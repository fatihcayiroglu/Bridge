// client/tests/helpers/webrtc-mock.ts
//
// jsdom'da RTCPeerConnection, RTCSessionDescription, RTCIceCandidate yoktur.
// Vitest/jsdom için sıfır-ek-bağımlılık minimal WebRTC mock.
// İhtiyaç duyan test dosyası bunu doğrudan import eder; global test setup'a
// bağlanmaz, böylece medya davranışı istemeyen testlere sahte RTC sızmaz.

// ── OPTION B: Manuel WebRTC mock ─────────────────────────────────────────────

type IceConnectionState = 'new' | 'checking' | 'connected' | 'completed' | 'failed' | 'disconnected' | 'closed';
type SignalingState = 'stable' | 'have-local-offer' | 'have-remote-offer' | 'have-local-pranswer' | 'have-remote-pranswer' | 'closed';

class MockRTCSessionDescription {
  type: RTCSdpType;
  sdp: string;
  constructor({ type, sdp }: RTCSessionDescriptionInit) {
    this.type = type;
    this.sdp  = sdp || '';
  }
  toJSON() { return { type: this.type, sdp: this.sdp }; }
}

class MockRTCIceCandidate {
  candidate: string;
  sdpMid: string | null;
  sdpMLineIndex: number | null;
  constructor(init: RTCIceCandidateInit = {}) {
    this.candidate    = init.candidate    || '';
    this.sdpMid       = init.sdpMid       ?? null;
    this.sdpMLineIndex = init.sdpMLineIndex ?? null;
  }
  toJSON() {
    return { candidate: this.candidate, sdpMid: this.sdpMid, sdpMLineIndex: this.sdpMLineIndex };
  }
}

class MockRTCPeerConnection extends EventTarget {
  localDescription:  MockRTCSessionDescription | null = null;
  remoteDescription: MockRTCSessionDescription | null = null;
  iceConnectionState: IceConnectionState = 'new';
  signalingState: SignalingState = 'stable';
  connectionState: RTCPeerConnectionState = 'new';

  private _listeners: Record<string, Array<(...args: unknown[]) => void>> = {};

  // EventTarget API
  addEventListener = vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
    const fn = typeof handler === 'function' ? handler : handler.handleEvent.bind(handler);
    (this._listeners[type] = this._listeners[type] || []).push(fn as (...args: unknown[]) => void);
  });
  removeEventListener = vi.fn();

  // Callback properties
  onicecandidate: ((e: { candidate: MockRTCIceCandidate | null }) => void) | null = null;
  ontrack: ((e: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ondatachannel: ((e: { channel: RTCDataChannel }) => void) | null = null;

  // Core methods
  createOffer  = vi.fn().mockResolvedValue({ type: 'offer',  sdp: 'v=0\r\n' });
  createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0\r\n' });
  setLocalDescription  = vi.fn().mockImplementation((desc: RTCSessionDescriptionInit) => {
    this.localDescription = new MockRTCSessionDescription(desc);
    return Promise.resolve();
  });
  setRemoteDescription = vi.fn().mockImplementation((desc: RTCSessionDescriptionInit) => {
    this.remoteDescription = new MockRTCSessionDescription(desc);
    return Promise.resolve();
  });
  addIceCandidate = vi.fn().mockResolvedValue(undefined);
  addTrack        = vi.fn().mockReturnValue({} as RTCRtpSender);
  removeTrack     = vi.fn();
  close           = vi.fn(() => { this.iceConnectionState = 'closed'; });
  getStats        = vi.fn().mockResolvedValue(new Map());
  createDataChannel = vi.fn().mockReturnValue({} as RTCDataChannel);
  getSenders        = vi.fn().mockReturnValue([]);
  getReceivers      = vi.fn().mockReturnValue([]);

  // Test yardımcısı: ICE candidate simüle et
  _triggerIceCandidate(candidate: MockRTCIceCandidate | null = null): void {
    if (this.onicecandidate) this.onicecandidate({ candidate });
  }
  // Test yardımcısı: track eklendi simüle et
  _triggerTrack(track: MediaStreamTrack, streams: MediaStream[] = []): void {
    if (this.ontrack) this.ontrack({ streams, track });
  }
  // Test yardımcısı: bağlantı durumu değiştir
  _setIceState(state: IceConnectionState): void {
    this.iceConnectionState = state;
    if (this.oniceconnectionstatechange) this.oniceconnectionstatechange();
  }
}

// ── Global'e kaydet ────────────────────────────────────────────────────────────

(global as Record<string, unknown>).RTCPeerConnection      = MockRTCPeerConnection;
(global as Record<string, unknown>).RTCSessionDescription  = MockRTCSessionDescription;
(global as Record<string, unknown>).RTCIceCandidate        = MockRTCIceCandidate;

// MediaDevices mock — navigator.mediaDevices.getUserMedia
if (!global.navigator) {
  Object.defineProperty(global, 'navigator', { value: {}, writable: true });
}

const mockMediaStream = {
  getTracks    : vi.fn().mockReturnValue([]),
  getAudioTracks: vi.fn().mockReturnValue([{ enabled: true, stop: vi.fn() }]),
  getVideoTracks: vi.fn().mockReturnValue([]),
  addTrack      : vi.fn(),
  removeTrack   : vi.fn(),
};

Object.defineProperty((global as Record<string, unknown>).navigator as object, 'mediaDevices', {
  value: {
    getUserMedia    : vi.fn().mockResolvedValue(mockMediaStream),
    getDisplayMedia : vi.fn().mockResolvedValue(mockMediaStream),
    enumerateDevices: vi.fn().mockResolvedValue([]),
  },
  writable: true,
  configurable: true,
});

export { MockRTCPeerConnection, MockRTCSessionDescription, MockRTCIceCandidate, mockMediaStream };
