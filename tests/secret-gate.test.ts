/**
 * Pre-deploy posture gate: the deploy workflow must reject a missing or weak
 * ADMIN_API_KEY / RECORD_ENCRYPTION_KEY / LLM_API_KEY / TEXAS_LICENSE_NUMBER
 * before building anything.
 *
 * The runtime already refuses to start without the admin key, the record key
 * and a verified license number, but only after the build has shipped. These
 * tests pin the earlier decision: production requires all four, a secret that
 * is present must be strong (not a placeholder, not a repeated block, not
 * sequential, not low-entropy, not shared with another name), the license must
 * be a real number rather than the pending sentinel or a number-shaped
 * placeholder, and no report ever contains the values it is judging.
 */

import { LICENSE_PENDING_PLACEHOLDER, MIN_ADMIN_API_KEY_LENGTH } from '../src/config/app-config';
import { MIN_RECORD_ENCRYPTION_KEY_LENGTH } from '../src/privacy/record-encryption';
import {
  GATED_SECRET_NAMES,
  MIN_DISTINCT_CHARACTERS,
  MIN_ENTROPY_BITS_PER_CHAR,
  MIN_LLM_API_KEY_LENGTH,
  assessLicenseNumber,
  assessSecret,
  evaluateSecretPosture,
  formatGateReport,
} from '../src/config/secret-gate';
import { runSecretGateCli } from '../src/config/secret-gate-cli';

/** Deterministic stand-ins for `openssl rand -base64 48` output. */
const STRONG_ADMIN = 'Kx7Qm2Vt9Rb4Nc8Ws3Yd6Lf1Hg5Jp0Za';
const STRONG_ENCRYPTION = 'Zm4Tq9Wc2Xn7Kb5Vr8Ys3Ld6Jh1Gf0Pa';
/** Provider-shaped: prefix plus random body, longer than the floor. */
const STRONG_LLM = 'sk-proj-7Hq2Lm9Rt4Vb6Nc8Ws3Yd5Jf1Gk0Pa2Zx';
/** Seven digits: a real TDI-style number, not a run or a repeat. */
const STRONG_LICENSE = '2718345';

function strongValues() {
  return {
    adminApiKey: STRONG_ADMIN,
    recordEncryptionKey: STRONG_ENCRYPTION,
    llmApiKey: STRONG_LLM,
    texasLicenseNumber: STRONG_LICENSE,
  };
}

/** The same values as the CLI reads them, from the environment. */
function strongEnv(): NodeJS.ProcessEnv {
  return {
    ADMIN_API_KEY: STRONG_ADMIN,
    RECORD_ENCRYPTION_KEY: STRONG_ENCRYPTION,
    LLM_API_KEY: STRONG_LLM,
    TEXAS_LICENSE_NUMBER: STRONG_LICENSE,
  };
}

function assessAdmin(value: string | undefined, required = true) {
  return assessSecret('ADMIN_API_KEY', value, {
    required,
    minLength: MIN_ADMIN_API_KEY_LENGTH,
  });
}

function assessLicense(value: string | undefined, required = true) {
  return assessLicenseNumber('TEXAS_LICENSE_NUMBER', value, { required });
}

function find(report: ReturnType<typeof evaluateSecretPosture>, name: string) {
  return report.secrets.find((secret) => secret.name === name);
}

