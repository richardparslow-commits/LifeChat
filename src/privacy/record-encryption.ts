/**
 * At-rest encryption for record logs (DSR records and consent/lead records).
 *
 * TDPSA consumer records (DSR intake) and lead/consent artifacts are legal
 * records that may contain PII (contact email, phone, free-text detail).
 * This module encrypts each JSONL line with AES-256-GCM before it is written
 * to disk, and decrypts on load, so the plaintext is never at rest.
 *
 * Key: supplied via RECORD_ENCRYPTION_KEY. When a key is configured, every
 * line is a JSON envelope `{ v, alg, iv, tag, data }` carrying base64 IV,
 * auth tag, and ciphertext. On load we decrypt only when a key is present
 * (a configured key that changes invalidates the auth tag and the line is
 * skipped, never silently misread). In production startup fails fast if no
 * key is set (see index.ts), so logs are always encrypted in production.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'crypto';
import { config } from '../config/app-config';

/** True when RECORD_ENCRYPTION_KEY is configured (non-empty). */
export function isRecordEncryptionConfigured(): boolean {
  return config.recordEncryptionKey.trim().length > 0;
}

/**
 * True when the line is an encrypted envelope (v:1, aes-256-gcm) without
 * attempting to decrypt it. Used by the record loaders to distinguish
 * "encrypted but unreadable without a key" from malformed/corrupt lines.
 */
export function isEncryptedRecordLine(line: string): boolean {
  try {
    const parsed = JSON.parse(line) as { v?: number; alg?: string } | null;
    return parsed !== null && parsed.v === 1 && parsed.alg === 'aes-256-gcm';
  } catch {
    return false;
  }
}

/** Deterministic 32-byte AES-256 key derived from the configured secret. */
function deriveKey(): Buffer {
  return createHash('sha256').update(config.recordEncryptionKey).digest();
}

/**
 * Serializes a plaintext record line, encrypting it when a key is configured.
 * With no key configured (pilot/dev) it returns the plaintext unchanged — the
 * production gate requires a key, so this is only a development fallback.
 *
 * @param payload - Plaintext JSON we want to persist.
 * @returns The text to append to the JSONL log.
 */
export function encryptRecordLine(payload: string): string {
  if (!isRecordEncryptionConfigured()) {
    return payload; // plaintext fallback (dev only; production gate requires a key)
  }
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const encrypted = Buffer.concat([cipher.update(payload, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return JSON.stringify({
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: encrypted.toString('base64'),
  });
}

/**
 * Reads one line from a JSONL record log back to its plaintext. Handles both
 * encrypted envelopes and legacy plaintext lines. Returns null on any failure
 * (malformed line, missing key, tampered/invalidated auth tag) so corrupt
 * records are skipped, never partially read.
 *
 * @param line - A single JSONL line (an encrypted envelope or plaintext).
 * @returns The plaintext, or null if the line cannot be decoded.
 */
export function decryptRecordLine(line: string): string | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed && parsed.v === 1 && parsed.alg === 'aes-256-gcm') {
      if (!isRecordEncryptionConfigured()) {
        return null; // encrypted line but no key available — cannot read
      }
      const decipher = createDecipheriv(
        'aes-256-gcm',
        deriveKey(),
        Buffer.from(parsed.iv, 'base64'),
      );
      decipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(parsed.data, 'base64')),
        decipher.final(),
      ]);
      return plain.toString('utf8');
    }
    // Legacy plaintext line
    return line;
  } catch {
    return null;
  }
}
