// client/tests/soundboard-cooldown-lifecycle.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// SOUNDBOARD — SOĞUMA, YÜKLEME İLERLEMESİ VE PANEL SAHİPLİĞİ
// ════════════════════════════════════════════════════════════════════════════
// Sunucu `soundboard:play` olayını kullanıcı başına 5 saniyede 6 ile sınırlar
// (`server/socket/socketRateLimit.ts`). Sınır aşıldığında olay SESSİZCE düşer:
// yalnızca `error:ratelimit` yayılır ve HTTP tarafında hiçbir iz kalmaz.
//
// Denetim öncesi istemci bu olayı hiç dinlemiyordu. Ölçülen sonuç: kullanıcı
// düğmeye basmaya devam ediyor, yerel önizlemeyi duyuyor, ama kanaldaki KİMSE
// sesi duymuyordu — ve arayüz bunu hiç göstermiyordu. Bu dosya, o sessiz
// düşüşün artık görünür bir SOĞUMA durumuna dönüştüğünü kanıtlar.
//
// Yerel bütçe bir yetkilendirme DEĞİLDİR; otorite sunucudadır. Buradaki
// beklentiler yalnızca arayüzün dürüstlüğünü ölçer.
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
  SOUNDBOARD_PLAY_BUDGET,
  SOUNDBOARD_PLAY_WINDOW_MS,
  closeSoundboardPanel,
  initSoundboardSocket,
  openSoundboard,
  openSoundUpload,
  playSound,
  soundboardCooldownRemainingMs,
  stopSoundboard,
  uploadSound,
} from '../js/soundboard.ts';

const toast = vi.fn();
const apiFetch = vi.fn();
const socketEmit = vi.fn();
const rtc = { isInVoice: vi.fn(() => true), currentChannelId: 'voice-1' };

let clock = 1_700_000_000_000;

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

/** Panel açar ve sayfayı yükler. */
async function openWith(items: unknown[], options: { canManage?: boolean } = {}): Promise<void> {
  apiFetch.mockResolvedValueOnce(response(200, page(items, options)));
  await openSoundboard();
}

