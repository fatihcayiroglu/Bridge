// Adapter contract tests only: NOT Android/iOS native, auth, or P7 acceptance.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BridgeReadError, createBridgeReadApi } from '../src/bridge-read-api.mjs';

const ORIGIN = 'https://bridge.example.test';
const activeSession = () => ({ token: 'in-memory-test-token', epoch: 1 });
const json = (data, status = 200) => Response.json(data, { status });

function harness(reply = json([]), getSession = activeSession) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    return typeof reply === 'function' ? reply(url, options) : reply;
  };
  return {
    api: createBridgeReadApi({ origin: ORIGIN, getSession, fetchImpl }),
    calls,
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof BridgeReadError);
    assert.equal(error.name, 'BridgeReadError');
    assert.equal(error.code, code);
    assert.equal(error.message, code, 'do not leak response or native error text');
    return true;
  });
}

test('GET /api/me reads only authenticated profile and does not expose token in result', async () => {
  const { api, calls } = harness(() => json({
    _id: 'user_1', displayName: 'Bridge Friend', email: 'private@example.test',
  }));
  assert.deepEqual(await api.getMe(), { id: 'user_1', displayName: 'Bridge Friend' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ORIGIN + '/api/me');
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.credentials, 'omit');
  assert.equal(calls[0].options.headers.Authorization, 'Bearer in-memory-test-token');
  assert.equal(calls[0].options.headers.Accept, 'application/json');
  assert.equal(JSON.stringify(await api.getMe()).includes('in-memory-test-token'), false);
});

test('lists only mapped server and visible channel fields using confirmed routes', async () => {
  const { api, calls } = harness((url) => url.endsWith('/channels')
    ? json([{ _id: 'chan-01', name: 'general', restricted: true }])
    : json([{ _id: 'server_01', name: 'Community', members: [{ secret: 'test' }] }]));
  assert.deepEqual(await api.listServers(), [{ id: 'server_01', name: 'Community' }]);
  assert.deepEqual(await api.listChannels('server_01'), [{ id: 'chan-01', name: 'general' }]);
  assert.equal(calls[0].url, ORIGIN + '/api/servers');
  assert.equal(calls[1].url, ORIGIN + '/api/servers/server_01/channels');
});

test('lists message envelope with bounded limit without claiming send or live sync', async () => {
  const { api, calls } = harness(() => json({
    messages: [{ _id: 'msg-01', content: 'Hello' }],
    hasMore: true,
    nextCursor: 'opaque-next',
    prevCursor: null,
    count: 1,
  }));
  assert.deepEqual(await api.listMessages('channel-01', { limit: 25 }), {
    messages: [{ _id: 'msg-01', content: 'Hello' }],
    hasMore: true,
    nextCursor: 'opaque-next',
  });
  assert.equal(calls[0].url, ORIGIN + '/api/channels/channel-01/messages?limit=25');
  assert.deepEqual(await api.listMessages('channel-01'), {
    messages: [{ _id: 'msg-01', content: 'Hello' }],
    hasMore: true,
    nextCursor: 'opaque-next',
  });
  assert.equal(calls[1].url, ORIGIN + '/api/channels/channel-01/messages?limit=50');
});

test('rejects non-HTTPS, embedded credentials, redirects to paths, and invalid adapters', () => {
  const getSession = activeSession;
  const fetchImpl = async () => json([]);
  for (const origin of [
    'http://bridge.example.test',
    'https://u:p@bridge.example.test',
    'https://bridge.example.test/admin',
    'https://bridge.example.test/?token=secret',
    'javascript:alert(1)',
    'not-a-url',
  ]) {
    assert.throws(() => createBridgeReadApi({ origin, getSession, fetchImpl }), {
      code: 'INVALID_ORIGIN',
    });
  }
  assert.throws(() => createBridgeReadApi({ origin: ORIGIN, getSession: null, fetchImpl }), {
    code: 'INVALID_ADAPTER',
  });
});

