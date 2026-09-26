// client/tests/ptt-key-capture-labels.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// PushToTalkControl / VoicePTTController — TUŞ ETİKETİ SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════
// Bas-konuş tuşu bir KOMBİNASYON olabilir. Etiket üretimi iki kuralı aynı anda
// tutmak zorundadır:
//
//   1. Değiştiricinin KENDİSİ basıldığında iki kez yazılmaz. `Ctrl` tuşuna
//      basıldığında `e.ctrlKey` de doğrudur; kod bunu ayıklamazsa etiket
//      "Ctrl+Control" olur ve kullanıcı tuşunu tanıyamaz.
//   2. Yalnızca değiştirici basıldığında etiket BOŞ KALMAZ; `e.code`'a düşer.
//      Boş bir etiket, ayarlar ekranında "atanmadı" gibi görünürdü.
//
// Aynı sözleşme iki sahipte de (ayar kontrolü ve ses denetleyicisi) birebir
// aynıdır; ikisi ayrışırsa aynı tuş iki ayrı adla görünür.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent } from '@testing-library/svelte';
import PushToTalkControl from '../js/core/voice/PushToTalkControl.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';
import { loadPttSettings } from '../js/core/voice/ptt-settings.ts';

const REGISTRY_KEYS = ['voicePanel:startPttKeyCapture', 'voicePanel:isPttCapturing'];

function keydown(init: Partial<KeyboardEventInit> & { code: string }): void {
  document.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init } as KeyboardEventInit));
}

/** Tuş atama düğmesi YALNIZCA bas-konuş açıkken çizilir. */
const captureButton = () => document.querySelector<HTMLButtonElement>('.ptt-key-controls .ptt-btn');

/** Kontrolü çizer, bas-konuşu açar ve yakalamayı başlatır. */
async function enableAndCapture(): Promise<void> {
  render(PushToTalkControl);
  const toggle = document.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  await fireEvent.change(toggle, { target: { checked: true } });
  const button = captureButton();
  expect(button).toBeTruthy();
  button!.click();
}

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  for (const key of REGISTRY_KEYS) BridgeRegistry.unregister(key);
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false, addEventListener() {}, removeEventListener() {} })));
});

afterEach(() => {
  cleanup();
  for (const key of REGISTRY_KEYS) BridgeRegistry.unregister(key);
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('local key capture when no voice controller owns it', () => {

  it.each([
    [{ code: 'KeyT', key: 't' }, 'T'],
    [{ code: 'Space', key: ' ' }, 'Space'],
    [{ code: 'F13', key: 'F13' }, 'F13'],
    [{ code: 'KeyT', key: 't', ctrlKey: true }, 'Ctrl+T'],
    [{ code: 'KeyT', key: 't', altKey: true }, 'Alt+T'],
    [{ code: 'KeyT', key: 't', shiftKey: true }, 'Shift+T'],
    [{ code: 'KeyT', key: 't', metaKey: true }, 'Meta+T'],
    [{ code: 'KeyT', key: 't', ctrlKey: true, altKey: true, shiftKey: true, metaKey: true }, 'Ctrl+Alt+Shift+Meta+T'],
  ])('labels %j as %s', async (init, expected) => {
    await enableAndCapture();
    keydown(init as Partial<KeyboardEventInit> & { code: string });
    expect(loadPttSettings().key).toEqual({ code: (init as { code: string }).code, label: expected });
  });

  it.each([
    ['ControlLeft', true, 'ctrlKey'],
    ['AltRight', true, 'altKey'],
    ['ShiftLeft', true, 'shiftKey'],
    ['MetaRight', true, 'metaKey'],
  ])('never prints %s twice when the modifier itself is the chosen key', async (code, _pressed, flag) => {
    await enableAndCapture();
    keydown({ code, key: 'Modifier', [flag]: true } as never);
    const label = loadPttSettings().key!.label;
    // Etiket kendi değiştiricisini TEKRARLAMAZ ve boş kalmaz.
    expect(label).toBe(code);
    expect(label.includes('+')).toBe(false);
  });

  it('lists only the other held modifiers when the chosen key is itself a modifier', async () => {
    await enableAndCapture();
    keydown({ code: 'ControlLeft', key: 'Control', ctrlKey: true, shiftKey: true });
    const stored = loadPttSettings().key!;
    // Eşleşme `code` ile yapılır; etiket yalnızca GÖRÜNEN addır. Seçilen tuşun
    // kendisi bir değiştirici olduğu için tekrar yazılmaz ve yalnızca birlikte
    // basılan diğer değiştirici görünür.
    expect(stored.code).toBe('ControlLeft');
    expect(stored.label).toBe('Shift');
  });

  it('abandons capture on Escape without assigning anything', async () => {
    await enableAndCapture();
    keydown({ code: 'Escape', key: 'Escape' });
    expect(loadPttSettings().key).toBeNull();

    // Yakalama durduğu için sonraki tuş de atanmaz.
    keydown({ code: 'KeyT', key: 't' });
    expect(loadPttSettings().key).toBeNull();
  });

  it('swallows the captured key so it triggers no other Bridge action', async () => {
    await enableAndCapture();
    const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyT', key: 't' });
    document.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it('captures only once per activation', async () => {
    await enableAndCapture();
    keydown({ code: 'KeyT', key: 't' });
    keydown({ code: 'KeyR', key: 'r' });
    expect(loadPttSettings().key!.code).toBe('KeyT');
  });
});

describe('capture ownership', () => {
  it('delegates to the voice controller when one is mounted', async () => {
    const start = vi.fn();
    BridgeRegistry.register('voicePanel:startPttKeyCapture', start as never);
    await enableAndCapture();

    expect(start).toHaveBeenCalledTimes(1);
    // Denetleyici sahipse yerel dinleyici KURULMAZ: iki sahip aynı tuşu iki
    // kez yazar ve son yazan kazanırdı.
    keydown({ code: 'KeyT', key: 't' });
    expect(loadPttSettings().key).toBeNull();
  });
});

describe('honest degradation on a touch-only device', () => {
  it('says push-to-talk is unavailable instead of rendering dead controls', () => {
    vi.stubGlobal('matchMedia', vi.fn((query: string) => ({
      matches: query.includes('pointer: coarse'),
      addEventListener() {}, removeEventListener() {},
    })));
    render(PushToTalkControl);
    expect(document.querySelector('.ptt-note')).not.toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('renders the full control when a pointing device with hover exists', () => {
    render(PushToTalkControl);
    expect(document.querySelector('.ptt-note')).toBeNull();
    expect(document.querySelector('input[type="checkbox"]')).not.toBeNull();
  });
});
