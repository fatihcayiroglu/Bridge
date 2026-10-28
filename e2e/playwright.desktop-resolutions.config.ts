import { defineConfig, devices } from '@playwright/test';
import base from './playwright.config';

// Inherit Bridge's real backend, auth fixture and server launch. The existing
// default CI config has retries=2; this acceptance matrix MUST use zero.
export default defineConfig(base, {
  testMatch: /desktop-resolutions\.spec\.ts/,
  retries: 0,
  workers: 1,
  forbidOnly: true,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-desktop-layout-report', open: 'never' }],
    ['json', { outputFile: 'desktop-layout-results.json' }],
  ],
  use: { trace: 'retain-on-failure', screenshot: 'only-on-failure', video: 'retain-on-failure' },
  projects: [
    { name: 'desktop-chromium', use: { ...devices['Desktop Chrome'], storageState: 'fixtures/auth-state.json', locale: 'tr-TR' } },
    { name: 'desktop-firefox', use: { ...devices['Desktop Firefox'], storageState: 'fixtures/auth-state.json', locale: 'tr-TR' } },
    { name: 'desktop-webkit', use: { ...devices['Desktop Safari'], storageState: 'fixtures/auth-state.json', locale: 'tr-TR' } },
  ],
});
