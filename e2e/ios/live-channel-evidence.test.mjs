import test from 'node:test';
import assert from 'node:assert/strict';
import { publicationApiFacts, publicationViewFacts } from './live-channel-evidence.mjs';

test('published-channel API evidence contains only status/count/visibility, not metadata', () => {
  const source = { status: 200, json: [
    { _id: 'expected-id', name: 'private-secret-channel', topic: 'private-secret-topic' },
    { _id: 'other-id', name: 'another-secret' },
  ] };
  const facts = publicationApiFacts(source, 'expected-id');
  assert.deepEqual(facts, { apiStatus: 200, apiContainsChannel: true, apiChannelCount: 2 });
  assert.equal(JSON.stringify(facts).includes('secret'), false);
  assert.equal(JSON.stringify(facts).includes('expected-id'), false);
  assert.deepEqual(publicationApiFacts({ status: 403, json: { error: 'details' } }, 'x'),
    { apiStatus: 403, apiContainsChannel: null, apiChannelCount: null });
});

test('WebView evidence normalizes missing or malformed values without leaking strings', () => {
  assert.deepEqual(publicationViewFacts({
    webviewContainsChannel: false, webviewChannelCount: 3, selectedServer: true,
    webviewVisible: true, browserOnline: false, secret: 'never-serialize',
  }), {
    webviewContainsChannel: false, webviewChannelCount: 3,
    selectedServer: true, webviewVisible: true, browserOnline: false,
  });
  assert.deepEqual(publicationViewFacts({ webviewChannelCount: -1, selectedServer: 'yes' }), {
    webviewContainsChannel: null, webviewChannelCount: null,
    selectedServer: null, webviewVisible: null, browserOnline: null,
  });
});
