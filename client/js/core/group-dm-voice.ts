// client/js/core/group-dm-voice.ts
// Group DM voice/video calling on the canonical BridgeRegistry socket.
//
// This file intentionally does not resurrect the archived global/window-based
// implementation.  It owns only GDM call media/signalling, uses specific
// socket listener references, and renders remote metadata with DOM APIs rather
// than inline HTML/event handlers.

import { BridgeRegistry } from './bridge-registry.ts';
import { apiFetch } from './api-fetch.ts';
import { getAPI } from './globals.ts';
import { createLogger } from './logger.ts';
import { t } from './i18n/index';

const log = createLogger('GroupDmVoice');

type CallType = 'voice' | 'video';

type SocketHandler = (payload: unknown) => void | Promise<void>;
interface GdmSocket {
  id?: string;
  connected?: boolean;
  on(event: string, fn: SocketHandler): void;
  off(event: string, fn: SocketHandler): void;
  emit(event: string, payload?: unknown): void;
}

interface PeerMeta {
  socketId: string;
  userId?: string;
  displayName: string;
  avatarColor?: string;
  muted?: boolean;
  video?: boolean;
}

interface PeerState extends PeerMeta {
  pc: RTCPeerConnection;
  stream: MediaStream | null;
  pendingIce: RTCIceCandidateInit[];
}

interface IncomingPayload {
  groupId?: unknown;
  type?: unknown;
  callerDisplayName?: unknown;
  callerAvatarColor?: unknown;
}

const DEFAULT_ICE: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
  iceTransportPolicy: 'all',
};

let _boundSocket: GdmSocket | null = null;
let _activeGroupId: string | null = null;
let _callType: CallType = 'voice';
let _localStream: MediaStream | null = null;
let _iceConfig: RTCConfiguration = DEFAULT_ICE;
let _iceLoaded = false;
let _muted = false;
let _videoEnabled = false;
let _callStartedAt = 0;
let _timer: ReturnType<typeof setInterval> | null = null;
let _incomingTimer: ReturnType<typeof setTimeout> | null = null;
const _peers = new Map<string, PeerState>();
const _earlyIce = new Map<string, RTCIceCandidateInit[]>();

function currentSocket(): GdmSocket | null {
  return BridgeRegistry.get('socket') as GdmSocket | null;
}

function toast(message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): void {
  BridgeRegistry.call('toast', message, type);
}

function asCallType(value: unknown): CallType {
  return value === 'video' ? 'video' : 'voice';
}

function validId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 64;
}

function currentGroupName(groupId: string): string {
  const getter = BridgeRegistry.get('groupDmPanel:getCurrentGroup') as
    (() => { _id?: string; name?: string } | null) | null;
  const group = getter?.() ?? null;
  return group && group._id === groupId && typeof group.name === 'string' && group.name.trim()
    ? group.name.trim().slice(0, 100)
    : t('gdm_call_title');
}

async function loadIceConfig(): Promise<void> {
  if (_iceLoaded) return;
  _iceLoaded = true;
  try {
    const response = await apiFetch<{ iceServers?: RTCIceServer[]; iceTransportPolicy?: RTCIceTransportPolicy }>(
      `${getAPI()}/api/rtc/ice-config`,
    );
    if (!response.ok) return;
    const raw = await response.json() as { iceServers?: unknown; iceTransportPolicy?: unknown };
    if (!Array.isArray(raw.iceServers) || raw.iceServers.length === 0) return;
    const policy = raw.iceTransportPolicy === 'relay' ? 'relay' : 'all';
    _iceConfig = { iceServers: raw.iceServers as RTCIceServer[], iceTransportPolicy: policy };
  } catch (err) {
    // ICE config is an optimization/configuration boundary.  The same public
    // STUN fallback used by the direct-DM/voice code remains available.
    log.warn('ICE config yüklenemedi; güvenli fallback kullanılıyor', err);
  }
}

function stopLocalMedia(): void {
  if (_localStream) {
    for (const track of _localStream.getTracks()) {
      try { track.stop(); } catch { /* browser cleanup is best effort */ }
    }
  }
  _localStream = null;
}

