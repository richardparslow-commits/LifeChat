/**
 * A deliberately tiny DOM for executing public/widget.js under Jest.
 *
 * The widget is plain ES5 served statically — it is a drop-in script for
 * WordPress/Elementor pages and cannot import from src/. Jest here runs on the
 * node test environment with no jsdom dependency, so the widget's accessibility
 * contract would otherwise be reviewable only by reading it.
 *
 * This shim implements exactly the DOM surface widget.js touches: element
 * creation, attributes, inline style (including `cssText`), text content,
 * child lists, focus, and events. It is not a browser: it does not lay out,
 * paint, or compute cascade. Every assertion built on it is therefore about the
 * DOM the widget builds — names, roles, attributes, inline geometry — and the
 * review records separately which parts need a human in a real browser.
 */

interface FakeStyle {
  cssText: string;
  setProperty(name: string, value: string): void;
  getPropertyValue(name: string): string;
  removeProperty(name: string): void;
  [key: string]: any;
}

function createStyle(): FakeStyle {
  const declared: Record<string, string> = {};
  const style: any = {
    setProperty(name: string, value: string) {
      declared[name] = value;
      style[name] = value;
    },
    getPropertyValue(name: string) {
      return declared[name] ?? '';
    },
    removeProperty(name: string) {
      delete declared[name];
      delete style[name];
    },
  };
  Object.defineProperty(style, 'cssText', {
    get() {
      return declared.__cssText ?? '';
    },
    set(value: string) {
      declared.__cssText = value;
      for (const declaration of String(value).split(';')) {
        const separator = declaration.indexOf(':');
        if (separator > 0) {
          const property = declaration.slice(0, separator).trim();
          style[property] = declaration.slice(separator + 1).trim();
        }
      }
    },
  });
  return style as FakeStyle;
}

