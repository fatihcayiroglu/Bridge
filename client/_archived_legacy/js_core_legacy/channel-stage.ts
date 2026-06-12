// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ChannelStagePanel.svelte
//              client/js/core/channel-stage-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-stage.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Stage kanal UI — konuşmacı/dinleyici yönetimi

declare function escHtml(s: string): string;
declare function cssColor(c: string): string;
declare function initials(name: string): string;
declare function toast(msg: string, type?: string): void;
declare const socket: { emit(event: string, data: Record<string, unknown>): void };
declare const currentServer: { _id: string; ownerId?: string; roles?: unknown[]; members?: unknown[] } | null;
declare const me: { id: string; displayName: string; avatarColor: string } | null;
declare const rtc: {
  toggleMute?(): boolean;
  joinVoice?(channelId: string, serverId: string): Promise<void>;
  leaveVoice?(): void;
} | null;

// ── Tip tanımları ─────────────────────────────────────────────

interface StageUser {
  userId?: string;
  id?: string;
  displayName: string;
  avatarColor: string;
  muted?: boolean;
  speaking?: boolean;
  handRaised?: boolean;
}

interface Channel {
  _id: string;
  name: string;
  topic?: string;
}

type StageRole = 'speaker' | 'listener' | null;

// ── State ─────────────────────────────────────────────────────

let _stageChannel:    Channel | null = null;
let _stageRole:       StageRole = null;
let _stageSpeakers:   StageUser[] = [];
let _stageListeners:  StageUser[] = [];
let _stageHandRaised  = false;

// ── Load stage channel ────────────────────────────────────────

export function loadStageChannel(channel: Channel): void {
  _stageChannel    = channel;
  _stageRole       = null;
  _stageSpeakers   = [];
  _stageListeners  = [];
  _stageHandRaised = false;

  const mainArea = document.getElementById('messages-area');
  if (!mainArea) return;

  mainArea.style.display = 'block';
  mainArea.innerHTML = `
    <div id="stage-view" style="display:flex;flex-direction:column;height:100%;
      background:linear-gradient(180deg,#1e1f26 0%,#13141a 100%);
      padding:24px;box-sizing:border-box;overflow:auto">

      <div style="text-align:center;margin-bottom:24px">
        <div style="font-size:2rem;margin-bottom:8px">🎭</div>
        <h2 id="stage-title" style="font-size:1.4rem;font-weight:700;color:#fff;margin:0">${escHtml(channel.name)}</h2>
        <div id="stage-topic" style="font-size:13px;color:var(--text-muted);margin-top:4px">${escHtml(channel.topic ?? 'Stage kanalı — dinleyici olarak katıl veya konuşmak için el kaldır')}</div>
        <div id="stage-live-badge" style="display:none;margin-top:8px">
          <span style="background:var(--danger,#ed4245);color:#fff;font-size:11px;font-weight:700;padding:3px 10px;border-radius:999px;letter-spacing:.05em">● CANLI</span>
        </div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:12px">
          🎤 Konuşmacılar <span id="stage-speaker-count" style="color:var(--brand)">(0)</span>
        </div>
        <div id="stage-speakers" style="display:flex;flex-wrap:wrap;gap:16px;min-height:80px;
          background:rgba(255,255,255,.03);border-radius:12px;padding:16px;
          border:1px solid rgba(255,255,255,.06)">
          <div style="color:var(--text-muted);font-size:13px;align-self:center">Henüz konuşmacı yok</div>
        </div>
      </div>

      <div style="margin-bottom:24px">
        <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-muted);margin-bottom:12px">
          👂 Dinleyiciler <span id="stage-listener-count" style="color:var(--text-muted)">(0)</span>
        </div>
        <div id="stage-listeners" style="display:flex;flex-wrap:wrap;gap:8px;min-height:40px"></div>
      </div>

      <div id="stage-controls" style="margin-top:auto;padding:16px;
        background:rgba(0,0,0,.3);border-radius:12px;
        display:flex;align-items:center;justify-content:center;gap:12px;flex-wrap:wrap">

        <div id="stage-join-btns">
          <button class="btn btn-primary" style="gap:8px;font-size:14px" onclick="joinStageAs('listener')">
            👂 Dinleyici Olarak Katıl
          </button>
          <button class="btn" style="gap:8px;font-size:14px;margin-left:8px" onclick="joinStageAs('speaker')">
            🎤 Konuşmacı Olarak Katıl
          </button>
        </div>

        <div id="stage-speaker-controls" style="display:none;gap:10px;align-items:center">
          <button id="stage-mute-btn" class="btn" style="gap:6px;font-size:13px" onclick="toggleStageMute()">🎤 Mikrofon Aç</button>
          <button class="btn btn-danger" style="gap:6px;font-size:13px" onclick="leaveStage()">📴 Ayrıl</button>
        </div>

        <div id="stage-listener-controls" style="display:none;gap:10px;align-items:center">
          <button id="stage-hand-btn" class="btn" style="gap:6px;font-size:13px" onclick="toggleStageHand()">✋ El Kaldır</button>
          <button class="btn btn-danger" style="gap:6px;font-size:13px" onclick="leaveStage()">🚪 Ayrıl</button>
        </div>
      </div>
    </div>`;

  socket.emit('stage:join', { channelId: channel._id, serverId: currentServer!._id });
}

