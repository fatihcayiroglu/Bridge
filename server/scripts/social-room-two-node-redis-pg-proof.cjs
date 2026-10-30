#!/usr/bin/env node
'use strict';

/**
 * REAL two-node Socket.IO acceptance, not an in-process pretend cluster:
 *   Parent: disposable PostgreSQL 16 fixtures and TWO child Node processes.
 *   Node A: real HTTP/WebSocket server + real Redis Socket.IO adapter.
 *   Node B: separate HTTP/WebSocket server + separate Redis Socket.IO adapter.
 *   Each socket: actual Bridge JWT verification, token-version DB check,
 *                fresh PostgreSQL member verification and PRODUCTION handler.
 *
 * Client A connected only to node A, client B only to node B. We assert Redis
 * adapter pub/sub broadcasts across node boundaries, state & movement
 * authority, cross-node membership ban and ghost-avatar removal.
 *
 * Deliberate boundary: workers install the SAME narrow authenticated socket
 * harness used in the single-node PG proof, not the entire production app
 * (voice, HTTP routes and browser). Never claim product release readiness.
 *
 * Requires dedicated ephemeral /bridge_social_3d_test DB and real REDIS_URL.
 * No mocked transport/DB/Redis, no retries, no skipped tests or fake green.
 */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const { fork } = require('node:child_process');
const jwt = require('jsonwebtoken');
const { Server } = require('socket.io');
const { io: createClient } = require('socket.io-client');

