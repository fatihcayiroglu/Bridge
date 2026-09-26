// client/tests/soundboard-modal-guards.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// soundboard.ts — KİPLİ PENCERE MUHAFIZLARI VE ODAK TUZAĞININ UÇ HÂLLERİ
// ════════════════════════════════════════════════════════════════════════════
// Yükleme ve yönetme pencereleri `aria-modal="true"` taşır. Bu bir SÖZDİR:
// odak pencerenin İÇİNDE kalır ve arkadaki panel kullanılamaz. Sözleşme
// yalnızca "ileri Tab" için değil, HER giriş yolu için tutmalıdır:
//
//   · Shift+Tab ilk denetimden geriye sarar,
//   · odak pencere DIŞINDAYKEN (indexOf === -1) Tab ilk denetime döner —
//     aksi hâlde odak arkadaki sayfaya kaçar ve kipli pencere yalan söyler,
//   · tıklama, eylem taşımayan bir alana düştüğünde HİÇBİR ŞEY yapmaz.
//
// Ayrıca yükleme yolunun kullanıcıya söylediği şey ölçülür: belirsiz ilerleme
// çubuğu görünür, gönder düğmesi kilitlenir ve HATA METNİ — `Error` olmayan
// bir değer fırlatılsa bile — anlaşılır kalır.
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  closeSoundboardPanel, initSoundboardSocket, openSoundboard, openSoundUpload,
  playSound, setSoundboardMuted, setSoundboardVolume, stopSoundboard, uploadSound,
} from '../js/soundboard.ts';

const toast = vi.fn();
const apiFetch = vi.fn();
const rtc = { isInVoice: vi.fn(() => true), currentChannelId: 'voice-1' };

const response = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response);

const page = (items: unknown[], canManage = true): unknown => ({ items, nextCursor: null, canManage });
const sound = (index: number, extra: Record<string, unknown> = {}): Record<string, unknown> =>
  ({ _id: `snd-${index}`, name: `Sound ${index}`, emoji: '🔊', url: `/sound-${index}.ogg`, scope: 'server', ...extra });

const flush = async (): Promise<void> => {
  await Promise.resolve(); await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
};

class AudioStub {
  static instances: AudioStub[] = [];
  src: string; volume = 1;
  onended: (() => void) | null = null;
  onerror: (() => void) | null = null;
  pause = vi.fn();
  play = vi.fn(async () => undefined);
  constructor(src = '') { this.src = src; AudioStub.instances.push(this); }
}

class FakeSocket {
  handlers = new Map<string, Set<(...payload: unknown[]) => void>>();
  on = vi.fn((event: string, handler: (...payload: unknown[]) => void) => {
    const set = this.handlers.get(event) ?? new Set(); set.add(handler); this.handlers.set(event, set); return this;
  });
  off = vi.fn((event: string, handler: (...payload: unknown[]) => void) => { this.handlers.get(event)?.delete(handler); return this; });
  emit = vi.fn();
}

/** Kipli pencereyi, `canManage: true` dönen gerçek panel akışıyla açar. */
async function openPanelThenUploadModal(): Promise<void> {
  apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
  await openSoundboard();
  await flush();
  openSoundUpload();
}

function selectFile(bytes = 1_024, type = 'audio/mpeg'): void {
  const input = document.getElementById('sound-file-input') as HTMLInputElement;
  const file = new File([new Uint8Array(bytes)], 'boom.mp3', { type });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });
}

const modal = () => document.getElementById('sound-upload-modal')!;
const submit = () => document.querySelector<HTMLButtonElement>('[data-sound-upload-action="upload"]')!;

beforeEach(() => {
  stopSoundboard(); closeSoundboardPanel();
  initSoundboardSocket(new FakeSocket())();
  document.body.innerHTML = '<button id="return-focus">Aç</button><div class="chat-area"></div>';
  localStorage.clear();
  toast.mockReset(); apiFetch.mockReset();
  rtc.isInVoice.mockReset(); rtc.isInVoice.mockReturnValue(true);
  AudioStub.instances.length = 0;
  vi.stubGlobal('toast', toast); vi.stubGlobal('apiFetch', apiFetch); BridgeRegistry.register('apiFetch', apiFetch as never); vi.stubGlobal('API', 'https://bridge.test');
  vi.stubGlobal('currentServer', { _id: 's1' }); vi.stubGlobal('Audio', AudioStub as unknown as typeof Audio);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:bridge-sound') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  BridgeRegistry.unregister('getCurrentServer');
  BridgeRegistry.register('rtc', rtc as never);
  BridgeRegistry.register('socket', { emit: vi.fn() } as never);
  setSoundboardMuted(false); setSoundboardVolume(0.8);
});

