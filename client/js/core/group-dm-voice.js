// client/js/core/group-dm-voice.js
// Group DM ses/video aramalar: WebRTC, çağrı UI, socket events
// Bağımlı: group-dm-core.js (önceden yüklenmeli)

// ── GDM Voice Call UI & WebRTC ─────────────────────────────────

function _gdmCallBar() {
  let bar = document.getElementById('gdm-call-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'gdm-call-bar';
    bar.style.cssText = [
      'position:fixed;bottom:0;left:0;right:0;z-index:9000',
      'background:var(--bg-2,#2b2d31);border-top:1px solid var(--border,#3f4147)',
      'display:flex;align-items:center;gap:8px;padding:8px 16px',
      'min-height:56px',
    ].join(';');
    document.body.appendChild(bar);
  }
  return bar;
}

function _renderCallBar() {
  const bar = _gdmCallBar();
  const g = _gdmGroups.find(g => g._id === _gdmCallGroupId) || currentGroupDm || {};
  const icon = _gdmCallType === 'video' ? '📹' : '🎙️';
  const peerCount = _gdmCallPeers.size;

  bar.innerHTML = `
    <span style="font-size:18px">${icon}</span>
    <span style="font-weight:600;font-size:13px">${escHtml(g.name || 'Grup Araması')}</span>
    <span id="gdm-call-timer" style="font-size:12px;color:var(--text-muted,#9d9fa8);min-width:40px">0:00</span>
    <div id="gdm-call-peers-bar" style="display:flex;gap:4px;flex:1;overflow:hidden"></div>
    <button id="gdm-call-mute-btn" class="btn btn-sm" title="Mikrofon" style="font-size:16px">🎙️</button>
    ${_gdmCallType === 'video' ? '<button id="gdm-call-video-toggle" class="btn btn-sm" title="Kamera" style="font-size:16px">📹</button>' : ''}
    <button id="gdm-call-expand-btn" class="btn btn-sm" title="Büyüt" style="font-size:16px" onclick="openGdmCallModal()">⛶</button>
    <button class="btn btn-sm" style="background:var(--danger,#ed4245);color:#fff;padding:6px 14px;font-weight:700" onclick="leaveGdmCall()">Kapat</button>
  `;
  bar.style.display = 'flex';

  // Mute toggle
  let _muted = false;
  document.getElementById('gdm-call-mute-btn')?.addEventListener('click', () => {
    _muted = !_muted;
    if (_gdmLocalStream) {
      _gdmLocalStream.getAudioTracks().forEach(t => { t.enabled = !_muted; });
    }
    const btn = document.getElementById('gdm-call-mute-btn');
    if (btn) btn.textContent = _muted ? '🔇' : '🎙️';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: _muted, video: _gdmCallType === 'video' });
  });

  // Video toggle
  let _videoOff = false;
  document.getElementById('gdm-call-video-toggle')?.addEventListener('click', () => {
    _videoOff = !_videoOff;
    if (_gdmLocalStream) {
      _gdmLocalStream.getVideoTracks().forEach(t => { t.enabled = !_videoOff; });
    }
    const btn = document.getElementById('gdm-call-video-toggle');
    if (btn) btn.textContent = _videoOff ? '🚫' : '📹';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: false, video: !_videoOff });
  });

  _renderCallPeersBar();
  _startCallTimer();
}

let _callTimerInterval = null;
let _callStartTime     = null;

function _startCallTimer() {
  clearInterval(_callTimerInterval);
  _callStartTime = Date.now();
  _callTimerInterval = setInterval(() => {
    const el = document.getElementById('gdm-call-timer');
    if (!el) return;
    const s = Math.floor((Date.now() - _callStartTime) / 1000);
    const m = Math.floor(s / 60);
    el.textContent = `${m}:${String(s % 60).padStart(2, '0')}`;
  }, 1000);
}

function _renderCallPeersBar() {
  const bar = document.getElementById('gdm-call-peers-bar');
  if (!bar) return;
  bar.innerHTML = '';
  for (const [socketId, peer] of _gdmCallPeers) {
    const dot = document.createElement('div');
    dot.dataset.gdmPeer = socketId;
    dot.title = peer.displayName || '';
    dot.style.cssText = [
      `width:28px;height:28px;border-radius:50%`,
      `background:${cssColor(peer.avatarColor)};color:#fff`,
      `display:flex;align-items:center;justify-content:center`,
      `font-size:11px;font-weight:700;flex-shrink:0`,
      `border:2px solid transparent;transition:border-color .15s`,
    ].join(';');
    dot.textContent = initials(peer.displayName || '?');
    if (peer.muted) dot.style.opacity = '0.5';
    bar.appendChild(dot);
  }
}

