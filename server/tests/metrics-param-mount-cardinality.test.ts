// server/tests/metrics-param-mount-cardinality.test.ts
//
// The `route` metric label must never carry caller-chosen text. The earlier
// fix (metrics-cardinality.test.ts) sends unmatched paths to one bucket, but a
// MATCHED route behind a parameterised mount still leaked: `req.route.path` is
// a pattern while `req.baseUrl` is the concrete mount, e.g.
// `/api/servers/<sid>/channels`. Per-route auth runs after the match, so an
// unauthenticated 401, or a 404 for a server that does not exist, created a new
// series per request, and real traffic put server ids into metrics (P7 B3).

process.env.NODE_ENV = 'test';
process.env.METRICS_ENABLED = 'true';

import express from 'express';
import request from 'supertest';
import type { Request } from 'express';
import {
  __normalizeRouteForTest as normalizeRoute,
  __OVERFLOW_ROUTE as OVERFLOW,
  __MAX_ROUTE_LABELS as MAX_LABELS,
  __resetRouteLabelsForTest as resetLabels,
  metricsMiddleware,
  metricsEndpoint,
} from '../middleware/metrics';

const matched = (baseUrl: string, path: string, params: Record<string, string>) =>
  ({ route: { path }, baseUrl, params, method: 'GET' } as unknown as Request);

beforeEach(() => resetLabels());

describe('route label: parameterised mounts', () => {
  it('maps the concrete mount segment back to its parameter name', () => {
    expect(normalizeRoute(matched('/api/servers/srv-123/channels', '/:cid', { sid: 'srv-123', cid: 'c-9' })))
      .toBe('/api/servers/:sid/channels/:cid');
    expect(normalizeRoute(matched('/api/servers/srv-123/og-image', '/', { sid: 'srv-123' })))
      .toBe('/api/servers/:sid/og-image/');
  });

  it('handles percent-encoded segments (params are decoded, baseUrl is not)', () => {
    expect(normalizeRoute(matched('/api/servers/a%20b/channels', '/:cid', { sid: 'a b', cid: 'x' })))
      .toBe('/api/servers/:sid/channels/:cid');
  });

  it('leaves static mounts and plain routes as they were', () => {
    expect(normalizeRoute(matched('/api/servers/invites', '/:code', { code: 'abc' }))).toBe('/api/servers/invites/:code');
    expect(normalizeRoute(matched('', '/api/health', {}))).toBe('/api/health');
  });

  it('many distinct server ids produce ONE label', () => {
    const labels = new Set<string>();
    for (let i = 0; i < 5000; i++) {
      labels.add(normalizeRoute(matched(`/api/servers/s${i}/channels`, '/:cid', { sid: `s${i}`, cid: `c${i}` })));
    }
    expect([...labels]).toEqual(['/api/servers/:sid/channels/:cid']);
  });
});

describe('route label: the set is bounded even for an unknown leak', () => {
  it(`after ${MAX_LABELS} distinct labels, new values share one overflow bucket`, () => {
    // A mount the substitution cannot see (no matching param): the guard still bounds it.
    for (let i = 0; i < MAX_LABELS; i++) normalizeRoute(matched(`/x/${i}`, '/', {}));
    expect(normalizeRoute(matched('/x/new-1', '/', {}))).toBe(OVERFLOW);
    expect(normalizeRoute(matched('/x/new-2', '/', {}))).toBe(OVERFLOW);
    // Labels already seen keep their own series.
    expect(normalizeRoute(matched('/x/0', '/', {}))).toBe('/x/0/');
  });
});

describe('real servers router: unauthenticated requests cannot mint series', () => {
  it('401s and 404s under /:sid mounts record only the patterns', async () => {
    const mod = require('../routes/servers');
    const app = express();
    app.use(metricsMiddleware);
    app.get('/metrics', metricsEndpoint);
    app.use('/api/servers', mod.default ?? mod);
    const statuses = new Set<number>();
    for (let i = 0; i < 20; i++) {
      statuses.add((await request(app).get(`/api/servers/attacker-chosen-${i}/channels/x`)).status);
      statuses.add((await request(app).get(`/api/servers/attacker-chosen-og-${i}/og-image`)).status);
    }
    // The requests really were refused (no session / no such server), not served.
    expect([...statuses].sort()).toEqual([401, 404]);
    const text = (await request(app).get('/metrics')).text;
    const routes = [...new Set([...text.matchAll(/route="([^"]+)"/g)].map(m => m[1]))].sort();
    expect(text).not.toContain('attacker-chosen');
    expect(routes).toEqual(['/api/servers/:sid/channels/:cid', '/api/servers/:sid/og-image/']);
  }, 60_000);
});
