/**
 * The contract for embedding public/widget.js in a host SPA on another origin —
 * the Lovable site (lifeinsurancebrokeradvocate.com) is the case this was
 * written for.
 *
 * Every test executes the shipped file, not a copy. Four host-page facts drive
 * the suite:
 *
 *  1. The page and the API are different origins, so a relative `/api/chat`
 *     fetch would hit the host's SPA fallback and come back as HTML.
 *  2. A React Router site changes the URL with history.pushState and never
 *     reloads, so the page context read at script load goes stale.
 *  3. React 18 StrictMode invokes effects twice in development, so mounting
 *     twice must not produce a second dialog.
 *  4. Tailwind's preflight removes list markers and zeroes borders globally,
 *     which erases the widget's citation bullets.
 */

import { readFileSync } from 'fs';
import path from 'path';

import {
  type FakeElement,
  createEnvironment,
  executeWidget,
  flushPromises,
  runWidget,
  widgetElement,
} from './helpers/dom-shim';

const WIDGET_SOURCE = readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');

const DISCLOSURE = {
  firstMessage: 'I am the Life Insurance Broker Advocate AI Educational Assistant.',
  banner:
    'You are chatting with an AI educational assistant. Do not enter medical, financial-account, Social Security, or other highly sensitive information.',
};
const REPLY = { assistant_message: 'Term life covers a set period.', state: 'education' };

interface FakeHistory {
  entries: string[];
  pushState(state: unknown, title: string, url?: string): void;
  replaceState(state: unknown, title: string, url?: string): void;
}

interface StartOptions {
  /** Attributes on the <script> tag, e.g. data-api-base. */
  attributes?: Record<string, string>;
  /** The script's own src, used as the default API base. */
  scriptSrc?: string;
  /** window.LPP_CHAT_CONFIG. */
  config?: Record<string, unknown>;
  /** Give the page a history object and window event listeners. */
  spa?: boolean;
}

interface Run {
  document: ReturnType<typeof createEnvironment>['document'];
  window: ReturnType<typeof createEnvironment>['window'];
  fetch: ReturnType<typeof createEnvironment>['fetch'];
  history: FakeHistory;
  /** Document listeners the widget removed, recorded by destroy(). */
  removedDocumentListeners: string[];
  /** Fire a window event the widget subscribed to (popstate, hashchange). */
  dispatchWindowEvent(type: string): void;
  panel: FakeElement;
  launcher: FakeElement;
  input: FakeElement;
  styleTag: FakeElement;
  send(text: string): void;
  chatCalls(): { url: string; init: any }[];
  disclosureCalls(): { url: string; init: any }[];
}

function fakeHistory(): FakeHistory {
  const entries: string[] = [];
  return {
    entries,
    pushState(_state: unknown, _title: string, url?: string) {
      if (url) entries.push(url);
    },
    replaceState(_state: unknown, _title: string, url?: string) {
      if (url) entries.push(url);
    },
  };
}

