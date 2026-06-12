// electron/jest.electron.config.ts
import type { Config } from 'jest';

const config: Config = {
  displayName: 'electron',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.json',
    }],
  },
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^electron$': '<rootDir>/tests/__mocks__/electron',
    '^electron-updater$': '<rootDir>/tests/__mocks__/electron-updater',
  },
  clearMocks: true,
  verbose: true,
};

export default config;
