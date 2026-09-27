// client/tests/voice-ptt-controller-labels-and-guards.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// VoicePTTController.svelte — TUŞ ETİKETİ VE "SESTE DEĞİLKEN" MUHAFIZI
// ════════════════════════════════════════════════════════════════════════════
// Denetleyici, ayar kontrolüyle AYNI etiket sözleşmesini taşır: değiştiricinin
// kendisi seçildiğinde iki kez yazılmaz ve etiket asla boş kalmaz. İki sahip
// ayrışırsa aynı fiziksel tuş ayarlar ekranında bir adla, ses panelinde başka
// bir adla görünür.
//
// İkinci sözleşme daha kritiktir: bas-konuş SESTE DEĞİLKEN mikrofonu
// AÇMAMALIDIR. `setMuted(false)` çağrısı bir arama dışında anlamsızdır ve
// kullanıcıya "yayındayım" izlenimi veren bir arayüz durumu üretirdi.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

const mocks = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn(), debug: vi.fn() }));

vi.mock('../js/core/voice/ptt-settings.ts', () => ({
  PTT_CHANGED_EVENT: 'bridge:ptt-changed',
  loadPttSettings: mocks.load,
  savePttSettings: mocks.save,
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ debug: mocks.debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import VoicePTTController from '../js/core/VoicePTTController.svelte';

type Controller = {
  setEnabled(on: boolean): void;
  setMode(mode: 'hold' | 'toggle'): void;
  setReleaseDelay(ms: number): void;
  clearKey(): void;
  getStatus(): { enabled: boolean; mode: 'hold' | 'toggle'; key: null | { code: string; label: string }; releaseDelay: number; active: boolean };
  isCapturing(): boolean;
  startCapture(): void;
  stopCapture(): void;
};

let host: HTMLDivElement;
let instance: Controller | null = null;
let setMuted: ReturnType<typeof vi.fn>;
let isInVoice: ReturnType<typeof vi.fn>;

function renderController(settings: Record<string, unknown> = {
  enabled: true, mode: 'hold', key: { code: 'KeyV', label: 'V' }, releaseDelay: 200,
}): Controller {
  // Denetleyici BELGE seviyesinde klavye dinler. Önceki örnek sökülmezse iki
  // sahip aynı tuşu işler ve ölçüm anlamını yitirir.
  if (instance) { unmount(instance as never); instance = null; }
  mocks.load.mockReturnValue(settings);
  const controller = mount(VoicePTTController, {
    target: host,
    props: { getRtc: () => ({ isInVoice, setMuted }), onStatusChange: vi.fn() },
  }) as unknown as Controller;
  // Kalıcı ayarlar `onMount` içinde okunur; efektler boşaltılmadan durum
  // varsayılan (tuşsuz) hâlinde kalır ve klavye muhafızları yanlış ölçülürdü.
  flushSync();
  return controller;
}

function key(init: Partial<KeyboardEventInit> & { code: string }, type = 'keydown'): void {
  document.dispatchEvent(new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init } as KeyboardEventInit));
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.load.mockReset(); mocks.save.mockReset(); mocks.debug.mockReset();
  mocks.save.mockImplementation((settings: Record<string, unknown>) => {
    mocks.load.mockReturnValue({ ...settings, key: settings.key ? { ...(settings.key as object) } : null });
    document.dispatchEvent(new CustomEvent('bridge:ptt-changed'));
  });
  setMuted = vi.fn();
  isInVoice = vi.fn(() => true);
  host = document.createElement('div');
  document.body.appendChild(host);
});