// ── Expanded Call Modal ────────────────────────────────────────

function openGdmCallModal() {
  _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.style.zIndex = '9500';

  const g = _gdmGroups.find(g => g._id === _gdmCallGroupId) || currentGroupDm || {};
  const icon = _gdmCallType === 'video' ? '📹' : '🎙️';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:600px;width:95%;max-height:85vh;overflow:hidden;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:12px">
        <span style="font-size:20px">${icon}</span>
        <h2 style="margin:0">${escHtml(g.name || 'Grup Araması')}</h2>
        <span id="gdm-modal-timer" style="font-size:13px;color:var(--text-muted);margin-left:8px">0:00</span>
        <button class="btn btn-sm" style="margin-left:auto" onclick="_destroyTempModal()">✕</button>
      </div>
      <div id="gdm-call-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:8px;flex:1;overflow-y:auto;padding-bottom:8px"></div>
      <div style="display:flex;gap:8px;justify-content:center;padding-top:12px;border-top:1px solid var(--border)">
        <button class="btn btn-sm" id="gdm-modal-mute">🎙️ Mikrofon</button>
        ${_gdmCallType === 'video' ? '<button class="btn btn-sm" id="gdm-modal-video">📹 Kamera</button>' : ''}
        <button class="btn btn-sm" style="background:var(--danger);color:#fff" onclick="leaveGdmCall();_destroyTempModal()">📵 Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };

  _renderCallGrid();

  // Sync timer
  const syncTimer = setInterval(() => {
    const el = document.getElementById('gdm-modal-timer');
    if (!el) { clearInterval(syncTimer); return; }
    if (!_callStartTime) return;
    const s = Math.floor((Date.now() - _callStartTime) / 1000);
    el.textContent = `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`;
  }, 1000);

  // Mute/video controls in modal
  let _muted = false, _videoOff = false;
  document.getElementById('gdm-modal-mute')?.addEventListener('click', function() {
    _muted = !_muted;
    if (_gdmLocalStream) _gdmLocalStream.getAudioTracks().forEach(t => { t.enabled = !_muted; });
    this.textContent = _muted ? '🔇 Mikrofon' : '🎙️ Mikrofon';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: _muted, video: _gdmCallType === 'video' && !_videoOff });
  });
  document.getElementById('gdm-modal-video')?.addEventListener('click', function() {
    _videoOff = !_videoOff;
    if (_gdmLocalStream) _gdmLocalStream.getVideoTracks().forEach(t => { t.enabled = !_videoOff; });
    this.textContent = _videoOff ? '🚫 Kamera' : '📹 Kamera';
    socket.emit('gdm:call:state', { groupId: _gdmCallGroupId, muted: _muted, video: !_videoOff });
  });
}

function _renderCallGrid() {
  const grid = document.getElementById('gdm-call-grid');
  if (!grid) return;
  grid.innerHTML = '';

  // Local tile
  const localTile = _makePeerTile({
    socketId:    'local',
    userId:      me?.id,
    displayName: me?.displayName || 'Sen',
    avatarColor: me?.avatarColor || '#5865f2',
    stream:      _gdmLocalStream,
    isLocal:     true,
    muted:       false,
  });
  grid.appendChild(localTile);

  // Remote peers
  for (const [socketId, peer] of _gdmCallPeers) {
    grid.appendChild(_makePeerTile({ ...peer, socketId }));
  }
}

