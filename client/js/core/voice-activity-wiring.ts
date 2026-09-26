// client/js/core/voice-activity-wiring.ts
//
// FAZ K2 — KONUSMA ALGILAMA BORU HATTININ EKSIK ISTEMCI YARISI.
//
// MEVCUT DURUM (olculdu):
//   • webrtc.ts:378  → registry'den `_bridgeStartLocalVAD` cagirir (katilirken)
//   • webrtc.ts:406  → registry'den `_bridgeStopLocalVAD` cagirir (ayrilirken)
//   • webrtc.ts:377  → registry'den `VoiceActivityUI.init(socket)` cagirir
//   • voice.ts:218   → sunucu `voice:activity`i YETKILENDIRILMIS sekilde yayar
//                      (oda payload'dan degil `socket.currentVoiceChannel`den)
//   • ANCAK bu adlarin HICBIRI kayitli degildi ve hicbir istemci
//     `voice:activity` YAYMIYORDU.
//
// Yani sunucu tarafi hazir ve guvenliydi; istemci tarafi hic baglanmamisti.
// Bu modul yalnizca o baglantiyi kurar — yeni protokol icat etmez, mevcut
// olay sozlesmesini kullanir.
//
// KURAL: konusma durumu GERCEK ses genliginden gelir (bkz.
// voice-activity-detector.ts). Sahte kullanici, sahte zamanlayici veya
// varsayilan "konusuyor" durumu URETILMEZ.

'use strict';

import { BridgeRegistry } from './bridge-registry.js';
import { createLogger } from './logger.js';
import { startVoiceActivityDetection, type VadHandle } from './voice-activity-detector.js';
import { loadSensitivity, tuningFor } from './voice/input-sensitivity.js';

const log = createLogger('VoiceActivityWiring');

interface EmitOnly { emit(event: string, payload: unknown): void }

/**
 * Soket, KANONIK RTC sahibinden okunur — mimari kural: BridgeRegistry.get('rtc').
 *
 * Registry yalnizca fonksiyon tipi kabul ettigi icin webrtc.ts'in bekledigi
 * `VoiceActivityUI` NESNESI kaydedilmez; ayrica ikinci bir soket kopyasi
 * tutmak tek-sahip kuralina aykiri olurdu. Soket her yayinda tazeden
 * cozulur, boylece yeniden baglanma sonrasi eskimis referans kalmaz.
 */
function canonicalSocket(): EmitOnly | null {
  const rtc = BridgeRegistry.get<unknown>('rtc') as { socket?: EmitOnly } | null;
  const socket = rtc?.socket;
  return socket && typeof socket.emit === 'function' ? socket : null;
}
let _handle: VadHandle | null = null;
let _channelId: string | null = null;

/** Yerel konusma durumunu sunucuya bildirir. Oda sunucuda dogrulanir. */
function publish(speaking: boolean): void {
  const socket = canonicalSocket();
  if (!socket || !_channelId) return;
  try {
    socket.emit('voice:activity', { channelId: _channelId, speaking });
  } catch (err) {
    log.warn('voice:activity yayilamadi', err);
  }
}

function stopDetection(): void {
  if (!_handle) { _channelId = null; return; }
  const handle = _handle;
  _handle = null;                 // once temizle: stop() son bir `false` yayar
  try { handle.stop(); } catch { /* zaten kapali */ }
  _channelId = null;
  _lastStream = null;
  _lastLevel = 0;
}

/**
 * Kayitlari kurar. webrtc.ts bu adlari zaten ariyor; burada yalnizca
 * karsiligi saglanir.
 */
let _lastStream: MediaStream | null = null;
let _lastLevel = 0;

/** Olculen ham RMS — gosterge icin; DOM'a burada dokunulmaz. */
function publishLevel(rms: number): void {
  _lastLevel = rms;
  document.dispatchEvent(new CustomEvent('bridge:voice-input-level', { detail: { rms } }));
}

export function registerVoiceActivityWiring(): void {
  // webrtc.ts:378 — sesli kanala katilinca.
  BridgeRegistry.register('_bridgeStartLocalVAD', (stream: MediaStream, channelId: string): void => {
    stopDetection();
    _channelId = channelId;
    // Hassasiyet KATILIRKEN okunur; kullanici ayari degistirdiginde
    // `voice:sensitivityChanged` ile yeniden baslatilir (asagida). Ikinci bir
    // olcum hatti KURULMAZ.
    _handle = startVoiceActivityDetection(
      stream, publish, tuningFor(loadSensitivity()), publishLevel,
    );
    _lastStream = stream;
    if (!_handle) {
      // AudioContext yoksa ozellik sessizce kapalidir — yanlis durum yayilmaz.
      log.info('Konusma algilama bu ortamda kullanilamiyor');
      _channelId = null;
    }
  });

  // webrtc.ts:406 — sesli kanaldan ayrilinca / temizlik.
  BridgeRegistry.register('_bridgeStopLocalVAD', (): void => { stopDetection(); });

  // Ayarlar ekrani hassasiyeti degistirdiginde olcum YENIDEN BASLATILIR.
  // Esik calisma aninda degistirilemedigi icin (gate kapanista tutulur)
  // dogru davranis, ayni akisla yeni ayarla yeniden kurmaktir.
  BridgeRegistry.register('voice:sensitivityChanged', (): void => {
    if (!_handle || !_lastStream || !_channelId) return;
    const stream = _lastStream;
    const channelId = _channelId;
    stopDetection();
    _channelId = channelId;
    _handle = startVoiceActivityDetection(
      stream, publish, tuningFor(loadSensitivity()), publishLevel,
    );
    _lastStream = stream;
  });

  // Canli giris seviyesi — hassasiyet gostergesi bunu dinler. Yalnizca TEK
  // bir sayi (RMS) tasinir; ses ornegi ne saklanir ne gonderilir.
  BridgeRegistry.register('voice:getInputLevel', (): number => _lastLevel);
}

/** Test/teshis icin canli durum. */
export function localSpeakingState(): boolean {
  return _handle?.isSpeaking() ?? false;
}

/** Testlerin modul durumunu izole edebilmesi icin. */
export function _resetVoiceActivityWiring(): void {
  stopDetection();
}
