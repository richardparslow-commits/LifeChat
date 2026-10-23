/**
 * Readiness of the published privacy-rights mailbox.
 *
 * TDPSA gives a consumer 45 days from a request, and the privacy notice names
 * exactly one address for access, deletion, correction and portability
 * requests. If that domain cannot accept mail, the notice is false and every
 * request sent to it bounces — a failure that is invisible from the
 * application: `/api/disclosure` happily serves the address and `POST /api/dsr`
 * happily accepts the request.
 *
 * This module answers the only question a deploy can answer without sending a
 * message: does the address name a domain that publishes a mail route? It is
 * deliberately separate from `app-config` so the pre-deploy CLI can run it
 * without booting the server, and the DNS resolver is injectable so the tests
 * describe the four real outcomes without touching the network.
 *
 * What it does NOT claim: that a specific mailbox exists. DNS proves a domain
 * accepts mail, not that `someone@` is provisioned. The operator still sends a
 * test message before switching the published address (see
 * docs/data-lifecycle-runbook.md).
 */

import { promises as dnsPromises } from 'dns';

/** The address whose domain is checked, split into its parts. */
export interface RightsChannelAddress {
  /** The full address, trimmed. */
  address: string;
  /** The lower-cased domain after the final `@`. */
  domain: string;
}

/**
 * The three outcomes a deploy can distinguish.
 *
 * `unverified` is not a pass: DNS being unreachable (offline build, resolver
 * failure, timeout) means the gate learned nothing. Callers decide whether that
 * blocks the deploy — a preview build may continue, a release must not.
 */
export type RightsChannelVerdict =
  | { status: 'deliverable'; address: string; domain: string; reason: string }
  | { status: 'undeliverable'; address: string; domain: string; reason: string }
  | { status: 'unverified'; address: string; domain: string; reason: string };

/** The DNS calls the verifier needs. `dns.promises` satisfies this shape. */
export interface DnsLookup {
  resolveMx(domain: string): Promise<{ exchange: string; priority: number }[]>;
  resolve4(domain: string): Promise<string[]>;
  resolve6(domain: string): Promise<string[]>;
}

export interface VerifyRightsChannelOptions {
  /** Resolver to use; defaults to the OS resolver. */
  dns?: DnsLookup;
  /** Hard ceiling on each lookup, so a deploy cannot hang on a silent resolver. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 3000;
/** RFC 5321 caps a forward/reverse path at 256 octets; 254 is the usable limit. */
const MAX_ADDRESS_LENGTH = 254;

/**
 * A pragmatic address shape, not RFC 5322 in full.
 *
 * It rejects the mistakes that matter here — a missing `@`, whitespace, two
 * `@`s, a bare hostname, a trailing dot — while accepting the ordinary
 * `local@sub.domain.tld` forms a real provider issues. `DSR_EMAIL` is served to
 * the public, so a malformed value is a visible defect, not an internal detail.
 */
const EMAIL_SHAPE =
  /^[^\s@]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

/**
 * Reserved names that can never receive a real request, so a placeholder
 * cannot pass the gate: RFC 2606 reserves `.test`, `.invalid`, `.localhost`
 * and `example.com`/`.net`/`.org` for documentation and testing.
 */
const NON_DELIVERABLE_DOMAINS = /(^|\.)(example|example\.(com|net|org)|invalid|localhost|test)$/;

/**
 * Parses and validates the configured rights address.
 *
 * Returns null for anything that is not a usable public address: empty,
 * over-long, syntactically wrong, or on a reserved domain such as
 * `example.com`. A null here is a configuration error, not a DNS problem.
 */
export function parseRightsEmail(raw: string): RightsChannelAddress | null {
  const address = String(raw ?? '').trim();
  if (address.length === 0 || address.length > MAX_ADDRESS_LENGTH) return null;
  if (!EMAIL_SHAPE.test(address)) return null;
  const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
  if (NON_DELIVERABLE_DOMAINS.test(domain)) return null;
  return { address, domain };
}

function errorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : '';
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(Object.assign(new Error('DNS lookup timed out'), { code: 'ETIMEOUT' }));
    }, timeoutMs);
    // Never keep the process alive for a pending lookup.
    if (typeof timer.unref === 'function') timer.unref();
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

