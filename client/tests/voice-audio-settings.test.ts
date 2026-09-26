// client/tests/voice-audio-settings.test.ts
//
// FAZ K2 — uygulanan ses ayarlarinin DURUST raporlanmasi.
//
// Bu testlerin ozu tek bir kural: tarayici bir degeri bildirmiyorsa, kod
// onu UYDURMAZ. "İstendi, oyleyse uygulandi" varsayimi tam olarak
// kacinilan hatadir; asagidaki senaryolar o varsayimi yakalar.
//
// Mock kullanimi burada mesrudur (test siniri); uretim kodu sahte veri
// URETMEZ — yalnizca gercek `getSettings()` ciktisini okur.

import { describe, it, expect } from 'vitest';
import {
  readAppliedAudioSettings,
  unknownAudioSettings,
  downgradedAudioFeatures,
  type AppliedAudioSettings,
} from '../js/core/voice-audio-settings.ts';

function trackStub(settings: unknown, opts: { label?: string; live?: boolean; hasGetSettings?: boolean } = {}) {
  const track: Record<string, unknown> = {
    label: opts.label ?? '',
    readyState: opts.live === false ? 'ended' : 'live',
  };
  if (opts.hasGetSettings !== false) track.getSettings = () => settings;
  return track;
}

function streamOf(track: unknown): unknown {
  return { getAudioTracks: () => (track ? [track] : []) };
}

describe('Faz K2 — uygulanan ses ayarlari', () => {
  it('tarayicinin bildirdigi degerleri oldugu gibi saklar', () => {
    const applied = readAppliedAudioSettings(streamOf(trackStub({
      deviceId: 'mic-1',
      sampleRate: 48000,
      sampleSize: 16,
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    }, { label: 'Yaka Mikrofonu' })));

    expect(applied.supported).toBe(true);
    expect(applied.trackLive).toBe(true);
    expect(applied.microphone).toEqual({ deviceId: 'mic-1', label: 'Yaka Mikrofonu' });
    expect(applied.audio.sampleRate).toBe(48000);
    expect(applied.audio.sampleSize).toBe(16);
    expect(applied.audio.channelCount).toBe(1);
    expect(applied.audio.echoCancellation).toBe(true);
    expect(applied.audio.noiseSuppression).toBe(true);
    expect(applied.audio.autoGainControl).toBe(true);
  });

  it('tarayici bir alani bildirmezse UNKNOWN yazar, true VARSAYMAZ', () => {
    // Kritik senaryo: kisitlama ISTENDI ama tarayici bildirmiyor.
    const applied = readAppliedAudioSettings(streamOf(trackStub({ sampleRate: 48000 })));

    expect(applied.audio.echoCancellation).toBe('unknown');
    expect(applied.audio.noiseSuppression).toBe('unknown');
    expect(applied.audio.autoGainControl).toBe('unknown');
    expect(applied.audio.channelCount).toBeNull();
    expect(applied.audio.sampleSize).toBeNull();
  });

  it('tarayici acikca false derse bunu gizlemez', () => {
    const applied = readAppliedAudioSettings(streamOf(trackStub({
      echoCancellation: false, noiseSuppression: false, autoGainControl: true,
    })));

    expect(applied.audio.echoCancellation).toBe(false);
    expect(applied.audio.noiseSuppression).toBe(false);
    expect(downgradedAudioFeatures(applied)).toEqual(['echoCancellation', 'noiseSuppression']);
  });

  it('bilinmeyen alanlari DUSURULMUS saymaz', () => {
    const applied = readAppliedAudioSettings(streamOf(trackStub({})));
    // 'unknown' bir sapma degil, bilgi yoklugudur.
    expect(downgradedAudioFeatures(applied)).toEqual([]);
  });

  it('sayisal 0 gecerli bir olcumdur, null ile karistirilmaz', () => {
    const applied = readAppliedAudioSettings(streamOf(trackStub({ channelCount: 0 })));
    expect(applied.audio.channelCount).toBe(0);
  });

  it('izin yoksa etiket null olur (bos string sizmaz)', () => {
    const applied = readAppliedAudioSettings(streamOf(trackStub({ deviceId: '' }, { label: '   ' })));
    expect(applied.microphone.label).toBeNull();
    expect(applied.microphone.deviceId).toBeNull();
  });

  it('getSettings desteklenmiyorsa supported=false doner ve cokmez', () => {
    const applied = readAppliedAudioSettings(
      streamOf(trackStub(null, { hasGetSettings: false, label: 'Mikrofon' })),
    );
    expect(applied.supported).toBe(false);
    expect(applied.microphone.label).toBe('Mikrofon');
    expect(applied.audio.noiseSuppression).toBe('unknown');
  });

  it('getSettings firlatirsa cokmez, bilinmiyor doner', () => {
    const track = { label: '', readyState: 'live', getSettings: () => { throw new Error('boom'); } };
    const applied = readAppliedAudioSettings(streamOf(track));
    expect(applied.supported).toBe(false);
    expect(applied.audio.sampleRate).toBeNull();
  });

  it('ses track yoksa hicbir sey iddia etmez', () => {
    const applied = readAppliedAudioSettings(streamOf(null));
    expect(applied).toEqual(unknownAudioSettings(false));
    expect(applied.trackLive).toBe(false);
  });

  it('akis null oldugunda da guvenlidir', () => {
    const applied: AppliedAudioSettings = readAppliedAudioSettings(null);
    expect(applied.supported).toBe(false);
    expect(applied.microphone.deviceId).toBeNull();
  });

  it('track sonlanmissa trackLive false raporlar', () => {
    const applied = readAppliedAudioSettings(streamOf(trackStub({ sampleRate: 48000 }, { live: false })));
    expect(applied.trackLive).toBe(false);
    // Ayarlar yine okunabilir — canlilik ayri bir gercektir.
    expect(applied.audio.sampleRate).toBe(48000);
  });
});
