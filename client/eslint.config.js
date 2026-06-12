// client/eslint.config.js
// ESLint flat config — Bridge istemci tarafı
// Sprint 77: no-console kuralı eklendi; tüm console çağrıları createLogger ile değiştirildi.

'use strict';

const tsParser = require('@typescript-eslint/parser');
const tsPlugin = require('@typescript-eslint/eslint-plugin');

module.exports = [
  {
    files: ['js/**/*.ts', 'js/**/*.js'],
    ignores: [
      'js/core/logger.ts', // logger.ts console kullanır — kasıtlı
      'tests/**',
      'node_modules/',
    ],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
      globals: {
        window:    'readonly',
        document:  'readonly',
        navigator: 'readonly',
        fetch:     'readonly',
        URL:       'readonly',
        URLSearchParams: 'readonly',
        FormData:  'readonly',
        Blob:      'readonly',
        File:      'readonly',
        FileReader: 'readonly',
        Worker:    'readonly',
        MediaStream: 'readonly',
        MediaRecorder: 'readonly',
        RTCPeerConnection: 'readonly',
        AudioContext: 'readonly',
        WebSocket: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        requestAnimationFrame: 'readonly',
        cancelAnimationFrame: 'readonly',
        performance: 'readonly',
        crypto: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
        localStorage: 'readonly',
        sessionStorage: 'readonly',
        location: 'readonly',
        history: 'readonly',
        MutationObserver: 'readonly',
        IntersectionObserver: 'readonly',
        ResizeObserver: 'readonly',
      },
    },
    plugins: { '@typescript-eslint': tsPlugin },
    rules: {
      // Sprint 77: console.* yasak — createLogger kullan
      // `no-console` yerine burada daha sıkı: allow listesi boş
      'no-console': ['error', { allow: [] }],

      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-var': 'error',
      'prefer-const': 'warn',
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-duplicate-imports': 'error',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
  {
    // Test dosyaları — console serbest
    files: ['tests/**/*.ts', 'tests/**/*.js'],
    rules: {
      'no-console': 'off',
      'no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },
];