function closePeer(socketId: string): void {
  const peer = _peers.get(socketId);
  if (!peer) return;
  try { peer.pc.onicecandidate = null; peer.pc.ontrack = null; peer.pc.close(); } catch { /* already closed */ }
  for (const track of peer.stream?.getTracks() ?? []) {
    // Remote MediaStream tracks are receiver-owned; stopping them releases the
    // element/decoder on local teardown and does not affect the remote sender.
    try { track.stop(); } catch { /* noop */ }
  }
  _peers.delete(socketId);
  _earlyIce.delete(socketId);
}

function closeAllPeers(): void {
  for (const socketId of [..._peers.keys()]) closePeer(socketId);
}

function removeCallUi(): void {
  document.getElementById('gdm-call-runtime')?.remove();
  document.getElementById('gdm-incoming-call')?.remove();
  if (_incomingTimer) { clearTimeout(_incomingTimer); _incomingTimer = null; }
  if (_timer) { clearInterval(_timer); _timer = null; }
}

function cleanupCall(): void {
  closeAllPeers();
  stopLocalMedia();
  removeCallUi();
  _activeGroupId = null;
  _callType = 'voice';
  _muted = false;
  _videoEnabled = false;
  _callStartedAt = 0;
}

function createButton(label: string, title: string, onClick: () => void, danger = false): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'btn btn-sm';
  button.title = title;
  button.textContent = label;
  if (danger) {
    button.style.background = 'var(--danger,#e05260)';
    button.style.color = '#fff';
  }
  button.addEventListener('click', onClick);
  return button;
}

function renderPeerMedia(container: HTMLElement, peer: PeerState): void {
  const tile = document.createElement('div');
  tile.dataset.gdmPeer = peer.socketId;
  tile.style.cssText = 'display:flex;align-items:center;gap:6px;min-width:0';

  if (peer.stream) {
    const hasVideo = peer.stream.getVideoTracks().some(track => track.enabled);
    const media = document.createElement(hasVideo ? 'video' : 'audio');
    media.autoplay = true;
    if (media instanceof HTMLVideoElement) {
      media.playsInline = true;
      media.style.cssText = 'width:72px;height:48px;object-fit:cover;border-radius:6px;background:#111';
    } else {
      media.style.display = 'none';
    }
    media.srcObject = peer.stream;
    tile.appendChild(media);
  }

  const name = document.createElement('span');
  name.textContent = peer.displayName || t('gdm_unknown_user');
  name.style.cssText = 'font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:110px';
  if (peer.muted) name.style.opacity = '0.55';
  tile.appendChild(name);
  container.appendChild(tile);
}

function renderCallUi(): void {
  if (!_activeGroupId) return;
  let root = document.getElementById('gdm-call-runtime');
  if (!root) {
    root = document.createElement('section');
    root.id = 'gdm-call-runtime';
    root.setAttribute('aria-label', t('gdm_call_aria', 'Grup araması'));
    root.style.cssText = [
      'position:fixed', 'left:16px', 'right:16px', 'bottom:16px', 'z-index:9400',
      'background:var(--bg-2,#2b2d31)', 'border:1px solid var(--border,#3f4147)',
      'border-radius:10px', 'padding:10px 12px', 'display:flex', 'align-items:center',
      'gap:10px', 'box-shadow:0 8px 28px rgba(0,0,0,.35)', 'max-height:120px',
    ].join(';');
    document.body.appendChild(root);
  }
  root.replaceChildren();

  const title = document.createElement('strong');
  title.textContent = `${_callType === 'video' ? '📹' : '🎙️'} ${currentGroupName(_activeGroupId)}`;
  title.style.cssText = 'font-size:13px;white-space:nowrap';
  root.appendChild(title);

  const elapsed = document.createElement('span');
  elapsed.id = 'gdm-call-elapsed';
  elapsed.style.cssText = 'font-size:12px;color:var(--text-muted,#9d9fa8);min-width:38px';
  root.appendChild(elapsed);

  const peerBox = document.createElement('div');
  peerBox.style.cssText = 'display:flex;gap:8px;align-items:center;overflow:auto;flex:1';
  for (const peer of _peers.values()) renderPeerMedia(peerBox, peer);
  root.appendChild(peerBox);

  root.appendChild(createButton(_muted ? '🔇' : '🎙️', t('gdm_toggle_mic'), () => {
    _muted = !_muted;
    for (const track of _localStream?.getAudioTracks() ?? []) track.enabled = !_muted;
    _boundSocket?.emit('gdm:call:state', { groupId: _activeGroupId, muted: _muted, video: _videoEnabled });
    renderCallUi();
  }));

  if (_callType === 'video') {
    root.appendChild(createButton(_videoEnabled ? '📹' : '🚫', t('gdm_toggle_camera'), () => {
      _videoEnabled = !_videoEnabled;
      for (const track of _localStream?.getVideoTracks() ?? []) track.enabled = _videoEnabled;
      _boundSocket?.emit('gdm:call:state', { groupId: _activeGroupId, muted: _muted, video: _videoEnabled });
      renderCallUi();
    }));
  }

  root.appendChild(createButton(t('close'), t('gdm_leave_call'), () => stopGroupDmVoice(), true));

  const updateTimer = (): void => {
    const el = document.getElementById('gdm-call-elapsed');
    if (!el || !_callStartedAt) return;
    const seconds = Math.max(0, Math.floor((Date.now() - _callStartedAt) / 1000));
    el.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  };
  updateTimer();
  if (!_timer) _timer = setInterval(updateTimer, 1000);
}

