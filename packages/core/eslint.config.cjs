const js = require('@eslint/js');
const ts = require('@typescript-eslint/eslint-plugin');
const globals = require('globals');

module.exports = [
  {ignores: ['dist/**', 'coverage/**']},
  js.configs.recommended,
  ...ts.configs['flat/recommended'],
  {
    files: ['src/**/*.ts'],
    languageOptions: {globals: {...globals.es2022, URL: 'readonly', AbortController: 'readonly',
      AbortSignal: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly'}},
  },
  {
    files: ['tests/**/*.cjs', '*.cjs'],
    languageOptions: {globals: globals.node},
    // These are CommonJS entry points; TypeScript source keeps the import rule.
    rules: {'@typescript-eslint/no-require-imports': 'off'},
  },
];
