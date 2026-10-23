/**
 * LifeChat by Life Insurance Broker Advocate — Embeddable Chat Widget
 *
 * Drop-in script for WordPress/Elementor sites.
 * Usage: Add this script tag to the page or via Elementor HTML widget:
 *   <script src="https://your-server.com/widget.js"
 *           data-server-url="https://your-server.com"></script>
 *
 * Features:
 *   - AI identity disclosure (always visible in header)
 *   - Privacy banner before first message, programmatically tied to the input
 *   - Keyboard navigable: no focus is taken on load, Escape closes, focus returns
 *     to the launcher, and the transcript is reachable to scroll
 *   - One polite live region (role="log") — announcements are not duplicated
 *   - Speaker identity carried in text, not by colour
 *   - Per-surface focus rings, measured in src/accessibility/accessibility.ts
 *   - Reflow-safe at 320px and against short viewports
 *   - Style-isolated: renders in an open shadow root with inherited typography
 *     reset at its root, so host-page CSS cannot restyle the widget or shrink
 *     its targets (one unstyled light-DOM host element is all it adds)
 *   - Reduced motion respected (CSS injected from the accessibility module)
 *   - Windows High Contrast Mode keeps an outline on every focusable control
 *   - Visual cards and citations are rendered from the application's
 *     pre-approved payloads as semantic DOM (figure/figcaption, table with
 *     scoped headers, lists, definition lists) — never from model text as markup
 *   - A visible Minimize/Expand toggle, plus automatic folding when focus leaves
 *     the widget, so the fixed panel never covers the element holding focus
 *     (WCAG 2.4.11, ACC-15)
 *   - Starts collapsed to its launcher: the panel covers nothing and takes no
 *     focus until the visitor asks for it
 *   - Message text keeps its paragraph and line breaks (white-space: pre-wrap)
 *     and every type size is a relative rem, so it scales with the host page
 *   - No PII in analytics events
 *
 * The accessibility contract here is asserted by tests/widget-accessibility.test.ts
 * and recorded in docs/section-508-accessibility-review.md. This file is plain
 * ES5 served statically (it is a third-party drop-in), so it cannot import from
 * src/; the tests compare the CSS and palette below against the module instead.
 */
