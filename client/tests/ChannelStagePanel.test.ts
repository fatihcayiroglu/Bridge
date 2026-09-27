// Faz 8.3 — production ChannelStagePanel regression matrix.
// Tests mount the real Svelte owner; only browser/registry boundaries are controlled.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/svelte';
import { mount, unmount } from 'svelte';
import ChannelStagePanel from '../js/core/ChannelStagePanel.svelte';
import VoicePanel from '../js/core/VoicePanel.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.js';

interface Channel { _id: string; name: string; type?: string }

let currentChannel: Channel | null = null;
const rtc = {
  currentChannelId: null as string | null,
  inVoice: false,
  isInVoice: vi.fn(() => rtc.inVoice),
  joinVoice: vi.fn(async (channelId: string) => {
    rtc.currentChannelId = channelId;
    rtc.inVoice = true;
  }),
  leaveVoice: vi.fn(() => {
    rtc.currentChannelId = null;
    rtc.inVoice = false;
  }),
};

function text(id = 'text-a', name = 'general'): Channel {
  return { _id: id, name, type: 'text' };
}

function voice(id = 'voice-a', name = 'Lounge'): Channel {
  return { _id: id, name, type: 'voice' };
}

function select(channel: Channel | null): Promise<void> {
  currentChannel = channel;
  return act(() => {
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', {
      detail: { channelId: channel?._id },
    }));
  });
}

function stageKind(): string | undefined {
  return BridgeRegistry.call<string>('getStageKind');
}

function mountStage() {
  const textView = document.createElement('div');
  textView.id = 'text-view';
  textView.style.display = 'flex';
  document.body.appendChild(textView);

  const voiceView = document.createElement('div');
  voiceView.id = 'voice-view';
  voiceView.style.display = 'none';
  document.body.appendChild(voiceView);

  return render(ChannelStagePanel);
}

beforeEach(() => {
  currentChannel = null;
  rtc.currentChannelId = null;
  rtc.inVoice = false;
  vi.clearAllMocks();

  BridgeRegistry.register('getCurrentChannel', () => currentChannel);
  BridgeRegistry.register('getCurrentServer', () => ({ _id: 'server-1' }));
  BridgeRegistry.register('rtc', rtc as never);
  BridgeRegistry.register('BridgeRTC', (() => undefined) as never);

  Object.defineProperty(globalThis, 'RTCPeerConnection', {
    configurable: true,
    writable: true,
    value: class RTCPeerConnectionStub {},
  });
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: vi.fn() },
  });
});

afterEach(() => {
  cleanup();
  for (const key of [
    'getCurrentChannel', 'getCurrentServer', 'rtc', 'BridgeRTC', 'toast',
    'getStageKind', 'syncChannelStage',
  ]) BridgeRegistry.unregister(key);
  document.body.innerHTML = '';
});

describe('ChannelStagePanel — routing and safe states', () => {
  it('no selected channel keeps the safe text/welcome stage', async () => {
    mountStage();
    await waitFor(() => expect(stageKind()).toBe('none'));
    expect(document.getElementById('text-view')).toHaveStyle({ display: 'flex' });
    expect(document.getElementById('voice-view')).toHaveStyle({ display: 'none' });
  });

  it('text channel owns the message stage without joining voice', async () => {
    currentChannel = text();
    mountStage();
    await waitFor(() => expect(stageKind()).toBe('text'));
    expect(document.getElementById('text-view')).toHaveStyle({ display: 'flex' });
    expect(rtc.joinVoice).not.toHaveBeenCalled();
  });

  it('voice channel owns the voice stage and joins the canonical rtc instance', async () => {
    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledWith('voice-a', 'server-1'));
    expect(stageKind()).toBe('voice');
    expect(document.getElementById('text-view')).toHaveStyle({ display: 'none' });
    expect(document.getElementById('voice-view')).toHaveStyle({ display: 'flex' });
  });

  it('stage kanali KENDI oturumuna yonlenir, sese ZORLANMAZ', async () => {
    // Bu test eskiden stage kanalinin voice'a esitlenmesini bekliyordu.
    // Uretim bunu BILEREK ayirdi (ChannelStagePanel.svelte: "`stage` artik
    // voice ile ayni medya oturumuna zorlanmaz"): stage'in kendi
    // `StageSessionPanel` yuzeyi var. Bir stage kanalini secmek artik
    // kullanicinin mikrofonunu sessizce ACMAZ — dogru davranis budur.
    const { container } = mountStage();
    await select({ _id: 'stage-a', name: 'Town Hall', type: 'stage' });
    await waitFor(() => expect(stageKind()).toBe('stage'));
    expect(rtc.joinVoice).not.toHaveBeenCalled();
    // Eski (kaldirilmis) stage denetimleri geri gelmemelidir.
    expect(container.querySelector('#stage-speakers')).toBeNull();
    expect(container.querySelector('#stage-hand-btn')).toBeNull();
  });

  it('stage routing leaves canonical channel-header identity ownership intact', async () => {
    const headerName = document.createElement('span');
    headerName.id = 'ch-h-name';
    headerName.textContent = 'Town Hall';
    document.body.appendChild(headerName);
    mountStage();
    await select({ _id: 'stage-a', name: 'Town Hall', type: 'stage' });
    expect(headerName).toHaveTextContent('Town Hall');
    expect(document.querySelector('#stage-title')).toBeNull();
  });

  it('unsupported channel renders an honest safe state and does not join voice', async () => {
    const view = mountStage();
    const panel = mount(VoicePanel, { target: document.getElementById('voice-view')!, props: {} });
    // `forum` ARTIK desteklenir; "desteklenmeyen" ornegi gercekten bilinmeyen
    // bir tip olmalidir.
    await select({ _id: 'weird-a', name: 'Ideas', type: 'holo-deck' });
    expect(stageKind()).toBe('unsupported');
    expect(view.getByText(/bu sürümde desteklenmiyor/i)).toBeInTheDocument();
    expect(document.getElementById('voice-panel')).toHaveStyle({ display: 'none' });
    expect(rtc.joinVoice).not.toHaveBeenCalled();
    await unmount(panel);
  });

  it('missing voice browser capability renders the safe unavailable state', async () => {
    Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
    const { getByText } = mountStage();
    await select(voice());
    expect(getByText(/bu tarayıcıda kullanılamıyor/i)).toBeInTheDocument();
    expect(rtc.joinVoice).not.toHaveBeenCalled();
  });

  it('BridgeRTC class alone is not mistaken for the canonical rtc instance', async () => {
    BridgeRegistry.unregister('rtc');
    const { getByText } = mountStage();
    await select(voice());
    expect(getByText(/bu tarayıcıda kullanılamıyor/i)).toBeInTheDocument();
  });
});

