/**
 * Domain canonicalisation and cross-origin policy for the Lovable migration.
 *
 * The assistant's citations, privacy link and fallback links used to be
 * hardcoded to lifepolicypilot.blog. Citations are the product's evidence
 * trail: a URL that 404s is worse than no citation, because the visitor cannot
 * verify the claim and the operator cannot show where it came from. These tests
 * pin every user-visible URL to WEBSITE_URL, and pin the CORS allowlist —
 * including the one wildcard form — to something that cannot accidentally grant
 * the whole internet.
 */

import { readFileSync } from 'fs';
import path from 'path';

const ROOT = path.join(__dirname, '..');
const LIVE_ORIGIN = 'https://lifeinsurancebrokeradvocate.com';

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
    // Drop the modules bound to the temporary environment, so a later import
    // cannot inherit, say, a staging WEBSITE_URL.
    jest.resetModules();
  }
}

const SHIPPED_ENV = {
  WEBSITE_URL: undefined,
  PRIVACY_NOTICE_URL: undefined,
  CONTACT_URL: undefined,
  DSR_EMAIL: undefined,
};

describe('shipped publication defaults', () => {
  it('points the site, privacy notice and contact link at the live Lovable domain', async () => {
    const { config } = await underEnv(SHIPPED_ENV, () => import('../src/config/app-config'));
    expect(config.websiteUrl).toBe(`${LIVE_ORIGIN}/`);
    expect(config.privacyNoticeUrl).toBe(`${LIVE_ORIGIN}/privacy`);
    expect(config.contactUrl).toBe(`${LIVE_ORIGIN}/contact`);
  });

  it('keeps a DSR mailbox that can actually receive mail', async () => {
    // The rights mailbox is permanent and its domain publishes MX. The site
    // domain still must not be used here: a DSR sent to an address there has no
    // route, and the TDPSA clock would run against a bounced request.
    const { config } = await underEnv(SHIPPED_ENV, () => import('../src/config/app-config'));
    expect(config.dsrEmail).toContain('@');
    expect(config.dsrEmail).not.toContain('lifeinsurancebrokeradvocate.com');
  });

  it('builds citation URLs from WEBSITE_URL, in both slash forms', async () => {
    const { publicationUrl } = await underEnv(
      SHIPPED_ENV,
      () => import('../src/config/app-config'),
    );
    expect(publicationUrl('/')).toBe(`${LIVE_ORIGIN}/`);
    expect(publicationUrl('')).toBe(`${LIVE_ORIGIN}/`);
    expect(publicationUrl('blog/term-vs-whole-life-insurance-texas')).toBe(
      `${LIVE_ORIGIN}/blog/term-vs-whole-life-insurance-texas`,
    );
    expect(publicationUrl('/contact/')).toBe(`${LIVE_ORIGIN}/contact`);
  });

  it('follows a WEBSITE_URL override', async () => {
    const { publicationUrl } = await underEnv(
      { ...SHIPPED_ENV, WEBSITE_URL: 'https://staging.example.com/' },
      () => import('../src/config/app-config'),
    );
    expect(publicationUrl('tools')).toBe('https://staging.example.com/tools');
  });
});

