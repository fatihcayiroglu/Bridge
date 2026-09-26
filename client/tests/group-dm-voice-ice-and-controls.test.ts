// client/tests/group-dm-voice-ice-and-controls.test.ts
import { t } from '../js/core/i18n/index.ts';
// Beklentiler SOZLUKTEN turetilir: bu metinler artik cevrilidir
// (Ingilizce yedekler yalnizca anahtar yoksa gorunur).

//
// ════════════════════════════════════════════════════════════════════════════
// core/group-dm-voice.ts — ICE YAPILANDIRMA GERİ DÜŞÜŞÜ VE ARAMA KONTROLLERİ
// ════════════════════════════════════════════════════════════════════════════
// ICE yapılandırması bir OPTİMİZASYON sınırıdır: sunucu TURN listesi veremezse
// arama başlamamalı DEĞİL, güvenli genel STUN yedeğiyle devam etmelidir. Aksi
// hâlde tek bir yapılandırma hatası tüm grup aramalarını durdururdu.
//
// Buna karşılık `iceTransportPolicy` KATI okunur: yalnızca `'relay'` relay
// anlamına gelir; tanınmayan bir değer sessizce relay'e zorlamaz (bu, gizlilik
// beklentisiyle çelişirdi) ve `'all'` olarak normalize edilir.
//
// Arama kontrolleri (mikrofon/kamera/kapat) yerel track'leri gerçekten
// değiştirmeli ve durumu KARŞI TARAFA bildirmelidir; yalnızca simge değiştiren
// bir düğme, kullanıcının kapalı sandığı mikrofonla konuşmasına yol açar.
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
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

const tracks = { audio: { enabled: true, stop: vi.fn() }, video: { enabled: true, stop: vi.fn() } };
const stream = {
  getTracks: () => [tracks.audio, tracks.video],
  getAudioTracks: () => [tracks.audio],
  getVideoTracks: () => [tracks.video],
} as unknown as MediaStream;
const getUserMedia = vi.fn(async () => stream);

class FakePc {
  static instances: FakePc[] = [];
  static config: RTCConfiguration | undefined;
  localDescription: RTCSessionDescriptionInit | null = null;
  connectionState: RTCPeerConnectionState = 'new';
  onicecandidate: ((ev: RTCPeerConnectionIceEvent) => unknown) | null = null;
  ontrack: ((ev: RTCTrackEvent) => unknown) | null = null;
  onconnectionstatechange: (() => unknown) | null = null;
  addTrack = vi.fn();
  addIceCandidate = vi.fn(async () => undefined);
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'offer-sdp' } as RTCSessionDescriptionInit));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'answer-sdp' } as RTCSessionDescriptionInit));
  setLocalDescription = vi.fn(async (d: RTCSessionDescriptionInit) => { this.localDescription = d; });
  setRemoteDescription = vi.fn(async () => undefined);
  close = vi.fn(() => { this.connectionState = 'closed'; });
  constructor(config?: RTCConfiguration) { FakePc.config = config; FakePc.instances.push(this); }
}

let mod: typeof import('../js/core/group-dm-voice.ts');
let socket: FakeSocket;
const toast = vi.fn();

const runtime = () => document.getElementById('gdm-call-runtime');
const buttons = () => [...(runtime()?.querySelectorAll('button') ?? [])] as HTMLButtonElement[];
const buttonBy = (title: string) => buttons().find(button => button.title === title || button.getAttribute('aria-label') === title);

beforeAll(async () => {
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  vi.stubGlobal('RTCPeerConnection', FakePc as unknown as typeof RTCPeerConnection);
  socket = new FakeSocket();
  BridgeRegistry.register('socket', socket as never);
  BridgeRegistry.register('toast', toast as never);
  BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => ({ _id: 'g-1', name: 'Runtime Group' })) as never);
  mod = await import('../js/core/group-dm-voice.ts');
});

beforeEach(() => {
  mod.__gdmVoiceTestHooks.cleanupCall();
  socket.emitted.length = 0;
  FakePc.instances.length = 0;
  FakePc.config = undefined;
  getUserMedia.mockClear();
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ok: false, json: async () => ({}) } as never);
  toast.mockClear();
  tracks.audio.enabled = true; tracks.video.enabled = true;
  tracks.audio.stop.mockClear(); tracks.video.stop.mockClear();
  document.body.innerHTML = '';
  socket.connected = true;
  BridgeRegistry.register('socket', socket as never);
  BridgeRegistry.register('toast', toast as never);
  BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => ({ _id: 'g-1', name: 'Runtime Group' })) as never);
  mod.__gdmVoiceTestHooks.resetIceConfig();
  mod.__gdmVoiceTestHooks.initializeRuntime();
  mod.__gdmVoiceTestHooks.bindSocket(socket as never);
});

