/**
 * Verified side effects (Section 4.8 / ARCH-02).
 *
 * The model may propose an action; only this module may authorize one. The
 * distinction that makes the authorization real is where the *facts* come
 * from:
 *
 *  - Consent is read from the durable record /api/consent wrote when the
 *    visitor submitted the form — never from `consent` in the model's reply,
 *    which is the model's claim about itself.
 *  - A slot is read from the server's own inventory, and the visitor's chosen
 *    slot is recorded by the scheduling route before a booking may name it —
 *    never from a `slot_id` the model produced.
 *  - Idempotency keys are derived here from the session and the action, so a
 *    model-supplied key can neither replay someone else's booking nor defeat
 *    the duplicate check.
 *
 * Fail-closed defaults, in order of application:
 *
 *  1. Nothing authorizes without a verified consent record: no record, a
 *     superseded consent version, an incomplete artifact, or a contact value
 *     that does not match its channel all mean "no consent".
 *  2. A *verified* deletion request for the consented address suppresses every
 *     side effect, even though the record still exists. An unverified request
 *     has no authority: otherwise anyone could POST a victim's email and stop
 *     contact with them.
 *  3. Side effects are refused outright on an ephemeral serverless runtime,
 *     where the records that would prove them cannot survive a cold start.
 *  4. Actions with no verified path (anything not handled here) are refused,
 *     not passed through.
 */

import { config, isRecordStorageSafe } from '../config/app-config';
import { getVerifiedContactConsent, type VerifiedContactConsent } from '../consent/consent-model';
import { ensureDsrRecordsLoaded, listDsrRecords } from '../privacy/dsr';
import {
  bookSlot,
  listAvailableSlots,
  type AppointmentSlot,
} from '../scheduling/appointment-slots';
import { getSelectedSlot } from '../llm/session-store';
import type { Consent, ProposedAction } from '../schema/response-schema';
import { authorizeToolAction, type ToolAuthorizationResult } from './tool-controls';

/**
 * Appended by the route when a proposed side effect was refused, because the
 * model's prose may already have said it was done. A booking or a lead is
 * never confirmed on the strength of the model's own text.
 */
export const ACTION_NOT_CONFIRMED_NOTE =
  "I couldn't confirm that in the chat just now. Please contact Richard Parslow directly and we'll complete it with you.";

/** Stable rejection codes, safe to surface in analytics and logs. */
export type ActionRejectionCode =
  | 'storage_unavailable'
  | 'consent_not_verified'
  | 'consent_withdrawn'
  | 'slot_selection_required'
  | 'slot_not_verified'
  | 'appointment_exists'
  | 'appointment_not_verified'
  | 'idempotency_conflict'
  | 'tool_not_authorized';

/** What actually happened, for the caller and for the tests. */
export interface VerifiedActionEffect {
  leadId?: string;
  appointmentId?: string;
  slotId?: string;
  startsAt?: string;
  availableSlots?: AppointmentSlot[];
  /** True when the action returned work an earlier request had already done. */
  replayed?: boolean;
}

export interface VerifiedActionResult {
  authorized: boolean;
  errors: string[];
  /** Server-derived arguments only; nothing from the model is echoed back. */
  sanitizedArguments: Record<string, unknown>;
  effect: VerifiedActionEffect | null;
  code: ActionRejectionCode | null;
}

export interface ProposedActionInput {
  sessionId: string;
  proposedAction: ProposedAction;
  actionArguments?: Record<string, unknown> | null;
  /** The model's do-not-contact signal; it can suppress, never grant. */
  doNotContact?: boolean;
  now?: Date;
}

/** Consent state used for proposals that carry no side effect. */
const NO_CONSENT: Consent = {
  privacy_notice_version: config.privacyNoticeVersion,
  contact_consent_version: null,
  contact_consent_affirmed: false,
  medical_consent_version: null,
  medical_consent_affirmed: false,
  do_not_contact: false,
};

function reject(code: ActionRejectionCode, errors: string[]): VerifiedActionResult {
  return { authorized: false, errors, sanitizedArguments: {}, effect: null, code };
}

