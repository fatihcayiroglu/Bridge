import { beforeEach, describe, expect, it, vi } from 'vitest';

const stateInit = vi.fn();
const loadTheme = vi.fn(async () => undefined);
const initVoice = vi.fn();
const initPermalink = vi.fn();
const initI18n = vi.fn();
const initUpdater = vi.fn();
const registryCall = vi.fn();
const registryRegister = vi.fn();
const registryUnregister = vi.fn();
const registryGet = vi.fn(() => null);
const log = vi.fn();
const errorWrap = vi.fn((fn: () => unknown) => fn);

const EMPTY_SIDE_EFFECT_MODULES = [
  '../js/core/socket-svelte.ts', '../js/core/api-error-toast-svelte.ts', '../js/core/navigation-history.ts',
  '../js/core/command-palette-svelte.ts', '../js/core/onboarding-wizard-svelte.ts', '../js/core/drafts-svelte.ts',
  '../js/core/dead-control-guard.ts', '../js/core/offline-banner-svelte.ts', '../js/core/channel-stage-svelte.ts',
  '../js/webrtc.ts', '../js/core/voice-check-svelte.ts', '../js/core/voice-svelte.ts', '../js/core/shell-voice-controls.ts',
  '../js/core/channel-list-svelte.ts', '../js/core/members-svelte.ts', '../js/core/messages-loader-svelte.ts',
  '../js/core/messages-svelte.ts', '../js/core/messages-input-svelte.ts', '../js/core/servers-svelte.ts',
  '../js/core/auth-compat.ts', '../js/core/webauthn-svelte.ts', '../js/core/empty-server-start-svelte.ts',
  '../js/core/e2ee-toggle-svelte.ts', '../js/core/settings-modal-svelte.ts', '../js/core/friends-svelte.ts',
  '../js/core/invite-svelte.ts', '../js/core/shell-actions.ts', '../js/core/server-menu-svelte.ts',
  '../js/core/create-channel-svelte.ts', '../js/core/member-profile-svelte.ts', '../js/core/search-svelte.ts',
  '../js/core/global-search-svelte.ts', '../js/core/emoji-picker-svelte.ts', '../js/core/notification-prefs-svelte.ts',
  '../js/core/unread-svelte.ts', '../js/core/dm-call-svelte.ts', '../js/core/dm-svelte.ts', '../js/core/slow-mode-svelte.ts',
  '../js/core/discover-svelte.ts', '../js/core/server-settings-opener-svelte.ts',
  '../js/core/channel-perms/channel-action-menu-svelte.ts', '../js/core/stickers/sticker-opener-svelte.ts',
  '../js/core/group-dm-svelte.ts', '../js/mobile.ts',
] as const;

async function importFreshApp() {
  vi.resetModules();
  for (const spec of EMPTY_SIDE_EFFECT_MODULES) vi.doMock(spec, () => ({}));
  vi.doMock('../js/core/state-svelte.ts', () => ({ BridgeState: { initState: stateInit } }));
  vi.doMock('../js/core/error-boundary-svelte.ts', () => ({ errorBoundary: { wrap: errorWrap } }));
  vi.doMock('../js/core/theme-svelte.ts', () => ({ loadTheme }));
  vi.doMock('../js/core/globals.ts', () => ({ getAPI: () => 'https://api.bridge.test' }));
  vi.doMock('../js/core/voice-activity-wiring.ts', () => ({ registerVoiceActivityWiring: initVoice }));
  vi.doMock('../js/core/bridge-registry.ts', () => ({ BridgeRegistry: { call: registryCall, register: registryRegister, unregister: registryUnregister, get: registryGet } }));
  vi.doMock('../js/core/logger.ts', () => ({ createLogger: () => ({ log, info: log, warn: log, error: log, debug: log }) }));
  vi.doMock('../js/core/i18n-dom.ts', () => ({ initI18nDom: initI18n }));
  vi.doMock('../js/core/desktop-updater.ts', () => ({ initDesktopUpdater: initUpdater }));
  vi.doMock('../js/core/permalink/permalink-router.ts', () => ({ initPermalinkRouter: initPermalink }));
  // BELİRLENİMCİ BEKLEME.
  // Burada eskiden `await Promise.resolve()` çağrıları SAYILIYORDU: boot'un
  // kaç mikro-görevde biteceği tahmin ediliyordu ve yüklü bir makinede iddia
  // boot bitmeden çalışabiliyordu. `app.ts` artık boot sözünü dışa açıyor;
  // test onu bekler. Sabit bir `sleep` de eklenmez — beklenen şey ZAMAN değil,
  // OLAYIN KENDİSİDİR.
  const app = await import('../js/app.ts') as { bootReady: Promise<void> };
  await app.bootReady;
}

beforeEach(() => {
  vi.useRealTimers();
  for (const fn of [stateInit, loadTheme, initVoice, initPermalink, initI18n, initUpdater, registryCall, registryRegister, registryUnregister, registryGet, log, errorWrap]) fn.mockClear();
});

describe('production app entrypoint orchestration', () => {
  it('initializes critical wiring and presentation state in boot order', async () => {
    await importFreshApp();
    expect(initVoice).toHaveBeenCalledOnce();
    expect(initPermalink).toHaveBeenCalledOnce();
    expect(errorWrap).toHaveBeenCalledWith(expect.any(Function), 'app:boot');
    expect(loadTheme).toHaveBeenCalledOnce();
    expect(initI18n).toHaveBeenCalledOnce();
    expect(stateInit).toHaveBeenCalledOnce();
    expect(initUpdater).toHaveBeenCalledOnce();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('https://api.bridge.test'));
    expect(loadTheme.mock.invocationCallOrder[0]).toBeLessThan(initI18n.mock.invocationCallOrder[0]);
    expect(initI18n.mock.invocationCallOrder[0]).toBeLessThan(stateInit.mock.invocationCallOrder[0]);
    // ── AÇIK VE CÖMERT ZAMAN AŞIMI ──────────────────────────────────────────
    // Bu test ÜRETİM GİRİŞ NOKTASININ tamamını taze olarak içeri alır: ~44
    // modül taklidi + gerçek boot zinciri. Tek başına ~2 sn sürer, ama TÜM
    // süit paralel koşarken (transform + jsdom ortamı) 5 sn'lik Vitest
    // varsayılanını aşabiliyor — ölçülen kırılganlık buydu; iddialar değil
    // SÜRE düşüyordu. Sözleşme sürede değil SONUÇTA olduğu için zaman aşımı
    // açıkça büyütülür; hiçbir iddia gevşetilmez ve sabit bir `sleep`
    // eklenmez (bekleme hâlâ `bootReady` sözüne bağlıdır).
  }, 30_000);

  it('defers the empty-server check after authentication so shell/session owners can settle', async () => {
    vi.useFakeTimers();
    await importFreshApp();
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    expect(registryCall).not.toHaveBeenCalledWith('checkEmptyServerStart');
    vi.advanceTimersByTime(799);
    expect(registryCall).not.toHaveBeenCalledWith('checkEmptyServerStart');
    vi.advanceTimersByTime(1);
    expect(registryCall).toHaveBeenCalledWith('checkEmptyServerStart');
    vi.useRealTimers();
  });
});