function _makePeerTile({ socketId, displayName, avatarColor, stream, isLocal, muted }) {
  const tile = document.createElement('div');
  tile.dataset.gdmTile = socketId;
  tile.style.cssText = [
    'border-radius:8px;background:var(--bg-3,#1e1f22);overflow:hidden',
    'aspect-ratio:4/3;position:relative;display:flex;align-items:center;justify-content:center',
  ].join(';');

  const hasVideo = stream && stream.getVideoTracks().some(t => t.enabled);
  if (hasVideo && stream) {
    const vid = document.createElement('video');
    vid.autoplay = true;
    vid.playsInline = true;
    vid.muted = !!isLocal;
    vid.style.cssText = 'width:100%;height:100%;object-fit:cover;position:absolute;inset:0';
    vid.srcObject = stream;
    tile.appendChild(vid);
  } else {
    const avatar = document.createElement('div');
    avatar.style.cssText = [
      `width:64px;height:64px;border-radius:50%`,
      `background:${cssColor(avatarColor)};color:#fff`,
      `display:flex;align-items:center;justify-content:center`,
      `font-size:24px;font-weight:700`,
    ].join(';');
    avatar.textContent = initials(displayName || '?');
    tile.appendChild(avatar);
  }

  // Name bar
  const nameBar = document.createElement('div');
  nameBar.style.cssText = [
    'position:absolute;bottom:0;left:0;right:0;padding:4px 8px',
    'background:rgba(0,0,0,.55);display:flex;align-items:center;gap:4px',
    'font-size:12px;color:#fff',
  ].join(';');
  nameBar.innerHTML = `
    <span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(displayName || '?')}${isLocal ? ' (Sen)' : ''}</span>
    <span class="gdm-peer-mute-icon" style="display:${muted ? 'inline' : 'none'}">🔇</span>
  `;
  tile.appendChild(nameBar);

  // Speaking ring (driven by voice:activity-like event, wired below)
  tile.style.outline = '2px solid transparent';
  tile.style.transition = 'outline-color .1s';

  return tile;
}

// ── WebRTC helpers ────────────────────────────────────────────

async function _createPeerConnection(socketId, peer) {
  const pc = new RTCPeerConnection({ iceServers: GDM_ICE_SERVERS });

  // Add local tracks
  if (_gdmLocalStream) {
    _gdmLocalStream.getTracks().forEach(track => pc.addTrack(track, _gdmLocalStream));
  }

  // ICE candidates → server relay
  pc.onicecandidate = ({ candidate }) => {
    if (candidate) {
      socket.emit('gdm:call:ice', { groupId: _gdmCallGroupId, targetSocketId: socketId, candidate });
    }
  };

  // Remote stream
  pc.ontrack = ({ streams }) => {
    const stream = streams[0];
    if (!stream) return;
    if (_gdmCallPeers.has(socketId)) {
      _gdmCallPeers.get(socketId).stream = stream;
    }
    // Update tile if modal is open
    const tile = document.querySelector(`[data-gdm-tile="${socketId}"]`);
    if (tile) {
      const vid = tile.querySelector('video');
      if (vid) vid.srcObject = stream;
    }
    // Audio playback (non-video)
    if (!document.querySelector(`audio[data-gdm-audio="${socketId}"]`)) {
      const audio = document.createElement('audio');
      audio.autoplay = true;
      audio.dataset.gdmAudio = socketId;
      audio.srcObject = stream;
      document.body.appendChild(audio);
    } else {
      document.querySelector(`audio[data-gdm-audio="${socketId}"]`).srcObject = stream;
    }
  };

  pc.onconnectionstatechange = () => {
    if (['failed', 'disconnected', 'closed'].includes(pc.connectionState)) {
      _removePeer(socketId);
    }
  };

  peer.pc = pc;
  return pc;
}

async function _initiatePeerOffer(socketId) {
  const peer = _gdmCallPeers.get(socketId);
  if (!peer) return;
  const pc = peer.pc || await _createPeerConnection(socketId, peer);
  peer.pc = pc;

  const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: _gdmCallType === 'video' });
  await pc.setLocalDescription(offer);
  socket.emit('gdm:call:offer', { groupId: _gdmCallGroupId, targetSocketId: socketId, offer });
}

function _removePeer(socketId) {
  const peer = _gdmCallPeers.get(socketId);
  if (!peer) return;
  peer.pc?.close();
  _gdmCallPeers.delete(socketId);
  // Remove audio element
  document.querySelector(`audio[data-gdm-audio="${socketId}"]`)?.remove();
  _renderCallPeersBar();
  const tile = document.querySelector(`[data-gdm-tile="${socketId}"]`);
  tile?.remove();
}

function _stopLocalStream() {
  if (_gdmLocalStream) {
    _gdmLocalStream.getTracks().forEach(t => t.stop());
    _gdmLocalStream = null;
  }
}

