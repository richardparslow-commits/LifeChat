# LifeChat — Principal Security, Privacy, Architecture & Accessibility Audit

**Audit date:** 2026-10-22  
**Repository:** `richardparslow-commits/LifeChat` (`/Users/richardparslow/Desktop/LifeChat`)  
**Commit reviewed:** `51ea666` ("Add the SEC-17 supply-chain gates to CI") plus the working-tree changes present at review time  
**Reviewer role:** Principal Security Architect / Lead Full-Stack Engineer / Accessibility Specialist  
**Classification:** Internal — contains no customer data, secrets, or exploit payloads

---

## 0. Verdict at a glance

This is not a naive chatbot. It is a carefully engineered, heavily tested compliance product with real trust boundaries, deterministic gates in front of the model, encrypted legal records, and an accessibility programme that is better than most commercial chat widgets. The risk is therefore **not** pervasive insecurity. It is **a small number of unverified trust boundaries and a fail-open administrative posture**, plus two product-level gaps that make the compliance story stronger on paper than in the shipped UI.

**Verdict: not ready for unauthenticated public traffic.** Ready for a closed, invite-only pilot behind the CI deploy path **after** the P0 items below are fixed. The repository's own 2026-10-21 audit claims SEC-01 is implemented; it is not. That is itself a governance finding.

