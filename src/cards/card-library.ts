/**
 * Visual Rich Cards — Pre-Approved Library (Section 4.3)
 *
 * All card content is pre-approved, versioned, and deterministic. The model can
 * ONLY reference a card by card_id; it can never generate or modify card
 * content. The application layer validates the id against this library and
 * attaches the full approved content.
 *
 * Compliance: every card is educational, carries a disclaimer (unless null for
 * purely informational renders), and is approved_by the licensed broker. Cards
 * are display-only — no data collection, no recommendation, no state-machine
 * change.
 */

export type CardType =
  | 'comparison_table'
  | 'bullet_list'
  | 'definition_card'
  | 'process_steps'
  | 'faq_accordion'
  | 'link_card'
  | 'warning_card'
  | 'stat_card';

/**
 * A single pre-approved card definition.
 * `content` is the full approved payload (typed below per card_type); the LLM
 * never supplies this — it only references card_id.
 */
export interface CardDefinition {
  card_id: string;
  card_type: CardType;
  title: string;
  content: Record<string, unknown>;
  disclaimer: string | null;
  version: string;
  last_reviewed: string;
  approved_by: string;
}

const DISCLAIMER_EDUCATIONAL = 'This is general educational information, not a recommendation.';
const DISCLAIMER_NOT_QUOTE =
  'This is general educational information, not a quote or recommendation.';
const DISCLAIMER_TEXAS_LEGAL =
  'This is general educational information, not legal advice. Consult the Texas Department of Insurance for specific requirements.';

