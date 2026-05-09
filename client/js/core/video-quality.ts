// client/js/core/video-quality.js
// Kamera video kalitesi ayarlarÄ± modÃ¼lÃ¼
// Ayarlar modalÄ±ndaki #video-quality-select-wrap'e Bridge UI Kit select enjekte eder
// ve seÃ§ilen kaliteyi webrtc.js'deki enableVideo'ya iletir.

'use strict';

/* â”€â”€ KALITE PREAYARLARÄ± â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
const VIDEO_QUALITY_PRESETS = [
  {
    value: '1080p30',
    label: '1080p 30fps (Full HD)',
    emoji: 'ğŸŒŸ',
    description: 'En yÃ¼ksek kalite â€” iyi aÄŸ baÄŸlantÄ±sÄ± gerektirir (~2-4 Mbps)',
    constraints: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '720p60',
    label: '720p 60fps (HD AkÄ±cÄ±)',
    emoji: 'âš¡',
    description: 'AkÄ±cÄ± video, yÃ¼ksek kare hÄ±zÄ± (~2 Mbps)',
    constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } },
  },
  {
    value: '720p30',
    label: '720p 30fps (HD â€” Ã–nerilen)',
    emoji: 'âœ…',
    description: 'En iyi denge: kalite ve bant geniÅŸliÄŸi (~1 Mbps)',
    constraints: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '480p30',
    label: '480p 30fps (Standart)',
    emoji: 'ğŸ”µ',
    description: 'DÃ¼ÅŸÃ¼k bant geniÅŸliÄŸi iÃ§in (~600 Kbps)',
    constraints: { width: { ideal: 854 }, height: { ideal: 480 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '360p30',
    label: '360p 30fps (DÃ¼ÅŸÃ¼k)',
    emoji: 'ğŸŸ¡',
    description: 'ZayÄ±f aÄŸ baÄŸlantÄ±sÄ± iÃ§in (~300 Kbps)',
    constraints: { width: { ideal: 640 }, height: { ideal: 360 }, frameRate: { ideal: 30, max: 30 } },
  },
  {
    value: '240p15',
    label: '240p 15fps (Minimum)',
    emoji: 'ğŸ”´',
    description: 'En dÃ¼ÅŸÃ¼k bant geniÅŸliÄŸi â€” ses odaklÄ± gÃ¶rÃ¼ÅŸmeler iÃ§in',
    constraints: { width: { ideal: 426 }, height: { ideal: 240 }, frameRate: { ideal: 15, max: 15 } },
  },
  { type: 'divider', label: 'Ã–zel' },
  {
    value: 'auto',
    label: 'Otomatik (TarayÄ±cÄ± seÃ§er)',
    emoji: 'ğŸ¤–',
    description: 'TarayÄ±cÄ±ya bÄ±rak â€” en uygun Ã§Ã¶zÃ¼nÃ¼rlÃ¼ÄŸÃ¼ seÃ§er',
    constraints: {},
  },
];

/* â”€â”€ MODÃœL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
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

  /* Settings modal'a Select bileÅŸenini enjekte et */
  mountSettingsSelect() {
    const wrap = document.getElementById('video-quality-select-wrap');
    if (!wrap || wrap._duiMounted) return;
    wrap._duiMounted = true;

    if (!window.BridgeUI) {
      // BridgeUI henÃ¼z yÃ¼klenmediyse fallback native select
      this._mountNativeSelect(wrap);
      return;
    }

    const selectEl = window.BridgeUI.select({
      id: 'video-quality-dui-select',
      options: VIDEO_QUALITY_PRESETS,
      value: this._quality,
      placeholder: 'Kalite seÃ§in...',
      onChange: (vals) => {
        const val = Array.isArray(vals) ? vals[0] : vals;
        if (val) this.applyQuality(val);
      },
    });

    this._selectEl = selectEl;
    wrap.appendChild(selectEl);

    // Tooltip ekle
    window.BridgeUI.tooltip(wrap, {
      text: 'Kamera gÃ¶rÃ¼ntÃ¼sÃ¼nÃ¼n Ã§Ã¶zÃ¼nÃ¼rlÃ¼k ve kare hÄ±zÄ±nÄ± belirler',
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
    console.log(`[VideoQuality] Kalite deÄŸiÅŸtirildi: ${quality}`);

    // EÄŸer ÅŸu an video aÃ§Ä±ksa yeniden baÅŸlat
    if (window.rtc?.videoOn) {
      window.rtc.enableVideo(false).then(() => {
        return window.rtc.enableVideo(true);
      }).then(ok => {
        if (ok) {
          window.bridgeApp?.toast(`ğŸ“¹ Video kalitesi: ${label}`, 'success');
          if (typeof attachLocalVideo === 'function') attachLocalVideo();
        }
      }).catch(() => {});
    } else {
      // DeÄŸiÅŸikliÄŸi kaydet, bir sonraki kamera aÃ§Ä±lÄ±ÅŸÄ±nda uygulanÄ±r
      if (typeof toast === 'function') toast(`ğŸ“¹ Video kalitesi ayarlandÄ±: ${label}`, 'info');
    }

    window.dispatchEvent(new CustomEvent('bridge:video-quality-changed', { detail: { quality, constraints: this.getConstraints() } }));
  }

  /* Mevcut video track Ã¼zerindeki istatistikleri gÃ¶ster (debug) */
  async getStats() {
    if (!window.rtc?.isInVoice()) return null;
    const stats = { quality: this._quality, tracks: [] };
    const stream = window.rtc.getLocalStream?.();
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

/* â”€â”€ SINGLETON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
window.BridgeVideoQuality = new BridgeVideoQualityManager();

/* â”€â”€ SETTINGS MODAL ENTEGRASYONU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
// Settings modal aÃ§Ä±lÄ±nca select'i mount et
window.addEventListener('bridge:settings-opened', () => {
  window.BridgeVideoQuality.mountSettingsSelect();
});

// Sayfa yÃ¼klenince de kontrol et (partial zaten yÃ¼klÃ¼yse)
document.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('video-quality-select-wrap')) {
    window.BridgeVideoQuality.mountSettingsSelect();
  }
});

console.log('[VideoQuality] ModÃ¼l yÃ¼klendi âœ“');

