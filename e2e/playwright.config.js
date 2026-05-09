// e2e/playwright.config.js — Bridge E2E Test Konfigürasyonu
// Playwright ile kritik akışları test eder: login, mesaj, kanal, DM
//
// Kurulum:
//   npm install -D @playwright/test
//   npx playwright install --with-deps chromium
//
// Çalıştırma:
//   npx playwright test                    # tüm testler
//   npx playwright test --headed           # tarayıcı görünür
//   npx playwright test tests/auth.spec.js # tek dosya
//   npx playwright show-report             # HTML rapor

const { defineConfig, devices } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  fullyParallel: false, // Bridge'in shared DB'si nedeniyle sıralı çalış
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 2,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'playwright-report', open: 'never' }],
    ['junit', { outputFile: 'playwright-results.xml' }],
  ],

  use: {
    baseURL: process.env.BASE_URL || 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    // Her test için temiz state
    storageState: undefined,
    actionTimeout: 10_000,
    navigationTimeout: 15_000,
  },

  projects: [
    // Setup: Auth state hazırla (login token'ı kaydet)
    {
      name: 'setup',
      testMatch: /global\.setup\.js/,
    },
    // Ana testler (Chromium)
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        // Auth state'i setup'tan al (login akışı)
        storageState: 'fixtures/auth-state.json',
      },
      dependencies: ['setup'],
      testIgnore: /global\.setup\.js/,
    },
    // Mobile viewport testleri
    {
      name: 'mobile',
      use: {
        ...devices['Pixel 7'],
        storageState: 'fixtures/auth-state.json',
      },
      dependencies: ['setup'],
      testMatch: /mobile\.spec\.js/,
    },
    {
      name: 'a11y',
      use: {
        ...devices['Desktop Chrome'],
      },
      testMatch: /a11y\.smoke\.spec\.js/,
    },
  ],

  // Test çalışmadan önce sunucuyu başlat (CI'da zaten ayakta olacak)
  webServer: process.env.CI && process.env.E2E_USE_WEBSERVER !== 'true'
    ? undefined
    : {
        command: 'cd ../server && node index.js',
        url: 'http://localhost:3000/api/health',
        reuseExistingServer: true,
        timeout: 30_000,
        env: {
          NODE_ENV: 'test',
          JWT_SECRET: 'e2e-test-secret',
          REFRESH_SECRET: 'e2e-refresh-secret',
          DATABASE_URL: process.env.DATABASE_URL || '',
          PORT: '3000',
        },
      },
});
