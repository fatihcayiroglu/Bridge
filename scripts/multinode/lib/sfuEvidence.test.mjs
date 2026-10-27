import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Cluster } from './cluster.mjs';
import { SFU_EVIDENCE_TAG, SfuRouterEvidence } from './sfuEvidence.mjs';

const lifecycle = (event, at, channelId = 'room-private') => ({ tag: SFU_EVIDENCE_TAG, event, at, channelId });

test('no lifecycle events cannot be mistaken for a split-brain pass', () => {
  const evidence = new SfuRouterEvidence();
  assert.deepEqual(evidence.creators('room-private'), []);
  assert.deepEqual(evidence.splitBrain('room-private'), {
    observed: 0, intervals: 'none-observed', overlaps: [], anomalies: [],
  });
});

test('private lifecycle IPC observes a single owner, explicit close and a clean takeover', () => {
  const evidence = new SfuRouterEvidence();
  assert.equal(evidence.record('A', 1, lifecycle('opened', 1000)), true);
  assert.equal(evidence.record('A', 1, lifecycle('closed', 1200)), true);
  assert.equal(evidence.record('B', 2, lifecycle('opened', 1201)), true);
  assert.equal(evidence.record('B', 2, lifecycle('closed', 1300)), true);
  assert.deepEqual(evidence.creators('room-private'), ['A', 'B']);
  assert.deepEqual(evidence.splitBrain('room-private'), {
    observed: 2, intervals: 'A[200ms] B[99ms]', overlaps: [], anomalies: [],
  });
});

test('overlapping owners fail instead of returning a vacuous or log-dependent pass', () => {
  const evidence = new SfuRouterEvidence();
  evidence.record('A', 1, lifecycle('opened', 1000));
  evidence.record('B', 2, lifecycle('opened', 1001));
  evidence.record('A', 1, lifecycle('closed', 1500));
  const result = evidence.splitBrain('room-private');
  assert.equal(result.observed, 2);
  assert.deepEqual(result.overlaps, ['A∩B']);
});

test('a duplicate live process using the same node name is still split brain', () => {
  const evidence = new SfuRouterEvidence();
  evidence.record('A', 1, lifecycle('opened', 1000));
  evidence.record('A', 2, lifecycle('opened', 1200));
  assert.deepEqual(evidence.splitBrain('room-private').overlaps, ['A∩A']);
});

test('two sequential creations on one node do not satisfy the exactly-one-router gate', () => {
  const evidence = new SfuRouterEvidence();
  evidence.record('A', 1, lifecycle('opened', 1000));
  evidence.record('A', 1, lifecycle('closed', 1100));
  evidence.record('A', 1, lifecycle('opened', 1200));
  assert.deepEqual(evidence.creators('room-private'), ['A', 'A']);
});

test('SIGKILL closes old generation at process exit, not at restart with the same node name', () => {
  const evidence = new SfuRouterEvidence();
  evidence.record('A', 1, lifecycle('opened', 1000));
  evidence.record('A', 2, lifecycle('opened', 1600));
  evidence.record('B', 3, lifecycle('opened', 1501));
  const history = [{ name: 'A', generation: 1, at: 1500 }];
  const { intervals, overlaps, anomalies } = evidence.splitBrain('room-private', history);
  assert.equal(intervals.includes('A[500ms]'), true);
  assert.deepEqual(overlaps, ['A∩B']); // only the *restarted* A overlaps B
  assert.deepEqual(anomalies, []);
});

test('duplicate opens, closes without opens and late events fail evidence integrity', () => {
  const evidence = new SfuRouterEvidence();
  evidence.record('A', 1, lifecycle('closed', 900));
  evidence.record('A', 1, lifecycle('opened', 1000));
  evidence.record('A', 1, lifecycle('opened', 1001));
  evidence.record('B', 2, lifecycle('opened', 2001));
  assert.deepEqual(evidence.splitBrain('room-private', [{ name: 'B', generation: 2, at: 2000 }]).anomalies,
    ['router closed without observed open', 'duplicate live router opened', 'lifecycle event after process exit']);
});

test('unrelated IPC controls and other channels do not contribute ownership evidence', () => {
  const evidence = new SfuRouterEvidence();
  assert.equal(evidence.record('A', 1, { tag: SFU_EVIDENCE_TAG, event: 'flushed', nonce: '1' }), false);
  assert.equal(evidence.record('B', 2, lifecycle('opened', 1000, 'another-channel')), true);
  assert.deepEqual(evidence.creators('room-private'), []);
  assert.equal(evidence.splitBrain('room-private').observed, 0);
  assert.throws(() => evidence.record('A', 1, lifecycle('opened', Number.NaN)), /Invalid SFU lifecycle IPC/);
});

test('parent flush waits for child evidence before recording a passing router creator', async () => {
  const proc = new EventEmitter();
  const cluster = Object.create(Cluster.prototype);
  cluster.sfuEvidence = new SfuRouterEvidence();
  cluster.sfuFlushSequence = 0;
  cluster.nodes = new Map([['A', { name: 'A', proc, exited: null }]]);
  proc.on('message', message => cluster.sfuEvidence.record('A', 1, message));
  proc.send = (message, callback) => {
    assert.equal(message.event, 'flush');
    setImmediate(() => {
      proc.emit('message', lifecycle('opened', 1000));
      proc.emit('message', { tag: SFU_EVIDENCE_TAG, event: 'flushed', nonce: message.nonce });
      callback?.();
    });
  };
  await cluster.flushSfuEvidence(200);
  assert.deepEqual(cluster.sfuEvidence.creators('room-private'), ['A']);
});

test('missing child flush acknowledgement cannot create a false green', async () => {
  const proc = new EventEmitter();
  const cluster = Object.create(Cluster.prototype);
  cluster.sfuFlushSequence = 0;
  cluster.nodes = new Map([['A', { name: 'A', proc, exited: null }]]);
  proc.send = (_message, callback) => callback?.();
  await assert.rejects(cluster.flushSfuEvidence(10), /failed to flush/);
  assert.equal(proc.listenerCount('message'), 0);
});
