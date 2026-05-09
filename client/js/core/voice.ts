export {};
// core/voice.js (Go Live ekran paylaÅŸÄ±mÄ±)

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// VOICE KONTROLLERI
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function toggleMute() {
  const muted = !rtc.muted;
  rtc.setMuted(muted);
  document.getElementById('vc-mute')?.classList.toggle('active', muted);
  document.getElementById('btn-mute')?.classList.toggle('active', muted);
  const muteIcon = muted ? 'ğŸ”‡' : 'ğŸ™ï¸';
  const el1 = document.getElementById('vc-mute');
  const el2 = document.getElementById('btn-mute');
  const el3 = document.getElementById('ss-mute-btn');
  if (el1) el1.textContent = muteIcon;
  if (el2) el2.textContent = muteIcon;
  if (el3) el3.textContent = muteIcon;
  if (el3) el3.classList.toggle('active', muted);
}

function toggleDeafen() {
  rtc.setDeafened(!rtc.deafened);
  document.getElementById('btn-deafen')?.classList.toggle('active', rtc.deafened);
  document.getElementById('vc-deafen')?.classList.toggle('active', rtc.deafened);
  document.getElementById('ss-deafen-btn')?.classList.toggle('active', rtc.deafened);
}

async function toggleVideo() {
  const btn = document.getElementById('vc-video');
  if (rtc.videoOn) {
    await rtc.enableVideo(false);
    if (btn) { btn.classList.remove('active'); btn.textContent = 'ğŸ“·'; }
    sfuRemoveVideoTile('local');
  } else {
    const ok = await rtc.enableVideo(true);
    if (ok !== false) {
      if (btn) { btn.classList.add('active'); btn.textContent = 'ğŸ“¸'; }
      // Kendi video akÄ±ÅŸÄ±nÄ± grid'e ekle
      const localStream = rtc.getLocalStream();
      if (localStream) sfuAddVideoTile('local', localStream, currentUser?.displayName || 'Ben', true);
    }
  }
}

// â”€â”€ v69: SFU Video Grid â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Ses kanalÄ±ndaki kamera / ekran paylaÅŸÄ±m tile'larÄ±nÄ± yÃ¶netir.

const _sfuVideoTiles = new Map(); // tileId â†’ <div>

function sfuAddVideoTile(tileId, stream, label, isLocal = false, isScreen = false) {
  const grid = document.getElementById('sfu-video-grid');
  if (!grid) return;

  // Zaten varsa stream'i gÃ¼ncelle
  if (_sfuVideoTiles.has(tileId)) {
    const existingVideo = _sfuVideoTiles.get(tileId)?.querySelector('video');
    if (existingVideo) { existingVideo.srcObject = stream; return; }
  }

  const tile = document.createElement('div');
  tile.className = `sfu-tile${isScreen ? ' sfu-tile-screen' : ''}`;
  tile.dataset.tileId = tileId;

  const video = document.createElement('video');
  video.srcObject   = stream;
  video.autoplay    = true;
  video.playsInline = true;
  video.muted       = isLocal; // kendi sesi echo yapar
  if (isScreen) video.controls = false;

  const nameTag = document.createElement('div');
  nameTag.className   = 'sfu-tile-name';
  nameTag.textContent = (isLocal ? 'ğŸ“¹ ' : '') + (isScreen ? 'ğŸ–¥ï¸ ' : '') + (label || '');

  tile.append(video, nameTag);
  _sfuVideoTiles.set(tileId, tile);
  grid.appendChild(tile);

  // Grid'i gÃ¶ster
  grid.style.display = '';
  _sfuUpdateGridLayout();
}

function sfuRemoveVideoTile(tileId) {
  const tile = _sfuVideoTiles.get(tileId);
  if (tile) { tile.remove(); _sfuVideoTiles.delete(tileId); }
  if (_sfuVideoTiles.size === 0) {
    const grid = document.getElementById('sfu-video-grid');
    if (grid) grid.style.display = 'none';
  } else {
    _sfuUpdateGridLayout();
  }
}

function _sfuUpdateGridLayout() {
  const grid  = document.getElementById('sfu-video-grid');
  if (!grid) return;
  const n = _sfuVideoTiles.size;
  // 1 tile â†’ full; 2 â†’ 2 col; 3-4 â†’ 2x2; 5+ â†’ 3 col
  const cols = n <= 1 ? 1 : n <= 2 ? 2 : n <= 4 ? 2 : 3;
  grid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
}

