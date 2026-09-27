// client/tests/voice-diagnostics-stat-sources.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// voice-diagnostics.ts — ÖLÇÜM KAYNAKLARI VE "BİLİNMİYOR" DÜRÜSTLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════
// Tanılama panelinin tek işi DOĞRU söylemektir. Uydurulmuş bir sıfır ("kayıp
// %0", "gecikme 0 ms") kullanıcıyı ve destek ekibini yanlış yönlendirir: gerçek
// bir sorun "her şey yolunda" gibi görünür. Bu yüzden ölçülemeyen her alan
// AÇIKÇA yok sayılır — sıfıra çevrilmez.
//
// Ölçülen dallar:
//   • RTT iki farklı istatistik satırından okunabilir (`candidate-pair` ve
//     `remote-inbound-rtp`); ikisi de desteklenmelidir çünkü tarayıcılar
//     farklı alt kümeler yayınlar.
//   • Aday çifti yalnızca `succeeded` VE (`nominated` ya da `selected`) ise
//     sayılır — aday listesindeki başarısız çiftler ortalamayı bozmamalıdır.
//   • Negatif/NaN değerler yok sayılır.
//   • Cihaz etiketleri izin verilmeden boş gelir; boş etiket yedek ada düşer.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectVoiceDiagnostics } from '../js/core/voice-diagnostics.ts';

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}

function installMedia(devices: MediaDeviceInfo[], permission: PermissionState | 'unsupported' | 'throws' = 'granted'): void {
  vi.stubGlobal('navigator', {
    mediaDevices: { enumerateDevices: vi.fn(async () => devices), getUserMedia: vi.fn() },
    ...(permission === 'unsupported' ? {} : {
      permissions: {
        query: permission === 'throws'
          ? vi.fn(async () => { throw new Error('policy'); })
          : vi.fn(async () => ({ state: permission })),
      },
    }),
  });
}

function peerWith(rows: Array<Record<string, unknown>>): RTCPeerConnection {
  const reports = new Map(rows.map((row, index) => [`row-${index}`, row]));
  return {
    connectionState: 'connected',
    iceConnectionState: 'connected',
    getStats: vi.fn(async () => reports),
  } as unknown as RTCPeerConnection;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('round-trip time sources', () => {
  it('reads latency from a nominated candidate pair', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peerWith([
        { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.05 },
      ])]]),
    });
    expect(snapshot.latencyMs).toBe(50);
  });

  it('reads latency from a selected candidate pair when nomination is not reported', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peerWith([
        { type: 'candidate-pair', state: 'succeeded', selected: true, currentRoundTripTime: 0.02 },
      ])]]),
    });
    expect(snapshot.latencyMs).toBe(20);
  });

  it('reads latency from a remote inbound RTP row when no candidate pair reports it', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peerWith([{ type: 'remote-inbound-rtp', roundTripTime: 0.12 }])]]),
    });
    expect(snapshot.latencyMs).toBe(120);
  });

  it('averages every reported source rather than trusting the first one', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peerWith([
        { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.1 },
        { type: 'remote-inbound-rtp', roundTripTime: 0.3 },
      ])]]),
    });
    expect(snapshot.latencyMs).toBe(200);
  });

  it('ignores candidate pairs that never succeeded or were never chosen', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peerWith([
        { type: 'candidate-pair', state: 'failed', nominated: true, currentRoundTripTime: 9 },
        { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 9 },
      ])]]),
    });
    // Ölçülemeyen gecikme SIFIR değildir; hiç yoktur.
    expect(snapshot.latencyMs).toBeUndefined();
  });

  it('ignores a negative or non-numeric round-trip time', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peerWith([
        { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: -1 },
        { type: 'remote-inbound-rtp', roundTripTime: 'soon' },
      ])]]),
    });
    expect(snapshot.latencyMs).toBeUndefined();
  });

  it('renders absent packet telemetry as absent instead of a perfect score', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peerWith([{ type: 'inbound-rtp', packetsLost: 0, packetsReceived: 0 }])]]),
    });
    expect(snapshot.packetLossPercent).toBeUndefined();
  });

  it('survives a peer whose getStats rejects', async () => {
    installMedia([]);
    const broken = { connectionState: 'connected', iceConnectionState: 'connected',
      getStats: vi.fn(async () => { throw new Error('stats unavailable'); }) } as unknown as RTCPeerConnection;
    const snapshot = await collectVoiceDiagnostics({ peers: new Map([['p', broken]]) });
    expect(snapshot.latencyMs).toBeUndefined();
    expect(snapshot.packetLossPercent).toBeUndefined();
  });

  it('deduplicates a peer that appears in both the SFU and the peer-to-peer map', async () => {
    installMedia([]);
    const peer = peerWith([
      { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.04 },
      { type: 'inbound-rtp', packetsLost: 1, packetsReceived: 99 },
    ]);
    const snapshot = await collectVoiceDiagnostics({
      peers: new Map([['p', peer]]),
      _p2pPeers: new Map([['same', peer]]),
    });
    // Aynı bağlantı iki kez sayılırsa kayıp oranı ve gecikme ortalaması bozulur.
    expect(snapshot.latencyMs).toBe(40);
    expect(snapshot.packetLossPercent).toBe(1);
  });

  it('accepts an RTC owner that exposes only peer-to-peer connections', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics({
      _p2pPeers: new Map([['p', peerWith([{ type: 'remote-inbound-rtp', roundTripTime: 0.01 }])]]),
    });
    expect(snapshot.latencyMs).toBe(10);
  });
});

describe('device and permission reporting', () => {
  it('falls back to a generic device name when the browser withholds labels', async () => {
    installMedia([device('audioinput', 'default', ''), device('audiooutput', 'default', '   ')]);
    const snapshot = await collectVoiceDiagnostics(null);
    expect(snapshot.inputDeviceLabel).toBeTruthy();
    expect(snapshot.outputDeviceLabel).toBeTruthy();
    expect(snapshot.inputDeviceLabel).not.toBe('');
  });

  it('reports an unrecognised permission state as unknown and a query failure as unsupported', async () => {
    vi.stubGlobal('navigator', {
      mediaDevices: { enumerateDevices: vi.fn(async () => []), getUserMedia: vi.fn() },
      permissions: { query: vi.fn(async () => ({ state: 'nonsense' })) },
    });
    expect((await collectVoiceDiagnostics(null)).microphonePermission).toBe('unknown');

    installMedia([], 'throws');
    expect((await collectVoiceDiagnostics(null)).microphonePermission).toBe('unsupported');

    installMedia([], 'unsupported');
    expect((await collectVoiceDiagnostics(null)).microphonePermission).toBe('unsupported');
  });

  it('reports a non-object RTC owner as no owner at all', async () => {
    installMedia([]);
    const snapshot = await collectVoiceDiagnostics('not-an-object');
    expect(snapshot.latencyMs).toBeUndefined();
  });
});
