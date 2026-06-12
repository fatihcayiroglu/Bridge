// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/DmCallPanel.svelte
//              client/js/core/dm-call-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { BridgeRegistry } from './bridge-registry.js';

import { createLogger } from './logger.js';
const log = createLogger('DmCall');

// core/dm-call.ts
// DM Ses & Video Araması (1-1 WebRTC over Socket.IO)

// ── Tip Tanımları ─────────────────────────────────────────────────────────────

type CallType = 'voice' | 'video';
type CallRole = 'caller' | 'callee';

interface IceConfig {
  iceServers: RTCIceServer[];
}

interface FileUploadChunkResponse {
  done?: boolean;
  fileName?: string;
  url?: string;
  fileType?: string;
  error?: string;
}

interface ImageUploadResponse {
  fileName?: string;
  url?: string;
  fileType?: string;
  error?: string;
}

declare const socket: ReturnType<typeof import('socket.io-client').io>;
declare const API: string;
declare const token: string;
declare function toast(msg: string, type: 'info' | 'success' | 'error' | 'warning'): void;

// ─────────────────────────────────────────────────────────────────────────────

const DmCall = (() => {
  // ── Module State ──────────────────────────────────────────
  let _currentCallId:      string | null       = null;
  let _currentType:        CallType | null      = null;
  let _remoteUserId:       string | null        = null;
  let _role:               CallRole | null      = null;
  let _pc:                 RTCPeerConnection | null = null;
  let _localStream:        MediaStream | null   = null;
  let _screenStream:       MediaStream | null   = null;
  let _ringtoneTimer:      ReturnType<typeof setInterval> | null = null;
  let _currentDmChannelId: string | null        = null;  // DM kanal ID — 4K/görsel gönderimi için

  // ── 4K Recording State ────────────────────────────────────
  let _4kTimer:               ReturnType<typeof setTimeout> | null = null;
  let _currentRecorder:       MediaRecorder | null                 = null;
  let _uploadAbortController: AbortController | null               = null;

  const ICE: IceConfig = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  // ── Overlay HTML ──────────────────────────────────────────
  function _injectOverlay(): void {
    if (document.getElementById('dm-call-overlay')) return;
    const el = document.createElement('div');
    el.id = 'dm-call-overlay';
    el.innerHTML = `
      <div id="dm-call-box">
        <div id="dm-call-video-wrap">
          <video id="dm-call-remote-video" autoplay playsinline></video>
          <video id="dm-call-local-video"  autoplay playsinline muted></video>
        </div>
        <div id="dm-call-avatar-wrap">
          <div id="dm-call-avatar"></div>
          <div id="dm-call-name"></div>
          <div id="dm-call-status"></div>
        </div>
        <div id="dm-call-actions">
          <button class="dm-call-btn dm-call-btn-red"   id="dm-call-hangup"  onclick="DmCall.hangUp()"      title="Kapat">🔵</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-mute"    onclick="DmCall.toggleMic()"   title="Mikrofon">🤐</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-cam"     onclick="DmCall.toggleCam()"   title="Kamera" style="display:none">📷</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-screen"  onclick="DmCall.toggleScreen()" title="Ekran Paylaş" style="display:none">🖥️</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-4k"      onclick="DmCall.send4KVideo()"  title="4K Video Gönder" style="display:none">🎬</button>
          <button class="dm-call-btn dm-call-btn-gray"  id="dm-call-img"      onclick="DmCall.sendImage()"    title="Görsel Gönder" style="display:none">🖼️</button>
        </div>
        <div id="dm-call-incoming-actions" style="display:none">
          <button class="dm-call-btn dm-call-btn-green" id="dm-call-accept"  onclick="DmCall.accept()"   title="Kabul">📞</button>
          <button class="dm-call-btn dm-call-btn-red"   id="dm-call-reject"  onclick="DmCall.decline()"  title="Reddet">🔵</button>
        </div>
      </div>
    `;
    const style = document.createElement('style');
    style.textContent = `
      #dm-call-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0,0,0,.55); backdrop-filter: blur(6px);
        display: none; align-items: center; justify-content: center;
      }
      #dm-call-overlay.active { display: flex; }
      #dm-call-box {
        background: var(--bg-secondary, #2f3136);
        border-radius: 16px; padding: 24px 28px;
        width: min(420px, 94vw); text-align: center;
        box-shadow: 0 20px 60px rgba(0,0,0,.6);
        display: flex; flex-direction: column; gap: 16px;
        position: relative;
      }
      #dm-call-video-wrap {
        display: none; position: relative;
        width: 100%; height: 240px; border-radius: 10px; overflow: hidden;
        background: #111;
      }
      #dm-call-video-wrap.active { display: block; }
      #dm-call-remote-video {
        width: 100%; height: 100%; object-fit: cover;
      }
      #dm-call-local-video {
        position: absolute; bottom: 8px; right: 8px;
        width: 90px; height: 60px; border-radius: 6px;
        object-fit: cover; border: 2px solid var(--brand, #2d9cdb);
      }
      #dm-call-avatar {
        width: 72px; height: 72px; border-radius: 50%;
        display: flex; align-items: center; justify-content: center;
        font-size: 28px; font-weight: 700; color: #fff;
        margin: 0 auto 10px;
      }
      #dm-call-name {
        font-size: 18px; font-weight: 700;
        color: var(--text-primary, #fff);
      }
      #dm-call-status {
        font-size: 13px; color: var(--text-muted, #aaa);
        margin-top: 4px;
      }
      #dm-call-actions, #dm-call-incoming-actions {
        display: flex; justify-content: center; gap: 16px;
      }
      .dm-call-btn {
        width: 52px; height: 52px; border-radius: 50%; border: none;
        cursor: pointer; font-size: 22px; transition: transform .12s, filter .12s;
        display: flex; align-items: center; justify-content: center;
      }
      .dm-call-btn:hover { transform: scale(1.1); filter: brightness(1.15); }
      .dm-call-btn-red   { background: #ed4245; }
      .dm-call-btn-green { background: #3ba55d; }
      .dm-call-btn-gray  { background: var(--bg-tertiary, #40444b); }
      .dm-call-btn.active { background: var(--brand, #2d9cdb); }
    `;
    document.head.appendChild(style);
    document.body.appendChild(el);
  }

  function _show(): void  { document.getElementById('dm-call-overlay')?.classList.add('active'); }
  function _hide(): void  { document.getElementById('dm-call-overlay')?.classList.remove('active'); }

  function _setStatus(txt: string): void {
    const el = document.getElementById('dm-call-status');
    if (el) el.textContent = txt;
  }

  function _renderUser(displayName: string, avatarColor?: string): void {
    const av = document.getElementById('dm-call-avatar');
    const nm = document.getElementById('dm-call-name');
    if (av) {
      av.style.background = avatarColor || '#2d9cdb';
      av.textContent = (displayName || '?').slice(0, 2).toUpperCase();
    }
    if (nm) nm.textContent = displayName || '';
  }

  // ── WebRTC ────────────────────────────────────────────────
  async function _initPC(): Promise<void> {
    _pc = new RTCPeerConnection(ICE);

    _pc.onicecandidate = ({ candidate }) => {
      if (candidate && _remoteUserId) {
        socket.emit('dm:call:ice', { callId: _currentCallId, targetUserId: _remoteUserId, candidate });
      }
    };

    _pc.ontrack = ({ streams }) => {
      const remoteVid = document.getElementById('dm-call-remote-video') as HTMLVideoElement | null;
      if (remoteVid && streams[0]) remoteVid.srcObject = streams[0];
    };

    _pc.onconnectionstatechange = () => {
      if (_pc!.connectionState === 'connected') _setStatus(_currentType === 'video' ? '📹 Görüntülü arama aktif' : '🤙 Ses araması aktif');
      if (['failed', 'disconnected', 'closed'].includes(_pc!.connectionState)) hangUp();
    };
  }

  async function _getMedia(withVideo: boolean): Promise<boolean> {
    try {
      _localStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: withVideo ? { width: 640, height: 480, facingMode: 'user' } : false,
      });
    } catch {
      _localStream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
    }
    if (!_localStream) { toast('Mikrofona erişilemiyor', 'error'); return false; }

    const localVid = document.getElementById('dm-call-local-video') as HTMLVideoElement | null;
    if (localVid && withVideo) localVid.srcObject = _localStream;

    for (const track of _localStream.getTracks()) _pc!.addTrack(track, _localStream);

    if (withVideo) {
      document.getElementById('dm-call-video-wrap')?.classList.add('active');
      document.getElementById('dm-call-cam')?.style.setProperty('display', '');
    }
    // Ekran paylaşımı, 4K video ve görsel butonları arama aktifken görünür
    document.getElementById('dm-call-screen')?.style.setProperty('display', '');
    document.getElementById('dm-call-4k')?.style.setProperty('display', '');
    document.getElementById('dm-call-img')?.style.setProperty('display', '');
    return true;
  }

  // ── Screen Share inside DM call ───────────────────────────
  async function toggleScreen(): Promise<void> {
    if (_screenStream) {
      _screenStream.getTracks().forEach(t => t.stop());
      _screenStream = null;
      if (_pc) {
        const camTrack = _localStream?.getVideoTracks()[0] || null;
        const sender = _pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) await sender.replaceTrack(camTrack).catch(() => {});
      }
      const btn = document.getElementById('dm-call-screen');
      if (btn) { btn.textContent = '🖥️'; btn.classList.remove('active'); }
      if (!_localStream?.getVideoTracks().length) {
        document.getElementById('dm-call-video-wrap')?.classList.remove('active');
      }
      return;
    }
    try {
      _screenStream = await navigator.mediaDevices.getDisplayMedia({
        video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 }, cursor: 'always' } as MediaTrackConstraints,
        audio: false,
      });
      const screenTrack = _screenStream.getVideoTracks()[0];
      screenTrack.onended = () => toggleScreen();

      if (_pc) {
        const sender = _pc.getSenders().find(s => s.track?.kind === 'video');
        if (sender) {
          await sender.replaceTrack(screenTrack);
        } else {
          _pc.addTrack(screenTrack, _screenStream);
        }
      }
      const localVid = document.getElementById('dm-call-local-video') as HTMLVideoElement | null;
      if (localVid) localVid.srcObject = _screenStream;
      document.getElementById('dm-call-video-wrap')?.classList.add('active');

      const btn = document.getElementById('dm-call-screen');
      if (btn) { btn.textContent = '⏹️'; btn.classList.add('active'); }
    } catch (e) {
      if ((e as DOMException).name !== 'NotAllowedError') log.warn('Screen share error:', e);
    }
  }

  // ── 4K Video Gönderme ─────────────────────────────────────
  // Arama sırasında karşı tarafa 4K video klip gönderir.
  // Kullanıcıya kaynak seçici (ekran / kamera) gösterir, ardından kaydeder.
  // MediaRecorder ile kaydeder → chunked upload → socket file:send.
  //
  // Kısıtlamalar:
  //   • Tarayıcı MediaRecorder desteği gerekir (Chrome 49+, Firefox 25+).
  //   • 4K kamera desteği cihaza bağlıdır; desteklenmiyorsa 1080p'ye düşer.
  //   • Kayıt süresi: MAX_4K_DURATION_SEC (varsayılan 30 sn).
  //   • Yükleme: chunked (5MB chunk) — _currentDmChannelId gerekir.

  const MAX_4K_DURATION_SEC = 30;

  async function send4KVideo(): Promise<void> {
    // Kayıt devam ediyorsa durdur
    const btn = document.getElementById('dm-call-4k');
    if (btn && btn.classList.contains('recording')) {
      _stop4KRecording();
      return;
    }

    // DM kanal ID yoksa video gönderilemez — sessiz başarısızlığı önle
    if (!_currentDmChannelId) {
      toast('4K video göndermek için aktif bir DM araması gerekli', 'error');
      return;
    }

    // Kullanıcıya kayıt kaynağı sor
    let stream: MediaStream;
    const useScreen = await _ask4KSource();
    if (useScreen === null) return; // kullanıcı iptal etti

    try {
      if (useScreen) {
        stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            width:     { ideal: 3840, max: 3840 },
            height:    { ideal: 2160, max: 2160 },
            frameRate: { ideal: 30,   max: 60 },
            cursor:    'motion',
          } as MediaTrackConstraints,
          audio: false,
        });
      } else {
        // 4K kamera — cihaz desteklemiyorsa 1080p fallback
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 3840 }, height: { ideal: 2160 }, frameRate: { ideal: 30 } },
            audio: false,
          });
        } catch {
          stream = await navigator.mediaDevices.getUserMedia({
            video: { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } },
            audio: false,
          });
        }
      }
    } catch (e) {
      if ((e as DOMException).name !== 'NotAllowedError') toast('4K video kaynağına erişilemiyor', 'error');
      return;
    }

    // Desteklenen codec'i bul (VP9 > H264 > varsayılan)
    const mimeTypes = ['video/webm;codecs=vp9', 'video/webm;codecs=h264', 'video/webm', 'video/mp4'];
    const mimeType  = mimeTypes.find(m => MediaRecorder.isTypeSupported(m)) || '';

    const chunks: Blob[] = [];
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(stream, {
        ...(mimeType && { mimeType }),
        videoBitsPerSecond: 25_000_000, // 25 Mbps — 4K için minimum kalite
      });
    } catch {
      toast('MediaRecorder başlatılamadı', 'error');
      stream.getTracks().forEach(t => t.stop());
      return;
    }

    recorder.ondataavailable = (e) => { if (e.data.size > 0) chunks.push(e.data); };

    recorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      if (btn) { btn.textContent = '🎬'; btn.classList.remove('recording'); btn.title = '4K Video Gönder'; }
      if (_4kTimer !== null) { clearTimeout(_4kTimer); _4kTimer = null; }

      if (!chunks.length) return;

      const ext  = mimeType.includes('mp4') ? 'mp4' : 'webm';
      const blob = new Blob(chunks, { type: mimeType || 'video/webm' });
      const file = new File([blob], `bridge-4k-${Date.now()}.${ext}`, { type: blob.type });

      toast(`🎬 4K video gönderiliyor (${(file.size / 1024 / 1024).toFixed(1)} MB)…`, 'info');

      try {
        await _upload4KFile(file);
      } catch (err) {
        toast('4K video yükleme başarısız: ' + ((err as Error).message || err), 'error');
      }
    };

    // Kayıt başlat
    recorder.start(1000); // 1 sn'lik chunk'lar
    _currentRecorder = recorder;
    if (btn) { btn.textContent = '⏹️'; btn.classList.add('recording'); btn.title = `Kaydı Durdur (max ${MAX_4K_DURATION_SEC}s)`; }
    _setStatus(`🎬 4K video kaydediliyor… (max ${MAX_4K_DURATION_SEC}s)`);

    // Otomatik durdurma
    _4kTimer = setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, MAX_4K_DURATION_SEC * 1000);

    // stream bitince (kullanıcı tarayıcı UI'dan durdurursa)
    stream.getVideoTracks()[0].onended = () => {
      if (recorder.state === 'recording') recorder.stop();
    };
  }

  function _stop4KRecording(): void {
    if (_currentRecorder && _currentRecorder.state === 'recording') _currentRecorder.stop();
  }

  // ── Chunked Upload ─────────────────────────────────────────
  // upload.ts'deki uploadChunked mantığıyla aynı — 5MB chunk
  // AbortController ile hangUp() sırasında iptal edilebilir.
  async function _upload4KFile(file: File): Promise<void> {
    const CHUNK_SIZE  = 5 * 1024 * 1024;
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId    = crypto.randomUUID?.() ?? `4k-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const progressEl  = _show4KProgress(file.name, 0);

    // Mevcut upload controller'ını kaydet — _cleanup() abort edebilsin
    const controller = new AbortController();
    _uploadAbortController = controller;

    try {
      for (let i = 0; i < totalChunks; i++) {
        // hangUp() zaten abort ettiyse sessizce çık
        if (controller.signal.aborted) {
          _hide4KProgress(progressEl);
          return;
        }

        const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
        const r = await fetch(`${API}/api/upload/chunk`, {
          method: 'POST',
          headers: {
            Authorization:    `Bearer ${token}`,
            'x-upload-id':    uploadId,
            'x-chunk-index':  String(i),
            'x-total-chunks': String(totalChunks),
            'x-file-name':    encodeURIComponent(file.name),
            'x-file-type':    file.type || 'video/webm',
          },
          body: chunk,
          signal: controller.signal,
        });

        if (!r.ok) {
          _hide4KProgress(progressEl);
          const err = await r.json().catch(() => ({})) as FileUploadChunkResponse;
          throw new Error(err.error || `Chunk ${i} failed (${r.status})`);
        }

        const data = await r.json() as FileUploadChunkResponse;
        _update4KProgress(progressEl, Math.round(((i + 1) / totalChunks) * 100));

        if (data.done) {
          _hide4KProgress(progressEl);
          // _currentDmChannelId upload başlamadan önce kontrol edildi (send4KVideo guard)
          if (_currentDmChannelId) {
            socket.emit('file:send', {
              channelId: _currentDmChannelId,
              fileName:  data.fileName,
              fileUrl:   data.url,
              fileType:  data.fileType,
            });
            toast('🎬 4K video gönderildi!', 'success');
          }
          _setStatus(_currentType === 'video' ? '📹 Görüntülü arama aktif' : '🤙 Ses araması aktif');
        }
      }
    } catch (err: unknown) {
      // AbortError beklenen bir iptal — kullanıcıya gösterme
      if ((err as DOMException).name === 'AbortError') {
        _hide4KProgress(progressEl);
        return;
      }
      throw err;
    } finally {
      // Controller referansını temizle
      if (_uploadAbortController === controller) _uploadAbortController = null;
    }
    _hide4KProgress(progressEl); // güvenlik
  }

  // ── 4K Upload Progress UI ─────────────────────────────────
  function _show4KProgress(fileName: string, pct: number): HTMLDivElement {
    const el = document.createElement('div');
    el.id = 'dm-call-4k-progress';
    el.style.cssText = 'position:absolute;bottom:0;left:0;right:0;background:rgba(0,0,0,.7);border-radius:0 0 16px 16px;padding:10px 16px;text-align:left;';
    el.innerHTML =
      `<div style="font-size:12px;color:#ccc;margin-bottom:4px">🎬 ${fileName.slice(0, 40)} yükleniyor…</div>` +
      `<div style="background:#40444b;border-radius:4px;height:6px;overflow:hidden">` +
      `<div id="dm-call-4k-fill" style="background:var(--brand,#2d9cdb);height:100%;width:${pct}%;transition:width .3s"></div></div>` +
      `<div id="dm-call-4k-pct" style="font-size:11px;color:#aaa;margin-top:3px">${pct}%</div>`;
    document.getElementById('dm-call-box')?.appendChild(el);
    return el;
  }

  function _update4KProgress(el: HTMLDivElement | null, pct: number): void {
    if (!el) return;
    const fill  = document.getElementById('dm-call-4k-fill');
    const pctEl = document.getElementById('dm-call-4k-pct');
    if (fill)  fill.style.width = `${pct}%`;
    if (pctEl) pctEl.textContent = `${pct}%`;
  }

  function _hide4KProgress(el: HTMLDivElement | null): void { el?.remove(); }

  // ── 4K Kaynak Seçici ──────────────────────────────────────
  // Kullanıcıya "Ekran mı, Kamera mı?" diye sorar.
  // Seçim: true = ekran, false = kamera, null = iptal
  function _ask4KSource(): Promise<boolean | null> {
    return new Promise((resolve) => {
      // Daha önce açık kalmış varsa temizle
      document.getElementById('dm-call-4k-picker')?.remove();

      const overlay = document.createElement('div');
      overlay.id = 'dm-call-4k-picker';
      overlay.innerHTML = `
        <div id="dm-call-4k-picker-box">
          <div id="dm-call-4k-picker-title">4K Video Kaynağı</div>
          <div id="dm-call-4k-picker-subtitle">Ne kaydetmek istiyorsun?</div>
          <div id="dm-call-4k-picker-options">
            <button id="dm-call-4k-pick-screen" class="dm-call-4k-opt">
              <span class="dm-call-4k-opt-icon">🖥️</span>
              <span class="dm-call-4k-opt-label">Ekran</span>
              <span class="dm-call-4k-opt-sub">4K ekran kaydı</span>
            </button>
            <button id="dm-call-4k-pick-camera" class="dm-call-4k-opt">
              <span class="dm-call-4k-opt-icon">📷</span>
              <span class="dm-call-4k-opt-label">Kamera</span>
              <span class="dm-call-4k-opt-sub">4K / 1080p fallback</span>
            </button>
          </div>
          <button id="dm-call-4k-pick-cancel">İptal</button>
        </div>
      `;

      const style = document.createElement('style');
      style.id = 'dm-call-4k-picker-style';
      style.textContent = `
        #dm-call-4k-picker {
          position: absolute; inset: 0; z-index: 10;
          background: rgba(0,0,0,.6); border-radius: 16px;
          display: flex; align-items: center; justify-content: center;
        }
        #dm-call-4k-picker-box {
          background: var(--bg-primary, #36393f);
          border-radius: 12px; padding: 20px 24px;
          width: min(320px, 90%); text-align: center;
          box-shadow: 0 8px 32px rgba(0,0,0,.5);
          display: flex; flex-direction: column; gap: 12px;
        }
        #dm-call-4k-picker-title {
          font-size: 15px; font-weight: 700;
          color: var(--text-primary, #fff);
        }
        #dm-call-4k-picker-subtitle {
          font-size: 12px; color: var(--text-muted, #aaa); margin-top: -6px;
        }
        #dm-call-4k-picker-options {
          display: flex; gap: 10px;
        }
        .dm-call-4k-opt {
          flex: 1; background: var(--bg-tertiary, #40444b);
          border: 2px solid transparent; border-radius: 10px;
          padding: 14px 8px; cursor: pointer;
          display: flex; flex-direction: column; align-items: center; gap: 6px;
          transition: border-color .15s, background .15s;
        }
        .dm-call-4k-opt:hover {
          border-color: var(--brand, #2d9cdb);
          background: var(--bg-secondary, #2f3136);
        }
        .dm-call-4k-opt-icon { font-size: 26px; }
        .dm-call-4k-opt-label {
          font-size: 13px; font-weight: 600;
          color: var(--text-primary, #fff);
        }
        .dm-call-4k-opt-sub {
          font-size: 10px; color: var(--text-muted, #aaa);
        }
        #dm-call-4k-pick-cancel {
          background: none; border: none; cursor: pointer;
          font-size: 12px; color: var(--text-muted, #aaa);
          padding: 4px; transition: color .15s;
        }
        #dm-call-4k-pick-cancel:hover { color: var(--text-primary, #fff); }
      `;

      const box = document.getElementById('dm-call-box');
      if (!box) { resolve(null); return; }

      box.appendChild(style);
      box.appendChild(overlay);

      function cleanup() {
        overlay.remove();
        document.getElementById('dm-call-4k-picker-style')?.remove();
      }

      const btnScreen = document.getElementById('dm-call-4k-pick-screen');
      const btnCamera = document.getElementById('dm-call-4k-pick-camera');
      const btnCancel = document.getElementById('dm-call-4k-pick-cancel');

      if (!btnScreen || !btnCamera || !btnCancel) { cleanup(); resolve(null); return; }

      btnScreen.onclick = () => { cleanup(); resolve(true); };
      btnCamera.onclick = () => { cleanup(); resolve(false); };
      btnCancel.onclick = () => { cleanup(); resolve(null); };
    });
  }

  // ── Görsel Gönderme ───────────────────────────────────────
  // Arama sırasında karşı tarafa görsel gönderir.
  // ≤50MB: tek seferde (multipart) — >50MB: chunked
  const IMAGE_ALLOWED = new Set<string>([
    'image/jpeg', 'image/png', 'image/gif', 'image/webp',
    'image/avif', 'image/bmp', 'image/tiff', 'image/svg+xml',
  ]);

  async function sendImage(): Promise<void> {
    if (!_currentDmChannelId) {
      toast('Görsel göndermek için aktif bir DM araması gerekli', 'error');
      return;
    }

    const inp = document.createElement('input');
    inp.type     = 'file';
    inp.accept   = [...IMAGE_ALLOWED].join(',');
    inp.multiple = false;

    inp.onchange = async () => {
      const file = inp.files?.[0];
      if (!file) return;

      if (!IMAGE_ALLOWED.has(file.type)) {
        return toast(`Desteklenmeyen format: ${file.type}`, 'error');
      }

      const maxBytes = 5120 * 1024 * 1024; // 5GB genel limit
      if (file.size > maxBytes) {
        return toast('Görsel çok büyük (max 5GB)', 'error');
      }

      toast(`🖼️ Görsel gönderiliyor (${(file.size / 1024).toFixed(0)} KB)…`, 'info');

      try {
        if (file.size <= 50 * 1024 * 1024) {
          await _uploadImageSmall(file);
        } else {
          await _upload4KFile(file); // chunked — aynı pipeline
        }
      } catch (err) {
        toast('Görsel yükleme başarısız: ' + ((err as Error).message || err), 'error');
      }
    };

    inp.click();
  }

  async function _uploadImageSmall(file: File): Promise<void> {
    const formData = new FormData();
    formData.append('file', file);

    const progressEl = _show4KProgress(file.name, 0);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/api/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) _update4KProgress(progressEl, Math.round((e.loaded / e.total) * 100));
    };

    return new Promise<void>((resolve) => {
      xhr.onload = () => {
        _hide4KProgress(progressEl);
        try {
          const data = JSON.parse(xhr.responseText) as ImageUploadResponse;
          if (xhr.status >= 200 && xhr.status < 300) {
            if (_currentDmChannelId) {
              socket.emit('file:send', {
                channelId: _currentDmChannelId,
                fileName:  data.fileName,
                fileUrl:   data.url,
                fileType:  data.fileType,
              });
              toast('🖼️ Görsel gönderildi!', 'success');
            }
          } else {
            toast(data.error || 'Görsel yükleme başarısız', 'error');
          }
        } catch { toast('Görsel yükleme başarısız', 'error'); }
        resolve();
      };
      xhr.onerror = () => { _hide4KProgress(progressEl); toast('Görsel yükleme başarısız', 'error'); resolve(); };
      xhr.send(formData);
    });
  }

  // ── Start call (caller side) ──────────────────────────────
  async function startCall(toUserId: string, displayName: string, avatarColor: string, type: CallType = 'voice'): Promise<void> {
    _injectOverlay();
    _currentType  = type;
    _remoteUserId = toUserId;
    _role         = 'caller';

    _renderUser(displayName, avatarColor);
    _setStatus(type === 'video' ? '📹 Görüntülü arama kuruluyor…' : '📞 Aranıyor…');
    document.getElementById('dm-call-actions')?.style.setProperty('display', 'flex');
    document.getElementById('dm-call-incoming-actions')?.style.setProperty('display', 'none');
    _show();

    socket.emit('dm:call:start', { toUserId, type });
  }

  // ── Incoming call (callee side) ───────────────────────────
  function _notifySwIncoming(callerName: string, callType: CallType): void {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'DM_CALL_INCOMING',
        callerName,
        callType,
      });
    }
  }

  function _handleIncoming({ callId, type, callerId, callerDisplayName, callerAvatarColor }: {
    callId: string; type: CallType; callerId: string;
    callerDisplayName: string; callerAvatarColor: string;
  }): void {
    _injectOverlay();
    _currentCallId = callId;
    _currentType   = type;
    _remoteUserId  = callerId;
    _role          = 'callee';

    _renderUser(callerDisplayName, callerAvatarColor);
    _setStatus(type === 'video' ? '📹 Görüntülü arama geliyor…' : '📞 Ses araması geliyor…');
    document.getElementById('dm-call-actions')?.style.setProperty('display', 'none');
    document.getElementById('dm-call-incoming-actions')?.style.setProperty('display', 'flex');
    _show();

    if (document.visibilityState === 'hidden') {
      _notifySwIncoming(callerDisplayName, type);
    }

    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      let beat = 0;
      _ringtoneTimer = setInterval(() => {
        if (beat++ > 10) { clearInterval(_ringtoneTimer!); return; }
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        o.connect(g); g.connect(ctx.destination);
        o.frequency.value = 480; g.gain.value = 0.15;
        o.start(); o.stop(ctx.currentTime + 0.4);
      }, 900);
    } catch { /* ses çıktısı yoksa sessizce geç */ }
  }

  function accept(): void {
    clearInterval(_ringtoneTimer!);
    _setStatus('Bağlanıyor…');
    document.getElementById('dm-call-incoming-actions')?.style.setProperty('display', 'none');
    document.getElementById('dm-call-actions')?.style.setProperty('display', 'flex');
    socket.emit('dm:call:accept', { callId: _currentCallId });
  }

  function decline(): void {
    clearInterval(_ringtoneTimer!);
    socket.emit('dm:call:decline', { callId: _currentCallId });
    _cleanup();
  }

  function hangUp(): void {
    if (_currentCallId) socket.emit('dm:call:end', { callId: _currentCallId });
    _cleanup();
  }

  function toggleMic(): void {
    if (!_localStream) return;
    const track = _localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = document.getElementById('dm-call-mute');
    if (btn) { btn.textContent = track.enabled ? '🤐' : '🔇'; btn.classList.toggle('active', !track.enabled); }
  }

  function toggleCam(): void {
    if (!_localStream) return;
    const track = _localStream.getVideoTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    const btn = document.getElementById('dm-call-cam');
    if (btn) { btn.textContent = track.enabled ? '📷' : '🚫'; btn.classList.toggle('active', !track.enabled); }
  }

  function _cleanup(): void {
    clearInterval(_ringtoneTimer!);
    _screenStream?.getTracks().forEach(t => t.stop()); _screenStream = null;
    _pc?.close(); _pc = null;
    _localStream?.getTracks().forEach(t => t.stop()); _localStream = null;

    // Devam eden 4K kaydı ve chunked upload'u iptal et
    if (_currentRecorder && _currentRecorder.state === 'recording') {
      _currentRecorder.stop();
    }
    _currentRecorder = null;
    if (_4kTimer !== null) { clearTimeout(_4kTimer); _4kTimer = null; }
    if (_uploadAbortController !== null) {
      _uploadAbortController.abort();
      _uploadAbortController = null;
    }
    // 4K buton ve progress UI'ı sıfırla
    const btn4k = document.getElementById('dm-call-4k');
    if (btn4k) { btn4k.textContent = '🎬'; btn4k.classList.remove('recording'); btn4k.title = '4K Video Gönder'; }
    document.getElementById('dm-call-4k-progress')?.remove();

    const remoteVid = document.getElementById('dm-call-remote-video') as HTMLVideoElement | null;
    const localVid  = document.getElementById('dm-call-local-video')  as HTMLVideoElement | null;
    if (remoteVid) remoteVid.srcObject = null;
    if (localVid)  localVid.srcObject  = null;
    document.getElementById('dm-call-video-wrap')?.classList.remove('active');
    _currentCallId = null; _currentType = null; _remoteUserId = null;
    _role = null; _currentDmChannelId = null;
    _hide();
  }

  // ── Socket event bindings (called after socket ready) ─────
  function bindSocketEvents(sock: typeof socket): void {
    // channelId sunucu tarafından her zaman gönderilmeli; opsiyonel tip
    // geriye dönük uyumluluk içindir (eski server sürümleri). Eksik gelirse
    // 4K/görsel gönderme guard'ı zaten kullanıcıyı bilgilendirir.
    sock.on('dm:call:outgoing', ({ callId, type, toUserId, channelId }: {
      callId: string; type: CallType; toUserId: string; channelId?: string;
    }) => {
      _currentCallId = callId;
      if (channelId) {
        _currentDmChannelId = channelId;
      } else {
        log.warn('[DmCall] dm:call:outgoing — channelId eksik; 4K/görsel gönderme devre dışı.');
      }
    });

    sock.on('dm:call:incoming', (data: Parameters<typeof _handleIncoming>[0]) => _handleIncoming(data));

    sock.on('dm:call:accepted', ({ callId, type, calleeDisplayName }: {
      callId: string; type: CallType; calleeDisplayName: string;
    }) => {
      _setStatus(`${calleeDisplayName} kabul etti — bağlanıyor…`);
    });

    sock.on('dm:call:ready', async ({ callId, channelId, role, type }: {
      callId: string; channelId?: string; role: CallRole; type: CallType;
    }) => {
      _currentCallId = callId;
      _role          = role;
      if (channelId) {
        _currentDmChannelId = channelId;
      } else {
        log.warn('[DmCall] dm:call:ready — channelId eksik; 4K/görsel gönderme devre dışı.');
      }
      await _initPC();
      const ok = await _getMedia(type === 'video');
      if (!ok) { hangUp(); return; }

      if (role === 'caller') {
        const offer = await _pc!.createOffer();
        await _pc!.setLocalDescription(offer);
        sock.emit('dm:call:offer', { callId, targetUserId: _remoteUserId, offer });
        _setStatus('Bağlanıyor…');
      }
    });

    sock.on('dm:call:offer', async ({ callId, fromSocketId, offer }: {
      callId: string; fromSocketId: string; offer: RTCSessionDescriptionInit;
    }) => {
      if (!_pc) return;
      await _pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await _pc.createAnswer();
      await _pc.setLocalDescription(answer);
      sock.emit('dm:call:answer', { callId, targetUserId: _remoteUserId, answer });
    });

    sock.on('dm:call:answer', async ({ callId, fromSocketId, answer }: {
      callId: string; fromSocketId: string; answer: RTCSessionDescriptionInit;
    }) => {
      if (!_pc || _pc.signalingState === 'stable') return;
      await _pc.setRemoteDescription(new RTCSessionDescription(answer));
    });

    sock.on('dm:call:ice', async ({ callId, fromSocketId, candidate }: {
      callId: string; fromSocketId: string; candidate: RTCIceCandidateInit;
    }) => {
      if (!_pc) return;
      try { await _pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch { /* stale candidate */ }
    });

    sock.on('dm:call:declined', ({ callId }: { callId: string }) => {
      _setStatus('Arama reddedildi');
      setTimeout(_cleanup, 1500);
    });

    sock.on('dm:call:ended', ({ callId }: { callId: string }) => {
      _setStatus('Arama sonlandı');
      setTimeout(_cleanup, 1200);
    });

    sock.on('dm:call:missed', ({ callId }: { callId: string }) => {
      if (_role === 'caller') { _setStatus('Cevap alınamadı'); setTimeout(_cleanup, 2000); }
      else _cleanup();
    });
  }

  return { startCall, accept, decline, hangUp, toggleMic, toggleCam, toggleScreen, send4KVideo, sendImage, bindSocketEvents };
})();

BridgeRegistry.register('DmCall', DmCall);
BridgeRegistry.register('DmCall:startCall', (uid: string, name: string, color: string, type: string) => DmCall.startCall(uid, name, color, type as 'voice' | 'video'));
