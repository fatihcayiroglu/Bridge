// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VideoQualityPanel.svelte
//              client/js/core/video-quality-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/video-quality.ts — Sprint 43 JS→TS geçişi
// Kamera video kalitesi ayarları modülü
// Ayarlar modalındaki #video-quality-select-wrap'e Bridge UI Kit select enjekte eder
// ve seçilen kaliteyi webrtc.ts'deki enableVideo'ya iletir.

import { BridgeRegistry } from './bridge-registry.js';
import { getRtc } from './globals.js';

import { createLogger } from './logger.js';
const log = createLogger('VideoQuality');


// ── Tipler ───────────────────────────────────────────────────

export interface VideoConstraints {
  width?:     { ideal: number };
  height?:    { ideal: number };
  frameRate?: { ideal: number; max: number };
}

export interface VideoQualityPreset {
  value:       string;
  label:       string;
  emoji:       string;
  description: string;
  constraints: VideoConstraints;
  type?:       never;
}

interface QualityDivider {
  type:  'divider';
  label: string;
  value?: never;
}

type PresetEntry = VideoQualityPreset | QualityDivider;

// ── Kalite Ön Ayarları ───────────────────────────────────────

export const VIDEO_QUALITY_PRESETS: PresetEntry[] = [
  {
    value: '1080p30', label: '1080p 30fps (Full HD)', emoji: '🌟',
    description: 'En yüksek kalite — iyi ağ bağlantısı gerektirir (~2-4 Mbps)',
    constraints: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '720p60', label: '720p 60fps (HD Akıcı)', emoji: '⚡',
    description: 'Akıcı video, yüksek kare hızı (~2 Mbps)',
    constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } },
  },
  {
    value: '720p30', label: '720p 30fps (HD — Önerilen)', emoji: '✅',
    description: 'En iyi denge: kalite ve bant genişliği (~1 Mbps)',
    constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '480p30', label: '480p 30fps (Standart)', emoji: '🔵',
    description: 'Düşük bant genişliği için (~600 Kbps)',
    constraints: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '360p30', label: '360p 30fps (Düşük)', emoji: '🟡',
    description: 'Zayıf ağ bağlantısı için (~300 Kbps)',
    constraints: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '240p15', label: '240p 15fps (Minimum)', emoji: '🔴',
    description: 'En düşük bant genişliği — ses odaklı görüşmeler için',
    constraints: { width: { ideal: 426 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } },
  },
  { type: 'divider', label: 'Özel' },
  {
    value: 'auto', label: 'Otomatik (Tarayıcı seçer)', emoji: '🤖',
    description: 'Tarayıcıya bırak — en uygun çözünürlüğü seçer',
    constraints: {},
  },
];

// ── Modül ────────────────────────────────────────────────────

const STORAGE_KEY = 'bridge-video-quality';
const DEFAULT_QUALITY = '720p30';

class BridgeVideoQualityManager {
  private _quality: string;
  private _selectEl: HTMLElement | null = null;

  constructor() {
    this._quality = this._load();
  }

  private _load(): string {
    return localStorage.getItem(STORAGE_KEY) ?? DEFAULT_QUALITY;
  }

  private _save(q: string): void {
    localStorage.setItem(STORAGE_KEY, q);
    this._quality = q;
  }

  getConstraints(): VideoConstraints {
    const preset = VIDEO_QUALITY_PRESETS.find(
      (p): p is VideoQualityPreset => 'value' in p && p.value === this._quality,
    );
    return preset?.constraints ?? {};
  }

  getCurrentQuality(): string { return this._quality; }

  /** Settings modal'a Select bileşenini enjekte et */
  mountSettingsSelect(): void {
    const wrap = document.getElementById('video-quality-select-wrap') as
      (HTMLElement & { _duiMounted?: boolean }) | null;
    if (!wrap || wrap._duiMounted) return;
    wrap._duiMounted = true;

    const bridgeUI = BridgeRegistry.get<(...a: unknown[]) => unknown>('BridgeUI');
    if (!bridgeUI) {
      this._mountNativeSelect(wrap);
      return;
    }

    const ui = bridgeUI as unknown as {
      select(opts: Record<string, unknown>): HTMLElement;
      tooltip(el: HTMLElement, opts: Record<string, unknown>): void;
    };

    const selectEl = ui.select({
      id: 'video-quality-dui-select',
      options: VIDEO_QUALITY_PRESETS,
      value: this._quality,
      placeholder: 'Kalite seçin...',
      onChange: (vals: unknown) => {
        const val = Array.isArray(vals) ? vals[0] : vals;
        if (typeof val === 'string') this.applyQuality(val);
      },
    });

    this._selectEl = selectEl;
    wrap.appendChild(selectEl);

    ui.tooltip(wrap, {
      text: 'Kamera görüntüsünün çözünürlük ve kare hızını belirler',
      position: 'top',
    });
  }

  private _mountNativeSelect(wrap: HTMLElement): void {
    const sel = document.createElement('select');
    sel.className = 'input-field';
    sel.style.width = '100%';
    VIDEO_QUALITY_PRESETS
      .filter((p): p is VideoQualityPreset => !('type' in p))
      .forEach((p) => {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = `${p.emoji} ${p.label}`;
        if (p.value === this._quality) opt.selected = true;
        sel.appendChild(opt);
      });
    sel.addEventListener('change', () => this.applyQuality(sel.value));
    wrap.appendChild(sel);
  }

  applyQuality(quality: string): void {
    this._save(quality);
    const preset = VIDEO_QUALITY_PRESETS.find(
      (p): p is VideoQualityPreset => 'value' in p && p.value === quality,
    );
    const label = preset ? `${preset.emoji} ${preset.label}` : quality;

    // Aktif RTC oturumuna uygula
    const rtc = getRtc?.() as (null | { applyVideoConstraints?: (c: VideoConstraints) => void });
    if (rtc?.applyVideoConstraints) {
      rtc.applyVideoConstraints(this.getConstraints());
    }

    log.log(`[VideoQuality] ${label} uygulandı`);
  }
}

const _manager = new BridgeVideoQualityManager();

BridgeRegistry.register('BridgeVideoQuality', _manager as unknown as (...a: unknown[]) => unknown);

export const getBridgeVideoQuality = (): BridgeVideoQualityManager =>
  (BridgeRegistry.get('BridgeVideoQuality') as unknown as BridgeVideoQualityManager) ?? _manager;

export { BridgeVideoQualityManager };