afterEach(() => {
  if (instance) unmount(instance as never);
  instance = null;
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('key label contract matches the settings control', () => {
  it.each([
    [{ code: 'KeyT', key: 't' }, 'T'],
    [{ code: 'Space', key: ' ' }, 'Space'],
    [{ code: 'F13', key: 'F13' }, 'F13'],
    [{ code: 'KeyT', key: 't', ctrlKey: true }, 'Ctrl+T'],
    [{ code: 'KeyT', key: 't', altKey: true }, 'Alt+T'],
    [{ code: 'KeyT', key: 't', shiftKey: true }, 'Shift+T'],
    [{ code: 'KeyT', key: 't', metaKey: true }, 'Meta+T'],
    [{ code: 'KeyT', key: 't', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }, 'Ctrl+Alt+Shift+Meta+T'],
  ])('labels %j as %s', (init, expected) => {
    instance = renderController();
    instance.startCapture();
    key(init as Partial<KeyboardEventInit> & { code: string });
    expect(instance.getStatus().key).toEqual({ code: (init as { code: string }).code, label: expected });
  });

  it.each([
    ['ControlLeft', 'ctrlKey'],
    ['AltRight', 'altKey'],
    ['ShiftLeft', 'shiftKey'],
    ['MetaRight', 'metaKey'],
  ])('never repeats %s when the modifier itself is the chosen key', (code, flag) => {
    instance = renderController();
    instance.startCapture();
    key({ code, key: 'Modifier', [flag]: true } as never);
    expect(instance.getStatus().key!.label).toBe(code);
  });

  it('abandons capture on Escape without changing the stored key', () => {
    instance = renderController();
    instance.startCapture();
    expect(instance.isCapturing()).toBe(true);
    key({ code: 'Escape', key: 'Escape' });
    expect(instance.isCapturing()).toBe(false);
    expect(instance.getStatus().key).toEqual({ code: 'KeyV', label: 'V' });
  });
});

describe('push-to-talk never unmutes outside a call', () => {
  it('ignores the hold key entirely when the user is not in voice', () => {
    isInVoice.mockReturnValue(false);
    instance = renderController();
    key({ code: 'KeyV', key: 'v' });
    expect(setMuted).not.toHaveBeenCalled();
    expect(instance.getStatus().active).toBe(false);
  });

  it('ignores the release when the user left the call mid-hold', () => {
    instance = renderController();
    key({ code: 'KeyV', key: 'v' });
    expect(setMuted).toHaveBeenCalledWith(false);

    setMuted.mockClear();
    isInVoice.mockReturnValue(false);
    key({ code: 'KeyV', key: 'v' }, 'keyup');
    vi.advanceTimersByTime(1_000);
    expect(setMuted).not.toHaveBeenCalled();
  });

  it('ignores the key when no RTC owner is available at all', () => {
    mocks.load.mockReturnValue({ enabled: true, mode: 'hold', key: { code: 'KeyV', label: 'V' }, releaseDelay: 0 });
    instance = mount(VoicePTTController, {
      target: host,
      props: { getRtc: () => null, onStatusChange: vi.fn() },
    }) as unknown as Controller;
    flushSync();
    key({ code: 'KeyV', key: 'v' });
    expect(instance.getStatus().active).toBe(false);
  });
});

describe('hold and toggle guards', () => {
  it('cancels a pending release when the key is pressed again during the delay', () => {
    instance = renderController({ enabled: true, mode: 'hold', key: { code: 'KeyV', label: 'V' }, releaseDelay: 500 });
    key({ code: 'KeyV', key: 'v' });
    key({ code: 'KeyV', key: 'v' }, 'keyup');
    vi.advanceTimersByTime(200);

    setMuted.mockClear();
    key({ code: 'KeyV', key: 'v' });     // gecikme dolmadan tekrar basıldı
    vi.advanceTimersByTime(1_000);
    // Bekleyen susturma İPTAL edilir; aksi hâlde kullanıcı konuşurken mikrofon
    // kendiliğinden kapanırdı.
    expect(setMuted).not.toHaveBeenCalledWith(true);
  });

  it('ignores operating-system key repeat in both modes', () => {
    for (const mode of ['hold', 'toggle'] as const) {
      setMuted.mockClear();
      instance = renderController({ enabled: true, mode, key: { code: 'KeyV', label: 'V' }, releaseDelay: 0 });
      key({ code: 'KeyV', key: 'v' });
      key({ code: 'KeyV', key: 'v', repeat: true });
      key({ code: 'KeyV', key: 'v', repeat: true });
      expect(setMuted.mock.calls.filter(call => call[0] === false)).toHaveLength(1);
    }
  });

  it('does nothing while a text field or editable region has focus', () => {
    instance = renderController();
    const input = document.createElement('input');
    document.body.appendChild(input);
    input.focus();
    key({ code: 'KeyV', key: 'v' });
    expect(setMuted).not.toHaveBeenCalled();
    input.remove();

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    Object.defineProperty(editable, 'isContentEditable', { configurable: true, value: true });
    document.body.appendChild(editable);
    editable.focus();
    key({ code: 'KeyV', key: 'v' });
    expect(setMuted).not.toHaveBeenCalled();
    editable.remove();
  });

  it('ignores key-up when push-to-talk is disabled, unkeyed or in toggle mode', () => {
    instance = renderController({ enabled: false, mode: 'hold', key: { code: 'KeyV', label: 'V' }, releaseDelay: 0 });
    key({ code: 'KeyV', key: 'v' }, 'keyup');

    instance = renderController({ enabled: true, mode: 'hold', key: null, releaseDelay: 0 });
    key({ code: 'KeyV', key: 'v' }, 'keyup');

    instance = renderController({ enabled: true, mode: 'toggle', key: { code: 'KeyV', label: 'V' }, releaseDelay: 0 });
    key({ code: 'KeyV', key: 'v' }, 'keyup');
    vi.advanceTimersByTime(1_000);
    expect(setMuted).not.toHaveBeenCalledWith(true);
  });

  it('ignores a key-up for a different physical key', () => {
    instance = renderController({ enabled: true, mode: 'hold', key: { code: 'KeyV', label: 'V' }, releaseDelay: 0 });
    key({ code: 'KeyV', key: 'v' });
    setMuted.mockClear();
    key({ code: 'KeyB', key: 'b' }, 'keyup');
    vi.advanceTimersByTime(1_000);
    expect(setMuted).not.toHaveBeenCalled();
  });
});