const TEST_DB = '/bridge_social_3d_test';
if (!process.env.DATABASE_URL?.includes(TEST_DB) ||
    !process.env.REDIS_URL ||
    !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32 ||
    process.env.NODE_ENV === 'production') {
  console.error('SOCIAL_3D_TWO_NODE_PG_REDIS_JWT_PRECONDITIONS_MISSING');
  process.exitCode = 1;
} else {
  const { verifyToken } = require('../dist/middleware/auth');
  const { parseTokenVersion } = require('../dist/lib/tokenVersion');
  const { Members, Users } = require('../dist/db/repositories');
  const db = require('../dist/db/loader').default;
  const { applyAdapter, isRedisAvailable, disconnect } = require('../dist/lib/redisAdapter');
  const { socialRoomStore } = require('../dist/socket/handlers/social-room-store');
  const { registerSocialRoomHandlers } = require('../dist/socket/handlers/social-room');
  const { evictUserFromServerRooms } = require('../dist/lib/liveMembership');

  const roomPrefix = 'social-node-' + randomBytes(7).toString('hex');
  const ids = Object.freeze(process.argv[2] === 'worker'
    ? {
      server: process.env.SOCIAL_3D_CLUSTER_SERVER,
      alice: process.env.SOCIAL_3D_CLUSTER_ALICE,
      bob: process.env.SOCIAL_3D_CLUSTER_BOB,
      outside: process.env.SOCIAL_3D_CLUSTER_OUTSIDE,
    }
    : {
      server: roomPrefix + '-server',
      alice: roomPrefix + '-alice',
      bob: roomPrefix + '-bob',
      outside: roomPrefix + '-outside',
    });
  const sql = (query, args = []) => db._pool.query(query, args);
  const sign = userId => jwt.sign({ id: userId, username: userId, v: 0 },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '2m' });

  function eventFrom(socket, name, timeoutMs = 7000) {
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => {
        socket.off(name, listener);
        reject(new Error('SOCIAL_3D_TWO_NODE_EVENT_TIMEOUT:' + name));
      }, timeoutMs);
      function listener(value) {
        clearTimeout(deadline);
        resolve(value);
      }
      socket.once(name, listener);
    });
  }

  async function workerMain() {
    const http = createServer();
    const io = new Server(http, {
      transports: ['websocket'],
      serveClient: false,
      maxHttpBufferSize: 65536,
    });
    try {
      assert.equal(await applyAdapter(io), true, 'Redis adapter must initialize');
      assert.equal(isRedisAvailable(), true, 'Redis must remain authoritative');
      io.use(async (socket, next) => {
        try {
          const decoded = verifyToken(socket.handshake.auth.token);
          if (!decoded || typeof decoded.id !== 'string') return next(new Error('Unauthorized'));
          const row = await Users.findById(decoded.id);
          if (!row || parseTokenVersion(row.tokenVersion) !== decoded.v) {
            return next(new Error('Token revoked'));
          }
          socket.data.verifiedUserId = decoded.id;
          next();
        } catch { next(new Error('Auth failed')); }
      });
      io.on('connection', async socket => {
        try {
          const userId = socket.data.verifiedUserId;
          await socket.join('user:' + userId);
          if (await Members.findOne(userId, ids.server)) {
            await socket.join('server:' + ids.server);
          }
          registerSocialRoomHandlers(socket, io, userId);
          // Harness-only ready event after production handler registration.
          socket.emit('social:test-ready');
        } catch (error) {
          socket.disconnect(true);
          process.stderr.write('SOCIAL_3D_WORKER_AUTH_SETUP_FAILED:' + String(error) + '\n');
        }
      });
      await new Promise((resolve, reject) => {
        http.once('error', reject);
        http.listen(0, '127.0.0.1', resolve);
      });
      process.send({ type: 'ready', port: http.address().port });
      process.on('message', async message => {
        if (!message || typeof message !== 'object' || typeof message.id !== 'number') return;
        const reply = (result, error) => {
          process.send({ type: 'reply', id: message.id, result, error });
        };
        try {
          if (message.action === 'revoke') {
            if (message.userId !== ids.bob) throw Error('Invalid targeted user');
            // This is the same existing server-side membership eviction that
            // Bridge role/kick routes invoke, executed on node A while Bob's
            // socket is owned by node B.
            const leaves = await evictUserFromServerRooms(io, ids.bob, ids.server);
            reply({ leaves }, null);
          } else if (message.action === 'remoteRooms') {
            const sockets = await io.in('user:' + ids.bob).fetchSockets();
            reply(sockets.map(s => ({
              id: s.id, rooms: [...s.rooms],
            })), null);
          } else if (message.action === 'shutdown') {
            reply({ stopped: true }, null);
            // Allow Socket.IO disconnect handlers to complete before closing
            // the shared Redis adapter; do not conceal any runtime failures.
            await new Promise(resolve => io.close(resolve));
            await db._pool.end();
            await disconnect();
            process.exitCode = 0;
            // Parent observes a real completed worker exit. No SIGTERM before
            // the worker has drained its DB and Redis clients.
            process.disconnect();
          } else throw Error('Unknown worker command');
        } catch (error) {
          reply(null, String(error instanceof Error ? error.stack || error.message : error));
          process.exitCode = 1;
        }
      });
    } catch (error) {
      process.stderr.write('SOCIAL_3D_TWO_NODE_WORKER_BOOT_FAILED:' +
        String(error instanceof Error ? error.stack || error.message : error) + '\n');
      process.exitCode = 1;
      try { await db._pool.end(); } catch {}
      try { await disconnect(); } catch {}
    }
  }

  function startWorker(label) {
    const child = fork(__filename, ['worker'], {
      env: { ...process.env, BRIDGE_SOCIAL_3D_MULTIPLAYER: '1', SOCIAL_3D_CLUSTER_SERVER: ids.server,
        SOCIAL_3D_CLUSTER_ALICE: ids.alice, SOCIAL_3D_CLUSTER_BOB: ids.bob,
        SOCIAL_3D_CLUSTER_OUTSIDE: ids.outside,
      },
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    const detail = { label, child, logs: '', pending: new Map(), counter: 0, dead: false };
    child.stdout.on('data', data => { detail.logs = (detail.logs + data.toString()).slice(-5000); });
    child.stderr.on('data', data => { detail.logs = (detail.logs + data.toString()).slice(-5000); });
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(label + ' worker boot timeout ' + detail.logs)), 12000);
      child.on('error', error => { clearTimeout(timeout); reject(error); });
      child.on('exit', (code, signal) => {
        detail.dead = true;
        clearTimeout(timeout);
        reject(new Error(label + ' worker died: ' + code + '/' + signal + ' ' + detail.logs));
        for (const entry of detail.pending.values()) {
          clearTimeout(entry.timeout);
          entry.reject(new Error(label + ' worker died while waiting for reply'));
        }
        detail.pending.clear();
      });
      child.on('message', msg => {
        if (msg?.type === 'ready') {
          clearTimeout(timeout);
          resolve(msg.port);
        } else if (msg?.type === 'reply') {
          const pending = detail.pending.get(msg.id);
          if (!pending) return;
          clearTimeout(pending.timeout);
          detail.pending.delete(msg.id);
          if (msg.error) pending.reject(Error(label + ' command failed: ' + msg.error));
          else pending.resolve(msg.result);
        }
      });
    });
    function command(action, extra = {}) {
      if (detail.dead) return Promise.reject(Error(label + ' worker already dead'));
      const id = ++detail.counter;
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          detail.pending.delete(id);
          reject(new Error(label + ' IPC command timeout: ' + action));
        }, 10000);
        detail.pending.set(id, { resolve, reject, timeout });
        child.send({ id, action, ...extra });
      });
    }
    const exit = new Promise((resolve, reject) => {
      child.once('exit', (code, signal) => {
        if (code === 0 && !signal) resolve();
        else reject(Error(label + ' shutdown failed: ' + code + '/' + signal + ' ' + detail.logs));
      });
    });
    return { ...detail, ready, command, exit };
  }

  // IPC env values are never taken from a user socket. The room and all test
  // account identifiers are created by the orchestrator in a disposable DB.
  if (process.argv[2] === 'worker') {
    workerMain();
  } else {
    const clients = [];
    const workers = [];
    let seeded = false;
    async function seed() {
      await db._initSchema();
      seeded = true;
      for (const userId of [ids.alice, ids.bob, ids.outside]) {
        await sql('INSERT INTO users (_id, username, "displayName", password, "tokenVersion", "createdAt") VALUES ($1,$2,$3,$4,0,$5)',
          [userId, userId, '3D Two Node Test', 'synthetic-test-only', Date.now()]);
      }
      await sql('INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,$4)',
        [ids.server, '3D Two Node Acceptance', ids.alice, Date.now()]);
      for (const userId of [ids.alice, ids.bob]) {
        await sql('INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned) VALUES ($1,$2,$3::jsonb,$4,FALSE)',
          [userId, ids.server, '[]', Date.now()]);
      }
    }
    async function connect(port, userId) {
      const client = createClient('http://127.0.0.1:' + port, {
        auth: { token: sign(userId) },
        transports: ['websocket'],
        forceNew: true, reconnection: false, timeout: 6000,
      });
      clients.push(client);
      const ready = eventFrom(client, 'social:test-ready');
      await ready;
      assert.equal(typeof client.id, 'string');
      return client;
    }
    async function run() {
      await seed();
      // The orchestrator also uses the real Redis authoritative state, but it
      // does NOT run an HTTP/Socket.IO server itself.
      assert.equal(await applyAdapter({}), true);
      const nodeA = startWorker('A');
      workers.push(nodeA);
      const nodeB = startWorker('B');
      workers.push(nodeB);
      const [portA, portB] = await Promise.all([nodeA.ready, nodeB.ready]);
      assert.notEqual(portA, portB, 'two actual separate network listeners');

      const alice = await connect(portA, ids.alice);
      const bob = await connect(portB, ids.bob);
      const outsider = await connect(portB, ids.outside);
      assert.notEqual(alice.id, bob.id);

      const outsiderDenied = eventFrom(outsider, 'social:error');
      outsider.emit('social:join', { serverId: ids.server });
      assert.deepEqual(await outsiderDenied, { code: 'SOCIAL_ROOM_UNAVAILABLE' });

      // A join emits a targeted social:joined acknowledgement AND a room
      // social:peers broadcast. Consume/assert both, not just the ack: Redis
      // pub/sub can deliver the older snapshot AFTER the targeted ack.
      const aliceJoined = eventFrom(alice, 'social:joined');
      const aliceSelfRoster = eventFrom(alice, 'social:peers');
      alice.emit('social:join', { serverId: ids.server });
      assert.deepEqual((await aliceJoined).peers.map(p => p.userId), [ids.alice]);
      assert.deepEqual((await aliceSelfRoster).peers.map(p => p.userId), [ids.alice]);

      const aliceSeesBob = eventFrom(alice, 'social:peers');
      const bobJoined = eventFrom(bob, 'social:joined');
      const bobOwnRoster = eventFrom(bob, 'social:peers');
      bob.emit('social:join', { serverId: ids.server });
      const bSnapshot = await bobJoined;
      assert.deepEqual(bSnapshot.peers.map(p => p.userId), [ids.alice, ids.bob]);
      assert.deepEqual((await bobOwnRoster).peers.map(p => p.userId), [ids.alice, ids.bob]);
      const crossJoin = await aliceSeesBob;
      assert.deepEqual(crossJoin.peers.map(p => p.userId), [ids.alice, ids.bob]);

      const bobSeesMovement = eventFrom(bob, 'social:peers');
      alice.emit('social:step', { serverId: ids.server, direction: 'right', x: 99999, z: 99999 });
      const movement = await bobSeesMovement;
      assert.equal(movement.peers.find(p => p.userId === ids.alice).x, 0.35,
        'remote node must receive authoritative position');
      assert.equal(movement.peers.find(p => p.userId === ids.alice).z, 2.5);

      // Ban Bob in the actual PostgreSQL membership row while his live
      // connection remains on node B. Invoke membership eviction from A.
      await sql('UPDATE members SET banned=TRUE WHERE "userId"=$1 AND "serverId"=$2', [ids.bob, ids.server]);
      const bobRevoked = eventFrom(bob, 'membership:revoked');
      const aliceSeesBan = eventFrom(alice, 'social:peers');
      const removal = await nodeA.command('revoke', { userId: ids.bob });
      assert.equal(typeof removal.leaves, 'number');
      assert.deepEqual(await bobRevoked, { serverId: ids.server });
      assert.deepEqual((await aliceSeesBan).peers.map(p => p.userId), [ids.alice]);
      const remoteSockets = await nodeA.command('remoteRooms');
      assert.equal(remoteSockets.length, 1,
        'node A must discover Bob owned by node B over Redis Socket.IO adapter');
      assert.equal(remoteSockets[0].id, bob.id);
      assert.equal(remoteSockets[0].rooms.includes('social-3d:' + ids.server), false);
      assert.deepEqual((await socialRoomStore.load(ids.server)).peers.map(p => p.userId),
        [ids.alice], 'ghost avatar must be removed in authoritative Redis');

      // A client's membership loss cannot mutate the authoritative shared
      // room again after the cross-node revoke.
      const revokedError = eventFrom(bob, 'social:error');
      bob.emit('social:step', { serverId: ids.server, direction: 'left' });
      assert.deepEqual(await revokedError, { code: 'SOCIAL_ROOM_UNAVAILABLE' });

      const aliceLeft = eventFrom(alice, 'social:left');
      alice.emit('social:leave', { serverId: ids.server });
      assert.deepEqual(await aliceLeft, { serverId: ids.server });
      assert.deepEqual((await socialRoomStore.load(ids.server)).peers, []);
      process.stdout.write('SOCIAL_3D_REAL_TWO_NODE_SOCKET_IO_BROADCAST:2/2:0_skipped\n');
      process.stdout.write('SOCIAL_3D_REAL_TWO_NODE_POSTGRES_BAN_EVICTION:2/2:0_skipped\n');
    }

    run().catch(error => {
      process.stderr.write('SOCIAL_3D_TWO_NODE_ACCEPTANCE_FAILED:' +
        String(error instanceof Error ? error.stack || error.message : error) + '\n');
      process.exitCode = 1;
    }).finally(async () => {
      for (const client of clients) client.disconnect();
      // Keep redis available to drain disconnect handlers prior to cleanup.
      for (const worker of workers) {
        if (worker.dead) continue;
        try { await worker.command('shutdown'); }
        catch (error) {
          process.stderr.write('SOCIAL_3D_TWO_NODE_WORKER_SHUTDOWN_FAILED:' + error + '\n');
          process.exitCode = 1;
          worker.child.kill('SIGKILL');
        }
      }
      for (const worker of workers) {
        if (worker.dead) continue;
        try { await worker.exit; }
        catch (error) {
          process.stderr.write('SOCIAL_3D_TWO_NODE_WORKER_EXIT_FAILED:' + error + '\n');
          process.exitCode = 1;
          worker.child.kill('SIGKILL');
        }
      }
      try {
        await socialRoomStore.withLock(ids.server,
          () => socialRoomStore.save(ids.server, { serverId: ids.server, peers: [] }));
      } catch (error) {
        process.stderr.write('SOCIAL_3D_TWO_NODE_REDIS_CLEANUP_FAILED:' + error + '\n');
        process.exitCode = 1;
      }
      if (seeded) {
        for (const [query, args] of [
          ['DELETE FROM members WHERE "serverId"=$1', [ids.server]],
          ['DELETE FROM servers WHERE _id=$1', [ids.server]],
          ['DELETE FROM users WHERE _id = ANY($1::text[])', [[ids.alice, ids.bob, ids.outside]]],
        ]) {
          try { await sql(query, args); }
          catch (error) { process.stderr.write('SOCIAL_3D_TWO_NODE_PG_CLEANUP_FAILED:' + error + '\n'); process.exitCode = 1; }
        }
      }
      try { await db._pool.end(); } catch (error) { process.exitCode = 1; }
      try { await disconnect(); } catch (error) { process.exitCode = 1; }
    });
  }
}