function fromPolicy(policy: ToolAuthorizationResult): VerifiedActionResult | null {
  return policy.authorized ? null : reject('tool_not_authorized', policy.errors);
}

/**
 * True when a *verified* deletion request exists for the consented address.
 *
 * The record outlives the request (a deletion is honoured out of band), so the
 * verified request is the suppression signal: while it is open, nothing new
 * may be created for that contact. Verification matters because /api/dsr is
 * unauthenticated — without it, a third party could suppress a real lead by
 * submitting the victim's address. Unverified requests (including records
 * written before this field existed) simply have no authority yet.
 */
async function hasPendingDeletion(consent: VerifiedContactConsent): Promise<boolean> {
  if (!consent.email) return false;
  await ensureDsrRecordsLoaded();
  const target = consent.email.toLowerCase();
  return listDsrRecords().some(
    (record) =>
      record.request_type === 'deletion' &&
      record.verified === true &&
      record.contact_email.toLowerCase() === target,
  );
}

/** Consent state derived from the stored record, for the policy layer. */
function consentStateFrom(consent: VerifiedContactConsent, doNotContact: boolean): Consent {
  return {
    ...NO_CONSENT,
    contact_consent_version: consent.version,
    contact_consent_affirmed: true,
    do_not_contact: doNotContact,
  };
}

/**
 * Verifies and, when authorized, executes a proposed action.
 *
 * Read-only proposals (`none`, `search_knowledge`, `request_human_handoff`) and
 * availability reads carry no side effect, so only the allowlist and argument
 * sanitization apply to them. Everything else must pass the consent, slot, and
 * idempotency checks below before any effect is recorded.
 */
