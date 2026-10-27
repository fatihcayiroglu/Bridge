// Realtime adapter contracts over a fake Socket.IO client and a fake coordinator.
// NOT a server, network or device test (see integration/ for the real backend).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createBridgeRealtime, RealtimeError } from '../src/bridge-realtime.mjs';

const ORIGIN = 'https://bridge.example';
const tick = async (n = 3) => { for (let i = 0; i < n; i += 1) await new Promise((r) => setImmediate(r)); };

function fakeIo() {
  const sockets = [];
  function connect(origin, options) {
    const handlers = new Map();
    const s = {
      origin, options, emitted: [], connected: false, disconnects: 0, connects: 0, handshakes: [],
      io: { opts: { reconnection: options.reconnection } },
      on(ev, fn) { handlers.set(ev, [...(handlers.get(ev) ?? []), fn]); return s; },
      emit(ev, ...args) { s.emitted.push([ev, ...args]); },
      removeAllListeners() { handlers.clear(); },
      disconnect() { s.connected = false; s.disconnects += 1; },
      connect() { s.connects += 1; s.handshakes.push(s.authToken()); },
      fire(ev, ...args) { for (const fn of handlers.get(ev) ?? []) fn(...args); },
      authToken() { let t; options.auth((v) => { t = v.token; }); return t; },
    };
    // Like socket.io, every connection attempt evaluates the auth callback.
    s.handshakes.push(s.authToken());
    sockets.push(s);
    return s;
  }
  return { connect, sockets };
}

function fakeCoordinator() {
  let state = { phase: 'authenticated', epoch: 1, userId: 'me', reason: null, serverSignOut: null };
  let token = 'at-1';
  const listeners = new Set();
  const refreshCalls = [];
  let refreshResult = () => { token = `at-${refreshCalls.length + 1}`; return { token, epoch: state.epoch }; };
  return {
    getSession: () => (state.phase === 'authenticated' ? { token, epoch: state.epoch } : null),
    getState: () => state,
    subscribe(l) { listeners.add(l); return () => listeners.delete(l); },
    async refreshAfterUnauthorized(failed) { refreshCalls.push(failed); return refreshResult(); },
    set(next) { state = { ...state, ...next }; for (const l of listeners) l(state); },
    setRefresh(fn) { refreshResult = fn; },
    refreshCalls,
  };
}

function setup(opts = {}) {
  const io = fakeIo();
  const coordinator = fakeCoordinator();
  const rt = createBridgeRealtime({ origin: ORIGIN, coordinator, connect: io.connect, confirmTimeoutMs: opts.timeout ?? 50 });
  rt.start();
  const s = io.sockets[0];
  s.fire('connect');
  return { io, coordinator, rt, s };
}

test('connects with the current access token over websocket and rejoins channels on reconnect', () => {
  const { s, rt } = setup();
  assert.equal(s.options.transports[0], 'websocket');
  assert.equal(s.authToken(), 'at-1');
  rt.joinChannel('c1');
  assert.deepEqual(s.emitted.at(-1), ['channel:join', 'c1']);
  s.fire('disconnect');
  assert.equal(rt.getStatus(), 'connecting');
  s.fire('connect');
  assert.deepEqual(s.emitted.at(-1), ['channel:join', 'c1']);
});

test('a send is confirmed only by our own message:new echo for that channel and content', async () => {
  const { s, rt } = setup();
  rt.joinChannel('c1');
  const p = rt.send({ serverId: 's1', channelId: 'c1', content: 'hi' });
  await tick();
  assert.deepEqual(s.emitted.at(-1), ['message:send', { serverId: 's1', channelId: 'c1', content: 'hi' }]);
  s.fire('message:new', { _id: 'm0', channelId: 'c1', content: 'hi', userId: 'someone-else' });
  s.fire('message:new', { _id: 'm1', channelId: 'c1', content: 'hi', userId: 'me' });
  assert.deepEqual(await p, { status: 'confirmed', messageId: 'm1' });
});

test('error:message fails the in-flight send; sends are serial so the refusal is unambiguous', async () => {
  const { s, rt } = setup();
  rt.joinChannel('c1');
  const a = rt.send({ serverId: 's1', channelId: 'c1', content: 'one' });
  const b = rt.send({ serverId: 's1', channelId: 'c1', content: 'two' });
  await tick();
  assert.equal(s.emitted.filter(([e]) => e === 'message:send').length, 1, 'second send waits');
  s.fire('error:message', { event: 'message:send', code: 'SLOW_MODE' });
  assert.deepEqual(await a, { status: 'failed', code: 'SLOW_MODE' });
  await tick();
  assert.equal(s.emitted.filter(([e]) => e === 'message:send').length, 2);
  s.fire('message:new', { _id: 'm2', channelId: 'c1', content: 'two', userId: 'me' });
  assert.equal((await b).status, 'confirmed');
});

