#!/usr/bin/env node
/**
 * REAL browser + REAL production social client + REAL WebGL GPU execution +
 * REAL Bridge Socket.IO middleware + disposable PostgreSQL 16 and Redis 7.
 * Two isolated Chromium pages use independent signed test accounts.
 *
 * Not physical Android/iPhone hardware, production HTTP routes or voice chat.
 * No test retries, mocks, skipped GPU contexts or synthetic Socket.IO.
 */
import { chromium } from '@playwright/test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { fork } from 'node:child_process';
import assert from 'node:assert/strict';

const require = createRequire(import.meta.url);
const esbuild = require('../../node_modules/esbuild');
const entry = fileURLToPath(new URL('./social-room-browser-entry.ts', import.meta.url));
const workerPath = fileURLToPath(new URL('../../server/scripts/social-room-real-browser-fixture.cjs', import.meta.url));
const built = await esbuild.build({
  entryPoints: [entry], bundle: true, write: false,
  platform: 'browser', target: 'chrome110', format: 'iife',
  globalName: 'BridgeSocialRealBrowser',
});
assert.equal(built.outputFiles.length, 1, 'actual browser client must bundle');
if (!process.env.DATABASE_URL?.includes('/bridge_social_3d_test') ||
    !process.env.REDIS_URL || process.env.NODE_ENV === 'production') {
  throw Error('Real browser acceptance requires ephemeral PG16/Redis7 service URLs');
}

