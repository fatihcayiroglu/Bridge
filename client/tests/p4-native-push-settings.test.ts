// client/tests/p4-native-push-settings.test.ts
//
// P4-06 — the native app can turn push on, and always says what state it is in.
//
// MEASURED: inside the Android/iOS WebView there is no Web Push, so Settings › Notifications showed
// "unsupported" and offered no way to enable notifications; the only other entry point (a mobile
// template banner) was bound to an event nothing dispatched. The native card reads the OS state
// from `window.bridgePush` and never claims success it did not get.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';

vi.mock('../js/core/notifications/web-push-client.ts', () => ({
  getWebPushState: vi.fn(async () => ({ supported: false, permission: 'unsupported', subscribed: false, configured: false })),
  enableWebPush: vi.fn(), disableWebPush: vi.fn(), sendTestWebPush: vi.fn(),
}));

import NotificationsTab from '../js/core/settings/tabs/NotificationsTab.svelte';
import { t } from '../js/core/i18n/index.ts';

type State = 'granted' | 'denied' | 'prompt' | 'unknown' | 'unavailable';
let osState: State;
const enable = vi.fn();

beforeEach(() => {
  osState = 'prompt';
  enable.mockReset();
  (globalThis as { bridgePush?: unknown }).bridgePush = { status: vi.fn(async () => osState), enable };
});

afterEach(() => {
  cleanup();
  delete (globalThis as { bridgePush?: unknown }).bridgePush;
  document.body.innerHTML = '';
});

const card = () => document.querySelector('[data-testid="native-push-card"]');
async function enableButton(): Promise<HTMLButtonElement> {
  return waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>('[data-testid="native-push-enable"]');
    expect(el).not.toBeNull();
    return el as HTMLButtonElement;
  });
}
const stateText = () => document.querySelector('[data-testid="native-push-state"]')?.textContent?.trim() ?? '';

describe('native push card', () => {
  it('replaces the Web Push card inside the native app', async () => {
    render(NotificationsTab, { props: { store: {} as never } });
    await waitFor(() => expect(card()).not.toBeNull());
    expect(document.querySelector('[aria-labelledby="web-push-title"]')).toBeNull();
  });

  it('not yet asked → an enable button; granting it shows the ON state', async () => {
    enable.mockImplementation(async () => { osState = 'granted'; return true; });
    render(NotificationsTab, { props: { store: {} as never } });
    const button = await enableButton();
    await fireEvent.click(button);
    await waitFor(() => expect(stateText()).toBe(t('ntf_native_on')));
    expect(document.querySelector('[data-testid="native-push-enable"]')).toBeNull();
  });

  it('denied in the OS sheet → no false success; explains how to allow it in phone Settings', async () => {
    enable.mockImplementation(async () => { osState = 'denied'; return false; });
    render(NotificationsTab, { props: { store: {} as never } });
    const button = await enableButton();
    await fireEvent.click(button);
    await waitFor(() => expect(stateText()).toBe(t('ntf_native_denied')));
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('ntf_native_denied'));
    expect(document.body.textContent).not.toContain(t('ntf_native_on'));
  });

  it('a build without a push service says so instead of offering a button that cannot work', async () => {
    osState = 'unavailable';
    render(NotificationsTab, { props: { store: {} as never } });
    await waitFor(() => expect(stateText()).toBe(t('ntf_native_unavailable')));
    expect(document.querySelector('[data-testid="native-push-enable"]')).toBeNull();
  });

  it('coming back from phone Settings (app resumed) re-reads the OS permission', async () => {
    osState = 'denied';
    render(NotificationsTab, { props: { store: {} as never } });
    await waitFor(() => expect(stateText()).toBe(t('ntf_native_denied')));
    osState = 'granted';
    window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } }));
    await waitFor(() => expect(stateText()).toBe(t('ntf_native_on')));
  });
});
