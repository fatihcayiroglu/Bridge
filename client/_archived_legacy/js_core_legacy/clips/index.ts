// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/IndexPanel.svelte
//              client/js/core/index-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/clips/index.ts
// Sprint 82: Clips sistemi — Sesli/video kanalda otomatik son N saniye buffer kaydı
// MediaRecorder API ile rolling buffer, kullanıcı "Klip Kaydet" dediğinde son 30s'yi dışa aktarır.

import { getSocket } from '../globals.js';
import { BridgeRegistry } from '../bridge-registry.js';

// ── Config ────────────────────────────────────────────────────────────────────

const BUFFER_DURATION_MS    = 30_000;  // 30 saniyelik rolling buffer
const CLIP_MIN_MS           = 5_000;   // minimum klip süresi
const CLIP_MAX_MS           = 60_000;  // maksimum klip süresi (1 dakika)
const CHUNK_INTERVAL_MS     = 500;     // MediaRecorder timeslice

// ── State ─────────────────────────────────────────────────────────────────────

let _mediaRecorder: MediaRecorder | null = null;
let _buffer: Array<{ blob: Blob; timestamp: number }> = [];
let _stream: MediaStream | null = null;
let _isRecording = false;
let _channelId   = '';

// ── MediaRecorder ─────────────────────────────────────────────────────────────

function _getBestMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'audio/webm;codecs=opus',
    'audio/webm',
  ];
  return candidates.find(m => MediaRecorder.isTypeSupported(m)) ?? '';
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * startClipBuffer — sesli/video kanala girildiğinde çağrılır.
 * Var olan stream'i (ses+video veya sadece ses) klip buffer'a bağlar.
 */
export async function startClipBuffer(stream: MediaStream, channelId: string): Promise<void> {
  if (_isRecording) stopClipBuffer();

  _stream    = stream;
  _channelId = channelId;
  _buffer    = [];

  const mimeType = _getBestMimeType();
  const options: MediaRecorderOptions = mimeType ? { mimeType } : {};

  try {
    _mediaRecorder = new MediaRecorder(stream, options);
  } catch (err) {
    console.warn('[Clips] MediaRecorder oluşturulamadı:', err);
    return;
  }

  _mediaRecorder.ondataavailable = (e: BlobEvent) => {
    if (e.data.size > 0) {
      const now = Date.now();
      _buffer.push({ blob: e.data, timestamp: now });

      // Rolling buffer — BUFFER_DURATION_MS'den eski chunk'ları temizle
      const cutoff = now - BUFFER_DURATION_MS;
      _buffer = _buffer.filter(c => c.timestamp >= cutoff);
    }
  };

  _mediaRecorder.start(CHUNK_INTERVAL_MS);
  _isRecording = true;

  // Arayüzde "REC" göstergesi
  _showRecordingIndicator();
}

/**
 * stopClipBuffer — kanaldan çıkılırken çağrılır.
 */
export function stopClipBuffer(): void {
  if (_mediaRecorder && _mediaRecorder.state !== 'inactive') {
    _mediaRecorder.stop();
  }
  _mediaRecorder = null;
  _buffer        = [];
  _isRecording   = false;
  _stream        = null;
  _hideRecordingIndicator();
}

/**
 * saveClip — son X saniyeyi dosya olarak indirir ve sunucuya yükler.
 * @param durationMs İstenen klip süresi (ms), varsayılan 30s
 */
export async function saveClip(durationMs = BUFFER_DURATION_MS): Promise<string | null> {
  if (!_isRecording || _buffer.length === 0) {
    _showToast('Klip için yeterli buffer yok.', 'error');
    return null;
  }

  const clampedMs = Math.min(Math.max(durationMs, CLIP_MIN_MS), CLIP_MAX_MS);
  const cutoff    = Date.now() - clampedMs;
  const chunks    = _buffer.filter(c => c.timestamp >= cutoff).map(c => c.blob);

  if (chunks.length === 0) {
    _showToast('Klip için yeterli buffer yok.', 'error');
    return null;
  }

  const mimeType = _mediaRecorder?.mimeType ?? 'video/webm';
  const blob     = new Blob(chunks, { type: mimeType });
  const ext      = mimeType.startsWith('audio') ? 'weba' : 'webm';
  const filename = `bridge-clip-${Date.now()}.${ext}`;

  // 1) Yerel indirme
  _downloadBlob(blob, filename);

  // 2) Sunucuya yükle (opsiyonel — socket ile bildir)
  const socket = getSocket();
  if (socket) {
    const arrayBuffer = await blob.arrayBuffer();
    socket.emit('clip:save', {
      channelId:  _channelId,
      filename,
      mimeType,
      sizeBytes:  blob.size,
      durationMs: clampedMs,
    });
  }

  _showToast(`✂️ Klip kaydedildi: ${filename}`, 'success');

  return filename;
}

