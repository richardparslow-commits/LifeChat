#!/usr/bin/env node
/**
 * Accessibility gate: axe-core, in a real browser, against the shipped widget.
 *
 * The DOM contract in `tests/widget-accessibility.test.ts` runs the real
 * `public/widget.js` against a hand-written DOM, which cannot compute styles or
 * lay anything out. That suite can therefore prove the attributes and the
 * declared geometry, but not that the rendered result is usable. The audit
 * asked for the missing half: a browser pass that fails CI on serious or
 * critical axe violations.
 *
 * What it does:
 *   1. Serves `public/` from a loopback server, answering `/api/disclosure`
 *      with a fixed greeting so the widget renders without the API, a database
 *      or an LLM call.
 *   2. Loads `/demo.html` in Chromium (Playwright) and scans the closed widget.
 *   3. Opens the widget with a real click and scans the full panel, including
 *      the shadow tree, the transcript and the composer.
 *   4. Fails on any `serious` or `critical` violation, and also fails if axe
 *      never inspected a widget node — a scan that silently skipped the shadow
 *      root would otherwise pass vacuously.
 *
 * Usage: `npm run a11y:e2e`. CI installs Chromium first:
 * `npx playwright install --with-deps chromium`.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import process from 'node:process';

import AxeBuilder from '@axe-core/playwright';
import { chromium } from 'playwright';

const PUBLIC_DIR = resolve(process.cwd(), 'public');
const DISCLOSURE =
  'I am LifeChat, the AI educational assistant from Life Insurance Broker Advocate. I provide general education about life insurance, not advice.';
const FAILING_IMPACTS = new Set(['serious', 'critical']);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** A loopback static server for `public/`, with the disclosure API stubbed. */
async function startServer() {
  const server = createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/api/disclosure') {
      response.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      response.end(JSON.stringify({ firstMessage: DISCLOSURE }));
      return;
    }
    // The contact step loads the canonical consent copy before it can submit
    // (C-08); a 404 would leave the form in its loading state and hide the
    // fields the scan is there to inspect.
    if (url.pathname === '/api/consent-text') {
      response.writeHead(200, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
      response.end(
        JSON.stringify({
          emailConsentCopy:
            'I agree to be contacted about my life-insurance inquiry. Consent is not a condition of purchase.',
          phoneConsentCopy:
            'Optional: I agree that Life Insurance Broker Advocate and Richard Parslow may call or text the number I provide about my life-insurance inquiry. Consent is not a condition of purchase.',
          privacyNoticeUrl: 'https://lifeinsurancebrokeradvocate.com/privacy',
        }),
      );
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      response.writeHead(404, { 'Content-Type': MIME['.json'] });
      response.end(JSON.stringify({ error: 'Not found in the accessibility harness' }));
      return;
    }

    const requestPath = url.pathname === '/' ? '/demo.html' : url.pathname;
    const filePath = resolve(PUBLIC_DIR, `.${requestPath}`);
    // Never serve outside public/: `..` in a URL must not escape the root.
    if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + sep)) {
      response.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Forbidden');
      return;
    }

    try {
      const body = await readFile(filePath);
      response.writeHead(200, {
        'Content-Type': MIME[extname(filePath)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
      });
      response.end(body);
    } catch {
      response.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
    }
  });

  await new Promise((ready) => server.listen(0, '127.0.0.1', ready));
  const address = server.address();
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

/** Every element target axe recorded, across violations, passes and incomplete. */
function inspectedTargets(results) {
  const targets = [];
  for (const bucket of [
    results.violations,
    results.passes,
    results.incomplete,
    results.inapplicable,
  ]) {
    for (const rule of bucket) {
      for (const node of rule.nodes ?? []) {
        targets.push(JSON.stringify(node.target));
      }
    }
  }
  return targets;
}

function formatViolation(violation) {
  const lines = [`  ${violation.id} [${violation.impact}] — ${violation.help}`];
  lines.push(`    ${violation.helpUrl}`);
  for (const node of violation.nodes.slice(0, 5)) {
    lines.push(`    target: ${JSON.stringify(node.target)}`);
    const summary = (node.failureSummary ?? '').trim().split('\n').slice(0, 3).join(' ');
    if (summary) lines.push(`    ${summary}`);
  }
  if (violation.nodes.length > 5) {
    lines.push(`    …and ${violation.nodes.length - 5} more node(s)`);
  }
  return lines.join('\n');
}

