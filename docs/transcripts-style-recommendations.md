# Transcript Review — Recommendations for Speech Patterns & Responses

**Source reviewed:** 22 files in `/Users/richardparslow/Desktop/Transcripts` (sales training for the Larsson Collective / Symmetry Financial Group — the "Don't Suck at Sales" podcast with John Ziller & Miranda Martin, plus trainings by Jim Larson, Nate Auffort, Dana Wilson, Rachel Dorr, and Stephanie Gant).

**Purpose of this document:** distill what is *adaptable* from those transcripts into the LifeChat assistant's speech patterns and question-answering behavior, and clearly separate what must be *rejected* because it conflicts with the compliance-first spec (Texas Insurance Code, TDI rules, NAIC AI bulletin, the project's own Section 5 system policy).

---

## 1. The core tension, stated plainly

The transcripts are classic **high-pressure, relationship-driven life-insurance sales coaching**. Their signature techniques — *"push at least twice,"* *"never take 'call me back,'"* *"pressure applied in certain situations is absolutely appropriate,"* *"scare them out of blood work,"* *"your wife is not going to be upset with you for prioritizing her protection"* — are **explicitly prohibited** by the assistant's Section 5/7 policy (no guilt, fear, false urgency, scarcity, shame, repeated persuasion, or family-protection-status claims) and by its loop controls (never re-ask a declined field, suppress offers after decline).

However, a large portion of the transcripts is **communication craft that is fully compatible** with a compliance-first, educational assistant. The recommendations below mine that compatible layer and convert the incompatible layer into **negative guardrails** (rules + evaluation tests that fail on prohibited patterns).

---

## 2. Adaptable patterns — recommended for implementation

### 2.1 "Role and Purpose" roadmap (Ep 14 — strongest match)
The transcripts insist you tell the prospect *what is going to happen before it happens*, numbered and explicit: *"There are four things we're doing today…"* This is exactly what the assistant's disclosure state is for, and it is 100% compliance-compatible.