describe('ChannelStagePanel — switching and duplicate guards', () => {
  it('text A→text B→text A stays on the message stage', async () => {
    mountStage();
    await select(text('a', 'a'));
    await select(text('b', 'b'));
    await select(text('a', 'a'));
    expect(stageKind()).toBe('text');
    expect(document.getElementById('text-view')).toHaveStyle({ display: 'flex' });
    expect(rtc.joinVoice).not.toHaveBeenCalled();
  });

  it('same text channel reselect remains a safe no-op', async () => {
    mountStage();
    await select(text());
    await select(text());
    expect(stageKind()).toBe('text');
    expect(rtc.joinVoice).not.toHaveBeenCalled();
    expect(rtc.leaveVoice).not.toHaveBeenCalled();
  });

  it('voice A→voice B leaves A before joining B', async () => {
    mountStage();
    await select(voice('voice-a'));
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledTimes(1));
    await select(voice('voice-b'));
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledTimes(2));
    expect(rtc.leaveVoice).toHaveBeenCalledTimes(1);
    expect(rtc.joinVoice.mock.calls.map(([id]) => id)).toEqual(['voice-a', 'voice-b']);
  });

  it('rapid switching leaves the settled UI truthful and does not duplicate a join', async () => {
    let resolveFirst!: () => void;
    rtc.joinVoice.mockImplementationOnce(async (channelId: string) => {
      rtc.currentChannelId = channelId;
      rtc.inVoice = true;
      await new Promise<void>(resolve => { resolveFirst = resolve; });
    });
    mountStage();
    await act(() => {
      currentChannel = voice('voice-a');
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      currentChannel = text('text-b');
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      currentChannel = voice('voice-c');
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    });
    expect(rtc.joinVoice).toHaveBeenCalledTimes(1);
    resolveFirst();
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(stageKind()).toBe('voice'));
    expect(document.getElementById('voice-view')).toHaveStyle({ display: 'flex' });
    expect(rtc.leaveVoice).toHaveBeenCalledTimes(1);
    expect(rtc.joinVoice.mock.calls.filter(([id]) => id === 'voice-c')).toHaveLength(1);
    expect(rtc.currentChannelId).toBe('voice-c');
  });

  it('same voice channel reselect while join is in flight produces one join', async () => {
    let resolveJoin!: () => void;
    rtc.joinVoice.mockImplementationOnce(() => new Promise<void>(resolve => { resolveJoin = resolve; }));
    mountStage();
    currentChannel = voice();
    await act(() => {
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
      document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    });
    expect(rtc.joinVoice).toHaveBeenCalledTimes(1);
    resolveJoin();
    await act();
  });

  it('same joined voice channel reselect produces no duplicate join', async () => {
    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledTimes(1));
    await select(voice());
    expect(rtc.joinVoice).toHaveBeenCalledTimes(1);
    expect(rtc.leaveVoice).not.toHaveBeenCalled();
  });

  it('voice→text leaves voice exactly once', async () => {
    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.inVoice).toBe(true));
    await select(text());
    expect(rtc.leaveVoice).toHaveBeenCalledTimes(1);
    expect(stageKind()).toBe('text');
  });

  it('voice→text→voice joins each voice visit and remains leak-free', async () => {
    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledTimes(1));
    await select(text());
    await select(voice());
    await waitFor(() => expect(rtc.joinVoice).toHaveBeenCalledTimes(2));
    expect(rtc.leaveVoice).toHaveBeenCalledTimes(1);
    expect(rtc.currentChannelId).toBe('voice-a');
  });
});