test('no echo: UNCONFIRMED after the timeout, and nothing is ever resent', async () => {
  const { s, rt } = setup({ timeout: 20 });
  rt.joinChannel('c1');
  const r = await rt.send({ serverId: 's1', channelId: 'c1', content: 'lost?' });
  assert.deepEqual(r, { status: 'unconfirmed', reason: 'NO_ECHO' });
  s.fire('disconnect'); s.fire('connect');
  assert.equal(s.emitted.filter(([e]) => e === 'message:send').length, 1);
});

test('offline sends are refused as UNCONFIRMED/OFFLINE without emitting; inputs are validated', async () => {
  const { s, rt } = setup();
  rt.joinChannel('c1');
  s.fire('disconnect');
  assert.deepEqual(await rt.send({ serverId: 's1', channelId: 'c1', content: 'x' }), { status: 'unconfirmed', reason: 'OFFLINE' });
  assert.equal(s.emitted.some(([e]) => e === 'message:send'), false);
  await assert.rejects(rt.send({ serverId: 's1', channelId: 'c2', content: 'x' }), (e) => e instanceof RealtimeError && e.code === 'NOT_JOINED');
  await assert.rejects(rt.send({ serverId: '../x', channelId: 'c1', content: 'x' }), (e) => e.code === 'INVALID_ID');
  await assert.rejects(rt.send({ serverId: 's1', channelId: 'c1', content: '  ' }), (e) => e.code === 'INVALID_CONTENT');
});

test('auth refusal: one refresh with the failed token, then reconnect with the rotated token', async () => {
  const { s, rt, coordinator } = setup();
  s.fire('connect_error', new Error('Unauthorized'));
  await tick();
  assert.deepEqual(coordinator.refreshCalls, [{ token: 'at-1', epoch: 1 }]);
  assert.equal(s.connects, 1, 'reconnects once');
  assert.deepEqual(s.handshakes, ['at-1', 'at-2'], 'the reconnect presents the rotated token');
  s.fire('connect');
  assert.equal(rt.getStatus(), 'online');
});

test('auth refusal that cannot be refreshed ends realtime as auth-failed; transport errors do not refresh', async () => {
  const { s, rt, coordinator } = setup();
  s.fire('connect_error', new Error('xhr poll error'));
  await tick();
  assert.equal(coordinator.refreshCalls.length, 0);
  coordinator.setRefresh(() => null);
  s.fire('connect_error', new Error('Token revoked'));
  await tick();
  assert.equal(rt.getStatus(), 'auth-failed');
});

test('account switch / sign-out: the old socket is torn down, pending sends end UNCONFIRMED, old events are ignored', async () => {
  const { io, s, rt, coordinator } = setup({ timeout: 5000 });
  rt.joinChannel('c1');
  const seen = [];
  rt.onMessage((m) => seen.push(m._id));
  const pending = rt.send({ serverId: 's1', channelId: 'c1', content: 'in flight' });
  await tick();
  coordinator.set({ epoch: 2, userId: 'other' });
  assert.deepEqual(await pending, { status: 'unconfirmed', reason: 'SESSION_ENDED' });
  assert.equal(s.disconnects >= 1, true);
  assert.equal(io.sockets.length, 2, 'a new socket for the new session');
  s.fire('message:new', { _id: 'old', channelId: 'c1', content: 'x', userId: 'me' });
  assert.deepEqual(seen, []);
  coordinator.set({ phase: 'signed-out' });
  assert.equal(rt.getStatus(), 'offline');
  assert.equal(io.sockets[1].disconnects >= 1, true);
});

test('defence in depth: an old socket can neither deliver events nor obtain the new account token after a switch', async () => {
  const io = fakeIo();
  const coordinator = fakeCoordinator();
  // A client implementation without removeAllListeners: the epoch fence alone must hold.
  const connect = (o, opts) => { const sock = io.connect(o, opts); delete sock.removeAllListeners; return sock; };
  const rt = createBridgeRealtime({ origin: ORIGIN, coordinator, connect, confirmTimeoutMs: 50 });
  rt.start();
  const old = io.sockets[0];
  old.fire('connect');
  rt.joinChannel('c1');
  const seen = [];
  rt.onMessage((m) => seen.push(m._id));
  coordinator.set({ epoch: 2, userId: 'other' });
  rt.joinChannel('c1'); // the new account opens the same channel
  old.fire('message:new', { _id: 'stale', channelId: 'c1', content: 'x', userId: 'me' });
  assert.deepEqual(seen, []);
  assert.equal(old.authToken(), '', 'the old socket gets no token of the new session');
});

