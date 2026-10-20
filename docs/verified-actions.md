# Verified side effects: lead creation and appointment booking

Section 4.8 of the specification says the model may _propose_ a side effect, but
only the application may _authorize_ one. This document describes exactly what
the application verifies before a lead or a booking is acknowledged, so the
authorization can be reviewed as a contract rather than inferred from code.

Implementation: [src/tools/verified-actions.ts](../src/tools/verified-actions.ts)
(composition of the facts), [src/tools/tool-controls.ts](../src/tools/tool-controls.ts)
(policy and argument allowlist), [src/scheduling/appointment-slots.ts](../src/scheduling/appointment-slots.ts)
(slot inventory and booking ledger), [src/consent/consent-model.ts](../src/consent/consent-model.ts)
(the consent artifact).

## Where each fact comes from

| Fact             | Source                                                                                                          | Never from                             |
| ---------------- | --------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| Contact consent  | The lead record `/api/consent` wrote when the visitor submitted the form, joined to the session by `session_id` | `consent` in the model's reply         |
| Consent currency | `contact_consent_version === CONTACT_CONSENT_VERSION` (server config)                                           | A version string the model emitted     |
| Contact validity | Server-side email/phone validation against the channel the visitor chose                                        | `lead_data` in the model's reply       |
| Booking slot     | The server's own half-hour inventory (`GET /api/scheduling/slots`)                                              | A `slot_id` the model invented         |
| Slot choice      | `POST /api/scheduling/select`, recorded on the session                                                          | A slot only the model mentioned        |
| Appointment      | The booking ledger in this process                                                                              | An `appointment_id` the model supplied |
| Idempotency key  | Derived here: `lead:<session>`, `booking:<session>:<slot>`, `confirmation:<session>:<appointment>`              | The model's `idempotency_key`          |

## Flow

1. **Consent.** `POST /api/consent` validates the body, writes the lead record
   with `session_id`, the consent version, a timestamp, and the SHA-256 of the
   affirmed copy, then moves the session to the `consent` state.
2. **Availability.** `GET /api/scheduling/slots` returns only slots the server
   issued: inside staffed Central-Time hours, at least `MINIMUM_NOTICE_HOURS`
   out, within `BOOKING_HORIZON_DAYS`, and not already booked.
3. **Selection.** `POST /api/scheduling/select` re-verifies the id, stores it on
   the session, and moves the session to `scheduling`. Selection books nothing.
   A malformed or overflowing id (`slot_20260231T1800Z`) is rejected by a
   round-trip check, not silently rolled into a different date. The widget
   fetches availability itself on a `scheduling` turn, renders only canonical
   `slot_…` ids as text, and posts the chosen id with the conversation's own
   session id; a slot taken in between answers 409 and the widget refreshes the
   list rather than retrying the stale choice. The times are a labelled
   radio group with one tab stop: arrows/Home/End move focus only, and Enter
   or Space commits the focused time.
4. **Chat.** `/api/chat` hands the model's `proposed_action` to
   `executeProposedAction`, which re-verifies everything at commit time and
   returns server-derived arguments only.

## Authorization rules

`create_lead` is authorized only when a complete, current consent record for
_this session_ exists. The action is then an **acknowledgement**: the lead
already exists, so nothing is written again and a retry returns the same
`lead_id`. No `lead_data` from the model is stored or echoed.

`book_appointment` is authorized only when:

- a verified consent record exists for the session;
- the model's `slot_id` equals the slot the visitor selected;
- the slot still passes `verifySlot` at commit time (re-checked after selection,
  so a slot taken in the meantime is refused);
- the session does not already hold a different appointment.

`send_transactional_confirmation` is authorized only for an appointment id this
process created for this session.

`get_calendar_slots` returns the server's availability in
`action_arguments.available_slots`; the model cannot populate it.

`none`, `search_knowledge`, and `request_human_handoff` carry no side effect and
are subject only to the allowlist and argument sanitization. An argument the
model attached that is not on the allowlist drops the whole proposal.

## Idempotency

- The same key, session, and slot returns the original appointment
  (`replayed: true`) — a retried turn never double-books.
- The same key pointing at a different slot or session is a conflict, so a key
  cannot be redefined to reach another visitor's booking.
- A session may hold at most one appointment; a second slot is refused rather
  than silently replacing or duplicating it.
- Check-and-set is synchronous, so two requests interleaved on the event loop
  cannot both win the same slot.

## Fail-closed defaults

| Condition                                                | Result                    |
| -------------------------------------------------------- | ------------------------- |
| No consent record for the session                        | `consent_not_verified`    |
| Record missing version, timestamp, or affirmed-copy hash | `no_consent_record`       |
| Consent version superseded                               | `stale_consent_version`   |
| Contact value invalid for its channel                    | `invalid_contact_field`   |
| Open deletion request for the consented address          | `consent_withdrawn`       |
| `do_not_contact` reported by the model                   | `consent_withdrawn`       |
| Model names a slot the visitor did not select            | `slot_selection_required` |
| Slot no longer bookable at commit                        | `slot_not_verified`       |
| Ephemeral serverless runtime (`SERVERLESS=true`)         | `storage_unavailable`     |
| Any other action                                         | `tool_not_authorized`     |

When a side-effect proposal is refused, the route sets
`risk_flags: ['tool_action_blocked']` and `analytics.error_code:
'tool_action_blocked'`, and appends a correction to the assistant message
because the model's prose may already claim the action succeeded.

## Known limitations

- **Single-instance ledger.** Slot bookings and their idempotency keys live in
  this process (bounded LRU, `MAX_TRACKED_APPOINTMENTS`). That is correct for
  one instance and for the pilot; a multi-instance deployment must replace the
  ledger with the practice-management calendar, which is also where the slot
  inventory should come from. There is no network calendar integration yet:
  `listAvailableSlots` generates a business-hours grid.
- **Serverless is refused, not emulated.** On Vercel the side-effect actions
  return `storage_unavailable`; a confirmation that storage cannot keep is never
  issued.
- **Deletion suppression matches on email.** A deletion DSR suppresses further
  side effects for the consented email address. Phone-only consent has no
  equivalent suppression key yet.
- **In-process consent lookup.** Session → consent lookups are cached, including
  negative results (so a session that never consented does not re-scan the
  append-only log on every turn). A consent written by this process invalidates
  its own negative entry immediately; a record written by _another instance_
  is only picked up after a restart or cache eviction.
- **Withdrawal semantics.** `DELETE /api/session/:id` clears conversation state
  only. Consent lives in the lead record, and withdrawing it is the durable,
  auditable path: a deletion DSR. A restart therefore still verifies consent
  that was never withdrawn — which is the correct legal direction.
- **The assistant's own availability claims are not rewritten.** The model can
  still say "I have Tuesday at 9" in prose; only the structured
  `action_arguments.available_slots` and the verified booking are authoritative.

## Tests

- [tests/verified-actions.test.ts](../tests/verified-actions.test.ts) — slot
  verification, ledger idempotency, consent verification, execution rules.
- [tests/verified-actions-api.test.ts](../tests/verified-actions-api.test.ts) —
  the same guarantees through `/api/consent`, `/api/scheduling/*`, and
  `/api/chat` with a mocked model.
- [tests/lead-persistence.test.ts](../tests/lead-persistence.test.ts) — consent
  still verifies after a simulated restart (the session binding is rebuilt from
  the log).
