# LifeChat — Life Policy Pilot AI Educational Assistant

A compliance-first AI chatbot/AI agent for the [Life Policy Pilot](https://lifepolicypilot.blog/) blog, a Texas-licensed life insurance educational website built on WordPress/Elementor. The assistant is a **grounded, guardrailed educational agent**: it answers only from an approved RAG corpus, abstains when evidence is insufficient, blocks sensitive data before it reaches the model, enforces per-session rate and token budgets, and routes anything individualized to a licensed-human handoff through fail-closed, encrypted persistence.

## ⚠️ Compliance Notice

This is a **product and risk-control specification implementation**, not a legal opinion. Before launch, Texas insurance counsel and every affected carrier/compliance department must approve the final scripts, product references, consent language, retention schedule, integrations, and advertising classification.

The assistant is **educational, not advisory**. It may explain approved content and offer a meeting; it must not recommend a policy, carrier, face amount, premium, tax strategy, replacement, or annuity transaction.

## What It Does

- **Grounded RAG answers with citations** — retrieval over approved sources (broker-approved articles, controlled FAQ, NAIC/TDI/regulatory material) with claim-level source titles and canonical URLs. Grounding failures and off-topic questions produce an abstention sentence rather than a guess.
- **Deterministic safety gates before any LLM call** — prompt-injection detection, health-data and financial-account-data blocking (with redacted session history and a licensed-broker handoff), and a kill switch.
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
- **Frontend**: Vanilla JS drop-in widget (no framework dependency)
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
│   ├── privacy/
│   │   ├── dsr.ts                 # DSR intake (TDPSA rights) — fail-closed, encrypted
│   │   └── record-encryption.ts   # AES-256-GCM envelope / keyless-warning helpers
│   ├── security/
│   │   └── security-controls.ts   # Injection + sensitive-data gates, rate & token budgets, constant-time admin key check (Section 4.9)
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
│   └── index.ts                   # Express server entry point (admin auth, session store, endpoints)
├── public/
│   ├── widget.js                  # Embeddable chat widget
│   ├── demo.html                  # Local widget preview (serve with a dev-run server)
│   └── elementor-trust-block.css  # Elementor "Trust & Transition" CSS
├── docs/                          # Compliance matrix, persona config, privacy notice, etc.
├── tests/                         # 18 suites incl. API, consent/DSR persistence, encryption, admin auth
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
```

## Configuration

Set environment variables (or create a `.env` file):

```bash
LIFECHAT_PORT=3000
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
ADMIN_API_KEY="" # when set, gates /api/system-prompt, session history/sessions, RAG search, DSR status via x-admin-key
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

| Method | Path                                 | Description                                                                                                            |
| ------ | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| GET    | `/`                                  | Product info & available endpoints                                                                                     |
| GET    | `/health`                            | Health check (kill switch status + compliance matrix overview)                                                         |
| GET    | `/api/disclosure`                    | First-message disclosure & AI identity                                                                                 |
| GET    | `/api/consent-text`                  | Consent copy for counsel review                                                                                        |
| GET    | `/api/availability`                  | Staff availability & SLA message                                                                                       |
| GET    | `/api/system-prompt` 🔒              | Hardened system prompt                                                                                                 |
| POST   | `/api/chat`                          | Main chat endpoint (kill switch → rate limit → injection → sensitive-data gates → RAG/LLM → validate/retry → fallback) |
| POST   | `/api/consent`                       | Submit consent for lead capture — **fail-closed** (500, no `leadId`, when the encrypted write fails)                   |
| POST   | `/api/dsr`                           | Submit a data subject request — **fail-closed** (503 "Storage unavailable" on write failure vs. 400 on validation)     |
| GET    | `/api/dsr/:requestId` 🔒             | DSR request status                                                                                                     |
| GET    | `/api/rag/search` 🔒                 | RAG retrieval search                                                                                                   |
| GET    | `/api/session/:sessionId/history` 🔒 | Conversation history (redacted placeholders for sensitive messages)                                                    |
| DELETE | `/api/session/:sessionId` 🔒         | Delete a session                                                                                                       |
| GET    | `/api/sessions` 🔒                   | List sessions                                                                                                          |
| GET    | `/api/analytics/example`             | Example GTM dataLayer snippet                                                                                          |

## Embedding the Widget

Add this script to your WordPress/Elementor site (via HTML widget or theme footer):

```html
<script src="https://your-server.com/widget.js" data-server-url="https://your-server.com"></script>
```

Or open `public/demo.html` served by the app (e.g. `http://localhost:3001/demo.html`) for a local preview — the widget in the bottom-right corner talks to the same-origin `/api/disclosure` and `/api/chat` endpoints.

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
- [Medical Lead Capture — Phase 2](docs/medical-lead-capture-phase2.md) — consented medical fact-finding (draft, requires approval)
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
