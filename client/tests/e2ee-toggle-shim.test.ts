// client/tests/e2ee-toggle-shim.test.ts
//
// `mountE2EEToggle` is the only way the E2EE switch can reach a page, and no
// production code calls it today (e2ee-truthfulness.test.ts pins that). When a
// real channel-scoped owner connects it, the shim must still:
//   - refuse to render without a channel (covered there) or without a target;
//   - mount exactly one switch, however many times it is called;
//   - fall back to the documented #e2ee-toggle-root container only when no
//     target is given;
//   - tear the switch down on unmount so a later mount starts clean.
// The switch itself stays invisible until the server reports the feature on,
// so each mount here answers feature-status with a literal `enabled: true`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const log = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock('../js/core/logger.ts', () => ({ createLogger: () => log }));

import { mountE2EEToggle, unmountE2EEToggle } from '../js/core/e2ee-toggle-svelte.ts';

const apiFetch = vi.fn();
const featureOn = () => ({ ok: true, status: 200, json: async () => ({ enabled: true }) }) as unknown as Response;
const settle = () => new Promise(r => setTimeout(r, 0));

beforeEach(() => {
  document.body.innerHTML = '';
  apiFetch.mockReset();
  apiFetch.mockImplementation(async () => featureOn());
  log.warn.mockClear();
  log.info.mockClear();
  BridgeRegistry.register('apiFetch', apiFetch as never);
});

afterEach(async () => {
  unmountE2EEToggle();
  await settle();
  BridgeRegistry.unregister('apiFetch');
  document.body.innerHTML = '';
});

describe('E2EE switch mount shim', () => {
  it('mounts one channel-bound switch into the given target, even when the root container exists; a second call does not add another', async () => {
    const root = document.createElement('div');
    root.id = 'e2ee-toggle-root';
    const host = document.createElement('div');
    const other = document.createElement('div');
    document.body.append(root, host, other);

    mountE2EEToggle(host, 'channel-1');
    mountE2EEToggle(other, 'channel-2');
    await settle();

    expect(host.querySelectorAll('.e2ee-btn')).toHaveLength(1);
    expect(root.innerHTML).toBe('');
    expect(other.innerHTML).toBe('');
    expect(apiFetch.mock.calls).toEqual([['/api/e2e/feature-status']]);
    expect(log.info).toHaveBeenCalledTimes(1);
  });

  it('without a target it uses the documented root container', async () => {
    const root = document.createElement('div');
    root.id = 'e2ee-toggle-root';
    document.body.appendChild(root);

    mountE2EEToggle(undefined, 'channel-1');
    await settle();
    expect(root.querySelector('.e2ee-btn')).not.toBeNull();
  });

  it('without a target and without the root container it renders nothing and stays mountable', async () => {
    mountE2EEToggle(undefined, 'channel-1');
    await settle();
    expect(document.body.innerHTML).toBe('');
    expect(apiFetch).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);

    const host = document.createElement('div');
    document.body.appendChild(host);
    mountE2EEToggle(host, 'channel-1');
    await settle();
    expect(host.querySelector('.e2ee-btn')).not.toBeNull();
  });

  it('unmount removes the switch, a second unmount is harmless, and a later mount starts fresh', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    mountE2EEToggle(host, 'channel-1');
    await settle();
    expect(host.querySelector('.e2ee-btn')).not.toBeNull();

    unmountE2EEToggle();
    await settle();
    expect(host.querySelector('.e2ee-btn')).toBeNull();
    unmountE2EEToggle();

    mountE2EEToggle(host, 'channel-2');
    await settle();
    expect(host.querySelectorAll('.e2ee-btn')).toHaveLength(1);
    expect(apiFetch).toHaveBeenCalledTimes(2);
  });
});
