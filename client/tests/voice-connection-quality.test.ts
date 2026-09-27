// client/tests/voice-connection-quality.test.ts
//
// FAZ K2 — baglanti kalitesi yalnizca GERCEK getStats satirlarindan turetilir.
// Olcum yoksa 'unknown'; asla iyimser bir varsayilan degil.

import { describe, it, expect } from 'vitest';
import {
  summarizeStatsRows,
  classifyQuality,
  collectConnectionQuality,
  unknownConnectionQuality,
  QUALITY_THRESHOLDS,
} from '../js/core/voice-connection-quality.ts';

const pair = (rttSeconds: number) => ({
  type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: rttSeconds,
});
const inbound = (o: { lost?: number; received?: number; jitter?: number }) => ({
  type: 'inbound-rtp', kind: 'audio',
  packetsLost: o.lost, packetsReceived: o.received, jitter: o.jitter,
});
const outbound = (sent: number) => ({ type: 'outbound-rtp', kind: 'audio', packetsSent: sent });

describe('Faz K2 — baglanti kalitesi olcumu', () => {
  it('RTT, jitter, paket kaybi ve sayaclari gercek satirlardan cikarir', () => {
    const q = summarizeStatsRows([[
      pair(0.040),                                     // 40 ms
      inbound({ lost: 2, received: 998, jitter: 0.008 }), // %0.2 kayip, 8 ms jitter
      outbound(1200),
    ]]);

    expect(q.latencyMs).toBe(40);
    expect(q.jitterMs).toBe(8);
    expect(q.packetLossPercent).toBe(0.2);
    expect(q.packetsReceived).toBe(998);
    expect(q.packetsSent).toBe(1200);
    expect(q.sampledPeers).toBe(1);
    expect(q.quality).toBe('excellent');
  });

  it('hicbir olcum yoksa unknown doner — iyimser varsayilan YOK', () => {
    const q = summarizeStatsRows([]);
    expect(q).toEqual(unknownConnectionQuality());
    expect(q.quality).toBe('unknown');
    expect(q.latencyMs).toBeNull();
    expect(q.jitterMs).toBeNull();
    expect(q.packetLossPercent).toBeNull();
  });

  it('bos satir dizisi peer olarak SAYILMAZ', () => {
    const q = summarizeStatsRows([[], []]);
    expect(q.sampledPeers).toBe(0);
    expect(q.quality).toBe('unknown');
  });

  it('paket akisi yoksa sayaclar null kalir (0 ile karistirilmaz)', () => {
    const q = summarizeStatsRows([[pair(0.05)]]);
    expect(q.packetsSent).toBeNull();
    expect(q.packetsReceived).toBeNull();
    expect(q.latencyMs).toBe(50);
  });

  it('video satirlarini ses olcumune karistirmaz', () => {
    const q = summarizeStatsRows([[
      { type: 'inbound-rtp', kind: 'video', packetsLost: 500, packetsReceived: 10, jitter: 0.4 },
      inbound({ lost: 0, received: 1000, jitter: 0.005 }),
    ]]);
    expect(q.packetLossPercent).toBe(0);
    expect(q.jitterMs).toBe(5);
  });

  it('birden fazla peer ortalanir ve peer sayisi bildirilir', () => {
    const q = summarizeStatsRows([[pair(0.020)], [pair(0.060)]]);
    expect(q.latencyMs).toBe(40);
    expect(q.sampledPeers).toBe(2);
  });

  it('EN KOTU boyut sinifi belirler — ortalama gercegi gizlemez', () => {
    // Gecikme mukemmel, ama kayip berbat.
    const q = summarizeStatsRows([[pair(0.010), inbound({ lost: 100, received: 900 })]]);
    expect(q.latencyMs).toBe(10);
    expect(q.packetLossPercent).toBe(10);
    expect(q.quality).toBe('poor');
  });

  it('siniflandirma esikleri belgelenen degerlerle tutarlidir', () => {
    const { latencyMs, packetLossPercent, jitterMs } = QUALITY_THRESHOLDS;

    expect(classifyQuality({ latencyMs: latencyMs.excellent, packetLossPercent: null, jitterMs: null })).toBe('excellent');
    expect(classifyQuality({ latencyMs: latencyMs.excellent + 1, packetLossPercent: null, jitterMs: null })).toBe('good');
    expect(classifyQuality({ latencyMs: latencyMs.good + 1, packetLossPercent: null, jitterMs: null })).toBe('poor');

    expect(classifyQuality({ latencyMs: null, packetLossPercent: packetLossPercent.good, jitterMs: null })).toBe('good');
    expect(classifyQuality({ latencyMs: null, packetLossPercent: null, jitterMs: jitterMs.good + 1 })).toBe('poor');
  });

  it('tum olcumler bilinmiyorsa sinif unknown kalir', () => {
    expect(classifyQuality({ latencyMs: null, packetLossPercent: null, jitterMs: null })).toBe('unknown');
  });

  it('getStats firlatan peer digerlerini bozmaz', async () => {
    const good = { getStats: async () => ({ forEach: (fn: (r: unknown) => void) => [pair(0.030)].forEach(fn) }) };
    const bad  = { getStats: async () => { throw new Error('nope'); } };

    const q = await collectConnectionQuality([good, bad] as unknown as RTCPeerConnection[]);
    expect(q.latencyMs).toBe(30);
    expect(q.sampledPeers).toBe(1);   // hata veren peer olcume katilmaz
  });

  it('peer yoksa unknown doner', async () => {
    const q = await collectConnectionQuality([]);
    expect(q.quality).toBe('unknown');
  });

  it('candidate secimi ve gecersiz sayilari fail-closed suzer', () => {
    const q = summarizeStatsRows([[
      { type: 'candidate-pair', state: 'failed', nominated: true, currentRoundTripTime: 0.01 },
      { type: 'candidate-pair', state: 'succeeded', nominated: false, selected: false, currentRoundTripTime: 0.02 },
      { type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: 'not-a-number' },
      { type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: -1 },
      { type: 'inbound-rtp', kind: 'audio', packetsLost: 'bad', packetsReceived: 0, jitter: -0.1 },
      { type: 'outbound-rtp', kind: 'audio', packetsSent: -1 },
    ]]);

    expect(q.latencyMs).toBeNull();
    expect(q.jitterMs).toBeNull();
    expect(q.packetLossPercent).toBeNull();
    expect(q.packetsReceived).toBe(0);
    expect(q.packetsSent).toBeNull();
    expect(q.quality).toBe('unknown');
  });

  it('selected candidate ve remote-inbound RTT/jitter satirlarini olcume katar', () => {
    const q = summarizeStatsRows([[
      { type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: 0.04 },
      { type: 'remote-inbound-rtp', roundTripTime: 0.06, jitter: 0.01 },
      { type: 'remote-inbound-rtp', roundTripTime: -1, jitter: -1 },
      { type: 'remote-inbound-rtp', roundTripTime: 'bad', jitter: 'bad' },
      { type: 'outbound-rtp', kind: 'audio', packetsSent: 0 },
    ]]);

    expect(q.latencyMs).toBe(50);
    expect(q.jitterMs).toBe(10);
    expect(q.packetsSent).toBe(0);
    expect(q.quality).toBe('excellent');
  });
});
