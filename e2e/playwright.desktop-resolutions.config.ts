import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Inherit Bridge's real backend, auth fixture and server launch. The existing
// default CI config has retries=2; this acceptance matrix MUST use zero.
export default defineConfig({
  // Copy only the reusable server/auth setup. Passing the full base config to
  // defineConfig() MERGES its projects, which accidentally executes unrelated
  // S3/MinIO tests and turns this dedicated viewport gate red.
  testDir: base.testDir,
  globalSetup: base.globalSetup,
  webServer: base.webServer,
  testMatch: /desktop-resolutions\.spec\.ts/,
  retries: 0,
  workers: 1,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-desktop-layout-report', open: 'never' }],
    ['json', { outputFile: 'desktop-layout-results.json' }],
  ],
  use: { ...base.use, trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], storageState: 'fixtures/auth-state.json', locale: 'tr-TR' } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'], storageState: 'fixtures/auth-state.json', locale: 'tr-TR' } },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'], storageState: 'fixtures/auth-state.json', locale: 'tr-TR' } },
  ],
});
