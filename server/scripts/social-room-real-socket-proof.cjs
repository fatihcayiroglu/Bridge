#!/usr/bin/env node
'use strict';

/**
 * Real network + real Redis, two distinct Socket.IO clients and the production
 * social-room handler. TEST-ONLY fake identity/membership boundary is explicit:
 * this does not establish production HTTP/JWT/PostgreSQL authentication.
 * The handler, Redis adapter, distributed lock and socket broadcast are real.
 *
 * Requires server build and REDIS_URL. No retries, no skipped assertions.
 */
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { Server } = require('socket.io');
const { io: openClient } = require('socket.io-client');
const { applyAdapter, disconnect, isRedisAvailable } = require('../dist/lib/redisAdapter');
const { socialRoomStore } = require('../dist/socket/handlers/social-room-store');

if (!process.env.REDIS_URL) {
  console.error('SOCIAL_3D_SOCKET_REAL_REDIS_REQUIRED');
  process.exitCode = 1;
} else {
  // Only intercept the social handler's two permission dependencies, never the
  // real Redis adapter, socket server, socket client, or handler implementation.
  // Restore the require hook immediately. The synthetic users are confined to
  // this process and cannot be promoted to production credentials.
  const testServer = 'social-live-' + randomBytes(6).toString('hex');
  const allowed = new Set(['user-a', 'user-b']);
  const originalLoad = Module._load;
  let registerSocialRoomHandlers;
  try {
    Module._load = function (request, parent, isMain) {
      const handlerCaller = typeof parent?.filename === 'string' &&
        parent.filename.endsWith('/socket/handlers/social-room.js');
      if (handlerCaller && request === '../../db/repositories') {
        return { Members: { findOne: async (userId, serverId) =>
          (serverId === testServer && allowed.has(userId)) ? { userId, serverId, banned: false } : null } };
      }
      if (handlerCaller && request === '../../lib/permissions') {
        return {
          PERMS: { VIEW_CHANNELS: 1, CONNECT: 65536 },
          resolvePermissions: async (userId, serverId) =>
            (serverId === testServer && allowed.has(userId)) ? (1 | 65536) : 0,
          hasPermission: (actual, flag) => (actual & flag) === flag,
        };
      }
      return originalLoad.apply(this, arguments);
    };
    ({ registerSocialRoomHandlers } = require('../dist/socket/handlers/social-room'));
  } finally {
    Module._load = originalLoad;
  }
  if (typeof registerSocialRoomHandlers !== 'function') {
    throw new Error('Production 3D social handler was not loaded');
  }

  const httpServer = createServer();
  const io = new Server(httpServer, {
    transports: ['websocket'], serveClient: false, maxHttpBufferSize: 65536,
  });
  const clients = [];

  function nextEvent(client, event, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        client.off(event, onValue);
        reject(new Error('SOCIAL_3D_SOCKET_TIMEOUT:' + event));
      }, timeoutMs);
      function onValue(value) {
        clearTimeout(deadline);
        resolve(value);
      }
      client.once(event, onValue);
    });
  }

  async function open(user) {
    const port = httpServer.address().port;
    const client = openClient('http://127.0.0.1:' + port, {
      auth: { testUser: user }, transports: ['websocket'],
      reconnection: false, forceNew: true, timeout: 5000,
    });
    clients.push(client);
    if (!client.connected) await nextEvent(client, 'connect');
    assert.equal(typeof client.id, 'string');
    return client;
  }

  async function main() {
    assert.equal(await applyAdapter(io), true, 'Redis Socket.IO adapter must connect');
    assert.equal(isRedisAvailable(), true, 'Real Redis must be connected');
    io.on('connection', socket => {
      // TEST HARNESS ONLY: production authentication is intentionally NOT
      // claimed. Independent server-created rooms are never client controlled.
      const testUser = socket.handshake.auth.testUser;
      const user = typeof testUser === 'string' ? testUser : '';
      socket.join('server:' + testServer);
      registerSocialRoomHandlers(socket, io, user);
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });
    const a = await open('user-a');
    const b = await open('user-b');
    const unauthorized = await open('intruder');

    // Unauthorized participant gets no room snapshot, despite a server room.
    const denied = nextEvent(unauthorized, 'social:error');
    unauthorized.emit('social:join', { serverId: testServer });
    assert.deepEqual(await denied, { code: 'SOCIAL_ROOM_UNAVAILABLE', serverId: testServer });

    const aJoined = nextEvent(a, 'social:joined');
    a.emit('social:join', { serverId: testServer, userId: 'intruder', x: 9999 });
    const first = await aJoined;
    assert.equal(first.peers.length, 1);
    assert.equal(first.peers[0].userId, 'user-a');
    assert.equal(first.peers[0].x, 0);

    const aSeesB = nextEvent(a, 'social:peers');
    const bJoined = nextEvent(b, 'social:joined');
    b.emit('social:join', { serverId: testServer });
    const second = await bJoined;
    assert.deepEqual(second.peers.map(p => p.userId), ['user-a', 'user-b']);
    const published = await aSeesB;
    assert.deepEqual(published.peers.map(p => p.userId), ['user-a', 'user-b']);

    // Movement originates on a real socket, is recalculated on the server,
    // and a DIFFERENT client sees only the authoritative 0.35 step.
    const bSeesStep = nextEvent(b, 'social:peers');
    a.emit('social:step', { serverId: testServer, direction: 'right', x: 5000, z: 5000 });
    const moved = await bSeesStep;
    assert.equal(moved.peers.find(p => p.userId === 'user-a').x, 0.35);
    assert.equal(moved.peers.find(p => p.userId === 'user-a').z, 2.5);

    // Revoke access through the same injected authorization seam. A further
    // event cannot move or publish a revoked user (push eviction is not proven).
    allowed.delete('user-b');
    const bError = nextEvent(b, 'social:error');
    const aSeesRemoval = nextEvent(a, 'social:peers');
    b.emit('social:step', { serverId: testServer, direction: 'left' });
    assert.deepEqual(await bError, { code: 'SOCIAL_ROOM_UNAVAILABLE', serverId: testServer });
    const remaining = await aSeesRemoval;
    assert.deepEqual(remaining.peers.map(p => p.userId), ['user-a']);

    const aLeft = nextEvent(a, 'social:left');
    a.emit('social:leave', { serverId: testServer });
    assert.deepEqual(await aLeft, { serverId: testServer });
    assert.equal((await socialRoomStore.load(testServer)).peers.length, 0);
    console.log('SOCIAL_3D_REAL_SOCKET_CLIENTS_REDIS_OK:2/2:0_skipped');
    console.log('SOCIAL_3D_REAL_SOCKET_UNAUTHORIZED_REVOKED_OK:2/2:0_skipped');
  }

  main().catch(error => {
    console.error('SOCIAL_3D_REAL_SOCKET_PROOF_FAILED:' +
      (error instanceof Error ? error.stack || error.message : String(error)));
    process.exitCode = 1;
  }).finally(async () => {
    for (const c of clients) c.disconnect();
    try { await socialRoomStore.withLock(testServer, () => socialRoomStore.save(testServer, { serverId: testServer, peers: [] })); }
    catch (error) { console.error('SOCIAL_3D_TEST_CLEANUP_FAILED:', error); process.exitCode = 1; }
    await new Promise(resolve => io.close(resolve));
    if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
    await disconnect();
  });
}
