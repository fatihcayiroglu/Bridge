// client/tests/helpers/webrtc-mock.ts
//
// jsdom'da RTCPeerConnection, RTCSessionDescription, RTCIceCandidate yoktur.
// jest-webrtc-mock paketi alternatiftir FAKAT mevcut package.json'da yok.
//
// Bu dosya iki seçenek sunar:
//  OPTİON A (önerilen): jest-webrtc-mock paket kurulumu talimatları + mock
//  OPTİON B (sıfır kurulum): manuel minimal WebRTC mock — şu an kullanılıyor
//
// package.json'a eklenecek:
//   "devDependencies": {
//     "jest-webrtc-mock": "^0.3.0"   <-- OPTİON A
//   }
//
// setup.ts'e (ya da jest config setupFiles'a) eklenecek:
//   import './helpers/webrtc-mock';  <-- bu dosya

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
  addEventListener = jest.fn((type: string, handler: EventListenerOrEventListenerObject) => {
    const fn = typeof handler === 'function' ? handler : handler.handleEvent.bind(handler);
    (this._listeners[type] = this._listeners[type] || []).push(fn as (...args: unknown[]) => void);
  });
  removeEventListener = jest.fn();

  // Callback properties
  onicecandidate: ((e: { candidate: MockRTCIceCandidate | null }) => void) | null = null;
  ontrack: ((e: { streams: MediaStream[]; track: MediaStreamTrack }) => void) | null = null;
  oniceconnectionstatechange: (() => void) | null = null;
  onnegotiationneeded: (() => void) | null = null;
  ondatachannel: ((e: { channel: RTCDataChannel }) => void) | null = null;

  // Core methods
  createOffer  = jest.fn().mockResolvedValue({ type: 'offer',  sdp: 'v=0\r\n' });
  createAnswer = jest.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0\r\n' });
  setLocalDescription  = jest.fn().mockImplementation((desc: RTCSessionDescriptionInit) => {
    this.localDescription = new MockRTCSessionDescription(desc);
    return Promise.resolve();
  });
  setRemoteDescription = jest.fn().mockImplementation((desc: RTCSessionDescriptionInit) => {
    this.remoteDescription = new MockRTCSessionDescription(desc);
    return Promise.resolve();
  });
  addIceCandidate = jest.fn().mockResolvedValue(undefined);
  addTrack        = jest.fn().mockReturnValue({} as RTCRtpSender);
  removeTrack     = jest.fn();
  close           = jest.fn(() => { this.iceConnectionState = 'closed'; });
  getStats        = jest.fn().mockResolvedValue(new Map());
  createDataChannel = jest.fn().mockReturnValue({} as RTCDataChannel);
  getSenders        = jest.fn().mockReturnValue([]);
  getReceivers      = jest.fn().mockReturnValue([]);

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
  getTracks    : jest.fn().mockReturnValue([]),
  getAudioTracks: jest.fn().mockReturnValue([{ enabled: true, stop: jest.fn() }]),
  getVideoTracks: jest.fn().mockReturnValue([]),
  addTrack      : jest.fn(),
  removeTrack   : jest.fn(),
};

Object.defineProperty((global as Record<string, unknown>).navigator as object, 'mediaDevices', {
  value: {
    getUserMedia    : jest.fn().mockResolvedValue(mockMediaStream),
    getDisplayMedia : jest.fn().mockResolvedValue(mockMediaStream),
    enumerateDevices: jest.fn().mockResolvedValue([]),
  },
  writable: true,
  configurable: true,
});

export { MockRTCPeerConnection, MockRTCSessionDescription, MockRTCIceCandidate, mockMediaStream };
