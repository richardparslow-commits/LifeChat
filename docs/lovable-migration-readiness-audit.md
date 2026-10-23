# Lovable Migration & Integration Readiness Audit — LifeChat → lifeinsurancebrokeradvocate.com

**Date:** 2026-10-21
**Target host:** `https://lifeinsurancebrokeradvocate.com/` (Lovable: React 18 + TypeScript + Vite + Tailwind + React Router SPA)
**Audited commit:** working tree at audit time (repository `richardparslow-commits/LifeChat`)

This audit covers the seven migration pillars against the live host, not a hypothetical one. Every claim below was checked one of three ways: (1) reading the shipped file and citing the line, (2) executing the shipped file under the repository's DOM shim, or (3) probing the live host on 2026-10-21 (HTTP status, sitemap, DNS, JS bundle).

## 1. Go / No-Go scorecard

| # | Pillar | Verdict | Why |
|---|--------|---------|-----|
| 1 | API base URL, CORS, CSP, security headers | **NEEDS CONFIG** | Widget now takes an absolute `data-api-base` / `window.LPP_CHAT_CONFIG.apiBase` and refuses relative bases (`public/widget.js:78`), and the API echoes CORS only to allowlisted origins (`src/config/app-config.ts:265`). Deployment must still set `ALLOWED_ORIGINS` to the apex **and** `www`; the host page's own CSP (if one is added later) must allow `connect-src` to the API origin. |
| 2 | Domain canonicalization | **READY (code)** | All 19 RAG citation URLs, 2 card links and 2 fallback links now derive from `WEBSITE_URL`; every replacement path was verified `200` on the live site. The rights mailbox is permanent and its domain publishes MX; `npm run rights:channel` keeps that true at release time. Branding is standardized on **LifeChat by Life Insurance Broker Advocate**. See §7. |
| 3 | React/Vite SPA lifecycle | **READY** | Route changes (`pushState`/`replaceState`/`popstate`/`hashchange`) refresh page context (`public/widget.js:676`); mount is idempotent and `destroy()` removes every node and listener (`public/widget.js:1670`, `:1679`). Covered by 23 new tests. |
| 4 | CSS isolation, Tailwind preflight, stacking | **READY (with caveat)** | Widget CSS is scoped to `.lpp-chat-widget`; list markers stripped by preflight are restored (`public/widget.js:177`). `z-index`/`bottom` are embed-configurable. Caveat: the shim does not paint, so the visual result still needs one real-browser pass. |
| 5 | Durable persistence / serverless | **BLOCKER for serverless hosting** | `/api/consent` and `/api/dsr` return `503` whenever `config.serverless` is true (`src/app.ts:1068`, `:1273`), which is automatic on Vercel (`src/config/app-config.ts:181`). Sessions and booked appointments are in-process LRUs (`src/llm/session-store.ts:91`, `src/scheduling/appointment-slots.ts:148-150`), so a multi-instance or cold-start host loses conversation state and double-books a slot that was already taken. |
| 6 | Env vars / secret boundary | **READY (code) / NEEDS CONFIG (proxy)** | No `VITE_`-prefixed variable exists anywhere in the repository, so nothing invites a backend key into the bundle. `TRUST_PROXY` is explicit and off by default (`src/app.ts:167`), but must be set on the API host or every visitor shares the proxy's IP and one rate-limit bucket. |
| 7 | Analytics / GTM `dataLayer` | **READY (code) / NEEDS CONFIG (GTM)** | Reply events push only allowlisted fields; the array is created if GTM has not loaded; a throwing host `dataLayer` cannot break a reply (`public/widget.js:1634`). GTM still needs triggers for the event names. The live site runs Consent Mode with `analytics_storage: 'denied'` by default, so queued events are not sent until consent is granted — correct behaviour, but it means "no data in GA4" is not a widget bug. |

**Overall: NO-GO if the API is deployed to Vercel/Netlify/serverless functions. GO if it is deployed to an always-on Node host with a persistent volume, with the environment in §8 set and the two notes in §7 closed.**

---

## 2. Evidence collected

| Check | Result |
|-------|--------|
| Live site framework | `/assets/index-BdD1N6T4.js` (Vite hash), `useLayoutEffect` present → React SPA |
| Tailwind | Utility classes in the served HTML (`min-h-screen flex flex-col bg-background`, `sticky top-0 z-40`) |
| Header stacking | `<header class="... sticky top-0 z-40">` on `/` |
| Existing fixed chat launcher / cookie banner | None found in the served HTML or bundle (`fixed bottom-0`, `z-50`, `bottom-4 right-4` = 0 matches). No collision today; a future consent layer is the risk the new `data-z-index` covers. |
| Analytics | `window.dataLayer=window.dataLayer||[]` plus `gtag('consent','default',{analytics_storage:'denied', ad_storage:'denied', …, wait_for_update:500})` |
| Site routes | `/`, `/about`, `/contact`, `/privacy`, `/tools`, `/tools/health-class-predictor`, `/tools/term-ladder`, `/tools/product-navigator`, `/ibc-lab`, `/guides/texas-life-insurance`, `/guides/texas-underwriting`, 60+ `/blog/*` — sampled set all returned `200` |
| Sitemap | `https://lifeinsurancebrokeradvocate.com/sitemap.xml`, 79 URLs, no `lifepolicypilot.blog` entries |
| DNS MX | `lifeinsurancebrokeradvocate.com` has **no MX records**; `lifepolicypilot.blog` still points at `smtp.google.com` |
| Legacy domain | `lifepolicypilot.blog` still resolves and serves the old WordPress site; it is not a redirect to the new domain |

