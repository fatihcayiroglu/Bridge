// client/tests/webrtc-saved-device-preferences.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// webrtc.ts — KAYITLI CİHAZ TERCİHLERİNİN OKUNMASI
// ════════════════════════════════════════════════════════════════════════════
// `loadSavedDevices()` iki nesil anahtarı birden okur: kanonik
// `bridge:device:*` ve eski `bridge-*`. Bunun bir sebebi var — ayar adları bir
// kez ayrışmıştı ve kullanıcının seçtiği mikrofon ASLA yüklenmiyordu
// (`voice-device-selection.test.ts` o gerilemeyi kilitler).
//
// Burada ölçülen tamamlayıcı sözleşme şudur: **yokluk bir değer değildir.**
//
//   · Hiç kayıt yoksa seçim alanları `null` KALIR. Boş dizge bir cihaz kimliği
//     olarak yazılırsa `getUserMedia` var olmayan bir cihaz ister ve görüşme
//     hiç başlamaz — üstelik kullanıcı hiçbir seçim yapmamışken.
//   · Kısmi kayıt yalnızca KENDİ alanını doldurur; diğerleri varsayılanda kalır.
//
// Ses işleme bayrakları ayrı bir kurala tabidir: yalnızca AÇIKÇA `'false'`
// kapatır. Eksik/bozuk değer güvenli tarafa (AÇIK) düşer — gürültü engelleme
// sessizce kapanırsa kullanıcı bunu ancak karşı taraf şikâyet edince anlar.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const socket = () => ({ connected: true, emit: vi.fn(), on: vi.fn(), off: vi.fn() });

class StubPeerConnection {
  connectionState: RTCPeerConnectionState = 'new';
  signalingState: RTCSignalingState = 'stable';
  onicecandidate: ((event: { candidate: unknown }) => void) | null = null;
  ontrack: ((event: { streams: MediaStream[] }) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  getTransceivers() { return []; }
  getSenders() { return []; }
  addTrack() { return {} as RTCRtpSender; }
  close() { this.connectionState = 'closed'; }
}

type DeviceState = {
  selectedMicId: string | null;
  selectedCameraId: string | null;
  selectedSpeakerId: string | null;
  echoCancellation: boolean;
  noiseSuppression: boolean;
  loadSavedDevices(): void;
};

async function newRtc(): Promise<DeviceState> {
  vi.resetModules();
  vi.stubGlobal('RTCPeerConnection', StubPeerConnection);
  vi.doMock('../js/core/api-fetch.ts', () => ({
    apiFetch: vi.fn(async () => ({ ok: false, json: async () => ({}) })),
  }));
  const mod = await import('../js/webrtc.ts');
  return new mod.BridgeRTC(socket() as never) as unknown as DeviceState;
}

beforeEach(() => { localStorage.clear(); });

afterEach(() => {
  vi.doUnmock('../js/core/api-fetch.ts');
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('an absent preference is not a preference', () => {
  it('leaves every selection unset when nothing was ever saved', async () => {
    const rtc = await newRtc();
    rtc.loadSavedDevices();

    // Boş dizge bir cihaz kimliği DEĞİLDİR; yazılsaydı `getUserMedia`
    // var olmayan bir cihaz isteyip görüşmeyi hiç başlatamazdı.
    expect(rtc.selectedMicId).toBeNull();
    expect(rtc.selectedCameraId).toBeNull();
    expect(rtc.selectedSpeakerId).toBeNull();
  });

  it('fills only the field that was actually saved', async () => {
    localStorage.setItem('bridge:device:camera', 'cam-42');
    const rtc = await newRtc();
    rtc.loadSavedDevices();

    expect(rtc.selectedCameraId).toBe('cam-42');
    expect(rtc.selectedMicId).toBeNull();
    expect(rtc.selectedSpeakerId).toBeNull();
  });

  it('treats an empty stored string as no preference at all', async () => {
    for (const key of ['bridge:device:mic', 'bridge:device:camera', 'bridge:device:speaker']) {
      localStorage.setItem(key, '');
    }
    const rtc = await newRtc();
    rtc.loadSavedDevices();

    expect(rtc.selectedMicId).toBeNull();
    expect(rtc.selectedCameraId).toBeNull();
    expect(rtc.selectedSpeakerId).toBeNull();
  });

  it('reads the canonical keys and falls back to the legacy spelling', async () => {
    localStorage.setItem('bridge:device:mic', 'mic-canonical');
    localStorage.setItem('bridge-mic', 'mic-legacy');
    localStorage.setItem('bridge-speaker', 'speaker-legacy');   // yalnızca eski ad

    const rtc = await newRtc();
    rtc.loadSavedDevices();

    // Kanonik ad KAZANIR; eski ad yalnızca kanonik yokken kullanılır.
    expect(rtc.selectedMicId).toBe('mic-canonical');
    expect(rtc.selectedSpeakerId).toBe('speaker-legacy');
  });
});

describe('audio processing flags fail safe', () => {
  it('stays enabled when nothing is stored', async () => {
    const rtc = await newRtc();
    rtc.loadSavedDevices();
    expect(rtc.echoCancellation).toBe(true);
    expect(rtc.noiseSuppression).toBe(true);
  });

  it('is disabled only by an explicit false', async () => {
    localStorage.setItem('bridge:device:echo', 'false');
    localStorage.setItem('bridge:device:noise', 'true');
    const rtc = await newRtc();
    rtc.loadSavedDevices();
    expect(rtc.echoCancellation).toBe(false);
    expect(rtc.noiseSuppression).toBe(true);
  });

  it('keeps processing on for a corrupt stored value', async () => {
    // Bozuk değer sessizce "kapalı" sayılırsa kullanıcı bunu ancak karşı
    // taraf yankı duyduğunda öğrenir.
    localStorage.setItem('bridge:device:echo', 'nope');
    localStorage.setItem('bridge:device:noise', '0');
    const rtc = await newRtc();
    rtc.loadSavedDevices();
    expect(rtc.echoCancellation).toBe(true);
    expect(rtc.noiseSuppression).toBe(true);
  });
});
