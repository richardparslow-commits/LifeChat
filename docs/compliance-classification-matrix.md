# Compliance Classification Matrix — Life Policy Pilot AI Assistant

**Phase 0 deliverable (Section 6 of the specification):** Texas insurance counsel classifies each
conversation flow under applicable insurance-advertising and privacy law, and approves which flows
may run. This document lists every flow the implementation can execute, proposes a classification
for each based on the code's reading of the law, and provides the sign-off record.

**Status:** DRAFT — proposed classifications only. Nothing is approved until counsel completes the
sign-off block (§6). Per the project governance matrix, approval is required *before use and on
every material change*, with "signed approval, version hash" as the required evidence.

> This document is not a legal opinion. The proposed classifications below are the implementation
> team's reading of the cited authorities; counsel makes the final determination in §6.

---

## 1. Classification framework (authorities)

| Category | Trigger | Source |
|---|---|---|
| **Educational content** | Explains insurance concepts without promoting a specific policy, carrier, or transaction | Texas Insurance Code §541.061 (truthful, non-deceptive); NAIC Model 570 |
| **Institutional advertisement** | Internet content that does not mention a specific policy and does not offer an application or quote | 28 TAC §21.104(2) |
| **Invitation to inquire** | Content that invites a person to inquire about or contract for insurance | 28 TAC §21.104(3) — must identify the insurer's full licensed name; §21.122(c) — agent must submit advertising to insurer for written approval before use; §21.116 — retain specimens ≥ 3 years |
| **Lead generation** | Collects contact and/or profile data for follow-up marketing or sales | TDPSA (consent; sensitive-data rules); TCPA/Texas telemarketing (prior express written consent for SMS/calls); Do-Not-Call suppression |
| **AI-system risk control** | Overarching governance of the AI system itself | Texas H.B. 149 (Responsible AI Governance Act, eff. Jan 1, 2026); NAIC Model Bulletin on AI (Dec 4, 2023); NIST AI 600-1 |
| **FTC substantiation (AI claims)** | Marketing claims — including those generated or augmented by AI — must be truthful, non-deceptive, and **substantiated before they are made**; the FTC has stated that AI does not change this and that AI systems must not make claims they cannot support | FTC Act §5 (unfair/deceptive acts); FTC guidance on AI (2023–2025), e.g. "Keep Your AI Claims in Check" (2023) and "A.I.: The FTC is looking at you" (2023) |

---

## 2. The matrix

