/**
 * The published privacy-rights mailbox is a legal channel (TDPSA), not a
 * display string: `/api/disclosure`, `/api/consent-text`, the DSR receipt and
 * the just-in-time notice all serve the same address, and a request sent to a
 * domain with no mail route bounces while the 45-day clock runs.
 *
 * These tests exercise the real verifier against an injected resolver, so each
 * of the four DNS outcomes is described without network access, and the gate's
 * exit codes are pinned: 0 deliverable/skipped, 1 undeliverable, 2 unverified.
 */

import {
  parseRightsEmail,
  verifyRightsChannel,
  type DnsLookup,
  type RightsChannelVerdict,
} from '../src/config/rights-channel';
import { parseOptions, runRightsChannelCli } from '../src/config/rights-channel-cli';

/** Import a module fresh under a specific environment. */
async function underEnv<T>(
  env: Record<string, string | undefined>,
  load: () => Promise<T>,
): Promise<T> {
  jest.resetModules();
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await load();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    jest.resetModules();
  }
}

function errno(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(code), { code });
}

interface DnsScript {
  mx?: { exchange: string; priority: number }[] | Error;
  a?: string[] | Error;
  aaaa?: string[] | Error;
}

function fakeDns(script: DnsScript): DnsLookup {
  const answer = <T>(value: T[] | Error | undefined): Promise<T[]> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value ?? []);
  return {
    resolveMx: () => answer(script.mx as any),
    resolve4: () => answer(script.a as any),
    resolve6: () => answer(script.aaaa as any),
  };
}

describe('rights-channel address validation', () => {
  it('accepts an ordinary provider address and lower-cases the domain', () => {
    expect(parseRightsEmail('  RichardParslow@LifePolicyPilot.BLOG ')).toEqual({
      address: 'RichardParslow@LifePolicyPilot.BLOG',
      domain: 'lifepolicypilot.blog',
    });
    expect(parseRightsEmail('privacy@sub.example-mail.co.uk')?.domain).toBe(
      'sub.example-mail.co.uk',
    );
  });

  it('rejects the shapes that cannot be a public rights channel', () => {
    for (const value of [
      '',
      '   ',
      'not-an-address',
      '@lifepolicypilot.blog',
      'privacy@',
      'privacy@@lifepolicypilot.blog',
      'pri vacy@lifepolicypilot.blog',
      'privacy@lifepolicypilot.blog.',
      'privacy@localhost',
      'privacy@example.com',
      'privacy@mail.invalid',
      `${'a'.repeat(250)}@lifepolicypilot.blog`,
    ]) {
      expect(parseRightsEmail(value)).toBeNull();
    }
  });
});

describe('rights-channel mail routing', () => {
  it('is deliverable when the domain publishes an MX record', async () => {
    const verdict = await verifyRightsChannel('richardparslow@lifepolicypilot.blog', {
      dns: fakeDns({
        mx: [
          { exchange: 'smtp2.google.com.', priority: 10 },
          { exchange: 'smtp.google.com.', priority: 5 },
        ],
      }),
    });
    expect(verdict.status).toBe('deliverable');
    // The lowest-priority-number host is the primary route, and the trailing
    // root dot is presentation only.
    expect(verdict.reason).toContain('smtp.google.com');
  });

  it('does not call a web host with no MX a deliverable mailbox', async () => {
    // RFC 5321 §5.1 makes the A/AAAA host an implicit MX, but a website's
    // address record is not evidence that anything accepts mail on port 25 —
    // and that false pass is how a notice names a mailbox nobody can write to.
    const verdict = await verifyRightsChannel('richardparslow@lifepolicypilot.blog', {
      dns: fakeDns({ mx: errno('ENODATA'), a: ['199.36.153.4'] }),
    });
    expect(verdict.status).toBe('unverified');
    expect(verdict.reason).toMatch(/implicit MX/);
    expect(verdict.reason).toMatch(/test message/);
  });

  it('is undeliverable when the domain has neither MX nor an address record', async () => {
    const verdict = await verifyRightsChannel('richardparslow@lifepolicypilot.blog', {
      dns: fakeDns({ mx: errno('ENOTFOUND'), a: errno('ENOTFOUND'), aaaa: errno('ENOTFOUND') }),
    });
    expect(verdict.status).toBe('undeliverable');
    expect(verdict.reason).toMatch(/no MX and no address record|neither an MX nor an A\/AAAA/);
  });

  it('treats a null MX route as undeliverable', async () => {
    // RFC 7505: a single "." MX says the domain accepts no mail at all.
    const verdict = await verifyRightsChannel('richardparslow@lifepolicypilot.blog', {
      dns: fakeDns({ mx: [{ exchange: '.', priority: 0 }] }),
    });
    expect(verdict.status).toBe('undeliverable');
    expect(verdict.reason).toMatch(/null route/);
  });

  it('does not turn a resolver failure into an accusation', async () => {
    // "No answer" is not "no mail route": a release must re-check, not claim
    // the address is broken.
    const verdict = await verifyRightsChannel('richardparslow@lifepolicypilot.blog', {
      dns: fakeDns({ mx: errno('EAI_AGAIN') }),
    });
    expect(verdict.status).toBe('unverified');
    expect(verdict.reason).toContain('EAI_AGAIN');
  });

  it('times out instead of hanging the deploy', async () => {
    const never: DnsLookup = {
      resolveMx: () => new Promise(() => undefined),
      resolve4: () => new Promise(() => undefined),
      resolve6: () => new Promise(() => undefined),
    };
    const verdict = await verifyRightsChannel('richardparslow@lifepolicypilot.blog', {
      dns: never,
      timeoutMs: 25,
    });
    expect(verdict.status).toBe('unverified');
    expect(verdict.reason).toContain('ETIMEOUT');
  });

  it('refuses a malformed address before asking DNS', async () => {
    let asked = false;
    const verdict = await verifyRightsChannel('privacy@example.com', {
      dns: {
        resolveMx: () => {
          asked = true;
          return Promise.resolve([]);
        },
        resolve4: () => Promise.resolve([]),
        resolve6: () => Promise.resolve([]),
      },
    });
    expect(verdict.status).toBe('undeliverable');
    expect(asked).toBe(false);
  });
});

