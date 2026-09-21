# LifeChat — Life Policy Pilot AI Educational Assistant

A compliance-first AI chatbot/AI agent for the [Life Policy Pilot](https://lifepolicypilot.blog/) blog, a Texas-licensed life insurance educational website built on WordPress/Elementor. The assistant is a **grounded, guardrailed educational agent**: it answers only from an approved RAG corpus, abstains when evidence is insufficient, blocks sensitive data before it reaches the model, enforces per-session rate and token budgets, and routes anything individualized to a licensed-human handoff through fail-closed, encrypted persistence.

## ⚠️ Compliance Notice

This is a **product and risk-control specification implementation**, not a legal opinion. Before launch, Texas insurance counsel and every affected carrier/compliance department must approve the final scripts, product references, consent language, retention schedule, integrations, and advertising classification.

The assistant is **educational, not advisory**. It may explain approved content and offer a meeting; it must not recommend a policy, carrier, face amount, premium, tax strategy, replacement, or annuity transaction.

## What It Does

- **Grounded RAG answers with citations** — retrieval over approved sources (broker-approved articles, controlled FAQ, NAIC/TDI/regulatory material) with claim-level source titles and canonical URLs. Grounding failures and off-topic questions produce an abstention sentence rather than a guess.
- **Deterministic safety gates before any LLM call** — prompt-injection detection, health-data and financial-account-data blocking (with redacted session history and a licensed-broker handoff), health-topic questions routed to the same handoff, and a kill switch.
- **Persona & policy guardrails** — a hardened system prompt (identity, abstention rules, prohibited promotion/comparison copy, consent rules) enforced by a deterministic persona validator, an offline golden-set gate (`test:guardrails:golden`), and a verdict gate (`test:verdicts`) so approved personas can never drift from model behavior.
- **Consented lead capture & data-subject rights** — `/api/consent` and `/api/dsr` both persist **fail-closed** (an acknowledgment is only issued after the record hits disk) and **encrypted at rest** when `RECORD_ENCRYPTION_KEY` is set (AES-256-GCM envelopes; loaders warn loudly when records are skipped for a missing or mismatched key; in pilot mode without a key, records persist in plaintext so never deploy pilot mode without setting the key).
- **Admin-gated operations** — system prompt, session history, session listing/deletion, RAG search, and DSR status require an `x-admin-key` header compared in constant time when `ADMIN_API_KEY` is configured.
- **Per-window budgets that actually enforce** — 20 requests and 50,000 tokens per session per 60-second window (the token budget counts real LLM usage end-to-end; a locked-out session recovers on window rollover).
- **Contextual content bridge** — the article being read enriches the opening message and prioritizes RAG retrieval; pre-approved visual cards can attach to responses.

## Key Design Principles

1. **Legal and consumer safety first** — every design decision prioritizes compliance, and the [classification matrix](docs/compliance-classification-matrix.md) records how each flow is classified for counsel
2. **Truthful, grounded education** — RAG over approved sources with claim-level citations; abstention over invention
3. **No health or financial data in chat** — health conditions (and now routing/account numbers too) are sensitive data: blocked deterministically, redacted from logs, routed to a licensed-broker handoff; health collection stays inert unless `HEALTH_DATA_COLLECTION_DISABLED=false` is set after counsel approval and only with explicit medical consent (Phase 2)
4. **Fail-closed records** — leads and DSRs are acknowledged only after a durable, encrypted write; a lost write surfaces as 500/503, never as a false success
5. **Explicit channel-specific consent** — never implied or blanket consent
6. **Deterministic tool authorization** — the model proposes; application code validates (Zod schema, cross-field consent rules, promotional/phrasing checks)
7. **Auditable events** — no PII in analytics; GA4 events are categorical and allowlisted, session history stores redacted placeholders for sensitive messages, and encrypted record logs refuse to load silently (missing or wrong key = explicit startup warning)

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

# Run tests
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

# Section 508 walkthrough — the runnable checklist and the recorded results it validates
npm run a11y:checklist

# Condition-coverage sweep — every candidate phrase is mapped, gated, or
# deliberately deferred (exits 1 on a silent row). Sweeps all 13 committed
# sources in one run: the carrier questionnaire and critical-illness lists,
# ten ICD-10-CM chapter enumerations (V, VI, IX, X, XI, XII, XIII, XIV,
# XVIII, XXI), and the deferral ledger, which is re-asked on every sweep.npm run conditions:sweep

# The sweep's machine-readable form (per-source totals and per-row status)
npm run conditions:sweep -- --json

```

## Deployment

The app runs two ways, both documented in [docs/sandbox-deployment.md](docs/sandbox-deployment.md):

- **Container / long-running** (§2–§9) — `npm run build && npm start` binds the
  port itself (`LIFECHAT_PORT` wins, else the platform-injected `PORT`), with a
  mounted `data/` volume for records. This remains the path where durable
  record files matter.
- **Vercel (serverless)** — merge to `main` and the `Deploy (Vercel)` workflow
  deploys with the `VERCEL_KEY` repository secret, then smoke-checks `/health`
  and the widget. The platform sets `VERCEL=1`, so the app builds without
  binding a port (`api/index.ts` exports the Express app; `vercel.json` rewrites
  `/api/*` to it and bundles `dist/` + `public/`). `tests/serverless-mode.test.ts`
  pins the no-listen contract. Read §11's caveats on record persistence before
  enabling consent capture there.

## Configuration

Set environment variables (or create a `.env` file):

```bash
LIFECHAT_PORT=3000 # wins when set; otherwise PORT is honored (hosting platforms inject PORT)
ALLOWED_ORIGINS="" # cross-origin embed allowlist; empty = same-origin only (see Embedding the Widget)
BUSINESS_NAME="Life Policy Pilot"
LICENSED_BROKER_NAME="Richard Parslow"
TEXAS_LICENSE_NUMBER="[Your Texas license number]"
APPOINTED_CARRIERS="" # comma-separated carriers Richard Parslow is appointed with (allowlist)
WEBSITE_URL="https://lifepolicypilot.blog/"
PRIVACY_NOTICE_URL="https://lifepolicypilot.blog/privacy/"
CONTACT_URL="https://lifepolicypilot.blog/contact/"
DSR_EMAIL="privacy@lifepolicypilot.blog" # data subject requests (TDPSA rights)
LLM_API_KEY="your-api-key"
LLM_MODEL="gpt-4o"
PILOT_MODE=true
HEALTH_DATA_COLLECTION_DISABLED=true # set false ONLY after counsel approval (gated medical capture)
FREE_OFFER_MARKETING_APPROVED=false # free-quote/free-consultation phrasing blocked until marketing review
CONTEXTUAL_BRIDGE_ENABLED=true # Contextual Content Bridge: enrich opening message + RAG from the article being read
VISUAL_CARDS_ENABLED=true # Visual Rich Cards: attach pre-approved educational cards to responses
ABSTENTION_LOGGING_ENABLED=true # Abstention logging for content strategy: hashed, anonymized JSONL feed (non-PII)
ABSTENTION_LOG_PATH="data/abstention-log.jsonl"

# Security & record store (added in the compliance audit)
ADMIN_API_KEY="" # when set, gates /api/system-prompt, session history/sessions, RAG search, DSR status, and the runtime kill switch, via x-admin-key
RECORD_ENCRYPTION_KEY="" # 32-byte hex key (openssl rand -hex 32). Encrypts DSR + lead logs at rest; loaders warn and skip records if missing or wrong. Do not change after records are written.
DSR_LOG_PATH="data/dsr-records.jsonl"
LEAD_LOG_PATH="data/lead-records.jsonl"
```

> **License disclosure:** `TEXAS_LICENSE_NUMBER` is required before going live
> (Texas Insurance Code §541.003 / TAC §19.1004). While unset, `/api/disclosure`
> returns `texasLicenseNumber: null` (never the placeholder) and production startup
> (`PILOT_MODE=false`) fails fast. The appointment disclaimer
> ("Richard Parslow is appointed with select carriers. Coverage availability may
> vary.") is always served, and `APPOINTED_CARRIERS` is the allowlist the assistant
> must never imply coverage from beyond.
>
> **Record encryption:** when `RECORD_ENCRYPTION_KEY` is set, lead and DSR writes
> are envelope-encrypted (AES-256-GCM) before hitting disk. Without a key, pilot
> mode falls back to plaintext but warns at startup whenever encrypted records are
> skipped. Production (`PILOT_MODE=false`) fails fast without the key.

## API Endpoints

`🔒` = requires `x-admin-key` when `ADMIN_API_KEY` is configured.

| Method | Path                                 | Description                                                                                                                                     |
| ------ | ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                                  | Product info & available endpoints                                                                                                              |
| GET    | `/health`                            | Health/readiness check (kill switch, uptime, LLM configured + endpoint, record paths writable, key/license posture, compliance matrix overview) |
| GET    | `/api/disclosure`                    | First-message disclosure & AI identity                                                                                                          |
| GET    | `/api/consent-text`                  | Consent copy for counsel review                                                                                                                 |
| GET    | `/api/availability`                  | Staff availability & SLA message                                                                                                                |
| GET    | `/api/system-prompt` 🔒              | Hardened system prompt                                                                                                                          |
| POST   | `/api/chat`                          | Main chat endpoint (kill switch → rate limit → injection → sensitive-data gates → RAG/LLM → validate/retry → fallback)                          |
| POST   | `/api/consent`                       | Submit consent for lead capture — **fail-closed** (500, no `leadId`, when the encrypted write fails)                                            |
| POST   | `/api/dsr`                           | Submit a data subject request — **fail-closed** (503 "Storage unavailable" on write failure vs. 400 on validation)                              |
| GET    | `/api/dsr/:requestId` 🔒             | DSR request status                                                                                                                              |
| GET    | `/api/rag/search` 🔒                 | RAG retrieval search                                                                                                                            |
| GET    | `/api/session/:sessionId/history` 🔒 | Conversation history (redacted placeholders for sensitive messages)                                                                             |
| DELETE | `/api/session/:sessionId` 🔒         | Delete a session                                                                                                                                |
| GET    | `/api/sessions` 🔒                   | List sessions                                                                                                                                   |
| GET    | `/api/analytics/example`             | Example GTM dataLayer snippet                                                                                                                   |
| POST   | `/api/admin/kill-switch` 🔒          | Stop the assistant at runtime (static safe fallback, `staffed:false`); body may carry `{ reason }` for the server log                           |
| DELETE | `/api/admin/kill-switch` 🔒          | Clear the kill switch and resume normal responses                                                                                               |

## Embedding the Widget

Add this script to your WordPress/Elementor site (via HTML widget or theme footer):

```html
<script src="https://your-server.com/widget.js" data-server-url="https://your-server.com"></script>
```

Or open `public/demo.html` served by the app (e.g. `http://localhost:3001/demo.html`) for a local preview — the widget in the bottom-right corner talks to the same-origin `/api/disclosure` and `/api/chat` endpoints.

Serving `widget.js` from this app while the page lives on the blog makes every call
cross-origin: list the blog origin in `ALLOWED_ORIGINS` (comma-separated, exact
scheme + host, no trailing slash). Nothing is allowed cross-origin by default, and
a disallowed origin simply receives no CORS grant — preflight (`OPTIONS`) is
answered without running route logic.

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
  redirect them to a mounted volume. The startup preflight logs each resolved
  path, whether it is writable, whether `public/` was found, and which LLM
  endpoint is in use.
- **Smoke checks** after boot:

  ```bash
  curl -s localhost:$PORT/health        # status, uptime, readiness facts
  curl -s -o /dev/null -w '%{http_code}\n' localhost:$PORT/demo.html
  curl -s -o /dev/null -w '%{http_code}\n' localhost:$PORT/widget.js
  curl -s -X POST localhost:$PORT/api/chat -H 'Content-Type: application/json' \
    -d '{"sessionId":"smoke","currentState":"education","message":"What is term life insurance?"}'
  ```

- **Stopping it:** `SIGTERM`/`SIGINT` close the listener gracefully (in-flight
  requests finish, 5s cap), so restarts do not leave the port held.
- **Records are real records:** the suite writes to the OS temp directory, so a
  clean `data/` after a test run contains only genuine lead/DSR/abstention files.
- Deployment specifics that are not in this repository (container image, TLS,
  reverse proxy, volume/secret wiring, process supervision) are covered in
  [docs/sandbox-deployment.md](docs/sandbox-deployment.md).

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

© Richard Parslow / Life Policy Pilot. All rights reserved.
