// client/tests/channel-stage-panel-failures.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ChannelStagePanel.svelte — SESE KATILMA HATALARI VE DÜRÜST DURUMLAR
// ════════════════════════════════════════════════════════════════════════════
// Sahne, seçilen kanala göre metin/ses/desteklenmeyen görünümlerini sahiplenir.
// En kritik dal kümesi HATA yollarıdır: mikrofon reddi, cihaz yokluğu, güvensiz
// bağlam ve `leaveVoice` çökmesi.
//
// Bu dalların ölçülmesi gerekir çünkü hepsinin ortak alternatifi AYNI kusurdur:
// kullanıcı sonsuz "katılıyor" durumunda asılı kalır ve neden katılamadığını
// öğrenemez. Katılım denemesi başarısız olduğunda `joiningChannelId` HER ZAMAN
// temizlenmeli ve kullanıcıya SEBEBE ÖZGÜ bir mesaj gösterilmelidir.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/svelte';
import ChannelStagePanel from '../js/core/ChannelStagePanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.js';

interface Channel { _id: string; name?: string; type?: string }

let currentChannel: Channel | null = null;
let currentServer: { _id?: string } | null = null;
const toast = vi.fn();
const rtc = {
  currentChannelId: null as string | null,
  inVoice: false,
  isInVoice: vi.fn(() => rtc.inVoice),
  joinVoice: vi.fn(async (channelId: string) => { rtc.currentChannelId = channelId; rtc.inVoice = true; }),
  leaveVoice: vi.fn(() => { rtc.currentChannelId = null; rtc.inVoice = false; }),
};

function select(channel: Channel | null): Promise<void> {
  currentChannel = channel;
  return act(() => {
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: channel?._id } }));
  });
}

function mountStage() {
  for (const id of ['text-view', 'voice-view', 'voice-panel']) {
    const node = document.createElement('div');
    node.id = id;
    node.style.display = id === 'text-view' ? 'flex' : 'none';
    document.body.appendChild(node);
  }
  return render(ChannelStagePanel);
}

const stageKind = () => BridgeRegistry.call<string>('getStageKind');
const stageText = () => document.querySelector('.stage-state__body')?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const stageTitle = () => document.querySelector('.stage-state__title')?.textContent?.trim() ?? '';

beforeEach(() => {
  currentChannel = null;
  currentServer = { _id: 'server-1' };
  rtc.currentChannelId = null;
  rtc.inVoice = false;
  vi.clearAllMocks();
  rtc.joinVoice.mockImplementation(async (channelId: string) => { rtc.currentChannelId = channelId; rtc.inVoice = true; });
  rtc.leaveVoice.mockImplementation(() => { rtc.currentChannelId = null; rtc.inVoice = false; });

  BridgeRegistry.register('getCurrentChannel', () => currentChannel);
  BridgeRegistry.register('getCurrentServer', () => currentServer);
  BridgeRegistry.register('rtc', rtc as never);
  BridgeRegistry.register('toast', toast as never);
  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true, writable: true, value: class RTCPeerConnectionStub {},
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  for (const key of ['getCurrentChannel', 'getCurrentServer', 'rtc', 'toast', 'getStageKind', 'syncChannelStage']) {
    BridgeRegistry.unregister(key);
  }
  document.body.innerHTML = '';
});

