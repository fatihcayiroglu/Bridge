import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { mount, unmount } from 'svelte';

const { registryGet, toast, logWarn, logInfo, logDebug } = vi.hoisted(() => ({
  registryGet: vi.fn(),
  toast: vi.fn(),
  logWarn: vi.fn(),
  logInfo: vi.fn(),
  logDebug: vi.fn(),
}));
vi.mock('../js/core/bridge-registry.js', () => ({ BridgeRegistry: { get: registryGet } }));
vi.mock('../js/core/utils.ts', () => ({ toast }));
vi.mock('../js/core/logger.js', () => ({ createLogger: () => ({ warn: logWarn, info: logInfo, debug: logDebug, error: vi.fn() }) }));
// KANONİK SÖZLÜĞE DEVRET (reaktif sarmalayıcı yalnızca Svelte reaktifliği
// ekler; metin sahibi `i18n/index.ts`tir). Elle yazılmış çiftler yedek metni
// olmayan anahtarlarda ham anahtar döndürüyor ve `vars` yerleştirmesini
// düşürüyordu.
vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});

import VoiceScreenShareController from '../js/core/VoiceScreenShareController.svelte';

type Controller = {
  toggle(): void;
  openQualityPicker(): void;
  startWithQuality(q: string): Promise<void>;
  stopShare(): void;
  setRemoteStream(stream: MediaStream | null, sharer: string, ch: string): void;
  toggleFullscreen(): void;
  toggleMini(): void;
};

let target: HTMLDivElement;
const mounted: unknown[] = [];
function mountController(props: Record<string, unknown>): Controller {
  const instance = mount(VoiceScreenShareController, { target, props }) as unknown as Controller;
  mounted.push(instance);
  return instance;
}

beforeEach(() => {
  target = document.createElement('div'); document.body.appendChild(target);
  localStorage.clear(); document.body.innerHTML = ''; document.body.appendChild(target);
  for (const fn of [registryGet, toast, logWarn, logInfo, logDebug]) fn.mockReset();
});
afterEach(async () => {
  while (mounted.length) await unmount(mounted.pop() as never);
  vi.restoreAllMocks();
  localStorage.clear(); document.body.innerHTML = '';
});

describe('VoiceScreenShareController media/lifecycle owner', () => {
  it('fails closed outside voice and opens the quality picker when no default exists', async () => {
    const rtc = { isInVoice: vi.fn(() => false), startScreenShare: vi.fn(), stopScreenShare: vi.fn(), getLocalStream: vi.fn(() => null) };
    const c = mountController({ getRtc: () => rtc });
    c.openQualityPicker();
    await c.startWithQuality('high');
    expect(rtc.startScreenShare).not.toHaveBeenCalled();
    c.setRemoteStream(null, 'peer', 'ch');
    c.toggleMini(); c.toggleMini();
  });

  it('persists an explicit default, reports captured audio truth and applies bitrate to the live video sender', async () => {
    document.body.insertAdjacentHTML('beforeend', '<input id="ss-save-as-default" type="checkbox" checked><input id="ss-include-audio" type="checkbox" checked>');
    localStorage.setItem('bridgeSSQuality', JSON.stringify({ bitrateKbps: 2500 }));
    const params = { encodings: [{} as { maxBitrate?: number }] };
    const sender = { track: { kind: 'video' }, getParameters: vi.fn(() => params), setParameters: vi.fn(async () => undefined) };
    const started = vi.fn(); const stopped = vi.fn(); const registryStarted = vi.fn(); const registryStopped = vi.fn();
    registryGet.mockImplementation((key: string) => key === '_onScreenShareStarted' ? registryStarted : key === '_onScreenShareStopped' ? registryStopped : null);
    const rtc = {
      isInVoice: vi.fn(() => true),
      startScreenShare: vi.fn(async () => true),
      stopScreenShare: vi.fn(), getLocalStream: vi.fn(() => null), screenAudioActive: true,
      _pc: { getSenders: () => [sender] },
    };
    const c = mountController({ getRtc: () => rtc, onShareStarted: started, onShareStopped: stopped });
    await c.startWithQuality('high');
    expect(rtc.startScreenShare).toHaveBeenCalledWith('high', true);
    expect(JSON.parse(localStorage.getItem('bridgeSSQuality')!)).toEqual({ bitrateKbps: 2500, preset: 'high' });
    expect(params.encodings[0].maxBitrate).toBe(2_500_000);
    expect(sender.setParameters).toHaveBeenCalledWith(params);
    expect(toast).toHaveBeenCalledWith(t('ss_audio_shared'), 'success');
    expect(registryStarted).toHaveBeenCalledTimes(1); expect(started).toHaveBeenCalledTimes(1);
    c.toggle();
    expect(rtc.stopScreenShare).toHaveBeenCalledTimes(1);
    expect(registryStopped).toHaveBeenCalledTimes(1); expect(stopped).toHaveBeenCalledTimes(1);
  });

  it('contains failed capture/bitrate paths and owns fullscreen enter/exit safely', async () => {
    const failedRtc = { isInVoice: () => true, startScreenShare: vi.fn(async () => false), stopScreenShare: vi.fn(), getLocalStream: () => null };
    const c = mountController({ getRtc: () => failedRtc });
    await c.startWithQuality('low');
    expect(logWarn).toHaveBeenCalledWith(expect.objectContaining({ ss: 'start_failed', quality: 'low' }));

    const video = document.createElement('video'); video.id = 'ss-remote-video';
    const requestFullscreen = vi.fn(async () => undefined); Object.defineProperty(video, 'requestFullscreen', { configurable: true, value: requestFullscreen });
    document.body.appendChild(video);
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: null });
    c.toggleFullscreen(); await Promise.resolve(); expect(requestFullscreen).toHaveBeenCalledTimes(1);
    const exitFullscreen = vi.fn(async () => undefined); Object.defineProperty(document, 'exitFullscreen', { configurable: true, value: exitFullscreen });
    Object.defineProperty(document, 'fullscreenElement', { configurable: true, value: video });
    c.toggleFullscreen(); await Promise.resolve(); expect(exitFullscreen).toHaveBeenCalledTimes(1);
    video.remove(); c.toggleFullscreen();
  });

  it('stops an active share during component teardown', async () => {
    const rtc = { isInVoice: () => true, startScreenShare: vi.fn(async () => true), stopScreenShare: vi.fn(), getLocalStream: () => null };
    const c = mountController({ getRtc: () => rtc });
    await c.startWithQuality('medium');
    await unmount(mounted.pop() as never);
    expect(rtc.stopScreenShare).toHaveBeenCalledTimes(1);
  });
});