export class FakeElement {
  readonly tagName: string;
  ownerDocument: FakeDocument | null = null;
  id = '';
  className = '';
  type = '';
  placeholder = '';
  value = '';
  onclick: ((event: any) => void) | null = null;
  parentNode: FakeElement | null = null;
  childNodes: FakeElement[] = [];
  style: FakeStyle = createStyle();
  private attributes: Record<string, string> = {};
  private listeners: Record<string, ((event: any) => void)[]> = {};
  private text = '';

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
  }

  get children(): FakeElement[] {
    return this.childNodes;
  }

  get lastChild(): FakeElement | null {
    return this.childNodes.length > 0 ? this.childNodes[this.childNodes.length - 1] : null;
  }

  get textContent(): string {
    // Leaf semantics, like the real thing: a node with children reports their
    // text, and assigning text discards the children.
    if (this.childNodes.length === 0) return this.text;
    return this.childNodes.map((child) => child.textContent).join('');
  }

  set textContent(value: string) {
    this.childNodes = [];
    this.text = String(value);
  }

  /** Text of this element and its descendants, ignoring visually hidden text. */
  visibleText(): string {
    const hidden = this.className.split(/\s+/).includes('lpp-visually-hidden');
    if (hidden) return '';
    if (this.childNodes.length === 0) return this.text;
    return this.childNodes.map((child) => child.visibleText()).join('');
  }

  /** All descendant nodes, this element excluded. */
  descendants(): FakeElement[] {
    return this.childNodes.flatMap((child) => [child, ...child.descendants()]);
  }

  appendChild(child: FakeElement): FakeElement {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  removeChild(child: FakeElement): FakeElement {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  setAttribute(name: string, value: unknown): void {
    this.attributes[name] = String(value);
    if (name === 'id') this.id = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  removeAttribute(name: string): void {
    delete this.attributes[name];
  }

  addEventListener(type: string, handler: (event: any) => void): void {
    (this.listeners[type] ??= []).push(handler);
  }

  removeEventListener(type: string, handler: (event: any) => void): void {
    this.listeners[type] = (this.listeners[type] ?? []).filter((fn) => fn !== handler);
  }

  /** Fire an event at this element, running handlers and the onclick property. */
  dispatch(type: string, event: Record<string, unknown> = {}): void {
    const payload = { type, target: this, preventDefault() {}, ...event };
    for (const handler of this.listeners[type] ?? []) handler(payload);
    if (type === 'click' && typeof this.onclick === 'function') this.onclick(payload);
  }

  focus(): void {
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  blur(): void {
    if (this.ownerDocument && this.ownerDocument.activeElement === this) {
      this.ownerDocument.activeElement = null;
    }
  }

  /** Inline style value, whether it came from cssText or a direct assignment. */
  styleValue(property: string): string {
    const direct = this.style[property];
    if (typeof direct === 'string' && direct.length > 0) return direct;
    const declaration = new RegExp(`(?:^|;)\\s*${property}\\s*:([^;]*)`).exec(this.style.cssText);
    return declaration ? declaration[1].trim() : '';
  }
}

export class FakeDocument {
  head = new FakeElement('head');
  body = new FakeElement('body');
  title = 'A test page';
  activeElement: FakeElement | null = null;
  currentScript: { getAttribute(name: string): string | null } | null = {
    getAttribute: (name: string) =>
      name === 'data-server-url' ? 'https://server.example.test' : null,
  };

  constructor() {
    this.head.ownerDocument = this;
    this.body.ownerDocument = this;
  }

  createElement(tagName: string): FakeElement {
    const element = new FakeElement(tagName);
    element.ownerDocument = this;
    return element;
  }

  /** Every element in the document carrying this id. */
  allById(id: string): FakeElement[] {
    return [this.head, this.body]
      .flatMap((root) => root.descendants())
      .filter((element) => element.id === id || element.getAttribute('id') === id);
  }

  getElementById(id: string): FakeElement | null {
    return this.allById(id)[0] ?? null;
  }

  /** No host-page meta tags are simulated; the widget must tolerate that. */
  querySelector(): FakeElement | null {
    return null;
  }

  querySelectorAll(): FakeElement[] {
    return [];
  }
}

export interface FakeWindow {
  location: { href: string; pathname: string };
  matchMedia(query: string): { matches: boolean; media: string };
  dataLayer: Record<string, unknown>[];
  [key: string]: any;
}

export function createWindow(options: { reducedMotion?: boolean } = {}): FakeWindow {
  return {
    location: {
      href: 'https://blog.example.test/articles/term-life-basics',
      pathname: '/articles/term-life-basics',
    },
    matchMedia: (query: string) => ({
      matches: query.includes('prefers-reduced-motion') && options.reducedMotion === true,
      media: query,
    }),
    dataLayer: [],
  };
}

/** A controllable timer queue, so the typing indicator is testable. */
export class FakeTimers {
  private queue: { id: number; callback: () => void }[] = [];
  private nextId = 1;

  setTimeout = (callback: () => void): number => {
    const id = this.nextId++;
    this.queue.push({ id, callback });
    return id;
  };

  clearTimeout = (id: number): void => {
    this.queue = this.queue.filter((entry) => entry.id !== id);
  };

  /** Run every pending timer now. */
  run(): void {
    const pending = this.queue;
    this.queue = [];
    for (const entry of pending) entry.callback();
  }

  get pending(): number {
    return this.queue.length;
  }
}

export interface FakeResponse {
  json(): Promise<unknown>;
}

/** A fetch double that records requests and defers their resolution. */
export class FakeFetch {
  readonly calls: { url: string; init: any }[] = [];
  private pending: {
    url: string;
    resolve: (value: FakeResponse) => void;
    reject: (reason: unknown) => void;
  }[] = [];

  fetch = (url: string, init?: any): Promise<FakeResponse> => {
    this.calls.push({ url, init });
    return new Promise<FakeResponse>((resolve, reject) => {
      this.pending.push({ url, resolve, reject });
    });
  };

  /** Answer the oldest unanswered request with `body`. */
  async respond(body: unknown): Promise<void> {
    const next = this.pending.shift();
    if (!next) throw new Error('No pending request to respond to');
    next.resolve({ json: async () => body });
    await flushPromises();
  }

  /** Fail the oldest unanswered request. */
  async fail(error: unknown = new Error('network')): Promise<void> {
    const next = this.pending.shift();
    if (!next) throw new Error('No pending request to fail');
    next.reject(error);
    await flushPromises();
  }

  get pendingCount(): number {
    return this.pending.length;
  }
}

/** Let the microtask queue drain so `.then` chains settle before asserting. */
export async function flushPromises(): Promise<void> {
  for (let i = 0; i < 8; i++) {
    await Promise.resolve();
  }
}

export interface WidgetRun {
  document: FakeDocument;
  window: FakeWindow;
  fetch: FakeFetch;
  timers: FakeTimers;
  widget: FakeElement;
  launcher: FakeElement;
  title: FakeElement;
  banner: FakeElement;
  log: FakeElement;
  input: FakeElement;
  send: FakeElement;
  close: FakeElement;
  styleTag: FakeElement;
}

/** Everything one execution of the widget script needs. */
export interface WidgetEnvironment {
  document: FakeDocument;
  window: FakeWindow;
  fetch: FakeFetch;
  timers: FakeTimers;
}

export function createEnvironment(options: { reducedMotion?: boolean } = {}): WidgetEnvironment {
  return {
    document: new FakeDocument(),
    window: createWindow(options),
    fetch: new FakeFetch(),
    timers: new FakeTimers(),
  };
}

/**
 * Execute the widget source in an existing environment — used both to start a
 * widget and to prove a second inclusion of the script changes nothing.
 */
export function executeWidget(source: string, env: WidgetEnvironment): void {
  const execute = new Function('window', 'document', 'fetch', 'setTimeout', 'clearTimeout', source);
  execute(
    env.window,
    env.document,
    env.fetch.fetch,
    env.timers.setTimeout,
    env.timers.clearTimeout,
  );
}

/**
 * Execute the real widget source against a fresh document, and return the
 * handles a test needs. `source` is read from public/widget.js by the caller so
 * the test always runs the shipped file rather than a copy.
 */
export function runWidget(source: string, options: { reducedMotion?: boolean } = {}): WidgetRun {
  const env = createEnvironment(options);
  const { document, window, fetch, timers } = env;
  executeWidget(source, env);

  const element = (id: string): FakeElement => {
    const found = document.getElementById(id);
    if (!found) throw new Error(`Widget did not create #${id}`);
    return found;
  };

  const widget = element('lpp-chat-widget');
  const styleTag = element('lpp-chat-a11y-styles');

  return {
    document,
    window,
    fetch,
    timers,
    widget,
    launcher: element('lpp-chat-launcher'),
    title: element('lpp-chat-title'),
    banner: element('lpp-chat-banner'),
    log: element('lpp-chat-messages'),
    input: element('lpp-chat-input'),
    send: widget.descendants().find((node) => node.className.includes('lpp-chat-send'))!,
    close: widget.descendants().find((node) => node.className.includes('lpp-chat-close'))!,
    styleTag,
  };
}

/** The message bubbles currently in the transcript, oldest first. */
export function bubbles(run: WidgetRun): FakeElement[] {
  return run.log.childNodes.filter((node) => node.className.includes('lpp-msg'));
}