describe('modal focus trap holds from every entry point', () => {
  it('wraps backwards from the first control on Shift+Tab', async () => {
    await openPanelThenUploadModal();
    const controls = [...modal().querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
      .filter(control => !control.closest('[hidden]'));
    controls[0].focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    modal().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[controls.length - 1]);
  });

  it('pulls focus back inside when it has escaped the dialog entirely', async () => {
    await openPanelThenUploadModal();
    const controls = [...modal().querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
      .filter(control => !control.closest('[hidden]'));

    // Odak pencerenin DIŞINDA: `indexOf` -1 döner. Bu, kipli pencerenin en
    // kolay kırıldığı yoldur ve düzeltilmezse arkadaki sayfa gezilebilir olur.
    (document.getElementById('return-focus') as HTMLButtonElement).focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    modal().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
  });

  it('wraps forwards from the last control', async () => {
    await openPanelThenUploadModal();
    const controls = [...modal().querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')]
      .filter(control => !control.closest('[hidden]'));
    controls[controls.length - 1].focus();

    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    modal().dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(controls[0]);
  });

  it('ignores a click that carries no declared action', async () => {
    await openPanelThenUploadModal();
    const title = modal().querySelector('#sound-upload-title') as HTMLElement;
    title.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Eylemsiz tıklama pencereyi KAPATMAZ ve isteğe dönüşmez.
    expect(document.getElementById('sound-upload-modal')).not.toBeNull();
    expect(apiFetch).toHaveBeenCalledTimes(1);   // yalnızca panelin ilk yüklemesi
  });
});

describe('upload reports progress and failure honestly', () => {
  it('shows an indeterminate bar and locks the submit control while in flight', async () => {
    await openPanelThenUploadModal();
    selectFile();
    (document.getElementById('sound-name-input') as HTMLInputElement).value = 'Boom';
    // Emoji BOŞ bırakılır: kanonik yedek uygulanmalı, boş string gitmemeli.
    (document.getElementById('sound-emoji-input') as HTMLInputElement).value = '   ';

    let release: (value: Response) => void = () => {};
    apiFetch.mockImplementationOnce(() => new Promise<Response>(resolve => { release = resolve; }));

    const pending = uploadSound();
    const progress = document.getElementById('sound-upload-progress')!;
    expect(progress.hidden).toBe(false);
    // Uydurma bir yüzde GÖSTERİLMEZ; belirsiz ilerlemenin doğru gösterimi budur.
    expect(progress.getAttribute('aria-valuenow')).toBeNull();
    expect(submit().disabled).toBe(true);

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    release(response(200, {}));
    await pending;
    await flush();

    const body = apiFetch.mock.calls[1][1].body as FormData;
    expect(body.get('emoji')).toBe('🔊');
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('eklendi'), 'success');
  });

  it('surfaces a readable message even when a non-Error value is thrown', async () => {
    await openPanelThenUploadModal();
    selectFile();
    (document.getElementById('sound-name-input') as HTMLInputElement).value = 'Boom';

    // Ağ katmanı bir `Error` değil, çıplak bir değer fırlatabilir.
    apiFetch.mockImplementationOnce(() => { throw 'kablo koptu'; });
    await uploadSound();

    expect(toast).toHaveBeenCalledWith('Yüklenemedi', 'error');
    // Pencere AÇIK kalır ve denetimler yeniden kullanılabilir olur.
    expect(document.getElementById('sound-upload-modal')).not.toBeNull();
    expect(document.getElementById('sound-upload-progress')!.hidden).toBe(true);
    expect(submit().disabled).toBe(false);
  });
});

describe('playback and panel guards', () => {
  it('refuses a sound whose url claims a built-in tone that does not exist', async () => {
    apiFetch.mockResolvedValueOnce(response(200, page([
      sound(1, { url: 'bridge-sound:kesinlikle-yok' }),
    ])));
    await openSoundboard();
    await flush();

    await playSound('snd-1');
    await flush();
    // Bilinmeyen yerleşik ton SESSİZ kalır; uydurma bir ses üretilmez.
    expect(AudioStub.instances).toHaveLength(0);
  });

  it('remembers no return focus when nothing focusable was active', async () => {
    // `document.activeElement` `<body>`'dir — `HTMLElement` olsa da odaklanabilir
    // bir denetim DEĞİLDİR; panel kapanışta odağı ona zorlamamalıdır.
    const detached = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    document.body.append(detached);
    Object.defineProperty(document, 'activeElement', { configurable: true, get: () => detached });

    apiFetch.mockResolvedValueOnce(response(200, page([sound(1)])));
    await openSoundboard();
    await flush();
    expect(document.getElementById('soundboard-panel')).not.toBeNull();

    Reflect.deleteProperty(document, 'activeElement');
    closeSoundboardPanel();
    expect(document.getElementById('soundboard-panel')).toBeNull();
  });

  it('produces no request path at all before a server is chosen', async () => {
    vi.stubGlobal('currentServer', null);
    await openSoundboard();
    // Sunucu seçilmeden istek üretilmez; boş yol bir "/api/servers//..." çağrısına
    // dönüşseydi sunucuda anlamsız bir 404 üretirdi.
    expect(apiFetch).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('sunucu'), 'error');
  });
});