describe('assessSecret', () => {
  it('accepts a random secret at or above the floor', () => {
    expect(assessAdmin(STRONG_ADMIN).ok).toBe(true);
    expect(assessAdmin(STRONG_ADMIN).length).toBe(MIN_ADMIN_API_KEY_LENGTH);
    expect(assessAdmin('q7Pz2Mx9Vb4Nc8Ws3Yd6Lf1Hg5Jt0RaQ')).toMatchObject({ ok: true });
  });

  it('rejects a missing secret in production', () => {
    const result = assessAdmin(undefined);
    expect(result.ok).toBe(false);
    expect(result.present).toBe(false);
    expect(result.issues).toEqual([expect.objectContaining({ kind: 'missing' })]);
  });

  it('rejects a whitespace-only value as blank rather than present', () => {
    const result = assessAdmin('   \n\t ');
    expect(result.ok).toBe(false);
    expect(result.present).toBe(false);
    expect(result.issues[0].kind).toBe('blank');
  });

  it('rejects a secret below the length floor', () => {
    const result = assessAdmin(STRONG_ADMIN.slice(0, MIN_ADMIN_API_KEY_LENGTH - 1));
    expect(result.length).toBe(MIN_ADMIN_API_KEY_LENGTH - 1);
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('too-short');
  });

  it('rejects one repeated character however long it is', () => {
    const result = assessAdmin('a'.repeat(64));
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('repeated-pattern');
  });

  it('rejects a repeated block that meets the length floor', () => {
    // 32 chars: the floor is satisfied, the shape is not.
    expect('aB3xaB3xaB3xaB3xaB3xaB3xaB3xaB3x').toHaveLength(32);
    const result = assessAdmin('aB3xaB3xaB3xaB3xaB3xaB3xaB3xaB3x');
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('repeated-pattern');
  });

  it('rejects a sequential run', () => {
    const result = assessAdmin('abcdefghijklmnopqrstuvwxyz0123456789');
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('sequential');
  });

  it.each([
    'changeme-then-some-more-words-here',
    'your-admin-key-goes-right-here-0000',
    'this-is-a-placeholder-value-12345',
    'REPLACE_ME_WITH_A_REAL_RANDOM_SECRET',
  ])('rejects the placeholder %j', (value) => {
    const result = assessAdmin(value);
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('placeholder');
  });

  it('rejects a long but predictable value', () => {
    const result = assessAdmin('aaaaabbbbbcccccdddddeeeeefffffggggg');
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain('low-entropy');
  });

  it('rejects accidental surrounding whitespace', () => {
    const result = assessAdmin(` ${STRONG_ADMIN}\n`);
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('whitespace');
    // Length is measured on the trimmed value, so it is not also "too short".
    expect(result.length).toBe(MIN_ADMIN_API_KEY_LENGTH);
  });

  it('accepts a strong hex key, which has lower entropy than base64', () => {
    const hex = '9f2c7a4e1b8d3c6f5a0e9b2d7c4f1a8e';
    const result = assessSecret('RECORD_ENCRYPTION_KEY', hex, {
      required: true,
      minLength: MIN_RECORD_ENCRYPTION_KEY_LENGTH,
    });
    expect(result.entropyBitsPerChar).toBeGreaterThanOrEqual(MIN_ENTROPY_BITS_PER_CHAR);
    expect(result.distinctCharacters).toBeGreaterThanOrEqual(MIN_DISTINCT_CHARACTERS);
    expect(result.ok).toBe(true);
  });
});

describe('LLM_API_KEY rules', () => {
  it('accepts a provider-shaped random key', () => {
    const report = evaluateSecretPosture(strongValues());
    const llm = find(report, 'LLM_API_KEY');
    expect(llm?.ok).toBe(true);
    expect(llm?.kind).toBe('secret');
    expect(llm?.length).toBe(STRONG_LLM.length);
    expect(llm?.length).toBeGreaterThanOrEqual(MIN_LLM_API_KEY_LENGTH);
  });

  it('rejects the key templates a dashboard hands out', () => {
    for (const value of [
      'your-api-key-here-0000000000',
      'your_api_key_goes_here_now',
      'sk-placeholder-000000000000',
      'sk-test-0000000000000000',
      'sk-your-key-here-0000000000',
      'APIKEY-0000000000000000',
    ]) {
      const report = evaluateSecretPosture({ ...strongValues(), llmApiKey: value });
      const llm = find(report, 'LLM_API_KEY');
      expect(report.ok).toBe(false);
      expect(llm?.issues.map((issue) => issue.kind)).toContain('placeholder');
    }
  });

  it('rejects a key below the length floor', () => {
    const report = evaluateSecretPosture({ ...strongValues(), llmApiKey: 'sk-short-key' });
    const llm = find(report, 'LLM_API_KEY');
    expect(report.ok).toBe(false);
    expect(llm?.issues[0].kind).toBe('too-short');
  });

  it('is required in production but optional in pilot mode', () => {
    const production = evaluateSecretPosture({ ...strongValues(), llmApiKey: undefined });
    expect(production.ok).toBe(false);
    const missing = find(production, 'LLM_API_KEY')?.issues[0];
    expect(missing?.kind).toBe('missing');
    // The runtime does start without this key, so the gate must not claim it will not.
    expect(missing?.message).toContain('static fallback');
    expect(missing?.message).not.toContain('refuses to start');

    const pilot = evaluateSecretPosture(
      { ...strongValues(), llmApiKey: undefined },
      { mode: 'pilot' },
    );
    expect(pilot.ok).toBe(true);
  });
});

