/**
 * At-rest encryption for record logs (DSR records and consent/lead records).
 *
 * TDPSA consumer records (DSR intake) and lead/consent artifacts are legal
 * records that may contain PII (contact email, phone, free-text detail).
 * This module encrypts each JSONL line with AES-256-GCM before it is written
 * to disk, and decrypts on load, so the plaintext is never at rest.
 *
 * Key ring (SEC-15). The envelope carries a key id (`kid`) derived from the
 * secret itself, so a key can be identified without a separate configuration
 * value. `RECORD_ENCRYPTION_KEY` writes new lines; `RECORD_ENCRYPTION_KEYS`
 * lists previous secrets used only for decryption during a rotation. Rotating
 * therefore does not make existing records unreadable: put the old secret in
 * the legacy list, deploy the new primary key, then run `npm run records:rekey`
 * to rewrite every log under the new kid before retiring the old secret.
 *
 * Envelope versions:
 *   v2  { v: 2, alg, kid, iv, tag, data }  — current writes; `kid` selects key.
 *   v1  { v: 1, alg, iv, tag, data }       — pre-rotation lines; every key in
 *                                            the ring is tried, the auth tag
 *                                            decides which one wrote it.
 *
 * Plaintext wins only outside production (`PILOT_MODE`) and only for a payload
 * that carries no health data: a consented medical profile is written with
 * `requireEncryption`, so it fails closed instead of falling back to clear text
 * in a pilot deployment (SEC-18).
 * In production a line that is not an authenticated envelope is refused —
 * skipped by loaders, never returned as if it were a verified record — so a
 * filesystem writer cannot inject an unauthenticated record. The migration CLI
 * encrypts existing plaintext logs.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config/app-config';

/**
 * Minimum secret length. A short passphrase is a brute-force target even with
 * a random salt; 32 characters is the floor the deployment contract enforces.
 */
export const MIN_RECORD_ENCRYPTION_KEY_LENGTH = 32;

/** Envelope version that carries a key id. */
export const RECORD_ENVELOPE_VERSION = 2;

/** One decryptable key: its derived id and the secret itself. */
export interface RecordKey {
  kid: string;
  secret: string;
}

/**
 * Stable, non-secret identifier for a record-encryption secret.
 *
 * Derived from the secret, never configured: two deployments holding the same
 * key agree on the id, and a rotated key automatically gets a new one.
 */
export function recordKeyId(secret: string): string {
  return createHash('sha256').update(secret).digest('hex').slice(0, 16);
}

/** True when RECORD_ENCRYPTION_KEY is configured (non-empty). */
export function isRecordEncryptionConfigured(): boolean {
  return config.recordEncryptionKey.trim().length > 0;
}

/**
 * True when the configured key meets the minimum entropy requirement (SEC-10).
 * A configured-but-weak key is a hard error at the encryption boundary: writes
 * fail closed and encrypted lines stay unreadable, rather than silently
 * deriving a weak AES key.
 */
export function isRecordEncryptionKeyStrong(): boolean {
  return config.recordEncryptionKey.trim().length >= MIN_RECORD_ENCRYPTION_KEY_LENGTH;
}

/** True when legacy unencrypted records may still be read (pilot mode only). */
export function isLegacyPlaintextRecordAllowed(): boolean {
  return config.pilotMode;
}

/**
 * The ring used for decryption: the primary key first, then every legacy key
 * that is long enough to have produced a valid envelope. Short secrets are
 * skipped because `encryptRecordLine` refuses them, so they cannot have
 * written any line in the log.
 */
export function recordKeyRing(): RecordKey[] {
  const ring: RecordKey[] = [];
  const seen = new Set<string>();

  const add = (secret: string): void => {
    const trimmed = secret.trim();
    if (trimmed.length < MIN_RECORD_ENCRYPTION_KEY_LENGTH) return;
    const kid = recordKeyId(trimmed);
    if (seen.has(kid)) return;
    seen.add(kid);
    ring.push({ kid, secret: trimmed });
  };

  add(config.recordEncryptionKey);
  for (const legacy of config.recordEncryptionLegacyKeys) add(legacy);
  return ring;
}

/** True when a configured key rings has no match for this kid yet. */
export function hasRecordKey(kid: string): boolean {
  return recordKeyRing().some((key) => key.kid === kid);
}

/**
 * True when the line is an encrypted envelope (v1 or v2) without attempting to
 * decrypt it. Used by the record loaders to distinguish "encrypted but
 * unreadable without a key" from malformed/corrupt lines.
 */
export function isEncryptedRecordLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { v?: number; alg?: string } | null;
    return (
      parsed !== null &&
      (parsed.v === 1 || parsed.v === RECORD_ENVELOPE_VERSION) &&
      parsed.alg === 'aes-256-gcm'
    );
  } catch {
    return false;
  }
}

/**
 * True when the line is a well-formed JSON object that is not an envelope —
 * i.e. a legacy plaintext record. Invalid JSON is not a plaintext record.
 */
export function isLegacyPlaintextRecordLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    return !isEncryptedRecordLine(line);
  } catch {
    return false;
  }
}

