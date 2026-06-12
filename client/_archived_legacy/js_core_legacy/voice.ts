// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/VoicePanel.svelte
//              client/js/core/voice-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/voice.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// core/voice.js (Go Live ekran paylaşımı, SFU video grid, PTT)

import { getRtc } from './globals.js';
import { BridgeRegistry } from './bridge-registry.js';

import { createLogger } from './logger.js';
const log = createLogger('Voice');


// ── Tip tanımları ─────────────────────────────────────────────

interface PeerInfo {
  id: string;
  socketId: string;
  displayName: string;
  avatarColor: string;
}

interface RtcInstance {
  muted: boolean;
  deafened: boolean;
  videoOn: boolean;
  screenSharing: boolean;
  screenStream: MediaStream | null;
  peers: Map<string, RTCPeerConnection>;
  setMuted(v: boolean): void;
  setDeafened(v: boolean): void;
  enableVideo(on: boolean): Promise<boolean | void>;
  getLocalStream(): MediaStream | null;
  isInVoice(): boolean;
  leaveVoice(): void;
  startScreenShare(quality: string, audio: boolean): Promise<boolean>;
  stopScreenShare(): void;
}

interface PeerState {
  muted?: boolean;
  deafened?: boolean;
  screensharing?: boolean;
  video?: boolean;
}

interface QualityPrefs {
  preset?: string;
  bitrateKbps?: number;
}

interface PTTKey {
  code: string;
  label: string;
}

// Globals (injected at runtime via window / ESM)
declare const rtc: RtcInstance;
declare const currentUser: { displayName?: string } | undefined;
declare const currentChannel: { name?: string; _id?: string } | null;
declare const currentServer: { _id: string } | null;
declare const voiceChannelPeers: Map<string, PeerInfo>;
declare const replyingTo: string | null;
declare const socket: { emit(event: string, data: unknown): void };
declare function toast(msg: string, type?: string): void;
declare function escHtml(s: string): string;
declare function cssColor(c: string): string;
declare function initials(name: string): string;
declare function _onScreenShareStarted(): void;
declare function _onScreenShareStopped(): void;

// ══════════════════════════════════════════════════
// VOICE KONTROLLERİ
// ══════════════════════════════════════════════════

export function toggleMute(): void {
  const muted = !rtc.muted;
  rtc.setMuted(muted);
  document.getElementById('vc-mute')?.classList.toggle('active', muted);
  document.getElementById('btn-mute')?.classList.toggle('active', muted);
  const muteIcon = muted ? '🔇' : '🎙️';
  (['vc-mute', 'btn-mute', 'ss-mute-btn'] as const).forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.textContent = muteIcon; el.classList.toggle('active', muted); }
  });
}

export function toggleDeafen(): void {
  rtc.setDeafened(!rtc.deafened);
  ['btn-deafen', 'vc-deafen', 'ss-deafen-btn'].forEach(id =>
    document.getElementById(id)?.classList.toggle('active', rtc.deafened),
  );
}

export async function toggleVideo(): Promise<void> {
  const btn = document.getElementById('vc-video');
  if (rtc.videoOn) {
    await rtc.enableVideo(false);
    if (btn) { btn.classList.remove('active'); btn.textContent = '📷'; }
    sfuRemoveVideoTile('local');
  } else {
    const ok = await rtc.enableVideo(true);
    if (ok !== false) {
      if (btn) { btn.classList.add('active'); btn.textContent = '📸'; }
      const localStream = rtc.getLocalStream();
      if (localStream) sfuAddVideoTile('local', localStream, currentUser?.displayName ?? 'Ben', true);
    }
  }
}

// ══════════════════════════════════════════════════
// SFU VİDEO GRİD
// ══════════════════════════════════════════════════

const _sfuVideoTiles = new Map<string, HTMLDivElement>();