export async function executeProposedAction(
  input: ProposedActionInput,
): Promise<VerifiedActionResult> {
  const { sessionId, proposedAction } = input;
  const actionArguments = input.actionArguments ?? {};
  const now = input.now ?? new Date();

  // 1. Proposals with no side effect: policy only.
  if (
    proposedAction === 'none' ||
    proposedAction === 'search_knowledge' ||
    proposedAction === 'request_human_handoff'
  ) {
    const policy = authorizeToolAction({
      proposedAction,
      actionArguments,
      consent: NO_CONSENT,
      userRequestedAction: true,
      requiredFieldsValid: true,
      suppressionChecksPassed: true,
    });
    const rejected = fromPolicy(policy);
    if (rejected) return rejected;
    return {
      authorized: true,
      errors: [],
      sanitizedArguments: policy.sanitizedArguments,
      effect: null,
      code: null,
    };
  }

  // 2. Availability is a read, but the times must be the server's. The model
  //    says what it likes; these are the slots the visitor can actually pick.
  if (proposedAction === 'get_calendar_slots') {
    const policy = authorizeToolAction({
      proposedAction,
      actionArguments,
      consent: NO_CONSENT,
      userRequestedAction: true,
      requiredFieldsValid: true,
      suppressionChecksPassed: true,
    });
    const rejected = fromPolicy(policy);
    if (rejected) return rejected;
    const availableSlots = listAvailableSlots(now);
    return {
      authorized: true,
      errors: [],
      sanitizedArguments: {
        time_zone: policy.sanitizedArguments.time_zone ?? null,
        available_slots: availableSlots,
      },
      effect: { availableSlots },
      code: null,
    };
  }

  // 3. Every remaining action has a side effect. Fail closed where the
  //    record that would prove it cannot be kept.
  if (!isRecordStorageSafe()) {
    return reject('storage_unavailable', [
      'side effects are unavailable on this runtime because their records cannot be durably stored',
    ]);
  }

  // 4. Consent comes from storage, not from the model.
  const verification = await getVerifiedContactConsent(sessionId);
  if (!verification.ok) {
    return reject('consent_not_verified', [
      `contact consent could not be verified server-side (${verification.reason})`,
    ]);
  }
  const consent = verification.consent;

  if (await hasPendingDeletion(consent)) {
    return reject('consent_withdrawn', [
      'a deletion request is open for this contact, so no new record may be created',
    ]);
  }

  const doNotContact = input.doNotContact === true;
  if (doNotContact) {
    return reject('consent_withdrawn', ['do_not_contact suppresses every side effect']);
  }

  const consentState = consentStateFrom(consent, doNotContact);

  // 5. Lead creation: the consented record already exists, so this is an
  //    acknowledgement, replayed identically on every retry. Nothing is
  //    written twice, and no field from the model is stored.
  if (proposedAction === 'create_lead') {
    const policy = authorizeToolAction({
      proposedAction,
      actionArguments,
      consent: consentState,
      // The user submitted the consent form for this session: that submission
      // is the request to be contacted, and it is what the facts above prove.
      userRequestedAction: true,
      requiredFieldsValid: true,
      suppressionChecksPassed: true,
      idempotencyKey: `lead:${sessionId}`,
    });
    const rejected = fromPolicy(policy);
    if (rejected) return rejected;

    return {
      authorized: true,
      errors: [],
      sanitizedArguments: { lead_id: consent.leadId },
      effect: { leadId: consent.leadId, replayed: true },
      code: null,
    };
  }

  // 6. Booking: only the slot the visitor selected, re-verified at commit.
  if (proposedAction === 'book_appointment') {
    const selectedSlotId = getSelectedSlot(sessionId);
    const requestedSlotId =
      typeof actionArguments.slot_id === 'string' ? actionArguments.slot_id : '';

    if (!selectedSlotId || requestedSlotId !== selectedSlotId) {
      return reject('slot_selection_required', [
        'book_appointment requires the slot the visitor selected through the scheduling route',
      ]);
    }

    const idempotencyKey = `booking:${sessionId}:${selectedSlotId}`;
    const policy = authorizeToolAction({
      proposedAction,
      actionArguments: { ...actionArguments, slot_id: selectedSlotId },
      consent: consentState,
      userRequestedAction: true,
      requiredFieldsValid: true,
      suppressionChecksPassed: true,
      idempotencyKey,
    });
    const rejected = fromPolicy(policy);
    if (rejected) return rejected;

    const booking = bookSlot({ slotId: selectedSlotId, sessionId, idempotencyKey, now });
    if (!booking.ok) {
      const code: ActionRejectionCode =
        booking.code === 'idempotency_conflict'
          ? 'idempotency_conflict'
          : booking.code === 'appointment_exists'
            ? 'appointment_exists'
            : booking.code === 'ledger_unavailable'
              ? 'storage_unavailable'
              : 'slot_not_verified';
      return reject(code, [`slot ${selectedSlotId} could not be booked (${booking.code})`]);
    }

    return {
      authorized: true,
      errors: [],
      sanitizedArguments: {
        appointment_id: booking.appointment.appointment_id,
        slot_id: booking.appointment.slot_id,
      },
      effect: {
        appointmentId: booking.appointment.appointment_id,
        slotId: booking.appointment.slot_id,
        replayed: booking.replayed,
      },
      code: null,
    };
  }

  // 7. A confirmation is a delivery, and this deployment has no transport.
  //    Authorizing it would return `authorized: true` for a message that was
  //    never sent, while the model's prose ("I've emailed your confirmation")
  //    stands — a false statement to a consumer in a fiduciary context. Refuse
  //    until a real mail/SMS transport exists and its 2xx is the authorization:
  //
  //      const delivery = await sendTransactionalEmail({ to: consent.email, appointment });
  //      if (!delivery.ok) return reject('tool_not_authorized', ['delivery failed']);
  //      return { authorized: true, effect: { appointmentId, delivered: true }, ... };
  //
  //    The route then appends ACTION_NOT_CONFIRMED_NOTE and points the visitor
  //    at the licensed broker, so no delivery is ever claimed on intent alone.
  if (proposedAction === 'send_transactional_confirmation') {
    return reject('tool_not_authorized', [
      'no transactional transport is configured; a confirmation cannot be claimed',
    ]);
  }

  // 8. Unreachable for the current schema; fail closed if it ever is not.
  return reject('tool_not_authorized', ['the proposed action has no verified execution path']);
}