/** Deterministic 32-byte AES-256 key derived from the configured secret. */
function deriveKey(secret: string): Buffer {
  return createHash('sha256').update(secret).digest();
}

/**
 * Options for {@link encryptRecordLine}.
 */
export interface EncryptRecordOptions {
  /**
   * Refuse plaintext in every mode, pilot included (SEC-18).
   *
   * Set for a payload carrying TDPSA sensitive health data: a consented
   * medical profile is never written in clear, whether or not PILOT_MODE is
   * set. Without this the pilot-mode convenience fallback would put a
   * visitor's conditions, date of birth and medications on disk as text.
   */
  requireEncryption?: boolean;
}

/** The primary key entry, or a hard error when it is absent or too weak. */
function primaryKey(requireEncryption = false): RecordKey {
  const secret = config.recordEncryptionKey.trim();
  if (secret.length === 0) {
    const reason = requireEncryption
      ? ' because it contains medical information, which must be encrypted at rest in every mode'
      : config.pilotMode
        ? ''
        : ' in production';
    throw new Error(
      `RECORD_ENCRYPTION_KEY is required. Refusing to write a record in plaintext${reason}; ` +
        `set a secret of at least ${MIN_RECORD_ENCRYPTION_KEY_LENGTH} characters.`,
    );
  }
  if (secret.length < MIN_RECORD_ENCRYPTION_KEY_LENGTH) {
    throw new Error(
      `RECORD_ENCRYPTION_KEY must be at least ${MIN_RECORD_ENCRYPTION_KEY_LENGTH} characters. ` +
        'Refusing to derive a weak AES-256 key; record writes fail closed until this is fixed.',
    );
  }
  return { kid: recordKeyId(secret), secret };
}

/**
 * Serializes a plaintext record line, encrypting it with the primary key.
 *
 * Outside pilot mode a missing key is an error rather than a plaintext
 * fallback: production must never write an unauthenticated record. The same
 * applies in *every* mode when `requireEncryption` is set, which is how a
 * medical payload is kept out of the pilot-mode plaintext fallback (SEC-18).
 *
 * @param payload - Plaintext JSON we want to persist.
 * @param options - `requireEncryption` refuses the pilot-mode plaintext fallback.
 * @returns The text to append to the JSONL log.
 * @throws when a key is required and none (or a weak one) is configured.
 */
export function encryptRecordLine(payload: string, options: EncryptRecordOptions = {}): string {
  const requireEncryption = options.requireEncryption === true;
  if (!isRecordEncryptionConfigured() && (requireEncryption || !config.pilotMode)) {
    primaryKey(requireEncryption); // throws the refusal with its explanation
  }
  if (!isRecordEncryptionConfigured()) {
    return payload; // plaintext fallback (pilot only; the gates above refuse the rest)
  }

  const { kid, secret } = primaryKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(secret), iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: RECORD_ENVELOPE_VERSION,
    alg: 'aes-256-gcm',
    kid,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

/** Decrypts one envelope with one key; null when the auth tag does not match. */
function decryptWith(
  key: RecordKey,
  envelope: {
    iv: string;
    tag: string;
    data: string;
  },
): string | null {
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      deriveKey(key.secret),
      Buffer.from(envelope.iv, 'base64'),
    );
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Reads one line from a JSONL record log back to its plaintext. Handles current
 * envelopes (by kid), pre-rotation envelopes (by trying the ring), and — only
 * outside production — legacy plaintext lines. Returns null on any failure
 * (malformed line, missing key, tampered auth tag, refused plaintext) so
 * corrupt or unauthenticated records are skipped, never partially read.
 *
 * @param line - A single JSONL line (an encrypted envelope or plaintext).
 * @returns The plaintext, or null if the line cannot be decoded.
 */
export function decryptRecordLine(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const envelope = parsed as {
    v?: unknown;
    alg?: unknown;
    kid?: unknown;
    iv?: unknown;
    tag?: unknown;
    data?: unknown;
  };

  const isEnvelope =
    (envelope.v === 1 || envelope.v === RECORD_ENVELOPE_VERSION) && envelope.alg === 'aes-256-gcm';

  if (isEnvelope) {
    if (!isRecordEncryptionConfigured()) return null; // encrypted, no key available
    if (
      typeof envelope.iv !== 'string' ||
      typeof envelope.tag !== 'string' ||
      typeof envelope.data !== 'string'
    ) {
      return null;
    }
    const fields = { iv: envelope.iv, tag: envelope.tag, data: envelope.data };

    // A v2 envelope names its key; try only that key. A v1 envelope predates
    // `kid`, so the auth tag decides which key in the ring wrote it.
    const candidates =
      typeof envelope.kid === 'string'
        ? recordKeyRing().filter((key) => key.kid === envelope.kid)
        : recordKeyRing();

    for (const key of candidates) {
      const plain = decryptWith(key, fields);
      if (plain !== null) return plain;
    }
    return null;
  }

  // A JSON object that is not an envelope is a legacy plaintext record.
  // Accepting one in production would let any filesystem writer inject an
  // unauthenticated "record"; the migration CLI encrypts existing logs.
  return isLegacyPlaintextRecordAllowed() ? line : null;
}
