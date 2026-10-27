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

test('the recorder counts history requests inside the page (CapacitorHttp bypasses the network stack), without URLs', async () => {
  // A minimal page: evaluate() runs the function against fake window/document globals.
  const listeners = {};
  const fakeWindow = {
    fetch: async (input) => {
      if (String(input).includes('fail')) throw new TypeError('Failed to fetch');
      return { status: String(input).includes('/messages') ? 200 : 204 };
    },
    addEventListener: () => {},
  };
  const fakeDocument = { addEventListener: (n, fn) => { (listeners[n] ||= []).push(fn); } };
  const page = {
    evaluate: async (fn, arg) => {
      const saved = { window: globalThis.window, document: globalThis.document, location: globalThis.location };
      Object.assign(globalThis, { window: fakeWindow, document: fakeDocument, location: { href: 'https://localhost/' } });
      try { return await fn(arg); } finally { Object.assign(globalThis, saved); }
    },
  };
  const original = fakeWindow.fetch;
  const rec = await startResyncRecorder(page);
  await fakeWindow.fetch('https://localhost/api/channels/secret-id/messages?limit=50');
  await fakeWindow.fetch('https://localhost/api/servers');
  await assert.rejects(fakeWindow.fetch('https://localhost/api/channels/fail/messages?limit=50'));
  for (const fn of listeners['bridge:socket-reconnected']) fn();
  const s = await rec.read();
  assert.equal(s.stage, 'history-loaded-not-rendered');
  assert.deepEqual(s.historyStatuses, { 200: 1, failed: 1 });
  assert.equal(s.events['bridge:socket-reconnected'], 1);
  assert.equal(fakeWindow.fetch, original, 'the page fetch is restored after read');
  assert(!JSON.stringify(s).includes('secret-id'));
});
