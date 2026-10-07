// P7 A5 — the operation-log runtime is strictly account-scoped.

import { afterEach, describe, expect, it } from 'vitest';
import {
  closeLocalFirstOperationRuntime,
  enqueueLocalFirstOperation,
  getLocalFirstOperation,
  listActiveLocalFirstOperations,
  resetLocalFirstOperationRuntimeForTests,
  transitionLocalFirstOperation,
} from '../js/core/local-first/operation-runtime.ts';

afterEach(() => resetLocalFirstOperationRuntimeForTests());

describe('P7 operation runtime account boundaries', () => {
  it('refuses a blank account at every entry point; closing a blank account is a no-op', async () => {
    await expect(getLocalFirstOperation('  ', 'op')).rejects.toThrow('userId is required');
    await expect(listActiveLocalFirstOperations('')).rejects.toThrow('userId is required');
    await expect(transitionLocalFirstOperation('', 'op', 'sending')).rejects.toThrow('userId is required');
    expect(() => closeLocalFirstOperationRuntime(' ')).not.toThrow();
  });

  it('one account never sees another account\'s queued mutations', async () => {
    await enqueueLocalFirstOperation({
      opId: 'alice-op', userId: 'alice', channelId: 'c1', targetId: 'm1', kind: 'delete-message', payload: {},
    });
    await expect(listActiveLocalFirstOperations('bob')).resolves.toEqual([]);
    await expect(getLocalFirstOperation('bob', 'alice-op')).resolves.toBeNull();
    await expect(listActiveLocalFirstOperations('alice')).resolves.toHaveLength(1);
    closeLocalFirstOperationRuntime('alice');
  });
});