beforeEach(() => {
  // Saat testler arasında GERİ ALINMAZ: modül durumu (soğuma bitişi) dosya
  // boyunca paylaşılır ve saati geri sarmak, bir önceki testin soğumasını
  // yapay olarak yeniden canlandırırdı.
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

afterEach(() => {
  vi.restoreAllMocks();
});

describe('soundboard playback cooldown', () => {
  it('spends the local budget, then blocks, announces and re-enables after the window', async () => {
    await openWith([sound(1)]);

    for (let index = 0; index < SOUNDBOARD_PLAY_BUDGET; index += 1) {
      playSound('snd-1'); await flush();
    }
    expect(socketEmit).toHaveBeenCalledTimes(SOUNDBOARD_PLAY_BUDGET);
    expect(soundboardCooldownRemainingMs()).toBe(0);

    // Bütçe dolu: yayın YAPILMAZ, kullanıcıya söylenir ve düğmeler kilitlenir.
    socketEmit.mockClear();
    playSound('snd-1'); await flush();
    expect(socketEmit).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('çok hızlı'), 'error');
    expect(soundboardCooldownRemainingMs()).toBeGreaterThan(0);

    const notice = document.getElementById('soundboard-cooldown') as HTMLElement;
    expect(notice.hidden).toBe(false);
    expect(notice.textContent).toMatch(/\d+s/);
    const button = document.querySelector('.sound-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(button.classList.contains('cooldown')).toBe(true);

    // Soğuma sürerken ek basışlar sessizce yutulur (ikinci bir toast üretmez).
    toast.mockClear();
    playSound('snd-1'); await flush();
    expect(socketEmit).not.toHaveBeenCalled();
    expect(toast).not.toHaveBeenCalled();

    // Pencere dolduğunda çalma yeniden mümkün olur.
    clock += SOUNDBOARD_PLAY_WINDOW_MS + 1;
    expect(soundboardCooldownRemainingMs()).toBe(0);
    playSound('snd-1'); await flush();
    expect(socketEmit).toHaveBeenCalledTimes(1);
  });

  it('honours the server rate-limit signal as the authority and ignores unrelated events', async () => {
    await openWith([sound(1)]);
    const socket = new FakeSocket(); initSoundboardSocket(socket);

    socket.emitLocal('error:ratelimit', null);
    socket.emitLocal('error:ratelimit', { event: 'message:send', message: 'slow down' });
    expect(soundboardCooldownRemainingMs()).toBe(0);
    expect(toast).not.toHaveBeenCalled();

    socket.emitLocal('error:ratelimit', { event: 'soundboard:play', message: 'Çok hızlı! Yavaşla.' });
    expect(soundboardCooldownRemainingMs()).toBe(SOUNDBOARD_PLAY_WINDOW_MS);
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('çok hızlı'), 'error');
    expect((document.getElementById('soundboard-cooldown') as HTMLElement).hidden).toBe(false);

    // Sunucu soğuması yerel bütçe harcanmamış olsa bile çalmayı durdurur.
    playSound('snd-1'); await flush();
    expect(socketEmit).not.toHaveBeenCalled();

    // Daha kısa bir ikinci sinyal, hâlihazırdaki soğumayı KISALTMAZ.
    clock += 1_000;
    socket.emitLocal('error:ratelimit', { event: 'soundboard:play' });
    expect(soundboardCooldownRemainingMs()).toBe(SOUNDBOARD_PLAY_WINDOW_MS);
  });

  it('never marks a permission-locked sound as merely cooling down', async () => {
    await openWith([sound(1), sound(2, { locked: true })]);
    const socket = new FakeSocket(); initSoundboardSocket(socket);
    socket.emitLocal('error:ratelimit', { event: 'soundboard:play' });

    const [playable, locked] = Array.from(document.querySelectorAll<HTMLButtonElement>('.sound-btn'));
    expect(playable.classList.contains('cooldown')).toBe(true);
    expect(locked.classList.contains('cooldown')).toBe(false);
    expect(locked.disabled).toBe(true);
    expect(locked.classList.contains('locked')).toBe(true);
  });
});

describe('soundboard upload progress', () => {
  function selectFile(bytes = 1024, type = 'audio/mpeg'): void {
    const input = document.getElementById('sound-file-input') as HTMLInputElement;
    const file = new File([new Uint8Array(bytes)], 'clip.mp3', { type });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    (document.getElementById('sound-name-input') as HTMLInputElement).value = 'Clip';
  }

  it('shows an indeterminate progress bar while the upload is in flight and clears it after success', async () => {
    await openWith([sound(1)], { canManage: true });
    openSoundUpload();
    selectFile();

    let resolveUpload!: (value: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveUpload = resolve; }));
    const submit = document.querySelector('[data-sound-upload-action="upload"]') as HTMLButtonElement;
    const pending = uploadSound();
    await flush();

    const progress = document.getElementById('sound-upload-progress') as HTMLElement;
    expect(progress.hidden).toBe(false);
    // Uydurma bir yüzde YOKTUR: belirsiz ilerlemenin doğru ARIA gösterimi budur.
    expect(progress.getAttribute('role')).toBe('progressbar');
    expect(progress.hasAttribute('aria-valuenow')).toBe(false);
    expect(submit.disabled).toBe(true);
    expect(submit.textContent).toContain('Yükleniyor');

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
    resolveUpload(response(200, { _id: 'snd-2' }));
    await pending; await flush();

    expect(document.getElementById('sound-upload-modal')).toBeNull();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('eklendi'), 'success');
  });

  it('restores the submit control and hides progress when the upload fails', async () => {
    await openWith([sound(1)], { canManage: true });
    openSoundUpload();
    selectFile();

    apiFetch.mockResolvedValueOnce(response(500, { error: 'storage offline' }));
    await uploadSound();
    await flush();

    const progress = document.getElementById('sound-upload-progress') as HTMLElement;
    const submit = document.querySelector('[data-sound-upload-action="upload"]') as HTMLButtonElement;
    expect(progress.hidden).toBe(true);
    expect(submit.disabled).toBe(false);
    expect(submit.textContent).toBe('Yükle');
    expect(toast).toHaveBeenCalledWith(t('error_server'), 'error');
    expect(toast).not.toHaveBeenCalledWith('storage offline', 'error');
  });

  it('survives a shell remount that removes the progress node mid-upload', async () => {
    await openWith([sound(1)], { canManage: true });
    openSoundUpload();
    selectFile();

    let resolveUpload!: (value: Response) => void;
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { resolveUpload = resolve; }));
    const pending = uploadSound();
    await flush();
    document.getElementById('sound-upload-progress')?.remove();

    resolveUpload(response(400, { error: 'rejected' }));
    await pending; await flush();
    expect(toast).toHaveBeenCalledWith(t('error_bad_request'), 'error');
  });
});

