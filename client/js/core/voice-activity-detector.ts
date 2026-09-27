// client/js/core/voice-activity-detector.ts
//
// FAZ K2 — GERCEK KONUSMA ALGILAMA.
//
// BULUNAN KUSUR: `webrtc.ts` ve `webrtc-sfu.ts` registry'den
// `_bridgeStartLocalVAD` cagiriyor, fakat bu adi HICBIR MODUL KAYDETMIYORDU.
// Sunucu tarafi ise hazir ve yetkilendirilmis:
//   voice.ts → socket.on('voice:activity') yalnizca `socket.currentVoiceChannel`
//   odasina yayin yapar (oda payload'dan ALINMAZ).
// Yani boru hattinin sunucu yarisi vardi, istemci yarisi hic baglanmamisti;
// hicbir istemci `voice:activity` YAYMIYORDU. Bu modul o boslugu doldurur.
//
// KURAL: zamanlayici taklidi YOK. Konusma durumu, canli mikrofon akisindan
// AudioContext analiz dugumuyle olculen GERCEK sinyal genligidir.

'use strict';

import { createLogger } from './logger.js';

const log = createLogger('VoiceVAD');

/**
 * ESIKLER — neden bu degerler?
 *
 * RMS, 0..1 araliginda normalize genliktir. Sessiz bir odada tipik mikrofon
 * taban gurultusu ~0.005 civarindadir; normal konusma 0.05+ uretir.
 *
 * Histerezis (acilis > kapanis) kullanilir: tek bir esik, genlik esigin
 * etrafinda salinirken gostergeyi titretirdi.
 *
 * `HANG_MS`, konusma icindeki dogal duraklamalarda gostergenin sonmesini
 * engeller — kelimeler arasi sessizlik konusmanin bittigi anlamina gelmez.
 */
/**
 * Ayarlanabilir VAD parametreleri.
 *
 * `VAD_TUNING` `as const` oldugu icin ozellikleri LITERAL tiptedir; imzalarda
 * dogrudan kullanmak, turetilmis (kullanici esikli) bir ayarin atanmasini
 * imkansiz kilardi.
 */
export interface VadTuning {
  openRms: number;
  closeRms: number;
  hangMs: number;
  intervalMs: number;
}

export const VAD_TUNING = {
  /** Uzerine cikildiginda konusma BASLAR. */
  openRms: 0.020,
  /** Altina inildiginde konusma bitmeye aday olur. */
  closeRms: 0.012,
  /** Kapanis icin gereken kesintisiz sessizlik suresi (ms). */
  hangMs: 320,
  /** Analiz araligi (ms) — 20 Hz, insan algisi icin fazlasiyla yeterli. */
  intervalMs: 50,
} as const;

export interface VadHandle {
  /** Olcumu durdurur ve tum ses dugumlerini serbest birakir. */
  stop(): void;
  /** Su anki olculen durum — test ve teshis icin. */
  isSpeaking(): boolean;
}

type AudioContextCtor = typeof AudioContext;

function audioContextCtor(): AudioContextCtor | null {
  const w = globalThis as unknown as {
    AudioContext?: AudioContextCtor;
    webkitAudioContext?: AudioContextCtor;
  };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

/** Zaman alani ornekleminden RMS (kok ortalama kare) genlik. */
export function rmsFromTimeDomain(samples: Float32Array): number {
  if (!samples.length) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i]! * samples[i]!;
  return Math.sqrt(sum / samples.length);
}

/**
 * Histerezis + hang-time durum makinesi.
 *
 * Saf ve senkron tutuldu: gercek ses olmadan, dogrudan RMS dizileriyle
 * test edilebilir.
 */
