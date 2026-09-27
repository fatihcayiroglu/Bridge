// client/tests/socket-manager-reauth-exhaustion.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SocketManager.svelte — YENİDEN KİMLİK DOĞRULAMA BÜTÇESİNİN SONU
// ════════════════════════════════════════════════════════════════════════════
// Socket.IO, kimlik hatasında AYNI bayat jetonla sonsuza kadar dener ve asla
// toparlanmaz. `SocketManager` bu yüzden kendi geri-çekilmeli (backoff)
// döngüsünü yürütür. Bu döngünün SONU en az kendisi kadar önemlidir:
//
//   • Bütçe biterse oturum KAPATILIR. Kapatılmazsa kullanıcı sonsuza kadar
//     "bağlanıyor" ekranında kalır ve yeniden giriş yapamaz.
//   • Yenileme `false` dönerse (sunucu oturumu iptal etti) tekrar denemek
//     anlamsızdır: doğrudan oturum kapatılır.
//   • Yenileme İSTİSNA atarsa oturum kapatılmaz — geçici bir ağ hatası, kalıcı
//     bir iptal ile aynı şey değildir; uçuş bayrağı serbest bırakılıp yeni bir
//     deneme mümkün kalır.
//
// Bu dosya üç sonun hepsini ölçer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, unmount } from 'svelte';

const mocks = vi.hoisted(() => {
  const registry = new Map<string, unknown>();
  return {
    registry,
    registryCall: vi.fn((name: string, ...args: unknown[]) => {
      if (name === 'getMe') return null;
      const fn = registry.get(name);
      return typeof fn === 'function' ? Reflect.apply(fn as (...xs: unknown[]) => unknown, undefined, args) : undefined;
    }),
    registryRegister: vi.fn((name: string, value: unknown) => { registry.set(name, value); }),
    registryUnregister: vi.fn((name: string) => { registry.delete(name); }),
    registryGet: vi.fn((name: string) => registry.get(name) ?? null),
    readToken: vi.fn<() => string | null>(),
    logout: vi.fn(),
    refreshAccessToken: vi.fn<() => Promise<boolean>>(),
    wasLastRefreshFailureTransient: vi.fn<() => boolean>(() => false),
    logInfo: vi.fn(), logWarn: vi.fn(), logError: vi.fn(), logDebug: vi.fn(),
  };
});

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    call: mocks.registryCall,
    register: mocks.registryRegister,
    unregister: mocks.registryUnregister,
    get: mocks.registryGet,
  },
}));
vi.mock('../js/core/auth-compat.js', () => ({ readToken: mocks.readToken, logout: mocks.logout }));
vi.mock('../js/core/api-fetch.js', () => ({
  refreshAccessToken: mocks.refreshAccessToken,
  wasLastRefreshFailureTransient: mocks.wasLastRefreshFailureTransient,
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'https://bridge.example.test' }));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: mocks.logInfo, warn: mocks.logWarn, error: mocks.logError, debug: mocks.logDebug }),
}));

import SocketManager from '../js/core/SocketManager.svelte';

type Handler = (...args: unknown[]) => void;
class FakeSocket {
  connected = false;
  id: string | undefined;
  handlers = new Map<string, Handler[]>();
  onceHandlers = new Map<string, Handler[]>();
  on = vi.fn((event: string, handler: Handler) => {
    const list = this.handlers.get(event) ?? []; list.push(handler); this.handlers.set(event, list);
  });
  once = vi.fn((event: string, handler: Handler) => {
    const list = this.onceHandlers.get(event) ?? []; list.push(handler); this.onceHandlers.set(event, list);
  });
  emit = vi.fn();
  disconnect = vi.fn(() => { this.connected = false; });
  constructor(id: string | undefined) { this.id = id; }
  fire(event: string, ...args: unknown[]) {
    for (const fn of this.handlers.get(event) ?? []) fn(...args);
    const once = this.onceHandlers.get(event) ?? [];
    this.onceHandlers.delete(event);
    for (const fn of once) fn(...args);
  }
}

let target: HTMLDivElement;
let instance: unknown | null = null;
let token: string | null;
let sockets: FakeSocket[];
let socketId: string | undefined;

/**
 * Bileşen durumu MODÜL seviyesindedir (tek soket sahipliği bilinçli bir
 * tasarımdır): yeniden deneme sayacı testler arasında yaşar. Sağlıklı bir
 * `connect` sayacı sıfırlar — üretimde de kurtarma tam olarak böyle biter.
 */