function _cleanupCall() {
  for (const [sid, peer] of _gdmCallPeers) {
    peer.pc?.close();
    document.querySelector(`audio[data-gdm-audio="${sid}"]`)?.remove();
  }
  _gdmCallPeers.clear();
  _stopLocalStream();
  clearInterval(_callTimerInterval);
  _callTimerInterval = null;
  _callStartTime     = null;
  _gdmCallActive     = false;
  _gdmCallGroupId    = null;
  const bar = document.getElementById('gdm-call-bar');
  if (bar) bar.remove();
}

// ── Public call actions ────────────────────────────────────────

async function startGdmCall(type = 'voice') {
  if (!currentGroupDm) return;
  if (_gdmCallActive) return toast('Zaten bir aramadayken başka arama başlatılamaz', 'error');

  try {
    _gdmLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video',
    });
  } catch (err) {
    const msg = err.name === 'NotAllowedError'
      ? 'Mikrofon/kamera izni reddedildi'
      : `Medya erişim hatası: ${err.message}`;
    return toast(msg, 'error');
  }

  _gdmCallActive  = true;
  _gdmCallGroupId = currentGroupDm._id;
  _gdmCallType    = type;

  socket.emit('gdm:call:start', { groupId: currentGroupDm._id, type });
}

async function joinGdmCall(groupId, type = 'voice') {
  if (_gdmCallActive) return; // zaten aramada

  try {
    _gdmLocalStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: type === 'video',
    });
  } catch {
    return toast('Mikrofon/kamera izni gerekli', 'error');
  }

  _gdmCallActive  = true;
  _gdmCallGroupId = groupId;
  _gdmCallType    = type;

  socket.emit('gdm:call:join', { groupId, type });
}

function leaveGdmCall() {
  if (!_gdmCallActive || !_gdmCallGroupId) return;
  socket.emit('gdm:call:leave', { groupId: _gdmCallGroupId });
  _cleanupCall();
}

// ── Incoming call popup ────────────────────────────────────────

function _showIncomingCallPopup({ groupId, type, callerDisplayName, callerAvatarColor }) {
  const existing = document.getElementById('gdm-incoming-call');
  if (existing) existing.remove();

  const popup = document.createElement('div');
  popup.id = 'gdm-incoming-call';
  popup.style.cssText = [
    'position:fixed;top:16px;right:16px;z-index:9800',
    'background:var(--bg-2,#2b2d31);border:1px solid var(--border,#3f4147)',
    'border-radius:12px;padding:16px 20px;min-width:260px',
    'box-shadow:0 8px 32px rgba(0,0,0,.45)',
    'display:flex;flex-direction:column;gap:10px',
  ].join(';');

  const g = _gdmGroups.find(g => g._id === groupId) || { name: 'Grup Araması' };
  const icon = type === 'video' ? '📹' : '🎙️';

  popup.innerHTML = `
    <div style="display:flex;align-items:center;gap:10px">
      <div style="width:40px;height:40px;border-radius:50%;background:${cssColor(callerAvatarColor)};color:#fff;display:flex;align-items:center;justify-content:center;font-size:16px;font-weight:700;flex-shrink:0">${initials(callerDisplayName)}</div>
      <div>
        <div style="font-weight:700;font-size:14px">${escHtml(callerDisplayName)}</div>
        <div style="font-size:12px;color:var(--text-muted)">${icon} ${escHtml(g.name)} · ${type === 'video' ? 'Görüntülü' : 'Sesli'} arama</div>
      </div>
    </div>
    <div style="display:flex;gap:8px">
      <button class="btn btn-sm" style="flex:1;background:var(--green,#57f287);color:#000;font-weight:700" onclick="joinGdmCall('${groupId}','${type}');document.getElementById('gdm-incoming-call')?.remove()">📞 Yanıtla</button>
      <button class="btn btn-sm" style="flex:1;background:var(--danger,#ed4245);color:#fff;font-weight:700" onclick="document.getElementById('gdm-incoming-call')?.remove()">📵 Reddet</button>
    </div>
  `;
  document.body.appendChild(popup);

  // Otomatik kapat 30 sn sonra
  setTimeout(() => popup.remove(), 30_000);
}