function showIncomingCall(payload: IncomingPayload): void {
  if (_activeGroupId || !validId(payload.groupId)) return;
  const type = asCallType(payload.type);
  const caller = typeof payload.callerDisplayName === 'string' && payload.callerDisplayName.trim()
    ? payload.callerDisplayName.trim().slice(0, 100)
    : t('gdm_unknown_user', 'Bir kullanıcı');

  document.getElementById('gdm-incoming-call')?.remove();
  if (_incomingTimer) clearTimeout(_incomingTimer);

  const popup = document.createElement('section');
  popup.id = 'gdm-incoming-call';
  popup.setAttribute('role', 'dialog');
  popup.setAttribute('aria-label', t('gdm_incoming_call_aria', 'Gelen grup araması'));
  popup.style.cssText = [
    'position:fixed', 'right:16px', 'top:16px', 'z-index:9600',
    'background:var(--bg-2,#2b2d31)', 'border:1px solid var(--border,#3f4147)',
    'border-radius:10px', 'padding:14px', 'min-width:260px',
    'box-shadow:0 8px 28px rgba(0,0,0,.4)', 'display:flex', 'flex-direction:column', 'gap:10px',
  ].join(';');

  const text = document.createElement('div');
  text.textContent = t(
    type === 'video' ? 'gdm_incoming_video_call' : 'gdm_incoming_voice_call',
    type === 'video' ? '{caller} · görüntülü grup araması' : '{caller} · sesli grup araması',
    { caller },
  );
  popup.appendChild(text);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex;gap:8px';
  actions.appendChild(createButton(t('gdm_answer', 'Yanıtla'), t('gdm_join_call', 'Aramaya katıl'), () => {
    popup.remove();
    if (_incomingTimer) { clearTimeout(_incomingTimer); _incomingTimer = null; }
    void joinGroupDmVoice(type, payload.groupId as string);
  }));
  actions.appendChild(createButton(t('gdm_reject', 'Reddet'), t('gdm_reject_call', 'Aramayı reddet'), () => {
    popup.remove();
    if (_incomingTimer) { clearTimeout(_incomingTimer); _incomingTimer = null; }
  }, true));
  popup.appendChild(actions);
  document.body.appendChild(popup);

  _incomingTimer = setTimeout(() => {
    popup.remove();
    _incomingTimer = null;
  }, 30_000);
}

async function acquireLocalMedia(type: CallType): Promise<void> {
  if (_localStream) return;
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('MediaDevices API unavailable');
  await loadIceConfig();
  _localStream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: type === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 } } : false,
  });
  _videoEnabled = type === 'video' && _localStream.getVideoTracks().some(track => track.enabled);
}