| # | Flow (states) | What the assistant does | Proposed classification | Key regulatory duties | Implementation status | Approval artifacts needed |
|---|---|---|---|---|---|---|
| F1 | **Disclosure** (`disclosure`) | Shows AI identity, scope, privacy warning before first message; banner persists in widget header | Educational + AI identity disclosure | NAIC Model 570 disclosure; §541.061 truthfulness; H.B. 149 transparency | **Enabled** (Phase 1 pilot) | Approve first-message disclosure & banner copy; record version hash |
| F2 | **Education** (`education`, `dime_estimator`) | Answers from RAG over compliance-reviewed corpus with claim-level citations; abstains (with reason) when no sufficient evidence. Includes the **DIME coverage-needs estimator** — a 3-step educational exercise (Debt, Income, Mortgage, Education); the illustrative range is computed by the application from coarse, non-sensitive inputs, never a recommendation or quote | Educational; at most **institutional advertisement** so long as no specific policy/carrier/quote is mentioned | §541.061; §21.104 identification of responsible person (agent full licensed name or Texas license number); NAIC 570; H.B. 149; **FTC substantiation — every material claim is RAG-grounded with a citation; abstention is the default when evidence is insufficient**; **comparative statements — only fair, accurate, non-misleading category-level comparisons from approved sources; ranking, disparagement, and carrier-to-carrier comparisons prohibited** | **Enabled** (Phase 1 pilot); DIME output is an app-computed illustrative range, not a quote | Approve corpus source list, citation format, abstention wording; confirm no policy/quote offers; **approve DIME estimator questions & illustrative range table** |
| F3 | **Clarify** (`clarify`) | Asks one clarifying question; never requests PII merely to answer; max 2 failed clarifications → links + human help | Educational | §541.061; §21.104 (as F2) | **Enabled** | Covered by F2 approval |
| F4 | **Qualification** (`qualification_offer`, `qualification`) | After value delivered, offers up to 3 optional questions (goal / timeline / current coverage), one at a time, **no health details**; decline suppresses re-offer in session | Educational context-gathering — **lead-generation precursor** once it feeds F6 | §541.061; §21.104 if it invites inquiry; TDPSA not triggered (no contact/sensitive data collected here) | **Enabled**; loop controls + value-before-offer guardrails in place | Approve the 3 questions and offer/decline handling |
| F5 | **Medical review** (`medical_offer`, `medical_review`) — Phase 2 | Proposes optional medical fact-finding with a just-in-time notice; requires **explicit, unchecked, versioned** medical consent; asks approved topics one at a time; health data accepted **only** in `medical_review`; MIB/attending-physician transparency statement per counsel checklist | **Lead generation collecting TDPSA sensitive data** (health) | TDPSA explicit consent + minimization + deletion/withdrawal; §541.061; §21.104 admissibility of the MIB transparency statement; H.B. 149 human-review if used in consequential decisions | **Disabled by default** — `HEALTH_DATA_COLLECTION_DISABLED=true`; runs only after explicit `.env` flip post-approval; draft spec in `docs/medical-lead-capture-phase2.md` | Sign §7 checklist of `medical-lead-capture-phase2.md`; approve `RECOMMENDED_MEDICAL_CONSENT_COPY` + just-in-time notice; approve field list (TDPSA minimization) |
| F6 | **Lead capture** (`contact_offer`, `consent`, `lead_submit`) | Offers email / call / calendar; collects only minimum contact fields with **channel-specific, versioned consent**; `create_lead` executes only with user request + affirmative consent + valid fields + suppression/DNC pass + idempotency key; forbidden chat fields enforced | **Lead generation (commercial)** | TDPSA (consent, personal data); **GLBA + TDPSA privacy notice** (NPI categories, purposes, sharing, third parties, safeguards, and rights — linked from disclosure/consent flows, `docs/privacy-notice.md` v1.3.0); **TDPSA consumer rights / DSR** (access, deletion, correction, portability via `POST /api/dsr`, 45-day response); TCPA / prior express written consent for SMS & calls; Do-Not-Call suppression; §21.104 identification; §541.061 | **Implemented & consent-gated**; production use pending approval | Approve `RECOMMENDED_PHONE_CONSENT_COPY`, field list, retention schedule (`counsel_approved`), suppression handling, **privacy notice (GLBA NPI + TDPSA 5 elements)**, **DSR process & contact** |
| F7 | **Scheduling** (`scheduling`, `confirmation`) | Presents read-only availability from the calendar tool with time zone; rechecks slot at commit; confirms booking only after downstream success; sends transactional confirmation | Service facilitation (not advertising) | §541.061 (no misrepresentation of booking status); TDPSA (calendar/contact data); confirmation must not carry marketing | **Structured** (tool allowlist + `SCHEDULING_RULES` implemented); real calendar API **not connected** | Approve confirmation copy; approve calendar/CRM integration when added |
| F8 | **Handoff** (`handoff`) | Summarizes with consent, provides availability/SLA, stops giving advice; routes to licensed broker | Customer-service referral | §541.061; clear that follow-up is by the licensed broker, not the assistant | **Enabled** | Approve handoff summary copy |
| F9 | **Standby** (`standby`) | Post-flow state; education only; re-enters an active flow only on user initiative | Educational | As F2 | **Enabled** | Covered by F2 approval |
| F10 | **Safety paths** (kill switch, abstention, static fallback, rate limit, prompt-injection & sensitive-data detection, promotional-offer output guard) | Risk-control layer; not a consumer-facing flow | AI-system risk control (no advertising classification) | H.B. 149 human oversight / kill switch; NAIC AI Bulletin monitoring; NIST AI 600-1; **FTC substantiation — the abstention gate is the enforcement mechanism: no claim is emitted without an approved retrieved source**; **marketing-review gate — free-offer phrasing (free quote / free consultation / no-obligation) is blocked in outputs until `FREE_OFFER_MARKETING_APPROVED=true` after review** | **Enabled** | Covered by governance matrix security control (prelaunch red-team, quarterly) |

