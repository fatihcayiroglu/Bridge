// client/tests/server-settings-ai-optout.test.ts
//
// P6 — per-server AI opt-out, the owner's control in Server Settings › General.
//
// The SERVER is the authority (every AI route re-reads the stored value on
// each request); the client only asks the owner-only endpoint and reflects
// what was stored. Contract: PATCH /api/servers/:sid { aiEnabled: boolean }.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createServerSettingsStore } from '../js/core/server-settings/stores/serverSettingsStore.ts';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const SRV = { _id: 'srv-A', id: 'srv-A', name: 'S', icon: '🌐', ownerId: 'u1' };
let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status: number) => ({ ok: false, status, json: async () => ({ error: 'x' }) }) as unknown as Response;

beforeEach(() => {
  fetchMock = vi.fn(async () => ok({ ...SRV, aiEnabled: false }));
  BridgeRegistry.register('getCurrentServer', () => ({ ...SRV }));
});
afterEach(() => { BridgeRegistry.unregister('getCurrentServer'); vi.restoreAllMocks(); });

describe('P6 — the AI toggle', () => {
  it('a server row without the field (pre-078) shows AI as allowed', () => {
    expect(createServerSettingsStore({ ...SRV }).aiEnabled).toBe(true);
  });

  it('a stored false shows AI as off', () => {
    expect(createServerSettingsStore({ ...SRV, aiEnabled: false }).aiEnabled).toBe(false);
  });

  it('turning it off sends exactly { aiEnabled: false } to the owner-only endpoint', async () => {
    const store = createServerSettingsStore({ ...SRV });
    store.setAiEnabled(false);
    expect(store.isAiDirty()).toBe(true);
    expect(await store.saveAi()).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe('http://test/api/servers/srv-A');
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ aiEnabled: false });
    expect(store.isAiDirty()).toBe(false);
  });

  it('the stored value from the server wins over the local toggle', async () => {
    fetchMock = vi.fn(async () => ok({ ...SRV, aiEnabled: true }));
    const store = createServerSettingsStore({ ...SRV });
    store.setAiEnabled(false);
    await store.saveAi();
    expect(store.aiEnabled).toBe(true);
  });

  it('a refusal (non-owner: 403) keeps the setting dirty and reports an error — no fake success', async () => {
    fetchMock = vi.fn(async () => fail(403));
    const store = createServerSettingsStore({ ...SRV });
    store.setAiEnabled(false);
    expect(await store.saveAi()).toBe(false);
    expect(store.error).toBeTruthy();
    expect(store.isAiDirty()).toBe(true);
  });

  it('nothing is sent when the open form belongs to another server', async () => {
    BridgeRegistry.register('getCurrentServer', () => ({ _id: 'srv-B', id: 'srv-B' }));
    const store = createServerSettingsStore({ ...SRV });
    store.setAiEnabled(false);
    expect(await store.saveAi()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