function connectCleanly(): void {
  const socket = sockets[sockets.length - 1]!;
  socket.connected = true;
  socket.fire('connect');
  socket.fire('userAuthenticated');
}

/** Kimlik hatasıyla bir yeniden deneme turunu tamamlar. */
async function failAuthRound(index: number): Promise<void> {
  sockets[index]!.fire('connect_error', { message: 'Unauthorized: jwt expired' });
  await vi.advanceTimersByTimeAsync(60_000);
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = '';
  target = document.createElement('div');
  document.body.appendChild(target);
  mocks.registry.clear();
  // `mockClear` UYGULAMAYI KORUR: bir testte kurulan `mockImplementation`
  // sonraki teste sızar ve yenileme sonucunu sessizce değiştirir. Tam sıfırlama
  // yapılır, ardından varsayılan davranışlar yeniden kurulur.
  for (const fn of Object.values(mocks)) {
    if (typeof (fn as { mockReset?: unknown }).mockReset === 'function') (fn as ReturnType<typeof vi.fn>).mockReset();
  }
  token = 'token-1';
  socketId = 'sock';
  mocks.readToken.mockImplementation(() => token);
  mocks.refreshAccessToken.mockImplementation(async () => true);
  mocks.wasLastRefreshFailureTransient.mockReturnValue(false);
  sockets = [];
  vi.stubGlobal('io', vi.fn(() => {
    const socket = new FakeSocket(socketId);
    sockets.push(socket);
    return socket;
  }));
});

afterEach(async () => {
  if (instance) { await unmount(instance as never); instance = null; }
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('re-authentication budget', () => {
  it('logs the user out once the retry budget is exhausted instead of looping forever', async () => {
    instance = mount(SocketManager, { target });
    connectCleanly();
    // Her tur yeni bir soket açar; bütçe bitene kadar oturum KAPATILMAZ.
    let round = 0;
    while (mocks.logout.mock.calls.length === 0 && round < 12) {
      await failAuthRound(sockets.length - 1);
      round += 1;
    }
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(round).toBeGreaterThan(1);
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('oturum kapatılıyor'));
    // Oturum kapatıldıktan sonra yeni soket açılmaz.
    const opened = sockets.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(sockets.length).toBe(opened);
  });

  it('logs out immediately when the refresh endpoint refuses the session', async () => {
    mocks.refreshAccessToken.mockImplementation(async () => false);
    instance = mount(SocketManager, { target });
    connectCleanly();
    await failAuthRound(0);
    expect(mocks.logout).toHaveBeenCalledTimes(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining('Token yenilenemedi'));
    expect(sockets).toHaveLength(1);
  });

  it('releases the in-flight guard after a refused refresh so a later login can recover normally', async () => {
    mocks.refreshAccessToken.mockImplementation(async () => false);
    instance = mount(SocketManager, { target });
    connectCleanly();
    await failAuthRound(0);
    expect(mocks.logout).toHaveBeenCalledTimes(1);

    // Simulate a later successful login in the same long-lived app module.
    token = 'token-after-login';
    mocks.refreshAccessToken.mockImplementation(async () => true);
    document.dispatchEvent(new CustomEvent('bridge:auth-success'));
    const reopened = sockets[sockets.length - 1]!;
    reopened.connected = true;
    reopened.fire('connect');
    reopened.fire('userAuthenticated');

    // A new auth failure must schedule another refresh. Before the fix,
    // `_reauthInFlight` stayed true after the first refused refresh forever.
    const before = mocks.refreshAccessToken.mock.calls.length;
    reopened.fire('connect_error', { message: 'Unauthorized: jwt expired' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.refreshAccessToken.mock.calls.length).toBeGreaterThan(before);
  });

  it('keeps the session when refreshing throws and allows a later retry', async () => {
    mocks.refreshAccessToken.mockRejectedValueOnce(new Error('offline'));
    instance = mount(SocketManager, { target });
    connectCleanly();
    await failAuthRound(0);
    // Geçici bir ağ hatası oturumu KAPATMAZ.
    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.logError).toHaveBeenCalledWith('Yeniden kimlik doğrulama hatası', expect.any(Error));

    // Uçuş bayrağı serbest bırakıldığı için yeni bir deneme yapılabilir.
    mocks.refreshAccessToken.mockImplementation(async () => true);
    await failAuthRound(0);
    expect(sockets.length).toBeGreaterThan(1);
    expect(mocks.logout).not.toHaveBeenCalled();
  });

  it('keeps retrying a transient refresh outage without logging the user out', async () => {
    mocks.refreshAccessToken.mockImplementation(async () => false);
    mocks.wasLastRefreshFailureTransient.mockReturnValue(true);
    instance = mount(SocketManager, { target });
    connectCleanly();

    sockets[0]!.fire('connect_error', { message: 'Auth check failed' });
    await vi.advanceTimersByTimeAsync(120_000);

    expect(mocks.logout).not.toHaveBeenCalled();
    expect(mocks.refreshAccessToken.mock.calls.length).toBeGreaterThan(1);
    expect(mocks.logWarn).toHaveBeenCalledWith(expect.stringContaining('oturum korunuyor'));
  });

  it('ignores a second auth error while a re-authentication is already scheduled', async () => {
    instance = mount(SocketManager, { target });
    connectCleanly();
    sockets[0]!.fire('connect_error', { message: 'Unauthorized' });
    sockets[0]!.fire('connect_error', { message: 'Unauthorized' });
    await vi.advanceTimersByTimeAsync(60_000);
    // İki hata tek bir yenileme üretir; aksi hâlde yenileme fırtınası olurdu.
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1);
  });
});

