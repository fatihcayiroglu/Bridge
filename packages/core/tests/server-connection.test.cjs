const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { normalizeServerUrl, ServerConnection, isBridgeLiveness, SERVER_PROBE_TIMEOUT_MS } = require('../dist');

const json = (body, ok = true) => ({ ok, json: async () => body });
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('the extracted desktop origin contract preserves HTTPS, loopback and credential rejection', () => {
  for (const [input, origin] of [
    [' chat.example.com/path?q=1#fragment ', 'https://chat.example.com'],
    ['HTTPS://Chat.Example.com:443/', 'https://chat.example.com'],
    ['http://localhost:3000', 'http://localhost:3000'],
    ['http://127.0.0.1:3000', 'http://127.0.0.1:3000'],
    ['http://[::1]:3000', 'http://[::1]:3000'],
  ]) assert.deepEqual(normalizeServerUrl(input), { ok: true, origin });
  for (const [input, reason] of [
    [null, 'empty'], ['', 'empty'], [42, 'empty'], ['https://', 'invalid'],
    ['file:///private', 'invalid'], ['ftp://example.com', 'invalid'],
    ['https://user:secret@example.com', 'credentials'],
    ['http://192.168.1.4', 'insecure'], ['http://10.0.2.2:3000', 'insecure'],
  ]) assert.deepEqual(normalizeServerUrl(input), { ok: false, reason });
  assert.deepEqual(normalizeServerUrl('http://10.0.2.2:3000', { allowAndroidEmulatorLoopback: true }),
    { ok: true, origin: 'http://10.0.2.2:3000' });
  assert.equal(normalizeServerUrl('http://10.0.2.3:3000', { allowAndroidEmulatorLoopback: true }).ok, false);
  assert.equal(normalizeServerUrl('http://10.0.2.2:3000', { allowAndroidEmulatorLoopback: false }).ok, false);
});

test('liveness proves the existing public protocol shape, not authentication or arbitrary JSON', () => {
  assert.equal(isBridgeLiveness({ status: 'ok', check: 'liveness' }), true);
  for (const body of [null, [], 'ok', {}, { status: 'ok' }, { status: 'bad', check: 'liveness' },
    { status: 'ok', check: 'readiness' }]) assert.equal(isBridgeLiveness(body), false);
});

test('a real HTTP fixture receives the exact public endpoint without credentials or redirects', async t => {
  let seen;
  const server = http.createServer((req, res) => {
    seen = { path: req.url, cookie: req.headers.cookie, authorization: req.headers.authorization };
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ status: 'ok', check: 'liveness' }));
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const connection = new ServerConnection(fetch);
  t.after(() => connection.dispose());
  const origin = 'http://127.0.0.1:' + server.address().port;
  connection.setTarget(origin + '/some/path');
  await connection.connect();
  assert.deepEqual(connection.getSnapshot(), { state: 'connected', origin });
  assert.deepEqual(seen, { path: '/api/health/live', cookie: undefined, authorization: undefined });
});

test('rejects a real redirect instead of probing a different origin', async t => {
  let targetRequests = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api/health/live') {
      res.writeHead(302, { location: '/fake-health' }); res.end();
    } else { targetRequests++; res.end(JSON.stringify({ status: 'ok', check: 'liveness' })); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => new Promise(done => server.close(done)));
  const connection = new ServerConnection(fetch);
  t.after(() => connection.dispose());
  connection.setTarget('http://127.0.0.1:' + server.address().port);
  await connection.connect();
  assert.deepEqual(connection.getSnapshot(), { state: 'error', reason: 'unavailable' });
  assert.equal(targetRequests, 0);
});

