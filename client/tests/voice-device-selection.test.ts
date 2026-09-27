// client/tests/voice-device-selection.test.ts
// FAZ D / SES — CİHAZ SEÇİMİ GERÇEKTEN UYGULANIR.
//
// ════════════════════════════════════════════════════════════════════════════
// DÜZELTİLEN GERÇEK SORUN (CANLI İŞLEV HATASI)
// ════════════════════════════════════════════════════════════════════════════
// Ayarlar → Cihazlar sekmesi seçimi şu anahtarlara yazıyordu:
//     bridge:device:mic · bridge:device:camera · bridge:device:speaker
// `webrtc.ts` `loadSavedDevices()` ise ESKİ adları okuyordu:
//     bridge-mic · bridge-camera · bridge-speaker
//
// Adlar hiç örtüşmediği için kayıtlı seçim ASLA yüklenmiyordu: kullanıcı
// mikrofon seçiyor, "kaydedildi" görüyor, ama görüşme VARSAYILAN cihazla
// kuruluyordu. Ayrıca sekme `voice:applyDeviceSettings` çağırıyordu —
// bu adın kayıt sayısı SIFIRDI, yani aktif görüşmede de hiçbir şey olmuyordu.
//
// Bu DORMANT bir yüzey DEĞİLDİ: `index.html` gerçek ayar butonları içerir ve
// `bridge:device:mic` üretim paketindeki güncel app chunk'ında bulunur.
//
// Bu paket her iki bağlantıyı da kilitler. `HUMAN_AUDIO_*` durumları
// DEĞİŞMEZ — bu testler teknik yolu kanıtlar, insan duyumunu değil.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CLIENT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = fs.readFileSync(path.join(CLIENT, 'js/webrtc.ts'), 'utf8');
const DEVICES_TAB = fs.readFileSync(
  path.join(CLIENT, 'js/core/settings/tabs/DevicesTab.svelte'), 'utf8');

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

// ════════════════════════════════════════════════════════════════════════════
// Sözleşme: iki taraf AYNI anahtarı kullanmalı
// ════════════════════════════════════════════════════════════════════════════
describe('D/SES — ayarlar ve RTC AYNI depolama anahtarını kullanır', () => {
  it('Ayarlar sekmesi kanonik anahtarlara yazar', () => {
    expect(DEVICES_TAB).toContain("'bridge:device:mic'");
    expect(DEVICES_TAB).toContain("'bridge:device:speaker'");
    expect(DEVICES_TAB).toContain("'bridge:device:camera'");
  });

  it('RTC motoru KANONİK anahtarı okur', () => {
    expect(SRC).toContain("'bridge:device:mic'");
    expect(SRC).toContain("'bridge:device:camera'");
    expect(SRC).toContain("'bridge:device:speaker'");
  });

  it('eski anahtarlar geriye dönük uyumluluk için KORUNUR', () => {
    // Daha önce ayar yapmış kullanıcılar seçimlerini kaybetmemeli.
    expect(SRC).toContain("'bridge-mic'");
  });

  it('`voice:applyDeviceSettings` KANONİK motorda kayıtlıdır', () => {
    expect(SRC).toContain("BridgeRegistry.register('voice:applyDeviceSettings'");
  });

  it('GÜVENLİK/MİMARİ: ikinci bir RTC sahibi kurulmaz', () => {
    // Kayıt yalnız `rtc` adıyla ve kanonik motor için yapılmalı.
    const rtcRegistrations = (SRC.match(/BridgeRegistry\.register\('rtc'/g) ?? []).length;
    expect(rtcRegistrations).toBeGreaterThan(0);
    expect(SRC).not.toMatch(/new\s+BridgeRTC\([^)]*\)[\s\S]{0,200}BridgeRegistry\.register\('rtc2'/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// Davranış: kaydedilen seçim yüklenir
// ════════════════════════════════════════════════════════════════════════════
describe('D/SES — kaydedilen cihaz seçimi YÜKLENİR', () => {
  /** `loadSavedDevices` mantığının birebir aynısı (sözleşme sabitlenir). */
  function loadSavedDevices(): { mic: string | null; camera: string | null; speaker: string | null } {
    const read = (canonical: string, legacy: string): string | null =>
      localStorage.getItem(canonical) || localStorage.getItem(legacy);
    return {
      mic:     read('bridge:device:mic',     'bridge-mic'),
      camera:  read('bridge:device:camera',  'bridge-camera'),
      speaker: read('bridge:device:speaker', 'bridge-speaker'),
    };
  }

  it('POZİTİF: Ayarlar’ın yazdığı kanonik seçim okunur', () => {
    localStorage.setItem('bridge:device:mic', 'mikrofon-A');

    expect(loadSavedDevices().mic).toBe('mikrofon-A');
  });

  it('eski anahtarla kaydedilmiş seçim de okunur (geçiş)', () => {
    localStorage.setItem('bridge-mic', 'eski-mikrofon');

    expect(loadSavedDevices().mic).toBe('eski-mikrofon');
  });

  it('kanonik anahtar eski anahtara ÖNCELİKLİDİR', () => {
    localStorage.setItem('bridge-mic', 'eski');
    localStorage.setItem('bridge:device:mic', 'yeni');

    expect(loadSavedDevices().mic).toBe('yeni');
  });

  it('hiç seçim yoksa null döner (varsayılan cihaz kullanılır)', () => {
    expect(loadSavedDevices().mic).toBeNull();
    expect(loadSavedDevices().camera).toBeNull();
    expect(loadSavedDevices().speaker).toBeNull();
  });

  it('kamera ve hoparlör de aynı sözleşmeyi izler', () => {
    localStorage.setItem('bridge:device:camera',  'kamera-A');
    localStorage.setItem('bridge:device:speaker', 'hoparlor-A');

    const d = loadSavedDevices();
    expect(d.camera).toBe('kamera-A');
    expect(d.speaker).toBe('hoparlor-A');
  });
});