describe('connection preconditions and identity', () => {
  it('reports a missing Socket.IO client rather than failing silently', async () => {
    vi.stubGlobal('io', undefined);
    instance = mount(SocketManager, { target });
    expect(mocks.logError).toHaveBeenCalledWith(expect.stringContaining('window.io bulunamadı'));
  });

  it('falls back to the global current user when the registry has no getMe', async () => {
    mocks.registryCall.mockImplementation((name: string) => (name === 'getMe' ? null : undefined));
    vi.stubGlobal('currentUser', { id: 'legacy-user' });
    instance = mount(SocketManager, { target });
    sockets[0]!.connected = true;
    sockets[0]!.fire('connect');
    expect(sockets[0]!.emit).toHaveBeenCalledWith('user:join-room', 'legacy-user');
  });

  it('joins no personal room when neither source knows the user', async () => {
    mocks.registryCall.mockImplementation(() => undefined);
    instance = mount(SocketManager, { target });
    sockets[0]!.connected = true;
    sockets[0]!.fire('connect');
    expect(sockets[0]!.emit).not.toHaveBeenCalled();
  });

  it('logs a placeholder when the transport reports no socket id', async () => {
    socketId = undefined;
    instance = mount(SocketManager, { target });
    sockets[0]!.connected = true;
    sockets[0]!.fire('connect');
    expect(mocks.logInfo).toHaveBeenCalledWith('Socket bağlandı (id: ?)');
  });

  it('reports a disconnect that carries no reason', async () => {
    instance = mount(SocketManager, { target });
    sockets[0]!.connected = true;
    sockets[0]!.fire('connect');
    sockets[0]!.fire('disconnect');
    expect(mocks.logWarn).toHaveBeenCalledWith('Socket bağlantısı koptu:', '');
  });

  it('records an unnamed connection error without treating it as an auth failure', async () => {
    instance = mount(SocketManager, { target });
    sockets[0]!.fire('connect_error');
    expect(mocks.logError).toHaveBeenCalledWith('Socket bağlantı hatası:', 'bilinmeyen bağlantı hatası');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled();
  });

  it('emits the ready signal only once per connection even if both paths fire', async () => {
    const ready = vi.fn();
    document.addEventListener('bridge:socket-ready', ready);
    instance = mount(SocketManager, { target });
    sockets[0]!.connected = true;
    sockets[0]!.fire('connect');
    sockets[0]!.fire('userAuthenticated');
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ready).toHaveBeenCalledTimes(1);
    document.removeEventListener('bridge:socket-ready', ready);
  });

  it('reuses the existing socket when connect is requested again with the same token', async () => {
    instance = mount(SocketManager, { target });
    expect(sockets).toHaveLength(1);
    (mocks.registry.get('connectSocket') as () => void)();
    expect(sockets).toHaveLength(1);

    // Jeton değişirse eski soket kapatılır ve yenisi açılır (hesap değişimi).
    token = 'token-2';
    (mocks.registry.get('connectSocket') as () => void)();
    expect(sockets).toHaveLength(2);
    expect(sockets[0]!.disconnect).toHaveBeenCalled();
  });
});
