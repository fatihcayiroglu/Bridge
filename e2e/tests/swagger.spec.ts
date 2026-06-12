// e2e/tests/swagger.spec.ts — Sprint 73: Swagger /docs endpoint smoke testi
// Kritik: setupRoutes.ts'de mountApi('/docs', swaggerRouter) doğrulanmamıştı.
// Bu test CI'da /api/v1/docs → 200 dönmesini garantiler.

import { test, expect, request as pwRequest } from '@playwright/test';

const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

test.describe('Swagger /docs smoke testi', () => {
  test('GET /api/v1/docs → 200 döner ve HTML içerir', async () => {
    const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
    const res = await ctx.get('/api/v1/docs');
    expect(res.status()).toBe(200);
    const body = await res.text();
    // Swagger UI veya JSON spec dönüyor olmalı
    expect(body.length).toBeGreaterThan(100);
    await ctx.dispose();
  });

  test('GET /api/v1/docs/swagger.json → 200 veya redirect', async () => {
    const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
    const res = await ctx.get('/api/v1/docs/swagger.json');
    // 200 veya 301/302 (bazı swagger kurulumları redirect yapar)
    expect([200, 301, 302]).toContain(res.status());
    await ctx.dispose();
  });
});
