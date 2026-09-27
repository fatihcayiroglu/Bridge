import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import DevicesTab from '../js/core/settings/tabs/DevicesTab.svelte';

// The tab reaches the live voice session through the canonical registry
// module. (It used to read `window.BridgeRegistry`, which production never
// sets — these tests used to install that global and hid the defect.)
const registry = vi.hoisted(() => ({ call: vi.fn() }));
vi.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    call: (...args: unknown[]) => registry.call(...args),
    get: vi.fn(() => null), has: vi.fn(() => false), register: vi.fn(), unregister: vi.fn(),
  },
}));

function track() {
  return { stop: vi.fn() } as unknown as MediaStreamTrack;
}

function stream(...tracks: MediaStreamTrack[]) {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

function device(kind: MediaDeviceKind, deviceId: string, label = ''): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}

function makeStore(setDevicePreference = vi.fn(), error: string | null = null) {
  return { save: vi.fn(), setDevicePreference, error } as any;
}

let getUserMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let registryCall: ReturnType<typeof vi.fn>;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  registryCall = registry.call; registryCall.mockReset();
  getUserMedia = vi.fn();
  enumerateDevices = vi.fn();
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia, enumerateDevices },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DevicesTab production owner behavior', () => {
  it('acquires permission briefly, stops it, partitions devices and renders safe fallback labels', async () => {
    const permissionTrack = track();
    getUserMedia.mockResolvedValueOnce(stream(permissionTrack));
    enumerateDevices.mockResolvedValue([
      device('audioinput', 'mic-1', 'Studio Mic'),
      device('audioinput', 'mic-2'),
      device('audiooutput', 'spk-1', 'Desk Speakers'),
      device('videoinput', 'cam-1'),
    ]);

    render(DevicesTab, { props: { store: makeStore() } });

    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());
    expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
    expect(permissionTrack.stop).toHaveBeenCalledTimes(1);
    expect(document.querySelectorAll('#mic-select option')).toHaveLength(3);
    expect(document.querySelector('#mic-select')?.textContent).toContain('Studio Mic');
    expect(document.querySelector('#mic-select')?.textContent).toContain('Mikrofon 2');
    expect(document.querySelector('#speaker-select')?.textContent).toContain('Desk Speakers');
    expect(document.querySelector('#camera-select')?.textContent).toContain('Kamera 1');
  });

  it('fails closed on permission denial and Retry can recover without crashing the settings surface', async () => {
    getUserMedia.mockRejectedValueOnce(new DOMException('denied', 'NotAllowedError'));
    enumerateDevices.mockResolvedValue([]);

    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('[role="alert"]')).not.toBeNull());
    expect(document.body.textContent).toContain('Mikrofon iznine ihtiyaç');

    const permissionTrack = track();
    getUserMedia.mockResolvedValueOnce(stream(permissionTrack));
    enumerateDevices.mockResolvedValueOnce([device('audioinput', 'mic-r', 'Recovered')]);
    const retry = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.includes(t('retry')))!;
    await fireEvent.click(retry);

    await waitFor(() => expect(document.querySelector('#mic-select')?.textContent).toContain('Recovered'));
    expect(permissionTrack.stop).toHaveBeenCalledTimes(1);
  });

  it('owns mic-test acquisition, selected constraints, explicit stop and unmount cleanup', async () => {
    const permissionTrack = track();
    const testTrack1 = track();
    const testTrack2 = track();
    getUserMedia
      .mockResolvedValueOnce(stream(permissionTrack))
      .mockResolvedValueOnce(stream(testTrack1))
      .mockResolvedValueOnce(stream(testTrack2));
    enumerateDevices.mockResolvedValue([
      device('audioinput', 'mic-a', 'A'),
      device('audioinput', 'mic-b', 'B'),
    ]);

    const view = render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());
    await fireEvent.change(document.querySelector<HTMLSelectElement>('#mic-select')!, { target: { value: 'mic-b' } });

    const testButton = () => document.querySelector<HTMLButtonElement>('.btn--test')!;
    await fireEvent.click(testButton());
    await waitFor(() => expect(testButton().getAttribute('aria-label')).toBe('Testi durdur'));
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: {
        deviceId: { exact: 'mic-b' },
        noiseSuppression: true,
        echoCancellation: true,
      },
    });

    await fireEvent.click(testButton());
    expect(testTrack1.stop).toHaveBeenCalledTimes(1);
    expect(testButton().getAttribute('aria-label')).toBe('Mikrofonu test et');

    await fireEvent.click(testButton());
    await waitFor(() => expect(testButton().getAttribute('aria-label')).toBe('Testi durdur'));
    view.unmount();
    expect(testTrack2.stop).toHaveBeenCalledTimes(1);
  });

  it('auto-stops an active mic test after five seconds', async () => {
    vi.useFakeTimers();
    const permissionTrack = track();
    const testTrack = track();
    getUserMedia
      .mockResolvedValueOnce(stream(permissionTrack))
      .mockResolvedValueOnce(stream(testTrack));
    enumerateDevices.mockResolvedValue([device('audioinput', 'mic-a', 'A')]);

    render(DevicesTab, { props: { store: makeStore() } });
    await vi.waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.btn--test')!);
    await vi.waitFor(() => expect(document.querySelector<HTMLButtonElement>('.btn--test')?.getAttribute('aria-label')).toBe('Testi durdur'));

    await vi.advanceTimersByTimeAsync(5000);
    expect(testTrack.stop).toHaveBeenCalledTimes(1);
    expect(document.querySelector<HTMLButtonElement>('.btn--test')?.getAttribute('aria-label')).toBe('Mikrofonu test et');
  });

  it('preserves valid zero volume and rejects corrupt or out-of-range persisted volumes', async () => {
    localStorage.setItem('bridge:device:inputVol', '0');
    localStorage.setItem('bridge:device:outputVol', '200');
    getUserMedia.mockResolvedValue(stream(track()));
    enumerateDevices.mockResolvedValue([]);

    const first = render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#input-vol')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('#input-vol')?.value).toBe('0');
    expect(document.querySelector<HTMLInputElement>('#output-vol')?.value).toBe('200');
    first.unmount();

    localStorage.setItem('bridge:device:inputVol', 'not-a-number');
    localStorage.setItem('bridge:device:outputVol', '201');
    const second = render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#input-vol')).not.toBeNull());
    expect(document.querySelector<HTMLInputElement>('#input-vol')?.value).toBe('100');
    expect(document.querySelector<HTMLInputElement>('#output-vol')?.value).toBe('100');
    second.unmount();
  });

  it('uses default mic constraints and returns to idle when test acquisition is denied', async () => {
    getUserMedia
      .mockResolvedValueOnce(stream(track()))
      .mockRejectedValueOnce(new DOMException('busy', 'NotReadableError'));
    enumerateDevices.mockResolvedValue([]);
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());

    await fireEvent.click(document.querySelector<HTMLButtonElement>('.btn--test')!);
    await waitFor(() => expect(document.querySelector<HTMLButtonElement>('.btn--test')).toHaveAttribute('aria-label', 'Mikrofonu test et'));
    expect(getUserMedia).toHaveBeenLastCalledWith({
      audio: { deviceId: undefined, noiseSuppression: true, echoCancellation: true },
    });
  });

  it('stops a stream that resolves after the user already cancelled the pending permission request', async () => {
    const lateTrack = track();
    let resolveTest!: (value: MediaStream) => void;
    const pending = new Promise<MediaStream>(resolve => { resolveTest = resolve; });
    getUserMedia
      .mockResolvedValueOnce(stream(track()))
      .mockReturnValueOnce(pending);
    enumerateDevices.mockResolvedValue([]);
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());

    const button = document.querySelector<HTMLButtonElement>('.btn--test')!;
    await fireEvent.click(button);
    expect(button).toHaveAttribute('aria-label', 'Testi durdur');
    await fireEvent.click(button);
    expect(button).toHaveAttribute('aria-label', 'Mikrofonu test et');

    resolveTest(stream(lateTrack));
    await waitFor(() => expect(lateTrack.stop).toHaveBeenCalledOnce());
    expect(button).toHaveAttribute('aria-label', 'Mikrofonu test et');
  });

  it('clears an old auto-stop timer so it cannot terminate a newer mic test', async () => {
    vi.useFakeTimers();
    const firstTrack = track();
    const secondTrack = track();
    getUserMedia
      .mockResolvedValueOnce(stream(track()))
      .mockResolvedValueOnce(stream(firstTrack))
      .mockResolvedValueOnce(stream(secondTrack));
    enumerateDevices.mockResolvedValue([]);
    render(DevicesTab, { props: { store: makeStore() } });
    await vi.waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());

    const button = document.querySelector<HTMLButtonElement>('.btn--test')!;
    await fireEvent.click(button);
    await vi.waitFor(() => expect(button).toHaveAttribute('aria-label', 'Testi durdur'));
    await vi.advanceTimersByTimeAsync(2500);
    await fireEvent.click(button);
    await fireEvent.click(button);
    await vi.waitFor(() => expect(button).toHaveAttribute('aria-label', 'Testi durdur'));

    await vi.advanceTimersByTimeAsync(2500);
    expect(secondTrack.stop).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2500);
    expect(secondTrack.stop).toHaveBeenCalledOnce();
  });

  it('persists browser-local preferences and propagates active voice settings through BridgeRegistry', async () => {
    localStorage.setItem('bridge:device:mic', 'mic-old');
    localStorage.setItem('bridge:device:inputVol', '80');
    localStorage.setItem('bridge:device:noise', 'false');
    const permissionTrack = track();
    getUserMedia.mockResolvedValue(stream(permissionTrack));
    enumerateDevices.mockResolvedValue([
      device('audioinput', 'mic-old', 'Old Mic'),
      device('audioinput', 'mic-new', 'New Mic'),
      device('audiooutput', 'spk-new', 'Speaker'),
      device('videoinput', 'cam-new', 'Camera'),
    ]);
    const setDevicePreference = vi.fn();

    render(DevicesTab, { props: { store: makeStore(setDevicePreference) } });
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());
    await fireEvent.change(document.querySelector<HTMLSelectElement>('#mic-select')!, { target: { value: 'mic-new' } });
    await fireEvent.change(document.querySelector<HTMLSelectElement>('#speaker-select')!, { target: { value: 'spk-new' } });
    await fireEvent.change(document.querySelector<HTMLSelectElement>('#camera-select')!, { target: { value: 'cam-new' } });
    await fireEvent.input(document.querySelector<HTMLInputElement>('#input-vol')!, { target: { value: '135' } });
    await fireEvent.input(document.querySelector<HTMLInputElement>('#output-vol')!, { target: { value: '70' } });
    const toggles = document.querySelectorAll<HTMLButtonElement>('.toggle-btn');
    await fireEvent.click(toggles[1]);

    const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.trim() === 'Kaydet')!;
    await fireEvent.click(saveButton);

    await waitFor(() => expect(setDevicePreference).toHaveBeenCalledTimes(7));
    expect(setDevicePreference).toHaveBeenCalledWith('micDeviceId', 'mic-new');
    expect(setDevicePreference).toHaveBeenCalledWith('speakerDeviceId', 'spk-new');
    expect(setDevicePreference).toHaveBeenCalledWith('cameraDeviceId', 'cam-new');
    expect(setDevicePreference).toHaveBeenCalledWith('inputVolume', 135);
    expect(setDevicePreference).toHaveBeenCalledWith('outputVolume', 70);
    expect(setDevicePreference).toHaveBeenCalledWith('noiseSuppression', false);
    expect(setDevicePreference).toHaveBeenCalledWith('echoCancellation', false);
    expect(localStorage.getItem('bridge:device:mic')).toBe('mic-new');
    expect(localStorage.getItem('bridge:device:speaker')).toBe('spk-new');
    expect(localStorage.getItem('bridge:device:camera')).toBe('cam-new');
    expect(localStorage.getItem('bridge:device:inputVol')).toBe('135');
    expect(localStorage.getItem('bridge:device:outputVol')).toBe('70');
    expect(localStorage.getItem('bridge:device:noise')).toBe('false');
    expect(localStorage.getItem('bridge:device:echo')).toBe('false');
    expect(registryCall).toHaveBeenCalledWith('voice:applyDeviceSettings', {
      micDeviceId: 'mic-new',
      noiseSuppression: false,
      echoCancellation: false,
      inputVolume: 135,
      outputVolume: 70,
    });
    expect(document.body.textContent).toContain('Kaydedildi');
  });

  it('does not propagate when browser persistence fails and reports the storage error', async () => {
    const permissionTrack = track();
    getUserMedia.mockResolvedValue(stream(permissionTrack));
    enumerateDevices.mockResolvedValue([]);
    const setDevicePreference = vi.fn();
    vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('Depolama kapalı');
    });

    render(DevicesTab, { props: { store: makeStore(setDevicePreference) } });
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());
    const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(b => b.textContent?.trim() === 'Kaydet')!;
    await fireEvent.click(saveButton);

    // Istisnanin ham `message`'i kullaniciya gosterilmez; kanonik metin yazilir.
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain(t('dev_save_failed')));
    expect(document.querySelector('[role="alert"]')?.textContent).not.toContain('Depolama kapalı');
    expect(localStorage.getItem('bridge:device:mic')).toBeNull();
    expect(setDevicePreference).not.toHaveBeenCalled();
    expect(registryCall).not.toHaveBeenCalledWith('voice:applyDeviceSettings', expect.anything());
  });

  it('saves without an active voice registry and clears its transient success state', async () => {
    vi.useFakeTimers();
    getUserMedia.mockResolvedValue(stream(track()));
    enumerateDevices.mockResolvedValue([]);
    const setDevicePreference = vi.fn();
    render(DevicesTab, { props: { store: makeStore(setDevicePreference) } });
    await vi.waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());

    const saveButton = [...document.querySelectorAll<HTMLButtonElement>('button')]
      .find(button => button.textContent?.trim() === 'Kaydet')!;
    await fireEvent.click(saveButton);
    await vi.waitFor(() => expect(document.body.textContent).toContain('Kaydedildi'));
    expect(setDevicePreference).toHaveBeenCalledTimes(7);

    await vi.advanceTimersByTimeAsync(2000);
    expect(document.body.textContent).not.toContain('Kaydedildi');
  });
});
