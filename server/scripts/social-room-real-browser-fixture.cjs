#!/usr/bin/env node
'use strict';

/**
 * Isolated real-service browser fixture. This is the production Socket.IO
 * bootstrap (not a fake transport), running with disposable PG16+Redis7.
 * Only the HTTP document and fixture identities are test-specific.
 */
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const jwt = require('jsonwebtoken');

if (!process.send || !process.env.DATABASE_URL?.includes('/bridge_social_3d_test') ||
    !process.env.REDIS_URL || process.env.BRIDGE_SOCIAL_3D_MULTIPLAYER !== '1' ||
    process.env.NODE_ENV === 'production' ||
    !process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  console.error('SOCIAL_3D_BROWSER_FIXTURE_PRECONDITIONS_MISSING');
  process.exit(1);
}

const db = require('../dist/db/loader').default;
const { createSocketServer } = require('../dist/app/setupSocket');
const { setupSocket } = require('../dist/socket/index');
const { applyAdapter, disconnect, isRedisAvailable } = require('../dist/lib/redisAdapter');
const { socialRoomStore } = require('../dist/socket/handlers/social-room-store');
const { evictUserFromServerRooms } = require('../dist/lib/liveMembership');
const testId = 'social_browser_' + randomBytes(6).toString('hex');
const serverId = testId + '_server';
const alice = testId + '_alice';
const bob = testId + '_bob';
const users = [alice, bob];
const q = (sql, args = []) => db._pool.query(sql, args);
let seeded = false;
let io;
// Only the real authored Activities entry element is extracted from the
// shipped HTML, not a test recreation. No app-wide JS or fake REST APIs run.
const realIndex = fs.readFileSync(path.resolve(__dirname, '../../client/index.html'), 'utf8');
const opener = realIndex.match(/<button\b[^>]*\bid="bridge-activities-entry"[\s\S]*?<\/button>/);
assert.ok(opener && opener.length === 1, 'real shipped Activities opener must exist');
const cssPath = path.resolve(__dirname, '../../client/dist/css/style.css');
assert.ok(fs.existsSync(cssPath), 'real production CSS build is required');
// The test-only document is intentionally not the entire authenticated app.
// It contains the original markup, actual built stylesheet and strict CSP.
const shippedShell = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">' +
  '<link rel="stylesheet" href="/__bridge-shipped-style.css"></head><body>' +
  '<main id="app" class="app" style="display:flex">' + opener[0] + '</main>' +
  '</body></html>';
const strictCsp = [
  "default-src 'self'", "script-src 'self'", "style-src 'self'",
  "style-src-elem 'self'", "style-src-attr 'unsafe-inline'",
  "connect-src 'self' ws:", "img-src 'self' data:", "object-src 'none'",
  "base-uri 'none'", "frame-ancestors 'none'",
].join('; ');
const httpServer = createServer((request, response) => {
  if (request.url === '/__bridge-shipped-shell') {
    response.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store',
      'Content-Security-Policy': strictCsp, 'X-Content-Type-Options': 'nosniff',
    });
    response.end(shippedShell);
    return;
  }
  if (request.url === '/__bridge-shipped-style.css') {
    response.writeHead(200, {
      'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    response.end(fs.readFileSync(cssPath));
    return;
  }
  if (request.url === '/') {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end('<!doctype html><html><head><title>Bridge 3D real browser test</title></head><body></body></html>');
    return;
  }
  response.writeHead(404); response.end();
});

async function cleanup() {
  let failed = false;
  try { if (io) await new Promise(resolve => io.close(resolve)); }
  catch (e) { failed = true; console.error('SOCIAL_BROWSER_SOCKET_CLEANUP_FAILED', e); }
  try {
    if (httpServer.listening) await new Promise(resolve => httpServer.close(resolve));
  } catch (e) { failed = true; console.error('SOCIAL_BROWSER_HTTP_CLEANUP_FAILED', e); }
  try {
    if (seeded) {
      await socialRoomStore.withLock(serverId, () =>
        socialRoomStore.save(serverId, { serverId, peers: [] }));
    }
  } catch (e) { failed = true; console.error('SOCIAL_BROWSER_REDIS_CLEANUP_FAILED', e); }
  if (seeded) for (const [query, args] of [
    ['DELETE FROM members WHERE "serverId"=$1', [serverId]],
    ['DELETE FROM servers WHERE _id=$1', [serverId]],
    ['DELETE FROM users WHERE _id = ANY($1::text[])', [users]],
  ]) {
    try { await q(query, args); }
    catch (e) { failed = true; console.error('SOCIAL_BROWSER_PG_CLEANUP_FAILED', e); }
  }
  try { await db._pool.end(); } catch (e) { failed = true; console.error(e); }
  try { await disconnect(); } catch (e) { failed = true; console.error(e); }
  return !failed;
}

async function main() {
  await db._initSchema();
  seeded = true;
  const now = Date.now();
  for (const id of users) await q(
    'INSERT INTO users (_id, username, "displayName", password, "tokenVersion", "createdAt") VALUES ($1,$2,$3,$4,0,$5)',
    [id, id, 'Browser Social Test', 'test-only-synthetic-password', now],
  );
  await q('INSERT INTO servers (_id, name, "ownerId", "createdAt") VALUES ($1,$2,$3,$4)',
    [serverId, '3D browser integration', alice, now]);
  for (const id of users) await q(
    'INSERT INTO members ("userId", "serverId", roles, "joinedAt", banned) VALUES ($1,$2,$3::jsonb,$4,FALSE)',
    [id, serverId, '[]', now],
  );
  io = createSocketServer(httpServer, ['http://127.0.0.1']);
  assert.equal(await applyAdapter(io), true);
  assert.equal(isRedisAvailable(), true);
  setupSocket(io);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const token = id => jwt.sign({ id, username: id, v: 0 }, process.env.JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '2m' });
  process.send({ type: 'ready', port: httpServer.address().port,
    serverId, aliceToken: token(alice), bobToken: token(bob) });
}

process.on('message', async msg => {
  if (msg?.type === 'revokeBob') {
    try {
      // Mutate REAL PostgreSQL membership and run the same production
      // cross-room revocation as a server kick/ban (not a client-side fake).
      const changed = await q(
        'UPDATE members SET banned=TRUE WHERE "serverId"=$1 AND "userId"=$2 RETURNING "userId"',
        [serverId, bob],
      );
      assert.equal(changed.rowCount, 1, 'real membership row must be revoked');
      const leaves = await evictUserFromServerRooms(io, bob, serverId);
      const roster = await socialRoomStore.load(serverId);
      const sockets = await io.in('user:' + bob).fetchSockets();
      process.send({
        type: 'bobRevoked', leaves,
        rosterUserIds: roster.peers.map(p => p.userId),
        bobSockets: sockets.length,
        bobInSocialAudience: sockets.some(s => s.rooms.has('social-3d:' + serverId)),
        bobInServerAudience: sockets.some(s => s.rooms.has('server:' + serverId)),
      });
    } catch (error) {
      console.error('SOCIAL_BROWSER_MEMBERSHIP_REVOKE_FAILED', error?.stack || error);
      process.send({ type: 'bobRevokeFailed' });
    }
    return;
  }
  if (msg?.type !== 'shutdown') return;
  const ok = await cleanup();
  process.send({ type: 'stopped', ok });
  process.disconnect();
  if (!ok) process.exitCode = 1;
});
main().catch(async error => {
  console.error('SOCIAL_BROWSER_FIXTURE_BOOT_FAILED:', error?.stack || error);
  await cleanup();
  process.exitCode = 1;
  process.disconnect();
});
