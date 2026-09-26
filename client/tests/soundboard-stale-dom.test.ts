// client/tests/soundboard-stale-dom.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// SOUNDBOARD — BAYAT/KURCALANMIŞ DOM VE YÖNETİM KİLİDİ
// ════════════════════════════════════════════════════════════════════════════
// Izgara, `data-sound-id` üzerinden TEMSİLCİ (delegated) gönderim yapar. Bu
// tasarımda düğmedeki kimlik, kullanıcının DOM'unda bulunan bir VERİDİR:
// bayat kalabilir (kütüphane yeniden yüklendi), uzantı/konsol tarafından
// değiştirilebilir, ya da yetki değişiminden sonra ekranda kalabilir.
//
// Bu yüzden sahiplik kararı DOM'dan değil, YÜKLENEN sayfadan okunur. Buradaki
// testler bunu kanıtlar: uydurma bir kimlik ses çalamaz, sunucuya ait olmayan
// bir ses yönetilemez ve eşzamanlı iki tıklama iki yazma üretemez.
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';

// KANONİK SÖZLÜĞE DEVRET.
// Önceki çift `(key, fallback) => fallback` biçimindeydi: yedek metni olmayan
// çağrılar HAM ANAHTAR döndürüyor, üçüncü argüman (`vars`) ise tamamen yok
// sayıldığı için `'{count} ses yüklendi'` gibi metinler YER TUTUCULARI
// YERLEŞTİRİLMEDEN kalıyordu. Böyle bir çift, ürünün yapmadığı bir davranışı
// ölçer; testler de gerçek metni değil çiftin kusurunu doğrular.
vi.mock('../js/core/i18n/index', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { ...real };
});

import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import {
  SOUNDBOARD_PLAY_WINDOW_MS,
  closeSoundboardPanel,
  initSoundboardSocket,
  openSoundboard,
  openSoundUpload,
  soundboardCooldownRemainingMs,
  stopSoundboard,
} from '../js/soundboard.ts';

const toast = vi.fn();
const apiFetch = vi.fn();
const socketEmit = vi.fn();
const rtc = { isInVoice: vi.fn(() => true), currentChannelId: 'voice-1' };

let clock = 1_800_000_000_000;

function response(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response;
}
function page(items: unknown[], options: { canManage?: boolean } = {}): unknown {
  return { items, nextCursor: null, canManage: options.canManage ?? false };
}
function sound(index: number, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { _id: `snd-${index}`, name: `Sound ${index}`, emoji: '🔊', url: `/sound-${index}.ogg`, scope: 'server', ...overrides };
}
async function flush(): Promise<void> {
  await Promise.resolve(); await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
}

async function chooseProductDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await flush();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`product dialog ${action} button missing`);
  button.click();
  await flush();
}

class AudioStub {
  static instances: AudioStub[] = [];
  static playImpl = vi.fn(async () => undefined);
  src: string;
  volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(() => AudioStub.playImpl());
  constructor(src = '') { this.src = src; AudioStub.instances.push(this); }
}

class FakeSocket {
  handlers = new Map<string, Set<(...payload: unknown[]) => void>>();
  on = vi.fn((event: string, handler: (...payload: unknown[]) => void) => {
    const handlers = this.handlers.get(event) ?? new Set(); handlers.add(handler); this.handlers.set(event, handlers); return this;
  });
  off = vi.fn((event: string, handler: (...payload: unknown[]) => void) => { this.handlers.get(event)?.delete(handler); return this; });
  emit = vi.fn();
  emitLocal(event: string, payload?: unknown): void { for (const handler of this.handlers.get(event) ?? []) handler(payload); }
}

async function openWith(items: unknown[], options: { canManage?: boolean } = {}): Promise<void> {
  apiFetch.mockResolvedValueOnce(response(200, page(items, options)));
  await openSoundboard();
}

const manageButton = () => document.querySelector('[data-soundboard-action="manage"]') as HTMLButtonElement;

