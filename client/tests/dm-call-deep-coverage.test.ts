import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';

const mocks = vi.hoisted(() => {
  const registry = new Map<string, unknown>();
  return {
    registry,
    register: vi.fn((name: string, value: unknown) => registry.set(name, value)),
    unregister: vi.fn((name: string) => registry.delete(name)),
    get: vi.fn((name: string) => registry.get(name) ?? null),
    call: vi.fn(),
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  };
});

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: mocks.register,
    unregister: mocks.unregister,
    get: mocks.get,
    call: mocks.call,
  },
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: mocks.info, warn: mocks.warn, error: mocks.error, debug: mocks.debug }),
}));
// KANONİK SÖZLÜĞE DEVRET (reaktif sarmalayıcı yalnızca Svelte reaktifliği
// ekler; metin sahibi `i18n/index.ts`tir). Elle yazılmış çiftler yedek metni
// olmayan anahtarlarda ham anahtar döndürüyor ve `vars` yerleştirmesini
// düşürüyordu.
vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});

import DmCallPanel from '../js/core/DmCallPanel.svelte';

type Handler = (payload: unknown) => void;
class FakeSocket {
  handlers = new Map<string, Handler>();
  emit = vi.fn();
  on = vi.fn((event: string, handler: Handler) => { this.handlers.set(event, handler); });
  off = vi.fn((event: string, handler: Handler) => {
    if (this.handlers.get(event) === handler) this.handlers.delete(event);
  });
  fire(event: string, payload: unknown) { this.handlers.get(event)?.(payload); }
}

function track(kind: 'audio' | 'video') {
  return { kind, enabled: true, stop: vi.fn(), onended: null as null | (() => void) };
}
function stream(audio = true, video = false) {
  const tracks = [audio ? track('audio') : null, video ? track('video') : null].filter(Boolean) as ReturnType<typeof track>[];
  return {
    tracks,
    getTracks: () => tracks,
    getAudioTracks: () => tracks.filter((t) => t.kind === 'audio'),
    getVideoTracks: () => tracks.filter((t) => t.kind === 'video'),
  };
}

