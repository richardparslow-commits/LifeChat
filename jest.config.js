/** Jest configuration for TypeScript */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
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
