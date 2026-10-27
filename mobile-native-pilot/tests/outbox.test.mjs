import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createOutbox } from '../src/outbox.mjs';

function setup(send = async input => ({ status: 'confirmed', messageId: `m-${input.ackId}` })) {
  let epoch = 1, online = false, sequence = 0;
  const listeners = new Set(), sent = [];
  const config = {
    coordinator: { getSession: () => epoch === null ? null : ({ epoch }), subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    realtime: { getStatus: () => online ? 'online' : 'offline', send(input) { sent.push(input); return send(input); } },
    createId: () => `id-${++sequence}`,
  };
  const box = createOutbox(config);
  return { box, sent, config, online: () => { online = true; }, switch: value => { epoch = value; for (const fn of listeners) fn(); } };
}
const message = content => ({ serverId: 's1', channelId: 'c1', content });

test('offline drafts flush in order, concurrent callers share one flight, confirmed entries never resend', async () => {
  const s = setup();
  s.box.enqueue(message('one')); s.box.enqueue(message('two'));
  await s.box.flush(); assert.equal(s.sent.length, 0);
  s.online();
  const a = s.box.flush(), b = s.box.flush(); assert.equal(a, b);
  await a; await s.box.flush();
  assert.deepEqual(s.sent.map(row => row.content), ['one', 'two']);
  assert.deepEqual(s.box.snapshot().map(row => row.status), ['confirmed', 'confirmed']);
});

test('lost ACK: explicit retry preserves the original id; a deduplicating server persists only once', async () => {
  const persisted = new Map(); let calls = 0;
  const s = setup(async input => {
    if (!persisted.has(input.ackId)) persisted.set(input.ackId, 'message-1');
    return ++calls === 1 ? { status: 'unconfirmed', reason: 'NO_ECHO' } : { status: 'confirmed', messageId: persisted.get(input.ackId) };
  });
  s.online(); const id = s.box.enqueue(message('persisted before lost ACK'));
  s.box.enqueue(message('younger'));
  await s.box.flush(); await s.box.flush(); assert.equal(s.sent.length, 1);
  assert.throws(() => s.box.remove(id), /OUTCOME_UNRESOLVED/);
  await s.box.retry(id);
  assert.equal(s.sent[0].ackId, s.sent[1].ackId);
  assert.equal(persisted.size, 2); // first once, then the younger message
  assert.equal(s.box.snapshot()[0].messageId, 'message-1');
});

test('switch/sign-out clears drafts immediately and late completion cannot write into the new account', async () => {
  let resolve;
  const s = setup(() => new Promise(r => { resolve = r; }));
  s.online(); s.box.enqueue(message('old')); s.box.enqueue(message('old queued'));
  const flight = s.box.flush(); await Promise.resolve();
  s.switch(2); assert.deepEqual(s.box.snapshot(), []);
  resolve({ status: 'confirmed', messageId: 'old-server-result' }); await flight;
  assert.deepEqual(s.box.snapshot(), []); assert.equal(s.sent.length, 1);
  s.switch(null); assert.throws(() => s.box.enqueue(message('no session')), /SESSION_REQUIRED/);
});

test('a server rejection blocks younger sends; snapshots cannot mutate the queue', async () => {
  const s = setup(async () => ({ status: 'failed', code: 'FORBIDDEN' }));
  s.online(); s.box.enqueue(message('denied')); s.box.enqueue(message('younger'));
  await s.box.flush(); await s.box.flush(); assert.equal(s.sent.length, 1);
  const row = s.box.snapshot()[0]; assert.throws(() => { row.status = 'queued'; }, TypeError);
});

test('restart is explicitly non-durable; bounds, invalid input and disposal fail closed', () => {
  const s = setup(); s.box.enqueue(message('lost on restart'));
  assert.deepEqual(createOutbox(s.config).snapshot(), []);
  assert.throws(() => s.box.enqueue(message(' ')), /INVALID_MESSAGE/);
  const bounded = createOutbox({ ...s.config, capacity: 1 }); bounded.enqueue(message('a'));
  assert.throws(() => bounded.enqueue(message('b')), /OUTBOX_FULL/);
  bounded.dispose(); assert.throws(() => bounded.enqueue(message('c')), /SESSION_REQUIRED/);
});
