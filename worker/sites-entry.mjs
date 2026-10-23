/**
 * Freebuff Sites entry point.
 *
 * The application is an Express server. Workers now run Express through the
 * Node HTTP compatibility layer, so this adapter hands every dynamic request to
 * the same `createApp()` the long-running server uses — no route is duplicated.
 * The three shipped static files come from the platform's asset binding instead
 * of `express.static`, because a Worker bundle has no public/ directory on its
 * virtual filesystem.
 *
 * The app imports no `dotenv`, deliberately: deployment secrets belong in the
 * platform's secret store and are supplied as environment variables, never
 * read from a file that could be bundled and uploaded.
 */

import { handleAsNodeRequest } from 'cloudflare:node';

import { createApp } from '../src/app';

const PORT = 3000;

// Only the files under public/. `/` is the app's JSON product/health document,
// not a static index, so it must keep going through Express.
const STATIC_PATHS = new Set(['/demo.html', '/widget.js', '/elementor-trust-block.css']);

const app = createApp();
app.listen(PORT);

/**
 * Serve one asset, following the asset router's extension normalization.
 * Workers assets redirects `/demo.html` to `/demo`; the long-running server
 * answers the `.html` URL directly, so the preview preserves that URL and
 * status instead of making every caller follow a redirect.
 */
async function serveAsset(request, env) {
  const response = await env.ASSETS.fetch(request);
  if (response.status !== 307 && response.status !== 308) return response;

  const location = response.headers.get('Location');
  if (!location) return response;
  return env.ASSETS.fetch(new Request(new URL(location, request.url), request));
}

export default {
  /**
   * @param {Request} request
   * @param {{ ASSETS: { fetch(request: Request): Promise<Response> } }} env
   */
  async fetch(request, env) {
    const { pathname } = new URL(request.url);
    if (STATIC_PATHS.has(pathname)) {
      return serveAsset(request, env);
    }
    return handleAsNodeRequest(PORT, request);
  },
};
