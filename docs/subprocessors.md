# Subprocessor register — LifeChat / Life Insurance Broker Advocate

**Status: DRAFT, incomplete.** This document records what the software sends where, what
is configured in a deployment, and which vendor artifacts are still missing. It is the
artifact the audit finding **M-10** asked for; the rows marked _not on file_ are the
reason the finding is not "closed" in the audit's sense, and no amount of code can close
them — they are contracts and provider settings that a person has to sign and record.

Reviewed: 2026-10-23 · Owner: Richard Parslow (licensed Texas broker) · Next review:
annually, and on any new outbound integration or provider change.

---

## 1. What the assistant sends where

The data flow is small enough to state completely. Every row below is implemented in
this repository; the "gate" column is the code that can stop the data.

| Data                                                                                 | Leaves the process?                        | Destination                                                                    | Gate before it leaves                                                                                                                                                         |
| ------------------------------------------------------------------------------------ | ------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The visitor's chat message                                                           | Yes, when the turn reaches the model       | LLM provider (see §2, row 1)                                                   | Prompt-injection, crisis, health/financial/PII classifiers and the medical-consent state; a blocked message never reaches the model (`src/app.ts`, `src/llm/orchestrator.ts`) |
| Recent conversation turns                                                            | Yes, same call                             | LLM provider                                                                   | Suffix of the same turn; sensitive turns are stored as redacted placeholders and sent as such                                                                                 |
| System prompt, approved reference passages, DIME progress, allowlisted article facts | Yes, same call                             | LLM provider                                                                   | Static prompt, corpus passages, and a validated page-context block — no caller free text beyond the message                                                                   |
| Lead/consent, DSR, booking and audit records                                         | Only if the deployment uses remote storage | Local volume, or an Archil disk when `ARCHIL_API_KEY`/`ARCHIL_DISK_ID` are set | AES-256-GCM envelope at rest; free text only inside the envelope (M-09); fail-closed, fsynced writes (M-05)                                                                   |
| Analytics events                                                                     | No — generated for the host page           | The host page's GA4 `dataLayer`                                                | Categorical, allowlisted fields only; no message text, no identifiers                                                                                                         |
| Server logs                                                                          | Yes, to the hosting platform's log store   | Hosting provider (see §2, row 2)                                               | Error facts only — name/code/status/type, a length and hash, and a route shape (M-06)                                                                                         |
| Email, SMS, calendar                                                                 | **No**                                     | —                                                                              | No email/SMS/calendar SDK is called by the server. The broker emails the consumer from their own mailbox; appointment slots are a local ledger, not a third-party calendar    |

Two facts follow from that table, and both matter for the notice:

- The only **content** that leaves this process is the material needed to answer one
  turn, and it goes to one destination: the model endpoint.
- Everything else is either local storage or the platform's operational logs.

## 2. Subprocessors

"Provider" names the deployed service. Almost every row is a **category**, because this
repository is deployed more than one way (Vercel, a container, or an Archil sandbox), and
the operator — not the code — chooses the vendor. Fill in the concrete name for the
deployment before publishing the notice.

| #   | Provider (category)                                                                     | Service                                                                         | Personal data involved                                                                                   | Region / residency                           | Retention and training posture                                             | Contract evidence                                | Status                           |
| --- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | -------------------------------- |
| 1   | **AI model provider** (default `api.openai.com`; `LLM_API_BASE_URL` may name a gateway) | Generates each chat reply from the message, recent turns and reference passages | Message content and recent turns, after the PII/health gates. No account identifiers, no contact details | _Record the region of the deployed endpoint_ | _Record whether the account has zero data retention / no training enabled_ | Data processing addendum + the retention setting | **Not on file**                  |
| 2   | **Hosting platform** (Vercel, or the container host)                                    | Serves the app; keeps request/console logs                                      | Request metadata, error facts, and whatever the platform records about the connection                    | _Record the hosting region_                  | Platform log retention period                                              | DPA in the platform's standard terms             | **Not on file**                  |
| 3   | **Archil** (optional; only when `ARCHIL_API_KEY` + `ARCHIL_DISK_ID` are set)            | Durable disk for the record logs when no volume is mounted                      | The same encrypted record lines the local volume would hold; audit logs in clear but PII-free            | _Record the disk region_                     | Object retention on the disk; deleted by erasure/retention sweeps          | DPA                                              | **Not on file** (skip if unused) |
| 4   | **Google Analytics 4** (the host page, not this server)                                 | Page analytics                                                                  | Page views and the categorical events the widget pushes; no chat content                                 | _Record GA4 property region/settings_        | GA4 property retention setting; IP anonymisation as configured             | Google's processor terms                         | **Not on file**                  |
| 5   | **Insurance carriers** (not a data processor)                                           | Underwriting/application, only with explicit consent                            | Whatever the consumer provides to the carrier directly                                                   | Carrier's own                                | Carrier's own notice                                                       | Not a subprocessor                               | Out of scope of this register    |

### Why there is no "zero retention" switch in the code

A boolean in `.env` would assert a vendor term without evidencing it — the same failure
mode this audit criticised elsewhere (a flag that claims durability instead of proving
it). The retention setting lives in the provider's account and its contract; this
register is where the operator records it, and the readiness payload
(`GET /api/admin/health`) shows which endpoint and model a deployment is actually using so
the register can be checked against reality.

## 3. Current state (2026-10-23)

- The shipped default is the OpenAI API (`LLM_API_BASE_URL=https://api.openai.com/v1`,
  `LLM_MODEL=gpt-4o`). A deployment that points `LLM_API_BASE_URL` at a gateway has a
  **different** provider — and a different row here.
- No signed DPA, subprocessor addendum, region confirmation, or zero-retention setting is
  stored in this repository. Rows 1–4 are therefore _not on file_.
- The privacy notice (§5) already discloses that service providers process information on
  our behalf; it now names AI processing explicitly and points at this register.

## 4. Before public traffic

- [ ] Name the concrete provider for each row of §2 in the deployment's copy of this file.
- [ ] File a signed DPA (or the provider's standard processor terms, with the date
      recorded) for rows 1–3 that are in use.
- [ ] Enable the provider's no-training / zero-retention option, and record the clause or
      the account setting with a date. If the provider offers no such option, say so here
      rather than leaving the row empty — an undocumented "probably fine" is the finding.
- [ ] Record the processing region for each row; if data must stay in the United States,
      pin the region in the provider's account and in the host.
- [ ] Confirm the GA4 property's retention setting and that IP anonymisation is on.
- [ ] Update `docs/privacy-notice.md` §5 if a named provider's role differs from the
      category wording (e.g. a gateway that adds a second processor).
- [ ] Keep this register with the compliance matrix; re-review annually and on change.

## 5. Keeping it accurate

- **One outbound integration point.** The server makes exactly one kind of outbound call
  today: `src/llm/llm-client.ts`. A new network dependency (email, SMS, calendar, a
  second model, an observability SaaS) needs a row here **before** it merges.
- **Check what a deployment actually uses.** `/api/admin/health` reports the model and
  base URL; the boot log reports the record-storage mode (local volume or Archil). Those
  two facts decide rows 1–3.
- **The status is deliberate.** A row marked _not on file_ is not a documentation gap; it
  is an open compliance action. Do not mark one "done" without the artifact.
