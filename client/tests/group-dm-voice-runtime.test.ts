import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
// Beklentiler SOZLUKTEN turetilir: bu metinler artik cevrilidir
// (Ingilizce yedekler yalnizca anahtar yoksa gorunur).

import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const { apiFetchMock, logMock } = vi.hoisted(() => ({
  apiFetchMock: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  logMock: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: apiFetchMock }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => '' }));
vi.mock('../js/core/logger.ts', () => ({ createLogger: () => logMock }));

class FakeSocket {
  id = 'self-socket';
  connected = true;
  handlers = new Map<string, Set<(payload: unknown) => unknown>>();
  emitted: Array<{ event: string; payload: any }> = [];
  on(event: string, fn: (payload: unknown) => unknown) {
    const set = this.handlers.get(event) ?? new Set(); set.add(fn); this.handlers.set(event, set);
  }
  off(event: string, fn: (payload: unknown) => unknown) { this.handlers.get(event)?.delete(fn); }
  emit(event: string, payload?: unknown) { this.emitted.push({ event, payload }); }
  async trigger(event: string, payload: unknown) {
    for (const fn of [...(this.handlers.get(event) ?? [])]) await fn(payload);
    await Promise.resolve(); await Promise.resolve();
  }
}

const tracks = {
  audio: { enabled: true, stop: vi.fn() },
  video: { enabled: true, stop: vi.fn() },
};
const stream = {
  getTracks: () => [tracks.audio, tracks.video],
  getAudioTracks: () => [tracks.audio],
  getVideoTracks: () => [tracks.video],
} as unknown as MediaStream;
const getUserMedia = vi.fn(async () => stream);

class FakePc {
  static instances: FakePc[] = [];
  localDescription: RTCSessionDescriptionInit | null = null;
  remoteDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => unknown) | null = null;
  ontrack: ((ev: RTCTrackEvent) => unknown) | null = null;
  onconnectionstatechange: (() => unknown) | null = null;
  addTrack = vi.fn();
  addIceCandidate = vi.fn(async () => undefined);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' } as RTCSessionDescriptionInit));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' } as RTCSessionDescriptionInit));
  setLocalDescription = vi.fn(async (d: RTCSessionDescriptionInit) => { this.localDescription = d; });
  setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => { this.remoteDescription = d; });
  close = vi.fn(() => { this.connectionState = 'closed'; });
  constructor() { FakePc.instances.push(this); }
}

let mod: typeof import('../js/core/group-dm-voice.ts');
let socket: FakeSocket;

beforeAll(async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('RTCPeerConnection', FakePc as unknown as typeof RTCPeerConnection);
  socket = new FakeSocket();
  BridgeRegistry.register('socket', socket as never);
  BridgeRegistry.register('toast', vi.fn() as never);
  BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => ({ _id: 'g-1', name: 'Runtime Group' })) as never);
  mod = await import('../js/core/group-dm-voice.ts');
});

beforeEach(() => {
  mod.__gdmVoiceTestHooks.cleanupCall();
  socket.emitted.length = 0;
  FakePc.instances.length = 0;
  getUserMedia.mockClear();
  tracks.audio.enabled = true; tracks.video.enabled = true;
  tracks.audio.stop.mockClear(); tracks.video.stop.mockClear();
  document.body.innerHTML = '';
  socket.connected = true;
  BridgeRegistry.register('socket', socket as never);
  BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => ({ _id: 'g-1', name: 'Runtime Group' })) as never);
  mod.__gdmVoiceTestHooks.initializeRuntime();
  mod.__gdmVoiceTestHooks.bindSocket(socket as never);
});