class FakePeer {
  static instances: FakePeer[] = [];
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' }));
  setLocalDescription = vi.fn(async (value: unknown) => { this.localDescription = value; });
  setRemoteDescription = vi.fn(async (value: unknown) => { this.remoteDescription = value; });
  addIceCandidate = vi.fn(async () => undefined);
  replaceVideo = vi.fn(async () => undefined);
  getSenders = vi.fn(() => [{ track: { kind: 'video' }, replaceTrack: this.replaceVideo }]);
  close = vi.fn();
  localDescription: unknown = null;
  remoteDescription: unknown = null;
  connectionState = 'new';
  ontrack: ((event: { streams: unknown[] }) => void) | null = null;
  onicecandidate: ((event: { candidate: null | { toJSON(): unknown } }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { FakePeer.instances.push(this); }
}

let socket: FakeSocket;
let local: ReturnType<typeof stream>;
let screen: ReturnType<typeof stream>;
let getUserMedia: ReturnType<typeof vi.fn>;
let getDisplayMedia: ReturnType<typeof vi.fn>;

function action<T extends (...args: any[]) => any>(name: string): T {
  const value = mocks.registry.get(name);
  if (typeof value !== 'function') throw new Error(`missing registry action ${name}`);
  return value as T;
}

beforeEach(() => {
  mocks.registry.clear();
  for (const fn of [mocks.register, mocks.unregister, mocks.get, mocks.call, mocks.info, mocks.warn, mocks.error, mocks.debug]) fn.mockClear();
  socket = new FakeSocket();
  mocks.registry.set('socket', socket);
  local = stream(true, true);
  screen = stream(false, true);
  getUserMedia = vi.fn(async () => local);
  getDisplayMedia = vi.fn(async () => screen);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, getDisplayMedia },
  });
  FakePeer.instances.length = 0;
  vi.stubGlobal('RTCPeerConnection', FakePeer as unknown as typeof RTCPeerConnection);
  vi.stubGlobal('RTCSessionDescription', class { constructor(value: unknown) { return value; } });
  vi.stubGlobal('RTCIceCandidate', class { constructor(value: unknown) { return value; } });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('DmCallPanel deep signaling/media behavior', () => {
  it('runs the caller handshake through canonical call id, offer/ICE, active controls, screen share and hangup', async () => {
    const view = render(DmCallPanel);
    action<(uid: string, type?: 'voice' | 'video') => void>('startDmCall')('peer-2', 'video');
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('dm:call:start', { toUserId: 'peer-2', type: 'video' }));
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
    });

    socket.fire('dm:call:outgoing', { callId: 'call-1', toUserId: 'peer-2', type: 'video' });
    socket.fire('dm:call:accepted', { callId: 'call-1', calleeDisplayName: 'Peer Two' });
    socket.fire('dm:call:ready', { callId: 'call-1', role: 'caller', type: 'video' });
    await waitFor(() => expect(FakePeer.instances).toHaveLength(1));
    const pc = FakePeer.instances[0];
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('dm:call:offer', {
      callId: 'call-1', targetUserId: 'peer-2', offer: { type: 'offer', sdp: 'offer-sdp' },
    }));
    expect(pc.addTrack).toHaveBeenCalledTimes(2);

    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'ice-1' }) } });
    expect(socket.emit).toHaveBeenCalledWith('dm:call:ice', {
      callId: 'call-1', targetUserId: 'peer-2', candidate: { candidate: 'ice-1' },
    });
    pc.onicecandidate?.({ candidate: null });

    pc.ontrack?.({ streams: [{ id: 'remote-stream' }] });
    await tick();
    expect(view.container.querySelector('.dm-call-duration')).not.toBeNull();

    const mute = view.getByRole('button', { name: 'Sesi kapat' });
    await fireEvent.click(mute);
    expect(local.getAudioTracks()[0].enabled).toBe(false);
    await fireEvent.click(view.getByRole('button', { name: 'Videoyu kapat' }));
    expect(local.getVideoTracks()[0].enabled).toBe(false);

    await fireEvent.click(view.getByRole('button', { name: 'Ekranı paylaş' }));
    await waitFor(() => expect(pc.replaceVideo).toHaveBeenCalledWith(screen.getVideoTracks()[0]));
    expect(view.getByRole('button', { name: 'Ekran paylaşımını durdur' })).toBeTruthy();
    screen.getVideoTracks()[0].onended?.();
    await tick();
    expect(screen.getVideoTracks()[0].stop).toHaveBeenCalled();
    expect(pc.replaceVideo).toHaveBeenCalledWith(local.getVideoTracks()[0]);

    await fireEvent.click(view.getByRole('button', { name: 'Aramayı sonlandır' }));
    expect(socket.emit).toHaveBeenCalledWith('dm:call:end', { callId: 'call-1' });
    expect(pc.close).toHaveBeenCalled();
    expect(local.getTracks().every((t) => t.stop.mock.calls.length > 0)).toBe(true);
  });

  it('queues an early offer and ICE for a callee, accepts after media acquisition and flushes both into an answer', async () => {
    const view = render(DmCallPanel);
    socket.fire('dm:call:incoming', {
      callId: 'call-callee', callerId: 'caller-1', type: 'voice', callerDisplayName: 'Caller',
    });
    await waitFor(() => expect(view.getByRole('button', { name: 'Aramayı kabul et' })).toBeTruthy());

    socket.fire('dm:call:offer', { callId: 'call-callee', offer: { type: 'offer', sdp: 'early-offer' } });
    socket.fire('dm:call:ice', { callId: 'call-callee', candidate: { candidate: 'early-ice' } });
    await fireEvent.click(view.getByRole('button', { name: 'Aramayı kabul et' }));
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('dm:call:accept', { callId: 'call-callee' }));

    socket.fire('dm:call:ready', { callId: 'call-callee', role: 'callee', type: 'voice' });
    await waitFor(() => expect(FakePeer.instances).toHaveLength(1));
    const pc = FakePeer.instances[0];
    await waitFor(() => expect(pc.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'early-offer' }));
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'early-ice' });
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('dm:call:answer', {
      callId: 'call-callee', targetUserId: 'caller-1', answer: { type: 'answer', sdp: 'answer-sdp' },
    }));

    // Once the remote description exists, later ICE is applied immediately.
    socket.fire('dm:call:ice', { callId: 'call-callee', candidate: { candidate: 'late-ice' } });
    await waitFor(() => expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'late-ice' }));
  });

  it('contains invalid/stale signaling, media denial, decline/missed/ended and failed peer states', async () => {
    const view = render(DmCallPanel);
    socket.fire('dm:call:incoming', { nope: true });
    expect(view.container.querySelector('.dm-call-overlay')).toBeNull();

    getUserMedia.mockRejectedValueOnce(new Error('mic denied'));
    action<(uid: string, type?: 'voice' | 'video') => void>('startDmCall')('peer-denied', 'voice');
    await waitFor(() => expect(mocks.call).toHaveBeenCalledWith('toast', 'Mikrofona erişilemedi; arama başlatılamadı', 'error'));
    expect(action<() => { status: string }>('getDmCallStatus')().status).toBe('idle');

    socket.fire('dm:call:incoming', {
      callId: 'call-decline', callerId: 'caller-x', type: 'voice', callerDisplayName: 'Caller X',
    });
    await waitFor(() => expect(view.getByRole('button', { name: 'Aramayı reddet' })).toBeTruthy());
    // A second incoming call must not replace the current session.
    socket.fire('dm:call:incoming', {
      callId: 'call-other', callerId: 'other', type: 'voice', callerDisplayName: 'Other',
    });
    await fireEvent.click(view.getByRole('button', { name: 'Aramayı reddet' }));
    expect(socket.emit).toHaveBeenCalledWith('dm:call:decline', { callId: 'call-decline' });

    // Start a fresh caller session and exercise declined/missed guards.
    action<(uid: string) => void>('startDmCall')('peer-3');
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith('dm:call:start', { toUserId: 'peer-3', type: 'voice' }));
    socket.fire('dm:call:outgoing', { callId: 'call-3', toUserId: 'peer-3', type: 'voice' });
    socket.fire('dm:call:declined', { callId: 'stale' });
    expect(action<() => { status: string }>('getDmCallStatus')().status).toBe('ringing');
    socket.fire('dm:call:declined', { callId: 'call-3' });
    expect(mocks.call).toHaveBeenCalledWith('toast', 'Arama reddedildi', 'info');

    // Invalid/empty registry invocations are harmless.
    await action<(uid: string) => void>('startDmCall')('');
    action<() => void>('hangUpDmCall')();
  });

  it('rebinds handlers to a replacement socket and contains peer connection failure', async () => {
    render(DmCallPanel);
    const old = socket;
    const replacement = new FakeSocket();
    mocks.registry.set('socket', replacement);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(old.off).toHaveBeenCalled();
    expect(replacement.on).toHaveBeenCalledWith('dm:call:incoming', expect.any(Function));

    replacement.fire('dm:call:incoming', {
      callId: 'call-fail', callerId: 'caller-f', type: 'voice', callerDisplayName: 'Fail Peer',
    });
    await action<() => void>('acceptDmCall')();
    replacement.fire('dm:call:ready', { callId: 'call-fail', role: 'callee', type: 'voice' });
    await waitFor(() => expect(FakePeer.instances).toHaveLength(1));
    const pc = FakePeer.instances[0];
    pc.connectionState = 'failed';
    pc.onconnectionstatechange?.();
    expect(mocks.call).toHaveBeenCalledWith('toast', 'Arama bağlantısı koptu', 'warning');
    expect(replacement.emit).toHaveBeenCalledWith('dm:call:end', { callId: 'call-fail' });
  });

  it('rejects malformed/stale signaling and guards actions while a session already exists', async () => {
    render(DmCallPanel);
    for (const [event, payload] of [
      ['dm:call:outgoing', { nope: true }],
      ['dm:call:accepted', { nope: true }],
      ['dm:call:ready', { nope: true }],
      ['dm:call:offer', { callId: 'stale', offer: { type: 'offer', sdp: 'x' } }],
      ['dm:call:ice', { callId: 'stale', candidate: { candidate: 'x' } }],
      ['dm:call:missed', { callId: 'stale' }],
      ['dm:call:ended', { callId: 'stale' }],
    ] as const) socket.fire(event, payload);

    action<() => void>('acceptDmCall')();
    action<() => void>('declineDmCall')();
    action<(uid: string) => void>('startDmCall')('peer-guard');
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
      'dm:call:start', { toUserId: 'peer-guard', type: 'voice' },
    ));
    action<(uid: string) => void>('startDmCall')('peer-other');
    expect(mocks.call).toHaveBeenCalledWith('toast', 'Zaten bir aramadasınız', 'warning');

    socket.fire('dm:call:outgoing', { callId: 'guard-call', toUserId: 'peer-guard', type: 'voice' });
    socket.fire('dm:call:accepted', { callId: 'stale', calleeDisplayName: 'Wrong' });
    socket.fire('dm:call:ready', { callId: 'stale', role: 'caller', type: 'voice' });
    expect(FakePeer.instances).toHaveLength(0);
    action<() => void>('hangUpDmCall')();
  });

  it('handles answers, missing/stale ICE, remote stream absence, connected state and duration ticks', async () => {
    const view = render(DmCallPanel);
    action<(uid: string, type?: 'voice' | 'video') => void>('startDmCall')('peer-answer', 'video');
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
      'dm:call:start', { toUserId: 'peer-answer', type: 'video' },
    ));
    socket.fire('dm:call:outgoing', { callId: 'answer-call', toUserId: 'peer-answer', type: 'video' });
    socket.fire('dm:call:ready', { callId: 'answer-call', role: 'caller', type: 'video' });
    await waitFor(() => expect(FakePeer.instances).toHaveLength(1));
    const pc = FakePeer.instances[0];

    socket.fire('dm:call:answer', { callId: 'stale', answer: { type: 'answer', sdp: 'stale' } });
    socket.fire('dm:call:answer', { callId: 'answer-call' });
    pc.setRemoteDescription.mockRejectedValueOnce(new Error('remote failed'));
    socket.fire('dm:call:answer', { callId: 'answer-call', answer: { type: 'answer', sdp: 'bad' } });
    await waitFor(() => expect(mocks.error).toHaveBeenCalledWith('setRemote', expect.any(Error)));
    socket.fire('dm:call:answer', { callId: 'answer-call', answer: { type: 'answer', sdp: 'good' } });
    await waitFor(() => expect(pc.remoteDescription).toEqual({ type: 'answer', sdp: 'good' }));

    socket.fire('dm:call:ice', { callId: 'answer-call' });
    socket.fire('dm:call:ice', { callId: 'stale', candidate: { candidate: 'stale' } });
    pc.addIceCandidate.mockRejectedValueOnce(new Error('ice failed'));
    socket.fire('dm:call:ice', { callId: 'answer-call', candidate: { candidate: 'late' } });
    await waitFor(() => expect(mocks.warn).toHaveBeenCalledWith('addIce', expect.any(Error)));

    vi.useFakeTimers();
    pc.ontrack?.({ streams: [] });
    await tick();
    expect((view.container.querySelector('.dm-call-remote-video') as HTMLVideoElement).srcObject).toBeNull();
    pc.connectionState = 'connected';
    pc.onconnectionstatechange?.();
    await vi.advanceTimersByTimeAsync(61_000);
    await tick();
    expect(view.container.querySelector('.dm-call-duration')?.textContent).toBe('01:01');
  });

  it('handles valid missed/ended events and does not let an old ended timer erase a new call', async () => {
    vi.useFakeTimers();
    render(DmCallPanel);
    socket.fire('dm:call:incoming', {
      callId: 'missed-call', callerId: 'caller-m', type: 'voice', callerDisplayName: 'Missed',
    });
    socket.fire('dm:call:missed', { callId: 'missed-call' });
    expect(mocks.call).toHaveBeenCalledWith('toast', 'Cevapsız arama', 'info');
    expect(action<() => { status: string }>('getDmCallStatus')().status).toBe('ended');

    action<(uid: string) => void>('startDmCall')('new-peer');
    await Promise.resolve();
    await Promise.resolve();
    expect(action<() => { status: string }>('getDmCallStatus')().status).toBe('ringing');
    await vi.advanceTimersByTimeAsync(1_800);
    expect(action<() => { status: string }>('getDmCallStatus')().status).toBe('ringing');

    socket.fire('dm:call:outgoing', { callId: 'ended-call', toUserId: 'new-peer', type: 'voice' });
    socket.fire('dm:call:ended', { callId: 'ended-call' });
    expect(action<() => { status: string }>('getDmCallStatus')().status).toBe('ended');
    await vi.advanceTimersByTimeAsync(1_800);
    expect(action<() => { status: string }>('getDmCallStatus')().status).toBe('idle');
  });

  it('stops screen sharing through the toggle, handles no sender/camera, and contains display denial', async () => {
    local = stream(true, false);
    const view = render(DmCallPanel);
    action<(uid: string, type?: 'voice' | 'video') => void>('startDmCall')('screen-peer', 'video');
    await waitFor(() => expect(socket.emit).toHaveBeenCalledWith(
      'dm:call:start', { toUserId: 'screen-peer', type: 'video' },
    ));
    socket.fire('dm:call:outgoing', { callId: 'screen-call', toUserId: 'screen-peer', type: 'video' });
    socket.fire('dm:call:ready', { callId: 'screen-call', role: 'caller', type: 'video' });
    await waitFor(() => expect(FakePeer.instances).toHaveLength(1));
    FakePeer.instances[0].getSenders.mockReturnValue([]);

    await fireEvent.click(view.getByRole('button', { name: 'Ekranı paylaş' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Ekran paylaşımını durdur' })).toBeTruthy());
    await fireEvent.click(view.getByRole('button', { name: 'Ekran paylaşımını durdur' }));
    expect(screen.getVideoTracks()[0].stop).toHaveBeenCalled();

    getDisplayMedia.mockRejectedValueOnce(new Error('display denied'));
    await fireEvent.click(view.getByRole('button', { name: 'Ekranı paylaş' }));
    await waitFor(() => expect(mocks.warn).toHaveBeenCalledWith('Screen share failed', expect.any(Error)));

    await fireEvent.click(view.getByRole('button', { name: 'Ekranı paylaş' }));
    await waitFor(() => expect(view.getByRole('button', { name: 'Ekran paylaşımını durdur' })).toBeTruthy());
    view.unmount();
    expect(screen.getVideoTracks()[0].stop.mock.calls.length).toBeGreaterThan(1);
  });

  it('stays unbound without a socket and does not duplicate handlers for an unchanged socket', () => {
    mocks.registry.delete('socket');
    const view = render(DmCallPanel);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(socket.on).not.toHaveBeenCalled();

    mocks.registry.set('socket', socket);
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(socket.on).toHaveBeenCalledTimes(10);
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(socket.on).toHaveBeenCalledTimes(10);
    view.unmount();
  });
});
