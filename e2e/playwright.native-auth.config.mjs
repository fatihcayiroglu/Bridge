import { defineConfig } from '@playwright/test';

if (!process.env.BRIDGE_IT_ORIGIN?.startsWith('https://')) throw Error('HTTPS_ORIGIN_REQUIRED');
export default defineConfig({
  testDir: './native-auth',
  testMatch: '**/*.spec.mjs',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 60000,
  outputDir: '../integration-evidence/browser-output',
  reporter: [['list'], ['json', { outputFile: '../integration-evidence/browser-results.json' }]],
  use: {
    browserName: 'chromium',
    channel: 'chromium',
    locale: 'en-US',
    ignoreHTTPSErrors: false,
    launchOptions: { chromiumSandbox: true },
    actionTimeout: 10000,
    navigationTimeout: 15000,
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
});