test('only https origins and complete adapters are accepted', () => {
  const c = fakeCoordinator();
  assert.throws(() => createBridgeRealtime({ origin: 'http://x', coordinator: c, connect: () => ({}) }), (e) => e.code === 'INVALID_ADAPTER');
  assert.throws(() => createBridgeRealtime({ origin: ORIGIN, coordinator: {}, connect: () => ({}) }), (e) => e.code === 'INVALID_ADAPTER');
});

test('queued sends cannot cross an account transition even if the new account joins the same channel', async () => {
  const { io, s, rt, coordinator } = setup({ timeout: 5000 });
  rt.joinChannel('c1');
  const first = rt.send({ serverId: 's1', channelId: 'c1', content: 'first' });
  const queued = rt.send({ serverId: 's1', channelId: 'c1', content: 'private old draft' });
  await tick();
  coordinator.set({ epoch: 2, userId: 'other' });
  const next = io.sockets[1];
  next.fire('connect');
  rt.joinChannel('c1');
  assert.deepEqual(await first, { status: 'unconfirmed', reason: 'SESSION_ENDED' });
  await tick();
  assert.equal(next.emitted.some(([event]) => event === 'message:send'), false);
  assert.deepEqual(await queued, { status: 'unconfirmed', reason: 'SESSION_ENDED' });
  rt.dispose();
});

test('ackId sends require the exact correlated ACK; echoes and duplicate/wrong ACKs cannot settle another send', async () => {
  const { rt, s } = setup({ timeout: 1000 });
  rt.joinChannel('c1');
  let settled = false;
  const p = rt.send({ serverId: 's1', channelId: 'c1', content: 'same', ackId: 'draft-1' }).then(r => { settled = true; return r; });
  await tick();
  assert.equal(s.emitted.at(-1)[1].ackId, 'draft-1');
  s.fire('message:new', { _id: 'echo', channelId: 'c1', content: 'same', userId: 'me' });
  s.fire('message:ack', { ackId: 'draft-1', channelId: 'other', messageId: 'wrong' });
  s.fire('error:message', { event: 'message:send', ackId: 'old', code: 'DENIED' });
  await tick(); assert.equal(settled, false);
  s.fire('message:ack', { ackId: 'draft-1', channelId: 'c1', messageId: 'persisted' });
  assert.deepEqual(await p, { status: 'confirmed', messageId: 'persisted' });
  const next = rt.send({ serverId: 's1', channelId: 'c1', content: 'same', ackId: 'draft-2' });
  await tick();
  s.fire('message:ack', { ackId: 'draft-1', channelId: 'c1', messageId: 'persisted' });
  s.fire('message:ack', { ackId: 'draft-2', channelId: 'c1', messageId: 'second' });
  assert.deepEqual(await next, { status: 'confirmed', messageId: 'second' });
  rt.dispose();
});

test('an ackId cannot identify two payloads in one account; another account has its own namespace', async () => {
  const { rt, s, io, coordinator } = setup({ timeout: 5000 });
  rt.joinChannel('c1');
  const first = rt.send({ serverId: 's1', channelId: 'c1', content: 'original', ackId: 'stable' });
  await tick();
  await assert.rejects(rt.send({ serverId: 's1', channelId: 'c1', content: 'changed', ackId: 'stable' }), e => e.code === 'IDEMPOTENCY_CONFLICT');
  s.fire('message:ack', { ackId: 'stable', channelId: 'c1', messageId: 'original-id' });
  assert.equal((await first).messageId, 'original-id');
  coordinator.set({ epoch: 2, userId: 'other' });
  const next = io.sockets[1]; next.fire('connect'); rt.joinChannel('c1');
  const other = rt.send({ serverId: 's1', channelId: 'c1', content: 'different account', ackId: 'stable' });
  await tick();
  next.fire('message:ack', { ackId: 'stable', channelId: 'c1', messageId: 'other-id' });
  assert.equal((await other).messageId, 'other-id');
  rt.dispose();
});
