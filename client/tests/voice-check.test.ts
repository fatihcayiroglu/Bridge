import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import VoiceCheckPanel from '../js/core/VoiceCheckPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';

function device(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return { kind, deviceId, label, groupId: '', toJSON: () => ({}) } as MediaDeviceInfo;
}

function installBrowserMedia(options: {
  devices?: MediaDeviceInfo[];
  permission?: PermissionState;
  stream?: MediaStream;
} = {}) {
  const getUserMedia = vi.fn(async () => options.stream ?? new MediaStream());
  const enumerateDevices = vi.fn(async () => options.devices ?? []);
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia, enumerateDevices },
    permissions: { query: vi.fn(async () => ({ state: options.permission ?? 'granted' })) },
  });
  return { getUserMedia, enumerateDevices };
}

function registerRtc(rtc: Record<string, unknown>): void {
  BridgeRegistry.register('rtc', rtc as unknown as AnyFn);
}

function openPanel(): void {
  BridgeRegistry.get<() => void>('openVoiceCheck')?.();
}

beforeEach(() => {
  BridgeRegistry.unregister('rtc');
  BridgeRegistry.unregister('openVoiceCheck');
  BridgeRegistry.unregister('closeVoiceCheck');
  vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
});

afterEach(() => {
  cleanup();
  BridgeRegistry.unregister('rtc');
  BridgeRegistry.unregister('openVoiceCheck');
  BridgeRegistry.unregister('closeVoiceCheck');
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Voice Check panel', () => {
  it('açılışta izin istemez; yalnız mevcut cihaz ve kanonik RTC durumunu okur', async () => {
    const media = installBrowserMedia({
      devices: [device('audioinput', 'mic-1', '<img src=x onerror=alert(1)>')],
      permission: 'prompt',
    });
    registerRtc({
      selectedMicId: 'mic-1',
      currentChannelId: null,
      socket: { connected: true },
      peers: new Map(),
      isInVoice: () => false,
    });
    const { container } = render(VoiceCheckPanel);

    expect(BridgeRegistry.has('openVoiceCheck')).toBe(true);
    openPanel();

    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeTruthy());
    await waitFor(() => expect(container.textContent).toContain('Ses kanalında değil'));
    expect(media.enumerateDevices).toHaveBeenCalled();
    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(container.querySelector('.vcheck-details img')).toBeNull();
    expect(container.textContent).toContain('ICE kimlik bilgileri ve ağ adresleri gösterilmez');
  });

  it('mikrofon testi yalnız yerel analiz yapar ve sahip olduğu akışı kapanışta durdurur', async () => {
    const stop = vi.fn();
    const track = { kind: 'audio', readyState: 'live', enabled: true, stop } as unknown as MediaStreamTrack;
    const ownedStream = new MediaStream([track]);
    const media = installBrowserMedia({
      devices: [device('audioinput', 'mic-1', 'Local Mic')],
      stream: ownedStream,
    });
    registerRtc({ selectedMicId: 'mic-1', localStream: null, peers: new Map(), socket: { connected: true } });

    const closeAudioContext = vi.fn(async () => undefined);
    class AudioContextMock {
      createAnalyser() {
        return { fftSize: 256, getByteTimeDomainData: vi.fn((samples: Uint8Array) => samples.fill(132)) };
      }
      createMediaStreamSource(stream: MediaStream) {
        expect(stream).toBe(ownedStream);
        return { connect: vi.fn() };
      }
      close = closeAudioContext;
    }
    vi.stubGlobal('AudioContext', AudioContextMock);

    const { container, getByRole } = render(VoiceCheckPanel);
    openPanel();
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeTruthy());

    await fireEvent.click(getByRole('button', { name: 'Testi başlat' }));
    await waitFor(() => expect(getByRole('button', { name: 'Testi durdur' })).toBeTruthy());
    // ════════════════════════════════════════════════════════════════════
    // TEST, ARAMANIN KISITLARIYLA AYNI TRACK'İ ALIR
    // ════════════════════════════════════════════════════════════════════
    // Bu iddia ÖNCEDEN `{ audio: { deviceId: { exact: 'mic-1' } } }` idi —
    // yani mikrofon testi ÇIPLAK kısıtla track alıyordu: yankı giderme,
    // gürültü bastırma ve kazanç HİÇ istenmiyordu.
    //
    // Sonuç: tanılama paneli, tanıladığı şeyden BAŞKA bir yapılandırmayı
    // ölçüyordu. `getSettings()` çıktısı tarayıcının `audio: true`
    // varsayılanlarını gösteriyor, kullanıcı ise bunu "aramada yankı
    // giderme açık/kapalı" diye okuyordu.
    //
    // Beklenti GEVŞETİLMEDİ, SIKILAŞTIRILDI: artık işleme kısıtlarının
    // gerçekten istendiği de doğrulanıyor.
    expect(media.getUserMedia).toHaveBeenCalledWith({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        deviceId: { exact: 'mic-1' },
      },
      video: false,
    });

    // KALICI KANCA: kapatma düğmesi SINIFIYLA bulunur, erişilebilir adıyla
    // değil. Ad artık i18n'den gelir ve jsdom'da `navigator.language`
    // tanımsız olduğu için yerel 'en'e düşer — yani ad ortama göre değişir.
    // Bu depoda aynı ders zaten kayıtlı (auth sekmesi testi): i18n ile değişen
    // metne bağlanmak kırılgandır.
    const closeBtn = container.querySelector('.vcheck-close');
    expect(closeBtn, 'kapatma düğmesi bulunamadı').toBeTruthy();
    await fireEvent.click(closeBtn as Element);
    expect(stop).toHaveBeenCalledOnce();
    expect(closeAudioContext).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="dialog"]')).toBeNull();
  });

  it('kanonik canlı akışı yeniden kullanır ve sahibinin track’ini durdurmaz', async () => {
    const stop = vi.fn();
    const track = { kind: 'audio', readyState: 'live', enabled: true, stop } as unknown as MediaStreamTrack;
    const canonicalStream = new MediaStream([track]);
    const media = installBrowserMedia({ devices: [device('audioinput', 'mic-1', 'Live Mic')] });
    registerRtc({
      selectedMicId: 'mic-1', localStream: canonicalStream,
      getLocalStream: () => canonicalStream, peers: new Map(), socket: { connected: true },
    });
    class AudioContextMock {
      createAnalyser() { return { fftSize: 256, getByteTimeDomainData: vi.fn() }; }
      createMediaStreamSource() { return { connect: vi.fn() }; }
      close = vi.fn(async () => undefined);
    }
    vi.stubGlobal('AudioContext', AudioContextMock);

    const { container, getByRole } = render(VoiceCheckPanel);
    openPanel();
    await waitFor(() => expect(container.querySelector('[role="dialog"]')).toBeTruthy());
    await fireEvent.click(getByRole('button', { name: 'Testi başlat' }));
    await fireEvent.click(getByRole('button', { name: 'Testi durdur' }));

    expect(media.getUserMedia).not.toHaveBeenCalled();
    expect(stop).not.toHaveBeenCalled();
  });

  it('izin reddini eyleme dönük metinle açıklar ve unmount kayıtları temizler', async () => {
    installBrowserMedia({ permission: 'denied' });
    const rendered = render(VoiceCheckPanel);
    openPanel();

    await waitFor(() => expect(rendered.container.textContent).toContain(
      'Mikrofon izni engellendi. Tarayıcı site izinlerini açın.',
    ));
    rendered.unmount();

    expect(BridgeRegistry.has('openVoiceCheck')).toBe(false);
    expect(BridgeRegistry.has('closeVoiceCheck')).toBe(false);
  });
});