> **Machine-readable mirror:** served at `GET /health` → `compliance` (source:
> `src/compliance/classification-matrix.ts`, version `1.7.0`). Each flow carries
> `approvalStatus` (counsel record) and `runtimeStatus` (live gating, e.g. medical
> review `gated_by_flag` until `HEALTH_DATA_COLLECTION_DISABLED=false` is flipped).

---

## 3. Cross-cutting controls (apply to every flow)

These are enforced in code and must pass the **100% critical-compliance test gate**
(`CRITICAL_COMPLIANCE_PASS_RATE: 1.0` — `ai_disclosure`, `prohibited_advice`, `health_data_handling`,
`consent_enforcement`, `pii_handling`, `prompt_exfiltration_prevention`, `booking_confirmation_accuracy`):

- **AI identity disclosed** — widget header + first message; never impersonates a human.
- **Educational, not advisory** — non-objectives list (no recommendations, quotes, replacement or
  suitability analysis, underwriting, tax/legal/medical advice).
- **No pressure tactics** — `PROHIBITED_PRESSURE_TACTICS` (guilt, fear, false urgency, scarcity,
  shame, repeated persuasion, family-protection-status claims, etc.).
- **Grounded answers / FTC substantiation** — every material claim is grounded in an approved
  retrieved source and carries a citation (system prompt §6; orchestrator abstention gate in
  `src/llm/orchestrator.ts`); abstention is the **default** when evidence is absent, conflicting, or
  expired, so the assistant never makes a claim it cannot substantiate (FTC Act §5; FTC AI guidance
  2023–2025).
- **Comparative statements** — prohibited by default; only generic, category-level comparisons
  (e.g., term vs. whole life) from approved retrieved content, fair, accurate, non-misleading, and
  without ranking or disparagement (§541.061; system prompt §5.1).
- **Promotional offers (marketing-review flag)** — "free quote", "free consultation", "free estimate",
  and "no-obligation" claims are blocked by an output guard until `FREE_OFFER_MARKETING_APPROVED=true`
  is set after marketing review; the assistant may offer a licensed-broker conversation without
  characterizing it as free (system prompt §5.1; orchestrator output guard).
- **Deterministic tool authorization** — model proposes, application validates (allowlist, consent
  version, suppression, idempotency, downstream-success confirmation).
- **Versioned consent** — contact consent carries a version (`1.0.0` default); medical consent requires a current `medical_consent_version` whenever a `medical_profile` is populated; ambiguous replies are **not** consent.
- **Privacy notice (GLBA + TDPSA)** — a plain-English notice (`docs/privacy-notice.md`, v1.1.0) covering
  GLBA nonpublic personal information and safeguards alongside the TDPSA disclosures (categories of
  personal data, purposes, third-party sharing categories, third-party categories, and how to exercise
  rights); linked from the disclosure and consent flows (`PRIVACY_NOTICE_URL`).
- **Consumer rights / DSR** — access, deletion, correction, and portability requests accepted via
  `POST /api/dsr` and the published contact (`DSR_EMAIL`, default `privacy@lifepolicypilot.blog`),
  with a 45-day TDPSA response window.
- **PII-safe** — forbidden chat fields never collected; sensitive keys redacted from tool arguments;
  analytics events carry no PII.
- **Retention** — `RETENTION_SCHEDULE: 'counsel_approved'`; deletion/withdrawal route provided.

---

## 4. Change triggers (re-approval required)