export function sfuAddVideoTile(
  tileId: string,
  stream: MediaStream,
  label: string,
  isLocal = false,
  isScreen = false,
): void {
  const grid = document.getElementById('sfu-video-grid');
  if (!grid) return;

  if (_sfuVideoTiles.has(tileId)) {
    const existingVideo = _sfuVideoTiles.get(tileId)?.querySelector('video');
    if (existingVideo) { (existingVideo as HTMLVideoElement).srcObject = stream; return; }
  }

  const tile = document.createElement('div');
  tile.className = `sfu-tile${isScreen ? ' sfu-tile-screen' : ''}`;
  tile.dataset.tileId = tileId;

  const video = document.createElement('video');
  video.srcObject = stream;
  video.autoplay = true;
  video.playsInline = true;
  video.muted = isLocal;

  const nameTag = document.createElement('div');
  nameTag.className = 'sfu-tile-name';
  nameTag.textContent = (isLocal ? '📹 ' : '') + (isScreen ? '🖥️ ' : '') + (label ?? '');

  tile.append(video, nameTag);
  _sfuVideoTiles.set(tileId, tile as HTMLDivElement);
  grid.appendChild(tile);
  grid.style.display = '';
  _sfuUpdateGridLayout();
}

export function sfuRemoveVideoTile(tileId: string): void {
  const tile = _sfuVideoTiles.get(tileId);
  if (tile) { tile.remove(); _sfuVideoTiles.delete(tileId); }
  const grid = document.getElementById('sfu-video-grid');
  if (_sfuVideoTiles.size === 0) { if (grid) grid.style.display = 'none'; }
  else _sfuUpdateGridLayout();
}

