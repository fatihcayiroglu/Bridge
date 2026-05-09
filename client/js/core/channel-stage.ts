export {};
// client/js/core/channel-stage.js.1
// Stage kanal UI â€” channel-permissions.js refactor'undan ayrÄ±ldÄ± (v51'den aynen)


// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// STAGE CHANNEL â€” deÄŸiÅŸtirilmedi (v51'den aynen)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

let _stageChannel     = null;
let _stageRole        = null;
let _stageSpeakers    = [];
let _stageListeners   = [];
let _stageHandRaised  = false;

function loadStageChannel(channel) {
  _stageChannel = channel;
  _stageRole    = null;
  _stageSpeakers = [];
  _stageListeners = [];
  _stageHandRaised = false;

  const mainArea = document.getElementById('messages-area');
  if (!mainArea) return;

  mainArea.style.display = 'block';
  mainArea.innerHTML = `
    <div id="stage-view" style="
      display:flex;flex-direction:column;height:100%;
      background:linear-gradient(180deg,#1e1f26 0%,#13141a 100%);
      padding:24px;box-sizing:border-box;overflow:auto">

      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:2rem;margin-bottom:8px">ğŸ­</div>
        <h2 id="stage-title" style="font-size:1.4rem;font-weight:700;color:#fff;margin:0">${escHtml(channel.name)}</h2>
        <div id="stage-topic" style="font-size:13px;color:var(--text-muted);margin-top:4px">${escHtml(channel.topic || 'Stage kanalÄ± â€” dinleyici olarak katÄ±l veya konuÅŸmak iÃ§in el kaldÄ±r')}</div>
        <div id="stage-live-badge" style="display:none;margin-top:8px">
          <span style="background:var(--danger,#ed4245);color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:.05em">â— CANLI</span>
        </div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:12px">
          ğŸ¤ KonuÅŸmacÄ±lar <span id="stage-speaker-count" style="color:var(--brand)">(0)</span>
        </div>
        <div id="stage-speakers" style="display:flex;flex-wrap:wrap;gap:16px;min-height:80px;
          background:rgba(255,255,255,.03);border-radius:12px;padding:16px;
          border:1px solid rgba(255,255,255,.06)">
          <div style="color:var(--text-muted);font-size:13px;align-self:center">HenÃ¼z konuÅŸmacÄ± yok</div>
        </div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:12px">
          ğŸ‘‚ Dinleyiciler <span id="stage-listener-count" style="color:var(--text-muted)">(0)</span>
        </div>
        <div id="stage-listeners" style="display:flex;flex-wrap:wrap;gap:8px;min-height:40px"></div>
      </div>

      <div id="stage-controls" style="
        margin-top:auto;padding:16px;
        background:rgba(0,0,0,.3);border-radius:12px;
        display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap">

        <div id="stage-join-btns">
          <button class="btn btn-primary" style="gap:8px;font-size:14px" onclick="joinStageAs('listener')">
            ğŸ‘‚ Dinleyici Olarak KatÄ±l
          </button>
          <button class="btn" style="gap:8px;font-size:14px;margin-left:8px" onclick="joinStageAs('speaker')">
            ğŸ¤ KonuÅŸmacÄ± Olarak KatÄ±l
          </button>
        </div>

        <div id="stage-speaker-controls" style="display:none;gap:10px;align-items:center">
          <button id="stage-mute-btn" class="btn" style="gap:6px;font-size:13px" onclick="toggleStageMute()">ğŸ¤ Mikrofon AÃ§</button>
          <button class="btn btn-danger" style="gap:6px;font-size:13px" onclick="leaveStage()">ğŸ“´ AyrÄ±l</button>
        </div>

        <div id="stage-listener-controls" style="display:none;gap:10px;align-items:center">
          <button id="stage-hand-btn" class="btn" style="gap:6px;font-size:13px" onclick="toggleStageHand()">âœ‹ El KaldÄ±r</button>
          <button class="btn btn-danger" style="gap:6px;font-size:13px" onclick="leaveStage()">ğŸšª AyrÄ±l</button>
        </div>
      </div>
    </div>`;

  socket.emit('stage:join', { channelId: channel._id, serverId: currentServer._id });
}

