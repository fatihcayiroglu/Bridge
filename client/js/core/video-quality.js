// client/js/core/video-quality.js
// Kamera video kalitesi ayarları modülü
// Ayarlar modalındaki #video-quality-select-wrap'e Bridge UI Kit select enjekte eder
// ve seçilen kaliteyi webrtc.js'deki enableVideo'ya iletir.

'use strict';
import { getRtc } from './globals.js';

/* ── KALITE PREAYARLARı ────────────────────────────────────── */
const VIDEO_QUALITY_PRESETS = [
  {
    value: '1080p30',
    label: '1080p 30fps (Full HD)',
    emoji: '🌟',
    description: 'En yüksek kalite — iyi ağ bağlantısı gerektirir (~2-4 Mbps)',
    constraints: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '720p60',
    label: '720p 60fps (HD Akıcı)',
    emoji: '⚡',
    description: 'Akıcı video, yüksek kare hızı (~2 Mbps)',
    constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } },
  },
  {
    value: '720p30',
    label: '720p 30fps (HD — Önerilen)',
    emoji: '✅',
    description: 'En iyi denge: kalite ve bant genişliği (~1 Mbps)',
    constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '480p30',
    label: '480p 30fps (Standart)',
    emoji: '🔵',
    description: 'Düşük bant genişliği için (~600 Kbps)',
    constraints: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '360p30',
    label: '360p 30fps (Düşük)',
    emoji: '🟡',
    description: 'Zayıf ağ bağlantısı için (~300 Kbps)',
    constraints: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '240p15',
    label: '240p 15fps (Minimum)',
    emoji: '🔴',
    description: 'En düşük bant genişliği — ses odaklı görüşmeler için',
    constraints: { width: { ideal: 426 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } },
  },
  { type: 'divider', label: 'Özel' },
  {
    value: 'auto',
    label: 'Otomatik (Tarayıcı seçer)',
    emoji: '🤖',
    description: 'Tarayıcıya bırak — en uygun çözünürlüğü seçer',
    constraints: {},
  },
];

/* ── MODÜL ─────────────────────────────────────────────────── */
class BridgeVideoQualityManager {
  constructor() {
    this._quality = this._load();
    this._selectEl = null;
  }

  _load() {
    return localStorage.getItem('bridge-video-quality') || '720p30';
  }

  _save(q) {
    localStorage.setItem('bridge-video-quality', q);
    this._quality = q;
  }

  getConstraints() {
    const preset = VIDEO_QUALITY_PRESETS.find(p => p.value === this._quality);
    return preset?.constraints || {};
  }

  getCurrentQuality() { return this._quality; }

  /* Settings modal'a Select bileşenini enjekte et */
  mountSettingsSelect() {
    const wrap = document.getElementById('video-quality-select-wrap');
    if (!wrap || wrap._duiMounted) return;
    wrap._duiMounted = true;

    if (!window.BridgeUI) {
      // BridgeUI henüz yüklenmediyse fallback native select
      this._mountNativeSelect(wrap);
      return;
    }

    const selectEl = window.BridgeUI.select({
      id: 'video-quality-dui-select',
      options: VIDEO_QUALITY_PRESETS,
      value: this._quality,
      placeholder: 'Kalite seçin...',
      onChange: (vals) => {
        const val = Array.isArray(vals) ? vals[0] : vals;
        if (val) this.applyQuality(val);
      },
    });

    this._selectEl = selectEl;
    wrap.appendChild(selectEl);

    // Tooltip ekle
    window.BridgeUI.tooltip(wrap, {
      text: 'Kamera görüntüsünün çözünürlük ve kare hızını belirler',
      position: 'top',
    });
  }

  _mountNativeSelect(wrap) {
    const sel = document.createElement('select');
    sel.className = 'input-field';
    sel.style.width = '100%';
    VIDEO_QUALITY_PRESETS
      .filter(p => !p.type)
      .forEach(p => {
        const opt = document.createElement('option');
        opt.value = p.value;
        opt.textContent = `${p.emoji} ${p.label}`;
        if (p.value === this._quality) opt.selected = true;
        sel.appendChild(opt);
      });
    sel.addEventListener('change', () => this.applyQuality(sel.value));
    wrap.appendChild(sel);
  }

  applyQuality(quality) {
    this._save(quality);
    const preset = VIDEO_QUALITY_PRESETS.find(p => p.value === quality);
    const label = preset ? `${preset.emoji} ${preset.label}` : quality;
    console.log(`[VideoQuality] Kalite değiştirildi: ${quality}`);

    // Eğer şu an video açıksa yeniden başlat
    if (getRtc()?.videoOn) {
      getRtc().enableVideo(false).then(() => {
        return getRtc().enableVideo(true);
      }).then(ok => {
        if (ok) {
          window.bridgeApp?.toast(`📹 Video kalitesi: ${label}`, 'success');
          if (typeof attachLocalVideo === 'function') attachLocalVideo();
        }
      }).catch(() => {});
    } else {
      // Değişikliği kaydet, bir sonraki kamera açılışında uygulanır
      if (typeof toast === 'function') toast(`📹 Video kalitesi ayarlandı: ${label}`, 'info');
    }

    window.dispatchEvent(new CustomEvent('bridge:video-quality-changed', { detail: { quality, constraints: this.getConstraints() } }));
  }

  /* Mevcut video track üzerindeki istatistikleri göster (debug) */
  async getStats() {
    if (!getRtc()?.isInVoice()) return null;
    const stats = { quality: this._quality, tracks: [] };
    const stream = getRtc().getLocalStream?.();
    if (stream) {
      stream.getVideoTracks().forEach(t => {
        const settings = t.getSettings();
        stats.tracks.push({
          label: t.label,
          width: settings.width,
          height: settings.height,
          frameRate: settings.frameRate,
        });
      });
    }
    return stats;
  }
}

/* ── SINGLETON ────────────────────────────────────────────── */
window.BridgeVideoQuality = new BridgeVideoQualityManager();

/* ── SETTINGS MODAL ENTEGRASYONU ─────────────────────────── */
// Settings modal açılınca select'i mount et
window.addEventListener('bridge:settings-opened', () => {
  window.BridgeVideoQuality.mountSettingsSelect();
});

// Sayfa yüklenince de kontrol et (partial zaten yüklüyse)
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('video-quality-select-wrap')) {
    window.BridgeVideoQuality.mountSettingsSelect();
  }
});

console.log('[VideoQuality] Modül yüklendi ✓');

export const getBridgeVideoQuality = () => window.BridgeVideoQuality;
