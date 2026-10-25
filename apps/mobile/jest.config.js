module.exports = {
  preset: '@react-native/jest-preset',
  collectCoverageFrom: ['App.tsx', 'src/**/*.ts', 'src/**/*.tsx'],
  coverageReporters: ['text', 'json', 'lcov'],
  coverageThreshold: {
    global: { statements: 90, branches: 90, functions: 90, lines: 90 },
  },
  transformIgnorePatterns: [
    'node_modules/(?!((jest-)?react-native|@react-native(-community)?|react-native-url-polyfill)/)',
  ],
};
