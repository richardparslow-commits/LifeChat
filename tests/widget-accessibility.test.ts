/**
 * The Section 508 accessibility contract for the embeddable widget.
 *
 * The review (docs/section-508-accessibility-review.md) found thirteen defects
 * by reading public/widget.js by hand. Reading found them; only running the
 * shipped file can keep them fixed, so this suite executes the real script
 * against the tiny DOM in tests/helpers/dom-shim.ts and asserts the property
 * behind each finding. Test names carry the finding id (ACC-n) so the review
 * table and the suite stay traceable to each other.
 *
 * What this cannot do: it cannot run NVDA, VoiceOver, or TalkBack, and the shim
 * does not lay out or paint. Assertions here are about the DOM the widget
 * builds and its declared geometry. The matrix rows in
 * src/accessibility/accessibility.ts record, per browser/AT pair, the procedure
 * a human still has to run; the results live in
 * docs/accessibility-matrix-receipt.json, and a row may only be recorded as
 * passed when that receipt carries a complete, signed run for it
 * (tests/accessibility-checklist.test.ts covers the instrument itself).
 */

import { readFileSync } from 'fs';
import { randomFillSync } from 'crypto';
import path from 'path';

import {
  ACCESSIBILITY_TEST_MATRIX,
  ACCESSIBILITY_WALKTHROUGH_CHECKS,
  ARIA_LIVE_CONFIG,
  FOCUS_INDICATORS,
  LANGUAGE_POLICY,
  PALETTE_COLORS,
  PALETTE_CONTRAST,
  REDUCED_MOTION_CSS,
  SECTION_508_FINDINGS,
  SECTION_508_REVIEW,
  WCAG_REQUIREMENTS,
  auditAccessibilityReview,
  contrastRatio,
  deriveRowStatus,
  meetsContrast,
  relativeLuminance,
} from '../src/accessibility/accessibility';
import { loadWalkthroughReceipt } from '../src/accessibility/accessibility-checklist';
import {
  bubbles,
  createEnvironment,
  executeWidget,
  flushPromises,
  runWidget,
  widgetElement,
  type WidgetRun,
} from './helpers/dom-shim';

const WIDGET_SOURCE = readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');
const ELEMENTOR_CSS = readFileSync(
  path.join(__dirname, '..', 'public', 'elementor-trust-block.css'),
  'utf8',
);

/**
 * The disclosure envelope as `GET /api/disclosure` serves it. `banner` is the
 * server-owned before-chat notice; the widget renders this text and does not
 * keep its own copy.
 */
const DISCLOSURE = {
  firstMessage: 'I am LifeChat, the AI educational assistant from Life Insurance Broker Advocate.',
  banner:
    'You are chatting with an AI educational assistant. Do not enter medical, financial-account, Social Security, or other highly sensitive information.',
};
const REPLY = {
  assistant_message: 'Term life covers a set period.',
  state: 'education',
};

/** A resolved pre-approved card, exactly as /api/chat attaches it. */
const CARD = {
  card_id: 'comparison_term_vs_whole',
  card_type: 'comparison_table',
  title: 'Term vs. Whole Life Insurance',
  content: {
    columns: ['Feature', 'Term Life', 'Whole Life'],
    rows: [
      { feature: 'Duration', values: ['10–30 years', 'Lifetime'] },
      { feature: 'Cash Value', values: ['No', 'Yes'] },
    ],
  },
  disclaimer: 'This is general educational information, not a recommendation.',
};

const SOURCES = [
  { title: 'Term vs Whole Life', url: 'https://lifepolicypilot.blog/term-vs-whole/' },
];

/** Start a widget and settle the opening disclosure request. */
async function start(options: { reducedMotion?: boolean } = {}): Promise<WidgetRun> {
  const run = runWidget(WIDGET_SOURCE, options);
  await run.fetch.respond(DISCLOSURE);
  return run;
}

/** Open the panel from the launcher, the way a visitor starts a conversation. */
function open(run: WidgetRun): void {
  if (run.widget.styleValue('display') === 'none') run.launcher.dispatch('click');
}

/** Open the panel, type into the field and press Enter. */
function send(run: WidgetRun, text: string): void {
  open(run);
  run.input.value = text;
  run.input.dispatch('keydown', { key: 'Enter', shiftKey: false });
}

/** The chat request, as opposed to the disclosure request. */
function chatCalls(run: WidgetRun) {
  return run.fetch.calls.filter((call) => call.url.includes('/api/chat'));
}

