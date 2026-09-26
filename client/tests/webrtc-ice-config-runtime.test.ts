import { afterEach, describe, expect, it, vi } from 'vitest';

const socket = () => ({
  connected: true,
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
});

class ConfigPeerConnection {
  static configs: RTCConfiguration[] = [];
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor(config: RTCConfiguration) { ConfigPeerConnection.configs.push(config); }
  getTransceivers() { return []; }
  getSenders() { return []; }
  addTrack() { return {} as RTCRtpSender; }
  close() { this.connectionState = 'closed'; }
}

async function loadWith(fetchIce: ReturnType<typeof vi.fn>) {
  vi.resetModules();
  ConfigPeerConnection.configs = [];
  vi.stubGlobal('RTCPeerConnection', ConfigPeerConnection);
  vi.doMock('../js/core/api-fetch.ts', () => ({ apiFetch: fetchIce }));
  const mod = await import('../js/webrtc.ts');
  await Promise.resolve();
  await Promise.resolve();
  const rtc = new mod.BridgeRTC(socket() as never);
  (rtc as unknown as { _createPeerConnection(id: string, peer: { socketId: string }): RTCPeerConnection })
    ._createPeerConnection('peer', { socketId: 'peer' });
  return ConfigPeerConnection.configs[0];
}

afterEach(() => {
  vi.doUnmock('../js/core/api-fetch.ts');
  vi.unstubAllGlobals();
});

describe('WebRTC ICE configuration bootstrap', () => {
  it('uses a valid server configuration and enforces relay policy', async () => {
    const config = await loadWith(vi.fn(async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: 'turns:turn.example' }], iceTransportPolicy: 'relay' }),
    })));
    expect(config).toEqual({ iceServers: [{ urls: 'turns:turn.example' }], iceTransportPolicy: 'relay' });
  });

  it('defaults a valid configuration without a transport policy to all', async () => {
    const config = await loadWith(vi.fn(async () => ({
      ok: true,
      json: async () => ({ iceServers: [{ urls: 'stun:stun.example' }] }),
    })));
    expect(config.iceServers).toEqual([{ urls: 'stun:stun.example' }]);
    expect(config.iceTransportPolicy).toBe('all');
  });

  it('keeps built-in STUN when the endpoint rejects or returns an empty configuration', async () => {
    const rejected = await loadWith(vi.fn(async () => { throw new Error('offline'); }));
    expect(rejected.iceServers).toHaveLength(3);
    expect(rejected.iceTransportPolicy).toBe('all');

    const empty = await loadWith(vi.fn(async () => ({ ok: true, json: async () => ({ iceServers: [] }) })));
    expect(empty.iceServers).toHaveLength(3);
    expect(empty.iceTransportPolicy).toBe('all');
  });

  it('does not parse an unsuccessful endpoint body and keeps the fallback', async () => {
    const json = vi.fn(async () => ({ iceServers: [{ urls: 'turn:attacker.invalid' }] }));
    const config = await loadWith(vi.fn(async () => ({ ok: false, json })));
    expect(json).not.toHaveBeenCalled();
    expect(config.iceServers).toHaveLength(3);
  });
});
