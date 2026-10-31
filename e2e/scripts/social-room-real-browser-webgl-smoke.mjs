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
  env: {
    ...process.env, NODE_ENV: 'integration',
    BRIDGE_SOCIAL_3D_MULTIPLAYER: '1', BRIDGE_MINI_GOLF_MULTIPLAYER: '1',
    // Eight distinct authenticated test users share ONE CI loopback IP plus
    // social/full-app control connections. Isolated worker ONLY; production
    // WS connection limits remain unchanged and must be tested separately.
    MAX_WS_PER_IP: '24', MAX_UNAUTH_WS_PER_IP: '12',
  },
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
    const context = await browser.newContext({ viewport: { width: 770, height: 520 }, deviceScaleFactor: 3 });
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

  // Separate experimental Mini Golf authority: two REAL PostgreSQL users
  // and Redis-backed turns through the same production Socket.IO bootstrap.
  // No synthetic game events, fake scores, or trusting client coordinates.
  for (const page of [alice, bob]) await page.evaluate(() => {
    const s = window.__bridge3DSmoke.socket;
    const game = window.__miniGolfProof = { states: [], errors: [], left: [] };
    s.on('mini-golf:state', value => game.states.push(value));
    s.on('mini-golf:error', value => game.errors.push(value));
    s.on('mini-golf:left', value => game.left.push(value));
  });
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:join', {serverId, userId:'forged',score:99}),
    fixture.serverId);
  await alice.waitForFunction(() => window.__miniGolfProof?.states.at(-1)?.phase === 'waiting',
    null, { timeout: 10000 });
  await bob.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:join', {serverId}),
    fixture.serverId);
  await bob.waitForFunction(() => window.__miniGolfProof?.states.at(-1)?.phase === 'waiting' &&
    window.__miniGolfProof?.states.at(-1)?.players.length === 2,
    null, { timeout: 10000 });
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:start', {serverId}),
    fixture.serverId);
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:sync', {serverId}), fixture.serverId);
  await alice.waitForFunction(() => window.__miniGolfProof?.states.at(-1)?.phase === 'playing',
    null, { timeout: 10000 });
  await bob.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:shoot', {serverId,degrees:0,power:60}),
    fixture.serverId);
  await bob.waitForFunction(() =>
    window.__miniGolfProof?.errors.some(e => e.code === 'GOLF_INVALID_TURN'),
    null, { timeout: 10000 });
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:shoot',
      {serverId,degrees:0,power:60,x:9999,strokes:99}),
    fixture.serverId);
  await alice.waitForFunction(() =>
    window.__miniGolfProof?.states.at(-1)?.players?.[0]?.won === true,
    null, { timeout: 10000 });
  const firstGolfShot = await alice.evaluate(() => window.__miniGolfProof.states.at(-1));
  assert.equal(firstGolfShot.players[0].strokes,1);
  assert.equal(firstGolfShot.players[0].z,-3.8);
  assert.equal(firstGolfShot.turnUserId,firstGolfShot.players[1].userId);
  await bob.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:sync', {serverId}),
    fixture.serverId);
  await bob.waitForFunction(() =>
    window.__miniGolfProof?.states.at(-1)?.players?.[0]?.won === true,
    null, { timeout: 10000 });
  await bob.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:shoot', {serverId,degrees:0,power:60}),
    fixture.serverId);
  await bob.waitForFunction(() =>
    window.__miniGolfProof?.states.at(-1)?.phase === 'finished',
    null, { timeout: 10000 });
  const completed = await bob.evaluate(() => window.__miniGolfProof.states.at(-1));
  assert.deepEqual(completed.players.map(p => p.strokes),[1,1]);
  assert.equal(completed.turnUserId,null);
  await bob.evaluate(otherServerId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:join', {serverId:otherServerId}),
    fixture.otherServerId);
  await bob.waitForFunction(otherServerId =>
    window.__miniGolfProof?.errors.some(e =>
      e.code === 'GOLF_UNAVAILABLE' && e.serverId === otherServerId),
    fixture.otherServerId, { timeout: 10000 });
  await bob.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:leave', {serverId}),fixture.serverId);
  await bob.waitForFunction(() => window.__miniGolfProof?.left.length === 1,
    null, { timeout: 10000 });
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:sync', {serverId}),fixture.serverId);
  await alice.waitForFunction(() =>
    window.__miniGolfProof?.states.at(-1)?.phase === 'waiting',
    null, { timeout: 10000 });
  const afterExit = await alice.evaluate(() => window.__miniGolfProof.states.at(-1));
  assert.equal(afterExit.players.length,1);
  assert.equal(afterExit.players[0].strokes,0);
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:leave', {serverId}),fixture.serverId);
  await alice.waitForFunction(() => window.__miniGolfProof?.left.length === 1,
    null, { timeout: 10000 });
  console.log('BRIDGE_MINI_GOLF_REAL_PG_REDIS_TWO_PLAYER_AUTHORITY:2/2:0_skipped');

  // Alice is authenticated to TWO real PostgreSQL servers on the SAME
  // Socket.IO transport. A second server's legitimate join, authoritative
  // peer frame and protocol error must not close the first room's 3D UI.
  await alice.evaluate(otherServerId => {
    const s = window.__bridge3DSmoke;
    const foreign = window.__bridge3DForeign = {
      joined: false, peers: false, errors: [],
    };
    s.socket.on('social:joined', frame => {
      if (frame?.serverId === otherServerId) foreign.joined = true;
    });
    s.socket.on('social:peers', frame => {
      if (frame?.serverId === otherServerId) foreign.peers = true;
    });
    s.socket.on('social:error', error => foreign.errors.push(error));
    s.socket.emit('social:join', { serverId: otherServerId });
  }, fixture.otherServerId);
  await alice.waitForFunction(() =>
    window.__bridge3DForeign?.joined && window.__bridge3DForeign?.peers,
    null, { timeout: 10000 });
  assert.deepEqual(await alice.evaluate(() => ({
    status: window.__bridge3DSmoke.status,
    active: window.__bridge3DSmoke.session?.active,
    peers: window.__bridge3DSmoke.lastFrame.peers.length,
  })), { status: 'online', active: true, peers: 2 },
  'foreign legitimate roster must not be treated as a corrupt own-server frame');

  await alice.evaluate(otherServerId => {
    const s = window.__bridge3DSmoke.socket;
    s.emit('social:step', { serverId: otherServerId, direction: 'teleport' });
  }, fixture.otherServerId);
  await alice.waitForFunction(otherServerId =>
    window.__bridge3DForeign?.errors.some(e =>
      e.code === 'SOCIAL_ROOM_UNAVAILABLE' && e.serverId === otherServerId),
    fixture.otherServerId, { timeout: 10000 });

  // Even malformed requests with no server id cannot be attributed to the
  // live session; the client must ignore their unscoped error event.
  await alice.evaluate(() =>
    window.__bridge3DSmoke.socket.emit('social:step', { direction: 'forward' }));
  await alice.waitForFunction(() =>
    window.__bridge3DForeign?.errors.some(e =>
      e.code === 'SOCIAL_ROOM_UNAVAILABLE' && !('serverId' in e)),
    null, { timeout: 10000 });
  await alice.evaluate(otherServerId =>
    window.__bridge3DSmoke.socket.emit('social:leave', { serverId: otherServerId }),
    fixture.otherServerId);
  const isolated = await alice.evaluate(() => ({
    status: window.__bridge3DSmoke.status,
    active: window.__bridge3DSmoke.session?.active,
    peers: window.__bridge3DSmoke.lastFrame.peers.length,
  }));
  assert.deepEqual(isolated, { status: 'online', active: true, peers: 2 },
    'leaving a different server may not tear down this social session');
  assert.equal(await bob.evaluate(() =>
    window.__bridge3DSmoke.lastFrame.peers.length), 2,
    'Bob must retain the original room avatars');

  // A real 3x-DPR Chromium page must cap the framebuffer to the selected
  // quality budget, instead of allocating a potentially enormous WebView.
  // 640x400 CSS pixels: low 1x, high 2x, balanced 1.5x despite actual DPR=3.
  for (const [quality, width, height] of [
    ['low', 640, 400],
    ['high', 1280, 800],
    ['balanced', 960, 600],
  ]) {
    await alice.evaluate(q => window.__bridge3DSmoke.room.setQuality(q), quality);
    await alice.waitForFunction(([w, h]) => {
      const canvas = document.querySelector('canvas');
      return canvas.width === w && canvas.height === h;
    }, [width, height], { timeout: 12000 });
    const render = await alice.evaluate(() => ({
      actualDpr: window.devicePixelRatio,
      width: document.querySelector('canvas').width,
      height: document.querySelector('canvas').height,
    }));
    assert.equal(render.actualDpr, 3, 'real high-DPR browser must be used');
    assert.deepEqual([render.width, render.height], [width, height]);
  }

  const ownId = await alice.evaluate(() => window.__bridge3DSmoke.socketId);
  await alice.evaluate(() => window.__bridge3DSmoke.session.step('right'));
  await bob.waitForFunction(id => {
    const s = window.__bridge3DSmoke;
    const peer = s.lastFrame?.peers.find(p => p.socketId === id);
    return Boolean(peer && peer.x === 0.35 && peer.z === 2.5);
  }, ownId, { timeout: 10000 });

  // WebGL2 is the default desktop path; losing this real GPU context must
  // remove Alice from Bob's authoritative Redis/Socket.IO roster. Recovery
  // recreates a working GLSL ES 3.00 program but may NOT silently rejoin.
  await alice.evaluate(() => {
    const canvas = document.querySelector('canvas');
    const gl = canvas.getContext('webgl2');
    const lose = gl?.getExtension('WEBGL_lose_context');
    if (!lose) throw Error('Real Chromium WebGL2 context-loss extension missing');
    window.__bridge3DWebGL2Restore = () => lose.restoreContext();
    lose.loseContext();
  });
  await alice.waitForFunction(() => {
    const s = window.__bridge3DSmoke;
    return s?.status === 'graphics-lost' &&
      !s.room.isGraphicsAvailable && s.session === null && s.socket.connected;
  }, null, { timeout: 10000 });
  await bob.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });

  await alice.evaluate(() => window.__bridge3DWebGL2Restore());
  await alice.waitForFunction(() => {
    const s = window.__bridge3DSmoke;
    const gl = document.querySelector('canvas').getContext('webgl2');
    return s.room.isGraphicsAvailable &&
      Boolean(gl?.getParameter(gl.CURRENT_PROGRAM)) &&
      s.session === null && s.status === 'graphics-lost' && s.socket.connected;
  }, null, { timeout: 10000 });
  assert.equal(await bob.evaluate(() =>
    window.__bridge3DSmoke.lastFrame.peers.length), 1,
  'WebGL2 restoration must not resurrect presence');
  await alice.evaluate(() => window.__bridge3DSmoke.rejoin());
  await Promise.all([alice, bob].map(page => page.waitForFunction(() => {
    const s = window.__bridge3DSmoke;
    return s?.status === 'online' && s.lastFrame?.peers.length === 2;
  }, null, { timeout: 10000 })));

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

  // Rejoin Bob before revocation so this probes an ACTIVE session rather than
  // an already disconnected tab. Both users must see a real 2-peer roster.
  await bob.evaluate(() => window.__bridge3DSmoke.rejoin());
  await Promise.all([alice, bob].map(page => page.waitForFunction(() => {
    const state = window.__bridge3DSmoke;
    return state?.status === 'online' && state.lastFrame?.peers.length === 2;
  }, null, { timeout: 10000 })));

  // Deliberately send an invalid movement intent over Bob's REAL
  // authenticated Socket.IO transport. The production handler replies with
  // social:error but does not itself remove a still-authorized avatar.
  // The production client must send social:leave and remove that Redis peer.
  await bob.evaluate(() => {
    const state = window.__bridge3DSmoke;
    state.socket.emit('social:step', {
      serverId: state.lastFrame.serverId, direction: 'teleport',
    });
  });
  await bob.waitForFunction(() => {
    const state = window.__bridge3DSmoke;
    return state?.status === 'unavailable' &&
      state.session?.active === false && state.socket.connected &&
      state.room.isGraphicsAvailable;
  }, null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });
  assert.equal(await alice.evaluate(() =>
    window.__bridge3DSmoke.lastFrame.peers.length), 1,
  'server-side protocol rejection must not leave a ghost avatar');

  // The same authenticated socket can join again by explicit user intent,
  // after the server acknowledged authoritative leave/roster cleanup.
  await bob.evaluate(() => window.__bridge3DSmoke.rejoin());
  await Promise.all([alice, bob].map(page => page.waitForFunction(() => {
    const state = window.__bridge3DSmoke;
    return state?.status === 'online' && state.lastFrame?.peers.length === 2;
  }, null, { timeout: 10000 })));

  // Keep a real two-user Mini Golf match ACTIVE while Bob loses database
  // membership. Existing socket stays connected, but reads must fail closed.
  for (const page of [alice, bob]) {
    const before = await page.evaluate(() => window.__miniGolfProof.states.length);
    await page.evaluate(serverId =>
      window.__bridge3DSmoke.socket.emit('mini-golf:join', {serverId}),fixture.serverId);
    await page.waitForFunction(count => window.__miniGolfProof.states.length > count,
      before, { timeout: 10000 });
  }
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:start', {serverId}),fixture.serverId);
  await alice.waitForFunction(() =>
    window.__miniGolfProof.states.at(-1)?.phase === 'playing',null,{timeout:10000});

  // Real PostgreSQL ban -> actual Bridge membership eviction -> real
  // Socket.IO membership:revoked. No synthetic socket event is injected.
  const revoked = new Promise((resolve, reject) => {
    const deadline = setTimeout(() => {
      worker.off('message', onReply);
      reject(Error('real PostgreSQL membership eviction timed out'));
    }, 15000);
    function onReply(msg) {
      if (msg?.type !== 'bobRevoked' && msg?.type !== 'bobRevokeFailed') return;
      clearTimeout(deadline);
      worker.off('message', onReply);
      if (msg.type === 'bobRevokeFailed') reject(Error('real membership eviction failed in fixture'));
      else resolve(msg);
    }
    worker.on('message', onReply);
  });
  worker.send({ type: 'revokeBob' });
  const outcome = await revoked;
  assert.ok(outcome.leaves >= 2, 'server and social audiences must both be revoked');
  assert.equal(outcome.bobSockets, 1, 'revoked browser socket remains authenticated');
  assert.equal(outcome.bobInSocialAudience, false);
  assert.equal(outcome.bobInServerAudience, false);
  assert.equal(outcome.rosterUserIds.length, 1,
    'authoritative Redis must retain only non-revoked Alice');

  await bob.waitForFunction(() => {
    const state = window.__bridge3DSmoke;
    return state?.status === 'disconnected' &&
      state.session?.active === false &&
      state.socket.connected && state.room.isGraphicsAvailable;
  }, null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });

  const bobGolfStates = await bob.evaluate(() => window.__miniGolfProof.states.length);
  await bob.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:sync', {serverId}),fixture.serverId);
  await bob.waitForFunction(() =>
    window.__miniGolfProof.errors.some(e => e.code === 'GOLF_UNAVAILABLE'
      && e.serverId === window.__bridge3DSmoke.lastFrame.serverId),
    null, {timeout:10000});
  assert.equal(await bob.evaluate(() => window.__miniGolfProof.states.length),bobGolfStates,
    'revoked browser must not receive the other player\'s current Mini Golf match');
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:sync', {serverId}),fixture.serverId);
  await alice.waitForFunction(() =>
    window.__miniGolfProof.states.at(-1)?.phase === 'waiting' &&
    window.__miniGolfProof.states.at(-1)?.players.length === 1,
    null,{timeout:10000});
  await alice.evaluate(serverId =>
    window.__bridge3DSmoke.socket.emit('mini-golf:leave', {serverId}),fixture.serverId);
  await alice.waitForFunction(() => window.__miniGolfProof.left.length === 2,
    null,{timeout:10000});
  console.log('BRIDGE_MINI_GOLF_REAL_PG_REVOKED_SYNC_FAIL_CLOSED:1/1:0_skipped');

  // The revoked socket may remain connected for other Bridge features, but
  // it must NOT silently enter the social audience again.
  const framesBeforeDeniedJoin = await alice.evaluate(() =>
    window.__bridge3DSmoke.frames.length);
  await bob.evaluate(() => window.__bridge3DSmoke.rejoin());
  await bob.waitForFunction(() => {
    const state = window.__bridge3DSmoke;
    return state?.status === 'unavailable' && state.session?.active === false;
  }, null, { timeout: 10000 });
  const postDeny = await alice.evaluate(start => ({
    peers: window.__bridge3DSmoke.lastFrame.peers.length,
    subsequent: window.__bridge3DSmoke.frames.slice(start).map(f => f.peers.length),
  }), framesBeforeDeniedJoin);
  assert.equal(postDeny.peers, 1);
  assert.ok(postDeny.subsequent.every(count => count === 1),
    'a revoked user must not be broadcast back into the room');

  // Mount the actual production Bridge Activities panel (not a replacement
  // test UI), behind the real BridgeRegistry and the real authenticated
  // Socket.IO middleware. The surrounding app shell/CSS is a fixture.
  const panelContext = await browser.newContext({ viewport: { width: 850, height: 600 } });
  const panelPage = await panelContext.newPage();
  pages.push({ page: panelPage, context: panelContext });
  await panelPage.goto('http://127.0.0.1:' + fixture.port + '/');
  await panelPage.addScriptTag({ content: built.outputFiles[0].text });
  await panelPage.evaluate(({ port, token, serverId }) =>
    window.BridgeSocialRealBrowser.mountRealActivitiesPanel(port, token, serverId),
    { port: fixture.port, token: fixture.aliceToken, serverId: fixture.serverId });
  await panelPage.waitForFunction(() =>
    window.__bridge3DPanel?.ready &&
    Boolean(document.querySelector('.bridge-activities-dialog canvas')) &&
    document.getElementById('app')?.inert === true,
    null, { timeout: 12000 });
  assert.equal(await panelPage.locator('.bridge-activities-card').count(), 0,
    'social tab must not auto-mount the games catalog');
  assert.equal(await alice.evaluate(() => window.__bridge3DSmoke.lastFrame.peers.length), 1,
    'opening the real panel must not autojoin the social network');
  assert.match(await panelPage.locator('.bridge-activities-help').first().textContent(),
    /experimental room/, 'shipped help must describe gated multiplayer honestly');

  await panelPage.getByRole('button', { name: 'Try shared room (experimental)' }).click();
  await panelPage.waitForFunction(() =>
    document.querySelector('p.bridge-room-status[role="status"]')?.textContent?.includes('In shared room'),
    null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 2,
    null, { timeout: 10000 });

  // A real user switching to Games tears down the shared 3D subscription.
  // Ten catalog cards: eight planned games and two local playable 3D practices.
  await panelPage.getByRole('tab', { name: '3D Mini Games' }).click();
  assert.equal(await panelPage.locator('.bridge-activities-card').count(), 10);
  assert.equal(await panelPage.locator('.bridge-activities-planned').count(), 8);
  assert.equal(await panelPage.locator('.bridge-activities-solo').count(), 2,
    'Mini Golf and Pool local practices must not be mistaken for multiplayer ready');
  await panelPage.getByRole('button', { name: 'Play 3D Mini Golf practice' }).click();
  const golfCanvas = panelPage.locator('canvas.bridge-mini-golf-canvas');
  await golfCanvas.waitFor();
  await panelPage.waitForFunction(() => {
    const c = document.querySelector('canvas.bridge-mini-golf-canvas');
    if (!c || !c.width || !c.height) return false;
    const gl = c.getContext('webgl2') || c.getContext('webgl');
    return Boolean(gl && gl.getParameter(gl.CURRENT_PROGRAM));
  }, null, { timeout: 10000 });
  assert.match(await panelPage.locator('.bridge-mini-golf-status').textContent(), /Strokes: 0/);
  await panelPage.getByRole('button', { name: 'Shoot' }).click();
  assert.match(await panelPage.locator('.bridge-mini-golf-status').textContent(), /Strokes: 1/);
  await panelPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-status')?.textContent?.includes('Nice shot!'),
    null, { timeout: 12000 });
  assert.equal(await panelPage.getByRole('button', { name: 'Shoot' }).isDisabled(), true,
    'a sunk ball must not be shot repeatedly');
  await panelPage.getByRole('button', { name: 'Restart' }).click();
  assert.match(await panelPage.locator('.bridge-mini-golf-status').textContent(), /Strokes: 0/);
  await panelPage.getByRole('button', { name: 'Back to games' }).click();
  assert.equal(await panelPage.locator('.bridge-activities-card').count(), 10);
  console.log('BRIDGE_3D_MINI_GOLF_REAL_WEBGL_SHOT_WIN_RESET:1/1:0_skipped');
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });

  // Switching back does not silently reconnect; explicit user opt-in is
  // required. Logout must close the modal and revoke the live avatar.
  await panelPage.getByRole('tab', { name: '3D Social Space' }).click();
  assert.equal(await panelPage.getByRole('button',
    { name: 'Try shared room (experimental)' }).count(), 1);
  assert.equal(await alice.evaluate(() => window.__bridge3DSmoke.lastFrame.peers.length), 1);
  await panelPage.getByRole('button', { name: 'Try shared room (experimental)' }).click();
  await panelPage.waitForFunction(() =>
    document.querySelector('p.bridge-room-status[role="status"]')?.textContent?.includes('In shared room'),
    null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 2,
    null, { timeout: 10000 });
  await panelPage.evaluate(() => document.dispatchEvent(new Event('bridge:auth-logout')));
  await panelPage.waitForFunction(() =>
    !document.querySelector('.bridge-activities-overlay') &&
    document.getElementById('app')?.inert === false,
    null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });
  assert.deepEqual(await panelPage.evaluate(() =>
    window.__bridge3DPanel.errors), [], 'real panel auth must have no transport errors');

  // The shipped index.html's actual Activities rail button and production
  // built CSS must render under a strict self/nonce-shaped policy. Only the
  // surrounding app/auth lifecycle is a fixture, not a full Bridge boot.
  const shellContext = await browser.newContext({ viewport: { width: 980, height: 730 } });
  const shellPage = await shellContext.newPage();
  pages.push({ page: shellPage, context: shellContext });
  const origin = 'http://127.0.0.1:' + fixture.port;
  await shellPage.route('**/__bridge-social-test-entry.js', route =>
    route.fulfill({
      status: 200, contentType: 'application/javascript',
      body: built.outputFiles[0].text,
    }));
  const shellResponse = await shellPage.goto(origin + '/__bridge-shipped-shell');
  assert.equal(shellResponse?.status(), 200);
  const csp = shellResponse.headers()['content-security-policy'];
  assert.match(csp, /script-src 'self'/, 'scripts must remain same-origin');
  assert.match(csp, /style-src-elem 'self'/, 'styles must remain same-origin');
  assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/, 'no inline-script CSP bypass');
  const styleResponse = await shellPage.request.get(origin + '/__bridge-shipped-style.css');
  assert.equal(styleResponse.status(), 200, 'real built production CSS must be served');
  assert.match(await styleResponse.text(), /bridge-activities-overlay/,
    'the real bundled stylesheet must contain Activities styles');
  await shellPage.addScriptTag({ url: origin + '/__bridge-social-test-entry.js' });
  await shellPage.evaluate(({ port, token, serverId }) =>
    window.BridgeSocialRealBrowser.mountShippedActivitiesOpener(port, token, serverId),
    { port: fixture.port, token: fixture.aliceToken, serverId: fixture.serverId });
  await shellPage.waitForFunction(() => window.__bridge3DShippedShell?.ready,
    null, { timeout: 12000 });
  const opener = shellPage.locator('#bridge-activities-entry');
  assert.equal(await opener.count(), 1, 'original HTML opener must be present');
  const openerBounds = await opener.boundingBox();
  assert.ok(openerBounds && openerBounds.width > 0 && openerBounds.height > 0,
    'the real styled shell opener must have a clickable box');
  assert.equal(await shellPage.locator('.bridge-activities-overlay').count(), 0,
    'real rail should not auto-open on authenticated socket connection');
  await opener.click();
  await shellPage.getByRole('dialog', { name: 'Bridge Activities' }).waitFor();
  assert.equal(await shellPage.locator('.bridge-activities-card').count(), 10);
  const visual = await shellPage.locator('.bridge-activities-overlay').evaluate(el => {
    const layer = Number(getComputedStyle(el).zIndex);
    const token = Number(getComputedStyle(document.documentElement)
      .getPropertyValue('--z-stage-modal').trim());
    const shellOpener = document.getElementById('bridge-activities-entry');
    const b = shellOpener.getBoundingClientRect();
    const atopShell = document.elementFromPoint(b.left + b.width/2, b.top + b.height/2);
    const atopCorner = document.elementFromPoint(8, 8);
    return {
      position: getComputedStyle(el).position,
      display: getComputedStyle(el).display,
      zIndex: layer, expectedZ: token,
      coversShell: Boolean(atopShell && (atopShell === el || el.contains(atopShell))),
      coversCorner: Boolean(atopCorner && (atopCorner === el || el.contains(atopCorner))),
      dialogRadius: getComputedStyle(el.querySelector('.bridge-activities-dialog')).borderRadius,
    };
  });
  assert.equal(visual.position, 'fixed', 'production overlay CSS must apply');
  assert.equal(visual.display, 'flex');
  assert.ok(Number.isFinite(visual.expectedZ),'overlay must use a defined design-system layer');
  assert.equal(visual.zIndex, visual.expectedZ,'overlay must use the canonical stage-modal token');
  assert.ok(visual.coversShell && visual.coversCorner,
    'real overlay must intercept pixels above shell opener and page corner');
  assert.notEqual(visual.dialogRadius, '0px', 'panel border radius must not be unstyled');
  assert.equal(await shellPage.locator('#app').evaluate(el => el.inert), true);

  // Actual production click handler opens Games; real tabs enter Social.
  await shellPage.getByRole('tab', { name: '3D Social Space' }).click();
  assert.equal(await alice.evaluate(() => window.__bridge3DSmoke.lastFrame.peers.length), 1,
    'opening the shipped rail must not autojoin');
  await shellPage.getByRole('button', { name: 'Try shared room (experimental)' }).click();
  await shellPage.waitForFunction(() =>
    document.querySelector('p.bridge-room-status[role="status"]')?.textContent?.includes('In shared room'),
    null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 2,
    null, { timeout: 10000 });
  await shellPage.keyboard.press('Escape');
  await shellPage.waitForFunction(() =>
    !document.querySelector('.bridge-activities-overlay') &&
    document.getElementById('app')?.inert === false,
    null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });
  assert.equal(await shellPage.evaluate(() =>
    document.activeElement?.id), 'bridge-activities-entry',
  'the production opener must regain keyboard focus after Escape');
  assert.deepEqual(await shellPage.evaluate(() =>
    window.__bridge3DShippedShell.errors), [], 'real transport must authenticate');

  // FULL production app path: real Express createApp+setupRoutes serves
  // /index.html, nonce CSP, built ESM chunks, real /api/login, real socket
  // authentication and real AppState/ServerSwitcher/Activities opener.
  // Only fixture identities and disposable PostgreSQL/Redis are synthetic.
  const fullContext = await browser.newContext({ viewport: { width: 1200, height: 780 } });
  const fullPage = await fullContext.newPage();
  pages.push({ page: fullPage, context: fullContext });
  const fullErrors = [];
  fullPage.on('pageerror', e => fullErrors.push(String(e.message)));
  const fullOrigin = 'http://127.0.0.1:' + fixture.port;
  const documentResponse = await fullPage.goto(fullOrigin + '/index.html',
    { waitUntil: 'domcontentloaded' });
  assert.equal(documentResponse?.status(), 200, 'actual Bridge Express SPA route must load');
  const productionCsp = documentResponse.headers()['content-security-policy'];
  assert.match(productionCsp, /nonce-/, 'real Bridge CSP must contain a random nonce');
  assert.doesNotMatch(productionCsp, /script-src[^;]*unsafe-inline/,
    'real SPA must not loosen inline script CSP');
  await fullPage.locator('#l-username').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await fullPage.locator('#app').isVisible(), false,
    'actual Activities rail must not be shown before signing in');
  await fullPage.locator('#l-username').fill(fixture.aliceUsername);
  await fullPage.locator('#l-password').fill(fixture.proofPassword);
  const loginResponse = fullPage.waitForResponse(response =>
    response.url().includes('/api/login') && response.request().method() === 'POST',
    { timeout: 15000 });
  await fullPage.locator('#login-form [data-auth-action="login"]').click();
  const login = await loginResponse;
  assert.equal(login.status(), 200,
    'real login API must verify a real bcrypt password in PostgreSQL');
  await fullPage.locator('#app').waitFor({ state: 'visible', timeout: 20000 });
  await fullPage.locator('#bridge-activities-entry').waitFor(
    { state: 'visible', timeout: 20000 });
  const actualServerIcon = fullPage.locator('.server-icon[data-id="' + fixture.serverId + '"]');
  await actualServerIcon.waitFor({ state: 'visible', timeout: 20000 });
  await actualServerIcon.click();
  await fullPage.locator('#bridge-activities-entry').click();
  await fullPage.getByRole('dialog', { name: 'Bridge Activities' }).waitFor();
  assert.equal(await fullPage.locator('.bridge-activities-card').count(), 10);
  await fullPage.locator('[data-game-id="mini-golf"]').click();
  await fullPage.locator('canvas.bridge-mini-golf-canvas').waitFor();
  assert.match(await fullPage.locator('.bridge-mini-golf-status').textContent(), /Strokes: 0|Vuruş: 0/);
  await fullPage.getByRole('button', { name: /^(Shoot|Vur)$/ }).click();
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-status')?.textContent?.includes('Nice shot!') ||
    document.querySelector('.bridge-mini-golf-status')?.textContent?.includes('Tebrikler!'),
    null, { timeout: 12000 });
  await fullPage.locator('.bridge-mini-golf-back').click();
  assert.equal(await fullPage.locator('.bridge-activities-card').count(), 10);

  // Tower Chaos is still a PLANNED catalog entry, but has an explicit local
  // experimental preview with genuine WebGL, alternating rules and GPU loss.
  assert.equal(await fullPage.locator('.bridge-activities-planned').count(),8);
  await fullPage.locator('[data-game-id="tower-chaos-preview"]').click();
  await fullPage.locator('canvas.bridge-tower-canvas').waitFor({state:'visible'});
  assert.match(await fullPage.locator('.bridge-tower-status').textContent(),
    /Player 1.*Moves: 0/);
  await fullPage.waitForFunction(()=>{
    const canvas=document.querySelector('canvas.bridge-tower-canvas');
    const gl=canvas?.getContext('webgl2')||canvas?.getContext('webgl');
    return canvas?.width>0&&canvas.height>0&&
      Boolean(gl?.getParameter(gl.CURRENT_PROGRAM));
  },null,{timeout:10000});
  const towerSelect=fullPage.locator('.bridge-tower-block');
  assert.equal(await towerSelect.locator('option').count(),15);
  // Real Chromium pointer hit at the projected camera centre. The closest
  // visible physical block is #15 (zero-based id 14), not an invented overlay.
  const towerCanvas=fullPage.locator('canvas.bridge-tower-canvas');
  const towerBounds=await towerCanvas.boundingBox();
  assert.ok(towerBounds?.width>0&&towerBounds.height>0);
  await towerCanvas.click({position:{
    x:towerBounds.width/2,y:towerBounds.height/2,
  }});
  assert.equal(await towerSelect.inputValue(),'14',
    'actual GPU-facing canvas hit must select nearest visible block 15');
  assert.match(await fullPage.locator('.bridge-tower-notice').textContent(),
    /Selected block 15/);
  // Read back the actual WebGL2 ARRAY_BUFFER, not a mock DOM style/color.
  // The selected physical block's first vertex uses a bright cyan RGB.
  await fullPage.waitForFunction(()=>{
    const canvas=document.querySelector('canvas.bridge-tower-canvas');
    const gl=canvas?.getContext('webgl2');
    if(!gl?.getParameter(gl.ARRAY_BUFFER_BINDING))return false;
    const rgb=new Float32Array(3);
    gl.getBufferSubData(gl.ARRAY_BUFFER,(15*216+3)*4,rgb);
    return rgb[0]<0.15&&rgb[1]>0.8&&rgb[2]>0.9;
  },null,{timeout:10000});
  assert.match(await fullPage.locator('.bridge-tower-status').textContent(),
    /Player 1.*Moves: 0/,
    'clicking the 3D tower is selection only: no implicit removal');
  await towerSelect.selectOption('1');
  await fullPage.waitForFunction(()=>{
    const gl=document.querySelector('canvas.bridge-tower-canvas')?.getContext('webgl2');
    if(!gl?.getParameter(gl.ARRAY_BUFFER_BINDING))return false;
    const selectedRgb=new Float32Array(3),previousRgb=new Float32Array(3);
    gl.getBufferSubData(gl.ARRAY_BUFFER,(2*216+3)*4,selectedRgb);
    gl.getBufferSubData(gl.ARRAY_BUFFER,(15*216+3)*4,previousRgb);
    return selectedRgb[0]<0.15&&selectedRgb[1]>0.8&&
      previousRgb[0]>0.4&&previousRgb[1]<0.7;
  },null,{timeout:10000});
  await fullPage.locator('.bridge-tower-remove').click();
  assert.match(await fullPage.locator('.bridge-tower-status').textContent(),
    /Player 2.*Moves: 1/);
  await towerSelect.selectOption('0');
  await fullPage.locator('.bridge-tower-remove').click();
  assert.match(await fullPage.locator('.bridge-tower-status').textContent(),
    /Winning player 1.*Moves: 2/,
    'actual rules must award the surviving player after unsupported layer removal');
  assert.equal(await fullPage.locator('.bridge-tower-remove').isDisabled(),true);
  await fullPage.locator('canvas.bridge-tower-canvas').evaluate(canvas=>{
    canvas.dataset.oldTowerCanvas='completed';
  });
  await fullPage.locator('.bridge-tower-restart').click();
  await fullPage.waitForFunction(()=>{
    const canvas=document.querySelector('canvas.bridge-tower-canvas');
    const gl=canvas?.getContext('webgl2')||canvas?.getContext('webgl');
    return canvas?.dataset.oldTowerCanvas!=='completed' &&
      Boolean(gl?.getParameter(gl.CURRENT_PROGRAM)) &&
      /Player 1.*Moves: 0/.test(
        document.querySelector('.bridge-tower-status')?.textContent||'');
  },null,{timeout:10000});
  await fullPage.locator('canvas.bridge-tower-canvas').evaluate(canvas=>{
    const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    const ext=gl?.getExtension('WEBGL_lose_context');
    if(!ext)throw Error('Real Chromium Tower WebGL loss extension missing');
    ext.loseContext();
  });
  await fullPage.waitForFunction(()=>
    document.querySelector('.bridge-tower-remove')?.disabled===true &&
    document.querySelector('.bridge-tower-restart')?.hidden===false &&
    /graphics unverified/.test(
      document.querySelector('.bridge-tower-status')?.textContent||''),
    null,{timeout:10000});
  await fullPage.locator('.bridge-tower-restart').click();
  await fullPage.waitForFunction(()=>{
    const canvas=document.querySelector('canvas.bridge-tower-canvas');
    const gl=canvas?.getContext('webgl2')||canvas?.getContext('webgl');
    return Boolean(gl?.getParameter(gl.CURRENT_PROGRAM)) &&
      document.querySelector('.bridge-tower-remove')?.disabled===false;
  },null,{timeout:10000});
  assert.match(await fullPage.locator('.bridge-tower-status').textContent(),
    /Player 1.*Moves: 0/);
  await fullPage.locator('.bridge-tower-back').click();
  assert.equal(await fullPage.locator('.bridge-activities-card').count(),10);
  console.log('BRIDGE_3D_TOWER_REAL_CHROMIUM_LOCAL_GPU_RULES_LOSS_RECOVERY:1/1:0_skipped');
  // Second playable prototype: actual logged-in Bridge UI, 3D WebGL
  // pocket-practice shot, deterministic local score and reset. Not online 8-ball.
  await fullPage.locator('[data-game-id="eight-ball-pool"]').click();
  await fullPage.locator('canvas.bridge-pool-canvas').waitFor({state:'visible'});
  assert.match(await fullPage.locator('.bridge-pool-status').textContent(), /Shots: 0|Vuruş: 0/);
  assert.match(await fullPage.locator('.bridge-pool-status').textContent(),
    /(?:Balls pocketed|Girilen toplar):\s*0\/15/,
    'real authenticated Bridge UI must show all 15 locally-racked targets');
  const poolWebGL=await fullPage.locator('canvas.bridge-pool-canvas').evaluate(canvas=>
    Boolean(canvas.getContext('webgl2')||canvas.getContext('webgl')));
  assert.equal(poolWebGL,true,'Pool practice requires actual WebGL');
  await fullPage.locator('.bridge-pool-shoot').click();
  await fullPage.waitForFunction(()=>/Shots: 1|Vuruş: 1/.test(
    document.querySelector('.bridge-pool-status')?.textContent||''),null,{timeout:8000});
  assert.equal(await fullPage.locator('.bridge-pool-shoot').isDisabled(),true,
    'cue is locked during physical rolling');
  await fullPage.locator('.bridge-pool-reset').click();
  assert.match(await fullPage.locator('.bridge-pool-status').textContent(),/Shots: 0|Vuruş: 0/);
  // Real authenticated Chromium: local call challenge is explicit opt-in.
  // No network call, 8-ball turn, or competitive win is implied by this UI.
  assert.equal(await fullPage.locator('.bridge-pool-call-ball').isDisabled(),true);
  await fullPage.locator('.bridge-pool-call-enabled').check();
  await fullPage.locator('.bridge-pool-call-ball').selectOption('1');
  await fullPage.locator('.bridge-pool-call-pocket').selectOption('5');
  assert.equal(await fullPage.locator('.bridge-pool-call-pocket').isDisabled(),false);
  await fullPage.locator('.bridge-pool-shoot').click();
  assert.match(await fullPage.locator('.bridge-pool-call-result').textContent(),
    /Evaluating called pocket|Çağrılı vuruş değerlendiriliyor/);
  await fullPage.locator('.bridge-pool-reset').click();
  assert.match(await fullPage.locator('.bridge-pool-call-result').textContent(),
    /not a rules-based 8-ball match|Bu 8-Ball maçı değildir/);
  await fullPage.locator('.bridge-pool-call-enabled').uncheck();
  assert.equal(await fullPage.locator('.bridge-pool-call-ball').isDisabled(),true);
  console.log('BRIDGE_3D_POOL_REAL_AUTH_CALLED_POCKET_OPT_IN:1/1:0_skipped');

  // REAL Chrome keyboard, not a DOM event mock: Pool sliders must be inside
  // the same focus order as buttons. Tabs must wrap inside the modal and
  // must never allow focus to escape to the inert authenticated app.
  const poolPower = fullPage.locator('input.bridge-pool-power');
  await poolPower.focus();
  assert.equal(await poolPower.evaluate(el => el === document.activeElement), true);
  await fullPage.keyboard.press('Tab');
  assert.equal(await fullPage.locator('.bridge-pool-shoot').evaluate(el =>
    el === document.activeElement), true,
    'real Tab from Pool power slider must reach Shoot in DOM order');
  await fullPage.locator('.bridge-pool-reset').focus();
  await fullPage.keyboard.press('Tab');
  assert.equal(await fullPage.locator('.bridge-activities-close').evaluate(el =>
    el === document.activeElement), true,
    'real Tab at final modal button must wrap to Close');
  await fullPage.keyboard.press('Shift+Tab');
  assert.equal(await fullPage.locator('.bridge-pool-reset').evaluate(el =>
    el === document.activeElement), true,
    'real Shift+Tab from Close must wrap to final Pool button');
  assert.equal(await fullPage.locator('#app').evaluate(el => el.inert), true,
    'keyboard focus checks must not lift inert app boundary');

  // REAL Chromium + the shipped full app shell and GPU renderer (not the
  // Vitest renderer double). Explicit same-device 8-Ball uses genuine
  // fixed-step physics and cannot advance before the illegal-break decision.
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-status').count(),0,
    'local 2-player game must never auto-start from solo practice');
  await fullPage.locator('.bridge-pool-hotseat-launch').click();
  const livePoolCanvas=fullPage.locator('canvas.bridge-pool-canvas');
  await livePoolCanvas.waitFor({state:'visible'});
  await fullPage.waitForFunction(()=>{
    const canvas=document.querySelector('canvas.bridge-pool-canvas');
    const gl=canvas?.getContext('webgl2')||canvas?.getContext('webgl');
    return Boolean(gl?.getParameter(gl.CURRENT_PROGRAM))&&canvas.width>0&&canvas.height>0;
  },null,{timeout:10000});
  const localGpu=await livePoolCanvas.evaluate(canvas=>{
    const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    return {available:Boolean(gl),program:Boolean(gl?.getParameter(gl.CURRENT_PROGRAM)),
      width:canvas.width,height:canvas.height};
  });
  assert.equal(localGpu.available,true,'local 2-player renderer must have a real WebGL context');
  assert.equal(localGpu.program,true,'local 2-player renderer must link a real GLSL program');
  assert.ok(localGpu.width>0&&localGpu.height>0);
  assert.match(await fullPage.locator('.bridge-pool-hotseat-status').textContent(),
    /Player 1.*Break shot/);
  assert.match(await fullPage.locator('.bridge-pool-hotseat-groups').textContent(),
    /Player 1: Not assigned.*Player 2: Not assigned/,
    'both 8-Ball players must have visibly unassigned groups at first break');
  assert.match(await fullPage.locator('.bridge-pool-hotseat-inventory').textContent(),
    /Remaining: Solids 7.*Stripes 7.*Eight on table/,
    'real initial WebGL rack must show the full verified 7+7+eight inventory');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-preview').textContent(),
    'Declared shot: Player 1 · Break shot',
    'real GPU local game must show only active opening player intent');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-ball option').count(),0,
    'no phantom called ball before the opening shot');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-ball').isDisabled(),true);
  const liveAim=fullPage.locator('input.bridge-pool-hotseat-aim');
  await liveAim.focus();
  await fullPage.keyboard.press('ArrowRight');
  assert.equal(await liveAim.inputValue(),'5',
    'the first player deliberately changes cue angle using real Chromium keyboard');
  assert.equal(await liveAim.getAttribute('aria-valuetext'),'5 degrees');
  assert.match(await fullPage.locator('.bridge-pool-hotseat-cue-values').textContent(),
    /Cue aim 5°.*Shot power 60%/,
    'the same live readout must reflect actual keyboard aim input');
  const livePower=fullPage.locator('input.bridge-pool-hotseat-power');
  await livePower.focus();
  await fullPage.keyboard.press('Home');
  assert.equal(await livePower.inputValue(),'10','real keyboard lowers the break to minimum power');
  assert.equal(await livePower.getAttribute('aria-valuetext'),'10 percent');
  assert.match(await fullPage.locator('.bridge-pool-hotseat-cue-values').textContent(),
    /Cue aim 5°.*Shot power 10%/,
    'real keyboard power input updates visible value and screen reader text');
  await fullPage.locator('.bridge-pool-hotseat-shoot').click();
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-shoot').isDisabled(),true,
    'physical shot must lock controls until it settles');
  await fullPage.waitForFunction(()=>
    /Player 2.*Illegal break.*Shots: 1/.test(
      document.querySelector('.bridge-pool-hotseat-status')?.textContent||''),
    null,{timeout:15000});
  assert.equal(await liveAim.inputValue(),'0',
    'the incoming player must not inherit previous shot aim');
  assert.equal(await livePower.inputValue(),'60',
    'the incoming player must not inherit previous shot power');
  assert.equal(await liveAim.getAttribute('aria-valuetext'),'0 degrees');
  assert.equal(await livePower.getAttribute('aria-valuetext'),'60 percent');
  assert.match(await fullPage.locator('.bridge-pool-hotseat-cue-values').textContent(),
    /Cue aim 0°.*Shot power 60%/,
    "the incoming player's readout cannot retain the previous cue values");
  const lastShotText=await fullPage.locator('.bridge-pool-hotseat-last-shot').textContent();
  assert.match(lastShotText,/Last shot: Player 1.*Pocketed: 0.*Foul:.*Decision for: Player 2/,
    'narration must derive from settled physical break and the recorded foul');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-preview').textContent(),'',
    'unresolved incoming player decision must not announce a playable target');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-decisions button').count(),3,
    'illegal break requires an explicit player choice, not a silent default');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-shoot').isDisabled(),true,
    'blocked decision must not permit the next cue strike');
  const rerackDecision=fullPage.locator('.bridge-pool-hotseat-decisions button').nth(1);
  await rerackDecision.focus();
  assert.equal(await rerackDecision.evaluate(el=>el===document.activeElement),true,
    'keyboard must be able to focus an explicit Pool rules decision');
  await fullPage.keyboard.press('Enter');
  await fullPage.waitForFunction(()=>
    /Player 2.*Break shot.*Shots: 0/.test(
      document.querySelector('.bridge-pool-hotseat-status')?.textContent||'') &&
    document.querySelector('.bridge-pool-hotseat-shoot')?.disabled===false,
    null,{timeout:10000});
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-decisions button').count(),0);
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-last-shot').textContent(),'',
    're-rack must not narrate the previous match as an active foul');
  assert.match(await fullPage.locator('.bridge-pool-hotseat-inventory').textContent(),
    /Remaining: Solids 7.*Stripes 7.*Eight on table/,
    'physical re-rack must restore an entire 7+7+eight inventory');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-preview').textContent(),
    'Declared shot: Player 2 · Break shot',
    'real Enter re-rack must announce the incoming breaker, never prior player');
  assert.equal(await liveAim.inputValue(),'0');
  assert.equal(await livePower.inputValue(),'60',
    'opponent re-rack cannot reintroduce stale first-player cue force');
  console.log('BRIDGE_3D_POOL_REAL_CHROMIUM_FRESH_CUE_EVERY_TURN:1/1:0_skipped');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-shoot').evaluate(
    el=>el===document.activeElement),true,
    'keyboard focus must transfer from a replaced rules button to ready Shoot');
  assert.match(await fullPage.locator('.bridge-pool-hotseat-groups').textContent(),
    /Player 1: Not assigned.*Player 2: Not assigned/);
  console.log('BRIDGE_3D_POOL_REAL_CHROMIUM_HOTSEAT_KEYBOARD_TURN_FOCUS:1/1:0_skipped');

  // Real WebGL context loss must permanently invalidate the current local
  // game, even if Chromium subsequently restores graphics. A stale physics
  // callback is never sufficient to restore turn authority.
  await fullPage.locator('canvas.bridge-pool-canvas').evaluate(canvas=>{
    const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    const extension=gl?.getExtension('WEBGL_lose_context');
    if(!extension)throw Error('Local Pool real WebGL context-loss extension missing');
    window.__bridgePoolRestoreGraphics=()=>extension.restoreContext();
    extension.loseContext();
  });
  await fullPage.waitForFunction(()=>
    document.querySelector('.bridge-pool-hotseat-notice')?.textContent
      ?.includes('3D evidence was lost') &&
    document.querySelector('.bridge-pool-hotseat-shoot')?.disabled===true,
    null,{timeout:10000});
  assert.match(await fullPage.locator('.bridge-pool-hotseat-status').textContent(),
    /Player 2.*Break shot.*Shots: 0/,'context loss must not invent a shot');
  await fullPage.evaluate(()=>window.__bridgePoolRestoreGraphics());
  await fullPage.waitForFunction(()=>{
    const canvas=document.querySelector('canvas.bridge-pool-canvas');
    const gl=canvas?.getContext('webgl2')||canvas?.getContext('webgl');
    return Boolean(gl&&!gl.isContextLost()&&gl.getParameter(gl.CURRENT_PROGRAM));
  },null,{timeout:10000});
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-shoot').isDisabled(),true,
    'graphics recovery must not silently re-enable a suspended 8-Ball match');
  assert.match(await fullPage.locator('.bridge-pool-hotseat-notice').textContent(),
    /3D evidence was lost/);
  const restart=fullPage.locator('.bridge-pool-hotseat-restart');
  assert.equal(await restart.isVisible(),true,
    'restart must require an explicit player action after real GPU loss');
  await fullPage.locator('canvas.bridge-pool-canvas').evaluate(
    canvas=>{canvas.dataset.poolRendererIdentity='lost-match';});
  await restart.click();
  await fullPage.waitForFunction(()=>{
    const canvas=document.querySelector('canvas.bridge-pool-canvas');
    const gl=canvas?.getContext('webgl2')||canvas?.getContext('webgl');
    return canvas?.dataset.poolRendererIdentity!== 'lost-match' &&
      Boolean(gl?.getParameter(gl.CURRENT_PROGRAM))&&
      document.querySelector('.bridge-pool-hotseat-shoot')?.disabled===false &&
      document.querySelector('.bridge-pool-hotseat-restart')?.hidden===true;
  },null,{timeout:10000});
  assert.match(await fullPage.locator('.bridge-pool-hotseat-status').textContent(),
    /Player 1.*Break shot.*Shots: 0/,
    'explicit new local match must use a fresh verified rack and first breaker');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-last-shot').textContent(),'',
    'new local match must not carry any prior shot outcome or foul');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-decisions button').count(),0);
  assert.match(await fullPage.locator('.bridge-pool-hotseat-inventory').textContent(),
    /Remaining: Solids 7.*Stripes 7.*Eight on table/,
    'a newly allocated GPU match must show fresh verified balls, not old counts');
  assert.equal(await fullPage.locator('.bridge-pool-hotseat-preview').textContent(),
    'Declared shot: Player 1 · Break shot',
    'explicit new GPU match must not retain the old player intention');
  assert.equal(await restart.isVisible(),false);
  console.log('BRIDGE_3D_POOL_REAL_CHROMIUM_EXPLICIT_NEW_RENDERER_AFTER_GPU_LOSS:1/1:0_skipped');

  await fullPage.locator('.bridge-pool-hotseat-back').click();
  assert.match(await fullPage.locator('.bridge-pool-status').textContent(),/Shots: 0/);
  console.log('BRIDGE_3D_POOL_REAL_CHROMIUM_LOCAL_HOTSEAT_BREAK_RERACK:1/1:0_skipped');

  await fullPage.locator('.bridge-pool-back').click();
  assert.equal(await fullPage.locator('.bridge-activities-card').count(),10);
  console.log('BRIDGE_3D_POOL_REAL_AUTH_APP_SOLO_SHOOT_RESET:1/1:0_skipped');

  // Social graphics quality is a native select in the *same* real dialog.
  // After leaving Pool, a user must be able to Tab from the selector to
  // online opt-in, and the unselected games tab cannot be a focus stop.
  await fullPage.getByRole('tab', { name: '3D Social Space' }).click();
  await fullPage.locator('select.bridge-room-quality').focus();
  await fullPage.keyboard.press('Tab');
  const socialJoin = fullPage.locator('.bridge-activities-body > button.bridge-room-direction');
  assert.equal(await socialJoin.evaluate(el => el === document.activeElement), true,
    'real Tab from graphics quality must reach explicit online join');
  assert.equal(await fullPage.locator('[data-tab="games"]').evaluate(el =>
    el.tabIndex), -1, 'inactive Games tab must not be an accidental focus stop');
  await fullPage.getByRole('tab', { name: '3D Mini Games' }).click();
  assert.equal(await fullPage.locator('.bridge-activities-card').count(), 10);
  console.log('BRIDGE_3D_REAL_APP_KEYBOARD_MODAL_FOCUS:1/1:0_skipped');

  // FULL SHIPPED UI: real Express login Alice plus a third real PostgreSQL
  // member on an independent, production-JWT Socket.IO connection. The UI
  // starts offline and must explicitly join; state/turn/score are server-owned.
  const opponentContext = await browser.newContext({ viewport: { width: 600, height: 480 } });
  const opponentPage = await opponentContext.newPage();
  pages.push({ page: opponentPage, context: opponentContext });
  await opponentPage.goto(fullOrigin + '/');
  await opponentPage.addScriptTag({ content: built.outputFiles[0].text });
  await opponentPage.evaluate(({ port, token, serverId }) =>
    window.BridgeSocialRealBrowser.mountGolfOpponent(port, token, serverId),
    { port: fixture.port, token: fixture.charlieToken, serverId: fixture.serverId });
  await opponentPage.waitForFunction(() => window.__miniGolfOpponent?.ready,
    null, { timeout: 12000 });
  await fullPage.locator('[data-game-id="mini-golf"]').click();
  assert.equal(await fullPage.locator('.bridge-mini-golf-scoreboard li').count(),0,
    'solo view cannot autojoin experimental multiplayer');
  await fullPage.locator('.bridge-mini-golf-online-button').click();
  await fullPage.waitForFunction(() =>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===1,
    null, { timeout: 12000 });
  await opponentPage.evaluate(() => window.__miniGolfOpponent.join());
  await opponentPage.waitForFunction(() =>
    window.__miniGolfOpponent.states.at(-1)?.phase==='waiting' &&
    window.__miniGolfOpponent.states.at(-1)?.players.length===2,
    null, { timeout: 12000 });
  await fullPage.waitForFunction(() =>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===2 &&
    !!document.querySelector('.bridge-mini-golf-start:not([hidden])'),
    null, { timeout: 12000 });
  await fullPage.locator('.bridge-mini-golf-start').click();
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Your turn|Sıra sende/),
    null, { timeout: 12000 });
  await opponentPage.evaluate(() => window.__miniGolfOpponent.sync());
  await opponentPage.waitForFunction(() =>
    window.__miniGolfOpponent.states.at(-1)?.phase==='playing',
    null, { timeout: 12000 });
  await fullPage.waitForFunction(() =>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===2 &&
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Your turn|Sıra sende/),
    null, { timeout: 15000 });
  assert.equal(await fullPage.locator('.bridge-mini-golf-shoot').isEnabled(),true);
  assert.equal(await fullPage.locator('.bridge-mini-golf-reset').isDisabled(),true,
    'online round reset must remain server-owned, not local');
  await fullPage.locator('.bridge-mini-golf-shoot').click();
  await fullPage.waitForFunction(() =>
    [...document.querySelectorAll('.bridge-mini-golf-scoreboard li')]
      .some(li => li.textContent?.match(/Strokes: 1|Vuruş: 1/)),
    null, { timeout: 12000 });
  await opponentPage.evaluate(() => window.__miniGolfOpponent.sync());
  await opponentPage.waitForFunction(() =>
    window.__miniGolfOpponent.states.at(-1)?.players?.[0]?.won===true,
    null, { timeout: 12000 });
  await opponentPage.evaluate(() => window.__miniGolfOpponent.shoot(0,60));
  await opponentPage.waitForFunction(() =>
    window.__miniGolfOpponent.states.at(-1)?.phase==='finished',
    null, { timeout: 12000 });
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Match finished|Maç sona erdi/) &&
    [...document.querySelectorAll('.bridge-mini-golf-scoreboard li')]
      .filter(li => li.textContent?.match(/Strokes: 1|Vuruş: 1/)).length===2,
    null, { timeout: 16000 });
  const twoResults=await fullPage.locator('.bridge-mini-golf-results li').allTextContents();
  assert.equal(twoResults.length,2,'the signed two-user match must expose both ranked results');
  assert.ok(twoResults.every(label => /Place 1|Sıra 1/.test(label)),
    'two one-shot winners share first place, never a fabricated second place');
  assert.ok(twoResults.every(label => /Strokes: 1|Vuruş: 1/.test(label)),
    'results must display the server-owned individual stroke counts');
  const onlineVisual = await fullPage.evaluate(() => {
    const canvas=document.querySelector('canvas.bridge-mini-golf-canvas');
    const gl=canvas.getContext('webgl2')||canvas.getContext('webgl');
    return { program:Boolean(gl?.getParameter(gl.CURRENT_PROGRAM)), width:canvas.width };
  });
  assert.equal(onlineVisual.program,true,'online real 3D canvas must render');
  assert.ok(onlineVisual.width>0);
  await fullPage.locator('.bridge-mini-golf-online-button').click();
  await fullPage.waitForFunction(() =>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===0 &&
    !document.querySelector('.bridge-mini-golf-reset')?.disabled,
    null, { timeout: 10000 });
  await opponentPage.evaluate(() => window.__miniGolfOpponent.sync());
  await opponentPage.waitForFunction(() =>
    window.__miniGolfOpponent.states.at(-1)?.phase==='waiting' &&
    window.__miniGolfOpponent.states.at(-1)?.players.length===1,
    null, { timeout: 12000 });
  await opponentPage.evaluate(() => window.__miniGolfOpponent.dispose());
  await fullPage.locator('.bridge-mini-golf-back').click();
  assert.equal(await fullPage.locator('.bridge-activities-card').count(),10);
  console.log('BRIDGE_MINI_GOLF_REAL_AUTH_APP_TWO_PLAYER_UI:2/2:0_skipped');

  // The same real logged-in Bridge app must admit eight distinct POSTGRES
  // members on eight independent production JWT Socket.IO connections. A
  // ninth authenticated user is denied without seeing the match roster.
  const rosterContext = await browser.newContext({ viewport: { width: 540, height: 440 } });
  const rosterPage = await rosterContext.newPage();
  pages.push({ page: rosterPage, context: rosterContext });
  await rosterPage.goto(fullOrigin + '/');
  await rosterPage.addScriptTag({ content: built.outputFiles[0].text });
  await rosterPage.evaluate(({port,tokens,serverId}) =>
    window.BridgeSocialRealBrowser.mountGolfRoster(port,tokens,serverId),{
      port:fixture.port,
      tokens:[fixture.charlieToken,...fixture.golfExtraTokens],
      serverId:fixture.serverId,
    });
  await rosterPage.waitForFunction(() =>
    window.__miniGolfRoster?.players.length===8 &&
    window.__miniGolfRoster.players.every(p=>p.ready),
    null,{timeout:20000});
  await fullPage.locator('[data-game-id="mini-golf"]').click();
  assert.equal(await fullPage.locator('.bridge-mini-golf-start').isHidden(),true,
    'lobby must not start without two authenticated members');
  await fullPage.locator('.bridge-mini-golf-online-button').click();
  await fullPage.waitForFunction(() =>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===1,
    null,{timeout:12000});
  for(let i=0;i<7;i++){
    await rosterPage.evaluate(i=>window.__miniGolfRoster.join(i),i);
    await rosterPage.waitForFunction(i=>{
      const current=window.__miniGolfRoster.players[i].states.at(-1);
      return current?.phase==='waiting' && current?.players.length===i+2;
    },i,{timeout:12000});
  }
  await rosterPage.evaluate(()=>window.__miniGolfRoster.join(7));
  await rosterPage.waitForFunction(() =>
    window.__miniGolfRoster.players[7].errors.some(e=>e.code==='GOLF_UNAVAILABLE'),
    null,{timeout:12000});
  assert.equal(await rosterPage.evaluate(() =>
    window.__miniGolfRoster.players[7].states.length),0,
    'ninth player must not receive another tenant-private eight-seat roster');
  await fullPage.waitForFunction(() =>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===8 &&
    !!document.querySelector('.bridge-mini-golf-start:not([hidden])'),
    null,{timeout:16000});
  await fullPage.locator('.bridge-mini-golf-start').click();
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Your turn|Sıra sende/),
    null,{timeout:12000});
  await fullPage.locator('.bridge-mini-golf-shoot').click();
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Another player's turn|Başka oyuncunun sırası/),
    null,{timeout:12000});

  // Actual late-game transport loss: fourth member loses the socket while the
  // other seven remain on the same Redis match. An eighth authenticated seat
  // must be RESERVED (not released), all shots pause, and a fresh socket
  // belonging to the same JWT principal can explicitly reclaim that seat.
  await rosterPage.evaluate(() => window.__miniGolfRoster.drop(2));
  await rosterPage.evaluate(() => window.__miniGolfRoster.sync(0));
  await rosterPage.waitForFunction(() =>
    window.__miniGolfRoster.players[0].states.at(-1)?.players[3]?.reconnecting === true,
    null,{timeout:12000});
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/reconnecting|yeniden bağlanıyor/i),
    null,{timeout:14000});
  const previousErrorCount = await rosterPage.evaluate(() =>
    window.__miniGolfRoster.players[0].errors.length);
  await rosterPage.evaluate(() => window.__miniGolfRoster.shoot(0,0,60));
  await rosterPage.waitForFunction(count =>
    window.__miniGolfRoster.players[0].errors.length > count,
    previousErrorCount,{timeout:12000});
  assert.equal(await fullPage.locator('.bridge-mini-golf-shoot').isDisabled(),true,
    'a peer transport gap must pause all local online shots');
  await rosterPage.evaluate(() => window.__miniGolfRoster.reconnect(2));
  await rosterPage.waitForFunction(() => window.__miniGolfRoster.players[2].ready,
    null,{timeout:12000});
  await rosterPage.evaluate(() => window.__miniGolfRoster.join(2));
  await rosterPage.waitForFunction(() =>
    window.__miniGolfRoster.players[2].states.at(-1)?.phase === 'playing' &&
    window.__miniGolfRoster.players[2].states.at(-1)?.players.length === 8 &&
    window.__miniGolfRoster.players[2].states.at(-1)?.players[3]?.reconnecting === false,
    null,{timeout:12000});
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Another player's turn|Başka oyuncunun sırası/),
    null,{timeout:14000});
  console.log('BRIDGE_MINI_GOLF_REAL_PG_REDIS_EIGHT_PLAYER_REJOIN:1/1:0_skipped');

  for(let i=0;i<7;i++){
    await rosterPage.evaluate(i=>window.__miniGolfRoster.shoot(i,0,60),i);
    await rosterPage.waitForFunction(i=>{
      const current=window.__miniGolfRoster.players[i].states.at(-1);
      return current?.players[i+1]?.won===true &&
        current?.players[i+1]?.strokes===1;
    },i,{timeout:12000});
  }
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Match finished|Maç sona erdi/) &&
    [...document.querySelectorAll('.bridge-mini-golf-scoreboard li')].filter(li =>
      /Strokes: 1|Vuruş: 1/.test(li.textContent||'')).length===8,
    null,{timeout:16000});
  assert.equal(await fullPage.locator('.bridge-mini-golf-shoot').isDisabled(),true);
  const eightResults=await fullPage.locator('.bridge-mini-golf-results li').allTextContents();
  assert.equal(eightResults.length,8);
  assert.ok(eightResults.every(label => /Place 1|Sıra 1/.test(label) &&
    /Strokes: 1|Vuruş: 1/.test(label)),
    'all eight one-shot winners must tie in the server-owned final ranking');
  const officialResults=await rosterPage.evaluate(() =>
    window.__miniGolfRoster.players[6].states.at(-1).results);
  assert.equal(officialResults.length,8);
  assert.ok(officialResults.every(p=>p.rank===1&&p.strokes===1&&p.holed));
  console.log('BRIDGE_MINI_GOLF_REAL_AUTH_EIGHT_PLAYER_RANKED_RESULTS:8/8:0_skipped');
  // All eight independent, authenticated PostgreSQL members must consent
  // to the rematch; 1–7 votes MUST NOT silently erase the first-round scores.
  const rematchControl=fullPage.locator('.bridge-mini-golf-rematch');
  assert.equal(await rematchControl.isVisible(),true);
  await rematchControl.click();
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-rematch')?.textContent?.includes('1/8'),
    null,{timeout:12000});
  assert.equal(await rematchControl.isDisabled(),true,
    'one consent must not be submitted multiple times');
  for(let i=0;i<6;i++){
    await rosterPage.evaluate(i=>window.__miniGolfRoster.rematch(i),i);
    await rosterPage.waitForFunction(i=>
      window.__miniGolfRoster.players[i].states.at(-1)?.rematchReady.length === i+2 &&
      window.__miniGolfRoster.players[i].states.at(-1)?.phase === 'finished',
      i,{timeout:12000});
  }
  assert.equal(await fullPage.locator('.bridge-mini-golf-shoot').isDisabled(),true,
    'seven rematch approvals cannot reset the shared game');
  await rosterPage.evaluate(()=>window.__miniGolfRoster.rematch(6));
  await rosterPage.waitForFunction(() =>{
    const frame=window.__miniGolfRoster.players[6].states.at(-1);
    return frame?.phase==='playing' && frame.players.length===8 &&
      frame.players.every(p=>p.strokes===0 && !p.won) && frame.rematchReady.length===0;
  },null,{timeout:12000});
  await fullPage.waitForFunction(() =>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent?.match(/Your turn|Sıra sende/) &&
    document.querySelector('.bridge-mini-golf-rematch')?.hidden===true &&
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===8 &&
    [...document.querySelectorAll('.bridge-mini-golf-scoreboard li')]
      .every(li => /Strokes: 0|Vuruş: 0/.test(li.textContent||'')),
    null,{timeout:16000});
  assert.equal(await fullPage.locator('.bridge-mini-golf-shoot').isEnabled(),true);
  assert.equal(await fullPage.locator('.bridge-mini-golf-results li').count(),0,
    'new round must not carry over previous standings');
  await fullPage.locator('.bridge-mini-golf-shoot').click();
  await fullPage.waitForFunction(() =>
    [...document.querySelectorAll('.bridge-mini-golf-scoreboard li')]
      .some(li=>/Strokes: 1|Vuruş: 1/.test(li.textContent||'')),
    null,{timeout:12000});
  console.log('BRIDGE_MINI_GOLF_REAL_AUTH_EIGHT_PLAYER_CONSENSUAL_REMATCH:8/8:0_skipped');

  await fullPage.locator('.bridge-mini-golf-online-button').click();
  await fullPage.waitForFunction(() =>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===0,
    null,{timeout:12000});
  await rosterPage.evaluate(()=>window.__miniGolfRoster.sync(0));
  await rosterPage.waitForFunction(() =>
    window.__miniGolfRoster.players[0].states.at(-1)?.players.length===7,
    null,{timeout:12000});
  await rosterPage.evaluate(()=>window.__miniGolfRoster.dispose());
  await fullPage.locator('.bridge-mini-golf-back').click();
  console.log('BRIDGE_MINI_GOLF_REAL_AUTH_APP_EIGHT_PLAYER_CAPACITY:8/8:0_skipped');

  // Emulated smartphone acceptance (NOT a physical Android/iOS device):
  // actual Bridge Express login, shipped HTML/CSS, touch-enabled Chromium,
  // actual WebGL canvas, narrow viewport and tap-driven mini-golf controls.
  const mobileContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
    screen: { width: 390, height: 844 },
    deviceScaleFactor: 2, isMobile: true, hasTouch: true,
  });
  const mobilePage = await mobileContext.newPage();
  pages.push({ page: mobilePage, context: mobileContext });
  const mobileErrors=[];
  mobilePage.on('pageerror', error => mobileErrors.push(String(error.message)));
  const mobileDocument = await mobilePage.goto(fullOrigin + '/index.html',
    {waitUntil:'domcontentloaded'});
  assert.equal(mobileDocument?.status(),200);
  await mobilePage.locator('#l-username').waitFor({state:'visible',timeout:20000});
  await mobilePage.locator('#l-username').fill(fixture.aliceUsername);
  await mobilePage.locator('#l-password').fill(fixture.proofPassword);
  const mobileLoginResponse=mobilePage.waitForResponse(response=>
    response.url().includes('/api/login') && response.request().method()==='POST',
    {timeout:15000});
  await mobilePage.locator('#login-form [data-auth-action="login"]').tap();
  assert.equal((await mobileLoginResponse).status(),200,
    'mobile device emulation still authenticates via real PostgreSQL');
  await mobilePage.locator('#app').waitFor({state:'visible',timeout:20000});
  const mobileServerIcon=mobilePage.locator('.server-icon[data-id="'+fixture.serverId+'"]');
  await mobileServerIcon.waitFor({state:'visible',timeout:20000});
  // On a phone, the "active" icon may be hydrated before the actual selected
  // server is registered. Exercise the SAME tap as a human to establish the
  // current server, then open the real Servers drawer for Activities.
  await mobilePage.locator('#mnav-servers').tap();
  await mobilePage.locator('.server-list').waitFor({state:'visible'});
  await mobileServerIcon.tap();
  assert.equal(await mobileServerIcon.getAttribute('aria-current'),'true',
    'a real mobile server tap must establish the active server');
  if (!await mobilePage.locator('.server-list').evaluate(el=>el.classList.contains('open'))) {
    await mobilePage.locator('#mnav-servers').tap();
  }
  await mobilePage.locator('#bridge-activities-entry').tap();
  await mobilePage.getByRole('dialog',{name:'Bridge Activities'}).waitFor();
  await mobilePage.locator('[data-game-id="mini-golf"]').tap();
  const mobileCanvas=mobilePage.locator('canvas.bridge-mini-golf-canvas');
  await mobileCanvas.waitFor({state:'visible',timeout:12000});
  const joinCopy=await mobilePage.locator('.bridge-mini-golf-online-button').textContent();
  assert.match(joinCopy||'', /2–8/,
    'the real mobile button must advertise the supported 2–8 player experimental lobby');
  assert.doesNotMatch(joinCopy||'', /two.player|iki oyunculu/i,
    'the shipped UI must not promise a two-seat-only game');
  const touchLayout=await mobilePage.evaluate(()=>{
    const dialog=document.querySelector('.bridge-activities-dialog');
    const canvas=document.querySelector('canvas.bridge-mini-golf-canvas');
    const shoot=document.querySelector('.bridge-mini-golf-shoot');
    const power=document.querySelector('.bridge-mini-golf-power');
    const powerRect=power?.getBoundingClientRect();
    return {
      dialogWidth:dialog?.clientWidth,dialogScroll:dialog?.scrollWidth,
      canvasWidth:canvas?.clientWidth,
      shootHeight:shoot?.getBoundingClientRect().height,
      powerWidth:powerRect?.width,
      webgl:Boolean(canvas?.getContext('webgl2')||canvas?.getContext('webgl')),
    };
  });
  assert.equal(touchLayout.webgl,true,'mobile emulation must render a real GPU context');
  assert.ok(touchLayout.dialogWidth>0 && touchLayout.dialogScroll<=touchLayout.dialogWidth+3,
    'Mini Golf dialog must not horizontally overflow a 390px viewport');
  assert.ok(touchLayout.canvasWidth>0 && touchLayout.canvasWidth<=390);
  assert.ok(touchLayout.shootHeight>=44,'touch shot control must be at least 44px');
  assert.ok(touchLayout.powerWidth>=100,'touch power range must remain usable');
  await mobilePage.locator('.bridge-mini-golf-shoot').tap();
  await mobilePage.waitForFunction(()=>
    /Strokes: 1|Vuruş: 1/.test(document.querySelector('.bridge-mini-golf-status')?.textContent||''),
    null,{timeout:12000});

  // Real 390px touch-device ONLINE journey: mobile Alice uses the shipped
  // Activities UI; Charlie connects through an INDEPENDENT actual PostgreSQL
  // member + production JWT + Socket.IO. All moves/score/replay are server-owned.
  const mobileOpponentContext=await browser.newContext({
    viewport:{width:600,height:480},
  });
  const mobileOpponentPage=await mobileOpponentContext.newPage();
  pages.push({page:mobileOpponentPage,context:mobileOpponentContext});
  await mobileOpponentPage.goto(fullOrigin+'/');
  await mobileOpponentPage.addScriptTag({content:built.outputFiles[0].text});
  await mobileOpponentPage.evaluate(({port,token,serverId})=>
    window.BridgeSocialRealBrowser.mountGolfOpponent(port,token,serverId),
    {port:fixture.port,token:fixture.charlieToken,serverId:fixture.serverId});
  await mobileOpponentPage.waitForFunction(()=>window.__miniGolfOpponent?.ready,
    null,{timeout:12000});
  await mobilePage.locator('.bridge-mini-golf-online-button').tap();
  await mobilePage.waitForFunction(()=>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===1,
    null,{timeout:12000});
  await mobileOpponentPage.evaluate(()=>window.__miniGolfOpponent.join());
  await mobileOpponentPage.waitForFunction(()=>
    window.__miniGolfOpponent.states.at(-1)?.players.length===2 &&
    window.__miniGolfOpponent.states.at(-1)?.phase==='waiting',
    null,{timeout:12000});
  await mobilePage.waitForFunction(()=>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===2 &&
    document.querySelector('.bridge-mini-golf-start:not([hidden])'),
    null,{timeout:12000});
  const liveHeading=await mobilePage.locator('.bridge-mini-golf-heading').textContent();
  assert.match(liveHeading||'', /2–8/,
    'online mode must no longer be titled solely as local solo practice');
  const touchStartHeight=await mobilePage.locator('.bridge-mini-golf-start')
    .evaluate(button=>button.getBoundingClientRect().height);
  assert.ok(touchStartHeight>=44,'the mobile host start target must be touch friendly');
  await mobilePage.locator('.bridge-mini-golf-start').tap();
  await mobilePage.waitForFunction(()=>
    document.querySelector('.bridge-mini-golf-online-status')?.textContent
      ?.match(/Your turn|Sıra sende/),
    null,{timeout:12000});
  await mobileOpponentPage.evaluate(()=>window.__miniGolfOpponent.sync());
  await mobileOpponentPage.waitForFunction(()=>
    window.__miniGolfOpponent.states.at(-1)?.phase==='playing',
    null,{timeout:12000});
  assert.equal(await mobilePage.locator('.bridge-mini-golf-reset').isDisabled(),true,
    'mobile online reset must never override the authoritative match');
  await mobilePage.locator('.bridge-mini-golf-shoot').tap();
  await mobilePage.waitForFunction(()=>
    [...document.querySelectorAll('.bridge-mini-golf-scoreboard li')]
      .some(li=>/Strokes: 1|Vuruş: 1/.test(li.textContent||'')) &&
    document.querySelector('.bridge-mini-golf-online-status')?.textContent
      ?.match(/Another player's turn|Başka oyuncunun sırası/),
    null,{timeout:12000});
  assert.equal(await mobilePage.locator('.bridge-mini-golf-shoot').isDisabled(),true,
    'mobile must block shooting when it is the other member’s turn');
  await mobileOpponentPage.evaluate(()=>window.__miniGolfOpponent.sync());
  await mobileOpponentPage.waitForFunction(()=>
    window.__miniGolfOpponent.states.at(-1)?.turnUserId &&
    window.__miniGolfOpponent.states.at(-1)?.players[0]?.won===true,
    null,{timeout:12000});
  await mobileOpponentPage.evaluate(()=>window.__miniGolfOpponent.shoot(0,60));
  await mobileOpponentPage.waitForFunction(()=>
    window.__miniGolfOpponent.states.at(-1)?.phase==='finished' &&
    window.__miniGolfOpponent.states.at(-1)?.results.length===2,
    null,{timeout:12000});
  await mobilePage.waitForFunction(()=>
    document.querySelectorAll('.bridge-mini-golf-results li').length===2 &&
    [...document.querySelectorAll('.bridge-mini-golf-results li')]
      .every(li=>/Place 1|Sıra 1/.test(li.textContent||'')),
    null,{timeout:16000});
  assert.equal(await mobilePage.locator('.bridge-mini-golf-shoot').isDisabled(),true);
  const touchRematchHeight=await mobilePage.locator('.bridge-mini-golf-rematch')
    .evaluate(button=>button.getBoundingClientRect().height);
  assert.ok(touchRematchHeight>=44,'mobile rematch consent must be touch friendly');
  await mobilePage.locator('.bridge-mini-golf-rematch').tap();
  await mobilePage.waitForFunction(()=>
    document.querySelector('.bridge-mini-golf-rematch')?.textContent?.includes('1/2'),
    null,{timeout:12000});
  assert.equal(await mobilePage.locator('.bridge-mini-golf-rematch').isDisabled(),true,
    'mobile cannot cast multiple votes');
  await mobileOpponentPage.evaluate(()=>window.__miniGolfOpponent.rematch());
  await mobileOpponentPage.waitForFunction(()=>
    window.__miniGolfOpponent.states.at(-1)?.phase==='playing' &&
    window.__miniGolfOpponent.states.at(-1)?.players.every(p=>p.strokes===0) &&
    window.__miniGolfOpponent.states.at(-1)?.results.length===0,
    null,{timeout:12000});
  await mobilePage.waitForFunction(()=>
    document.querySelectorAll('.bridge-mini-golf-results li').length===0 &&
    document.querySelector('.bridge-mini-golf-online-status')?.textContent
      ?.match(/Your turn|Sıra sende/),
    null,{timeout:16000});
  await mobilePage.locator('.bridge-mini-golf-online-button').tap();
  await mobilePage.waitForFunction(()=>
    document.querySelectorAll('.bridge-mini-golf-scoreboard li').length===0,
    null,{timeout:12000});
  await mobileOpponentPage.evaluate(()=>window.__miniGolfOpponent.sync());
  await mobileOpponentPage.waitForFunction(()=>
    window.__miniGolfOpponent.states.at(-1)?.phase==='waiting' &&
    window.__miniGolfOpponent.states.at(-1)?.players.length===1,
    null,{timeout:12000});
  await mobileOpponentPage.evaluate(()=>window.__miniGolfOpponent.dispose());
  assert.deepEqual(mobileErrors,[],'mobile online journey must not cause runtime errors');
  console.log('BRIDGE_MINI_GOLF_MOBILE_CHROMIUM_ONLINE_TWO_PLAYER:2/2:0_skipped');

  await mobilePage.locator('.bridge-mini-golf-back').tap();
  assert.equal(await mobilePage.locator('.bridge-activities-card').count(),10);
  await mobilePage.locator('[data-game-id="eight-ball-pool"]').tap();
  const mobilePool=mobilePage.locator('canvas.bridge-pool-canvas');
  await mobilePool.waitFor({state:'visible'});
  const mobilePoolLayout=await mobilePage.evaluate(()=>{
    const d=document.querySelector('.bridge-activities-dialog');
    const shoot=document.querySelector('.bridge-pool-shoot');
    const canvas=document.querySelector('canvas.bridge-pool-canvas');
    return {overflow:(d?.scrollWidth||0)-(d?.clientWidth||0),
      shotHeight:shoot?.getBoundingClientRect().height||0,
      webgl:Boolean(canvas?.getContext('webgl2')||canvas?.getContext('webgl'))};
  });
  assert.ok(mobilePoolLayout.overflow<=3,'mobile pool must not horizontally overflow');
  assert.ok(mobilePoolLayout.shotHeight>=44,'pool mobile cue target must be touch friendly');
  assert.equal(mobilePoolLayout.webgl,true);
  await mobilePage.locator('.bridge-pool-shoot').tap();
  await mobilePage.waitForFunction(()=>/Shots: 1|Vuruş: 1/.test(
    document.querySelector('.bridge-pool-status')?.textContent||''),null,{timeout:8000});
  // Touch/mobile viewport is a real Chromium emulation, not a physical
  // Android/iOS device. Verify visible player status, 44px tap target and
  // the offline 3D renderer without claiming a native mobile acceptance.
  await mobilePage.locator('.bridge-pool-hotseat-launch').tap();
  await mobilePage.locator('.bridge-pool-hotseat-status').waitFor({state:'visible'});
  const touchLocal=await mobilePage.evaluate(()=>{
    const dialog=document.querySelector('.bridge-activities-dialog');
    const shoot=document.querySelector('.bridge-pool-hotseat-shoot');
    const canvas=document.querySelector('.bridge-pool-canvas');
    return {overflow:(dialog?.scrollWidth||0)-(dialog?.clientWidth||0),
      targetHeight:shoot?.getBoundingClientRect().height||0,
      webgl:Boolean(canvas?.getContext('webgl2')||canvas?.getContext('webgl')),
      status:document.querySelector('.bridge-pool-hotseat-status')?.textContent||''};
  });
  assert.ok(touchLocal.overflow<=3,'2-player Pool local mobile layout must not overflow');
  assert.ok(touchLocal.targetHeight>=44,'2-player Pool mobile shoot needs a real touch target');
  assert.equal(touchLocal.webgl,true);
  assert.match(touchLocal.status,/Player 1.*Break shot/);
  const localMobilePower=mobilePage.locator('input.bridge-pool-hotseat-power');
  await localMobilePower.tap({position:{x:2,y:20}});
  assert.equal(await localMobilePower.inputValue(),'10',
    'real touch must set legal minimum power, not an injected value');
  await mobilePage.locator('.bridge-pool-hotseat-shoot').tap();
  await mobilePage.waitForFunction(()=>
    /Player 2.*Illegal break.*Shots: 1/.test(
      document.querySelector('.bridge-pool-hotseat-status')?.textContent||''),
    null,{timeout:15000});
  assert.equal(await mobilePage.locator('.bridge-pool-hotseat-shoot').isDisabled(),true);
  await mobilePage.locator('.bridge-pool-hotseat-decisions button').nth(1).tap();
  await mobilePage.waitForFunction(()=>
    /Player 2.*Break shot.*Shots: 0/.test(
      document.querySelector('.bridge-pool-hotseat-status')?.textContent||'') &&
    document.querySelector('.bridge-pool-hotseat-shoot')?.disabled===false,
    null,{timeout:10000});
  assert.deepEqual(mobileErrors,[],
    'real mobile Chromium local 8-Ball touch must not cause uncaught page errors');
  await mobilePage.locator('.bridge-pool-hotseat-back').tap();
  await mobilePage.locator('.bridge-pool-back').tap();
  assert.equal(await mobilePage.locator('.bridge-activities-card').count(),10);
  await mobilePage.locator('.bridge-activities-close').tap();
  console.log('BRIDGE_3D_POOL_MOBILE_CHROMIUM_TOUCH_LOCAL_HOTSEAT:1/1:0_skipped');
  console.log('BRIDGE_3D_POOL_MOBILE_CHROMIUM_REAL_TOUCH_TURN_RERACK:1/1:0_skipped');
  console.log('BRIDGE_3D_POOL_REAL_WEBGL_CONTEXT_LOSS_NO_RESUME:1/1:0_skipped');
  console.log('BRIDGE_3D_POOL_MOBILE_CHROMIUM_TOUCH_SOLO:1/1:0_skipped');
  console.log('BRIDGE_MINI_GOLF_REAL_MOBILE_CHROMIUM_TOUCH:1/1:0_skipped');

  console.log('BRIDGE_3D_MINI_GOLF_REAL_AUTH_APP_JOURNEY:1/1:0_skipped');
  await fullPage.locator('.bridge-activities-tab[data-tab="social"]').click();
  // Language is user-configurable; the join control is the single direct
  // social-body button (directional buttons live in a separate controls div).
  const joinFromRealApp = fullPage.locator(
    '.bridge-activities-body > button.bridge-room-direction');
  assert.equal(await joinFromRealApp.isEnabled(), true,
    'real AppState selected server must allow explicit opt-in');
  assert.equal(await alice.evaluate(() =>
    window.__bridge3DSmoke.lastFrame.peers.length), 1,
    'real authenticated shell must not autojoin before user click');
  await joinFromRealApp.click();
  await fullPage.waitForFunction(() =>
    [...document.querySelectorAll('p.bridge-room-status[role="status"]')]
      .some(node => node.textContent?.includes('Ortak odada') ||
        node.textContent?.includes('In shared room')),
    null, { timeout: 12000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 2,
    null, { timeout: 12000 });
  await fullPage.keyboard.press('Escape');
  await fullPage.waitForFunction(() =>
    !document.querySelector('.bridge-activities-overlay') &&
    document.getElementById('app')?.inert === false,
    null, { timeout: 10000 });
  await alice.waitForFunction(() =>
    window.__bridge3DSmoke.lastFrame?.peers.length === 1,
    null, { timeout: 10000 });
  assert.equal(await fullPage.locator('#app').isVisible(), true,
    'closing the room must not log the real user out');
  assert.deepEqual(fullErrors, [],
    'real SPA bootstrap/login/3D journey must not raise uncaught page errors');
  console.log('SOCIAL_3D_REAL_EXPRESS_LOGIN_FULL_APP_SHELL:1/1:0_skipped');
  console.log('SOCIAL_3D_REAL_BROWSER_MULTISERVER_EVENT_ISOLATION:1/1:0_skipped');
  console.log('SOCIAL_3D_SHIPPED_HTML_CSS_CSP_RAIL_JOIN_ESCAPE:1/1:0_skipped');
  console.log('SOCIAL_3D_REAL_ACTIVITIES_PANEL_JOIN_SWITCH_LOGOUT:1/1:0_skipped');
  console.log('SOCIAL_3D_REAL_BROWSER_SERVER_ERROR_LEAVE:1/1:0_skipped');
  console.log('SOCIAL_3D_REAL_BROWSER_MEMBERSHIP_REVOKED:1/1:0_skipped');
  console.log('SOCIAL_3D_REAL_BROWSER_WEBGL_TWO_USERS:2/2:0_skipped');
  console.log('SOCIAL_3D_REAL_BROWSER_MOVEMENT_AND_LEAVE:2/2:0_skipped');
  console.log('SOCIAL_3D_REAL_WEBGL1_CONTEXT_LOSS_REJOIN:1/1:0_skipped');
  console.log('SOCIAL_3D_REAL_WEBGL2_CONTEXT_LOSS_REJOIN:1/1:0_skipped');
  console.log('SOCIAL_3D_REAL_BROWSER_DPR_QUALITY_BOUNDS:3/3:0_skipped');
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
