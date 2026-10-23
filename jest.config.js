/** Jest configuration for TypeScript */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  setupFiles: [
    // Keep a developer's .env out of the assertions (an ambient admin key
    // would turn pilot-mode 200s into 401s).
    '<rootDir>/tests/setup/isolate-secrets.ts',
    // Every ephemeral server binds 127.0.0.1, so another local service holding
    // that port on IPv4 cannot intercept the request (see the file).
    '<rootDir>/tests/setup/loopback-listen.ts',
    // The durable booking ledger writes one claim file per slot; each test file
    // gets a private temp directory so suites cannot claim each other's slots.
    '<rootDir>/tests/setup/booking-ledger.ts',
    // Record stores default to data/ in the repository. Point every test file's
    // lead/DSR/abstention/audit paths at its own temp directory so a suite that
    // says nothing can never append synthetic records to a real store (M-01).
    '<rootDir>/tests/setup/record-paths.ts',
  ],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
  collectCoverageFrom: ['src/**/*.ts', '!src/index.ts'],
  /**
   * Coverage floor (SEC-17).
   *
   * CI already ran `jest --coverage` and uploaded the report, but without a
   * threshold a change could drop a whole module's coverage and still pass.
   * These are the audit's targets; the measured baseline when they were added
   * was 88.4 % statements, 80.7 % branches, 89.8 % functions and 89.5 % lines,
   * so the floor leaves headroom while failing a material regression.
   */
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 75,
      functions: 85,
      lines: 85,
    },
  },
  clearMocks: true,
};