describe('join failures never strand the user', () => {
  it.each([
    ['NotAllowedError', 'Mikrofon izni verilmedi'],
    ['SecurityError', 'Mikrofon izni verilmedi'],
    ['NotFoundError', 'Mikrofon bulunamadı'],
    ['AbortError', 'Sesli kanala katılınamadı'],
  ])('explains a %s failure specifically', async (name, expected) => {
    rtc.joinVoice.mockImplementation(async () => {
      const error = new Error('join failed');
      error.name = name;
      throw error;
    });
    mountStage();
    await select({ _id: 'voice-a', name: 'Lounge', type: 'voice' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith(expect.stringContaining(expected), 'error'));

    // Katılım başarısız oldu ama sahne yine de ses sahnesi olarak kalır ve
    // yeni bir deneme mümkün olur — bileşen "katılıyor" durumunda kilitlenmez.
    rtc.joinVoice.mockImplementation(async (channelId: string) => { rtc.currentChannelId = channelId; rtc.inVoice = true; });
    await select({ _id: 'voice-a', name: 'Lounge', type: 'voice' });
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledTimes(2));
  });

  it('reports a rejection that carries no error name', async () => {
    rtc.joinVoice.mockRejectedValue({ reason: 'unknown' });
    mountStage();
    await select({ _id: 'voice-a', type: 'voice' });
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Sesli kanala katılınamadı.', 'error'));
  });

  it('does not attempt to join when the current server cannot be resolved', async () => {
    currentServer = null;
    mountStage();
    await select({ _id: 'voice-a', type: 'voice' });
    expect(rtc.joinVoice).not.toHaveBeenCalled();
    expect(stageKind()).toBe('voice');
  });

  it('survives a leaveVoice implementation that throws while switching channels', async () => {
    mountStage();
    await select({ _id: 'voice-a', type: 'voice' });
    await waitFor(() => expect(rtc.inVoice).toBe(true));

    rtc.leaveVoice.mockImplementation(() => { throw new Error('transport already closed'); });
    await select({ _id: 'text-a', type: 'text' });
    // Çıkış hatası sahne yönlendirmesini durdurmaz.
    await waitFor(() => expect(stageKind()).toBe('text'));
  });

  it('leaves voice and resets the stage when the session is logged out', async () => {
    mountStage();
    await select({ _id: 'voice-a', type: 'voice' });
    await waitFor(() => expect(rtc.inVoice).toBe(true));

    rtc.leaveVoice.mockClear();
    await act(() => { document.dispatchEvent(new CustomEvent('bridge:auth-logout')); });
    await waitFor(() => expect(stageKind()).toBe('none'));
    expect(rtc.leaveVoice).toHaveBeenCalled();
    expect(document.getElementById('text-view')!.style.display).toBe('flex');
    expect(document.getElementById('voice-view')!.style.display).toBe('none');
    expect(document.getElementById('voice-panel')!.style.display).toBe('none');
  });
});

describe('honest stage states', () => {
  it('announces an unsupported channel type and names the type when known', async () => {
    mountStage();
    // `forum` ARTIK desteklenen bir tiptir (ForumChannelPanel canli olarak
    // monte edilir), bu yuzden "desteklenmeyen tip" ornegi olarak kullanilamaz.
    // Sozlesme hala gecerli: GERCEKTEN bilinmeyen bir tip durustce bildirilir.
    await select({ _id: 'weird-1', name: 'deneysel', type: 'holo-deck' });
    await waitFor(() => expect(stageKind()).toBe('unsupported'));
    expect(stageTitle()).toBe('#deneysel');
    expect(stageText()).toContain('holo-deck');
  });

  it('falls back to generic labels when the unsupported channel has no name or type', async () => {
    mountStage();
    await select({ _id: 'weird-2', type: 'holo-deck' });
    await waitFor(() => expect(stageKind()).toBe('unsupported'));
    expect(stageTitle()).toBe('Kanal');
  });

  it('says voice is unavailable when the browser cannot run WebRTC at all', async () => {
    Object.defineProperty(globalThis, 'RTCPeerConnection', { configurable: true, writable: true, value: undefined });
    mountStage();
    await select({ _id: 'voice-a', name: 'Lounge', type: 'voice' });
    await waitFor(() => expect(stageTitle()).toBe('#Lounge'));
    expect(stageText()).toContain('HTTPS');
    expect(rtc.joinVoice).not.toHaveBeenCalled();
  });

  it('falls back to a generic voice title when the channel has no name', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: {} });
    mountStage();
    await select({ _id: 'voice-a', type: 'voice' });
    await waitFor(() => expect(stageTitle()).toBe('Sesli kanal'));
  });

  it('treats an announcement channel as a text stage', async () => {
    mountStage();
    await select({ _id: 'ann-1', name: 'duyuru', type: 'announcement' });
    await waitFor(() => expect(stageKind()).toBe('text'));
    expect(document.querySelector('.stage-state')).toBeNull();
  });

  it('treats a channel with no declared type as text', async () => {
    mountStage();
    await select({ _id: 'plain-1', name: 'genel' });
    await waitFor(() => expect(stageKind()).toBe('text'));
  });

  it('carries the channel name in the voice-joined announcement', async () => {
    const joined = vi.fn();
    document.addEventListener('bridge:voice-joined', joined);
    mountStage();
    await select({ _id: 'voice-a', name: 'Lounge', type: 'voice' });
    await waitFor(() => expect(joined).toHaveBeenCalled());
    expect((joined.mock.calls[0]![0] as CustomEvent).detail)
      .toEqual({ channelId: 'voice-a', channelName: 'Lounge' });
    document.removeEventListener('bridge:voice-joined', joined);
  });

  it('announces an empty name when the joined voice channel has none', async () => {
    const joined = vi.fn();
    document.addEventListener('bridge:voice-joined', joined);
    mountStage();
    await select({ _id: 'voice-b', type: 'voice' });
    await waitFor(() => expect(joined).toHaveBeenCalled());
    expect((joined.mock.calls[0]![0] as CustomEvent).detail)
      .toEqual({ channelId: 'voice-b', channelName: '' });
    document.removeEventListener('bridge:voice-joined', joined);
  });
});
