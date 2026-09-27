// Shared screen-share quality policy for both P2P and SFU engines.
// The capture constraint shapes intentionally differ: P2P preserves the
// explicit max/cursor hints used by the existing browser path, while SFU keeps
// the lighter ideal-only constraints it historically used.

export type ScreenQuality = '4k60' | '1440p60' | '1440p' | '1080p60' | '1080p' | '720p' | 'hd';

export const P2P_SCREEN_PRESETS: Record<ScreenQuality, MediaTrackConstraints & { cursor?: string }> = {
  '4k60':    { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
  '1440p60': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
  '1440p':   { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
  '1080p60': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60, max: 60 }, cursor: 'always' },
  '1080p':   { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
  '720p':    { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 }, cursor: 'always' },
  'hd':      { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, cursor: 'always' },
};

export const SFU_SCREEN_PRESETS: Record<ScreenQuality, MediaTrackConstraints> = {
  '4k60':    { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 60 } },
  '1440p60': { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 60 } },
  '1440p':   { width: { ideal: 2560 }, height: { ideal: 1440 }, frameRate: { ideal: 30 } },
  '1080p60': { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 60 } },
  '1080p':   { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
  '720p':    { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
  'hd':      { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
};

export const SCREEN_BITRATES: Record<ScreenQuality, number> = {
  '4k60': 20_000_000,
  '1440p60': 12_000_000,
  '1440p': 10_000_000,
  '1080p60': 8_000_000,
  '1080p': 5_000_000,
  '720p': 3_000_000,
  'hd': 2_000_000,
};

export const SCREEN_FPS: Record<ScreenQuality, number> = {
  '4k60': 60,
  '1440p60': 60,
  '1440p': 30,
  '1080p60': 60,
  '1080p': 30,
  '720p': 30,
  'hd': 30,
};

export function normalizeScreenQuality(value: string, fallback: ScreenQuality): ScreenQuality {
  return Object.prototype.hasOwnProperty.call(SCREEN_BITRATES, value) ? value as ScreenQuality : fallback;
}