describe('ICE configuration is an optimisation, never a gate', () => {
  // Yapılandırma OTURUM BAŞINA BİR KEZ yüklenir; her dalı ölçebilmek için
  // `resetIceConfig` kancasıyla tek seferlik durum her testte sıfırlanır.
  it.each([
    ['a refused response', { ok: false, json: async () => ({}) }],
    ['an empty server list', { ok: true, json: async () => ({ iceServers: [] }) }],
    ['a non-array server list', { ok: true, json: async () => ({ iceServers: 'turn:relay' }) }],
    ['a body with no ICE field at all', { ok: true, json: async () => ({}) }],
  ])('still starts the call after %s', async (_label, response) => {
    apiFetchMock.mockResolvedValueOnce(response as never);
    await mod.startGroupDmVoice('voice', 'g-1');
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:start', payload: { groupId: 'g-1', type: 'voice' } });
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');
  });

  it('applies a relay policy exactly as the server declared it', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ iceServers: [{ urls: 'turn:relay.example' }], iceTransportPolicy: 'relay' }),
    } as never);
    await mod.startGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', { groupId: 'g-1', socketId: 'peer-a', userId: 'u-a', displayName: 'A' });
    expect(FakePc.config?.iceTransportPolicy).toBe('relay');
  });

  it('normalises an unrecognised transport policy to all rather than silently forcing relay', async () => {
    apiFetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ iceServers: [{ urls: 'stun:stun.example' }], iceTransportPolicy: 'proxy-only' }),
    } as never);
    await mod.startGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', { groupId: 'g-1', socketId: 'peer-a', userId: 'u-a', displayName: 'A' });
    expect(apiFetchMock).toHaveBeenCalledWith('/api/rtc/ice-config');
    expect(FakePc.config?.iceTransportPolicy).toBe('all');
    expect(FakePc.config?.iceServers).toEqual([{ urls: 'stun:stun.example' }]);
  });

  it('never re-fetches the configuration within one session', async () => {
    apiFetchMock.mockResolvedValue({ ok: true, json: async () => ({ iceServers: [{ urls: 'stun:a' }] }) } as never);
    await mod.startGroupDmVoice('voice', 'g-1');
    mod.stopGroupDmVoice();
    await mod.startGroupDmVoice('voice', 'g-1');
    expect(apiFetchMock.mock.calls.filter(call => String(call[0]).includes('ice-config'))).toHaveLength(1);
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:start', payload: { groupId: 'g-1', type: 'voice' } });
  });

  it('logs a rejected configuration request and still starts on the safe fallback', async () => {
    apiFetchMock.mockRejectedValueOnce(new Error('offline'));
    logMock.warn.mockClear();
    await mod.startGroupDmVoice('voice', 'g-1');
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:start', payload: { groupId: 'g-1', type: 'voice' } });
    expect(logMock.warn).toHaveBeenCalledWith(expect.stringContaining('ICE config'), expect.any(Error));
  });
});

describe('call start guards', () => {
  it('refuses to join a malformed group id before touching the microphone', async () => {
    await mod.joinGroupDmVoice('voice', '');
    await mod.joinGroupDmVoice('voice', 'x'.repeat(65));
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(toast).toHaveBeenCalledWith(t('gdm_invalid_call'), 'error');
  });

  it('starting with no explicit id falls back to the open group, and warns when there is none', async () => {
    await mod.startGroupDmVoice('voice');
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');

    mod.stopGroupDmVoice();
    BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => null) as never);
    toast.mockClear();
    await mod.startGroupDmVoice('voice');
    expect(toast).toHaveBeenCalledWith(t('gdm_select_group_first'), 'warning');
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
  });

  it('refuses to start a second call while another one is live', async () => {
    await mod.startGroupDmVoice('voice', 'g-1');
    toast.mockClear();
    await mod.startGroupDmVoice('voice', 'g-2');
    expect(toast).toHaveBeenCalledWith(t('gdm_leave_current_call'), 'warning');
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');
  });
});

describe('in-call controls act on the real tracks', () => {
  it('mutes and unmutes the local audio track and announces the state each time', async () => {
    await mod.startGroupDmVoice('voice', 'g-1');
    socket.emitted.length = 0;

    const mic = buttonBy('Mikrofonu aç/kapat')!;
    mic.click();
    expect(tracks.audio.enabled).toBe(false);
    expect(socket.emitted).toContainEqual({
      event: 'gdm:call:state', payload: { groupId: 'g-1', muted: true, video: false },
    });

    buttonBy('Mikrofonu aç/kapat')!.click();
    expect(tracks.audio.enabled).toBe(true);
    expect(socket.emitted.at(-1)).toEqual({
      event: 'gdm:call:state', payload: { groupId: 'g-1', muted: false, video: false },
    });
  });

  it('exposes a camera control only in a video call and toggles the real video track', async () => {
    await mod.startGroupDmVoice('voice', 'g-1');
    expect(buttonBy('Kamerayı aç/kapat')).toBeUndefined();

    mod.stopGroupDmVoice();
    await mod.startGroupDmVoice('video', 'g-1');
    socket.emitted.length = 0;
    const camera = buttonBy('Kamerayı aç/kapat')!;
    camera.click();
    expect(tracks.video.enabled).toBe(false);
    expect(socket.emitted.at(-1)).toEqual({
      event: 'gdm:call:state', payload: { groupId: 'g-1', muted: false, video: false },
    });
  });

  it('stops every local track and removes the runtime surface when the call ends', async () => {
    await mod.startGroupDmVoice('video', 'g-1');
    expect(runtime()).not.toBeNull();
    mod.stopGroupDmVoice();
    expect(tracks.audio.stop).toHaveBeenCalled();
    expect(tracks.video.stop).toHaveBeenCalled();
    expect(runtime()).toBeNull();
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
  });
});

describe('peer tile rendering', () => {
  it('labels a peer with no display name and dims a muted one', async () => {
    await mod.startGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', { groupId: 'g-1', socketId: 'peer-a', userId: 'u-a' });
    await socket.trigger('gdm:call:peer:state', { groupId: 'g-1', socketId: 'peer-a', muted: true, video: false });

    const text = runtime()?.textContent ?? '';
    expect(text).toContain(t('gdm_unknown_user'));
    const dimmed = [...(runtime()?.querySelectorAll('span') ?? [])]
      .some(node => (node as HTMLElement).style.opacity === '0.55');
    expect(dimmed).toBe(true);
  });
});