async function ensurePeer(meta: PeerMeta): Promise<PeerState> {
  const existing = _peers.get(meta.socketId);
  if (existing) {
    existing.displayName = meta.displayName || existing.displayName;
    if (meta.userId) existing.userId = meta.userId;
    return existing;
  }

  const pc = new RTCPeerConnection(_iceConfig);
  for (const track of _localStream?.getTracks() ?? []) pc.addTrack(track, _localStream!);
  const peer: PeerState = {
    ...meta, displayName: meta.displayName || t('gdm_unknown_user'), pc, stream: null,
    pendingIce: _earlyIce.get(meta.socketId) ?? [],
  };
  _earlyIce.delete(meta.socketId);
  _peers.set(meta.socketId, peer);

  pc.onicecandidate = event => {
    if (!event.candidate || !_activeGroupId || !_boundSocket) return;
    _boundSocket.emit('gdm:call:ice', {
      groupId: _activeGroupId,
      targetSocketId: meta.socketId,
      candidate: event.candidate.toJSON ? event.candidate.toJSON() : event.candidate,
    });
  };
  pc.ontrack = event => {
    peer.stream = event.streams[0] ?? new MediaStream([event.track]);
    renderCallUi();
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
      closePeer(meta.socketId);
      renderCallUi();
    }
  };
  return peer;
}

async function flushPendingIce(peer: PeerState): Promise<void> {
  if (!peer.pc.remoteDescription || peer.pendingIce.length === 0) return;
  const pending = peer.pendingIce.splice(0);
  for (const candidate of pending) {
    try { await peer.pc.addIceCandidate(candidate); }
    catch (err) { log.warn('GDM bekleyen ICE adayı işlenemedi', err); }
  }
}

async function initiateOffer(peer: PeerState): Promise<void> {
  if (!_activeGroupId || !_boundSocket) return;
  const offer = await peer.pc.createOffer();
  await peer.pc.setLocalDescription(offer);
  _boundSocket.emit('gdm:call:offer', {
    groupId: _activeGroupId,
    targetSocketId: peer.socketId,
    offer: peer.pc.localDescription ?? offer,
  });
}

async function startOrJoin(mode: 'start' | 'join', type: CallType, groupId: string): Promise<void> {
  if (!validId(groupId)) { toast(t('gdm_invalid_call', 'Invalid group call'), 'error'); return; }
  if (_activeGroupId && _activeGroupId !== groupId) {
    toast(t('gdm_leave_current_call', 'Leave the current group call first'), 'warning');
    return;
  }
  const socket = currentSocket();
  if (!socket?.connected) { toast(t('gdm_realtime_not_ready', 'Realtime connection is not ready'), 'error'); return; }

  try {
    await acquireLocalMedia(type);
    _activeGroupId = groupId;
    _callType = type;
    _callStartedAt ||= Date.now();
    bindSocket(socket);
    socket.emit(mode === 'start' ? 'gdm:call:start' : 'gdm:call:join', { groupId, type });
    renderCallUi();
  } catch (err) {
    log.error('GDM medya başlatılamadı', err);
    cleanupCall();
    toast(t('gdm_media_access_failed', 'Microphone/camera access failed; the call could not start'), 'error');
  }
}

export async function startGroupDmVoice(type: CallType = 'voice', groupId?: string): Promise<void> {
  const getter = BridgeRegistry.get('groupDmPanel:getCurrentGroup') as (() => { _id?: string } | null) | null;
  const resolved = validId(groupId) ? groupId : getter?.()?._id;
  if (!validId(resolved)) { toast(t('gdm_select_group_first', 'Select a group first'), 'warning'); return; }
  await startOrJoin('start', asCallType(type), resolved);
}

export async function joinGroupDmVoice(type: CallType = 'voice', groupId?: string): Promise<void> {
  if (!validId(groupId)) { toast(t('gdm_invalid_call', 'Invalid group call'), 'error'); return; }
  await startOrJoin('join', asCallType(type), groupId);
}

export function stopGroupDmVoice(): void {
  if (_activeGroupId && _boundSocket?.connected) {
    _boundSocket.emit('gdm:call:leave', { groupId: _activeGroupId });
  }
  cleanupCall();
}

export function endGroupDmVoice(): void {
  if (_activeGroupId && _boundSocket?.connected) {
    _boundSocket.emit('gdm:call:end', { groupId: _activeGroupId });
  }
  cleanupCall();
}

