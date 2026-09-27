// client/js/core/voice-actions.ts
//
// Svelte `use:` eylemleri — uzak ses/görüntü elemanlarının bağlanması.

import { BridgeRegistry } from './bridge-registry.js';

export function setSrcObject(el: HTMLMediaElement | null, stream: MediaStream | null) {
  if (el) el.srcObject = stream;
  return {
    update(next: MediaStream | null): void {
      if (el) el.srcObject = next;
    },
  };
}

/** `setSinkId` destekleyen eleman. Tarayıcıların bir kısmında yoktur. */
type SinkCapable = HTMLMediaElement & { setSinkId?(id: string): Promise<void> };

/**
 * ════════════════════════════════════════════════════════════════════════════
 * SEÇİLİ HOPARLÖR, SONRADAN GELEN KATILIMCILARA DA UYGULANIR
 * ════════════════════════════════════════════════════════════════════════════
 * KAPATILAN GERÇEK KUSUR: `BridgeRTC.setSpeakerDevice()` yalnızca O ANDA
 * belgede bulunan `.remote-audio` elemanlarına `setSinkId` uyguluyordu.
 * Uzak ses elemanları ise katılımcı geldikçe `{#each}` tarafından ÜRETİLİR.
 *
 * Sonuç: kullanıcı hoparlörü değiştirir, sonra biri kanala katılır — o kişinin
 * sesi VARSAYILAN cihazdan çıkar. Aynı görüşmede bazı kişiler seçilen
 * cihazdan, bazıları varsayılandan duyulur. Kulaklık/hoparlör karışımı yankı
 * teşhisini de bulanıklaştırır: kullanıcı "kulaklıktayım" der ama bir kısım
 * ses hoparlörden çıkıyordur.
 *
 * Bu eylem, eleman OLUŞTUĞU anda seçili çıkışı uygular; kaynak yine tek
 * yerdir (RTC sahibinin `selectedSpeakerId` alanı), burada ikinci bir tercih
 * deposu TUTULMAZ.
 */
export function applySelectedSink(el: HTMLMediaElement | null): void {
  if (!el) return;
  const rtc = BridgeRegistry.get<{ selectedSpeakerId?: string | null }>('rtc');
  const deviceId = rtc?.selectedSpeakerId;
  if (!deviceId) return;                       // varsayılan cihaz — dokunma
  const sinkEl = el as SinkCapable;
  if (typeof sinkEl.setSinkId !== 'function') return;
  sinkEl.setSinkId(deviceId).catch(() => {
    // Cihaz kaybolmuş ya da izin yok. Ses varsayılandan çıkmaya devam eder;
    // sessizce düşmek doğru davranış, alternatifi sesin hiç çıkmaması olurdu.
  });
}

/**
 * Uzak ses elemanı: akışı bağlar ve seçili çıkışı uygular.
 *
 * Tek bir `use:` içinde toplanır ki bir yeni katılımcı elemanı bunlardan
 * yalnızca birini almış olamasın.
 */
export function remoteAudio(el: HTMLMediaElement, stream: MediaStream | null) {
  setSrcObject(el, stream);
  applySelectedSink(el);
  return {
    update(next: MediaStream | null) {
      setSrcObject(el, next);
      applySelectedSink(el);
    },
  };
}