const worker = fork(workerPath, [], {
  env: { ...process.env, NODE_ENV: 'integration', BRIDGE_SOCIAL_3D_MULTIPLAYER: '1' },
  stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
});
let workerLogs = '';
worker.stdout.on('data', x => { workerLogs = (workerLogs + x.toString()).slice(-12000); });
worker.stderr.on('data', x => { workerLogs = (workerLogs + x.toString()).slice(-12000); });
let stoppedResolve;
const stopped = new Promise(resolve => { stoppedResolve = resolve; });
let bootSettled = false;
const ready = new Promise((resolve, reject) => {
  const deadline = setTimeout(() => reject(Error('real socket fixture boot timed out: ' + workerLogs)), 20000);
  worker.on('message', msg => {
    if (msg?.type === 'ready') {
      if (bootSettled) return;
      bootSettled = true; clearTimeout(deadline); resolve(msg);
    } else if (msg?.type === 'stopped') stoppedResolve(msg.ok);
  });
  worker.once('exit', (code, signal) => {
    if (!bootSettled) { bootSettled = true; clearTimeout(deadline); reject(Error('real fixture exited: ' + code + '/' + signal + workerLogs)); }
  });
  worker.once('error', e => { if (!bootSettled) { bootSettled = true; clearTimeout(deadline); reject(e); } });
});
let browser = null;
const pages = [];
try {
  const fixture = await ready;
  browser = await chromium.launch({
    headless: true, channel: 'chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  async function openSession(token, webgl1, expectedPeers) {
    const context = await browser.newContext({ viewport: { width: 770, height: 520 } });
    const page = await context.newPage();
    pages.push({ page, context });
    await page.goto('http://127.0.0.1:' + fixture.port + '/');
    await page.addScriptTag({ content: built.outputFiles[0].text });
    await page.evaluate(({ port, token, serverId, webgl1 }) => {
      window.BridgeSocialRealBrowser.mountSocialBrowser(port, token, serverId, webgl1);
    }, { port: fixture.port, token, serverId: fixture.serverId, webgl1 });
    await page.waitForFunction((count) => {
      const s = window.__bridge3DSmoke;
      return s?.status === 'online' && s.lastFrame?.peers.length === count;
    }, expectedPeers, { timeout: 12000 });
    const gpu = await page.evaluate(() => {
      const s = window.__bridge3DSmoke;
      const canvas = document.querySelector('canvas');
      const gl = canvas.getContext(s.api === 'webgl1' ? 'webgl' : 'webgl2');
      return {
        api: s.api, available: s.room.isGraphicsAvailable,
        program: Boolean(gl?.getParameter(gl.CURRENT_PROGRAM)),
        width: canvas.width, height: canvas.height,
        ownSocketId: s.socketId,
      };
    });
    assert.equal(gpu.api, webgl1 ? 'webgl1' : 'webgl2');
    assert.equal(gpu.available, true);
    assert.equal(gpu.program, true, 'real GLSL must be linked and used by renderer');
    assert.ok(gpu.width > 0 && gpu.height > 0);
    assert.equal(typeof gpu.ownSocketId, 'string');
    return page;
  }

  // Each page is an isolated, real Chromium browsing context, not an
  // in-process fake socket or a simulated renderer.
  const alice = await openSession(fixture.aliceToken, false, 1);
  const bob = await openSession(fixture.bobToken, true, 2);
  await Promise.all([alice, bob].map(p => p.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 2, null, { timeout: 10000 })));
  const both = await Promise.all([alice, bob].map(p => p.evaluate(() => ({
    api: window.__bridge3DSmoke.api,
    ids: window.__bridge3DSmoke.lastFrame.peers.map(peer => peer.userId),
  }))));
  assert.equal(both[0].api, 'webgl2');
  assert.equal(both[1].api, 'webgl1');
  assert.deepEqual(both[0].ids, both[1].ids);
  assert.equal(both[0].ids.length, 2);

  const ownId = await alice.evaluate(() => window.__bridge3DSmoke.socketId);
  await alice.evaluate(() => window.__bridge3DSmoke.session.step('right'));
  await bob.waitForFunction(id => {
    const s = window.__bridge3DSmoke;
    const peer = s.lastFrame?.peers.find(p => p.socketId === id);
    return Boolean(peer && peer.x === 0.35 && peer.z === 2.5);
  }, ownId, { timeout: 10000 });

  // Lose the REAL WebGL1 context while Bob is online. This must tear down
  // the authoritative socket-room membership, not just hide the GPU pixels.
  await bob.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl');
    const lose = gl?.getExtension('WEBGL_lose_context');
    if (!lose) throw Error('Real Chromium WebGL context-loss extension missing');
    window.__bridge3DContextRestore = () => lose.restoreContext();
    lose.loseContext();
  });
  await bob.waitForFunction(() => {
    const s = window.__bridge3DSmoke;
    return s?.status === 'graphics-lost' &&
      !s.room.isGraphicsAvailable && s.session === null && s.socket.connected;
  }, null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });

  // GPU recovery must rebuild a valid shader/program but NEVER silently
  // rejoin the online room. A genuine user action can explicitly rejoin.
  await bob.evaluate(() => window.__bridge3DContextRestore());
  await bob.waitForFunction(() => {
    const s = window.__bridge3DSmoke;
    const gl = document.querySelector('canvas').getContext('webgl');
    return s.room.isGraphicsAvailable &&
      Boolean(gl?.getParameter(gl.CURRENT_PROGRAM)) &&
      s.session === null && s.status === 'graphics-lost' && s.socket.connected;
  }, null, { timeout: 10000 });
  assert.equal(await alice.evaluate(() =>
    window.__bridge3DSmoke.lastFrame.peers.length), 1,
  'Restoring a GPU context must not resurrect an online avatar');
  await bob.evaluate(() => window.__bridge3DSmoke.rejoin());
  await Promise.all([alice, bob].map(page => page.waitForFunction(() => {
    const s = window.__bridge3DSmoke;
    return s?.status === 'online' && s.lastFrame?.peers.length === 2;
  }, null, { timeout: 10000 })));

  // The network session must leave when the user explicitly quits. The
  // other Chromium tab receives the authoritative updated peer roster.
  await bob.evaluate(() => window.__bridge3DSmoke.session.dispose());
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1, null, { timeout: 10000 });
  const final = await alice.evaluate(() => {
    const s = window.__bridge3DSmoke;
    return { online: s.status, gpu: s.room.isGraphicsAvailable,
      count: s.lastFrame.peers.length, errors: s.errors };
  });
  assert.deepEqual(final, { online: 'online', gpu: true, count: 1, errors: [] });
  console.log('SOCIAL_3D_REAL_BROWSER_WEBGL_TWO_USERS:2/2:0_skipped');
  console.log('SOCIAL_3D_REAL_BROWSER_MOVEMENT_AND_LEAVE:2/2:0_skipped');
  console.log('SOCIAL_3D_REAL_WEBGL1_CONTEXT_LOSS_REJOIN:1/1:0_skipped');
} finally {
  for (const { page, context } of pages) {
    try { await page.evaluate(() => window.__bridge3DSmoke?.dispose()); } catch {}
    await context.close();
  }
  if (browser) await browser.close();
  if (worker.connected) worker.send({ type: 'shutdown' });
  const ok = await Promise.race([
    stopped,
    new Promise((_, reject) => setTimeout(() => reject(Error('browser fixture cleanup timeout')), 15000)),
  ]).catch(error => {
    worker.kill('SIGKILL');
    throw error;
  });
  assert.equal(ok, true, 'real database/Redis fixture cleanup must succeed');
  if (workerLogs.includes('SOCIAL_BROWSER_') && workerLogs.includes('_FAILED')) {
    throw Error('fixture emitted an internal failure: ' + workerLogs);
  }
}
