// server/tests/voice-route-mount-contract.test.ts
// Voice REST routes — the PRODUCTION mount path contract.
//
// ════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS — AND WHY THE EXISTING TESTS COULD NOT CATCH IT
// ════════════════════════════════════════════════════════════════════════════
// `routes/channels/voice.ts` serves `POST /:channelId/voice-state` and
// `GET /:channelId/voice-members`; the OpenAPI spec and the router's own header
// publish them as `/api/channels/{channelId}/voice-state|voice-members`. Since
// the Sprint 108 split, `setupRoutes.ts` mounted the router under `/servers`, so
// the documented URLs answered 404 and the handlers were reachable only at
// `/api/servers/<channelId>/voice-state` — a path nothing documents or calls.
//
// BLIND SPOT: `tests/channel-voice-route-behavior.test.ts` mounts the router on
// its OWN app at `/api/channels`, so it assumed the right contract while
// production mounted the wrong one; e2e/tests/voice.spec.ts called the
// documented URLs and accepted the 404 (`< 500`, `>= 401`).
//
// Same class as C3 (moderation-mount-contract.test.ts): this file checks the
// real `setupRoutes()` — which path the router is bound to, and that a request
// to the documented URL reaches the route (401 from its auth guard), not the
// 404 handler.

process.env.JWT_SECRET     = 'test-jwt-secret-abcdefghijklmnop';
process.env.REFRESH_SECRET = 'test-refresh-secret-abcdefghijkl';
process.env.NODE_ENV       = 'test';

// This suite does not exercise image processing; isolate the native import.
jest.mock('sharp', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import express from 'express';
import type { Application, Router } from 'express';
import request from 'supertest';
import channelsRouter from '../routes/channels/index';
import { setupRoutes } from '../app/setupRoutes';

interface Mount { path: string; router: unknown }

/** A minimal app that records `app.use(path, ...)` calls. */
function recordMounts(): Mount[] {
  const mounts: Mount[] = [];
  const app = {
    use: (...args: unknown[]) => {
      if (typeof args[0] === 'string') {
        for (const h of args.slice(1)) mounts.push({ path: args[0] as string, router: h });
      }
      return app;
    },
    get:    () => app,
    post:   () => app,
    set:    () => app,
    all:    () => app,
    locals: {},
  } as unknown as Application;
  setupRoutes(app);
  return mounts;
}

describe('voice REST routes — production mount contract', () => {
  it('the channels router is mounted where OpenAPI publishes it (/api/channels, /api/v1/channels)', () => {
    const paths = recordMounts()
      .filter((m) => m.router === (channelsRouter as unknown as Router))
      .map((m) => m.path)
      .sort();
    expect(paths).toEqual(['/api/channels', '/api/v1/channels']);
  });

  describe('a request to the documented URL reaches the route, not the 404 handler', () => {
    let app: Application;
    beforeAll(() => {
      app = express();
      app.use(express.json());
      setupRoutes(app);
    });

    it.each([
      ['post', '/api/channels/c1/voice-state'],
      ['get',  '/api/channels/c1/voice-members'],
      ['post', '/api/v1/channels/c1/voice-state'],
      ['get',  '/api/v1/channels/c1/voice-members'],
    ] as const)('%s %s without a token → 401 from the route\'s auth guard', async (method, url) => {
      const res = await request(app)[method](url).send({ selfMute: true });
      expect(res.status).toBe(401);
    });

    it('the old accidental alias /api/servers/<channelId>/voice-state no longer serves the handler', async () => {
      const res = await request(app).post('/api/servers/c1/voice-state').send({ selfMute: true });
      expect(res.status).toBe(404);
    });
  });
});