describe('group DM voice runtime owner', () => {
  it('accepts a valid relay ICE configuration on the first media acquisition', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        iceServers: [{ urls: 'turn:relay.example' }],
        iceTransportPolicy: 'relay',
      }),
    });
    await mod.startGroupDmVoice('voice', 'g-1');
    expect(apiFetchMock).toHaveBeenCalledWith('/api/rtc/ice-config');
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:start', payload: { groupId: 'g-1', type: 'voice' } });
  });

  it('starts on the canonical socket after browser media is acquired', async () => {
    await mod.startGroupDmVoice('voice', 'g-1');
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({ audio: expect.anything(), video: false }));
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:start', payload: { groupId: 'g-1', type: 'voice' } });
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');
    expect(document.getElementById('gdm-call-runtime')).not.toBeNull();
  });

  it('does not emit a call when realtime transport is unavailable', async () => {
    socket.connected = false;
    await mod.startGroupDmVoice('voice', 'g-1');
    expect(socket.emitted.find(e => e.event === 'gdm:call:start')).toBeUndefined();
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('renders incoming metadata as text and joins only after explicit acceptance', async () => {
    await socket.trigger('gdm:call:incoming', { groupId: 'g-2', type: 'video', callerDisplayName: '<img src=x onerror=alert(1)>' });
    const popup = document.getElementById('gdm-incoming-call');
    expect(popup?.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(popup?.querySelector('img')).toBeNull();
    (Array.from(popup!.querySelectorAll('button')).find(b => b.textContent === 'Yanıtla') as HTMLButtonElement).click();
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(socket.emitted.some(e => e.event === 'gdm:call:join' && e.payload.groupId === 'g-2')).toBe(true);
  });

  it('joining peer offers to every existing peer and never offers to itself', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    socket.emitted.length = 0;
    await socket.trigger('gdm:call:existing:peers', { groupId: 'g-1', peers: [
      { socketId: 'peer-a', userId: 'u-a', displayName: 'A' },
      { socketId: socket.id, userId: 'self', displayName: 'Self' },
    ] });
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(1);
    expect(socket.emitted).toContainEqual(expect.objectContaining({ event: 'gdm:call:offer', payload: expect.objectContaining({ targetSocketId: 'peer-a' }) }));
    expect(socket.emitted.some(e => e.event === 'gdm:call:offer' && e.payload.targetSocketId === socket.id)).toBe(false);
  });

  it('queues early ICE until the corresponding remote description exists', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:ice', { groupId: 'g-1', fromSocketId: 'peer-race', candidate: { candidate: 'early' } });
    expect(FakePc.instances).toHaveLength(0);

    await socket.trigger('gdm:call:offer', { groupId: 'g-1', fromSocketId: 'peer-race', offer: { type: 'offer', sdp: 'remote' } });
    const pc = FakePc.instances[0]!;
    expect(pc.setRemoteDescription).toHaveBeenCalled();
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'early' });
    expect(socket.emitted).toContainEqual(expect.objectContaining({ event: 'gdm:call:answer', payload: expect.objectContaining({ targetSocketId: 'peer-race' }) }));
  });

  it('queues ICE after an outgoing offer until the answer sets remote description', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:existing:peers', { groupId: 'g-1', peers: [{ socketId: 'peer-a', displayName: 'A' }] });
    const pc = FakePc.instances[0]!;
    await socket.trigger('gdm:call:ice', { groupId: 'g-1', fromSocketId: 'peer-a', candidate: { candidate: 'between' } });
    expect(pc.addIceCandidate).not.toHaveBeenCalled();
    await socket.trigger('gdm:call:answer', { groupId: 'g-1', fromSocketId: 'peer-a', answer: { type: 'answer', sdp: 'remote' } });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'between' });
  });

  it('leaves, closes peers and stops local tracks on cleanup', async () => {
    await mod.joinGroupDmVoice('video', 'g-1');
    await socket.trigger('gdm:call:peer:joined', { groupId: 'g-1', socketId: 'peer-a', displayName: 'A' });
    const pc = FakePc.instances[0]!;
    mod.stopGroupDmVoice();
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:leave', payload: { groupId: 'g-1' } });
    expect(pc.close).toHaveBeenCalled();
    expect(tracks.audio.stop).toHaveBeenCalled();
    expect(tracks.video.stop).toHaveBeenCalled();
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
  });

  it('can restore registry/document ownership after an explicit teardown without duplicating handlers', async () => {
    mod.teardownGroupDmVoiceRuntime();
    expect(BridgeRegistry.get('startGdmCall')).toBeNull();
    const before = [...socket.handlers.values()].reduce((sum, set) => sum + set.size, 0);
    expect(before).toBe(0);

    mod.__gdmVoiceTestHooks.initializeRuntime();
    expect(typeof BridgeRegistry.get('startGdmCall')).toBe('function');
    const first = [...socket.handlers.values()].reduce((sum, set) => sum + set.size, 0);
    expect(first).toBeGreaterThan(0);
    mod.__gdmVoiceTestHooks.initializeRuntime();
    const second = [...socket.handlers.values()].reduce((sum, set) => sum + set.size, 0);
    expect(second).toBe(first);
  });

  it('rebinds specific listeners to a replacement socket and rejoins an active call', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    const old = socket;
    const replacement = new FakeSocket(); replacement.id = 'replacement';
    BridgeRegistry.register('socket', replacement as never);
    mod.__gdmVoiceTestHooks.bindSocket(replacement as never);
    expect([...old.handlers.values()].every(set => set.size === 0)).toBe(true);
    expect([...replacement.handlers.values()].some(set => set.size > 0)).toBe(true);
  });
});