**Implementation (system prompt §14 addition):**
- At the start of a session and on every significant state transition, give a one-to-three-step roadmap: e.g., *"I'll answer your general questions first; then, only if you'd like, I can connect you with Richard Parslow, a licensed Texas life-insurance broker."*
- Number the steps when there are 2+ (the transcripts' bullet-point style maps to plain-English numbered steps).
- Never announce an action the assistant will not actually perform (no "we're doing an application today" equivalents).

### 2.2 Justify before you ask (Ep 9)
*"I always justify what I'm doing before I do it — a way of asking for approval with confidence."* Before requesting anything (a scheduling slot, an optional qualification answer, contact info), state *why* it's needed and how it will be used.

**Implementation:** harden into the consent/qualification flow. The consent model already requires stating fields/purpose/recipient; make "state the reason before the question" a style rule for every collection point, and add the same rule to the LLM prompt so even non-consent questions (e.g., *"which state are you in?"* for jurisdiction) carry a brief reason.

### 2.3 Echo / regurgitation of the user's own words (Ep 3–4)
*"It's their words, not your words… if they say it, there's undeniable fact behind it."* The transcripts build agreement by restating the prospect's statements back. For an educational assistant this is a **comprehension and trust** device, not a persuasion device.

**Implementation (system prompt style rule):**
- Before answering, briefly restate the question in the user's own terms when it helps: *"So you're comparing term life that lasts 20 years with whole life that builds cash value — is that right?"* This also serves the existing `clarify` state (confirms understanding instead of guessing).
- Keep it to one confirming sentence; never use it as a sales "tie-down" toward a decision.

### 2.4 Alternative of choice, with recap (Ep 11, Ep 17, show-factor episode)
*"Always offer two options, then repeat them at the end: 'Do you want A or do you want B?'"* Also: *"the first price you ever hear is always expensive"* → establish value/context before numbers; and *"the next person that talks loses"* → after presenting options, stop talking.

**Implementation:**
- The state machine already presents **2–3 options** in scheduling; add an explicit "recap and ask" instruction (state the options, then ask which the user prefers) and a rule to **pause after asking** (one question per turn — already enforced).
- When the assistant offers a choice of actions (e.g., continue learning vs. connect with a licensed broker), frame it as two clear options rather than an open question.
- Context-before-detail: give the educational context *before* any number, quote, or comparison (no raw "here are three prices" behavior — the assistant doesn't quote prices, but the same principle applies to stats/facts from RAG: context first).

### 2.5 Preempt objections before they arise (Ep 14, Ep 8)
*"The best way to overcome an objection is before it ever even comes up… talk about it before it ever comes up."*

**Implementation:** bake the known friction points into the disclosure/early states so the user never has to ask:
- *"I can't give quotes, premiums, or policy recommendations here — I provide general education."* (preempts the #1 expectation mismatch)
- *"This chat is not the right place for medical history or Social Security numbers."* (preempts sensitive-data disclosure — already in the banner; make it an early spoken line too)
- *"If you'd like a personalized review, Richard can do that on a licensed basis."* (preempts the "can you price this for me" turn)

### 2.6 "Keep it super simple" language (Ep 11, §14)
Two-option framing, one idea per sentence, short words, repeat key information. This aligns with the existing 10th-grade / ≤120-word / ≤1-follow-up rules.

**Implementation:** extend the style section with the transcripts' K.I.S.S. checklist: one idea per sentence; no stacking of numbers or options; when a number or fact is important, state it once plainly and once in plain English.

### 2.7 Confident, grounded tone — no hedging, no up-speak (Ep 5, Good vs Bad Agent)
The transcripts equate confidence with *knowing your material*. The chatbot's analog of "I know my material" is **only asserting what the RAG evidence supports** and using the mandated abstention sentence for everything else. Vague hedging ("maybe," "I think so," "probably") is the chatbot's "up-speak."

**Implementation (style rule):** assert firmly when grounded; say exactly the abstention sentence when not. No filler hedges, no apologies for not knowing — just the approved fallback.

### 2.8 Weak-answer detection → stricter consent (show-factor episode)
The transcripts train agents to catch weak answers (*"if nothing comes up,"* *"I should be able to"*) and treat them as *not* commitments. The assistant's consent model should be **more** conservative in the same direction: only an **unambiguous affirmative** counts as consent; anything conditional, vague, or hedged must be treated as *not consented* and re-confirmed (or declined gracefully).

**Implementation (prompt + widget, not validation):** the raw consent text never reaches the application layer — the schema stores `contact_consent_affirmed` as a boolean (`response-schema.ts`) and `/api/consent` receives that boolean. So ambiguity must be handled *before* it becomes a boolean: (1) instruct the model in the system prompt to set `contact_consent_affirmed: false` for anything less than an unambiguous "yes" (e.g., "maybe," "I guess," "if nothing comes up," "probably") and to re-confirm once or decline gracefully; (2) the widget's consent control must be an explicit, unchecked opt-in checkbox — unambiguous by construction. The existing schema rule (create_lead requires `contact_consent_affirmed`) then blocks any residual ambiguity. Add an evaluation test that a hedged utterance yields `contact_consent_affirmed: false`.

### 2.9 "The call doesn't start until you elicit resistance" → handle the real question first
The transcripts: don't answer objections in the first 30 seconds; answer the *reason* for the call first. For the assistant this maps to the existing rule: **answer the user's question before any qualification or offer** (Section 7: "Answer the user's question before qualification"). No change needed — but worth a regression test that value is always delivered before any offer appears.

### 2.10 Curiosity and open-ended framing (Ep 3; "ferociously curious" — Good vs Bad Agent)
The transcripts favor *who/what/when/where/why/how* questions to get people thinking. Within the assistant's **three approved qualification topics** (goal category, timeline, current coverage), prefer the open-ended framing over presumptive wording — e.g., *"What are you hoping to understand about life insurance today?"* rather than *"Are you looking to buy?"* (the latter risks steering toward a transaction the assistant can't do).

---

## 3. Rejected patterns — encode as negative guardrails

These techniques appear throughout the transcripts and must **never** appear in assistant output. Most are already prohibited by policy; the recommendation is to make them **machine-checkable** in evaluation so a regression can't slip through.

| Transcript technique | Why it's rejected | Existing guardrail | Action |
|---|---|---|---|
| "Push at least twice," never accept the first no (Ep 8) | Repeated persuasion prohibited | §7, §12, `LOOP_CONTROLS` | Add eval case: after a decline, assistant must not re-offer |
| "Pressure applied in certain situations is absolutely appropriate" (Good vs Bad Agent) | Pressure tactics prohibited | `PROHIBITED_PRESSURE_TACTICS` | Add eval case: no urgency/scarcity language ever |
| Guilt/fear/family-status claims ("your wife won't be upset," "you're 10 years late," "leave them with nothing") (Ep 3, Good vs Bad Agent) | Fear/guilt/family-protection-status claims prohibited | §7 | Add eval case: outputs containing these frames fail |
| "Walk their pain," 7-layers-deep digging (Ep 3–4) | Would require emotional pressure + forbidden fields | §7, `APPROVED_QUALIFICATION_TOPICS` | Cap at the 3 approved topics; never "dig deeper" on refusal |
| Assumptive closes ("go ahead with that," "I'll assume we're good," "we're doing an application today") (Ep 9, Ep 14) | No implied consent, no fabricated confirmations | §9, §5 | Add eval case: no language implying consent/agreement was given |
| Income/asset/equity fact-finding (Ep 7) | `exact_income`, `exact_debt`, account data forbidden | `FORBIDDEN_CHAT_FIELDS` | Keep hard-blocked; note it explicitly in the style guide |
| Third-party "success story" persuasion (Ep 13, Ep 17) | Fabricated stories/facts prohibited | §5 ("never fabricate") | Only approved, retrieved, cited content may be used — recommend **no** anecdote use in Phase 1 |
| Fear-mongering about underwriting ("scare them out of blood work") (Ep 13) | Fear tactics; also implies underwriting advice | §5, §7 | Blocked; the assistant must not discuss underwriting outcomes |
| Multiple phone numbers / "stalk the lead" persistence (Ep 12) | N/A to chatbot + conflicts with consent | — | No analog; do not implement persistence behavior |

---

## 4. Concrete code-level changes (prioritized)

### Phase 1 (now — low risk, high value)
1. **`src/prompts/system-prompt.ts`** — extend §14 (Style) with a short "Communication Style" addendum encoding §2.1–2.7 above: roadmap, justify-before-ask, echo-confirm, two-option-with-recap, preempt objections, K.I.S.S., no hedging. Keep each rule to one sentence. Add the negative line: *"Never use sales pressure, scarcity, guilt, or assumptions of consent — this is education, not a sale."*
2. **Prompt-level consent strictness** — in `src/prompts/system-prompt.ts`, instruct the model to set `contact_consent_affirmed: false` for anything less than an unambiguous "yes" and to re-confirm once or decline gracefully (the schema stores this as a boolean, so ambiguity cannot be caught in validation). The widget's consent control stays an explicit, unchecked opt-in checkbox. Add an evaluation test that hedged utterances ("maybe," "I guess," "if nothing comes up") yield `contact_consent_affirmed: false`.
3. **`src/evaluation/evaluation-plan.ts`** — add the guardrail test scenarios from §3 (decline → no re-offer; ambiguous consent → not consented; no pressure language; no fabricated anecdotes; value-before-offer).

### Phase 2 (consented lead capture + scheduling)
4. **Follow-up lifecycle** (from More.txt / Stephanie Gant, "submitted business isn't paid business"): design a **post-consent** client-journey touchpoint plan — (a) immediate thank-you + confirm the appointment/draft expectations, (b) review call within ~10 days incl. a referral ask, (c) 3-month check-in, (d) annual review. Each touchpoint requires its own channel consent per the FCC/TDPSA rules already in the spec; this is a Phase 2+ product decision, not an in-chat behavior.
5. **"Resets" / life-event listening** (Dana Wilson): in the annual-review or policy-review conversation (Phase 2+), allow the assistant to surface *educational* topics when a user mentions a qualifying life event (new baby, retirement, mortgage, debt) — always as education or a licensed-broker handoff, never as a product pitch. This mirrors the transcripts' reset flow but stays inside the no-recommendation boundary.

### Explicitly out of scope
- Adding the transcripts themselves (or their techniques) to the RAG corpus. They are internal sales training, not approved educational sources, and several techniques are non-compliant. The **style patterns** above belong in the prompt; the **content** stays out of the knowledge base.

---

## 5. Summary table — transcript theme → assistant behavior

| Transcript theme | Assistant behavior |
|---|---|
| Role & purpose roadmap | Step-by-step disclosure of what will happen, before it happens |
| Justify before asking | State why each question/collection is needed, first |
| Echo their words | Restate the user's question to confirm understanding |
| Alternative of choice + recap | Present 2 clear options, then ask which they prefer |
| Preempt objections | Say early: no quotes/recommendations here; don't share sensitive data |
| K.I.S.S. | One idea per sentence, short words, repeat key facts plainly |
| Confidence = knowing material | Assert only what RAG supports; abstention sentence for the rest; no hedging |
| Weak answers aren't yes | Consent requires an unambiguous affirmative |
| Answer before selling | Deliver the answer first; qualification only after, at most one question |
| Push twice / pressure / fear / guilt / scarcity | **Rejected** — encoded as evaluation failures |
| Walk-their-pain digging | **Rejected** — capped at 3 approved non-sensitive topics |
| Assumptive closes | **Rejected** — consent must be explicit, never implied |
| Anecdote persuasion | **Rejected** — no fabricated stories; approved cited content only |
| Follow-up cadence / resets | Phase 2+ post-consent lifecycle design (outbound, separately consented) |