---

## 3. Pillar 1 — API base URL, CORS, CSP

### 3.1 The relative-path trap (fixed)

Before, the widget only read one attribute and defaulted to an empty string:

```js
// BEFORE — public/widget.js
var scriptTag = document.currentScript;
var serverUrl = (scriptTag && scriptTag.getAttribute('data-server-url')) || '';
…
fetch(serverUrl + '/api/disclosure?…')
fetch(serverUrl + '/api/chat', …)
fetch(serverUrl + '/api/scheduling/slots', …)
```

With no attribute, `serverUrl` is `''` and every request becomes `/api/…` **relative to the host page**. On the Lovable static host that is not the Express app: it is the SPA's history fallback, which returns `index.html` with `200`. `r.json()` then throws and the visitor sees the generic "I'm having trouble responding" with no diagnostic. All four call sites were affected: `/api/disclosure` (`public/widget.js:1529`), `/api/chat` (`:1590`), `/api/scheduling/slots` (`:1482`), `/api/scheduling/select` (`:1397`).

The widget calls exactly those four endpoints. It does **not** call `/api/consent` or `/api/dsr`: there is no lead form and no DSR form in the widget, so those are API-only endpoints today. If the Lovable site adds a lead form or a rights-request form, those requests need the same absolute `apiBase` and run into the storage gate in §7.

After:

```js
// AFTER — public/widget.js:78
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
  if (tag && typeof tag.src === 'string' && tag.src) {
    var origin = /^(https?:\/\/[^\/]+)/i.exec(String(tag.src));
    return origin ? absoluteBase(origin[1]) : '';
  }
  return '';
}
```

Precedence: `window.LPP_CHAT_CONFIG.apiBase` → `data-api-base` → `data-server-url` (legacy name kept) → the script's own **origin**. A relative value such as `"/api"` is rejected rather than used, so a copy-paste mistake cannot silently point at the host page. Tests: `tests/widget-lovable-embed.test.ts` ("widget API base").

### 3.2 CORS and preflight

`src/app.ts:205-239` already had the right shape: deny by default, echo the exact allowed origin, `Vary: Origin`, answer every `OPTIONS` with `204` before route logic, no wildcard `*`, no credentials. Two gaps:

1. Exact-match only. Lovable previews are `https://<id>.lovable.app` and `https://<id>.lovableproject.com`, so every preview origin had to be added by hand.
2. Nothing in the repository named the production origins — the default was empty, and `.env.example` still suggested the old blog.

After: `ALLOWED_ORIGINS` accepts exact origins **and** a narrow subdomain wildcard (`src/config/app-config.ts:243`). The wildcard is `http(s)://*.suffix` only, requires at least one subdomain label, rejects ports, paths, `*` anywhere except the leading label, and does **not** match the bare vendor domain. `*.lovable.app` therefore admits previews but not `https://lovable.app`; it does admit every other Lovable project, so exact origins are preferred in production.

```bash
# API host environment
ALLOWED_ORIGINS="https://lifeinsurancebrokeradvocate.com,https://www.lifeinsurancebrokeradvocate.com"
# Optional, preview only:
# ALLOWED_ORIGINS="…,https://*.lovable.app"
```

Tests: `tests/publication-domain.test.ts` ("cross-origin allowlist"), `tests/server-hardening.test.ts` ("cross-origin embed").

### 3.3 CSP and headers

