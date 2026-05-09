const { test, expect } = require('@playwright/test');
const AxeBuilder = require('@axe-core/playwright').default;

async function expectNoA11yViolations(page, path) {
  await page.goto(path, { waitUntil: 'domcontentloaded' });
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa'])
    .disableRules(['color-contrast'])
    .analyze();
  expect(results.violations, `A11Y violations on ${path}`).toEqual([]);
}

test.describe('a11y smoke', () => {
  test('landing page has no critical wcag2a/aa violations', async ({ page }) => {
    await expectNoA11yViolations(page, '/');
  });

  test('marketplace page has no critical wcag2a/aa violations', async ({ page }) => {
    await expectNoA11yViolations(page, '/marketplace');
  });
});
