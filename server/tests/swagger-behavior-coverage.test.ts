process.env.NODE_ENV = 'test';

import express from 'express';
import request from 'supertest';
import {
  BASE_SPEC,
  deriveOperationId,
  ensureOperationIds,
  getSpec,
  invalidateSpec,
  resolveRef,
  swaggerRouter,
  validateSpec,
  type OpenApiSpec,
} from '../lib/swagger';

function spec(paths: OpenApiSpec['paths'], extra: Partial<OpenApiSpec> = {}): OpenApiSpec {
  return {
    openapi: '3.0.3',
    info: { title: 'Coverage', version: '1' },
    tags: [{ name: 'Known' }],
    components: {
      schemas: { Body: { type: 'object' } },
      responses: { Shared: { description: 'shared' } },
    },
    paths,
    ...extra,
  };
}

describe('Swagger behavior coverage', () => {
  test.each([
    ['get', '/', 'get'],
    ['get', '/servers/{id}/channels', 'getServersByIdChannels'],
    ['POST', '/server-events/{serverId}/rsvp', 'postServerEventsByServerIdRsvp'],
    ['patch', '/foo-bar/baz_qux/{messageId}', 'patchFooBarBazQuxByMessageId'],
    ['delete', '/users/{id}', 'deleteUsersById'],
  ])('deriveOperationId(%s, %s)', (method, path, expected) => {
    expect(deriveOperationId(method, path)).toBe(expected);
  });

  test('ensureOperationIds preserves existing ids, covers every HTTP method, resolves collisions and is immutable', () => {
    const original = spec({
      '/same': {
        get: { operationId: 'existing', responses: { 200: { description: 'ok' } } },
        post: { responses: { 200: { description: 'ok' } } },
        put: { responses: { 200: { description: 'ok' } } },
        patch: { responses: { 200: { description: 'ok' } } },
        delete: { responses: { 200: { description: 'ok' } } },
        head: { responses: { 200: { description: 'ok' } } },
        options: { responses: { 200: { description: 'ok' } } },
        trace: { responses: { 200: { description: 'ok' } } },
      },
      '/same-2': {
        get: { operationId: 'getSame2', responses: { 200: { description: 'ok' } } },
      },
      '/same_2': {
        get: { responses: { 200: { description: 'ok' } } },
      },
    });
    const before = JSON.stringify(original);
    const out = ensureOperationIds(original);
    expect(JSON.stringify(original)).toBe(before);
    expect(out).not.toBe(original);
    expect(out.paths['/same']?.get?.operationId).toBe('existing');
    for (const method of ['post','put','patch','delete','head','options','trace'] as const) {
      expect(out.paths['/same']?.[method]?.operationId).toBe(`${method}Same`);
    }
    // `/same_2` derives the already-taken getSame2 and must get a deterministic suffix.
    expect(out.paths['/same_2']?.get?.operationId).toBe('getSame22');
  });

  test('validateSpec reports empty paths, unknown tags, unresolved response/body refs and accepts valid refs', () => {
    expect(validateSpec(spec({}))).toEqual([
      expect.objectContaining({ level: 'warn', path: 'paths' }),
    ]);

    const invalid = spec({
      '/x': {
        get: {
          tags: ['Known', 'Missing'],
          responses: {
            200: { $ref: '#/components/responses/Shared' },
            404: { $ref: '#/components/responses/DoesNotExist' },
          },
          requestBody: {
            content: {
              'application/json': { schema: { $ref: '#/components/schemas/MissingBody' } },
              'application/problem+json': { schema: { $ref: '#/components/schemas/Body' } },
            },
          },
        },
        post: { tags: [], responses: { 204: { description: 'ok' } } },
      },
    });
    const warnings = validateSpec(invalid);
    expect(warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ level: 'warn', path: 'GET /x', message: expect.stringContaining('Missing') }),
      expect.objectContaining({ level: 'error', path: 'GET /x responses[404]' }),
      expect.objectContaining({ level: 'error', path: 'GET /x requestBody' }),
    ]));
    expect(warnings).toHaveLength(3);
  });

  test('resolveRef fails closed when an intermediate node becomes primitive/null', () => {
    const weird = spec({}, { components: { schemas: { Leaf: { type: 'string' } } } });
    expect(resolveRef(weird, '#/info/title/value')).toBeUndefined();
    expect(resolveRef({ ...weird, components: undefined }, '#/components/schemas/Leaf')).toBeUndefined();
  });

  test('getSpec caches the generated/fallback object and invalidateSpec rebuilds the cache boundary', () => {
    invalidateSpec();
    const a = getSpec();
    const b = getSpec();
    expect(a).toBe(b);
    expect(a.openapi).toBe('3.1.0');
    expect(Object.keys(a.paths).length).toBeGreaterThan(0);
    invalidateSpec();
    const c = getSpec();
    expect(c.openapi).toBe('3.1.0');
  });

  test('router serves spec JSON, validation and refresh endpoints in test mode', async () => {
    const app = express();
    app.use(express.json());
    app.use('/docs', swaggerRouter);

    const raw = await request(app).get('/docs/spec.json').expect(200);
    expect(raw.body.openapi).toBe('3.1.0');
    expect(raw.body.info.title).toBe('Bridge API');

    const validation = await request(app).get('/docs/spec/validate');
    expect([200, 422]).toContain(validation.status);
    expect(validation.body).toEqual(expect.objectContaining({
      ok: expect.any(Boolean), warnings: expect.any(Array), errors: expect.any(Array),
    }));

    await request(app).post('/docs/spec/refresh').expect(200, { ok: true, message: 'Spec cache temizlendi.' });
  });

  test('BASE_SPEC is the canonical generated OpenAPI snapshot', () => {
    expect(BASE_SPEC.openapi).toBe('3.1.0');
    expect(BASE_SPEC.info.version).toBe('1.125.0');
    expect(Object.keys(BASE_SPEC.paths).length).toBeGreaterThan(0);
    // The canonical spec declares EVERY tag its operations use (case-split
    // duplicates like `auth`/`Auth` used to fragment the Swagger UI grouping
    // and only one stub tag was declared at the root at all).
    const declared = new Set((BASE_SPEC.tags ?? []).map(t => t.name));
    expect(declared.has('Auth')).toBe(true);
    const used = new Set<string>();
    for (const item of Object.values(BASE_SPEC.paths)) {
      for (const [method, op] of Object.entries(item as Record<string, { tags?: string[] }>)) {
        if (!/^(?:get|post|put|patch|delete|options|head|trace)$/i.test(method)) continue;
        for (const tag of op?.tags ?? []) used.add(tag);
      }
    }
    expect([...used].filter(tag => !declared.has(tag))).toEqual([]);
    expect([...declared].filter(tag => !used.has(tag))).toEqual([]);
  });
});
