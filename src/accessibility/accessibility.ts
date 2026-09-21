/**
 * Accessibility and Multilingual Requirements (Section 4.12)
 *
 * Target WCAG 2.2 AA. Normal text requires at least 4.5:1 contrast and
 * large text at least 3:1. The widget must be fully operable by keyboard,
 * have visible focus indicators, expose correct ARIA, announce new
 * messages, allow zoom/reflow, respect reduced motion, and more.
 *
 * This module is also the machine-readable record of the manual Section 508
 * review: the palette with its computed contrast, the measured focus
 * indicators, and the findings from reviewing the real UI surfaces. The
 * review is enforced rather than described — `auditAccessibilityReview()`
 * recomputes every documented ratio and refuses a record with an unresolved
 * blocking finding, so the numbers here cannot drift from the colours the
 * widget actually renders.
 *
 * See docs/section-508-accessibility-review.md for the human-readable review.
 */

/**
 * WCAG 2.2 AA requirements for the chat widget (Section 4.12).
 */
export const WCAG_REQUIREMENTS = {
  /** Normal text requires at least 4.5:1 contrast */
  NORMAL_TEXT_CONTRAST_RATIO: 4.5,
  /** Large text requires at least 3:1 contrast */
  LARGE_TEXT_CONTRAST_RATIO: 3.0,
  /** Non-text graphical boundaries generally need 3:1 */
  NON_TEXT_BOUNDARY_CONTRAST_RATIO: 3.0,

  /** Fully operable by keyboard without a trap */
  KEYBOARD_OPERABLE: true,
  /** Visible focus indicator, keep focused elements unobscured */
  VISIBLE_FOCUS: true,
  /** Expose correct names, roles, states, and error associations */
  ARIA_CORRECT: true,
  /** Announce new assistant messages and booking status without moving focus */
  ANNOUNCE_NEW_MESSAGES: true,
  /** Allow 200% zoom/reflow and mobile orientation */
  ZOOM_REFLOW_200_PERCENT: true,
  /** At least 24x24 CSS-pixel targets or adequate spacing */
  MIN_TARGET_SIZE_PX: 24,
  /** Pause/disable nonessential animation; respect prefers-reduced-motion */
  RESPECT_REDUCED_MOTION: true,
  /** Provide transcript copy/download in accessible format after identity/privacy review */
  TRANSCRIPT_ACCESSIBLE: true,
  /** Avoid color-only meaning */
  NO_COLOR_ONLY_MEANING: true,
} as const;

/* ── WCAG contrast math ───────────────────────────────────────────────────
 * The review's central claim is that a colour pair passes or fails, so the
 * formula lives in code rather than in a comment. Everything below is
 * recomputed by auditAccessibilityReview().
 */