/**
 * isBuffering — klip buffer aktif mi?
 */
export function isBuffering(): boolean {
  return _isRecording;
}

/**
 * getBufferDurationMs — buffer'daki gerçek veri süresi
 */
export function getBufferDurationMs(): number {
  if (_buffer.length < 2) return 0;
  const first = _buffer[0]!.timestamp;
  const last  = _buffer[_buffer.length - 1]!.timestamp;
  return last - first;
}

// ── Quick Clip (son 30s otomatik) ─────────────────────────────────────────────

export async function quickClip(): Promise<void> {
  await saveClip(BUFFER_DURATION_MS);
}

// ── Clip Picker UI ────────────────────────────────────────────────────────────

export function openClipDurationPicker(): void {
  const existing = document.getElementById('clip-picker-modal');
  if (existing) { existing.remove(); return; }

  const buffMs = getBufferDurationMs();
  const maxSec = Math.floor(Math.min(buffMs, CLIP_MAX_MS) / 1000);

  const modal = document.createElement('div');
  modal.id = 'clip-picker-modal';
  modal.className = 'clip-picker-modal';
  modal.innerHTML = `
    <div class="clip-picker-inner">
      <h3>✂️ Klip Kaydet</h3>
      <p>Buffer: <strong>${Math.floor(buffMs / 1000)}s</strong> | Maks: ${maxSec}s</p>
      <label for="clip-duration-input">Süre (saniye):</label>
      <input id="clip-duration-input" type="range" min="5" max="${maxSec}" value="${Math.min(30, maxSec)}" step="5">
      <span id="clip-duration-label">${Math.min(30, maxSec)}s</span>
      <div class="clip-picker-actions">
        <button id="clip-save-btn" class="btn-primary">Kaydet</button>
        <button id="clip-cancel-btn" class="btn-secondary">İptal</button>
      </div>
    </div>
  `;

  const slider = modal.querySelector<HTMLInputElement>('#clip-duration-input')!;
  const label  = modal.querySelector<HTMLSpanElement>('#clip-duration-label')!;
  slider.addEventListener('input', () => { label.textContent = `${slider.value}s`; });

  modal.querySelector('#clip-save-btn')?.addEventListener('click', async () => {
    modal.remove();
    await saveClip(parseInt(slider.value) * 1000);
  });
  modal.querySelector('#clip-cancel-btn')?.addEventListener('click', () => modal.remove());
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.remove(); });

  document.body.appendChild(modal);
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function _showToast(msg: string, type: 'success' | 'error' | 'info' = 'info'): void {
  const fn = (window as Record<string, unknown>)['showToast'] as ((m: string, t?: string) => void) | undefined;
  fn?.(msg, type);
}

let _recIndicatorEl: HTMLElement | null = null;

function _showRecordingIndicator(): void {
  if (_recIndicatorEl) return;
  const el = document.createElement('div');
  el.id = 'clip-rec-indicator';
  el.style.cssText = `
    position: fixed; bottom: 80px; right: 16px;
    background: rgba(0,0,0,0.75); color: #fff;
    padding: 4px 10px; border-radius: 12px;
    font-size: 11px; pointer-events: none;
    z-index: 9999; display: flex; align-items: center; gap: 6px;
  `;
  el.innerHTML = '<span style="color:#ED4245;animation:blink 1s infinite">●</span> Klip buffer aktif';

  if (!document.getElementById('clip-blink-style')) {
    const s = document.createElement('style');
    s.id = 'clip-blink-style';
    s.textContent = '@keyframes blink{0%,100%{opacity:1}50%{opacity:0}}';
    document.head.appendChild(s);
  }

  document.body.appendChild(el);
  _recIndicatorEl = el;
}

function _hideRecordingIndicator(): void {
  _recIndicatorEl?.remove();
  _recIndicatorEl = null;
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initClips(): void {
  BridgeRegistry.register('startClipBuffer',       startClipBuffer);
  BridgeRegistry.register('stopClipBuffer',        stopClipBuffer);
  BridgeRegistry.register('saveClip',              saveClip);
  BridgeRegistry.register('quickClip',             quickClip);
  BridgeRegistry.register('openClipDurationPicker', openClipDurationPicker);
  BridgeRegistry.register('isBuffering',           isBuffering);
}
