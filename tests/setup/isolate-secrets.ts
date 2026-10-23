/**
 * Tests must not inherit an operator's `.env`.
 *
 * `src/index.ts` imports `dotenv/config`, so every suite that re-imports the
 * entry point loads the developer's `.env`. Most keys are harmless to a test,
 * but `ADMIN_API_KEY` changes behaviour: when it is set, the admin middleware
 * rejects unauthenticated requests, so a suite that does not configure auth
 * sees 401s where pilot mode promises 200s. A developer with a working local
 * admin key should still be able to run the tests.
 *
 * A defined-but-empty value is enough: dotenv does not overwrite a key that is
 * already present, and the app treats an empty key as "not configured". A test
 * that wants authentication sets the key explicitly before importing the app
 * and restores it from its own snapshot afterwards.
 */

process.env.ADMIN_API_KEY = '';
process.env.ARCHIL_API_KEY = '';
process.env.ARCHIL_DISK_ID = '';
