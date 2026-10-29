'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => instance.close(resolve)));
  return `http://127.0.0.1:${instance.address().port}`;
}
const load = () => import('./webdriver-http.mjs');

test('WebDriver receives delayed session headers and transmits the actual JSON body', async t => {
  const body = { capabilities: { alwaysMatch: { platformName: 'iOS' } } };
  let received;
  const base = await server(t, (request, response) => {
    let bytes = '';
    request.on('data', chunk => { bytes += chunk; });
    request.on('end', () => {
      received = { method: request.method, url: request.url, json: JSON.parse(bytes) };
      setTimeout(() => response.end(JSON.stringify({ value: { sessionId: 'native-session' } })), 100);
    });
  });
  const { webdriverRequest } = await load();
  assert.deepEqual(await webdriverRequest(base, 'POST', '/session', body, 2000), { sessionId: 'native-session' });
  assert.deepEqual(received, { method: 'POST', url: '/session', json: body });
});

test('WebDriver deadline aborts a stalled response instead of waiting indefinitely', async t => {
  let closed;
  const disconnected = new Promise(resolve => { closed = resolve; });
  const base = await server(t, (_request, response) => { response.once('close', closed); });
  const { webdriverRequest } = await load();
  await assert.rejects(webdriverRequest(base, 'POST', '/session', {}, 100), /ABORT_ERR/);
  await disconnected;
});

test('WebDriver failures never expose response messages, arguments or unrecognized error values', async t => {
  const secret = 'private-password-and-upload-name';
  const base = await server(t, (_request, response) => {
    response.statusCode = 500;
    response.end(JSON.stringify({ value: { error: secret, message: secret, stacktrace: secret } }));
  });
  const { webdriverRequest } = await load();
  await assert.rejects(webdriverRequest(base, 'POST', '/execute/sync', { args: [secret] }), error => {
    assert.equal(error.message, 'WebDriver sync failed (500; HTTP error)');
    assert(!error.message.includes(secret));
    return true;
  });
});

test('WebDriver fails on malformed JSON and oversized responses', async t => {
  const base = await server(t, (request, response) => {
    response.end(request.url === '/invalid' ? 'not JSON' : 'x'.repeat(1_048_577));
  });
  const { webdriverRequest } = await load();
  await assert.rejects(webdriverRequest(base, 'GET', '/invalid'), /returned invalid JSON/);
  await assert.rejects(webdriverRequest(base, 'GET', '/large'), /response exceeds limit/);
});

test('WebDriver preserves recognized W3C failure codes even on HTTP 200', async t => {
  const base = await server(t, (_request, response) => {
    response.end(JSON.stringify({ value: { error: 'no such context', message: 'sensitive command contents' } }));
  });
  const { webdriverRequest } = await load();
  await assert.rejects(webdriverRequest(base, 'POST', '/context'), { message: 'WebDriver context failed (200; no such context)' });
});

test('WebDriver preserves a configured base path and rejects incomplete W3C envelopes', async t => {
  const base = await server(t, (request, response) => {
    assert.equal(request.url, '/wd/hub/session');
    response.end('null');
  });
  const { webdriverRequest } = await load();
  await assert.rejects(webdriverRequest(base + '/wd/hub/', 'POST', '/session'), /invalid W3C response/);
});
