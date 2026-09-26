// client/tests/devices-tab-save-states.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// ════════════════════════════════════════════════════════════════════════════
// settings/tabs/DevicesTab.svelte — KAYDET DURUM MAKİNESİ VE ETİKET YEDEKLERİ
// ════════════════════════════════════════════════════════════════════════════
// Cihaz tercihleri TARAYICI-YERELDİR: `PATCH /api/me` bunları kabul etmez, bu
// yüzden `localStorage` + canlı ses oturumu kanonik hedeftir.
//
// Ölçülen sözleşmeler:
//   • Kaydet düğmesi üç ayrı durum gösterir (boşta / kaydediliyor / kaydedildi)
//     ve kaydederken TEKRAR TIKLANAMAZ — iki eşzamanlı kayıt, yarı yazılmış bir
//     tercih kümesi bırakırdı.
//   • Kalıcılaştırma başarısız olursa (depolama kotası, gizli mod) hata
//     GÖSTERİLİR; sessiz bir "kaydedildi" kullanıcının ayarını kaybettirirdi.
//   • Etiketsiz cihazlar (izin verilmeden tarayıcı etiket vermez) sıralı bir
//     yedek adla listelenir; boş bir seçenek kullanıcıya hiçbir şey söylemez.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import DevicesTab from '../js/core/settings/tabs/DevicesTab.svelte';

function track() { return { stop: vi.fn() } as unknown as MediaStreamTrack; }
function stream(...tracks: MediaStreamTrack[]) { return { getTracks: () => tracks } as unknown as MediaStream; }
function device(kind: MediaDeviceKind, deviceId: string, label = ''): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}
function makeStore(setDevicePreference = vi.fn()) {
  return { save: vi.fn(), setDevicePreference, error: null } as never;
}

let getUserMedia: ReturnType<typeof vi.fn>;
let enumerateDevices: ReturnType<typeof vi.fn>;
let registryCall: ReturnType<typeof vi.fn>;

const saveButton = () => document.querySelector('.btn--primary') as HTMLButtonElement;

beforeEach(() => {
  localStorage.clear();
  document.body.innerHTML = '';
  registryCall = vi.fn();
  (window as unknown as Record<string, unknown>).BridgeRegistry = { call: registryCall };
  getUserMedia = vi.fn().mockResolvedValue(stream(track()));
  enumerateDevices = vi.fn().mockResolvedValue([
    device('audioinput', 'mic-1', 'Studio Mic'),
    device('audioinput', 'mic-2'),
    device('audiooutput', 'spk-1'),
    device('audiooutput', 'spk-2', 'Desk Speakers'),
    device('videoinput', 'cam-1'),
  ]);
  Object.defineProperty(navigator, 'mediaDevices', {
    configurable: true, value: { getUserMedia, enumerateDevices },
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  delete (window as unknown as Record<string, unknown>).BridgeRegistry;
});

describe('device labels', () => {
  it('numbers every unlabelled device per category instead of rendering a blank option', async () => {
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());

    const options = (selector: string) =>
      [...document.querySelectorAll<HTMLOptionElement>(`${selector} option`)].map(option => option.textContent?.trim());

    expect(options('#mic-select')).toEqual(['Sistem Varsayılanı', 'Studio Mic', 'Mikrofon 2']);
    expect(options('#speaker-select')).toEqual(['Sistem Varsayılanı', 'Hoparlör 1', 'Desk Speakers']);
    expect(options('#camera-select')).toEqual(['Sistem Varsayılanı', 'Kamera 1']);
  });

  it('hides the camera field entirely when no video input exists', async () => {
    enumerateDevices.mockResolvedValue([device('audioinput', 'mic-1', 'Mic')]);
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());
    expect(document.querySelector('#camera-select')).toBeNull();
  });

  it('renders the live volume readouts next to their sliders', async () => {
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('#input-vol')).not.toBeNull());
    expect(document.querySelector('label[for="input-vol"]')?.textContent).toContain('%');
    expect(document.querySelector('label[for="output-vol"]')?.textContent).toContain('%');
  });
});

