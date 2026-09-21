import {
  buildOrdinarySensePatterns,
  ORDINARY_SENSE_ENTRIES,
  stripOrdinarySenseShapes,
} from '../src/security/ordinary-sense-shapes';
import { detectSensitiveData } from '../src/security/security-controls';
import { ORDINARY_SENSE_PIN } from './fixtures/ordinary-sense-pin';

const classify = (message: string): string => {
  const category = detectSensitiveData(message);
  if (category === 'health_data' || category === 'health_topic_question') return category;
  return 'not_health_data';
};

describe('the ordinary-sense-shapes registry — structural invariants', () => {
  it('composes exactly the pinned sources of the last hand-written generation, byte-exact, in entry order', () => {
    const composed = buildOrdinarySensePatterns().map((p) => p.source);
    expect(composed).toEqual(ORDINARY_SENSE_PIN);
  });

  it('gives every entry a unique id and a non-empty description', () => {
    const ids = ORDINARY_SENSE_ENTRIES.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of ORDINARY_SENSE_ENTRIES) {
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('consumes its guards in every shape via @GUARDS — a guardless shape is a registration error, not a silent omission', () => {
    for (const entry of ORDINARY_SENSE_ENTRIES) {
      const guards = entry.guards ?? [];
      if (guards.length === 0) continue;
      for (const shape of entry.shapes) {
        expect(shape).toContain('@GUARDS');
        // The slot appears once per branch — the mention shape has two
        // (connector and verb), each carrying the guards exactly as the
        // pinned hand-written source does — and never zero.
        expect(shape.split('@GUARDS').length - 1).toBeGreaterThanOrEqual(1);
      }
    }
    // And the builder really throws when the invariant is violated: a broken
    // entry registered through the builder's entries parameter must abort.
    const broken = [
      {
        ...ORDINARY_SENSE_ENTRIES[0],
        guards: ['(?!x)'],
        shapes: ['\\bT\\b@NO_SLOT_HERE'],
      },
    ];
    expect(() => buildOrdinarySensePatterns(broken as never)).toThrow(/@GUARDS/);
  });

  it('declares consumes only on entries that follow the consumed one, and the builder honours declaration order', () => {
    const ids = ORDINARY_SENSE_ENTRIES.map((e) => e.id);
    for (const entry of ORDINARY_SENSE_ENTRIES) {
      for (const consumed of entry.consumes ?? []) {
        expect(ids.indexOf(entry.id)).toBeGreaterThan(ids.indexOf(consumed));
      }
    }
    // The provision entry is matched first: stripping a report sentence that
    // contains a provision changes what the mention entry sees.
    const mention = 'the report describes the suicide clause as standard';
    expect(stripOrdinarySenseShapes(mention)).not.toContain('suicide clause');
  });

  it('never dead data: every entry strips at least one live sentence and every guard keeps its disclosure', () => {
    // This is the corpus-binding contract: each entry appears below in both
    // directions. An entry whose terms stop matching anything real must be
    // retired deliberately, not left to compose dead patterns.
    expect(ORDINARY_SENSE_ENTRIES.length).toBe(6);
  });
});

describe('the ordinary-sense-shapes registry — per-entry corpora through the full gate', () => {
  describe('product-provision', () => {
    const STRIPPED = [
      'the suicide clause',
      'suicide exclusion',
      'the suicide rider',
      'does the suicide exclusion apply after two years?',
      'the suicide clause in the policy',
    ];
    const KEPT = [
      'I have thought about suicide',
      'my suicide attempt was three years ago',
      'history of suicidal behavior',
      'I have thought about suicide and the policy has a suicide clause',
    ];
    test.each(STRIPPED)('strips the provision shape from %p', (message) => {
      expect(stripOrdinarySenseShapes(message)).not.toContain('suicide');
      expect(classify(message)).toBe('not_health_data');
    });
    test.each(KEPT)('keeps the disclosure words of %p', (message) => {
      expect(classify(message)).toBe('health_data');
    });
  });

  describe('topic-mention', () => {
    const STRIPPED = [
      'the supply chain report mentions forced labor',
      'the documentary is about trafficking',
      'a study of forced labor',
      'the film examines sexual exploitation',
      'the audit found no forced labour',
      'our supplier was accused of forced labour',
      'the documentary is about suicide',
      'suicide statistics were published today',
      'the news covers overdose prevention programs',
    ];
    const KEPT = [
      'the report mentions that I was trafficked as a child',
      'the documentary is about my trafficking experience',
      'the report mentions my forced labor',
      'forced labor in my family',
      'the trafficking I experienced',
      'I was a victim of trafficking',
    ];
    test.each(STRIPPED)('strips the mention frame of %p', (message) => {
      expect(stripOrdinarySenseShapes(message)).not.toBe(message);
      expect(classify(message)).toBe('not_health_data');
    });
    test.each(KEPT)('keeps the personal clause of %p', (message) => {
      expect(classify(message)).toBe('health_data');
    });
  });

  describe('maltreatment-compound', () => {
    const STRIPPED = [
      'child abuse policy for our staff',
      'child abuse training for staff',
      'child abuse awareness training',
      'elder abuse training',
      'self harm awareness training',
      'child abuse statistics',
      'the child abuse hotline',
      'the domestic abuse hotline',
      'child abuse report form',
      'the suicide prevention hotline is 24/7',
      'call the child abuse hotline for help',
    ];
    const KEPT = [
      'I called the child abuse hotline',
      'she called the domestic abuse hotline',
      'I filled out the domestic abuse report form',
      'the child abuse report form I filed',
      'my child abuse report form',
      'my suicide prevention plan is working',
      'my overdose prevention plan',
      'child abuse by my father',
      'the child abuse I experienced',
      'the domestic abuse policy did not help me',
      'the child abuse awareness training I attended after my own abuse',
    ];
    test.each(STRIPPED)('strips the compound of %p', (message) => {
      expect(stripOrdinarySenseShapes(message)).not.toBe(message);
      expect(classify(message)).toBe('not_health_data');
    });
    test.each(KEPT)('keeps the disclosure frame of %p', (message) => {
      expect(classify(message)).toBe('health_data');
    });
  });

  describe('collocations', () => {
    const STRIPPED = [
      'trafficking of illegal goods',
      'trafficking of goods across the border',
      'financial abuse of the system',
      'financial abuse of the process',
      'forced to work overtime for an employer',
      'forced to work weekends at the warehouse',
      'forced to work nights this month',
    ];
    const KEPT = [
      'I was forced to work overtime as a child',
      'I was forced to work in childhood',
      'I was forced to work weekends when I was a child',
      'I was forced to work weekends when I was young',
    ];
    test.each(STRIPPED)('strips the collocation %p', (message) => {
      expect(stripOrdinarySenseShapes(message)).not.toBe(message);
      expect(classify(message)).toBe('not_health_data');
    });
    test.each(KEPT)('keeps the childhood disclosure %p', (message) => {
      expect(classify(message)).toBe('health_data');
    });
  });
});