// SFU new-producer: peer video/screen tile ekle
function sfuHandleNewProducer(socketId, userId, stream, kind) {
  const peerEl = document.querySelector(`[data-socket-id="${socketId}"]`);
  const label  = peerEl?.querySelector('.vp-name')?.textContent || userId || 'KullanÄ±cÄ±';
  const isScreen = kind === 'screen';
  sfuAddVideoTile(`${socketId}-${kind}`, stream, label, false, isScreen);
}

// SFU peer left: peer video tile kaldÄ±r
function sfuHandlePeerLeft(socketId) {
  sfuRemoveVideoTile(`${socketId}-video`);
  sfuRemoveVideoTile(`${socketId}-screen`);
}

// webrtc-sfu.js peerStreams gÃ¼ncellenince burasÄ± Ã§aÄŸrÄ±lÄ±r
window.bridgeApp = window.bridgeApp || {};
const _origUpdatePeerState = window.bridgeApp.updatePeerState;
window.bridgeApp.updatePeerState = function(socketId, state) {
  _origUpdatePeerState?.call(window.bridgeApp, socketId, state);
  // Kamera kapandÄ±ysa tile sil
  if (state.video === false) sfuRemoveVideoTile(`${socketId}-video`);
  if (state.screensharing === false) sfuRemoveVideoTile(`${socketId}-screen`);
};

// Video tile: peer stream hazÄ±r olunca
const _origRenderVoicePeer = window.bridgeApp.renderVoicePeer;
window.bridgeApp.renderVoicePeer = function(peer, existing) {
  _origRenderVoicePeer?.call(window.bridgeApp, peer, existing);
};

// Temizlik: ses kanalÄ±ndan Ã§Ä±kÄ±nca tÃ¼m tile'larÄ± sil
function sfuClearAllVideoTiles() {
  for (const [id] of _sfuVideoTiles) sfuRemoveVideoTile(id);
}