describe('save state machine', () => {
  it('moves through saving and saved and then settles back to idle', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const setDevicePreference = vi.fn();
    render(DevicesTab, { props: { store: makeStore(setDevicePreference) } });
    await vi.waitFor(() => expect(saveButton()).not.toBeNull());

    await fireEvent.click(saveButton());
    await vi.waitFor(() => expect(saveButton().textContent?.trim()).toBe('✓ Kaydedildi'));
    expect(saveButton().classList.contains('btn--saved')).toBe(true);
    expect(setDevicePreference).toHaveBeenCalledTimes(7);
    expect(registryCall).toHaveBeenCalledWith('voice:applyDeviceSettings', expect.objectContaining({
      noiseSuppression: expect.any(Boolean),
      echoCancellation: expect.any(Boolean),
    }));

    vi.advanceTimersByTime(2500);
    await vi.waitFor(() => expect(saveButton().textContent?.trim()).toBe('Kaydet'));
    expect(saveButton().disabled).toBe(false);
  });

  it('surfaces a persistence failure instead of claiming the preference was saved', async () => {
    const setDevicePreference = vi.fn(() => { throw new Error('Depolama kotası doldu'); });
    render(DevicesTab, { props: { store: makeStore(setDevicePreference) } });
    await waitFor(() => expect(saveButton()).not.toBeNull());

    await fireEvent.click(saveButton());
    await waitFor(() => expect(document.body.textContent).toContain(t('dev_save_failed')));
    expect(document.body.textContent).not.toContain('Depolama kotası doldu');
    expect(saveButton().textContent?.trim()).toBe('Kaydet');
    expect(saveButton().disabled).toBe(false);
  });

  it('reports a non-Error persistence failure with a stable message', async () => {
    const setDevicePreference = vi.fn(() => { throw 'disk full'; });
    render(DevicesTab, { props: { store: makeStore(setDevicePreference) } });
    await waitFor(() => expect(saveButton()).not.toBeNull());

    await fireEvent.click(saveButton());
    await waitFor(() => expect(document.body.textContent).toContain(t('dev_save_failed')));
  });

  it('persists every device preference to browser-local storage', async () => {
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(saveButton()).not.toBeNull());

    await fireEvent.change(document.querySelector('#mic-select')!, { target: { value: 'mic-2' } });
    await fireEvent.click(saveButton());
    await waitFor(() => expect(localStorage.getItem('bridge:device:mic')).toBe('mic-2'));
    for (const key of ['speaker', 'camera', 'inputVol', 'outputVol', 'noise', 'echo']) {
      expect(localStorage.getItem(`bridge:device:${key}`)).not.toBeNull();
    }
  });

  it('toggles the advanced audio switches and carries them into the saved preference', async () => {
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(saveButton()).not.toBeNull());

    const toggles = [...document.querySelectorAll<HTMLButtonElement>('.toggle-btn')];
    expect(toggles).toHaveLength(2);
    const before = toggles.map(toggle => toggle.getAttribute('aria-pressed'));
    await fireEvent.click(toggles[0]!);
    await fireEvent.click(toggles[1]!);
    const after = [...document.querySelectorAll<HTMLButtonElement>('.toggle-btn')]
      .map(toggle => toggle.getAttribute('aria-pressed'));
    expect(after).not.toEqual(before);

    await fireEvent.click(saveButton());
    await waitFor(() => expect(registryCall).toHaveBeenCalledWith(
      'voice:applyDeviceSettings',
      expect.objectContaining({ noiseSuppression: after[0] === 'true', echoCancellation: after[1] === 'true' }),
    ));
  });

  it('still saves when no voice session is listening on the registry', async () => {
    delete (window as unknown as Record<string, unknown>).BridgeRegistry;
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(saveButton()).not.toBeNull());
    await fireEvent.click(saveButton());
    await waitFor(() => expect(localStorage.getItem('bridge:device:mic')).not.toBeNull());
  });
});

describe('permission failure', () => {
  it('offers a retry that re-runs enumeration after the user grants access', async () => {
    getUserMedia.mockRejectedValueOnce(new Error('NotAllowedError'));
    enumerateDevices.mockResolvedValue([]);
    render(DevicesTab, { props: { store: makeStore() } });
    await waitFor(() => expect(document.querySelector('.btn--secondary')).not.toBeNull());

    getUserMedia.mockResolvedValue(stream(track()));
    enumerateDevices.mockResolvedValue([device('audioinput', 'mic-1', 'Mic')]);
    await fireEvent.click(document.querySelector('.btn--secondary')!);
    await waitFor(() => expect(document.querySelector('#mic-select')).not.toBeNull());
  });
});
