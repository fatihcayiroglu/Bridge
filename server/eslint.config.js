// server/eslint.config.js
// ESLint flat config (Node.js 20+)

'use strict';

const js = require('@eslint/js');
const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        require: 'readonly',
        module: 'readonly',
        exports: 'writable',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        fetch: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextDecoder: 'readonly',
        URLSearchParams: 'readonly',
        FormData: 'readonly',
        Blob: 'readonly',
        setImmediate: 'readonly',
        Headers: 'readonly',
        Request: 'readonly',
        Response: 'readonly',
        ReadableStream: 'readonly',
        WritableStream: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      // Error prevention
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-undef': 'error',
      'no-console': ['warn', { allow: ['warn', 'error', 'log'] }],
      'no-var': 'error',
      'prefer-const': 'warn',

      // Security
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // Style (light)
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-duplicate-imports': 'error',
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Node.js
      'no-process-exit': 'off', // used in index.js
    },
  },
  {
    files: ['**/*.ts', '**/*.d.ts'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2022,
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      '@typescript-eslint/no-var-requires': 'off',
    },
  },
  {
    // Test files - more lenient rules
    files: ['tests/**/*.js', '**/*.test.js'],
    languageOptions: {
      globals: {
        describe: 'readonly',
        it: 'readonly',
        test: 'readonly',
        expect: 'readonly',
        beforeEach: 'readonly',
        afterEach: 'readonly',
        beforeAll: 'readonly',
        afterAll: 'readonly',
        jest: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'off',
      'no-console': 'off',
    },
  },
  {
    // Generated or vendor files - skip
    ignores: [
      'node_modules/',
      'data/',
      'uploads/',
      'ts-out/',
      '_legacy_js_backup_session4_5/',
      'db/repositories/types/*.d.js',
      'routes/admin-ipban-routes.js',
    ],
  },
];