// ── Render ────────────────────────────────────────────────────

function _renderStageUser(user: StageUser, isSpeaker: boolean): string {
  const isMuted = user.muted !== false;
  const uid     = user.userId ?? user.id ?? '';
  const isMe    = uid === me?.id;
  const isMod   = _stageChannel != null && currentServer?.ownerId === me?.id;

  const promoteBtn = (!isSpeaker && isMod && user.handRaised)
    ? `<button onclick="stagePromoteUser('${escHtml(uid)}')"
         title="Konuşmacı yap"
         style="position:absolute;bottom:-4px;left:50%;transform:translateX(-50%);
         background:var(--brand,#2d9cdb);color:#fff;border:none;border-radius:10px;
         font-size:9px;padding:1px 5px;cursor:pointer;white-space:nowrap">▲ Davet</button>`
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
          ${isMuted ? '🔇' : '🎤'}</div>` : ''}
        ${user.handRaised ? `<div style="position:absolute;top:-4px;right:-4px;font-size:14px;animation:stageHandPulse 1s infinite">✋</div>` : ''}
        ${promoteBtn}
      </div>
      <div style="font-size:11px;color:${isSpeaker ? '#dcddde' : 'var(--text-muted)'};text-align:center;
        max-width:70px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
        ${escHtml(user.displayName)}${isMe ? ' (sen)' : ''}
      </div>
    </div>`;
}

function _refreshStageUI(): void {
  const speakersEl  = document.getElementById('stage-speakers');
  const listenersEl = document.getElementById('stage-listeners');
  if (!speakersEl) return;

  speakersEl.innerHTML  = _stageSpeakers.length
    ? _stageSpeakers.map(u => _renderStageUser(u, true)).join('')
    : '<div style="color:var(--text-muted);font-size:13px;align-self:center">Henüz konuşmacı yok</div>';

  if (listenersEl) {
    listenersEl.innerHTML = _stageListeners.length
      ? _stageListeners.map(u => _renderStageUser(u, false)).join('')
      : '<div style="color:var(--text-muted);font-size:12px">Henüz dinleyici yok</div>';
  }

  const sc = document.getElementById('stage-speaker-count');
  const lc = document.getElementById('stage-listener-count');
  if (sc) sc.textContent = `(${_stageSpeakers.length})`;
  if (lc) lc.textContent = `(${_stageListeners.length})`;

  const liveBadge = document.getElementById('stage-live-badge');
  if (liveBadge) liveBadge.style.display = _stageSpeakers.length ? '' : 'none';
}

// ── Eylemler ──────────────────────────────────────────────────

export async function joinStageAs(role: 'speaker' | 'listener'): Promise<void> {
  if (!_stageChannel) return;
  _stageRole = role;

  _setDisplay('stage-join-btns', 'none');
  _setDisplay('stage-speaker-controls', role === 'speaker' ? 'flex' : 'none');
  _setDisplay('stage-listener-controls', role === 'listener' ? 'flex' : 'none');

  socket.emit('stage:setRole', {
    channelId:   _stageChannel._id,
    serverId:    currentServer!._id,
    role,
    displayName: me!.displayName,
    avatarColor: me!.avatarColor,
    userId:      me!.id,
  });

  if (role === 'speaker') {
    try { await rtc!.joinVoice?.(_stageChannel._id, currentServer!._id); } catch { /* ignore */ }
    const muteBtn = document.getElementById('stage-mute-btn');
    if (muteBtn) muteBtn.textContent = '🔇 Mikrofon Kapalı';
    toast("Stage'e konuşmacı olarak katıldın", 'success');
  } else {
    toast("Stage'e dinleyici olarak katıldın", 'success');
  }
}

export function toggleStageMute(): void {
  if (!rtc) return;
  const muted = rtc.toggleMute?.() ?? false;
  const btn = document.getElementById('stage-mute-btn');
  if (btn) btn.textContent = muted ? '🔇 Mikrofon Kapalı' : '🎤 Mikrofon Açık';
  socket.emit('stage:updateMute', { channelId: _stageChannel?._id ?? '', muted });
}

