import {
  P2P_SCREEN_PRESETS,
  SFU_SCREEN_PRESETS,
  SCREEN_BITRATES,
  SCREEN_FPS,
  normalizeScreenQuality,
} from '../js/core/rtc-screen-quality.ts';

describe('shared RTC screen quality policy', () => {
  it('keeps every quality present across P2P, SFU, bitrate and fps policy', () => {
    const qualities = Object.keys(SCREEN_BITRATES).sort();
    expect(Object.keys(P2P_SCREEN_PRESETS).sort()).toEqual(qualities);
    expect(Object.keys(SFU_SCREEN_PRESETS).sort()).toEqual(qualities);
    expect(Object.keys(SCREEN_FPS).sort()).toEqual(qualities);
  });

  it('normalizes unsupported values without inventing a profile', () => {
    expect(normalizeScreenQuality('4k60', 'hd')).toBe('4k60');
    expect(normalizeScreenQuality('8k240', 'hd')).toBe('hd');
  });
});