describe('widget focus indicator (ACC-1, ACC-11)', () => {
  it('rules out the single black ring that measured below 3:1', () => {
    // The evidence the finding rests on, recomputed rather than remembered.
    expect(contrastRatio('#000000', '#414C32')).toBe(2.305);
    expect(contrastRatio('#000000', '#485B61')).toBe(2.945);
    expect(contrastRatio('#000000', '#414C32')).toBeLessThan(
      WCAG_REQUIREMENTS.NON_TEXT_BOUNDARY_CONTRAST_RATIO,
    );
    expect(WIDGET_SOURCE).not.toContain('3px solid #000000');
    expect(ELEMENTOR_CSS).not.toContain('outline: 3px solid #000000');
  });

  it('gives the buttons a light inner ring and a dark outer ring', async () => {
    const run = await start();
    const css = run.styleTag.textContent;
    const sendRule =
      /\.lpp-chat-send:focus-visible,\s*\.lpp-chat-launcher:focus-visible\s*\{([^}]*)\}/.exec(css);
    expect(sendRule).not.toBeNull();
    expect(sendRule![1]).toContain('outline: 3px solid #FFFFFF');
    expect(sendRule![1]).toContain('box-shadow: 0 0 0 6px #1a1a1a');
  });

  it('gives the input and the transcript a dark ring, and the close button a light one', async () => {
    const run = await start();
    const css = run.styleTag.textContent;
    expect(css).toMatch(/#lpp-chat-input:focus\s*\{[^}]*outline: 3px solid #1a1a1a/);
    expect(css).toMatch(/#lpp-chat-messages:focus\s*\{[^}]*outline: 3px solid #1a1a1a/);
    expect(css).toMatch(/\.lpp-chat-close:focus-visible\s*\{[^}]*outline: 3px solid #FFFFFF/);
  });

  it('keeps an outline on every focusable control in forced-colors mode', async () => {
    const run = await start();
    const css = run.styleTag.textContent;
    const forced = /@media \(forced-colors: active\) \{([\s\S]*?)\n\}/.exec(css);
    expect(forced).not.toBeNull();
    for (const selector of [
      '#lpp-chat-input:focus',
      '#lpp-chat-messages:focus',
      '.lpp-chat-send:focus-visible',
      '.lpp-chat-close:focus-visible',
      '.lpp-chat-launcher:focus-visible',
    ]) {
      expect(forced![1]).toContain(selector);
    }
    // A box-shadow band is not painted there, so it must be removed.
    expect(forced![1]).toContain('box-shadow: none');
    expect(forced![1]).toContain('solid ButtonText');
  });

  it('uses the ring colours and widths the review measured', async () => {
    const run = await start();
    const css = run.styleTag.textContent;
    for (const indicator of FOCUS_INDICATORS) {
      expect(css).toContain(`${indicator.innerRing.widthPx}px solid ${indicator.innerRing.color}`);
      if (indicator.outerRing) {
        // The second band is declared as a spread, and the width has to match
        // what the widget actually paints.
        expect(css).toContain(
          `box-shadow: 0 0 0 ${indicator.outerRing.widthPx}px ${indicator.outerRing.color}`,
        );
      }
      for (const boundary of indicator.boundaries) {
        // A two-tone indicator is a pair: the edge passes when either band
        // clears it, which is exactly what auditAccessibilityReview() checks.
        const inner = contrastRatio(indicator.innerRing.color, boundary.adjacentColor);
        const outer = indicator.outerRing
          ? contrastRatio(indicator.outerRing.color, boundary.adjacentColor)
          : 0;
        expect(Math.max(inner, outer)).toBe(boundary.ratio);
        expect(Math.max(inner, outer)).toBeGreaterThanOrEqual(
          WCAG_REQUIREMENTS.NON_TEXT_BOUNDARY_CONTRAST_RATIO,
        );
      }
    }
    // The exclusion reasoning in the module has to stay true of the code.
    expect(FOCUS_INDICATORS.some((indicator) => indicator.outerRing !== null)).toBe(true);
  });

  it('falls back to :focus where :focus-visible is unsupported', async () => {
    const run = await start();
    const css = run.styleTag.textContent;
    const fallback = /@supports not selector\(:focus-visible\) \{([\s\S]*?)\n\}/.exec(css);
    expect(fallback).not.toBeNull();
    expect(fallback![1]).toContain('.lpp-chat-send:focus');
    expect(fallback![1]).toContain('.lpp-chat-close:focus');
  });
});

describe('widget live regions and speaker identity (ACC-2, ACC-3, ACC-9)', () => {
  it('exposes exactly one live region', async () => {
    const run = await start();
    const live = run.widget
      .descendants()
      .filter((node) => node.hasAttribute('aria-live') || node.getAttribute('role') === 'log');
    expect(live).toHaveLength(ARIA_LIVE_CONFIG.MAX_LIVE_REGIONS_PER_WIDGET);
    expect(live[0]).toBe(run.log);
    expect(run.log.getAttribute('aria-live')).toBe(ARIA_LIVE_CONFIG.ASSISTANT_MESSAGES);
  });

  it('keeps aria-live off the dialog container', async () => {
    const run = await start();
    expect(run.widget.getAttribute('role')).toBe('dialog');
    expect(run.widget.hasAttribute('aria-live')).toBe(false);
  });

  it('names the speaker in text, not by bubble colour', async () => {
    const run = await start();
    send(run, 'What is term life?');
    await run.fetch.respond(REPLY);

    const [userBubble, assistantBubble] = bubbles(run).slice(-2);
    expect(userBubble.textContent).toBe('You said: What is term life?');
    expect(assistantBubble.textContent).toBe(`Assistant said: ${REPLY.assistant_message}`);
    // The label must be present for assistive tech but absent to the eye.
    expect(userBubble.visibleText()).toBe('What is term life?');
    expect(assistantBubble.visibleText()).toBe(REPLY.assistant_message);
  });

  it('has a visually-hidden utility that actually hides', async () => {
    const run = await start();
    const css = run.styleTag.textContent;
    expect(css).toMatch(/\.lpp-visually-hidden \{[\s\S]*?width: 1px/);
    expect(css).toContain('clip-path: inset(50%)');
    expect(css).toContain('position: absolute !important');
  });

  it('declares the language of its own copy', async () => {
    const run = await start();
    expect(run.widget.getAttribute('lang')).toBe(LANGUAGE_POLICY.DEFAULT_LANGUAGE);
  });
});

describe('widget keyboard operability (ACC-4, ACC-5, ACC-15)', () => {
  it('makes the scrollable transcript keyboard reachable', async () => {
    const run = await start();
    expect(run.log.getAttribute('tabindex')).toBe('0');
    expect(run.log.getAttribute('aria-label')).toBe('Conversation');
    expect(run.log.styleValue('overflow-y')).toBe('auto');
  });

  it('does not take focus when the page loads', async () => {
    const run = await start();
    expect(run.document.activeElement).not.toBe(run.input);
    expect(run.document.activeElement).not.toBe(run.send);
  });

  it('starts collapsed to its launcher instead of covering the page (ACC-15)', async () => {
    const run = await start();
    // Nothing may obscure the host page before the visitor asks for the panel,
    // and the launcher is the only entry point that exists at that moment.
    expect(run.widget.styleValue('display')).toBe('none');
    expect(run.launcher.styleValue('display')).toBe('block');
    expect(run.launcher.getAttribute('aria-expanded')).toBe('false');
    expect(run.document.activeElement).not.toBe(run.input);
  });

  it('collapses to a launcher on close, and returns focus there', async () => {
    const run = await start();
    open(run);
    expect(run.launcher.styleValue('display')).toBe('none');

    run.close.dispatch('click');
    expect(run.widget.styleValue('display')).toBe('none');
    expect(run.launcher.styleValue('display')).toBe('block');
    expect(run.launcher.getAttribute('aria-expanded')).toBe('false');
    expect(run.document.activeElement).toBe(run.launcher);
  });

  it('reopens from the launcher and moves focus into the field', async () => {
    const run = await start();
    open(run);
    run.close.dispatch('click');
    run.launcher.dispatch('click');
    expect(run.widget.styleValue('display')).toBe('flex');
    expect(run.launcher.styleValue('display')).toBe('none');
    expect(run.launcher.getAttribute('aria-expanded')).toBe('true');
    expect(run.document.activeElement).toBe(run.input);
  });

  it('closes on Escape and restores focus to the launcher', async () => {
    const run = await start();
    open(run);
    run.input.focus();
    run.widget.dispatch('keydown', { key: 'Escape' });
    expect(run.widget.styleValue('display')).toBe('none');
    expect(run.document.activeElement).toBe(run.launcher);
  });

  it('is not a modal dialog and does not trap focus', async () => {
    const run = await start();
    // Non-modal on purpose: trapping focus in a widget embedded in a page the
    // visitor still has to read would itself be a failure (2.1.2).
    expect(run.widget.hasAttribute('aria-modal')).toBe(false);
    expect(WIDGET_SOURCE).not.toMatch(/key === 'Tab'/);
    expect(WIDGET_SOURCE).not.toContain('role", "presentation"');
  });
});

describe('widget focus-collapse toggle (ACC-15)', () => {
  it('offers a visible minimize control wired to the panel body', async () => {
    const run = await start();
    open(run);
    expect(run.collapse.visibleText()).toBe('Minimize');
    expect(run.collapse.type).toBe('button');
    expect(run.collapse.getAttribute('aria-expanded')).toBe('true');
    expect(run.collapse.getAttribute('aria-controls')).toBe('lpp-chat-body');
    expect(run.body.styleValue('display')).toBe('flex');
    // The header (identity disclosure + close) must stay; only the body folds.
    expect(run.banner.parentNode).toBe(run.body);
    expect(run.log.parentNode).toBe(run.body);
  });

  it('folds the panel to its header and moves focus out before hiding', async () => {
    const run = await start();
    open(run);
    run.input.focus();
    run.collapse.dispatch('click');

    expect(run.body.styleValue('display')).toBe('none');
    expect(run.collapse.getAttribute('aria-expanded')).toBe('false');
    expect(run.collapse.visibleText()).toBe('Expand');
    expect(run.collapse.getAttribute('aria-label')).toContain('Expand');
    // Hiding a subtree that holds focus would strand the user on the body.
    expect(run.document.activeElement).toBe(run.collapse);
  });

  it('re-expands with the conversation intact', async () => {
    const run = await start();
    open(run);
    run.collapse.dispatch('click');
    run.collapse.dispatch('click');

    expect(run.body.styleValue('display')).toBe('flex');
    expect(run.collapse.getAttribute('aria-expanded')).toBe('true');
    expect(run.collapse.visibleText()).toBe('Minimize');
    expect(bubbles(run)).toHaveLength(1);
  });

  it('folds automatically when focus lands on page content behind it', async () => {
    const run = await start();
    open(run);
    const pageLink = run.document.createElement('a');
    run.document.body.appendChild(pageLink);
    run.input.focus();

    run.document.dispatch('focusin', { target: pageLink });

    expect(run.body.styleValue('display')).toBe('none');
    expect(run.collapse.getAttribute('aria-expanded')).toBe('false');
  });

  it('does not fold while focus stays inside the widget', async () => {
    const run = await start();
    open(run);
    run.input.focus();

    run.document.dispatch('focusin', { target: run.send });
    run.document.dispatch('focusin', { target: run.collapse });

    expect(run.body.styleValue('display')).toBe('flex');
  });

  it('reopens from the launcher in the expanded state', async () => {
    const run = await start();
    open(run);
    run.collapse.dispatch('click');
    run.close.dispatch('click');
    run.launcher.dispatch('click');

    expect(run.body.styleValue('display')).toBe('flex');
    expect(run.document.activeElement).toBe(run.input);
  });
});

describe('widget session identity', () => {
  it('mints the session id with crypto.randomUUID when the platform exposes it', async () => {
    const env = createEnvironment();
    const uuid = '3f1c7e2a-9b4d-4a61-8c2e-5d0f6a7b8c9d';
    env.window.crypto = { randomUUID: () => uuid };
    executeWidget(WIDGET_SOURCE, env);
    await env.fetch.respond(DISCLOSURE);

    const input = widgetElement(env.document, 'lpp-chat-input');
    const chats = () => env.fetch.calls.filter((call) => call.url.includes('/api/chat'));

    input.value = 'first';
    input.dispatch('keydown', { key: 'Enter', shiftKey: false });
    expect(JSON.parse(chats()[0].init.body).sessionId).toBe(`lpp_${uuid}`);

    await env.fetch.respond(REPLY);
    input.value = 'second';
    input.dispatch('keydown', { key: 'Enter', shiftKey: false });
    // One conversation, one id — the whole session keys off it server-side.
    expect(JSON.parse(chats()[1].init.body).sessionId).toBe(`lpp_${uuid}`);
  });

  it('falls back to getRandomValues when randomUUID is unavailable or blocked', async () => {
    const env = createEnvironment();
    env.window.crypto = {
      randomUUID: () => {
        throw new Error('insecure context');
      },
      getRandomValues: (array: Uint8Array) => randomFillSync(array),
    };
    executeWidget(WIDGET_SOURCE, env);
    await env.fetch.respond(DISCLOSURE);

    const input = widgetElement(env.document, 'lpp-chat-input');
    input.value = 'hello';
    input.dispatch('keydown', { key: 'Enter', shiftKey: false });

    const call = env.fetch.calls.find((entry) => entry.url.includes('/api/chat'))!;
    // 128 bits of CSPRNG output, hex encoded — never Math.random.
    expect(JSON.parse(call.init.body).sessionId).toMatch(/^lpp_[0-9a-f]{32}$/);
  });

  it('never falls back to a non-cryptographic generator', () => {
    // The fallback chain is documented in a comment, so assert on call syntax:
    // a `Math.random()` call anywhere in the widget would defeat the session
    // id's entropy and is what SEC-05 exists to prevent.
    expect(WIDGET_SOURCE).not.toMatch(/Math\.random\s*\(/);
  });

  it('refuses to start a chat when the browser has no CSPRNG at all', async () => {
    const env = createEnvironment();
    env.window.crypto = undefined;
    executeWidget(WIDGET_SOURCE, env);
    await env.fetch.respond(DISCLOSURE);

    const input = widgetElement(env.document, 'lpp-chat-input');
    input.value = 'hello';
    input.dispatch('keydown', { key: 'Enter', shiftKey: false });

    expect(env.fetch.calls.filter((entry) => entry.url.includes('/api/chat'))).toHaveLength(0);
  });
});

describe('widget pre-approved cards and citations', () => {
  it('renders a comparison card as a figure with scoped table headers', async () => {
    const run = await start();
    send(run, 'Compare term and whole');
    await run.fetch.respond({ ...REPLY, visual_card: CARD, citations: SOURCES });

    const figure = run.log.descendants().find((node) => node.tagName === 'FIGURE');
    expect(figure).toBeDefined();
    expect(figure!.className).toContain('lpp-card');
    const caption = figure!.childNodes.find((node) => node.tagName === 'FIGCAPTION');
    expect(caption!.textContent).toBe(CARD.title);

    const table = figure!.descendants().find((node) => node.tagName === 'TABLE')!;
    expect(
      table
        .descendants()
        .filter((node) => node.tagName === 'TH')
        .map((th) => th.getAttribute('scope')),
    ).toEqual(['col', 'col', 'col', 'row', 'row']);
    expect(table.textContent).toContain('Lifetime');
    expect(figure!.textContent).toContain(CARD.disclaimer);
  });

  it('renders a bullet list as a real list, not a run of divs', async () => {
    const run = await start();
    send(run, 'underwriting factors');
    await run.fetch.respond({
      ...REPLY,
      visual_card: {
        ...CARD,
        card_id: 'bullet_underwriting_factors',
        card_type: 'bullet_list',
        title: 'Key Factors',
        content: { items: ['Age', 'Health history'] },
      },
    });

    const figure = run.log.descendants().find((node) => node.tagName === 'FIGURE')!;
    const items = figure.descendants().filter((node) => node.tagName === 'LI');
    expect(items.map((item) => item.textContent)).toEqual(['Age', 'Health history']);
  });

  it('renders every approved card type as semantic content', async () => {
    const scenarios = [
      {
        card_type: 'definition_card',
        content: {
          term: 'Premium',
          definition: 'What you pay.',
          example: 'For example, $30 a month.',
        },
        expected: 'What you pay.',
      },
      {
        card_type: 'process_steps',
        content: { steps: [{ step_number: 1, title: 'Application', description: 'You apply.' }] },
        expected: 'Application',
      },
      {
        card_type: 'faq_accordion',
        content: { items: [{ question: 'Who can be a beneficiary?', answer: 'Anyone.' }] },
        expected: 'Anyone.',
      },
      {
        card_type: 'link_card',
        content: {
          description: 'Read more.',
          url: 'https://example.com/article',
          link_text: 'Read the full article',
        },
        expected: 'Read the full article',
      },
      {
        card_type: 'warning_card',
        content: { severity: 'important', message: 'Not a recommendation.' },
        expected: 'Not a recommendation.',
      },
      {
        card_type: 'stat_card',
        content: {
          statistic: '10 days',
          description: 'Free look.',
          source: 'Texas Insurance Code',
        },
        expected: 'Free look.',
      },
    ];

    for (const scenario of scenarios) {
      const run = await start();
      send(run, 'show me');
      await run.fetch.respond({
        ...REPLY,
        visual_card: {
          card_id: `fixture_${scenario.card_type}`,
          card_type: scenario.card_type,
          title: 'Approved card',
          content: scenario.content,
          disclaimer: null,
        },
      });

      const figure = run.log.descendants().find((node) => node.tagName === 'FIGURE');
      expect(figure).toBeDefined();
      expect(figure!.className).toContain(`lpp-card-${scenario.card_type}`);
      expect(figure!.textContent).toContain(scenario.expected);
      expect(figure!.textContent).toContain('Approved card');
    }
  });

  it('lists citations as a named group of real links', async () => {
    const run = await start();
    send(run, 'Where is that from?');
    await run.fetch.respond({ ...REPLY, citations: SOURCES });

    const links = run.log.descendants().filter((node) => node.tagName === 'A');
    expect(links).toHaveLength(1);
    expect(links[0].getAttribute('href')).toBe(SOURCES[0].url);
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0].textContent).toBe(SOURCES[0].title);

    const group = run.log.descendants().find((node) => node.getAttribute('role') === 'group');
    expect(group).toBeDefined();
    expect(group!.textContent).toContain('Sources');
    // The group is named by its own visible label, not a second hidden string.
    const labelId = group!.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(
      group!.descendants().find((node) => node.getAttribute('id') === labelId)!.textContent,
    ).toBe('Sources');
  });

  it('writes payload text as text, never as markup', async () => {
    const run = await start();
    send(run, 'show a card');
    await run.fetch.respond({
      ...REPLY,
      visual_card: { ...CARD, title: '<img src=x onerror=alert(1)>' },
    });

    expect(run.log.descendants().some((node) => node.tagName === 'IMG')).toBe(false);
    expect(run.log.textContent).toContain('<img src=x onerror=alert(1)>');
  });

  it('drops unsafe citation URLs and an unapproved card type', async () => {
    const run = await start();
    send(run, 'anything');
    await run.fetch.respond({
      ...REPLY,
      citations: [
        { title: 'Script', url: 'javascript:alert(1)' },
        { title: 'Relative', url: '//evil.example/x' },
        { title: '', url: 'https://ok.example/x' },
      ],
      visual_card: {
        card_id: 'model_generated',
        card_type: 'freeform',
        title: 'Not approved',
        content: { anything: 'goes' },
      },
    });

    expect(run.log.descendants().filter((node) => node.tagName === 'A')).toHaveLength(0);
    expect(run.log.descendants().some((node) => node.tagName === 'FIGURE')).toBe(false);
  });
});

describe('widget message formatting (UI-02, UI-04)', () => {
  it('keeps the paragraph breaks an approved answer carries', async () => {
    const run = await start();
    const answer = 'Term life covers a set period.\n\nWhole life covers your lifetime.';
    send(run, 'What is the difference?');
    await run.fetch.respond({ ...REPLY, assistant_message: answer });

    const bubble = bubbles(run).slice(-1)[0];
    // Without pre-wrap the blank line collapses and the answer arrives as one
    // unformatted wall of text.
    expect(bubble.styleValue('white-space')).toBe('pre-wrap');
    expect(bubble.styleValue('overflow-wrap')).toBe('break-word');
    expect(bubble.visibleText()).toBe(answer);
  });

  it('lets a card keep its own block layout inside a pre-wrapped bubble', async () => {
    const run = await start();
    send(run, 'Compare them');
    await run.fetch.respond({ ...REPLY, visual_card: CARD });

    const figure = run.log.descendants().find((node) => node.tagName === 'FIGURE')!;
    expect(figure.styleValue('white-space')).toBe('normal');
  });

  it('declares every type size in rem so it scales with the host page', () => {
    // A px size inside a third-party drop-in ignores the visitor's browser
    // font preference and the host page's root size (WCAG 1.4.4).
    expect(WIDGET_SOURCE).not.toMatch(/font-size:\s*\d+(?:\.\d+)?px/);
    expect(WIDGET_SOURCE).toMatch(/font-size:0\.9375rem/); // panel text, 15px at a 16px root
    expect(WIDGET_SOURCE).toMatch(/font-size:0\.75rem/); // 12px at a 16px root
  });
});

describe('widget reflow and geometry (ACC-6)', () => {
  it('sizes the panel so it cannot exceed the viewport', async () => {
    const run = await start();
    expect(run.widget.styleValue('width')).toBe('min(360px, 100vw)');
    expect(run.widget.styleValue('max-height')).toBe(
      'calc(100vh - 16px - env(safe-area-inset-bottom, 0px))',
    );
    expect(run.styleTag.textContent).toContain('100dvh');
    expect(run.styleTag.textContent).toContain(
      '.lpp-chat-widget, .lpp-chat-widget * { box-sizing: border-box; }',
    );
  });

  it('lets the input shrink and the transcript yield height', async () => {
    const run = await start();
    expect(run.input.styleValue('flex')).toBe('1 1 auto');
    expect(run.input.styleValue('min-width')).toBe('0');
    expect(run.log.styleValue('min-height')).toBe('0');
    expect(run.log.styleValue('flex')).toBe('1 1 auto');
    expect(run.send.styleValue('flex')).toBe('0 0 auto');
    // The old fixed floor is what forced the row past the panel.
    expect(WIDGET_SOURCE).not.toContain('min-width:200px');
  });

  it('fits the narrowest supported viewport without horizontal overflow', async () => {
    const run = await start();
    // Worst case: a 320 CSS px viewport, the panel at 100vw with 2px borders,
    // 16px of horizontal padding on the input row, and the flex gap.
    const viewport = 320;
    const panelContentWidth = viewport - 2 * 2; // border-box borders
    const rowChrome = 16 * 2 + 8; // input wrapper padding + gap
    const fixedMinimums = [run.input, run.send].map((node) => {
      const declared = node.styleValue('min-width');
      return declared.length > 0 ? parseFloat(declared) : WCAG_REQUIREMENTS.MIN_TARGET_SIZE_PX;
    });
    const required = fixedMinimums.reduce((total, value) => total + value, 0) + rowChrome;
    expect(required).toBeLessThanOrEqual(panelContentWidth);
  });

  it('keeps the input usable as a touch target', async () => {
    const run = await start();
    expect(parseFloat(run.input.styleValue('min-height'))).toBeGreaterThanOrEqual(
      WCAG_REQUIREMENTS.MIN_TARGET_SIZE_PX,
    );
    for (const control of [run.send, run.close, run.collapse, run.launcher]) {
      expect(parseFloat(control.styleValue('min-height'))).toBeGreaterThanOrEqual(
        WCAG_REQUIREMENTS.MIN_TARGET_SIZE_PX,
      );
      expect(parseFloat(control.styleValue('min-width'))).toBeGreaterThanOrEqual(
        WCAG_REQUIREMENTS.MIN_TARGET_SIZE_PX,
      );
    }
  });
});

describe('widget status messages (ACC-7, ACC-8)', () => {
  it('announces the pending reply as text, not as "dot dot dot"', async () => {
    const run = await start();
    send(run, 'What is term life?');
    run.timers.run();

    const indicator = bubbles(run).slice(-1)[0];
    expect(indicator.textContent).toContain('Assistant is typing');
    expect(indicator.visibleText()).toBe('…');

    await run.fetch.respond(REPLY);
    expect(bubbles(run).some((bubble) => bubble.textContent.includes('Assistant is typing'))).toBe(
      false,
    );
  });

  it('does not delete a user message that is literally "..."', async () => {
    const run = await start();
    send(run, '...');
    // Answer before the 500ms indicator appears: the old code removed whatever
    // the last child was when it saw the text "...", which was the user's own
    // message in exactly this ordering.
    await run.fetch.respond(REPLY);

    const userBubble = bubbles(run).find((bubble) => bubble.className.includes('lpp-msg-user'));
    expect(userBubble).toBeDefined();
    expect(userBubble!.visibleText()).toBe('...');
  });

  it('removes the indicator by reference when it had appeared', async () => {
    const run = await start();
    send(run, 'What is term life?');
    run.timers.run();
    expect(bubbles(run)).toHaveLength(3); // disclosure + user + indicator
    expect(bubbles(run)[2].textContent).toContain('Assistant is typing');

    await run.fetch.respond(REPLY);
    expect(bubbles(run)).toHaveLength(3); // disclosure + user + reply
    expect(bubbles(run)[2].visibleText()).toBe(REPLY.assistant_message);
    // The indicator node itself is gone, not merely overwritten.
    expect(bubbles(run).some((bubble) => bubble.textContent.includes('typing'))).toBe(false);
  });

  it('announces a failed reply assertively', async () => {
    expect(ARIA_LIVE_CONFIG.ERRORS).toBe('assertive');
    const run = await start();
    send(run, 'What is term life?');
    await run.fetch.fail();

    const failure = bubbles(run).slice(-1)[0];
    expect(failure.getAttribute('role')).toBe('alert');
    expect(failure.textContent).toMatch(/trouble responding/i);
  });

  it('reports a failed disclosure instead of inventing a greeting', async () => {
    // The approved disclosure is server-owned copy. When it cannot be read the
    // widget must not present substitute wording as the disclosure: it says
    // the conversation has not started, and announces that as an alert.
    const run = runWidget(WIDGET_SOURCE);
    await run.fetch.fail();
    const first = bubbles(run)[0];
    expect(first.textContent).toMatch(/approved disclosure .* could not be loaded/i);
    expect(first.textContent).not.toMatch(/How can I help you learn about life insurance today/);
    expect(first.getAttribute('role')).toBe('alert');
    // The banner follows the same rule: no invented notice is left standing.
    expect(run.banner.textContent).toMatch(/could not be loaded/);
  });

  it('renders the banner the server approved', async () => {
    const run = runWidget(WIDGET_SOURCE);
    await run.fetch.respond({ ...DISCLOSURE, banner: 'Approved notice from the API.' });
    expect(run.banner.textContent).toBe('Approved notice from the API.');
    // Still associated with the input, so the notice is read with the field.
    expect(run.input.getAttribute('aria-describedby')).toBe(run.banner.id);
  });
});

describe('widget accessible names and associations (ACC-10)', () => {
  it('takes the dialog name from the visible title', async () => {
    const run = await start();
    expect(run.widget.getAttribute('aria-labelledby')).toBe(run.title.id);
    expect(run.title.textContent).toBe('LifeChat by Life Insurance Broker Advocate');
    // No second, hidden name that could drift from the visible one.
    expect(run.widget.hasAttribute('aria-label')).toBe(false);
  });

  it('labels the input with a real label and the privacy banner', async () => {
    const run = await start();
    const label = run.widget
      .descendants()
      .find((node) => node.tagName === 'LABEL' && node.getAttribute('for') === run.input.id);
    expect(label).toBeDefined();
    expect(label!.textContent).toBe('Type your question');
    expect(label!.className).toContain('lpp-visually-hidden');
    expect(run.input.getAttribute('aria-describedby')).toBe(run.banner.id);
    expect(run.banner.textContent).toMatch(/Do not enter medical, financial-account/);
    expect(run.input.hasAttribute('aria-label')).toBe(false);
  });

  it('names every control', async () => {
    const run = await start();
    expect(run.send.getAttribute('aria-label')).toBe('Send message');
    expect(run.close.getAttribute('aria-label')).toBe('Close chat');
    // 2.5.3: the collapse toggle's name contains its visible text, and both
    // change together when it toggles.
    expect(run.collapse.getAttribute('aria-label')).toContain(run.collapse.visibleText());
    expect(run.collapse.getAttribute('aria-controls')).toBe(run.body.id);
    expect(run.launcher.getAttribute('aria-label')).toBeTruthy();
    // 2.5.3: the launcher's accessible name contains its visible text.
    expect(run.launcher.getAttribute('aria-label')).toContain(run.launcher.visibleText());
    expect(run.launcher.getAttribute('aria-controls')).toBe(run.widget.id);
    // 2.5.3: the send button's name contains its visible text.
    expect(run.send.getAttribute('aria-label')).toContain(run.send.visibleText());
  });

  it('uses a type on every button so no host form is submitted (ACC-14)', async () => {
    const run = await start();
    for (const control of [run.send, run.close, run.collapse, run.launcher]) {
      expect(control.type).toBe('button');
    }
  });
});

describe('widget contact and privacy forms (ACC-10, C-08)', () => {
  const CONSENT_TEXT = {
    emailConsentCopy: 'I agree to be contacted about my life-insurance inquiry.',
    phoneConsentCopy: 'Optional: I agree that Life Insurance Broker Advocate may call or text me.',
    privacyNoticeUrl: 'https://lifeinsurancebrokeradvocate.com/privacy',
  };

  /** Opens the contact form and answers its consent-text request. */
  async function openContact(): Promise<WidgetRun> {
    const run = await start();
    open(run);
    widgetElement(run.document, 'lpp-contact-toggle').dispatch('click');
    await run.fetch.respond(CONSENT_TEXT);
    return run;
  }

  it('labels every contact control with a real label', async () => {
    const run = await openContact();
    const byId = (id: string) => widgetElement(run.document, id);
    const labels = run.widget
      .descendants()
      .filter((node) => node.tagName === 'LABEL' && node.getAttribute('for'));

    const labelFor = (id: string) =>
      labels.find((node) => node.getAttribute('for') === id)?.textContent;
    expect(labelFor('lpp-contact-name')).toContain('First name');
    expect(labelFor('lpp-contact-email')).toBe('Email address');
    expect(labelFor('lpp-contact-phone')).toBe('Phone number');
    expect(labelFor('lpp-contact-consent')).toContain(CONSENT_TEXT.emailConsentCopy);
    expect(labelFor('lpp-dsr-email')).toBe('Email address for this request');
    expect(labelFor('lpp-dsr-type')).toBe('What would you like us to do?');
    expect(labelFor('lpp-dsr-detail')).toContain('Anything else');

    // The channel choice is a named group, not two unlabelled radios.
    const fieldset = run.widget.descendants().find((node) => node.tagName === 'FIELDSET');
    expect(fieldset).toBeDefined();
    expect(fieldset!.descendants().find((node) => node.tagName === 'LEGEND')!.textContent).toBe(
      'How should Richard reach you?',
    );
    expect(byId('lpp-contact-channel-email').getAttribute('name')).toBe('lpp-contact-channel');
    expect(byId('lpp-contact-channel-phone').getAttribute('name')).toBe('lpp-contact-channel');
  });

  it('names its toggles and keeps aria-expanded in step with the panel', async () => {
    const run = await start();
    open(run);
    const contactToggle = widgetElement(run.document, 'lpp-contact-toggle');
    const dsrToggle = widgetElement(run.document, 'lpp-dsr-toggle');
    const contactPanel = widgetElement(run.document, 'lpp-contact-panel');

    for (const toggle of [contactToggle, dsrToggle]) {
      expect(toggle.type).toBe('button');
      expect(toggle.visibleText().length).toBeGreaterThan(0);
      expect(toggle.getAttribute('aria-controls')).toBeTruthy();
      expect(toggle.getAttribute('aria-expanded')).toBe('false');
    }

    contactToggle.dispatch('click');
    await run.fetch.respond(CONSENT_TEXT);
    expect(contactToggle.getAttribute('aria-expanded')).toBe('true');
    expect(contactPanel.hasAttribute('hidden')).toBe(false);
    // Opening a task moves focus to its first field.
    expect(run.document.activeElement).toBe(widgetElement(run.document, 'lpp-contact-email'));

    // The privacy form and the contact form are never open together.
    dsrToggle.dispatch('click');
    expect(contactToggle.getAttribute('aria-expanded')).toBe('false');
    expect(contactPanel.hasAttribute('hidden')).toBe(true);
    expect(dsrToggle.getAttribute('aria-expanded')).toBe('true');
    expect(run.document.activeElement).toBe(widgetElement(run.document, 'lpp-dsr-email'));
  });

  it('uses an explicit type on every new button', async () => {
    const run = await start();
    expect(widgetElement(run.document, 'lpp-contact-toggle').type).toBe('button');
    expect(widgetElement(run.document, 'lpp-dsr-toggle').type).toBe('button');
    expect(widgetElement(run.document, 'lpp-contact-submit').type).toBe('submit');
    expect(widgetElement(run.document, 'lpp-dsr-submit').type).toBe('submit');
  });

  it('announces form outcomes through status and alert, not a second live region', async () => {
    const run = await openContact();
    const live = run.widget
      .descendants()
      .filter((node) => node.hasAttribute('aria-live') || node.getAttribute('role') === 'log');
    expect(live).toHaveLength(ARIA_LIVE_CONFIG.MAX_LIVE_REGIONS_PER_WIDGET);
    expect(widgetElement(run.document, 'lpp-contact-status').getAttribute('role')).toBe('status');
    expect(widgetElement(run.document, 'lpp-contact-alert').getAttribute('role')).toBe('alert');
    expect(widgetElement(run.document, 'lpp-dsr-status').getAttribute('role')).toBe('status');
    expect(widgetElement(run.document, 'lpp-dsr-alert').getAttribute('role')).toBe('alert');
  });

  it('shows the fetched canonical copy and links the privacy notice', async () => {
    const run = await openContact();
    const copy = run.widget
      .descendants()
      .find((node) => node.className.split(/\s+/).includes('lpp-contact-copy'));
    expect(copy!.textContent).toBe(CONSENT_TEXT.emailConsentCopy);
    const link = run.widget
      .descendants()
      .find((node) => node.tagName === 'A' && node.textContent === 'Read the privacy notice');
    expect(link!.getAttribute('href')).toBe(CONSENT_TEXT.privacyNoticeUrl);
  });
});

describe('widget install guard (ACC-13)', () => {
  it('builds nothing new when the script is included twice', () => {
    const env = createEnvironment();
    executeWidget(WIDGET_SOURCE, env);
    executeWidget(WIDGET_SOURCE, env);
    // One light-DOM host; everything else is inside its shadow root, where a
    // second inclusion cannot find (and therefore cannot duplicate) it.
    const hosts = env.document.allById('lpp-chat-widget-host');
    expect(hosts).toHaveLength(1);
    expect(env.document.allById('lpp-chat-widget')).toHaveLength(0);
    expect(hosts[0].shadowRoot!.allById('lpp-chat-widget')).toHaveLength(1);
    expect(hosts[0].shadowRoot!.allById('lpp-chat-a11y-styles')).toHaveLength(1);
    expect(hosts[0].shadowRoot!.allById('lpp-chat-input')).toHaveLength(1);
  });
});

describe('widget style boundary against a host page', () => {
  it('renders inside an open shadow root, so host-page CSS cannot select its internals', () => {
    const run = runWidget(WIDGET_SOURCE);

    expect(run.host.id).toBe('lpp-chat-widget-host');
    expect(run.host.parentNode).toBe(run.document.body);
    expect(run.shadowRoot).toBe(run.host.shadowRoot);
    // The only light-DOM node is the host. Everything else is scoped inside the
    // shadow tree, where a theme selector such as `button { ... !important }`
    // cannot match it.
    expect(run.host.className).toBe('');
    for (const id of [
      'lpp-chat-widget',
      'lpp-chat-launcher',
      'lpp-chat-input',
      'lpp-chat-a11y-styles',
    ]) {
      expect(run.document.getElementById(id)).toBeNull();
      expect(run.shadowRoot.getElementById(id)).not.toBeNull();
    }
  });

  it('resets inherited typography at the boundary instead of adopting the host page', () => {
    const css = runWidget(WIDGET_SOURCE).styleTag.textContent;

    // Author rules cannot cross the boundary, but inherited properties can.
    // `all: initial` on the root drops them; the declarations after it restore
    // the widget's own type scale.
    expect(css).toContain(':host { all: initial; }');
    expect(css).toMatch(
      /\.lpp-chat-root \{ all: initial; display: block;\s*font-family: system-ui/,
    );
    expect(css).toContain('font-size: 0.9375rem');
  });
});

describe('widget palette (ACC-12)', () => {
  it('documents every colour the widget renders', async () => {
    const run = await start();
    const rendered = new Set(
      `${WIDGET_SOURCE}\n${run.styleTag.textContent}`
        .match(/#[0-9a-fA-F]{3,8}\b/g)
        ?.map((hex) => hex.toLowerCase()) ?? [],
    );
    const documented = new Set(PALETTE_COLORS.map((color) => color.toLowerCase()));
    expect([...rendered].filter((hex) => !documented.has(hex))).toEqual([]);
  });

  it('records a passing ratio for any pair rendered as text', () => {
    for (const pair of Object.values(PALETTE_CONTRAST)) {
      expect(contrastRatio(pair.color, pair.bg)).toBe(pair.ratio);
      if (pair.normalText !== 'FAIL') {
        expect(meetsContrast(pair.color, pair.bg)).toBe(true);
      }
    }
  });

  it('puts the Elementor button on the same two-tone ring', () => {
    expect(ELEMENTOR_CSS).toContain('outline: 3px solid #ffffff');
    expect(ELEMENTOR_CSS).toContain('box-shadow: 0 0 0 6px #1a1a1a');
    expect(ELEMENTOR_CSS).toContain('@media (forced-colors: active)');
  });
});

describe('widget reduced motion (ACC-1)', () => {
  it('injects exactly the module CSS, so there is one source', async () => {
    const run = await start();
    expect(run.styleTag.textContent).toContain(REDUCED_MOTION_CSS);
  });

  it('skips the pointer lift when the visitor asks for less motion', () => {
    const still = runWidget(WIDGET_SOURCE, { reducedMotion: true });
    still.send.dispatch('mouseenter');
    expect(still.send.styleValue('transform')).toBe('');
    expect(still.send.styleValue('background')).toBe('#485B61'); // colour is not motion

    const lively = runWidget(WIDGET_SOURCE, { reducedMotion: false });
    lively.send.dispatch('mouseenter');
    expect(lively.send.styleValue('transform')).toBe('translateY(-2px)');
  });
});

describe('widget API contract is unchanged', () => {
  it('asks for the disclosure with the page URL and title', async () => {
    const run = runWidget(WIDGET_SOURCE);
    // Built with encodeURIComponent, not URLSearchParams: the widget encodes a
    // space as %20, where searchParams would emit a +.
    const expectedUrl = `https://server.example.test/api/disclosure?url=${encodeURIComponent(
      'https://blog.example.test/articles/term-life-basics',
    )}&title=${encodeURIComponent('A test page')}`;
    expect(run.fetch.calls[0].url).toBe(expectedUrl);
    await run.fetch.respond(DISCLOSURE);
    expect(bubbles(run)[0].visibleText()).toBe(DISCLOSURE.firstMessage);
  });

  it('sends the page context only with the first message', async () => {
    const run = await start();
    send(run, 'first');
    const first = JSON.parse(chatCalls(run)[0].init.body);
    expect(first).toMatchObject({
      message: 'first',
      sourceUrl: '/articles/term-life-basics',
    });
    // State is server-authoritative now; the payload no longer sends it.
    expect(first.currentState).toBeUndefined();
    expect(first.sessionId).toMatch(/^lpp_[0-9a-f]{32}$/);
    expect(first.page_context).toEqual({
      url: 'https://blog.example.test/articles/term-life-basics',
      title: 'A test page',
      category: null,
      article_id: null,
    });
    await run.fetch.respond(REPLY);

    send(run, 'second');
    const second = JSON.parse(chatCalls(run)[1].init.body);
    expect(second).not.toHaveProperty('page_context');
  });

  it('pushes allowlisted analytics fields only', async () => {
    const run = await start();
    send(run, 'What is term life?');
    await run.fetch.respond({
      ...REPLY,
      analytics: {
        event_name: 'chat_reply',
        conversation_stage: 'education',
        fallback_type: null,
        user_message: 'must never be forwarded', // not allowlisted
      },
    });
    expect(run.window.dataLayer).toEqual([
      {
        event: 'chat_reply',
        conversation_stage: 'education',
        fallback_type: null,
      },
    ]);
  });

  it('ignores an empty message', async () => {
    const run = await start();
    send(run, '   ');
    expect(chatCalls(run)).toHaveLength(0);
    await flushPromises();
    expect(bubbles(run)).toHaveLength(1); // the disclosure only
  });

  it('does not send while an IME composition is committing (ACC-14)', async () => {
    const run = await start();
    run.input.value = 'こん';
    run.input.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: true });
    expect(chatCalls(run)).toHaveLength(0);
    run.input.dispatch('keydown', { key: 'Enter', shiftKey: false, isComposing: false });
    expect(chatCalls(run)).toHaveLength(1);
  });
});

describe('review record and gate', () => {
  it('passes its own audit', () => {
    expect(auditAccessibilityReview()).toEqual([]);
  });

  it('would catch a drifted ratio, a dead colour, and an open blocker', () => {
    // The audit must be able to fail; a gate that cannot fail is decoration.
    const drifted = {
      ...SECTION_508_REVIEW,
      findings: [
        ...SECTION_508_REVIEW.findings,
        {
          id: 'ACC-X',
          title: 'synthetic',
          severity: 'high' as const,
          criteria: ['1.1.1 Non-text Content'],
          status: 'open' as const,
          evidence: 'nothing',
          resolution: '',
        },
      ],
    };
    const gaps = auditAccessibilityReview(drifted);
    expect(gaps.map((gap) => gap.code)).toContain('open_blocking_finding');

    const undocumented = {
      ...SECTION_508_REVIEW,
      findings: SECTION_508_REVIEW.findings.map((finding) =>
        finding.id === 'ACC-1' ? { ...finding, criteria: [], evidence: '' } : finding,
      ),
    };
    const codes = auditAccessibilityReview(undocumented).map((gap) => gap.code);
    expect(codes).toContain('finding_without_criterion');
    expect(codes).toContain('finding_without_evidence');

    // And the palette half: a hand-edited ratio is a failure.
    const originalRatio = PALETTE_CONTRAST.HEADLINE_ON_BG.ratio;
    expect(contrastRatio('#CC0700', '#E2E8F0')).toBe(originalRatio);
    expect(relativeLuminance('#FFFFFF')).toBe(1);
  });

  it('maps every finding to a criterion and an outcome', () => {
    expect(SECTION_508_FINDINGS.length).toBeGreaterThanOrEqual(15);
    const ids = SECTION_508_FINDINGS.map((finding) => finding.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const finding of SECTION_508_FINDINGS) {
      expect(finding.criteria.length).toBeGreaterThan(0);
      expect(finding.evidence.length).toBeGreaterThan(20);
      expect(['fixed', 'mitigated', 'open']).toContain(finding.status);
      if (finding.status !== 'fixed') {
        expect(['mitigated', 'open']).toContain(finding.status);
        expect(finding.resolution.length).toBeGreaterThan(20);
      }
    }
    // ACC-15 is now fixed by the focus-collapse behaviour; nothing may be left
    // unresolved without a documented, deliberate record.
    const unresolved = SECTION_508_FINDINGS.filter((finding) => finding.status !== 'fixed');
    expect(unresolved.map((finding) => finding.id)).toEqual([]);
  });

  it('takes every browser/AT row status from the recorded walkthrough', () => {
    expect(SECTION_508_REVIEW.matrix).toHaveLength(ACCESSIBILITY_TEST_MATRIX.length);
    const { receipt, gaps } = loadWalkthroughReceipt();
    expect(gaps).toEqual([]);
    if (receipt === null) {
      throw new Error('docs/accessibility-matrix-receipt.json is missing');
    }
    for (const row of SECTION_508_REVIEW.matrix) {
      expect(row.automatedCoverage).toMatch(/asserted in CI/);
      expect(row.humanProcedure).toMatch(/tab from the page into the widget/);
      expect(row.humanProcedure).toContain('npm run a11y:checklist');
      // The procedure IS the check library, so a check cannot go missing from it.
      for (const check of ACCESSIBILITY_WALKTHROUGH_CHECKS) {
        expect(row.humanProcedure).toContain(check.check);
      }
      // No row may claim a human pass it cannot evidence.
      expect(row.humanStatus).toBe(deriveRowStatus(receipt, row));
    }
    expect(auditAccessibilityReview(SECTION_508_REVIEW, receipt)).toEqual([]);
    expect(SECTION_508_REVIEW.limits.join(' ')).toContain('not_performed');
  });

  it('names the surfaces it reviewed', () => {
    expect(SECTION_508_REVIEW.scope).toEqual([
      'public/widget.js',
      'public/elementor-trust-block.css',
      'public/demo.html',
    ]);
  });
});

describe('automated accessibility gate wiring', () => {
  const ROOT = path.join(__dirname, '..');
  const packageJson = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
  };
  const CI_WORKFLOW = readFileSync(path.join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
  const GATE = readFileSync(path.join(ROOT, 'scripts', 'a11y-gate.mjs'), 'utf8');

  it('is runnable locally and required in CI', () => {
    expect(packageJson.scripts['a11y:e2e']).toBe('node scripts/a11y-gate.mjs');
    expect(CI_WORKFLOW).toContain('name: Accessibility Gate (axe-core)');
    expect(CI_WORKFLOW).toContain('npx playwright install --with-deps chromium');
    expect(CI_WORKFLOW).toContain('npm run a11y:e2e');
  });

  it('fails on serious or critical violations, in both widget states', () => {
    expect(GATE).toContain("new Set(['serious', 'critical'])");
    expect(GATE).toContain("'closed widget (launcher)'");
    expect(GATE).toContain("'open widget (panel and transcript)'");
    // A scan that never reached the shadow tree would pass vacuously.
    expect(GATE).toContain('axe inspected no widget element');
  });

  it('proves the scan can still detect a violation before trusting a pass', () => {
    expect(GATE).toContain('controlProbe');
    expect(GATE).toContain('image-alt');
    expect(GATE).toContain('the control probe was not detected');
  });
});

describe('section 508 review record honesty', () => {
  it('does not claim a screen-reader pass that was never run', () => {
    const claims = SECTION_508_REVIEW.limits.join(' ').toLowerCase();
    expect(claims).toContain('no screen reader');
    // ACC-15 is fixed in the DOM contract, and the record says the painted
    // fold is still owed to the human walkthrough rather than claiming it.
    expect(claims).toContain('re-checked in the human walkthrough');
  });

  it('keeps the demo page it reviewed structurally sound', () => {
    const demo = readFileSync(path.join(__dirname, '..', 'public', 'demo.html'), 'utf8');
    expect(demo).toMatch(/<html lang="en">/);
    expect(demo).toContain('<main>');
    // One h1, and the widget host page is the surface the review walked.
    expect(demo.match(/<h1/g)).toHaveLength(1);
    expect(demo).toContain('<script src="/widget.js" data-server-url=""></script>');
  });
});
