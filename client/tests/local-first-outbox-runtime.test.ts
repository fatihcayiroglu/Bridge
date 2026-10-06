import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  OUTBOX_KEY_PREFIX,
  putOutboxEntry as putLegacyOutboxEntry,
  readOutbox as readLegacyOutbox,
  type OutboxEntry,
} from '../js/core/outbox-store.ts';
import {
  flushLocalFirstOutbox,
  hydrateLocalFirstOutbox,
  patchLocalFirstOutboxEntry,
  putLocalFirstOutboxEntry,
  readLocalFirstOutbox,
  removeLocalFirstOutboxEntry,
  resetLocalFirstOutboxRuntimeForTests,
} from '../js/core/local-first/outbox-runtime.ts';

function entry(ackId: string, state: OutboxEntry['state'] = 'queued'): OutboxEntry {
  return {
    ackId,
    userId: 'u1',
    channelId: 'c1',
    serverId: 's1',
    draftKind: 'channel',
    messageType: 'normal',
    content: `secret-${ackId}`,
    createdAt: ackId === 'a' ? 1 : 2,
    state,
    attempts: 0,
  };
}

beforeEach(() => {
  localStorage.clear();
  resetLocalFirstOutboxRuntimeForTests();
});

afterEach(() => {
  resetLocalFirstOutboxRuntimeForTests();
  localStorage.clear();
});

describe('P7 local-first outbox runtime', () => {
  it('migrates the legacy plaintext queue before replay', async () => {
    putLegacyOutboxEntry(entry('a', 'sending'));
    expect(readLegacyOutbox('u1')).toHaveLength(1);

    await expect(hydrateLocalFirstOutbox('u1')).resolves.toEqual([
      entry('a', 'queued'),
    ]);

    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}:u1`)).toBeNull();
  });

  it('new queue writes never create a plaintext legacy outbox', async () => {
    expect(putLocalFirstOutboxEntry(entry('a'))).toBe(true);
    await flushLocalFirstOutbox('u1');

    expect(readLocalFirstOutbox('u1')).toEqual([entry('a')]);
    expect(localStorage.getItem(`${OUTBOX_KEY_PREFIX}:u1`)).toBeNull();
    expect(JSON.stringify(localStorage)).not.toContain('secret-a');
  });

  it('patches the same ackId in place', async () => {
    putLocalFirstOutboxEntry(entry('a'));
    const patched = patchLocalFirstOutboxEntry('u1', 'a', {
      state: 'failed',
      attempts: 1,
      lastError: 'timeout',
    });

    expect(patched).toMatchObject({
      ackId: 'a',
      state: 'failed',
      attempts: 1,
      lastError: 'timeout',
    });
    expect(readLocalFirstOutbox('u1')).toHaveLength(1);
    await flushLocalFirstOutbox('u1');
  });

  it('removes acknowledged entries without touching another ackId', async () => {
    putLocalFirstOutboxEntry(entry('a'));
    putLocalFirstOutboxEntry(entry('b'));
    removeLocalFirstOutboxEntry('u1', 'a');

    expect(readLocalFirstOutbox('u1').map(value => value.ackId)).toEqual(['b']);
    await flushLocalFirstOutbox('u1');
  });

  it('keeps the active queue usable while physical persistence initializes', () => {
    expect(putLocalFirstOutboxEntry(entry('a'))).toBe(true);
    expect(readLocalFirstOutbox('u1')).toEqual([entry('a')]);
  });
});
