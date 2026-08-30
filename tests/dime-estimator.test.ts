/**
 * Tests for the DIME Coverage Needs Estimator (src/estimator/dime-estimator.ts)
 *
 * Verifies the deterministic illustrative range table, input completeness,
 * step derivation, merge semantics, and the educational framing of the
 * result message and LLM application context.
 */

import {
  buildDimeProgressContext,
  buildDimeResultMessage,
  computeDimeEstimate,
  countDimeInputs,
  dimeInputsComplete,
  DIME_QUESTIONS,
  EMPTY_DIME_INPUTS,
  mergeDimeInputs,
  nextDimeStep,
  type DimeInputs,
} from '../src/estimator/dime-estimator';

describe('computeDimeEstimate — illustrative range table', () => {
  test('flagship case (debt, 10 years, education) → $600,000 – $1,000,000', () => {
    const estimate = computeDimeEstimate({
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: true,
    });
    expect(estimate.min).toBe(600_000);
    expect(estimate.max).toBe(1_000_000);
    expect(estimate.rangeLabel).toBe('$600,000 – $1,000,000');
  });

  test('minimal case (no debt, 0 years, no education) → $150,000 – $250,000', () => {
    const estimate = computeDimeEstimate({
      has_mortgage_or_debt: false,
      income_replacement_years: 0,
      future_expenses: false,
    });
    expect(estimate.rangeLabel).toBe('$150,000 – $250,000');
  });

  test('maximal case (debt, 40 years, education) → $900,000 – $1,500,000', () => {
    const estimate = computeDimeEstimate({
      has_mortgage_or_debt: true,
      income_replacement_years: 40,
      future_expenses: true,
    });
    expect(estimate.rangeLabel).toBe('$900,000 – $1,500,000');
  });

  test('income-years group boundary: 5 years vs 6 years', () => {
    const five = computeDimeEstimate({
      has_mortgage_or_debt: false,
      income_replacement_years: 5,
      future_expenses: false,
    });
    const six = computeDimeEstimate({
      has_mortgage_or_debt: false,
      income_replacement_years: 6,
      future_expenses: false,
    });
    // 5 years → 200k base; 6 years → 400k base
    expect(five.min).toBeLessThan(six.min);
    expect(five.max).toBeLessThan(six.max);
  });

  test('debt and education each widen the range upward', () => {
    const plain = computeDimeEstimate({
      has_mortgage_or_debt: false,
      income_replacement_years: 10,
      future_expenses: false,
    });
    const withDebt = computeDimeEstimate({
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: false,
    });
    const withBoth = computeDimeEstimate({
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: true,
    });
    expect(withDebt.max).toBeGreaterThan(plain.max);
    expect(withBoth.max).toBeGreaterThan(withDebt.max);
  });

  test('throws when inputs are incomplete', () => {
    expect(() =>
      computeDimeEstimate({
        has_mortgage_or_debt: true,
        income_replacement_years: null,
        future_expenses: null,
      }),
    ).toThrow('requires all three DIME inputs');
  });
});

describe('dimeInputsComplete / countDimeInputs / nextDimeStep', () => {
  test('empty inputs are incomplete', () => {
    expect(dimeInputsComplete(EMPTY_DIME_INPUTS)).toBe(false);
    expect(countDimeInputs(EMPTY_DIME_INPUTS)).toBe(0);
  });

  test('complete only when all three are collected', () => {
    const one: DimeInputs = {
      has_mortgage_or_debt: true,
      income_replacement_years: null,
      future_expenses: null,
    };
    const two: DimeInputs = {
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: null,
    };
    const three: DimeInputs = {
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: true,
    };
    expect(dimeInputsComplete(one)).toBe(false);
    expect(dimeInputsComplete(two)).toBe(false);
    expect(dimeInputsComplete(three)).toBe(true);
  });

  test('step advances 1 → 2 → 3 → null as inputs are collected', () => {
    expect(nextDimeStep(EMPTY_DIME_INPUTS)).toBe(1);
    expect(
      nextDimeStep({
        has_mortgage_or_debt: true,
        income_replacement_years: null,
        future_expenses: null,
      }),
    ).toBe(2);
    expect(
      nextDimeStep({
        has_mortgage_or_debt: true,
        income_replacement_years: 10,
        future_expenses: null,
      }),
    ).toBe(3);
    expect(
      nextDimeStep({
        has_mortgage_or_debt: true,
        income_replacement_years: 10,
        future_expenses: true,
      }),
    ).toBeNull();
  });
});

describe('mergeDimeInputs', () => {
  test('incoming non-null values overwrite session values', () => {
    const session: DimeInputs = {
      has_mortgage_or_debt: true,
      income_replacement_years: null,
      future_expenses: null,
    };
    const incoming: DimeInputs = {
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: null,
    };
    const merged = mergeDimeInputs(session, incoming);
    expect(merged).toEqual({
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: null,
    });
  });

  test('incoming nulls never wipe earlier session answers', () => {
    const session: DimeInputs = {
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: null,
    };
    const incoming: DimeInputs = {
      has_mortgage_or_debt: null,
      income_replacement_years: null,
      future_expenses: true,
    };
    const merged = mergeDimeInputs(session, incoming);
    expect(merged).toEqual({
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: true,
    });
  });

  test('empty incoming returns the session unchanged', () => {
    const session: DimeInputs = {
      has_mortgage_or_debt: true,
      income_replacement_years: 10,
      future_expenses: null,
    };
    expect(mergeDimeInputs(session, EMPTY_DIME_INPUTS)).toEqual(session);
  });
});

describe('buildDimeResultMessage — educational framing', () => {
  const estimate = computeDimeEstimate({
    has_mortgage_or_debt: true,
    income_replacement_years: 10,
    future_expenses: true,
  });

  test('contains the range, the disclaimer, and the licensed-broker bridge', () => {
    const message = buildDimeResultMessage(estimate);
    expect(message).toContain('$600,000 – $1,000,000');
    expect(message).toContain('not a recommendation, quote, or personalized assessment');
    expect(message).toContain('Richard Parslow');
  });

  test('never says "recommendation" as an action the assistant takes', () => {
    const message = buildDimeResultMessage(estimate);
    expect(message.toLowerCase()).not.toContain('i recommend');
    expect(message.toLowerCase()).not.toContain('you should buy');
  });
});

describe('buildDimeProgressContext — application context for the LLM', () => {
  test('reports collected inputs and the next step', () => {
    const context = buildDimeProgressContext({
      has_mortgage_or_debt: true,
      income_replacement_years: null,
      future_expenses: null,
    });
    expect(context).toContain('mortgage or large debts answered: yes');
    expect(context).toContain('income replacement years answered: not yet');
    expect(context).toContain('Next question to ask: step 2');
  });

  test('forbids re-asking and dollar figures', () => {
    const context = buildDimeProgressContext(EMPTY_DIME_INPUTS);
    expect(context).toContain('Never re-ask an answered question');
    expect(context).toContain('Never state a dollar figure');
  });
});

describe('DIME_QUESTIONS — approved scripting', () => {
  test('exactly three questions, one per step', () => {
    expect(DIME_QUESTIONS.length).toBe(3);
    expect(DIME_QUESTIONS[0]).toContain('mortgage or other large debts');
    expect(DIME_QUESTIONS[1]).toContain('years of income');
    expect(DIME_QUESTIONS[2]).toContain('future expenses');
  });
});
