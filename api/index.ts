/**
 * Vercel entry point (serverless Node runtime).
 *
 * Vercel's runtime imports this file per invocation and drives the exported
 * handler itself, so the app must be built without ever calling listen() —
 * the platform sets VERCEL=1 (and SERVERLESS=true can be added as a project
 * env var), which keeps src/index.ts from binding a port or scheduling the
 * cleanup intervals on the cold-start path.
 *
 * The default export adapts the Express app to the Node (req, res) signature
 * the Vercel builder expects. Every route — /api/chat, /api/consent,
 * /api/dsr, the admin-gated endpoints — behaves exactly as it does on a
 * long-running server; only the socket ownership differs.
 *
 * Deployment wiring (the VERCEL_KEY repository secret and the workflow that
 * consumes it) lives in .github/workflows/deploy.yml; the operational notes,
 * including the record-store caveat for serverless filesystems, are in
 * docs/sandbox-deployment.md.
 */
import { app } from '../src/index';

export default app;
