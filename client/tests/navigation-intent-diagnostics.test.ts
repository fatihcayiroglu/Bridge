// #491: privacy-bounded lifecycle of explicit deep-link intents, so an EX01
// cold-deep-link failure shows where the intent was lost.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: vi.fn() }));
vi.mock('../js/core/auth-compat.ts', () => ({ readToken: () => 'token' }));

import { initNativeDeepLinks, _resetNativeDeepLinksForTest, type NativeDeepLinkDeps } from '../js/core/native-deeplink.ts';
import {
  navigationIntentStatus, noteAutoSelection, resetNavigationIntentDiagnosticsForTests,
} from '../js/core/navigation-intent-diagnostics.ts';

const json = (body: unknown) => ({ ok: true, json: async () => body });

function deps(overrides: Partial<NativeDeepLinkDeps> = {}): NativeDeepLinkDeps {
  return {
    ready: () => true,
    servers: () => [{ _id: 'server-secret' }],
    selectServer: vi.fn(),
    loadServers: vi.fn(),
    navigateToChannel: vi.fn(async () => true),
    post: vi.fn(),
    get: vi.fn(async () => json([{ _id: 'channel-secret' }])),
    toast: vi.fn(),
    signedIn: () => true,
    sessionOwner: () => 'test-user',
    openDm: vi.fn(async () => true),
    openGroupDm: vi.fn(async () => true),
    ...overrides,
  } as NativeDeepLinkDeps;
}

function park(channelId = 'channel-secret'): void {
  (window as { __bridgePendingDeepLinks?: unknown[] }).__bridgePendingDeepLinks = [{ type: 'navigate:channel', channelId }];
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(() => { _resetNativeDeepLinksForTest(); resetNavigationIntentDiagnosticsForTests(); });
afterEach(() => {
  _resetNativeDeepLinksForTest();
  delete (window as { __bridgePendingDeepLinks?: unknown }).__bridgePendingDeepLinks;
});

describe('#491 deep-link intent diagnostics', () => {
  it('records a navigated cold link end to end', async () => {
    park(); initNativeDeepLinks(deps());
    await settle(); await settle();
    const [intent] = navigationIntentStatus().intents;
    expect(intent?.stages).toEqual(['received', 'dispatched', 'lookup-found', 'navigated']);
    expect(intent?.serversAtRoute).toBe(1);
  });

  it('distinguishes a link parked for sign-in, a missing target and a refused navigation', async () => {
    park(); initNativeDeepLinks(deps({ signedIn: () => false }));
    expect(navigationIntentStatus().intents[0]?.stages).toEqual(['received', 'queued-for-sign-in']);

    _resetNativeDeepLinksForTest(); resetNavigationIntentDiagnosticsForTests();
    park('channel-gone'); initNativeDeepLinks(deps());
    await settle(); await settle();
    expect(navigationIntentStatus().intents[0]?.stages.at(-1)).toBe('lookup-missing');

    _resetNativeDeepLinksForTest(); resetNavigationIntentDiagnosticsForTests();
    park(); initNativeDeepLinks(deps({ navigateToChannel: vi.fn(async () => false) }));
    await settle(); await settle();
    expect(navigationIntentStatus().intents[0]?.stages.at(-1)).toBe('not-navigated');
  });

  it('counts an automatic restore only while an explicit intent is still in flight', async () => {
    noteAutoSelection();
    expect(navigationIntentStatus()).toMatchObject({ autoSelections: 1, autoRestoreWhileIntentPending: 0 });
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    park(); initNativeDeepLinks(deps({ get: vi.fn(async () => { await gate; return json([{ _id: 'channel-secret' }]); }) }));
    await settle();
    noteAutoSelection(); // restoration racing the in-flight lookup
    release(); await settle(); await settle();
    noteAutoSelection(); // after the intent finished
    expect(navigationIntentStatus()).toMatchObject({ autoSelections: 3, autoRestoreWhileIntentPending: 1 });
  });

  it('never exposes identifiers and stays bounded', async () => {
    for (let i = 0; i < 6; i++) { park(); _resetNativeDeepLinksForTest(); initNativeDeepLinks(deps()); await settle(); await settle(); }
    const status = navigationIntentStatus();
    expect(status.intents.length).toBe(4);
    const text = JSON.stringify(status) + JSON.stringify(
      (window as unknown as { __bridgeNavigationIntentV1: { status(): unknown } }).__bridgeNavigationIntentV1.status());
    expect(text).not.toMatch(/secret|server-|channel-/);
  });
});