describe('TEXAS_LICENSE_NUMBER rules', () => {
  it('accepts a verified number, with or without separators', () => {
    expect(assessLicense(STRONG_LICENSE).ok).toBe(true);
    expect(assessLicense('27-18345').ok).toBe(true);
    expect(assessLicense('271 8345').ok).toBe(true);
    expect(assessLicense(STRONG_LICENSE).kind).toBe('identifier');
  });

  it.each([
    ['the pending sentinel', LICENSE_PENDING_PLACEHOLDER, 'placeholder'],
    ['the pending sentinel in lower case', '[pending compliance approval]', 'placeholder'],
    ['a TBD template', 'TBD', 'placeholder'],
    ['a labelled template', 'your-license-number', 'placeholder'],
    ['a word', 'PENDING', 'placeholder'],
    ['one repeated digit', '0000000', 'repeated-pattern'],
    ['an ascending run', '1234567', 'sequential'],
    ['a descending run', '7654321', 'sequential'],
    ['letters', 'ABC12345', 'invalid-format'],
    ['too few digits', '1234', 'too-short'],
    ['too many digits', '2718345678901', 'invalid-format'],
  ])('rejects %s', (_label, value, kind) => {
    const result = assessLicense(value);
    expect(result.ok).toBe(false);
    expect(result.issues.map((issue) => issue.kind)).toContain(kind);
  });

  it('requires the number in production but not in pilot mode', () => {
    expect(assessLicense(undefined).issues[0].kind).toBe('missing');
    expect(assessLicense('   ').issues[0].kind).toBe('blank');
    // Optional and absent is reported as not present, not as a failure.
    expect(assessLicense(undefined, false).ok).toBe(true);
    expect(assessLicense('   ', false)).toMatchObject({ ok: true, present: false });
  });

  it('rejects surrounding whitespace rather than silently trimming it', () => {
    const result = assessLicense(` ${STRONG_LICENSE} `);
    expect(result.ok).toBe(false);
    expect(result.issues[0].kind).toBe('whitespace');
    expect(result.length).toBe(STRONG_LICENSE.length);
  });

  it('still refuses a placeholder in pilot mode', () => {
    const report = evaluateSecretPosture(
      { ...strongValues(), texasLicenseNumber: 'TBD' },
      { mode: 'pilot' },
    );
    expect(report.ok).toBe(false);
    expect(find(report, 'TEXAS_LICENSE_NUMBER')?.issues[0].kind).toBe('placeholder');
  });
});

describe('evaluateSecretPosture', () => {
  it('requires all four values in production', () => {
    const report = evaluateSecretPosture({});
    expect(report.ok).toBe(false);
    expect(report.required).toEqual([...GATED_SECRET_NAMES]);
    expect(report.secrets.map((secret) => secret.name)).toEqual([...GATED_SECRET_NAMES]);
    expect(report.secrets.every((secret) => secret.issues[0].kind === 'missing')).toBe(true);
    expect(find(report, 'TEXAS_LICENSE_NUMBER')?.kind).toBe('identifier');
    expect(find(report, 'LLM_API_KEY')?.kind).toBe('secret');
  });

  it('passes when all four values are set and well-formed', () => {
    const report = evaluateSecretPosture(strongValues());
    expect(report.ok).toBe(true);
    expect(report.secrets.map((secret) => secret.ok)).toEqual([true, true, true, true]);
  });

  it('fails when the license number is missing even if every secret is strong', () => {
    const report = evaluateSecretPosture({ ...strongValues(), texasLicenseNumber: undefined });
    expect(report.ok).toBe(false);
    const missing = find(report, 'TEXAS_LICENSE_NUMBER')?.issues[0];
    expect(missing?.kind).toBe('missing');
    expect(missing?.message).toContain('verified license number');
    expect(find(report, 'ADMIN_API_KEY')?.ok).toBe(true);
  });

  it('fails when only one secret is set', () => {
    const report = evaluateSecretPosture({ adminApiKey: STRONG_ADMIN });
    expect(report.ok).toBe(false);
    const missing = find(report, 'RECORD_ENCRYPTION_KEY');
    expect(missing?.issues[0].kind).toBe('missing');
  });

  it('rejects using one value for two secrets', () => {
    const report = evaluateSecretPosture({
      ...strongValues(),
      recordEncryptionKey: STRONG_ADMIN,
    });
    expect(report.ok).toBe(false);
    const record = find(report, 'RECORD_ENCRYPTION_KEY');
    expect(record?.issues.map((issue) => issue.kind)).toContain('duplicate');
  });

  it('rejects an LLM key reused from another secret', () => {
    const report = evaluateSecretPosture({
      ...strongValues(),
      llmApiKey: STRONG_ENCRYPTION,
    });
    expect(report.ok).toBe(false);
    const llm = find(report, 'LLM_API_KEY');
    expect(llm?.issues.map((issue) => issue.kind)).toContain('duplicate');
    // The earlier name is not blamed for the reuse.
    expect(find(report, 'RECORD_ENCRYPTION_KEY')?.ok).toBe(true);
  });

  it('allows missing values in pilot mode but still validates what is set', () => {
    expect(evaluateSecretPosture({}, { mode: 'pilot' }).ok).toBe(true);
    expect(evaluateSecretPosture({}, { mode: 'pilot' }).required).toEqual([]);

    const weak = evaluateSecretPosture(
      { adminApiKey: 'changeme-changeme-changeme-changeme' },
      { mode: 'pilot' },
    );
    expect(weak.ok).toBe(false);
  });
});