function _sfuUpdateGridLayout(): void {
  const grid = document.getElementById('sfu-video-grid');
  if (!grid) return;
  const n = _sfuVideoTiles.size;
  const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : 3;
  (grid as HTMLElement).style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

export function sfuHandleNewProducer(
  socketId: string,
  userId: string,
  stream: MediaStream,
  kind: 'video' | 'screen',
): void {
  const peerEl = document.querySelector(`[data-socket-id="${socketId}"]`);
  const label = peerEl?.querySelector('.vp-name')?.textContent ?? userId ?? 'Kullanıcı';
  sfuAddVideoTile(`${socketId}-${kind}`, stream, label, false, kind === 'screen');
}

export function sfuHandlePeerLeft(socketId: string): void {
  sfuRemoveVideoTile(`${socketId}-video`);
  sfuRemoveVideoTile(`${socketId}-screen`);
}

export function sfuClearAllVideoTiles(): void {
  for (const [id] of _sfuVideoTiles) sfuRemoveVideoTile(id);
}

// ══════════════════════════════════════════════════
// SCREEN SHARE — KALİTE SEÇİCİ + BAŞLATMA
// ══════════════════════════════════════════════════

export async function toggleScreenShare(): Promise<void> {
  const btn = document.getElementById('vc-screen');
  if (rtc.screenSharing) {
    stopMyScreenShare();
    btn?.classList.remove('active');
  } else {
    openScreenShareQualityPicker();
  }
}

export function openScreenShareQualityPicker(): void {
  try {
    const prefs: QualityPrefs = JSON.parse(localStorage.getItem('bridgeSSQuality') ?? '{}');
    if (prefs.preset && prefs.preset !== 'ask') {
      startScreenShareWithQuality(prefs.preset);
      return;
    }
  } catch (_) { /* ignore */ }
  const modal = document.getElementById('ss-quality-modal');
  if (modal) modal.style.display = 'flex';
}

export async function startScreenShareWithQuality(quality: string): Promise<void> {
  const modal = document.getElementById('ss-quality-modal');
  if (modal) modal.style.display = 'none';

  const saveEl = document.getElementById('ss-save-as-default') as HTMLInputElement | null;
  if (saveEl?.checked) {
    try {
      const prefs: QualityPrefs = JSON.parse(localStorage.getItem('bridgeSSQuality') ?? '{}');
      prefs.preset = quality;
      localStorage.setItem('bridgeSSQuality', JSON.stringify(prefs));
      toast(`Varsayılan kalite kaydedildi: ${_qualityLabel(quality)}`, 'info');
    } catch (_) { /* ignore */ }
  }

  const audioEl = document.getElementById('ss-include-audio') as HTMLInputElement | null;
  const includeAudio = audioEl?.checked !== false;

  if (!rtc.isInVoice()) { toast('Önce bir ses kanalına gir', 'error'); return; }

  const loadingEl = document.getElementById('ss-loading');
  if (loadingEl) loadingEl.style.display = 'flex';
  openScreenShareView();

  const ok = await rtc.startScreenShare(quality, includeAudio);
  if (loadingEl) loadingEl.style.display = 'none';

  if (ok) {
    document.getElementById('vc-screen')?.classList.add('active');
    _setDisplay('ss-stop-btn', '');
    _setDisplay('ss-share-btn', 'none');
    _setDisplay('ss-local-badge', 'flex');
    const labelEl = document.getElementById('ss-quality-label');
    if (labelEl) labelEl.textContent = _qualityLabel(quality);

    const localVideo = document.getElementById('remote-screen-video') as HTMLVideoElement | null;
    if (localVideo && rtc.screenStream) {
      localVideo.srcObject = rtc.screenStream;
      localVideo.muted = true;
    }

    try {
      const ssPrefs: QualityPrefs = JSON.parse(localStorage.getItem('bridgeSSQuality') ?? '{}');
      if ((ssPrefs.bitrateKbps ?? 0) > 0) {
        const fpsMap: Record<string, number> = {
          '4k60': 60, '1440p60': 60, '1440p': 30, '1080p60': 60,
          '1080p': 30, '720p': 30, 'hd': 30,
        };
        const overrideBps = (ssPrefs.bitrateKbps ?? 0) * 1000;
        const fps = fpsMap[quality] ?? 30;
        for (const pc of rtc.peers.values()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (!sender) continue;
          const params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate = overrideBps;
          params.encodings[0].maxFramerate = fps;
          sender.setParameters(params).catch(e => log.warn('[SS override]', e));
        }
      }
    } catch (_) { /* ignore */ }

    toast(`Ekran paylaşımı başladı — ${_qualityLabel(quality)} 🖥️`, 'success');
    if (typeof _onScreenShareStarted === 'function') _onScreenShareStarted();
  } else {
    closeScreenShareView();
  }
}

function _qualityLabel(q: string): string {
  const map: Record<string, string> = {
    '4k60': '4K 60fps', '1440p60': '1440p 60fps', '1440p': '1440p 30fps',
    '1080p60': '1080p 60fps', '1080p': '1080p 30fps', '720p': '720p 30fps', 'hd': 'HD',
  };
  return map[q] ?? q;
}

export function stopMyScreenShare(): void {
  if (typeof _onScreenShareStopped === 'function') _onScreenShareStopped();
  rtc.stopScreenShare();
  document.getElementById('vc-screen')?.classList.remove('active');
  _setDisplay('ss-stop-btn', 'none');
  _setDisplay('ss-share-btn', '');
  _setDisplay('ss-local-badge', 'none');
  const v = document.getElementById('remote-screen-video') as HTMLVideoElement | null;
  if (v) v.srcObject = null;
  if (!_hasRemoteScreenShare()) closeScreenShareView();
  toast('Ekran paylaşımı durduruldu', 'success');
}

function _hasRemoteScreenShare(): boolean {
  const v = document.getElementById('remote-screen-video') as HTMLVideoElement | null;
  return !!(v?.srcObject && (v.srcObject as MediaStream).active);
}

// ══════════════════════════════════════════════════
// SCREEN SHARE VIEW
// ══════════════════════════════════════════════════

export function openScreenShareView(): void {
  const view = document.getElementById('screen-share-view');
  if (!view) return;
  view.style.display = 'flex';
  const chName = document.getElementById('ss-channel-name');
  if (chName && currentChannel) chName.textContent = currentChannel.name ?? 'Ses Kanalı';
}

export function closeScreenShareView(): void {
  const view = document.getElementById('screen-share-view');
  if (view) view.style.display = 'none';
}

export function toggleSSFullscreen(): void {
  const wrap = document.getElementById('ss-video-wrap');
  if (!document.fullscreenElement) {
    wrap?.requestFullscreen?.().catch(() => { /* ignore */ });
    const btn = document.getElementById('ss-fullscreen-btn');
    if (btn) btn.textContent = '⊠';
  } else {
    document.exitFullscreen?.();
    const btn = document.getElementById('ss-fullscreen-btn');
    if (btn) btn.textContent = '⛶';
  }
}

let _ssMiniMode = false;
export function toggleSSMiniMode(): void {
  _ssMiniMode = !_ssMiniMode;
  document.getElementById('screen-share-view')?.classList.toggle('ss-mini', _ssMiniMode);
}

document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('ss-fullscreen-btn');
  if (btn) btn.textContent = document.fullscreenElement ? '⊠' : '⛶';
});