(function () {
  'use strict';

  // ── Install guard ──
  //    A second copy of the script, a React 18 StrictMode double-invoked
  //    effect, or a remount after client-side navigation must re-attach the
  //    SAME dialog rather than build a second one (duplicate dialogs, ids and
  //    style tags confuse screen readers and make element ids ambiguous). The
  //    handle is also the teardown path for a React component (see mount/
  //    destroy at the end of this file).
  // ── Brand strings ──
  //    The product is LifeChat; the provider is Life Insurance Broker Advocate.
  //    This file is plain ES5 served statically, so it cannot import
  //    src/config/branding.ts — the two are kept identical by
  //    tests/branding.test.ts. /api/disclosure also sends productDisplayName,
  //    which replaces the title once it arrives; these values cover the window
  //    before the fetch resolves.
  var PRODUCT_NAME = 'LifeChat';
  var PROVIDER_BRAND = 'Life Insurance Broker Advocate';
  var PRODUCT_DISPLAY_NAME = PRODUCT_NAME + ' by ' + PROVIDER_BRAND;

  var GLOBAL_KEY = '__lppChatWidget';
  // The widget renders inside a shadow root attached to this light-DOM host.
  // The host id is the install handle: everything else lives in the shadow tree
  // and is not reachable from `document.getElementById`.
  var HOST_ID = 'lpp-chat-widget-host';
  // Declared before the first mount() call below: mount() can run while this
  // file is still executing, so these cannot be initialised further down.
  var historyPatches = [];
  var windowListenersAttached = false;
  if (window[GLOBAL_KEY]) {
    window[GLOBAL_KEY].mount();
    return;
  }
  if (document.getElementById(HOST_ID)) {
    return;
  }

  var scriptTag = document.currentScript;

  // ── API base ──
  //    The page and the API are different origins once the widget is embedded
  //    (Lovable SPA on lifeinsurancebrokeradvocate.com, this Express app
  //    elsewhere), so every call needs an absolute base. Without one,
  //    `fetch('/api/chat')` hits the host page's SPA fallback and returns HTML,
  //    which fails as "I'm having trouble responding" with no clue why.
  //    Precedence: window.LPP_CHAT_CONFIG.apiBase → data-api-base →
  //    data-server-url (the documented name) → this script's own directory, so
  //    a bare <script src="https://api.example.com/widget.js"> works with no
  //    attribute. Anything that is not an absolute http(s) base is ignored
  //    rather than silently becoming a request against the host page.
  function absoluteBase(value) {
    var normalized = String(value || '').trim().replace(/\/+$/, '');
    return /^https?:\/\/[^\s]+$/i.test(normalized) ? normalized : '';
  }

  function resolveApiBase(tag) {
    var configured = '';
    if (window.LPP_CHAT_CONFIG && typeof window.LPP_CHAT_CONFIG.apiBase === 'string') {
      configured = window.LPP_CHAT_CONFIG.apiBase;
    } else if (tag) {
      configured = tag.getAttribute('data-api-base') || tag.getAttribute('data-server-url') || '';
    }
    var resolved = absoluteBase(configured);
    if (resolved) return resolved;
    // A relative or missing base is ignored on purpose. Falling back to the
    // origin this script was served from keeps a bare
    // <script src="https://api.example.com/widget.js"> working, where using the
    // host page's origin would send every call to the SPA's 404 fallback. The
    // origin, not the script's directory: widget.js is served from /public, but
    // the API is mounted at /api, not /public/api.
    if (tag && typeof tag.src === 'string' && tag.src) {
      var origin = /^(https?:\/\/[^\/]+)/i.exec(String(tag.src));
      return origin ? absoluteBase(origin[1]) : '';
    }
    return '';
  }

  var serverUrl = resolveApiBase(scriptTag);

  // ── Color palette (Section 4.16; every pair below is recorded with a
  //    recomputed ratio in PALETTE_CONTRAST) ──
  var COLORS = {
    bg: '#E2E8F0', // light slate background (body text 14.118:1)
    border: '#485B61', // slate border (5.785:1 on bg — Pass AA)
    headline: '#CC0700', // red headline (4.735:1 on bg — Pass AA)
    button: '#414C32', // green button (white text 9.112:1 — Pass AAA)
    buttonHover: '#485B61', // slate hover (white text 7.132:1 — Pass AAA)
    bubbleAssistant: '#F0F0F0', // assistant bubble fill (text 15.272:1)
    banner: '#FFF3CD', // privacy banner fill (text 15.708:1)
    text: '#1a1a1a', // dark text for readability
    white: '#FFFFFF',
    focusLight: '#FFFFFF', // inner focus band on the dark controls
    focusDark: '#1a1a1a', // focus band against light surfaces (matches PALETTE_CONTRAST)
  };

  // ── Focus rings, measured per surface (FOCUS_INDICATORS). One colour cannot
  //    work: the buttons are dark green (a light ring is needed against the
  //    fill) and the page behind them is light slate (a dark ring is needed
  //    against that). Black on the button green measured 2.305:1, below the
  //    3:1 non-text minimum. ──
  // ── Host-page stacking ──
  //    Fixed positioning has to negotiate with the host page: the live site's
  //    header is sticky at z-40, and a Tailwind modal, sheet or consent layer
  //    commonly sits at z-50. A hard-coded 9999 covers those controls. The
  //    launcher stays above content by default (backwards compatible), and the
  //    embed can pin it below a given layer with data-z-index /
  //    data-bottom-offset, or through window.LPP_CHAT_CONFIG.
  //
  //    Both values are untrusted embed input, so each is range-checked rather
  //    than used as given: `zIndex: -1` would render the launcher behind the
  //    page and a negative offset would push it off-screen — a widget that
  //    loads and cannot be reached. An out-of-range or non-integer value falls
  //    back to the documented default instead of being clamped to a value the
  //    embed never asked for.
  var MAX_Z_INDEX = 2147483647;
  var MAX_BOTTOM_OFFSET_PX = 10000;

  function validStackNumber(value, min, max) {
    return typeof value === 'number' && isFinite(value) && value >= min && value <= max;
  }

  function readStackNumber(name, fallback, min, max) {
    var config = window.LPP_CHAT_CONFIG;
    var configKey = name === 'data-z-index' ? 'zIndex' : 'bottomOffset';
    if (config && Object.prototype.hasOwnProperty.call(config, configKey)) {
      var configured = config[configKey];
      return validStackNumber(configured, min, max) ? Math.floor(configured) : fallback;
    }
    var raw = tagValue(name);
    if (raw === null || raw === '') return fallback;
    var parsed = Number(raw);
    return validStackNumber(parsed, min, max) ? Math.floor(parsed) : fallback;
  }

  function tagValue(name) {
    if (!scriptTag || typeof scriptTag.getAttribute !== 'function') return null;
    var raw = scriptTag.getAttribute(name);
    return raw === undefined ? null : raw;
  }

  /**
   * The `bottom` value for the fixed panel and launcher.
   *
   * `bottom: 0` sits under the iOS home indicator and the Android gesture bar,
   * where the launcher's lower half cannot be tapped (WCAG 2.5.8 assumes a
   * reachable target). The device inset is therefore added to the bottom edge
   * rather than replacing it, and a configured `data-bottom-offset` still
   * clears whatever host layer it was meant for. `env()` with a 0 fallback is
   * inert on a device or browser without an inset.
   */
  function fixedBottom(offsetPx) {
    return (
      'calc(' + offsetPx + 'px + env(safe-area-inset-bottom, 0px))'
    );
  }

  var STACK_Z_INDEX = readStackNumber('data-z-index', 9999, 0, MAX_Z_INDEX);
  var BOTTOM_OFFSET_PX = readStackNumber('data-bottom-offset', 0, 0, MAX_BOTTOM_OFFSET_PX);
  var BOTTOM_CSS_VALUE = fixedBottom(BOTTOM_OFFSET_PX);

  var FOCUS = {
    light: { color: COLORS.focusLight, widthPx: 3 },
    dark: { color: COLORS.focusDark, widthPx: 3 },
    twoToneOuterWidthPx: 6,
  };

  // ── Reduced motion, byte-for-byte the module's REDUCED_MOTION_CSS (asserted
  //    by test: single source, no build step) ──
  var REDUCED_MOTION_CSS = [
    '@media (prefers-reduced-motion: reduce) {',
    '  .lpp-chat-widget *,',
    '  .lpp-chat-widget *::before,',
    '  .lpp-chat-widget *::after {',
    '    animation-duration: 0.01ms !important;',
    '    animation-iteration-count: 1 !important;',
    '    transition-duration: 0.01ms !important;',
    '    scroll-behavior: auto !important;',
    '  }',
    '}',
  ].join('\n');

  // ── Accessibility stylesheet. Inline styles cannot express :focus, so the
  //    rings, the visually-hidden utility, box-sizing and the reflow fallbacks
  //    live here. ──
  var a11yCSS = [
    // ── Style boundary ──
    // The widget is embedded in third-party themes (WordPress/Elementor) whose
    // rules are written for the page, not for it: a theme's `button { font-size:
    // … !important }` breaks target size, `* { letter-spacing: … }` breaks
    // readability. The shadow root already stops author selectors from
    // matching the widget's internals; `all: initial` on the inner root stops
    // the properties that *do* cross a shadow boundary by inheritance (font,
    // colour, letter/word spacing, white-space, text-transform, visibility)
    // from being carried in from the host element. The declarations after it
    // in the same block then establish the widget's own type scale.
    //
    // `all: revert` would restore the *host page's* values, which is the wrong
    // direction here: the widget wants a known baseline, not the theme's.
    ':host { all: initial; }',
    '.lpp-chat-root { all: initial; display: block;' +
      ' font-family: system-ui, -apple-system, sans-serif;' +
      ' font-size: 0.9375rem; line-height: 1.45; color: ' +
      COLORS.text +
      '; text-align: left; }',
    // Without border-box the 360px panel plus padding and borders overflows at
    // 320px width (WCAG 1.4.10).
    '.lpp-chat-widget, .lpp-chat-widget * { box-sizing: border-box; }',
    // Host pages built on Tailwind reset list markers (preflight:
    // `ol, ul, menu { list-style: none; padding: 0 }`), which erases the
    // citation bullets, card bullets and the numbering on process steps. These
    // rules are scoped to the widget and only restore what the widget renders.
    '.lpp-chat-widget ul { list-style-type: disc; list-style-position: outside; }',
    '.lpp-chat-widget ol { list-style-type: decimal; list-style-position: outside; }',
    // The appointment picker is a radiogroup, not a bulleted list.
    '.lpp-chat-widget .lpp-slots-list { list-style: none; }',
    '.lpp-chat-widget .lpp-visually-hidden {',
    '  position: absolute !important; width: 1px; height: 1px;',
    '  padding: 0; margin: -1px; overflow: hidden;',
    '  clip: rect(0 0 0 0); clip-path: inset(50%);',
    '  white-space: nowrap; border: 0;',
    '}',
    // dvh where it exists, so a mobile URL bar cannot push the header (and the
    // AI-identity disclosure) off screen.
    '@supports (height: 100dvh) {',
    '  .lpp-chat-widget { max-height: min(600px, calc(100dvh - 16px)); }',
    '}',
    // Input: white field on the light widget background — one dark ring clears
    // both edges (17.404:1 and 14.118:1).
    '#lpp-chat-input:focus { outline: ' +
      FOCUS.dark.widthPx +
      'px solid ' +
      FOCUS.dark.color +
      '; outline-offset: 2px; }',
    // Transcript: focusable so it can be scrolled by keyboard (WCAG 2.1.1).
    '#lpp-chat-messages:focus { outline: ' +
      FOCUS.dark.widthPx +
      'px solid ' +
      FOCUS.dark.color +
      '; outline-offset: -' +
      FOCUS.dark.widthPx +
      'px; }',
    // Buttons on the light page (green fill): light inner band against the
    // fill (9.112:1, 7.132:1 on hover) plus a dark outer band against the page
    // (14.118:1).
    '.lpp-chat-send:focus-visible,',
    '.lpp-chat-launcher:focus-visible {',
    '  outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 0;',
    '  box-shadow: 0 0 0 ' +
      FOCUS.twoToneOuterWidthPx +
      'px ' +
      FOCUS.dark.color +
      ';',
    '}',
    // Close button sits on the green header bar, which is dark on both sides of
    // the ring, so a single light ring clears both edges (9.112:1, 7.132:1).
    '.lpp-chat-close:focus-visible {',
    '  outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 2px;',
    '}',
    // The collapse toggle shares the close control's dark header bar, so it
    // takes the same single light ring (9.112:1 on the fill, 7.132:1 on hover).
    '.lpp-chat-collapse:focus-visible {',
    '  outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 2px;',
    '}',
    // ── Appointment slot picker. The times come from the server, so the
    //    picker is a radio group rather than free text: one time can be held,
    //    the group is one tab stop, and each label is the server's own local
    //    time. ──
    '.lpp-slots { margin: 0 0 12px; padding: 8px 12px; border: 1px solid ' +
      COLORS.border +
      '; border-radius: 4px; background: ' +
      COLORS.white +
      '; }',
    '.lpp-slots-title { margin: 0 0 4px; font-size: 0.8125rem; font-weight: 600; color: ' +
      COLORS.text +
      '; }',
    '.lpp-slots-hint, .lpp-slots-status, .lpp-slots-alert { margin: 0 0 8px; font-size: 0.75rem; color: ' +
      COLORS.text +
      '; }',
    '.lpp-slots-list { margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 8px; }',
    '.lpp-slot, .lpp-slot-retry, .lpp-slot-change { padding: 8px 12px; min-height: 24px; font-family: inherit;' +
      ' font-size: 0.8125rem; color: ' +
      COLORS.text +
      '; background: ' +
      COLORS.white +
      '; border: 1px solid ' +
      COLORS.border +
      '; border-radius: 4px; cursor: pointer; }',
    // The held time stays visible when the list is re-opened by "Change time".
    // The inset band and weight carry the state without shifting layout, so the
    // choice is not conveyed by colour alone (WCAG 1.4.1).
    '.lpp-slot[aria-checked="true"] { background: ' +
      COLORS.bg +
      '; font-weight: 600; box-shadow: inset 0 0 0 2px ' +
      COLORS.button +
      '; }',
    '.lpp-slot:disabled, .lpp-slot-change:disabled { opacity: 0.6; cursor: default; }',
    // Slot buttons sit on the white picker fill, so they take the dark ring
    // measured against it (15.272:1) like the card links.
    '.lpp-slot:focus-visible,',
    '.lpp-slot-retry:focus-visible,',
    '.lpp-slot-change:focus-visible,',
    '.lpp-card a:focus-visible,',
    '.lpp-citations a:focus-visible {',
    '  outline: ' +
      FOCUS.dark.widthPx +
      'px solid ' +
      FOCUS.dark.color +
      '; outline-offset: 2px;',
    '}',
    // ── Contact and privacy panel (C-08). The chat refuses direct identifiers;
    //    this panel is the secure path the refusal points at, and the consent
    //    statement is the canonical copy the server verifies (fetched, never
    //    hard-coded here). ──
    '.lpp-contact-actions { display: flex; flex-wrap: wrap; gap: 8px; padding: 0 16px 4px; }',
    '.lpp-contact-toggle, .lpp-contact-submit { padding: 8px 12px; min-height: 24px;' +
      ' font-family: inherit; font-size: 0.8125rem; border-radius: 4px; cursor: pointer; }',
    '.lpp-contact-toggle { color: ' +
      COLORS.text +
      '; background: ' +
      COLORS.white +
      '; border: 1px solid ' +
      COLORS.border +
      '; }',
    '.lpp-contact-submit { color: ' +
      COLORS.white +
      '; background: ' +
      COLORS.button +
      '; border: none; font-weight: 600; }',
    '.lpp-contact-toggle:disabled, .lpp-contact-submit:disabled { opacity: 0.6; cursor: default; }',
    '.lpp-contact-panel { margin: 0 16px 8px; padding: 8px 12px; border: 1px solid ' +
      COLORS.border +
      '; border-radius: 4px; background: ' +
      COLORS.white +
      '; }',
    // `hidden` is the toggle's state; display:none keeps a host theme's
    // `[hidden] { display: block }` override from exposing it.
    '.lpp-contact-panel[hidden] { display: none; }',
    '.lpp-contact-title { margin: 0 0 4px; font-size: 0.8125rem; font-weight: 600; color: ' +
      COLORS.text +
      '; }',
    '.lpp-contact-hint, .lpp-contact-status, .lpp-contact-alert { margin: 0 0 8px; font-size: 0.75rem; color: ' +
      COLORS.text +
      '; }',
    '.lpp-contact-field { margin: 0 0 8px; border: 0; padding: 0; }',
    '.lpp-contact-label, .lpp-contact-channel-legend { display: block; margin: 0 0 2px; font-size: 0.75rem;' +
      ' font-weight: 600; color: ' +
      COLORS.text +
      '; }',
    '.lpp-contact-channel { display: block; margin: 0 0 4px; font-size: 0.75rem; color: ' +
      COLORS.text +
      '; }',
    '.lpp-contact-channel input { margin: 0 6px 0 0; }',
    '.lpp-contact-input { width: 100%; padding: 6px 8px; min-height: 24px; font-family: inherit;' +
      ' font-size: 0.8125rem; color: ' +
      COLORS.text +
      '; background: ' +
      COLORS.white +
      '; border: 1px solid ' +
      COLORS.border +
      '; border-radius: 4px; }',
    '.lpp-contact-consent { display: block; margin: 0 0 8px; font-size: 0.75rem; line-height: 1.4; color: ' +
      COLORS.text +
      '; }',
    '.lpp-contact-consent input { margin: 0 6px 0 0; vertical-align: top; }',
    '.lpp-contact-link { color: ' +
      COLORS.text +
      '; text-decoration: underline; word-break: break-word; }',
    // Inputs and toggles sit on the white panel fill: one dark ring clears both
    // edges (15.272:1 and 14.118:1). The submit button is the green fill, so it
    // takes the same two-tone ring as Send.
    '.lpp-contact-input:focus-visible,',
    '.lpp-contact-toggle:focus-visible,',
    '.lpp-contact-channel input:focus-visible,',
    '.lpp-contact-consent input:focus-visible,',
    '.lpp-contact-link:focus-visible {',
    '  outline: ' +
      FOCUS.dark.widthPx +
      'px solid ' +
      FOCUS.dark.color +
      '; outline-offset: 2px;',
    '}',
    '.lpp-contact-submit:focus-visible {',
    '  outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 0;',
    '  box-shadow: 0 0 0 ' + FOCUS.twoToneOuterWidthPx + 'px ' + FOCUS.dark.color + ';',
    '}',
    // Browsers that understand @supports selector() but not :focus-visible get
    // the ring on every focus instead. Over-indicating beats no indicator.
    '@supports not selector(:focus-visible) {',
    '  .lpp-chat-send:focus, .lpp-chat-launcher:focus {',
    '    outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 0;',
    '    box-shadow: 0 0 0 ' +
      FOCUS.twoToneOuterWidthPx +
      'px ' +
      FOCUS.dark.color +
      ';',
    '  }',
    '  .lpp-chat-close:focus {',
    '    outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 2px;',
    '  }',
    '  .lpp-chat-collapse:focus {',
    '    outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 2px;',
    '  }',
    '  .lpp-slot:focus,',
    '  .lpp-slot-retry:focus,',
    '  .lpp-slot-change:focus,',
    '  .lpp-contact-input:focus,',
    '  .lpp-contact-toggle:focus,',
    '  .lpp-contact-channel input:focus,',
    '  .lpp-contact-consent input:focus,',
    '  .lpp-contact-link:focus,',
    '  .lpp-card a:focus,',
    '  .lpp-citations a:focus {',
    '    outline: ' +
      FOCUS.dark.widthPx +
      'px solid ' +
      FOCUS.dark.color +
      '; outline-offset: 2px;',
    '  }',
    '  .lpp-contact-submit:focus {',
    '    outline: ' +
      FOCUS.light.widthPx +
      'px solid ' +
      FOCUS.light.color +
      '; outline-offset: 0;',
    '    box-shadow: 0 0 0 ' +
      FOCUS.twoToneOuterWidthPx +
      'px ' +
      FOCUS.dark.color +
      ';',
    '  }',
    '}',
    // Forced colours: a box-shadow band is not painted at all, so every ring
    // is restated as an outline in a system colour.
    '@media (forced-colors: active) {',
    '  #lpp-chat-input:focus, #lpp-chat-messages:focus,',
    '  .lpp-chat-send:focus-visible, .lpp-chat-close:focus-visible,',
    '  .lpp-chat-collapse:focus-visible,',
    '  .lpp-slot:focus-visible, .lpp-slot-retry:focus-visible, .lpp-slot-change:focus-visible,',
    '  .lpp-contact-input:focus-visible, .lpp-contact-toggle:focus-visible,',
    '  .lpp-contact-submit:focus-visible,',
    '  .lpp-contact-channel input:focus-visible, .lpp-contact-consent input:focus-visible,',
    '  .lpp-contact-link:focus-visible,',
    '  .lpp-card a:focus-visible, .lpp-citations a:focus-visible,',
    '  .lpp-chat-launcher:focus-visible {',
    '    outline: ' +
      FOCUS.dark.widthPx +
      'px solid ButtonText; box-shadow: none;',
    '  }',
    '}',
    REDUCED_MOTION_CSS,
  ].join('\n');

  var a11yStyles = document.createElement('style');
  a11yStyles.id = 'lpp-chat-a11y-styles';
  a11yStyles.textContent = a11yCSS;
  // Appended by mount(), so destroy() can remove every node this script added.

  // ── Build the widget DOM ──
  var container = document.createElement('div');
  container.id = 'lpp-chat-widget';
  container.className = 'lpp-chat-widget';
  // role="dialog" with a name taken from the visible title (not a second,
  // separate string that could drift — WCAG 2.5.3). It is deliberately
  // NON-modal (no aria-modal, no focus trap): trapping focus would be a 2.1.2
  // failure for a widget embedded in a page the user still needs to read.
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-labelledby', 'lpp-chat-title');
  // Language of parts: the widget's copy is English even on a page that is not.
  container.setAttribute('lang', 'en');
  // Closed on load (ACC-15): a fixed panel that opens itself covers the
  // bottom-right of the host page before the visitor has asked for it. The
  // launcher is the entry point, so nothing is obscured until a click.
  container.style.cssText = [
    'position:fixed',
    'bottom:' + BOTTOM_CSS_VALUE,
    'right:0',
    'z-index:' + STACK_Z_INDEX,
    'width:min(360px, 100vw)',
    // The panel is anchored to the viewport bottom, so the safe-area inset it
    // is lifted by must also come off the top of its max height, or a short
    // viewport plus `overflow:hidden` clips the header.
    'max-height:calc(100vh - 16px - env(safe-area-inset-bottom, 0px))',
    'display:none',
    'flex-direction:column',
    'overflow:hidden',
    'background:' + COLORS.bg,
    'border:2px solid ' + COLORS.border,
    'border-radius:8px 8px 0 0',
    'font-family:system-ui,-apple-system,sans-serif',
    'font-size:0.9375rem',
    'color:' + COLORS.text,
    'box-shadow:0 -4px 12px rgba(0,0,0,0.15)',
  ].join(';');

  // ── Header (always shows "AI assistant") ──
  var header = document.createElement('div');
  header.style.cssText = [
    'padding:12px 16px',
    'background:' + COLORS.button,
    'color:' + COLORS.white,
    'font-weight:600',
    'font-size:0.875rem',
    'display:flex',
    'justify-content:space-between',
    'align-items:center',
  ].join(';');

  // Not an <h1>-<h6>: a heading injected at the end of a host page would join
  // that page's heading outline. The dialog name does the work instead.
  var title = document.createElement('div');
  title.id = 'lpp-chat-title';
  title.textContent = PRODUCT_DISPLAY_NAME;
  header.appendChild(title);

  var closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.className = 'lpp-chat-close';
  closeButton.textContent = '✕';
  closeButton.setAttribute('aria-label', 'Close chat');
  closeButton.style.cssText = [
    'background:none',
    'border:none',
    'color:' + COLORS.white,
    'font-size:1.125rem',
    'cursor:pointer',
    'padding:4px 8px',
    'min-width:24px',
    'min-height:24px',
  ].join(';');

  // ── Focus-collapse toggle (ACC-15). A fixed panel cannot promise 2.4.11 on
  //    its own, so the visitor gets a visible control that folds it to the
  //    header bar, and the panel also folds itself when focus moves out (see
  //    the focusin handler below). Visible text, not an icon: "Minimize" says
  //    what it does, and aria-expanded/aria-controls tie it to the body. ──
  var collapseToggle = document.createElement('button');
  collapseToggle.type = 'button';
  collapseToggle.className = 'lpp-chat-collapse';
  collapseToggle.id = 'lpp-chat-collapse';
  collapseToggle.textContent = 'Minimize';
  collapseToggle.setAttribute('aria-label', 'Minimize chat panel');
  collapseToggle.setAttribute('aria-controls', 'lpp-chat-body');
  collapseToggle.setAttribute('aria-expanded', 'true');
  collapseToggle.style.cssText = [
    'background:none',
    'border:none',
    'color:' + COLORS.white,
    'font-family:inherit',
    'font-size:0.75rem',
    'font-weight:600',
    'cursor:pointer',
    'padding:4px 6px',
    'min-width:24px',
    'min-height:24px',
    'text-decoration:underline',
  ].join(';');

  // Grouped so the title keeps the left edge and both controls stay together.
  var headerActions = document.createElement('div');
  headerActions.style.cssText = 'display:flex;align-items:center;gap:4px;flex:0 0 auto;';
  headerActions.appendChild(collapseToggle);
  headerActions.appendChild(closeButton);
  header.appendChild(headerActions);

  // ── Launcher: the way back in. Without it, closing the widget left it
  //    unreachable until a page reload. ──
  var launcher = document.createElement('button');
  launcher.type = 'button';
  launcher.className = 'lpp-chat-launcher';
  launcher.id = 'lpp-chat-launcher';
  launcher.textContent = 'Chat';
  launcher.setAttribute(
    'aria-label',
    'Chat with ' + PRODUCT_NAME + ', the AI educational assistant from ' + PROVIDER_BRAND,
  );
  launcher.setAttribute('aria-controls', 'lpp-chat-widget');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.style.cssText = [
    'position:fixed',
    'bottom:' + BOTTOM_CSS_VALUE,
    'right:0',
    'z-index:' + STACK_Z_INDEX,
    'display:block',
    'padding:10px 16px',
    'min-width:24px',
    'min-height:24px',
    'background:' + COLORS.button,
    'color:' + COLORS.white,
    'border:2px solid ' + COLORS.button,
    'border-bottom:none',
    'border-radius:8px 8px 0 0',
    'font-family:system-ui,-apple-system,sans-serif',
    'font-size:0.875rem',
    'font-weight:600',
    'cursor:pointer',
  ].join(';');

  // ── Privacy banner (before chat). The input points at it with
  //    aria-describedby, so the warning is read with the field.
  //
  //    The approved wording is owned by the server (`GET /api/disclosure` →
  //    `banner`, from BEFORE_CHAT_BANNER) and is written here when it arrives.
  //    Keeping a second copy in this file would let the two drift, and the
  //    copy a visitor is shown is the one counsel approved. Until the server
  //    answers, the banner must not present invented wording as if it were
  //    approved, so it says only that the notice is loading; if the notice
  //    never loads it says so and asks for a reload before chatting. ──
  var BANNER_LOADING_TEXT = 'Loading the approved before-chat privacy notice…';
  var BANNER_UNAVAILABLE_TEXT =
    'The approved before-chat privacy notice could not be loaded. Please reload the page before chatting.';

  var banner = document.createElement('div');
  banner.className = 'lpp-chat-banner';
  banner.id = 'lpp-chat-banner';
  banner.style.cssText = [
    'padding:8px 16px',
    'font-size:0.75rem',
    'line-height:1.4',
    'background:' + COLORS.banner,
    'border-bottom:1px solid ' + COLORS.border,
    'color:' + COLORS.text,
  ].join(';');
  banner.textContent = BANNER_LOADING_TEXT;

  // ── Messages container. This is the ONLY live region in the widget: the
  //    container used to carry aria-live="polite" as well, which made NVDA and
  //    JAWS announce every message twice. role="log" implies polite.
  //    tabindex="0" makes the scrollable transcript keyboard reachable. ──
  var messages = document.createElement('div');
  messages.id = 'lpp-chat-messages';
  messages.className = 'lpp-chat-messages';
  messages.setAttribute('role', 'log');
  messages.setAttribute('aria-live', 'polite');
  messages.setAttribute('aria-label', 'Conversation');
  messages.setAttribute('tabindex', '0');
  messages.style.cssText = [
    'flex:1 1 auto',
    // A flex item will not shrink below its content without this, which used to
    // push the header off a short viewport (WCAG 2.4.11 / 1.4.10).
    'min-height:0',
    'overflow-y:auto',
    'padding:16px',
    'outline-offset:-3px',
  ].join(';');

  // ── Input area ──
  var inputWrapper = document.createElement('div');
  inputWrapper.style.cssText = [
    'padding:8px 16px 12px',
    'display:flex',
    'gap:8px',
    'border-top:1px solid ' + COLORS.border,
  ].join(';');

  var inputLabel = document.createElement('label');
  inputLabel.className = 'lpp-visually-hidden';
  inputLabel.setAttribute('for', 'lpp-chat-input');
  inputLabel.textContent = 'Type your question';

  var input = document.createElement('input');
  input.type = 'text';
  input.id = 'lpp-chat-input';
  input.className = 'lpp-chat-input';
  input.placeholder = 'Ask about life insurance...';
  input.setAttribute('autocomplete', 'off');
  input.setAttribute('enterkeyhint', 'send');
  // A real label element (visually hidden) plus the privacy instructions,
  // instead of a placeholder doing the labelling (WCAG 3.3.2).
  input.setAttribute('aria-describedby', 'lpp-chat-banner');
  input.style.cssText = [
    // min-width:0 is what lets the field shrink at 320px; a fixed 200px floor
    // previously forced the row wider than the 288px panel.
    'flex:1 1 auto',
    'min-width:0',
    'padding:8px 12px',
    'font-size:0.9375rem',
    'font-family:inherit',
    'border:1px solid ' + COLORS.border,
    'border-radius:4px',
    'min-height:24px',
  ].join(';');

  var sendButton = document.createElement('button');
  sendButton.type = 'button';
  sendButton.className = 'lpp-chat-send';
  sendButton.textContent = 'Send';
  sendButton.setAttribute('aria-label', 'Send message');
  sendButton.style.cssText = [
    'flex:0 0 auto',
    'padding:8px 16px',
    'background:' + COLORS.button,
    'color:' + COLORS.white,
    'border:none',
    'border-radius:4px',
    'font-size:0.875rem',
    'font-weight:600',
    'font-family:inherit',
    'cursor:pointer',
    'min-width:24px',
    'min-height:24px',
    'transition:background-color 0.2s ease',
  ].join(';');

  inputWrapper.appendChild(inputLabel);
  inputWrapper.appendChild(input);
  inputWrapper.appendChild(sendButton);

  // ── Contact and privacy panel (C-08) ──
  //    A direct identifier in a chat message is refused and handed off, so the
  //    refusal needs somewhere to send the visitor. This is that place: the
  //    contact form posts to /api/consent over the same consented, encrypted
  //    path the API exposes, and the privacy form posts a TDPSA request to
  //    /api/dsr without the visitor hand-crafting an API call.
  //
  //    The consent statement is fetched from /api/consent-text, not copied
  //    here. /api/consent compares the submitted copy with the server's
  //    canonical text and stores the hash of that text, so a hard-coded copy
  //    that drifted would be rejected — or, worse, the form would show
  //    different words than the artifact proves. If the copy cannot be
  //    fetched, submission stays disabled.
  var contactArea = document.createElement('div');
  contactArea.className = 'lpp-contact-area';

  function contactField(id, labelText, node) {
    var wrap = document.createElement('div');
    wrap.className = 'lpp-contact-field';
    var label = document.createElement('label');
    label.className = 'lpp-contact-label';
    label.setAttribute('for', id);
    label.textContent = labelText;
    wrap.appendChild(label);
    wrap.appendChild(node);
    return wrap;
  }

  function contactInput(id, type, autocomplete, maxLength) {
    var field = document.createElement('input');
    field.type = type;
    field.id = id;
    field.className = 'lpp-contact-input';
    field.setAttribute('autocomplete', autocomplete);
    if (maxLength) field.setAttribute('maxlength', String(maxLength));
    return field;
  }

  var contactActions = document.createElement('div');
  contactActions.className = 'lpp-contact-actions';

  var contactToggle = document.createElement('button');
  contactToggle.type = 'button';
  contactToggle.id = 'lpp-contact-toggle';
  contactToggle.className = 'lpp-contact-toggle';
  contactToggle.textContent = 'Talk to a licensed broker';
  contactToggle.setAttribute('aria-expanded', 'false');
  contactToggle.setAttribute('aria-controls', 'lpp-contact-panel');

  var dsrToggle = document.createElement('button');
  dsrToggle.type = 'button';
  dsrToggle.id = 'lpp-dsr-toggle';
  dsrToggle.className = 'lpp-contact-toggle';
  dsrToggle.textContent = 'Privacy request';
  dsrToggle.setAttribute('aria-expanded', 'false');
  dsrToggle.setAttribute('aria-controls', 'lpp-dsr-panel');

  contactActions.appendChild(contactToggle);
  contactActions.appendChild(dsrToggle);

  // ── Contact form ──
  var contactPanel = document.createElement('div');
  contactPanel.id = 'lpp-contact-panel';
  contactPanel.className = 'lpp-contact-panel';
  contactPanel.setAttribute('role', 'group');
  contactPanel.setAttribute('aria-labelledby', 'lpp-contact-title');
  contactPanel.setAttribute('hidden', 'hidden');
  contactPanel.style.display = 'none';

  var contactTitle = document.createElement('p');
  contactTitle.id = 'lpp-contact-title';
  contactTitle.className = 'lpp-contact-title';
  contactTitle.textContent = 'Contact Richard Parslow';

  var contactHint = document.createElement('p');
  contactHint.className = 'lpp-contact-hint';
  contactHint.textContent =
    'Only your name and one contact method are needed. Richard Parslow is a licensed Texas life-insurance broker.';

  var contactForm = document.createElement('form');
  contactForm.id = 'lpp-contact-form';
  contactForm.setAttribute('novalidate', 'novalidate');

  var nameInput = contactInput('lpp-contact-name', 'text', 'name', 100);
  var emailInput = contactInput('lpp-contact-email', 'email', 'email', 254);
  emailInput.setAttribute('required', 'required');
  var phoneInput = contactInput('lpp-contact-phone', 'tel', 'tel', 32);

  var nameField = contactField('lpp-contact-name', 'First name (optional)', nameInput);
  var emailField = contactField('lpp-contact-email', 'Email address', emailInput);
  var phoneField = contactField('lpp-contact-phone', 'Phone number', phoneInput);
  // The phone field starts hidden because email is the initial channel.
  phoneField.setAttribute('hidden', 'hidden');
  phoneField.style.display = 'none';
  phoneInput.disabled = true;

  var channelGroup = document.createElement('fieldset');
  channelGroup.className = 'lpp-contact-field';
  var channelLegend = document.createElement('legend');
  channelLegend.className = 'lpp-contact-channel-legend';
  channelLegend.textContent = 'How should Richard reach you?';
  channelGroup.appendChild(channelLegend);

  var emailRadio = document.createElement('input');
  emailRadio.type = 'radio';
  emailRadio.id = 'lpp-contact-channel-email';
  emailRadio.setAttribute('name', 'lpp-contact-channel');
  emailRadio.value = 'email';
  emailRadio.checked = true;
  var emailRadioLabel = document.createElement('label');
  emailRadioLabel.className = 'lpp-contact-channel';
  emailRadioLabel.setAttribute('for', 'lpp-contact-channel-email');
  emailRadioLabel.appendChild(emailRadio);
  appendText(emailRadioLabel, 'span', '', 'Email');

  var phoneRadio = document.createElement('input');
  phoneRadio.type = 'radio';
  phoneRadio.id = 'lpp-contact-channel-phone';
  phoneRadio.setAttribute('name', 'lpp-contact-channel');
  phoneRadio.value = 'phone';
  var phoneRadioLabel = document.createElement('label');
  phoneRadioLabel.className = 'lpp-contact-channel';
  phoneRadioLabel.setAttribute('for', 'lpp-contact-channel-phone');
  phoneRadioLabel.appendChild(phoneRadio);
  appendText(phoneRadioLabel, 'span', '', 'Phone call or text');

  channelGroup.appendChild(emailRadioLabel);
  channelGroup.appendChild(phoneRadioLabel);

  var consentLabel = document.createElement('label');
  consentLabel.className = 'lpp-contact-consent';
  consentLabel.setAttribute('for', 'lpp-contact-consent');
  var contactCheckbox = document.createElement('input');
  contactCheckbox.type = 'checkbox';
  contactCheckbox.id = 'lpp-contact-consent';
  contactCheckbox.setAttribute('required', 'required');
  consentLabel.appendChild(contactCheckbox);
  var consentCopyNode = appendText(
    consentLabel,
    'span',
    'lpp-contact-copy',
    'Loading the approved consent text…',
  );

  var privacyLine = document.createElement('p');
  privacyLine.className = 'lpp-contact-hint';
  var privacyLink = appendText(privacyLine, 'a', 'lpp-contact-link', 'Read the privacy notice');
  privacyLink.setAttribute('target', '_blank');
  privacyLink.setAttribute('rel', 'noopener noreferrer');

  var contactSubmit = document.createElement('button');
  contactSubmit.type = 'submit';
  contactSubmit.id = 'lpp-contact-submit';
  contactSubmit.className = 'lpp-contact-submit';
  contactSubmit.textContent = 'Send my contact details';
  // Fail closed until the canonical copy arrives: the server would reject any
  // other copy, and a form that cannot know the approved words cannot take
  // consent.
  contactSubmit.disabled = true;

  var contactStatus = document.createElement('p');
  contactStatus.id = 'lpp-contact-status';
  contactStatus.className = 'lpp-contact-status';
  contactStatus.setAttribute('role', 'status');
  // Focusable so a completed submission can move focus to its own result
  // without adding a tab stop (WCAG 2.4.3: the visitor stays where the task
  // ended).
  contactStatus.setAttribute('tabindex', '-1');

  var contactAlert = document.createElement('p');
  contactAlert.id = 'lpp-contact-alert';
  contactAlert.className = 'lpp-contact-alert';
  contactAlert.setAttribute('role', 'alert');

  contactForm.appendChild(nameField);
  contactForm.appendChild(channelGroup);
  contactForm.appendChild(emailField);
  contactForm.appendChild(phoneField);
  contactForm.appendChild(consentLabel);
  contactForm.appendChild(privacyLine);
  contactForm.appendChild(contactSubmit);
  contactForm.appendChild(contactStatus);
  contactForm.appendChild(contactAlert);

  contactPanel.appendChild(contactTitle);
  contactPanel.appendChild(contactHint);
  contactPanel.appendChild(contactForm);

  // ── Data subject request form (TDPSA) ──
  var dsrPanel = document.createElement('div');
  dsrPanel.id = 'lpp-dsr-panel';
  dsrPanel.className = 'lpp-contact-panel';
  dsrPanel.setAttribute('role', 'group');
  dsrPanel.setAttribute('aria-labelledby', 'lpp-dsr-title');
  dsrPanel.setAttribute('hidden', 'hidden');
  dsrPanel.style.display = 'none';

  var dsrTitle = document.createElement('p');
  dsrTitle.id = 'lpp-dsr-title';
  dsrTitle.className = 'lpp-contact-title';
  dsrTitle.textContent = 'Privacy request';

  var dsrHint = document.createElement('p');
  dsrHint.className = 'lpp-contact-hint';
  dsrHint.textContent =
    'Ask for a copy of the personal data you shared, a correction, deletion, or a portable export. We respond within the statutory window.';

  var dsrForm = document.createElement('form');
  dsrForm.id = 'lpp-dsr-form';
  dsrForm.setAttribute('novalidate', 'novalidate');

  var dsrEmail = contactInput('lpp-dsr-email', 'email', 'email', 254);
  dsrEmail.setAttribute('required', 'required');
  var dsrEmailField = contactField('lpp-dsr-email', 'Email address for this request', dsrEmail);

  var dsrType = document.createElement('select');
  dsrType.id = 'lpp-dsr-type';
  dsrType.className = 'lpp-contact-input';
  var DSR_REQUEST_TYPES = [
    { value: 'access', label: 'Send me a copy of my data' },
    { value: 'correction', label: 'Correct my data' },
    { value: 'deletion', label: 'Delete my data' },
    { value: 'portability', label: 'Send my data in a portable format' },
  ];
  for (var dsrIndex = 0; dsrIndex < DSR_REQUEST_TYPES.length; dsrIndex++) {
    var option = document.createElement('option');
    option.value = DSR_REQUEST_TYPES[dsrIndex].value;
    option.textContent = DSR_REQUEST_TYPES[dsrIndex].label;
    dsrType.appendChild(option);
  }
  dsrType.value = 'access';
  var dsrTypeField = contactField('lpp-dsr-type', 'What would you like us to do?', dsrType);

  var dsrDetail = document.createElement('textarea');
  dsrDetail.id = 'lpp-dsr-detail';
  dsrDetail.className = 'lpp-contact-input';
  dsrDetail.setAttribute('rows', '3');
  dsrDetail.setAttribute('maxlength', '2000');
  var dsrDetailField = contactField('lpp-dsr-detail', 'Anything else we should know? (optional)', dsrDetail);

  var dsrSubmit = document.createElement('button');
  dsrSubmit.type = 'submit';
  dsrSubmit.id = 'lpp-dsr-submit';
  dsrSubmit.className = 'lpp-contact-submit';
  dsrSubmit.textContent = 'Send privacy request';

  var dsrStatus = document.createElement('p');
  dsrStatus.id = 'lpp-dsr-status';
  dsrStatus.className = 'lpp-contact-status';
  dsrStatus.setAttribute('role', 'status');
  dsrStatus.setAttribute('tabindex', '-1');

  var dsrAlert = document.createElement('p');
  dsrAlert.id = 'lpp-dsr-alert';
  dsrAlert.className = 'lpp-contact-alert';
  dsrAlert.setAttribute('role', 'alert');

  dsrForm.appendChild(dsrEmailField);
  dsrForm.appendChild(dsrTypeField);
  dsrForm.appendChild(dsrDetailField);
  dsrForm.appendChild(dsrSubmit);
  dsrForm.appendChild(dsrStatus);
  dsrForm.appendChild(dsrAlert);

  dsrPanel.appendChild(dsrTitle);
  dsrPanel.appendChild(dsrHint);
  dsrPanel.appendChild(dsrForm);

  contactArea.appendChild(contactPanel);
  contactArea.appendChild(dsrPanel);
  contactArea.appendChild(contactActions);

  // ── Panel body. The banner, transcript and input row live inside one
  //    wrapper so the collapse toggle can hide them as a unit while the
  //    header (the AI-identity disclosure, the toggle and Close) stays put. ──
  var body = document.createElement('div');
  body.id = 'lpp-chat-body';
  body.className = 'lpp-chat-body';
  body.style.cssText = [
    'flex:1 1 auto',
    'min-height:0',
    'display:flex',
    'flex-direction:column',
  ].join(';');
  body.appendChild(banner);
  body.appendChild(messages);
  body.appendChild(contactArea);
  body.appendChild(inputWrapper);

  container.appendChild(header);
  container.appendChild(body);

  // ── Shadow boundary ──
  //    Everything the widget builds lives in a shadow root, so a host page
  //    stylesheet cannot restyle the dialog, its buttons or the transcript.
  //    The only light-DOM node is a single host element: it carries the id the
  //    install guard and teardown use, and nothing a theme is likely to style
  //    (no classes, no inline layout). Browsers without attachShadow keep the
  //    previous light-DOM behaviour rather than rendering nothing.
  var host = document.createElement('div');
  host.id = HOST_ID;
  var shadow = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'open' }) : null;
  if (shadow) {
    var widgetRoot = document.createElement('div');
    widgetRoot.className = 'lpp-chat-root';
    shadow.appendChild(a11yStyles);
    shadow.appendChild(widgetRoot);
    widgetRoot.appendChild(container);
    widgetRoot.appendChild(launcher);
  }

  var mounted = false;
  mount();

  // ── Hover affordance (pointer only). The lift is skipped when the visitor
  //    asks for reduced motion; the colour change is not motion. ──
  var prefersReducedMotion =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  sendButton.addEventListener('mouseenter', function () {
    sendButton.style.background = COLORS.buttonHover;
    if (!prefersReducedMotion) {
      sendButton.style.transform = 'translateY(-2px)';
      sendButton.style.boxShadow = '0 4px 6px rgba(0,0,0,0.18)';
    }
  });
  sendButton.addEventListener('mouseleave', function () {
    sendButton.style.background = COLORS.button;
    sendButton.style.transform = '';
    sendButton.style.boxShadow = '';
  });

  // ── State. The session id comes only from the platform CSPRNG.
  //    crypto.randomUUID is exposed in secure contexts; elsewhere
  //    crypto.getRandomValues still gives 128 bits of entropy. There is no
  //    Math.random fallback: the API rejects ids that do not match
  //    lpp_[A-Za-z0-9_-]{12,64}, and a weak id is not worth minting. A browser
  //    with no CSPRNG gets a clear message instead of a broken session. ──
  function createSessionId() {
    var cryptoObj = typeof window !== 'undefined' ? window.crypto : null;
    if (!cryptoObj) return null;

    if (typeof cryptoObj.randomUUID === 'function') {
      try {
        return 'lpp_' + cryptoObj.randomUUID();
      } catch (_error) {
        // Fall through to getRandomValues (e.g. a blocked randomUUID).
      }
    }

    if (typeof cryptoObj.getRandomValues === 'function') {
      var bytes = new Uint8Array(16);
      try {
        cryptoObj.getRandomValues(bytes);
      } catch (_error) {
        return null;
      }
      var hex = '';
      for (var i = 0; i < bytes.length; i++) {
        hex += ('0' + bytes[i].toString(16)).slice(-2);
      }
      return 'lpp_' + hex;
    }

    return null;
  }

  var sessionId = createSessionId();
  var sourceUrl = window.location.pathname; // sanitized — no query params

  // ── Page context (Contextual Content Bridge). Reads the page once on load
  //    and sends it with the FIRST chat message so the backend can prioritize
  //    the article being read. Kept in memory; sent only on the first message. ──
  var contextualPage = buildPageContext();
  var pageContextSent = false;
  var lastSentPath = null;

  // ── SPA route sync ──
  //    A React Router / TanStack Router site changes the URL with
  //    history.pushState and never reloads the document, so the values read
  //    above go stale the moment the visitor opens a calculator or another
  //    article: later turns would describe the page the script loaded on. Re-read
  //    on every route change (and on back/forward) so sourceUrl and the page
  //    context describe the page actually open. Guarded because the widget also
  //    runs in environments without history (tests, very old browsers).
  function syncRoute() {
    if (!window.location || window.location.pathname === sourceUrl) return;
    sourceUrl = window.location.pathname;
    contextualPage = buildPageContext();
  }

  // Both wrapper and listener are tracked so destroy() can hand the page back
  // exactly as it found it.
  function wrapHistory(method) {
    var target = window.history;
    var original = target && target[method];
    if (typeof original !== 'function') return;
    var wrapped = function () {
      var result = original.apply(this, arguments);
      syncRoute();
      return result;
    };
    target[method] = wrapped;
    historyPatches.push({ target: target, method: method, original: original, wrapped: wrapped });
  }

  function attachRouteObservers() {
    if (historyPatches.length === 0) {
      wrapHistory('pushState');
      wrapHistory('replaceState');
    }
    if (!windowListenersAttached && typeof window.addEventListener === 'function') {
      window.addEventListener('popstate', syncRoute);
      window.addEventListener('hashchange', syncRoute);
      windowListenersAttached = true;
    }
  }

  function detachRouteObservers() {
    historyPatches.forEach(function (patch) {
      if (patch.target[patch.method] === patch.wrapped) {
        patch.target[patch.method] = patch.original;
      }
    });
    historyPatches = [];
    if (windowListenersAttached && typeof window.removeEventListener === 'function') {
      window.removeEventListener('popstate', syncRoute);
      window.removeEventListener('hashchange', syncRoute);
    }
    windowListenersAttached = false;
  }

  function readMeta(selector) {
    var el = document.querySelector(selector);
    return el && el.content ? el.content : null;
  }

  function buildPageContext() {
    var category =
      readMeta('meta[name="category"]') || readMeta('meta[property="article:section"]');
    var articleId = readMeta('meta[name="article_id"]') || readMeta('meta[property="article:tag"]');
    return {
      url: window.location.href,
      title: document.title || null,
      category: category || null,
      article_id: articleId || null,
    };
  }

  // ── Open / close. Opening moves focus into the field; closing returns focus
  //    to the launcher, because hiding a subtree that holds focus strands the
  //    keyboard and screen-reader user on the body (WCAG 2.4.3). ──
  function openWidget(moveFocus) {
    container.style.display = 'flex';
    launcher.style.display = 'none';
    launcher.setAttribute('aria-expanded', 'true');
    // Reopening always restores the full panel: focusing the input while its
    // parent is display:none would leave focus nowhere.
    if (!panelExpanded) {
      setPanelExpanded(true, false);
    }
    if (moveFocus) {
      input.focus();
    }
  }

  function closeWidget() {
    container.style.display = 'none';
    launcher.style.display = 'block';
    launcher.setAttribute('aria-expanded', 'false');
    launcher.focus();
  }

  // ── Focus collapse (ACC-15, WCAG 2.4.11) ──
  //    Two halves. The toggle lets the visitor fold the panel to its header bar
  //    without losing the conversation; the focusin handler folds it for them
  //    the moment focus lands on a page element outside the widget, so a fixed
  //    overlay can never leave the focused element underneath it.
  var panelExpanded = true;

  function isInside(node, ancestor) {
    var current = node;
    while (current) {
      if (current === ancestor) return true;
      current = current.parentNode;
    }
    return false;
  }

  // Focus inside a shadow tree is reported as the host both by
  // `document.activeElement` and by the retargeted `focusin` event, so the two
  // checks below have to descend one boundary to see the widget's own controls.
  function currentFocus() {
    var active = document.activeElement;
    if (active && active.shadowRoot && active.shadowRoot.activeElement) {
      return active.shadowRoot.activeElement;
    }
    return active;
  }

  function setPanelExpanded(expanded, moveFocus) {
    // Move focus before hiding: hiding the element that holds focus strands a
    // keyboard or screen-reader user on the body (WCAG 2.4.3).
    if (!expanded && moveFocus && isInside(currentFocus(), body)) {
      collapseToggle.focus();
    }
    panelExpanded = expanded;
    body.style.display = expanded ? 'flex' : 'none';
    collapseToggle.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    collapseToggle.textContent = expanded ? 'Minimize' : 'Expand';
    collapseToggle.setAttribute('aria-label', expanded
      ? 'Minimize chat panel'
      : 'Expand chat panel');
  }

  collapseToggle.onclick = function () {
    setPanelExpanded(!panelExpanded, true);
  };

  function onDocumentFocusIn(event) {
    var target = event ? event.target : null;
    // Focus inside the widget (including on the toggle) must not fold it. A
    // focus target inside the shadow tree is retargeted to the host, so that
    // case is treated as inside too.
    if (!panelExpanded || !target) return;
    if (target === host || isInside(target, container) || isInside(target, host)) return;
    setPanelExpanded(false, false);
  }
  if (typeof document.addEventListener === 'function') {
    document.addEventListener('focusin', onDocumentFocusIn);
  }

  closeButton.onclick = closeWidget;
  launcher.onclick = function () {
    openWidget(true);
  };
  container.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' || e.key === 'Esc') {
      closeWidget();
    }
  });

  // ── Helper: add a message to the chat ──
  //    opts.typing — the pending-reply indicator (announced as text, removed by
  //      reference rather than by matching "..." against the last child, which
  //      used to delete a user's own "..." message)
  //    opts.alert  — announce immediately (ARIA_LIVE_CONFIG.ERRORS: assertive)
  function addMessage(text, sender, opts) {
    var options = opts || {};
    var msg = document.createElement('div');
    msg.className = 'lpp-msg lpp-msg-' + sender;
    // pre-wrap keeps the blank lines and single line breaks an approved
    // answer already carries (a list written as "\n\n" would otherwise
    // collapse into one unformatted wall of text); overflow-wrap stops a long
    // unbroken URL from widening the panel.
    msg.style.cssText =
      'margin-bottom:12px;padding:8px 12px;border-radius:4px;' +
      'white-space:pre-wrap;overflow-wrap:break-word;' +
      (sender === 'assistant'
        ? 'background:' + COLORS.bubbleAssistant + ';'
        : 'background:' + COLORS.button + ';color:' + COLORS.white + ';margin-left:40px;');

    if (options.alert) {
      // An error is its own status message, announced without waiting its turn.
      msg.setAttribute('role', 'alert');
    }

    // Who is speaking is carried in text as well as colour: with the fill
    // removed (forced colours, CSS off) the bubbles would otherwise be
    // indistinguishable, and a screen reader would hear an unattributed stream.
    var who = document.createElement('span');
    who.className = 'lpp-visually-hidden';
    who.textContent = sender === 'user' ? 'You said: ' : 'Assistant said: ';

    var body = document.createElement('span');
    if (options.typing) {
      // Visible ellipsis, meaningful announcement.
      body.setAttribute('aria-hidden', 'true');
      body.textContent = '…';
      var typingLabel = document.createElement('span');
      typingLabel.className = 'lpp-visually-hidden';
      typingLabel.textContent = 'Assistant is typing';
      msg.appendChild(who);
      msg.appendChild(body);
      msg.appendChild(typingLabel);
    } else {
      body.textContent = text;
      msg.appendChild(who);
      msg.appendChild(body);
    }

    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
    return msg;
  }

  // ── Pre-approved visual card and citations ──
  //    Both payloads are produced by the application, never by the model: the
  //    model can only name a card_id from the approved library, and citations
  //    are resolved against the approved source list before they reach the
  //    widget. Even so, every value below is written with textContent — no
  //    payload is ever interpreted as markup, and an unknown card type or an
  //    unsafe citation URL is dropped rather than rendered.
  var extraIdCounter = 0;

  var CELL_STYLE =
    'padding:4px 6px;border-bottom:1px solid ' +
    COLORS.border +
    ';text-align:left;vertical-align:top;';

  function appendText(parent, tagName, className, text) {
    var node = document.createElement(tagName);
    if (className) node.className = className;
    node.textContent = text === null || text === undefined ? '' : String(text);
    parent.appendChild(node);
    return node;
  }

  /** Absolute http(s) only: javascript:, data:, and protocol-relative URLs are refused. */
  function isSafeHttpUrl(url) {
    return typeof url === 'string' && /^https?:\/\/[^\s]+$/i.test(url);
  }

  function renderComparisonTable(content, figure) {
    var columns = Array.isArray(content.columns) ? content.columns : [];
    var rows = Array.isArray(content.rows) ? content.rows : [];
    if (columns.length === 0 || rows.length === 0) return false;

    var table = document.createElement('table');
    table.style.cssText = 'width:100%;border-collapse:collapse;font-size:0.8125rem;line-height:1.4;';

    var thead = document.createElement('thead');
    var headRow = document.createElement('tr');
    for (var c = 0; c < columns.length; c++) {
      // Real table semantics: column headers in <th scope="col">, the first
      // cell of every row as a <th scope="row">. A flat list of <div>s would
      // lose the feature/value relationship a screen reader needs.
      var th = appendText(headRow, 'th', '', columns[c]);
      th.setAttribute('scope', 'col');
      th.style.cssText = CELL_STYLE + 'font-weight:600;';
    }
    thead.appendChild(headRow);
    table.appendChild(thead);

    var tbody = document.createElement('tbody');
    for (var r = 0; r < rows.length; r++) {
      var row = rows[r];
      if (!row || typeof row !== 'object') continue;
      var tr = document.createElement('tr');
      var rowHeader = appendText(tr, 'th', '', row.feature);
      rowHeader.setAttribute('scope', 'row');
      rowHeader.style.cssText = CELL_STYLE + 'font-weight:400;';
      var values = Array.isArray(row.values) ? row.values : [];
      for (var v = 0; v < columns.length - 1; v++) {
        appendText(tr, 'td', '', values[v]).style.cssText = CELL_STYLE;
      }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    figure.appendChild(table);
    return true;
  }

  function renderVisualCard(card) {
    if (!card || typeof card !== 'object') return null;
    if (typeof card.title !== 'string' || card.title.length === 0) return null;
    if (!card.content || typeof card.content !== 'object') return null;

    var cardType = typeof card.card_type === 'string' ? card.card_type : '';
    var figure = document.createElement('figure');
    figure.className = 'lpp-card lpp-card-' + cardType;
    figure.style.cssText = [
      'margin:8px 0 0',
      'padding:8px',
      'background:' + COLORS.bg,
      'border:1px solid ' + COLORS.border,
      'border-radius:4px',
      'font-size:0.8125rem',
      'line-height:1.4',
      // The bubble inherits pre-wrap from its parent; a table or list inside a
      // card has its own structure and must not honour source line breaks.
      'white-space:normal',
    ].join(';');

    // The caption is the card's accessible name; no separate heading joins the
    // host page's heading outline.
    appendText(figure, 'figcaption', 'lpp-card-title', card.title).style.cssText =
      'font-weight:600;margin-bottom:6px;';

    var content = card.content;
    var rendered = true;

    if (cardType === 'comparison_table') {
      rendered = renderComparisonTable(content, figure);
    } else if (cardType === 'bullet_list') {
      var items = Array.isArray(content.items) ? content.items : [];
      var list = document.createElement('ul');
      list.style.cssText = 'margin:0;padding-left:18px;';
      for (var i = 0; i < items.length; i++) appendText(list, 'li', '', items[i]);
      figure.appendChild(list);
    } else if (cardType === 'definition_card') {
      var definitionList = document.createElement('dl');
      definitionList.style.cssText = 'margin:0;';
      appendText(definitionList, 'dt', '', content.term).style.cssText = 'font-weight:600;';
      appendText(definitionList, 'dd', '', content.definition).style.cssText =
        'margin:0 0 6px 0;';
      if (content.example) {
        appendText(definitionList, 'dd', '', content.example).style.cssText =
          'margin:0;font-size:0.75rem;';
      }
      figure.appendChild(definitionList);
    } else if (cardType === 'process_steps') {
      var steps = Array.isArray(content.steps) ? content.steps : [];
      var ordered = document.createElement('ol');
      ordered.style.cssText = 'margin:0;padding-left:20px;';
      for (var s = 0; s < steps.length; s++) {
        var step = steps[s];
        if (!step || typeof step !== 'object') continue;
        var stepItem = document.createElement('li');
        stepItem.style.cssText = 'margin-bottom:6px;';
        appendText(stepItem, 'strong', '', step.title);
        if (step.description) appendText(stepItem, 'span', '', ' ' + step.description);
        ordered.appendChild(stepItem);
      }
      figure.appendChild(ordered);
    } else if (cardType === 'faq_accordion') {
      // A definition list rather than a collapsible widget: every answer is
      // reachable by keyboard without a disclosure pattern to operate.
      var faqList = document.createElement('dl');
      faqList.style.cssText = 'margin:0;';
      var faqItems = Array.isArray(content.items) ? content.items : [];
      for (var f = 0; f < faqItems.length; f++) {
        var faq = faqItems[f];
        if (!faq || typeof faq !== 'object') continue;
        appendText(faqList, 'dt', '', faq.question).style.cssText =
          'font-weight:600;margin-top:6px;';
        appendText(faqList, 'dd', '', faq.answer).style.cssText = 'margin:0;';
      }
      figure.appendChild(faqList);
    } else if (cardType === 'link_card') {
      if (content.description) appendText(figure, 'p', '', content.description).style.cssText =
        'margin:0 0 6px;';
      var link = appendText(figure, 'a', '', content.link_text || 'Read the full article');
      if (isSafeHttpUrl(content.url)) {
        link.setAttribute('href', content.url);
        link.setAttribute('rel', 'noopener noreferrer');
      }
      link.style.cssText =
        'color:' + COLORS.text + ';text-decoration:underline;word-break:break-word;';
    } else if (cardType === 'warning_card') {
      var note = document.createElement('div');
      note.setAttribute('role', 'note');
      appendText(note, 'p', '', content.message).style.cssText = 'margin:0;';
      figure.appendChild(note);
    } else if (cardType === 'stat_card') {
      appendText(figure, 'p', '', content.statistic).style.cssText =
        'margin:0;font-size:1rem;font-weight:600;';
      if (content.description) appendText(figure, 'p', '', content.description).style.cssText =
        'margin:2px 0 0;';
      if (content.source) appendText(figure, 'p', '', 'Source: ' + content.source).style.cssText =
        'margin:2px 0 0;font-size:0.75rem;';
    } else {
      // Fail closed: a card type outside the approved set is not shown at all.
      return null;
    }

    if (!rendered) return null;

    if (typeof card.disclaimer === 'string' && card.disclaimer.length > 0) {
      appendText(figure, 'p', 'lpp-card-disclaimer', card.disclaimer).style.cssText =
        'margin:6px 0 0;font-size:0.6875rem;font-style:italic;';
    }
    return figure;
  }

  function renderCitations(citations) {
    if (!Array.isArray(citations)) return null;

    var usable = [];
    for (var i = 0; i < citations.length; i++) {
      var item = citations[i];
      if (!item || typeof item !== 'object') continue;
      if (typeof item.title !== 'string' || item.title.length === 0) continue;
      if (!isSafeHttpUrl(item.url)) continue;
      usable.push(item);
    }
    if (usable.length === 0) return null;

    extraIdCounter += 1;
    var labelId = 'lpp-citations-label-' + extraIdCounter;
    var block = document.createElement('div');
    block.className = 'lpp-citations';
    // A group named by its own visible label: the sources are announced as a
    // set, and the visible heading is the accessible name (2.5.3).
    block.setAttribute('role', 'group');
    block.setAttribute('aria-labelledby', labelId);
    block.style.cssText = 'margin-top:8px;';

    var label = appendText(block, 'p', 'lpp-citations-heading', 'Sources');
    label.setAttribute('id', labelId);
    label.style.cssText = 'margin:0 0 2px;font-size:0.75rem;font-weight:600;';

    var list = document.createElement('ul');
    list.style.cssText = 'margin:0;padding-left:18px;font-size:0.75rem;';
    for (var j = 0; j < usable.length; j++) {
      var li = document.createElement('li');
      var link = appendText(li, 'a', '', usable[j].title);
      link.setAttribute('href', usable[j].url);
      link.setAttribute('rel', 'noopener noreferrer');
      link.style.cssText =
        'color:' + COLORS.text + ';text-decoration:underline;word-break:break-word;';
      list.appendChild(li);
    }
    block.appendChild(list);
    return block;
  }

  /** Attach the resolved card and citation list to a completed reply bubble. */
  function renderAssistantExtras(data, messageNode) {
    if (!data || !messageNode) return;
    var figure = renderVisualCard(data.visual_card);
    if (figure) messageNode.appendChild(figure);
    var sources = renderCitations(data.citations);
    if (sources) messageNode.appendChild(sources);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Appointment slots ──
  //    A scheduling turn hands the visitor the server's own inventory: the only
  //    slot ids rendered are the ones GET /api/scheduling/slots just returned,
  //    and choosing one POSTs that id to /api/scheduling/select. The model never
  //    supplies a time, and selecting a slot books nothing — it records which
  //    time the visitor wants so a later confirmation can name it.
  var SLOT_RENDER_LIMIT = 24;
  var SLOT_ID_PATTERN = /^slot_[0-9]{8}T[0-9]{4}Z$/;
  var slotPickerSeq = 0;
  var activeSlotPicker = null;

  /** Replaces the previous picker so only the newest conversation turn offers times. */
  function renderAppointmentSlots(data) {
    if (!data || data.state !== 'scheduling' || !sessionId) return;

    // A newer scheduling turn replaces the previous list. If focus is inside
    // that list, removing it would drop the visitor onto the body mid-task
    // (WCAG 2.4.3), so the replacement has to take focus as well as the place.
    var pickerHadFocus = !!activeSlotPicker && isInside(currentFocus(), activeSlotPicker);

    if (activeSlotPicker && activeSlotPicker.parentNode === messages) {
      messages.removeChild(activeSlotPicker);
    }

    var picker = document.createElement('div');
    picker.className = 'lpp-slots';
    slotPickerSeq += 1;
    var titleId = 'lpp-slots-title-' + slotPickerSeq;
    var hintId = 'lpp-slots-hint-' + slotPickerSeq;

    var title = document.createElement('p');
    title.className = 'lpp-slots-title';
    title.id = titleId;
    title.textContent = 'Available appointment times';
    picker.appendChild(title);

    var hint = document.createElement('p');
    hint.className = 'lpp-slots-hint';
    hint.id = hintId;
    hint.textContent =
      "Times are shown in the practice's time zone. Choose one to hold it for this conversation.";
    picker.appendChild(hint);

    // Loading, progress and the selection are polite; a failure is an alert so
    // it is not queued behind the rest of the transcript.
    var status = document.createElement('p');
    status.className = 'lpp-slots-status';
    status.setAttribute('role', 'status');
    picker.appendChild(status);

    var alertNode = document.createElement('p');
    alertNode.className = 'lpp-slots-alert';
    alertNode.setAttribute('role', 'alert');
    picker.appendChild(alertNode);

    // One choice, one tab stop, arrows inside it: the WAI-ARIA radio-group
    // pattern. The group is labelled by the title and described by the hint,
    // and the status/alert live outside it so they are announced on their own.
    var list = document.createElement('div');
    list.className = 'lpp-slots-list';
    list.setAttribute('role', 'radiogroup');
    list.setAttribute('aria-labelledby', titleId);
    list.setAttribute('aria-describedby', hintId);
    picker.appendChild(list);

    messages.appendChild(picker);
    activeSlotPicker = picker;
    messages.scrollTop = messages.scrollHeight;

    if (pickerHadFocus) {
      // The title is the radio group's accessible name, so landing there keeps
      // focus inside the new picker and announces what replaced the old list.
      // Replacing one list with another must not steal focus when the visitor
      // was elsewhere (the composer, say), hence the pickerHadFocus guard.
      title.setAttribute('tabindex', '-1');
      if (typeof title.focus === 'function') title.focus();
    }

    var buttons = [];
    var selecting = false;
    var loading = false;
    var retryButton = null;
    var changeButton = null;
    // The time this picker last committed. Kept so "Change time" can reopen
    // the list with the current choice checked and focused; the server holds
    // the authoritative copy (a new selection replaces it).
    var selectedSlotId = null;
    var revealSelection = false;

    function clearList() {
      while (list.childNodes.length > 0) list.removeChild(list.childNodes[0]);
    }

    function removeRetry() {
      if (retryButton && retryButton.parentNode === picker) picker.removeChild(retryButton);
      retryButton = null;
    }

    function showRetry() {
      if (retryButton) return;
      retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'lpp-slot-retry';
      retryButton.textContent = 'Try again';
      retryButton.onclick = function () {
        loadSlots();
      };
      picker.appendChild(retryButton);
    }

    function removeChange() {
      if (changeButton && changeButton.parentNode === picker) picker.removeChild(changeButton);
      changeButton = null;
    }

    /** After a time is held, offer the inventory again so it can be swapped. */
    function showChange() {
      if (changeButton) return;
      changeButton = document.createElement('button');
      changeButton.type = 'button';
      changeButton.className = 'lpp-slot-change';
      changeButton.textContent = 'Change time';
      changeButton.onclick = function () {
        if (loading || selecting) return;
        revealSelection = true;
        // Keep the control in place (disabled) while the list reloads, so focus
        // has somewhere to stay until the chosen slot can take it back.
        changeButton.disabled = true;
        loadSlots();
      };
      picker.appendChild(changeButton);
    }

    function setDisabled(disabled) {
      for (var i = 0; i < buttons.length; i += 1) buttons[i].disabled = disabled;
    }

    /** One tab stop for the whole group: the focused radio holds tabindex 0. */
    function setActive(index) {
      if (buttons.length === 0) return -1;
      var next = ((index % buttons.length) + buttons.length) % buttons.length;
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].setAttribute('tabindex', i === next ? '0' : '-1');
      }
      return next;
    }

    /** Move focus — never the selection — to a radio, wrapping at both ends. */
    function focusSlot(index) {
      var next = setActive(index);
      if (next === -1) return;
      if (typeof buttons[next].focus === 'function') buttons[next].focus();
    }

    /** Mark the committed radio so a screen reader hears which time was chosen. */
    function markChecked(slotId) {
      for (var i = 0; i < buttons.length; i += 1) {
        buttons[i].setAttribute(
          'aria-checked',
          buttons[i].getAttribute('data-slot-id') === slotId ? 'true' : 'false',
        );
      }
    }

    function clearChecked() {
      for (var i = 0; i < buttons.length; i += 1) buttons[i].setAttribute('aria-checked', 'false');
    }

    /**
     * Radio-group keys (APG): arrows, Home and End move focus only; Enter and
     * Space commit the focused time. These are real buttons, so their native
     * activation is cancelled — the commit runs once, through the same choose()
     * a pointer click uses.
     */
    function handleSlotKey(event, index) {
      var key = event.key;
      if (key === 'ArrowDown' || key === 'ArrowRight') {
        event.preventDefault();
        focusSlot(index + 1);
        return;
      }
      if (key === 'ArrowUp' || key === 'ArrowLeft') {
        event.preventDefault();
        focusSlot(index - 1);
        return;
      }
      if (key === 'Home') {
        event.preventDefault();
        focusSlot(0);
        return;
      }
      if (key === 'End') {
        event.preventDefault();
        focusSlot(buttons.length - 1);
        return;
      }
      if (key === 'Enter' || key === ' ' || key === 'Spacebar') {
        event.preventDefault();
        if (!buttons[index]) return;
        setActive(index);
        choose(buttons[index].getAttribute('data-slot-id'), buttons[index].textContent);
      }
    }

    /**
     * Renders only well-formed, server-issued slots. Anything else — a missing
     * id, an id that is not the canonical grid shape, an empty label, a repeat —
     * is dropped rather than offered, and the label is written with textContent
     * so no value is ever interpreted as markup.
     */
    function renderSlots(payload) {
      var raw = payload && Object.prototype.toString.call(payload.slots) === '[object Array]'
        ? payload.slots
        : [];
      var usable = [];
      var seen = {};
      for (var i = 0; i < raw.length && usable.length < SLOT_RENDER_LIMIT; i += 1) {
        var slot = raw[i];
        if (!slot || typeof slot !== 'object') continue;
        if (typeof slot.slot_id !== 'string' || !SLOT_ID_PATTERN.test(slot.slot_id)) continue;
        if (typeof slot.display !== 'string') continue;
        var label = slot.display.trim();
        if (label.length === 0 || label.length > 80) continue;
        if (seen[slot.slot_id]) continue;
        seen[slot.slot_id] = true;
        usable.push({ slotId: slot.slot_id, label: label });
      }

      clearList();
      buttons = [];
      alertNode.textContent = '';

      if (usable.length === 0) {
        status.textContent = 'No appointment times are currently available.';
        if (revealSelection) {
          revealSelection = false;
          removeChange();
          status.setAttribute('tabindex', '-1');
          if (typeof status.focus === 'function') status.focus();
        }
        return;
      }

      status.textContent =
        usable.length < raw.length ? 'Showing the next ' + usable.length + ' available times.' : '';

      for (var j = 0; j < usable.length; j += 1) {
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'lpp-slot';
        button.textContent = usable[j].label;
        button.setAttribute('role', 'radio');
        button.setAttribute('aria-checked', 'false');
        button.setAttribute('tabindex', j === 0 ? '0' : '-1');
        button.setAttribute('data-slot-id', usable[j].slotId);
        (function (node, index, choice) {
          node.onclick = function () {
            setActive(index);
            choose(choice.slotId, choice.label);
          };
          node.addEventListener('keydown', function (event) {
            handleSlotKey(event, index);
          });
        })(button, j, usable[j]);
        buttons.push(button);
        list.appendChild(button);
      }

      // Returning from "Change time": this is a fresh render of the same
      // inventory, so restore the prior choice's checked state and put focus
      // back on it (or the first time if it is no longer offered). Removing the
      // trigger only after focus moves keeps it on an element inside the picker.
      if (revealSelection) {
        revealSelection = false;
        var selectedIndex = -1;
        for (var k = 0; k < buttons.length; k += 1) {
          if (buttons[k].getAttribute('data-slot-id') === selectedSlotId) selectedIndex = k;
        }
        if (selectedIndex !== -1) buttons[selectedIndex].setAttribute('aria-checked', 'true');
        focusSlot(selectedIndex === -1 ? 0 : selectedIndex);
        removeChange();
      }
    }

    function choose(slotId, label) {
      if (selecting || loading) return;
      selecting = true;
      setDisabled(true);
      markChecked(slotId);
      alertNode.textContent = '';
      status.textContent = 'Saving that time…';

      fetch(serverUrl + '/api/scheduling/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, slotId: slotId }),
      })
        .then(function (response) {
          var code = typeof response.status === 'number' ? response.status : 200;
          return response.json().then(
            function (body) {
              return { status: code, body: body };
            },
            function () {
              return { status: code, body: null };
            },
          );
        })
        .then(function (result) {
          var body = result.body;
          var saved =
            result.status >= 200 &&
            result.status < 300 &&
            body &&
            body.selected === true &&
            body.slotId === slotId;
          if (saved) {
            selecting = false;
            selectedSlotId = slotId;
            clearList();
            buttons = [];
            // Focus must not fall to the body when the button list goes away.
            status.setAttribute('tabindex', '-1');
            if (typeof status.focus === 'function') status.focus();
            status.textContent =
              'Selected ' + label + '. Reply in the chat to confirm, or change the time.';
            showChange();
            return;
          }
          selecting = false;
          clearChecked();
          if (result.status === 409) {
            status.textContent = '';
            loadSlots();
            // After the refresh's own clearing, so the explanation survives
            // until the new list arrives (renderSlots clears it then).
            alertNode.textContent = 'That time was just taken. Showing the updated times.';
            return;
          }
          if (result.status === 429) {
            alertNode.textContent = 'Too many requests. Please wait a moment and try again.';
          } else {
            alertNode.textContent = 'That time could not be saved. Please try again.';
          }
          setDisabled(false);
        })
        .catch(function () {
          selecting = false;
          clearChecked();
          status.textContent = '';
          alertNode.textContent = 'That time could not be saved. Please try again.';
          setDisabled(false);
        });
    }

    function loadSlots() {
      if (loading) return;
      loading = true;
      removeRetry();
      clearList();
      buttons = [];
      alertNode.textContent = '';
      status.textContent = 'Loading available times…';

      /** A failed reload must not strand focus on the disabled Change button. */
      function loadFailed(message) {
        status.textContent = '';
        alertNode.textContent = message;
        var wasChanging = revealSelection;
        revealSelection = false;
        removeChange();
        showRetry();
        if (wasChanging && retryButton && typeof retryButton.focus === 'function') {
          retryButton.focus();
        }
      }

      fetch(serverUrl + '/api/scheduling/slots', { headers: { Accept: 'application/json' } })
        .then(function (response) {
          var code = typeof response.status === 'number' ? response.status : 200;
          return response.json().then(
            function (body) {
              return { status: code, body: body };
            },
            function () {
              return { status: code, body: null };
            },
          );
        })
        .then(function (result) {
          loading = false;
          if (result.status >= 200 && result.status < 300 && result.body) {
            renderSlots(result.body);
            return;
          }
          loadFailed(
            result.status === 429
              ? 'Too many requests. Please wait a moment and try again.'
              : 'Could not load available times. Please try again.',
          );
        })
        .catch(function () {
          loading = false;
          loadFailed('Could not load available times. Please try again.');
        });
    }

    loadSlots();
  }

  // ── Contact and privacy request behaviour (C-08) ──
  var contactCopy = null;
  var contactCopyLoading = false;
  var contactSending = false;
  var contactSubmitted = false;
  var dsrSending = false;
  var dsrSubmitted = false;

  function selectedChannel() {
    if (emailRadio.checked) return 'email';
    if (phoneRadio.checked) return 'phone';
    return '';
  }

  function setPanelOpen(panel, toggle, open) {
    if (open) {
      panel.removeAttribute('hidden');
      panel.style.display = 'block';
      toggle.setAttribute('aria-expanded', 'true');
    } else {
      panel.setAttribute('hidden', 'hidden');
      panel.style.display = 'none';
      toggle.setAttribute('aria-expanded', 'false');
    }
  }

  function openContactPanel(open) {
    setPanelOpen(contactPanel, contactToggle, open);
    if (!open) return;
    setPanelOpen(dsrPanel, dsrToggle, false);
    loadContactCopy();
    if (selectedChannel() === 'phone') phoneInput.focus();
    else emailInput.focus();
  }

  function openDsrPanel(open) {
    setPanelOpen(dsrPanel, dsrToggle, open);
    if (!open) return;
    setPanelOpen(contactPanel, contactToggle, false);
    dsrEmail.focus();
  }

  contactToggle.onclick = function () {
    openContactPanel(contactToggle.getAttribute('aria-expanded') !== 'true');
  };
  dsrToggle.onclick = function () {
    openDsrPanel(dsrToggle.getAttribute('aria-expanded') !== 'true');
  };

  /** The form's visible announcement slots are separate: status is polite, alert is assertive. */
  function clearContactMessages() {
    contactStatus.textContent = '';
    contactAlert.textContent = '';
  }

  function showContactAlert(text) {
    contactStatus.textContent = '';
    contactAlert.textContent = text;
  }

  function showDsrAlert(text) {
    dsrStatus.textContent = '';
    dsrAlert.textContent = text;
  }

  /**
   * A safe failure sentence: the field-level message the server returns for a
   * validation error, else its message, else a stable fallback. Server text is
   * written as text, never markup.
   */
  function requestErrorText(status, data) {
    if (data && Array.isArray(data.details) && data.details.length > 0) {
      var first = data.details[0];
      if (first && typeof first.message === 'string' && first.message) return first.message;
    }
    if (data && typeof data.message === 'string' && data.message) return data.message;
    if (data && typeof data.reason === 'string' && data.reason) return data.reason;
    if (data && typeof data.error === 'string' && data.error) return data.error;
    if (status === 429) return 'Too many requests. Please wait a moment and try again.';
    return 'We could not send that just now. Please check your connection and try again.';
  }

  /** Applies the canonical copy for the selected channel and the notice link. */
  function applyContactCopy() {
    if (!contactCopy) return;
    var channel = selectedChannel() === 'phone' ? 'phone' : 'email';
    consentCopyNode.textContent =
      channel === 'phone' ? contactCopy.phoneConsentCopy : contactCopy.emailConsentCopy;
    if (typeof contactCopy.privacyNoticeUrl === 'string' && isSafeHttpUrl(contactCopy.privacyNoticeUrl)) {
      privacyLink.setAttribute('href', contactCopy.privacyNoticeUrl);
    }
    if (!contactSending && !contactSubmitted) contactSubmit.disabled = false;
  }

  /**
   * Fetches the approved disclosure once per session. A failure leaves the
   * submit button disabled, because the server would reject any copy this
   * widget could invent.
   */
  function loadContactCopy() {
    if (contactCopy || contactCopyLoading) return;
    contactCopyLoading = true;
    contactStatus.textContent = 'Loading the approved consent text…';
    contactAlert.textContent = '';
    fetch(serverUrl + '/api/consent-text', { headers: { Accept: 'application/json' } })
      .then(function (response) {
        var code = typeof response.status === 'number' ? response.status : 200;
        return response.json().then(
          function (body) {
            return { status: code, body: body };
          },
          function () {
            return { status: code, body: null };
          },
        );
      })
      .then(function (result) {
        contactCopyLoading = false;
        var data = result.body && typeof result.body === 'object' ? result.body : null;
        if (
          result.status < 200 ||
          result.status >= 300 ||
          !data ||
          typeof data.emailConsentCopy !== 'string' ||
          typeof data.phoneConsentCopy !== 'string'
        ) {
          contactSubmit.disabled = true;
          showContactAlert(
            'The approved consent text could not be loaded. Please check your connection and reopen this form to try again.',
          );
          return;
        }
        contactCopy = data;
        contactStatus.textContent = '';
        applyContactCopy();
      })
      .catch(function () {
        contactCopyLoading = false;
        contactSubmit.disabled = true;
        showContactAlert(
          'The approved consent text could not be loaded. Please check your connection and reopen this form to try again.',
        );
      });
  }

  /** Swaps the visible contact field and resets consent, because the copy changed. */
  function updateChannelFields() {
    var emailChosen = selectedChannel() !== 'phone';
    emailInput.disabled = !emailChosen;
    phoneInput.disabled = emailChosen;
    if (emailChosen) {
      emailField.removeAttribute('hidden');
      emailField.style.display = 'block';
      phoneField.setAttribute('hidden', 'hidden');
      phoneField.style.display = 'none';
    } else {
      emailField.setAttribute('hidden', 'hidden');
      emailField.style.display = 'none';
      phoneField.removeAttribute('hidden');
      phoneField.style.display = 'block';
    }
    // The email and phone disclosures are different legal texts: a tick for
    // one is not a tick for the other.
    contactCheckbox.checked = false;
    consentCopyNode.textContent = contactCopy
      ? selectedChannel() === 'phone'
        ? contactCopy.phoneConsentCopy
        : contactCopy.emailConsentCopy
      : 'Loading the approved consent text…';
  }

  emailRadio.addEventListener('change', updateChannelFields);
  phoneRadio.addEventListener('change', updateChannelFields);

  contactForm.addEventListener('submit', function (event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (contactSending || contactSubmitted) return;
    clearContactMessages();

    var channel = selectedChannel();
    if (!channel) {
      showContactAlert('Choose how you would like to be contacted.');
      emailRadio.focus();
      return;
    }

    var email = emailInput.value.trim();
    var phone = phoneInput.value.trim();
    if (channel === 'email' && !email) {
      showContactAlert('Enter an email address so Richard can reply.');
      emailInput.focus();
      return;
    }
    if (channel === 'phone' && !phone) {
      showContactAlert('Enter a phone number so Richard can call or text.');
      phoneInput.focus();
      return;
    }
    if (!contactCopy) {
      showContactAlert(
        'The approved consent text has not loaded yet. Please wait a moment or reopen this form.',
      );
      return;
    }
    if (contactCheckbox.checked !== true) {
      showContactAlert('Please check the consent statement before sending your details.');
      contactCheckbox.focus();
      return;
    }

    var payload = {
      contactConsentAffirmed: true,
      contactChannel: channel,
      consentText:
        channel === 'phone' ? contactCopy.phoneConsentCopy : contactCopy.emailConsentCopy,
      sourceUrl: sourceUrl,
    };
    if (channel === 'phone') payload.phone = phone;
    else payload.email = email;
    var firstName = nameInput.value.trim();
    if (firstName) payload.firstName = firstName;
    if (sessionId) payload.sessionId = sessionId;
    if (contextualPage && contextualPage.category) payload.topicCategory = contextualPage.category;

    contactSending = true;
    contactSubmit.disabled = true;
    contactStatus.textContent = 'Sending your details…';
    fetch(serverUrl + '/api/consent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (response) {
        var code = typeof response.status === 'number' ? response.status : 200;
        return response.json().then(
          function (body) {
            return { status: code, body: body };
          },
          function () {
            return { status: code, body: null };
          },
        );
      })
      .then(function (result) {
        contactSending = false;
        var data = result.body && typeof result.body === 'object' ? result.body : null;
        if (result.status < 200 || result.status >= 300) {
          contactSubmit.disabled = !contactCopy;
          showContactAlert(requestErrorText(result.status, data));
          return;
        }
        // One submission per session: a retry after a success would append a
        // second lead for the same visit.
        contactSubmitted = true;
        contactSubmit.disabled = true;
        nameInput.disabled = true;
        emailInput.disabled = true;
        phoneInput.disabled = true;
        emailRadio.disabled = true;
        phoneRadio.disabled = true;
        contactCheckbox.disabled = true;
        contactStatus.textContent =
          data && typeof data.message === 'string' && data.message
            ? data.message
            : 'Your information has been received.';
        contactStatus.focus();
      })
      .catch(function () {
        contactSending = false;
        contactSubmit.disabled = !contactCopy;
        showContactAlert(
          'We could not send your details. Please check your connection and try again.',
        );
      });
  });

  dsrForm.addEventListener('submit', function (event) {
    if (event && typeof event.preventDefault === 'function') event.preventDefault();
    if (dsrSending || dsrSubmitted) return;
    dsrStatus.textContent = '';
    dsrAlert.textContent = '';

    var contactEmail = dsrEmail.value.trim();
    if (!contactEmail) {
      showDsrAlert('Enter the email address the request is about.');
      dsrEmail.focus();
      return;
    }
    var requestType = dsrType.value;
    var recognised = false;
    for (var index = 0; index < DSR_REQUEST_TYPES.length; index++) {
      if (DSR_REQUEST_TYPES[index].value === requestType) recognised = true;
    }
    if (!recognised) requestType = 'access';

    var dsrPayload = { requestType: requestType, contactEmail: contactEmail };
    var detail = dsrDetail.value.trim();
    if (detail) dsrPayload.detail = detail;

    dsrSending = true;
    dsrSubmit.disabled = true;
    dsrStatus.textContent = 'Sending your request…';
    fetch(serverUrl + '/api/dsr', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(dsrPayload),
    })
      .then(function (response) {
        var code = typeof response.status === 'number' ? response.status : 200;
        return response.json().then(
          function (body) {
            return { status: code, body: body };
          },
          function () {
            return { status: code, body: null };
          },
        );
      })
      .then(function (result) {
        dsrSending = false;
        var data = result.body && typeof result.body === 'object' ? result.body : null;
        if (result.status < 200 || result.status >= 300) {
          dsrSubmit.disabled = false;
          showDsrAlert(requestErrorText(result.status, data));
          return;
        }
        dsrSubmitted = true;
        dsrSubmit.disabled = true;
        dsrEmail.disabled = true;
        dsrType.disabled = true;
        dsrDetail.disabled = true;
        var dsrMessage =
          data && typeof data.message === 'string' && data.message
            ? data.message
            : 'Your privacy request has been received.';
        // The reference id is the server's own identifier; without it the
        // visitor has no handle for a follow-up.
        if (data && typeof data.requestId === 'string' && data.requestId) {
          dsrMessage += ' Reference: ' + data.requestId;
        }
        dsrStatus.textContent = dsrMessage;
        dsrStatus.focus();
      })
      .catch(function () {
        dsrSending = false;
        dsrSubmit.disabled = false;
        showDsrAlert('We could not send your request. Please check your connection and try again.');
      });
  });

  // ── Fetch the approved disclosure and before-chat banner ──

  /**
   * The disclosure could not be read. The server is the only source of the
   * approved wording, so this does not invent a greeting to stand in for it:
   * it says the conversation has not started and gives the way out. The
   * banner switches to its unavailable text for the same reason.
   */
  function showDisclosureUnavailable() {
    banner.textContent = BANNER_UNAVAILABLE_TEXT;
    addMessage(
      'The approved disclosure for this assistant could not be loaded, so the conversation has not started. Please reload the page, or contact Richard Parslow directly.',
      'assistant',
      { alert: true },
    );
  }

  function loadDisclosure() {
    // Ask the backend for a disclosure enriched with page context (optional),
    // so the opening message can reference the article being read when it maps
    // to a known topic (Section 16.3), plus the approved before-chat banner.
    var disclosurePath = serverUrl + '/api/disclosure';
    var ctx = contextualPage;
    var q =
      '?' +
      ['url=' + encodeURIComponent(ctx.url), 'title=' + encodeURIComponent(ctx.title || '')].join(
        '&',
      );
    fetch(disclosurePath + q)
      .then(function (r) {
        // Status before body: a proxy error page is HTML, not JSON, and
        // json() throws on it — which used to look like a network failure.
        var code = typeof r.status === 'number' ? r.status : 200;
        return r.json().then(
          function (body) {
            return { status: code, body: body };
          },
          function () {
            return { status: code, body: null };
          },
        );
      })
      .then(function (result) {
        var data = result.body && typeof result.body === 'object' ? result.body : null;
        if (
          result.status < 200 ||
          result.status >= 300 ||
          !data ||
          typeof data.firstMessage !== 'string' ||
          !data.firstMessage.trim()
        ) {
          showDisclosureUnavailable();
          return;
        }
        // The banner is server-owned copy: render exactly what was approved,
        // and treat a missing one as a contract failure rather than falling
        // back to wording this file would have to keep in sync.
        if (typeof data.banner === 'string' && data.banner.trim()) {
          banner.textContent = data.banner.trim();
        } else {
          banner.textContent = BANNER_UNAVAILABLE_TEXT;
        }
        // Server-owned branding: the header and the launcher name come from the
        // API so the widget cannot drift from the disclosure the API serves.
        if (typeof data.productDisplayName === 'string' && data.productDisplayName.trim()) {
          title.textContent = data.productDisplayName.trim();
        }
        if (typeof data.productName === 'string' && data.productName.trim()) {
          launcher.setAttribute(
            'aria-label',
            'Chat with ' +
              data.productName.trim() +
              ', the AI educational assistant from ' +
              (typeof data.providerBrand === 'string' && data.providerBrand.trim()
                ? data.providerBrand.trim()
                : PROVIDER_BRAND),
          );
        }
        addMessage(data.firstMessage, 'assistant');
      })
      .catch(showDisclosureUnavailable);
  }
  loadDisclosure();

  // ── Send message to server ──
  function sendMessage() {
    var text = input.value.trim();
    if (!text) return;

    if (!sessionId) {
      addMessage(
        'Chat is unavailable because this browser does not provide the secure random number generator a session requires.',
        'assistant',
      );
      return;
    }

    addMessage(text, 'user');
    input.value = '';

    // Show typing indicator after 500ms
    var typingNode = null;
    var typingTimer = setTimeout(function () {
      typingNode = addMessage('', 'assistant', { typing: true });
    }, 500);

    function clearTyping() {
      clearTimeout(typingTimer);
      if (typingNode && typingNode.parentNode === messages) {
        messages.removeChild(typingNode);
      }
      typingNode = null;
    }

    var payload = {
      sessionId: sessionId,
      message: text,
      sourceUrl: sourceUrl,
    };
    // Page context is sent with the first message (Section 3.2), and again
    // only when the SPA route changed since the last send — never on an
    // ordinary follow-up turn.
    if (!pageContextSent || sourceUrl !== lastSentPath) {
      payload.page_context = contextualPage;
      payload.topicCategory = contextualPage.category || undefined;
      pageContextSent = true;
      lastSentPath = sourceUrl;
    }

    fetch(serverUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        // Read the status before the body: a cross-origin failure or a proxy
        // error page is HTML, not JSON, and json() throws on it. Treating a
        // 429 body as a normal reply rendered "undefined" in the transcript.
        var code = typeof r.status === 'number' ? r.status : 200;
        return r.json().then(
          function (body) {
            return { status: code, body: body };
          },
          function () {
            return { status: code, body: null };
          },
        );
      })
      .then(function (result) {
        clearTyping();
        var data = result.body && typeof result.body === 'object' ? result.body : {};

        if (
          result.status < 200 ||
          result.status >= 300 ||
          typeof data.assistant_message !== 'string'
        ) {
          var reason =
            result.status === 429
              ? 'You are sending messages a little quickly. Please wait a moment and try again.'
              : result.status === 403
                ? 'This page is not allowed to use the assistant. Please contact Richard Parslow directly.'
                : typeof data.message === 'string' && data.message
                  ? data.message
                  : "I'm having trouble responding right now. Please try again in a moment, or contact Richard Parslow directly.";
          addMessage(reason, 'assistant', { alert: true });
          return;
        }

        var replyNode = addMessage(data.assistant_message, 'assistant');
        renderAssistantExtras(data, replyNode);
        renderAppointmentSlots(data);

        // Push analytics event (no PII). The host page owns dataLayer: GTM may
        // not have loaded yet, may use its own array, or a consent shim may
        // freeze it. Create the array if it is missing (the standard GTM
        // pattern) and never let a host analytics error break the reply.
        if (data.analytics && data.analytics.event_name) {
          try {
            if (!window.dataLayer) window.dataLayer = [];
            if (typeof window.dataLayer.push === 'function') {
              window.dataLayer.push({
                event: data.analytics.event_name,
                conversation_stage: data.analytics.conversation_stage,
                fallback_type: data.analytics.fallback_type,
              });
            }
          } catch (analyticsError) {
            // Deliberately swallowed: analytics is not part of the answer.
          }
        }
      })
      .catch(function () {
        clearTyping();
        addMessage(
          "I'm having trouble responding right now. Please try again in a moment, or contact Richard Parslow directly.",
          'assistant',
          { alert: true },
        );
      });
  }

  // ── Mount / teardown ──
  //    mount() attaches the dialog and the stylesheet and is idempotent;
  //    destroy() removes everything this script added, including the document
  //    focus listener, so a React component can unmount without leaving ids,
  //    listeners or a stray floating button behind. The conversation state
  //    survives a destroy/mount cycle on purpose: closing and reopening the
  //    panel must not mint a new session.
  function mount() {
    if (mounted || document.getElementById(HOST_ID)) return;
    if (shadow) {
      if (!host.parentNode) document.body.appendChild(host);
    } else {
      if (!a11yStyles.parentNode) document.head.appendChild(a11yStyles);
      document.body.appendChild(container);
      document.body.appendChild(launcher);
    }
    attachRouteObservers();
    mounted = true;
  }

  function destroy() {
    if (typeof document.removeEventListener === 'function') {
      document.removeEventListener('focusin', onDocumentFocusIn);
    }
    detachRouteObservers();
    if (shadow) {
      // One node removes the entire widget, including its stylesheet: the
      // shadow tree is only reachable through the host.
      if (host.parentNode) host.parentNode.removeChild(host);
    } else {
      [container, launcher, a11yStyles].forEach(function (node) {
        if (node && node.parentNode) node.parentNode.removeChild(node);
      });
    }
    mounted = false;
  }

  window[GLOBAL_KEY] = {
    mount: mount,
    destroy: destroy,
    open: function () {
      openWidget(true);
    },
    close: closeWidget,
  };

  sendButton.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function (e) {
    // isComposing: while an IME or voice input is confirming a candidate, Enter
    // commits the candidate rather than sending the message.
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Deliberately no autofocus and no auto-open: taking focus, or covering the
  // page with a panel, on load would pull a keyboard or screen-reader visitor
  // out of the article they were reading (WCAG 3.2.1, 2.4.3, 2.4.11). Focus
  // enters the widget when the visitor opens the launcher or tabs to it.
})();
