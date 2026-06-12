// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/FriendsPanel.svelte
//              client/js/core/friends-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/friends.ts
// Sprint 43: JS→TS geçişi
// Arkadaş sistemi, voice activity, status

import { apiFetch } from './api-fetch.js';
import { getAPI } from './globals.js';
import { toast, escHtml, initials } from './utils.js';

interface Friend {
  _id: string;
  displayName: string;
  username: string;
  avatarColor?: string;
  status?: 'online' | 'idle' | 'dnd' | 'offline';
  activity?: { name?: string };
}

interface PendingRequest {
  _id: string;
  displayName: string;
  username: string;
  avatarColor?: string;
}

// Modül-scoped state
let friendsList: Friend[] = [];
let pendingRequests: PendingRequest[] = [];
let currentStatusText = '';

// Runtime-injected (BridgeRegistry veya globals'tan gelir)
declare const API: string;
declare const socket: { emit: (...a: unknown[]) => void; currentVoiceChannel?: string } | undefined;

// ── ARKADAŞLAR PANELİ ─────────────────────────────────────────────────────────
export function openFriendsPanel(): void {
  const panel = document.getElementById('friends-panel');
  if (panel) panel.style.display = 'flex';
  loadFriends();
}

export function closeFriendsPanel(): void {
  const panel = document.getElementById('friends-panel');
  if (panel) panel.style.display = 'none';
}

export function switchFriendsTab(tab: string, btn?: HTMLElement | null): void {
  document.querySelectorAll<HTMLElement>('.fn-btn').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  renderFriendsTab(tab);
}

export async function loadFriends(): Promise<void> {
  try {
    const [fr, pr] = await Promise.all([
      apiFetch(`${API}/api/friends`).then(r => r.json()) as Promise<Friend[]>,
      apiFetch(`${API}/api/friends/pending`).then(r => r.json()) as Promise<PendingRequest[]>,
    ]);
    friendsList    = fr;
    pendingRequests = pr;

    const badge = document.getElementById('pending-badge');
    if (badge) {
      badge.textContent = String(pr.length);
      badge.style.display = pr.length ? '' : 'none';
    }

    renderFriendsTab('online');
  } catch { toast('Arkadaşlar yüklenemedi', 'error'); }
}

