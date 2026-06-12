// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VoiceRecorderPanel.svelte
//              client/js/core/voice-recorder-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/voice-recorder.ts — Bridge Voice Recording
// MediaRecorder API ile ses kaydı, server upload, dinleme UI
//
// Özellikler:
//   - Tarayıcı MediaRecorder API (WebM/Opus codec)
//   - Gerçek zamanlı ses seviyesi görselleştirme (waveform)
//   - /api/voice-messages endpoint'ine upload
//   - Inline audio player (waveform + seek + speed control)
//   - Noise suppression entegrasyonu (BridgeNoiseSuppression)
//   - Stage → Podcast akışı için kayıt desteği
//   - Keyboard shortcut: hold-to-record (Push to Talk)

'use strict';
import { BridgeRegistry } from './bridge-registry.js';
import { getCurrentChannel, getCurrentServer } from './globals.js';

import { createLogger } from './logger.js';
const log = createLogger('VoiceRecorder');


class BridgeVoiceRecorder {
  options: Record<string, unknown>;
  _mediaRecorder: MediaRecorder | null;
  _stream: MediaStream | null;
  _chunks: Blob[];
  _startTime: number | null;
  _durationTimer: ReturnType<typeof setInterval> | null;
  _maxTimer: ReturnType<typeof setTimeout> | null;
  _analyser: AnalyserNode | null;
  _audioCtx: AudioContext | null;
  _animFrame: number | null;
  _noiseSuppressor: unknown;
  state: string;

  constructor(options: Record<string, unknown> = {}) {
    this.options = {
      maxDuration: options.maxDuration || 300_000, // 5 dakika
      mimeType: options.mimeType || this._bestMimeType(),
      audioBitsPerSecond: options.audioBitsPerSecond || 96_000,
      noiseSuppression: options.noiseSuppression !== false,
      channelId: options.channelId || null,
      serverId: options.serverId || null,
      onStart: options.onStart || (() => {}),
      onStop: options.onStop || (() => {}),
      onUpload: options.onUpload || (() => {}),
      onError: options.onError || ((e) => log.error('[VoiceRec]', e)),
    };

    this._mediaRecorder = null;
    this._stream = null;
    this._chunks = [];
    this._startTime = null;
    this._durationTimer = null;
    this._maxTimer = null;
    this._analyser = null;
    this._audioCtx = null;
    this._animFrame = null;
    this._noiseSuppressor = null;

    this.state = 'idle'; // idle | recording | uploading
  }

  // ── Codec Seçimi ─────────────────────────────────────────
  _bestMimeType() {
    const candidates = [
      'audio/webm;codecs=opus',
      'audio/webm',
      'audio/ogg;codecs=opus',
      'audio/mp4',
    ];
    return candidates.find((t) => MediaRecorder.isTypeSupported(t)) || '';
  }

