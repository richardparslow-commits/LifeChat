/**
 * Life Policy Pilot AI Educational Assistant — Embeddable Chat Widget
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

  // ── Install guard (a second copy of the script must not build a second
  //    dialog: duplicate dialogs, ids and style tags confuse screen readers
  //    and make element ids ambiguous) ──
  if (document.getElementById('lpp-chat-widget')) {
    return;
  }

  var scriptTag = document.currentScript;
  var serverUrl = (scriptTag && scriptTag.getAttribute('data-server-url')) || '';

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
    // Without border-box the 360px panel plus padding and borders overflows at
    // 320px width (WCAG 1.4.10).
    '.lpp-chat-widget, .lpp-chat-widget * { box-sizing: border-box; }',
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
    '.lpp-slot, .lpp-slot-retry { padding: 8px 12px; min-height: 24px; font-family: inherit;' +
      ' font-size: 0.8125rem; color: ' +
      COLORS.text +
      '; background: ' +
      COLORS.white +
      '; border: 1px solid ' +
      COLORS.border +
      '; border-radius: 4px; cursor: pointer; }',
    '.lpp-slot:disabled { opacity: 0.6; cursor: default; }',
    // Slot buttons sit on the white picker fill, so they take the dark ring
    // measured against it (15.272:1) like the card links.
    '.lpp-slot:focus-visible,',
    '.lpp-slot-retry:focus-visible,',
    '.lpp-card a:focus-visible,',
    '.lpp-citations a:focus-visible {',
    '  outline: ' +
      FOCUS.dark.widthPx +
      'px solid ' +
      FOCUS.dark.color +
      '; outline-offset: 2px;',
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
    '  .lpp-card a:focus,',
    '  .lpp-citations a:focus {',
    '    outline: ' +
      FOCUS.dark.widthPx +
      'px solid ' +
      FOCUS.dark.color +
      '; outline-offset: 2px;',
    '  }',
    '}',
    // Forced colours: a box-shadow band is not painted at all, so every ring
    // is restated as an outline in a system colour.
    '@media (forced-colors: active) {',
    '  #lpp-chat-input:focus, #lpp-chat-messages:focus,',
    '  .lpp-chat-send:focus-visible, .lpp-chat-close:focus-visible,',
    '  .lpp-chat-collapse:focus-visible,',
    '  .lpp-slot:focus-visible, .lpp-slot-retry:focus-visible,',
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
  document.head.appendChild(a11yStyles);

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
    'bottom:0',
    'right:0',
    'z-index:9999',
    'width:min(360px, 100vw)',
    'max-height:calc(100vh - 16px)',
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
  title.textContent = 'Life Policy Pilot — AI Educational Assistant';
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
  launcher.setAttribute('aria-label', 'Chat with the Life Policy Pilot AI Educational Assistant');
  launcher.setAttribute('aria-controls', 'lpp-chat-widget');
  launcher.setAttribute('aria-expanded', 'false');
  launcher.style.cssText = [
    'position:fixed',
    'bottom:0',
    'right:0',
    'z-index:9999',
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
  //    aria-describedby, so the warning is read with the field. ──
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
  banner.textContent =
    'You are chatting with an AI educational assistant. Do not enter medical, financial-account, Social Security, or other highly sensitive information. Messages may be stored and reviewed to provide and improve the service.';

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
  body.appendChild(inputWrapper);

  container.appendChild(header);
  container.appendChild(body);
  document.body.appendChild(container);
  document.body.appendChild(launcher);

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

  function setPanelExpanded(expanded, moveFocus) {
    // Move focus before hiding: hiding the element that holds focus strands a
    // keyboard or screen-reader user on the body (WCAG 2.4.3).
    if (!expanded && moveFocus && isInside(document.activeElement, body)) {
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

  if (typeof document.addEventListener === 'function') {
    document.addEventListener('focusin', function (event) {
      var target = event ? event.target : null;
      // Focus inside the widget (including on the toggle) must not fold it.
      if (!panelExpanded || !target || isInside(target, container)) return;
      setPanelExpanded(false, false);
    });
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

    var buttons = [];
    var selecting = false;
    var loading = false;
    var retryButton = null;

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
            clearList();
            buttons = [];
            // Focus must not fall to the body when the button list goes away.
            status.setAttribute('tabindex', '-1');
            if (typeof status.focus === 'function') status.focus();
            status.textContent =
              'Selected ' + label + '. Reply in the chat to confirm the appointment.';
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
          status.textContent = '';
          alertNode.textContent =
            result.status === 429
              ? 'Too many requests. Please wait a moment and try again.'
              : 'Could not load available times. Please try again.';
          showRetry();
        })
        .catch(function () {
          loading = false;
          status.textContent = '';
          alertNode.textContent = 'Could not load available times. Please try again.';
          showRetry();
        });
    }

    loadSlots();
  }

  // ── Fetch the initial disclosure message ──
  function loadDisclosure() {
    // Ask the backend for a disclosure enriched with page context (optional),
    // so the opening message can reference the article being read when it maps
    // to a known topic (Section 16.3). Falls back to the standard message.
    // The fallback is the disclosure itself, not an error, so it is announced
    // politely like any other assistant message.
    var disclosurePath = serverUrl + '/api/disclosure';
    var ctx = contextualPage;
    var q =
      '?' +
      ['url=' + encodeURIComponent(ctx.url), 'title=' + encodeURIComponent(ctx.title || '')].join(
        '&',
      );
    fetch(disclosurePath + q)
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        addMessage(data.firstMessage, 'assistant');
      })
      .catch(function () {
        addMessage(
          "I'm the Life Policy Pilot AI Educational Assistant. How can I help you learn about life insurance today?",
          'assistant',
        );
      });
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
    // Send page context only with the first message (Section 3.2).
    if (!pageContextSent) {
      payload.page_context = contextualPage;
      payload.topicCategory = contextualPage.category || undefined;
      pageContextSent = true;
    }

    fetch(serverUrl + '/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        clearTyping();

        var replyNode = addMessage(data.assistant_message, 'assistant');
        renderAssistantExtras(data, replyNode);
        renderAppointmentSlots(data);

        // Push analytics event (no PII)
        if (data.analytics && data.analytics.event_name) {
          if (typeof window.dataLayer !== 'undefined') {
            window.dataLayer.push({
              event: data.analytics.event_name,
              conversation_stage: data.analytics.conversation_stage,
              fallback_type: data.analytics.fallback_type,
            });
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