// Ses kanalÄ± butonundan doÄŸrudan paylaÅŸÄ±m baÅŸlat
async function toggleScreenShare() {
  const btn = document.getElementById('vc-screen');
  if (rtc.screenSharing) {
    stopMyScreenShare();
    if (btn) btn.classList.remove('active');
  } else {
    openScreenShareQualityPicker();
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SCREEN SHARE â€” KALÄ°TE SEÃ‡Ä°CÄ° + BAÅLATMA
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

/**
 * Settings'deki varsayÄ±lan preset'e gÃ¶re doÄŸrudan baÅŸlatÄ±r ya da seÃ§iciyi aÃ§ar.
 */
function openScreenShareQualityPicker() {
  try {
    const prefs  = JSON.parse(localStorage.getItem('bridgeSSQuality') || '{}');
    const preset = prefs.preset || 'ask';
    if (preset !== 'ask') {
      // KullanÄ±cÄ±nÄ±n kaydettiÄŸi preset ile doÄŸrudan baÅŸlat â€” seÃ§ici aÃ§ma
      startScreenShareWithQuality(preset);
      return;
    }
  } catch (_) {}
  document.getElementById('ss-quality-modal').style.display = 'flex';
}

async function startScreenShareWithQuality(quality) {
  document.getElementById('ss-quality-modal').style.display = 'none';

  // "VarsayÄ±lan olarak kaydet" iÅŸaretliyse settings'e yaz
  const saveAsDefault = document.getElementById('ss-save-as-default')?.checked;
  if (saveAsDefault) {
    try {
      const prefs = JSON.parse(localStorage.getItem('bridgeSSQuality') || '{}');
      prefs.preset = quality;
      localStorage.setItem('bridgeSSQuality', JSON.stringify(prefs));
      toast(`VarsayÄ±lan kalite kaydedildi: ${_qualityLabel(quality)}`, 'info');
    } catch (_) {}
  }

  const includeAudio = document.getElementById('ss-include-audio')?.checked !== false;

  // Ses kanalÄ±nda deÄŸilsek Ã¶nce ses kanalÄ±nÄ± aÃ§
  if (!rtc.isInVoice()) {
    toast('Ã–nce bir ses kanalÄ±na gir', 'error');
    return;
  }

  // Loading gÃ¶ster
  const loadingEl = document.getElementById('ss-loading');
  if (loadingEl) loadingEl.style.display = 'flex';
  openScreenShareView();

  const ok = await rtc.startScreenShare(quality, includeAudio);
  if (loadingEl) loadingEl.style.display = 'none';

  if (ok) {
    // UI gÃ¼ncelle
    document.getElementById('vc-screen')?.classList.add('active');
    document.getElementById('ss-stop-btn').style.display = '';
    document.getElementById('ss-share-btn').style.display = 'none';
    document.getElementById('ss-local-badge').style.display = 'flex';
    document.getElementById('ss-quality-label').textContent = _qualityLabel(quality);

    // Kendi ekranÄ±mÄ± video elementine baÄŸla
    const localVideo = document.getElementById('remote-screen-video');
    if (localVideo && rtc.screenStream) {
      localVideo.srcObject = rtc.screenStream;
      localVideo.muted = true; // kendi sesini geri yÃ¼kleme
    }

    // Settings'deki bitrate override'Ä±nÄ± uygula
    try {
      const ssPrefs = JSON.parse(localStorage.getItem('bridgeSSQuality') || '{}');
      if (ssPrefs.bitrateKbps > 0) {
        const _bpsFpsMap = {
          '4k60': 60, '1440p60': 60, '1440p': 30, '1080p60': 60, '1080p': 30, '720p': 30, 'hd': 30,
        };
        const overrideBps = ssPrefs.bitrateKbps * 1000;
        const fps = _bpsFpsMap[quality] || 30;
        for (const pc of rtc.peers.values()) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (!sender) continue;
          const params = sender.getParameters();
          if (!params.encodings?.length) params.encodings = [{}];
          params.encodings[0].maxBitrate   = overrideBps;
          params.encodings[0].maxFramerate = fps;
          sender.setParameters(params).catch(e => console.warn('[SS override]', e));
        }
      }
    } catch (_) {}

    toast(`Ekran paylaÅŸÄ±mÄ± baÅŸladÄ± â€” ${_qualityLabel(quality)} ğŸ–¥ï¸`, 'success');
    if (typeof _onScreenShareStarted === 'function') _onScreenShareStarted();
  } else {
    closeScreenShareView();
  }
}

function _qualityLabel(q) {
  return { '4k60': '4K 60fps', '1440p60': '1440p 60fps', '1440p': '1440p 30fps', '1080p60': '1080p 60fps', '1080p': '1080p 30fps', '720p': '720p 30fps', 'hd': 'HD' }[q] || q;
}

function stopMyScreenShare() {
  if (typeof _onScreenShareStopped === 'function') _onScreenShareStopped();
  rtc.stopScreenShare();
  document.getElementById('vc-screen')?.classList.remove('active');
  document.getElementById('ss-stop-btn').style.display = 'none';
  document.getElementById('ss-share-btn').style.display = '';
  document.getElementById('ss-local-badge').style.display = 'none';

  // Videoyu temizle
  const v = document.getElementById('remote-screen-video');
  if (v) v.srcObject = null;

  // BaÅŸka biri paylaÅŸmÄ±yorsa kapat
  if (!_hasRemoteScreenShare()) closeScreenShareView();

  toast('Ekran paylaÅŸÄ±mÄ± durduruldu', 'success');
}

function _hasRemoteScreenShare() {
  const v = document.getElementById('remote-screen-video');
  return v?.srcObject && v.srcObject.active;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SCREEN SHARE VIEW â€” AÃ‡ / KAPAT / KONTROLLER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function openScreenShareView() {
  const view = document.getElementById('screen-share-view');
  view.style.display = 'flex';
  // Kanal adÄ±nÄ± gÃ¼ncelle
  const chName = document.getElementById('ss-channel-name');
  if (chName && currentChannel) chName.textContent = currentChannel.name || 'Ses KanalÄ±';
}

function closeScreenShareView() {
  document.getElementById('screen-share-view').style.display = 'none';
}

function toggleSSFullscreen() {
  const wrap = document.getElementById('ss-video-wrap');
  if (!document.fullscreenElement) {
    wrap.requestFullscreen?.().catch(() => {});
    document.getElementById('ss-fullscreen-btn').textContent = 'âŠ ';
  } else {
    document.exitFullscreen?.();
    document.getElementById('ss-fullscreen-btn').textContent = 'â›¶';
  }
}

let _ssMiniMode = false;
function toggleSSMiniMode() {
  _ssMiniMode = !_ssMiniMode;
  const view = document.getElementById('screen-share-view');
  view.classList.toggle('ss-mini', _ssMiniMode);
}

// Fullscreen deÄŸiÅŸince ikonu gÃ¼ncelle
document.addEventListener('fullscreenchange', () => {
  const btn = document.getElementById('ss-fullscreen-btn');
  if (btn) btn.textContent = document.fullscreenElement ? 'âŠ ' : 'â›¶';
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// LEAVE VOICE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function leaveVoice() {
  // Voice E2E session temizle
  window.BridgeVoiceE2E?.clearSession();
  document.getElementById("voice-e2e-badge")?.remove();
//   tÃ¼m video tile'larÄ±nÄ± temizle
  sfuClearAllVideoTiles();
  rtc.leaveVoice();
  voiceChannelPeers.clear();
  document.getElementById('text-view').style.display = 'flex';
  document.getElementById('voice-view').style.display = 'none';
  document.getElementById('voice-peers').innerHTML = '';
  document.getElementById('vc-video')?.classList.remove('active');
  document.getElementById('vc-screen')?.classList.remove('active');
  document.getElementById('ss-stop-btn').style.display = 'none';
  document.getElementById('ss-share-btn').style.display = '';
  document.getElementById('ss-local-badge').style.display = 'none';
  closeScreenShareView();
  const firstText = document.querySelector('.ch-item[data-type="text"]');
  if (firstText) firstText.click();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// VOICE PEER RENDERING
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function renderVoicePeer(peer, isLocal = false) {
  const container = document.getElementById('voice-peers');
  const id = isLocal ? 'local' : peer.socketId;
  if (document.getElementById(`vp-${id}`)) return;
  const el = document.createElement('div');
  el.className = 'voice-peer' + (isLocal ? ' local' : '');
  el.id = `vp-${id}`;
  el.dataset.socket = peer.socketId || 'local';
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

function attachLocalVideo() {
  const stream = rtc?.getLocalStream();
  if (!stream || !stream.getVideoTracks().length) return;
  const wrap = document.getElementById('vpw-local');
  if (!wrap) return;
  let video = wrap.querySelector('video');
  if (!video) {
    video = document.createElement('video');
    video.autoplay = true; video.muted = true; video.playsInline = true;
    wrap.appendChild(video);
  }
  video.srcObject = stream;
}

function attachRemoteStream(socketId, stream) {
  const wrap = document.getElementById(`vpw-${socketId}`);
  if (wrap) {
    let video = wrap.querySelector('video');
    if (!video) {
      video = document.createElement('video');
      video.autoplay = true; video.playsInline = true;
      video.className = 'remote-audio';
      wrap.appendChild(video);
    }
    video.srcObject = stream;
  }

  // Ekran paylaÅŸÄ±mÄ± track'i var mÄ± kontrol et
  const hasScreen = stream.getVideoTracks().some(t =>
    t.label.toLowerCase().includes('screen') ||
    t.label.toLowerCase().includes('window') ||
    t.label.toLowerCase().includes('tab') ||
    t.contentHint === 'detail'
  );

  if (hasScreen) {
    const mainVideo = document.getElementById('remote-screen-video');
    mainVideo.srcObject = stream;
    // Kim paylaÅŸÄ±yor?
    const peer = [...voiceChannelPeers.values()].find(p => p.socketId === socketId);
    const sharerEl = document.getElementById('ss-sharer-name');
    if (sharerEl && peer) sharerEl.textContent = `â€” ${peer.displayName} paylaÅŸÄ±yor`;
    openScreenShareView();
    document.getElementById('ss-stop-btn').style.display = 'none';
    document.getElementById('ss-share-btn').style.display = '';
    // Thumbnail ekle
    _addScreenThumbnail(socketId, stream, peer?.displayName || 'KullanÄ±cÄ±');
  }
}

function _addScreenThumbnail(socketId, stream, name) {
  const strip = document.getElementById('ss-thumbnails');
  if (!strip) return;
  let thumb = document.getElementById(`ss-thumb-${socketId}`);
  if (!thumb) {
    thumb = document.createElement('div');
    thumb.id = `ss-thumb-${socketId}`;
    thumb.className = 'ss-thumb';
    const v = document.createElement('video');
    v.autoplay = true; v.playsInline = true; v.muted = true;
    v.srcObject = stream;
    const label = document.createElement('div');
    label.className = 'ss-thumb-label';
    label.textContent = name;
    thumb.appendChild(v);
    thumb.appendChild(label);
    thumb.addEventListener('click', () => {
      // Bu streami ana ekrana taÅŸÄ±
      document.getElementById('remote-screen-video').srcObject = stream;
      document.getElementById('ss-sharer-name').textContent = `â€” ${name} paylaÅŸÄ±yor`;
    });
    strip.appendChild(thumb);
    strip.style.display = 'flex';
  }
}

function removeVoicePeer(socketId) {
  document.getElementById(`vp-${socketId}`)?.remove();
  // Thumbnail da sil
  const thumb = document.getElementById(`ss-thumb-${socketId}`);
  if (thumb) {
    thumb.remove();
    const strip = document.getElementById('ss-thumbnails');
    if (strip && !strip.children.length) strip.style.display = 'none';
  }
  // EÄŸer bu kiÅŸi ekran paylaÅŸÄ±yorduysa ve baÅŸkasÄ± yoksa kapat
  const mainVideo = document.getElementById('remote-screen-video');
  if (mainVideo?.srcObject) {
    const tracks = mainVideo.srcObject.getTracks();
    const allEnded = tracks.every(t => t.readyState === 'ended');
    if (allEnded && !rtc.screenSharing) closeScreenShareView();
  }
}

function updatePeerState(socketId, state) {
  const icons = document.getElementById(`vpi-${socketId}`);
  if (!icons) return;
  icons.innerHTML =
    (state.muted ? 'ğŸ”‡ ' : '') +
    (state.screensharing ? '<span class="peer-sharing-badge">ğŸ–¥ï¸ PaylaÅŸÄ±yor</span> ' : '') +
    (state.video ? 'ğŸ“·' : '');
  document.getElementById(`vpw-${socketId}`)?.classList.toggle('speaking', !state.muted);

  // PaylaÅŸÄ±m durdu mu?
  if (!state.screensharing) {
    const thumb = document.getElementById(`ss-thumb-${socketId}`);
    if (thumb) { thumb.remove(); }
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// REPLY & PIN
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function startReply(msgId, displayName) {
  replyingTo = msgId;
  let bar = document.getElementById('reply-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'reply-bar';
    bar.className = 'reply-bar-active';
    document.getElementById('msg-input-wrap').prepend(bar);
  }
  bar.innerHTML = `<span>â†©ï¸ Replying to <strong>${escHtml(displayName)}</strong></span><button onclick="cancelReply()">âœ•</button>`;
  document.getElementById('msg-input').focus();
}

function cancelReply() { replyingTo = null; document.getElementById('reply-bar')?.remove(); }
function pinMessage(msgId, channelId) { socket.emit('message:pin', { messageId: msgId, channelId, serverId: currentServer._id }); }

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SCHEDULE SEND
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// BRIDGE PTT â€” Push-to-Talk
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

const BridgePTT = (() => {
  const STORAGE_KEY = 'bridgePTT';

  // â”€â”€ State â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _enabled      = false;
  let _mode         = 'hold';      // 'hold' | 'toggle'
  let _key          = null;        // { code, label }  Ã¶rn: { code:'Space', label:'Space' }
  let _releaseDelay = 200;         // ms
  let _active       = false;       // ÅŸu an mikrofon PTT tarafÄ±ndan aÃ§Ä±k mÄ±
  let _releaseTimer = null;
  let _capturing    = false;       // tuÅŸ kayÄ±t modunda mÄ±

  // â”€â”€ Persist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _load() {
    try {
      const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      _enabled      = d.enabled      ?? false;
      _mode         = d.mode         ?? 'hold';
      _key          = d.key          ?? null;
      _releaseDelay = d.releaseDelay ?? 200;
    } catch (_) {}
  }

  function _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        enabled: _enabled, mode: _mode, key: _key, releaseDelay: _releaseDelay,
      }));
    } catch (_) {}
  }

  // â”€â”€ Mic helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _unmute() {
    if (!window.rtc?.isInVoice()) return;
    rtc.setMuted(false);
    document.getElementById('vc-mute')?.classList.remove('active');
    document.getElementById('btn-mute')?.classList.remove('active');
    ['vc-mute','btn-mute','ss-mute-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = 'ğŸ™ï¸';
    });
    _active = true;
    _pttLiveIndicator(true);
  }

  function _mute() {
    if (!window.rtc?.isInVoice()) return;
    rtc.setMuted(true);
    document.getElementById('vc-mute')?.classList.add('active');
    document.getElementById('btn-mute')?.classList.add('active');
    ['vc-mute','btn-mute','ss-mute-btn'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.textContent = 'ğŸ”‡';
    });
    _active = false;
    _pttLiveIndicator(false);
  }

  function _pttLiveIndicator(on) {
    const el = document.getElementById('ptt-live-status');
    if (!el) return;
    if (!_enabled) { el.textContent = 'Devre dÄ±ÅŸÄ±'; el.style.color = ''; return; }
    if (on) { el.textContent = 'ğŸ”´ YayÄ±nda â€” mikrofon aÃ§Ä±k'; el.style.color = 'var(--green,#43b581)'; }
    else    { el.textContent = `â¸ Beklemede (${_key?.label ?? 'â€”'})`; el.style.color = ''; }
  }

  // â”€â”€ Key event handlers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _onKeyDown(e) {
    if (!_enabled || !_key || e.code !== _key.code) return;
    // YazÄ± alanÄ±nda PTT'yi tetikleme
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;

    e.preventDefault();

    if (_mode === 'hold') {
      if (_active) return;
      clearTimeout(_releaseTimer);
      _unmute();
    } else {
      // toggle
      if (_active) _scheduleRelease(0);
      else _unmute();
    }
  }

  function _onKeyUp(e) {
    if (!_enabled || !_key || _mode !== 'hold') return;
    if (e.code !== _key.code) return;
    e.preventDefault();
    _scheduleRelease(_releaseDelay);
  }

  function _scheduleRelease(delay) {
    clearTimeout(_releaseTimer);
    if (delay <= 0) { _mute(); return; }
    _releaseTimer = setTimeout(_mute, delay);
  }

  // â”€â”€ Key capture â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _captureHandler(e) {
    e.preventDefault();
    e.stopPropagation();

    // Escape = iptal
    if (e.code === 'Escape') {
      _stopCapture();
      return;
    }

    const label = _buildLabel(e);
    _key = { code: e.code, label };
    _save();
    _stopCapture();
    _pttUiSync();
  }

  function _buildLabel(e) {
    const parts = [];
    if (e.ctrlKey  && e.code !== 'ControlLeft'  && e.code !== 'ControlRight')  parts.push('Ctrl');
    if (e.altKey   && e.code !== 'AltLeft'       && e.code !== 'AltRight')      parts.push('Alt');
    if (e.shiftKey && e.code !== 'ShiftLeft'     && e.code !== 'ShiftRight')    parts.push('Shift');
    if (e.metaKey  && e.code !== 'MetaLeft'      && e.code !== 'MetaRight')     parts.push('Meta');

    // Modifier-only tuÅŸ â†’ sadece tuÅŸun kendisi
    const modCodes = ['ControlLeft','ControlRight','AltLeft','AltRight','ShiftLeft','ShiftRight','MetaLeft','MetaRight'];
    if (!modCodes.includes(e.code)) {
      parts.push(e.key === ' ' ? 'Space' : (e.key?.length === 1 ? e.key.toUpperCase() : e.key));
    }
    return parts.join('+') || e.code;
  }

  function _stopCapture() {
    document.removeEventListener('keydown', _captureHandler, true);
    _capturing = false;
    const btn = document.getElementById('ptt-record-btn');
    if (btn) btn.textContent = 'ğŸ”´ TuÅŸu Kaydet';
  }

  // â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function setEnabled(on) {
    _enabled = on;
    if (!on && _active) _mute();
    _save();
    _pttUiSync();
  }

  function setMode(m) {
    _mode = m;
    if (_active && m === 'hold') _mute(); // hold moduna geÃ§ilince aktifse kapat
    _save();
  }

  function setReleaseDelay(ms) {
    _releaseDelay = ms;
    _save();
  }

  function startKeyCapture() {
    if (_capturing) return;
    _capturing = true;
    const btn = document.getElementById('ptt-record-btn');
    if (btn) btn.textContent = 'â³ TuÅŸa basâ€¦ (Esc = iptal)';
    document.addEventListener('keydown', _captureHandler, true);
  }

  function clearKey() {
    _key = null;
    if (_active) _mute();
    _save();
    _pttUiSync();
  }

  function getStatus() {
    return { enabled: _enabled, mode: _mode, key: _key, releaseDelay: _releaseDelay, active: _active };
  }

  // â”€â”€ Init â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function init() {
    _load();
    document.addEventListener('keydown', _onKeyDown);
    document.addEventListener('keyup',   _onKeyUp);
  }

  return { init, setEnabled, setMode, setReleaseDelay, startKeyCapture, clearKey, getStatus };
})();

// Uygulama yÃ¼klenince baÅŸlat
document.addEventListener('DOMContentLoaded', () => BridgePTT.init());
// Socket baÄŸlantÄ±sÄ± kurulunca da baÅŸlat (SPA akÄ±ÅŸÄ± iÃ§in)
document.addEventListener('bridge:socket-ready', () => BridgePTT.init());