/** Execute the shipped widget with a script tag and (optionally) an SPA host. */
async function start(options: StartOptions = {}): Promise<Run> {
  const env = createEnvironment();
  const attributes = options.attributes ?? {};

  (env.document as any).currentScript = {
    src: options.scriptSrc ?? null,
    getAttribute: (name: string) => (name in attributes ? attributes[name] : null),
  };
  if (options.config) env.window.LPP_CHAT_CONFIG = options.config;

  const history = fakeHistory();
  const windowListeners: Record<string, ((event: any) => void)[]> = {};
  const removedDocumentListeners: string[] = [];

  if (options.spa) {
    (env.window as any).history = history;
    (env.window as any).addEventListener = (type: string, handler: (event: any) => void) => {
      (windowListeners[type] ??= []).push(handler);
    };
    (env.window as any).removeEventListener = (type: string, handler: (event: any) => void) => {
      windowListeners[type] = (windowListeners[type] ?? []).filter((fn) => fn !== handler);
    };
  }

  // Record removals so teardown is observable without reaching into the widget.
  const removeDocumentListener = env.document.removeEventListener.bind(env.document);
  (env.document as any).removeEventListener = (type: string, handler: (event: any) => void) => {
    removedDocumentListeners.push(type);
    removeDocumentListener(type, handler);
  };

  executeWidget(WIDGET_SOURCE, env);
  await env.fetch.respond(DISCLOSURE);

  // The widget's internals live in a shadow root; only the host is in the
  // document, so lookups go through it rather than through `document`.
  const host = env.document.getElementById('lpp-chat-widget-host');
  if (!host || !host.shadowRoot) throw new Error('Widget did not create its shadow host');

  const panel = widgetElement(env.document, 'lpp-chat-widget');
  const launcher = widgetElement(env.document, 'lpp-chat-launcher');
  const input = widgetElement(env.document, 'lpp-chat-input');
  const styleTag = widgetElement(env.document, 'lpp-chat-a11y-styles');

  const run: Run = {
    document: env.document,
    window: env.window,
    fetch: env.fetch,
    history,
    removedDocumentListeners,
    dispatchWindowEvent(type: string) {
      for (const handler of windowListeners[type] ?? []) handler({ type });
    },
    panel,
    launcher,
    input,
    styleTag,
    send(text: string) {
      if (panel.styleValue('display') === 'none') launcher.dispatch('click');
      input.value = text;
      input.dispatch('keydown', { key: 'Enter', shiftKey: false });
    },
    chatCalls() {
      return env.fetch.calls.filter((call) => call.url.includes('/api/chat'));
    },
    disclosureCalls() {
      return env.fetch.calls.filter((call) => call.url.includes('/api/disclosure'));
    },
  };

  return run;
}

/** The JSON body of the nth chat request. */
function payloadAt(run: Run, index: number): any {
  return JSON.parse(run.chatCalls()[index].init.body);
}

/** Visit a new route the way React Router does, without a page reload. */
function navigate(run: Run, pathname: string): void {
  run.window.location.pathname = pathname;
  run.window.location.href = `https://lifeinsurancebrokeradvocate.com${pathname}`;
  (run.window as any).history.pushState({}, '', pathname);
}

