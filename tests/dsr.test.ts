/**
 * Tests for the Data Subject Request intake (src/privacy/dsr.ts)
 *
 * Verifies TDPSA request-type validation, contact-email validation,
 * record creation, and the in-memory store.
 */

import {
  clearAllDsrRecords,
  DSR_REQUEST_TYPES,
  DSR_RESPONSE_SLA_DAYS,
  getDsrRecord,
  listDsrRecords,
  submitDsr,
} from '../src/privacy/dsr';

beforeEach(() => {
  clearAllDsrRecords();
});

describe('submitDsr — validation', () => {
  test('accepts every TDPSA request type', () => {
    for (const requestType of DSR_REQUEST_TYPES) {
      const result = submitDsr({
        requestType,
        contactEmail: 'user@example.com',
      });
      expect(result.ok).toBe(true);
    }
  });

  test('rejects an unknown request type', () => {
    const result = submitDsr({
      requestType: 'nuclear_option',
      contactEmail: 'user@example.com',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('requestType must be one of');
    }
  });

  test('rejects an invalid contact email', () => {
    const result = submitDsr({
      requestType: 'deletion',
      contactEmail: 'not-an-email',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain('valid contact email');
    }
  });
});

describe('submitDsr — record creation', () => {
  test('creates a received record with id, timestamp, and status', () => {
    const result = submitDsr({
      requestType: 'access',
      contactEmail: 'user@example.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.request_id).toBeTruthy();
    expect(result.record.created_at).toBeTruthy();
    expect(result.record.request_type).toBe('access');
    expect(result.record.contact_email).toBe('user@example.com');
    expect(result.record.status).toBe('received');
    expect(result.record.detail).toBeNull();
  });

  test('trims and stores the optional detail', () => {
    const result = submitDsr({
      requestType: 'correction',
      contactEmail: 'user@example.com',
      detail: '  my phone number changed  ',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record.detail).toBe('my phone number changed');
  });

  test('45-day TDPSA response SLA is exposed', () => {
    expect(DSR_RESPONSE_SLA_DAYS).toBe(45);
  });
});

describe('DSR store', () => {
  test('getDsrRecord returns the record by id', () => {
    const result = submitDsr({
      requestType: 'portability',
      contactEmail: 'user@example.com',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(getDsrRecord(result.record.request_id)?.request_type).toBe('portability');
  });

  test('getDsrRecord returns undefined for an unknown id', () => {
    expect(getDsrRecord('does-not-exist')).toBeUndefined();
  });

  test('listDsrRecords returns all submitted records', () => {
    submitDsr({ requestType: 'access', contactEmail: 'a@example.com' });
    submitDsr({ requestType: 'deletion', contactEmail: 'b@example.com' });
    expect(listDsrRecords()).toHaveLength(2);
  });

  test('clearAllDsrRecords empties the store', () => {
    submitDsr({ requestType: 'access', contactEmail: 'a@example.com' });
    clearAllDsrRecords();
    expect(listDsrRecords()).toHaveLength(0);
  });
});