test('validates before any network operation and never emits backend error details', async () => {
  let calls = 0;
  const connection = new ServerConnection(async () => { calls++; return json({ secret: 'never-display' }, false); });
  connection.setTarget('https://user:secret@example.com');
  await connection.connect();
  assert.equal(calls, 0);
  assert.deepEqual(connection.getSnapshot(), { state: 'error', reason: 'credentials' });
  connection.setTarget('https://example.com'); await connection.connect();
  assert.deepEqual(connection.getSnapshot(), { state: 'error', reason: 'not-bridge' });
  const malformed = new ServerConnection(async () => ({ ok: true, json: async () => { throw new Error('private body'); } }));
  malformed.setTarget('https://example.com'); await malformed.connect();
  assert.deepEqual(malformed.getSnapshot(), { state: 'error', reason: 'unavailable' });
});

test('superseded transport success and failure cannot overwrite a newer target, even if abort is ignored', async () => {
  for (const oldFails of [false, true]) {
    const old = deferred(), fresh = deferred();
    const signals = [];
    const connection = new ServerConnection((_url, init) => { signals.push(init.signal); return signals.length === 1 ? old.promise : fresh.promise; });
    connection.setTarget('https://old.example'); const first = connection.connect();
    connection.setTarget('https://new.example'); const second = connection.connect();
    assert.equal(signals[0].aborted, true);
    if (oldFails) old.reject(new Error('private old failure')); else old.resolve(json({ status: 'ok', check: 'liveness' }));
    await first;
    assert.deepEqual(connection.getSnapshot(), { state: 'checking', origin: 'https://new.example' });
    assert.equal(signals[1].aborted, false);
    fresh.resolve(json({ status: 'ok', check: 'liveness' })); await second;
    assert.deepEqual(connection.getSnapshot(), { state: 'connected', origin: 'https://new.example' });
    connection.dispose();
  }
});

test('body decoding, disposal and subscriptions obey the same target lifetime', async () => {
  const body = deferred();
  const connection = new ServerConnection(async () => ({ ok: true, json: () => body.promise }));
  let notifications = 0;
  const unsubscribe = connection.subscribe(() => { notifications++; });
  connection.setTarget('https://old.example'); const pending = connection.connect();
  await Promise.resolve(); await Promise.resolve();
  connection.setTarget('https://new.example');
  const before = notifications;
  body.resolve({ status: 'ok', check: 'liveness' }); await pending;
  assert.equal(notifications, before);
  assert.deepEqual(connection.getSnapshot(), { state: 'idle' });
  unsubscribe(); connection.setTarget('https://another.example');
  assert.equal(notifications, before);
  const late = deferred();
  const disposed = new ServerConnection(() => late.promise);
  let emitted = 0; disposed.subscribe(() => { emitted++; });
  disposed.setTarget('https://example.com'); const sending = disposed.connect();
  disposed.dispose(); const atClose = emitted;
  assert.deepEqual(disposed.getSnapshot(), { state: 'idle' });
  late.resolve(json({ status: 'ok', check: 'liveness' })); await sending;
  assert.equal(emitted, atClose);
  connection.dispose();
});

test('the deadline remains authoritative when a transport ignores cancellation', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const response = deferred();
  const connection = new ServerConnection(() => response.promise);
  connection.setTarget('https://example.com'); const pending = connection.connect();
  t.mock.timers.tick(SERVER_PROBE_TIMEOUT_MS);
  assert.deepEqual(connection.getSnapshot(), { state: 'error', reason: 'unavailable' });
  response.resolve(json({ status: 'ok', check: 'liveness' })); await pending;
  assert.deepEqual(connection.getSnapshot(), { state: 'error', reason: 'unavailable' });
  connection.dispose();
});

test('native URL primitives still pass through the shared credential and transport rules', () => {
  const options = {parseUrl: input => new URL(input)};
  assert.deepEqual(normalizeServerUrl('HTTPS://Chat.Example.com:443/path', options),
    {ok: true, origin: 'https://chat.example.com'});
  assert.deepEqual(normalizeServerUrl('https://user:secret@chat.example.com', options),
    {ok: false, reason: 'credentials'});
  assert.deepEqual(normalizeServerUrl('http://remote.example', options), {ok: false, reason: 'insecure'});
  assert.deepEqual(normalizeServerUrl('https://chat.example', {parseUrl: () => { throw new Error('platform parse failure'); }}),
    {ok: false, reason: 'invalid'});
});
