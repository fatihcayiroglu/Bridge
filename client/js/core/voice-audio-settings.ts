// client/js/core/voice-audio-settings.ts
//
// FAZ K2 — MIKROFONUN GERCEKTEN UYGULANAN AYARLARI.
//
// SORUN: `webrtc.ts` getUserMedia'ya `echoCancellation`, `noiseSuppression`,
// `autoGainControl` ve `sampleRate: 48000` ISTIYOR. Ancak bunlar yalnizca
// ISTEKTIR — tarayici/isletim sistemi/surucu bir kisitlamayi sessizce
// dusurebilir. Kod tabaninda `getSettings()` HICBIR YERDE cagrilmiyordu,
// dolayisiyla "gurultu bastirma acik" iddiasini dogrulayan tek bir olcum
// bile yoktu.
//
// Bu modul YALNIZCA tarayicinin BILDIRDIGI degerleri okur:
//   MediaStreamTrack.getSettings()
//
// KURAL: deger yoksa UYDURULMAZ. Sayisal alanlar `null`, ucucu mantiksal
// alanlar `'unknown'` olur. Hicbir varsayilan "true" kabul edilmez —
// istenen kisitlamanin uygulandigini varsaymak tam da kacinilan hatadir.
//
// Bu modul mevcut getUserMedia kisitlamalarini DEGISTIRMEZ ve WebRTC
// akisina dokunmaz; yalnizca canli track'i okur.

'use strict';

/** Uc durumlu mantiksal: tarayici bildirmediyse `'unknown'`. */
export type TriState = boolean | 'unknown';

export interface AppliedMicrophone {
  /** Cihaz kimligi — izin verilmemisse tarayici bos dondurur. */
  deviceId: string | null;
  /** Cihaz etiketi yalnizca mikrofon izni verildiginde doludur. */
  label: string | null;
}

export interface AppliedAudio {
  sampleRate: number | null;
  sampleSize: number | null;
  channelCount: number | null;
  echoCancellation: TriState;
  noiseSuppression: TriState;
  autoGainControl: TriState;
}

export interface AppliedAudioSettings {
  /** `getSettings()` bu ortamda kullanilabiliyor mu? */
  supported: boolean;
  /** Okuma aninda canli bir ses track'i var miydi? */
  trackLive: boolean;
  microphone: AppliedMicrophone;
  audio: AppliedAudio;
}

/** Deger yokken hicbir sey iddia etmeyen taban durum. */
export function unknownAudioSettings(supported = false): AppliedAudioSettings {
  return {
    supported,
    trackLive: false,
    microphone: { deviceId: null, label: null },
    audio: {
      sampleRate: null,
      sampleSize: null,
      channelCount: null,
      echoCancellation: 'unknown',
      noiseSuppression: 'unknown',
      autoGainControl: 'unknown',
    },
  };
}

/** Sonlu bir sayi degilse `null` — 0 gecerli bir olcum olabilir, korunur. */
function numberOrNull(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Yalnizca gercek mantiksal degerler kabul edilir; digerleri `'unknown'`. */
function triState(value: unknown): TriState {
  return typeof value === 'boolean' ? value : 'unknown';
}

/** Bos/whitespace etiket `null` sayilir (izin verilmemis demektir). */
function textOrNull(value: unknown): string | null {
  const text = typeof value === 'string' ? value.trim() : '';
  return text || null;
}

/**
 * Canli mikrofon track'inden tarayicinin UYGULADIGI ayarlari okur.
 *
 * @param stream Yerel ses akisi (`rtc.localStream`). Yoksa "bilinmiyor" doner.
 */
export function readAppliedAudioSettings(stream: unknown): AppliedAudioSettings {
  const media = stream as MediaStream | null | undefined;
  const tracks = typeof media?.getAudioTracks === 'function' ? media.getAudioTracks() : [];
  const track = tracks[0];

  if (!track) return unknownAudioSettings(false);

  // `getSettings` eski/kisitli ortamlarda bulunmayabilir. Yoklugu, degerlerin
  // yanlis olmasindan daha durust bir sonuctur.
  if (typeof track.getSettings !== 'function') {
    const base = unknownAudioSettings(false);
    base.trackLive = track.readyState === 'live';
    base.microphone.label = textOrNull(track.label);
    return base;
  }

  let settings: MediaTrackSettings;
  try {
    settings = track.getSettings();
  } catch {
    const base = unknownAudioSettings(false);
    base.trackLive = track.readyState === 'live';
    return base;
  }

  const raw = settings as MediaTrackSettings & Record<string, unknown>;

  return {
    supported: true,
    trackLive: track.readyState === 'live',
    microphone: {
      deviceId: textOrNull(raw.deviceId),
      // Etiket once track'ten, yoksa ayarlardan; ikisi de bossa izin yok demektir.
      label: textOrNull(track.label) ?? textOrNull(raw.label),
    },
    audio: {
      sampleRate: numberOrNull(raw.sampleRate),
      sampleSize: numberOrNull(raw.sampleSize),
      channelCount: numberOrNull(raw.channelCount),
      echoCancellation: triState(raw.echoCancellation),
      noiseSuppression: triState(raw.noiseSuppression),
      autoGainControl: triState(raw.autoGainControl),
    },
  };
}

/**
 * ISTENEN ile UYGULANAN arasindaki farki bildirir.
 *
 * Yalnizca tarayicinin ACIKCA `false` dedigi alanlar "dusurulmus" sayilir;
 * `'unknown'` bir sapma DEGILDIR — bilgi yoklugudur ve oyle raporlanir.
 */
export function downgradedAudioFeatures(applied: AppliedAudioSettings): string[] {
  const out: string[] = [];
  if (applied.audio.echoCancellation === false) out.push('echoCancellation');
  if (applied.audio.noiseSuppression === false) out.push('noiseSuppression');
  if (applied.audio.autoGainControl === false) out.push('autoGainControl');
  return out;
}