/** Parse `#rgb` or `#rrggbb` into 0-255 channels. Throws on anything else. */
function parseHex(hex: string): [number, number, number] {
  const raw = hex.trim().replace(/^#/, '');
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(full)) {
    throw new Error(`Not a hex colour: ${hex}`);
  }
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG 2.x relative luminance of an sRGB hex colour. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map((channel) => {
    const v = channel / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/**
 * WCAG 2.x contrast ratio between two sRGB hex colours (1 to 21).
 * Rounded to three decimals, which is the precision the tables below record.
 */
export function contrastRatio(colorA: string, colorB: string): number {
  const [lighter, darker] = [relativeLuminance(colorA), relativeLuminance(colorB)].sort(
    (a, b) => b - a,
  );
  return Math.round(((lighter + 0.05) / (darker + 0.05)) * 1000) / 1000;
}

/** True when `fg` on `bg` meets `minimum` (defaults to normal-text AA). */
export function meetsContrast(
  fg: string,
  bg: string,
  minimum: number = WCAG_REQUIREMENTS.NORMAL_TEXT_CONTRAST_RATIO,
): boolean {
  return contrastRatio(fg, bg) >= minimum;
}

/**
 * Color palette contrast results (Section 4.16 / palette analysis).
 * Every ratio is recomputed from the hex values by auditAccessibilityReview();
 * a hand-edited number that disagrees with the formula is a gate failure.
 */
export const PALETTE_CONTRAST = {
  // Headline red on light background — PASS AA
  HEADLINE_ON_BG: {
    color: '#CC0700',
    bg: '#E2E8F0',
    ratio: 4.735,
    normalText: 'Pass AA',
    largeText: 'Pass AA',
  },
  // Slate border on light background — PASS AA
  BORDER_ON_BG: {
    color: '#485B61',
    bg: '#E2E8F0',
    ratio: 5.785,
    normalText: 'Pass AA',
    largeText: 'Pass AA',
  },
  // White text on green button — PASS AAA
  WHITE_ON_BUTTON: {
    color: '#FFFFFF',
    bg: '#414C32',
    ratio: 9.112,
    normalText: 'Pass AAA',
    largeText: 'Pass AAA',
  },
  // Green on light background — PASS AAA
  GREEN_ON_BG: {
    color: '#414C32',
    bg: '#E2E8F0',
    ratio: 7.392,
    normalText: 'Pass AAA',
    largeText: 'Pass AAA',
  },
  // White on slate hover — PASS AAA
  WHITE_ON_HOVER: {
    color: '#FFFFFF',
    bg: '#485B61',
    ratio: 7.132,
    normalText: 'Pass AAA',
    largeText: 'Pass AAA',
  },
  // WARNING: Red on slate border — FAIL (do not use this combination)
  RED_ON_SLATE: {
    color: '#CC0700',
    bg: '#485B61',
    ratio: 1.222,
    normalText: 'FAIL',
    largeText: 'FAIL',
  },
  // Widget body text on the widget background — PASS AAA
  BODY_TEXT_ON_WIDGET_BG: {
    color: '#1a1a1a',
    bg: '#E2E8F0',
    ratio: 14.118,
    normalText: 'Pass AAA',
    largeText: 'Pass AAA',
  },
  // Assistant bubble text on the bubble fill (added in the Section 508 review:
  // this colour was rendered by the widget but absent from the verified table)
  TEXT_ON_ASSISTANT_BUBBLE: {
    color: '#1a1a1a',
    bg: '#F0F0F0',
    ratio: 15.272,
    normalText: 'Pass AAA',
    largeText: 'Pass AAA',
  },
  // Text typed into the input (browser default white field) — PASS AAA
  TEXT_ON_INPUT: {
    color: '#1a1a1a',
    bg: '#FFFFFF',
    ratio: 17.404,
    normalText: 'Pass AAA',
    largeText: 'Pass AAA',
  },
  // Privacy banner text on its fill (added in the Section 508 review)
  PRIVACY_BANNER_TEXT: {
    color: '#1a1a1a',
    bg: '#FFF3CD',
    ratio: 15.708,
    normalText: 'Pass AAA',
    largeText: 'Pass AAA',
  },
  // Privacy banner rule against its fill — PASS AA (non-text boundary)
  PRIVACY_BANNER_BORDER: {
    color: '#485B61',
    bg: '#FFF3CD',
    ratio: 6.437,
    normalText: 'Pass AA',
    largeText: 'Pass AA',
  },
} as const;

/** Every colour a palette pair may legally use, for the drift audit. */
export const PALETTE_COLORS = [
  '#CC0700',
  '#E2E8F0',
  '#485B61',
  '#FFFFFF',
  '#414C32',
  '#1a1a1a',
  '#F0F0F0',
  '#FFF3CD',
] as const;

/**
 * Palette usage rules derived from the contrast analysis:
 * - The palette passes when used as proposed if button text is white
 *   and the red headline remains on the light background
 * - Do NOT place the red headline on the slate border/hover color
 * - Preserve a 3:1 focus indicator against both normal and hover states.
 *   One colour cannot do this (see FOCUS_INDICATORS): the input takes a single
 *   dark ring, while the buttons need a light inner ring against the button
 *   fill and a dark outer ring against the light page around them.
 */
export const PALETTE_RULES = [
  'Button text must be white on #414C32 background',
  'Red headline #CC0700 must remain on light background #E2E8F0',
  'Do NOT place red headline #CC0700 on slate border #485B61 (fails 1.222:1)',
  'Preserve 3:1 focus indicators against both normal and hover states',
  'Every colour the widget renders must appear in PALETTE_CONTRAST (auditAccessibilityReview)',
] as const;

/**
 * Language support policy (Section 4.12).
 * Launch English only unless the complete approved corpus, disclosures,
 * consent text, evaluation set, and human handoff are supported in
 * another language.
 */
export const LANGUAGE_POLICY = {
  /** Launch English only */
  DEFAULT_LANGUAGE: 'en',
  /** Detecting Spanish should offer a clearly labeled Spanish handoff or approved experience */
  DETECT_SPANISH: true,
  /** Do not improvise regulated translations */
  NO_IMPROVISED_TRANSLATIONS: true,
  /** Multi-language requires full corpus, disclosures, consent, eval set, and handoff support */
  MULTI_LANGUAGE_REQUIRES_FULL_SUPPORT: true,
} as const;

/**
 * The browser/assistive-technology test matrix (Section 4.12).
 */
export const ACCESSIBILITY_TEST_MATRIX = [
  { browser: 'Chrome', at: 'NVDA' },
  { browser: 'Safari', at: 'VoiceOver' },
  { browser: 'Firefox', at: 'Keyboard only' },
  { browser: 'Safari Mobile', at: 'VoiceOver (iOS)' },
  { browser: 'Chrome Mobile', at: 'Talkback (Android)' },
] as const;

/**
 * ARIA live region configuration for announcing new assistant messages.
 * The chat message container should use aria-live="polite" so screen
 * readers announce new messages without moving focus.
 *
 * Exactly ONE live region may exist per widget: nesting a polite region
 * inside another polite region is announced twice by NVDA and JAWS, so the
 * dialog container carries no aria-live of its own.
 */
export const ARIA_LIVE_CONFIG = {
  // The assistant message container should be aria-live="polite"
  ASSISTANT_MESSAGES: 'polite',
  // Booking status changes should be aria-live="assertive"
  BOOKING_STATUS: 'assertive',
  // Error messages should be aria-live="assertive"
  ERRORS: 'assertive',
  /** Live regions per widget — one log region, and no nested polite region */
  MAX_LIVE_REGIONS_PER_WIDGET: 1,
} as const;

/**
 * Generates the CSS for the prefers-reduced-motion media query.
 * Used by the widget and the Elementor block.
 *
 * The widget is plain JavaScript served statically (it is a drop-in script for
 * WordPress/Elementor, so it cannot import from here). tests/widget-accessibility
 * asserts that the CSS the widget injects is exactly this string, which is how
 * "single source" is enforced without a build step.
 */
export const REDUCED_MOTION_CSS = `@media (prefers-reduced-motion: reduce) {
  .lpp-chat-widget *,
  .lpp-chat-widget *::before,
  .lpp-chat-widget *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}`;

/* ── Focus indicators (measured during the Section 508 review) ────────────
 * The widget's original indicator was a single black outline on every control.
 * Measured: #000000 on the button green is 2.305:1 and on the hover slate is
 * 2.945:1 — both below the 3:1 non-text minimum, and below the palette's own
 * stated rule. A single colour cannot fix this, because the indicator has to
 * contrast against the control fill AND against whatever is behind the control,
 * and the controls sit on a dark green fill (a light ring is needed) while the
 * page behind them is a light slate (a dark ring is needed).
 */

/** One edge of a focus indicator, against the colour it touches. */
export interface FocusBoundary {
  /** Which colour this edge of the indicator sits against */
  against: string;
  /** The colour adjacent to that edge */
  adjacentColor: string;
  /** Recomputable contrast ratio for this edge */
  ratio: number;
}

/** A measured, per-control focus indicator. */
export interface FocusIndicator {
  control: string;
  /** What the indicator sits on, and therefore what it must contrast with */
  surface: string;
  technique: string;
  innerRing: { color: string; widthPx: number };
  outerRing: { color: string; widthPx: number } | null;
  boundaries: readonly FocusBoundary[];
}

export const FOCUS_INDICATORS: readonly FocusIndicator[] = [
  {
    control: 'chat input',
    surface: 'white input field on the light widget background',
    technique: 'single dark ring',
    // The field is white and the widget behind it is light slate, so one dark
    // ring clears both edges. Every band is an `outline` — a box-shadow band is
    // not painted at all in Windows High Contrast Mode.
    innerRing: { color: '#1a1a1a', widthPx: 3 },
    outerRing: null,
    boundaries: [
      { against: 'input field fill', adjacentColor: '#FFFFFF', ratio: 17.404 },
      { against: 'widget background', adjacentColor: '#E2E8F0', ratio: 14.118 },
    ],
  },
  {
    control: 'send button and launcher',
    surface: 'green fill on the light page background',
    technique: 'two-tone ring — light inner ring, dark outer ring',
    innerRing: { color: '#FFFFFF', widthPx: 3 },
    // The outer band is a box-shadow spread, which is what the 6px records.
    outerRing: { color: '#1a1a1a', widthPx: 6 },
    boundaries: [
      { against: 'button fill', adjacentColor: '#414C32', ratio: 9.112 },
      { against: 'button hover fill', adjacentColor: '#485B61', ratio: 7.132 },
      { against: 'page background', adjacentColor: '#E2E8F0', ratio: 14.118 },
    ],
  },
  {
    control: 'close button',
    surface: 'green header bar',
    technique: 'single light ring',
    innerRing: { color: '#FFFFFF', widthPx: 3 },
    outerRing: null,
    boundaries: [
      { against: 'header fill', adjacentColor: '#414C32', ratio: 9.112 },
      { against: 'header hover fill', adjacentColor: '#485B61', ratio: 7.132 },
    ],
  },
  {
    control: 'message log',
    surface: 'light widget background (the log is focusable to be scrollable)',
    technique: 'single dark ring, inset offset',
    innerRing: { color: '#1a1a1a', widthPx: 3 },
    outerRing: null,
    boundaries: [{ against: 'widget background', adjacentColor: '#E2E8F0', ratio: 14.118 }],
  },
];

/**
 * Why the indicator is per-control rather than one colour everywhere, with the
 * measurements that rule each single-colour option out.
 */
export const FOCUS_INDICATOR_EXCLUSION = {
  darkOnButtons: '#000000 on the button fills: 2.305:1 (green) / 2.945:1 (slate hover)',
  lightOnPage:
    '#FFFFFF on the light widget background: 1.175:1 — a light ring alone is invisible there',
  conclusion:
    'No single colour clears 3:1 against both a dark green control fill and the light page behind it, ' +
    'so buttons take a light inner ring (clears both the normal and hover fill) plus a dark outer ring ' +
    '(clears the page), and the input keeps a single dark ring.',
} as const;

/* ── Manual Section 508 review ────────────────────────────────────────────
 * The governance matrix names this control "Accessibility audit" (owner:
 * accessibility owner; frequency: prelaunch and major UI change; evidence:
 * test matrix and defects). This is that record, in a form a test can hold to
 * account.
 */

export type AccessibilityFindingStatus = 'fixed' | 'mitigated' | 'open';
export type AccessibilityFindingSeverity = 'critical' | 'high' | 'medium' | 'low';

/** One defect found by reviewing the UI surfaces by hand. */
export interface AccessibilityFinding {
  id: string;
  title: string;
  severity: AccessibilityFindingSeverity;
  /** WCAG 2.2 success criteria (and where useful, the Section 508 clause) */
  criteria: readonly string[];
  status: AccessibilityFindingStatus;
  /** What was measured, not asserted — the evidence the finding rests on */
  evidence: string;
  /** What was done about it, or why it stays open */
  resolution: string;
}

export const SECTION_508_FINDINGS: readonly AccessibilityFinding[] = [
  {
    id: 'ACC-1',
    title: 'Focus indicator failed 3:1 on both buttons',
    severity: 'high',
    criteria: ['1.4.11 Non-text Contrast', '2.4.13 Focus Appearance (AAA)', 'palette rule 4'],
    status: 'fixed',
    evidence:
      '#000000 on #414C32 = 2.305:1 and on the hover #485B61 = 2.945:1 (computed, both below 3:1); ' +
      'the same black outline appeared in public/elementor-trust-block.css on a button that turns #485B61',
    resolution:
      'Per-control indicators (FOCUS_INDICATORS): the input takes a single dark ring (17.404:1 / 14.118:1); ' +
      'the send button takes a light inner ring (9.112:1 normal, 7.132:1 hover) with a dark outer ring ' +
      '(14.118:1 against the page); the close button and launcher take the light ring on the green header',
  },
  {
    id: 'ACC-2',
    title: 'Nested polite live regions announced messages twice',
    severity: 'high',
    criteria: ['4.1.3 Status Messages', '1.3.1 Info and Relationships'],
    status: 'fixed',
    evidence:
      'the dialog container carried aria-live="polite" and the message area inside it carried ' +
      'role="log" plus its own aria-live="polite" — two polite regions, one inside the other',
    resolution:
      'aria-live is on the log region only; the container keeps role="dialog" and no longer announces. ' +
      'ARIA_LIVE_CONFIG.MAX_LIVE_REGIONS_PER_WIDGET asserts a single region',
  },
  {
    id: 'ACC-3',
    title: 'Speaker identity was conveyed by colour alone',
    severity: 'high',
    criteria: ['1.3.1 Info and Relationships', '1.4.1 Use of Color', '4.1.2 Name, Role, Value'],
    status: 'fixed',
    evidence:
      'user and assistant bubbles differed only by background fill (#414C32 against #F0F0F0) and a ' +
      '40px margin; no text or attribute identified the speaker, so a screen reader cannot tell who said what',
    resolution:
      'each bubble carries a visually hidden "You said:" / "Assistant said:" prefix, so the identity ' +
      'survives with CSS and images off and without colour perception',
  },
  {
    id: 'ACC-4',
    title: 'The scrollable transcript was unreachable by keyboard',
    severity: 'high',
    criteria: ['2.1.1 Keyboard'],
    status: 'fixed',
    evidence:
      'the message area had overflow-y:auto with a capped height but was a plain div with no tabindex, ' +
      'so a keyboard user could not scroll back through earlier messages',
    resolution:
      'the log is focusable (tabindex="0") with an accessible name and its own focus ring',
  },
  {
    id: 'ACC-5',
    title: 'Focus was taken on page load, lost on close, with no way back',
    severity: 'high',
    criteria: ['2.4.3 Focus Order', '3.2.1 On Focus', '2.1.1 Keyboard'],
    status: 'fixed',
    evidence:
      'input.focus() ran as the script loaded, moving a keyboard or screen-reader user off the article ' +
      'they were reading; closing set display:none while focus was inside, stranding focus on the body; ' +
      'and nothing re-opened the widget without a page reload',
    resolution:
      'no focus is taken on load; a launcher button appears when the widget is closed and returns focus ' +
      'to itself on close (aria-expanded/aria-controls wired); opening moves focus to the input; ' +
      'Escape closes and restores focus',
  },
  {
    id: 'ACC-6',
    title: 'Content overflowed the viewport at 320px width and short heights',
    severity: 'high',
    criteria: ['1.4.10 Reflow', '1.4.4 Resize Text', '2.4.11 Focus Not Obscured (Minimum)'],
    status: 'fixed',
    evidence:
      'no box-sizing was set, so the 360px panel plus padding and 2px borders exceeded the viewport ' +
      'width; the input carried min-width:200px which cannot shrink, and with the send button, gap and ' +
      '24px of padding it needed ~312px inside a 288px (90vw) panel; the fixed max-height:600px against ' +
      'a min-height:200px message area (no min-height:0 on the flex child) let the panel exceed a short ' +
      'viewport, pushing the header — with the AI-identity disclosure and the close control — off screen',
    resolution:
      'border-box everywhere; width:min(360px, 100vw); the input is flex:1 1 auto with min-width:0; ' +
      'the panel height is min(600px, calc(100dvh - 16px)) with a vh fallback; the log is flex:1 1 auto ' +
      'with min-height:0 so it shrinks instead of pushing the header out',
  },
  {
    id: 'ACC-7',
    title: 'Typing indicator announced as "dot dot dot" and could delete a user message',
    severity: 'medium',
    criteria: ['4.1.3 Status Messages', '1.3.1 Info and Relationships'],
    status: 'fixed',
    evidence:
      'the indicator was a bubble whose entire text was "..." (announced literally), and it was removed ' +
      'by checking whether the last child\'s textContent equalled "..." — a user who sent "..." had ' +
      'their own message deleted when the reply arrived',
    resolution:
      'the indicator has a visually hidden "Assistant is typing" label and is removed by reference to ' +
      'the node that created it',
  },
  {
    id: 'ACC-8',
    title: 'Error messages were announced politely, contradicting the documented config',
    severity: 'medium',
    criteria: ['4.1.3 Status Messages', 'ARIA_LIVE_CONFIG.ERRORS'],
    status: 'fixed',
    evidence:
      'ARIA_LIVE_CONFIG.ERRORS is "assertive" and the policy says errors are announced assertively, but ' +
      'the failure message was appended as an ordinary bubble in the polite log',
    resolution: 'failure bubbles carry role="alert", so they are announced without waiting',
  },
  {
    id: 'ACC-9',
    title: 'Widget text had no language of its own',
    severity: 'medium',
    criteria: ['3.1.2 Language of Parts'],
    status: 'fixed',
    evidence:
      'the widget renders English copy but set no lang, so embedded in a page of another language the ' +
      'content is pronounced with the host page voice',
    resolution:
      'the dialog sets lang to LANGUAGE_POLICY.DEFAULT_LANGUAGE (asserted against the policy)',
  },
  {
    id: 'ACC-10',
    title: 'Accessible name duplicated visible text; input label and instructions unassociated',
    severity: 'medium',
    criteria: ['2.5.3 Label in Name', '3.3.2 Labels or Instructions', '1.3.1'],
    status: 'fixed',
    evidence:
      "the dialog's aria-label repeated the visible header text (agreeing today by luck, with nothing " +
      'stopping them drifting); the input was named only by aria-label while the privacy instructions ' +
      'sat in a separate banner with no programmatic association',
    resolution:
      'the dialog is named by aria-labelledby against the visible title element; the input has a real ' +
      '(visually hidden) <label for> plus aria-describedby pointing at the privacy banner',
  },
  {
    id: 'ACC-11',
    title: 'Focus rings drawn only with box-shadow vanish in Windows High Contrast Mode',
    severity: 'medium',
    criteria: ['1.4.11 Non-text Contrast', 'Section 508 §502.2 platform conventions'],
    status: 'fixed',
    evidence:
      'the two-tone ring needs two bands, and a box-shadow band is not painted at all in forced-colors ' +
      'mode, which would leave those controls with no indicator',
    resolution:
      'every band is an outline or a shadowed outline pair, and a forced-colors block sets an outline ' +
      'from the system ButtonText colour with the decorative shadow removed',
  },
  {
    id: 'ACC-12',
    title: 'Two rendered colours were absent from the verified palette',
    severity: 'medium',
    criteria: ['1.4.3 Contrast (Minimum)', 'palette rule 5'],
    status: 'fixed',
    evidence:
      'the assistant bubble fill #F0F0F0 and the privacy banner fill #FFF3CD were rendered by the widget ' +
      'but missing from PALETTE_CONTRAST, whose table claimed every pair verified; measured now at ' +
      '15.272:1 and 15.708:1 against #1a1a1a (both pass)',
    resolution:
      'both pairs were added to PALETTE_CONTRAST, and auditAccessibilityReview() fails if the widget ' +
      'renders a colour that no documented pair covers',
  },
  {
    id: 'ACC-13',
    title: 'A second copy of the script duplicated the dialog and its ids',
    severity: 'low',
    criteria: ['1.3.1 Info and Relationships', '4.1.2 Name, Role, Value'],
    status: 'fixed',
    evidence:
      'the script had no install guard, so being included twice (easy in WordPress/Elementor) produced ' +
      'two dialogs, duplicate element ids, and a second reduced-motion style tag',
    resolution:
      'the script returns early when #lpp-chat-widget already exists, so a second dialog, a second set ' +
      'of ids, and a second style tag can no longer be built; the style tag is also guarded by id',
  },
  {
    id: 'ACC-14',
    title: 'Buttons had no type, and Enter during IME composition could double-send',
    severity: 'low',
    criteria: ['2.1.1 Keyboard', '3.3.2 Labels or Instructions'],
    status: 'fixed',
    evidence:
      'a <button> without type defaults to submit, so in a host page that wraps the script in a form a ' +
      'click would submit it; and the Enter handler ignored composition, so an IME or voice-input user ' +
      'confirming a candidate could send a partial message and then send it again',
    resolution: 'buttons are type="button" and the Enter path ignores events with isComposing set',
  },
  {
    id: 'ACC-15',
    title: 'A fixed overlay can obscure focused page content',
    severity: 'medium',
    criteria: ['2.4.11 Focus Not Obscured (Minimum)'],
    status: 'mitigated',
    evidence:
      'the panel is position:fixed with z-index 9999, so while it is open it covers the bottom-right ' +
      'of the page and can cover the element the user is tabbing through; the layout is 360px wide and ' +
      'the panel is collapsed to a launcher as soon as the user closes it',
    resolution:
      'mitigated rather than eliminated: the close control collapses the panel to a launcher (so nothing ' +
      'stays obscured), the panel is limited to the bottom-right, and it never traps focus. A fixed ' +
      'overlay cannot guarantee the minimum for every viewport, so this stays recorded and is re-checked ' +
      'on any layout change',
  },
];

/**
 * One check a human runs at the keyboard for a browser/assistive-technology
 * row. This is the runnable form of the walkthrough: SECTION_508_MATRIX builds
 * its procedure text from these checks, `npm run a11y:checklist` prints them,
 * and a receipt (see WalkthroughReceipt) records one result per check per row.
 *
 * `check` is the action, `expected` is the observable pass condition, because
 * "confirm it is announced" is not something two reviewers can agree on after
 * the fact.
 */
export interface WalkthroughCheck {
  id: string;
  /** Which part of the widget this check exercises */
  area: string;
  /** What the reviewer does */
  check: string;
  /** What counts as a pass, stated as an observation */
  expected: string;
  /** Platform-specific checks may be recorded not_applicable; required ones may not */
  optional?: boolean;
}

export const ACCESSIBILITY_WALKTHROUGH_CHECKS: readonly WalkthroughCheck[] = [
  {
    id: 'AT-01',
    area: 'Focus',
    check: 'tab from the page into the widget and through every control, including the transcript',
    expected:
      'each stop shows the two-band focus ring, and the transcript is reachable before the input',
  },
  {
    id: 'AT-02',
    area: 'Announcements',
    check: 'open the panel and listen to how the container is announced',
    expected: 'it is announced as a dialog named "Life Policy Pilot — AI Educational Assistant"',
  },
  {
    id: 'AT-03',
    area: 'Announcements',
    check: 'read the opening disclosure and the privacy banner by navigating into the panel',
    expected:
      'both are announced in reading order, and the disclosure is reachable before the visitor types',
  },
  {
    id: 'AT-04',
    area: 'Messages',
    check:
      'send a message with the network throttled, and listen through the typing state and the reply',
    expected:
      'the typing state and the reply are each announced exactly once — nothing is announced twice',
  },
  {
    id: 'AT-05',
    area: 'Messages',
    check:
      'point the widget at a dead server (data-server-url) and send a message, then listen to the failure',
    expected:
      'the failure notice is announced once, on its own, and the earlier conversation is still in the transcript',
  },
  {
    id: 'AT-06',
    area: 'Messages',
    check: 'send "..." as a message and wait for the reply',
    expected: 'the user message "..." is still in the transcript after the reply lands',
  },
  {
    id: 'AT-07',
    area: 'Close and return',
    check: 'activate the close control',
    expected:
      'the panel closes, focus is on the launcher, and the launcher reports aria-expanded="false" with its name',
  },
  {
    id: 'AT-08',
    area: 'Close and return',
    check: 're-open the panel, then press Escape',
    expected:
      'the panel closes and focus returns to the launcher, exactly as with the close control',
  },
  {
    id: 'AT-09',
    area: 'Close and return',
    check: 'activate the launcher to re-open the panel',
    expected: 'the panel re-opens and focus is placed in the message field',
  },
  {
    id: 'AT-10',
    area: 'Reflow',
    check: 'at 320 CSS px wide, tab through the open panel and scroll it',
    expected:
      'nothing is clipped, the header (disclosure and close control) stays on screen, and there is no horizontal scrolling',
  },
  {
    id: 'AT-11',
    area: 'Reflow',
    check: 'at 400% zoom, repeat the tab-through and the scroll',
    expected: 'nothing is clipped, every control stays reachable, and the header stays on screen',
  },
  {
    id: 'AT-12',
    area: 'Reduced motion',
    check: 'with prefers-reduced-motion: reduce set, open and close the panel and send a message',
    expected: 'no animation or transition motion remains; every state change is instant',
  },
  {
    id: 'AT-13',
    area: 'High contrast',
    check: 'with Windows High Contrast Mode on, tab to every control',
    expected: 'each control still shows a visible focus indicator (an outline, not a shadow)',
    // Windows-only: macOS and Android runs record this as not_applicable with a note.
    optional: true,
  },
];

/** One row of the manual browser/assistive-technology walkthrough. */
export interface AccessibilityMatrixRow {
  browser: string;
  at: string;
  /** What this review could establish without the device or screen reader */
  automatedCoverage: string;
  /** What still needs a human at the keyboard — every check, condensed */
  humanProcedure: string;
  humanStatus: 'pass' | 'fail' | 'in_progress' | 'not_performed';
}

/**
 * The status each walkthrough row last recorded. This is the only hand-edited
 * part of the matrix: `auditAccessibilityReview(review, receipt)` refuses a
 * value that the receipt on disk does not support, so a `pass` here is a claim
 * with evidence behind it, and `not_performed` is the honest default.
 *
 * To sign a row off: run `npm run a11y:checklist`, fill the receipt, then set
 * the value below to the status the receipt derives.
 */
export const WALKTHROUGH_RECORDED_STATUS: Record<string, AccessibilityMatrixRow['humanStatus']> = {
  'Chrome / NVDA': 'not_performed',
  'Safari / VoiceOver': 'not_performed',
  'Firefox / Keyboard only': 'not_performed',
  'Safari Mobile / VoiceOver (iOS)': 'not_performed',
  'Chrome Mobile / Talkback (Android)': 'not_performed',
};

export const SECTION_508_MATRIX: readonly AccessibilityMatrixRow[] = ACCESSIBILITY_TEST_MATRIX.map(
  (row) => ({
    browser: row.browser,
    at: row.at,
    automatedCoverage:
      'Widget DOM contract asserted in CI: names, roles, live-region count, keyboard paths, reflow ' +
      'constraints, and every documented contrast ratio recomputed from source',
    humanProcedure: `Load /demo.html in ${row.browser} with ${row.at}, then run the ${
      ACCESSIBILITY_WALKTHROUGH_CHECKS.length
    } checks in ACCESSIBILITY_WALKTHROUGH_CHECKS (npm run a11y:checklist -- --row "${
      row.browser
    } / ${row.at}"): ${ACCESSIBILITY_WALKTHROUGH_CHECKS.map((check) => check.check).join('; ')}`,
    humanStatus: WALKTHROUGH_RECORDED_STATUS[walkthroughRowKey(row)] ?? 'not_performed',
  }),
);

/**
 * The manual Section 508 review record — the evidence behind the governance
 * matrix row "Accessibility audit".
 */
export const SECTION_508_REVIEW = {
  standard: 'Section 508 (36 CFR Part 1194) — Revised standards, WCAG 2.2 Level AA',
  reviewedAt: '2026-09-19',
  /** The UI that reaches a user and therefore falls in scope */
  scope: ['public/widget.js', 'public/elementor-trust-block.css', 'public/demo.html'],
  method: [
    'manual code review of every rendered element, attribute, and style in the widget and its host pages',
    'contrast recomputed from the sRGB hex values with the WCAG relative-luminance formula',
    'keyboard-path and focus-order walkthrough traced through the script',
    'reflow arithmetic at 320 CSS px and at 200%/400% zoom, including flex shrink behaviour',
    'DOM-level contract asserted in CI (tests/widget-accessibility.test.ts)',
  ],
  findings: SECTION_508_FINDINGS,
  matrix: SECTION_508_MATRIX,
  /** Verification the review itself runs, so the record cannot silently drift */
  gates: ['auditAccessibilityReview()', 'tests/widget-accessibility.test.ts'],
  limits: [
    'No screen reader, mobile device, or Windows High Contrast session was run: the matrix rows are ' +
      'recorded as not_performed, and the runnable checklist (npm run a11y:checklist) is the instrument ' +
      'that turns them into signed results rather than claims',
    'Forced-colors support is verified by construction (an outline is retained in every focus rule) ' +
      'rather than by a real Windows High Contrast Mode session',
    'Reflow is verified by style assertions and layout arithmetic, not by a rendered 320px viewport capture',
    'ACC-15 stays mitigated, not fixed: a fixed overlay cannot guarantee 2.4.11 for every viewport',
  ],
} as const;

/* ── The human walkthrough, as a record the gate can read ─────────────────
 * The five matrix rows cannot be run by any process in this repository: only
 * a person at a keyboard with NVDA, VoiceOver, or TalkBack can produce a
 * result. What the repository can do is make the run procedural — the checks
 * above — and make the result auditable: a receipt records one result per
 * check per row, `deriveRowStatus()` turns that into the row's status, and
 * `auditAccessibilityReview(review, receipt)` refuses a recorded status the
 * receipt does not support. The receipt is committed at
 * WALKTHROUGH_RECEIPT_PATH (a blank template until someone runs a row), so a
 * signed walkthrough survives in the tree instead of in someone's memory.
 */

/** One recorded result for one check in one row of the walkthrough. */
export type WalkthroughResult = 'pass' | 'fail' | 'not_performed' | 'not_applicable';

export interface WalkthroughItemReceipt {
  result: WalkthroughResult;
  /** Free text: what happened, or why a failure is not one — required on a fail */
  note: string;
}

export interface WalkthroughRowReceipt {
  /** The versions the row was actually run on — a pass without these is not a pass */
  environment: { browserVersion: string; atVersion: string; os: string };
  /** Check id (AT-nn) → recorded result */
  items: Record<string, WalkthroughItemReceipt>;
}

export interface WalkthroughReceipt {
  schema: string;
  /** Who ran the walkthrough, and when — required before any row may pass */
  reviewer: string;
  reviewedAt: string;
  /** Row key ("Chrome / NVDA") → recorded results */
  rows: Record<string, WalkthroughRowReceipt>;
}

export const WALKTHROUGH_RECEIPT_SCHEMA = 'lifechat.a11y-walkthrough-receipt/1';
/** Where the committed receipt lives, relative to the repository root */
export const WALKTHROUGH_RECEIPT_PATH = 'docs/accessibility-matrix-receipt.json';

/** The stable key a receipt uses for a matrix row. */
export function walkthroughRowKey(row: { browser: string; at: string }): string {
  return `${row.browser} / ${row.at}`;
}

/** A blank receipt: every row, every check, nothing recorded. */
export function buildWalkthroughReceiptTemplate(): WalkthroughReceipt {
  const rows: Record<string, WalkthroughRowReceipt> = {};
  for (const row of ACCESSIBILITY_TEST_MATRIX) {
    const items: Record<string, WalkthroughItemReceipt> = {};
    for (const check of ACCESSIBILITY_WALKTHROUGH_CHECKS) {
      items[check.id] = { result: 'not_performed', note: '' };
    }
    rows[walkthroughRowKey(row)] = {
      environment: { browserVersion: '', atVersion: '', os: '' },
      items,
    };
  }
  return {
    schema: WALKTHROUGH_RECEIPT_SCHEMA,
    reviewer: '',
    reviewedAt: '',
    rows,
  };
}

function environmentRecorded(environment: WalkthroughRowReceipt['environment']): boolean {
  return (
    environment !== undefined &&
    typeof environment === 'object' &&
    environment.browserVersion.trim().length > 0 &&
    environment.atVersion.trim().length > 0 &&
    environment.os.trim().length > 0
  );
}

function receiptIsSigned(receipt: WalkthroughReceipt): boolean {
  return receipt.reviewer.trim().length > 0 && receipt.reviewedAt.trim().length > 0;
}

/** Every required check is pass, and every optional check is pass or not_applicable. */
function checksAreComplete(entry: WalkthroughRowReceipt): boolean {
  return ACCESSIBILITY_WALKTHROUGH_CHECKS.every((check) => {
    const result = entry.items[check.id]?.result;
    return check.optional === true
      ? result === 'pass' || result === 'not_applicable'
      : result === 'pass';
  });
}

/**
 * What the recorded results support for one row. Conservative by construction:
 * a row is `pass` only when every check was run and passed, the environment it
 * ran on is recorded, and the receipt is signed. Anything run-but-unfinished is
 * `in_progress`; a single recorded failure is `fail`.
 */
export function deriveRowStatus(
  receipt: WalkthroughReceipt,
  row: { browser: string; at: string },
): AccessibilityMatrixRow['humanStatus'] {
  const entry = receipt.rows[walkthroughRowKey(row)];
  if (!entry || typeof entry.items !== 'object') {
    return 'not_performed';
  }
  const results = ACCESSIBILITY_WALKTHROUGH_CHECKS.map((check) => entry.items[check.id]?.result);
  if (results.some((result) => result === 'fail')) {
    return 'fail';
  }
  if (results.every((result) => result === undefined || result === 'not_performed')) {
    return 'not_performed';
  }
  if (
    checksAreComplete(entry) &&
    environmentRecorded(entry.environment) &&
    receiptIsSigned(receipt)
  ) {
    return 'pass';
  }
  return 'in_progress';
}

export interface WalkthroughSignOff {
  /** outstanding → in_progress → complete, or failed when a row recorded a failure */
  atWalkthrough: 'outstanding' | 'in_progress' | 'complete' | 'failed';
  rowsPassed: number;
  rowsTotal: number;
  rowsInProgress: number;
  rowsFailed: number;
}

/** The sign-off the receipt supports — the value docs/section-508-accessibility-review.md states. */
export function deriveSignOff(receipt: WalkthroughReceipt): WalkthroughSignOff {
  const statuses = ACCESSIBILITY_TEST_MATRIX.map((row) => deriveRowStatus(receipt, row));
  const rowsPassed = statuses.filter((status) => status === 'pass').length;
  const rowsInProgress = statuses.filter((status) => status === 'in_progress').length;
  const rowsFailed = statuses.filter((status) => status === 'fail').length;
  const atWalkthrough: WalkthroughSignOff['atWalkthrough'] =
    rowsFailed > 0
      ? 'failed'
      : rowsPassed === statuses.length
        ? 'complete'
        : rowsPassed + rowsInProgress > 0
          ? 'in_progress'
          : 'outstanding';
  return { atWalkthrough, rowsPassed, rowsTotal: statuses.length, rowsInProgress, rowsFailed };
}

/** The matrix rows with each status taken from the receipt. */
export function deriveMatrixStatuses(
  receipt: WalkthroughReceipt,
  matrix: readonly AccessibilityMatrixRow[] = SECTION_508_MATRIX,
): AccessibilityMatrixRow[] {
  return matrix.map((row) => ({ ...row, humanStatus: deriveRowStatus(receipt, row) }));
}

/**
 * Structural check on a receipt: it must cover exactly the matrix rows and
 * exactly the checks, every result must be a known value, a failure must
 * explain itself, and a row that claims a pass must carry the environment and
 * the signature that make the claim checkable.
 */
export function auditWalkthroughReceipt(receipt: WalkthroughReceipt): AccessibilityReviewGap[] {
  const gaps: AccessibilityReviewGap[] = [];
  if (receipt.schema !== WALKTHROUGH_RECEIPT_SCHEMA) {
    gaps.push({
      code: 'walkthrough_schema_unknown',
      detail: `receipt declares ${JSON.stringify(receipt.schema)}, expected ${WALKTHROUGH_RECEIPT_SCHEMA}`,
    });
  }
  if (typeof receipt.rows !== 'object' || receipt.rows === null) {
    return [...gaps, { code: 'walkthrough_rows_missing', detail: 'receipt has no rows object' }];
  }

  const expectedKeys = new Set(ACCESSIBILITY_TEST_MATRIX.map((row) => walkthroughRowKey(row)));
  for (const key of Object.keys(receipt.rows)) {
    if (!expectedKeys.has(key)) {
      gaps.push({
        code: 'walkthrough_row_unknown',
        detail: `receipt has a row "${key}" that is not in ACCESSIBILITY_TEST_MATRIX`,
      });
    }
  }
  const checkIds = new Set(ACCESSIBILITY_WALKTHROUGH_CHECKS.map((check) => check.id));

  for (const row of ACCESSIBILITY_TEST_MATRIX) {
    const key = walkthroughRowKey(row);
    const entry = receipt.rows[key];
    if (!entry) {
      gaps.push({ code: 'walkthrough_row_missing', detail: key });
      continue;
    }
    const items = entry.items ?? {};
    for (const id of Object.keys(items)) {
      if (!checkIds.has(id)) {
        gaps.push({
          code: 'walkthrough_item_unknown',
          detail: `${key} records "${id}", which is not in ACCESSIBILITY_WALKTHROUGH_CHECKS`,
        });
      }
    }
    for (const check of ACCESSIBILITY_WALKTHROUGH_CHECKS) {
      const item = items[check.id];
      if (!item) {
        gaps.push({ code: 'walkthrough_item_missing', detail: `${key}: ${check.id}` });
        continue;
      }
      if (!['pass', 'fail', 'not_performed', 'not_applicable'].includes(item.result)) {
        gaps.push({
          code: 'walkthrough_result_unknown',
          detail: `${key}: ${check.id} records ${JSON.stringify(item.result)}`,
        });
      }
      if (check.optional !== true && item.result === 'not_applicable') {
        gaps.push({
          code: 'walkthrough_not_applicable_on_required_check',
          detail: `${key}: ${check.id} (${check.area}) is a required check and cannot be not_applicable`,
        });
      }
      if (item.result === 'fail' && item.note.trim().length === 0) {
        gaps.push({
          code: 'walkthrough_failure_without_note',
          detail: `${key}: ${check.id} failed with no note describing what happened`,
        });
      }
    }
    if (checksAreComplete(entry)) {
      if (!environmentRecorded(entry.environment)) {
        gaps.push({
          code: 'walkthrough_pass_without_environment',
          detail: `${key} records every check as passing but no browser version, AT version, and OS`,
        });
      } else if (!receiptIsSigned(receipt)) {
        gaps.push({
          code: 'walkthrough_pass_without_signature',
          detail: `${key} records every check as passing but the receipt has no reviewer and reviewedAt`,
        });
      }
    }
  }
  return gaps;
}

/**
 * Parses a receipt and audits its structure. A malformed file returns no
 * receipt and a gap, so callers cannot accidentally audit `undefined` as if it
 * were an empty but valid record.
 */
export function parseWalkthroughReceipt(json: string): {
  receipt: WalkthroughReceipt | null;
  gaps: AccessibilityReviewGap[];
} {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return {
      receipt: null,
      gaps: [{ code: 'walkthrough_receipt_malformed', detail: 'not valid JSON' }],
    };
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return {
      receipt: null,
      gaps: [
        {
          code: 'walkthrough_receipt_malformed',
          detail: `expected a JSON object, got ${Array.isArray(raw) ? 'an array' : typeof raw}`,
        },
      ],
    };
  }
  const candidate = raw as Partial<WalkthroughReceipt>;
  const receipt: WalkthroughReceipt = {
    schema: typeof candidate.schema === 'string' ? candidate.schema : '',
    reviewer: typeof candidate.reviewer === 'string' ? candidate.reviewer : '',
    reviewedAt: typeof candidate.reviewedAt === 'string' ? candidate.reviewedAt : '',
    rows:
      typeof candidate.rows === 'object' && candidate.rows !== null
        ? candidate.rows
        : ({} as Record<string, WalkthroughRowReceipt>),
  };
  return { receipt, gaps: auditWalkthroughReceipt(receipt) };
}

/** A gap between the review record and what the gate requires. */
export interface AccessibilityReviewGap {
  code: string;
  detail: string;
}

/**
 * Checks the review record against itself and the palette, the way
 * auditTierAGateGaps() checks the phenome map: every documented ratio is
 * recomputed, every rendered colour must be documented, every focus boundary
 * must clear 3:1, and no critical or high finding may be left open.
 */
export function auditAccessibilityReview(
  review: typeof SECTION_508_REVIEW = SECTION_508_REVIEW,
  /** The recorded walkthrough results, when a caller has them (see loadWalkthroughReceipt) */
  receipt: WalkthroughReceipt | null = null,
): AccessibilityReviewGap[] {
  const gaps: AccessibilityReviewGap[] = [];
  const minimum = WCAG_REQUIREMENTS.NON_TEXT_BOUNDARY_CONTRAST_RATIO;

  // 1. Documented text-contrast ratios must agree with the formula.
  for (const [key, pair] of Object.entries(PALETTE_CONTRAST)) {
    const computed = contrastRatio(pair.color, pair.bg);
    if (Math.abs(computed - pair.ratio) > 0.001) {
      gaps.push({
        code: 'contrast_ratio_mismatch',
        detail: `${key}: documented ${pair.ratio}, computed ${computed} for ${pair.color} on ${pair.bg}`,
      });
    }
    const required = pair.normalText === 'FAIL' ? 0 : WCAG_REQUIREMENTS.NORMAL_TEXT_CONTRAST_RATIO;
    if (pair.normalText !== 'FAIL' && computed < required) {
      gaps.push({
        code: 'contrast_below_text_minimum',
        detail: `${key}: ${computed} is below ${required} but is documented as ${pair.normalText}`,
      });
    }
    for (const color of [pair.color, pair.bg]) {
      if (!PALETTE_COLORS.includes(color as (typeof PALETTE_COLORS)[number])) {
        gaps.push({
          code: 'undocumented_palette_colour',
          detail: `${key} uses ${color}, which is absent from PALETTE_COLORS`,
        });
      }
    }
  }

  // 2. Every focus boundary must clear the non-text minimum, as measured.
  for (const indicator of FOCUS_INDICATORS) {
    if (indicator.boundaries.length === 0) {
      gaps.push({
        code: 'focus_indicator_without_boundaries',
        detail: `${indicator.control} records no measured boundary`,
      });
    }
    for (const boundary of indicator.boundaries) {
      const computed = contrastRatio(indicator.innerRing.color, boundary.adjacentColor);
      const outer = indicator.outerRing
        ? contrastRatio(indicator.outerRing.color, boundary.adjacentColor)
        : 0;
      // A boundary passes when the ring facing it clears 3:1. The two-tone
      // indicator is a pair, so either band clearing the edge is enough;
      // record only where neither does.
      if (computed < minimum && outer < minimum) {
        gaps.push({
          code: 'focus_indicator_below_minimum',
          detail: `${indicator.control} against ${boundary.against}: ${computed} (and ${outer} for the outer ring) is below ${minimum}`,
        });
      }
      if (Math.abs(Math.max(computed, outer) - boundary.ratio) > 0.001) {
        gaps.push({
          code: 'focus_indicator_ratio_mismatch',
          detail: `${indicator.control} against ${boundary.against}: documented ${boundary.ratio}, computed ${Math.max(computed, outer)}`,
        });
      }
    }
  }

  // 3. Findings must be evidence-backed, criterion-mapped, and resolved.
  const seen = new Set<string>();
  for (const finding of review.findings) {
    if (seen.has(finding.id)) {
      gaps.push({ code: 'duplicate_finding_id', detail: finding.id });
    }
    seen.add(finding.id);
    if (finding.criteria.length === 0) {
      gaps.push({
        code: 'finding_without_criterion',
        detail: `${finding.id} cites no WCAG success criterion`,
      });
    }
    if (finding.evidence.trim().length === 0) {
      gaps.push({ code: 'finding_without_evidence', detail: finding.id });
    }
    if (finding.status === 'fixed' && finding.resolution.trim().length === 0) {
      gaps.push({ code: 'fix_without_resolution', detail: finding.id });
    }
    if (
      finding.status === 'open' &&
      (finding.severity === 'critical' || finding.severity === 'high')
    ) {
      gaps.push({
        code: 'open_blocking_finding',
        detail: `${finding.id} (${finding.severity}) is still open: ${finding.title}`,
      });
    }
  }

  // 4. Every matrix row must say what CI covers and what a human still must do.
  for (const row of review.matrix) {
    if (row.automatedCoverage.trim().length === 0 || row.humanProcedure.trim().length === 0) {
      gaps.push({
        code: 'matrix_row_without_procedure',
        detail: `${row.browser} / ${row.at} does not state both the automated coverage and the human step`,
      });
    }
  }
  if (review.matrix.length !== ACCESSIBILITY_TEST_MATRIX.length) {
    gaps.push({
      code: 'matrix_row_count',
      detail: `${review.matrix.length} reviewed rows against ${ACCESSIBILITY_TEST_MATRIX.length} matrix rows`,
    });
  }

  // 5. The status ledger may only name real rows, and must cover all of them.
  for (const key of Object.keys(WALKTHROUGH_RECORDED_STATUS)) {
    if (!ACCESSIBILITY_TEST_MATRIX.some((row) => walkthroughRowKey(row) === key)) {
      gaps.push({
        code: 'matrix_status_key_unknown',
        detail: `WALKTHROUGH_RECORDED_STATUS has "${key}", which is not a matrix row`,
      });
    }
  }
  for (const row of ACCESSIBILITY_TEST_MATRIX) {
    const key = walkthroughRowKey(row);
    if (!(key in WALKTHROUGH_RECORDED_STATUS)) {
      gaps.push({ code: 'matrix_status_missing', detail: key });
    }
  }

  // 6. The recorded walkthrough: a row's status is what the receipt supports,
  //    not what the record asserts, and a recorded failure is an open defect.
  if (receipt) {
    gaps.push(...auditWalkthroughReceipt(receipt));
    const recordedKeys = new Set(Object.keys(receipt.rows ?? {}));
    for (const row of review.matrix) {
      const key = walkthroughRowKey(row);
      if (!recordedKeys.has(key)) {
        // auditWalkthroughReceipt already reports the missing row; the record's
        // own status then simply has nothing behind it.
        continue;
      }
      const supported = deriveRowStatus(receipt, row);
      if (row.humanStatus !== supported) {
        gaps.push({
          code: 'matrix_status_not_from_receipt',
          detail: `${key}: the record says ${row.humanStatus}, the receipt supports ${supported}`,
        });
      }
      if (supported === 'fail') {
        gaps.push({
          code: 'matrix_row_failed',
          detail: `${key} recorded a failing check — the receipt note says what happened; fix it or record the mitigation`,
        });
      }
    }
  } else {
    // No receipt: no row may claim anything but "not performed".
    for (const row of review.matrix) {
      if (row.humanStatus !== 'not_performed') {
        gaps.push({
          code: 'matrix_status_without_receipt',
          detail: `${walkthroughRowKey(row)} claims ${row.humanStatus} but no receipt was supplied`,
        });
      }
    }
  }

  return gaps;
}
