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
    '}',
    // Forced colours: a box-shadow band is not painted at all, so every ring
    // is restated as an outline in a system colour.
    '@media (forced-colors: active) {',
    '  #lpp-chat-input:focus, #lpp-chat-messages:focus,',
    '  .lpp-chat-send:focus-visible, .lpp-chat-close:focus-visible,',
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
  container.style.cssText = [
    'position:fixed',
    'bottom:0',
    'right:0',
    'z-index:9999',
    'width:min(360px, 100vw)',
    'max-height:calc(100vh - 16px)',
    'display:flex',
    'flex-direction:column',
    'overflow:hidden',
    'background:' + COLORS.bg,
    'border:2px solid ' + COLORS.border,
    'border-radius:8px 8px 0 0',
    'font-family:system-ui,-apple-system,sans-serif',
    'font-size:15px',
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
    'font-size:14px',
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
    'font-size:18px',
    'cursor:pointer',
    'padding:4px 8px',
    'min-width:24px',
    'min-height:24px',
  ].join(';');
  header.appendChild(closeButton);

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
    'display:none',
    'padding:10px 16px',
    'min-width:24px',
    'min-height:24px',
    'background:' + COLORS.button,
    'color:' + COLORS.white,
    'border:2px solid ' + COLORS.button,
    'border-bottom:none',
    'border-radius:8px 8px 0 0',
    'font-family:system-ui,-apple-system,sans-serif',
    'font-size:14px',
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
    'font-size:12px',
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
    'font-size:15px',
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
    'font-size:14px',
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

  container.appendChild(header);
  container.appendChild(banner);
  container.appendChild(messages);
  container.appendChild(inputWrapper);
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

  // ── State ──
  var sessionId = 'lpp_' + Date.now() + '_' + Math.random().toString(36).substr(2, 9);
  var currentState = 'disclosure';
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
    msg.style.cssText =
      'margin-bottom:12px;padding:8px 12px;border-radius:4px;' +
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
      currentState: currentState,
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

        addMessage(data.assistant_message, 'assistant');
        currentState = data.state || 'education';

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

  // Deliberately no autofocus: taking focus on load would pull a keyboard or
  // screen-reader visitor out of the article they were reading (WCAG 3.2.1,
  // 2.4.3). Focus enters the widget when the visitor opens or tabs to it.
  launcher.setAttribute('aria-expanded', 'true');
})();
