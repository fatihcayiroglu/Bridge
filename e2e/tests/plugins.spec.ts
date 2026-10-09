// e2e/tests/plugins.spec.ts — the SHIPPED plugin runtime, end to end.
//
// What Bridge ships (server/plugins/loader.ts): the bundled plugins in
// <repo>/plugins (welcome-bot, word-filter, auto-role) are loaded at start-up
// with restricted, permission-gated capabilities; each may register routes under
// /api/plugins/:id/* and subscribe to server hooks.
//
// What it does NOT ship: an admin HTTP API that loads executable code from an
// arbitrary path at runtime. The previous version of this file tested exactly
// that (POST /api/admin/plugins/load …) and skipped all six tests because the
// endpoint does not exist. Such an endpoint would be remote code execution for
// whoever holds an admin token, so its ABSENCE is asserted here instead of
// being implemented to turn a skip green.
//
// These tests became runnable when the compiled server started finding the
// bundled plugins outside Docker (fix/plugins-dir-compiled); before, the E2E
// server logged "Plugin loading completed. count 0".

import { test, expect } from '../helpers/apiTest';
import { request as pwRequest } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, closeSockets, joinChannelConfirmed, paceSends, waitForEvent } from '../helpers/socket';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
const BUNDLED = ['auto-role', 'welcome-bot', 'word-filter'];

test.describe('Plugin runtime — bundled plugins', () => {
  let token: string;
  let serverId: string;
  let channelId: string;

  test.beforeAll(async ({ request }) => {
    token = getTokens().alice;
    const server = await createTestServer(request, token, `Plugins ${Date.now()}`);
    expect(server, 'plugin test server fixture').toBeTruthy();
    serverId = server._id || server.id;
    const channel = await createTestChannel(request, token, serverId, 'plugin-filter');
    expect(channel, 'plugin test channel fixture').toBeTruthy();
    channelId = channel._id || channel.id;
  });

  test('GET /api/plugins lists every bundled plugin, and only to a signed-in person', async ({ request }) => {
    const res = await request.get(`${BASE}/api/plugins`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(200);
    const list = await res.json() as Array<{ id: string; version: string }>;
    expect(list.map(p => p.id).sort()).toEqual(BUNDLED);
    for (const p of list) expect(p.version).toMatch(/^\d+\.\d+\.\d+/);

    const anon = await pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      expect((await anon.get(`${BASE}/api/plugins`)).status()).toBe(401);
    } finally { await anon.dispose(); }
  });

  test('a plugin-registered route is mounted under /api/plugins/:id and requires authentication', async ({ request }) => {
    const res = await request.get(`${BASE}/api/plugins/word-filter/blocked`, { headers: { Authorization: `Bearer ${token}` } });
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ blockedWords: ['spam', 'scam'] });

    const anon = await pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      expect((await anon.get(`${BASE}/api/plugins/word-filter/blocked`)).status()).toBe(401);
    } finally { await anon.dispose(); }
  });

  test('word-filter acts on the real message:created hook: a blocked word is removed and the author warned; a clean message stays', async ({ request }) => {
    const socket = await openSocket(token);
    try {
      await joinChannelConfirmed(socket, channelId, serverId, 6, 'alice');

      // Negative control: a clean message is persisted and not deleted.
      await paceSends('alice');
      const cleanAck = `plugin-clean-${Date.now()}`;
      const cleanSaved = waitForEvent<{ ackId: string; messageId: string }>(socket, 'message:ack', 15_000, a => a?.ackId === cleanAck);
      socket.emit('message:send', { channelId, serverId, content: 'a perfectly ordinary message', ackId: cleanAck });
      const cleanId = (await cleanSaved).messageId;
      expect(cleanId).toBeTruthy();

      await paceSends('alice');
      const blockedAck = `plugin-blocked-${Date.now()}`;
      const saved = waitForEvent<{ ackId: string; messageId: string }>(socket, 'message:ack', 15_000, a => a?.ackId === blockedAck);
      const warned = waitForEvent<{ content?: string; displayName?: string }>(
        socket, 'message:new', 15_000, m => m?.displayName === 'Word Filter' && /yasaklı içerik/.test(m?.content ?? ''),
      );
      socket.emit('message:send', { channelId, serverId, content: 'this offer is a SCAM, click here', ackId: blockedAck });
      const blockedId = (await saved).messageId;
      expect(blockedId).toBeTruthy();
      const deleted = await waitForEvent<{ id: string }>(socket, 'message:deleted', 15_000, d => d?.id === blockedId);
      expect(deleted.id).toBe(blockedId);
      expect((await warned).content).toContain('yasaklı içerik');

      await expect.poll(async () => {
        const res = await request.get(`${BASE}/api/channels/${channelId}/messages?limit=50`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        expect(res.status()).toBe(200);
        const body = await res.json() as { messages?: Array<{ _id: string }> } | Array<{ _id: string }>;
        const ids = (Array.isArray(body) ? body : body.messages ?? []).map(m => m._id);
        return { clean: ids.includes(cleanId), blocked: ids.includes(blockedId) };
      }, { timeout: 15_000 }).toEqual({ clean: true, blocked: false });
    } finally {
      closeSockets(socket);
    }
  });

  test('there is no HTTP API that loads plugin code at runtime (it would be remote code execution)', async ({ request }) => {
    // An instance admin must get 404 (not 403): the route does not exist at all.
    const admin = (getTokens() as unknown as { admin?: string }).admin;
    expect(admin, 'instance-admin fixture (global.setup.ts ensureAdminUser)').toBeTruthy();
    const list = await request.get(`${BASE}/api/admin/plugins`, { headers: { Authorization: `Bearer ${admin}` } });
    expect(list.status()).toBe(404);
    const load = await request.post(`${BASE}/api/admin/plugins/load`, {
      headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      data: { path: '/tmp' },
    });
    expect(load.status()).toBe(404);
  });
});
