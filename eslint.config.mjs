import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';
import security from 'eslint-plugin-security';
import globals from 'globals';

export default tseslint.config(
  // Base JS recommended rules
  js.configs.recommended,

  // TypeScript recommended rules (type-aware where possible)
  ...tseslint.configs.recommended,

  // Disable formatting rules that conflict with Prettier
  eslintConfigPrettier,

  // Project-specific overrides
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    rules: {
      // Allow console.log/warn/error for server logging
      'no-console': 'off',

      // TypeScript-specific
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/explicit-module-boundary-types': 'off',

      // General code quality
      'no-unused-vars': 'off', // Use the TS version instead
      'prefer-const': 'error',
      'no-var': 'error',
      'object-shorthand': 'error',
      'prefer-template': 'error',
    },
  },

  /**
   * Security-focused static analysis (SEC-17).
   *
   * These rules run inside the required lint step, so a dangerous primitive
   * (dynamic eval, a child process, a non-literal require, a weak RNG) fails CI
   * without a second scanner to install. This is pattern-based SAST, not
   * whole-program data-flow analysis: `eslint-plugin-security`'s taint-shaped
   * rules (notably `detect-object-injection`) are intentionally off because
   * they flag ordinary index access throughout this codebase, and a permanently
   * noisy gate is a gate nobody reads. CodeQL is not used here because its
   * SARIF upload requires `security-events: write`, which the workflow
   * least-privilege guard (`tests/workflow-pinning.test.ts`) forbids.
   */
  {
    files: ['src/**/*.ts', 'tests/**/*.ts'],
    plugins: { security },
    rules: {
      'security/detect-eval-with-expression': 'error',
      'security/detect-child-process': 'error',
      'security/detect-non-literal-require': 'error',
      'security/detect-buffer-noassert': 'error',
      'security/detect-pseudoRandomBytes': 'error',
      // Reported, not gated: the rule is heuristic about regex shape and the
      // classifier patterns are reviewed separately (SEC-19 tracks ReDoS).
      'security/detect-unsafe-regex': 'warn',
    },
  },

  // Test files — relax some rules
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Config files — declare Node globals so `module`, `require`, etc.
  //   are not flagged as undefined by `no-undef`.
  {
    files: ['*.js', '*.cjs', '*.mjs'],
    languageOptions: {
      globals: globals.node,
    },
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Ignore patterns
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'public/'],
  },
);
