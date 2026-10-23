/**
 * Response security and cache policy (SEC-16).
 *
 * Two hosts serve this application's responses and only one runs Express:
 * Vercel answers `/widget.js`, `/demo.html` and the stylesheet from its static
 * host before any function executes, while Docker/Azure/`npm start` serve the
 * same files through `express.static`. `vercel.json` therefore carries its own
 * copy of these values, and `tests/static-delivery-headers.test.ts` pins the
 * two copies together so one host cannot silently serve a weaker policy.
 *
 * The widget is embedded in third-party pages, but these headers travel with
 * *our* responses only. A browser enforces the host page's CSP, not this one,
 * so a document policy here cannot break an embed. The script itself is not a
 * document: a CSP on a JavaScript response is inert.
 */

/** HSTS: one year, subdomains included. Ignored by browsers over plain HTTP. */
export const HSTS_HEADER = 'max-age=31536000; includeSubDomains';

/**
 * Document policy for `/demo.html` and any other HTML this server emits.
 *
 * `style-src` keeps `'unsafe-inline'` because the widget builds its
 * accessibility stylesheet at runtime (`document.createElement('style')` in
 * `public/widget.js`) and cannot know a per-request nonce on a host page it
 * does not control. Scripts stay strict — no `'unsafe-inline'`, no
 * `'unsafe-eval'` — which is the directive that matters for XSS. The demo's
 * own inline `<style>` block is covered by the same allowance.
 *
 * `connect-src 'self'` matches the demo (same-origin API). A cross-origin
 * embed's calls are governed by the embedder's own CSP, which must allow the
 * API origin; that requirement is documented in README "Embedding the widget".
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
].join('; ');

/** HTML must revalidate so a deploy is picked up on the next navigation. */
export const HTML_CACHE_CONTROL = 'no-cache';

/**
 * Cache policy for the unversioned static assets (`/widget.js`,
 * `/elementor-trust-block.css`).
 *
 * The audit's first suggestion was `maxAge: '1y', immutable`, which is correct
 * only for content-hashed names. These names are fixed and the documented
 * embed is a bare `<script src="…/widget.js">`, so a year-long immutable entry
 * would strand every embed on an old widget after a deploy. One hour with
 * `must-revalidate` stops the per-navigation revalidation the audit measured
 * while bounding that skew to a single cache window.
 */
export const STATIC_ASSET_CACHE_CONTROL = 'public, max-age=3600, must-revalidate';

/** Cache policy for a file served from `public/`. */
export function staticCacheControl(filePath: string): string {
  return /\.html?$/i.test(filePath) ? HTML_CACHE_CONTROL : STATIC_ASSET_CACHE_CONTROL;
}
