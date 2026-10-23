import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import {
  CONTENT_SECURITY_POLICY,
  HSTS_HEADER,
  HTML_CACHE_CONTROL,
  STATIC_ASSET_CACHE_CONTROL,
} from '../src/security/security-headers';

/**
 * SEC-16 — Vercel and Express must serve the same policy.
 *
 * `/widget.js`, `/demo.html` and `/elementor-trust-block.css` are answered by
 * Vercel's static host before any function runs, so `next.config`/Express
 * middleware never sees them in production. `vercel.json` is therefore a
 * second, independent copy of the CSP, HSTS and cache values; this suite pins
 * it to `src/security/security-headers.ts` and enumerates `public/` so a new
 * asset cannot ship without a cache rule.
 */

interface HeaderEntry {
  key: string;
  value: string;
}

interface HeaderRule {
  source: string;
  headers: HeaderEntry[];
}

const vercel = JSON.parse(readFileSync(path.join(process.cwd(), 'vercel.json'), 'utf8')) as {
  headers: HeaderRule[];
  functions?: Record<string, { maxDuration?: number }>;
};

function header(source: string, key: string): string | undefined {
  return vercel.headers
    .find((rule) => rule.source === source)
    ?.headers.find((entry) => entry.key === key)?.value;
}

const publicFiles = readdirSync(path.join(process.cwd(), 'public'), { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);

describe('static delivery headers match the Express policy', () => {
  it('gives the chat function a duration budget above the LLM retry worst case', () => {
    // M-03: two callLLM calls (the orchestrator retries once on schema failure)
    // × two 10 s attempts each = 40 s, so the platform limit must not cut the
    // retry short. A missing or lower budget fails here rather than as a 504.
    const budget = vercel.functions?.['api/index.ts']?.maxDuration;
    expect(typeof budget).toBe('number');
    expect(budget).toBeGreaterThanOrEqual(40);
  });

  it('keeps HSTS identical on both hosts', () => {
    expect(HSTS_HEADER).toBe('max-age=31536000; includeSubDomains');
    expect(header('/(.*)', 'Strict-Transport-Security')).toBe(HSTS_HEADER);
  });

  it('keeps the demo CSP identical and script-strict', () => {
    const csp = header('/demo.html', 'Content-Security-Policy');
    expect(csp).toBe(CONTENT_SECURITY_POLICY);
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/script-src[^;]*unsafe-(?:inline|eval)/);
    expect(csp).toContain("frame-ancestors 'none'");
  });

  it('gives every public file the cache policy its content requires', () => {
    expect(publicFiles.length).toBeGreaterThan(0);

    for (const file of publicFiles) {
      const source = `/${file}`;
      const isHtml = /\.html?$/i.test(file);
      const expected = isHtml ? HTML_CACHE_CONTROL : STATIC_ASSET_CACHE_CONTROL;

      expect(`${source}: ${header(source, 'Cache-Control')}`).toBe(`${source}: ${expected}`);
      if (isHtml) {
        // Any HTML document served from public/ is a browsing context and
        // needs the document policy, not just the cache header.
        expect(`${source}: ${header(source, 'Content-Security-Policy')}`).toBe(
          `${source}: ${CONTENT_SECURITY_POLICY}`,
        );
      }
    }
  });

  it('never marks an unversioned asset immutable', () => {
    for (const rule of vercel.headers) {
      const cache = rule.headers.find((entry) => entry.key === 'Cache-Control')?.value;
      if (!cache) continue;
      // The only immutable policy in this deployment belongs to Vercel's own
      // build output; every file under public/ has a fixed name.
      expect(`${rule.source}: ${cache}`).not.toContain('immutable');
    }
  });
});