describe('group DM voice defensive/state-machine branches', () => {
  it('rejects invalid/missing group ids and refuses switching groups mid-call', async () => {
    BridgeRegistry.unregister('groupDmPanel:getCurrentGroup');
    await mod.startGroupDmVoice('voice');
    await mod.joinGroupDmVoice('voice', '');
    expect(getUserMedia).not.toHaveBeenCalled();
    BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => ({ _id: 'g-1', name: 'Runtime Group' })) as never);
    await mod.joinGroupDmVoice('voice', 'g-1');
    const before = socket.emitted.length;
    await mod.joinGroupDmVoice('video', 'g-other');
    expect(socket.emitted.length).toBe(before);
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');
  });

  it('owns video/mute controls and emits canonical state payloads', async () => {
    await mod.joinGroupDmVoice('video', 'g-1');
    expect(getUserMedia).toHaveBeenCalledWith(expect.objectContaining({
      audio: expect.objectContaining({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }),
      video: expect.objectContaining({ width: { ideal: 1280 }, height: { ideal: 720 } }),
    }));
    const root = document.getElementById('gdm-call-runtime')!;
    const buttons = [...root.querySelectorAll('button')];
    const mic = buttons.find(b => b.title.includes('Mikrofon'))!;
    const camera = buttons.find(b => b.title.includes('Kamera'))!;
    mic.click(); camera.click();
    const states = socket.emitted.filter(e => e.event === 'gdm:call:state');
    expect(states).toHaveLength(2);
    expect(states[0].payload).toEqual({ groupId: 'g-1', muted: true, video: true });
    expect(states[1].payload).toEqual({ groupId: 'g-1', muted: true, video: false });
    expect(tracks.audio.enabled).toBe(false); expect(tracks.video.enabled).toBe(false);
  });

  it('contains media acquisition failure without leaving an active call', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    await expect(mod.joinGroupDmVoice('video', 'g-1')).resolves.toBeUndefined();
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
    expect(document.getElementById('gdm-call-runtime')).toBeNull();
    expect(logMock.error).toHaveBeenCalledWith('GDM medya başlatılamadı', expect.anything());
  });

  it('rejects, expires and ignores malformed incoming calls without acquiring media', async () => {
    vi.useFakeTimers();
    try {
      await socket.trigger('gdm:call:incoming', { groupId: '', type: 'voice' });
      expect(document.getElementById('gdm-incoming-call')).toBeNull();
      await socket.trigger('gdm:call:incoming', { groupId: 'g-2', type: 'wat', callerDisplayName: '  Caller  ' });
      let popup = document.getElementById('gdm-incoming-call')!;
      expect(popup.textContent).toContain(t('gdm_incoming_voice_call', undefined, { caller: 'Caller' }));
      (Array.from(popup.querySelectorAll('button')).find(b => b.textContent === 'Reddet') as HTMLButtonElement).click();
      expect(document.getElementById('gdm-incoming-call')).toBeNull();
      await socket.trigger('gdm:call:incoming', { groupId: 'g-3', type: 'video' });
      popup = document.getElementById('gdm-incoming-call')!;
      expect(popup).not.toBeNull();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(document.getElementById('gdm-incoming-call')).toBeNull();
      expect(getUserMedia).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });

  it('applies peer state, track, ICE and failed-connection lifecycle through canonical events', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', { groupId: 'g-1', socketId: 'peer-x', userId: 'ux', displayName: '' });
    const pc = FakePc.instances[0]!;
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(1);

    // Local candidate is forwarded, empty candidate is ignored.
    pc.onicecandidate?.({ candidate: null } as RTCPeerConnectionIceEvent);
    pc.onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'local' }) } } as unknown as RTCPeerConnectionIceEvent);
    expect(socket.emitted).toContainEqual(expect.objectContaining({
      event: 'gdm:call:ice', payload: expect.objectContaining({ targetSocketId: 'peer-x', candidate: { candidate: 'local' } }),
    }));

    const remoteTrack = { enabled: true, stop: vi.fn(), kind: 'video' };
    const remoteStream = { getTracks: () => [remoteTrack], getVideoTracks: () => [remoteTrack] } as unknown as MediaStream;
    pc.ontrack?.({ streams: [remoteStream], track: remoteTrack } as unknown as RTCTrackEvent);
    expect(document.querySelector('[data-gdm-peer="peer-x"] video')).not.toBeNull();

    await socket.trigger('gdm:call:peer:state', { groupId: 'g-1', socketId: 'peer-x', muted: true, video: true });
    expect(document.querySelector('[data-gdm-peer="peer-x"] span')?.getAttribute('style')).toContain('opacity');

    pc.remoteDescription = { type: 'answer', sdp: 'ok' };
    await socket.trigger('gdm:call:ice', { groupId: 'g-1', fromSocketId: 'peer-x', candidate: { candidate: 'direct' } });
    expect(pc.addIceCandidate).toHaveBeenCalledWith({ candidate: 'direct' });

    pc.connectionState = 'failed'; pc.onconnectionstatechange?.();
    expect(pc.close).toHaveBeenCalled(); expect(remoteTrack.stop).toHaveBeenCalled();
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);
  });

  it('cleans calls on server ended/left events and emits end only while connected', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    mod.endGroupDmVoice();
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:end', payload: { groupId: 'g-1' } });
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();

    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:ended', { groupId: 'g-1' });
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();

    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:left', { groupId: 'g-1' });
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();

    await mod.joinGroupDmVoice('voice', 'g-1');
    socket.connected = false; const before = socket.emitted.length;
    mod.endGroupDmVoice();
    expect(socket.emitted.length).toBe(before);
  });

  it('rebuilds stale peer ownership and rejoins through the document reconnect lifecycle', async () => {
    await mod.joinGroupDmVoice('video', 'g-1');
    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'old-peer', displayName: 'Old peer',
    });
    const stalePc = FakePc.instances[0]!;
    const oldSocket = socket;
    const replacement = new FakeSocket();
    replacement.id = 'new-self';
    BridgeRegistry.register('socket', replacement as never);

    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await Promise.resolve();

    expect(stalePc.close).toHaveBeenCalledOnce();
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);
    expect([...oldSocket.handlers.values()].every(set => set.size === 0)).toBe(true);
    expect(replacement.emitted).toContainEqual({
      event: 'gdm:call:join', payload: { groupId: 'g-1', type: 'video' },
    });

    // Restore the fixture owner for the following test before cleanup runs.
    BridgeRegistry.register('socket', socket as never);
    mod.__gdmVoiceTestHooks.bindSocket(socket as never);
  });

  it('exposes the complete runtime API and keeps active-state truth across start/leave/end', async () => {
    const start = BridgeRegistry.get('startGdmCall') as (type: unknown, id: unknown) => Promise<void>;
    const leave = BridgeRegistry.get('leaveGdmCall') as () => void;
    const end = BridgeRegistry.get('endGdmCall') as () => void;
    const active = BridgeRegistry.get('groupDmCall:isActive') as () => boolean;

    expect(active()).toBe(false);
    await start('unexpected-type', 'g-1');
    expect(socket.emitted).toContainEqual({
      event: 'gdm:call:start', payload: { groupId: 'g-1', type: 'voice' },
    });
    expect(active()).toBe(true);
    leave();
    expect(active()).toBe(false);

    await (BridgeRegistry.get('joinGdmCall') as (type: unknown, id: unknown) => Promise<void>)('video', 'g-1');
    expect(active()).toBe(true);
    end();
    expect(active()).toBe(false);
  });

  it('applies started/joined server truth only to the active group', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    expect(document.querySelector('[title="Kamerayı aç/kapat"]')).toBeNull();

    await socket.trigger('gdm:call:started', { groupId: 'other', type: 'video' });
    await socket.trigger('gdm:call:joined', { groupId: '', type: 'video' });
    expect(document.querySelector('[title="Kamerayı aç/kapat"]')).toBeNull();

    await socket.trigger('gdm:call:started', { groupId: 'g-1', type: 'video' });
    expect(document.querySelector('[title="Kamerayı aç/kapat"]')).not.toBeNull();
    await socket.trigger('gdm:call:joined', { groupId: 'g-1', type: 'voice' });
    expect(document.querySelector('[title="Kamerayı aç/kapat"]')).toBeNull();
  });

  it('updates an existing peer without creating a second connection and removes it on peer-left', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'peer-meta', userId: 'u-1', displayName: 'First',
    });
    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'peer-meta', userId: 'u-2', displayName: 'Updated',
    });
    expect(FakePc.instances).toHaveLength(1);
    expect(document.querySelector('[data-gdm-peer="peer-meta"]')?.textContent).toContain('Updated');

    const pc = FakePc.instances[0]!;
    await socket.trigger('gdm:call:peer:left', { groupId: 'g-1', socketId: 'peer-meta' });
    expect(pc.close).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-gdm-peer="peer-meta"]')).toBeNull();
    await socket.trigger('gdm:call:peer:left', { groupId: 'other', socketId: 'peer-meta' });
    await socket.trigger('gdm:call:peer:left', { groupId: 'g-1', socketId: '' });
  });

  it('falls back to a receiver-owned MediaStream and forwards native candidates without toJSON', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'peer-fallback', displayName: 'Audio peer',
    });
    const pc = FakePc.instances[0]!;
    const audioTrack = { kind: 'audio', enabled: true, stop: vi.fn() } as unknown as MediaStreamTrack;
    pc.ontrack?.({ streams: [], track: audioTrack } as unknown as RTCTrackEvent);
    expect(document.querySelector('[data-gdm-peer="peer-fallback"] audio')).not.toBeNull();

    const candidate = { candidate: 'native-shape' };
    pc.onicecandidate?.({ candidate } as unknown as RTCPeerConnectionIceEvent);
    expect(socket.emitted).toContainEqual(expect.objectContaining({
      event: 'gdm:call:ice', payload: expect.objectContaining({ candidate }),
    }));
  });

  it('caps hostile early ICE floods before attaching candidates to a later peer', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    for (let i = 0; i < 140; i++) {
      await socket.trigger('gdm:call:ice', {
        groupId: 'g-1', fromSocketId: 'peer-flood', candidate: { candidate: `early-${i}` },
      });
    }
    await socket.trigger('gdm:call:offer', {
      groupId: 'g-1', fromSocketId: 'peer-flood', offer: { type: 'offer', sdp: 'remote' },
    });
    expect(FakePc.instances[0]!.addIceCandidate).toHaveBeenCalledTimes(128);
  });

  it('contains offer, answer, direct ICE, and pending ICE failures at their peer boundary', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:existing:peers', {
      groupId: 'g-1', peers: [{ socketId: 'bad-offer', displayName: 'Bad offer' }],
    });
    const outgoing = FakePc.instances[0]!;
    outgoing.createOffer.mockRejectedValueOnce(new Error('offer failed'));
    // A second event reuses the same peer and exercises the guarded offer path.
    await socket.trigger('gdm:call:existing:peers', {
      groupId: 'g-1', peers: [{ socketId: 'bad-offer', displayName: 'Bad offer' }],
    });
    expect(logMock.warn).toHaveBeenCalledWith('GDM offer oluşturulamadı', expect.any(Error));
    expect(outgoing.close).toHaveBeenCalled();

    await socket.trigger('gdm:call:offer', {
      groupId: 'g-1', fromSocketId: 'bad-remote-offer', offer: { type: 'offer', sdp: 'remote' },
    });
    const incoming = FakePc.instances.at(-1)!;
    // Re-enter with the existing peer so the failing remote description is observed.
    incoming.setRemoteDescription.mockRejectedValueOnce(new Error('remote offer failed'));
    await socket.trigger('gdm:call:offer', {
      groupId: 'g-1', fromSocketId: 'bad-remote-offer', offer: { type: 'offer', sdp: 'remote' },
    });
    expect(logMock.warn).toHaveBeenCalledWith('GDM offer işlenemedi', expect.any(Error));
    expect(incoming.close).toHaveBeenCalled();

    await socket.trigger('gdm:call:existing:peers', {
      groupId: 'g-1', peers: [{ socketId: 'bad-answer', displayName: 'Bad answer' }],
    });
    const answerPeer = FakePc.instances.at(-1)!;
    answerPeer.setRemoteDescription.mockRejectedValueOnce(new Error('answer failed'));
    await socket.trigger('gdm:call:answer', {
      groupId: 'g-1', fromSocketId: 'bad-answer', answer: { type: 'answer', sdp: 'answer' },
    });
    expect(logMock.warn).toHaveBeenCalledWith('GDM answer işlenemedi', expect.any(Error));
    expect(answerPeer.close).toHaveBeenCalled();
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);

    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'bad-ice', displayName: 'Bad ICE',
    });
    const icePeer = FakePc.instances.at(-1)!;
    icePeer.remoteDescription = { type: 'answer', sdp: 'set' };
    icePeer.addIceCandidate.mockRejectedValueOnce(new Error('ice failed'));
    await socket.trigger('gdm:call:ice', {
      groupId: 'g-1', fromSocketId: 'bad-ice', candidate: { candidate: 'direct' },
    });
    expect(logMock.warn).toHaveBeenCalledWith('GDM ICE adayı işlenemedi', expect.any(Error));

    icePeer.remoteDescription = null;
    await socket.trigger('gdm:call:ice', {
      groupId: 'g-1', fromSocketId: 'bad-ice', candidate: { candidate: 'pending' },
    });
    icePeer.addIceCandidate.mockRejectedValueOnce(new Error('pending failed'));
    await socket.trigger('gdm:call:answer', {
      groupId: 'g-1', fromSocketId: 'bad-ice', answer: { type: 'answer', sdp: 'answer' },
    });
    expect(logMock.warn).toHaveBeenCalledWith('GDM bekleyen ICE adayı işlenemedi', expect.any(Error));
  });

  it('ignores malformed or cross-group signaling without allocating peer state', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    const malformed: Array<[string, unknown]> = [
      ['gdm:call:existing:peers', null],
      ['gdm:call:existing:peers', { groupId: 'g-1', peers: [null, {}, { socketId: socket.id }] }],
      ['gdm:call:peer:joined', { groupId: 'other', socketId: 'peer' }],
      ['gdm:call:peer:joined', { groupId: 'g-1', socketId: '' }],
      ['gdm:call:offer', { groupId: 'g-1', fromSocketId: '', offer: {} }],
      ['gdm:call:answer', { groupId: 'g-1', fromSocketId: 'missing', answer: {} }],
      ['gdm:call:ice', { groupId: 'g-1', fromSocketId: 'missing' }],
      ['gdm:call:peer:state', { groupId: 'g-1', socketId: 'missing', muted: true }],
    ];
    for (const [event, payload] of malformed) await socket.trigger(event, payload);
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);
  });

  it('continues teardown when browser peer or track cleanup throws', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'fragile-peer', displayName: 'Fragile',
    });
    const pc = FakePc.instances[0]!;
    const remoteStop = vi.fn(() => { throw new Error('remote stop failed'); });
    pc.ontrack?.({
      streams: [{ getTracks: () => [{ stop: remoteStop }], getVideoTracks: () => [] }],
      track: { kind: 'audio' },
    } as unknown as RTCTrackEvent);
    pc.close.mockImplementationOnce(() => { throw new Error('close failed'); });
    tracks.audio.stop.mockImplementationOnce(() => { throw new Error('local stop failed'); });

    expect(() => mod.stopGroupDmVoice()).not.toThrow();
    expect(remoteStop).toHaveBeenCalled();
    expect(tracks.video.stop).toHaveBeenCalled();
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
  });

  it('uses fallback group metadata, reuses acquired media, and owns the UI leave control', async () => {
    BridgeRegistry.unregister('groupDmPanel:getCurrentGroup');
    await mod.startGroupDmVoice('voice', 'g-fallback');
    expect(document.getElementById('gdm-call-runtime')?.textContent).toContain('Grup Araması');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    await mod.startGroupDmVoice('voice', 'g-fallback');
    expect(getUserMedia).toHaveBeenCalledTimes(1);

    (document.querySelector('[title="Aramadan ayrıl"]') as HTMLButtonElement).click();
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
    expect(document.getElementById('gdm-call-runtime')).toBeNull();
  });

  it('contains missing media APIs and timer DOM races', async () => {
    const mediaDevices = navigator.mediaDevices;
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    await expect(mod.joinGroupDmVoice('voice', 'g-1')).resolves.toBeUndefined();
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: mediaDevices });

    vi.useFakeTimers();
    await mod.joinGroupDmVoice('voice', 'g-1');
    document.getElementById('gdm-call-elapsed')?.remove();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');
    mod.stopGroupDmVoice();
    vi.useRealTimers();
  });

  it('replaces pending incoming UI and clears its timer during call cleanup', async () => {
    vi.useFakeTimers();
    await socket.trigger('gdm:call:incoming', { groupId: 'g-first', callerDisplayName: '' });
    const first = document.getElementById('gdm-incoming-call');
    await socket.trigger('gdm:call:incoming', { groupId: 'g-second', callerDisplayName: null, type: 'video' });
    expect(first?.isConnected).toBe(false);
    expect(document.getElementById('gdm-incoming-call')?.textContent).toContain('Bir kullanıcı');
    mod.__gdmVoiceTestHooks.cleanupCall();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(document.getElementById('gdm-incoming-call')).toBeNull();
    vi.useRealTimers();
  });

  it('covers peer metadata fallbacks, closed state, absent peers, and pending ICE capacity', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'peer-meta-more', displayName: 'Named', avatarColor: '#abc',
    });
    const pc = FakePc.instances[0]!;
    await socket.trigger('gdm:call:peer:joined', {
      groupId: 'g-1', socketId: 'peer-meta-more', displayName: '',
    });
    expect(document.querySelector('[data-gdm-peer="peer-meta-more"]')?.textContent).toContain('Named');

    for (let i = 0; i < 140; i++) {
      await socket.trigger('gdm:call:ice', {
        groupId: 'g-1', fromSocketId: 'peer-meta-more', candidate: { candidate: `pending-${i}` },
      });
    }
    pc.connectionState = 'connected'; pc.onconnectionstatechange?.();
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(1);
    pc.connectionState = 'closed'; pc.onconnectionstatechange?.();
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);
    await socket.trigger('gdm:call:peer:left', { groupId: 'g-1', socketId: 'missing-peer' });
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);
  });

  it('falls back to generated descriptions when browsers leave localDescription null', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:existing:peers', {
      groupId: 'g-1', peers: [{ socketId: 'peer-offer-fallback', displayName: 'Offer' }],
    });
    const outgoing = FakePc.instances[0]!;
    outgoing.localDescription = null;
    outgoing.setLocalDescription.mockImplementationOnce(async () => undefined);
    await socket.trigger('gdm:call:existing:peers', {
      groupId: 'g-1', peers: [{ socketId: 'peer-offer-fallback', displayName: 'Offer' }],
    });
    expect(socket.emitted.at(-1)).toEqual(expect.objectContaining({
      event: 'gdm:call:offer', payload: expect.objectContaining({ offer: expect.objectContaining({ type: 'offer' }) }),
    }));

    await socket.trigger('gdm:call:offer', {
      groupId: 'g-1', fromSocketId: 'peer-answer-fallback', offer: { type: 'offer', sdp: 'remote' },
    });
    const incoming = FakePc.instances.at(-1)!;
    incoming.localDescription = null;
    incoming.setLocalDescription.mockImplementationOnce(async () => undefined);
    await socket.trigger('gdm:call:offer', {
      groupId: 'g-1', fromSocketId: 'peer-answer-fallback', offer: { type: 'offer', sdp: 'remote' },
    });
    expect(socket.emitted.at(-1)).toEqual(expect.objectContaining({
      event: 'gdm:call:answer', payload: expect.objectContaining({ answer: expect.objectContaining({ type: 'answer' }) }),
    }));
  });

  it('contains null event payloads and covers reconnect/lifecycle false branches', async () => {
    await mod.joinGroupDmVoice('voice', 'g-1');
    for (const event of [
      'gdm:call:started', 'gdm:call:incoming', 'gdm:call:joined', 'gdm:call:peer:joined',
      'gdm:call:peer:left', 'gdm:call:ended', 'gdm:call:left', 'gdm:call:offer',
      'gdm:call:answer', 'gdm:call:ice', 'gdm:call:peer:state',
    ]) await socket.trigger(event, null);
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');

    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    expect(socket.emitted.some(entry => entry.event === 'gdm:call:join')).toBe(true);
    socket.connected = false;
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    const before = socket.emitted.length;
    mod.stopGroupDmVoice();
    expect(socket.emitted).toHaveLength(before);

    mod.teardownGroupDmVoiceRuntime();
    mod.teardownGroupDmVoiceRuntime();
    mod.__gdmVoiceTestHooks.initializeRuntime();
    BridgeRegistry.unregister('groupDmPanel:getCurrentGroup');
    await (BridgeRegistry.get('startGdmCall') as (type: unknown, id: unknown) => Promise<void>)('voice', '');
    await (BridgeRegistry.get('joinGdmCall') as (type: unknown, id: unknown) => Promise<void>)('voice', '');
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
  });
});