// ── Socket Events ──────────────────────────────────────────────
function bindGroupDmSocketEvents(socket) {
  socket.on('gdm:created', async (group) => {
    const idx = _gdmGroups.findIndex(g => g._id === group._id);
    if (idx === -1) _gdmGroups.unshift(group);
    else _gdmGroups[idx] = group;
    renderGroupDmList();
  });

  socket.on('gdm:message', (msg) => {
    // Update last message in list
    const g = _gdmGroups.find(g => g._id === msg.groupId);
    if (g) { g.lastMessage = msg; renderGroupDmList(); }

    // Append to open conversation
    if (currentGroupDm?._id === msg.groupId) {
      const area = document.getElementById('dm-messages');
      if (area) {
        area.appendChild(renderGdmMessage(msg));
        if (area.scrollHeight - area.scrollTop < 300) area.scrollTop = area.scrollHeight;
      }
    }
  });

  socket.on('gdm:updated', (group) => {
    const idx = _gdmGroups.findIndex(g => g._id === group._id);
    if (idx !== -1) { _gdmGroups[idx] = { ..._gdmGroups[idx], ...group }; renderGroupDmList(); }
    if (currentGroupDm?._id === group._id) currentGroupDm = { ...currentGroupDm, ...group };
  });

  socket.on('gdm:deleted', ({ groupId }) => {
    _gdmGroups = _gdmGroups.filter(g => g._id !== groupId);
    renderGroupDmList();
    if (currentGroupDm?._id === groupId) {
      currentGroupDm = null;
      document.getElementById('dm-messages').innerHTML = '';
      document.getElementById('dm-input-area').style.display = 'none';
    }
  });

  socket.on('gdm:typing', ({ groupId, displayName }) => {
    if (currentGroupDm?._id !== groupId) return;
    const area = document.getElementById('dm-messages');
    if (!area) return;
    let tip = area.querySelector('.gdm-typing-indicator');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'gdm-typing-indicator';
      tip.style.cssText = 'font-size:12px;color:var(--text-muted);padding:4px 12px;font-style:italic';
      area.appendChild(tip);
    }
    tip.textContent = `${escHtml(displayName)} yazıyor...`;
    clearTimeout(tip._timer);
    tip._timer = setTimeout(() => tip.remove(), 3000);
  });

  // ── GDM Voice Call Events ──────────────────────────────────

  // Arama başlatıldı (biz başlattık) — call bar göster
  socket.on('gdm:call:started', ({ groupId, type }) => {
    _gdmCallGroupId = groupId;
    _gdmCallType    = type;
    _gdmCallActive  = true;
    _renderCallBar();
  });

  // Başka biri arama başlattı — gelen arama popup'ı göster
  socket.on('gdm:call:incoming', ({ groupId, type, callerDisplayName, callerAvatarColor }) => {
    if (_gdmCallActive) return; // zaten aramadaysa gösterme
    _showIncomingCallPopup({ groupId, type, callerDisplayName, callerAvatarColor });
  });

  // Biz aramaya katıldık (gdm:call:join sonrası server onayı)
  socket.on('gdm:call:joined', ({ groupId, type }) => {
    _gdmCallGroupId = groupId;
    _gdmCallType    = type;
    _gdmCallActive  = true;
    _renderCallBar();
  });

  // Mevcut peer listesi — aramaya yeni katıldığımızda server gönderir
  socket.on('gdm:call:existing:peers', async ({ groupId, peers }) => {
    if (groupId !== _gdmCallGroupId) return;
    for (const peer of peers) {
      if (!_gdmCallPeers.has(peer.socketId)) {
        _gdmCallPeers.set(peer.socketId, {
          userId:      peer.userId,
          displayName: peer.displayName || 'Kullanıcı',
          avatarColor: peer.avatarColor || '#5865f2',
          stream:      null,
          pc:          null,
          muted:       false,
        });
        // Biz teklif (offer) göndeririz — taker modeli
        const pc = await _createPeerConnection(peer.socketId, _gdmCallPeers.get(peer.socketId));
        _gdmCallPeers.get(peer.socketId).pc = pc;
        await _initiatePeerOffer(peer.socketId);
      }
    }
    _renderCallPeersBar();
    _renderCallGrid();
  });

  // Yeni peer katıldı — onlar bize offer gönderecek, biz sadece peer kaydedelim
  socket.on('gdm:call:peer:joined', async ({ groupId, userId, displayName, avatarColor, socketId }) => {
    if (groupId !== _gdmCallGroupId) return;
    if (socketId === socket.id) return; // kendimiz
    if (!_gdmCallPeers.has(socketId)) {
      _gdmCallPeers.set(socketId, {
        userId, displayName: displayName || 'Kullanıcı',
        avatarColor: avatarColor || '#5865f2',
        stream: null, pc: null, muted: false,
      });
      // Peer connection'ı hazırla — karşı taraf offer gönderecek
      const pc = await _createPeerConnection(socketId, _gdmCallPeers.get(socketId));
      _gdmCallPeers.get(socketId).pc = pc;
    }
    _renderCallPeersBar();
    _renderCallGrid();
    toast(`${escHtml(displayName)} aramaya katıldı 🎙️`, 'info');
  });

  // Peer ayrıldı
  socket.on('gdm:call:peer:left', ({ groupId, socketId }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(socketId);
    if (peer) toast(`${escHtml(peer.displayName)} aramadan ayrıldı`, 'info');
    _removePeer(socketId);
    _renderCallGrid();
  });

  // Arama tamamen bitirildi (biri gdm:call:end emit etti)
  socket.on('gdm:call:ended', ({ groupId }) => {
    if (groupId !== _gdmCallGroupId) return;
    _destroyTempModal();
    _cleanupCall();
    toast('Grup araması sona erdi', 'info');
  });

  // Biz aramadan çıktık (kendi emit'imizin onayı — socket auto-leave)
  socket.on('gdm:call:left', ({ groupId }) => {
    if (groupId !== _gdmCallGroupId) return;
    // _cleanupCall zaten leaveGdmCall()'da çağrıldı
  });

  // WebRTC Signaling ─────────────────────────────────────────

  // Gelen offer — answer oluştur
  socket.on('gdm:call:offer', async ({ groupId, fromSocketId, offer }) => {
    if (groupId !== _gdmCallGroupId) return;
    let peer = _gdmCallPeers.get(fromSocketId);
    if (!peer) {
      // Peer henüz eklenmemişse (race condition) geçici kayıt
      peer = { userId: null, displayName: 'Kullanıcı', avatarColor: '#5865f2', stream: null, pc: null, muted: false };
      _gdmCallPeers.set(fromSocketId, peer);
    }
    if (!peer.pc) {
      peer.pc = await _createPeerConnection(fromSocketId, peer);
    }
    const pc = peer.pc;
    try {
      await pc.setRemoteDescription(new RTCSessionDescription(offer));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('gdm:call:answer', { groupId, targetSocketId: fromSocketId, answer });
    } catch (err) {
      console.error('[GDM Voice] offer işleme hatası:', err);
    }
  });

  // Gelen answer — remote description olarak kaydet
  socket.on('gdm:call:answer', async ({ groupId, fromSocketId, answer }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(fromSocketId);
    if (!peer?.pc) return;
    try {
      await peer.pc.setRemoteDescription(new RTCSessionDescription(answer));
    } catch (err) {
      console.error('[GDM Voice] answer işleme hatası:', err);
    }
  });

  // Gelen ICE candidate
  socket.on('gdm:call:ice', async ({ groupId, fromSocketId, candidate }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(fromSocketId);
    if (!peer?.pc) return;
    try {
      await peer.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.error('[GDM Voice] ICE candidate hatası:', err);
    }
  });

  // Peer mute/video durum güncellemesi
  socket.on('gdm:call:peer:state', ({ groupId, socketId, muted, video }) => {
    if (groupId !== _gdmCallGroupId) return;
    const peer = _gdmCallPeers.get(socketId);
    if (!peer) return;
    peer.muted = muted;
    peer.video = video;

    // Mini bar güncelle
    const dot = document.querySelector(`[data-gdm-peer="${socketId}"]`);
    if (dot) dot.style.opacity = muted ? '0.5' : '1';

    // Modal tile güncelle
    const muteIcon = document.querySelector(`[data-gdm-tile="${socketId}"] .gdm-peer-mute-icon`);
    if (muteIcon) muteIcon.style.display = muted ? 'inline' : 'none';
  });
}

export {
  bindGroupDmSocketEvents,
  joinGdmCall,
  leaveGdmCall,
  openGdmCallModal,
  startGdmCall,
};

