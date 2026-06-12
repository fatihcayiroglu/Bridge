// electron/jest.electron.config.js
// Electron main.js + preload.js için ayrı Jest konfigürasyonu
//
// Kurulum (electron/ dizininde):
//   npm install --save-dev jest @types/jest jest-mock-ipc
//   npm install --save-dev electron   # zaten devDependencies'te
//
// Çalıştırma:
//   npx jest --config jest.electron.config.js

'use strict';

/** @type {import('jest').Config} */
module.exports = {
  // Node ortamı zorunlu — Electron main process Node'dur, jsdom değil
  testEnvironment: 'node',

  // Sadece electron test dosyalarını topla; server/client testleriyle çakışmasın
  testMatch: ['<rootDir>/tests/**/*.test.js', '<rootDir>/tests/**/*.test.ts'],

  // main.test.js saf CJS — babel-jest ile işle; .ts dosyaları ts-jest ile
  transform: {
    '^.+\\.js$':  ['babel-jest', { presets: [['@babel/preset-env', { targets: { node: 'current' } }]] }],
    '^.+\\.ts$':  ['ts-jest', { diagnostics: false }],
  },

  // electron modülünü mock'la — gerçek binary olmadan require('electron') patlar
  moduleNameMapper: {
    '^electron$': '<rootDir>/tests/__mocks__/electron.js',
    '^electron-updater$': '<rootDir>/tests/__mocks__/electron-updater.js',
  },

  // Her test öncesi mock durumunu sıfırla
  clearMocks: true,
  restoreMocks: true,

  // Electron main process'i test süresi bitmeden kapatmak için yeterli süre
  testTimeout: 15000,

  // Kapsam kaynakları
  collectCoverageFrom: [
    '<rootDir>/../electron/main.js',
    '<rootDir>/../electron/preload.js',
  ],

  coverageThreshold: {
    global: { lines: 70, functions: 65, branches: 60 },
  },
};