  // ── Kayıt Başlat ─────────────────────────────────────────
  async start() {
    if (this.state !== 'idle') return;

    try {
      // Mikrofon izni iste
      const rawStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
          sampleRate: 48000,
          channelCount: 1,
        },
      });

      // Noise suppression uygula (varsa)
      let stream = rawStream;
      if (this.options.noiseSuppression && BridgeRegistry.get('BridgeNoiseSuppression')) {
        try {
          type NSConstructor = new() => { init(): Promise<void>; process(s: MediaStream): Promise<MediaStream>; dispose?(): void };
          const NS = BridgeRegistry.get('BridgeNoiseSuppression') as unknown as NSConstructor;
          this._noiseSuppressor = new NS();
          await this._noiseSuppressor.init();
          stream = await this._noiseSuppressor.process(rawStream);
        } catch (nsErr) {
          log.warn('[VoiceRec] Noise suppression yüklenemedi, ham stream kullanılıyor:', nsErr);
          stream = rawStream;
        }
      }

      this._stream = stream;
      this._chunks = [];
      this._startTime = Date.now();

      // Waveform için analyser
      this._setupAnalyser(stream);

      // MediaRecorder oluştur
      const recOptions = { audioBitsPerSecond: this.options.audioBitsPerSecond };
      if (this.options.mimeType) recOptions.mimeType = this.options.mimeType;

      this._mediaRecorder = new MediaRecorder(stream, recOptions);

      this._mediaRecorder.ondataavailable = (e) => {
        if (e.data?.size > 0) this._chunks.push(e.data);
      };

      this._mediaRecorder.onstop = () => this._onRecordingStop();
      this._mediaRecorder.onerror = (e) => this.options.onError(e.error || e);

      // Her 250ms'de chunk al (smooth upload için)
      this._mediaRecorder.start(250);
      this.state = 'recording';

      // Maksimum süre timer
      this._maxTimer = setTimeout(() => this.stop(), this.options.maxDuration);

      this.options.onStart({ stream });
    } catch (err) {
      this.state = 'idle';
      this.options.onError(err);
    }
  }

  // ── Kayıt Durdur ─────────────────────────────────────────
  stop() {
    if (this.state !== 'recording') return;
    clearTimeout(this._maxTimer);
    this._stopAnalyser();
    if (this._mediaRecorder?.state !== 'inactive') {
      this._mediaRecorder.stop();
    }
  }

  // ── Kayıt İptal ──────────────────────────────────────────
  cancel() {
    if (this.state === 'idle') return;
    clearTimeout(this._maxTimer);
    this._stopAnalyser();
    this._chunks = [];
    if (this._mediaRecorder?.state !== 'inactive') {
      this._mediaRecorder.ondataavailable = null;
      this._mediaRecorder.onstop = null;
      this._mediaRecorder.stop();
    }
    this._cleanup();
    this.state = 'idle';
  }

  // ── Kayıt Bitti ──────────────────────────────────────────
  async _onRecordingStop() {
    const duration = Math.round((Date.now() - this._startTime) / 1000);
    const blob = new Blob(this._chunks, { type: this.options.mimeType || 'audio/webm' });
    this._cleanup();

    this.options.onStop({ blob, duration });

    if (this.options.channelId && this.options.serverId) {
      await this._upload(blob, duration);
    }
  }

  // ── Upload ───────────────────────────────────────────────
  async _upload(blob, duration) {
    this.state = 'uploading';

    const formData = new FormData();
    const ext = this.options.mimeType?.includes('ogg') ? 'ogg' : 'webm';
    formData.append('audio', blob, `voice_${Date.now()}.${ext}`);
    formData.append('channelId', this.options.channelId);
    formData.append('serverId', this.options.serverId);
    formData.append('duration', duration.toString());

    const token = localStorage.getItem('token') || localStorage.getItem('bridge_token');

    try {
      const res = await fetch('/api/voice-messages', {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      if (!res.ok) throw new Error(`Upload başarısız: ${res.status}`);

      const data = await res.json();
      this.state = 'idle';
      this.options.onUpload({ ok: true, data, blob, duration });
    } catch (err) {
      this.state = 'idle';
      this.options.onError(err);
      this.options.onUpload({ ok: false, error: err });
    }
  }

  // ── Waveform Analyser ────────────────────────────────────
  _setupAnalyser(stream) {
    try {
      this._audioCtx = new AudioContext();
      this._analyser = this._audioCtx.createAnalyser();
      this._analyser.fftSize = 256;
      const source = this._audioCtx.createMediaStreamSource(stream);
      source.connect(this._analyser);
    } catch { /* analyser opsiyonel */ }
  }

  _stopAnalyser() {
    cancelAnimationFrame(this._animFrame);
    this._analyser = null;
    this._audioCtx?.close().catch(() => {});
    this._audioCtx = null;
  }

  /**
   * Waveform canvas'ına çiz
   * @param {HTMLCanvasElement} canvas
   */
  drawWaveform(canvas) {
    if (!this._analyser || !canvas) return;
    const ctx = canvas.getContext('2d');
    const data = new Uint8Array(this._analyser.frequencyBinCount);

    const draw = () => {
      if (!this._analyser) return;
      this._animFrame = requestAnimationFrame(draw);
      this._analyser.getByteFrequencyData(data);

      const W = canvas.width;
      const H = canvas.height;
      ctx.clearRect(0, 0, W, H);

      const barW = (W / data.length) * 2.5;
      let x = 0;

      data.forEach((value) => {
        const barH = (value / 255) * H;
        const hue = 220 + (value / 255) * 60; // mavi → mor
        ctx.fillStyle = `hsl(${hue}, 80%, 60%)`;
        ctx.fillRect(x, H - barH, barW, barH);
        x += barW + 1;
      });
    };

    draw();
  }

  /**
   * Anlık ses seviyesi (0-1)
   */
  getLevel() {
    if (!this._analyser) return 0;
    const data = new Uint8Array(this._analyser.frequencyBinCount);
    this._analyser.getByteFrequencyData(data);
    const avg = data.reduce((s, v) => s + v, 0) / data.length;
    return avg / 255;
  }

  /**
   * Kayıt süresi (saniye)
   */
  getDuration() {
    if (!this._startTime) return 0;
    return Math.round((Date.now() - this._startTime) / 1000);
  }

  _cleanup() {
    this._stream?.getTracks().forEach((t) => t.stop());
    this._stream = null;
    this._noiseSuppressor?.dispose?.();
    this._noiseSuppressor = null;
  }
}

// ────────────────────────────────────────────────────────────
// VoiceMessage Player — Ses mesajı dinleme UI bileşeni
// ────────────────────────────────────────────────────────────

class VoiceMessagePlayer {
  vm: unknown;
  container: HTMLElement;
  audio: HTMLAudioElement | null;
  _raf: number | null;

  /**
   * @param {Object} voiceMsg - { fileUrl, duration, transcript, _id }
   * @param {HTMLElement} container - Render edilecek element
   */
  constructor(voiceMsg: Record<string, unknown>, container: HTMLElement) {
    this.vm = voiceMsg;
    this.container = container;
    this.audio = null;
    this._raf = null;
    this._render();
  }

  _render() {
    const { fileUrl, duration, transcript } = this.vm;
    const totalStr = this._fmtTime(duration || 0);

    this.container.innerHTML = `
      <div class="vm-player" style="
        display:flex; align-items:center; gap:10px;
        background:var(--bg-secondary,#2f3136);
        border-radius:20px; padding:8px 14px;
        max-width:360px; user-select:none;
      ">
        <button class="vm-play-btn" style="
          width:36px; height:36px; border-radius:50%;
          background:var(--accent,#2d9cdb); border:none;
          cursor:pointer; display:flex; align-items:center; justify-content:center;
          color:#fff; font-size:14px; flex-shrink:0;
          transition:background 0.15s;
        ">â–¶</button>

        <div style="flex:1; min-width:0;">
          <div class="vm-waveform-container" style="position:relative; height:32px; cursor:pointer;">
            <canvas class="vm-waveform" height="32" style="width:100%; height:100%;"></canvas>
            <div class="vm-progress-overlay" style="
              position:absolute; top:0; left:0; height:100%;
              background:rgba(45,156,219,0.3); width:0%;
              pointer-events:none; transition:width 0.1s linear;
            "></div>
          </div>
          <div style="display:flex; justify-content:space-between; margin-top:2px;">
            <span class="vm-current-time" style="font-size:11px; color:var(--text-muted,#72767d);">0:00</span>
            <span class="vm-duration" style="font-size:11px; color:var(--text-muted,#72767d);">${totalStr}</span>
          </div>
        </div>

        <div class="vm-speed-btn" style="
          font-size:11px; color:var(--text-muted,#72767d);
          cursor:pointer; min-width:32px; text-align:center;
          padding:3px 6px; border-radius:8px;
          background:var(--bg-tertiary,#202225);
        ">1×</div>
      </div>
      ${transcript ? `
        <div class="vm-transcript" style="
          margin-top:4px; font-size:12px;
          color:var(--text-muted,#72767d); font-style:italic;
          max-width:360px; line-height:1.4;
        ">ğŸ’¬ ${this._escHtml(transcript)}</div>
      ` : ''}
    `;

    this.audio = new Audio(fileUrl);
    this.audio.preload = 'metadata';

    this._bindEvents();
    this._drawStaticWaveform();
  }

  _bindEvents() {
    const playBtn = this.container.querySelector('.vm-play-btn');
    const waveContainer = this.container.querySelector('.vm-waveform-container');
    const speedBtn = this.container.querySelector('.vm-speed-btn');
    const progress = this.container.querySelector('.vm-progress-overlay');
    const currentTimeEl = this.container.querySelector('.vm-current-time');
    const canvas = this.container.querySelector('.vm-waveform');

    const speeds = [1, 1.5, 2, 0.5];
    let speedIdx = 0;

    // Play / Pause
    playBtn.addEventListener('click', () => {
      if (this.audio.paused) {
        this.audio.play();
        playBtn.textContent = 'â¸';
        this._startProgress(progress, currentTimeEl, canvas);
      } else {
        this.audio.pause();
        playBtn.textContent = 'â–¶';
        cancelAnimationFrame(this._raf);
      }
    });

    // Bitti
    this.audio.addEventListener('ended', () => {
      playBtn.textContent = 'â–¶';
      cancelAnimationFrame(this._raf);
      progress.style.width = '0%';
      currentTimeEl.textContent = '0:00';
    });

    // Waveform'a tıklayarak seek
    waveContainer.addEventListener('click', (e) => {
      const rect = waveContainer.getBoundingClientRect();
      const ratio = (e.clientX - rect.left) / rect.width;
      this.audio.currentTime = ratio * (this.audio.duration || 0);
    });

    // Hız değiştir
    speedBtn.addEventListener('click', () => {
      speedIdx = (speedIdx + 1) % speeds.length;
      const spd = speeds[speedIdx];
      this.audio.playbackRate = spd;
      speedBtn.textContent = `${spd}×`;
    });
  }

  _startProgress(progressEl, currentTimeEl, canvas) {
    const update = () => {
      if (!this.audio || this.audio.paused) return;
      const ratio = this.audio.currentTime / (this.audio.duration || 1);
      progressEl.style.width = `${ratio * 100}%`;
      currentTimeEl.textContent = this._fmtTime(Math.floor(this.audio.currentTime));
      this._raf = requestAnimationFrame(update);
    };
    this._raf = requestAnimationFrame(update);
  }

  // Statik placeholder waveform
  _drawStaticWaveform() {
    const canvas = this.container.querySelector('.vm-waveform');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    canvas.width = canvas.offsetWidth || 200;
    const W = canvas.width;
    const H = canvas.height;
    const bars = 40;
    const barW = W / bars - 1;

    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < bars; i++) {
      // Ses mesajlarına özgü görünüm — ortada yüksek
      const ratio = Math.sin((i / bars) * Math.PI);
      const noise = 0.3 + Math.random() * 0.7;
      const barH = Math.max(3, ratio * noise * (H - 6));
      ctx.fillStyle = 'rgba(45,156,219,0.45)';
      ctx.beginPath();
      ctx.roundRect(i * (barW + 1), (H - barH) / 2, barW, barH, 2);
      ctx.fill();
    }
  }

  _fmtTime(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${String(s).padStart(2, '0')}`;
  }

  _escHtml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  destroy() {
    cancelAnimationFrame(this._raf);
    this.audio?.pause();
    this.audio = null;
  }
}

// ────────────────────────────────────────────────────────────
// VoiceRecorderUI — Sohbet çubuğuna entegre UI
// ────────────────────────────────────────────────────────────

class VoiceRecorderUI {
  channelId: string | null;
  serverId: string | null;
  recorder: unknown;
  _btn: HTMLButtonElement | null;
  _popup: HTMLElement | null;
  _canvas: HTMLCanvasElement | null;
  _timerEl: HTMLElement | null;
  _timerInterval: ReturnType<typeof setInterval> | null;

  constructor(options: Record<string, unknown> = {}) {
    this.channelId = options.channelId;
    this.serverId = options.serverId;
    this.recorder = null;
    this._btn = null;
    this._popup = null;
    this._canvas = null;
    this._timerEl = null;
    this._timerInterval = null;

    this._init();
  }

  _init() {
    // Mikrofon butonunu oluştur
    this._btn = document.createElement('button');
    this._btn.className = 'vm-record-btn';
    this._btn.title = 'Ses mesajı gönder';
    this._btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 2a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V5a3 3 0 0 1 3-3z"/>
        <path d="M19 11a7 7 0 0 1-14 0H3a9 9 0 0 0 18 0h-2z"/>
        <line x1="12" y1="20" x2="12" y2="23" stroke="currentColor" stroke-width="2"/>
      </svg>
    `;
    this._btn.style.cssText = `
      background: none; border: none; cursor: pointer;
      color: var(--text-muted, #72767d); padding: 6px;
      border-radius: 4px; transition: color 0.15s;
    `;

    this._btn.addEventListener('mouseenter', () => {
      this._btn.style.color = 'var(--text-normal, #dcddde)';
    });
    this._btn.addEventListener('mouseleave', () => {
      if (!this.recorder || this.recorder.state !== 'recording') {
        this._btn.style.color = 'var(--text-muted, #72767d)';
      }
    });

    this._btn.addEventListener('click', () => this._toggleRecording());

    // Klavye kısayolu: Alt+R
    document.addEventListener('keydown', (e) => {
      if (e.altKey && e.key === 'r') this._toggleRecording();
    });
  }

  async _toggleRecording() {
    if (!this.recorder || this.recorder.state === 'idle') {
      await this._startRecording();
    } else if (this.recorder.state === 'recording') {
      this._stopRecording();
    }
  }

  async _startRecording() {
    this.recorder = new BridgeVoiceRecorder({
      channelId: this.channelId,
      serverId: this.serverId,
      onStart: () => this._showRecordingUI(),
      onStop: ({ duration }) => {
        log.log(`[VoiceUI] Kayıt durduruldu: ${duration}s`);
      },
      onUpload: ({ ok, data }) => {
        this._hideRecordingUI();
        if (!ok) this._showError('Upload başarısız');
      },
      onError: (err) => {
        this._hideRecordingUI();
        if (err.name === 'NotAllowedError') {
          this._showError('Mikrofon erişimi reddedildi');
        } else {
          this._showError('Ses kaydı başlatılamadı');
        }
      },
    });

    await this.recorder.start();
  }

  _stopRecording() {
    this.recorder?.stop();
  }

  _showRecordingUI() {
    // Buton kırmızı yap
    this._btn.style.color = '#ed4245';
    this._btn.title = 'Gönder (tekrar tıkla)';

    // Popup oluştur
    this._popup = document.createElement('div');
    this._popup.className = 'vm-recording-popup';
    this._popup.style.cssText = `
      position: fixed; bottom: 70px; left: 50%; transform: translateX(-50%);
      background: var(--bg-secondary, #2f3136);
      border: 1px solid var(--bg-tertiary, #202225);
      border-radius: 12px; padding: 12px 16px;
      display: flex; align-items: center; gap: 12px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.4);
      z-index: 9999; min-width: 280px;
    `;

    // Timer
    this._timerEl = document.createElement('span');
    this._timerEl.style.cssText = 'font-size:13px; color:var(--text-normal,#dcddde); min-width:40px;';
    this._timerEl.textContent = '0:00';

    // Waveform canvas
    this._canvas = document.createElement('canvas');
    this._canvas.width = 160;
    this._canvas.height = 32;
    this._canvas.style.cssText = 'flex:1; height:32px;';

    // İptal butonu
    const cancelBtn = document.createElement('button');
    cancelBtn.textContent = '✕';
    cancelBtn.style.cssText = `
      background: none; border: none; cursor: pointer;
      color: var(--text-muted, #72767d); font-size: 16px; padding: 4px;
    `;
    cancelBtn.addEventListener('click', () => {
      this.recorder?.cancel();
      this._hideRecordingUI();
    });

    this._popup.append(
      Object.assign(document.createElement('div'), {
        style: 'width:10px; height:10px; border-radius:50%; background:#ed4245; animation:pulse 1s infinite;',
      }),
      this._timerEl,
      this._canvas,
      cancelBtn
    );

    document.body.appendChild(this._popup);

    // Timer
    let secs = 0;
    this._timerInterval = setInterval(() => {
      secs++;
      const m = Math.floor(secs / 60);
      const s = secs % 60;
      this._timerEl.textContent = `${m}:${String(s).padStart(2, '0')}`;
    }, 1000);

    // Waveform
    if (this.recorder) {
      this.recorder.drawWaveform(this._canvas);
    }
  }

  _hideRecordingUI() {
    clearInterval(this._timerInterval);
    this._popup?.remove();
    this._popup = null;
    this._canvas = null;
    this._timerEl = null;
    this._btn.style.color = 'var(--text-muted, #72767d)';
    this._btn.title = 'Ses mesajı gönder';
  }

  _showError(msg) {
    const toast = document.createElement('div');
    toast.textContent = `ğŸ¤ ${msg}`;
    toast.style.cssText = `
      position:fixed; bottom:20px; left:50%; transform:translateX(-50%);
      background:#ed4245; color:#fff; padding:8px 16px; border-radius:8px;
      font-size:13px; z-index:9999;
    `;
    document.body.appendChild(toast);
    setTimeout(() => toast.remove(), 3000);
  }

  /**
   * Butonu bir container'a ekle
   * @param {HTMLElement} container
   */
  mount(container) {
    container.appendChild(this._btn);
    return this;
  }

  /**
   * Kanal değiştir (sayfa navigasyonunda)
   */
  setChannel(channelId, serverId) {
    this.channelId = channelId;
    this.serverId = serverId;
  }
}

// ── Modül-scoped UI instance ─────────────────────────────
let _voiceRecorderUI: VoiceRecorderUI | null = null;

// ── CSS Animasyon ─────────────────────────────────────────
if (!document.getElementById('vm-styles')) {
  const style = document.createElement('style');
  style.id = 'vm-styles';
  style.textContent = `
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    .vm-play-btn:hover { background: var(--accent-hover, #1a6b8a) !important; }
    .vm-waveform-container:hover .vm-progress-overlay { background: rgba(45,156,219,0.45); }
  `;
  document.head.appendChild(style);
}

// ── Global Export ─────────────────────────────────────────
BridgeRegistry.register('BridgeVoiceRecorder', BridgeVoiceRecorder as unknown as (...a: unknown[]) => unknown);
BridgeRegistry.register('VoiceMessagePlayer', VoiceMessagePlayer as unknown as (...a: unknown[]) => unknown);
BridgeRegistry.register('VoiceRecorderUI', VoiceRecorderUI as unknown as (...a: unknown[]) => unknown);

// ── Otomatik init (eğer chat input varsa) ────────────────
document.addEventListener('DOMContentLoaded', () => {
  // Mevcut mesaj giriş alanının yanına mikrofon butonu ekle
  const init = () => {
    const inputArea = document.querySelector('.message-input-area, .chat-input, #message-form');
    if (!inputArea || document.querySelector('.vm-record-btn')) return;

    const channelId = (getCurrentChannel() as Record<string, unknown> | null)?._id as string | null ?? null;
    const serverId = (getCurrentServer() as Record<string, unknown> | null)?._id as string | null ?? null;

    _voiceRecorderUI = new VoiceRecorderUI({ channelId, serverId });
    _voiceRecorderUI.mount(inputArea);
  };

  // Socket event'leri dinle — kanal değiştiğinde güncelle
  init();
  document.addEventListener('bridge:channel-changed', (e) => {
    const { channelId, serverId } = e.detail || {};
    if (_voiceRecorderUI) {
      _voiceRecorderUI.setChannel(channelId, serverId);
    } else {
      _voiceRecorderUI = new VoiceRecorderUI({ channelId, serverId });
      const inputArea = document.querySelector('.message-input-area, .chat-input');
      if (inputArea) _voiceRecorderUI.mount(inputArea as HTMLElement);
    }
  });
});

