/**
 * Accessibility and Multilingual Requirements (Section 4.12)
 *
 * Target WCAG 2.2 AA. Normal text requires at least 4.5:1 contrast and
 * large text at least 3:1. The widget must be fully operable by keyboard,
 * have visible focus indicators, expose correct ARIA, announce new
 * messages, allow zoom/reflow, respect reduced motion, and more.
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

/**
 * Color palette contrast results (Section 4.16 / palette analysis).
 * All pairs verified with the WCAG relative-luminance formula.
 */
export const PALETTE_CONTRAST = {
  // Headline red on light background — PASS AA
  HEADLINE_ON_BG: { color: '#CC0700', bg: '#E2E8F0', ratio: 4.735, normalText: 'Pass AA', largeText: 'Pass AA' },
  // Slate border on light background — PASS AA
  BORDER_ON_BG: { color: '#485B61', bg: '#E2E8F0', ratio: 5.785, normalText: 'Pass AA', largeText: 'Pass AA' },
  // White text on green button — PASS AAA
  WHITE_ON_BUTTON: { color: '#FFFFFF', bg: '#414C32', ratio: 9.112, normalText: 'Pass AAA', largeText: 'Pass AAA' },
  // Green on light background — PASS AAA
  GREEN_ON_BG: { color: '#414C32', bg: '#E2E8F0', ratio: 7.392, normalText: 'Pass AAA', largeText: 'Pass AAA' },
  // White on slate hover — PASS AAA
  WHITE_ON_HOVER: { color: '#FFFFFF', bg: '#485B61', ratio: 7.132, normalText: 'Pass AAA', largeText: 'Pass AAA' },
  // WARNING: Red on slate border — FAIL (do not use this combination)
  RED_ON_SLATE: { color: '#CC0700', bg: '#485B61', ratio: 1.222, normalText: 'FAIL', largeText: 'FAIL' },
} as const;

/**
 * Palette usage rules derived from the contrast analysis:
 * - The palette passes when used as proposed if button text is white
 *   and the red headline remains on the light background
 * - Do NOT place the red headline on the slate border/hover color
 * - Preserve a 3:1 focus indicator against both normal and hover states
 */
export const PALETTE_RULES = [
  'Button text must be white on #414C32 background',
  'Red headline #CC0700 must remain on light background #E2E8F0',
  'Do NOT place red headline #CC0700 on slate border #485B61 (fails 1.222:1)',
  'Preserve 3:1 focus indicator against both normal and hover states',
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
 */
export const ARIA_LIVE_CONFIG = {
  // The assistant message container should be aria-live="polite"
  ASSISTANT_MESSAGES: 'polite',
  // Booking status changes should be aria-live="assertive"
  BOOKING_STATUS: 'assertive',
  // Error messages should be aria-live="assertive"
  ERRORS: 'assertive',
} as const;

/**
 * Generates the CSS for the prefers-reduced-motion media query.
 * Used by the widget and the Elementor block.
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
