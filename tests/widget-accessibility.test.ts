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
  type WidgetRun,
} from './helpers/dom-shim';

const WIDGET_SOURCE = readFileSync(path.join(__dirname, '..', 'public', 'widget.js'), 'utf8');
const ELEMENTOR_CSS = readFileSync(
  path.join(__dirname, '..', 'public', 'elementor-trust-block.css'),
  'utf8',
);

const DISCLOSURE = { firstMessage: 'I am the Life Policy Pilot AI Educational Assistant.' };
const REPLY = {
  assistant_message: 'Term life covers a set period.',
  state: 'education',
};

/** Start a widget and settle the opening disclosure request. */
async function start(options: { reducedMotion?: boolean } = {}): Promise<WidgetRun> {
  const run = runWidget(WIDGET_SOURCE, options);
  await run.fetch.respond(DISCLOSURE);
  return run;
}

/** Type into the field and press Enter. */
function send(run: WidgetRun, text: string): void {
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

  it('collapses to a launcher on close, and returns focus there', async () => {
    const run = await start();
    expect(run.launcher.styleValue('display')).toBe('none');

    run.close.dispatch('click');
    expect(run.widget.styleValue('display')).toBe('none');
    expect(run.launcher.styleValue('display')).toBe('block');
    expect(run.launcher.getAttribute('aria-expanded')).toBe('false');
    expect(run.document.activeElement).toBe(run.launcher);
  });

  it('reopens from the launcher and moves focus into the field', async () => {
    const run = await start();
    run.close.dispatch('click');
    run.launcher.dispatch('click');
    expect(run.widget.styleValue('display')).toBe('flex');
    expect(run.launcher.styleValue('display')).toBe('none');
    expect(run.launcher.getAttribute('aria-expanded')).toBe('true');
    expect(run.document.activeElement).toBe(run.input);
  });

  it('closes on Escape and restores focus to the launcher', async () => {
    const run = await start();
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

describe('widget reflow and geometry (ACC-6)', () => {
  it('sizes the panel so it cannot exceed the viewport', async () => {
    const run = await start();
    expect(run.widget.styleValue('width')).toBe('min(360px, 100vw)');
    expect(run.widget.styleValue('max-height')).toBe('calc(100vh - 16px)');
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
    for (const control of [run.send, run.close, run.launcher]) {
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

  it('does not dress the disclosure fallback as an error', async () => {
    // The fallback is the disclosure itself, so it is announced politely.
    const run = runWidget(WIDGET_SOURCE);
    await run.fetch.fail();
    const first = bubbles(run)[0];
    expect(first.textContent).toMatch(/Life Policy Pilot AI Educational Assistant/);
    expect(first.hasAttribute('role')).toBe(false);
  });
});

describe('widget accessible names and associations (ACC-10)', () => {
  it('takes the dialog name from the visible title', async () => {
    const run = await start();
    expect(run.widget.getAttribute('aria-labelledby')).toBe(run.title.id);
    expect(run.title.textContent).toBe('Life Policy Pilot — AI Educational Assistant');
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
    expect(run.launcher.getAttribute('aria-label')).toBeTruthy();
    // 2.5.3: the launcher's accessible name contains its visible text.
    expect(run.launcher.getAttribute('aria-label')).toContain(run.launcher.visibleText());
    expect(run.launcher.getAttribute('aria-controls')).toBe(run.widget.id);
    // 2.5.3: the send button's name contains its visible text.
    expect(run.send.getAttribute('aria-label')).toContain(run.send.visibleText());
  });

  it('uses a type on every button so no host form is submitted (ACC-14)', async () => {
    const run = await start();
    for (const control of [run.send, run.close, run.launcher]) {
      expect(control.type).toBe('button');
    }
  });
});

describe('widget install guard (ACC-13)', () => {
  it('builds nothing new when the script is included twice', () => {
    const env = createEnvironment();
    executeWidget(WIDGET_SOURCE, env);
    executeWidget(WIDGET_SOURCE, env);
    expect(env.document.allById('lpp-chat-widget')).toHaveLength(1);
    expect(env.document.allById('lpp-chat-a11y-styles')).toHaveLength(1);
    expect(env.document.allById('lpp-chat-input')).toHaveLength(1);
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
      currentState: 'disclosure',
      sourceUrl: '/articles/term-life-basics',
    });
    expect(first.sessionId).toMatch(/^lpp_\d+_[a-z0-9]+$/);
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
    expect(second.currentState).toBe('education'); // carried from data.state
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
    // ACC-15 is the one accepted, documented mitigation; nothing else may be open.
    const unresolved = SECTION_508_FINDINGS.filter((finding) => finding.status !== 'fixed');
    expect(unresolved.map((finding) => finding.id)).toEqual(['ACC-15']);
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

describe('section 508 review record honesty', () => {
  it('does not claim a screen-reader pass that was never run', () => {
    const claims = SECTION_508_REVIEW.limits.join(' ').toLowerCase();
    expect(claims).toContain('no screen reader');
    expect(claims).toContain('mitigated, not fixed');
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
