// e2e/tests/swagger.spec.ts — Sprint 73: Swagger /docs endpoint smoke testi
// Kritik: setupRoutes.ts'de mountApi('/docs', swaggerRouter) doğrulanmamıştı.
// Bu test CI'da /api/v1/docs → 200 dönmesini garantiler.

import { test, expect, request as pwRequest } from '../helpers/apiTest';

const BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3000';

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

  test('GET /api/v1/docs/spec.json serves the generated OpenAPI snapshot', async () => {
    // The deployed Swagger router mounts spec.json; swagger.json was a
    // nonexistent path and made this important runtime contract skip forever.
    const ctx = await pwRequest.newContext({ baseURL: BASE_URL });
    try {
      const res = await ctx.get('/api/v1/docs/spec.json');
      expect(res.status()).toBe(200);
      expect(res.headers()['content-type']).toContain('application/json');
      const spec = await res.json() as {
        openapi?: string;
        info?: { title?: string; version?: string };
        paths?: Record<string, unknown>;
      };
      expect(spec.openapi).toMatch(/^3\./);
      expect(spec.info?.title).toBeTruthy();
      expect(spec.info?.version).toBeTruthy();
      expect(spec.paths).toBeDefined();
      expect(Object.keys(spec.paths ?? {}).length).toBeGreaterThan(0);
    } finally {
      await ctx.dispose();
    }
  });
});
