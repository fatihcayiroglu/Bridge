import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, tick, unmount } from 'svelte';

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('../js/core/voice/ptt-settings.ts', () => ({
  PTT_CHANGED_EVENT: 'bridge:ptt-changed',
  loadPttSettings: mocks.load,
  savePttSettings: mocks.save,
}));
vi.mock('../js/core/logger.js', () => ({ createLogger: () => ({ debug: mocks.debug, info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));

import VoicePTTController from '../js/core/VoicePTTController.svelte';

type Controller = {
  setEnabled(on: boolean): void;
  setMode(mode: 'hold' | 'toggle'): void;
  setReleaseDelay(ms: number): void;
  clearKey(): void;
  getStatus(): { enabled: boolean; mode: 'hold' | 'toggle'; key: null | { code: string; label: string }; releaseDelay: number; active: boolean };
  isCapturing(): boolean;
  startCapture(): void;
  stopCapture(): void;
};

let host: HTMLDivElement;
let instance: Controller | null = null;
let setMuted: ReturnType<typeof vi.fn>;
let isInVoice: ReturnType<typeof vi.fn>;
let onStatusChange: ReturnType<typeof vi.fn>;

function renderController(settings: any = { enabled: false, mode: 'hold', key: { code: 'KeyV', label: 'V' }, releaseDelay: 200 }): Controller {
  mocks.load.mockReturnValue(settings);
  return mount(VoicePTTController, {
    target: host,
    props: { getRtc: () => ({ isInVoice, setMuted }), onStatusChange },
  }) as unknown as Controller;
}

beforeEach(() => {
  vi.useFakeTimers();
  mocks.load.mockReset(); mocks.save.mockReset(); mocks.debug.mockReset();
  // Match the real persistence owner's synchronous contract: save writes the
  // value that the controller will read back, then broadcasts the change.
  // A no-op save leaves load() returning stale state, which makes the
  // controller correctly self-heal back to that stale value and invalidates
  // every mutation this behavior suite is trying to exercise.
  mocks.save.mockImplementation((settings: any) => {
    mocks.load.mockReturnValue({
      ...settings,
      key: settings.key ? { ...settings.key } : null,
    });
    document.dispatchEvent(new CustomEvent('bridge:ptt-changed'));
  });
  setMuted = vi.fn(); isInVoice = vi.fn(() => true); onStatusChange = vi.fn();
  host = document.createElement('div'); document.body.appendChild(host);
});

afterEach(async () => {
  if (instance) await unmount(instance as unknown as Record<string, unknown>);
  instance = null; host.remove(); vi.useRealTimers();
});

function key(type: 'keydown' | 'keyup', init: KeyboardEventInit): KeyboardEvent {
  const event = new KeyboardEvent(type, { bubbles: true, cancelable: true, ...init });
  document.dispatchEvent(event);
  return event;
}

describe('VoicePTTController deep runtime behavior', () => {
  it('loads settings and enforces hold PTT with repeat/input guards plus delayed release', async () => {
    instance = renderController();
    await tick();
    expect(instance.getStatus()).toEqual({ enabled: false, mode: 'hold', key: { code: 'KeyV', label: 'V' }, releaseDelay: 200, active: false });

    instance.setEnabled(true);
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: true }));
    expect(setMuted).toHaveBeenCalledWith(true);

    const input = document.createElement('input'); document.body.appendChild(input); input.focus();
    key('keydown', { code: 'KeyV', key: 'v' });
    expect(setMuted).not.toHaveBeenCalledWith(false);
    input.remove();

    key('keydown', { code: 'KeyX', key: 'x' });
    key('keydown', { code: 'KeyV', key: 'v', repeat: true });
    expect(setMuted).not.toHaveBeenCalledWith(false);

    const down = key('keydown', { code: 'KeyV', key: 'v' });
    expect(down.defaultPrevented).toBe(true);
    expect(setMuted).toHaveBeenCalledWith(false);
    expect(instance.getStatus().active).toBe(true);
    key('keydown', { code: 'KeyV', key: 'v' }); // already active: no duplicate unmute
    expect(setMuted.mock.calls.filter(c => c[0] === false)).toHaveLength(1);

    key('keyup', { code: 'KeyX', key: 'x' });
    key('keyup', { code: 'KeyV', key: 'v' });
    expect(instance.getStatus().active).toBe(true);
    vi.advanceTimersByTime(199); expect(instance.getStatus().active).toBe(true);
    vi.advanceTimersByTime(1); expect(setMuted).toHaveBeenLastCalledWith(true);
    expect(instance.getStatus().active).toBe(false);
  });

  it('handles toggle mode, voice-joined privacy mute, no-voice guards and mode transitions', async () => {
    instance = renderController({ enabled: true, mode: 'toggle', key: { code: 'Space', label: 'Space' }, releaseDelay: 0 });
    await tick();
    document.dispatchEvent(new Event('bridge:voice-joined'));
    expect(setMuted).toHaveBeenCalledWith(true);

    key('keydown', { code: 'Space', key: ' ' });
    expect(setMuted).toHaveBeenLastCalledWith(false);
    key('keydown', { code: 'Space', key: ' ' });
    expect(setMuted).toHaveBeenLastCalledWith(true);

    key('keydown', { code: 'Space', key: ' ' });
    expect(instance.getStatus().active).toBe(true);
    instance.setMode('hold');
    expect(setMuted).toHaveBeenLastCalledWith(true);
    expect(instance.getStatus().mode).toBe('hold');

    isInVoice.mockReturnValue(false);
    const calls = setMuted.mock.calls.length;
    key('keydown', { code: 'Space', key: ' ' });
    expect(setMuted).toHaveBeenCalledTimes(calls);
    instance.setEnabled(false);
    document.dispatchEvent(new Event('bridge:voice-joined'));
    expect(setMuted).toHaveBeenCalledTimes(calls);
  });

  it('captures modifier labels, supports Escape/idempotent capture and clearKey/release-delay persistence', async () => {
    instance = renderController(); await tick();
    expect(instance.isCapturing()).toBe(false);
    instance.startCapture(); instance.startCapture();
    expect(instance.isCapturing()).toBe(true);
    const captured = key('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, shiftKey: true });
    expect(captured.defaultPrevented).toBe(true);
    expect(instance.isCapturing()).toBe(false);
    expect(instance.getStatus().key).toEqual({ code: 'KeyK', label: 'Ctrl+Shift+K' });
    expect(mocks.save).toHaveBeenLastCalledWith(expect.objectContaining({ key: { code: 'KeyK', label: 'Ctrl+Shift+K' } }));

    instance.setReleaseDelay(0);
    expect(instance.getStatus().releaseDelay).toBe(0);
    instance.setEnabled(true);
    key('keydown', { code: 'KeyK', key: 'k', ctrlKey: true, shiftKey: true });
    expect(instance.getStatus().active).toBe(true);
    instance.clearKey();
    expect(instance.getStatus().key).toBeNull();
    expect(setMuted).toHaveBeenLastCalledWith(true);

    instance.startCapture();
    key('keydown', { code: 'Escape', key: 'Escape' });
    expect(instance.isCapturing()).toBe(false);
    instance.stopCapture(); // idempotent
  });

  it('self-heals external persisted changes without event loops and mutes an active session when disabled', async () => {
    const initial = { enabled: true, mode: 'toggle', key: { code: 'KeyV', label: 'V' }, releaseDelay: 100 };
    instance = renderController(initial); await tick();
    key('keydown', { code: 'KeyV', key: 'v' });
    expect(instance.getStatus().active).toBe(true);

    mocks.load.mockReturnValue({ enabled: false, mode: 'hold', key: { code: 'KeyB', label: 'B' }, releaseDelay: 350 });
    const saveCalls = mocks.save.mock.calls.length;
    document.dispatchEvent(new Event('bridge:ptt-changed'));
    expect(setMuted).toHaveBeenLastCalledWith(true);
    expect(instance.getStatus()).toEqual({ enabled: false, mode: 'hold', key: { code: 'KeyB', label: 'B' }, releaseDelay: 350, active: false });
    expect(mocks.save).toHaveBeenCalledTimes(saveCalls); // no write-back loop

    onStatusChange.mockClear();
    document.dispatchEvent(new Event('bridge:ptt-changed')); // identical external state
    expect(onStatusChange).not.toHaveBeenCalled();
  });
});