beforeEach(() => {
  clock += 10 * 60_000;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  stopSoundboard(); closeSoundboardPanel();
  const resetSocket = new FakeSocket(); initSoundboardSocket(resetSocket)();
  document.body.innerHTML = '<button id="return-focus">Open</button><div class="chat-area"></div>';
  localStorage.clear();
  toast.mockReset(); apiFetch.mockReset(); socketEmit.mockReset();
  rtc.isInVoice.mockReset(); rtc.isInVoice.mockReturnValue(true); rtc.currentChannelId = 'voice-1';
  AudioStub.instances.length = 0; AudioStub.playImpl.mockReset(); AudioStub.playImpl.mockResolvedValue(undefined);
  vi.stubGlobal('toast', toast); vi.stubGlobal('apiFetch', apiFetch); BridgeRegistry.register('apiFetch', apiFetch as never); vi.stubGlobal('API', 'https://bridge.test');
  vi.stubGlobal('currentServer', { _id: 's1' }); vi.stubGlobal('Audio', AudioStub as unknown as typeof Audio);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:bridge-sound') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  BridgeRegistry.unregister('getCurrentServer'); BridgeRegistry.unregister('rtc'); BridgeRegistry.unregister('socket');
  BridgeRegistry.register('rtc', rtc as never); BridgeRegistry.register('socket', { emit: socketEmit } as never);
});

afterEach(() => { vi.restoreAllMocks(); });

describe('delegated identity is never authoritative', () => {
  it('refuses a forged sound id in the grid for both playback and management', async () => {
    await openWith([sound(1)], { canManage: true });
    const play = document.querySelector('[data-soundboard-action="play"]') as HTMLButtonElement;
    const manage = manageButton();
    expect(manage).not.toBeNull();

    play.dataset.soundId = 'not-in-library';
    manage.dataset.soundId = 'not-in-library';
    play.click(); await flush();
    expect(AudioStub.instances).toHaveLength(0);
    manage.click(); await flush();
    expect(document.getElementById('sound-manage-modal')).toBeNull();
  });

  it('refuses to manage a global sound even when a manage control points at it', async () => {
    await openWith([
      sound(1),
      { ...sound(2), _id: 'global:chime', scope: 'global', url: 'bridge-sound:chime' },
    ], { canManage: true });
    const manage = manageButton();
    manage.dataset.soundId = 'global:chime';
    manage.click(); await flush();
    // Bridge varsayılan sesleri sunucuya ait DEĞİLDİR: yeniden adlandırılamaz
    // veya silinemez.
    expect(document.getElementById('sound-manage-modal')).toBeNull();
  });

  it('ignores modal interaction whose event target is not an element', async () => {
    await openWith([sound(1)], { canManage: true });
    openSoundUpload();
    const modal = document.getElementById('sound-upload-modal') as HTMLElement;
    const text = document.createTextNode('x');
    modal.appendChild(text);
    text.dispatchEvent(new Event('click', { bubbles: true }));
    await flush();
    expect(document.getElementById('sound-upload-modal')).not.toBeNull();
  });
});

