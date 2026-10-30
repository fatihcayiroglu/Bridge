#!/usr/bin/env node
'use strict';

/**
 * REAL PostgreSQL 16 + Redis 7 + Socket.IO transport + Bridge JWT verification.
 * No test seam replaces Members.findOne or resolvePermissions: both are the
 * production repository and permission resolver.
 *
 * Narrow claim: an isolated Socket.IO harness uses real Bridge JWT verification
 * and DB token-version checks, but it is NOT the full production socket boot
 * middleware, website, phone, or an automatic membership-eviction push.
 *
 * Must run ONLY against a dedicated ephemeral test database. No retry/skip.
 */
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const { createServer } = require('node:http');
const { Server } = require('socket.io');
const { io: openClient } = require('socket.io-client');
const jwt = require('jsonwebtoken');

if (!process.env.DATABASE_URL?.includes('/bridge_social_3d_test') ||
    !process.env.REDIS_URL || process.env.NODE_ENV === 'test' ||
    !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('SOCIAL_3D_REAL_PG_REDIS_JWT_PRECONDITIONS_MISSING');
  process.exitCode = 1;
} else {
  const db = require('../dist/db/loader').default;
  const { Members, Users } = require('../dist/db/repositories');
  const { verifyToken } = require('../dist/middleware/auth');
  const { parseTokenVersion } = require('../dist/lib/tokenVersion');
  const { registerSocialRoomHandlers } = require('../dist/socket/handlers/social-room');
  const { socialRoomStore } = require('../dist/socket/handlers/social-room-store');
  const { applyAdapter, disconnect, isRedisAvailable } = require('../dist/lib/redisAdapter');
  const run = 'social_pg_' + randomBytes(6).toString('hex');
  const ids = {
    a: run + '_a', b: run + '_b', outsider: run + '_outsider',
    server: run + '_server',
  };
  const httpServer = createServer();
  const io = new Server(httpServer, {
    transports: ['websocket'], serveClient: false, maxHttpBufferSize: 65536,
  });
  const clients = [];
  let seeded = false;

  function waitForEvent(socket, name, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.off(name, onValue);
        reject(new Error('SOCIAL_3D_REAL_PG_EVENT_TIMEOUT:' + name));
      }, timeout);
      function onValue(value) { clearTimeout(timer); resolve(value); }
      socket.once(name, onValue);
    });
  }

  const q = (sql, params = []) => db._pool.query(sql, params);
  function tokenFor(userId, secret = process.env.JWT_SECRET) {
    // Actual jwt.verify is production code; deliberately short-lived tokens.
    return jwt.sign({ id: userId, username: userId, v: 0 }, secret, {
      algorithm: 'HS256', expiresIn: '2m',
    });
  }

  async function connect(token, expectSuccess = true) {
    const port = httpServer.address().port;
    const socket = openClient('http://127.0.0.1:' + port, {
      auth: { token }, transports: ['websocket'], forceNew: true,
      reconnection: false, timeout: 5000,
    });
    clients.push(socket);
    const ready = expectSuccess ? waitForEvent(socket, 'social:test-ready') : null;
    const outcome = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SOCIAL_3D_REAL_PG_SOCKET_TIMEOUT')), 5000);
      socket.once('connect', () => { clearTimeout(timer); resolve('connected'); });
      socket.once('connect_error', () => { clearTimeout(timer); resolve('denied'); });
    });
    assert.equal(outcome, expectSuccess ? 'connected' : 'denied');
    if (ready) await ready;
    return socket;
  }

  async function seed() {
    await db._initSchema();
    const createdAt = Date.now();
    seeded = true;
    for (const [suffix, userId] of Object.entries({
      a: ids.a, b: ids.b, outsider: ids.outsider,
    })) {
      await q(
        'INSERT INTO users (_id, username, "displayName", password, "tokenVersion", "createdAt") ' +
        'VALUES ($1,$2,$3,$4,0,$5)',
        [userId, userId, 'Social Test ' + suffix, 'test-only-not-a-login-password', createdAt],
      );
    }
    await q(
      'INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,$4)',
      [ids.server, 'Isolated 3D Social Test', ids.a, createdAt],
    );
    for (const userId of [ids.a, ids.b]) {
      await q(
        'INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned) ' +
        'VALUES ($1,$2,$3::jsonb,$4,FALSE)',
        [userId, ids.server, '[]', createdAt],
      );
    }
  }

  async function runProof() {
    await seed();
    assert.equal(await applyAdapter(io), true);
    assert.equal(isRedisAvailable(), true);
    // Narrow harness. Uses the production cryptographic verifier and fresh
    // persisted user/token-version check, no mock auth or membership records.
    io.use(async (socket, next) => {
      try {
        const decoded = verifyToken(socket.handshake.auth.token);
        if (!decoded || typeof decoded.id !== 'string') return next(new Error('Unauthorized'));
        const user = await Users.findById(decoded.id);
        if (!user || parseTokenVersion(user.tokenVersion) !== decoded.v) {
          return next(new Error('Token revoked'));
        }
        socket.data.bridgeTestUserId = decoded.id;
        next();
      } catch { next(new Error('Auth failed')); }
    });
    io.on('connection', async socket => {
      try {
        const userId = socket.data.bridgeTestUserId;
        if (await Members.findOne(userId, ids.server)) await socket.join('server:' + ids.server);
        registerSocialRoomHandlers(socket, io, userId);
        // Harness-only ready signal after the real DB-based membership join.
        socket.emit('social:test-ready');
      } catch {
        socket.disconnect(true);
      }
    });
    await new Promise((resolve, reject) => {
      httpServer.once('error', reject);
      httpServer.listen(0, '127.0.0.1', resolve);
    });

    // Invalid signatures and nonexistent users must be rejected *before*
    // joining the transport. The latter is validly signed, but has no DB row.
    await connect(tokenFor(ids.a, 'different-test-signing-secret-32chars'), false);
    await connect(tokenFor(run + '_absent'), false);
    const a = await connect(tokenFor(ids.a));
    const b = await connect(tokenFor(ids.b));
    const outsider = await connect(tokenFor(ids.outsider));

    const denial = waitForEvent(outsider, 'social:error');
    outsider.emit('social:join', { serverId: ids.server });
    assert.deepEqual(await denial, { code: 'SOCIAL_ROOM_UNAVAILABLE' });

    const firstJoin = waitForEvent(a, 'social:joined');
    a.emit('social:join', { serverId: ids.server, userId: ids.outsider, x: 9999 });
    const first = await firstJoin;
    assert.deepEqual(first.peers.map(p => p.userId), [ids.a]);

    const aSeesB = waitForEvent(a, 'social:peers');
    const secondJoin = waitForEvent(b, 'social:joined');
    b.emit('social:join', { serverId: ids.server });
    const second = await secondJoin;
    assert.deepEqual(second.peers.map(p => p.userId), [ids.a, ids.b]);
    const shared = await aSeesB;
    assert.deepEqual(shared.peers.map(p => p.userId), [ids.a, ids.b]);

    const bSeesStep = waitForEvent(b, 'social:peers');
    a.emit('social:step', { serverId: ids.server, direction: 'right', x: 99999 });
    const stepped = await bSeesStep;
    const position = stepped.peers.find(p => p.userId === ids.a);
    assert.equal(position.x, 0.35);
    assert.equal(position.z, 2.5);

    // Persisted membership ban must take effect at the next movement request.
    await q(
      'UPDATE members SET banned = TRUE WHERE "userId"=$1 AND "serverId"=$2',
      [ids.b, ids.server],
    );
    assert.equal(await Members.findOne(ids.b, ids.server), null);
    const onError = waitForEvent(b, 'social:error');
    const aSeesEviction = waitForEvent(a, 'social:peers');
    b.emit('social:step', { serverId: ids.server, direction: 'left' });
    assert.deepEqual(await onError, { code: 'SOCIAL_ROOM_UNAVAILABLE' });
    assert.deepEqual((await aSeesEviction).peers.map(p => p.userId), [ids.a]);

    // Revoking access during an already active connection also blocks join.
    const forbidden = waitForEvent(b, 'social:error');
    b.emit('social:join', { serverId: ids.server });
    assert.deepEqual(await forbidden, { code: 'SOCIAL_ROOM_UNAVAILABLE' });

    const left = waitForEvent(a, 'social:left');
    a.emit('social:leave', { serverId: ids.server });
    assert.deepEqual(await left, { serverId: ids.server });
    assert.equal((await socialRoomStore.load(ids.server)).peers.length, 0);
    console.log('SOCIAL_3D_REAL_POSTGRES_JWT_REDIS_SOCKET:2/2:0_skipped');
    console.log('SOCIAL_3D_REAL_POSTGRES_BAN_EVICTION:1/1:0_skipped');
  }

  runProof().catch(error => {
    console.error('SOCIAL_3D_REAL_PG_JWT_PROOF_FAILED:' +
      (error instanceof Error ? error.stack || error.message : String(error)));
    process.exitCode = 1;
  }).finally(async () => {
    for (const client of clients) client.disconnect();
    try {
      await socialRoomStore.withLock(ids.server, () => socialRoomStore.save(ids.server, { serverId: ids.server, peers: [] }));
    } catch (error) {
      console.error('SOCIAL_3D_PG_PROOF_REDIS_CLEANUP_FAILED:', error);
      process.exitCode = 1;
    }
    await new Promise(resolve => io.close(resolve));
    if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
    if (seeded) {
      // Delete only rows created for this run, never truncate production data.
      for (const [sql, params] of [
        ['DELETE FROM members WHERE "serverId"=$1', [ids.server]],
        ['DELETE FROM servers WHERE _id=$1', [ids.server]],
        ['DELETE FROM users WHERE _id = ANY($1::text[])', [[ids.a, ids.b, ids.outsider]]],
      ]) {
        try { await q(sql, params); } catch (error) {
          console.error('SOCIAL_3D_PG_PROOF_PG_CLEANUP_FAILED:', error);
          process.exitCode = 1;
        }
      }
    }
    await db._pool.end();
    await disconnect();
  });
}