function failingViolations(results) {
  return results.violations.filter((violation) => FAILING_IMPACTS.has(violation.impact));
}

/**
 * A coherent dark host theme for `/demo.html`.
 *
 * The widget keeps its own palette; only the host page changes. That makes the
 * dark scan a different question from the light one: is the widget still
 * accessible when the site around it is dark, and did the shadow boundary keep
 * its colours from being inherited or overridden? The demo's own rules are
 * overridden with a later stylesheet, exactly as a dark theme would.
 */
const DARK_HOST_CSS = `
  :root { color-scheme: dark; }
  body { background: #0b0f14; color: #e6edf3; }
  main { color: #e6edf3; }
  h1 { color: #ff8a80; }
  .card { background: #111827; color: #e6edf3; border-color: #64748b; }
  code { background: #1f2937; color: #e6edf3; }
`;

/** Colours the widget must keep regardless of the host page's theme. */
const WIDGET_LAUNCHER_BACKGROUND = 'rgb(65, 76, 50)';
const DARK_PAGE_BACKGROUND = 'rgb(11, 15, 20)';

/**
 * Scans the open widget with a dark host theme applied, and reports whether the
 * theme reached the page while the widget's own colours stayed unchanged.
 */
async function darkHostScan(page) {
  const style = await page.addStyleTag({ content: DARK_HOST_CSS });
  try {
    const context = await page.evaluate(() => {
      const host = document.querySelector('#lpp-chat-widget-host');
      const launcher =
        host && host.shadowRoot && host.shadowRoot.querySelector('.lpp-chat-launcher');
      return {
        pageBackground: getComputedStyle(document.body).backgroundColor,
        launcherBackground: launcher ? getComputedStyle(launcher).backgroundColor : null,
      };
    });
    const results = await new AxeBuilder({ page }).analyze();
    return { results, context };
  } finally {
    // Always restore the light page for anything that runs after this scan.
    await style.evaluate((node) => node.remove());
  }
}

/**
 * Injects a deliberately inaccessible node and confirms axe still reports it.
 *
 * A green scan is only meaningful if the same pipeline can go red. The probe
 * image has no alt text, which axe reports as a critical `image-alt` violation;
 * it is scoped out of the widget, removed immediately, and never part of the
 * real scans.
 */
async function controlProbe(page) {
  await page.evaluate(() => {
    const image = document.createElement('img');
    image.id = 'a11y-gate-control';
    // A 1×1 transparent GIF, inline so the probe needs no network.
    image.src = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    image.width = 10;
    image.height = 10;
    document.body.appendChild(image);
  });

  try {
    const result = await new AxeBuilder({ page }).include('#a11y-gate-control').analyze();
    return result.violations.some(
      (violation) => violation.id === 'image-alt' && FAILING_IMPACTS.has(violation.impact),
    );
  } finally {
    await page.evaluate(() => document.getElementById('a11y-gate-control')?.remove());
  }
}

