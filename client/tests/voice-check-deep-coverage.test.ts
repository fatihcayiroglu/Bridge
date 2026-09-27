import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { tick } from 'svelte';
import VoiceCheckPanel from '../js/core/VoiceCheckPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import type { VoiceDiagnosticsSnapshot } from '../js/core/voice-diagnostics.ts';

const mocks = vi.hoisted(() => ({
  collect: vi.fn(),
  buildReport: vi.fn(() => 'sanitized local report'),
  warn: vi.fn(),
  info: vi.fn(),
}));

vi.mock('../js/core/voice-diagnostics.ts', () => ({
  collectVoiceDiagnostics: mocks.collect,
}));

vi.mock('../js/core/voice-echo-report.ts', () => ({
  buildEchoReport: mocks.buildReport,
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ warn: mocks.warn, info: mocks.info, error: vi.fn(), debug: vi.fn() }),
}));

function snapshot(overrides: Partial<VoiceDiagnosticsSnapshot> = {}): VoiceDiagnosticsSnapshot {
  return {
    rtcAvailable: true,
    mediaApiAvailable: true,
    microphonePermission: 'granted',
    microphoneDetected: true,
    microphoneTrackLive: true,
    outputDetected: true,
    inputDeviceLabel: 'Studio <Mic>',
    outputDeviceLabel: 'USB Speaker',
    selectedInputUnavailable: false,
    selectedOutputUnavailable: false,
    inVoice: true,
    signalingConnected: true,
    peerCount: 2,
    connectionState: 'connected',
    iceState: 'completed',
    latencyMs: 44,
    packetLossPercent: 1.5,
    appliedAudioSource: 'call',
    appliedAudio: {
      supported: true,
      trackLive: true,
      microphone: { deviceId: 'mic-1', label: 'Studio <Mic>' },
      audio: {
        sampleRate: 48_000,
        sampleSize: 16,
        channelCount: 2,
        echoCancellation: true,
        noiseSuppression: false,
        autoGainControl: 'unknown',
      },
    },
    connectionQuality: {
      quality: 'poor',
      latencyMs: 450,
      jitterMs: null,
      packetLossPercent: 8,
      packetsSent: 12,
      packetsReceived: 10,
      sampledPeers: 2,
    },
    ...overrides,
  };
}

function installNavigator(options: {
  getUserMedia?: ReturnType<typeof vi.fn>;
  clipboard?: ReturnType<typeof vi.fn>;
} = {}): void {
  vi.stubGlobal('navigator', {
    language: 'tr-TR',
    userAgent: 'VoiceCheckTest',
    platform: 'TestOS',
    mediaDevices: {
      getUserMedia: options.getUserMedia ?? vi.fn(async () => new MediaStream()),
      enumerateDevices: vi.fn(async () => []),
    },
    permissions: { query: vi.fn(async () => ({ state: 'granted' })) },
    clipboard: { writeText: options.clipboard ?? vi.fn(async () => undefined) },
  });
}

async function mountOpen() {
  const rendered = render(VoiceCheckPanel);
  await tick();
  BridgeRegistry.get<() => void>('openVoiceCheck')?.();
  await tick();
  await Promise.resolve();
  await tick();
  return rendered;
}

beforeEach(() => {
  mocks.collect.mockReset().mockResolvedValue(snapshot());
  mocks.buildReport.mockReset().mockReturnValue('sanitized local report');
  mocks.warn.mockReset();
  mocks.info.mockReset();
  installNavigator();
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 17));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  BridgeRegistry.unregister('rtc');
  BridgeRegistry.unregister('openVoiceCheck');
  BridgeRegistry.unregister('closeVoiceCheck');
  BridgeRegistry.register('rtc', { selectedMicId: 'mic-1' } as unknown as AnyFn);
});

afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('rtc');
  BridgeRegistry.unregister('openVoiceCheck');
  BridgeRegistry.unregister('closeVoiceCheck');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Voice Check deep state and security behavior', () => {
  it('renders measured quality and applied settings without treating unknown values as good', async () => {
    const { container } = await mountOpen();
    const text = container.textContent ?? '';

    expect(text).toContain('Studio <Mic>');
    expect(text).toContain('USB Speaker');
    expect(text).toContain('44 ms');
    expect(text).toContain('%1.5');
    expect(text).toContain('Zayıf');
    expect(text).toContain('450 ms');
    expect(text).toContain('Ölçülemiyor');
    expect(text).toContain('Açık');
    expect(text).toContain('Kapalı');
    expect(text).toContain('Tarayıcı bildirmiyor');
    expect(text).toContain('48000 Hz');
    expect(text).toContain('Tarayıcı şunları uygulamadı: gürültü bastırma.');
    expect(text).toContain('Varsayılan olmayan bir çıkış cihazı seçili.');
    expect(text).toContain('Kaynak: canlı arama akışı.');
    expect(container.querySelector('.vcheck-details img')).toBeNull();
    expect(container.innerHTML).not.toContain('<mic>');
  });

  it('renders proxy, unsupported, dead-track, and unknown connection states truthfully across refreshes', async () => {
    mocks.collect
      .mockResolvedValueOnce(snapshot({
        outputDeviceLabel: 'Varsayılan çıkış',
        outputDetected: null,
        signalingConnected: null,
        connectionState: undefined,
        iceState: undefined,
        latencyMs: undefined,
        packetLossPercent: undefined,
        appliedAudioSource: 'mic-test',
        appliedAudio: {
          ...snapshot().appliedAudio,
          supported: false,
          trackLive: false,
        },
        connectionQuality: {
          quality: 'unknown', latencyMs: null, jitterMs: null,
          packetLossPercent: null, packetsSent: null, packetsReceived: null, sampledPeers: 0,
        },
      }))
      .mockResolvedValueOnce(snapshot({
        appliedAudioSource: 'none',
        appliedAudio: { ...snapshot().appliedAudio, supported: true, trackLive: false },
        inVoice: false,
      }));

    const { container, getByRole } = await mountOpen();
    expect(container.textContent).toContain('Tarayıcı raporlamıyor');
    expect(container.textContent).toContain('Kaynak: mikrofon testi akışı');
    expect(container.textContent).toContain('Bu tarayıcı uygulanan ayarları bildirmiyor.');
    expect(container.textContent).toContain('Ölçülemiyor');

    await fireEvent.click(getByRole('button', { name: 'Yenile' }));
    await Promise.resolve();
    await tick();
    expect(container.textContent).toContain('Canlı bir mikrofon akışı yok');
    expect(container.textContent).toContain('Ses kanalında değil');
    expect(container.textContent).not.toContain('Kaynak: canlı arama akışı.');
  });

  it('copies only the generated local report and preserves it in logs when clipboard permission fails', async () => {
    const writeText = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('clipboard denied'));
    installNavigator({ clipboard: writeText });
    const { getByRole } = await mountOpen();
    const copy = getByRole('button', { name: 'Yankı raporunu kopyala' });

    await fireEvent.click(copy);
    await tick();
    expect(writeText).toHaveBeenCalledWith('sanitized local report');
    expect(getByRole('button', { name: 'Kopyalandı ✓' })).toBeTruthy();

    await fireEvent.click(getByRole('button', { name: 'Kopyalandı ✓' }));
    await tick();
    expect(mocks.warn).toHaveBeenCalledWith('Rapor panoya kopyalanamadı', expect.any(Error));
    expect(mocks.info).toHaveBeenCalledWith('sanitized local report');
    expect(getByRole('button', { name: 'Konsola yazıldı' })).toBeTruthy();
  });

  it('discards a stale refresh and refreshes only while visible on canonical voice events', async () => {
    let resolveFirst!: (value: VoiceDiagnosticsSnapshot) => void;
    const stale = new Promise<VoiceDiagnosticsSnapshot>(resolve => { resolveFirst = resolve; });
    mocks.collect
      .mockReturnValueOnce(stale)
      .mockResolvedValueOnce(snapshot({ connectionState: 'failed' }));

    const rendered = render(VoiceCheckPanel);
    await tick();
    BridgeRegistry.get<() => void>('openVoiceCheck')?.();
    document.dispatchEvent(new CustomEvent('bridge:voice-joined'));
    await Promise.resolve();
    await tick();
    expect(rendered.container.textContent).toContain('Eş bağlantısı kurulamadı');

    resolveFirst(snapshot({ connectionState: 'connected' }));
    await Promise.resolve();
    await tick();
    expect(rendered.container.textContent).toContain('Eş bağlantısı kurulamadı');

    BridgeRegistry.get<() => void>('closeVoiceCheck')?.();
    document.dispatchEvent(new CustomEvent('bridge:voice-left'));
    await tick();
    expect(mocks.collect).toHaveBeenCalledTimes(2);
  });

  it('closes via Escape and overlay, while inner-panel clicks do not dismiss it', async () => {
    const { container } = await mountOpen();
    const overlay = container.querySelector('.vcheck-overlay') as HTMLElement;
    const panel = container.querySelector('.vcheck-panel') as HTMLElement;

    await fireEvent.click(panel);
    expect(container.querySelector('[role="dialog"]')).toBeTruthy();
    await fireEvent.keyDown(window, { key: 'Escape' });
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();

    BridgeRegistry.get<() => void>('openVoiceCheck')?.();
    await Promise.resolve();
    await tick();
    await fireEvent.click(container.querySelector('.vcheck-overlay') as HTMLElement);
    await tick();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
    expect(overlay.isConnected).toBe(false);
  });
});

