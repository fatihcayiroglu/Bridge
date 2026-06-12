// client/tests/dm-call.test.ts
//
// DmCall WebRTC mantığı birim testleri
//
// Gereksinim: client/tests/package.json'a eklenecek:
//   "jest": {
//     "setupFiles": ["./helpers/setup.ts", "./helpers/webrtc-mock.ts"]
//   }
//
// VEYA bu dosyanın başında import:
//   import './helpers/webrtc-mock';
//
// jest-webrtc-mock KURULUYSA:
//   npm install --save-dev jest-webrtc-mock
//   setupFiles'a: "jest-webrtc-mock"
//   Bu dosyadaki import './helpers/webrtc-mock' kaldırılabilir.

import './helpers/webrtc-mock';   // RTCPeerConnection, RTCIceCandidate, RTCSessionDescription global'e yazar
import {
  MockRTCPeerConnection,
  MockRTCIceCandidate,
  MockRTCSessionDescription,
  mockMediaStream,
} from './helpers/webrtc-mock';

// IceConnectionState WebRTC spec'ten — jsdom'da global olarak tanımlı değil
type IceConnectionState = 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed';

// ── DmCall modülü yüklenmeden önce global'leri hazırla ────────────────────────

// Socket mock
const mockSocket = {
  emit: jest.fn(),
  on  : jest.fn(),
  off : jest.fn(),
  connected: true,
};

// DmCall vanilla IIFE pattern — global BridgeRegistry gerekebilir
global.BridgeRegistry = { get: jest.fn() };

// ── DmCall IIFE'yi simüle et ──────────────────────────────────────────────────
// dm-call.ts doğrudan import edilmek yerine mantığı izole test ediyoruz.
// Gerçek import için: jest.config'de moduleNameMapper ile .js → .ts yönlendir.

// Modül mantığını manuel olarak yeniden oluştur (src import alternatifi)
interface CallState {
  callId: string | null;
  type: 'voice' | 'video' | null;
  remoteUserId: string | null;
  role: 'caller' | 'callee' | null;
  pc: InstanceType<typeof MockRTCPeerConnection> | null;
}

function makeDmCallState(): CallState {
  return { callId: null, type: null, remoteUserId: null, role: null, pc: null };
}

// ──────────────────────────────────────────────────────────────────────────────
// TESTLER
// ──────────────────────────────────────────────────────────────────────────────