export function renderFriendsTab(tab: string): void {
  const list = document.getElementById('friends-list');
  if (!list) return;

  if (tab === 'add') {
    list.innerHTML = `
      <div style="padding:16px">
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:12px">Kullanıcı adı ile arkadaş ekle:</p>
        <div style="display:flex;gap:8px">
          <input id="friend-add-input" type="text" placeholder="kullanici_adi"
            class="input" style="flex:1;"
            onkeydown="if(event.key==='Enter')sendFriendRequest()">
          <button class="btn" onclick="sendFriendRequest()">Gönder</button>
        </div>
      </div>`;
    return;
  }

  let displayed: Array<Friend | PendingRequest> = [];

  if (tab === 'pending')     displayed = pendingRequests;
  else if (tab === 'all')    displayed = friendsList;
  else /* online */          displayed = friendsList.filter(f => f.status && f.status !== 'offline');

  if (!displayed.length) {
    const emptyMsg: Record<string, string> = {
      online:  '😴 Şu an çevrimiçi arkadaşın yok',
      all:     '👥 Henüz arkadaşın yok',
      pending: '✅ Bekleyen istek yok',
    };
    list.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted);">
      <div style="font-size:32px;margin-bottom:8px">${tab === 'online' ? '😴' : tab === 'all' ? '👥' : '✅'}</div>
      <p>${emptyMsg[tab] ?? ''}</p>
    </div>`;
    return;
  }

  if (tab === 'pending') {
    list.innerHTML = (displayed as PendingRequest[]).map(req => `
      <div class="friend-item">
        <div class="friend-avatar" style="background:${req.avatarColor ?? '#4f8ef7'}">${initials(req.displayName)}</div>
        <div class="friend-info">
          <div class="friend-name">${escHtml(req.displayName)}</div>
          <div class="friend-status">@${escHtml(req.username)}</div>
        </div>
        <div style="display:flex;gap:6px">
          <button class="btn" style="padding:4px 10px;font-size:12px;" onclick="acceptFriend('${req._id}')">✅</button>
          <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="rejectFriend('${req._id}')">✕</button>
        </div>
      </div>`).join('');
  } else {
    const statusColors: Record<string, string> = { online: 'var(--green)', idle: 'var(--yellow)', dnd: 'var(--red)', offline: 'var(--text-muted)' };
    const statusLabels: Record<string, string> = { online: 'Çevrimiçi', idle: 'Uzakta', dnd: 'Rahatsız Etme', offline: 'Çevrimdışı' };

    list.innerHTML = (displayed as Friend[]).map(f => {
      const activity = f.activity ? ` • ${f.activity.name ?? ''}` : '';
      const statusKey = f.status ?? 'offline';
      return `
        <div class="friend-item">
          <div style="position:relative">
            <div class="friend-avatar" style="background:${f.avatarColor ?? '#4f8ef7'}">${initials(f.displayName)}</div>
            <div style="position:absolute;bottom:-2px;right:-2px;width:12px;height:12px;border-radius:50%;background:${statusColors[statusKey] ?? 'var(--text-muted)'};border:2px solid var(--bg-2)"></div>
          </div>
          <div class="friend-info">
            <div class="friend-name">${escHtml(f.displayName)}</div>
            <div class="friend-status" style="color:${statusColors[statusKey] ?? 'var(--text-muted)'}">
              ${statusLabels[statusKey] ?? 'Çevrimdışı'}${escHtml(activity)}
            </div>
          </div>
          <div style="display:flex;gap:6px">
            <button class="icon-btn" title="Mesaj gönder" onclick="openDmWithUser('${f._id}','${escHtml(f.displayName)}','${f.avatarColor ?? '#4f8ef7'}')">💬</button>
            <button class="icon-btn" title="Arkadaşlıktan çıkar" onclick="removeFriend('${f._id}','${escHtml(f.displayName)}')">✕</button>
          </div>
        </div>`;
    }).join('');
  }
}

export async function sendFriendRequest(): Promise<void> {
  const username = (document.getElementById('friend-add-input') as HTMLInputElement | null)?.value?.trim();
  if (!username) return toast('Kullanıcı adı gerekli', 'error');
  try {
    const r    = await apiFetch(`${API}/api/friends/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username }),
    });
    const data = await r.json() as { error?: string };
    if (!r.ok) return toast(data.error ?? 'Hata', 'error');
    toast(`${username} kullanıcısına istek gönderildi!`, 'success');
    const input = document.getElementById('friend-add-input') as HTMLInputElement | null;
    if (input) input.value = '';
  } catch { toast('Bağlantı hatası', 'error'); }
}

export async function acceptFriend(userId: string): Promise<void> {
  try {
    const r = await apiFetch(`${API}/api/friends/accept/${userId}`, { method: 'POST' });
    const d = await r.json() as { error?: string };
    if (!r.ok) return toast(d.error ?? 'Hata', 'error');
    toast('Arkadaşlık isteği kabul edildi!', 'success');
    await loadFriends();
  } catch { toast('Hata', 'error'); }
}

export async function rejectFriend(userId: string): Promise<void> {
  try {
    const r = await apiFetch(`${API}/api/friends/reject/${userId}`, { method: 'POST' });
    if (!r.ok) return toast('Hata', 'error');
    toast('İstek reddedildi', 'info');
    await loadFriends();
  } catch { toast('Hata', 'error'); }
}

