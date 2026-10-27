import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMessagingController } from '../src/messaging-controller.mjs';
function setup() {
  let session = { phase: 'authenticated', epoch: 1, userId: 'A' }, connection = 'offline', n = 0;
  const sessions = new Set(), statuses = new Set(), messages = new Set(), sends = [];
  const read = { listServers: async () => [{ id: 's1', name: 'server' }], listChannels: async () => [{ id: 'c1', name: 'one' }, { id: 'c2', name: 'two' }], listMessages: async () => ({ messages: [] }) };
  const coordinator = { getState: () => session, getSession: () => session.phase === 'authenticated' ? { epoch: session.epoch, token: 'secret' } : null,
    subscribe(fn) { sessions.add(fn); return () => sessions.delete(fn); } };
  const realtime = { getStatus: () => connection, start() {}, dispose() {}, joinChannel() {},
    onStatus(fn) { statuses.add(fn); return () => statuses.delete(fn); }, onMessage(fn) { messages.add(fn); return () => messages.delete(fn); },
    async send(row) { sends.push(row); return { status: 'confirmed', messageId: 'persisted' }; } };
  const controller = createMessagingController({ coordinator, realtime, read, createId: () => `id-${++n}` });
  return { controller, read, sends, messages, realtime,
    switchAccount() { session = { ...session, epoch: 2, userId: 'B' }; for (const fn of sessions) fn(session); },
    online() { connection = 'online'; for (const fn of statuses) fn(connection); } };
}
const tick = () => new Promise(resolve => setImmediate(resolve));
async function selected(s) { await s.controller.start(); await s.controller.selectServer('s1'); await s.controller.selectChannel('c1'); }
test('offline optimistic draft is flushed on reconnect and server identity prevents duplicate rendering', async () => {
  const s = setup(); await selected(s);
  let historyCalls = 0;
  s.read.listMessages = async () => { historyCalls++; return { messages: [] }; };
  await s.controller.send('draft'); assert.equal(s.sends.length, 0);
  assert.equal(historyCalls, 0, 'offline queuing must not await an unreachable history request');
  assert.equal(s.controller.snapshot().drafts[0].status, 'queued');
  s.online(); await tick();
  assert.equal(s.sends.length, 1); assert.equal(s.sends[0].ackId, 'id-1');
  assert.equal(s.controller.snapshot().drafts[0].status, 'confirmed');
  assert.equal(JSON.stringify(s.controller.snapshot()).includes('secret'), false);
  s.controller.dispose();
});
test('late history cannot cross account selection boundaries', async () => {
  const s = setup(); await selected(s); let resolve;
  s.read.listMessages = () => new Promise(r => { resolve = r; });
  const old = s.controller.refresh(); s.switchAccount(); resolve({ messages: [{ _id: 'private-A', content: 'private' }] }); await old;
  assert.deepEqual(s.controller.snapshot().messages, []); assert.equal(s.controller.snapshot().channelId, null);
  s.controller.dispose();
});

test('a late history response cannot overwrite a newly selected channel', async () => {
  const s = setup(); await selected(s); let resolve;
  s.read.listMessages = channel => channel === 'c1' ? new Promise(r => { resolve = r; }) : Promise.resolve({ messages: [{ _id: 'c2-message' }] });
  const old = s.controller.refresh(); await s.controller.selectChannel('c2');
  resolve({ messages: [{ _id: 'old-c1' }] }); await old;
  assert.equal(s.controller.snapshot().channelId, 'c2');
  assert.deepEqual(s.controller.snapshot().messages.map(row => row._id), ['c2-message']);
  s.controller.dispose();
});
test('a live event received during history loading is retained once by server id', async () => {
  const s = setup(); await selected(s); let resolve;
  s.read.listMessages = () => new Promise(r => { resolve = r; });
  const work = s.controller.refresh();
  for (const fn of s.messages) fn({ _id: 'live', channelId: 'c1', content: 'new', createdAt: 2 });
  resolve({ messages: [{ _id: 'history', createdAt: 1 }, { _id: 'live', createdAt: 2 }] }); await work;
  assert.deepEqual(s.controller.snapshot().messages.map(row => row._id), ['history', 'live']);
  s.controller.dispose();
});
test('unknown sends require explicit retry; changing channels hides another channel draft', async () => {
  const s = setup(); await selected(s); s.realtime.send = async () => ({ status: 'unconfirmed' });
  s.online(); await tick(); await s.controller.send('uncertain');
  assert.equal(s.controller.snapshot().drafts[0].status, 'unconfirmed');
  await s.controller.selectChannel('c2'); assert.deepEqual(s.controller.snapshot().drafts, []);
  await assert.rejects(s.controller.retry('id-1'), /DRAFT_NOT_SELECTED/);
  s.controller.dispose();
});
