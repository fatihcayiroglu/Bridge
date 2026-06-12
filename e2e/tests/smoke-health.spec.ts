import { test, expect } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3001';

test.describe('production smoke health', () => {
  test.use({ storageState: undefined });

  test('liveness endpoint answers quickly', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health/live`);
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.status).toBe('ok');
    expect(body.check).toBe('liveness');
    expect(body.version).toBeTruthy();
  });

  test('readiness endpoint exposes safe readiness state', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/api/health/ready`);
    expect([200, 503]).toContain(res.status());
    const body = await res.json();
    expect(body.check).toBe('readiness');
    expect(body.version).toBeTruthy();
    expect(body).not.toHaveProperty('secret');
    expect(body).not.toHaveProperty('token');
  });

  test('public HTML has hardening headers', async ({ request }) => {
    const res = await request.get(`${BASE_URL}/`);
    expect([200, 404]).toContain(res.status());
    const headers = res.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("default-src");
  });
});
