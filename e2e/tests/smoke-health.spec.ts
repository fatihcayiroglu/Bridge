import { test, expect } from '../helpers/apiTest';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

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
    // Final21 Faz 22 (19-37): sunucu istemci kabuğunu sunar (ölçüldü 200). 404'te de başlıklar
    // denetlenirdi ama "kamuya açık HTML" hiç sunulmuyor olurdu.
    expect(res.status()).toBe(200);
    const headers = res.headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['content-security-policy']).toContain("default-src");
  });
});
