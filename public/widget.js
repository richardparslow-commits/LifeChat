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
 *   - Privacy banner before first message
 *   - Keyboard-navigable, ARIA-live announcements
 *   - WCAG 2.2 AA compliant (4.5:1 contrast, visible focus, reduced motion)
 *   - No PII in analytics events
 */
(function () {
  'use strict';

  var scriptTag = document.currentScript;
  var serverUrl = (scriptTag && scriptTag.getAttribute('data-server-url')) || '';

  // ── Color palette (Section 4.16, all contrast verified) ──
  var COLORS = {
    bg: '#E2E8F0',        // light slate background
    border: '#485B61',    // slate border (5.785:1 on bg — Pass AA)
    headline: '#CC0700',  // red headline (4.735:1 on bg — Pass AA)
    button: '#414C32',   // green button (white text 9.112:1 — Pass AAA)
    buttonHover: '#485B61', // slate hover (white text 7.132:1 — Pass AAA)
    text: '#1a1a1a',     // dark text for readability
    white: '#FFFFFF',
  };

  // ── Build the widget DOM ──
  var container = document.createElement('div');
  container.className = 'lpp-chat-widget';
  container.setAttribute('role', 'dialog');
  container.setAttribute('aria-label', 'Life Policy Pilot AI Educational Assistant');
  container.setAttribute('aria-live', 'polite');
  container.style.cssText = [
    'position:fixed', 'bottom:0', 'right:0', 'z-index:9999',
    'width:360px', 'max-width:90vw', 'max-height:600px',
    'display:flex', 'flex-direction:column',
    'background:' + COLORS.bg, 'border:2px solid ' + COLORS.border,
    'border-radius:8px 8px 0 0', 'font-family:system-ui,-apple-system,sans-serif',
    'font-size:15px', 'color:' + COLORS.text,
    'box-shadow:0 -4px 12px rgba(0,0,0,0.15)',
  ].join(';');

  // ── Header (always shows "AI assistant") ──
  var header = document.createElement('div');
  header.style.cssText = [
    'padding:12px 16px', 'background:' + COLORS.button,
    'color:' + COLORS.white, 'border-radius:6px 6px 0 0',
    'font-weight:600', 'font-size:14px',
    'display:flex', 'justify-content:space-between', 'align-items:center',
  ].join(';');
  header.textContent = 'Life Policy Pilot — AI Educational Assistant';

  var closeButton = document.createElement('button');
  closeButton.textContent = '✕';
  closeButton.setAttribute('aria-label', 'Close chat');
  closeButton.style.cssText = [
    'background:none', 'border:none', 'color:' + COLORS.white,
    'font-size:18px', 'cursor:pointer', 'padding:4px 8px',
    'min-width:24px', 'min-height:24px',
  ].join(';');
  closeButton.onclick = function () { container.style.display = 'none'; };

  header.appendChild(closeButton);

  // ── Privacy banner (before chat) ──
  var banner = document.createElement('div');
  banner.className = 'lpp-chat-banner';
  banner.style.cssText = [
    'padding:8px 16px', 'font-size:12px', 'line-height:1.4',
    'background:#fff3cd', 'border-bottom:1px solid ' + COLORS.border,
    'color:' + COLORS.text,
  ].join(';');
  banner.textContent = 'You are chatting with an AI educational assistant. Do not enter medical, financial-account, Social Security, or other highly sensitive information. Messages may be stored and reviewed to provide and improve the service.';

  // ── Messages container (aria-live="polite" for screen reader announcements) ──
  var messages = document.createElement('div');
  messages.className = 'lpp-chat-messages';
  messages.setAttribute('aria-live', 'polite');
  messages.setAttribute('role', 'log');
  messages.style.cssText = [
    'flex:1', 'overflow-y:auto', 'padding:16px',
    'min-height:200px', 'max-height:400px',
  ].join(';');

  // ── Input area ──
  var inputWrapper = document.createElement('div');
  inputWrapper.style.cssText = [
    'padding:8px 16px 12px', 'display:flex', 'gap:8px',
    'border-top:1px solid ' + COLORS.border,
  ].join(';');

  var input = document.createElement('input');
  input.type = 'text';
  input.placeholder = 'Ask about life insurance...';
  input.setAttribute('aria-label', 'Type your question');
  input.style.cssText = [
    'flex:1', 'padding:8px 12px', 'font-size:15px',
    'border:1px solid ' + COLORS.border, 'border-radius:4px',
    'min-height:24px', 'min-width:200px',
  ].join(';');

  var sendButton = document.createElement('button');
  sendButton.textContent = 'Send';
  sendButton.setAttribute('aria-label', 'Send message');
  sendButton.style.cssText = [
    'padding:8px 16px', 'background:' + COLORS.button, 'color:' + COLORS.white,
    'border:none', 'border-radius:4px', 'font-size:14px', 'font-weight:600',
    'cursor:pointer', 'min-width:24px', 'min-height:24px',
    'transition:background-color 0.2s ease',
  ].join(';');

  // Focus styles (3:1 contrast indicator)
  function addFocusStyle(el) {
    el.addEventListener('focus', function () {
      el.style.outline = '3px solid #000000';
      el.style.outlineOffset = '3px';
    });
    el.addEventListener('blur', function () {
      el.style.outline = '';
      el.style.outlineOffset = '';
    });
  }
  addFocusStyle(input);
  addFocusStyle(sendButton);
  addFocusStyle(closeButton);

  // Hover style (white on slate hover — Pass AAA)
  sendButton.addEventListener('mouseenter', function () {
    sendButton.style.background = COLORS.buttonHover;
    sendButton.style.transform = 'translateY(-2px)';
    sendButton.style.boxShadow = '0 4px 6px rgba(0,0,0,0.18)';
  });
  sendButton.addEventListener('mouseleave', function () {
    sendButton.style.background = COLORS.button;
    sendButton.style.transform = '';
    sendButton.style.boxShadow = '';
  });

  inputWrapper.appendChild(input);
  inputWrapper.appendChild(sendButton);

  container.appendChild(header);
  container.appendChild(banner);
  container.appendChild(messages);
  container.appendChild(inputWrapper);
  document.body.appendChild(container);

  // ── Reduced motion support (WCAG 2.2) ──
  var motionCSS = document.createElement('style');
  motionCSS.textContent = '@media (prefers-reduced-motion: reduce) {' +
    '.lpp-chat-widget * { animation-duration:0.01ms !important; ' +
    'transition-duration:0.01ms !important; } }';
  document.head.appendChild(motionCSS);

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
    var category = readMeta('meta[name="category"]') || readMeta('meta[property="article:section"]');
    var articleId = readMeta('meta[name="article_id"]') || readMeta('meta[property="article:tag"]');
    return {
      url: window.location.href,
      title: document.title || null,
      category: category || null,
      article_id: articleId || null
    };
  }

  // ── Helper: add a message to the chat ──
  function addMessage(text, sender) {
    var msg = document.createElement('div');
    msg.style.cssText = 'margin-bottom:12px;padding:8px 12px;border-radius:4px;' +
      (sender === 'assistant'
        ? 'background:#f0f0f0;'
        : 'background:' + COLORS.button + ';color:' + COLORS.white + ';margin-left:40px;');
    msg.textContent = text;
    messages.appendChild(msg);
    messages.scrollTop = messages.scrollHeight;
  }

  // ── Fetch the initial disclosure message ──
  function loadDisclosure() {
    // Ask the backend for a disclosure enriched with page context (optional),
    // so the opening message can reference the article being read when it maps
    // to a known topic (Section 16.3). Falls back to the standard message.
    var disclosurePath = serverUrl + '/api/disclosure';
    var ctx = contextualPage;
    var q = '?' + ['url=' + encodeURIComponent(ctx.url), 'title=' + encodeURIComponent(ctx.title || '')].join('&');
    fetch(disclosurePath + q)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        addMessage(data.firstMessage, 'assistant');
      })
      .catch(function () {
        addMessage('I\'m the Life Policy Pilot AI Educational Assistant. How can I help you learn about life insurance today?', 'assistant');
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
    var typingTimer = setTimeout(function () {
      addMessage('...', 'assistant');
    }, 500);

    var payload = {
      sessionId: sessionId,
      message: text,
      currentState: currentState,
      sourceUrl: sourceUrl
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
      .then(function (r) { return r.json(); })
      .then(function (data) {
        clearTimeout(typingTimer);
        // Remove typing indicator if present
        var lastMsg = messages.lastChild;
        if (lastMsg && lastMsg.textContent === '...') {
          messages.removeChild(lastMsg);
        }

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
        clearTimeout(typingTimer);
        var lastMsg = messages.lastChild;
        if (lastMsg && lastMsg.textContent === '...') {
          messages.removeChild(lastMsg);
        }
        addMessage('I\'m having trouble responding right now. Please try again in a moment, or contact Richard Parslow directly.', 'assistant');
      });
  }

  sendButton.addEventListener('click', sendMessage);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Auto-focus the input
  input.focus();
})();