describe('ChannelStagePanel — ownership and cleanup', () => {
  it('uses one voice shell, one VoicePanel root, and unique control IDs', async () => {
    mountStage();
    const shell = document.getElementById('voice-view')!;
    const panel = mount(VoicePanel, { target: shell, props: {} });
    await select(voice());
    expect(document.querySelectorAll('#voice-view')).toHaveLength(1);
    expect(document.querySelectorAll('#voice-panel')).toHaveLength(1);
    expect(document.getElementById('voice-panel')).toHaveStyle({ display: 'flex' });
    for (const id of ['vc-mute', 'vc-deafen', 'vc-video', 'vc-screen']) {
      expect(document.querySelectorAll(`#${id}`)).toHaveLength(1);
    }
    await unmount(panel);
  });

  it('unmount while joined leaves voice and unregisters stage ownership', async () => {
    const view = mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.inVoice).toBe(true));
    view.unmount();
    expect(rtc.leaveVoice).toHaveBeenCalledTimes(1);
    expect(BridgeRegistry.has('getStageKind')).toBe(false);
    expect(BridgeRegistry.has('syncChannelStage')).toBe(false);
  });

  it('theme changes do not alter stage kind or voice membership', async () => {
    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.inVoice).toBe(true));
    document.documentElement.dataset.theme = 'midnight';
    document.dispatchEvent(new CustomEvent('bridge:theme-changed', { detail: { theme: 'midnight' } }));
    expect(stageKind()).toBe('voice');
    expect(rtc.joinVoice).toHaveBeenCalledTimes(1);
    expect(document.getElementById('voice-view')).toHaveStyle({ display: 'flex' });
  });

  it('logout leaves voice and restores a private-state-safe shell', async () => {
    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.inVoice).toBe(true));
    await act(() => document.dispatchEvent(new CustomEvent('bridge:auth-logout')));
    expect(rtc.leaveVoice).toHaveBeenCalledTimes(1);
    expect(stageKind()).toBe('none');
    expect(document.getElementById('text-view')).toHaveStyle({ display: 'flex' });
    expect(document.getElementById('voice-view')).toHaveStyle({ display: 'none' });
  });

  it('does not claim MessageLoader, draft, reply, or delivery ownership', () => {
    mountStage();
    for (const key of [
      'loadMessages', 'getDraft', 'setDraft', 'startReply', 'sendMessage',
      'appendMessage', 'replaceMessage',
    ]) expect(BridgeRegistry.has(key), key).toBe(false);
  });

  it('stage transitions preserve independent draft, reply, and MessageLoader owners', async () => {
    const getDraft = vi.fn(() => 'yarım mesaj');
    const setReplyTarget = vi.fn();
    const loadMessages = vi.fn();
    BridgeRegistry.register('getDraft', getDraft);
    BridgeRegistry.register('setReplyTarget', setReplyTarget);
    BridgeRegistry.register('loadMessages', loadMessages);

    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.inVoice).toBe(true));
    await select(text());

    expect(BridgeRegistry.call('getDraft', 'text-a')).toBe('yarım mesaj');
    BridgeRegistry.call('setReplyTarget', { _id: 'message-1' });
    BridgeRegistry.call('loadMessages', 'text-a');
    expect(setReplyTarget).toHaveBeenCalledWith({ _id: 'message-1' });
    expect(loadMessages).toHaveBeenCalledWith('text-a');

    BridgeRegistry.unregister('getDraft');
    BridgeRegistry.unregister('setReplyTarget');
    BridgeRegistry.unregister('loadMessages');
  });

  it('reconnect notification does not invent joined UI or duplicate voice join', async () => {
    mountStage();
    await select(voice());
    await waitFor(() => expect(rtc.inVoice).toBe(true));
    await act(() => document.dispatchEvent(new CustomEvent('bridge:socket-ready')));
    expect(rtc.joinVoice).toHaveBeenCalledTimes(1);
    expect(stageKind()).toBe('voice');
  });

  it('cancelled in-flight join does not resurrect joined UI after disconnect', async () => {
    let resolveJoin!: () => void;
    rtc.joinVoice.mockImplementationOnce(() => new Promise<void>(resolve => { resolveJoin = resolve; }));
    const joined = vi.fn();
    document.addEventListener('bridge:voice-joined', joined);
    mountStage();

    currentChannel = voice();
    await act(() => document.dispatchEvent(new CustomEvent('bridge:channel-selected')));
    expect(rtc.joinVoice).toHaveBeenCalledTimes(1);

    // Production RTC has already handled the disconnect and truthfully reset
    // these values before its cancelled join promise settles.
    rtc.inVoice = false;
    rtc.currentChannelId = null;
    resolveJoin();
    await act();

    expect(joined).not.toHaveBeenCalled();
    expect(rtc.inVoice).toBe(false);
    document.removeEventListener('bridge:voice-joined', joined);
  });
});
