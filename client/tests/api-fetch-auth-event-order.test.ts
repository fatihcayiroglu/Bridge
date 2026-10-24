import { afterEach, expect, it, vi } from 'vitest';

vi.mock('../js/core/auth-compat.ts', () => ({ readToken: () => 'fresh-account', saveToken: vi.fn(), logout: vi.fn() }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'https://bridge.test', toServerUrl: (url: string) => url }));
vi.mock('../js/core/refresh-coordinator.ts', () => ({
  storageAvailable: () => false, tryAcquireLease: () => true, releaseLease: vi.fn(),
  publishResult: vi.fn(), waitForOtherTab: vi.fn(),
}));
vi.mock('../js/core/logger.ts', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/bridge-registry.ts', () => ({ BridgeRegistry: { register: vi.fn() } }));

afterEach(() => { vi.unstubAllGlobals(); });

it('invalidates old HTTP work before earlier-registered sign-in consumers start fresh requests', async () => {
  let client!: typeof import('../js/core/api-fetch.ts');
  const requests: Array<Promise<Response>> = [];
  const consumer = (): void => { requests.push(client.apiFetch('https://bridge.test/api/me')); };
  // Real startup can register consumers before the dynamic API client import.
  document.addEventListener('bridge:auth-success', consumer);
  try {
    client = await import('../js/core/api-fetch.ts');
    const fetch = vi.fn(async () => new Response(JSON.stringify({ account: 'fresh-account' }), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetch);
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    expect(requests).toHaveLength(1);
    expect((await requests[0]!).status).toBe(200);
    expect(fetch).toHaveBeenCalledOnce();
  } finally { document.removeEventListener('bridge:auth-success', consumer); }
});
