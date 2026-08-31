/**
 * Card Validation Module (Visual Rich Cards, Section 4.2)
 *
 * The model NEVER supplies card content. It may only reference a pre-approved
 * card by its card_id; the application layer validates the id and replaces the
 * reference with the full, approved content from the library. This is the
 * critical security control: fabricated or modified card content is impossible.
 *
 * Additional guards:
 * - unknown card_id / card_type mismatch → rejected
 * - prompt-injection patterns in card_id → rejected
 * - cards are disallowed in qualification / consent / scheduling flows
 *   (VRC-008, VRC-009)
 * - at most one card per response
 * - always paired with a standalone text response
 */

import {
  cardLibrary,
  getCardById,
  ALLOWED_CARD_TYPES,
  type CardDefinition,
  type CardType,
} from './card-library';

/**
 * The model's reference to a card in its JSON output. Only `card_id` is
 * honored; any other fields the model invents for the card are ignored.
 */
export interface CardReference {
  card_id: string;
}

/** The resolved, validated card payload returned to the widget. */
export interface VisualCard {
  card_id: string;
  card_type: CardType;
  title: string;
  content: Record<string, unknown>;
  disclaimer: string | null;
}

export interface CardValidationResult {
  isValid: boolean;
  card: VisualCard | null;
  error: string | null;
}

/** States in which visual cards are not allowed (VRC-008, VRC-009). */
const CARD_DISALLOWED_STATES = new Set([
  'qualification',
  'qualification_offer',
  'consent',
  'scheduling',
  'confirmation',
  'lead_submit',
]);

/** Prompt-injection patterns applied to card_id (VRC-014). */
const CARD_ID_INJECTION_PATTERNS = [
  /(?:ignore|disregard|forget)\s+(?:previous|all|above|system)?\s*instructions?/i,
  /(?:reveal|show|print|output|disclose)\s+(?:your|the|system)\s+(?:prompt|instructions?|rules?|secrets?)/i,
  /(?:override|disable|bypass|system\s*:)/i,
  /<[^>]*script/i,
];

function cardIdHasInjection(cardId: string): boolean {
  return CARD_ID_INJECTION_PATTERNS.some((p) => p.test(cardId));
}

function toVisualCard(def: CardDefinition): VisualCard {
  return {
    card_id: def.card_id,
    card_type: def.card_type,
    title: def.title,
    content: def.content,
    disclaimer: def.disclaimer,
  };
}

/**
 * Validates a model-emitted visual_card reference against the library and the
 * flow rules, returning the resolved approved card (or null + an error).
 *
 * @param card      - the reference from the model (unknown; only card_id read)
 * @param state     - the conversation state (cards disallowed in flow states)
 * @param maxCards  - normally 1 (the spec allows at most one card per response)
 */
export function validateCard(
  card: unknown,
  state?: string,
  maxCards: number = 1,
): CardValidationResult {
  if (card === undefined || card === null) {
    return { isValid: true, card: null, error: null };
  }
  if (maxCards < 1) {
    return { isValid: false, card: null, error: 'At most one card per response is allowed' };
  }
  if (typeof card !== 'object') {
    return { isValid: false, card: null, error: 'visual_card must be an object' };
  }

  const ref = card as Record<string, unknown>;

  if (typeof ref.card_id !== 'string' || ref.card_id.length === 0) {
    return { isValid: false, card: null, error: 'card_id must be a non-empty string' };
  }

  const cardId = ref.card_id;

  // Prompt injection in card_id (VRC-014)
  if (cardIdHasInjection(cardId)) {
    return { isValid: false, card: null, error: 'card_id contains a prompt-injection attempt' };
  }

  // Card must exist in the pre-approved library (VRC-002)
  const libraryCard = getCardById(cardId);
  if (!libraryCard) {
    return { isValid: false, card: null, error: `card_id not found in library: ${cardId}` };
  }

  // Card_type must match the library (VRC-003). The model may include a
  // card_type; if present it must match the library's type.
  if (ref.card_type !== undefined && ref.card_type !== libraryCard.card_type) {
    return { isValid: false, card: null, error: 'card_type mismatch with library' };
  }

  // Cards disallowed in flow states (VRC-008, VRC-009)
  if (state && CARD_DISALLOWED_STATES.has(state)) {
    return { isValid: false, card: null, error: `cards are not allowed in state ${state}` };
  }

  return { isValid: true, card: toVisualCard(libraryCard), error: null };
}

/** The allowlist of card types (consumed by the schema rule). */
export const VALID_CARD_TYPES: CardType[] = ALLOWED_CARD_TYPES;

/** Count of cards in the pre-approved library. */
export const CARD_LIBRARY_COUNT = cardLibrary.length;