export function createSpeakingGate(tuning: VadTuning = VAD_TUNING) {
  let speaking = false;
  let quietSince: number | null = null;

  return {
    /** @returns durum DEGISTIYSE yeni deger, degismediyse `null`. */
    push(rms: number, now: number): boolean | null {
      if (!speaking) {
        if (rms >= tuning.openRms) {
          speaking = true;
          quietSince = null;
          return true;
        }
        return null;
      }

      if (rms > tuning.closeRms) {
        quietSince = null;
        return null;
      }

      if (quietSince === null) { quietSince = now; return null; }
      if (now - quietSince >= tuning.hangMs) {
        speaking = false;
        quietSince = null;
        return false;
      }
      return null;
    },
    get speaking() { return speaking; },
  };
}

/**
 * Yerel mikrofon akisini dinler ve konusma durumu DEGISTIKCE `onChange`
 * cagirir. Durum degismedikce hicbir sey yayilmaz — sunucuya gereksiz
 * trafik gonderilmez.
 *
 * Tarayici AudioContext desteklemiyorsa `null` doner: ozellik sessizce
 * devre disi kalir, sahte bir "konusuyor" durumu URETILMEZ.
 */
export function startVoiceActivityDetection(
  stream: MediaStream,
  onChange: (speaking: boolean) => void,
  tuning: VadTuning = VAD_TUNING,
  /**
   * Her olcumde ham RMS. Hassasiyet gostergesi bunu kullanir; IKINCI bir
   * AudioContext acmak yerine ZATEN calisan olcum paylasilir — iki ayri
   * analiz hatti hem CPU yer hem de birbirinden sapardi.
   */
  onLevel?: (rms: number) => void,
): VadHandle | null {
  const Ctor = audioContextCtor();
  if (!Ctor) {
    log.warn('AudioContext yok — konusma algilama devre disi (sahte durum uretilmez)');
    return null;
  }
  if (typeof stream?.getAudioTracks !== 'function') {
    return null;
  }
  try {
    const tracks = stream.getAudioTracks();
    if (!Array.isArray(tracks) || tracks.length === 0) return null;
  } catch {
    return null;
  }

  let ctx: AudioContext;
  try {
    ctx = new Ctor();
  } catch {
    return null;
  }

  let source: MediaStreamAudioSourceNode;
  let analyser: AnalyserNode;
  try {
    source = ctx.createMediaStreamSource(stream);
    analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    analyser.smoothingTimeConstant = 0.2;
    source.connect(analyser);
  } catch {
    try { void ctx.close().catch(() => { /* kurulum tamamlanamadi */ }); } catch { /* close senkron hata verebilir */ }
    return null;
  }
  // NOT: analyser cikisa BAGLANMAZ — kendi sesimizi hoparlore vermeyiz.

  const buffer = new Float32Array(analyser.fftSize);
  const gate = createSpeakingGate(tuning);
  let stopped = false;

  const timer = setInterval(() => {
    if (stopped) return;
    try {
      analyser.getFloatTimeDomainData(buffer);
    } catch {
      return;
    }
    const rms = rmsFromTimeDomain(buffer);
    try { onLevel?.(rms); } catch { /* seviye tuketicisi VAD durumunu bozmamali */ }
    const changed = gate.push(rms, Date.now());
    if (changed !== null) {
      try { onChange(changed); } catch { /* tuketici hatasi analiz dongusunu durdurmamalidir */ }
    }
  }, tuning.intervalMs);

  return {
    stop(): void {
      if (stopped) return;
      stopped = true;
      clearInterval(timer);
      // Konusuyor durumunda birakmamak icin son bir kapanis bildirilir.
      if (gate.speaking) {
        try { onChange(false); } catch { /* yine de ses dugumlerini serbest birak */ }
      }
      try { source.disconnect(); } catch { /* zaten kopuk */ }
      try { analyser.disconnect(); } catch { /* zaten kopuk */ }
      try { void ctx.close().catch(() => { /* kapanmis olabilir */ }); } catch { /* close senkron hata verebilir */ }
    },
    isSpeaking: () => gate.speaking,
  };
}
