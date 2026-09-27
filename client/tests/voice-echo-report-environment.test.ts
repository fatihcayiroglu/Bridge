// client/tests/voice-echo-report-environment.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// voice-echo-report.ts — ORTAM TESPİTİ VE KAYNAK DÜRÜSTLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════
// Yankı teşhisinde tarayıcı ve işletim sistemi BELİRLEYİCİDİR: Chrome'un yankı
// gidericisi varsayılan render akışını referans alır, mobil platformlarda ise
// donanım yankı gidericisi devrededir. Yanlış tespit edilen bir platform,
// teşhisi baştan yanlış dala sokar.
//
// Ayrıca ölçümün KAYNAĞI rapora yazılmalıdır: mikrofon testi track'i bir
// VEKİLDİR, canlı arama track'i değildir. İkisini aynı göstermek, tek kişilik
// bir ölçümü iki kişilik bir aramanın kanıtı gibi okuturdu.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { buildEchoReport, browserName, osName, outputIsDefault } from '../js/core/voice-echo-report.ts';

const UA = {
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0 Safari/537.36 Edg/124',
  opera: 'Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/123.0 Safari/537.36 OPR/109',
  firefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:126.0) Gecko/20100101 Firefox/126.0',
  chrome: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/125.0 Safari/537.36',
  safari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Version/17.4 Safari/605.1.15',
  android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 Chrome/125.0 Mobile Safari/537.36',
  iphone: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Version/17.4 Mobile Safari',
};

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    rtcAvailable: true, mediaApiAvailable: true, microphonePermission: 'granted',
    microphoneDetected: true, microphoneTrackLive: true, outputDetected: true,
    selectedInputUnavailable: false, selectedOutputUnavailable: false,
    inVoice: true, signalingConnected: true, peerCount: 1,
    appliedAudioSource: 'call',
    appliedAudio: { supported: true, trackLive: true, audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: false } },
    connectionQuality: { quality: 'good' },
    ...overrides,
  } as never;
}

afterEach(() => { vi.unstubAllGlobals(); });

describe('browser detection', () => {
  it.each([
    [UA.edge, 'Edge 124'],
    [UA.opera, 'Opera 109'],
    [UA.firefox, 'Firefox 126'],
    [UA.chrome, 'Chrome 125'],
    [UA.safari, 'Safari 17'],
  ])('names the engine and major version for %s', (ua, expected) => {
    expect(browserName(ua)).toBe(expected);
  });

  it('reports unknown rather than guessing for an empty or unrecognised agent', () => {
    expect(browserName('')).toBe('unknown');
    expect(browserName('curl/8.4.0')).toBe('unknown');
  });
});

describe('operating system detection', () => {
  it.each([
    [UA.edge, undefined, 'Windows'],
    [UA.chrome, undefined, 'macOS'],
    [UA.android, undefined, 'Android'],
    [UA.iphone, undefined, 'iOS'],
    [UA.firefox, undefined, 'Linux'],
    ['Mozilla/5.0', 'Win32', 'Windows'],
    ['Mozilla/5.0', 'MacIntel', 'macOS'],
    ['Mozilla/5.0', 'Linux armv8l', 'Linux'],
  ])('classifies %s / %s as %s', (ua, platform, expected) => {
    expect(osName(ua, platform)).toBe(expected);
  });

  it('reports unknown when neither the agent nor the platform is recognisable', () => {
    expect(osName('bridge-bot/1.0')).toBe('unknown');
    expect(osName('', '')).toBe('unknown');
  });
});

describe('output device classification', () => {
  it('distinguishes a system default, a chosen device, an absent one and no measurement', () => {
    expect(outputIsDefault(null)).toBe('unknown');
    expect(outputIsDefault(snapshot({ selectedOutputUnavailable: true }))).toContain('bulunamadı');
    expect(outputIsDefault(snapshot({ outputDeviceLabel: undefined }))).toBe('unknown');
    expect(outputIsDefault(snapshot({ outputDeviceLabel: 'Varsayılan çıkış' }))).toBe('system default');
    expect(outputIsDefault(snapshot({ outputDeviceLabel: 'Default - Speakers' }))).toBe('system default');
    expect(outputIsDefault(snapshot({ outputDeviceLabel: 'Studio Monitors' }))).toBe('other (Studio Monitors)');
  });
});

describe('report assembly', () => {
  it('falls back to the live navigator when no agent or platform is supplied', () => {
    vi.stubGlobal('navigator', { userAgent: UA.edge, platform: 'Win32' });
    const report = buildEchoReport({ snapshot: snapshot() });
    expect(report).toContain('Edge 124');
    expect(report).toContain('Windows');
  });

  it('prefers explicitly supplied environment values over the live navigator', () => {
    vi.stubGlobal('navigator', { userAgent: UA.edge, platform: 'Win32' });
    const report = buildEchoReport({ snapshot: snapshot(), userAgent: UA.iphone, platform: 'iPhone' });
    expect(report).toContain('iOS');
    expect(report).not.toContain('Edge 124');
  });

  it.each([
    ['call', 'kesin'],
    ['mic-test', 'VEKİL'],
    ['none', 'ölçüm yok'],
  ])('states that the %s measurement source produced the numbers', (source, marker) => {
    const report = buildEchoReport({ snapshot: snapshot({ appliedAudioSource: source }), userAgent: UA.chrome });
    expect(report).toContain(marker);
  });

  it('labels an unrecognised measurement source as no measurement rather than echoing it back', () => {
    const report = buildEchoReport({ snapshot: snapshot({ appliedAudioSource: 'telemetry' }), userAgent: UA.chrome });
    expect(report).toContain('ölçüm yok');
    expect(report).not.toContain('telemetry');
  });

  it('writes unknown — never false — when no live track could be measured', () => {
    const report = buildEchoReport({
      snapshot: snapshot({
        appliedAudioSource: 'none',
        appliedAudio: { supported: false, trackLive: false, audio: {} },
      }),
      userAgent: UA.chrome,
    });
    expect(report).toContain('unknown');
  });

  it('produces a usable report even with no diagnostics snapshot at all', () => {
    const report = buildEchoReport({ snapshot: null, userAgent: UA.chrome, platform: 'MacIntel' });
    expect(report).toContain('BRIDGE YANKI TEŞHİSİ');
    expect(report).toContain('macOS');
    expect(report).toContain('unknown');
  });

  it('never includes network identifiers or credentials', () => {
    const report = buildEchoReport({
      snapshot: snapshot({ outputDeviceLabel: 'MacBook Pro Hoparlörleri' }),
      userAgent: UA.chrome,
    });
    for (const forbidden of ['candidate', 'turn:', 'stun:', 'token', 'Bearer', 'srflx', 'relay']) {
      expect(report.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
    // Donanım etiketi bilinçli olarak DAHİLDİR: yankı teşhisinde belirleyicidir.
    expect(report).toContain('MacBook Pro Hoparlörleri');
  });
});
