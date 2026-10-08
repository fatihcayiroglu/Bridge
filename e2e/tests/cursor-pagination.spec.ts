// Shipped cursor pagination, not unshipped window._bridgeVS virtualization.
import { test, expect } from '../helpers/apiTest';
import { request as pwRequest } from '@playwright/test';
import { getTokens, createTestServer, createTestChannel } from '../helpers/bridge';
import { openSocket, closeSockets, paceSends, waitForEvent } from '../helpers/socket';
import type { Socket } from 'socket.io-client';

const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
type History = { messages: Array<{ _id: string; createdAt: number | string }>; hasMore: boolean; prevCursor: string | null; nextCursor: string | null };
test.describe('Shipped cursor history E2E', () => {
  let token: string;
  let channelId: string;
  let serverId: string;
  let socket: Socket | undefined;
  const ids: string[] = [];
  test.beforeAll(async ({ request }) => {
    token = getTokens().media2;
    expect(token).toBeTruthy();
    const server = await createTestServer(request, token, 'Cursor ' + Date.now());
    expect(server, 'server fixture missing').toBeTruthy();
    serverId = server._id || server.id;
    const channel = await createTestChannel(request, token, serverId, 'cursor-history');
    expect(channel, 'channel fixture missing').toBeTruthy();
    channelId = channel._id || channel.id;
    socket = await openSocket(token);
    for (let i = 0; i < 9; i++) {
      await paceSends('media2');
      const ackId = 'cursor-' + Date.now() + '-' + i;
      const ack = waitForEvent<{ ackId: string; messageId: string }>(socket, 'message:ack', 15000, x => x?.ackId === ackId);
      socket.emit('message:send', { channelId, serverId, content: 'cursor-fixture-' + i, ackId });
      const received = await ack;
      expect(received.messageId).toBeTruthy();
      ids.push(received.messageId);
    }
    expect(new Set(ids).size).toBe(9);
  });
  test.afterAll(() => { if (socket) closeSockets(socket); });

  async function history(request: import('@playwright/test').APIRequestContext, query: string): Promise<History> {
    const res = await request.get(BASE + '/api/channels/' + channelId + '/messages?' + query, {
      headers: { Authorization: 'Bearer ' + token },
    });
    expect(res.status(), await res.text()).toBe(200);
    return await res.json() as History;
  }
  test('adjacent pages are disjoint, in order, complete and traversable forwards', async ({ request }) => {
    const latest = await history(request, 'limit=3');
    expect(latest.messages).toHaveLength(3);
    expect(latest.hasMore).toBe(true);
    expect(latest.prevCursor).toBeTruthy();
    const middle = await history(request, 'limit=3&cursor=' + encodeURIComponent(latest.prevCursor!));
    expect(middle.messages).toHaveLength(3);
    expect(middle.hasMore).toBe(true);
    expect(middle.prevCursor).toBeTruthy();
    const oldest = await history(request, 'limit=3&cursor=' + encodeURIComponent(middle.prevCursor!));
    expect(oldest.messages).toHaveLength(3);
    expect(oldest.hasMore).toBe(false);
    const joined = [...oldest.messages, ...middle.messages, ...latest.messages];
    expect(new Set(joined.map(x => x._id))).toEqual(new Set(ids));
    for (const page of [oldest, middle, latest]) {
      const timestamps = page.messages.map(m => Number(m.createdAt));
      expect(timestamps.every(Number.isSafeInteger)).toBe(true);
      expect(timestamps).toEqual([...timestamps].sort((a, b) => a - b));
    }
    expect(middle.nextCursor).toBeTruthy();
    const forward = await history(request, 'limit=3&cursor=' + encodeURIComponent(middle.nextCursor!));
    expect(forward.messages.map(x => x._id)).toEqual(latest.messages.map(x => x._id));
  });
  test('invalid bounds/cursors and unauthorized reads fail rather than skip', async ({ request }) => {
    for (const query of ['limit=0', 'limit=101', 'limit=nan', 'cursor=not-base64']) {
      const res = await request.get(BASE + '/api/channels/' + channelId + '/messages?' + query, {
        headers: { Authorization: 'Bearer ' + token },
      });
      expect(res.status(), query).toBe(400);
    }
    const anon = await pwRequest.newContext({ storageState: { cookies: [], origins: [] } });
    try {
      const denied = await anon.get(BASE + '/api/channels/' + channelId + '/messages?limit=3');
      expect(denied.status()).toBe(401);
    } finally { await anon.dispose(); }
    const other = await request.get(BASE + '/api/channels/' + channelId + '/messages?limit=3', {
      headers: { Authorization: 'Bearer ' + getTokens().bob },
    });
    expect(other.status()).toBe(403);
  });
});