describe('formatGateReport', () => {
  it('never prints a secret or license value', () => {
    const report = evaluateSecretPosture({
      adminApiKey: 'changeme-changeme-changeme-changeme',
      recordEncryptionKey: 'aaaaabbbbbcccccdddddeeeeefffffggggg',
      llmApiKey: 'sk-placeholder-000000000000',
      texasLicenseNumber: 'TBD',
    });
    const text = formatGateReport(report);

    expect(text).not.toContain('changeme-changeme');
    expect(text).not.toContain('aaaaabbbbb');
    expect(text).not.toContain('sk-placeholder');
    expect(text).not.toContain('TBD');
    // Only the measured shape is reported.
    expect(text).toContain('35 chars');
    expect(text).toContain('TEXAS_LICENSE_NUMBER');
    expect(text).toContain('FAILED');
    expect(text).toContain('Nothing was deployed.');
  });

  it('reports success without the values', () => {
    const report = evaluateSecretPosture(strongValues());
    const text = formatGateReport(report);

    expect(text).toContain('pre-deploy gate — production');
    expect(text).toContain('OK: 4 value(s)');
    expect(text).not.toContain(STRONG_ADMIN);
    expect(text).not.toContain(STRONG_ENCRYPTION);
    expect(text).not.toContain(STRONG_LLM);
    expect(text).not.toContain(STRONG_LICENSE);
  });

  it('reports the license as a public identifier, not as a secret shape', () => {
    const text = formatGateReport(evaluateSecretPosture(strongValues()));
    const line = text.split('\n').find((entry) => entry.startsWith('TEXAS_LICENSE_NUMBER'));
    expect(line).toContain('public identifier');
    expect(line).not.toContain('bits/char');
  });
});

describe('runSecretGateCli', () => {
  beforeEach(() => {
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('exits 1 when the production values are missing', () => {
    expect(runSecretGateCli([], {})).toBe(1);
  });

  it('exits 0 when all four production values are strong', () => {
    expect(runSecretGateCli([], strongEnv())).toBe(0);
  });

  it('exits 1 when a secret is weak', () => {
    expect(
      runSecretGateCli([], {
        ...strongEnv(),
        ADMIN_API_KEY: 'changeme-changeme-changeme-changeme',
      }),
    ).toBe(1);
  });

  it('exits 1 when the LLM key is a placeholder', () => {
    expect(
      runSecretGateCli([], {
        ...strongEnv(),
        LLM_API_KEY: 'your-api-key-here-0000000000',
      }),
    ).toBe(1);
  });

  it('exits 1 when the license number is still pending', () => {
    expect(
      runSecretGateCli([], {
        ...strongEnv(),
        TEXAS_LICENSE_NUMBER: LICENSE_PENDING_PLACEHOLDER,
      }),
    ).toBe(1);
  });

  it('exits 1 when the license number is missing', () => {
    const env = strongEnv();
    delete env.TEXAS_LICENSE_NUMBER;
    expect(runSecretGateCli([], env)).toBe(1);
  });

  it('exits 0 in pilot mode with no values configured', () => {
    expect(runSecretGateCli(['--mode', 'pilot'], {})).toBe(0);
  });

  it('exits 2 for bad usage', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(runSecretGateCli(['--mode', 'staging'], {})).toBe(2);
    expect(runSecretGateCli(['--nope'], {})).toBe(2);
    error.mockRestore();
  });

  it('prints usage and exits 0 for --help', () => {
    expect(runSecretGateCli(['--help'], {})).toBe(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Pre-deploy gate'));
  });

  it('emits a JSON report that still contains no values', () => {
    const output: string[] = [];
    (console.log as jest.Mock).mockImplementation((line: unknown) => {
      output.push(String(line));
    });

    const exit = runSecretGateCli(['--json'], { ...strongEnv(), TEXAS_LICENSE_NUMBER: 'TBD' });
    expect(exit).toBe(1);

    const report = JSON.parse(output.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.secrets.map((secret: { name: string }) => secret.name)).toEqual([
      ...GATED_SECRET_NAMES,
    ]);
    expect(output.join('\n')).not.toContain(STRONG_ADMIN);
    expect(output.join('\n')).not.toContain('TBD');
  });
});