describe('soundboard panel ownership', () => {
  it('drops library ownership on close so a late play cannot broadcast into a left server', async () => {
    await openWith([sound(1)]);
    closeSoundboardPanel();

    playSound('snd-1'); await flush();
    expect(AudioStub.instances).toHaveLength(0);
    expect(socketEmit).not.toHaveBeenCalled();
  });

  it('keeps local usage bookkeeping safe when the panel closes before playback resolves', async () => {
    await openWith([sound(1)]);
    let resolvePlay!: () => void;
    AudioStub.playImpl.mockImplementationOnce(() => new Promise<void>(resolve => { resolvePlay = resolve; }));

    playSound('snd-1');
    closeSoundboardPanel();
    resolvePlay();
    await flush();

    // Sahiplik bittiği için yerel kullanım geçmişi YAZILMAZ.
    expect(localStorage.getItem('bridge.soundboard.usage.v1.s1')).toBeNull();
    // Çalma paneli kapanmadan ÖNCE başlatılmıştı; başlamış bir sesin yayını
    // bilerek iptal edilmez. Sunucu zaten kanal/sunucu sahipliğini yeniden
    // doğrular, bu yüzden bu yayın bir yetki atlaması üretmez.
    expect(socketEmit).toHaveBeenCalledWith('soundboard:play', { channelId: 'voice-1', soundId: 'snd-1' });
  });

  it('re-renders without throwing when the grid chrome disappears before a realtime resync', async () => {
    await openWith([sound(1)]);
    const socket = new FakeSocket(); initSoundboardSocket(socket);

    document.getElementById('soundboard-grid')?.remove();
    apiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
    socket.emitLocal('soundboard:updated', { serverId: 's1' });
    await flush();
    expect(apiFetch).toHaveBeenCalledTimes(2);

    // Durum satırı da kaybolduğunda hata durumu sessizce yutulur.
    document.getElementById('soundboard-status')?.remove();
    apiFetch.mockRejectedValueOnce(new Error('offline'));
    socket.emitLocal('soundboard:deleted', { serverId: 's1' });
    await flush();
    expect(document.getElementById('soundboard-panel')).not.toBeNull();
  });

  it('stops the cooldown ticker when the panel closes and resets the local budget only', async () => {
    await openWith([sound(1)]);
    const socket = new FakeSocket(); initSoundboardSocket(socket);
    socket.emitLocal('error:ratelimit', { event: 'soundboard:play' });
    expect(soundboardCooldownRemainingMs()).toBeGreaterThan(0);

    closeSoundboardPanel();
    // Sunucu kaynaklı soğuma kapat-aç ile ATLATILAMAZ.
    expect(soundboardCooldownRemainingMs()).toBeGreaterThan(0);

    await openWith([sound(1)]);
    const button = document.querySelector('.sound-btn') as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    playSound('snd-1'); await flush();
    expect(socketEmit).not.toHaveBeenCalled();

    clock += SOUNDBOARD_PLAY_WINDOW_MS + 1;
    playSound('snd-1'); await flush();
    expect(socketEmit).toHaveBeenCalledTimes(1);
  });
});
