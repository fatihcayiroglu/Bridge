import { afterEach, describe, expect, it, vi } from 'vitest';
import { collectVoiceDiagnostics } from '../js/core/voice-diagnostics.ts';

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}

function installMedia(
  devices: MediaDeviceInfo[],
  permission: PermissionState | 'unsupported' = 'granted',
): { enumerateDevices: ReturnType<typeof vi.fn>; getUserMedia: ReturnType<typeof vi.fn> } {
  const mediaDevices = {
    enumerateDevices: vi.fn(async () => devices),
    getUserMedia: vi.fn(),
  };
  vi.stubGlobal('navigator', {
    mediaDevices,
    ...(permission === 'unsupported' ? {} : {
      permissions: { query: vi.fn(async () => ({ state: permission })) },
    }),
  });
  return mediaDevices;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (HTMLMediaElement.prototype as HTMLMediaElement & { setSinkId?: unknown }).setSinkId;
});

describe('voice diagnostics — measured truth and sanitization', () => {
  it('kanonik RTC sahibinden gerçek cihaz, bağlantı, gecikme ve kayıp ölçümlerini toplar', async () => {
    installMedia([
      device('audioinput', 'mic-1', 'Studio Mic'),
      device('audiooutput', 'speaker-1', 'Desk Speakers'),
    ]);
    Object.defineProperty(HTMLMediaElement.prototype, 'setSinkId', {
      configurable: true, value: vi.fn(),
    });

    const reports = new Map<string, Record<string, unknown>>([
      ['pair', { type: 'candidate-pair', state: 'succeeded', nominated: true, currentRoundTripTime: 0.042 }],
      ['inbound', { type: 'inbound-rtp', packetsLost: 5, packetsReceived: 95 }],
    ]);
    const peer = {
      connectionState: 'connected',
      iceConnectionState: 'connected',
      getStats: vi.fn(async () => reports),
    } as unknown as RTCPeerConnection;
    const liveTrack = { readyState: 'live' } as MediaStreamTrack;
    const rtc = {
      selectedMicId: 'mic-1',
      selectedSpeakerId: 'speaker-1',
      currentChannelId: 'voice-1',
      socket: { connected: true },
      peers: new Map([['peer-1', peer]]),
      getLocalStream: () => ({ getAudioTracks: () => [liveTrack] }),
      isInVoice: () => true,
    };

    const result = await collectVoiceDiagnostics(rtc);

    expect(result).toMatchObject({
      rtcAvailable: true,
      mediaApiAvailable: true,
      microphonePermission: 'granted',
      microphoneDetected: true,
      microphoneTrackLive: true,
      outputDetected: true,
      inputDeviceLabel: 'Studio Mic',
      outputDeviceLabel: 'Desk Speakers',
      selectedInputUnavailable: false,
      selectedOutputUnavailable: false,
      inVoice: true,
      signalingConnected: true,
      peerCount: 1,
      connectionState: 'connected',
      iceState: 'connected',
      latencyMs: 42,
      packetLossPercent: 5,
    });
  });

  it('ölçülmeyen telemetriyi sıfır diye uydurmaz ve hassas RTC/ICE alanlarını dışarı taşımaz', async () => {
    installMedia([device('audioinput', 'default', '')], 'unsupported');
    const rawRtc = {
      selectedMicId: 'missing-mic',
      currentChannelId: null,
      socket: { connected: false, authToken: 'DO-NOT-LEAK' },
      iceServers: [{ credential: 'ICE-SECRET', urls: 'turn:10.0.0.4' }],
      peers: new Map([['peer', {
        connectionState: 'new',
        iceConnectionState: 'new',
        getStats: vi.fn(async () => new Map([
          ['candidate', { type: 'local-candidate', address: '192.168.1.20', candidate: 'RAW-CANDIDATE' }],
        ])),
      } as unknown as RTCPeerConnection]]),
    };

    const result = await collectVoiceDiagnostics(rawRtc);
    const serialized = JSON.stringify(result);

    expect(result.selectedInputUnavailable).toBe(true);
    expect(result.outputDetected).toBeNull();
    expect(result.latencyMs).toBeUndefined();
    expect(result.packetLossPercent).toBeUndefined();
    expect(result.microphonePermission).toBe('unsupported');
    expect(serialized).not.toMatch(/DO-NOT-LEAK|ICE-SECRET|10\.0\.0\.4|192\.168\.1\.20|RAW-CANDIDATE/i);
    expect(serialized).not.toMatch(/credential|candidate|address|token/i);
  });

  it('izin reddini gerçek cihaz yokluğundan ayrı ve açık biçimde raporlar', async () => {
    const media = installMedia([], 'denied');

    const result = await collectVoiceDiagnostics(null);

    expect(result.rtcAvailable).toBe(false);
    expect(result.microphonePermission).toBe('denied');
    expect(result.microphoneDetected).toBe(false);
    expect(media.getUserMedia).not.toHaveBeenCalled();
  });
});