export function toggleStageHand(): void {
  _stageHandRaised = !_stageHandRaised;
  const btn = document.getElementById('stage-hand-btn');
  if (btn) { btn.textContent = _stageHandRaised ? '✋ El İndir' : '✋ El Kaldır'; btn.style.background = _stageHandRaised ? 'var(--brand)' : ''; }
  socket.emit('stage:handRaise', { channelId: _stageChannel?._id ?? '', raised: _stageHandRaised });
  toast(_stageHandRaised ? 'El kaldırdın — konuşmacılar görecek' : 'Elini indirdin', 'info');
}

export function leaveStage(): void {
  if (_stageChannel) {
    socket.emit('stage:leave', { channelId: _stageChannel._id });
    if (_stageRole === 'speaker') rtc?.leaveVoice?.();
  }
  _stageChannel = null; _stageRole = null; _stageSpeakers = []; _stageListeners = []; _stageHandRaised = false;
  _setDisplay('stage-join-btns', '');
  _setDisplay('stage-speaker-controls', 'none');
  _setDisplay('stage-listener-controls', 'none');
  toast("Stage'den ayrıldın", 'info');
}

export function stagePromoteUser(targetUserId: string): void {
  if (_stageChannel) socket.emit('stage:promote', { channelId: _stageChannel._id, targetUserId });
}

export function stageKickSpeaker(targetUserId: string): void {
  if (!_stageChannel) return;
  if (!confirm('Bu konuşmacıyı dinleyiciye al?')) return;
  socket.emit('stage:demote', { channelId: _stageChannel._id, targetUserId });
}

// ── Socket event handler ──────────────────────────────────────

export function handleStageEvent(event: string, data: Record<string, unknown>): void {
  if (!_stageChannel || data['channelId'] !== _stageChannel._id) return;

  switch (event) {
    case 'stage:state':
      _stageSpeakers  = (data['speakers']  as StageUser[]) ?? [];
      _stageListeners = (data['listeners'] as StageUser[]) ?? [];
      _refreshStageUI();
      break;
    case 'stage:userJoined':
      if (data['role'] === 'speaker') _stageSpeakers.push(data['user'] as StageUser);
      else _stageListeners.push(data['user'] as StageUser);
      _refreshStageUI();
      break;
    case 'stage:userLeft':
      _stageSpeakers  = _stageSpeakers.filter(u  => u.userId !== data['userId']);
      _stageListeners = _stageListeners.filter(u => u.userId !== data['userId']);
      _refreshStageUI();
      break;
    case 'stage:handRaise': {
      const all = [..._stageSpeakers, ..._stageListeners];
      const u = all.find(x => x.userId === data['userId']);
      if (u) { u.handRaised = data['raised'] as boolean; _refreshStageUI(); }
      if (data['raised'] && data['userId'] !== me?.id && currentServer?.ownerId === me?.id) {
        const who = _stageSpeakers.concat(_stageListeners).find(x => x.userId === data['userId']);
        if (who) toast(`✋ ${who.displayName} konuşmak istiyor`, 'info');
      }
      break;
    }
    case 'stage:muteUpdate': {
      const sp = _stageSpeakers.find(u => u.userId === data['userId']);
      if (sp) { sp.muted = data['muted'] as boolean; _refreshStageUI(); }
      break;
    }
    case 'stage:demoted':
      if (data['userId'] === me?.id) {
        _stageRole = 'listener';
        _setDisplay('stage-speaker-controls', 'none');
        _setDisplay('stage-listener-controls', 'flex');
        toast('Dinleyici moduna alındın', 'info');
        rtc?.leaveVoice?.();
      }
      { const si = _stageSpeakers.findIndex(u => u.userId === data['userId']); if (si !== -1) { const [u] = _stageSpeakers.splice(si, 1); u.handRaised = false; _stageListeners.push(u); _refreshStageUI(); } }
      break;
    case 'stage:promoted':
      if (data['userId'] === me?.id) {
        _stageRole = 'speaker';
        _setDisplay('stage-listener-controls', 'none');
        _setDisplay('stage-speaker-controls', 'flex');
        toast('Konuşmacı olarak yükseltildin! 🎤', 'success');
        rtc?.joinVoice?.(_stageChannel._id, currentServer!._id).catch(() => { /* ignore */ });
      }
      { const li = _stageListeners.findIndex(u => u.userId === data['userId']); if (li !== -1) { const [u] = _stageListeners.splice(li, 1); u.muted = true; _stageSpeakers.push(u); _refreshStageUI(); } }
      break;
  }
}

// ── Yardımcı ─────────────────────────────────────────────────

function _setDisplay(id: string, v: string): void {
  const el = document.getElementById(id);
  if (el) el.style.display = v;
}