> **Remediation update — 2026-10-22 (post-audit).** C-01 through C-05 are closed and covered by [tests/p0-security-regressions.test.ts](../tests/p0-security-regressions.test.ts): admin routes answer 503 without a key in every mode, including a non-loopback request; the response envelope is server-authored; consent is compared against and hashed from the canonical per-channel copy; `topicCategory` is allowlisted; and the medical consent version is server-owned. The prior audit's status table has also been corrected.
>
> **Remediation update — 2026-10-23.** C-06 is also closed, covered by [tests/state-machine-wiring.test.ts](../tests/state-machine-wiring.test.ts). The model returns a schema-validated `intent` block (value delivered, clarification needed, interest, explicit contact request, qualification agreement, decline); the route resolves the prompt state from application-verified facts, then computes and persists the next state from that intent after the response and any side effect are handled. `LOOP_CONTROLS` are enforced in the session store: two failed clarifications hand off, a fourth qualification question is refused, and a declined offer suppresses automatic re-offers while an explicit contact request still reopens contact. The model's own `state` is still never persisted.
>
> **Remediation update — 2026-10-23 (C-08).** The shipped widget now carries the consent/contact step and a TDPSA request route. **Talk to a licensed broker** fetches the canonical disclosure from `/api/consent-text` (and keeps submission disabled if it cannot), posts the affirmed copy to `/api/consent`, and the lead is bound to the conversation's session; **Privacy request** posts to `/api/dsr` and shows the server's request id and response window. The forms use native labels, a named channel group, `status`/`alert` announcements, focus moved to the result, and a fresh copy on channel change. Covered end to end (chat refusal → consent → `/api/admin/leads`, and DSR → `/api/dsr/:id`) in [tests/widget-contact-e2e.test.ts](../tests/widget-contact-e2e.test.ts), with the accessibility contract in [tests/widget-accessibility.test.ts](../tests/widget-accessibility.test.ts) and both forms added to the real-browser axe scan (`npm run a11y:e2e`). With C-06 and C-08 closed, the pilot blockers in this report are cleared; the M-items remain scale/operational work.
>
> **Remediation update — 2026-10-23 (C-07).** Consent lookup is now index-first. `/api/consent` writes a derived, PII-free line (`session_id`, `lead_id`, `created_at`) to `LEAD_SESSION_INDEX_PATH` (default: the lead log's path with a `-session-index` suffix), and a chat turn resolves the session from that file instead of decrypting the log; a session with no record is answered from memory. The index is rebuilt from the lead log when it is missing or older than the log (an append that did not land), and forcibly after erasure/retention rewrites, so a deleted session stops resolving. Boot hydration and the operator export stream the log line by line (`forEachJsonlLine`) instead of collecting it, and `npm run records:index-sessions` rebuilds or repairs the index. Measured here with synthetic encrypted records: the old full-log scan was 29 ms at 3,397 records and 738 ms at 100,000; an indexed lookup is 0.07–0.13 ms, and rehydrating a 50,000-session index at boot is 24 ms. Covered by [tests/session-index.test.ts](../tests/session-index.test.ts): index purity, a restart lookup that opens no lead log, missing/stale index repair, erasure dropping the mapping, and a 50,000-entry lookup under 50 ms.
>
> **Remediation update — 2026-10-23 (M-01).** Test record paths are isolated. `tests/setup/record-paths.ts` gives every test file a private directory under `os.tmpdir()` for the lead log, session index, DSR, lead-access, erasure and abstention logs, registered in `jest.config.js` before any test module. The hardening and serverless suites no longer point their overrides at `data/`, and [tests/record-path-isolation.test.ts](../tests/record-path-isolation.test.ts) guards the property: every resolved store must be outside the repository, a real lead and DSR write must leave `data/` unchanged, and any test that assigns a record-path variable back into `data/` fails the suite. A full run now leaves `data/` byte-for-byte unchanged, so the C-07 index no longer grows with synthetic records.
>
> **Remediation update — 2026-10-23 (M-02).** The public `GET /health` now returns only `{ status, uptimeSeconds, killSwitch }`. The readiness posture — model and provider endpoint, record-storage verdict, proxy derivation, record-encryption/admin-key/license booleans and the compliance matrix — moved unchanged to `GET /api/admin/health`, which uses the same admin auth as the other operator routes: 503 when no key is configured, 401 with a wrong one. Tests assert the exact public shape, the fail-closed route, and the gated payload, and the sandbox/deploy scripts read readiness with the admin key (reporting it, never enforcing it).
>
> **Remediation update — 2026-10-23 (M-10, partial).** The vendor-management evidence now exists where it can be produced from this repository, and nowhere else does it pretend to. [docs/subprocessors.md](subprocessors.md) is a register with two halves: a complete data-flow table (the message, recent turns, prompt and passages that go to the model; records that stay local or on Archil; analytics that never leave the browser; logs that go to the host — and the fact that no email/SMS/calendar provider is called at all), and a provider table whose contract, region and retention columns are marked _not on file_ until someone files them. It also explains why there is no `ZERO_RETENTION=true` flag: a boolean would assert a vendor term without evidencing it, the same failure this audit named elsewhere. The privacy notice's §5 now discloses AI processing — what is sent, what is blocked first, and that the register holds the vendor terms — and §8 points provider-side retention at the same register. What remains is not a documentation task: signed DPAs, a confirmed processing region and an enabled zero-retention setting per provider. Until those are filed, the finding stays open, and the register is the checklist that keeps that visible rather than letting a green checkmark imply counsel has seen a contract.
>
> **Remediation update — 2026-10-23 (M-09).** The DSR intake no longer writes free text in the clear. `detail` is offered to consumers precisely so they can paste anything ("my SSN is …", "I was diagnosed with …"), and in pilot mode without `RECORD_ENCRYPTION_KEY` the whole record — that text included — went to disk as plaintext. Now the request is always accepted (a TDPSA intake must not fail because a deployment is misconfigured), but the text is stored only when a key is configured: otherwise it is dropped, the record carries `detail_withheld: true` so the operator knows to ask, and `POST /api/dsr` returns `detailWithheld: true` with a message telling the consumer to email `dsrEmail`. Belt and braces, `persistDsrRecord` refuses any record whose `detail` is non-null on a line that is not an authenticated envelope — so even if encryption silently degrades, the text cannot reach disk. Covered by [tests/dsr.test.ts](../tests/dsr.test.ts) and an endpoint test in [tests/api-endpoints.test.ts](../tests/api-endpoints.test.ts) that forces the keyless path.
>
> **Remediation update — 2026-10-23 (M-08).** The abstention feed no longer stores a plain digest. `question_text_hash` is HMAC-SHA-256 of the normalized question, keyed with `ABSTENTION_LOG_KEY`, and each entry records a 12-hex `hash_key_id` (a prefix of the key's own digest, never the key) so a rotation is visible in the log. Recurrence counting is unchanged — same key plus same question still deduplicates — while a different key yields a different digest, which is also what makes rotation meaningful. When the key is absent nothing is written: the module warns once, the boot preflight reports it, and the editorial feed has a visibly empty day rather than a reversible record. That is the deliberate trade — losing analytics beats keeping a value anyone with the file can compute for "I have HIV". Covered by [tests/abstention-log.test.ts](../tests/abstention-log.test.ts), which asserts the stored hash is not the bare SHA-256, that a second key produces a different digest, and that no key means no file.
>
> **Remediation update — 2026-10-23 (M-06).** Nothing that carried visitor or model text reaches a server log any more. `src/observability/safe-log.ts` is the only way to describe a failure: `describeError` keeps `{name, code, status, type}` and drops `message`/`stack` (Node's `JSON.parse` quotes the offending input, and a body-parser failure quotes the rejected body); `fingerprint` reduces text to `len=<n> sha=<12>`; `safeCode` prints a string only when it matches the code vocabulary; `safeRequestPath` prints a path only when every character is one our routes and opaque ids use. The terminal handler, the lifecycle error path, the lead-export catch and the orchestrator all use them. The client's own leak is fixed at the source: `llm-client` copied `err.message` into `lastError`, which `JSON.parse(rawBody)` could fill with a fragment of the provider's body — that value was logged _and_ returned as `error_code`. It now returns one of `timeout`, `invalid_provider_body`, `network_error[_errno]`. A static gate in [tests/log-redaction.test.ts](../tests/log-redaction.test.ts) scans `src/` for request-path `console.*` calls that pass an error object, a `.message`, or an unreduced `.detail`, and was mutation-checked (an injected `console.error('boom', err)` fails it). The operator CLIs and boot banner print to the operator's own terminal and are the only exceptions, listed in the gate.
>
> **Remediation update — 2026-10-23 (M-05).** Record writes are now crash-durable. `appendJsonlLine` opens the log, appends, `fsync`s the descriptor and closes; when the append created the file it also `fsync`s the parent directory, because a new name is a directory change and a flush of the file alone can leave content on disk that nothing points at. The rewrite path (`replaceJsonlLines`) writes the temp file, `fsync`s it, renames it over the log, then `fsync`s the directory, so a crash cannot leave an empty log where an erased one was or bring the previous version back. Erasure and key rotation had their own copies of that write; both now call the shared helper, so the property is enforced in one place. A directory sync the host cannot do (Windows, some filesystems) is tolerated — there is no stronger primitive to ask for — while a real error still fails the write. Cost measured here: ~5 ms per record append (0.08 ms without the fsync), paid on consent/DSR/booking writes and abstention lines, not on chat turns; the full suite is unchanged at 27 s. The RPO this buys is stated in [data-lifecycle-runbook.md](data-lifecycle-runbook.md#8-durability-and-rpo): nothing for a process crash, at most the in-flight append for a power cut, unless the device drops its own write cache (macOS `fsync` does not request `F_FULLFSYNC`). Pinned in [tests/durable-writes.test.ts](../tests/durable-writes.test.ts), which records every fsynced path through a wrapped `open`.
>
> **Remediation update — 2026-10-23 (M-04).** Every admin read that returns data now writes a PII-free entry to `ADMIN_ACCESS_LOG_PATH` before the payload leaves the process: readiness, system prompt, DSR status, RAG search, session history, and the session count. `src/privacy/admin-access-audit.ts` fixes the shape — `audit_id`, `event: admin_read`, `at`, a route label from `ADMIN_READ_ROUTES`, `record_id`, `actor_key_id` (a 12-hex SHA-256 prefix of the configured key, never the key), and `status`. A path parameter is only recorded when it has the shape of an opaque record id; anything else (an address passed as a session id, a path) is stored as `unrecognized`, and no query string or record content is written. The write happens first and the read is refused with `503 Audit unavailable` when it fails, so an unlogged disclosure is treated like an unauthorised one. `GET /api/admin/leads` keeps its own richer entry in the lead-access log rather than being double-audited. Writing the fail-closed test exposed a second defect in the shared append path: `Writable.end()`'s callback receives the error on a failed open, and `appendJsonlLine` ignored it, so an append to an unwritable path (EISDIR, EACCES) resolved `true` — every store could acknowledge a record the disk never held. It now settles on that argument, pinned in [tests/persistence.test.ts](../tests/persistence.test.ts); [tests/admin-access-audit.test.ts](../tests/admin-access-audit.test.ts) covers the six audited routes, the redaction of a non-opaque id, the 401 that writes nothing, and the 503 with no payload when the log cannot be written.
>
> **Remediation update — 2026-10-23 (M-03).** Each provider attempt now has one deadline that covers the response body: the abort timer is armed before `fetch` and cleared in `finally`, after the body has been read and parsed. The previous code cleared it as soon as the headers arrived, so `response.json()` was unbounded, and a rejected `fetch` leaked the timer entirely. The body is read once with `text()` and parsed, so the error branch and the success branch share the same bounded read. `vercel.json` sets `maxDuration: 45` for `api/index.ts`: two `callLLM` calls (the orchestrator retries once on validation failure) × two 10 s attempts is 40 s, so the platform limit sits above that worst case rather than cutting the retry short. Covered by [tests/llm-client.test.ts](../tests/llm-client.test.ts): the mocked provider sends headers and then stalls, settling only when the abort signal fires, and the call returns its failure within the two attempt deadlines instead of hanging.

### Scorecard

| Pillar        | Grade  | One-line rationale                                                                                                                                                                                           |
| ------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Security      | **B−** | Strong gates, constant-time admin compare, no `innerHTML`, strict CSP; admin auth still fails open in pilot mode and model-authored consent is echoed.                                                       |
| Privacy       | **C+** | AES-256-GCM records, redaction, PII gates; analytics accepts caller free text, consent hash is not bound to approved copy, DSR free text can be plaintext in pilot.                                          |
| Compliance    | **C+** | Consent/DSR artefacts are real and fail-closed at the syscall level; versioned medical consent is client-controlled, retention/backups are manual, and the privacy notice is still a draft.                  |
| Architecture  | **C+** | Clean domain modules and excellent comments; `src/app.ts` is a 1,801-line god-route module and the conversation state machine is effectively disconnected from it.                                           |
| Performance   | **C**  | Session consent is index-backed and flat (C-07 closed); up to 20–40 s of LLM latency per turn remains, and the admin export still reads the whole log per page.                                              |
| Testing       | **A−** | 3,127 tests, 90 % statements / 81.8 % branches, real regression suites; record-path isolation is now enforced (M-01), and the remaining blind spots are the trust boundaries above.                          |
| DevOps        | **B+** | SHA-pinned actions, gitleaks over full history, dependency review, weekly Dependabot, coverage floor, post-deploy smoke; no SAST/CodeQL, no image scan, no deploy approval.                                  |
| Accessibility | **A−** | `axe` 0 serious/critical in closed/open/dark-host scans, 3 px two-tone focus, `role="log"`, focus return, reduced-motion and forced-colors support; mobile keyboard/viewport and screen-reader proof remain. |

**Release blockers (P0):** C-01, C-02, C-03, C-04, C-05.  
**Pilot correctness (P1):** C-06 ✅, C-07 ✅, C-08 ✅ (closed 2026-10-23); C-09, C-10, C-11 open.

---

## 1. Executive risk summary

### 1.1 The five things that matter

1. **Administrative authorization is fail-open by configuration (C-01, CRITICAL).** When `ADMIN_API_KEY` is unset and `PILOT_MODE` is not the literal string `false`, every `/api/admin/*` and `/api/session/*` route returns 200. That includes the full decrypted lead export, DSR verification/erasure, conversation history, the system prompt, and the kill switch. I reproduced this against `createApp()`: `GET /api/admin/leads`, `GET /api/session/:id/history`, `GET /api/system-prompt`, and `GET /api/sessions` all returned **200 with no credential**. The documented sandbox runbook starts the app with `PILOT_MODE=true`, and `.env.example` ships an empty `ADMIN_API_KEY`; the CI deploy path supplies a key, but the application does not enforce that. The 2026-10-21 audit records SEC-01 as implemented; the code says otherwise.

2. **The model owns the response envelope (C-02, HIGH).** `generateResponse()` returns `finalResponse = { ...validated }`, overwriting only `consent.privacy_notice_version`. The model's `lead_data`, `consent` (including `contact_consent_affirmed` and `medical_consent_affirmed`), and `state` are serialized to the browser unchanged. Tool execution correctly re-verifies server-side consent, so this is not an unauthorized side effect; it is an **integrity and compliance** defect: the API can assert consent and a medical profile that no durable record supports, and any downstream client that trusts `lead_data` can create a lead from model output.

3. **The consent artefact does not prove the approved disclosure (C-03, HIGH).** `/api/consent` hashes whatever `consentText` the caller sent and stamps it with the current server version. There is no comparison with `RECOMMENDED_PHONE_CONSENT_COPY` or any canonical email copy. A caller can send `"x"` and receive a record that claims v1.0.0 consent. For a TCPA/TDPSA consent proof, that is the wrong side of the line.

4. **Analytics is not categorical (C-04, HIGH).** `topicCategory` is a free 64-character string from the request body. It flows into the GA4 dataLayer, the response's `analytics.topic_category`, the lead record, and the abstention JSONL (`question_category`). A caller can put an email address or a health phrase there and have it persisted and emitted, contradicting the "no PII in analytics" design claim.

5. **The state machine is not connected to the route (C-06, HIGH — closed 2026-10-23).** `app.ts` calls `getNextState()` with `hasValueBeenDelivered: false`, `userShowsInterest: false`, `queryIsAmbiguous: false`, `userAgreesToQualification: false`, `userRequestsFollowup: false`. Consequently `clarify`, `qualification_offer`, and the ordinary `contact_offer` path are unreachable; `LOOP_CONTROLS` (max 3 qualification questions, no re-offer after decline, clarification limits) is never consulted. The integration tests hide this by seeding the session state directly. The model's `state` is returned to the user but not persisted, so the UI and the server disagree about where the conversation is.

### 1.2 What is genuinely strong

- **Prompt/data separation.** RAG passages, conversation history, page metadata, and the current message are all delivered as `user`-role blocks with explicit "untrusted data" delimiters; the application context and validation feedback are `system` messages. This is better than most LLM apps.
- **Sensitive-data gates.** Health, financial-account, and direct-identifier detection runs before the model, redacts session history, and routes to handoff. The condition vocabulary is broad and test-covered.
- **Fail-closed record writes.** A lead/DSR is acknowledged only after a successful write; a write failure returns 500/503, never a false success. Records are AES-256-GCM envelopes with a key-id ring and a rekey CLI.
- **Tool authorization.** The model proposes; the application authorizes from the stored consent record, the selected slot, and the durable booking ledger. Model-supplied action arguments are discarded.
- **Output hygiene.** No `innerHTML`/`dangerouslySetInnerHTML` anywhere; all widget text is `textContent`; citation URLs are restricted to `http(s)`; the model cannot supply card content.
- **Accessibility.** Shadow-DOM style isolation, `role="dialog"` with a visible name, non-modal focus policy, focus return, `role="log"`, two-tone 3 px focus rings, reduced motion, forced colors, 24 px targets, and a real axe gate (0 serious/critical across three scans).
- **Supply chain.** Lockfile v3, `npm audit` 0 at every severity, SHA-pinned actions, checksum-pinned gitleaks, dependency review, Dependabot groups, coverage floor, and a post-deploy `/health` + `widget.js` smoke check.

### 1.3 Go / no-go

- **No public launch** until C-01, C-02, C-03, C-04, C-05 are closed and verified.
- **Closed pilot** is defensible after P0, C-06, and C-08 — all now closed, and the widget can take a lead and a privacy request end to end.
- **Scale** no longer depends on the lead log for session lookup: C-07 is closed, and the index answers in constant time. Reading one lead record on a cache miss, and the admin export per page, still scan the log, so a database remains the right answer at very large volumes.

---

## 2. Method and verification evidence

### 2.1 What was reviewed

- All 55 TypeScript source files under `src/` (33,076 lines), the 1,782-line widget, `public/`, `api/`, `worker/`, build/deploy files, workflows, Dockerfile, tests, and the privacy/lifecycle/accessibility documentation.
- The prior audit `docs/security-architecture-audit-2026-10-21.md` (927 lines) as a baseline, not as evidence.
- Data flows from browser input through Express handlers, security gates, RAG, the LLM client, Zod validation, action authorization, persistence, encryption, and admin export.
- The complete dependency tree and lockfile metadata.

### 2.2 Executed checks (this review)

| Check                   | Command                                                                         | Result                                                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| TypeScript              | `npm run typecheck`                                                             | **Pass** (exit 0)                                                                                                         |
| Lint                    | `npm run lint`                                                                  | **Pass**, 0 errors, 22 advisory warnings (mostly `security/detect-unsafe-regex` in test fixtures)                         |
| Test suite              | `npx jest --coverage=false` with temp record paths                              | **68/68 suites, 3,087/3,087 tests pass, 21.4 s**                                                                          |
| Coverage (existing run) | `coverage/coverage-summary.json`                                                | **89.99 % lines, 89.28 % statements, 90.92 % functions, 81.77 % branches** (thresholds 85/85/85/75)                       |
| Accessibility           | `npm run a11y:e2e`                                                              | **0 violations**, 0 serious/critical in closed, open, and dark-host scans; 211 nodes; control probe detected `image-alt`  |
| Dependencies            | `npm audit --json`                                                              | **0** info/low/moderate/high/critical; 591 lockfile packages                                                              |
| Admin posture probe     | supertest against `createApp()` with `PILOT_MODE=true`, no key                  | `GET /api/admin/leads` **200**, `/api/session/:id/history` **200**, `/api/system-prompt` **200**, `/api/sessions` **200** |
| Lead-lookup cost        | `getVerifiedContactConsent('lpp_auditscan0001')` against the 3,397-record store | **1,398 ms** for a cache miss                                                                                             |
| Widget delivery         | `wc -c`, `gzip -9`                                                              | 71,560 B raw, **20,629 B gzip**                                                                                           |
| Test isolation control  | Full suite with all record paths pointed at `/tmp`                              | Pass; `data/lead-records.jsonl` stayed at 3,875,750 B / mtime 22:45                                                       |

The full suite was deliberately run with `LEAD_LOG_PATH`, `DSR_LOG_PATH`, `LEAD_ACCESS_LOG_PATH`, `ERASURE_LOG_PATH`, `ABSTENTION_LOG_PATH`, and `BOOKING_LEDGER_PATH` redirected to `/tmp`. That both proves the suite is green and demonstrates the isolation defect in C-09: the default run writes into the repository's real `data/` store.

### 2.3 Not performed (and why)

- No live LLM call (no outbound provider credential was used); the orchestration/fallback paths were reviewed statically and are covered by tests with an empty key.
- No production deployment, real D1/database, or public URL was touched.
- No NVDA/JAWS/VoiceOver/TalkBack session; the repository's own Section 508 review documents this gap honestly.
- No external penetration test or load test beyond the 3,397-record lookup measurement.
- `.env` values were not read or printed; only the presence/length of admin and encryption keys was checked.

---

## 3. System model and data-flow trace

### 3.1 Runtime and deployment shape

| Surface             | Runtime                         | Entry point                         | Notes                                                                                                   |
| ------------------- | ------------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Container / sandbox | Node 22/24, Express             | `dist/index.js` (`src/index.ts`)    | Long-running; boot preflight starts record hydration, session/rate-limit cleanup, and production gates. |
| Vercel              | Node serverless                 | `api/index.ts` → `src/index.ts` app | `VERCEL=1` suppresses `listen()`; warm-instance memory only.                                            |
| Static              | Express `public/` or Vercel CDN | `/widget.js`, `/demo.html`, CSS     | Unversioned assets cached 1 h with `must-revalidate`; HTML `no-cache`.                                  |
| Staging artifact    | `sites-*`/`freebuff-*`          | —                                   | Work-in-progress deployment scaffolding, not part of the runtime reviewed.                              |

**Boot gates:** outside pilot mode, startup refuses to run without `TEXAS_LICENSE_NUMBER`, `ADMIN_API_KEY`, and `RECORD_ENCRYPTION_KEY`; short keys are refused in every mode. **This gate does not run when a host imports `createApp()` directly**, and it deliberately does nothing in pilot mode.

### 3.2 A chat turn, end to end

```
Browser widget (public/widget.js)
  │  fetch POST /api/chat  { sessionId, message, sourceUrl?, topicCategory?, page_context? }
  ▼
Express (src/app.ts:732)
  ├─ ChatRequestSchema.safeParse              → 400, field names only, values never echoed
  ├─ session state + medical consent from session store (never the body)
  ├─ kill switch                               → static safe fallback
  ├─ client budget (req.ip + global) → session budget (20 req / 50k tokens per minute)
  ├─ detectPromptInjection(message)            → canned refusal + redacted history
  ├─ detectSensitiveData(message)
  │     financial → refusal + handoff
  │     health (unless consented medical_review) → refusal + handoff
  │     health topic → refusal + handoff
  ├─ containsPersonalIdentifier(message)       → refusal, message never stored/sent
  ├─ sanitizeUrl(sourceUrl)                    → path only, query/hash stripped
  ├─ getHistory(sessionId)                     → prior turns (redacted)
  ├─ getVerifiedContactConsent(sessionId)      → PII-free session index, O(1) (C-07 closed)
  ├─ getNextState(...)                         → **hardcoded false flags** (C-06)
  ├─ setSessionState(sessionId, nextState)     → persisted before the model call
  ├─ injectContext(page_context)               → allowlisted article id/topic only
  ▼
generateResponse() (src/llm/orchestrator.ts)
  ├─ retrieveFromCorpus() → sanitizeRetrievedContent() → passages
  ├─ callLLM() → OpenAI-compatible /chat/completions, 10 s timeout, one retry
  ├─ Zod parse → schema rules → persona validator → claim guard
  ├─ retry once with validation feedback; then static fallback
  ▼
Response shaping (src/app.ts:1120-1210)
  ├─ DIME estimator inputs merged; app computes the range, never the model
  ├─ visual card id resolved against the approved library
  ├─ executeProposedAction(): server consent + selected slot + booking ledger
  └─ res.json(finalResponse)   ← **lead_data/consent/state still model-authored** (C-02)
  ▼
Widget (textContent only; role="log"; focus return; no HTML injection)
```

**Third parties on this path:** the configured LLM provider receives the system prompt, RAG evidence, redacted conversation history, and the current message. No analytics SDK, email, SMS, CRM, or database call is made by this repository.

### 3.3 Consent, DSR, and admin paths

```
POST /api/consent (unauthenticated, 60/min/IP)
  ├─ isRecordStorageSafe()       → 503 on ephemeral serverless storage
  ├─ ConsentRequestSchema        → contact channel + matching email/phone required
  ├─ medical payload?            → refuse unless collection enabled, encryption configured,
  │                                affirmative consent, and version present
  ├─ sourceUrl → stored session path or sanitizeUrl(body) → pathname only
  ├─ createLeadRecord → AES-256-GCM (or pilot plaintext for contact-only)
  ├─ saveLeadRecord()            → stream append; ack only after write resolves
  └─ session state = consent
```

```
POST /api/dsr (unauthenticated, 60/min/IP) → DSR record (AES-GCM when key configured)
POST /api/dsr/:id/verify  (admin)           → proof of control
POST /api/dsr/:id/erase   (admin)           → rewrite logs atomically, audit entry
GET  /api/dsr/:id         (admin)           → status only
GET  /api/admin/leads     (admin)           → paginated decrypted export + access audit
```

### 3.4 Trust boundaries

| Boundary           | What crosses it                                                       | Control                                                                   | Residual risk                                                                                                                                                                                      |
| ------------------ | --------------------------------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser → API      | Message, session id, page metadata, topic label, contact/consent form | Zod, length caps, PII/health gates, rate limits, CORS                     | `topicCategory` is unvalidated free text (C-04); no Origin check on POST (L-05).                                                                                                                   |
| API → LLM          | System prompt, RAG, history, message                                  | Delimiters, redaction, no tools, timeout, schema validation               | Prompt injection is a lexical heuristic (M-07); provider DPA/retention registered but not yet filed (M-10).                                                                                        |
| LLM → API          | JSON envelope                                                         | Zod, cross-field rules, persona/claim guards                              | Model-authored `lead_data`/`consent`/`state` survive to the client (C-02).                                                                                                                         |
| API → disk         | PII, consent, DSR                                                     | AES-256-GCM, key ring, fail-closed and fsynced writes                     | Every append fsynced, rewrites fsync file and directory (M-05); DSR free text only inside the envelope (M-09); with no key configured in pilot, records are plaintext including the contact email. |
| Operator → admin   | Lead export, history, DSR actions                                     | `x-admin-key`, constant-time, 32-char floor, PII-free access audit (M-04) | Fail-open in pilot (C-01, closed). Reads are audited and fail closed on the audit write.                                                                                                           |
| Host page → widget | DOM, CSS, API base                                                    | Shadow root, `all: initial`, explicit styles                              | Host page fully controls its own origin; no integrity pin on `widget.js` (accepted).                                                                                                               |

---

## 4. Detailed finding matrix

Severity reflects likelihood × impact **in the documented deployment posture**, not theoretical purity. Evidence is `file:line` at the reviewed commit; line numbers can drift.

### 4.1 CRITICAL

| ID       | Finding                                                                                                                                                                                                                                                                                                                                               | Evidence                                                                                                                                                                                                                                        | Impact                                                                                                                                                                                                                                                 | Required fix                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C-01** | **Admin authorization fails open in pilot mode.** With no `ADMIN_API_KEY`, `requireAdminAuth` returns `true` when `pilotMode` is on. `PILOT_MODE` is on unless it is exactly `'false'` (or unset with `NODE_ENV !== 'production'`). The documented sandbox boot command is `PILOT_MODE=true node dist/index.js`, and `.env.example` has an empty key. | `src/app.ts:313-352` (return true at **:327**); `src/config/app-config.ts:234-237`; `src/index.ts:183-190`; `docs/sandbox-deployment.md:46,351`; `.env.example:33,90`; prior audit claim at `docs/security-architecture-audit-2026-10-21.md:47` | A single unauthenticated `GET /api/admin/leads` returns decrypted PII; `/api/admin/kill-switch` stops the assistant; `/api/session/:id/history` exposes conversations; `/api/dsr/:id/erase` destroys records. Reproduced 200 on all four probe routes. | Deny by default. Require the key for every admin route regardless of pilot; allow only a loopback dev request when no key exists. Treat `PILOT_MODE` as `=== 'true'`, never "anything but false". Add a regression test that asserts 503/401 for a non-loopback request with no key. |

### 4.2 HIGH

| ID       | Finding                                                                                                                                                                                                                                                                                                                                           | Evidence                                                                                                                                                                                                                                           | Impact                                                                                                                                                                                                                                                                   | Required fix                                                                                                                                                                                                                                                                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **C-02** | **Model-authored `lead_data`, `consent`, and `state` are returned to the client.** Only `privacy_notice_version` is overwritten. `executeProposedAction` correctly ignores model consent for side effects, but the wire response still asserts it.                                                                                                | `src/llm/orchestrator.ts:346,357-363`; `src/app.ts:1120-1210`; `src/schema/response-schema.ts:246-247,286-320`                                                                                                                                     | A prompt-injected or hallucinating model can make the API say `contact_consent_affirmed: true`, invent an email/phone, or attach a `medical_profile` in Phase 1. A CRM consuming `lead_data` can create a lead without a durable consent record.                         | Overwrite the envelope from server truth before `res.json`: `lead_data` from the verified lead or all-null; `consent` from `getVerifiedContactConsent()` and a DSR `do_not_contact` check; `state` from the persisted session/action result. Add a test that a model response with forged consent is neutralized.                                                                          |
| **C-03** | **Consent hash is over caller-supplied text, not the approved copy.** Any 1–5,000 character string is hashed and stamped with the current `contact_consent_version`. There is no canonical email copy at all (only a phone copy exists).                                                                                                          | `src/app.ts:1280,1404,1419`; `src/consent/consent-model.ts:647`; `src/config/app-config.ts:217`; `GET /api/consent-text` at `src/app.ts:700`                                                                                                       | The legal artefact proves "someone sent some text", not "the visitor affirmed the approved disclosure". A version bump without a server-side hash comparison is unverifiable later.                                                                                      | Server owns the canonical text per channel. Compare normalized input to it; reject a mismatch; hash the canonical text and persist `copy_id` + version. Fetch the copy from `/api/consent-text` in the UI.                                                                                                                                                                                 |
| **C-04** | **`topicCategory` is free text that reaches analytics and the abstention log.** No enum, no allowlist, no masking.                                                                                                                                                                                                                                | `src/schema/request-schema.ts:46`; `src/schema/response-schema.ts:192`; `src/llm/orchestrator.ts:362`; `src/analytics/abstention-log.ts:57-65,105`; `src/app.ts:848,1390`                                                                          | A caller can inject an email, phone, or health phrase into GA4/dataLayer and persistent logs, breaking the "no PII in analytics" promise.                                                                                                                                | `z.enum([...])` for request and response `topic_category`; map unknown to `'other'`; allowlist in `deriveQuestionCategory`; add a test that an email in `topicCategory` is rejected or replaced.                                                                                                                                                                                           |
| **C-05** | **Medical consent version is client-controlled.** The route takes `medicalConsentVersion` from the body, stores it, and uses it to set the server-side consent flag. It only checks presence, not equality to a configured current version.                                                                                                       | `src/app.ts:1314,1356,1364,1375,1432`; `src/schema/request-schema.ts:86`; `src/schema/response-schema.ts:318`                                                                                                                                      | When Phase 2 is enabled, a caller can label an old/arbitrary version as current and have the session treated as medically consented. Disabled by default (`HEALTH_DATA_COLLECTION_DISABLED=true`), so conditional.                                                       | Add `config.medicalConsentVersion`; ignore the request value; reject any mismatch; derive `medical_consent_affirmed` only from a verified record written under the current version.                                                                                                                                                                                                        |
| **C-06** | **The conversation state machine is disconnected.** The route passes constant `false` for five transition inputs; `LOOP_CONTROLS` is never enforced; `qualification_offer`, `clarify`, and normal `contact_offer` are unreachable. Tests seed states instead of driving them.                                                                     | `src/app.ts:1012-1058` (flags at **:1015-1018, :1034**; persist at **:1048**); `src/state-machine/state-machine.ts:56-236,238-257`; `tests/api-endpoints.test.ts:162-166`; `seedSession` at `tests/api-endpoints.test.ts:30-38`                    | The regulatory conversation design (max 3 questions, no re-offer after decline, clarify twice then hand off) exists only as dead code. The UI receives the model's `state` while the server persists a different one.                                                    | Emit structured intent fields from the model (`needs_clarification`, `qualification_interest`, `value_delivered`) and validate them; or derive flags from the validated response and retrieval. Enforce `LOOP_CONTROLS` counters in the session store. Persist state **after** the response/action, not before. Add end-to-end tests that start at `education` and assert each transition. |
| **C-07** | **O(file) decrypt scan on the first chat turn of every session, plus whole-file boot hydration (closed 2026-10-23).** Measured **1,398 ms** for 3,397 records / 3.7 MB. At 100k records this is tens of seconds; 30 new sessions/min can saturate a core. Boot read the entire file with `readJsonlLines` and decrypted into a 5,000-entry cache. | Closed: `src/consent/consent-model.ts` (index hydrate/rebuild/`findLeadIdBySession`); `src/persistence/jsonl-log.ts` (`forEachJsonlLine`, `replaceJsonlLines`); `src/config/app-config.ts` (`leadSessionIndexPath`); `tests/session-index.test.ts` | Fixed as recommended: a PII-free `session_id → lead_id` file is written with each lead, hydrated into memory for an O(1) lookup (including the no-consent answer), and rebuilt from the log when missing or older than it. Boot and export stream instead of collecting. | Verified at 50k index entries (<50 ms lookup) and measured at 100k records (738 ms scan → 0.13 ms lookup). The remaining O(file) paths are a lead-record cache miss and the admin export, both operator reads.                                                                                                                                                                             |
| **C-08** | **No shipped UI client for `/api/consent` or `/api/dsr` (closed 2026-10-23).** The widget has no email/phone/name fields and never calls either route. The chat refuses PII, tells the visitor a "secure process" exists, and returns `contactUrl` for an external page.                                                                          | `public/widget.js` (no `contactConsentAffirmed`, `email`, `phone`, or `consentText`); `src/app.ts:693,959-975`; `README.md:327`; `docs/sandbox-deployment.md:380`                                                                                  | The assistant cannot actually take a lead from the product it ships, and a TDPSA request requires hand-crafting an API call. The compliance features are API-only.                                                                                                       | Add a consent/contact step to the widget (or a verified Elementor form that posts to `/api/consent` with the canonical copy), plus a visible DSR route. Add an end-to-end browser test from chat refusal → consent → `/api/admin/leads`.                                                                                                                                                   |

### 4.3 MEDIUM

| ID       | Finding                                                                                                                                                                                                                                                                                                                                                         | Evidence                                                                                                                                                                                                                               | Impact                                                                                                                                                                                                                                      | Required fix                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **M-01** | **Test suite writes into the real `data/` store (closed 2026-10-23).** The `POST /api/consent` suite used the default paths; only two narrow tests overrode them. `data/lead-records.jsonl` was 3,397 lines / 3.7 MB, mtime 22:45 (the coverage run). The same applied to the 6.1 MB abstention log and 261 KB DSR log.                                         | Fixed in `tests/setup/record-paths.ts` (registered in `jest.config.js`), the hardening/serverless overrides, and [tests/record-path-isolation.test.ts](../tests/record-path-isolation.test.ts)                                         | The risk was real: a developer's local records were mixed with synthetic ones, tests read real records, and the store grew every run — which also slowed the C-07 scan. Verified by a full run that leaves `data/` byte-for-byte unchanged. | **Fixed:** every test file's record stores resolve under `os.tmpdir()` before any module import; a guard asserts the resolved paths, exercises a real lead and DSR write without touching `data/`, and rejects any test that assigns a record-path variable back into it.                                                                                                                                                     |
| **M-02** | **`/health` published security posture (closed 2026-10-23).** Model, provider base URL, `adminApiKeyConfigured`, `recordEncryptionConfigured`, `licenseNumberConfigured`, `trustProxy`, and the compliance matrix were unauthenticated.                                                                                                                         | Closed in `src/app.ts` (`/health`, `/api/admin/health`); `tests/server-hardening.test.ts`, `tests/durable-storage.test.ts`, `tests/api-endpoints.test.ts`, `tests/medical-gating.test.ts`; sandbox/README docs                         | Reconnaissance that directly enabled C-01 targeting and exposed provider/endpoint details.                                                                                                                                                  | **Fixed:** public `/health` returns `{status, uptimeSeconds, killSwitch}` only; the readiness block moved verbatim to key-gated `GET /api/admin/health`, which fails closed exactly like the other admin routes.                                                                                                                                                                                                              |
| **M-03** | **LLM timeout was cleared before the body was read; the catch path leaked the timer; worst-case latency was 20–40 s (closed 2026-10-23).** `clearTimeout` fired immediately after `fetch` resolved, so `response.json()` was unbounded. Two attempts × 10 s; the orchestrator can make a second call on validation failure. `vercel.json` set no `maxDuration`. | Closed in `src/llm/llm-client.ts` (deadline spans fetch + body, cleared in `finally`), `vercel.json` (`maxDuration: 30` for `api/index.ts`), [tests/llm-client.test.ts](../tests/llm-client.test.ts)                                   | Serverless 504s, hung requests, duplicate spend; a slow provider burned two timeouts before fallback.                                                                                                                                       | **Fixed:** the abort timer is armed before `fetch` and cleared in `finally` only after the body is read and parsed; the body is read once with `text()`, so both branches share the bounded read; the platform duration (45 s) is above the worst case of two calls × two 10 s attempts.                                                                                                                                      |
| **M-04** | **Admin reads were not all audited (closed 2026-10-23).** `GET /api/admin/leads` wrote a PII-free access entry, but session history, DSR status, RAG search, prompt and readiness reads did not.                                                                                                                                                                | `src/privacy/admin-access-audit.ts`, `src/app.ts` (all six audited routes); [tests/admin-access-audit.test.ts](../tests/admin-access-audit.test.ts)                                                                                    | Could not answer "who read this conversation/DSR"; GLBA/TDPSA accountability gap.                                                                                                                                                           | **Fixed:** every data-returning admin read appends `{audit_id, event, at, route, record_id, actor_key_id, status}` before answering, with a hashed key id and no payload text; a non-opaque path parameter is stored as `unrecognized`; a failed write answers 503 with no payload.                                                                                                                                           |
| **M-05** | **Acknowledged records were not `fsync`ed (closed 2026-10-23).** `appendJsonlLine` resolved on stream end (OS cache), and erasure/rekey used `writeFile` + `rename` without a file or directory `fsync`.                                                                                                                                                        | `src/persistence/jsonl-log.ts` (`appendJsonlLine`, `replaceJsonlLines`, `syncDirectory`); `src/privacy/erasure.ts`, `src/privacy/record-rekey.ts`; [tests/durable-writes.test.ts](../tests/durable-writes.test.ts)                     | A power loss could lose an acknowledged consent or resurrect a half-erased log. "Durable" was stronger than the implementation.                                                                                                             | **Fixed:** appends open, write, `fsync`, close (and flush the directory when the append created the file); rewrites `fsync` the temp file before the rename and the directory after it; erasure and key rotation share that one path. RPO documented in the runbook.                                                                                                                                                          |
| **M-06** | **PII/error content could reach logs (closed 2026-10-23).** The terminal error handler logged the full `err` (body-parser messages can include a body fragment); the orchestrator logged `firstAttempt.detail`, built from model output; and `llm-client` copied `fetch`/`JSON.parse` messages into a value that was both logged and returned as `error_code`.  | `src/observability/safe-log.ts`; `src/app.ts`, `src/llm/orchestrator.ts`, `src/llm/llm-client.ts`; [tests/log-redaction.test.ts](../tests/log-redaction.test.ts)                                                                       | PII or health phrases in server logs, retained outside the record-encryption boundary.                                                                                                                                                      | **Fixed:** failures are logged as `{name, code, status, type}` plus method and route shape; payload text becomes a length + hash; only code-shaped strings are printed; the client classifies its errors instead of copying messages; a static gate fails any request-path `console.*` that passes an error, its `message`, or an unreduced `detail`.                                                                         |
| **M-07** | **Prompt-injection defence is a lexical heuristic.** Eight regexes; "please disregard the guidance above", base64, homoglyphs, or a benign-sounding multi-turn setup pass. The structural separation is the real defence, but the detection claim is overconfident.                                                                                             | `src/security/security-controls.ts:168-196`                                                                                                                                                                                            | A determined visitor can steer the model; tool actions are still server-authorized, so impact is limited to prose/claims.                                                                                                                   | Do not rely on detection: keep the system/data separation, add an output-side check for system-prompt fragments and instruction leakage, and add adversarial multi-turn tests. Consider a classifier or a strict allowlist of answer intents for Phase 2.                                                                                                                                                                     |
| **M-08** | **Abstention log used an unsalted SHA-256 of the normalized question (closed 2026-10-23).**                                                                                                                                                                                                                                                                     | `src/analytics/abstention-log.ts` (`hmacQuestionHash`, `abstentionKeyId`, `logAbstention`); `src/config/app-config.ts`; [tests/abstention-log.test.ts](../tests/abstention-log.test.ts)                                                | A dictionary attack over common sensitive questions ("I have HIV") reveals health topics to anyone with the log.                                                                                                                            | **Fixed:** the hash is HMAC-SHA-256 keyed with `ABSTENTION_LOG_KEY`; each entry carries a 12-hex key id so a rotation is visible; with no key configured nothing is written at all (boot warns), rather than falling back to a guessable digest.                                                                                                                                                                              |
| **M-09** | **DSR free-text `detail` could be plaintext in pilot (closed 2026-10-23).** The field is capped at 2,000 chars and was encrypted only when a key was configured; without one the record — free text included — was written in clear.                                                                                                                            | `src/privacy/dsr.ts` (`submitDsr`, `persistDsrRecord`, `DsrRecord.detail_withheld`); `src/app.ts` (`POST /api/dsr` response); [tests/dsr.test.ts](../tests/dsr.test.ts), [tests/api-endpoints.test.ts](../tests/api-endpoints.test.ts) | A consumer may paste an SSN, diagnosis, or account number into a TDPSA request; it lands in plaintext.                                                                                                                                      | **Fixed:** the request is always accepted, but the free text is only stored with a configured key — otherwise it is dropped, the record is marked `detail_withheld`, the caller is told to email it, and a belt in the persistence path refuses any record whose detail is not an authenticated envelope. Free text is never written outside the envelope, whatever the key state.                                            |
| **M-10** | **Third-party AI processing is not evidenced (open — documentation delivered 2026-10-23; contract evidence outstanding).** The notice listed "chat/AI infrastructure" generically; there was no subprocessor list, DPA, zero-retention setting, or data-residency note.                                                                                         | [docs/subprocessors.md](subprocessors.md); [docs/privacy-notice.md](privacy-notice.md) §5 and §8; `src/llm/llm-client.ts`; `.env.example:LLM_API_BASE_URL`                                                                             | GLBA/TDPSA vendor-management gap; a provider may train on or retain chat text.                                                                                                                                                              | **Partially fixed:** the register states every destination the code sends data to, what gate runs before it leaves, and each provider's required artifacts; the notice now discloses AI processing and points at the register. Still open: the signed DPAs, region confirmations and zero-retention settings themselves — those are signing actions, recorded as _not on file_ in the register, and cannot be closed by code. |
| **M-11** | **The prior audit overstates remediation.** `docs/security-architecture-audit-2026-10-21.md:47` says SEC-01 through SEC-08 are implemented; SEC-01 is still open in code and reproducible.                                                                                                                                                                      | Prior audit line 47 vs `src/app.ts:313-352`                                                                                                                                                                                            | Operators may trust a false closure and ship an open admin surface.                                                                                                                                                                         | Correct the status table; require a code-level regression test for every "closed" finding.                                                                                                                                                                                                                                                                                                                                    |
| **M-12** | **No SAST/taint analysis in CI; no container image scan.** Lint has `eslint-plugin-security`, gitleaks covers secrets, dependency-review covers PRs. There is no CodeQL/Semgrep SARIF job and no Trivy/Grype image scan.                                                                                                                                        | `.github/workflows/security.yml`; `.github/workflows/ci.yml`; `Dockerfile`                                                                                                                                                             | Injection/deserialization/SSRF classes are not systematically detected; base-image CVEs are unseen.                                                                                                                                         | Add a job-scoped `security-events: write` CodeQL or Semgrep job; build the image in CI and scan it; keep the existing read-only default.                                                                                                                                                                                                                                                                                      |
| **M-13** | **No environment approval before production deploy.** Every green `main` push deploys to Vercel production automatically.                                                                                                                                                                                                                                       | `.github/workflows/deploy.yml:50-75,199-214`                                                                                                                                                                                           | A compromised or mistaken merge reaches production without a human gate.                                                                                                                                                                    | Use a GitHub Environment with required reviewers for production, or gate on a release tag/manual dispatch.                                                                                                                                                                                                                                                                                                                    |
| **M-14** | **Duplicate consent submissions create duplicate leads.** No idempotency key or dedupe on session + channel + contact hash.                                                                                                                                                                                                                                     | `src/app.ts:1379-1420`                                                                                                                                                                                                                 | Duplicate consent records, inconsistent "latest" lookup, inflated lead counts.                                                                                                                                                              | Add a deterministic idempotency key per session/channel/contact hash; return the existing lead on replay.                                                                                                                                                                                                                                                                                                                     |
| **M-15** | **Rate limits and sessions are per process.** On serverless/multi-instance, budgets are multiplied and reset on cold start; cleanup intervals are not scheduled when `config.serverless` is true.                                                                                                                                                               | `src/security/security-controls.ts:2483-2600,2620-2710`; `src/llm/session-store.ts:31,89,407-446`; `src/index.ts:279-301`                                                                                                              | Cost/abuse control is weaker than the README implies; memory can grow to the 5,000-entry cap per warm instance.                                                                                                                             | Document per-instance semantics; move counters to a shared store (Redis/D1) before horizontal scale; cap session memory by bytes, not only count.                                                                                                                                                                                                                                                                             |

### 4.4 LOW

| ID       | Finding                                                                                                                                                                                         | Evidence                                                             | Fix                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| **L-01** | No Origin/CSRF check on state-changing POSTs. JSON content-type + preflight currently blocks classic browser CSRF, but defense-in-depth is missing.                                             | `src/app.ts:208-270`                                                 | Reject a present `Origin` that is not allowlisted on POST/DELETE; keep same-origin default.                                                 |
| **L-02** | No `Permissions-Policy`/COOP/CORP headers.                                                                                                                                                      | `src/app.ts:222-229`; `src/security/security-headers.ts`             | Add `Permissions-Policy: camera=(), microphone=(), geolocation=()` and `Cross-Origin-Opener-Policy: same-origin`.                           |
| **L-03** | Input font is 15 px, which triggers iOS Safari auto-zoom on focus; panel height uses `100vh`, which ignores mobile browser chrome/keyboard.                                                     | `public/widget.js:577,397`                                           | Use `font-size: max(16px, 0.9375rem)` on the input and `100dvh` with a `100vh` fallback.                                                    |
| **L-04** | `role="log"` already implies `aria-live="polite"`; setting both is redundant (not a failure).                                                                                                   | `public/widget.js:533-534`                                           | Drop the explicit `aria-live`, or document why it is kept for older AT.                                                                     |
| **L-05** | Dead policy constants create a false sense of enforcement: `PROHIBITED_PRESSURE_TACTICS`, `FORBIDDEN_CHAT_FIELDS`, `APPROVED_QUALIFICATION_TOPICS`, `APPROVED_MEDICAL_TOPICS`, `LOOP_CONTROLS`. | `src/state-machine/state-machine.ts:238-300` (no runtime references) | Enforce them or remove them and label them as specification notes.                                                                          |
| **L-06** | Monolithic files: `src/app.ts` 1,801 lines / 20 routes; `security-controls.ts` 2,837; `retrieval.ts` 1,106.                                                                                     | `wc -l`                                                              | Extract `routes/chat`, `routes/consent`, `routes/admin`, `services/lead-service`, `middleware/admin-auth`; keep `createApp` to composition. |
| **L-07** | AES-GCM envelope does not bind `v`/`kid` as AAD; a record envelope can be swapped between lines without detection.                                                                              | `src/privacy/record-encryption.ts:186-202`                           | Use `cipher.setAAD(Buffer.from(`${v}:${kid}`))` and the same on decrypt.                                                                    |
| **L-08** | Dependabot excludes majors; Express 5 / Zod 4 / TypeScript majors have no scheduled upgrade window.                                                                                             | `.github/dependabot.yml`                                             | Add a quarterly major-upgrade epic with contract tests; not a security defect today.                                                        |
| **L-09** | HSTS includes subdomains on a domain that may host non-HTTPS services.                                                                                                                          | `src/security/security-headers.ts:17`; `vercel.json`                 | Confirm every subdomain is HTTPS before keeping `includeSubDomains`.                                                                        |
| **L-10** | `npm ci` in the Docker build runs lifecycle scripts as root; no `--ignore-scripts`.                                                                                                             | `Dockerfile:20`                                                      | Audit install scripts and use `--ignore-scripts` where the dependency tree allows it; add an SBOM.                                          |
| **L-11** | No request id/correlation id in responses or logs.                                                                                                                                              | `src/app.ts:1759-1800`                                               | Generate/propagate `x-request-id`; include it in structured logs and admin audit entries.                                                   |
| **L-12** | Manual screen-reader proof is absent (NVDA/JAWS/VoiceOver/TalkBack). The Section 508 review documents this honestly.                                                                            | `docs/section-508-accessibility-review.md:28`                        | Schedule the manual matrix; record results in `docs/accessibility-matrix-receipt.json`.                                                     |

---

## 5. Code-level remediation (Before / After)

### 5.1 C-01 — make admin authorization deny-by-default

**Before** (`src/app.ts:313-352`):

```ts
function requireAdminAuth(req: Request, res: Response): boolean {
  if (!isAdminApiKeyConfigured()) {
    if (!config.pilotMode) {
      res.status(503).json({ error: 'Admin authentication is not configured' });
      return false;
    }
    return true; // pilot/dev only
  }
  const provided = req.headers['x-admin-key'];
  if (typeof provided === 'string' && constantTimeEqual(provided, config.adminApiKey)) {
    return true;
  }
  res.status(401).json({ error: 'Admin authentication required' });
  return false;
}
```

**After:**

```ts
function isLoopbackRequest(req: Request): boolean {
  const address = req.socket.remoteAddress ?? '';
  const loopback = address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
  // A proxied request is never a local developer, even if the socket is local.
  return loopback && req.headers['x-forwarded-for'] === undefined;
}

function requireAdminAuth(req: Request, res: Response): boolean {
  if (isAdminApiKeyConfigured()) {
    const provided = req.headers['x-admin-key'];
    if (typeof provided === 'string' && constantTimeEqual(provided, config.adminApiKey)) {
      return true;
    }
    res.status(401).json({ error: 'Admin authentication required' });
    return false;
  }

  // No key configured. A local developer may use the admin surface on loopback;
  // no network caller ever can, in any mode.
  if (config.pilotMode && isLoopbackRequest(req)) {
    return true;
  }

  res.status(503).json({
    error: 'Admin authentication is not configured',
    message: 'Set ADMIN_API_KEY and restart.',
  });
  return false;
}
```

Also make the mode parser explicit (`src/config/app-config.ts:234-237`):

```ts
pilotMode:
  process.env.PILOT_MODE === undefined
    ? process.env.NODE_ENV !== 'production'
    : process.env.PILOT_MODE === 'true',
```

**Acceptance test:** with `PILOT_MODE=true`, `ADMIN_API_KEY=''`, and a non-loopback `req.ip`, every admin route returns 503/401. With a loopback request it may return 200 in dev. The existing "pilot 200" tests must be updated to use loopback or a key.

---

### 5.2 C-02 — never return model-authored consent or lead data

**Before** (`src/llm/orchestrator.ts:346-363`):

```ts
validated.consent.privacy_notice_version = config.privacyNoticeVersion;

const finalResponse: AssistantResponse = {
  ...validated,
  citations,
  analytics: {
    ...validated.analytics,
    topic_category: validated.analytics.topic_category || input.topicCategory || null,
    conversation_stage: validated.state,
  },
};
```

**After** (in `src/app.ts`, after `executeProposedAction`, before `res.json`):

```ts
const verified = await getVerifiedContactConsent(sessionId);
const serverState = getSessionState(sessionId); // persisted by the action layer

finalResponse = {
  ...finalResponse,
  state: serverState,
  lead_data: {
    first_name: null,
    email: verified.ok ? verified.consent.email : null,
    phone: verified.ok ? verified.consent.phone : null,
    goal_category: null,
    timeline_category: null,
    current_coverage_category: null,
    policy_type_seeking: null,
    coverage_amount_seeking: null,
    contact_channel: verified.ok ? verified.consent.channel : null,
    time_zone: null,
    preferred_contact_window: null,
    medical_profile: null, // medical data is collected only by /api/consent
  },
  consent: {
    privacy_notice_version: config.privacyNoticeVersion,
    contact_consent_version: verified.ok ? verified.consent.version : null,
    contact_consent_affirmed: verified.ok,
    medical_consent_version: null,
    medical_consent_affirmed: false,
    do_not_contact: await hasPendingDeletionForSession(sessionId),
  },
};
```

The model may still _say_ "I've recorded your consent"; the claim guard and the `ACTION_NOT_CONFIRMED_NOTE` path must correct that prose. The wire payload, however, is now server truth.

**Acceptance test:** a mocked LLM returns `lead_data.email = "attacker@example.com"`, `consent.contact_consent_affirmed = true`, and a `medical_profile`; the route response must contain all-null lead data, `contact_consent_affirmed: false`, and `medical_profile: null`.

---

### 5.3 C-03 — bind the consent artefact to the approved copy

**Before** (`src/app.ts:1404`):

```ts
lead.consent_text_hash = createHash('sha256').update(consentText, 'utf8').digest('hex');
```

**After:**

```ts
// Server-owned canonical copy per channel; the client may display it but
// cannot define it.
const canonicalConsentText =
  contactChannel === 'phone' ? RECOMMENDED_PHONE_CONSENT_COPY : RECOMMENDED_EMAIL_CONSENT_COPY;

const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
if (normalize(consentText) !== normalize(canonicalConsentText)) {
  return res.status(400).json({
    error: 'Consent copy mismatch',
    message: 'Reload this page and affirm the current consent text.',
  });
}

lead.contact_consent_version = config.contactConsentVersion; // server-owned
lead.consent_text_hash = createHash('sha256').update(canonicalConsentText, 'utf8').digest('hex');
```

Add `RECOMMENDED_EMAIL_CONSENT_COPY` next to the phone copy and serve both from `/api/consent-text`. Add a test that a 1-character `consentText` is rejected.

---

### 5.4 C-04 — make analytics categorical

**Before** (`src/schema/request-schema.ts:46`):

```ts
topicCategory: OptionalTextSchema(64),
```

**After:**

```ts
export const TopicCategorySchema = z.enum([
  'term_life',
  'whole_life',
  'final_expense',
  'annuity',
  'underwriting',
  'riders',
  'beneficiaries',
  'taxes',
  'claims',
  'other',
]);

topicCategory: TopicCategorySchema.optional(),
```

Mirror it in `AnalyticsSchema.topic_category` and in `deriveQuestionCategory`:

```ts
export function deriveQuestionCategory(input?: string | null): string {
  if (!input) return '';
  return TOPIC_CATEGORIES.has(input) ? input : 'other';
}
```

Add a regression test that `topicCategory: "user@example.com"` returns 400 with no field value echoed, and that a known category still reaches analytics.

---

### 5.5 C-06 — wire the state machine and enforce loop controls

The current transition inputs are constants:

```ts
const nextState = getNextState({
  currentState,
  userMessage: message,
  hasValueBeenDelivered: false, // Determined by LLM response quality
  userShowsInterest: false,
  queryIsAmbiguous: false,
  userAgreesToQualification: false,
  userRequestsFollowup: false,
  ...
});
```

**Required design change:** add explicit, schema-validated intent fields to the model response (not free prose), for example:

```ts
// response-schema.ts
export const TurnIntentSchema = z.object({
  value_delivered: z.boolean().default(false),
  needs_clarification: z.boolean().default(false),
  interest_in_contact: z.boolean().default(false),
  agrees_to_qualification: z.boolean().default(false),
  declines_or_ends: z.boolean().default(false),
});
```

Then:

```ts
const nextState = getNextState({
  currentState,
  userMessage: message,
  hasValueBeenDelivered: response.intent.value_delivered,
  userShowsInterest: response.intent.interest_in_contact,
  queryIsAmbiguous: response.intent.needs_clarification,
  userAgreesToQualification: response.intent.agrees_to_qualification,
  userRequestsFollowup: contactConsentVerified || response.intent.interest_in_contact,
  userDeclinesOrFlowEnds: response.intent.declines_or_ends,
  ...
});
```

Enforce `LOOP_CONTROLS` in the session store (per-session counters for clarification failures, qualification questions, declines) and pass the counters into `getNextState` or reject the transition. Persist state **after** the validated response and action, not before. The model's `state` must never be the persisted value.

**Acceptance test:** start a fresh session at `education`, send a value-delivering message with `interest_in_contact=true`, and assert the next `/api/session/:id/history` (admin/loopback) shows `qualification_offer` or `contact_offer` — not `education`. Add a test that the fourth qualification question is refused.

---

### 5.6 C-07 — O(1) session → lead lookup

**Before** (`src/consent/consent-model.ts:389-400`):

```ts
async function findLeadIdBySession(sessionId: string): Promise<string | undefined> {
  const match = await findJsonlRecord<LeadRecord>(config.leadLogPath, (line) => {
    const plain = decryptRecordLine(line);
    if (plain === null) return null;
    const parsed = JSON.parse(plain) as LeadRecord;
    return parsed && parsed.session_id === sessionId ? parsed : null;
  });
  return match?.lead_id;
}
```

**After (index):**

```ts
// data/lead-session-index.jsonl — PII-free: { session_id, lead_id, created_at }
async function findLeadIdBySession(sessionId: string): Promise<string | undefined> {
  const hit = await findLastJsonlRecord<SessionIndexEntry>(config.leadSessionIndexPath, (line) => {
    const entry = JSON.parse(line) as SessionIndexEntry;
    return entry.session_id === sessionId ? entry : null;
  });
  return hit?.lead_id;
}

// In saveLeadRecord(), after the durable write succeeds:
await appendJsonlLine(
  config.leadSessionIndexPath,
  JSON.stringify({
    session_id: lead.session_id,
    lead_id: lead.lead_id,
    created_at: lead.created_at,
  }),
);
```

Backfill with a one-off `npm run records:index-sessions` that streams the existing log (no plaintext index content). If the index is missing, fall back to the scan once and write the index. Add a test at 50k synthetic records asserting the lookup stays under 50 ms.

**Implemented 2026-10-23.** The index is `LEAD_SESSION_INDEX_PATH` (default `data/lead-records-session-index.jsonl`, derived from the lead log path so an overridden log never shares an index), and it is hydrated once into a `Map` rather than scanned per lookup — the per-lookup scan above would still be O(index). Absence from a complete index is the answer, so a new visitor's first turn opens no files. A local write is ordered log-then-index, and the index's mtime is compared with the log's at boot: a failed append (log newer) triggers a rebuild instead of trusting a short index. Erasure and retention call `reloadLeadRecords()`, which forces a rebuild so a deleted subject's session stops mapping. On the Archil object store, where mtime is unavailable, a missing or empty index is rebuilt rather than trusted.

---

### 5.7 C-09 — isolate test records

**Before** (`jest.config.js:6-16`): only `isolate-secrets`, `loopback-listen`, `booking-ledger`.

**After:** add `tests/setup/record-paths.ts`:

```ts
import { randomUUID } from 'crypto';
import os from 'os';
import path from 'path';

const dir = path.join(os.tmpdir(), 'lifechat-test-records', randomUUID());

process.env.LEAD_LOG_PATH = path.join(dir, 'leads.jsonl');
process.env.DSR_LOG_PATH = path.join(dir, 'dsr.jsonl');
process.env.LEAD_ACCESS_LOG_PATH = path.join(dir, 'lead-access.jsonl');
process.env.ERASURE_LOG_PATH = path.join(dir, 'erasure.jsonl');
process.env.ABSTENTION_LOG_PATH = path.join(dir, 'abstention.jsonl');
process.env.BOOKING_LEDGER_PATH = path.join(dir, 'bookings');
```

Register it in `setupFiles` **before** any test module. Change `tests/server-hardening.test.ts` to use `tempLogPath(...)`. Add a guard test:

```ts
it('does not write records into the repository data directory', () => {
  expect(fs.existsSync(path.join(process.cwd(), 'data', 'lead-records.jsonl'))).toBe(false);
});
```

(The guard should run in CI on a clean checkout; locally the file may pre-exist, so assert mtime/size instead.)

**Implemented 2026-10-23.** Registered `tests/setup/record-paths.ts` after the booking-ledger setup (which keeps its own per-file directory), removed the `data/` overrides from the hardening and serverless suites, and wrote the guard as three assertions rather than one existence check: every resolved store must sit under `os.tmpdir()`, a real lead and DSR write must leave the repository's `data/` listing unchanged while the temp files appear, and a source scan fails on any test that assigns a record-path variable back into `data/`. The last check is what keeps a future suite from looking isolated while writing to a developer's store; the existence check alone would pass locally because the file predates the run.

---

### 5.8 M-03 — keep the timeout through the body read

**Before** (`src/llm/llm-client.ts:219-232`):

```ts
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), LATENCY_CONFIG.TIMEOUT_MS);
const response = await fetch(endpoint, { ..., signal: controller.signal });
clearTimeout(timeoutId);
```

**After:**

```ts
const controller = new AbortController();
const timeoutId = setTimeout(() => controller.abort(), LATENCY_CONFIG.TIMEOUT_MS);
try {
  const response = await fetch(endpoint, { ..., signal: controller.signal });
  const body = await response.text(); // still under the same abort signal
  // parse body, check status, etc.
} finally {
  clearTimeout(timeoutId);
}
```

Also add a bounded platform duration in `vercel.json` (e.g. `"functions": { "api/index.ts": { "maxDuration": 30 } }`) or collapse the chat path to one attempt.

---

### 5.9 L-03 — mobile input and viewport

**Before** (`public/widget.js:397,577`):

```js
'max-height:calc(100vh - 16px)',
...
'font-size:0.9375rem',
```

**After:**

```js
'max-height:calc(100vh - 16px)',
'max-height:calc(100dvh - 16px)', // modern browsers; the previous line is the fallback
...
'font-size:max(16px, 0.9375rem)', // prevents iOS focus zoom
```

---

## 6. Pillar assessments

### 6.1 Security, privacy, compliance

**Strengths.** Input validation is consistent (`safeParse` on all three write bodies; `req.body` is never trusted). The admin key comparison hashes both sides and uses `timingSafeEqual`, removing the length oracle. PII is blocked before the model and redacted from history. Records are AES-256-GCM with random 96-bit IVs, an authenticated tag, a key-id ring, and a rekey CLI. Erasure rewrites to a temp file and renames; a failure leaves the log unchanged. The lead export is paginated and access-audited. CORS is deny-by-default, `x-powered-by` is off, CSP has no `unsafe-inline` scripts, HSTS is present, and the app never reflects an unvalidated `Origin`.

**Gaps.** C-01 is the dominant issue: the application delegates its admin security posture to CI. C-02 means the API's consent block is not evidence even though the action layer treats it correctly. C-03 makes the consent artefact weaker than it looks. C-04 lets caller free text into analytics. C-05 lets the client label medical consent. M-05 means "durable" was not crash-durable (now fixed). M-08 makes the abstention hash dictionary-attackable. M-10 now has a subprocessor register, but the DPAs and retention settings it tracks are still unfiled. There is no SAST, no image scan, and no manual screen-reader proof in CI (the latter is documented).

**Compliance posture.** The product is unusually careful about _what it does not do_: no advice, no quotes, no health data in Phase 1, no PII in chat, no analytics PII by design, explicit channel consent, and a deterministic handoff. The gap is evidentiary: the consent record, the analytics stream, and the vendor chain need to be verifiable, not just intended. The privacy notice is still a draft (`docs/privacy-notice.md:3`), and the retention schedule is operator-triggered (`DATA_RETENTION_DAYS=2555`). Those are launch-gate items, not code bugs.

### 6.2 Architecture and code quality

The domain separation is good: `config`, `security`, `llm`, `consent`, `privacy`, `scheduling`, `compliance`, `medical`, `cards`, `evaluation`, `accessibility`, and `state-machine` are coherent modules with explicit contracts. The validation-retry orchestrator is a clean pipeline. The booking ledger uses `O_CREAT|O_EXCL` and cross-process tests. Comments explain _why_ a control exists, not just what it does — rare and valuable.

The weaknesses are concentration and dead policy. `src/app.ts` is 1,801 lines and owns routing, validation orchestration, state derivation, DIME merging, card resolution, action execution, session mutation, and response shaping. `security-controls.ts` is 2,837 lines. `LOOP_CONTROLS`, `PROHIBITED_PRESSURE_TACTICS`, `FORBIDDEN_CHAT_FIELDS`, and the approved-topic lists are exported but never enforced; a reader can easily believe the state machine enforces them. The `getNextState` call uses constants, so the pure-function tests pass while the product path does not. That is the classic "tested unit, untested integration" failure.

**Refactor direction:** introduce `src/http/routes/{chat,consent,admin,scheduling,dsr}.ts`, `src/services/{lead,consent,handoff}.ts`, and `src/http/middleware/{admin-auth,rate-limit,security-headers}.ts`; keep `createApp()` as composition. Add a `buildResponseEnvelope(serverFacts)` factory to remove the repeated 12-field empty `lead_data` blocks. Delete or enforce the dead policy constants.

### 6.3 Performance and scalability

The measured 1.4 s cache-miss scan is the headline. It is CPU-bound decryption inside an async function; it blocks the event loop for the duration and happens before the model call, so it directly adds to time-to-first-token for every new visitor. At 3,397 records the file is 3.7 MB; at 100k records it is ~110 MB and the scan is tens of seconds. The boot loader also reads the entire file into an array, then decrypts into a 5,000-entry LRU. The admin export reads the whole log per page. The LLM path can take 20 s (two attempts) or 40 s (orchestrator validation retry), which exceeds common serverless limits.

Positive: `compression()` is enabled; static assets are 20.6 KB gzip; the widget is a single classic script with no framework; retrieval is in-memory; writes are streamed; rate limits are bounded LRUs; the global budget is outside the LRU so a client-key flood cannot evict it.

**Targets:** P95 chat first token < 2 s at 10k leads; lookup < 50 ms at 100k; no whole-file reads on the request path; `maxDuration` ≥ worst-case or a single-attempt chat path.

### 6.4 Testing and DevOps

**Testing is a strength.** 68 suites / 3,087 tests / 90 % statements, with dedicated suites for PII, medical gating, prompt injection, schema rules, record encryption, key rotation, DSR, erasure, retention, lead export, booking ledger cross-process, worker smoke, Docker posture, workflow pinning, document lint, a11y contract, and axe in Chromium. The coverage floor is enforced. The tests are mostly behavioural, not snapshot-brittle, and they use real temp files/processes where it matters.

**Blind spots.** (1) No test asserts that the route overwrites model `lead_data`/`consent` — C-02. (2) No test drives the route from `education` through `qualification_offer`/`contact_offer`; the tests seed those states — C-06. (3) No test asserts `topicCategory` is categorical — C-04. (4) Test records leak into `data/` — M-01. (5) No real-browser end-to-end chat/consent flow (the a11y gate is browser-real; the functional E2E is DOM-shim/supertest). (6) No load test for the lookup/export.

**CI/CD.** Good: SHA-pinned actions, read-only default permissions, `npm ci`, lint/format/typecheck/build/test with coverage, a11y gate, dependency audit, gitleaks over full history with a checksum-verified binary, dependency review, weekly Dependabot, a post-deploy smoke check, and a `workflow_run` deploy restricted to `main` push + success. Missing: CodeQL/Semgrep, container image scan, SBOM, deploy environment approval, and a post-deploy auth probe (e.g. assert admin routes 503 without a key).

### 6.5 UI/UX and accessibility

The widget is a genuine accessibility effort, not a compliance veneer. It uses a shadow root with `all: initial` to stop host-page CSS from breaking target size/contrast; a non-modal `role="dialog"` with a visible accessible name; focus into the input on open and back to the launcher on close; Escape to close; a `role="log"` transcript with visually hidden speaker labels; `aria-describedby` tying the input to the privacy banner; real `<label>`; a two-tone 3 px focus ring measured against each surface; `prefers-reduced-motion` and `forced-colors` support; 24 px minimum targets; radio-group semantics for the slot picker with roving tabindex; and textContent-only rendering. The axe gate reports **0** serious/critical violations across closed, open, and dark-host scans, and a control probe proves the scan can still detect an injected `image-alt` failure. The manual Section 508 review is complete and honest about the missing screen-reader pass.

Residual issues are small: the 15 px input (iOS zoom), `100vh` on mobile, redundant `aria-live`, no `aria-busy` during the pending reply (the typing indicator covers it), and the screen-reader gap. Typography uses rem-based sizes and a sensible 1.45 line-height; the panel reflows at 320 px and 400 % zoom (per the review). The palette's tightest pair is the red headline on light slate at 4.735:1, which passes AA for normal text but has little headroom; do not darken the background or lighten the red without re-measuring.

**UX gap:** there is no consent/contact form in the widget, so the "talk to a human" path ends in prose and an external link. That is both a conversion problem and a compliance-evidence problem (C-08).

---

## 7. File-by-file register

### 7.1 Application source (`src/`, 55 TypeScript files, 33,076 lines)

| File                                                       | Role                                                       | Assessment                                                                                                                                                                |
| ---------------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` (351)                                       | Boot, gates, preflight, listen, cleanup                    | Strong production gates; **does not gate admin auth in pilot** (C-01); serverless skips cleanup (M-15).                                                                   |
| `src/app.ts` (1,801)                                       | Express app, 20+ routes, orchestration, response shaping   | The core risk surface; admin fail-open (C-01), model envelope (C-02), consent hash (C-03), state constants (C-06), scan call (C-07). Extract routes/services (L-06).      |
| `src/config/app-config.ts` (486)                           | Env parsing, product definition, origin allowlist          | Clear defaults and origin matcher; `PILOT_MODE !== 'false'` is fail-open (C-01); `topicCategory` unrelated.                                                               |
| `src/config/durable-storage.ts` (174)                      | Write/read/delete probe for record dirs                    | Good fail-closed design; synchronous probe on first record op; no fsync (M-05).                                                                                           |
| `src/config/trust-proxy.ts` (107)                          | Resolve `trust proxy` from env                             | Correctly refuses `true` and wildcards; Vercel one-hop default; warning on invalid.                                                                                       |
| `src/config/secret-gate.ts` (602)                          | Pre-deploy secret posture                                  | Strong placeholder/length/duplication checks; build-time only.                                                                                                            |
| `src/config/secret-gate-cli.ts` (106)                      | CLI wrapper                                                | Fine.                                                                                                                                                                     |
| `src/security/security-controls.ts` (2,837)                | Injection, PII, health/financial gates, rate/token budgets | Broad, test-heavy, well-reasoned; lexical injection heuristic (M-07); 2.8k-line god module (L-06); logs none of the input.                                                |
| `src/security/security-headers.ts` (68)                    | CSP/HSTS/cache constants                                   | Good; add Permissions-Policy/COOP (L-02).                                                                                                                                 |
| `src/security/context-qualified-terms.ts`                  | Declarative term rules                                     | Data-only, test-covered.                                                                                                                                                  |
| `src/security/context-family-terms.ts`                     | Family rules                                               | Data-only.                                                                                                                                                                |
| `src/security/ordinary-sense-shapes.ts`                    | Ordinary-sense registry                                    | Data-only.                                                                                                                                                                |
| `src/schema/request-schema.ts` (154)                       | Zod for chat/consent/slot                                  | Strong strip/limits; `topicCategory` free text (C-04); medical version client-supplied (C-05).                                                                            |
| `src/schema/response-schema.ts` (457)                      | Model response schema + cross-field rules                  | Good internal consistency; cannot verify truth; model envelope survives (C-02); analytics `topic_category` free text (C-04).                                              |
| `src/llm/llm-client.ts` (353)                              | OpenAI-compatible client, retry, JSON extraction           | Good error redaction; timeout cleared before body (M-03); catch path leaks timer.                                                                                         |
| `src/llm/orchestrator.ts` (504)                            | Retrieval → LLM → validation → fallback                    | Strong pipeline; returns validated model envelope untouched (C-02); logs a fingerprint instead of validator detail (M-06 closed); second LLM call extends latency (M-03). |
| `src/llm/session-store.ts` (446)                           | Conversation state/history, TTL, LRU                       | 30-min TTL, 20-turn/5,000-session caps; serverless cleanup absent (M-15); stores medical text when consented.                                                             |
| `src/llm/llm-probe.ts` / `llm-probe-cli.ts`                | Provider probe                                             | Fine; CLI prints stack traces to stderr only.                                                                                                                             |
| `src/consent/consent-model.ts` (665)                       | Lead records, consent verification, canonical path, copies | Good fail-closed/encryption/cache design; full-log scan (C-07); consent hash caller text (C-03); phone copy only.                                                         |
| `src/privacy/dsr.ts` (422)                                 | DSR intake, verification, suppression                      | Good status model and encryption; free-text detail plaintext possible (M-09).                                                                                             |
| `src/privacy/erasure.ts` (515)                             | Subject erasure, atomic rewrite                            | Good fail-closed semantics; fsynced rewrite via the shared helper (M-05 closed); Windows fallback gives up atomicity (documented).                                        |
| `src/privacy/lead-export.ts` (251)                         | Paginated admin export + access audit                      | Good audit-before-return; whole-file read per page (C-07).                                                                                                                |
| `src/privacy/record-encryption.ts` (309)                   | AES-256-GCM envelope, key ring, rekey                      | Solid; SHA-256 key derivation is fine for high-entropy secrets; no AAD (L-07).                                                                                            |
| `src/privacy/record-rekey.ts` / `-cli.ts`                  | Key rotation                                               | Good; atomic rewrite.                                                                                                                                                     |
| `src/privacy/lifecycle-cli.ts` (138)                       | Retention/erasure operator CLI                             | Fine; operator-triggered only.                                                                                                                                            |
| `src/persistence/jsonl-log.ts` (265)                       | Streamed JSONL I/O                                         | Non-blocking, fail-closed, fsynced writes (M-05 closed); whole-file `readJsonlLines` for boot/export (C-07).                                                              |
| `src/persistence/bounded-lru.ts` (80)                      | Bounded LRU                                                | Simple, correct.                                                                                                                                                          |
| `src/scheduling/appointment-slots.ts` (400)                | Availability/slot verification                             | Time-zone aware; tests cover booking races.                                                                                                                               |
| `src/scheduling/booking-ledger.ts` (206)                   | Durable exclusive claim per slot                           | Strong cross-process design + fsync.                                                                                                                                      |
| `src/tools/verified-actions.ts` (342)                      | Tool authorization/execution                               | Excellent: server consent, selected slot, idempotency, honest refusal of unsent confirmations; `doNotContact` from model (minor).                                         |
| `src/tools/tool-controls.ts` (263)                         | Policy checks                                              | Good, but lower coverage (71 %).                                                                                                                                          |
| `src/state-machine/state-machine.ts` (471)                 | Conversation states/loop controls                          | Pure function is correct and tested; **dead at runtime** (C-06); constants unused (L-05).                                                                                 |
| `src/prompts/system-prompt.ts` (591)                       | Hardened system policy                                     | Detailed, cites rules, treats external content as data; long but coherent.                                                                                                |
| `src/compliance/claim-guard.ts` (143)                      | Deterministic claim checks                                 | Good; negated disclaimers handled.                                                                                                                                        |
| `src/compliance/persona-guardrails.ts` (140)               | Persona/policy validator                                   | Good; decline-no-reoffer guard.                                                                                                                                           |
| `src/compliance/classification-matrix.ts` (269)            | Counsel classification data                                | Data-only.                                                                                                                                                                |
| `src/medical/condition-crosswalk.ts` (5,312)               | ICD-10-CM crosswalk                                        | Large data table; spot-checked; no runtime risk beyond size.                                                                                                              |
| `src/medical/condition-screening.ts` (413)                 | Consented-profile screening                                | Test-covered.                                                                                                                                                             |
| `src/medical/condition-coverage-sweep.ts` / `-cli.ts`      | Coverage sweep                                             | Data/tooling.                                                                                                                                                             |
| `src/phenome/sequelae-crosswalk.ts` (572)                  | Phenome join                                               | Data/derivation.                                                                                                                                                          |
| `src/phenome/phenome-map-schema.ts` (705)                  | Schema/validators                                          | Data-rich, test-covered.                                                                                                                                                  |
| `src/cards/card-library.ts` (495)                          | Approved visual cards                                      | Static content.                                                                                                                                                           |
| `src/cards/card-validation.ts` (142)                       | Card id validation                                         | Good allowlist.                                                                                                                                                           |
| `src/rag/retrieval.ts` (1,106)                             | Corpus retrieval + citations                               | Sanitizes each document; per-query lowercasing/allocation (minor perf); corpus is app-owned.                                                                              |
| `src/rag/rag-architecture.ts` (174)                        | Retrieval design notes                                     | Documentation.                                                                                                                                                            |
| `src/resilience/fallback-behavior.ts` (166)                | Static fallbacks                                           | Clear, safe copy.                                                                                                                                                         |
| `src/handoff/human-escalation.ts` (187)                    | Handoff summaries                                          | PII-minimized.                                                                                                                                                            |
| `src/analytics/analytics.ts` (194)                         | GA4/dataLayer event taxonomy                               | Allowlisted event names; `topic_category` free text (C-04).                                                                                                               |
| `src/analytics/abstention-log.ts` (153)                    | Hashed abstention feed                                     | No raw text; unsalted SHA-256 (M-08); category free text (C-04).                                                                                                          |
| `src/estimator/dime-estimator.ts` (187)                    | DIME math/range                                            | App-computed, model never supplies figures.                                                                                                                               |
| `src/evaluation/*` (4 files)                               | Golden set, guardrail/verdict gates                        | Good offline gates.                                                                                                                                                       |
| `src/accessibility/accessibility.ts` (1,284)               | Widget contract/checks                                     | Strong, detailed.                                                                                                                                                         |
| `src/accessibility/accessibility-checklist.ts` / `-cli.ts` | Manual AT checklist                                        | Good instrumentation.                                                                                                                                                     |
| `src/testing/flake-harness.ts` / `-cli.ts`                 | Flake stress harness                                       | Uses `spawnSync` with fixed args; dev-only; 77 % coverage.                                                                                                                |
| `src/runtime-status.ts` (20)                               | Runtime flag                                               | Trivial.                                                                                                                                                                  |
| `src/contextual/page-context.ts` (110)                     | Untrusted page context validation                          | Strict; accepts `http` and full URL but strips query later.                                                                                                               |
| `src/contextual/context-injection.ts`                      | Allowlisted article data block                             | Excellent SEC-12 design: only app-owned values, user role.                                                                                                                |
| `src/contextual/article-map.ts` (176)                      | URL→article map                                            | Allowlist, no caller title.                                                                                                                                               |

### 7.2 HTTP surface, assets, build, deploy, tests

| File                                             | Assessment                                                                                              |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `api/index.ts`                                   | Thin Vercel adapter; imports `src/index` so gates run.                                                  |
| `worker/sites-entry.mjs`                         | Workers entry for the Sites build; not part of the Express runtime.                                     |
| `public/widget.js` (1,782)                       | Excellent a11y/XSS posture; no consent/contact UI (C-08); 15 px input/`100vh` (L-03).                   |
| `public/demo.html`                               | Minimal demo; CSP pinned.                                                                               |
| `public/elementor-trust-block.css`               | Static host-page styles; no runtime risk.                                                               |
| `Dockerfile`                                     | Multi-stage, non-root, secrets via BuildKit, `NODE_ENV=production`; no image scan/SBOM (L-10/M-12).     |
| `vercel.json`                                    | Rewrites/headers/caching; no `maxDuration` (M-03).                                                      |
| `.github/workflows/ci.yml`                       | Strong gates and coverage; no SAST/image scan (M-12).                                                   |
| `.github/workflows/security.yml`                 | Checksum-pinned gitleaks + dependency review; no SARIF.                                                 |
| `.github/workflows/deploy.yml`                   | `workflow_run` gated to main/push/success; secrets scoped; smoke check; no environment approval (M-13). |
| `.github/dependabot.yml`                         | Weekly npm/actions, majors excluded (L-08).                                                             |
| `jest.config.js`                                 | Coverage floor; **no record-path isolation** (M-01).                                                    |
| `tests/` (68 suites)                             | Broad and behavioural; blind spots C-02/C-04/C-06/M-01.                                                 |
| `docs/section-508-accessibility-review.md`       | Complete manual review + honest screen-reader gap.                                                      |
| `docs/privacy-notice.md`                         | Draft; AI-processing disclosure added, points at the register (M-10).                                   |
| `docs/data-lifecycle-runbook.md`                 | Good operator runbook; retention sweep is manual.                                                       |
| `docs/security-architecture-audit-2026-10-21.md` | Valuable baseline; SEC-01 status is inaccurate (M-11).                                                  |

---

## 8. Strategic action plan

### P0 — before any public traffic (closed 2026-10-22)

1. ✅ **C-01 closed.** Deny-by-default admin auth; no key means 503 in pilot and production. The non-loopback no-key regression is in `tests/p0-security-regressions.test.ts`, and the sandbox checklist now requires `ADMIN_API_KEY` for any reachable instance.
2. ✅ **C-02 closed.** The route overwrites `lead_data`, `consent`, and `state` from server truth; a forged-envelope test asserts the model cannot manufacture any of them.
3. ✅ **C-03 closed.** `/api/consent` compares the submitted copy to the canonical per-channel text, rejects a mismatch, hashes the canonical text, and `/api/consent-text` serves both the email and phone copies. A one-character-copy test is included.
4. ✅ **C-04 closed.** `topicCategory` is an allowlist in request and response; unknown values become `other`; an injected email is tested end to end.
5. ✅ **C-05 closed.** `MEDICAL_CONSENT_VERSION` is server-owned; a mismatch is rejected and the stored version is the configured one.
6. ✅ **Prior audit's status table corrected**, with the rule that a finding is closed only with a code-level regression test.

### P1 — within the week (pilot correctness)

7. ✅ **C-06 closed (2026-10-23).** Structured `intent` fields are validated with the response; the route resolves the prompt state from server facts and persists an intent-derived transition after the response and side effects. `LOOP_CONTROLS` counters live in the session store (clarification cap → handoff, three qualification questions maximum, decline suppresses automatic re-offers). Transition tests start at `education` in [tests/state-machine-wiring.test.ts](../tests/state-machine-wiring.test.ts).
8. ✅ **C-07 closed (2026-10-23).** A PII-free `session_id → lead_id` index is written with each lead and hydrated for an O(1) lookup, including the no-consent answer; it is rebuilt when missing or older than the log, and after erasure/retention rewrites. Boot hydration and the export stream the log line by line. `npm run records:index-sessions` backfills or repairs it. Benchmarked in [tests/session-index.test.ts](../tests/session-index.test.ts) at 50k index entries, and measured at 100k records (738 ms scan → 0.13 ms lookup).
9. ✅ **C-08 closed (2026-10-23).** The widget ships the consent/contact step (canonical copy fetched from `/api/consent-text`, posted to `/api/consent`, lead bound to the session) and a TDPSA request form (`/api/dsr`), both labelled and covered by the real-browser axe scan. End-to-end tests in [tests/widget-contact-e2e.test.ts](../tests/widget-contact-e2e.test.ts).
10. ✅ **M-01 closed (2026-10-23).** `tests/setup/record-paths.ts` redirects every suite's record stores to a private temp directory; the hardening and serverless overrides use `tempLogPath` (or none); [tests/record-path-isolation.test.ts](../tests/record-path-isolation.test.ts) guards the config paths, a real write against `data/`, and any test that points a record path back into the repository. A full run leaves `data/` unchanged.
11. ✅ **M-02 closed (2026-10-23).** Public `/health` is liveness only (`status`, `uptimeSeconds`, `killSwitch`); the readiness posture and compliance matrix are on admin-gated `GET /api/admin/health` (503 without a key, 401 with a wrong one). Regression tests pin the exact public shape and the gated payload.
12. ✅ **M-03 closed (2026-10-23).** A single deadline per attempt now covers `fetch` and the body read, cleared in `finally` on every exit; `vercel.json` sets `maxDuration: 45` for the chat function: above the worst case of two calls × two 10 s attempts (40 s). A stalled-body regression test pins it.

### P2 — next sprint (hardening and scale)

13. ✅ **M-04 closed (2026-10-23).** All six data-returning admin reads write a PII-free entry (`route`, hashed `actor_key_id`, opaque `record_id` or `unrecognized`, `status`) to `ADMIN_ACCESS_LOG_PATH` before answering, and answer 503 with no payload if the write fails. The fail-closed test also exposed that `appendJsonlLine` ignored the error `Writable.end()` hands its callback, so a failed open resolved `true`; it now returns `false`. Pinned in [tests/admin-access-audit.test.ts](../tests/admin-access-audit.test.ts) and [tests/persistence.test.ts](../tests/persistence.test.ts).
14. ✅ **M-05 closed (2026-10-23).** Appends open, write, `fsync` and close, and flush the parent directory when the append creates the file; rewrites `fsync` the temp file before the rename and the directory after it, and erasure plus key rotation now share that path with the session index. Measured at ~5 ms per append on this machine's APFS volume (0.08 ms without), paid only on record writes, not on chat turns. The RPO is documented in [data-lifecycle-runbook.md](data-lifecycle-runbook.md#8-durability-and-rpo).
15. ✅ **M-06 closed (2026-10-23).** Errors are logged as `{name, code, status, type}` (plus method and route shape) and payloads as `len=<n> sha=<12>`; `llm-client` classifies aborts, body-parse failures and errnos instead of copying messages, so the value cannot carry provider text into the log or `error_code`; a source gate fails any request-path `console.*` that passes an error, its `.message`, or an unreduced `.detail`. Pinned in [tests/log-redaction.test.ts](../tests/log-redaction.test.ts), including a mutation check that the gate actually fires.
16. ✅ **M-08 closed (2026-10-23).** The abstention hash is HMAC-SHA-256 keyed with `ABSTENTION_LOG_KEY`, with a 12-hex key id per entry so a rotation is visible; no key means no entry (and a boot warning), because an unkeyed digest of "I have HIV" is one dictionary lookup away. Dedup still works within a key, and a rotation starts a new window — stated in `.env.example` and the runbook. Pinned in [tests/abstention-log.test.ts](../tests/abstention-log.test.ts), including the assertion that the stored value is not the bare SHA-256.
17. ✅ **M-09 closed (2026-10-23).** A DSR's free text is stored only inside the encrypted envelope. Without a key the intake still accepts the request, records `detail_withheld`, tells the caller to email it, and refuses at the persistence boundary if a detail ever reaches a non-envelope line. Pinned in [tests/dsr.test.ts](../tests/dsr.test.ts) (no key ⇒ request kept, text absent from the log; key ⇒ text round-trips) and [tests/api-endpoints.test.ts](../tests/api-endpoints.test.ts) (the response flag and message).
18. **M-10 (partially done 2026-10-23):** [docs/subprocessors.md](subprocessors.md) now lists every destination the code sends data to, the gate before each, and the DPA/region/retention artifacts still to be filed; the privacy notice discloses AI processing and links it. Remaining — and only the operator can do it — is filing those contracts and recording the provider's retention setting. The register deliberately marks them _not on file_ rather than claiming a vendor term the repository cannot evidence.
19. **M-12/M-13:** add CodeQL/Semgrep + image scan + SBOM; require a production environment approval.
20. **L-06:** extract routes/services; add a response-envelope factory; delete or enforce dead policy constants.
21. **L-07:** bind `v`/`kid` as GCM AAD.
22. **L-03/L-04:** 16 px input, `100dvh`, one live-region mechanism.
23. **L-02:** add Permissions-Policy/COOP.
24. **M-14:** idempotent consent submissions.
25. **M-15:** document per-instance budgets; plan a shared store before horizontal scale.

### P3 — ongoing

26. **Manual screen-reader matrix** (NVDA/Chrome, JAWS/Edge, VoiceOver/Safari, TalkBack/Chrome Android); record receipts.
27. **Load test** the chat path at 10k/50k/100k leads; assert P95 and memory.
28. **External penetration test** focused on the LLM trust boundary, admin surface, and record store.
29. **Counsel review** of the privacy notice, consent copy, classification matrix, and medical flow; publish the notice before any Phase 2 enablement.
30. **Retention/backup schedule** configured and tested (restore drill), not just documented.
31. **Quarterly dependency major-upgrade window** (Express 5, Zod 4, TypeScript).
32. **Post-deploy auth probe** in CI: assert admin routes 503/401 without a key on the deployed origin.

### Verification after each fix

```bash
npm run typecheck
npm run lint
npm test -- --coverage
npm run a11y:e2e
npm audit --audit-level=high
# targeted probes:
#   no-key, non-loopback admin route → 503/401
#   forged model envelope → null lead_data, consent false
#   bad consent copy → 400
#   email in topicCategory → 400/other
#   getVerifiedContactConsent at 50k → < 50 ms
#   full suite with temp paths → repo data/ unchanged
```

---

## 9. Acceptance criteria for "closed"

A finding is closed only when **all** of the following hold:

1. The code change is merged.
2. A regression test exercises the exact failure mode (not a unit test of a helper).
3. The test fails on the pre-fix commit and passes on the fix.
4. The relevant CI gate is required on `main`.
5. The prior audit/status document is updated with the commit and test name.

For C-01 specifically, the test must run against a non-loopback request with no key, in pilot mode, and assert **503/401** — not 200.

---

## 10. Limitations

- This review is static plus targeted probes; it is not a penetration test.
- No live model call was made, so prompt-injection behaviour against the configured provider is inferred from structure and tests, not observed.
- No production deployment or real record store was touched; the admin probe used an empty temp store.
- The 1.4 s lookup measurement is on a local macOS filesystem with 3,397 encrypted records; production storage (Archil/volume) may differ.
- The 5,312-line `condition-crosswalk.ts` and the phenome data tables were spot-checked for structure, not line-by-line clinically validated.
- Line numbers are at commit `51ea666` plus the working tree at review time; the working tree already contained uncommitted changes, so a later commit may shift them.
- No screen reader was driven; the axe result is not a substitute for NVDA/VoiceOver.
- This is not legal advice. Texas insurance counsel and the carriers must approve the scripts, consent language, classification, retention, and vendor terms.

---

## Appendix A — Probe outputs (trimmed)

Admin posture, `createApp()` with `PILOT_MODE=true`, `ADMIN_API_KEY=''`, temp record store:

```
GET /api/admin/leads                    -> 200 {"exportedAt":"...","auditId":"...","count":0,...}
GET /api/session/lpp_aaaaaaaaaaaa/history -> 200 {"sessionId":"...","turnCount":0,"messages":[]}
GET /api/system-prompt                  -> 200 {"systemPrompt":"# LIFE POLICY PILOT AI ..."}
GET /api/sessions                       -> 200 {"activeSessions":0}
GET /health                             -> 200 {"status":"ok",...,"llm":{"configured":false,"model":"gpt-4o","baseUrl":"https://api.openai.com/v1"},...}
```

Lookup cost, real encrypted store:

```
result false elapsed_ms 1398
data/lead-records.jsonl: 3397 lines, 3.7M
```

Test suite with temp paths:

```
Test Suites: 68 passed, 68 total
Tests:       3087 passed, 3087 total
Time:        21.387 s
```

Accessibility gate:

```
closed widget (launcher): 0 violation(s), 0 serious/critical (26 rules passed)
open widget (panel and transcript): 0 violation(s), 0 serious/critical (36 rules passed)
open widget in a dark host context: 0 violation(s), 0 serious/critical (36 rules passed)
Accessibility gate passed: no serious or critical axe violations.
```

Dependencies:

```
{"info":0,"low":0,"moderate":0,"high":0,"critical":0,"total":0}
```

---

## Appendix B — Coverage (existing run)

| Metric     | Covered / Total | Percent | Threshold |
| ---------- | --------------- | ------- | --------- |
| Lines      | 3,473 / 3,859   | 89.99 % | 85 %      |
| Statements | 3,741 / 4,190   | 89.28 % | 85 %      |
| Functions  | 561 / 617       | 90.92 % | 85 %      |
| Branches   | 2,324 / 2,842   | 81.77 % | 75 %      |

Lowest-value gaps: `src/testing/flake-harness.ts` 77 %, `src/tools/tool-controls.ts` 71 %, `security-controls.ts` 89 % (the uncovered lines are mostly cleanup/edge branches, not the core gates).
