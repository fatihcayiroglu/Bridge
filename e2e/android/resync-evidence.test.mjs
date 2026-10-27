// Unit controls for N02 evidence classification. NOT emulator evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isHistoryRequest, summarizeResync, startResyncRecorder } from './resync-evidence.mjs';

const events = (reconnected) => ({ 'bridge:socket-reconnected': reconnected, 'bridge:socket-ready': 0 });

test('only channel history requests are counted', () => {
  assert.equal(isHistoryRequest('https://localhost/api/channels/c1/messages?limit=50'), true);
  assert.equal(isHistoryRequest('http://10.0.2.2:3000/api/channels/c1/messages?limit=50&cursor=x'), true);
  assert.equal(isHistoryRequest('https://localhost/api/channels/c1'), false);
  assert.equal(isHistoryRequest('https://localhost/api/servers/s1/channels'), false);
  assert.equal(isHistoryRequest('not a url'), false);
});

test('classifies where the resync stopped', () => {
  assert.equal(summarizeResync(null, []).stage, 'page-unreadable');
  assert.equal(summarizeResync({ events: events(0) }, []).stage, 'no-reconnect-event');
  assert.equal(summarizeResync({ events: events(1) }, []).stage, 'no-history-request');
  assert.equal(summarizeResync({ events: events(1) }, ['failed', 409]).stage, 'history-request-failed');
  assert.equal(summarizeResync({ events: events(1) }, [409, 200]).stage, 'history-loaded-not-rendered');
});

test('the summary carries counts and statuses only', () => {
  const s = summarizeResync({ events: events(1) }, [200, 'failed', 200]);
  assert.deepEqual(s.historyStatuses, { 200: 2, failed: 1 });
  assert.equal(s.historyRequests, 3);
});

test('the recorder records history outcomes and in-page counts, without URLs', async () => {
  const handlers = {};
  const fakePage = {
    on: (name, fn) => { handlers[name] = fn; },
    off: (name) => { delete handlers[name]; },
    evaluate: async (fn) => (fn.toString().includes('__bridgeResyncEvidence = {')
      ? undefined : { events: { ...events(1), online: 1 } }),
  };
  const rec = await startResyncRecorder(fakePage);
  handlers.response({ url: () => 'https://localhost/api/channels/secret-id/messages?limit=50', status: () => 200 });
  handlers.response({ url: () => 'https://localhost/api/servers', status: () => 200 });
  handlers.requestfailed({ url: () => 'https://localhost/api/channels/secret-id/messages?limit=50' });
  const s = await rec.read();
  assert.equal(s.stage, 'history-loaded-not-rendered');
  assert.deepEqual(s.historyStatuses, { 200: 1, failed: 1 });
  assert.equal(handlers.response, undefined, 'listeners are removed after read');
  assert(!JSON.stringify(s).includes('secret-id'));
});
