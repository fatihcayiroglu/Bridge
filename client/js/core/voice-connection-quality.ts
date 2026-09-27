// client/js/core/voice-connection-quality.ts
//
// FAZ K2 — GERCEK BAGLANTI KALITESI.
//
// `voice-diagnostics.ts` zaten `getStats()` uzerinden RTT ve paket kaybi
// olcuyordu. Eksik olanlar: JITTER, paket sayaclari ve bunlari kullanicinin
// anlayacagi tek bir kaliteye indirgeyen SINIFLANDIRMA.
//
// KURAL: her deger `RTCPeerConnection.getStats()` ciktisindan gelir.
// Olculemeyen alan `null` kalir ve kalite `'unknown'` olur — "iyi" varsayilmaz.

'use strict';

export type ConnectionQuality = 'excellent' | 'good' | 'poor' | 'unknown';

export interface VoiceConnectionQuality {
  quality: ConnectionQuality;
  latencyMs: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
  packetsSent: number | null;
  packetsReceived: number | null;
  /** Olcum alinabilen peer sayisi — 0 ise kalite bilinemez. */
  sampledPeers: number;
}

/**
 * ESIKLER — neden bu degerler?
 *
 * ITU-T G.114 tek yon agiz-kulak gecikmesi icin <150 ms'yi "kullanicilarin
 * cogu icin kabul edilebilir", 150-400 ms arasini "kabul edilebilir ama
 * fark edilir" sayar. RTT bunun kabaca iki katidir; bu yuzden esikler
 * gidis-donus olarak 150/300 ms alinmistir.
 *
 * Paket kaybi: konusma kodekleri ~%1'e kadar kaybi gizleyebilir; %5 uzerinde
 * bozulma acikca duyulur.
 *
 * Jitter: 30 ms uzeri jitter tipik jitter buffer'i asar ve kesintiye yol acar.
 *
 * Sinif, UC olcumun EN KOTUSU tarafindan belirlenir — tek bir kotu boyut
 * cagriyi bozmaya yeter, ortalama almak gercegi gizlerdi.
 */
export const QUALITY_THRESHOLDS = {
  latencyMs:         { excellent: 150, good: 300 },
  packetLossPercent: { excellent: 1,   good: 5 },
  jitterMs:          { excellent: 15,  good: 30 },
} as const;

function rank(value: number | null, limits: { excellent: number; good: number }): ConnectionQuality {
  if (value === null) return 'unknown';
  if (value <= limits.excellent) return 'excellent';
  if (value <= limits.good) return 'good';
  return 'poor';
}

/** En kotu bilinen sinif kazanir; hicbir olcum yoksa `'unknown'`. */
export function classifyQuality(input: {
  latencyMs: number | null;
  packetLossPercent: number | null;
  jitterMs: number | null;
}): ConnectionQuality {
  const ranks = [
    rank(input.latencyMs, QUALITY_THRESHOLDS.latencyMs),
    rank(input.packetLossPercent, QUALITY_THRESHOLDS.packetLossPercent),
    rank(input.jitterMs, QUALITY_THRESHOLDS.jitterMs),
  ].filter((r): r is Exclude<ConnectionQuality, 'unknown'> => r !== 'unknown');

  if (!ranks.length) return 'unknown';
  if (ranks.includes('poor')) return 'poor';
  if (ranks.includes('good')) return 'good';
  return 'excellent';
}

/** Olcum yokken hicbir sey iddia etmeyen taban durum. */
export function unknownConnectionQuality(): VoiceConnectionQuality {
  return {
    quality: 'unknown',
    latencyMs: null,
    packetLossPercent: null,
    jitterMs: null,
    packetsSent: null,
    packetsReceived: null,
    sampledPeers: 0,
  };
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * Ham `RTCStatsReport` satirlarini tek bir kalite ozetine indirger.
 *
 * Girdi, her peer icin bir satir dizisidir — boylece bu fonksiyon saf kalir
 * ve testlerde gercek tarayici olmadan dogrulanabilir.
 */
export function summarizeStatsRows(perPeerRows: Array<Array<Record<string, unknown>>>): VoiceConnectionQuality {
  const latencies: number[] = [];
  const jitters: number[] = [];
  let packetsLost = 0;
  let packetsReceived = 0;
  let packetsSent = 0;
  let sawInbound = false;
  let sawOutbound = false;
  let sampledPeers = 0;

  for (const rows of perPeerRows) {
    if (!Array.isArray(rows) || !rows.length) continue;
    sampledPeers++;

    for (const row of rows) {
      const type = row.type;

      if (type === 'candidate-pair' && row.state === 'succeeded'
        && (row.nominated === true || row.selected === true)) {
        const seconds = num(row.currentRoundTripTime);
        if (seconds !== null && seconds >= 0) latencies.push(seconds * 1000);
      }

      if (type === 'remote-inbound-rtp') {
        const seconds = num(row.roundTripTime);
        if (seconds !== null && seconds >= 0) latencies.push(seconds * 1000);
        // remote-inbound jitter, KARSI TARAFIN bizden aldigi akisi anlatir.
        const j = num(row.jitter);
        if (j !== null && j >= 0) jitters.push(j * 1000);
      }

      if (type === 'inbound-rtp' && row.kind !== 'video') {
        sawInbound = true;
        const lost = num(row.packetsLost);
        const received = num(row.packetsReceived);
        const j = num(row.jitter);
        if (lost !== null && lost > 0) packetsLost += lost;
        if (received !== null && received > 0) packetsReceived += received;
        if (j !== null && j >= 0) jitters.push(j * 1000);   // saniye → ms
      }

      if (type === 'outbound-rtp' && row.kind !== 'video') {
        const sent = num(row.packetsSent);
        if (sent !== null && sent >= 0) { packetsSent += sent; sawOutbound = true; }
      }
    }
  }

  const latencyMs = latencies.length
    ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length)
    : null;

  const jitterMs = jitters.length
    ? Math.round((jitters.reduce((a, b) => a + b, 0) / jitters.length) * 10) / 10
    : null;

  const packetTotal = packetsLost + packetsReceived;
  const packetLossPercent = packetTotal > 0
    ? Math.round((packetsLost / packetTotal) * 1000) / 10
    : null;

  return {
    quality: classifyQuality({ latencyMs, packetLossPercent, jitterMs }),
    latencyMs,
    packetLossPercent,
    jitterMs,
    packetsSent: sawOutbound ? packetsSent : null,
    packetsReceived: sawInbound ? packetsReceived : null,
    sampledPeers,
  };
}

/** Canli peer baglantilarindan olcum toplar. Hata veren peer atlanir. */
export async function collectConnectionQuality(
  peers: Iterable<RTCPeerConnection>,
): Promise<VoiceConnectionQuality> {
  const list = [...peers];
  if (!list.length) return unknownConnectionQuality();

  const perPeerRows = await Promise.all(list.map(async peer => {
    try {
      const report = await peer.getStats();
      const rows: Array<Record<string, unknown>> = [];
      report.forEach(row => rows.push(row as unknown as Record<string, unknown>));
      return rows;
    } catch {
      // Telemetri opsiyoneldir; yoklugu uydurma sifira cevrilmez.
      return [];
    }
  }));

  return summarizeStatsRows(perPeerRows);
}