function parsePeer(payload: unknown): PeerMeta | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  if (!validId(p.socketId)) return null;
  return {
    socketId: p.socketId,
    userId: validId(p.userId) ? p.userId : undefined,
    displayName: typeof p.displayName === 'string' ? p.displayName.slice(0, 100) : t('gdm_unknown_user'),
    avatarColor: typeof p.avatarColor === 'string' ? p.avatarColor.slice(0, 32) : undefined,
  };
}

const handlers: Record<string, SocketHandler> = {
  'gdm:call:started': payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (!validId(p.groupId) || p.groupId !== _activeGroupId) return;
    _callType = asCallType(p.type);
    _callStartedAt ||= Date.now();
    renderCallUi();
  },
  'gdm:call:incoming': payload => showIncomingCall((payload ?? {}) as IncomingPayload),
  'gdm:call:joined': payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (!validId(p.groupId) || p.groupId !== _activeGroupId) return;
    _callType = asCallType(p.type);
    _callStartedAt ||= Date.now();
    renderCallUi();
  },
  'gdm:call:existing:peers': async payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId || !Array.isArray(p.peers)) return;
    for (const raw of p.peers) {
      const meta = parsePeer(raw);
      if (!meta || meta.socketId === _boundSocket?.id) continue;
      try { await initiateOffer(await ensurePeer(meta)); }
      catch (err) { log.warn('GDM offer oluşturulamadı', err); closePeer(meta.socketId); }
    }
    renderCallUi();
  },
  'gdm:call:peer:joined': async payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId) return;
    const meta = parsePeer(p);
    if (!meta || meta.socketId === _boundSocket?.id) return;
    try { await ensurePeer(meta); renderCallUi(); }
    catch (err) { log.warn('GDM peer hazırlanamadı', err); closePeer(meta.socketId); }
  },
  'gdm:call:peer:left': payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId || !validId(p.socketId)) return;
    closePeer(p.socketId);
    renderCallUi();
  },
  'gdm:call:ended': payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId) return;
    cleanupCall();
    toast(t('gdm_call_ended', 'Group call ended'), 'info');
  },
  'gdm:call:left': payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId === _activeGroupId) cleanupCall();
  },
  'gdm:call:offer': async payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId || !validId(p.fromSocketId) || !p.offer) return;
    const meta: PeerMeta = { socketId: p.fromSocketId, displayName: t('adm_user', 'Kullanıcı') };
    try {
      const peer = await ensurePeer(meta);
      await peer.pc.setRemoteDescription(p.offer as RTCSessionDescriptionInit);
      await flushPendingIce(peer);
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      _boundSocket?.emit('gdm:call:answer', {
        groupId: _activeGroupId,
        targetSocketId: p.fromSocketId,
        answer: peer.pc.localDescription ?? answer,
      });
    } catch (err) {
      log.warn('GDM offer işlenemedi', err);
      closePeer(p.fromSocketId);
    }
  },
  'gdm:call:answer': async payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId || !validId(p.fromSocketId) || !p.answer) return;
    const peer = _peers.get(p.fromSocketId);
    if (!peer) return;
    try {
      await peer.pc.setRemoteDescription(p.answer as RTCSessionDescriptionInit);
      await flushPendingIce(peer);
    }
    catch (err) {
      // A peer whose answer cannot be installed cannot complete negotiation.
      // Keeping it in the canonical map makes later join/existing-peer events
      // reuse the permanently broken connection instead of rebuilding it.
      log.warn('GDM answer işlenemedi', err);
      closePeer(p.fromSocketId);
      renderCallUi();
    }
  },
  'gdm:call:ice': async payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId || !validId(p.fromSocketId) || !p.candidate) return;
    const candidate = p.candidate as RTCIceCandidateInit;
    const peer = _peers.get(p.fromSocketId);
    if (!peer) {
      const pending = _earlyIce.get(p.fromSocketId) ?? [];
      if (pending.length < 128) pending.push(candidate);
      _earlyIce.set(p.fromSocketId, pending);
      return;
    }
    if (!peer.pc.remoteDescription) {
      if (peer.pendingIce.length < 128) peer.pendingIce.push(candidate);
      return;
    }
    try { await peer.pc.addIceCandidate(candidate); }
    catch (err) { log.warn('GDM ICE adayı işlenemedi', err); }
  },
  'gdm:call:peer:state': payload => {
    const p = (payload ?? {}) as Record<string, unknown>;
    if (p.groupId !== _activeGroupId || !validId(p.socketId)) return;
    const peer = _peers.get(p.socketId);
    if (!peer) return;
    peer.muted = p.muted === true;
    peer.video = p.video === true;
    renderCallUi();
  },
};