describe('widget API base (cross-origin embed)', () => {
  it('calls every endpoint on the configured API base, not the page origin', async () => {
    const run = await start({ attributes: { 'data-api-base': 'https://lifechat.example.com/' } });
    expect(run.disclosureCalls()[0].url).toMatch(
      /^https:\/\/lifechat\.example\.com\/api\/disclosure\?/,
    );

    run.send('first');
    expect(run.chatCalls()[0].url).toBe('https://lifechat.example.com/api/chat');
  });

  it('accepts the previously documented data-server-url attribute', async () => {
    const run = await start({ attributes: { 'data-server-url': 'https://legacy.example.com' } });
    expect(run.disclosureCalls()[0].url).toMatch(/^https:\/\/legacy\.example\.com\/api\//);
  });

  it('prefers window.LPP_CHAT_CONFIG.apiBase over the script attribute', async () => {
    const run = await start({
      attributes: { 'data-api-base': 'https://attribute.example.com' },
      config: { apiBase: 'https://config.example.com' },
    });
    expect(run.disclosureCalls()[0].url).toMatch(/^https:\/\/config\.example\.com\/api\//);
  });

  it('defaults to the origin the widget script came from', async () => {
    // Serving the widget from /assets must not imply the API lives at
    // /assets/api: this app mounts it at /api.
    const run = await start({ scriptSrc: 'https://api.example.com/assets/widget.js' });
    expect(run.disclosureCalls()[0].url).toMatch(/^https:\/\/api\.example\.com\/api\/disclosure\?/);
  });

  it('ignores a relative base instead of requesting the host page origin', async () => {
    // `/api` is the trap this guards: on a static SPA host it resolves to the
    // host's own 404/HTML fallback rather than to this API.
    const run = await start({
      attributes: { 'data-api-base': '/api' },
      scriptSrc: 'https://api.example.com/widget.js',
    });
    expect(run.disclosureCalls()[0].url).toMatch(/^https:\/\/api\.example\.com\/api\/disclosure\?/);
  });

  it('strips trailing slashes so no request path contains a double slash', async () => {
    const run = await start({ attributes: { 'data-api-base': 'https://api.example.com///' } });
    expect(run.disclosureCalls()[0].url).toContain('https://api.example.com/api/disclosure?');
  });
});

describe('widget SPA route awareness', () => {
  it('re-reads the page context after a pushState route change', async () => {
    const run = await start({ spa: true });

    run.send('first');
    const first = payloadAt(run, 0);
    expect(first.sourceUrl).toBe('/articles/term-life-basics');
    expect(first.page_context.url).toBe('https://blog.example.test/articles/term-life-basics');
    await run.fetch.respond(REPLY);

    navigate(run, '/tools/ibc-lab');
    run.send('second');
    const second = payloadAt(run, 1);
    expect(second.sourceUrl).toBe('/tools/ibc-lab');
    expect(second.page_context.url).toBe('https://lifeinsurancebrokeradvocate.com/tools/ibc-lab');
    await run.fetch.respond(REPLY);

    // Same route again: ordinary follow-up, no page context re-sent.
    run.send('third');
    expect(payloadAt(run, 2)).not.toHaveProperty('page_context');
  });

  it('treats back/forward navigation as a route change', async () => {
    const run = await start({ spa: true });
    run.send('first');
    await run.fetch.respond(REPLY);

    run.window.location.pathname = '/about';
    run.window.location.href = 'https://lifeinsurancebrokeradvocate.com/about';
    run.dispatchWindowEvent('popstate');

    run.send('second');
    expect(payloadAt(run, 1).sourceUrl).toBe('/about');
  });

  it('does not repeat the greeting or the disclosure request on navigation', async () => {
    const run = await start({ spa: true });
    navigate(run, '/tools');
    await flushPromises();
    expect(run.disclosureCalls()).toHaveLength(1);
  });
});

describe('widget React mount lifecycle', () => {
  it('exposes a mount/destroy handle on window', async () => {
    const run = await start();
    const handle = (run.window as any).__lppChatWidget;
    expect(typeof handle.mount).toBe('function');
    expect(typeof handle.destroy).toBe('function');
  });

  it('destroy() removes the host, which takes the dialog, launcher and stylesheet with it', async () => {
    const run = await start();
    (run.window as any).__lppChatWidget.destroy();

    // One light-DOM node was all that ever existed; removing it removes
    // everything, including the stylesheet inside the shadow root.
    expect(run.document.allById('lpp-chat-widget-host')).toHaveLength(0);
    expect(run.document.allById('lpp-chat-widget')).toHaveLength(0);
    expect(run.document.allById('lpp-chat-launcher')).toHaveLength(0);
    expect(run.document.allById('lpp-chat-a11y-styles')).toHaveLength(0);
  });

  it('destroy() removes the document focus listener it added', async () => {
    const run = await start();
    (run.window as any).__lppChatWidget.destroy();
    expect(run.removedDocumentListeners).toContain('focusin');
  });

  it('mount() after destroy() restores exactly one of everything, for StrictMode', async () => {
    const run = await start();
    const handle = (run.window as any).__lppChatWidget;

    handle.destroy();
    handle.mount();
    handle.mount();

    const hosts = run.document.allById('lpp-chat-widget-host');
    expect(hosts).toHaveLength(1);
    expect(hosts[0].shadowRoot!.allById('lpp-chat-widget')).toHaveLength(1);
    expect(hosts[0].shadowRoot!.allById('lpp-chat-launcher')).toHaveLength(1);
    expect(hosts[0].shadowRoot!.allById('lpp-chat-a11y-styles')).toHaveLength(1);
    expect(hosts[0].shadowRoot!.allById('lpp-chat-input')).toHaveLength(1);
  });

  it('hands the page history back on destroy and re-attaches on mount', async () => {
    const run = await start({ spa: true });
    const wrapped = run.history.pushState;

    (run.window as any).__lppChatWidget.destroy();
    expect(run.history.pushState).not.toBe(wrapped);
    // The host's own navigation still works after teardown.
    expect(() => run.history.pushState({}, '', '/after-destroy')).not.toThrow();

    const restored = run.history.pushState;
    (run.window as any).__lppChatWidget.mount();
    // A fresh wrapper replaces the host's original method again.
    expect(run.history.pushState).not.toBe(restored);
  });

  it('keeps the conversation across a destroy/mount cycle', async () => {
    const run = await start();
    const before = (run.window as any).__lppChatWidget;
    run.send('first');
    await run.fetch.respond(REPLY);
    const transcriptLength = widgetElement(run.document, 'lpp-chat-messages').childNodes.length;

    before.destroy();
    (run.window as any).__lppChatWidget.mount();

    expect(widgetElement(run.document, 'lpp-chat-messages').childNodes.length).toBe(
      transcriptLength,
    );
  });

  it('a second inclusion of the script re-attaches instead of rebuilding', async () => {
    const run = await start();
    const widgetCount = run.document.allById('lpp-chat-widget-host').length;
    executeWidget(WIDGET_SOURCE, {
      document: run.document,
      window: run.window,
      fetch: run.fetch,
      timers: { setTimeout: () => 0, clearTimeout: () => {} } as any,
    });
    expect(run.document.allById('lpp-chat-widget-host')).toHaveLength(widgetCount);
  });
});

describe('widget error surfaces across an origin boundary', () => {
  /** The text of every bubble, oldest first. */
  function transcript(run: Run): string[] {
    return widgetElement(run.document, 'lpp-chat-messages').childNodes.map((node) =>
      node.visibleText(),
    );
  }

  it('turns a 429 JSON body into a readable message rather than "undefined"', async () => {
    const run = await start();
    run.send('first');
    await run.fetch.respond({ error: 'Too many requests' }, 429);

    const bubbles = transcript(run);
    expect(bubbles[bubbles.length - 1]).toContain('Please wait a moment');
    expect(bubbles.join(' ')).not.toContain('undefined');
  });

  it('treats a non-JSON error page as a failed request', async () => {
    const run = await start();
    run.send('first');
    // What a proxy or a static host returns for an unknown route: HTML.
    await run.fetch.respond('<html><body>Not found</body></html>', 404);

    const bubbles = transcript(run);
    expect(bubbles[bubbles.length - 1]).toContain('having trouble responding');
    expect(bubbles.join(' ')).not.toContain('<html>');
  });

  it('creates window.dataLayer when the host has no GTM yet', async () => {
    const run = await start();
    delete (run.window as any).dataLayer;

    run.send('first');
    await run.fetch.respond({
      ...REPLY,
      analytics: { event_name: 'chat_reply', conversation_stage: 'education', fallback_type: null },
    });

    expect((run.window as any).dataLayer).toEqual([
      { event: 'chat_reply', conversation_stage: 'education', fallback_type: null },
    ]);
  });

  it('survives a host dataLayer that refuses pushes', async () => {
    const run = await start();
    (run.window as any).dataLayer = {
      push() {
        throw new Error('consent manager blocked analytics');
      },
    };

    run.send('first');
    await run.fetch.respond({ ...REPLY, analytics: { event_name: 'chat_reply' } });

    const bubbles = transcript(run);
    expect(bubbles[bubbles.length - 1]).toBe(REPLY.assistant_message);
  });
});

describe('widget under a Tailwind host page', () => {
  it('keeps citation and step markers that preflight would strip', async () => {
    const run = await start();
    const css = run.styleTag.textContent;
    expect(css).toContain('.lpp-chat-widget ul { list-style-type: disc');
    expect(css).toContain('.lpp-chat-widget ol { list-style-type: decimal');
    // The appointment picker is a radiogroup, not a bulleted list.
    expect(css).toContain('.lpp-chat-widget .lpp-slots-list { list-style: none; }');
  });

  it('lets the embed pin the launcher below a cookie banner or modal layer', async () => {
    const run = await start({
      attributes: { 'data-z-index': '40', 'data-bottom-offset': '72' },
    });
    expect(run.panel.styleValue('z-index')).toBe('40');
    expect(run.panel.styleValue('bottom')).toBe('calc(72px + env(safe-area-inset-bottom, 0px))');
    expect(run.launcher.styleValue('z-index')).toBe('40');
    expect(run.launcher.styleValue('bottom')).toBe('calc(72px + env(safe-area-inset-bottom, 0px))');
  });

  it('keeps the launcher above the device safe area by default', async () => {
    // bottom:0 puts the launcher under the iOS home indicator / Android
    // gesture bar, where it cannot be tapped. The inset is added, not
    // substituted, so a configured offset still clears the host layer.
    const run = await start();
    expect(run.launcher.styleValue('bottom')).toBe('calc(0px + env(safe-area-inset-bottom, 0px))');
    expect(run.panel.styleValue('bottom')).toBe('calc(0px + env(safe-area-inset-bottom, 0px))');
    expect(run.panel.styleValue('max-height')).toBe(
      'calc(100vh - 16px - env(safe-area-inset-bottom, 0px))',
    );
  });

  it('ignores stacking values that would make the widget unreachable', async () => {
    // A negative z-index renders behind the page and a negative offset pushes
    // the launcher off-screen: both look like a widget that failed to load.
    const run = await start({ config: { zIndex: -1, bottomOffset: -40 } });
    expect(run.panel.styleValue('z-index')).toBe('9999');
    expect(run.launcher.styleValue('bottom')).toBe('calc(0px + env(safe-area-inset-bottom, 0px))');
  });

  it('ignores a non-numeric attribute rather than emitting invalid CSS', async () => {
    const run = await start({
      attributes: { 'data-z-index': 'front', 'data-bottom-offset': '12px' },
    });
    expect(run.panel.styleValue('z-index')).toBe('9999');
    expect(run.launcher.styleValue('bottom')).toBe('calc(0px + env(safe-area-inset-bottom, 0px))');
  });

  it('accepts the same stacking values through window.LPP_CHAT_CONFIG', async () => {
    const run = await start({ config: { zIndex: 45, bottomOffset: 88 } });
    expect(run.panel.styleValue('z-index')).toBe('45');
    expect(run.launcher.styleValue('bottom')).toBe('calc(88px + env(safe-area-inset-bottom, 0px))');
  });

  it('renders the product display name the API sends', async () => {
    // The widget ships fallback constants for the window before the fetch
    // resolves; once the payload arrives, the server's copy wins so the header
    // cannot drift from the disclosure the API serves.
    const run = runWidget(WIDGET_SOURCE);
    await run.fetch.respond({
      ...DISCLOSURE,
      productName: 'LifeChat',
      providerBrand: 'Life Insurance Broker Advocate',
      productDisplayName: 'LifeChat by Life Insurance Broker Advocate',
    });
    expect(run.title.textContent).toBe('LifeChat by Life Insurance Broker Advocate');
    expect(run.launcher.getAttribute('aria-label')).toBe(
      'Chat with LifeChat, the AI educational assistant from Life Insurance Broker Advocate',
    );
  });

  it('keeps today’s layering when nothing is configured', async () => {
    const run = runWidget(WIDGET_SOURCE);
    expect(run.widget.styleValue('z-index')).toBe('9999');
    expect(run.widget.styleValue('bottom')).toBe('calc(0px + env(safe-area-inset-bottom, 0px))');
  });
});