const systemDns: DnsLookup = {
  resolveMx: (domain) => dnsPromises.resolveMx(domain),
  resolve4: (domain) => dnsPromises.resolve4(domain),
  resolve6: (domain) => dnsPromises.resolve6(domain),
};

/**
 * True when the error means "this name/record type does not exist", as opposed
 * to "the resolver could not answer". Only the former is evidence.
 */
function isAbsent(error: unknown): boolean {
  const code = errorCode(error);
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'ENOTIMP';
}

/**
 * Resolves whether the rights address names a domain that accepts mail.
 *
 * A published MX record is proof of a mail route. No MX is not proof of the
 * opposite: RFC 5321 §5.1 defines an implicit MX pointing at the domain's
 * A/AAAA host. But that host only receives mail if something is listening on
 * port 25 — and a website's address record usually is not a mail server, which
 * is exactly how a notice ends up naming a mailbox nobody can write to. So the
 * implicit-MX case is reported as `unverified` with the reason, not as a pass:
 * a release waits for an explicit MX or a delivered test message. Only a
 * domain with no MX and no address record at all is conclusively unroutable.
 */
export async function verifyRightsChannel(
  rawEmail: string,
  options: VerifyRightsChannelOptions = {},
): Promise<RightsChannelVerdict> {
  const parsed = parseRightsEmail(rawEmail);
  if (!parsed) {
    return {
      status: 'undeliverable',
      address: String(rawEmail ?? '').trim(),
      domain: '',
      reason:
        'not a valid public email address (empty, malformed, over 254 characters, or on a reserved domain)',
    };
  }

  const { dns = systemDns, timeoutMs = DEFAULT_TIMEOUT_MS } = options;
  const { address, domain } = parsed;

  let noMxRecord = false;
  try {
    const records = await withTimeout(dns.resolveMx(domain), timeoutMs);
    const usable = records.filter(
      (record) =>
        record && typeof record.exchange === 'string' && record.exchange.trim().length > 0,
    );
    if (usable.length > 0) {
      // A lone root-domain MX ('.') means the domain explicitly accepts no mail.
      const targets = usable.filter((record) => record.exchange.trim() !== '.');
      if (targets.length > 0) {
        const best = targets.sort((a, b) => a.priority - b.priority)[0];
        return {
          status: 'deliverable',
          address,
          domain,
          reason: `MX record present (${best.exchange.trim().replace(/\.$/, '')}, priority ${best.priority})`,
        };
      }
      return {
        status: 'undeliverable',
        address,
        domain,
        reason: 'MX record is a null route ("."), which accepts no mail',
      };
    }
    noMxRecord = true;
  } catch (error) {
    if (!isAbsent(error)) {
      return {
        status: 'unverified',
        address,
        domain,
        reason: `MX lookup could not complete (${errorCode(error) || 'unknown error'})`,
      };
    }
    noMxRecord = true;
  }

  if (!noMxRecord) {
    return {
      status: 'undeliverable',
      address,
      domain,
      reason: 'the domain publishes no usable MX record',
    };
  }

  // No MX: an A/AAAA host is only an implicit MX (RFC 5321 §5.1) if it runs
  // SMTP, which DNS cannot show. Report it as unverified rather than pass it.
  for (const lookup of ['resolve4', 'resolve6'] as const) {
    try {
      const addresses = await withTimeout(dns[lookup](domain), timeoutMs);
      if (addresses.length > 0) {
        return {
          status: 'unverified',
          address,
          domain,
          reason: `no MX record; an ${lookup === 'resolve4' ? 'A' : 'AAAA'} record exists, which is only an implicit MX (RFC 5321 §5.1) if that host accepts SMTP — add an MX record or confirm with a test message`,
        };
      }
    } catch (error) {
      if (!isAbsent(error)) {
        return {
          status: 'unverified',
          address,
          domain,
          reason: `${lookup === 'resolve4' ? 'A' : 'AAAA'} lookup could not complete (${errorCode(error) || 'unknown error'})`,
        };
      }
    }
  }

  return {
    status: 'undeliverable',
    address,
    domain,
    reason: 'the domain publishes neither an MX nor an A/AAAA record, so mail has no route',
  };
}
