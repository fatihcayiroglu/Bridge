// server/tests/global-ratelimit-default-parity.test.ts
//
// Final21 Phase 11: the operator limits report said the default `/api` budget
// was 300/min while `createApp` enforced 200/min. The report exists so an
// operator can tell a loosened limit from the default; a report that shows a
// looser number than the one in force defeats that. This test compares the
// report with the limit the real app advertises on a live response.

process.env.JWT_SECRET      = 'test-jwt-secret-default-parityxx'.padEnd(64, 'x');
process.env.REFRESH_SECRET  = 'test-refresh-secret-default-parity'.padEnd(64, 'y');
process.env.NODE_ENV        = 'test';
process.env.ALLOWED_ORIGINS = 'http://localhost:3000';
delete process.env.RL_GLOBAL_MAX;
delete process.env.RL_GLOBAL_WIN;
delete process.env.REDIS_URL;

import type { Request, Response } from 'express';
import request from 'supertest';
import { createApp } from '../app/createApp';
import { collectLimits } from '../lib/limitsReport';
import { _resetRateLimitStoreForTest } from '../middleware/rateLimit';

describe('RL_GLOBAL_MAX default parity', () => {
  it('the limits report shows the same default /api budget that createApp enforces', async () => {
    _resetRateLimitStoreForTest();
    const { app } = createApp();
    app.get('/api/parity-probe', (_req: Request, res: Response) => { res.json({ ok: true }); });

    const res = await request(app).get('/api/parity-probe');
    const enforced = Number(String(res.headers['x-ratelimit-policy'] ?? '').split(';')[0]);
    const reported = collectLimits().find((row) => row.env === 'RL_GLOBAL_MAX');

    expect(res.status).toBe(200);
    expect(enforced).toBe(200);
    expect({ value: reported?.value, fallback: reported?.fallback }).toEqual({ value: enforced, fallback: enforced });
  });
});
