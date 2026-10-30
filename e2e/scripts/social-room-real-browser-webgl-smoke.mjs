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
  env: { ...process.env, NODE_ENV: 'integration', BRIDGE_SOCIAL_3D_MULTIPLAYER: '1', BRIDGE_MINI_GOLF_MULTIPLAYER: '1' },
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
  await bob.waitForFunction(() => window.__miniGolfProof?.states.at(-1)?.phase === 'playing',
    null, { timeout: 10000 });
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
    window.__bridge3DSmoke.socket.emit('mini-golf:sync', {serverId}),fixture.serverId);
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
  // The 10 selected mini games remain correctly marked planned, not playable.
  await panelPage.getByRole('tab', { name: '3D Mini Games' }).click();
  assert.equal(await panelPage.locator('.bridge-activities-card').count(), 10);
  assert.equal(await panelPage.locator('.bridge-activities-planned').count(), 9);
  assert.equal(await panelPage.locator('.bridge-activities-solo').count(), 1,
    'solo-only Mini Golf must not be mistaken for multiplayer ready');
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
  const visual = await shellPage.locator('.bridge-activities-overlay').evaluate(el => ({
    position: getComputedStyle(el).position,
    display: getComputedStyle(el).display,
    zIndex: Number(getComputedStyle(el).zIndex),
    dialogRadius: getComputedStyle(el.querySelector('.bridge-activities-dialog')).borderRadius,
  }));
  assert.equal(visual.position, 'fixed', 'production overlay CSS must apply');
  assert.equal(visual.display, 'flex');
  assert.ok(visual.zIndex >= 10000, 'overlay must cover shell content');
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