// ══════════════════════════════════════════════════
// LEAVE VOICE
// ══════════════════════════════════════════════════

export function leaveVoice(): void {
  BridgeRegistry.get('BridgeVoiceE2E')?.clearSession?.();
  document.getElementById('voice-e2e-badge')?.remove();
  BridgeRegistry.get('_bridgeStopLocalVAD')?.();
  sfuClearAllVideoTiles();
  rtc.leaveVoice();
  voiceChannelPeers.clear();
  _setDisplay('text-view', 'flex');
  _setDisplay('voice-view', 'none');
  const peersEl = document.getElementById('voice-peers');
  if (peersEl) peersEl.innerHTML = '';
  document.getElementById('vc-video')?.classList.remove('active');
  document.getElementById('vc-screen')?.classList.remove('active');
  _setDisplay('ss-stop-btn', 'none');
  _setDisplay('ss-share-btn', '');
  _setDisplay('ss-local-badge', 'none');
  closeScreenShareView();
  const firstText = document.querySelector<HTMLElement>('.ch-item[data-type="text"]');
  firstText?.click();
}

// ══════════════════════════════════════════════════
// VOICE PEER RENDERING
// ══════════════════════════════════════════════════

export function renderVoicePeer(peer: PeerInfo, isLocal = false): void {
  const container = document.getElementById('voice-peers');
  if (!container) return;
  const id = isLocal ? 'local' : peer.socketId;
  if (document.getElementById(`vp-${id}`)) return;
  const el = document.createElement('div');
  el.className = 'voice-peer' + (isLocal ? ' local' : '');
  el.id = `vp-${id}`;
  el.dataset.socket = peer.socketId ?? 'local';
  el.innerHTML = `
    <div class="voice-peer-video-wrap" id="vpw-${id}">
      <div class="voice-peer-avatar-center">
        <div class="voice-peer-big-avatar" style="background:${cssColor(peer.avatarColor)}">${initials(peer.displayName)}</div>
      </div>
    </div>
    <div class="voice-peer-name">${escHtml(peer.displayName)}${isLocal ? ' (Sen)' : ''}</div>
    <div class="voice-peer-icons" id="vpi-${id}"></div>`;
  container.appendChild(el);
  if (isLocal) attachLocalVideo();
}

export function attachLocalVideo(): void {
  const stream = (getRtc() as RtcInstance | null)?.getLocalStream();
  if (!stream || !stream.getVideoTracks().length) return;
  const wrap = document.getElementById('vpw-local');
  if (!wrap) return;
  let video = wrap.querySelector('video') as HTMLVideoElement | null;
  if (!video) {
    video = document.createElement('video');
    video.autoplay = true; video.muted = true; video.playsInline = true;
    wrap.appendChild(video);
  }
  video.srcObject = stream;
}

