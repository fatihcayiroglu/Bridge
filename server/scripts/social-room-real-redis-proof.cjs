#!/usr/bin/env node
'use strict';

// REAL Redis evidence. Two separate Node processes must observe and mutate the
// same 3D social room through the production Redis adapter + distributed lock.
// No mocks, ignored failures, retries or in-process Redis substitutes.
// Requires server production build and REDIS_URL (CI: Redis service).

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { randomBytes } = require('node:crypto');

if (!process.env.REDIS_URL) {
  console.error('SOCIAL_3D_REDIS_PROOF_NO_CONFIGURED_REDIS');
  process.exitCode = 1;
} else {
  const { applyAdapter, disconnect, isRedisAvailable } = require('../dist/lib/redisAdapter.js');
  const { socialRoomStore } = require('../dist/socket/handlers/social-room-store.js');

  async function initialize() {
    assert.equal(await applyAdapter({}), true, 'real Redis adapter must connect');
    assert.equal(isRedisAvailable(), true, 'real Redis must be authoritative');
  }
  async function worker(serverId, identity) {
    await initialize();
    await socialRoomStore.withLock(serverId, async () => {
      const room = await socialRoomStore.load(serverId);
      assert.equal(room.peers.some(peer => peer.socketId === identity), false);
      // Hold the shared lock long enough to overlap the second real process.
      await new Promise(resolve => setTimeout(resolve, 160));
      room.peers.push({
        socketId: identity, userId: 'probe-' + identity,
        x: identity === 'process-a' ? -0.35 : 0.35, z: 2.5,
        lastStepAt: 0,
      });
      await socialRoomStore.save(serverId, room);
    });
    process.stdout.write('SOCIAL_3D_REDIS_WORKER_OK:' + identity + '\n');
  }

  function launch(serverId, identity) {
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [__filename, 'worker', serverId, identity], {
        env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stdout = '';
      let stderr = '';
      const watchdog = setTimeout(() => child.kill('SIGKILL'), 12000);
      child.stdout.on('data', chunk => { stdout = (stdout + chunk.toString()).slice(-4000); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
      child.on('error', reject);
      child.on('exit', (code, signal) => {
        clearTimeout(watchdog);
        if (code !== 0 || signal || !stdout.includes('SOCIAL_3D_REDIS_WORKER_OK:' + identity)) {
          reject(new Error('Real Redis worker failed: ' + identity + ' exit=' + code +
            ' signal=' + signal + ' stderr=' + stderr.slice(-1000)));
        } else resolve();
      });
    });
  }

  async function main() {
    const mode = process.argv[2];
    if (mode === 'worker') {
      await worker(process.argv[3], process.argv[4]);
      return;
    }
    const serverId = 'social-proof-' + Date.now() + '-' + randomBytes(3).toString('hex');
    await initialize();
    try {
      await Promise.all([launch(serverId, 'process-a'), launch(serverId, 'process-b')]);
      const room = await socialRoomStore.load(serverId);
      const ids = room.peers.map(p => p.socketId).sort();
      assert.deepEqual(ids, ['process-a', 'process-b'],
        'two independent Redis-connected processes must retain both writes');
      assert.deepEqual(room.peers.map(p => p.x).sort(), [-0.35, 0.35],
        'one shared state, not separate process-local fallbacks');
      process.stdout.write('SOCIAL_3D_REAL_REDIS_TWO_PROCESS_OK:2/2:0_skipped\n');
    } finally {
      await socialRoomStore.withLock(serverId, async () => {
        await socialRoomStore.save(serverId, { serverId, peers: [] });
      });
    }
  }

  main().catch(err => {
    console.error('SOCIAL_3D_REAL_REDIS_FAILED:' + (err instanceof Error ? err.message : String(err)));
    process.exitCode = 1;
  }).finally(async () => { await disconnect(); });
}
