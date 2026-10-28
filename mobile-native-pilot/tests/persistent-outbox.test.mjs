import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersistentOutbox } from '../src/persistent-outbox.mjs';
import { createEncryptedOutboxJournal } from '../src/encrypted-outbox-journal.mjs';
import { sqliteTestPort } from './sqlite-test-port.mjs';
const tick = () => new Promise(resolve => setImmediate(resolve));
const input = { serverId: 's1', channelId: 'c1', content: 'queued payload' };
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'bridge-persistent-'));
  let epoch = 1, account = 'A', online = false, count = 0;
  const listeners = new Set(), sent = [];
  const coordinator = { getSession: () => account ? { epoch, token: 'not-a-real-token' } : null,
    getState: () => ({ epoch, userId: account, phase: account ? 'authenticated' : 'signed-out' }),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } };
  const realtime = { getStatus: () => online ? 'online' : 'offline', joinChannel() {},
    async send(row) { sent.push(row); return { status: 'confirmed', messageId: 'server-id' }; } };
  const config = { coordinator, realtime, createId: () => `ack-${++count}`,
    openJournal: user => createEncryptedOutboxJournal({ db: sqliteTestPort(join(directory, `${user}.db`)), keyHex: 'a'.repeat(64) }) };
  return { config, realtime, sent, online() { online = true; },
    switch(user) { account = user; epoch++; for (const fn of listeners) fn(); } };
}
test('queued draft and original ackId survive reopening; lost ACK retry does not allocate a new id', async () => {
  const s = setup(); let box = createPersistentOutbox(s.config);
  const id = await box.enqueue(input); assert.equal(id, 'ack-1');
  box.dispose(); await tick(); box = createPersistentOutbox(s.config); await box.ready();
  assert.equal(box.snapshot()[0].id, id); assert.equal(box.snapshot()[0].status, 'queued');
  s.online(); let calls = 0; const persisted = new Map();
  s.realtime.send = async row => { s.sent.push(row); persisted.set(row.ackId, 'server-id'); return ++calls === 1 ? { status: 'unconfirmed' } : { status: 'confirmed', messageId: persisted.get(row.ackId) }; };
  const a = box.flush(), b = box.flush(); assert.equal(a, b); await a;
  box.dispose(); await tick(); box = createPersistentOutbox(s.config); await box.ready();
  assert.equal(box.snapshot()[0].status, 'unconfirmed'); await box.flush(); assert.equal(calls, 1);
  await box.retry(id); assert.equal(calls, 2); assert.equal(persisted.size, 1);
  assert.equal(s.sent[0].ackId, s.sent[1].ackId); assert.equal(box.snapshot()[0].messageId, 'server-id'); box.dispose();
});
test('write-ahead failure prevents network emission, with no memory fallback', async () => {
  const s = setup(); const open = s.config.openJournal;
  const box = createPersistentOutbox({ ...s.config, openJournal: async user => {
    const journal = await open(user); return { ...journal, mark: async () => { throw new Error('DISK_COMMIT_FAILED'); } };
  } });
  await box.enqueue(input); s.online(); await assert.rejects(box.flush(), /DISK_COMMIT_FAILED/);
  assert.equal(s.sent.length, 0); assert.equal(box.snapshot()[0].status, 'queued'); box.dispose();
});
test('account switch in flight isolates late ACK and restores old account with the same uncertain id', async () => {
  const s = setup(); let resolve;
  const box = createPersistentOutbox(s.config); const id = await box.enqueue(input); s.online();
  s.realtime.send = () => new Promise(r => { resolve = r; });
  const work = box.flush(); await tick(); assert.equal(box.snapshot()[0].status, 'sending');
  s.switch('B'); await box.ready(); assert.deepEqual(box.snapshot(), []);
  resolve({ status: 'confirmed', messageId: 'late-A' }); await work;
  assert.deepEqual(box.snapshot(), []); s.switch('A'); await box.ready();
  assert.equal(box.snapshot()[0].id, id); assert.equal(box.snapshot()[0].status, 'unconfirmed'); box.dispose();
});
test('failed encrypted initialization fails closed rather than using memory', async () => {
  const s = setup(); const box = createPersistentOutbox({ ...s.config, openJournal: async () => { throw new Error('SQLCIPHER_REQUIRED'); } });
  await assert.rejects(box.ready(), /SQLCIPHER_REQUIRED/);
  await assert.rejects(box.enqueue(input), /SQLCIPHER_REQUIRED/);
  assert.deepEqual(box.snapshot(), []); assert.equal(s.sent.length, 0); box.dispose();
});
test('fast A-B-A switch waits for superseded initialization and does not adopt old rows', async () => {
  const s = setup(); const open = s.config.openJournal; let release; let calls = 0;
  const box = createPersistentOutbox({ ...s.config, openJournal: async user => { calls++; if (calls === 1) await new Promise(r => { release = r; }); return open(user); } });
  await tick(); s.switch('B'); s.switch('A'); release(); await box.ready();
  assert.equal(calls, 2); assert.deepEqual(box.snapshot(), []); box.dispose();
});
test('full journal stays fail-closed with uncertain drafts; confirmed receipts alone can make room', async () => {
  const s = setup(); let box = createPersistentOutbox(s.config);
  for (let i = 0; i < 100; i++) await box.enqueue({ ...input, content: `payload ${i}` });
  await assert.rejects(box.enqueue(input), /OUTBOX_FULL/);
  assert.equal(box.snapshot().length, 100);
  assert.ok(box.snapshot().every(row => row.status === 'queued'));
  assert.equal(s.sent.length, 0);
  s.online();
  s.realtime.send = async row => { s.sent.push(row); return { status: 'confirmed', messageId: `server-${row.ackId}` }; };
  await box.flush();
  assert.equal(box.snapshot().filter(row => row.status === 'confirmed').length, 100);
  const freshId = await box.enqueue({ ...input, content: 'post-capacity payload' });
  assert.equal(freshId, 'ack-102');
  assert.equal(s.sent.length, 100); // Compaction itself must not emit.
  assert.deepEqual(box.snapshot().map(row => row.id), [
    ...Array.from({ length: 75 }, (_, i) => `ack-${i + 26}`), freshId,
  ]);
  box.dispose(); await tick(); box = createPersistentOutbox(s.config); await box.ready();
  assert.equal(box.snapshot().length, 76);
  assert.equal(box.snapshot().find(row => row.id === freshId).status, 'queued');
  box.dispose();
});