function unbindSocket(): void {
  if (!_boundSocket) return;
  for (const [event, handler] of Object.entries(handlers)) _boundSocket.off(event, handler);
  _boundSocket = null;
}

function bindSocket(socket = currentSocket()): void {
  if (!socket || socket === _boundSocket) return;
  unbindSocket();
  _boundSocket = socket;
  for (const [event, handler] of Object.entries(handlers)) socket.on(event, handler);
}

function handleSocketReady(): void {
  const next = currentSocket();
  const changed = next !== _boundSocket;
  if (changed) bindSocket(next);
  // Socket.IO rooms and socket ids are connection-scoped.  On reconnect, old
  // peer ids/connections are stale; rebuild them through the server's canonical
  // existing-peer handshake rather than trying to reuse them.
  if (_activeGroupId && _localStream && next?.connected) {
    closeAllPeers();
    next.emit('gdm:call:join', { groupId: _activeGroupId, type: _callType });
  }
}

const RUNTIME_KEYS = ['startGdmCall', 'joinGdmCall', 'leaveGdmCall', 'endGdmCall', 'groupDmCall:isActive'] as const;
let _runtimeRegistered = false;
let _documentListenersBound = false;

function registerRuntimeApi(): void {
  if (_runtimeRegistered) return;
  BridgeRegistry.register('startGdmCall', (type: unknown, groupId: unknown) =>
    startGroupDmVoice(asCallType(type), validId(groupId) ? groupId : undefined));
  BridgeRegistry.register('joinGdmCall', (type: unknown, groupId: unknown) =>
    joinGroupDmVoice(asCallType(type), validId(groupId) ? groupId : undefined));
  BridgeRegistry.register('leaveGdmCall', () => stopGroupDmVoice());
  BridgeRegistry.register('endGdmCall', () => endGroupDmVoice());
  BridgeRegistry.register('groupDmCall:isActive', () => _activeGroupId !== null);
  _runtimeRegistered = true;
}

function bindDocumentLifecycle(): void {
  if (_documentListenersBound) return;
  document.addEventListener('bridge:socket-ready', handleSocketReady);
  document.addEventListener('bridge:socket-reconnected', handleSocketReady);
  _documentListenersBound = true;
}

function initializeRuntime(): void {
  registerRuntimeApi();
  bindDocumentLifecycle();
  bindSocket();
}

initializeRuntime();

export function teardownGroupDmVoiceRuntime(): void {
  cleanupCall();
  unbindSocket();
  if (_documentListenersBound) {
    document.removeEventListener('bridge:socket-ready', handleSocketReady);
    document.removeEventListener('bridge:socket-reconnected', handleSocketReady);
    _documentListenersBound = false;
  }
  if (_runtimeRegistered) {
    for (const key of RUNTIME_KEYS) BridgeRegistry.unregister(key);
    _runtimeRegistered = false;
  }
}

export const __gdmVoiceTestHooks = {
  bindSocket,
  cleanupCall,
  initializeRuntime,
  registerRuntimeApi,
  peerCount: () => _peers.size,
  activeGroupId: () => _activeGroupId,
  /**
   * ICE yapılandırması OTURUM BAŞINA BİR KEZ yüklenir (`_iceLoaded`). Yükleme
   * yolunun her dalını (başarı, boş liste, reddedilen istek) ölçebilmek için
   * bu tek seferlik durumun sıfırlanabilmesi gerekir. Üretim kodu bu kancayı
   * ÇAĞIRMAZ; yalnızca ölçüm içindir.
   */
  resetIceConfig: (): void => { _iceLoaded = false; _iceConfig = DEFAULT_ICE; },
};