- The API sets `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`, and `Cache-Control: no-store` on `/api` (`src/app.ts:192-201`). Those are correct for JSON.
- `vercel.json:15-19` sets `X-Frame-Options: DENY` on every path, including `/widget.js`. A `<script src>` is not a frame, so this does not block the recommended embed. It **would** block an `<iframe>` embed, which is one more reason the script embed is the right pattern.
- The API serves no HTML, so it does not need a CSP. The widget does not inject a `<script>` or `<style>` URL; it appends one inline `<style>` node and DOM nodes, so a host CSP needs `connect-src https://<api-host>` and `style-src 'unsafe-inline'` (already required by Tailwind's runtime style injection on many Lovable builds). If the site later adopts a CSP, add the API origin to `connect-src`; no `frame-src` is needed.

---

## 4. Pillar 2 — Domain canonicalization

### 4.1 What was hardcoded

| File | Before | Now |
|------|--------|-----|
| `src/config/app-config.ts:156` | `websiteUrl: 'https://lifepolicypilot.blog/'` | `'https://lifeinsurancebrokeradvocate.com/'` |
| `src/config/app-config.ts:157` | `privacyNoticeUrl: '…/privacy/'` | `'https://lifeinsurancebrokeradvocate.com/privacy'` |
| `src/config/app-config.ts:159` | `contactUrl: '…/contact/'` | `'https://lifeinsurancebrokeradvocate.com/contact'` |
| `src/rag/retrieval.ts` (19 `canonical_url`) | literal legacy URLs | `publicationUrl('<new path>')` (`:224` helper) |
| `src/cards/card-library.ts:390,405` | legacy article URLs | `publicationUrl('blog/texas-life-insurance-tdi-rules-taxes-claims')`, `publicationUrl('tools')` |
| `src/resilience/fallback-behavior.ts:142,147` | legacy home/contact | `publicationUrl('/')`, `publicationUrl('contact')` |

Nineteen corpus documents is a lot of hardcoded URLs to move by hand, so the fix is structural rather than textual: `publicationUrl()` joins `WEBSITE_URL` with a site-relative path. The next domain move is one environment variable, and a test (`tests/publication-domain.test.ts`, "leaves no legacy page URLs in the source it rewrote") fails if a literal `lifepolicypilot.blog/` URL is reintroduced.

### 4.2 Citation validation

Citations are not taken from the model. After schema validation the orchestrator **overwrites** them with the retrieved passages (`src/llm/orchestrator.ts:326`), so there is no model-supplied URL that a domain allowlist would need to filter. The integrity requirement is therefore that every `canonical_url` resolves — which is why each new path was checked with a live `200` rather than guessed.

Two corpus documents had no 1:1 article on the new site. They now point at the closest live page and need an editorial sign-off:

| Corpus id | Legacy path | New path | Note |
|-----------|-------------|----------|------|
| `add-overview` | `/accidental-death-and-dismemberment/` | `/blog/life-insurance-riders-texas` | AD&D is covered as a rider; acceptable but not exact |
| `child-life-overview` | `/child-life-insurance/` | `/blog/life-insurance-what-texas-families-need-to-know` | closest live page; no child-life article exists |
| `pandemic-quarantine-overview` | `/pandemic-quarantine/` | `/blog/life-insurance-past-medical-conditions` | topic adjacent, not identical |
| `insurable-interest-overview` | `/insurable-interest/` | `/blog/life-insurance-beneficiary-rules-texas` | insurable interest is discussed in beneficiary context |
| `occupation-hobby-risk-overview` | `/occupation-hobby-risk/` | `/blog/how-life-insurance-underwriting-works-texas` | underwriting article covers the concept |
| `policy-lapse-and-reinstatement` | `/policy-lapse-reinstatement/` | `/blog/contestability-period-life-insurance-texas` | weakest match; consider commissioning a lapse/reinstatement article |

**Editorial sign-off (2026-10-23).** All six mappings are now recorded in `src/rag/citation-mappings.ts` with the live article's own H1, the retired path, whether the page is `exact` or `nearest`, what it does and does not cover, and the reviewer/date. Each corpus document carries that H1 as `citation_title`, so the citation label names the page the reader actually lands on; `tests/citation-mappings.test.ts` fails if a mapping, URL, title or sign-off drifts from the corpus. The lapse/reinstatement article is still the one worth commissioning — the mapping records that rather than hiding it.

### 4.3 Page context and topic mapping

The bridge matches a regex against the **full URL**, so the new `/blog/…-texas` slugs did not match the old patterns. Added at the top of `src/contextual/article-map.ts` (first match wins):

- `/tools/health-class-predictor`, `/ibc-lab|infinite-banking`, `/tools/term-ladder|term-life-laddering`, `/tools/product-navigator` — one prompt per calculator, before the generic tools entry
- `/tools` — calculator hub
- `/author/…` and `/about` — broker page
- `how-much-does-life-insurance-cost` — maps to the `factors-affecting-cost` corpus doc
- `beneficiary` — catches `/blog/life-insurance-beneficiary-rules-texas`

Existing patterns (`term-vs-whole-life`, `life-insurance-riders`, `underwriting`, `final-expense|burial-insurance`, `life-insurance-for-seniors|senior-citizens`) already match the new slugs and were left alone. The five calculator entries are new behaviour and have no corpus doc, so they enrich the greeting but do not retrieve new evidence (`articleId` values that do not exist in the corpus are tolerated by design — `src/contextual/article-map.ts:11-13`).

---

## 5. Pillar 3 — React/Vite SPA lifecycle

### 5.1 SPA navigation blindness (fixed)

Before, `sourceUrl` was read once at script load (`public/widget.js:577` pre-patch) and `page_context` was sent only with the first message. On a React Router site, opening `/tools/term-ladder` after the script loaded still told the API the visitor was on `/`, and a second article got no context at all.

After (`public/widget.js:676-731`):

```js
function syncRoute() {
  if (!window.location || window.location.pathname === sourceUrl) return;
  sourceUrl = window.location.pathname;
  contextualPage = buildPageContext();
}

function wrapHistory(method) {
  var target = window.history;
  var original = target && target[method];
  if (typeof original !== 'function') return;
  target[method] = function () {
    var result = original.apply(this, arguments);
    syncRoute();
    return result;
  };
}

wrapHistory('pushState');
wrapHistory('replaceState');
window.addEventListener('popstate', syncRoute);
window.addEventListener('hashchange', syncRoute);
```

Sending is deliberately not spammed: page context goes with the first message and again **only** when the path changed since the last send (`public/widget.js:1583`). The greeting still runs once; a route change does not re-fetch `/api/disclosure` (test: "does not repeat the greeting or the disclosure request on navigation").

### 5.2 StrictMode and remounts (fixed)

Before, the only guard was `if (document.getElementById('lpp-chat-widget')) return;`. It prevented a duplicate dialog but left nothing to call on unmount and no way to re-attach after React removed the node.

After, the IIFE exposes a handle before anything else:

```js
var GLOBAL_KEY = '__lppChatWidget';
if (window[GLOBAL_KEY]) {
  window[GLOBAL_KEY].mount();
  return;
}
…
window[GLOBAL_KEY] = {
  mount: mount,      // idempotent: re-appends the existing dialog + stylesheet
  destroy: destroy,  // removes dialog, launcher and stylesheet, and the focusin listener
  open: function () { openWidget(true); },
  close: closeWidget,
};
```

`destroy()` removes the document `focusin` listener by reference (it used to be an anonymous function), restores the page's original `history.pushState`/`replaceState`, removes the `popstate`/`hashchange` listeners, removes all three nodes, and flips `mounted` false; `mount()` re-appends the same nodes and re-attaches the route observers. A test asserts the history methods are handed back (`tests/widget-lovable-embed.test.ts`, "hands the page history back on destroy"). Conversation state, including the session id, survives the cycle on purpose — closing and reopening must not mint a new session. Tests: "widget React mount lifecycle" in `tests/widget-lovable-embed.test.ts`.

What this still is not: a React component. A wrapper must call `destroy()` on unmount only if it truly wants the widget gone; in StrictMode's mount → unmount → mount cycle the net result is one mounted dialog either way.

---

## 6. Pillar 4 — CSS isolation, Tailwind preflight, stacking

### 6.1 Preflight collisions

Lovable ships Tailwind's preflight, which sets, among other things:

```css
*, ::before, ::after { box-sizing: border-box; border-width: 0; border-style: solid; }
ol, ul, menu { list-style: none; margin: 0; padding: 0; }
```

The widget already sets `box-sizing: border-box` itself and renders every border inline, so borders and geometry survive. The real casualty is **list markers**: citations, card bullets, and numbered process steps are rendered as `<ul>/<ol>` and lose their markers under preflight. Because the widget's CSS is injected into `document.head` (not a shadow root), a scoped restore is both possible and necessary:

```css
/* AFTER — public/widget.js:177-180 */
.lpp-chat-widget ul { list-style-type: disc; list-style-position: outside; }
.lpp-chat-widget ol { list-style-type: decimal; list-style-position: outside; }
.lpp-chat-widget .lpp-slots-list { list-style: none; } /* radiogroup, not a list */
```

Note the third rule: the appointment picker is a radiogroup and must stay marker-free. Shadow DOM was considered and rejected for now: it would isolate styles more completely, but it also breaks `document.getElementById` lookups used by the existing tests and by the host integrations, and it would need the focus-restoration code rewritten to cross the shadow boundary. The scoped-reset approach is smaller and reversible.

### 6.2 Stacking and viewport

Before, both the panel and the launcher were fixed at `bottom:0; right:0; z-index:9999` (`public/widget.js:365`, `:464`). That covers a host modal at `z-50` and, on mobile, can sit on top of a consent banner's buttons (WCAG 2.4.11 *Focus Not Obscured*).

After: `data-z-index` / `data-bottom-offset`, or `window.LPP_CHAT_CONFIG.zIndex` / `.bottomOffset`, with today's values as defaults (`public/widget.js:142`). The live site currently has no fixed launcher or cookie banner (bundle inspection, §2), so the default is safe today; the attributes exist for the layer that gets added later.

The panel remains `width:min(360px, 100vw)` and `max-height:calc(100vh - 16px)` with `min-height:0` on the flex children, so it does not push the header off a short viewport. That is unchanged and still covered by the accessibility suite.

---

## 7. Pillar 5 — Durable persistence and serverless hosting

This is the migration's only hard blocker.

### 7.1 Fail-closed gates

```ts
// src/app.ts:1068 — POST /api/consent
if (config.serverless) {
  return res.status(503).json({ error: 'Storage unavailable', message: 'Consent records cannot be stored on this runtime…' });
}

// src/app.ts:1273 — POST /api/dsr
if (config.serverless) {
  return res.status(503).json({ error: 'Storage unavailable', message: `Data subject requests cannot be stored on this runtime…` });
}
```

`config.serverless` is auto-true on Vercel (`src/config/app-config.ts`: `process.env.SERVERLESS === 'true' || process.env.VERCEL === '1'`). Deploying the API to Vercel therefore disables **lead consent capture, consent proof, and DSR intake** by design: a TDPSA request carries a 45-day deadline and a consent hash is the legal proof of consent, so accepting either into `/tmp` would be worse than refusing. The old `DURABLE_STORAGE_CONFIGURED=true` escape hatch has been removed (SEC-11): durability is now established by a boot probe that writes, reads back, and deletes in each record directory, and refuses any directory under `/tmp`, the OS temp dir, or `/var/task`. Mount a durable volume or configure Archil; a flag alone no longer unlocks the write path.

### 7.2 Session state

`src/llm/session-store.ts:91` keeps sessions in a `BoundedLruCache` (5,000 entries). On a cold start or a second replica, the visitor's next message arrives for a session id the process has never seen: state-machine progress, medical consent flags and history are gone. The widget keeps its session id, so it will not error — it will just silently restart the conversation at the education state. This is a correctness bug on any horizontally scaled or serverless host, independent of the file-backed records.

Appointments have the same shape and a worse failure mode: `src/scheduling/appointment-slots.ts:148-150` keeps bookings in three LRU maps, `POST /api/scheduling/select` records only the choice in the session LRU, and the booking itself is created by the verified-action path (`src/tools/verified-actions.ts:285`) into those same maps. After a restart the slot shows as available again, so two visitors can be told they booked the same time. A durable appointments table (or at minimum a JSONL record on the volume) is required before the widget is promoted on the live site. **Addressed by SEC-14:** bookings are now held by one durable claim file per slot under `BOOKING_LEDGER_PATH` (exclusive create), reloaded on restart, and refused when the ledger cannot be durable; a real calendar API remains the long-term replacement.

### 7.3 What "ready" requires

Option 1 (recommended now): **one always-on Node process with a persistent volume.** Railway, Render, Fly.io, a small VM, or Azure Container Apps with a mounted volume. `DSR_LOG_PATH` and `LEAD_LOG_PATH` live on that volume; `PILOT_MODE=false` requires `RECORD_ENCRYPTION_KEY`; one replica only, so the LRU session cache is coherent. This preserves the existing compliance design with no code change beyond configuration.

Option 2 (the durable migration, not in this patch): move DSR records, lead/consent records and sessions to PostgreSQL (Lovable/Supabase is a reasonable home), keep AES-256-GCM envelope encryption per record, add RLS scoped by an application role (never by browser-supplied ids), and replace the LRU with a `sessions` table plus a short TTL. The storage interfaces are already behind `src/persistence/jsonl-log.ts` and `src/llm/session-store.ts`, so the blast radius is those two modules plus the DSR/consent writers. This is the correct long-term shape, but it is a schema + migration + key-management project, not an embed fix.

Do **not** put a Supabase Edge Function in front of a Vercel deployment and call the blocker solved: the proxy cannot make the downstream storage durable, and it adds a second origin, body-size limits and a new timeout.

---

## 8. Pillar 6 — Environment variables and secret boundary

- No `VITE_`-prefixed variable exists anywhere in the repository (verified with a full-tree grep). The Lovable frontend therefore has nothing to import, and nothing in the docs suggests one. The widget needs **one** public value, the API origin, which is not a secret.
- Keys stay server-side: `LLM_API_KEY`, `RECORD_ENCRYPTION_KEY`, `ADMIN_API_KEY` are read only in `src/config/app-config.ts` and never serialized. `/health` returns booleans only and `/api/system-prompt` is admin-gated.
- `TRUST_PROXY` defaults to empty, i.e. trust no proxy (`src/app.ts:167`). Behind Cloudflare/Render/Railway the socket peer is the proxy: without `TRUST_PROXY=1` (or the platform's documented hop count) `req.ip` is the proxy address, so `checkWriteRateLimit(req.ip)` buckets **all visitors together** and the first busy minute returns `429` to everyone. Set it on the API host only, never trust a value you cannot verify. The parser already fails closed on an unparseable value and warns.
- Do not expose the API host as a Lovable environment variable with a `VITE_` prefix. If the frontend needs the origin at build time, use a public constant in the component, not a secret.

---

## 9. Pillar 7 — Analytics and GTM

The reply path pushes three allowlisted fields (`public/widget.js:1634`):

```js
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
  } catch (analyticsError) { /* analytics is not part of the answer */ }
}
```

Before, the push was guarded by `typeof window.dataLayer !== 'undefined'`, which is true on the live site (GTM's snippet runs in `<head>`), so this changes little in production — but it makes the widget correct on a page where GTM is still loading or blocked, and it makes a hostile consent shim unable to break a reply. Tests cover both.

Interaction with the live consent setup: the site sets `gtag('consent','default',{analytics_storage:'denied', ad_storage:'denied', …, wait_for_update:500})`. GTM will queue the widget's events and only send them after `analytics_storage` is granted. That is the intended behaviour of Consent Mode, not a defect. Two host-side follow-ups:

1. Register GTM triggers for the event names the API emits (`chat_reply` is the one in the tests; check `/api/analytics/example` and the orchestrator for the full set) and map them to GA4 events if reporting is wanted.
2. The widget sends no message text, email, phone or session id. Do not add any in the GTM tag; the dataLayer is visible to every tag on the page.

There is a second analytics feed server-side (`ABSTENTION_LOG_PATH`, hashed non-PII) that is unaffected by the host migration, except that it is another file path that must live on the persistent volume.

---

## 10. File-by-file blocker matrix

| File | Line(s) | Assumption / defect | Effect on `lifeinsurancebrokeradvocate.com` | Status |
|------|---------|--------------------|--------------------------------------------|--------|
| `public/widget.js` | 74-99 | API base was optional and could be `''` | `/api/*` resolves to the SPA host → HTML → "having trouble responding" | Fixed |
| `public/widget.js` | 361, 460 | `z-index:9999`, `bottom:0` | Covers host modals/consent layers; mobile overlap | Fixed (configurable) |
| `public/widget.js` | 174-177 | No list-style reset | Citation/step markers erased by Tailwind preflight | Fixed |
| `public/widget.js` | 47-50, 1644-1668 | Install guard only; no destroy | StrictMode/unmount leaves nodes and a document listener behind | Fixed |
| `public/widget.js` | 673-694 | `sourceUrl` read once at load | Wrong page context after any client-side navigation | Fixed |
| `public/widget.js` | 1552 | `page_context` sent only once | Second article never explained to the API | Fixed |
| `public/widget.js` | 1502, 1564 | `.json()` without a status check | 429/403/HTML error pages render as `undefined` | Fixed |
| `public/widget.js` | 1608-1624 | `dataLayer` push could throw | A consent shim could break the reply | Fixed |
| `public/widget.js` | 47 | Global is `__lppChatWidget` | Document it for the React wrapper; no collision found | New API |
| `src/config/app-config.ts` | 156-159 | Legacy URLs | Privacy/contact links pointed at the old blog | Fixed |
| `src/config/app-config.ts` | 166 | DSR email is `@lifepolicypilot.blog` | Permanent rights mailbox; its domain publishes MX, so TDPSA requests are deliverable | Closed — `npm run rights:channel` guards it |
| `src/config/app-config.ts` | 243-271 | CORS exact-match only | Every preview URL needed a manual entry | Fixed (wildcard) |
| `src/rag/retrieval.ts` | 19 sites | Legacy `canonical_url` strings | Citations linked to the old blog | Fixed |
| `src/cards/card-library.ts` | 390, 405 | Legacy card links | Same | Fixed |
| `src/resilience/fallback-behavior.ts` | 142, 147 | Legacy fallback links | Same | Fixed |
| `src/contextual/article-map.ts` | 33-89 | No `/tools`, `/author`, `/about`, cost or beneficiary-blog patterns | Generic greeting on the five calculators and key articles | Fixed |
| `src/app.ts` | 1068-1078 | `config.serverless` → 503 | Consent capture dead on Vercel | **Blocker for serverless** |
| `src/app.ts` | 1273-1282 | `config.serverless` → 503 | DSR intake dead on Vercel | **Blocker for serverless** |
| `src/llm/session-store.ts` | 91 | In-process LRU | State lost across cold starts/replicas | **Blocker for multi-instance** |
| `src/scheduling/appointment-slots.ts` | 148-150 | Booked appointments in three in-process LRU maps | Slot is re-offered after a restart → double booking | **Blocker for serverless / multi-instance** |
| `src/app.ts` | 167-181 | `TRUST_PROXY` empty by default | All visitors share one rate-limit bucket behind a proxy | Needs config |
| `vercel.json` | 15-19 | `X-Frame-Options: DENY` | Blocks iframe embedding (not script embedding) | Constraint |
| `.env.example` | 16, 53-62 | Old domain; empty allowlist | A deploy copying the template gets no CORS grant | Fixed in template |

---

## 11. Architecture recommendation

**Recommendation: Option A — keep the Express API on an always-on Node host, embed `public/widget.js` from that host, and wrap the script in a tiny React component inside Lovable (Option B-lite). Do not port the backend to a Lovable Edge Function.**

| Criterion | A. Script embed + external Node API | B. Native React rewrite | C. Lovable Edge Function proxy in front of A |
|-----------|-------------------------------------|--------------------------|-----------------------------------------------|
| Works with the existing compliance code | Yes, unchanged | Only by re-implementing the whole chat UI and its accessibility contract | Yes, but the proxy adds a hop and cannot fix storage |
| Cross-origin | Solved by CORS + `data-api-base` | Same | Proxy could make it same-origin, at the cost of a new failure domain |
| Session consistency | Single always-on instance → coherent LRU | Same | Serverless downstream → still loses sessions |
| Lead/DSR persistence | Persistent volume → works today | Same | Serverless downstream → 503, or a second database project |
| CSS isolation | Scoped CSS + resets (verified) | Native Tailwind, but the entire widget would be rebuilt | Same as A |
| Upgrade path | Replace the script with a component later | — | — |
| Time to ship | Hours | Weeks | Days, and it does not remove the hard blocker |

Why not C: the Express app uses `fs` streams, `crypto` AES-256-GCM, sync startup gates and in-process session state. A Workers/Edge runtime cannot execute it; a proxy would have to forward to a Node host anyway, so it solves only the cosmetic problem of hiding the API origin while adding latency, a body-size ceiling and a second thing that can time out mid-message. Lovable Cloud's edge functions are useful for authenticated, small, stateless calls; this API is the opposite.

Why B-lite rather than "native React component": the widget is a 1,650-line ES5 file with an accessibility contract and a Section 508 review, and it is the only thing that has been executed against the host DOM in tests. Rewriting it in React would re-open every one of those findings. A ~40-line wrapper that injects the script once and calls `window.__lppChatWidget.destroy()` on unmount gets StrictMode correctness without a rewrite.

---

## 12. Drop-in patches applied

All patches below are in the working tree; the test suite that proves them is listed in §13.

### 12.1 Configured API base

```html
<!-- BEFORE -->
<script src="https://chat.example.com/widget.js"></script>
<!-- serverUrl = '' → fetch('/api/chat') against the Lovable host -->

<!-- AFTER -->
<script
  src="https://chat.example.com/widget.js"
  data-api-base="https://chat.example.com"
></script>
```

or, before the script tag:

```html
<script>
  window.LPP_CHAT_CONFIG = {
    apiBase: 'https://chat.example.com',
    zIndex: 40,        // optional: sit below a host modal/consent layer
    bottomOffset: 72,  // optional: clear a host launcher
  };
</script>
<script src="https://chat.example.com/widget.js"></script>
```

### 12.2 CORS allowlist

```bash
# BEFORE
ALLOWED_ORIGINS=""   # nothing cross-origin; widget fails silently in the browser

# AFTER — API host
ALLOWED_ORIGINS="https://lifeinsurancebrokeradvocate.com,https://www.lifeinsurancebrokeradvocate.com"
# optional for previews only:
# ALLOWED_ORIGINS="…,https://*.lovable.app"
```

### 12.3 SPA route-change listener

Already shown in §5.1; the shipped code wraps `history.pushState`/`replaceState`, listens for `popstate`/`hashchange`, and re-sends `page_context` only when the path changed.

### 12.4 Idempotent mount and teardown

Already shown in §5.2; `window.__lppChatWidget.mount()` / `.destroy()`.

### 12.5 Domain updates

Already shown in §4.1; all user-visible links now derive from `WEBSITE_URL`.

### 12.6 Chat error handling

```js
// AFTER — public/widget.js:1590-1632 (abridged)
.then(function (r) {
  var code = typeof r.status === 'number' ? r.status : 200;
  return r.json().then(
    function (body) { return { status: code, body: body }; },
    function () { return { status: code, body: null }; },
  );
})
.then(function (result) {
  clearTyping();
  var data = result.body && typeof result.body === 'object' ? result.body : {};
  if (result.status < 200 || result.status >= 300 || typeof data.assistant_message !== 'string') {
    var reason = result.status === 429
      ? 'You are sending messages a little quickly. Please wait a moment and try again.'
      : result.status === 403
        ? 'This page is not allowed to use the assistant. Please contact Richard Parslow directly.'
        : (typeof data.message === 'string' && data.message) ||
          "I'm having trouble responding right now. Please try again in a moment, or contact Richard Parslow directly.";
    addMessage(reason, 'assistant', { alert: true });
    return;
  }
  …
});
```

### 12.7 React wrapper (for the Lovable side)

```tsx
// src/components/LifeChatWidget.tsx
import { useEffect } from 'react';

const API_BASE = 'https://YOUR-API-HOST';
const SCRIPT_ID = 'lifechat-widget-script';

export function LifeChatWidget() {
  useEffect(() => {
    window.LPP_CHAT_CONFIG = { apiBase: API_BASE, zIndex: 40, bottomOffset: 72 };

    let script = document.getElementById(SCRIPT_ID) as HTMLScriptElement | null;
    if (!script) {
      script = document.createElement('script');
      script.id = SCRIPT_ID;
      script.src = `${API_BASE}/widget.js`;
      script.async = true;
      script.setAttribute('data-api-base', API_BASE);
      document.body.appendChild(script);
    } else {
      (window as any).__lppChatWidget?.mount();
    }

    return () => {
      // Optional: keep the widget alive across route changes by returning
      // without destroying. Destroy only when the component truly unmounts.
      // (window as any).__lppChatWidget?.destroy();
    };
  }, []);

  return null;
}
```

Mount it **once** in the root layout, outside `<Routes>`, so navigation does not unmount it. If it is mounted per-route, call `mount()` on mount and `destroy()` on unmount; the guard makes both safe.

---

## 13. Verification performed

| Command | Result |
|---------|--------|
| `npx tsc --noEmit -p tsconfig.json` | clean |
| `npx jest tests/widget-lovable-embed.test.ts` | 24 passed |
| `npx jest tests/widget-accessibility.test.ts tests/widget-scheduling.test.ts tests/widget-scheduling-e2e.test.ts` | 91 passed (115 with the new suite) |
| `npx jest tests/publication-domain.test.ts` | 11 passed |
| `npx jest tests/contextual-bridge.test.ts tests/server-hardening.test.ts tests/api-endpoints.test.ts tests/schema-validation.test.ts` | 342 passed after assertion updates |
| `npx jest` (full suite) | 54 suites / 2,970 tests passed |

Not verified here, and still required before launch:

1. **Real browser with the real site.** The DOM shim does not paint. Open `/`, `/tools/term-ladder`, `/ibc-lab`, an article, and a 320px viewport; confirm the launcher does not cover the sticky header, the cookie area, or calculator controls, and that citation bullets render.
2. **Screen reader pass** for the embedded widget on Safari/VoiceOver and Chrome/NVDA, recorded in `docs/accessibility-matrix-receipt.json` per the existing process. A script-injected dialog on a React host is a new browser/AT pairing.
3. **CORS on the real origins**, including `https://www.…` and one preview URL: preflight `204` with `access-control-allow-origin` echoing the exact origin, and a real `POST /api/chat`.
4. **Rate limiting behind the chosen proxy** with `TRUST_PROXY` set: two different client IPs must get separate buckets.
5. **A full consent → lead → DSR flow** against the persistent volume, proving records survive a restart.
6. **GTM preview** showing `chat_reply` only after `analytics_storage` is granted.

---

## 14. Open items the code cannot close

| # | Item | Owner | Why it blocks or matters |
|---|------|-------|--------------------------|
| 1 | **Rights channel — closed.** `DSR_CONTACT_EMAIL` is the permanent published address, `richardparslow@lifepolicypilot.blog`, and its domain publishes MX (`smtp.google.com`). The mailbox is not scheduled to move. | Richard / ops | TDPSA requires a working rights channel, so the gate is the mail route rather than the domain name: `npm run rights:channel` fails a release whose configured address has no route (exit 1) or is unverifiable (exit 2). |
| 2 | **Brand mismatch — closed in code.** The assistant is **LifeChat**, the provider is **Life Insurance Broker Advocate**, and the display form is **LifeChat by Life Insurance Broker Advocate** (`src/config/branding.ts`). The disclosure, system prompt, widget, persona document and privacy notice all use those names; the retired brand (Life Policy Pilot) survives only in this audit as the record of the change. | Richard / compliance | The two consent checkbox texts were renamed with their versions bumped to 1.1.0, so old consent artefacts keep 1.0.0. The 1.1.0 copy is signed off by the principal owner and licensed broker (Richard Parslow, 2026-10-23). |
| 3 | **Texas license number.** `TEXAS_LICENSE_NUMBER` still gates the disclosure line. | Richard | Production startup refuses the pending sentinel. |
| 4 | **Durable database.** Sessions and JSONL records are process/volume-bound. | Engineering | Required before any multi-replica or serverless deployment; see §7.3. |
| 5 | **Hosting choice.** Vercel is not viable for this API (503 + sessions). Railway/Render/Fly/VM with a volume is. | Ops | Determines where the widget's `apiBase` points. |
| 6 | **GTM triggers.** No trigger exists for `chat_reply` yet. | Marketing | Events reach `dataLayer` but no GA4 event fires until a trigger + tag exist. |
| 7 | **CSP.** The site has none today. If one is added, `connect-src` must include the API origin and `style-src` must allow the widget's inline stylesheet. | Lovable implementer | A strict CSP would silently block the widget. |
| 8 | **Six approximate citation mappings** in §4.2 — closed 2026-10-23. | Editorial | Registry: `src/rag/citation-mappings.ts`; validation: `tests/citation-mappings.test.ts`. The lapse/reinstatement article remains worth commissioning. |

---

## 15. Lovable agent prompt

Paste the block below into Lovable's chat after the API host is deployed and `ALLOWED_ORIGINS` includes the site's origins.

```text
Add the LifeChat AI assistant to this site as a persistent, site-wide chat widget. It is a
third-party script served from our own API host; do not install npm packages for it and do
not rewrite it in React.

Hard requirements:
1. Create src/components/LifeChatWidget.tsx that renders null. It must inject this script
   once, only in the browser (never during SSR):
     src = "https://YOUR-API-HOST/widget.js"
     data-api-base = "https://YOUR-API-HOST"
   Set window.LPP_CHAT_CONFIG = { apiBase: "https://YOUR-API-HOST", zIndex: 40,
   bottomOffset: 72 } before injecting the script. Guard against double injection with a
   stable script id, and if window.__lppChatWidget already exists call
   window.__lppChatWidget.mount() instead of adding a second script.
2. Mount <LifeChatWidget /> exactly once, in the root layout/App component OUTSIDE
   <Routes>, so React Router navigation does not unmount it. Do not add it to individual
   pages or to the calculators.
3. Do not add any global CSS, Tailwind config changes, or wrapper divs around it. The
   widget styles itself and scopes its CSS to .lpp-chat-widget. Do not set overflow,
   transform, filter or z-index on body, #root or any ancestor: those create a containing
   block and break position:fixed.
4. Keep z-index 40 and bottom offset 72px as configured. If a cookie banner or modal is
   added later, it must sit above the widget; adjust data-z-index in that change, not here.
5. Do not change the site's <head>, meta tags, JSON-LD, sitemap or routing. The widget
   injects one <style> element into <head> and two nodes at the end of <body>; it must not
   affect SEO, prerender output, or the calculator pages.
6. Do not expose any secret. The only value involved is the public API origin above.

Verification before you finish:
- Load /, open the launcher, send "What is term life insurance?", and confirm a reply with
  citations appears.
- Navigate client-side to /tools/term-ladder and /ibc-lab without a reload, send another
  message, and confirm the reply reflects the new page (the widget re-reads the route).
- In React StrictMode development, confirm exactly one launcher and one dialog exist and
  no duplicate ids appear in the console.
- Confirm the launcher does not cover the sticky header or calculator controls at 320px and
  1440px widths, and that citation bullets are visible.
- Confirm no CORS error appears in the console and no request goes to
  https://lifeinsurancebrokeradvocate.com/api/* (all calls must go to the API host).
- Confirm no layout shift and no change to Lighthouse SEO/CLS beyond the injected widget.

If any step fails, report the exact console/network error instead of adding CSS overrides.
```

---

## 16. Deployment checklist for the API host

1. `NODE_ENV=production`, `PILOT_MODE=false`, `PORT` as the platform requires; do not set `VERCEL=1` or `SERVERLESS=true`.
2. `TEXAS_LICENSE_NUMBER`, `BUSINESS_NAME`, `LICENSED_BROKER_NAME`, `APPOINTED_CARRIERS`.
3. `WEBSITE_URL=https://lifeinsurancebrokeradvocate.com/`, `PRIVACY_NOTICE_URL=…/privacy`, `CONTACT_URL=…/contact`, `DSR_CONTACT_EMAIL` (see §14 item 1). Run `npm run rights:channel` against this environment and require exit `0` before releasing.
4. `ALLOWED_ORIGINS` with apex + `www`; add a preview origin only while testing.
5. `TRUST_PROXY` set to the platform's hop count (usually `1`), verified with the rate-limit test in §13.
6. `LLM_API_KEY`, `RECORD_ENCRYPTION_KEY` (32+ chars), `ADMIN_API_KEY` (32+ chars).
7. A persistent volume mounted at the working directory for `data/` (or absolute `DSR_LOG_PATH`, `LEAD_LOG_PATH`, `ABSTENTION_LOG_PATH` on the volume).
8. One replica. Scale vertically, not horizontally, until §14 item 4 is done.
9. `curl -i -X OPTIONS https://API_HOST/api/chat -H 'Origin: https://lifeinsurancebrokeradvocate.com' -H 'Access-Control-Request-Method: POST'` must return `204` with the exact `access-control-allow-origin`.
10. `curl -s https://API_HOST/health` must report the license, storage and LLM posture you expect; then send one real message from the live page and confirm the citation URLs open on the new domain.

---

## 17. Summary

The widget and the domain layer are ready; the hosting model is not. With `data-api-base`, the narrowed CORS wildcard, SPA route sync, the mount/destroy handle, preflight-safe list styles and configurable stacking, the embed can coexist with Lovable's React Router SPA and Tailwind reset without touching the calculators. The blocking decision is where the Express process runs: Vercel's serverless runtime turns consent and DSR intake into deliberate `503`s and loses session state between turns, so the API must live on one always-on Node host with a persistent volume until the Postgres migration is done. Branding (**LifeChat by Life Insurance Broker Advocate**) and the six citation mappings are now closed in code, with their sign-offs recorded in `src/config/branding.ts` and `src/rag/citation-mappings.ts`. The remaining items — the license number, the hosting choice and GTM triggers — are listed in §14; the rights channel is now gated by `npm run rights:channel`, and the license number still refuses production startup until it is configured.