function _renderStageUser(user, isSpeaker) {
  const isMuted = user.muted !== false;
  const uid     = user.userId || user.id || '';
  const isMe    = uid === me?.id;
  const isMod   = _stageChannel && (currentServer?.ownerId === me?.id ||
                  currentServer?.roles?.some(r => r.permissions?.includes('MANAGE_CHANNELS') &&
                  currentServer?.members?.find(m => m.userId === me?.id)?.roles?.includes(r._id)));

  const promoteBtn = (!isSpeaker && isMod && user.handRaised)
    ? `<button onclick="stagePromoteUser('${escHtml(uid)}')"
         title="KonuÅŸmacÄ± yap"
         style="position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);
         background:var(--brand,#5865f2);color:#fff;border:none;border-radius:10px;
         font-size:9px;padding:1px 5px;cursor:pointer;white-space:nowrap">â–² Davet</button>`
    : '';

  return `
    <div class="stage-user" data-uid="${escHtml(uid)}" style="
      display:flex;flex-direction:column;align-items:center;gap:6px;
      position:relative;${isSpeaker ? 'min-width:72px' : ''}">
      <div style="position:relative">
        <div style="
          width:${isSpeaker ? 56 : 36}px;height:${isSpeaker ? 56 : 36}px;
          border-radius:50%;background:${cssColor(user.avatarColor)};
          display:flex;align-items:center;justify-content:center;
          font-size:${isSpeaker ? '1.4rem' : '0.9rem'};font-weight:700;color:#fff;
          border:2px solid ${user.speaking ? 'var(--online,#23a55a)' : (isMuted && isSpeaker ? 'var(--danger,#ed4245)' : 'transparent')};
          transition:border-color .2s;cursor:${isMe ? 'default' : 'pointer'}"
          ${!isMe && isSpeaker && isMod ? `onclick="stageKickSpeaker('${escHtml(uid)}')"` : ''}>
          ${initials(user.displayName)}
        </div>
        ${isSpeaker ? `<div style="position:absolute;bottom:-2px;right:-2px;
          background:${isMuted ? 'var(--danger,#ed4245)' : 'var(--online,#23a55a)'};
          border-radius:50%;width:18px;height:18px;
          display:flex;align-items:center;justify-content:center;
          font-size:10px;border:2px solid #13141a">
          ${isMuted ? 'ğŸ”‡' : 'ğŸ¤'}</div>` : ''}
        ${user.handRaised ? `<div style="position:absolute;top:-4px;right:-4px;font-size:14px;animation:stageHandPulse 1s infinite">âœ‹</div>` : ''}
        ${promoteBtn}
      </div>
      <div style="font-size:11px;color:${isSpeaker ? '#dcddde' : 'var(--text-muted)'};text-align:center;
        max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${escHtml(user.displayName)}${isMe ? ' (sen)' : ''}
      </div>
    </div>`;
}

function stagePromoteUser(targetUserId) {
  if (!_stageChannel) return;
  socket.emit('stage:promote', { channelId: _stageChannel._id, targetUserId });
}

function stageKickSpeaker(targetUserId) {
  if (!_stageChannel) return;
  if (!confirm('Bu konuÅŸmacÄ±yÄ± dinleyiciye al?')) return;
  socket.emit('stage:demote', { channelId: _stageChannel._id, targetUserId });
}

function _refreshStageUI() {
  const speakersEl  = document.getElementById('stage-speakers');
  const listenersEl = document.getElementById('stage-listeners');
  if (!speakersEl) return;

  speakersEl.innerHTML  = _stageSpeakers.length
    ? _stageSpeakers.map(u => _renderStageUser(u, true)).join('')
    : '<div style="color:var(--text-muted);font-size:13px;align-self:center">HenÃ¼z konuÅŸmacÄ± yok</div>';

  listenersEl.innerHTML = _stageListeners.length
    ? _stageListeners.map(u => _renderStageUser(u, false)).join('')
    : '<div style="color:var(--text-muted);font-size:12px">HenÃ¼z dinleyici yok</div>';

  const sc = document.getElementById('stage-speaker-count');
  const lc = document.getElementById('stage-listener-count');
  if (sc) sc.textContent = `(${_stageSpeakers.length})`;
  if (lc) lc.textContent = `(${_stageListeners.length})`;

  const liveBadge = document.getElementById('stage-live-badge');
  if (liveBadge) liveBadge.style.display = _stageSpeakers.length ? '' : 'none';
}

async function joinStageAs(role) {
  if (!_stageChannel) return;
  _stageRole = role;

  document.getElementById('stage-join-btns').style.display        = 'none';
  document.getElementById('stage-speaker-controls').style.display  = role === 'speaker' ? 'flex' : 'none';
  document.getElementById('stage-listener-controls').style.display = role === 'listener' ? 'flex' : 'none';

  socket.emit('stage:setRole', {
    channelId:   _stageChannel._id,
    serverId:    currentServer._id,
    role,
    displayName: me.displayName,
    avatarColor: me.avatarColor,
    userId:      me.id,
  });

  if (role === 'speaker') {
    try { await rtc.joinVoice(_stageChannel._id, currentServer._id); } catch { /* sessiz */ }
    const muteBtn = document.getElementById('stage-mute-btn');
    if (muteBtn) muteBtn.textContent = 'ğŸ”‡ Mikrofon KapalÄ±';
    toast('Stage\'e konuÅŸmacÄ± olarak katÄ±ldÄ±n', 'success');
  } else {
    toast('Stage\'e dinleyici olarak katÄ±ldÄ±n', 'success');
  }
}