describe('Voice Check microphone state machine', () => {
  it.each([
    ['NotAllowedError', 'Mikrofon izni engellendi.'],
    ['SecurityError', 'Mikrofon izni engellendi.'],
    ['NotFoundError', 'Seçili giriş cihazı kullanılamıyor.'],
    ['OverconstrainedError', 'Seçili giriş cihazı kullanılamıyor.'],
    ['NotReadableError', 'Mikrofona erişilemiyor; başka bir uygulama kullanıyor olabilir.'],
    ['AbortError', 'Mikrofon testi başlatılamadı.'],
  ])('maps %s media denial to an actionable local error', async (name, message) => {
    const error = new Error(name);
    error.name = name;
    installNavigator({ getUserMedia: vi.fn(async () => { throw error; }) });
    const { container, getByRole } = await mountOpen();

    await fireEvent.click(getByRole('button', { name: 'Testi başlat' }));
    await Promise.resolve();
    await tick();
    expect(container.textContent).toContain('Test başarısız');
    expect(container.textContent).toContain(message);
  });

  it('reports an unsupported media API without requesting or inventing a stream', async () => {
    vi.stubGlobal('navigator', {
      language: 'tr-TR',
      mediaDevices: {},
      clipboard: { writeText: vi.fn() },
    });
    const { container, getByRole } = await mountOpen();
    await fireEvent.click(getByRole('button', { name: 'Testi başlat' }));
    await Promise.resolve();
    await tick();
    expect(container.textContent).toContain('Mikrofon testi başlatılamadı.');
  });

  it('stops an acquired owned stream when audio analysis is unavailable', async () => {
    const stop = vi.fn();
    const stream = {
      getTracks: () => [{ stop }],
      getAudioTracks: () => [],
    } as unknown as MediaStream;
    installNavigator({ getUserMedia: vi.fn(async () => stream) });
    vi.stubGlobal('AudioContext', undefined);
    vi.stubGlobal('webkitAudioContext', undefined);
    const { container, getByRole } = await mountOpen();

    await fireEvent.click(getByRole('button', { name: 'Testi başlat' }));
    await Promise.resolve();
    await tick();
    expect(stop).toHaveBeenCalledOnce();
    expect(container.textContent).toContain('Mikrofon testi başlatılamadı.');
  });

  it.each([
    [132, 'Sinyal algılandı'],
    [128, 'Sinyal algılanmadı'],
  ])('settles the eight-second meter honestly for sample level %i', async (sample, outcome) => {
    const stop = vi.fn();
    const track = { kind: 'audio', readyState: 'live', enabled: true, stop } as unknown as MediaStreamTrack;
    const stream = new MediaStream([track]);
    installNavigator({ getUserMedia: vi.fn(async () => stream) });
    const close = vi.fn(async () => undefined);
    class AudioContextMock {
      createAnalyser() {
        return {
          fftSize: 8,
          getByteTimeDomainData: (values: Uint8Array) => values.fill(sample),
        };
      }
      createMediaStreamSource() { return { connect: vi.fn() }; }
      close = close;
    }
    vi.stubGlobal('AudioContext', AudioContextMock);
    const timeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const { container, getByRole } = await mountOpen();

    await fireEvent.click(getByRole('button', { name: 'Testi başlat' }));
    await Promise.resolve();
    await tick();
    const settle = timeoutSpy.mock.calls.find(call => call[1] === 8_000)?.[0] as (() => void) | undefined;
    expect(settle).toBeTypeOf('function');
    settle?.();
    await tick();

    expect(container.textContent).toContain(outcome);
    expect(stop).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });
});

