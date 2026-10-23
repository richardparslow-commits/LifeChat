# LifeChat — Principal Security, Privacy & Architecture Audit

**Repository:** `richardparslow-commits/LifeChat`
**Commit audited:** `f78ef5f` (Merge PR #36, `release/sandbox-readiness`) **plus 45 uncommitted working-tree changes**
**Audit date:** 2026-10-21
**Auditor posture:** Principal Security Architect / Lead Full-Stack Engineer / Accessibility Specialist
**Scope:** 152 tracked files — 55 source files (31,917 LOC), 55 test files (28,311 LOC), `public/widget.js` (1,713 LOC), 2 workflows, 10 design docs, build and deploy config.

> **Working-tree caveat.** The checkout is dirty: 45 files are modified relative to `f78ef5f`, including `src/app.ts`, `public/widget.js`, `src/config/app-config.ts`, `src/rag/retrieval.ts`, and both workflows. Line numbers below refer to the **working tree as audited**. If those changes are discarded, some anchors shift.

---

## 0. Verification evidence

Everything in this report is either measured in this checkout or cited to a file and line. Nothing was taken from the README.

| Check | Command | Result |
|---|---|---|
| Type-check | `npx tsc --noEmit` | **Pass** (exit 0) |
| Lint | `npm run lint` | **Pass** (no output) |
| Test suite | `npm test -- --silent` | **2,983 passed / 56 suites / 0 failed** (26.9 s) |
| Coverage | `npx jest --coverage` | Statements **89.28 %**, Branches **81.77 %**, Functions **90.92 %**, Lines **89.99 %** |
| Dependency audit | `npm audit --audit-level=high` | **0** vulnerabilities (578 deps: 93 prod, 486 dev, 42 optional) |
| Live-app probe | supertest against `createApp()` | Admin endpoints **HTTP 200 with no credential** (§SEC-01) |
| Rate-limit probe | 200 distinct client-minted session ids | **200/200 allowed** (§SEC-02) |
| Provider-leak probe | fake LLM 401 echoing a key fragment | fragment returned **to the client** in `action_arguments.summary` (§SEC-05) |
| ReDoS probe | 2,000-char adversarial strings through the classifiers | worst case **32 ms** per request (§SEC-18) |

Not verified (and not claimed): a real browser/axe-core run, a live Vercel or Archil deployment, a real LLM provider call, and the behaviour of the GitHub App on the remote (only the local clone was inspected).

---

## 1. Executive risk summary

LifeChat is, in engineering terms, a **well-built system with an unfinished data lifecycle**. The code is unusually disciplined for an LLM product: every write fails closed, consent is derived from storage rather than from model prose, the model's output is schema-validated and retried once, session state is server-authoritative, the widget builds DOM with `textContent` only, and there are 2,983 tests with 90 % line coverage. None of that is marketing copy; it is verifiable.

The risk is concentrated in five places:

1. **Authorization is fail-open by configuration, not by code.** With `ADMIN_API_KEY` unset, every admin endpoint — including the kill switch and conversation-history reads — answers 200. `PILOT_MODE` defaults to `true` (any value other than the literal string `false`), so a runtime that loses or never receives an env var is *silently* in the open posture. The Docker and Vercel pipelines require the key, so the pipeline is safe; the application is not. Security posture is delegated to CI.
2. **The model's cost is unbounded.** `/api/chat` is rate-limited by `sessionId`, and `sessionId` is minted by the client. A 12-character string is a fresh budget. 200 distinct ids were allowed in one window, each able to spend up to 50,000 tokens/minute. There is no per-IP or global budget on the only endpoint that costs money.
3. **The record system is write-only.** Consent/lead records and DSR requests are written, encrypted, and then have no read path in the API (`listLeadRecords` is not exposed), no delete path (`clearAllLeadRecords` is test-only), no retention job, and no status transition for DSRs. The privacy notice promises deletion after a counsel-approved retention period and a 45-day response. The code implements intake, not fulfilment. In a TDPSA/GLBA context that is the single most consequential gap in this repository.
4. **Two actions claim success without a side effect.** `send_transactional_confirmation` is *authorized* although the repository contains no mail or SMS transport at all (the only outbound `fetch` in `src/` is the LLM client). `request_human_handoff` notifies nobody. The model's prose is not corrected in either case, because the correction note is only appended when an action is *refused*.
5. **An unauthenticated third party can suppress a legitimate lead.** A DSR filed with someone else's email address — no verification whatsoever — causes `hasPendingDeletion()` to reject every side effect for that address. That is a consent-integrity control that grants authority to an unverified claim, and it only reads a 5,000-entry in-memory cache, so it is simultaneously over-broad and unreliable.

**Go/no-go:** *no* public launch until SEC-01 through SEC-04, SEC-06, SEC-07 and SEC-08 are closed. A **closed, invite-only** pilot behind the CI deploy path is defensible once SEC-02 and SEC-05 are fixed; SEC-03 and SEC-08 are now closed.

> **Remediation status — 2026-10-21 (corrected 2026-10-22, extended 2026-10-23).** SEC-02 through SEC-08 and SEC-10 through SEC-18 were implemented at that time. **SEC-01 was not closed**: `requireAdminAuth` still returned `true` in pilot mode with no key, and the live probe above (HTTP 200 unauthenticated) was the accurate result. The 2026-10-22 audit re-opened it as C-01 and found four further P0 gaps: C-02 model-authored response envelope, C-03 consent hash over caller text, C-04 free-text `topicCategory`, and C-05 client-controlled medical consent version. All five are now closed: admin routes answer 503 without a key in every mode, the response envelope is server-authored, the consent hash is over the canonical approved copy, `topicCategory` is allowlisted, and the medical consent version is server-owned. Regressions are in [tests/p0-security-regressions.test.ts](../tests/p0-security-regressions.test.ts); the P0 checklist in §7 carries the corrected status. Provider-error coverage is in [tests/llm-client-error-leak.test.ts](../tests/llm-client-error-leak.test.ts); the lifecycle work by [tests/data-lifecycle.test.ts](../tests/data-lifecycle.test.ts); the lead read path by [tests/lead-export.test.ts](../tests/lead-export.test.ts). The findings below remain the record of the pre-fix state. The 2026-10-22 audit's C-06 (the state machine was disconnected from the route) was closed on 2026-10-23: the model's validated `intent` block drives the persisted state, loop controls are enforced, and the state is persisted only after the response and side effects — see the 2026-10-22 report and [tests/state-machine-wiring.test.ts](../tests/state-machine-wiring.test.ts). C-08 (no shipped UI client for consent or DSR) was closed the same day: the widget now ships the consent/contact step and a TDPSA request form, covered by [tests/widget-contact-e2e.test.ts](../tests/widget-contact-e2e.test.ts). SEC-08 is closed by the admin-only export at `GET /api/admin/leads`: paginated, log-backed (not narrowed by the bounded cache), refusing a page it cannot decode, carried suppression flags, and access-audited before any record is returned. What replaces the old blocker is an operational requirement: an operator must hold the admin key and the access audit log must live on durable storage with the records. SEC-10 resolves proxy trust deliberately: Vercel's single edge hop is the default there, wildcard trust is refused, and an unset serverless deployment warns instead of silently collapsing every visitor into one bucket. SEC-11 replaces `DURABLE_STORAGE_CONFIGURED` with a boot probe that writes, reads back and deletes in each record directory; a serverless runtime whose paths are under `/tmp`, the OS temp dir or `/var/task` now fails closed regardless of the flag, and `/health` reports the verdict. Tests in `tests/durable-storage.test.ts`. SEC-12 takes page context out of the system role: `injectContext` emits only the allowlisted `article_id` and `topic` (the caller-supplied title is dropped entirely), and `buildMessages` delivers that as a user-role block between the fixed delimiters, with the Section 16 rules app-authored in the system prompt. Tests in `tests/contextual-bridge.test.ts` assert that no page context appears in any system message, that the block arrives as a user turn, and that a title carrying instructions yields no block at all. SEC-13 adds a deterministic claim guard on `assistant_message`: guarantees, currency/percentage figures, prohibited rankings or "right for you" recommendations, and personal identifiers are rejected before a response is accepted, fed back for the single retry, and recorded as `claim_*` entries on the final response's `risk_flags` even when the retry rewrites the message. Negated disclaimers ("no policy is guaranteed") are allowed, so compliant wording does not pay a retry. Tests in `tests/claim-guard.test.ts`. SEC-14 makes the appointment ledger cross-process: each booked slot has one claim file under `BOOKING_LEDGER_PATH`, created with `O_CREAT|O_EXCL` (new `src/scheduling/booking-ledger.ts`), written and fsynced before the in-memory index is updated, and reloaded on first use so a restart or another replica sees it. A second instance loses the create and reports `slot_already_booked`; a ledger that cannot make a durable claim (ephemeral serverless path, unusable directory, or object-only storage with no conditional create) refuses with `storage_unavailable` instead of confirming a booking. Tests in `tests/booking-ledger.test.ts`, `tests/booking-ledger-cross-process.test.ts` (four real OS processes racing for one slot) and `tests/verified-actions.test.ts`. SEC-15 makes record encryption rotatable and authenticated-only: the envelope is v2 with a `kid` derived from the secret, `RECORD_ENCRYPTION_KEYS` supplies previous secrets for decryption (and pre-`kid` v1 lines are matched by trying the ring, with the auth tag deciding), production refuses any line that is not a valid envelope instead of returning it as a record, and `npm run records:rekey` rewrites each log atomically under the current key. Tests in `tests/record-keyring.test.ts`; the procedure is in [data-lifecycle-runbook.md §7](./data-lifecycle-runbook.md). The privacy notice's retention sentence is backed by an operator-triggered sweep, but the schedule and backup expiry must be configured — see [data-lifecycle-runbook.md](./data-lifecycle-runbook.md). SEC-16 gives the API host HSTS and a document CSP, replaces `express.static`'s `max-age=0` with `no-cache` for HTML and a one-hour revalidating cache for the unversioned widget assets, and compresses them on Node hosts; `vercel.json` carries the same policy for the three files Vercel serves statically, pinned by `tests/static-delivery-headers.test.ts`. SEC-17 adds the missing CI gates: a global coverage floor at the audit's 85/75 targets, a checksum-pinned gitleaks scan over full history with a narrowly scoped allowlist for three verified historical test fixtures, a read-only dependency-review job on pull requests, weekly Dependabot for npm and pinned actions, and `eslint-plugin-security` rules inside the required lint step; `tests/security-gates.test.ts` proves the wiring and that a dynamic `eval` is actually reported. SEC-18 keeps a consented medical profile out of the pilot-mode plaintext fallback: `/api/consent` refuses a medical payload with 503 when `RECORD_ENCRYPTION_KEY` is unset (in pilot mode too), and the writer independently marks such a record `requireEncryption`, so a different caller cannot bypass the route and put health data on disk in clear. Tests in `tests/medical-record-encryption.test.ts`. On the accessibility side, the widget now renders inside an open shadow root with `all: initial` typography reset at its root, so host-page CSS cannot override target size, spacing or contrast; verified in Chromium against a hostile host stylesheet and locked by `tests/widget-accessibility.test.ts`. The axe-core/Playwright gate (`npm run a11y:e2e`, CI job `Accessibility Gate`) renders the demo in Chromium and fails on serious/critical violations in both the closed and open widget, with a control probe proving the scan can still detect one, and a third scan applies a dark host theme while asserting the page actually changed and the widget kept its own palette (§5.5).

### Scorecard

| Pillar | Grade | One-line verdict |
|---|---|---|
| Security & PII handling | **B−** | Excellent data minimisation and redaction; fail-open admin default and unbounded spend drag it down |
| Privacy & compliance | **D+** | Intake is rigorous, lifecycle is absent; deletion cannot be performed by the software |
| Architecture & code quality | **B** | Clear layering and strong types; one 1,566-line route monolith and four copy-pasted response scaffolds |
| Performance & scalability | **C+** | Non-blocking I/O and bounded caches are good; single-instance state and a 68 KB uncached widget are not |
| Testing & DevOps | **A−** | 2,983 tests, SHA-pinned actions, secret gate, clean audit; no SAST/secret scanning/axe/coverage floor |
| Accessibility | **A−** | Genuinely strong hand-built widget; no automated axe gate and host-page CSS can still override it |

---

## 2. System model and data-flow trace

### 2.1 Deployment shape

```
Browser (host page)                         Edge / process
┌──────────────────────┐   <script>        ┌──────────────────────────────────┐
│ lifeinsurancebroker… │──widget.js──────▶ │ Express app (src/app.ts)          │
│ or Lovable site      │                   │  static: widget.js, demo.html     │
│                      │  POST /api/chat   │  JSON API (no cookies, no auth)   │
│  window.LPP_CHAT_    │──────────────────▶│  in-memory LRU stores:            │
│  CONFIG.apiBase      │◀──────────────────│   sessions, rate limits, leads,   │
└──────────────────────┘   JSON            │   DSR, bookings, page context      │
                                            └───────┬──────────────┬───────────┘
                                                    │              │
                                     HTTPS Bearer   │              │ append-only JSONL
                                                    ▼              ▼ (AES-256-GCM) or Archil S3
                                        OpenAI-compatible      data/lead-records.jsonl
                                        /chat/completions      data/dsr-records.jsonl
                                                               data/abstention-log.jsonl
```

Egress inventory (verified by grep for `fetch(` in `src/`): **exactly one** outbound `fetch` — the LLM provider in `src/llm/llm-client.ts:190`. Archil uses its SDK (`disk`). There is **no** mail, SMS, CRM, calendar, or webhook integration anywhere in the repository.

### 2.2 Chat turn, step by step

| # | Step | File | Trust treatment |
|---|---|---|---|
| 1 | `express.json()` parses the body (default 100 kB limit, not set explicitly) | `src/app.ts:182` | Unbounded keys, bounded size |
| 2 | Baseline headers + `Cache-Control: no-store` on `/api` | `src/app.ts:195-205` | — |
| 3 | CORS: exact or `*.host` allowlist, deny by default, 204 preflight | `src/app.ts:220-241` | Browser origin |
| 4 | `ChatRequestSchema.safeParse` strips unknown keys | `src/schema/request-schema.ts:38-55` | Rejects `currentState` injection |
| 5 | State + medical consent come from the session store | `src/app.ts:581-583` | Server-authoritative |
| 6 | Kill switch | `src/app.ts:606-612` | Static safe fallback |
| 7 | Rate limit **by `sessionId`** | `src/app.ts:617` | Client-controlled key (§SEC-02) |
| 8 | Prompt-injection regex | `src/app.ts:626` | Redacts message into history |
| 9 | Immediate-crisis detector | `src/app.ts:676` | Message never reaches the model or history |
| 10 | Sensitive-data classifier (health / financial / identifiers) | `src/app.ts:694-790` | Deterministic refusal + handoff |
| 11 | `containsPersonalIdentifier` — independent PII gate | `src/app.ts:792` | Email/SSN/phone/card never reach the model |
| 12 | Snapshot history **before** recording the new turn | `src/app.ts:817` | Prevents duplicate turn to LLM |
| 13 | State machine transition | `src/app.ts:833-879` | Server facts only |
| 14 | RAG retrieval + sufficiency abstention | `src/llm/orchestrator.ts:120-160` | Abstains in `education`/`disclosure` |
| 15 | LLM call: 10 s timeout, 2 attempts, circuit breaker | `src/llm/llm-client.ts:151-286` | Prompt in a Bearer-authenticated call |
| 16 | JSON extraction → Zod schema → cross-field rules → promo/persona/re-offer gates → one retry | `src/llm/orchestrator.ts:180-300` | Model output untrusted |
| 17 | Citations **overwritten** from the corpus | `src/llm/orchestrator.ts:318-321` | Model cannot cite arbitrary URLs |
| 18 | DIME figures computed by the app, never by the model | `src/app.ts:920-968` | Deterministic |
| 19 | Card resolved from the approved library only | `src/app.ts:970-1000` | Model supplies an id, never content |
| 20 | Side-effect authorization from stored consent + selected slot | `src/tools/verified-actions.ts:170-350` | Model prose is not evidence |
| 21 | Assistant text appended to history (never lead/consent/risk fields) | `src/app.ts:1044` | PII minimisation |

### 2.3 Consent and DSR paths

```
POST /api/consent
  serverless+no durable storage ──▶ 503 (fail closed)
  write rate limit by req.ip ──▶ 429
  Zod ──▶ affirmative consent required ──▶ channel field validated
  optional medical profile ──▶ feature flag ──▶ versioned consent ──▶ ICD-10 crosswalk
                     └─▶ no RECORD_ENCRYPTION_KEY ──▶ 503 (SEC-18: never plaintext)
  createLeadRecord ──▶ AES-256-GCM ──▶ append JSONL (must return true)
  session.medicalConsent = true; session.state = 'consent'

POST /api/dsr
  serverless+no durable storage ──▶ 503
  write rate limit by req.ip ──▶ 429
  requestType ∈ {access, deletion, correction, portability}; email format check
  record.status = 'received' ──▶ encrypted JSONL ──▶ 45-day SLA in the response
  [nothing else exists: no verification, no fulfilment, no status update]
```

### 2.4 Trust boundaries

| Boundary | Untrusted input | Controls | Residual risk |
|---|---|---|---|
| Browser → API | whole body, `sessionId`, `sourceUrl`, `page_context` | Zod strip, length caps, URL sanitisation, per-session budget | Client picks its own budget key (§SEC-02) |
| Host page → prompt | `title`, `category`, `article_id` | injection regex, length caps, mapped to allowlisted articles; only allowlisted `article_id`/`topic` emitted, as a user-role data block (§SEC-12, closed) | Page title no longer reaches the model at all |
| Model → app | full JSON response | Zod + cross-field rules + persona/promo/decline gates + claim guard + one retry (§SEC-13, closed) | Claim guard is pattern-based, not semantic |
| App → records | PII, consent artefacts | AES-256-GCM with a per-key `kid`, legacy key ring, fail-closed writes, production plaintext refusal (§SEC-15, closed) | Rotation needs the old key in the ring until `records:rekey` runs |
| Operator → admin API | `x-admin-key` | constant-time compare over SHA-256 digests, 32-char floor, boot gate, 503 when unset in every mode (C-01, closed 2026-10-22) | No credential, no request — including from a non-loopback peer |
| App → provider | system prompt, evidence, last 20 turns | Bearer secret in env, 10 s timeout | Error bodies returned to callers (§SEC-05) |

---

## 3. Detailed finding matrix

Severity reflects **exploitability × blast radius in a regulated insurance context**, not code aesthetics.

### CRITICAL

| ID | Finding | Evidence | Impact | Fix |
|---|---|---|---|---|
| **SEC-01** | **Admin authorization is fail-open.** `requireAdminAuth` returns `true` when no key is configured. `pilotMode` is true unless `PILOT_MODE` is exactly `'false'`. A process started without those two variables serves the system prompt, session histories, session count, DSR status, and the **kill switch** to anyone. Verified: `GET /api/system-prompt`, `/api/session/:id/history`, `/api/sessions` all returned **200** unauthenticated. | `src/app.ts:272-283`; `src/config/app-config.ts:175`; `src/index.ts:134-176` | Confidentiality (prompt, conversation history), integrity (conversation state), availability (anyone can stop the bot). Pipeline gates the key; the **application** does not. | Make the default deny: pilot only when `NODE_ENV !== 'production'` **and** `PILOT_MODE=true` explicitly; return 503 for admin routes whenever a key is absent. Ship a test that asserts 503 with `PILOT_MODE=false` and no key. |

### HIGH

| ID | Finding | Evidence | Impact | Fix |
|---|---|---|---|---|
| **SEC-02** | **Unbounded model spend.** The chat limiter is keyed by the caller-supplied `sessionId`; 200 distinct ids were all admitted. The 10,000-entry LRU also *evicts* counters under churn, resetting other callers' budgets. | `src/app.ts:617`; `src/security/security-controls.ts:2475-2557` | Direct financial loss, provider rate-limit lockout, DoS of legitimate visitors. | Add a second budget keyed by `req.ip` (and a process-wide token ceiling), keep the per-session budget for fairness, and count tokens against both. |
| **SEC-03** | **Deletion requests cannot be fulfilled and retention is not implemented.** DSR records are created with `status: 'received'` and there is no update, fulfilment, or erasure function; `clearAllLeadRecords`/`clearAllDsrRecords` are test helpers. No retention job exists. The privacy notice promises deletion after a counsel-approved period and a 45-day response. | `src/privacy/dsr.ts:166-222`; `src/consent/consent-model.ts:485-500`; `docs/privacy-notice.md:138-143` | TDPSA rights cannot be honoured; the published notice overstates capability; regulator-facing exposure. | Implement `eraseSubjectRecords(email)` (rewrite-and-rename with an audit tombstone), a DSR status machine, and a scheduled retention sweep. Publish the runbook. |
| **SEC-04** | **`send_transactional_confirmation` reports success with no transport.** It is authorized for a matching appointment id and returns `authorized: true`, `replayed: true`; nothing is sent. The model's prose is only corrected when an action is *refused*, so "I've emailed you a confirmation" stands. | `src/tools/verified-actions.ts:299-345`; `src/tools/tool-controls.ts:170-178`; no mailer in `package.json`/`src` | Consumer harm and a false compliance record in a fiduciary context; contradicts `SCHEDULING_RULES.CONFIRM_ONLY_AFTER_SUCCESS`. | Refuse it until a transport exists (`tool_not_authorized` + correction note), or gate it on a provider 2xx and set `effect.delivered`. Never authorize on intent. |
| **SEC-05** | **Provider error bodies are returned to the client.** On a non-2xx, `lastError` embeds up to 200 chars of the provider body; `buildFallbackResponse` puts `slice(0,100)` into `action_arguments.summary`, which is serialized to the browser. Proven with a fake 401: the response contained `sk-live-SECRET-ABC123 … org-LEAK-4`. | `src/llm/llm-client.ts:204`; `src/llm/orchestrator.ts:471` | Disclosure of provider internals, masked key prefixes, org/project ids; unsafe for gateways that echo request content. | Keep the body in a server log; expose only `error_code` (`api_error_401`) to callers. |
| **SEC-06** | **An unverified third party can suppress a real lead.** `hasPendingDeletion()` matches any `deletion` DSR whose `contact_email` equals the consented address; `/api/dsr` accepts any well-formed email with no verification. | `src/tools/verified-actions.ts:118-125, 220`; `src/privacy/dsr.ts:166-200` | Attacker files a deletion for a victim's email and blocks contact/booking for that lead. | Require verification before a DSR gains suppression authority (double opt-in link, or admin confirmation), and bind suppression to `lead_id`/session where possible. |
| **SEC-07** | **Consent is accepted with no contact channel.** All of `contactChannel`, `email`, `phone` are optional; `contactFieldIsValid` returns `true` when the channel is absent; the record is persisted and acknowledged. | `src/schema/request-schema.ts:65-93`; `src/app.ts:1120-1160`; `src/consent/consent-model.ts:382-420` | A "consent artifact" with no reachable route is not usable consent (TCPA proof), and it is an unauthenticated append to an unbounded log. | Require `contactChannel` plus a valid value for that channel before creating a lead; reject otherwise with 400. |
| **SEC-08** | **Records are write-only from the API.** No route lists or exports leads; `/api/dsr/:id` exposes status only. The broker cannot retrieve a lead without filesystem access **and** the decryption key. | `src/app.ts:371-1500` (route table); `src/consent/consent-model.ts:477-483` | Operationally the product cannot follow up on the leads it collects; the "handoff" is inert. | Add an admin-only, paginated, audit-logged lead export; decide whether that is a file, a CRM sync, or an email digest. |

### MEDIUM

| ID | Finding | Evidence | Impact | Fix |
|---|---|---|---|---|
| **SEC-09** | **Wildcard CORS widens the trust boundary to a vendor's tenants.** `https://*.lovable.app` is offered in `.env.example` and recommended in the migration audit. Any Lovable project can then call the API. | `src/config/app-config.ts:262-292`; `.env.example:56-66`; `docs/lovable-migration-readiness-audit.md:99-103` | Cross-tenant abuse of LLM budget and lead submission. | Use exact origins per published site; if previews must work, issue a short-lived embed token and validate it server-side. |
| **SEC-10** | **`TRUST_PROXY` default makes the write budget global.** Empty means `req.ip` is the socket peer; behind Vercel/Cloudflare that is the proxy, so every visitor shares one 60/min bucket. Already acknowledged in the project's own audit doc, still unresolved. | `src/app.ts:167-181`; `src/security/security-controls.ts:2569-2605`; `docs/lovable-migration-readiness-audit.md:292` | Either a global throttle (misconfiguration) or a spoofable header (if set to `true`). | Set the documented hop count per platform; add a test that two `X-Forwarded-For` values get separate buckets with `TRUST_PROXY=1`. |
| **SEC-11** | **`DURABLE_STORAGE_CONFIGURED=true` disables the ephemeral-path guard without proof.** Setting it on Vercel makes consent/DSR writes go to `/tmp` and be acknowledged. | `src/config/app-config.ts:316-323` | Silent loss of legal records; the one flag that turns fail-closed into fail-open for writes. | Replace the flag with a verified write-and-read probe at boot, or require an Archil/DB binding. |
| **SEC-12** | **Untrusted page title is interpolated into a `system`-role message.** `buildContextualInstruction` embeds `pageContext.title`; orchestrator passes it as `applicationContext` → `buildMessages` emits `role: 'system'`. Filtering is a 6-regex blocklist. | `src/contextual/context-injection.ts:83-105`; `src/llm/llm-client.ts:120-128` | A title that evades the blocklist is instructions at the highest authority. | Emit article metadata in a `user` data block with explicit delimiters, and use the allowlisted `articleId` only. |
| **SEC-13** | **No claim-level output guard.** Validation covers schema, consent cross-fields, promo phrases, persona style, and re-offers — not factual claims, guarantees, invented coverage, or PII in `assistant_message`. | `src/llm/orchestrator.ts:196-300` | Model can assert unapproved coverage/price statements; in insurance that is a regulatory statement. | Add a post-validation guard for currency/percentage/guarantee patterns and a banned-claims list; log and retry. |
| **SEC-14** | **Booking ledger is process-local.** Slots, idempotency keys, and appointments live in three LRUs. Correct for one instance; two instances double-book the same slot. | `src/scheduling/appointment-slots.ts:148-150` | Double bookings, lost confirmations. | Back bookings with durable storage + a unique constraint on `slot_id`, or refuse booking when more than one instance is detected. |
| **SEC-15** | **Record encryption has no key versioning and accepts plaintext on read.** `decryptRecordLine` returns any non-envelope line verbatim; key rotation makes every prior line unreadable. | `src/privacy/record-encryption.ts:96-125` | Rotation is a data-loss event; a writer with filesystem access can inject an unauthenticated record. | Add `kid` to the envelope, a keyring, and a migration tool; mark legacy plaintext lines explicitly and refuse them in production. |
| **SEC-16** | **No CSP/HSTS; static assets are uncached and uncompressed.** `express.static` default is `Cache-Control: public, max-age=0`; `widget.js` is 68,073 B (19.5 kB gzip) and served without compression. Headers set: `X-Content-Type-Options`, `Referrer-Policy` only. | `src/app.ts:195-200, 245`; `public/widget.js` | Every navigation revalidates 68 KB; no defence-in-depth for the demo origin. | `maxAge: '1y', immutable` for hashed assets, `no-cache` for HTML, add `compression`/precompressed `.br`, and a CSP (`default-src 'self'`) for the demo. |
| **SEC-17** | **No SAST, secret scanning, dependency review, or coverage floor.** `.github/` contains only `ci.yml` and `deploy.yml`. Jest has no `coverageThreshold`. | `.github/workflows/`; `jest.config.js` | Regressions in security-critical modules are not gated beyond tests the author writes. | Add CodeQL, `gitleaks`/GitHub secret scanning, `dependency-review-action` on PRs, Dependabot, and a 85 % statements / 75 % branches threshold. |
| **SEC-18** | **Medical-data plaintext in pilot mode.** The AES gate runs only when `!pilotMode`; pilot is the default. A pilot deployment with DOB/conditions/medications in `lead-records.jsonl` writes them in clear. | `src/index.ts:154-176`; `src/privacy/record-encryption.ts:73-80` | TDPSA sensitive-data exposure from a backup or disk snapshot. | Require the key whenever a medical payload is accepted, regardless of pilot mode. |

### LOW

| ID | Finding | Evidence | Note |
|---|---|---|---|
| **SEC-19** | Regex classifiers take **32 ms** on a 2,000-char benign string (`'a'*2000`), 13.5 ms on digits. | `src/security/security-controls.ts:1876-1918` | Linear in ~1,000 alternations. Cache the per-message classification; consider a single Aho-Corasick pass. Becomes material only when combined with SEC-02. |
| **SEC-20** | `/health` publishes the model name and provider base URL. | `src/app.ts:394-427` | Low-value recon; make it admin-only or drop `baseUrl`. |
| **SEC-21** | Full error objects are logged for 5xx. | `src/app.ts:1539` | Verified that a malformed body (400) does **not** log its contents; the risk is future error types carrying request data. Use a structured logger with an allowlist. |
| **SEC-22** | `sanitizeRetrievedContent` is applied to the **user message**, not to the retrieved evidence it is named for. | `src/llm/orchestrator.ts:169`; `src/security/security-controls.ts:127-158` | Harmless today (corpus is app-owned) but the control does not do what its name says; sanitise `formatRetrievedContext` output instead. |
| **SEC-23** | Kill-switch reason (admin-supplied, 200 chars) is written to logs. | `src/app.ts:437` | Newlines stripped; could still carry PII pasted by an operator. |
| **SEC-24** | Decorative control constants. `SCHEDULING_RULES.CONFIRM_ONLY_AFTER_SUCCESS` and `confirmOnlyAfterDownstreamSuccess()` exist but are never consulted by the action layer. | `src/tools/tool-controls.ts:216-262` | A reader believes the invariant is enforced. Wire it or delete it. |
| **SEC-25** | Dependency majors are behind (Express 4→5, Zod 3→4, uuid 11→14, TypeScript 5.9→7). No advisories today. | `package.json`; `npm outdated` | Plan a deliberate upgrade window; do not bundle with security fixes. |
| **SEC-26** | No request id / structured audit trail for admin reads. | `src/app.ts:467-510` | Cannot answer "who read this session's history". |

---

## 4. Code-level remediation

### 4.1 SEC-01 — make admin authorization deny-by-default

**Before** — `src/config/app-config.ts:175`

```ts
pilotMode: process.env.PILOT_MODE !== 'false',
```

**After**

```ts
// Pilot is an explicit, local-only posture. Production is never inferred from
// a missing variable: an environment that loses PILOT_MODE must fail closed.
pilotMode:
  process.env.PILOT_MODE === undefined
    ? process.env.NODE_ENV !== 'production'
    : process.env.PILOT_MODE !== 'false',
```

**Before** — `src/app.ts:274-286`

```ts
function requireAdminAuth(req: Request, res: Response): boolean {
  if (!isAdminApiKeyConfigured()) {
    return true; // No key configured — allow (pilot/dev mode)
  }
  const provided = req.headers['x-admin-key'];
  if (typeof provided === 'string' && constantTimeEqual(provided, config.adminApiKey)) {
    return true;
  }
  res.status(401).json({ error: 'Admin authentication required' });
  return false;
}
```

**After**

```ts
function requireAdminAuth(req: Request, res: Response): boolean {
  if (!isAdminApiKeyConfigured()) {
    // Fail closed in every mode. The boot gate refuses to start a production
    // process without a key, but an admin route must also never be reachable
    // merely because a variable is missing from an already-running process.
    res.status(503).json({
      error: 'Admin authentication is not configured',
      message: 'Set ADMIN_API_KEY and restart.',
    });
    return false;
  }
  const provided = req.headers['x-admin-key'];
  if (typeof provided === 'string' && constantTimeEqual(provided, config.adminApiKey)) {
    return true;
  }
  res.status(401).json({ error: 'Admin authentication required' });
  return false;
}
```

Add to `tests/p0-security-regressions.test.ts`:

```ts
it('refuses a non-loopback admin request when no key is configured', async () => {
  process.env.PILOT_MODE = 'true';
  delete process.env.ADMIN_API_KEY;
  process.env.TRUST_PROXY = '1'; // make req.ip the X-Forwarded-For value
  jest.resetModules();
  const { createApp } = await import('../src/app');
  await request(createApp())
    .get('/api/system-prompt')
    .set('X-Forwarded-For', '203.0.113.9')
    .expect(503);
});
```

### 4.2 SEC-02 — a budget the caller cannot mint

**Before** — `src/app.ts:617`

```ts
const rateLimitResult = checkRateLimit(sessionId);
```

**After** — `src/security/security-controls.ts`

```ts
/**
 * Per-client chat budget. The session budget is fair-use; this one is the
 * spend control, because a session id is minted by the caller and therefore
 * cannot be the only key in front of a paid model call.
 */
export const CHAT_CLIENT_LIMIT_CONFIG = {
  MAX_REQUESTS_PER_WINDOW: 30,
  MAX_TOKENS_PER_WINDOW: 60_000,
  WINDOW_MS: 60_000,
} as const;

const chatClientStore = new BoundedLruCache<string, RateLimitState>(MAX_RATE_LIMIT_ENTRIES);

export function checkChatClientLimit(clientKey: string): { allowed: boolean; reason?: string } {
  const now = Date.now();
  let state = chatClientStore.get(clientKey);
  if (!state) {
    state = { sessionId: clientKey, requestCount: 0, windowStart: now, tokenCount: 0, lastActivity: now };
    chatClientStore.set(clientKey, state);
  }
  if (now - state.windowStart > CHAT_CLIENT_LIMIT_CONFIG.WINDOW_MS) {
    state.requestCount = 0;
    state.tokenCount = 0;
    state.windowStart = now;
  }
  state.lastActivity = now;
  if (state.requestCount >= CHAT_CLIENT_LIMIT_CONFIG.MAX_REQUESTS_PER_WINDOW) {
    return { allowed: false, reason: 'client_rate_limit_exceeded' };
  }
  if (state.tokenCount >= CHAT_CLIENT_LIMIT_CONFIG.MAX_TOKENS_PER_WINDOW) {
    return { allowed: false, reason: 'client_token_budget_exceeded' };
  }
  state.requestCount++;
  return { allowed: true };
}

/** Count a completed call against both budgets. */
export function incrementChatTokens(sessionId: string, clientKey: string, tokens: number): void {
  incrementTokenCount(sessionId, tokens);
  const client = chatClientStore.get(clientKey);
  if (client && Number.isFinite(tokens) && tokens > 0) client.tokenCount += tokens;
}
```

and in the route:

```ts
const clientKey = req.ip || 'unknown';
const clientLimit = checkChatClientLimit(clientKey);
const rateLimitResult = checkRateLimit(sessionId);
if (!clientLimit.allowed || !rateLimitResult.allowed) {
  /* 429 with reason */
}
// …after the call:
if (tokenUsage) incrementChatTokens(sessionId, clientKey, tokenUsage.inputTokens + tokenUsage.outputTokens);
```

Also make the LRU **not** evict below a floor while a caller is active — or, better, key the store by a hash and treat eviction as "fresh window" only for sessions that have been idle past `ENTRY_TTL_MS`.

### 4.3 SEC-05 — stop forwarding provider bodies

**Before** — `src/llm/llm-client.ts:204`

```ts
lastError = `api_error_${response.status}: ${errorBody.slice(0, 200)}`;
```

**After**

```ts
// The body may echo a key prefix, an org id, or request content. It belongs in
// the operator log, never in a value that can reach a caller.
console.error(`[llm] provider error ${response.status}: ${errorBody.slice(0, 200)}`);
lastError = `api_error_${response.status}`;
```

**Before** — `src/llm/orchestrator.ts:471`

```ts
summary: `Fallback triggered: ${errorType}${errorDetail ? ` (${errorDetail.slice(0, 100)})` : ''}`,
```

**After**

```ts
summary: `Fallback triggered: ${errorType}`,
```

### 4.4 SEC-04 — never authorize an action with no transport

**Before** — `src/tools/verified-actions.ts:299`

```ts
if (proposedAction === 'send_transactional_confirmation') {
  const appointment = getAppointmentForSession(sessionId);
  if (!appointment) return reject('appointment_not_verified', [...]);
  // …policy checks…
  return { authorized: true, effect: { appointmentId, replayed: true }, /* … */ };
}
```

**After**

```ts
if (proposedAction === 'send_transactional_confirmation') {
  // There is no mail/SMS transport in this deployment. Authorizing the action
  // would let the model's prose ("I've sent your confirmation") stand with no
  // delivery — a false statement to a consumer. Refuse, so the route appends
  // ACTION_NOT_CONFIRMED_NOTE and the visitor is told to contact the broker.
  return reject('tool_not_authorized', [
    'no transactional transport is configured; a confirmation cannot be claimed',
  ]);
}
```

If a transport is added later, authorize only on a 2xx from it:

```ts
const delivery = await sendTransactionalEmail({ to: consent.email, appointment });
if (!delivery.ok) return reject('tool_not_authorized', ['delivery failed']);
return { authorized: true, /* … */ effect: { appointmentId, delivered: true } };
```

### 4.5 SEC-06 — a DSR must be verified before it suppresses anything

**Before** — `src/tools/verified-actions.ts:118-125`

```ts
async function hasPendingDeletion(consent: VerifiedContactConsent): Promise<boolean> {
  if (!consent.email) return false;
  await ensureDsrRecordsLoaded();
  const target = consent.email.toLowerCase();
  return listDsrRecords().some(
    (record) => record.request_type === 'deletion' && record.contact_email.toLowerCase() === target,
  );
}
```

**After**

```ts
async function hasPendingDeletion(consent: VerifiedContactConsent): Promise<boolean> {
  if (!consent.email) return false;
  await ensureDsrRecordsLoaded();
  const target = consent.email.toLowerCase();
  // Suppression is an authority grant. An unauthenticated POST with someone
  // else's address must not be able to stop contact with that person, so only
  // a verified (double-confirmed or operator-approved) request counts.
  return listDsrRecords().some(
    (record) =>
      record.request_type === 'deletion' &&
      record.verified === true &&
      record.contact_email.toLowerCase() === target,
  );
}
```

Add `verified: boolean` to `DsrRecord`, flip it only from an admin route or a signed confirmation link, and add a test: an unverified deletion for `a@b.com` must **not** block `executeProposedAction` for that lead.

### 4.6 SEC-03 — an erasure path that can actually run

The minimum viable, auditable implementation (rewrite-and-rename; never edit a JSONL in place):

```ts
// src/privacy/erasure.ts
import { readFile, rename, writeFile } from 'fs/promises';
import { config } from '../config/app-config';
import { decryptRecordLine, encryptRecordLine } from './record-encryption';

export interface ErasureReceipt {
  scanned: number;
  erased: number;
  tombstoneId: string;
}

/**
 * Removes every lead and DSR line whose contact matches `email`.
 * Reads the whole log once, streams a replacement, then atomically renames it.
 * A tombstone (request id, timestamp, counts — no PII) is appended to the audit
 * log so the deletion itself is provable.
 */
export async function eraseSubjectRecords(email: string, dsrRequestId: string): Promise<ErasureReceipt> {
  const target = email.trim().toLowerCase();
  let scanned = 0;
  let erased = 0;

  for (const path of [config.leadLogPath, config.dsrLogPath]) {
    let source: string;
    try {
      source = await readFile(path, 'utf8');
    } catch {
      continue;
    }
    const kept: string[] = [];
    for (const line of source.split('\n')) {
      if (!line.trim()) continue;
      scanned++;
      const plain = decryptRecordLine(line);
      if (plain === null) { kept.push(line); continue; }
      let record: { email?: string | null; contact_email?: string | null };
      try { record = JSON.parse(plain); } catch { kept.push(line); continue; }
      const subject = (record.email ?? record.contact_email ?? '').toLowerCase();
      if (subject === target) { erased++; continue; }
      kept.push(line);
    }
    const tmp = `${path}.erasing`;
    await writeFile(tmp, kept.join('\n') + (kept.length ? '\n' : ''), 'utf8');
    await rename(tmp, path);
  }

  return { scanned, erased, tombstoneId: dsrRequestId };
}
```

Wire it to an admin route guarded by `requireAdminAuth`, require the DSR to be verified, transition `status` `received → verifying → fulfilled`, and expose the receipt. Add a retention sweep that calls the same primitive per expired record set. Backups are out of scope of the function but must be named in the runbook.

### 4.7 SEC-07 — a consent record needs a reachable channel

**Before** — `src/schema/request-schema.ts:65-93` (all optional) and `src/app.ts:1130`

```ts
if (!contactFieldIsValid(parsed.data)) { /* 400 */ }
```

**After**

```ts
export const ConsentRequestSchema = z
  .object({
    // …existing fields…
    contactChannel: z.enum(['email', 'phone']), // required
    email: OptionalTextSchema(254),
    phone: OptionalTextSchema(32),
  })
  .strip()
  .superRefine((value, ctx) => {
    if (value.contactChannel === 'email' && !value.email) {
      ctx.addIssue({ code: 'custom', path: ['email'], message: 'email is required for the email channel' });
    }
    if (value.contactChannel === 'phone' && !value.phone) {
      ctx.addIssue({ code: 'custom', path: ['phone'], message: 'phone is required for the phone channel' });
    }
  });
```

### 4.8 SEC-16 — a document policy, bounded caching and compression

Before, `express.static(PUBLIC_DIR)` served every asset `public, max-age=0` with no `Content-Encoding`, and no response carried HSTS or a CSP; `vercel.json` had only nosniff, `X-Frame-Options` and `Referrer-Policy`.

After, `src/security/security-headers.ts` owns the policy: HSTS for one year with subdomains; a document CSP (`default-src 'self'`, `script-src 'self'`, `style-src 'self' 'unsafe-inline'`, `frame-ancestors 'none'`, `base-uri 'none'`, `object-src 'none'`, `connect-src 'self'`, …); `no-cache` for HTML and `public, max-age=3600, must-revalidate` for the unversioned JavaScript and CSS. Express sets them on every response and runs `compression()` before the static handler. `vercel.json` repeats HSTS globally plus the CSP and cache rules for the three files Vercel's static host answers before the function runs — `/widget.js`, `/demo.html` and `/elementor-trust-block.css` — and `tests/static-delivery-headers.test.ts` pins the two copies and enumerates `public/`, so a new asset cannot ship without a cache decision.

Two deliberate deviations from the sketch above:

- **Not `maxAge: '1y', immutable`.** The filenames are fixed and the documented embed is a bare `<script src="…/widget.js">`, not a versioned query string. `immutable` would strand every embed on an old widget after a deploy; one hour bounds that skew while still ending the per-navigation revalidation. A year would require content-hashed names.
- **`style-src` keeps `'unsafe-inline'`.** `widget.js` builds its accessibility stylesheet at runtime with `document.createElement('style')` and cannot receive a per-request nonce on a host page it does not control. Scripts stay strict — no `'unsafe-inline'`, no `'unsafe-eval'` — which is the XSS-relevant directive. The policy belongs to our responses only: a browser enforces the embedding page's CSP, and a CSP on a JavaScript response is inert.

Measured on a local Node host: `/widget.js` fell from 68,073 B to 19,533 B gzip and 19,880 B Brotli (71 %). In a real browser under the new policy, `/demo.html` opened the widget, applied its 22-rule runtime stylesheet and loaded the disclosure greeting with no console CSP violations. Compression is negotiated by `compression()` on Node; Vercel's edge already compresses its static responses, so no declaration is added in `vercel.json`.

### 4.9 SEC-13 — a deterministic guard on the model's claims

Before, the validator stopped at structure and style; nothing read the factual content of `assistant_message`. After, `attemptValidation` calls `detectClaimViolation` (new `src/compliance/claim-guard.ts`) and treats a hit like any other validation failure:

```ts
const claimViolation = detectClaimViolation(schemaResult.data.assistant_message);
if (claimViolation) {
  blockedViolationLog.add(claimViolation.id);
  return { ok: false, kind: 'claim_guard_violation', detail: claimViolation.retryInstruction };
}
```

The four rules are the prohibitions the system prompt already states (Section 5/5.1): no guarantees or risk-free outcomes, no currency/percentage figures (the approved corpus contains none, and the application supplies the DIME estimate after validation), no "best/cheapest/optimal/tax-free/right for you" claims, and no personal identifiers in prose. Each rule ignores negated uses inside the same clause — "no coverage is guaranteed" and "I can't tell you which option is best" pass — so disclaimers are not rewritten into weaker text. A second violation falls back to the static safe response, and the rule id persists onto `risk_flags` so the blocked attempt remains auditable. The guard is pattern-based: it raises the cost of an accidental or prompted claim, and does not replace semantic review of new corpus content.

### 4.10 SEC-14 — one durable claim per slot

Before, `bookSlot` verified the slot and wrote it into three bounded LRUs, so two instances could each verify the same open slot and both confirm it. After, the in-memory indexes are a cache over a filesystem claim:

```ts
const claim = claimSlot({ appointment_id, slot_id, session_id, booked_at, idempotency_key });
if (claim === 'taken') return { ok: false, code: 'slot_already_booked' };
if (claim === 'unavailable') return { ok: false, code: 'ledger_unavailable' };
indexAppointment(appointment, idempotencyKey);
```

`claimSlot` uses `openSync(path, 'wx', 0o600)` — `O_CREAT|O_EXCL` — so the filesystem, not the event loop, decides the winner. The claim is fsynced before the booking is reported, and `loadBookingClaims` rebuilds the indexes on first use, so a restart keeps its bookings and the availability list excludes them. `verifySlot` remains the pre-check; the claim is the commit. `tests/booking-ledger-cross-process.test.ts` exercises the real arbitration rather than the reload simulation: it spawns four OS processes against one ledger, releases them together, and asserts exactly one booking succeeds and exactly one claim file exists.

The honest limits: this needs a shared POSIX filesystem. Archil's S3 object API has no conditional create, so object-only deployments now refuse booking (`storage_unavailable`) rather than acknowledge one that could be double-booked. On a serverless runtime the ledger path must be absolute and outside `/tmp`, the OS temp dir and `/var/task`, or the claim dies with the invocation and booking is refused. Otherwise the practice-management calendar remains the long-term home for slot inventory and bookings.

### 4.11 SEC-15 — a key ring instead of a single unversioned key

Before, the envelope carried no key identity, `decryptRecordLine` returned any non-envelope line verbatim, and rotation made every prior line unreadable. After:

```ts
// write — v2 envelope with a kid derived from the secret
{ v: 2, alg: 'aes-256-gcm', kid, iv, tag, data }

// read — kid selects the key; v1 lines try the ring; plaintext only outside production
return isLegacyPlaintextRecordAllowed() ? line : null;
```

`RECORD_ENCRYPTION_KEY` writes; `RECORD_ENCRYPTION_KEYS` lists previous secrets for decryption. Because the id is derived from the secret (`sha256(secret)` prefix), an operator never tracks ids by hand, and a v2 line names exactly one key while a v1 line is matched by its auth tag. In production a JSON object that is not an authenticated envelope is skipped rather than returned as a record, so a filesystem writer cannot inject an unauthenticated lead or DSR.

`npm run records:rekey` (with `--dry-run`) decodes each line with the ring and re-encrypts it under the current key, writing the file atomically; a file with any undecodable line is left exactly as it was and the command exits 1, so a partial rewrite cannot drop legal records. The rotation procedure and the rule for retiring the old secret are in [data-lifecycle-runbook.md §7](./data-lifecycle-runbook.md). Residual: the old secret must stay configured until the rekey run succeeds, and the key still lives in process environment/config rather than a KMS.

### 4.12 SEC-17 — gates instead of good intentions

Before, CI ran the test suite with `--coverage` and uploaded the report, but no threshold, secret scan, dependency review or action-update automation existed; a module could lose most of its coverage and still merge, and a credential committed to history was invisible.

After:

- **Coverage floor.** `jest.config.js` sets global thresholds at the audit's targets — 85 % statements/functions/lines, 75 % branches. The measured baseline when they were added was 88.4 / 80.7 / 89.8 / 89.5, so the floor fails a material regression without demanding a rewrite.
- **Secret scanning.** `.github/workflows/security.yml` runs gitleaks 8.30.1 over the full history on push, pull request and a weekly schedule. The binary is a release archive verified against its published SHA-256 before execution, so a compromised download cannot run as CI. `.gitleaks.toml` keeps the default ruleset and allowlists only three historical test fixtures by their exact line text — no path exemption, so a real key committed to a test file is still caught. The few inline exemptions the current tree needs (deliberately realistic fake keys in the Docker/Archil/provider-error tests, and the build script's `id=…,env=…` secret references, which contain no value) are local to their line and must carry a fixed justification, enforced by `tests/security-gates.test.ts`, so the config allowlist never grows a pattern that could hide a real secret. Verified on 2026-10-21 against this checkout: the published SHA-256 matches the downloaded Linux archive, `gitleaks 8.30.1` reports no leaks over the full 67-commit history, the `dependency-review-action` pin resolves to its `v5.0.0` tag upstream, and a full `jest --coverage` run passes 68 suites / 3,087 tests at 88.4 % statements, 80.7 % branches, 89.79 % functions and 89.52 % lines — above the 85/75/85/85 floor. The gates are configuration in the working tree; the GitHub-hosted run stays unobserved until these workflow files are committed.
- **Dependency review.** A pull-request job runs `actions/dependency-review-action` v5.0.0 (commit-pinned) with `fail-on-severity: high`. The workflow's token is `contents: read`; the action writes its result to the job summary (`comment-summary-in-pr: never`) instead of needing a pull-request scope.
- **Dependabot.** Weekly npm and `github-actions` updates, minor/patch grouped, majors excluded as deliberate upgrade windows (SEC-25). Dependabot's security-update channel is separate and remains enabled.
- **SAST.** `eslint-plugin-security` runs inside the required lint step and fails on dynamic `eval`, child processes, non-literal `require`, `Buffer` without assertions, and `pseudoRandomBytes`; unsafe-regex is reported as a warning because it is heuristic (SEC-19 tracks the classifier cost). `tests/security-gates.test.ts` proves the wiring by linting a real dynamic `eval` through the project config and asserting the rule fires.

The honest limit: this is pattern-based SAST plus supply-chain gates, not whole-program taint analysis. CodeQL is not used because SARIF upload requires `security-events` repository scope, which the workflow least-privilege guard (`tests/workflow-pinning.test.ts`) forbids; adding it would need an explicit policy exception and a second review. GitHub's native secret scanning and push protection remain repository settings, not code — the gitleaks job is the code-level equivalent, and neither replaces rotating a credential that was actually exposed.

### 4.13 SEC-18 — no plaintext medical record, in any mode

Before, `encryptRecordLine` returned the payload unchanged whenever `RECORD_ENCRYPTION_KEY` was unset and the process was in pilot mode. Pilot is the default, so a deployment that enabled `HEALTH_DATA_COLLECTION_DISABLED=false` without also configuring a key wrote the visitor's date of birth, conditions, medications and canonical ICD-10 refs into `lead-records.jsonl` as JSON — exactly the sensitive data a backup or disk snapshot exposes.

After, the exception is gone for health data, enforced at two layers:

- **The route refuses.** `/api/consent` checks `isRecordEncryptionConfigured()` as soon as the request carries a medical payload and returns `503 Secure storage unavailable` before canonicalization or any record creation. A contact-only submission is unaffected, so the refusal is specific to the sensitive payload rather than to the endpoint.
- **The writer refuses independently.** `LeadRecord.medical_profile !== null` is reported to the encryption boundary as `{ requireEncryption: true }`, which throws instead of falling back to plaintext. `persistLeadRecord` catches that as a failed write, so `saveLeadRecord` resolves `false` and the route would answer 500 rather than acknowledge a record it did not encrypt — a defence for any other caller.

What this does not do: migrate records already written in clear by an older pilot build. `npm run records:rekey` (SEC-15) encrypts existing plaintext logs under the current key in any mode, and is the step to run against a pilot volume that has medical rows. Retention and backup expiry remain operator tasks ([data-lifecycle-runbook.md](./data-lifecycle-runbook.md)).

Tests in `tests/medical-record-encryption.test.ts`: the 503 refusal stores nothing, a contact-only submission still succeeds, a stored medical lead is an authenticated envelope whose raw line contains neither the conditions, the medications nor the contact email, and the boundary's `requireEncryption` throws in pilot mode while the ordinary plaintext fallback still works for a non-medical payload.

---

## 5. Pillar assessments

### 5.1 Security, privacy and compliance

**What is genuinely strong.**

- **Data minimisation is enforced, not documented.** Direct identifiers are blocked before the model call by a gate independent of the health classifier, precisely because the classifier returns one category and health outranks PII (`src/app.ts:792`). That is a subtle, correct design decision.
- **History redaction is correct.** Every blocked category writes a placeholder, not the message; assistant history stores only `assistant_message` (`src/app.ts:1044`). Verified by reading the route in order.
- **Consent is server-authoritative.** `currentState` and `medicalConsentAffirmative` are absent from the request schema; `getVerifiedContactConsent` re-derives channel, version, timestamp, and hash from the durable record and rejects a superseded version.
- **Side-effect authorization is the best part of the codebase.** The model's `slot_id`, `lead_data`, idempotency key, and consent block are all discarded; only stored facts are used (`src/tools/verified-actions.ts`). Check-and-set in `bookSlot` is synchronous, so interleaving cannot double-book on one instance.
- **Writes fail closed.** `appendJsonlLine` resolves `false` on any I/O failure and the route refuses to acknowledge; serverless without durable storage returns 503 rather than accepting a record into `/tmp`.
- **No XSS surface in the widget.** No `innerHTML`/`insertAdjacentHTML`/`document.write` anywhere; every string goes through `textContent` (`public/widget.js:887`), and every `href` is gated to absolute `http(s)` (`public/widget.js:896`). Session ids use `crypto.randomUUID` (`public/widget.js:635`).
- **Prompt-injection defence is layered**: input regex, evidence delimiters, untrusted-data labels, schema validation, retry-with-feedback, and corpus-overridden citations. No single control is sufficient; the combination is credible.
- **Encryption is real AES-256-GCM** with a per-line 96-bit random IV and an auth tag, not a base64 obfuscation.

**Where it fails.**

- Authorization defaults (§SEC-01), spend control (§SEC-02), and the entire record lifecycle (§SEC-03, SEC-06, SEC-08) are the failures. They are not bugs in a function; they are missing subsystems.
- The privacy notice's retention sentence is a promise the software cannot keep. That is the highest-liability sentence in the repository.
- Medical data is no longer writable in plaintext in the default (pilot) mode: a consented medical profile requires the key and is refused otherwise (§SEC-18, closed).
- The unauthenticated DSR's authority to suppress a lead inverts the consent model: consent requires proof, suppression does not.

**Compliance mapping.**

| Obligation | Status | Evidence |
|---|---|---|
| TDPSA access/correction/portability | **Intake only** | `POST /api/dsr` accepts and stores; no export, no correction path |
| TDPSA deletion | **Not implemented** | no erasure function; `clearAll*` are test-only |
| TDPSA 45-day response | **Acknowledged, untracked** | SLA constant returned to caller; no status transition or tickler |
| GLBA safeguards (encryption at rest) | **Conditional** | AES-GCM when `RECORD_ENCRYPTION_KEY` is set; required for production and for any medical payload (SEC-18) |
| TCPA consent proof | **Partial** | version + timestamp + SHA-256 of copy, but a channel-less record is accepted (§SEC-07) |
| TDI licence display (§541.003) | **Pass** | placeholder never served; production boot refuses without a real number (`src/app.ts:487-500`) |
| Advertising review gate | **Pass** | `FREE_OFFER_MARKETING_APPROVED=false` blocks free-offer phrasing with retry |
| Crisis escalation | **Pass** | deterministic response before any model call (`src/app.ts:676`) |

### 5.2 Architecture and code quality

- **Layering is better than the file count suggests.** Routes → orchestrator → llm-client → provider; policy modules are pure and testable; the state machine is separate; persistence is behind a small interface (`jsonl-log.ts`) with an Archil adapter. There is real separation of concerns at the module level.
- **`src/app.ts` is a monolith.** 1,566 lines, 19 routes, and a ~500-line `/api/chat` handler that performs validation, safety classification, page-context persistence, state transition, orchestration, DIME computation, card resolution, tool execution, history writes, and latency reporting. Extract a `ChatService` and 4–5 route modules; the handler should be ~80 lines.
- **`security-controls.ts` is 2,705 lines with at least six responsibilities**: prompt-injection detection, retrieval sanitisation, the health-condition vocabulary, PII/financial classifiers, the kill switch, and two rate limiters. Split into `detection/`, `rate-limit.ts`, `kill-switch.ts`. The 1,000-term vocabulary belongs in data, not code.
- **Duplicated response scaffolds.** The 60-line `lead_data`/`consent`/`dime_estimator`/`analytics` literal appears four times (`src/app.ts:305`, `src/app.ts:634`, `src/llm/orchestrator.ts:358`, `src/llm/orchestrator.ts:414`). A single `emptyScaffold()` helper removes ~180 lines and the risk of drift when a field is added (the `dime_estimator` block was clearly added by copy-paste).
- **Data-as-code.** `condition-crosswalk.ts` is 5,312 lines, `golden-set.ts` 2,161, `context-family-terms.ts` 1,064. They are well-commented and test-locked, but they inflate compile time and make review impossible. Move to versioned JSON with a schema and a loader (the project already does this for `phenome/ptsd-phenome-map.json`).
- **Decorative invariants.** `SCHEDULING_RULES` and `confirmOnlyAfterDownstreamSuccess` are never called (§SEC-24). This is worse than absent: it misleads the next engineer.
- **Types are strong.** Zod at both boundaries, inferred types, `unknown` narrowing in the error handler, no `any` in the reviewed paths. `tsc --noEmit` is clean.
- **Error handling is good.** A terminal handler converts body-parse failures to a small JSON 400 and never leaks stack traces; a JSON 404 replaces Express's HTML page.

### 5.3 Performance and scalability

| Observation | Measurement | Assessment |
|---|---|---|
| Widget payload | 68,073 B raw, 19,565 B gzip | Too large for an embed and served uncompressed |
| Static caching | `max-age=0` (Express default) | Revalidation on every navigation |
| Classifier latency | 32 ms on 2 KB benign text; 13.5 ms on digits | Multiplies with SEC-02 into a CPU DoS amplifier |
| JSONL writes | Streamed, non-blocking | Good |
| JSONL reads | Full-file stream at boot; O(n) scan on cache miss | Correct, but boot memory grows with history |
| Caches | Bounded LRUs (5,000 sessions/leads/DSRs, 2,000 appointments, 10,000 limits) | Good ceiling; eviction changes semantics (§SEC-06) |
| LLM call | 10 s timeout, 2 attempts, circuit breaker, no backoff | Correct shape; add jittered backoff before the retry |
| Chat handler | Synchronous classification + retrieval, then one network call | Fine for pilot traffic |
| Multi-instance | Sessions, limits and the consent negative-cache are process-local; bookings are durable slot claims | Sessions cannot span instances; bookings can |

The honest scalability statement: this is a **single-instance pilot architecture**. Session state, rate limits and the consent negative cache are per process, so behaviour on two instances is incorrect for those (bookings are now arbitrated by durable claims). Vercel's serverless path deliberately disables side effects, which is the right call — but it also means the deployed product cannot capture a lead at all unless Archil or a durable store is configured.

### 5.4 Testing and DevOps

**Strengths**

- 2,983 tests across 56 suites, 89.99 % lines / 81.77 % branches, all passing in 27 s. That is a serious suite.
- The tests target the *invariants*, not the implementation: `tests/verified-actions.test.ts` (575 lines), `tests/medical-condition-gate.test.ts` (2,334), `tests/gate-road-test.test.ts` (4,796) with pinned classification rows, `tests/server-hardening.test.ts`, `tests/key-entropy.test.ts`, `tests/ci-pinning.test.ts` and `tests/workflow-pinning.test.ts` (the workflows are themselves under test).
- Determinism work is unusual and welcome: `tests/setup/isolate-secrets.ts` keeps a developer `.env` out of assertions, and `tests/setup/loopback-listen.ts` pins ephemeral listeners to `127.0.0.1`.
- CI is SHA-pinned, least-privilege (`contents: read`), runs lint, format, typecheck, build, tests with coverage on Node 22 and 24, and a separate `npm audit` job. The deploy workflow validates secrets before building, pins `vercel@64.7.0`, syncs secrets over stdin, and smoke-checks `/health` and `/widget.js`.

**Gaps**

- No SAST (CodeQL/Semgrep), no secret scanning, no `dependency-review-action` on PRs, no Dependabot — the supply chain is audited only at install time.
- No coverage threshold; coverage is uploaded as an artifact and can silently regress.
- Functional browser tests are still thin. The widget's behaviour runs through a hand-written DOM shim (`tests/helpers/dom-shim.ts`), but the accessibility gate (`npm run a11y:e2e`) now renders the demo in Chromium and runs axe-core there, so computed styles and the rendered accessibility tree are covered. Real focus order behind `:focus-visible`, screen-reader speech and visual regression remain manual.
- No load/soak test for the classifier and rate limiter under adversarial input.
- No test that the *deployed* posture is fail-closed (the SEC-01 test above).
- `workflow_run` deploy has no GitHub Environment protection or required reviewer; a compromised `main` ships automatically.

### 5.5 UI/UX and accessibility

The widget is the most carefully built artefact in the repository.

**Verified strengths**

- **Semantics**: `role="dialog"` named by the visible title via `aria-labelledby`; **non-modal by design** (no `aria-modal`, no focus trap) with a comment explaining that a trap would violate 2.1.2 — a correct call for an embed that must not trap a visitor inside a chat.
- **Announcements**: one `role="log"`/`aria-live="polite"` transcript, with the redundant `aria-live` on the container removed to stop NVDA/JAWS double-announcing. Errors use `role="alert"`; the typing indicator pairs a visual ellipsis (`aria-hidden`) with a visually hidden "Assistant is typing" so the pending state is spoken (`public/widget.js:852-861`).
- **Keyboard**: launcher is a real `<button>` with `aria-expanded`/`aria-controls`; Escape closes; focus returns to the launcher; the transcript is reachable (`tabindex="0"`); the slot picker is a `radiogroup` with roving `tabindex`, arrow keys, and `aria-checked` (`public/widget.js:1165-1250`).
- **Language and non-colour cues**: the widget root declares `lang="en"` so a screen reader does not read English copy in a Spanish host page's voice (`public/widget.js:361`); every message carries a visually hidden "You said / Assistant said" attribution so the transcript survives CSS-off and forced-colours modes (`public/widget.js:838-850`); the selected time uses weight + an inset band, not colour alone (WCAG 1.4.1, `public/widget.js:264-271`); a `forced-colors: active` block restates every focus ring as a system-colour outline (`public/widget.js:330-343`).
- **Labelling**: a visually hidden `<label for>` on the input, `aria-describedby` pointing at the privacy banner, `autocomplete="off"`, `enterkeyhint="send"` (`public/widget.js:528-544`).
- **Colour**: every pair is documented with a recomputed ratio; the body text is 14.1:1, the red headline 4.735:1 on the slate background (passes AA), the green button is 9.1:1 with white text. Focus rings are chosen per surface because one colour cannot reach 3:1 on both (`public/widget.js:104-125`).
- **Targets and motion**: 24×24 CSS px minimum on every control (WCAG 2.2 AA, 2.5.8); `prefers-reduced-motion` collapses animations (`public/widget.js:154-160`).
- **No layout thrash**: styles are injected once, `min-width:0` on the input lets the row fit 320 px, and the panel is sized in `rem`/percentages.
- **Reduced-data honesty**: citations are labelled "Sources" in a named group; cards fail closed to no card; disclaimers are attached to every card.

**Gaps**

- **Automated accessibility gate — closed, including the dark host context.** `npm run a11y:e2e` renders `/demo.html` in Chromium and runs axe-core over the closed launcher and the open panel, failing on any serious or critical violation. It then applies a coherent dark host theme and rescans the open widget. That third scan is guarded the same way as the others: it asserts the page background actually changed to the theme colour and the launcher kept its own fill, so a stylesheet that silently failed to apply, or one that leaked through the shadow boundary, fails the gate instead of passing it. It refuses to pass unless axe inspected widget nodes (a skipped shadow tree would otherwise look green) and it injects an unlabelled image first to prove the same pipeline still reports a violation. CI runs it as its own job. The widget keeps its light palette in both contexts by design; what is proved is that a dark surrounding page neither inherits into it nor hides its contrast failures.
- **Host-page CSS can override the widget — closed.** The widget now renders into an open shadow root attached to one unstyled light-DOM host, with its stylesheet inside the boundary; a theme's class or element selector no longer matches its internals. Inherited properties (font, colour, letter/word spacing, `text-transform`, `white-space`) are reset at `.lpp-chat-root` with `all: initial` and then re-declared, so a host `body { font-size: 40px }` cannot reach the panel either. Verified in Chromium against `/demo.html` with a hostile stylesheet: a light-DOM button took `font-size: 9px !important` and `letter-spacing: 20px !important`, while the widget's launcher, buttons and input stayed at 14/12/15 px with normal spacing. Locked by `tests/widget-accessibility.test.ts` (host/shadow structure and the reset rule). Browsers without `attachShadow` keep a light-DOM fallback and therefore the old exposure.
- **Disclaimer text is 0.6875 rem (11 px).** Not a WCAG failure for non-essential text, but a readability and 508 usability concern; 0.75 rem is the practical floor.
- **No screen-reader or high-contrast verification.** The forced-colours block covers focus rings and the selected slot retains a weight cue, but only a manual pass in NVDA/JAWS/VoiceOver and Windows High Contrast can confirm the result; the code is stronger than the evidence for it.
- **Demo page has no `<main>` landmark problem** (it does have one), but neither the demo nor the widget documents a skip link; irrelevant for a non-modal widget.

**Typography and layout**: 0.9375 rem input/body, 0.875 rem controls, 0.75 rem metadata, 1.4–1.5 line-height, 8/12/16 px spacing rhythm, flex rows with `min-width:0`, and a 320 px floor. This is coherent and responsive. The one inconsistency is the 0.6875 rem disclaimer noted above.

---

## 6. File-by-file register

### 6.1 Application source (55 files)

| File | LOC | Role | Verdict |
|---|---|---|---|
| `src/app.ts` | 1,566 | Express app, 19 routes, all safety gates inline | **Refactor.** Correct gates, monolith handler. SEC-01, SEC-02, SEC-07 live here |
| `src/index.ts` | 289 | Startup gates, preflight, listener, signals | **Good.** Fail-fast gates; pilot default, with medical writes gated by SEC-18 (closed) |
| `src/runtime-status.ts` | 20 | Writable-data-path flag for `/health` | Fine |
| `src/config/app-config.ts` | 381 | Single config surface + origin matching + ephemeral check | **Good.** SEC-01/09/11 anchors |
| `src/config/secret-gate.ts` | 601 | Pre-deploy secret/licence shape validation | **Strong.** Values never printed |
| `src/config/secret-gate-cli.ts` | 106 | CLI wrapper, exit codes | Fine |
| `src/schema/request-schema.ts` | 123 | Zod for chat/consent/slot | **Good.** SEC-07 anchor |
| `src/schema/response-schema.ts` | 457 | Zod response contract + cross-field rules + static fallback | **Strong.** The real output guard |
| `src/prompts/system-prompt.ts` | 588 | Hardened policy prompt | Reviewed; no secrets |
| `src/llm/llm-client.ts` | 309 | Provider call, timeout, retry, breaker, JSON extraction | **Good.** SEC-05 anchor; add backoff |
| `src/llm/orchestrator.ts` | 484 | RAG → prompt → validate → retry → fallback | **Strong.** SEC-05/12/22 anchors |
| `src/llm/session-store.ts` | 446 | Bounded session LRU, 20 turns, 30-min TTL | **Good.** Process-local |
| `src/security/security-controls.ts` | 2,705 | Injection, PII, health vocabulary, kill switch, rate limits | **Split.** Six responsibilities, 32 ms classifier |
| `src/security/context-qualified-terms.ts` | 716 | Data-driven term registry | Good, but data-as-code |
| `src/security/context-family-terms.ts` | 1,064 | Family/possessive term registry | Good, data-as-code |
| `src/security/ordinary-sense-shapes.ts` | — | Ordinary-sense exclusions | Good |
| `src/medical/condition-crosswalk.ts` | 5,312 | ICD-10-CM vocabulary + resolver | **Move to JSON.** Test-locked, unreviewable |
| `src/medical/condition-screening.ts` | 413 | Candidate screening | Fine |
| `src/medical/condition-coverage-sweep.ts` | 597 | Coverage sweep over candidate sources | Fine |
| `src/medical/condition-coverage-sweep-cli.ts` | 1 | Re-export CLI entry | Fine |
| `src/phenome/phenome-map-schema.ts` | 972 | Phenome map schema/validation | Fine |
| `src/phenome/sequelae-crosswalk.ts` | 571 | Sequelae mapping | Fine |
| `src/phenome/ptsd-phenome-map.json` | — | Versioned data | **The right pattern** |
| `src/privacy/record-encryption.ts` | 250 | AES-256-GCM envelope with `kid` + legacy key ring | **SEC-15 and SEC-18 closed** |
| `src/privacy/dsr.ts` | 261 | DSR intake + cache + log lookup | **Incomplete.** No fulfilment (SEC-03) |
| `src/consent/consent-model.ts` | 565 | Lead record, validation, verified consent | **Strong.** SEC-07 anchor |
| `src/persistence/jsonl-log.ts` | 164 | Streamed append/read/find, Archil switch | **Strong.** Non-blocking, fail-closed |
| `src/persistence/bounded-lru.ts` | 80 | Bounded LRU | Fine; eviction semantics matter |
| `src/scheduling/appointment-slots.ts` | 330 | Slot grid, verification, booking ledger | Durable slot claims; SEC-14 closed |
| `src/tools/tool-controls.ts` | 262 | Allowlist, argument sanitisation, redaction | **Good**, but SEC-24 decorative rules |
| `src/tools/verified-actions.ts` | 352 | Consent/slot/booking authorization | **Best-in-class**; SEC-04/06 anchors |
| `src/state-machine/state-machine.ts` | 320 | Conversation transitions | Good |
| `src/rag/retrieval.ts` | 1,106 | In-memory corpus + scoring + sufficiency | Good; `formatRetrievedContext` unsanitised (SEC-22) |
| `src/rag/rag-architecture.ts` | 174 | Architecture constants/docs | Fine |
| `src/resilience/fallback-behavior.ts` | 166 | Circuit breaker, latency budget, fallback copy | Good; add backoff/jitter |
| `src/cards/card-library.ts` | 495 | Approved card content | Good (content is app-owned) |
| `src/cards/card-validation.ts` | 142 | Card id/state validation | **Strong** fail-closed |
| `src/contextual/page-context.ts` | 110 | Untrusted page context validation | Good; blocklist, not allowlist |
| `src/contextual/context-injection.ts` | 100 | Mapping → allowlisted data block | **SEC-12 closed** |
| `src/contextual/article-map.ts` | 115 | URL → allowlisted article | Good |
| `src/analytics/analytics.ts` | 194 | Events, `sanitizeUrl` (query stripped) | **Good PII control** |
| `src/analytics/abstention-log.ts` | 153 | SHA-256 question hash, category only | **Strong** privacy design |
| `src/evaluation/evaluation-plan.ts` | 299 | Evaluation plan | Docs-as-code |
| `src/evaluation/golden-set.ts` | 2,161 | 250-sample golden set | Data-as-code; large |
| `src/evaluation/persona-guardrail-gate.ts` | 95 | CLI gate | Fine |
| `src/evaluation/verdict-gate.ts` | 306 | Retrieval/policy regression gate | Fine |
| `src/compliance/classification-matrix.ts` | 269 | Flow → classification/approval | Good compliance artefact |
| `src/compliance/persona-guardrails.ts` | 126 | Presumptive/pressure/fabrication detection | Good; output-side only |
| `src/handoff/human-escalation.ts` | 187 | SLA, crisis copy, handoff summary | **No delivery mechanism** (SEC-04 family) |
| `src/estimator/dime-estimator.ts` | 187 | Deterministic DIME range | **Strong** (model never emits figures) |
| `src/accessibility/accessibility.ts` | 1,284 | Accessibility constants/receipts | Docs-as-code |
| `src/accessibility/accessibility-checklist.ts` | 234 | Checklist model | Fine |
| `src/accessibility/accessibility-checklist-cli.ts` | 171 | CLI | Fine |
| `src/testing/flake-harness.ts` | 467 | Flake reproduction harness | Good engineering hygiene |
| `src/testing/flake-harness-cli.ts` | 103 | CLI | Fine |
| `src/archil/disk.ts` | 181 | Archil S3-compatible storage adapter | Reviewed; credentials from env only |

### 6.2 HTTP surface, public assets, build and deploy

| File | Verdict |
|---|---|
| `api/index.ts` | Thin Vercel adapter; `SERVERLESS` guard is correct |
| `vercel.json` | `framework: null`, rewrite `/api/:path*`, HSTS plus document CSP and static cache rules for the three public files (§SEC-16, closed) |
| `public/widget.js` (1,713) | **Strong.** No HTML sinks, safe `href` allowlist, crypto session ids, excellent ARIA; too large/uncompressed |
| `public/demo.html` | Correct `lang`, viewport, single `main`, `h1`; no CSP |
| `public/elementor-trust-block.css` | Static trust styling; no user data |
| `Dockerfile` | Multi-stage, BuildKit secrets, non-root `node`, pruned prod deps — **strong** |
| `scripts/sync-vercel-secrets.sh` | Sends values on stdin, logs name + length only |
| `package.json` / `package-lock.json` | 5 runtime deps; clean audit; majors lag (SEC-25) |
| `tsconfig.json` | `strict`; clean compile |
| `eslint.config.mjs` | Flat config, typescript-eslint; clean |
| `jest.config.js` | ts-jest, node env, seeds isolated; global coverage floor at 85/75/85/85 (§SEC-17, closed) |
| `vercel.json` | No `regions`, no function memory/timeout tuning |
| `.env.example` | Honest, well-commented; offers the wildcard CORS pattern (SEC-09) |
| `.gitignore` | Correct: `.env`, `data/`, `dist/`, `coverage/`, `.vercel/` |
| `.dockerignore` | Keeps `.env`, `data`, tests out of the image |
| `.prettierrc.json`, `.prettierignore` | Standard |
| `.github/workflows/ci.yml` | SHA-pinned, least privilege, 3 gates — **strong**; SAST now runs in its lint step (§SEC-17) |
| `.github/workflows/deploy.yml` | Secret completeness gate, pinned CLI, smoke check — **strong**; no environment protection |

### 6.3 Tests (55 files)

| Suite | LOC | What it locks |
|---|---|---|
| `api-endpoints.test.ts` | 2,463 | Route contracts, auth, CORS, 404/error shapes |
| `gate-road-test.test.ts` | 4,796 | Pinned classification rows for the health/PII gate |
| `medical-condition-gate.test.ts` | 2,334 | Every gate term, exclusion, and scope |
| `condition-coverage-sweep.test.ts` | 1,231 | Every candidate mapped or explicitly gated |
| `condition-crosswalk.test.ts` | 1,076 | ICD-10 resolution and spelling parity |
| `widget-accessibility.test.ts` | 1,049 | Roles, labels, focus, keyboard, live regions |
| `condition-screening.test.ts` | 785 | Screening decisions |
| `context-family-terms.test.ts` | 670 | Family/possessive registry |
| `security-detection.test.ts` | 666 | Injection/PII/financial classifiers |
| `state-machine.test.ts` | 662 | Transitions and guards |
| `schema-validation.test.ts` | 572 | Request/response Zod contracts |
| `verified-actions.test.ts` | 575 | Consent/slot/booking authorization |
| `vercel-secret-sync.test.ts` | 506 | Deploy script behaviour |
| `widget-scheduling.test.ts` | 517 | Slot picker behaviour |
| `dsr.test.ts` | 480 | DSR intake, encryption, lookup |
| `lead-persistence.test.ts` | 351 | Encrypted lead writes, reload |
| `server-hardening.test.ts` | 345 | Headers, proxy, malformed bodies |
| `orchestrator.test.ts` | 345 | Validation, retry, fallback |
| `flake-harness.test.ts` | 320 | Harness correctness |
| `record-lookup-reload.test.ts` | — | Cache-miss disk lookup |
| `session-store.test.ts` | 285 | TTL, bounds, clear |
| `verified-actions-api.test.ts` | 291 | Same guarantees through HTTP |
| `safety-wiring.test.ts` | 287 | Gate ordering in `/api/chat` |
| `secret-gate.test.ts` | 261 | Placeholder/weak-secret rejection |
| `workflow-pinning.test.ts` | 226 | Actions SHA-pinned |
| `abstention-log.test.ts` | 206 | Hash-only, category-only |
| `request-contract.test.ts` | 302 | Unknown-key stripping |
| `dime-estimator.test.ts` | 249 | Deterministic ranges |
| `serverless-mode.test.ts` | 166 | No listen, 503 on ephemeral storage |
| `medical-gating.test.ts` | 182 | Phase-2 flag off by default |
| `pii-gate.test.ts` | 177 | Identifier blocking |
| `visual-cards.test.ts` | — | Card validation/fail-closed |
| `widget-scheduling-e2e.test.ts` | 388 | Widget → API → booking |
| `contextual-bridge.test.ts` | 381 | Page-context validation |
| `persona-guardrails.test.ts` / `persona-guardrail-gate.test.ts` | — | Style/pressure/fabrication |
| `verdict-gate.test.ts` | — | Retrieval regression |
| `ci-pinning.test.ts` | 102 | Workflow permissions/pins |
| `key-entropy.test.ts` | — | 32-char floors |
| `loopback-listen.test.ts` / `loopback-bind.test.ts` | 113/53 | 127.0.0.1 binding |
| `app-startup-split.test.ts` | 134 | Import ≠ listen |
| `persistence.test.ts`, `phenome-*.test.ts`, `ordinary-sense-shapes.test.ts`, `condition-spelling-variants.test.ts`, `contract-register.test.ts`, `llm-client.test.ts`, `llm-probe.test.ts`, `archil-disk.test.ts`, `accessibility-checklist.test.ts`, `rag-retrieval.test.ts`, `evidence-document-ingestion.test.ts` | — | Focused module locks |

**Fixtures/helpers**: `contract-register.ts` (679) is an executable endpoint contract; `dom-shim.ts` (452) is a hand-built DOM — useful, but not a browser; `temp-log.ts`, `test-session.ts`, `supertest-loopback.ts` are clean, deterministic helpers.

### 6.4 Documentation (10 Markdown + 13 data files)

| File | Verdict |
|---|---|
| `privacy-notice.md` | Legally careful; §8 promises deletion the software cannot perform (SEC-03) |
| `compliance-classification-matrix.md` | Excellent; explicitly marks retention `counsel_approved` |
| `verified-actions.md` | Honest "known limitations"; omits that no confirmation is actually sent |
| `sandbox-deployment.md` | Accurate operational runbook; backup/rotation manual |
| `section-508-accessibility-review.md` | Detailed, with a receipt JSON; not machine-verified |
| `lovable-migration-readiness-audit.md` | Good integration analysis; recommends wildcard CORS (SEC-09) and flags TRUST_PROXY |
| `medical-lead-capture-phase2.md` | Unusually rigorous release ledger |
| `ai-chatbot-persona-configuration.md`, `phenome-mapping-rules.md`, `transcripts-style-recommendations.md` | Policy/reference material |
| `accessibility-matrix-receipt.json` | Recorded contrast/focus measurements |
| `medical-condition-candidates-*.txt` (11 files) | Candidate sources for the sweep; no PII |

---

## 7. Strategic action plan

### P0 — before any public traffic (today)

- [x] **SEC-01 / C-01** (corrected 2026-10-22) Deny-by-default admin auth: no key means 503 in every mode, including pilot. The 2026-10-21 entry was wrong — the pilot bypass was still present and reproduced as C-01. Regressions cover keyless pilot access, the kill switch, lead export, and a non-loopback request (`p0-security-regressions.test.ts`).
- [x] **SEC-02** Per-client (IP) + process-wide chat budget; tokens counted against session, client, and global budgets. The churn test sends 31 distinct session ids from one client and gets a 429 on the 31st.
- [x] **SEC-05** Provider error bodies stripped from `lastError`; only status + provider request id are logged. Covered at the client and orchestrator layers.
- [x] **SEC-04** `send_transactional_confirmation` always refused; the route correction note is asserted through `/api/chat`.
- [x] **SEC-06** `DsrRecord.verified` + operator-only `POST /api/dsr/:requestId/verify`; suppression requires `verified === true`. Both directions tested.
- [x] **SEC-07** `/api/consent` requires `contactChannel` and a non-empty value for it; channel-less records are a 400.
- [x] **C-02** (2026-10-22) The route replaces the model's `state`, `lead_data`, and `consent` with server facts: the persisted session state, the verified consent record, and configured versions. A forged-envelope regression proves an asserted contact/medical consent, invented email, attached medical profile, or chosen state cannot reach the client.
- [x] **C-03** (2026-10-22) `/api/consent` compares the submitted text with the canonical email or phone copy, rejects a mismatch with 400, and hashes the canonical text. `/api/consent-text` serves both copies. A one-character `consentText` regression is included.
- [x] **C-04** (2026-10-22) `topicCategory` is an allowlist (`src/schema/topic-category.ts`); unknown values become `other` before the response schema, orchestrator, GA4 payload, lead record, or abstention log can see them. An email-injection regression is included.
- [x] **C-05** (2026-10-22) `MEDICAL_CONSENT_VERSION` is server-owned; the route requires an exact match and stores the configured version, never the caller's label. Mismatch and current-version regressions are included.

### P1 — within the week (pilot correctness)

- [x] **SEC-03** `eraseSubject` (verified-deletion authority, rewrite-and-rename with fail-closed decode checks, DSR tombstones, PII-free audit), DSR status transitions (`received → verifying → fulfilled`), operator-triggered retention sweep with dry run, CLI and admin routes, and the [runbook](./data-lifecycle-runbook.md). Tests in `tests/data-lifecycle.test.ts`.
- [x] **SEC-08** Admin-only lead export at `GET /api/admin/leads` (paginated, `limit` ≤ 100, log-backed, fail-closed on undecodable lines, verified-deletion suppression flags, PII-free access audit written before the response). Tests in `tests/lead-export.test.ts`.
- [x] **SEC-11** `DURABLE_STORAGE_CONFIGURED` removed from the guard. A boot probe (`src/config/durable-storage.ts`) writes, reads back and deletes in every record directory, refuses known ephemeral roots and the OS temp dir, falls back to lazy verification when a serverless host imports the app directly, reports `recordStorage` on `/health`, and leaves writes closed on failure. Tests in `tests/durable-storage.test.ts`.
- [x] **SEC-10** `TRUST_PROXY` resolved by `src/config/trust-proxy.ts`: Vercel defaults to one edge hop, everywhere else the safe default stays "trust nothing", `true` is refused (it makes `req.ip` caller-controlled), an unset serverless deployment warns at boot, and the preflight logs the effective value. Two-client bucket test plus wildcard-refusal test in `tests/request-contract.test.ts`.
- [x] **SEC-12** Move page context out of the system role into a delimited user data block (`tests/contextual-bridge.test.ts`).
- [x] **SEC-16** HSTS and a document CSP for the demo origin; `no-cache` HTML, a one-hour revalidating cache for the unversioned widget assets, and gzip/Brotli compression on Node hosts (§4.8; `immutable` would need content-hashed names).
- [x] **SEC-17** Coverage floor (85/75/85/85), checksum-pinned gitleaks over full history, read-only dependency review on PRs, weekly Dependabot, and security rules in the required lint step (§4.12; pattern-based SAST, not CodeQL — see the scope note).
- [x] **SEC-18** A consented medical profile is never written in plaintext: `/api/consent` returns 503 without `RECORD_ENCRYPTION_KEY` in every mode, and the record writer refuses the pilot-mode plaintext fallback for a medical payload (§4.13; `tests/medical-record-encryption.test.ts`).
- [x] **A11Y** Shadow DOM style boundary for the widget, with inherited typography reset at the root and verified in Chromium against a hostile host stylesheet (§5.5; `tests/widget-accessibility.test.ts`).
- [x] **A11Y gate** `axe-core` + Playwright (`npm run a11y:e2e`, CI job `Accessibility Gate`): scans the closed widget, the open widget, and the open widget under a dark host theme, fails on serious/critical violations, and self-checks both that the scan can still detect one and that the dark theme actually applied (§5.5).

### P2 — next sprint (architecture and scale)

- [ ] Extract `ChatService` and route modules from `app.ts`; target < 120 lines per handler.
- [ ] Split `security-controls.ts`; move the condition vocabulary to JSON with a schema and loader.
- [ ] De-duplicate the response scaffold (four copies).
- [ ] Back sessions and rate limits with durable storage before running more than one instance (bookings already use durable slot claims).
- [x] Add `kid`-based key rotation and refuse legacy plaintext in production (SEC-15, §4.11; rotate per runbook §7).
- [ ] Add claim-level output guards (guarantees, currency, percentages, banned claims).
- [ ] Add load tests: 50 rps classification, 10k unique session ids, 1 MB JSONL replay.
- [ ] Wire or delete `SCHEDULING_RULES` and `confirmOnlyAfterDownstreamSuccess`.

### Verification after each fix

```bash
npx tsc --noEmit && npm run lint && npm test -- --silent
npx jest --coverage            # statements ≥ 85, branches ≥ 75
npm audit --audit-level=high
# posture: with PILOT_MODE=false and no ADMIN_API_KEY, every /api/admin and
# /api/session route must answer 503, never 200
```

---

## 8. Limitations of this audit

- **No real deployment was exercised.** Vercel, Archil, a real provider, and the GitHub App were not reachable from this environment. Findings about those paths are code-and-docs based.
- **No real browser or screen reader.** The accessibility assessment is a code and specification review plus the project's own measurements; axe-core and manual AT testing are still required.
- **The working tree is dirty.** 45 modified files were audited as they exist now; `git diff` against `f78ef5f` should be reviewed before merging, particularly `public/widget.js` and `src/app.ts`.
- **Line numbers are working-tree anchors** and will move with refactors.
- **No penetration test was performed** against a running instance; no fuzzing of the Zod schemas or the classifier was run beyond the timing probes.
