// client/tests/group-dm-voice-teardown-races.test.ts
import { t } from '../js/core/i18n/index.ts';
// Beklentiler SOZLUKTEN turetilir: bu metinler artik cevrilidir
// (Ingilizce yedekler yalnizca anahtar yoksa gorunur).

//
// ════════════════════════════════════════════════════════════════════════════
// core/group-dm-voice.ts — ARAMA BİTTİKTEN SONRA GELEN GİRDİLER
// ════════════════════════════════════════════════════════════════════════════
// Arama arayüzü, çağrı sona erdiğinde SÖKÜLÜR. Ama kullanıcının parmağı
// düğmenin üzerindedir: "sustur"a tam kapanma anında basmak gerçek bir
// yarıştır. O anda `_localStream` ve `_activeGroupId` artık YOKTUR.
//
// Bu yolun çökmemesi yeterli değildir — HİÇBİR ŞEY YAPMAMALIDIR. Sökülmüş bir
// aramanın mikrofon durumunu değiştirmeye çalışmak, bir sonraki aramada
// kullanıcının kapalı sandığı mikrofonla açılmasına yol açardı.
//
// İkinci sınıf: kimlik doğrulama. Grup kimliği bir DOM/olay verisidir;
// geçersiz bir kimlikle arama kurulmaya BAŞLANMAMALIDIR — aksi hâlde sunucuya
// anlamsız bir oda açılır ve kullanıcı "arama başlamadı" ile baş başa kalır.
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
  emitted: Array<{ event: string; payload: unknown }> = [];
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
  constructor() { FakePc.instances.push(this); }
}

let mod: typeof import('../js/core/group-dm-voice.ts');
let socket: FakeSocket;
const toast = vi.fn();

const runtime = () => document.getElementById('gdm-call-runtime');
const buttonBy = (title: string) =>
  [...(runtime()?.querySelectorAll('button') ?? [])].find(
    b => b.title === title || b.getAttribute('aria-label') === title) as HTMLButtonElement | undefined;

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
  getUserMedia.mockClear();
  apiFetchMock.mockReset();
  apiFetchMock.mockResolvedValue({ ok: false, json: async () => ({}) } as never);
  toast.mockClear();
  tracks.audio.enabled = true; tracks.video.enabled = true;
  document.body.innerHTML = '';
  socket.connected = true;
  BridgeRegistry.register('socket', socket as never);
  BridgeRegistry.register('toast', toast as never);
  BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => ({ _id: 'g-1', name: 'Runtime Group' })) as never);
  mod.__gdmVoiceTestHooks.resetIceConfig();
  mod.__gdmVoiceTestHooks.initializeRuntime();
  mod.__gdmVoiceTestHooks.bindSocket(socket as never);
});

describe('controls pressed after the call is torn down', () => {
  it('does not touch tracks or redraw when mute is pressed on a dead call', async () => {
    await mod.startGroupDmVoice('video', 'g-1');
    const mic = buttonBy('Mikrofonu aç/kapat')!;
    const camera = buttonBy('Kamerayı aç/kapat')!;
    expect(mic).toBeTruthy();

    // Kullanıcı "sustur"a basarken arama tam o anda kapanır.
    mod.__gdmVoiceTestHooks.cleanupCall();
    expect(runtime()).toBeNull();

    expect(() => mic.click()).not.toThrow();
    expect(() => camera.click()).not.toThrow();

    // Sökülmüş arama YENİDEN ÇİZİLMEZ; ölü bir arayüz geri gelmemelidir.
    expect(runtime()).toBeNull();
    // Yerel akış yok: hiçbir track durumu değiştirilmedi.
    expect(tracks.audio.enabled).toBe(true);
    expect(tracks.video.enabled).toBe(true);
  });
});

describe('group identity is validated before any call is opened', () => {
  it.each([
    ['an empty id', ''],
    ['a non-string id', 42 as unknown as string],
    ['an over-long id', 'x'.repeat(65)],
  ])('starting with %s refuses outright when no group is open either', async (_label, groupId) => {
    // `startGroupDmVoice` AÇIK gruba geri düşer (düğme bağlamından çağrılır).
    // Geri düşecek grup da yoksa arama KURULMAZ; sunucuya boş oda açılmaz.
    BridgeRegistry.register('groupDmPanel:getCurrentGroup', (() => null) as never);
    await mod.startGroupDmVoice('voice', groupId);
    expect(toast).toHaveBeenCalledWith(t('gdm_select_group_first'), 'warning');
    expect(socket.emitted).toHaveLength(0);
    expect(getUserMedia).not.toHaveBeenCalled();
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBeNull();
  });

  it('starting with an unusable id falls back to the group already on screen', async () => {
    // Geri düşüş SESSİZ bir kabul değildir: kullanıcının BAKTIĞI grup açılır.
    await mod.startGroupDmVoice('voice', '');
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');
    expect(socket.emitted).toContainEqual({ event: 'gdm:call:start', payload: { groupId: 'g-1', type: 'voice' } });
  });

  it.each([
    ['an over-long id', 'x'.repeat(65)],
    ['a non-string id', 42 as unknown as string],
  ])('refuses to start with %s even when a group is open, once the id is rejected downstream', async (_label, groupId) => {
    // Geçerli görünmeyen kimlik geri düşüşe girer; açık grup kullanılır.
    await mod.startGroupDmVoice('voice', groupId);
    expect(mod.__gdmVoiceTestHooks.activeGroupId()).toBe('g-1');
  });

  it.each([
    ['an empty id', ''],
    ['an over-long id', 'x'.repeat(65)],
  ])('refuses to join with %s', async (_label, groupId) => {
    await mod.joinGroupDmVoice('voice', groupId);
    expect(toast).toHaveBeenCalledWith(t('gdm_invalid_call'), 'error');
    expect(socket.emitted).toHaveLength(0);
  });
});

describe('peers arriving with incomplete identity', () => {
  it('labels a peer that reports no display name instead of rendering nothing', async () => {
    await mod.startGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', { groupId: 'g-1', socketId: 'peer-a', userId: 'u-a' });

    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(1);
    // Adsız katılımcı için kanonik yedek görünür; "undefined" YAZILMAZ.
    const text = runtime()!.textContent ?? '';
    expect(text).toContain(t('gdm_unknown_user'));
    expect(text).not.toContain('undefined');
  });

  it('ignores a peer announcement addressed to a different group', async () => {
    await mod.startGroupDmVoice('voice', 'g-1');
    await socket.trigger('gdm:call:peer:joined', { groupId: 'g-2', socketId: 'peer-b', userId: 'u-b' });
    expect(mod.__gdmVoiceTestHooks.peerCount()).toBe(0);
  });
});
