# Medical Lead Capture — Phase 2 (Compliant Design)

**Status:** Draft — **requires Texas insurance counsel and compliance approval before any use.**
**Scope:** Consented medical fact-finding so Richard Parslow (licensed Texas life-insurance broker) can focus on carriers that fit a user's profile.
**Relationship to the request:** The original request contained scripts using prohibited pressure tactics (assumptive closes, scarcity/takeaway, fabricated decline claims). This document implements the same business goal in a compliance-safe form. The pressure tactics are intentionally **not** implemented and are listed in §5 as prohibited.

---

## 1. When this flow runs

- **Phase 2 only**, gated behind the medical capture feature flag and `healthDataCollectionDisabled=false`.
- **Only after** the user opts into the optional medical review.
- **Only with** explicit, current, versioned medical consent (`medical_consent_affirmed=true` + a current `medical_consent_version`).
- Never in the default educational flow (system prompt §7 forbids these fields without consent).

## 2. Fields collected (only after consent)

| Field                        | Type                | Notes                                                                                                 |
| ---------------------------- | ------------------- | ----------------------------------------------------------------------------------------------------- |
| Date of birth                | string (YYYY-MM-DD) | Never full government identifier                                                                      |
| Gender                       | enum                | male / female / other / prefer_not_to_say                                                             |
| Height                       | number (inches)     |                                                                                                       |
| Weight                       | number (lbs)        |                                                                                                       |
| Tobacco/nicotine use         | enum                | none / cigarettes / vaping / other_nicotine / prefer_not_to_say (includes any vaping per the request) |
| Current medical conditions   | string[]            | As diagnosed by a doctor, as stated by the user                                                       |
| Current medications          | string[]            | As prescribed by a doctor, as stated by the user                                                      |
| Policy type seeking          | enum                | term / whole_life / iul / unsure                                                                      |
| Coverage amount seeking      | string              | Preference only — never quoted                                                                        |
| Diabetes (conditional)       | object              | type (1/2/unsure), treatment (pills/insulin/other), last A1C                                          |
| Cancer history (conditional) | object              | cancer type, years cancer-free                                                                        |

## 3. Consent flow (implemented)

1. Assistant proposes the optional medical review after qualification, with a just-in-time notice: which fields, why (carrier matching by the licensed broker), optional nature, withdrawal/deletion route.
2. The application presents `RECOMMENDED_MEDICAL_CONSENT_COPY` as an **explicit, unchecked, opt-in** control. Ambiguous or hedged replies are treated as **not** consented (system prompt §9).
3. Consent is versioned (`medical_consent_version` + timestamp) and stored on the lead record.
4. The response schema rejects any populated `medical_profile` without affirmed, versioned medical consent.

## 4. Scripting (compliant replacements)

- **Pre-frame (exact):** "Just because you might have medical conditions or take medications, doesn't mean you are disqualified from life insurance. By answering these questions, it allows me to focus on what carriers best suit your current profile."
- **Transparency (neutral fact):** carriers may review an MIB report and attending physician statements when an application is submitted; withholding accurate information can hurt the user's own application. Stated as fact, never as a threat.
- **Diabetes (alternative choice, one question per turn):** "Are you controlling that with daily pills, or are you taking insulin?" → "Are you Type 1 or Type 2? And what was your most recent A1C reading?"
- **Cancer:** "What type of cancer were you diagnosed with, and how long have you been completely cancer-free?"
- **Objection deflection with purpose:** "Carriers evaluate diabetes and cancer history differently based on type, treatment, and time. Your best estimate lets the licensed broker match carriers." — then continue; never argue or repeat.
- **Refusal:** accept once, do not re-ask the same declined field, return to education or licensed-broker handoff.

## 5. Explicitly NOT implemented (prohibited)

- "Go ahead with that" as an assumptive consent/close.
- DOT "takeaway" threats ("we can just stop right now, because the carriers will decline the application anyway").
- "The better the price I can get you" / any promise of price, approval, or outcome.
- Claiming to be the user's attorney, doctor, or advisor.
- Any guilt, fear, scarcity, shame, or repeated persuasion (system prompt §7, `PROHIBITED_PRESSURE_TACTICS`).

## 6. Code touch points

| Module                               | Change                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/consent/consent-model.ts`       | `MedicalProfile`, `RECOMMENDED_MEDICAL_CONSENT_COPY`, lead-record fields                                                                                                                                                                                                                                                                                       |
| `src/schema/response-schema.ts`      | `MedicalProfileSchema` + consent fields + validation rule                                                                                                                                                                                                                                                                                                      |
| `src/state-machine/state-machine.ts` | `medical_offer` / `medical_review` states, `APPROVED_MEDICAL_TOPICS`                                                                                                                                                                                                                                                                                           |
| `src/prompts/system-prompt.ts`       | §9.1 MEDICAL FACT-FINDING                                                                                                                                                                                                                                                                                                                                      |
| `src/evaluation/evaluation-plan.ts`  | 4 medical guardrail scenarios                                                                                                                                                                                                                                                                                                                                  |
| `src/index.ts`                       | **Wired** — endpoint gating honors `HEALTH_DATA_COLLECTION_DISABLED` (default true). When disabled, medical context flags are forced off and health data in chat is blocked; when `HEALTH_DATA_COLLECTION_DISABLED=false`, the request-body medical flags flow into the state machine and health data is accepted only in the consented `medical_review` state |

## 7. Counsel checklist

- [ ] Approve `RECOMMENDED_MEDICAL_CONSENT_COPY` and the just-in-time notice wording.
- [ ] Confirm the fields are the minimum needed for carrier matching (TDPSA sensitive-data minimization).
- [ ] Confirm retention, deletion, and withdrawal handling for medical data.
- [ ] Confirm no field creates an implied underwriting or recommendation duty for the assistant.
- [ ] Confirm the MIB/attending-physician transparency statement is permitted advertising/educational content under 28 TAC §21.104.