export function attachRemoteStream(socketId: string, stream: MediaStream): void {
  const wrap = document.getElementById(`vpw-${socketId}`);
  if (wrap) {
    let video = wrap.querySelector('video') as HTMLVideoElement | null;
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true; video.playsInline = true;
      video.className = 'remote-audio';
      wrap.appendChild(video);
    }
    video.srcObject = stream;
  }

  const hasScreen = stream.getVideoTracks().some(t =>
    t.label.toLowerCase().includes('screen') ||
    t.label.toLowerCase().includes('window') ||
    t.label.toLowerCase().includes('tab') ||
    t.contentHint === 'detail',
  );

  if (hasScreen) {
    const mainVideo = document.getElementById('remote-screen-video') as HTMLVideoElement | null;
    if (mainVideo) mainVideo.srcObject = stream;
    const peer = [...voiceChannelPeers.values()].find(p => p.socketId === socketId);
    const sharerEl = document.getElementById('ss-sharer-name');
    if (sharerEl && peer) sharerEl.textContent = `— ${peer.displayName} paylaşıyor`;
    openScreenShareView();
    _setDisplay('ss-stop-btn', 'none');
    _setDisplay('ss-share-btn', '');
    _addScreenThumbnail(socketId, stream, peer?.displayName ?? 'Kullanıcı');
  }
}

function _addScreenThumbnail(socketId: string, stream: MediaStream, name: string): void {
  const strip = document.getElementById('ss-thumbnails');
  if (!strip) return;
  if (document.getElementById(`ss-thumb-${socketId}`)) return;
  const thumb = document.createElement('div');
  thumb.id = `ss-thumb-${socketId}`;
  thumb.className = 'ss-thumb';
  const v = document.createElement('video');
  v.autoplay = true; v.playsInline = true; v.muted = true; v.srcObject = stream;
  const label = document.createElement('div');
  label.className = 'ss-thumb-label'; label.textContent = name;
  thumb.appendChild(v); thumb.appendChild(label);
  thumb.addEventListener('click', () => {
    (document.getElementById('remote-screen-video') as HTMLVideoElement).srcObject = stream;
    const el = document.getElementById('ss-sharer-name');
    if (el) el.textContent = `— ${name} paylaşıyor`;
  });
  strip.appendChild(thumb);
  strip.style.display = 'flex';
}

export function removeVoicePeer(socketId: string): void {
  document.getElementById(`vp-${socketId}`)?.remove();
  const thumb = document.getElementById(`ss-thumb-${socketId}`);
  if (thumb) {
    thumb.remove();
    const strip = document.getElementById('ss-thumbnails');
    if (strip && !strip.children.length) strip.style.display = 'none';
  }
  const mainVideo = document.getElementById('remote-screen-video') as HTMLVideoElement | null;
  if (mainVideo?.srcObject) {
    const tracks = (mainVideo.srcObject as MediaStream).getTracks();
    if (tracks.every(t => t.readyState === 'ended') && !rtc.screenSharing) closeScreenShareView();
  }
}

export function updatePeerState(socketId: string, state: PeerState): void {
  const icons = document.getElementById(`vpi-${socketId}`);
  if (!icons) return;
  icons.innerHTML =
    (state.muted ? '🔇 ' : '') +
    (state.screensharing ? '<span class="peer-sharing-badge">🖥️ Paylaşıyor</span> ' : '') +
    (state.video ? '📷' : '');
  document.getElementById(`vpw-${socketId}`)?.classList.toggle('speaking', !state.muted);
  if (!state.screensharing) document.getElementById(`ss-thumb-${socketId}`)?.remove();
  if (state.video === false) sfuRemoveVideoTile(`${socketId}-video`);
  if (state.screensharing === false) sfuRemoveVideoTile(`${socketId}-screen`);
}

// ══════════════════════════════════════════════════
// REPLY & PIN
// ══════════════════════════════════════════════════