describe('citations and links on the new domain', () => {
  it('serves corpus citations from the live site, not the retired blog', async () => {
    const { getArticleById } = await import('../src/rag/retrieval');
    for (const id of [
      'term-vs-whole',
      'factors-affecting-cost',
      'mib-overview',
      'tx-ins-code-541',
    ]) {
      const doc = getArticleById(id);
      expect(doc).not.toBeNull();
      expect(doc!.canonical_url).toMatch(/^https:\/\//);
      expect(doc!.canonical_url).not.toContain('lifepolicypilot.blog');
    }
  });

  it('points the card links and fallback resources at live pages', async () => {
    const { getCardById } = await import('../src/cards/card-library');
    const { STATIC_FALLBACK_RESOURCES } = await import('../src/resilience/fallback-behavior');

    for (const id of ['link_texas_laws', 'link_dime_method']) {
      const card = getCardById(id);
      expect(card).not.toBeNull();
      expect(String((card!.content as { url: string }).url)).toContain(
        'lifeinsurancebrokeradvocate.com',
      );
    }
    for (const resource of STATIC_FALLBACK_RESOURCES) {
      expect(resource.url).not.toContain('lifepolicypilot.blog');
      expect(resource.url).toMatch(
        /^https:\/\/(lifeinsurancebrokeradvocate\.com|www\.tdi\.texas\.gov)/,
      );
    }
  });

  it('leaves no legacy page URLs in the source it rewrote', () => {
    // A grep-level guard: the email exception has no trailing slash, so any
    // `lifepolicypilot.blog/` left in these files is a dead citation target.
    for (const relative of [
      'src/rag/retrieval.ts',
      'src/cards/card-library.ts',
      'src/resilience/fallback-behavior.ts',
      'src/config/app-config.ts',
    ]) {
      const source = readFileSync(path.join(ROOT, relative), 'utf8');
      expect(source).not.toContain('lifepolicypilot.blog/');
    }
  });
});

describe('cross-origin allowlist', () => {
  it('allows the apex, www and a named preview origin exactly', async () => {
    const { isAllowedOrigin } = await underEnv(
      {
        ALLOWED_ORIGINS:
          'https://lifeinsurancebrokeradvocate.com, https://www.lifeinsurancebrokeradvocate.com, https://abc123.lovable.app',
      },
      () => import('../src/config/app-config'),
    );
    expect(isAllowedOrigin('https://lifeinsurancebrokeradvocate.com')).toBe(true);
    expect(isAllowedOrigin('https://LIFEINSURANCEBROKERADVOCATE.com/')).toBe(true);
    expect(isAllowedOrigin('https://www.lifeinsurancebrokeradvocate.com')).toBe(true);
    expect(isAllowedOrigin('https://abc123.lovable.app')).toBe(true);
    expect(isAllowedOrigin('https://evil.example')).toBe(false);
    // Scheme and port are part of the origin, never assumed.
    expect(isAllowedOrigin('http://lifeinsurancebrokeradvocate.com')).toBe(false);
    expect(isAllowedOrigin('https://lifeinsurancebrokeradvocate.com:8443')).toBe(false);
  });

  it('supports a narrow subdomain wildcard for preview deployments', async () => {
    const { isAllowedOrigin } = await underEnv(
      { ALLOWED_ORIGINS: 'https://*.lovable.app' },
      () => import('../src/config/app-config'),
    );
    expect(isAllowedOrigin('https://abc123.lovable.app')).toBe(true);
    expect(isAllowedOrigin('https://id-preview--abc.lovable.app')).toBe(true);
    // The bare vendor domain is not a preview origin.
    expect(isAllowedOrigin('https://lovable.app')).toBe(false);
    // Not a suffix trick, and not another scheme.
    expect(isAllowedOrigin('https://evil-lovable.app')).toBe(false);
    expect(isAllowedOrigin('https://abc123.lovable.app.evil.example')).toBe(false);
    expect(isAllowedOrigin('http://abc123.lovable.app')).toBe(false);
  });

  it('refuses wildcard shapes that would grant everything', async () => {
    for (const entry of ['*', 'https://*', 'https://*.app.*', 'abc*.lovable.app']) {
      const { isAllowedOrigin } = await underEnv(
        { ALLOWED_ORIGINS: entry },
        () => import('../src/config/app-config'),
      );
      expect(isAllowedOrigin('https://anything.example')).toBe(false);
      expect(isAllowedOrigin('https://abc123.lovable.app')).toBe(false);
    }
  });

  it('names the wildcard entries so boot can warn about them', async () => {
    // A wildcard is a CORS grant to every tenant on the vendor domain. Boot
    // reports it by name; this is the lookup that finds them.
    const { wildcardAllowedOrigins } = await underEnv(
      {
        ALLOWED_ORIGINS:
          'https://lifeinsurancebrokeradvocate.com, https://*.lovable.app, https://*.lovableproject.com',
      },
      () => import('../src/config/app-config'),
    );
    expect(wildcardAllowedOrigins()).toEqual([
      'https://*.lovable.app',
      'https://*.lovableproject.com',
    ]);
  });

  it('reports no wildcard for an exact-origin allowlist', async () => {
    const { wildcardAllowedOrigins } = await underEnv(
      {
        ALLOWED_ORIGINS:
          'https://lifeinsurancebrokeradvocate.com,https://www.lifeinsurancebrokeradvocate.com',
      },
      () => import('../src/config/app-config'),
    );
    expect(wildcardAllowedOrigins()).toEqual([]);
  });

  it('warns at boot when a wildcard is configured', () => {
    // The warning is the operator's only signal that preview convenience
    // became a production grant; it must stay wired into the boot report.
    const entry = readFileSync(path.join(__dirname, '..', 'src', 'index.ts'), 'utf8');
    expect(entry).toContain('wildcardAllowedOrigins()');
    expect(entry).toContain('WARN: ALLOWED_ORIGINS contains a subdomain wildcard');
  });

  it('stays deny-by-default with no allowlist configured', async () => {
    const { isAllowedOrigin } = await underEnv(
      { ALLOWED_ORIGINS: undefined },
      () => import('../src/config/app-config'),
    );
    expect(isAllowedOrigin(LIVE_ORIGIN)).toBe(false);
    expect(isAllowedOrigin('')).toBe(false);
  });
});
