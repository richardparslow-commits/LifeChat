# LifeChat by Life Insurance Broker Advocate

A compliance-first AI chatbot/AI agent for [Life Insurance Broker Advocate](https://lifeinsurancebrokeradvocate.com/), a Texas-licensed life insurance educational website. The assistant is a **grounded, guardrailed educational agent**: it answers only from an approved RAG corpus, abstains when evidence is insufficient, blocks sensitive data before it reaches the model, enforces per-session rate and token budgets, and routes anything individualized to a licensed-human handoff through fail-closed, encrypted persistence.

## ⚠️ Compliance Notice

This is a **product and risk-control specification implementation**, not a legal opinion. Before launch, Texas insurance counsel and every affected carrier/compliance department must approve the final scripts, product references, consent language, retention schedule, integrations, and advertising classification.

The assistant is **educational, not advisory**. It may explain approved content and offer a meeting; it must not recommend a policy, carrier, face amount, premium, tax strategy, replacement, or annuity transaction.

## What It Does

- **Grounded RAG answers with citations** — retrieval over approved sources (broker-approved articles, controlled FAQ, NAIC/TDI/regulatory material) with claim-level source titles and canonical URLs. Grounding failures and off-topic questions produce an abstention sentence rather than a guess.
- **Deterministic safety gates before any LLM call** — prompt-injection detection, health-data and financial-account-data blocking (with redacted session history and a licensed-broker handoff), health-topic questions routed to the same handoff, and a kill switch.
- **Persona & policy guardrails** — a hardened system prompt (identity, abstention rules, prohibited promotion/comparison copy, consent rules) enforced by a deterministic persona validator, an offline golden-set gate (`test:guardrails:golden`), and a verdict gate (`test:verdicts`) so approved personas can never drift from model behavior.
- **Consented lead capture & data-subject rights** — `/api/consent` and `/api/dsr` both persist **fail-closed** (an acknowledgment is only issued after the record hits disk) and **encrypted at rest** when `RECORD_ENCRYPTION_KEY` is set (AES-256-GCM envelopes; loaders warn loudly when records are skipped for a missing or mismatched key). In pilot mode without a key, a contact-only record still persists in plaintext for development, but a **medical profile is refused (`503`) rather than stored in clear** — health data requires the key in every mode.
- **Admin-gated operations** — system prompt, session history, session listing/deletion, RAG search, DSR status/verification/erasure, and the retention sweep require an `x-admin-key` header compared in constant time. When `ADMIN_API_KEY` is not configured they answer 503 in every mode, including pilot.
- **Per-window budgets that actually enforce** — 20 requests and 50,000 tokens per session per 60-second window (the token budget counts real LLM usage end-to-end; a locked-out session recovers on window rollover).
- **Contextual content bridge** — the article being read enriches the opening message and prioritizes RAG retrieval; pre-approved visual cards can attach to responses.
- **Consent and privacy requests in the widget** — because the chat refuses direct identifiers, the widget ships the secure path it points at. **Talk to a licensed broker** opens a contact form that loads the canonical disclosure from `GET /api/consent-text` (submission stays disabled if it cannot be fetched), posts the affirmed copy to `POST /api/consent`, and binds the lead to the widget's session. **Privacy request** opens a TDPSA intake that posts to `POST /api/dsr` and shows the server's request id and response window. Both forms are labelled, keyboard-operable, announced through `status`/`alert` regions, and scanned by the real-browser axe gate.
- **In-chat scheduling** — on a scheduling turn the widget renders the server's own bookable times (`GET /api/scheduling/slots`) as a labelled group of buttons, each labelled with the practice's local time. Choosing one posts that id to `POST /api/scheduling/select`; the model never supplies a time, and selecting books nothing until the visitor confirms. A **Change time** button reopens the list at the current choice, and a new selection replaces the prior one on that session rather than stacking a second.

## Key Design Principles

1. **Legal and consumer safety first** — every design decision prioritizes compliance, and the [classification matrix](docs/compliance-classification-matrix.md) records how each flow is classified for counsel
2. **Truthful, grounded education** — RAG over approved sources with claim-level citations; abstention over invention
3. **No health or financial data in chat** — health conditions (and now routing/account numbers too) are sensitive data: blocked deterministically, redacted from logs, routed to a licensed-broker handoff; health collection stays inert unless `HEALTH_DATA_COLLECTION_DISABLED=false` is set after counsel approval and only with explicit medical consent (Phase 2)
4. **Fail-closed records** — leads and DSRs are acknowledged only after a durable, encrypted write: the line is `fsync`ed (and the directory too when the write creates the file), and rewrites `fsync` the temp file and the directory around the rename, so a crash cannot resurrect an erased log. A lost write surfaces as 500/503, never as a false success; the RPO this buys is in the [data lifecycle runbook](docs/data-lifecycle-runbook.md#8-durability-and-rpo). Encrypted records carry a key id and the reader accepts a ring of previous keys, so rotating the key does not orphan existing records, and production refuses unauthenticated plaintext lines
5. **Explicit channel-specific consent** — never implied or blanket consent
6. **Deterministic tool authorization** — the model proposes; application code validates (Zod schema, cross-field consent rules, promotional/phrasing checks, and a claim guard that blocks guarantees, figures, rankings and identifiers in the model's message). Appointment slots are held by one durable, exclusive claim file per slot, so two instances cannot confirm the same time
7. **Auditable events** — no PII in analytics; GA4 events are categorical and allowlisted, session history stores redacted placeholders for sensitive messages, and encrypted record logs refuse to load silently (missing or wrong key = explicit startup warning). Server logs follow the same rule: a failure is logged as its name, code, status and type, a rejected payload only as a length and hash, and a source gate fails any new `console.*` that would pass an error object, its message, or model text

## Tech Stack

- **Backend**: Node.js / TypeScript / Express
- **Validation**: Zod schema validation of every model response
- **LLM**: single-call + validation-retry orchestrator with safe fallbacks (no autonomous tool loop; tool budgets removed until real tools exist)
- **Frontend**: Vanilla JS drop-in widget (no framework dependency), carrying a tested Section 508 / WCAG 2.2 AA contract
- **Analytics**: GTM/GA4 with dataLayer (no PII)
- **At-rest encryption**: AES-256-GCM envelopes for lead and DSR record logs

## Project Structure

```
LifeChat/
├── src/
│   ├── config/
│   │   └── app-config.ts          # Product definition & configuration
│   ├── prompts/
│   │   └── system-prompt.ts       # Hardened system prompt (Section 5)
│   ├── state-machine/
│   │   └── state-machine.ts       # Conversation state machine (Section 4.4)
│   ├── schema/
│   │   └── response-schema.ts     # JSON output schema & validation (Section 15)
│   ├── consent/
│   │   └── consent-model.ts       # Lead records: fail-closed, encrypted, consent model (Section 4.7)
│   ├── medical/
│   │   ├── condition-crosswalk.ts       # Versioned ICD-10-CM condition crosswalk, v1.22.0 — 471 conditions (Phase 2, consented only)
│   │   ├── condition-coverage-sweep.ts  # Coverage sweep: every candidate phrase mapped, gated, or deferred (docs/medical-condition-candidates-*.txt)
│   │   ├── condition-coverage-sweep-cli.ts # CLI + --json for the sweep (npm run conditions:sweep)
│   │   └── condition-screening.ts       # Consented-profile screening over the qualifier dimensions (childhood vs adult, suicidal vs not)
│   ├── phenome/
│   │   ├── phenome-map-schema.ts        # Row schema + validators for the systemic-phenome rule set
│   │   ├── ptsd-phenome-map.json        # Graded PTSD systemic-sequelae rows (tiers, conflicts, verification status)
│   │   └── sequelae-crosswalk.ts        # Joins canonical conditions to phenome rows (graded or explicit no-phenome-evidence)
│   ├── privacy/
│   │   ├── dsr.ts                 # DSR intake (TDPSA rights) — fail-closed, encrypted
│   │   └── record-encryption.ts   # AES-256-GCM envelope / keyless-warning helpers
│   ├── security/
│   │   ├── security-controls.ts        # Injection + sensitive-data gates, rate & token budgets, constant-time admin key check (Section 4.9)
│   │   ├── context-qualified-terms.ts  # Declarative context-qualified rules (condition, treatment, heart, symptom…)
│   │   ├── context-family-terms.ts     # The seven broad context families as declared clause data
│   │   └── ordinary-sense-shapes.ts    # Ordinary-sense strips (product provisions, topic mentions, compounds) as one registry
│   ├── accessibility/
│   │   ├── accessibility.ts            # Accessibility gate and checks
│   │   ├── accessibility-checklist.ts  # The runnable assistive-technology checklist the gate reads
│   │   └── accessibility-checklist-cli.ts # CLI that records a walkthrough's results (npm run a11y:checklist)
│   ├── compliance/
│   │   ├── classification-matrix.ts   # Flow classification for counsel
│   │   ├── claim-guard.ts             # Deterministic claim guard (guarantees, figures, rankings, identifiers)
│   │   └── persona-guardrails.ts      # Deterministic persona/policy validator
│   ├── llm/
│   │   ├── orchestrator.ts        # Retrieve → abstain-or-LLM → validate/retry → fallback
│   │   └── llm-client.ts          # API client incl. real token-usage capture
│   ├── rag/
│   │   ├── rag-architecture.ts    # Knowledge tiering (Section 4.6)
│   │   └── retrieval.ts           # Retrieval with priority weighting + controlled FAQ
│   ├── contextual/
│   │   └── context-injection.ts   # Contextual Content Bridge (article → RAG priority + instruction)
│   ├── cards/
│   │   └── card-library.ts        # Pre-approved visual cards
│   ├── tools/
│   │   └── tool-controls.ts       # Tool & integration controls (Section 4.8)
│   ├── handoff/
│   │   └── human-escalation.ts    # Human escalation & SLAs (Section 4.10)
│   ├── resilience/
│   │   └── fallback-behavior.ts   # Failure, latency & fallback (Section 4.11)
│   ├── evaluation/
│   │   └── evaluation-plan.ts     # Evaluation & QA plan (Section 4.14)
│   ├── estimator/
│   │   └── dime-estimator.ts      # DIME coverage-needs estimator (educational)
│   ├── analytics/
│   │   ├── analytics.ts           # GTM/GA4 dataLayer events (categorical, no PII)
│   │   └── abstention-log.ts      # Hashed, anonymized abstention feed for content strategy
│   └── index.ts                   # Express server entry point (admin auth, session store, endpoints)
├── public/
│   ├── widget.js                  # Embeddable chat widget
│   ├── demo.html                  # Local widget preview (serve with a dev-run server)
│   └── elementor-trust-block.css  # Elementor "Trust & Transition" CSS
├── docs/                          # Compliance matrix, persona config, privacy notice, candidate corpora (medical-condition-candidates-*.txt), etc.
├── tests/                         # 33 suites incl. API, consent/DSR persistence, encryption, admin auth, server hardening, the gate road test, and the coverage sweep
├── package.json
├── tsconfig.json
└── README.md
```

## Getting Started

```bash
# Install dependencies
npm install

# Run in development mode
npm run dev

# Build for production
npm run build

# Start production server
npm start

# Type-check
npm run typecheck

# Run tests — each suite's record stores are redirected to a private temp
# directory by tests/setup/record-paths.ts, so the repo's data/ is never written
npm test

# Lint
npm run lint

# Auto-fix lint errors
npm run lint:fix

# Format code
npm run format

# Check formatting without writing
npm run format:check
```

## Verification Gates (offline, run in CI)

```bash
# Persona golden-set gate — every golden sample's assistant_message must be persona-clean
npm run test:guardrails:golden

# Verdict gate — judged samples score against the schema, persona guardrails, and policy
npm run test:verdicts

# Both + persona unit tests
npm run test:persona

# Repeat-until-failure harness for the suites that have flaked in full runs.
# Stops at the first failure, keeps that log, and reruns each failing test alone
# to say whether it is deterministic or load/order dependent.
npm run test:flake -- --iterations 20
npm run test:flake -- --suite tests/api-endpoints.test.ts --workers 50%

# Section 508 walkthrough — the runnable checklist and the recorded results it validates
npm run a11y:checklist

# Automated accessibility gate — axe-core over /demo.html in Chromium, failing on
# serious/critical violations. Install the browser once with
# `npx playwright install chromium`; CI installs it with the Playwright deps.
npm run a11y:e2e

# Pre-deploy posture gate — rejects a missing, short, placeholder, repeated,
# sequential, or low-entropy ADMIN_API_KEY / RECORD_ENCRYPTION_KEY / LLM_API_KEY,
# a TEXAS_LICENSE_NUMBER that is the pending sentinel or a number-shaped
# placeholder (all digits repeated or in a straight run), and a secret reused
# under two names. The license is a public identifier, so it is reported by
# shape only. The deploy workflow runs this before the build; `-- --mode pilot`
# makes the values optional but still validates any that are set.
npm run secrets:gate

# Data lifecycle — verify/erase a DSR, or run the retention sweep. Erasure
# requires a verified deletion request and derives the subject from it; see
# docs/data-lifecycle-runbook.md for the full procedure.
npm run data:lifecycle -- retention --dry-run

# Record-key rotation — set the new RECORD_ENCRYPTION_KEY, list the previous
# secret in RECORD_ENCRYPTION_KEYS, then rewrite every encrypted record log
# under the new key (atomic per file; exits 1 and leaves a file untouched if
# any line cannot be decoded). See docs/data-lifecycle-runbook.md §7.
npm run records:rekey -- --dry-run

# Session → lead index — rebuild the derived, PII-free lookup file from the
# lead log (session_id, lead_id, created_at only). The server writes it with
# each consent and repairs it when missing or older than the log; run this
# after restoring a log, or to check how many sessions it binds.
npm run records:index-sessions

# Condition-coverage sweep — every candidate phrase is mapped, gated, or
# deliberately deferred (exits 1 on a silent row). Sweeps all 13 committed
# sources in one run: the carrier questionnaire and critical-illness lists,
# ten ICD-10-CM chapter enumerations (V, VI, IX, X, XI, XII, XIII, XIV,
# XVIII, XXI), and the deferral ledger, which is re-asked on every sweep.
npm run conditions:sweep

# The sweep's machine-readable form (per-source totals and per-row status)
npm run conditions:sweep -- --json

```

## Deployment

**There is one supported production topology: a single long-running Node
process with a persistent volume.** Steps 2–9 of
[docs/sandbox-deployment.md](docs/sandbox-deployment.md) are the runbook. In
short:

- Build the image with `scripts/build-docker-image.sh`; the [`Dockerfile`](Dockerfile)
  runs the pre-deploy posture gate inside the build, so a weak or placeholder
  value fails the build rather than shipping.
- `npm run build && npm start` binds the port itself (`LIFECHAT_PORT` wins, else
  the platform-injected `PORT`).
- Mount a volume and point `LEAD_LOG_PATH`, `DSR_LOG_PATH`,
  `ABSTENTION_LOG_PATH`, `LEAD_ACCESS_LOG_PATH`, `ADMIN_ACCESS_LOG_PATH`,
  `ERASURE_LOG_PATH` and `BOOKING_LEDGER_PATH` at it. Boot proves each directory
  writable; when it cannot, every record write answers 503 instead of
  acknowledging a record the next restart would lose.
- Run **one replica**. Sessions, rate-limit budgets and the appointment ledger
  are process-local, and the record files are append-only JSONL with one writer.

**Not supported for production: serverless functions** (Vercel, Netlify,
Cloudflare Workers). `/api/consent` and `/api/dsr` return 503 there by design,
because a consent hash and a TDPSA request are legal records that a recycled
instance would lose, and a widget session would silently restart mid-conversation
on every cold start. Nothing in the repository claims otherwise; the remaining
`Deploy (Vercel)` pipeline is a **sandbox demo path only**, and §11 of the
runbook lists what it cannot do. Do not host the Lovable embed's API there.

The reasoning (why the API cannot be a Workers/Edge function: `fs` streams,
AES-256-GCM record encryption, in-process session state) is recorded in
[docs/lovable-migration-readiness-audit.md](docs/lovable-migration-readiness-audit.md) §11.

### Release flow (required by branch protection)

`main` is protected: direct pushes are rejected (`GH006`), the merged branch
must be up to date, and both `Typecheck, Build & Test (22)` and
`Typecheck, Build & Test (24)` must pass. Administrators are not exempt, and
no approving review is required — the automated checks are the gate. Every
change therefore lands through a pull request and a merge commit, matching the
existing history:

```bash
git switch -c release/<slug>
git add <paths> && git commit -m "<imperative summary>"
git push -u origin release/<slug>
gh pr create --base main --head release/<slug> --fill

gh pr checks --watch          # both matrix jobs must go green
gh pr merge --merge           # merge commit, not squash or rebase
git switch main && git pull --ff-only

git push origin --delete release/<slug>   # the merged branch is deleted

git branch -d release/<slug>
```

The `Deploy (Vercel)` workflow — the sandbox demo path, not the supported
topology — is triggered by the CI run on `main`, never by a pull request, so a
red PR cannot deploy. Its first step reports whether the pipeline is enabled
and whether every required repository secret and variable is present; see §11
for the list.

## Configuration

Set environment variables (or create a `.env` file):

```bash
LIFECHAT_PORT=3000 # wins when set; otherwise PORT is honored (hosting platforms inject PORT)
ALLOWED_ORIGINS="" # cross-origin embed allowlist; empty = same-origin only (see Embedding the Widget)
BUSINESS_NAME="LifeChat" # the assistant/product; the provider is Life Insurance Broker Advocate
LICENSED_BROKER_NAME="Richard Parslow"
TEXAS_LICENSE_NUMBER="[Your Texas license number]" # verified TDI number; placeholders and the pending sentinel are rejected by the pre-deploy gate and by production startup
APPOINTED_CARRIERS="" # comma-separated carriers Richard Parslow is appointed with (allowlist)
WEBSITE_URL="https://lifeinsurancebrokeradvocate.com/"
PRIVACY_NOTICE_URL="https://lifeinsurancebrokeradvocate.com/privacy"
CONTACT_URL="https://lifeinsurancebrokeradvocate.com/contact"
DSR_CONTACT_EMAIL="richardparslow@lifepolicypilot.blog" # TDPSA rights channel; DSR_EMAIL accepted as the legacy name. Verified by `npm run rights:channel`
LLM_API_KEY="your-api-key" # provider key: required by the production pre-deploy gate, optional at runtime (no key = static fallback)
LLM_MODEL="gpt-4o"
PILOT_MODE=true
HEALTH_DATA_COLLECTION_DISABLED=true # set false ONLY after counsel approval (gated medical capture)
FREE_OFFER_MARKETING_APPROVED=false # free-quote/free-consultation phrasing blocked until marketing review
CONTEXTUAL_BRIDGE_ENABLED=true # Contextual Content Bridge: enrich opening message + RAG from the article being read
VISUAL_CARDS_ENABLED=true # Visual Rich Cards: attach pre-approved educational cards to responses
ABSTENTION_LOGGING_ENABLED=true # Abstention logging for content strategy: keyed-hash, anonymized JSONL feed (non-PII)
ABSTENTION_LOG_PATH="data/abstention-log.jsonl"
ABSTENTION_LOG_KEY="" # 32+ chars (openssl rand -hex 32). Keys the question hash; without it nothing is recorded (an unkeyed hash is reversible by dictionary lookup). Rotating it starts a new dedup window

# Security & record store (added in the compliance audit)
ADMIN_API_KEY="" # when set (32+ chars), gates /api/system-prompt, session history/sessions, RAG search, DSR status, and the runtime kill switch, via x-admin-key; a shorter key refuses to start
RECORD_ENCRYPTION_KEY="" # 32+ chars (openssl rand -base64 48). Encrypts DSR + lead logs at rest; loaders warn and skip records if missing or wrong. Do not change after records are written.
TRUST_PROXY="" # empty = trust no proxy. Set to your proxy's hop count (1), keyword (loopback), or subnet list only when you control it; an unparseable value is ignored with a warning
DSR_LOG_PATH="data/dsr-records.jsonl"
LEAD_LOG_PATH="data/lead-records.jsonl"
LEAD_SESSION_INDEX_PATH="data/lead-records-session-index.jsonl" # derived, PII-free session → lead lookup; rebuilt automatically
ERASURE_LOG_PATH="data/erasure-log.jsonl" # PII-free audit of erasures and retention sweeps
ADMIN_ACCESS_LOG_PATH="data/admin-access-log.jsonl" # PII-free audit of every admin read; the read is refused if this write fails
DATA_RETENTION_DAYS="2555" # seven years; enforced only by the operator-triggered retention sweep
```

> **License disclosure:** `TEXAS_LICENSE_NUMBER` is required before going live
> (Texas Insurance Code §541.003 / TAC §19.1004) and is checked by the pre-deploy
> gate for the pending sentinel, templates, letters, repeated digits, and
> straight runs (`1234567`). While unset, `/api/disclosure`
> returns `texasLicenseNumber: null` (never the placeholder) and production startup
> (`PILOT_MODE=false`) fails fast. The appointment disclaimer
> ("Richard Parslow is appointed with select carriers. Coverage availability may
> vary.") is always served, and `APPOINTED_CARRIERS` is the allowlist the assistant
> must never imply coverage from beyond.
>
> **Record encryption:** when `RECORD_ENCRYPTION_KEY` is set, lead and DSR writes
> are envelope-encrypted (AES-256-GCM) before hitting disk. Without a key, pilot
> mode falls back to plaintext for contact-only records and warns at startup
> whenever encrypted records are skipped, but `/api/consent` refuses a medical
> profile with `503` — a consented medical profile is never written in clear.
> Production (`PILOT_MODE=false`) fails fast without the key.

## API Endpoints

`🔒` = requires `x-admin-key` when `ADMIN_API_KEY` is configured.

| Method | Path                                 | Description                                                                                                                                    |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                                  | Product info & available endpoints                                                                                                             |
| GET    | `/health`                            | Liveness only: status, uptime, kill switch                                                                                                     |
| GET    | `/api/admin/health` 🔒               | Readiness posture: LLM configured + endpoint, record paths/storage, proxy, key/license posture, compliance matrix overview                     |
| GET    | `/api/disclosure`                    | First-message disclosure & AI identity                                                                                                         |
| GET    | `/api/consent-text`                  | Exact consent copy the server verifies, with its version                                                                                       |
| GET    | `/api/availability`                  | Staff availability & SLA message                                                                                                               |
| GET    | `/api/system-prompt` 🔒              | Hardened system prompt                                                                                                                         |
| POST   | `/api/chat`                          | Main chat endpoint (kill switch → rate limit → injection → sensitive-data gates → RAG/LLM → validate/retry → fallback)                         |
| POST   | `/api/consent`                       | Submit consent for lead capture — **fail-closed** (500, no `leadId`, when the encrypted write fails)                                           |
| POST   | `/api/dsr`                           | Submit a data subject request — **fail-closed** (503 "Storage unavailable" on write failure vs. 400 on validation)                             |
| GET    | `/api/dsr/:requestId` 🔒             | DSR request status                                                                                                                             |
| POST   | `/api/dsr/:requestId/verify` 🔒      | Record operator verification of a request (required before suppression or erasure)                                                             |
| POST   | `/api/dsr/:requestId/erase` 🔒       | Fulfil a verified deletion: erase leads, tombstone DSRs, append a PII-free audit entry                                                         |
| POST   | `/api/admin/retention/sweep` 🔒      | Remove records past `DATA_RETENTION_DAYS`; `{ dryRun: true }` reports counts without changing anything                                         |
| GET    | `/api/admin/leads` 🔒                | Paginated lead export (`limit` ≤ 100, `cursor` from `nextCursor`); marks leads suppressed by a verified deletion; every page is access-audited |
| GET    | `/api/rag/search` 🔒                 | RAG retrieval search                                                                                                                           |
| GET    | `/api/session/:sessionId/history` 🔒 | Conversation history (redacted placeholders for sensitive messages)                                                                            |
| DELETE | `/api/session/:sessionId` 🔒         | Delete a session                                                                                                                               |
| GET    | `/api/sessions` 🔒                   | List sessions                                                                                                                                  |
| GET    | `/api/analytics/example`             | Example GTM dataLayer snippet                                                                                                                  |
| POST   | `/api/admin/kill-switch` 🔒          | Stop the assistant at runtime (static safe fallback, `staffed:false`); body may carry `{ reason }` for the server log                          |
| DELETE | `/api/admin/kill-switch` 🔒          | Clear the kill switch and resume normal responses                                                                                              |

## Embedding the Widget

The widget is a plain ES5 script with no build step. Serve it from this API host
and embed it on the public site (Lovable, WordPress/Elementor, anywhere):

```html
<!-- data-api-base is the API origin. Without it the widget uses the origin it
     was loaded from; a relative value is ignored rather than requested from the
     host page (which would hit the SPA fallback and return HTML). -->
<script
  src="https://your-api-host.com/widget.js"
  data-api-base="https://your-api-host.com"
  data-z-index="40"
  data-bottom-offset="72"
></script>
```

`window.LPP_CHAT_CONFIG` is the JavaScript equivalent and wins over the
attributes when both are present:

```html
<script>
  window.LPP_CHAT_CONFIG = {
    apiBase: 'https://your-api-host.com',
    zIndex: 40, // sit below a cookie banner or modal layer
    bottomOffset: 72, // clear the host's own floating launcher
  };
</script>
<script src="https://your-api-host.com/widget.js"></script>
```

The widget also carries the two tasks the chat itself must not take: a contact
step that submits the approved consent copy to `/api/consent` (with the lead
bound to the conversation's session) and a privacy-request form that submits a
TDPSA request to `/api/dsr`. Both are reachable from the composer area and never
ask for a direct identifier in the transcript.

What the widget does to coexist with a host SPA:

- **SPA route changes.** `pushState`, `replaceState`, `popstate` and `hashchange`
  re-read the page URL/title, so the page context sent with a message describes
  the page actually open — not the page the script loaded on. The greeting is
  not repeated.
- **React StrictMode / remounts.** A second inclusion of the script, or a second
  mount, re-attaches the existing dialog instead of building another. A React
  wrapper can keep the handle from `window.__lppChatWidget` and call
  `destroy()` on unmount, `mount()` on remount. The conversation survives a
  destroy/mount cycle.
- **Style isolation.** The widget renders inside an open shadow root and resets
  inherited typography at its root (`all: initial`, then its own type scale), so
  a theme's `button { … !important }` or a global `letter-spacing` cannot restyle
  its controls, shrink their target size or damage contrast. A single unstyled
  host element is the only thing it adds to the host document.
- **Tailwind preflight.** Widget CSS is scoped to `.lpp-chat-widget` and
  restores list markers that preflight strips (`ul { list-style: disc }`,
  `ol { list-style: decimal }`), so citations keep their bullets.
- **Analytics.** Reply events are pushed to `window.dataLayer` (the GTM array is
  created if GTM has not loaded yet). A host analytics error never interrupts a
  reply, and no message text or PII is pushed.

Response headers from the API host apply to what it serves: HSTS, a document CSP whose `script-src 'self'` permits only the widget script, `no-cache` for HTML, and a one-hour revalidating cache for the unversioned `widget.js`. A host page's own CSP is separate — if it has one, allow the script origin in `script-src` and the API origin in `connect-src`.

Or open `public/demo.html` served by the app (e.g. `http://localhost:3001/demo.html`) for a local preview — the widget in the bottom-right corner talks to the same-origin `/api/disclosure` and `/api/chat` endpoints.

Serving `widget.js` from this app while the page lives on Lovable makes every call
cross-origin: list every hosting origin in `ALLOWED_ORIGINS` (comma-separated,
scheme + host, no trailing slash). The live site needs both the apex and `www`
because they are separate browser origins. Preview deployments can use the narrow
subdomain wildcard `https://*.lovable.app`; it never matches the bare vendor
domain, but it does admit any other Lovable project, so prefer exact origins in
production. Nothing is allowed cross-origin by default, and a disallowed origin
simply receives no CORS grant — preflight (`OPTIONS`) is answered without
running route logic.

## Running in a Sandbox / Preview

The app is designed to boot with no credentials and no writable project directory:

```bash
npm ci && npm run build
PILOT_MODE=true node dist/index.js        # honors PORT if LIFECHAT_PORT is unset
```

- **No `LLM_API_KEY`:** the server still starts and answers from the static safe
  fallback (`state: standby`) instead of failing — sandbox demos stay interactive.
- **Port:** `LIFECHAT_PORT` wins; otherwise `PORT` is used, so managed platforms
  bind correctly. `PORT=0` asks the OS for a free port (used by the tests).
- **Record logs:** written under `data/` relative to the working directory,
  created on demand; `LEAD_LOG_PATH` / `DSR_LOG_PATH` / `ABSTENTION_LOG_PATH`
  redirect them to a mounted volume. `LEAD_SESSION_INDEX_PATH` (default: the
  lead log's name with `-session-index`) is a derived, PII-free lookup file
  kept beside the lead log; the server writes it with each consent and rebuilds
  it from the log when it is missing or stale. The startup preflight logs each
  resolved path, whether it is writable, whether `public/` was found, and which
  LLM endpoint is in use.
- **Smoke checks** after boot:

  ```bash
  curl -s localhost:$PORT/health        # liveness: status, uptime, kill switch
  curl -s -o /dev/null -w '%{http_code}\n' localhost:$PORT/demo.html
  curl -s -o /dev/null -w '%{http_code}\n' localhost:$PORT/widget.js
  curl -s -X POST localhost:$PORT/api/chat -H 'Content-Type: application/json' \
    -d '{"sessionId":"smoke","currentState":"education","message":"What is term life insurance?"}'
  ```

- **Stopping it:** `SIGTERM`/`SIGINT` close the listener gracefully (in-flight
  requests finish, 5s cap), so restarts do not leave the port held.
- **Records are real records:** the suite writes to the OS temp directory, so a
  clean `data/` after a test run contains only genuine lead/DSR/abstention files.
- Deployment specifics that are not in this repository (TLS, reverse proxy,
  volume/secret wiring, process supervision) are covered in
  [docs/sandbox-deployment.md](docs/sandbox-deployment.md); the container image
  itself is the [`Dockerfile`](Dockerfile).

## Phased Rollout (Section 6)

| Phase   | Description                                                                                                      | Status                      |
| ------- | ---------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Phase 0 | Compliance design — counsel classifies flows — [classification matrix](docs/compliance-classification-matrix.md) | Pending — draft for counsel |
| Phase 1 | Educational pilot — RAG over approved sources only                                                               | **Structured**              |
| Phase 2 | Consented lead capture — minimal fields + CRM                                                                    | Structured                  |
| Phase 3 | Scheduling — read-only availability then booking                                                                 | Structured                  |
| Phase 4 | Controlled optimization — A/B test presentation only                                                             | Future                      |

## Key Design Documents

- [Compliance Classification Matrix](docs/compliance-classification-matrix.md) — counsel-approved classification of every conversation flow (Phase 0)
- [AI Chatbot Persona Configuration](docs/ai-chatbot-persona-configuration.md) — the assistant's persona spec; mirrors the system prompt; keep in sync per its §13 change triggers
- [Medical Lead Capture — Phase 2](docs/medical-lead-capture-phase2.md) — consented medical fact-finding (draft, requires approval); also records the per-release history of the ICD-10-CM vocabulary and its sweep
- [Phenome Mapping Rules](docs/phenome-mapping-rules.md) — the rule set for mapping a condition's systemic physical sequelae (case definitions, effect-size thresholds, evidence grading), with the PTSD map as its first machine-readable instance
- [Section 508 Accessibility Review](docs/section-508-accessibility-review.md) — the manual review of the widget, its measured contrast and focus indicators, and the runnable assistive-technology walkthrough (`npm run a11y:checklist`) whose recorded results the accessibility gate reads
- [Sandbox Deployment](docs/sandbox-deployment.md) — boot, healthchecks, volumes, secrets, TLS/reverse-proxy steps
- [Privacy Notice](docs/privacy-notice.md) — GLBA + TDPSA disclosures
- [Subprocessor Register](docs/subprocessors.md) — every destination this app sends data to, what is gated before it leaves, and the DPA/region/retention evidence still to be filed (M-10)
- [Transcript Review — Speech Patterns](docs/transcripts-style-recommendations.md) — adaptable vs. rejected sales-training patterns

## Regulatory References

- Texas Insurance Code §541.061 — misrepresentation & unfair/deceptive practices
- Texas Data Privacy and Security Act (TDPSA) — sensitive data requires consent; privacy notice and consumer rights (access/deletion/correction/portability) via DSR
- Texas H.B. 149 — Responsible AI Governance Act (effective Jan 1, 2026)
- NAIC Model Bulletin on AI Systems (Dec 4, 2023)
- NAIC Model 570 — life/annuity advertising disclosure
- NIST AI 600-1 — Generative AI Profile
- FTC Act §5 / FTC AI guidance (2023–2025) — AI claims must be substantiated; every answer is RAG-grounded with citations and abstention is the default when evidence is insufficient
- OWASP LLM01:2025 — prompt injection
- WCAG 2.2 AA — accessibility
- FCC prior-express-written-consent rules (Eleventh Circuit vacatur Jan 2025)
- TDI advertising rules (28 TAC §21.104, §21.116, §21.122)

## License

© Richard Parslow / Life Insurance Broker Advocate. All rights reserved.
