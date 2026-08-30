import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import eslintConfigPrettier from 'eslint-config-prettier';

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

  // Test files — relax some rules
  {
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-non-null-assertion': 'off',
    },
  },

  // Config files
  {
    files: ['*.js', '*.cjs', '*.mjs'],
    rules: {
      '@typescript-eslint/no-require-imports': 'off',
    },
  },

  // Ignore patterns
  {
    ignores: ['dist/', 'node_modules/', 'coverage/', 'public/'],
  },
);