/** The complete pre-approved card library. */
export const cardLibrary: CardDefinition[] = [
  // ════════════════ COMPARISON TABLES ════════════════
  {
    card_id: 'comparison_term_vs_whole',
    card_type: 'comparison_table',
    title: 'Term vs. Whole Life Insurance',
    content: {
      columns: ['Feature', 'Term Life', 'Whole Life'],
      rows: [
        { feature: 'Duration', values: ['10–30 years', 'Lifetime'] },
        { feature: 'Cash Value', values: ['No', 'Yes'] },
        { feature: 'Typical Cost', values: ['Lower', 'Higher'] },
        {
          feature: 'Best For',
          values: ['Temporary needs (mortgage, kids)', 'Permanent needs (estate, final expenses)'],
        },
      ],
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'comparison_term_vs_whole_vs_universal',
    card_type: 'comparison_table',
    title: 'Term vs. Whole vs. Universal Life Insurance',
    content: {
      columns: ['Feature', 'Term Life', 'Whole Life', 'Universal Life'],
      rows: [
        { feature: 'Duration', values: ['10–30 years', 'Lifetime', 'Lifetime'] },
        { feature: 'Cash Value', values: ['No', 'Yes', 'Yes'] },
        { feature: 'Premium Flexibility', values: ['Fixed', 'Fixed', 'Flexible'] },
        { feature: 'Typical Cost', values: ['Lower', 'Higher', 'Moderate'] },
        {
          feature: 'Best For',
          values: ['Temporary needs', 'Permanent needs', 'Flexible permanent needs'],
        },
      ],
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'comparison_medical_exam_vs_no_exam',
    card_type: 'comparison_table',
    title: 'Medical Exam vs. No-Exam Life Insurance',
    content: {
      columns: ['Feature', 'Medical Exam', 'No-Exam'],
      rows: [
        { feature: 'Typical Cost', values: ['Lower', 'Higher'] },
        { feature: 'Coverage Amount', values: ['Higher limits available', 'Lower limits typical'] },
        { feature: 'Approval Time', values: ['Weeks', 'Days'] },
        { feature: 'Health Questions', values: ['Detailed', 'Limited'] },
      ],
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },

  // ════════════════ BULLET LISTS ════════════════
  {
    card_id: 'bullet_underwriting_factors',
    card_type: 'bullet_list',
    title: 'Key Factors in Life Insurance Underwriting',
    content: {
      items: [
        'Age — Younger applicants typically pay lower premiums',
        'Health history — Pre-existing conditions may affect rates',
        'Lifestyle — Tobacco use, occupation, and hobbies are considered',
        'Coverage amount — Higher coverage generally means higher premiums',
        'Policy type — Term is typically less expensive than whole life',
      ],
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'bullet_common_riders',
    card_type: 'bullet_list',
    title: 'Common Life Insurance Riders',
    content: {
      items: [
        'Accelerated death benefit — Access a portion of your death benefit if diagnosed with a terminal illness',
        'Waiver of premium — Premiums are waived if you become disabled',
        'Child term rider — Provides coverage for your children',
        'Accidental death — Additional benefit if death is accidental',
        'Guaranteed insurability — Purchase additional coverage later without medical underwriting',
      ],
    },
    disclaimer:
      'This is general educational information, not a recommendation. Rider availability varies by carrier.',
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'bullet_texas_specific_rules',
    card_type: 'bullet_list',
    title: 'Texas-Specific Life Insurance Rules',
    content: {
      items: [
        'Free look period — Texas allows a 10-day free look period for most life insurance policies',
        'Grace period — Texas requires a 31-day grace period for premium payments',
        'Contestability period — Texas follows the standard 2-year contestability period',
        'Replacement rules — Texas has specific disclosure requirements when replacing a policy',
      ],
    },
    disclaimer: DISCLAIMER_TEXAS_LEGAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },

  // ════════════════ DEFINITION CARDS ════════════════
  {
    card_id: 'definition_rider',
    card_type: 'definition_card',
    title: 'Life Insurance Rider',
    content: {
      term: 'Life Insurance Rider',
      definition:
        'An add-on to your life insurance policy that provides extra benefits beyond the base coverage.',
      example:
        'For example, an accelerated death benefit rider allows you to access a portion of your death benefit early if you are diagnosed with a terminal illness.',
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'definition_beneficiary',
    card_type: 'definition_card',
    title: 'Life Insurance Beneficiary',
    content: {
      term: 'Beneficiary',
      definition:
        'The person or entity you designate to receive the death benefit from your life insurance policy.',
      example:
        'For example, you might name your spouse as the primary beneficiary and your children as contingent beneficiaries.',
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'definition_premium',
    card_type: 'definition_card',
    title: 'Life Insurance Premium',
    content: {
      term: 'Premium',
      definition:
        'The amount you pay to keep your life insurance policy active, typically paid monthly or annually.',
      example:
        'For example, a 20-year term policy with $500,000 in coverage might have a premium of $30 per month for a healthy 30-year-old.',
    },
    disclaimer: DISCLAIMER_NOT_QUOTE,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'definition_death_benefit',
    card_type: 'definition_card',
    title: 'Death Benefit',
    content: {
      term: 'Death Benefit',
      definition:
        'The amount of money paid to your beneficiaries when you pass away, as specified in your life insurance policy.',
      example:
        'For example, if you have a $500,000 term life policy, your beneficiaries would receive $500,000 upon your death (assuming the policy is active and no exclusions apply).',
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'definition_cash_value',
    card_type: 'definition_card',
    title: 'Cash Value',
    content: {
      term: 'Cash Value',
      definition:
        'A savings component in permanent life insurance policies (like whole life) that grows over time and can be borrowed against or withdrawn.',
      example:
        'For example, after 10 years, a whole life policy might have accumulated $15,000 in cash value that you could borrow against.',
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },

  // ════════════════ PROCESS STEPS ════════════════
  {
    card_id: 'process_underwriting',
    card_type: 'process_steps',
    title: 'How Life Insurance Underwriting Works',
    content: {
      steps: [
        {
          step_number: 1,
          title: 'Application',
          description:
            'You complete an application with basic information about your health, lifestyle, and coverage needs.',
        },
        {
          step_number: 2,
          title: 'Medical Review',
          description:
            'The carrier reviews your medical history and may request a medical exam or records.',
        },
        {
          step_number: 3,
          title: 'Underwriting Decision',
          description: 'The carrier evaluates your risk profile and determines your rate class.',
        },
        {
          step_number: 4,
          title: 'Policy Offer',
          description: 'You receive an offer with the final premium and coverage terms.',
        },
      ],
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'process_claims',
    card_type: 'process_steps',
    title: 'How a Life Insurance Claim Works',
    content: {
      steps: [
        {
          step_number: 1,
          title: 'Notification',
          description:
            "The beneficiary notifies the insurance carrier of the policyholder's death.",
        },
        {
          step_number: 2,
          title: 'Documentation',
          description:
            'The beneficiary submits a claim form and a certified copy of the death certificate.',
        },
        {
          step_number: 3,
          title: 'Review',
          description:
            'The carrier reviews the claim and verifies the policy is active and no exclusions apply.',
        },
        {
          step_number: 4,
          title: 'Payment',
          description:
            'The carrier pays the death benefit to the beneficiary, typically within 30–60 days.',
        },
      ],
    },
    disclaimer:
      'This is general educational information, not a recommendation. Claim processing times vary by carrier.',
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },

  // ════════════════ FAQ ACCORDIONS ════════════════
  {
    card_id: 'faq_beneficiaries',
    card_type: 'faq_accordion',
    title: 'Common Questions About Beneficiaries',
    content: {
      items: [
        {
          question: 'Who can be a beneficiary?',
          answer:
            'Almost anyone can be a beneficiary, including a spouse, child, friend, trust, or charity.',
        },
        {
          question: 'Can I have multiple beneficiaries?',
          answer:
            'Yes, you can name multiple beneficiaries and specify the percentage each receives.',
        },
        {
          question: 'What happens if my beneficiary dies before me?',
          answer:
            'If your primary beneficiary dies before you, the death benefit typically goes to your contingent beneficiary, if you named one.',
        },
      ],
    },
    disclaimer: DISCLAIMER_EDUCATIONAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'faq_texas_laws',
    card_type: 'faq_accordion',
    title: 'Common Questions About Texas Life Insurance Laws',
    content: {
      items: [
        {
          question: 'What is the free look period in Texas?',
          answer:
            'Texas allows a 10-day free look period for most life insurance policies. You can cancel within this period for a full refund.',
        },
        {
          question: 'What is the grace period in Texas?',
          answer:
            'Texas requires a 31-day grace period for premium payments. Your policy remains active during this period even if you miss a payment.',
        },
        {
          question: 'Can an insurance company deny my claim?',
          answer:
            'Yes, if the policyholder made material misrepresentations on the application or if the death occurred under excluded circumstances during the contestability period (typically 2 years).',
        },
      ],
    },
    disclaimer: DISCLAIMER_TEXAS_LEGAL,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },

  // ════════════════ LINK CARDS ════════════════
  {
    card_id: 'link_texas_laws',
    card_type: 'link_card',
    title: 'Related Article',
    content: {
      description: 'Learn more about Texas life insurance laws and regulations.',
      url: 'https://lifepolicypilot.blog/texas-life-insurance-laws/',
      link_text: 'Read the full article',
    },
    disclaimer: null,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'link_dime_method',
    card_type: 'link_card',
    title: 'Related Article',
    content: {
      description:
        'Learn how to estimate your life insurance coverage needs using the DIME method.',
      url: 'https://lifepolicypilot.blog/how-much-life-insurance-do-i-need/',
      link_text: 'Read the full article',
    },
    disclaimer: null,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },

  // ════════════════ WARNING CARDS ════════════════
  {
    card_id: 'warning_not_recommendation',
    card_type: 'warning_card',
    title: 'Important Note',
    content: {
      severity: 'important',
      message:
        'This is general educational information, not a personalized recommendation. A licensed broker can help you determine the right coverage for your specific situation.',
    },
    disclaimer: null,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'warning_not_quote',
    card_type: 'warning_card',
    title: 'Important Note',
    content: {
      severity: 'caution',
      message:
        'The figures shown are general educational ranges, not quotes. Actual premiums vary based on age, health, lifestyle, carrier, and other factors.',
    },
    disclaimer: null,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },

  // ════════════════ STAT CARDS ════════════════
  {
    card_id: 'stat_term_cost_range',
    card_type: 'stat_card',
    title: 'Typical Term Life Cost Range',
    content: {
      statistic: '$25–$40/month',
      description:
        'Typical range for a 20-year, $500,000 term life policy for a healthy 30-year-old in Texas.',
      source: 'General industry data. Actual rates vary by carrier and individual factors.',
    },
    disclaimer: DISCLAIMER_NOT_QUOTE,
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
  {
    card_id: 'stat_free_look_period',
    card_type: 'stat_card',
    title: 'Texas Free Look Period',
    content: {
      statistic: '10 days',
      description:
        'Texas allows a 10-day free look period for most life insurance policies. You can cancel within this period for a full refund.',
      source: 'Texas Insurance Code, Chapter 1101',
    },
    disclaimer: 'This is general educational information, not legal advice.',
    version: '1.0',
    last_reviewed: '2025-01-15',
    approved_by: 'Richard Parslow',
  },
];

/** The allowed card types (allowlist). */
export const ALLOWED_CARD_TYPES: CardType[] = [
  'comparison_table',
  'bullet_list',
  'definition_card',
  'process_steps',
  'faq_accordion',
  'link_card',
  'warning_card',
  'stat_card',
];

/**
 * Looks up a card in the pre-approved library by id.
 * Returns the definition or null when unknown.
 */
export function getCardById(cardId: string): CardDefinition | null {
  return cardLibrary.find((c) => c.card_id === cardId) ?? null;
}
