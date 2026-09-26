// client/tests/soundboard-apifetch-registry.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SOUNDBOARD HTTP İSTEMCİSİNİ REGISTRY'DEN ÇÖZER — GLOBAL'E BAĞLI DEĞİL
// ════════════════════════════════════════════════════════════════════════════
// SINIFI KAPATAN GERİLEME TESTİ.
//
// CANLI ÜRÜNDE (v1.124.1, gerçek tarayıcı): Soundboard paneli her açılışta
// gövdesinde ham `apiFetch is not defined` gösteriyordu. Sebep: `soundboard.ts`
// HTTP istemcisine SERBEST BİR GLOBAL değişken olarak erişiyordu. Bu ne
// import ne registry ile bağlıydı; üretimde böyle bir global YOK.
//
// Neden mevcut testler yakalamadı: hepsi `vi.stubGlobal('apiFetch', …)` ile
// bir global enjekte ediyordu — yani sözleşme YALNIZCA test ortamında vardı.
//
// Bu test, üretim koşulunu birebir kurar:
//   · HİÇBİR global `apiFetch` YOK (silinir),
//   · istemci YALNIZCA registry'de kayıtlı (üretimde `core/api-fetch.ts`
//     bunu yapar),
// ve Soundboard'un yine de yüklendiğini, ham `apiFetch is not defined`
// hatasının HİÇ görünmediğini doğrular.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import { closeSoundboardPanel, openSoundboard, stopSoundboard } from '../js/soundboard.ts';

const response = (status: number, body: unknown): Response =>
  ({ ok: status >= 200 && status < 300, status, json: vi.fn(async () => body) } as unknown as Response);

const page = (items: unknown[]): unknown => ({ items, nextCursor: null, canManage: false });
const sound = (i: number): Record<string, unknown> =>
  ({ _id: `snd-${i}`, name: `Sound ${i}`, emoji: '🔊', url: `/s-${i}.ogg`, scope: 'server' });

const flush = async (): Promise<void> => {
  await Promise.resolve(); await Promise.resolve();
  await new Promise(r => setTimeout(r, 0));
};

const registryApiFetch = vi.fn();

beforeEach(() => {
  stopSoundboard(); closeSoundboardPanel();
  document.body.innerHTML = '<div class="chat-area"></div>';
  registryApiFetch.mockReset();

  // ── ÜRETİM KOŞULU: global `apiFetch` YOK ──────────────────────────────────
  // Bilerek stub'lamıyoruz; hatta varsa siliyoruz. Bare bir `apiFetch`
  // referansı üretimde olduğu gibi çözümlenememelidir — modül yalnızca
  // registry'ye güvenmelidir.
  delete (globalThis as Record<string, unknown>).apiFetch;
  vi.stubGlobal('API', 'https://bridge.test');
  vi.stubGlobal('toast', vi.fn());
  vi.stubGlobal('currentServer', { _id: 's1' });
  vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: false })));

  // rtc/getCurrentServer registry üzerinden — mevcut sözleşme.
  BridgeRegistry.register('rtc', { isInVoice: () => false, currentChannelId: null } as never);
  BridgeRegistry.unregister('getCurrentServer');
});

afterEach(() => {
  BridgeRegistry.unregister('apiFetch');
  closeSoundboardPanel(); stopSoundboard();
});

describe('Soundboard, HTTP istemcisini yalnızca registry\'den alır', () => {
  it('registry\'de kayıtlı istemciyle YÜKLENIR ve `apiFetch is not defined` GÖSTERMEZ', async () => {
    registryApiFetch.mockResolvedValueOnce(response(200, page([sound(1), sound(2)])));
    BridgeRegistry.register('apiFetch', registryApiFetch as never);

    await openSoundboard();
    await flush();

    // Kanonik istemci registry'den çözülüp GERÇEKTEN çağrılmalı.
    expect(registryApiFetch).toHaveBeenCalledTimes(1);
    expect(registryApiFetch.mock.calls[0][0]).toContain('/soundboard');

    // Panel açıldı ve HAM hata metni yok.
    const panel = document.getElementById('soundboard-panel');
    expect(panel).not.toBeNull();
    expect(panel?.textContent ?? '').not.toContain('apiFetch is not defined');
    expect(panel?.textContent ?? '').not.toContain('is not defined');

    // Sesler render edildi.
    expect(document.querySelectorAll('.sound-btn').length).toBeGreaterThan(0);
  });

  it('istemci registry\'de YOKKEN bile ham ReferenceError sızdırmaz — güvenli metin gösterir', async () => {
    // Kayıt YOK: `BridgeRegistry.get('apiFetch')` undefined döner. Modül,
    // ham `apiFetch is not defined` yerine güvenli bir durum göstermelidir.
    BridgeRegistry.unregister('apiFetch');

    await openSoundboard();
    await flush();

    const panel = document.getElementById('soundboard-panel');
    expect(panel).not.toBeNull();
    const text = panel?.textContent ?? '';
    expect(text).not.toContain('apiFetch is not defined');
    expect(text).not.toContain('is not defined');
    // Hata durumu bir "tekrar dene" eylemi sunar.
    expect(panel?.querySelector('[data-soundboard-action="retry"]')).not.toBeNull();
  });
});
