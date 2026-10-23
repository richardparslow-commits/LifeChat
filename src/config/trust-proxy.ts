/**
 * Express `trust proxy` resolution (SEC-10).
 *
 * The per-client budgets (chat spend and the write endpoints) are keyed on
 * `req.ip`. That key is only as good as the proxy configuration:
 *
 *   - trust nothing behind a proxy, and every visitor shares the proxy's
 *     address, so one caller can exhaust the budget for everybody;
 *   - trust everything (`TRUST_PROXY=true`), and any caller can send their own
 *     `X-Forwarded-For`, mint a fresh key per request, and escape the budget.
 *
 * This module resolves the environment into a hop count with a deliberate
 * default. Vercel reaches the app through exactly one edge hop, so an unset
 * `TRUST_PROXY` on a Vercel deployment becomes `1`; the client address is the
 * one the edge appended, not a value the caller chose. Everywhere else the
 * default stays "trust nothing", with a warning when the runtime is serverless
 * (where that default collapses the budgets) so the operator sets the value.
 *
 * `true` is refused outright rather than passed to Express: it is the one
 * value that makes the key caller-controlled.
 */

/** The subset of Express's `trust proxy` setting this app produces. */
export type TrustProxySetting = false | number | string | string[];

export interface TrustProxyResolution {
  setting: TrustProxySetting;
  source: 'explicit' | 'vercel_default' | 'none';
  /** Operator-facing warning, or null when the resolution is unremarkable. */
  warning: string | null;
}

/** Express keywords that name a class of trusted peer. */
const EXPRESS_KEYWORDS = ['loopback', 'linklocal', 'uniquelocal'] as const;

/**
 * Resolves TRUST_PROXY for this process.
 *
 * @param input.raw        The configured value, verbatim.
 * @param input.serverless Whether the platform proxies and recycles the app.
 * @param input.vercel     Whether this is a Vercel deployment (`VERCEL=1`).
 */
export function resolveTrustProxy(input: {
  raw: string;
  serverless: boolean;
  vercel: boolean;
}): TrustProxyResolution {
  const raw = input.raw.trim();

  if (raw.length === 0) {
    if (input.vercel) {
      // Vercel terminates TLS at its edge and forwards the connecting address;
      // exactly one hop is trusted, so the header is the edge's, not the
      // caller's.
      return { setting: 1, source: 'vercel_default', warning: null };
    }
    if (input.serverless) {
      return {
        setting: false,
        source: 'none',
        warning:
          'WARN: SERVERLESS=true without TRUST_PROXY — every visitor behind the platform ' +
          'proxy shares one client budget. Set TRUST_PROXY to the number of proxy hops ' +
          '(1 for a single edge, 2 when a CDN sits in front of it).',
      };
    }
    return { setting: false, source: 'none', warning: null };
  }

  // Wildcard trust makes req.ip whatever the caller writes in the header.
  if (raw.toLowerCase() === 'true') {
    return {
      setting: false,
      source: 'explicit',
      warning:
        'WARN: TRUST_PROXY="true" trusts a caller-supplied X-Forwarded-For, so any caller ' +
        'could mint a fresh client budget. Refusing it; set the proxy hop count instead.',
    };
  }

  if (raw === '0') {
    return { setting: false, source: 'explicit', warning: null };
  }

  const keyword = EXPRESS_KEYWORDS.find((value) => value === raw.toLowerCase());
  if (keyword) {
    return { setting: keyword, source: 'explicit', warning: null };
  }

  const hops = Number(raw);
  if (Number.isInteger(hops) && hops > 0 && String(hops) === raw) {
    return { setting: hops, source: 'explicit', warning: null };
  }

  // A single IP, subnet, or comma-separated list. Express validates these on
  // assignment; the caller must fail closed if it rejects one.
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return {
    setting: entries.length > 1 ? entries : raw,
    source: 'explicit',
    warning: null,
  };
}