describe('management form defaults and write serialisation', () => {
  it('falls back to the default emoji and category when the form is cleared', async () => {
    await openWith([sound(1, { emoji: '💥', category: 'FX' })], { canManage: true });
    manageButton().click(); await flush();
    (document.getElementById('sound-rename-input') as HTMLInputElement).value = 'Renamed';
    (document.getElementById('sound-rename-emoji') as HTMLInputElement).value = '   ';
    (document.getElementById('sound-rename-category') as HTMLInputElement).value = '';

    apiFetch.mockResolvedValueOnce(response(200, { ok: true }));
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    (document.querySelector('[data-sound-manage-action="save"]') as HTMLButtonElement).click();
    await flush();

    const patch = apiFetch.mock.calls.find(call => call[1]?.method === 'PATCH');
    expect(JSON.parse(String(patch![1].body))).toEqual({ name: 'Renamed', emoji: '🔊', category: 'Server' });
  });

  it('serialises manage mutations so a double click cannot issue two writes', async () => {
    await openWith([sound(1)], { canManage: true });
    manageButton().click(); await flush();
    (document.getElementById('sound-rename-input') as HTMLInputElement).value = 'Renamed';

    let resolveSave!: (value: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveSave = resolve; }));
    const save = document.querySelector('[data-sound-manage-action="save"]') as HTMLButtonElement;
    save.click(); await flush();
    save.click(); await flush();
    expect(apiFetch.mock.calls.filter(call => call[1]?.method === 'PATCH')).toHaveLength(1);

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    resolveSave(response(200, { ok: true }));
    await flush();
    expect(document.getElementById('sound-manage-modal')).toBeNull();
  });

  it('serialises deletion the same way and honours the product confirmation dialog', async () => {
    await openWith([sound(1)], { canManage: true });
    manageButton().click(); await flush();

    (document.querySelector('[data-sound-manage-action="delete"]') as HTMLButtonElement).click();
    await chooseProductDialog('cancel');
    expect(apiFetch.mock.calls.filter(call => call[1]?.method === 'DELETE')).toHaveLength(0);

    let resolveDelete!: (value: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveDelete = resolve; }));
    const remove = document.querySelector('[data-sound-manage-action="delete"]') as HTMLButtonElement;
    remove.click(); await chooseProductDialog('confirm');
    remove.click(); await flush();
    expect(apiFetch.mock.calls.filter(call => call[1]?.method === 'DELETE')).toHaveLength(1);

    apiFetch.mockResolvedValueOnce(response(200, page([])));
    resolveDelete(response(200, { ok: true }));
    await flush();
    expect(document.getElementById('sound-manage-modal')).toBeNull();
  });

  it('reports a non-Error transport rejection with a stable message', async () => {
    await openWith([sound(1)], { canManage: true });
    manageButton().click(); await flush();
    (document.getElementById('sound-rename-input') as HTMLInputElement).value = 'Renamed';

    apiFetch.mockRejectedValueOnce('network down');
    (document.querySelector('[data-sound-manage-action="save"]') as HTMLButtonElement).click();
    await flush();
    expect(toast).toHaveBeenCalledWith(t('snd_update_failed'), 'error');

    apiFetch.mockRejectedValueOnce('network down');
    (document.querySelector('[data-sound-manage-action="delete"]') as HTMLButtonElement).click();
    // Silme onayi artik bir URUN DIYALOGUdur; surulmezse istek hic gitmez ve
    // ekranda yalnizca onceki (guncelleme) hatasi kalir.
    await chooseProductDialog('confirm');
    await flush();
    expect(toast).toHaveBeenCalledWith(t('snd_delete_failed'), 'error');
  });
});

describe('remote playback payload hardening', () => {
  it('ignores a remote playback event that carries no usable media url', () => {
    const socket = new FakeSocket(); initSoundboardSocket(socket);
    socket.emitLocal('soundboard:play', { channelId: 'voice-1', soundId: 'snd-1' });
    expect(AudioStub.instances).toHaveLength(0);
  });
});

describe('cooldown countdown surface', () => {
  it('does not shorten an active cooldown and counts it down to zero in the panel', async () => {
    // YALNIZ aralik (interval) sahte: `Date` sahtelenirse yukarida kurulan
    // saat casusu ezilir ve geri sayim olculemez.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    try {
      await openWith([sound(1)]);
      const socket = new FakeSocket(); initSoundboardSocket(socket);
      socket.emitLocal('error:ratelimit', { event: 'soundboard:play' });
      // Aynı anda gelen ikinci sinyal soğumayı UZATMAZ da KISALTMAZ da.
      socket.emitLocal('error:ratelimit', { event: 'soundboard:play' });
      expect(soundboardCooldownRemainingMs()).toBe(SOUNDBOARD_PLAY_WINDOW_MS);

      const notice = document.getElementById('soundboard-cooldown') as HTMLElement;
      expect(notice.textContent).toContain('5s');

      clock += 3_000;
      vi.advanceTimersByTime(400);
      expect(notice.textContent).toContain('2s');

      clock += 2_100;
      vi.advanceTimersByTime(400);
      expect(notice.hidden).toBe(true);
      expect((document.querySelector('.sound-btn') as HTMLButtonElement).disabled).toBe(false);

      // Süre dolduğunda zamanlayıcı KENDİNİ durdurur (sonsuz tik yok).
      const settled = notice.textContent;
      vi.advanceTimersByTime(10_000);
      expect(notice.textContent).toBe(settled);
    } finally {
      vi.useRealTimers();
    }
  });
});
