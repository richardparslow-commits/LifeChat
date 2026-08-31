# LifeChat — Life Policy Pilot AI Educational Assistant

A compliance-first AI chatbot/AI agent for the [Life Policy Pilot](https://lifepolicypilot.blog/) blog, a Texas-licensed life insurance educational website built on WordPress/Elementor.

## ⚠️ Compliance Notice

This is a **product and risk-control specification implementation**, not a legal opinion. Before launch, Texas insurance counsel and every affected carrier/compliance department must approve the final scripts, product references, consent language, retention schedule, integrations, and advertising classification.

The assistant is **educational, not advisory**. It may explain approved content and offer a meeting; it must not recommend a policy, carrier, face amount, premium, tax strategy, replacement, or annuity transaction.

## Key Design Principles

1. **Legal and consumer safety first** — every design decision prioritizes compliance
2. **Truthful, grounded education** — RAG over approved sources with claim-level citations
3. **No health data collection by default** — health conditions are sensitive data under TDPSA; collection stays blocked unless `HEALTH_DATA_COLLECTION_DISABLED=false` is set after counsel approval, and then only with explicit medical consent (Phase 2)
4. **Explicit channel-specific consent** — never implied or blanket consent
5. **Deterministic tool authorization** — the model proposes; application code validates
6. **Auditable events** — no PII in analytics; GA4 events are categorical and allowlisted

## Tech Stack

- **Backend**: Node.js / TypeScript / Express
- **Validation**: Zod schema validation
- **Frontend**: Vanilla JS drop-in widget (no framework dependency)
- **Analytics**: GTM/GA4 with dataLayer (no PII)

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
│   │   └── consent-model.ts       # Lead data & consent model (Section 4.7)
│   ├── privacy/
│   │   └── dsr.ts                 # Data subject request intake (TDPSA rights)
│   ├── tools/
│   │   └── tool-controls.ts       # Tool & integration controls (Section 4.8)
│   ├── security/
│   │   └── security-controls.ts   # Security & prompt injection (Section 4.9)
│   ├── handoff/
│   │   └── human-escalation.ts    # Human escalation & SLAs (Section 4.10)
│   ├── resilience/
│   │   └── fallback-behavior.ts   # Failure, latency & fallback (Section 4.11)
│   ├── accessibility/
│   │   └── accessibility.ts       # WCAG 2.2 AA requirements (Section 4.12)
│   ├── analytics/
│   │   └── analytics.ts           # GTM/GA4 event taxonomy (Section 4.13)
│   ├── evaluation/
│   │   └── evaluation-plan.ts     # Evaluation & QA plan (Section 4.14)
│   ├── estimator/
│   │   └── dime-estimator.ts      # DIME coverage-needs estimator (educational)
│   ├── rag/
│   │   └── rag-architecture.ts    # Knowledge & RAG architecture (Section 4.6)
│   └── index.ts                   # Express server entry point
├── public/
│   ├── widget.js                  # Embeddable chat widget
│   └── elementor-trust-block.css  # Elementor "Trust & Transition" CSS
├── tests/
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
FREE_OFFER_MARKETING_APPROVED=false # free-quote/free-consultation phrasing blocked until marketing review
CONTEXTUAL_BRIDGE_ENABLED=true # Contextual Content Bridge: enrich opening message + RAG from the article being read (set false to disable)
VISUAL_CARDS_ENABLED=true # Visual Rich Cards: attach pre-approved educational cards to responses (set false to disable)
ABSTENTION_LOGGING_ENABLED=true # Abstention logging for content strategy: hashed, anonymized JSONL feed (set false to disable)
ABSTENTION_LOG_PATH="data/abstention-log.jsonl" # where the abstention feed is written (point to a writable volume on serverless)
```

> **License disclosure:** `TEXAS_LICENSE_NUMBER` is required before going live
> (Texas Insurance Code §541.003 / TAC §19.1004). While unset, `/api/disclosure`
> returns `texasLicenseNumber: null` (never the placeholder) and production startup
> (`PILOT_MODE=false`) fails fast. The appointment disclaimer
> ("Richard Parslow is appointed with select carriers. Coverage availability may
> vary.") is always served, and `APPOINTED_CARRIERS` is the allowlist the assistant
> must never imply coverage from beyond.

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Product info & available endpoints |
| GET | `/health` | Health check (kill switch status + compliance matrix overview) |
| GET | `/api/disclosure` | First-message disclosure & AI identity |
| GET | `/api/consent-text` | Consent copy for counsel review |
| GET | `/api/availability` | Staff availability & SLA message |
| GET | `/api/system-prompt` | Hardened system prompt (admin) |
| POST | `/api/chat` | Main chat endpoint |
| POST | `/api/consent` | Submit consent for lead capture (Phase 2) |
| POST | `/api/dsr` | Submit a data subject request (access/deletion/correction/portability) |
| GET | `/api/dsr/:requestId` | DSR request status (admin/debug) |
| GET | `/api/analytics/example` | Example GTM dataLayer snippet |

## Embedding the Widget

Add this script to your WordPress/Elementor site (via HTML widget or theme footer):

```html
<script src="https://your-server.com/widget.js"
        data-server-url="https://your-server.com"></script>
```

## Phased Rollout (Section 6)

| Phase | Description | Status |
|-------|-------------|--------|
| Phase 0 | Compliance design — counsel classifies flows — [classification matrix](docs/compliance-classification-matrix.md) | Pending — draft for counsel |
| Phase 1 | Educational pilot — RAG over approved sources only | **Structured** |
| Phase 2 | Consented lead capture — minimal fields + CRM | Structured |
| Phase 3 | Scheduling — read-only availability then booking | Structured |
| Phase 4 | Controlled optimization — A/B test presentation only | Future |

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