describe('Voice Check operational edge matrix', () => {
  it('renders unsupported APIs, unavailable outputs, and disconnected signaling as separate actions', async () => {
    mocks.collect
      .mockResolvedValueOnce(snapshot({
        mediaApiAvailable: false,
        microphonePermission: 'granted',
        microphoneDetected: false,
        selectedInputUnavailable: false,
        selectedOutputUnavailable: true,
        outputDetected: false,
        outputDeviceLabel: 'Varsayılan çıkış',
        inVoice: true,
        signalingConnected: false,
        connectionState: 'connecting',
      }))
      .mockResolvedValueOnce(snapshot({
        mediaApiAvailable: true,
        microphonePermission: 'granted',
        microphoneDetected: false,
        selectedInputUnavailable: true,
        selectedOutputUnavailable: false,
        outputDetected: false,
        outputDeviceLabel: 'Varsayılan çıkış',
        inVoice: true,
        signalingConnected: true,
        connectionState: undefined,
        peerCount: 0,
      }))
      .mockResolvedValueOnce(snapshot({
        mediaApiAvailable: true,
        microphonePermission: 'granted',
        microphoneDetected: false,
        selectedInputUnavailable: false,
        selectedOutputUnavailable: false,
        outputDetected: false,
        outputDeviceLabel: 'Varsayılan çıkış',
        inVoice: true,
        signalingConnected: true,
        connectionState: 'connecting',
        peerCount: 1,
      }));

    const { container, getByRole } = await mountOpen();
    expect(container.textContent).toContain('Tarayıcı desteklemiyor');
    expect(container.textContent).toContain('Seçili çıkış cihazı kullanılamıyor.');
    expect(container.textContent).toContain('Sinyal bağlantısı kapalı');
    expect(container.textContent).toContain('Ses kanalındasınız ancak signaling bağlantısı kapalı.');
    expect(container.textContent).not.toContain('Varsayılan olmayan bir çıkış cihazı seçili.');

    await fireEvent.click(getByRole('button', { name: 'Yenile' }));
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(2));
    await tick();
    expect(container.textContent).toContain('Seçili giriş cihazı kullanılamıyor.');
    expect(container.textContent).toContain('Algılanmadı');
    expect(container.textContent).toContain('Signaling bağlı · henüz eş yok');

    await fireEvent.click(getByRole('button', { name: 'Yenile' }));
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(3));
    await tick();
    expect(container.textContent).toContain('Kullanılabilir mikrofon algılanmadı.');
    expect(container.textContent).toContain('Bağlantı: connecting');
  });

  it('replaces the refresh interval and never refreshes from a closed-panel callback', async () => {
    const callbacks: Array<() => void> = [];
    const realSetInterval = globalThis.setInterval;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
      if (delay !== 2_000) return realSetInterval(callback, delay, ...args);
      callbacks.push(callback as () => void);
      return (callbacks.length + 40) as unknown as ReturnType<typeof setInterval>;
    }) as typeof setInterval);
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);
    const rendered = render(VoiceCheckPanel);
    await tick();
    const open = BridgeRegistry.get<() => void>('openVoiceCheck') as () => void;
    const close = BridgeRegistry.get<() => void>('closeVoiceCheck') as () => void;

    open();
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(1));
    open();
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(2));
    expect(interval.mock.calls.filter(call => call[1] === 2_000)).toHaveLength(2);
    expect(clear).toHaveBeenCalledWith(41);

    callbacks[1]?.();
    await waitFor(() => expect(mocks.collect).toHaveBeenCalledTimes(3));
    close();
    const callsAfterClose = mocks.collect.mock.calls.length;
    callbacks[1]?.();
    await Promise.resolve();
    expect(mocks.collect).toHaveBeenCalledTimes(callsAfterClose);
    await fireEvent.keyDown(window, { key: 'Enter' });
    expect(rendered.container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('omits a device constraint for the default microphone and ignores a stopped meter frame', async () => {
    const stop = vi.fn();
    const track = { kind: 'audio', readyState: 'live', enabled: true, stop } as unknown as MediaStreamTrack;
    const stream = new MediaStream([track]);
    const getUserMedia = vi.fn(async () => stream);
    installNavigator({ getUserMedia });
    BridgeRegistry.register('rtc', {
      selectedMicId: null, localStream: null, peers: new Map(), socket: { connected: true },
    } as unknown as AnyFn);

    let nextFrame: FrameRequestCallback | undefined;
    const requestFrame = vi.fn((callback: FrameRequestCallback) => {
      nextFrame = callback;
      return 29;
    });
    vi.stubGlobal('requestAnimationFrame', requestFrame);
    class AudioContextMock {
      createAnalyser() {
        return { fftSize: 8, getByteTimeDomainData: (values: Uint8Array) => values.fill(132) };
      }
      createMediaStreamSource() { return { connect: vi.fn() }; }
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal('AudioContext', AudioContextMock);
    const { getByRole } = await mountOpen();

    await fireEvent.click(getByRole('button', { name: 'Testi başlat' }));
    await waitFor(() => expect(getByRole('button', { name: 'Testi durdur' })).toBeTruthy());
    expect(getUserMedia).toHaveBeenCalledWith({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: false,
    });
    expect(requestFrame).toHaveBeenCalledOnce();

    await fireEvent.click(getByRole('button', { name: 'Testi durdur' }));
    nextFrame?.(0);
    expect(requestFrame).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledOnce();
  });
});
