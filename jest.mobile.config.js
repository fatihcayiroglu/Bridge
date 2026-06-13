// jest.mobile.config.js  (proje kök dizininde veya mobile/ altında)
//
// Capacitor mobile testleri için AYRI Jest konfigürasyonu.
// Mevcut server/jest.config.js ve client/tests/package.json jest alanıyla
// çakışmaz — tamamen bağımsız testEnvironment + moduleNameMapper.
//
// Kurulum (mobile/ dizininde):
//   npm install --save-dev jest @types/jest babel-jest @babel/core @babel/preset-env
//
// Çalıştırma:
//   npx jest --config jest.mobile.config.js
//
// NOT: Jasmine/Jest hybrid gerekmez. Capacitor plugin'leri burada tamamen
//      mock'landığı için gerçek native bridge çağrısı yapılmaz. Standard
//      Jest yeterlidir; jasmine2 test runner'ına gerek yoktur.

'use strict';

/** @type {import('jest').Config} */
module.exports = {
  // jsdom — capacitor-bridge.js DOM API'lerini kullanır (window.localStorage vb.)
  testEnvironment: 'node',

  testMatch: ['<rootDir>/mobile/tests/**/*.test.{js,ts}'],

  modulePathIgnorePatterns: ['<rootDir>/electron/_archived_legacy'],

  // Tüm @capacitor/* ve native paketler mock'a yönlendirilir
  moduleNameMapper: {
    '^@capacitor/core$':
      '<rootDir>/mobile/tests/__mocks__/@capacitor/core.js',
    '^@capacitor/push-notifications$':
      '<rootDir>/mobile/tests/__mocks__/capacitor-plugins.js',
    '^@capacitor/network$':
      '<rootDir>/mobile/tests/__mocks__/capacitor-plugins.js',
    '^@capacitor/app$':
      '<rootDir>/mobile/tests/__mocks__/capacitor-plugins.js',
    '^@capacitor/haptics$':
      '<rootDir>/mobile/tests/__mocks__/capacitor-plugins.js',
    '^@capawesome/capacitor-badge$':
      '<rootDir>/mobile/tests/__mocks__/capacitor-plugins.js',
    '^@aparajita/capacitor-biometric-auth$':
      '<rootDir>/mobile/tests/__mocks__/capacitor-plugins.js',
    // Diğer Capacitor paketleri — hepsi aynı WebPlugin tabanını kullandığından
    // tek bir fallback ile karşılanabilir:
    '^@capacitor/(.+)$':
      '<rootDir>/mobile/tests/__mocks__/capacitor-plugins.js',
  },

  transform: {
    '^.+\\.[jt]sx?$': ['babel-jest', {
      presets: [
        ['@babel/preset-env', { targets: { node: 'current' } }],
      ],
    }],
  },

  setupFilesAfterEnv: ['<rootDir>/mobile/tests/setup-dom-shim.js'],
  clearMocks: true,
  restoreMocks: false,

  testTimeout: 10000,

  collectCoverageFrom: [
    '<rootDir>/mobile/capacitor-bridge.js',
  ],

  coverageThreshold: {
    global: { lines: 70, functions: 65, branches: 60 },
  },
};