export async function removeFriend(userId: string, displayName: string): Promise<void> {
  if (!confirm(`${displayName} ile arkadaşlığı bitir?`)) return;
  try {
    const r = await apiFetch(`${API}/api/friends/${userId}`, { method: 'DELETE' });
    if (!r.ok) return toast('Hata', 'error');
    toast('Arkadaşlık sonlandırıldı', 'info');
    await loadFriends();
  } catch { toast('Hata', 'error'); }
}

// ── VOICE ACTIVITY DETECTOR ───────────────────────────────────────────────────
export function startVoiceActivityDetection(stream: MediaStream): void {
  try {
    const ctx      = new AudioContext();
    const source   = ctx.createMediaStreamSource(stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const data = new Uint8Array(analyser.frequencyBinCount);
    let speaking = false;

    const tick = (): void => {
      analyser.getByteFrequencyData(data);
      const avg        = data.reduce((a, b) => a + b, 0) / data.length;
      const isSpeaking = avg > 15;
      if (isSpeaking !== speaking) {
        speaking = isSpeaking;
        if (socket?.currentVoiceChannel) {
          socket.emit('voice:activity', { channelId: socket.currentVoiceChannel, speaking });
        }
        document.querySelector<HTMLElement>('.voice-peer.local')?.classList.toggle('speaking', speaking);
      }
      requestAnimationFrame(tick);
    };
    tick();
  } catch { /* AudioContext kullanılamıyor */ }
}

// ── RICH STATUS ───────────────────────────────────────────────────────────────
export function openStatusPicker(e?: MouseEvent): void {
  e?.stopPropagation();
  const picker = document.getElementById('status-picker');
  if (!picker) return;
  const rect = document.getElementById('my-status-dot')?.getBoundingClientRect() ?? { top: 100, left: 100 };
  picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
  picker.style.left   = rect.left + 'px';
  picker.style.display = picker.style.display === 'block' ? 'none' : 'block';
  const stInput = document.getElementById('status-text-input') as HTMLInputElement | null;
  if (stInput) stInput.value = currentStatusText;
  setTimeout(() => document.addEventListener('click', () => { picker.style.display = 'none'; }, { once: true }), 50);
}

export function setRichStatus(status: string): void {
  const stInput  = document.getElementById('status-text-input') as HTMLInputElement | null;
  const statusText = stInput?.value ?? '';
  currentStatusText = statusText;
  socket?.emit('status:update', { status, statusText, statusEmoji: '' });
  const myDot = document.getElementById('my-status-dot');
  if (myDot) myDot.className = `status-dot ${status === 'offline' ? 'offline' : status}`;
  const myTag = document.getElementById('my-tag');
  if (myTag) myTag.textContent = statusText || status;
  const picker = document.getElementById('status-picker');
  if (picker) picker.style.display = 'none';
  toast('Durum güncellendi', 'success');
}

export function saveStatusText(): void {
  const val = (document.getElementById('status-text-input') as HTMLInputElement | null)?.value ?? '';
  currentStatusText = val;
  socket?.emit('status:update', { status: 'online', statusText: val, statusEmoji: '' });
  const picker = document.getElementById('status-picker');
  if (picker) picker.style.display = 'none';
  const myTag = document.getElementById('my-tag');
  if (myTag) myTag.textContent = val || 'Online';
  toast('Durum mesajı güncellendi', 'success');
}

export function initStatusPicker(): void {
  const dot = document.getElementById('my-status-dot');
  if (dot) dot.addEventListener('click', openStatusPicker);
}

// ── CSS ───────────────────────────────────────────────────────────────────────
const friendStyle = document.createElement('style');
friendStyle.textContent = `
  .friend-item {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border-radius: 6px;
    cursor: pointer;
    transition: background 0.1s;
  }
  .friend-item:hover { background: var(--bg-hover); }
  .friend-avatar {
    width: 36px; height: 36px;
    border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700; color: white; flex-shrink: 0;
  }
  .friend-info { flex: 1; min-width: 0; }
  .friend-name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .friend-status { font-size: 12px; color: var(--text-muted); margin-top: 1px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
document.head.appendChild(friendStyle);