function toggleStageMute() {
  if (!rtc) return;
  const muted = rtc.toggleMute?.() ?? false;
  const btn = document.getElementById('stage-mute-btn');
  if (btn) btn.textContent = muted ? 'ğŸ”‡ Mikrofon KapalÄ±' : 'ğŸ¤ Mikrofon AÃ§Ä±k';
  socket.emit('stage:updateMute', { channelId: _stageChannel?._id, muted });
}

function toggleStageHand() {
  _stageHandRaised = !_stageHandRaised;
  const btn = document.getElementById('stage-hand-btn');
  if (btn) btn.textContent = _stageHandRaised ? 'âœ‹ El Ä°ndir' : 'âœ‹ El KaldÄ±r';
  if (btn) btn.style.background = _stageHandRaised ? 'var(--brand)' : '';
  socket.emit('stage:handRaise', { channelId: _stageChannel?._id, raised: _stageHandRaised });
  toast(_stageHandRaised ? 'El kaldÄ±rdÄ±n â€” konuÅŸmacÄ±lar gÃ¶recek' : 'Elini indirdin', 'info');
}

function leaveStage() {
  if (_stageChannel) {
    socket.emit('stage:leave', { channelId: _stageChannel._id });
    if (_stageRole === 'speaker') rtc.leaveVoice?.();
  }
  _stageChannel    = null;
  _stageRole       = null;
  _stageSpeakers   = [];
  _stageListeners  = [];
  _stageHandRaised = false;

  document.getElementById('stage-join-btns').style.display        = '';
  document.getElementById('stage-speaker-controls').style.display  = 'none';
  document.getElementById('stage-listener-controls').style.display = 'none';
  toast('Stage\'den ayrÄ±ldÄ±n', 'info');
}

function handleStageEvent(event, data) {
  if (!_stageChannel || data.channelId !== _stageChannel._id) return;
  switch (event) {
    case 'stage:state':
      _stageSpeakers  = data.speakers  || [];
      _stageListeners = data.listeners || [];
      _refreshStageUI();
      break;
    case 'stage:userJoined':
      if (data.role === 'speaker') _stageSpeakers.push(data.user);
      else _stageListeners.push(data.user);
      _refreshStageUI();
      break;
    case 'stage:userLeft':
      _stageSpeakers  = _stageSpeakers.filter(u  => u.userId !== data.userId);
      _stageListeners = _stageListeners.filter(u => u.userId !== data.userId);
      _refreshStageUI();
      break;
    case 'stage:handRaise': {
      const all = [..._stageSpeakers, ..._stageListeners];
      const u = all.find(x => x.userId === data.userId);
      if (u) {
        u.handRaised = data.raised;
        _refreshStageUI();
        if (data.raised && data.userId !== me?.id && currentServer?.ownerId === me?.id) {
          toast(`âœ‹ ${u.displayName} konuÅŸmak istiyor`, 'info');
        }
      }
      break;
    }
    case 'stage:muteUpdate': {
      const sp = _stageSpeakers.find(u => u.userId === data.userId);
      if (sp) { sp.muted = data.muted; _refreshStageUI(); }
      break;
    }
    case 'stage:demoted': {
      if (data.userId === me?.id) {
        _stageRole = 'listener';
        document.getElementById('stage-speaker-controls').style.display  = 'none';
        document.getElementById('stage-listener-controls').style.display = 'flex';
        toast('Dinleyici moduna alÄ±ndÄ±n', 'info');
        rtc.leaveVoice?.();
      }
      const si = _stageSpeakers.findIndex(u => u.userId === data.userId);
      if (si !== -1) {
        const [user] = _stageSpeakers.splice(si, 1);
        user.handRaised = false;
        _stageListeners.push(user);
        _refreshStageUI();
      }
      break;
    }
    case 'stage:promoted': {
      if (data.userId === me?.id) {
        _stageRole = 'speaker';
        document.getElementById('stage-listener-controls').style.display = 'none';
        document.getElementById('stage-speaker-controls').style.display  = 'flex';
        toast('KonuÅŸmacÄ± olarak yÃ¼kseltildin! ğŸ¤', 'success');
        rtc.joinVoice?.(_stageChannel._id, currentServer._id).catch(() => {});
      }
      const li = _stageListeners.findIndex(u => u.userId === data.userId);
      if (li !== -1) {
        const [user] = _stageListeners.splice(li, 1);
        user.muted = true;
        _stageSpeakers.push(user);
        _refreshStageUI();
      }
      break;
    }
  }
}