Any of the following invalidates approval for the affected flows until counsel re-signs:

- Prompt or model change (F2, F4, F5, F6)
- Consent copy, field list, or retention change (F5, F6)
- Corpus/source change (F2, F3)
- New tool or integration, including the calendar/CRM API (F6, F7)
- Advertising or disclosure wording change (F1, F2)
- Any flag flip that enables a previously disabled flow (F5, F10 — `FREE_OFFER_MARKETING_APPROVED`)
- Comparative-statement or promotional/free-offer wording change (F2, F10)

---

## 5. Version history

| Version | Date | Author | Change |
|---|---|---|---|
| 1.0.0 | 2026-08-30 | LifeChat implementation | Initial matrix — proposed classifications for all flows (Phase 0, status: Pending) |
| 1.1.0 | 2026-08-30 | LifeChat implementation | F2 extended with the DIME coverage-needs estimator sub-flow (`dime_estimator` state); added approval artifact for the estimator questions & illustrative range table |
| 1.2.0 | 2026-08-30 | LifeChat implementation | Documented FTC substantiation duty (FTC Act §5; FTC AI guidance 2023–2025) on F2 and F10 — RAG-grounded answers with citations and abstention-as-default mapped to the enforcement controls |
| 1.3.0 | 2026-08-30 | LifeChat implementation | Added TDPSA privacy-notice and consumer-rights (DSR) duties to F6; published `docs/privacy-notice.md`; added `POST /api/dsr` with the 45-day response window and DSR contact (`DSR_EMAIL`) |
| 1.4.0 | 2026-08-30 | LifeChat implementation | Added comparative-statement policy (F2) and the promotional-offer marketing-review gate (F10) — free-quote/free-consultation/no-obligation phrasing blocked until `FREE_OFFER_MARKETING_APPROVED=true` |
| 1.5.0 | 2026-08-30 | LifeChat implementation | Privacy notice rewritten for GLBA (NPI + safeguards) and TDPSA as an independent-broker notice (`docs/privacy-notice.md` v1.1.0); F6 duty updated |
| 1.6.0 | 2026-08-30 | LifeChat implementation | Privacy notice v1.2.0 — added explicit "What we collect / We do NOT collect" and "We do NOT use" disclosures (no selling, no targeted advertising, no consequential automated decisions) |
| 1.7.0 | 2026-08-30 | LifeChat implementation | Privacy notice v1.3.0 — restructured "How We Share Your Information" into the categories-of-third-parties table (insurance carriers with explicit consent, service providers, regulators & law enforcement) plus the "We do NOT share with" list (no marketers, data brokers, affiliates, or any undisclosed party) |

---

## 6. Counsel sign-off

Reviewed against: Texas Insurance Code §541.061 · TDPSA · 28 TAC §§21.104/21.116/21.122 · NAIC
Model 570 · NAIC AI Model Bulletin (Dec 4, 2023) · Texas H.B. 149 (eff. Jan 1, 2026) · NIST AI 600-1 ·
FTC Act §5 and FTC AI guidance (2023–2025).

| # | Flow | Proposed classification | **Counsel determination** | Approved? (date) |
|---|---|---|---|---|
| F1 | Disclosure | Educational + AI disclosure | | |
| F2 | Education | Educational / institutional advertisement | | |
| F3 | Clarify | Educational | | |
| F4 | Qualification | Educational precursor to lead generation | | |
| F5 | Medical review | Lead generation — TDPSA sensitive data | | |
| F6 | Lead capture | Lead generation (commercial) | | |
| F7 | Scheduling | Service facilitation | | |
| F8 | Handoff | Customer-service referral | | |
| F9 | Standby | Educational | | |
| F10 | Safety paths | AI-system risk control | | |

**Counsel:** ______________________________________   **Firm:** ______________________________________

**Signature:** ______________________________________   **Date:** ____________________

**Approval version hash (of this document):** ____________________

**Conditions / reservations:** ____________________________________________________________________
