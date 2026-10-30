import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { uiSurvey } from '../scripts/ios-login-evidence.mjs';
import http from 'node:http';
import { once, EventEmitter } from 'node:events';
import { observeRequest, requestKind, tlsEvent, transportProgress, TRANSPORT_PREFIX } from '../scripts/integration-proxy-evidence.mjs';

test('alphabetic account names, passwords and message text are never UI evidence', () => {
  const source = '<A><XCUIElementTypeStaticText name="Private Account"/>' +
    '<XCUIElementTypeButton label="SecretPassword"/>' +
    '<XCUIElementTypeLink name="Meet me tomorrow"/>' +
    '<XCUIElementTypeButton name="Reload"/></A>';
  const report = uiSurvey(source);
  assert.deepEqual(report.plainLabels, ['Reload']);
  assert.doesNotMatch(JSON.stringify(report), /Private Account|SecretPassword|Meet me tomorrow/);
});

test('the iOS authentication journey never captures screenshots', () => {
  const driver = readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(driver, /['"]\/screenshot['"]|await screenshot\(/);
});

test('page and authentication routes become fixed categories without queries or IDs', () => {
  for (const [method, route, kind] of [
    ['GET', '/native-auth?state=secret&code_challenge=private', 'document'],
    ['GET', '/?code=secret', 'document'], ['GET', '/assets/private-name.js?token=secret', 'script'],
    ['GET', '/assets/private-name.css', 'style'], ['GET', '/api/csrf-token', 'csrf'],
    ['POST', '/api/login?password=secret', 'native-login'],
    ['POST', '/api/refresh/native-authorize', 'native-authorize'],
    ['POST', '/api/native-auth/token', 'native-code'], ['POST', '/api/native-auth/refresh', 'native-refresh'],
    ['GET', '/api/users/private-name', 'other'], ['POST', 'constructor', 'other'],
    ['DELETE', '/api/native-auth/token', 'other'],
  ]) assert.equal(requestKind(method, route), kind);
});

test('real HTTP completion and connection loss have distinct evidence, without request content', async t => {
  const events = [];
  let interruptedClosed;
  const server = http.createServer((req, res) => {
    const progress = observeRequest(req, res, row => events.push(row));
    progress.response(200);
    if (req.url.startsWith('/native-auth')) {
      interruptedClosed = once(res, 'close');
      res.writeHead(200); res.write('private response body');
      setImmediate(() => res.destroy());
    } else res.end('private response body');
  });
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(origin + '/?token=SecretPassword', { headers: { Cookie: 'private-cookie', Authorization: 'Bearer private-token' } });
  await response.text();
  const closed = once(server, 'close');
  await new Promise((resolve, reject) => {
    const request = http.get(origin + '/native-auth?state=SecretState', res => {
      res.resume(); res.on('error', resolve); res.on('end', () => reject(new Error('ABORT_EXPECTED')));
    });
    request.on('error', resolve);
  });
  await interruptedClosed;
  server.close(); await closed;
  assert.deepEqual(events.map(row => row.phase), ['request', 'response', 'complete', 'request', 'response', 'aborted']);
  assert.ok(events.every(row => row.kind === 'document'));
  assert.doesNotMatch(JSON.stringify(events), /Secret|private|Cookie|Bearer|127\.0\.0\.1/);
});

test('upstream errors and TLS failures retain enum codes only', () => {
  const rows = [];
  const response = new EventEmitter();
  observeRequest({ method: 'POST', url: '/api/login?password=private' }, response, row => rows.push(row)).upstreamError();
  assert.deepEqual(rows, [{ kind: 'native-login', phase: 'request' }, { kind: 'native-login', phase: 'upstream-error' }]);
  assert.deepEqual(tlsEvent(), { kind: 'tls', phase: 'secure' });
  assert.deepEqual(tlsEvent({ code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA', message: 'private certificate data' }),
    { kind: 'tls', phase: 'client-error', code: 'ERR_SSL_TLSV1_ALERT_UNKNOWN_CA' });
  assert.deepEqual(tlsEvent({ code: 'private-name', message: 'SecretPassword' }), { kind: 'tls', phase: 'client-error', code: 'OTHER' });
});

test('transport aggregation discards arbitrary fields, malformed lines and unrecognized enums', () => {
  const log = [
    { kind: 'document', phase: 'request', url: '/?state=SecretState' },
    { kind: 'document', phase: 'request', body: 'SecretPassword' },
    { kind: 'document', phase: 'response', status: 200, cookie: 'SecretCookie' },
    { kind: 'private-user', phase: 'request' }, { kind: 'script', phase: 'private-password' },
    { kind: 'tls', phase: 'client-error', code: 'SecretPassword' }, null,
  ].map(row => TRANSPORT_PREFIX + JSON.stringify(row)).join('\n') + '\nNATIVE_TRANSPORT {invalid';
  const result = transportProgress(log);
  assert.deepEqual(result, [
    { kind: 'document', phase: 'request', count: 2 },
    { kind: 'document', phase: 'response', status: 200, count: 1 },
    { kind: 'tls', phase: 'client-error', code: 'OTHER', count: 1 },
  ]);
  assert.doesNotMatch(JSON.stringify(result), /Secret|private|cookie|body|url/);
  assert.deepEqual(transportProgress(''), []);
});