export function startReply(msgId: string, displayName: string): void {
  (window as unknown as Record<string, unknown>)['replyingTo'] = msgId;
  let bar = document.getElementById('reply-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'reply-bar';
    bar.className = 'reply-bar-active';
    document.getElementById('msg-input-wrap')?.prepend(bar);
  }
  bar.innerHTML = `<span>↩️ Replying to <strong>${escHtml(displayName)}</strong></span><button onclick="cancelReply()">✕</button>`;
  (document.getElementById('msg-input') as HTMLInputElement | null)?.focus();
}

export function cancelReply(): void {
  (window as unknown as Record<string, unknown>)['replyingTo'] = null;
  document.getElementById('reply-bar')?.remove();
}

export function pinMessage(msgId: string, channelId: string): void {
  socket.emit('message:pin', { messageId: msgId, channelId, serverId: currentServer?._id });
}

// ══════════════════════════════════════════════════
// BRIDGE PTT — Push-to-Talk
// ══════════════════════════════════════════════════

interface PTTState {
  enabled: boolean;
  mode: 'hold' | 'toggle';
  key: PTTKey | null;
  releaseDelay: number;
  active: boolean;
}

const BridgePTT = (() => {
  const STORAGE_KEY = 'bridgePTT';
  let _enabled = false;
  let _mode: 'hold' | 'toggle' = 'hold';
  let _key: PTTKey | null = null;
  let _releaseDelay = 200;
  let _active = false;
  let _releaseTimer: ReturnType<typeof setTimeout> | null = null;
  let _capturing = false;

  function _load(): void {
    try {
      const d: Partial<PTTState> = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
      _enabled = d.enabled ?? false;
      _mode = d.mode ?? 'hold';
      _key = d.key ?? null;
      _releaseDelay = d.releaseDelay ?? 200;
    } catch (_) { /* ignore */ }
  }

  function _save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ enabled: _enabled, mode: _mode, key: _key, releaseDelay: _releaseDelay }));
    } catch (_) { /* ignore */ }
  }

  function _unmute(): void {
    if (!(getRtc() as RtcInstance | null)?.isInVoice()) return;
    rtc.setMuted(false);
    (['vc-mute', 'btn-mute', 'ss-mute-btn'] as const).forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.remove('active'); el.textContent = '🎙️'; }
    });
    _active = true;
    _pttLiveIndicator(true);
  }

  function _mute(): void {
    if (!(getRtc() as RtcInstance | null)?.isInVoice()) return;
    rtc.setMuted(true);
    (['vc-mute', 'btn-mute', 'ss-mute-btn'] as const).forEach(id => {
      const el = document.getElementById(id);
      if (el) { el.classList.add('active'); el.textContent = '🔇'; }
    });
    _active = false;
    _pttLiveIndicator(false);
  }

  function _pttLiveIndicator(on: boolean): void {
    const el = document.getElementById('ptt-live-status');
    if (!el) return;
    if (!_enabled) { el.textContent = 'Devre dışı'; el.style.color = ''; return; }
    if (on) { el.textContent = '🔴 Yayında — mikrofon açık'; el.style.color = 'var(--green,#43b581)'; }
    else { el.textContent = `⏸ Beklemede (${_key?.label ?? '—'})`; el.style.color = ''; }
  }

  function _onKeyDown(e: KeyboardEvent): void {
    if (!_enabled || !_key || e.code !== _key.code) return;
    const tag = (document.activeElement as HTMLElement | null)?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || (document.activeElement as HTMLElement | null)?.isContentEditable) return;
    e.preventDefault();
    if (_mode === 'hold') { if (_active) return; if (_releaseTimer) clearTimeout(_releaseTimer); _unmute(); }
    else { if (_active) _scheduleRelease(0); else _unmute(); }
  }

  function _onKeyUp(e: KeyboardEvent): void {
    if (!_enabled || !_key || _mode !== 'hold') return;
    if (e.code !== _key.code) return;
    e.preventDefault();
    _scheduleRelease(_releaseDelay);
  }

  function _scheduleRelease(delay: number): void {
    if (_releaseTimer) clearTimeout(_releaseTimer);
    if (delay <= 0) { _mute(); return; }
    _releaseTimer = setTimeout(_mute, delay);
  }

  function _captureHandler(e: KeyboardEvent): void {
    e.preventDefault(); e.stopPropagation();
    if (e.code === 'Escape') { _stopCapture(); return; }
    _key = { code: e.code, label: _buildLabel(e) };
    _save(); _stopCapture(); _pttUiSync();
  }

  function _buildLabel(e: KeyboardEvent): string {
    const parts: string[] = [];
    if (e.ctrlKey  && !['ControlLeft','ControlRight'].includes(e.code))  parts.push('Ctrl');
    if (e.altKey   && !['AltLeft','AltRight'].includes(e.code))          parts.push('Alt');
    if (e.shiftKey && !['ShiftLeft','ShiftRight'].includes(e.code))      parts.push('Shift');
    if (e.metaKey  && !['MetaLeft','MetaRight'].includes(e.code))        parts.push('Meta');
    const modCodes = ['ControlLeft','ControlRight','AltLeft','AltRight','ShiftLeft','ShiftRight','MetaLeft','MetaRight'];
    if (!modCodes.includes(e.code)) parts.push(e.key === ' ' ? 'Space' : (e.key?.length === 1 ? e.key.toUpperCase() : e.key));
    return parts.join('+') || e.code;
  }

  function _stopCapture(): void {
    document.removeEventListener('keydown', _captureHandler as EventListener, true);
    _capturing = false;
    const btn = document.getElementById('ptt-record-btn');
    if (btn) btn.textContent = '🔴 Tuşu Kaydet';
  }

  function _pttUiSync(): void {
    const status = document.getElementById('ptt-live-status');
    if (status) _pttLiveIndicator(_active);
  }

  return {
    init(): void { _load(); document.addEventListener('keydown', _onKeyDown); document.addEventListener('keyup', _onKeyUp); },
    setEnabled(on: boolean): void { _enabled = on; if (!on && _active) _mute(); _save(); _pttUiSync(); },
    setMode(m: 'hold' | 'toggle'): void { _mode = m; if (_active && m === 'hold') _mute(); _save(); },
    setReleaseDelay(ms: number): void { _releaseDelay = ms; _save(); },
    startKeyCapture(): void { if (_capturing) return; _capturing = true; const btn = document.getElementById('ptt-record-btn'); if (btn) btn.textContent = '⏳ Tuşa bas… (Esc = iptal)'; document.addEventListener('keydown', _captureHandler as EventListener, true); },
    clearKey(): void { _key = null; if (_active) _mute(); _save(); _pttUiSync(); },
    getStatus(): PTTState { return { enabled: _enabled, mode: _mode, key: _key, releaseDelay: _releaseDelay, active: _active }; },
  };
})();

document.addEventListener('DOMContentLoaded', () => BridgePTT.init());
document.addEventListener('bridge:socket-ready', () => BridgePTT.init());

export { BridgePTT };

// ── Yardımcı ─────────────────────────────────────────────────
function _setDisplay(id: string, value: string): void {
  const el = document.getElementById(id);
  if (el) el.style.display = value;
}


// Sprint 92: Desktop voice bar event dispatchers
// Bu event'ler desktop-voice-bar.ts tarafından dinleniyor.
// joinVoiceChannel başarısında:
//   document.dispatchEvent(new CustomEvent('bridge:voice-joined', { detail: { channelId, channelName } }));
// leaveVoiceChannel'da:
//   document.dispatchEvent(new CustomEvent('bridge:voice-left'));
// toggleMute'da:
//   document.dispatchEvent(new CustomEvent('bridge:voice-mute-changed', { detail: { muted } }));