test('invalid URL ids and message limits fail before a network call', async () => {
  const { api, calls } = harness();
  for (const id of ['../private', 'server/name', '', 'with space', 'x?secret', 'a'.repeat(201)]) {
    await rejectsCode(api.listChannels(id), 'INVALID_ID');
    await rejectsCode(api.listMessages(id), 'INVALID_ID');
  }
  for (const limit of [0, 101, 1.2, '50', NaN, Infinity]) {
    await rejectsCode(api.listMessages('channel-01', { limit }), 'INVALID_LIMIT');
  }
  assert.equal(calls.length, 0);
});

test('an absent or invalid session blocks all traffic and does not ask the server', async () => {
  for (const session of [null, { token: '', epoch: 2 }, { token: 'x' }, { token: 'x', epoch: null }]) {
    const { api, calls } = harness(json([]), () => session);
    await rejectsCode(api.listServers(), 'AUTH_REQUIRED');
    assert.equal(calls.length, 0);
  }
  const { api } = harness(json([]), () => { throw new Error('secret value'); });
  await rejectsCode(api.listServers(), 'AUTH_REQUIRED');
});

test('rejects a response from the previous session after the transport resolves', async () => {
  const current = { token: 'accountA', epoch: 11 };
  const { api, calls } = harness(() => {
    current.token = 'accountB';
    current.epoch = 12;
    return json([{ _id: 'private-server', name: 'A only' }]);
  }, () => ({ ...current }));
  await rejectsCode(api.listServers(), 'SESSION_CHANGED');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer accountA');
});

test('rejects a response if account switches while JSON is being decoded', async () => {
  const current = { token: 'accountA', epoch: 9 };
  const { api } = harness({
    ok: true, status: 200,
    async json() {
      current.epoch = 10;
      return [{ _id: 'old-account-only', name: 'Not visible' }];
    },
  }, () => ({ ...current }));
  await rejectsCode(api.listServers(), 'SESSION_CHANGED');
});

test('maps authorization, account-change and server errors without response-body leakage', async () => {
  for (const [status, code] of [
    [401, 'AUTH_REQUIRED'],
    [403, 'FORBIDDEN'],
    [409, 'SESSION_CHANGED'],
    [429, 'REQUEST_REJECTED'],
    [503, 'SERVER_UNAVAILABLE'],
  ]) {
    const { api } = harness(json({ token: 'do-not-show', error: 'do-not-show' }, status));
    await rejectsCode(api.getMe(), code);
  }
});

test('malformed responses fail closed with no empty-list fallback', async () => {
  for (const payload of [null, {}, { servers: [] }, [{ _id: 'x' }], [{ name: 'y' }]]) {
    const { api } = harness(json(payload));
    await rejectsCode(api.listServers(), 'BAD_RESPONSE');
  }
  const { api: invalidProfile } = harness(json({ displayName: 'no ID' }));
  await rejectsCode(invalidProfile.getMe(), 'BAD_RESPONSE');
  const { api: invalidMessages } = harness(json({
    messages: [{ content: 'missing ID' }], hasMore: false, nextCursor: null,
  }));
  await rejectsCode(invalidMessages.listMessages('channel_1'), 'BAD_RESPONSE');
  const { api: invalidCursor } = harness(json({
    messages: [], hasMore: false, nextCursor: undefined,
  }));
  await rejectsCode(invalidCursor.listMessages('channel_1'), 'BAD_RESPONSE');
});

test('invalid JSON, network failures and abort are typed without leaking error details', async () => {
  const { api: invalidJson } = harness({ status: 200, ok: true, json: async () => {
    throw new Error('sensitive parse data');
  } });
  await rejectsCode(invalidJson.listServers(), 'BAD_RESPONSE');
  const { api: failedNetwork } = harness(() => {
    throw new Error('internal host and path');
  });
  await rejectsCode(failedNetwork.listServers(), 'NETWORK_FAILURE');
  const controller = new AbortController();
  controller.abort();
  const { api: aborted } = harness(() => {
    throw Object.assign(new Error('native cancellation details'), { name: 'AbortError' });
  });
  await rejectsCode(aborted.listServers({ signal: controller.signal }), 'ABORTED');
});

test('forwards cancellation signal without retrying automatically', async () => {
  const controller = new AbortController();
  const { api, calls } = harness(json([]));
  assert.deepEqual(await api.listServers({ signal: controller.signal }), []);
  assert.equal(calls[0].options.signal, controller.signal);
  assert.equal(calls.length, 1);
});
