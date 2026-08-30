/**
 * Tests for the Conversation State Machine (Section 4.4)
 *
 * Verifies all state transitions, entry conditions, allowed behaviors,
 * and exit conditions for the 12-state conversation flow.
 */

import {
  getNextState,
  LOOP_CONTROLS,
  type StateTransitionContext,
} from '../src/state-machine/state-machine';

/** Helper: build a minimal context with all fields defaulted to false/empty. */
function makeCtx(overrides: Partial<StateTransitionContext>): StateTransitionContext {
  return {
    currentState: 'education',
    userMessage: '',
    hasValueBeenDelivered: false,
    userShowsInterest: false,
    queryIsAmbiguous: false,
    userAgreesToQualification: false,
    userRequestsFollowup: false,
    contactChannelChosen: false,
    consentAffirmative: false,
    requiredFieldsValid: false,
    userAsksToBook: false,
    bookingApiConfirms: false,
    riskOrEscalationTrigger: false,
    userDeclinesOrFlowEnds: false,
    ...overrides,
  };
}

describe('State Machine — getNextState', () => {
  // ── disclosure state ──
  describe('disclosure state', () => {
    test('transitions to education when user sends a message', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'disclosure',
          userMessage: 'What is term life insurance?',
        }),
      );
      expect(next).toBe('education');
    });

    test('returns null (stays in disclosure) when no user message', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'disclosure',
          userMessage: '',
        }),
      );
      expect(next).toBeNull();
    });

    test('returns null when message is only whitespace', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'disclosure',
          userMessage: '   ',
        }),
      );
      expect(next).toBeNull();
    });
  });

  // ── education state ──
  describe('education state', () => {
    test('transitions to clarify when query is ambiguous', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'education',
          queryIsAmbiguous: true,
        }),
      );
      expect(next).toBe('clarify');
    });

    test('transitions to qualification_offer when value delivered and user shows interest', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'education',
          hasValueBeenDelivered: true,
          userShowsInterest: true,
        }),
      );
      expect(next).toBe('qualification_offer');
    });

    test('transitions to contact_offer when user requests followup', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'education',
          userRequestsFollowup: true,
        }),
      );
      expect(next).toBe('contact_offer');
    });

    test('transitions to handoff on risk/escalation trigger', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'education',
          riskOrEscalationTrigger: true,
        }),
      );
      expect(next).toBe('handoff');
    });

    test('stays in education when nothing triggers a transition', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'education',
        }),
      );
      expect(next).toBe('education');
    });

    test('ambiguity takes priority over qualification offer', () => {
      // If the query is ambiguous, we should clarify before offering qualification
      const next = getNextState(
        makeCtx({
          currentState: 'education',
          queryIsAmbiguous: true,
          hasValueBeenDelivered: true,
          userShowsInterest: true,
        }),
      );
      expect(next).toBe('clarify');
    });
  });

  // ── clarify state ──
  describe('clarify state', () => {
    test('transitions to education when query is no longer ambiguous', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'clarify',
          queryIsAmbiguous: false,
        }),
      );
      expect(next).toBe('education');
    });

    test('stays in clarify when still ambiguous', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'clarify',
          queryIsAmbiguous: true,
        }),
      );
      expect(next).toBe('clarify');
    });

    test('transitions to handoff on risk trigger during clarification', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'clarify',
          queryIsAmbiguous: true,
          riskOrEscalationTrigger: true,
        }),
      );
      expect(next).toBe('handoff');
    });
  });

  // ── qualification_offer state ──
  describe('qualification_offer state', () => {
    test('transitions to qualification when user agrees', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'qualification_offer',
          userAgreesToQualification: true,
        }),
      );
      expect(next).toBe('qualification');
    });

    test('transitions to standby when user declines', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'qualification_offer',
          userDeclinesOrFlowEnds: true,
        }),
      );
      expect(next).toBe('standby');
    });

    test('returns to education when no response', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'qualification_offer',
        }),
      );
      expect(next).toBe('education');
    });
  });

  // ── qualification state ──
  describe('qualification state', () => {
    test('transitions to contact_offer when user requests followup', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'qualification',
          userRequestsFollowup: true,
        }),
      );
      expect(next).toBe('contact_offer');
    });

    test('returns to education when user declines', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'qualification',
          userDeclinesOrFlowEnds: true,
        }),
      );
      expect(next).toBe('education');
    });

    test('stays in qualification otherwise', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'qualification',
        }),
      );
      expect(next).toBe('qualification');
    });
  });

  // ── contact_offer state ──
  describe('contact_offer state', () => {
    test('transitions to consent when channel is chosen', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'contact_offer',
          contactChannelChosen: true,
        }),
      );
      expect(next).toBe('consent');
    });

    test('returns to education when user declines', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'contact_offer',
          userDeclinesOrFlowEnds: true,
        }),
      );
      expect(next).toBe('education');
    });

    test('stays in contact_offer otherwise', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'contact_offer',
        }),
      );
      expect(next).toBe('contact_offer');
    });
  });

  // ── consent state ──
  describe('consent state', () => {
    test('transitions to lead_submit when consent is affirmative and fields valid', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'consent',
          consentAffirmative: true,
          requiredFieldsValid: true,
        }),
      );
      expect(next).toBe('lead_submit');
    });

    test('does not transition to lead_submit when consent is not affirmative', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'consent',
          consentAffirmative: false,
          requiredFieldsValid: true,
        }),
      );
      expect(next).toBe('consent');
    });

    test('does not transition to lead_submit when fields are invalid', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'consent',
          consentAffirmative: true,
          requiredFieldsValid: false,
        }),
      );
      expect(next).toBe('consent');
    });

    test('returns to education when user declines', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'consent',
          userDeclinesOrFlowEnds: true,
        }),
      );
      expect(next).toBe('education');
    });
  });

  // ── lead_submit state ──
  describe('lead_submit state', () => {
    test('transitions to scheduling when user asks to book', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'lead_submit',
          userAsksToBook: true,
        }),
      );
      expect(next).toBe('scheduling');
    });

    test('transitions to handoff on risk trigger', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'lead_submit',
          riskOrEscalationTrigger: true,
        }),
      );
      expect(next).toBe('handoff');
    });

    test('transitions to confirmation by default', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'lead_submit',
        }),
      );
      expect(next).toBe('confirmation');
    });
  });

  // ── scheduling state ──
  describe('scheduling state', () => {
    test('transitions to confirmation when booking API confirms', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'scheduling',
          bookingApiConfirms: true,
        }),
      );
      expect(next).toBe('confirmation');
    });

    test('transitions to handoff on risk trigger', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'scheduling',
          riskOrEscalationTrigger: true,
        }),
      );
      expect(next).toBe('handoff');
    });

    test('stays in scheduling otherwise', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'scheduling',
        }),
      );
      expect(next).toBe('scheduling');
    });
  });

  // ── confirmation state ──
  describe('confirmation state', () => {
    test('transitions to handoff on risk trigger', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'confirmation',
          riskOrEscalationTrigger: true,
        }),
      );
      expect(next).toBe('handoff');
    });

    test('transitions to standby by default', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'confirmation',
        }),
      );
      expect(next).toBe('standby');
    });
  });

  // ── handoff state ──
  describe('handoff state', () => {
    test('always transitions to standby', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'handoff',
        }),
      );
      expect(next).toBe('standby');
    });
  });

  // ── standby state ──
  describe('standby state', () => {
    test('returns to education when user sends a new message (not declining)', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'standby',
          userMessage: 'Tell me about whole life',
          userDeclinesOrFlowEnds: false,
        }),
      );
      expect(next).toBe('education');
    });

    test('stays in standby when user declines', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'standby',
          userMessage: 'No thanks',
          userDeclinesOrFlowEnds: true,
        }),
      );
      expect(next).toBe('standby');
    });

    test('stays in standby when no message', () => {
      const next = getNextState(
        makeCtx({
          currentState: 'standby',
          userMessage: '',
        }),
      );
      expect(next).toBe('standby');
    });
  });
});

describe('State Machine — loop controls', () => {
  test('max field requests after refusal is 0', () => {
    expect(LOOP_CONTROLS.MAX_FIELD_REQUESTS_AFTER_REFUSAL).toBe(0);
  });

  test('suppress offers after decline is true', () => {
    expect(LOOP_CONTROLS.SUPPRESS_OFFERS_AFTER_DECLINE).toBe(true);
  });

  test('max clarification failures is 2', () => {
    expect(LOOP_CONTROLS.MAX_CLARIFICATION_FAILURES).toBe(2);
  });

  test('max retrieval failures per topic is 2', () => {
    expect(LOOP_CONTROLS.MAX_RETRIEVAL_FAILURES_PER_TOPIC).toBe(2);
  });

  test('max tool failures is 2', () => {
    expect(LOOP_CONTROLS.MAX_TOOL_FAILURES).toBe(2);
  });

  test('max qualification questions is 3', () => {
    expect(LOOP_CONTROLS.MAX_QUALIFICATION_QUESTIONS).toBe(3);
  });
});
