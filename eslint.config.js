import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.tmp/**', '**/dist/**', '**/coverage/**', '**/node_modules/**', 'prototype/**', 'audit/**/evidence/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      'no-console': ['error', { allow: ['warn', 'error'] }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: 'error',
    },
  },
  {
    files: ['audit/**/*.mjs', 'scripts/**/*.mjs', 'packages/core/src/cli/**/*.ts'],
    rules: { 'no-console': 'off' },
    languageOptions: { globals: { console: 'readonly', process: 'readonly', fetch: 'readonly', URL: 'readonly', URLSearchParams: 'readonly', setTimeout: 'readonly', TextEncoder: 'readonly', Buffer: 'readonly', location: 'readonly', document: 'readonly', window: 'readonly', getComputedStyle: 'readonly', innerWidth: 'readonly', localStorage: 'readonly', sessionStorage: 'readonly' } },
  },
);