async function main() {
  const { server, origin } = await startServer();
  const browser = await chromium.launch();

  try {
    // A context-created page, not browser.newPage(): axe's Playwright builder
    // injects its script through the context API.
    const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (message) => {
      if (message.type() === 'error') consoleErrors.push(message.text());
    });


    await page.goto(`${origin}/demo.html`, { waitUntil: 'load' });

    // The widget must actually be present; otherwise every scan below would be
    // a vacuous pass over a page with nothing on it.
    const launcher = page.locator('button.lpp-chat-launcher');
    await launcher.waitFor({ state: 'visible' });

    const scans = [];
    scans.push({
      label: 'closed widget (launcher)',
      results: await new AxeBuilder({ page }).analyze(),
    });

    await launcher.click();
    // The disclosure request is local; wait for the reply bubble so the panel
    // is scanned in a realistic, populated state.
    await page.waitForFunction(
      ([needle]) => {
        const host = document.querySelector('#lpp-chat-widget-host');
        const log = host && host.shadowRoot && host.shadowRoot.querySelector('#lpp-chat-messages');
        return Boolean(log && log.textContent && log.textContent.includes(needle));
      },
      ['Assistant said'],
      { timeout: 5000 },
    );
    scans.push({
      label: 'open widget (panel and transcript)',
      results: await new AxeBuilder({ page }).analyze(),
    });

    // C-08: the consent/contact step and the privacy-request form are part of
    // the shipped surface, so they are scanned in the state a visitor uses
    // them in — expanded, with the canonical consent copy loaded.
    await page.locator('#lpp-contact-toggle').click();
    await page.waitForFunction(
      () => {
        const host = document.querySelector('#lpp-chat-widget-host');
        const copy = host && host.shadowRoot && host.shadowRoot.querySelector('.lpp-contact-copy');
        return Boolean(copy && copy.textContent && !copy.textContent.includes('Loading the approved'));
      },
      undefined,
      { timeout: 5000 },
    );
    scans.push({
      label: 'open contact form',
      results: await new AxeBuilder({ page }).analyze(),
    });

    await page.locator('#lpp-dsr-toggle').click();
    scans.push({
      label: 'open privacy request form',
      results: await new AxeBuilder({ page }).analyze(),
    });
    // Collapse the form so the dark-host scan sees the same panel it did before.
    await page.locator('#lpp-dsr-toggle').click();

    const dark = await darkHostScan(page);
    scans.push({ label: 'open widget in a dark host context', results: dark.results });

    // Prove the pipeline can still fail before trusting a passing scan: axe
    // blocked by a policy or a missing ruleset would otherwise look green.
    let failed = false;

    if (
      dark.context.pageBackground === DARK_PAGE_BACKGROUND &&
      dark.context.launcherBackground === WIDGET_LAUNCHER_BACKGROUND
    ) {
      console.log(
        'dark host context: the page turned dark and the widget kept its own palette ' +
          `(${WIDGET_LAUNCHER_BACKGROUND}).`,
      );
    } else {
      console.error(
        'FAIL: the dark host context did not apply, or it changed the widget palette ' +
          `(page ${dark.context.pageBackground}, launcher ${dark.context.launcherBackground}).`,
      );
      failed = true;
    }
    if (await controlProbe(page)) {
      console.log('control probe: axe reported the unlabelled image as critical (image-alt).');
    } else {
      console.error(
        'FAIL: the control probe was not detected. axe is not reporting violations on this page, so the scans below prove nothing.',
      );
      failed = true;
    }

    let widgetNodesInspected = 0;

    for (const { label, results } of scans) {
      const violations = failingViolations(results);
      widgetNodesInspected += inspectedTargets(results).filter((target) =>
        target.includes('lpp-'),
      ).length;

      const total = results.violations.length;
      console.log(
        `\n${label}: ${total} violation(s), ${violations.length} serious/critical` +
          ` (${results.passes.length} rules passed)`,
      );
      if (violations.length > 0) {
        failed = true;
        for (const violation of violations) console.log(formatViolation(violation));
      }
      // Do not hide the rest: a moderate finding is still worth seeing, even
      // though it does not fail the gate.
      const other = results.violations.filter(
        (violation) => !FAILING_IMPACTS.has(violation.impact),
      );
      for (const violation of other) {
        console.log(`  note: ${violation.id} [${violation.impact}] — ${violation.help}`);
      }
    }

    if (widgetNodesInspected === 0) {
      console.error(
        '\nFAIL: axe inspected no widget element. The shadow root was not traversed, so these scans prove nothing.',
      );
      failed = true;
    } else {
      console.log(
        `\naxe inspected ${widgetNodesInspected} widget node target(s) across the scans.`,
      );
    }

    // A page error means the widget is not working even if it is accessible.
    const unexpected = consoleErrors.filter((text) => !/Failed to load resource/i.test(text));
    if (unexpected.length > 0) {
      console.error(`\nFAIL: the page logged ${unexpected.length} console error(s):`);
      for (const text of unexpected.slice(0, 10)) console.error(`  ${text}`);
      failed = true;
    }

    if (failed) {
      console.error('\nAccessibility gate FAILED.');
      process.exitCode = 1;
      return;
    }
    console.log('\nAccessibility gate passed: no serious or critical axe violations.');
  } finally {
    await browser.close();
    await new Promise((done) => server.close(done));
  }
}

main().catch((error) => {
  console.error('The accessibility gate could not run:', error);
  process.exitCode = 1;
});