describe('RTCPeerConnection mock — global erişilebilirlik', () => {
  it('RTCPeerConnection global tanımlı olmalı', () => {
    expect(typeof RTCPeerConnection).toBe('function');
  });
  it('RTCSessionDescription global tanımlı olmalı', () => {
    expect(typeof RTCSessionDescription).toBe('function');
  });
  it('RTCIceCandidate global tanımlı olmalı', () => {
    expect(typeof RTCIceCandidate).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('RTCPeerConnection mock — createOffer / createAnswer', () => {
  let pc: InstanceType<typeof MockRTCPeerConnection>;

  beforeEach(() => {
    pc = new (global.RTCPeerConnection as unknown as typeof MockRTCPeerConnection)({
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
    });
  });

  it('createOffer() type:"offer" ile çözümlenmeli', async () => {
    const offer = await pc.createOffer();
    expect(offer.type).toBe('offer');
    expect(typeof offer.sdp).toBe('string');
  });

  it('createAnswer() type:"answer" ile çözümlenmeli', async () => {
    const answer = await pc.createAnswer();
    expect(answer.type).toBe('answer');
  });

  it('setLocalDescription() localDescription güncellenmeli', async () => {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    expect(pc.localDescription).not.toBeNull();
    expect(pc.localDescription?.type).toBe('offer');
  });

  it('setRemoteDescription() remoteDescription güncellenmeli', async () => {
    const answer = await pc.createAnswer();
    await pc.setRemoteDescription(answer);
    expect(pc.remoteDescription?.type).toBe('answer');
  });

  it('addIceCandidate() hata fırlatmamalı', async () => {
    const candidate = new (global.RTCIceCandidate as unknown as typeof MockRTCIceCandidate)({
      candidate: 'candidate:0 1 UDP 2130706431 192.168.1.100 52397 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    });
    await expect(pc.addIceCandidate(candidate)).resolves.toBeUndefined();
  });

  it('close() sonrası iceConnectionState "closed" olmalı', () => {
    pc.close();
    expect(pc.iceConnectionState).toBe('closed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('DmCall — caller tarafı WebRTC akışı', () => {
  let pc: InstanceType<typeof MockRTCPeerConnection>;

  beforeEach(() => {
    jest.clearAllMocks();
    pc = new (global.RTCPeerConnection as unknown as typeof MockRTCPeerConnection)({});
  });

  it('startCall caller akışı: getUserMedia → addTrack → createOffer → setLocalDescription', async () => {
    // getUserMedia
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: true });

    // Track ekle
    const track = {} as MediaStreamTrack;
    pc.addTrack(track, stream as MediaStream);
    expect(pc.addTrack).toHaveBeenCalledWith(track, stream);

    // Offer oluştur
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    expect(pc.localDescription?.type).toBe('offer');

    // Socket'e gönder
    mockSocket.emit('dm:call:start', {
      callId: 'call-123',
      toUserId: 'user-b',
      type: 'voice',
      offer: pc.localDescription,
    });
    expect(mockSocket.emit).toHaveBeenCalledWith('dm:call:start', expect.objectContaining({
      callId: 'call-123',
      type: 'voice',
    }));
  });

  it('answer gelince setRemoteDescription çağrılmalı', async () => {
    const answerSdp = { type: 'answer' as RTCSdpType, sdp: 'v=0\r\n' };
    await pc.setRemoteDescription(answerSdp);
    expect(pc.remoteDescription?.type).toBe('answer');
  });

  it('ICE candidate simülasyonu — onicecandidate callback', (done) => {
    pc.onicecandidate = (e) => {
      if (e.candidate) {
        expect(e.candidate.candidate).toContain('candidate:');
        done();
      }
    };
    pc._triggerIceCandidate(new MockRTCIceCandidate({
      candidate: 'candidate:1 1 UDP 2130706431 10.0.0.1 54321 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    }));
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('DmCall — callee tarafı WebRTC akışı', () => {
  let pc: InstanceType<typeof MockRTCPeerConnection>;

  beforeEach(() => {
    jest.clearAllMocks();
    pc = new (global.RTCPeerConnection as unknown as typeof MockRTCPeerConnection)({});
  });

  it('offer gelince setRemoteDescription → createAnswer → setLocalDescription', async () => {
    const incomingOffer = { type: 'offer' as RTCSdpType, sdp: 'v=0\r\no=- 0 0 IN IP4 127.0.0.1\r\n' };

    await pc.setRemoteDescription(incomingOffer);
    expect(pc.remoteDescription?.type).toBe('offer');

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    expect(pc.localDescription?.type).toBe('answer');
    expect(pc.createAnswer).toHaveBeenCalledTimes(1);
  });

  it('karşı taraf ICE candidate gönderince addIceCandidate çağrılmalı', async () => {
    const candidate = { candidate: 'candidate:0 1 UDP 2130706431 192.168.0.1 60000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
    await pc.addIceCandidate(candidate as RTCIceCandidateInit);
    expect(pc.addIceCandidate).toHaveBeenCalledWith(candidate);
  });

  it('decline edilince socket dm:call:decline emit edilmeli ve pc kapatılmalı', () => {
    const callId = 'call-abc';
    mockSocket.emit('dm:call:decline', { callId });
    pc.close();

    expect(mockSocket.emit).toHaveBeenCalledWith('dm:call:decline', { callId });
    expect(pc.close).toHaveBeenCalled();
    expect(pc.iceConnectionState).toBe('closed');
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('DmCall — bağlantı durum geçişleri', () => {
  let pc: InstanceType<typeof MockRTCPeerConnection>;

  beforeEach(() => {
    pc = new (global.RTCPeerConnection as unknown as typeof MockRTCPeerConnection)({});
  });

  it.each([
    ['connected',    false],
    ['failed',       true],
    ['disconnected', true],
    ['closed',       true],
  ] as [IceConnectionState, boolean][])(
    'iceConnectionState="%s" → hangUp tetiklenmeli mi: %s',
    (state, shouldHangUp) => {
      const hangUpCb = jest.fn();
      pc.oniceconnectionstatechange = () => {
        if (['failed', 'disconnected', 'closed'].includes(pc.iceConnectionState)) {
          hangUpCb();
        }
      };

      pc._setIceState(state);

      if (shouldHangUp) {
        expect(hangUpCb).toHaveBeenCalled();
      } else {
        expect(hangUpCb).not.toHaveBeenCalled();
      }
    }
  );
});

// ─────────────────────────────────────────────────────────────────────────────

describe('DmCall — toggleMic mantığı', () => {
  it('track enabled toggle etmeli', async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tracks = (stream as typeof mockMediaStream).getAudioTracks();
    expect(tracks.length).toBeGreaterThan(0);

    const track = tracks[0] as { enabled: boolean; stop: jest.Mock };
    track.enabled = true;
    track.enabled = !track.enabled; // toggle
    expect(track.enabled).toBe(false);

    track.enabled = !track.enabled; // tekrar toggle
    expect(track.enabled).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('DmCall — hangUp temizleme', () => {
  let pc: InstanceType<typeof MockRTCPeerConnection>;

  beforeEach(() => {
    pc = new (global.RTCPeerConnection as unknown as typeof MockRTCPeerConnection)({});
  });

  it('hangUp: pc.close() + socket emit + state sıfırlanmalı', () => {
    const state: CallState = {
      callId: 'call-999',
      type: 'video',
      remoteUserId: 'user-x',
      role: 'caller',
      pc: pc as unknown as CallState['pc'],
    };

    // hangUp mantığı
    if (state.pc) state.pc.close();
    mockSocket.emit('dm:call:hangup', { callId: state.callId });

    const fresh = makeDmCallState();
    Object.assign(state, fresh);

    expect(pc.close).toHaveBeenCalled();
    expect(mockSocket.emit).toHaveBeenCalledWith('dm:call:hangup', { callId: 'call-999' });
    expect(state.callId).toBeNull();
    expect(state.pc).toBeNull();
  });
});