describe('rights-channel configuration', () => {
  it('reads DSR_CONTACT_EMAIL, falling back to the legacy DSR_EMAIL name', async () => {
    const primary = await underEnv(
      {
        DSR_CONTACT_EMAIL: 'rights@lifeinsurancebrokeradvocate.com',
        DSR_EMAIL: 'privacy@lifepolicypilot.blog',
      },
      () => import('../src/config/app-config'),
    );
    expect(primary.config.dsrEmail).toBe('rights@lifeinsurancebrokeradvocate.com');

    const legacy = await underEnv(
      { DSR_CONTACT_EMAIL: undefined, DSR_EMAIL: 'privacy@lifepolicypilot.blog' },
      () => import('../src/config/app-config'),
    );
    expect(legacy.config.dsrEmail).toBe('privacy@lifepolicypilot.blog');
  });

  it('defaults to the verified working mailbox, not the domain without MX', async () => {
    const loaded = await underEnv(
      { DSR_CONTACT_EMAIL: undefined, DSR_EMAIL: undefined },
      () => import('../src/config/app-config'),
    );
    expect(loaded.config.dsrEmail).toBe(loaded.DEFAULT_DSR_CONTACT_EMAIL);
    expect(loaded.config.dsrEmail).toBe('richardparslow@lifepolicypilot.blog');
    expect(loaded.config.dsrEmail).not.toContain('lifeinsurancebrokeradvocate.com');
  });
});

describe('rights-channel pre-deploy gate', () => {
  const deliverable: RightsChannelVerdict = {
    status: 'deliverable',
    address: 'richardparslow@lifepolicypilot.blog',
    domain: 'lifepolicypilot.blog',
    reason: 'MX record present (smtp.google.com, priority 5)',
  };
  const unverified: RightsChannelVerdict = {
    status: 'unverified',
    address: 'richardparslow@lifepolicypilot.blog',
    domain: 'lifepolicypilot.blog',
    reason: 'MX lookup could not complete (EAI_AGAIN)',
  };

  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let error: jest.SpyInstance;

  beforeEach(() => {
    log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('passes a deliverable channel', async () => {
    const code = await runRightsChannelCli([], {}, async () => deliverable);
    expect(code).toBe(0);
    expect(log.mock.calls.flat().join('\n')).toContain('DELIVERABLE');
  });

  it('fails a channel whose domain cannot receive mail', async () => {
    const code = await runRightsChannelCli(['--email', 'privacy@example.com'], {}, (email) =>
      verifyRightsChannel(email),
    );
    expect(code).toBe(1);
    expect(error.mock.calls.flat().join('\n')).toContain('would bounce');
  });

  it('fails closed on an unverified channel, and says how a preview may continue', async () => {
    const code = await runRightsChannelCli([], {}, async () => unverified);
    expect(code).toBe(2);
    expect(error.mock.calls.flat().join('\n')).toContain('--allow-offline');
  });

  it('tolerates an unverified channel only when the caller opts in', async () => {
    expect(await runRightsChannelCli(['--allow-offline'], {}, async () => unverified)).toBe(0);
    expect(
      await runRightsChannelCli([], { DSR_CHANNEL_ALLOW_OFFLINE: 'true' }, async () => unverified),
    ).toBe(0);
    expect(warn.mock.calls.flat().join('\n')).toContain('could not be verified');
  });

  it('skips cleanly for an offline preview build', async () => {
    let called = false;
    const code = await runRightsChannelCli([], { DSR_CHANNEL_CHECK: 'off' }, async () => {
      called = true;
      return deliverable;
    });
    expect(code).toBe(0);
    expect(called).toBe(false);
    expect(log.mock.calls.flat().join('\n')).toContain('skipped');
  });

  it('reads the address from the environment, and the flags override it', () => {
    expect(parseOptions([], { DSR_CONTACT_EMAIL: 'a@b.co' }).email).toBe('a@b.co');
    expect(parseOptions(['--email', 'c@d.co'], { DSR_CONTACT_EMAIL: 'a@b.co' }).email).toBe(
      'c@d.co',
    );
    expect(parseOptions(['--email=e@f.co'], {}).email).toBe('e@f.co');
    expect(parseOptions([], { DSR_CHANNEL_CHECK: 'off' }).skip).toBe(true);
    expect(parseOptions(['--allow-offline'], {}).allowOffline).toBe(true);
  });
});
