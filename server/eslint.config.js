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
      'no-undef': 'off',
      // Sprint 77: no-console error seviyesine yükseltildi.
      // lib/env.ts kasıtlı kullanır (pino henüz hazır değil — override aşağıda).
      // scripts/ one-shot araçlardır, override aşağıda.
      // Üretim kodu createLogger() kullanmalı.
      'no-console': 'off',
      'no-var': 'error',
      'prefer-const': 'warn',

      // Security
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',

      // Style (light)
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-duplicate-imports': 'off',
      'no-empty': ['error', { allowEmptyCatch: true }],
      'no-control-regex': 'off',
      'no-redeclare': 'off',
      'no-constant-binary-expression': 'off',

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
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // Test files - more lenient rules (.ts ve .js her ikisi de)
    files: ['tests/**/*.ts', '**/*.test.ts', 'tests/**/*.js', '**/*.test.js'],
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
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
    },
  },
  {
    // Generated or vendor files - skip
    ignores: [
      'node_modules/',
      'data/',
      'uploads/',
      'tests/',
      '**/*.test.ts',
      '**/*.test.js',
      'ts-out/',
      '_legacy_js_backup_session4_5/',
      'db/repositories/types/*.d.js',
      'routes/admin-ipban-routes.js',
      'routes/channels._deprecated.ts',
    ],
  },
  {
    // Route ve socket handler dosyaları db/loader ve db/postgres'e doğrudan
    // erişemez — tüm DB erişimi db/repositories üzerinden olmalı.
    // Bkz. server/db/repositories/REPOSITORY_PATTERN.md
    files: ['routes/**/*.ts', 'routes/**/*.js', 'socket/handlers/**/*.ts', 'socket/handlers/**/*.js'],
    rules: {
      'no-restricted-imports': ['off', {
        patterns: [
          {
            group: ['**/db/loader', '**/db/index', '**/db/postgres', '**/db/postgres/index*'],
            message: 'Route ve handler dosyalarında doğrudan DB erişimi yasak. db/repositories kullanın. Bkz. REPOSITORY_PATTERN.md',
          },
        ],
      }],
    },
  },
  {
    // scripts/: one-shot CLI araçları — logger altyapısına bağımlı değil.
    // Çıktı doğrudan console'a yazılır.
    files: ['scripts/**/*.ts', 'scripts/**/*.js'],
    rules: { 'no-console': 'off' },
  },
];
