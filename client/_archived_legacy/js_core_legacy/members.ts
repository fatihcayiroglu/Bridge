// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MembersPanel.svelte
//              client/js/core/members-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/members.ts — Sprint 43 JS→TS geçişi
import { setCurrentServerMembers, contextCommands } from './globals.js';
import { escHtml, cssColor, toast } from './utils.js';
import { initials } from './utils.js';
import { BridgeRegistry } from './bridge-registry.js';

// ── Context menu tipleri ──────────────────────────────────────────────────────

interface ContextMenuItem {
  icon: string;
  label: string;
  action: () => void;
  danger?: boolean;
  sep?: never;
}
interface ContextMenuSep { sep: true }
type ContextMenuEntry = ContextMenuItem | ContextMenuSep;

// core/members.js (split from app.js)
async function loadMembers(serverId: string): Promise<void> {
  const r = await apiFetch(`${API}/api/servers/${serverId}/members`);
  const members = await r.json();
  setCurrentServerMembers(members); // Sprint 32: ESM setter // cache for mention autocomplete
  renderMembers(members);
}

function renderMembers(members: Record<string, unknown>[]): void {
  const online = members.filter(m => m.status !== 'offline');
  const offline = members.filter(m => m.status === 'offline');
  const content = document.getElementById('member-list-content'); content.innerHTML = '';
  if (online.length) { content.innerHTML += `<div class="member-cat">Online — ${online.length}</div>`; for (const m of online) content.innerHTML += memberRow(m, true); }
  if (offline.length) { content.innerHTML += `<div class="member-cat" style="margin-top:8px">Offline — ${offline.length}</div>`; for (const m of offline) content.innerHTML += memberRow(m, false); }
}

function memberRow(m: Record<string, unknown>, isOnline: boolean): string {
  const statusClass = m.status === 'idle' ? 'idle' : m.status === 'dnd' ? 'dnd' : isOnline ? 'online' : 'offline';
  const isMe = m.id === me?.id;
  const dmBtn   = !isMe ? `<button class="dm-btn" data-uid="${escHtml(m.id)}" data-name="${escHtml(m.displayName)}" data-color="${cssColor(m.avatarColor)}" onclick="openDmWithUser(this.dataset.uid,this.dataset.name,this.dataset.color)" title="Mesaj At">💬</button>` : '';
  const callBtn = !isMe && isOnline ? `<button class="dm-btn" style="opacity:.85" title="Ara" onclick="event.stopPropagation();_memberQuickCall('${escHtml(m.id)}','${escHtml(m.displayName)}','${cssColor(m.avatarColor)}')">📞</button>` : '';

  const displayName = m.nickname || m.displayName;
  const badgeHtml = m.badge ? `<span title="${escHtml(m.badge)}" style="font-size:11px;padding:1px 5px;border-radius:3px;background:var(--brand);color:#fff;font-weight:600;margin-left:4px">${escHtml(m.badge)}</span>` : '';
  const nicknameHint = m.nickname ? `<span style="font-size:10px;color:var(--text-muted);margin-left:3px">(${escHtml(m.displayName)})</span>` : '';

  return `<div class="member-row" oncontextmenu="_memberContextMenu(event,'${escHtml(m.id)}','${escHtml(m.displayName)}','${cssColor(m.avatarColor)}',${isOnline})">
    <div class="member-avatar" style="background:${cssColor(m.avatarColor)}">${initials(displayName)}<div class="m-status ${statusClass}"></div></div>
    <span class="member-name ${isOnline ? 'is-online' : ''}">${escHtml(displayName)}${badgeHtml}${nicknameHint}</span>
    <div class="member-actions">${callBtn}${dmBtn}</div>
  </div>`;
}

function _memberQuickCall(uid: string, name: string, color: string): void {
  openDmWithUser(uid, name, color);  // ensure DM exists
  // Small delay so DM opens first, then start call
  setTimeout(() => {
    // Sprint 33: import { DmCall }
    BridgeRegistry.call('DmCall:startCall', uid, name, color, 'voice');
  }, 300);
}

function _memberContextMenu(e: MouseEvent, uid: string, name: string, color: string, isOnline: boolean): void {
  e.preventDefault();
  document.getElementById('_bridge-ctx')?.remove();
  const isMe = uid === me?.id;
  const menu = document.createElement('div');
  menu.id = '_bridge-ctx';
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9998;
    background:var(--bg-secondary,#2f3136);border-radius:8px;padding:6px 0;min-width:200px;
    box-shadow:0 8px 24px rgba(0,0,0,.5);font-size:13px;`;
  const items: ContextMenuEntry[] = [];
  if (!isMe) {
    items.push({ icon:'💬', label:'Mesaj Gönder',
      action: () => openDmWithUser(uid, name, color) });
    if (isOnline) {
      items.push({ icon:'📞', label:'Ses Araması Yap',
        action: () => _memberQuickCall(uid, name, color) });
      items.push({ icon:'📹', label:'Görüntülü Ara',
        action: () => { openDmWithUser(uid, name, color); setTimeout(() => BridgeRegistry.call('DmCall:startCall', uid, name, color, 'video'), 300); } });
    }
    items.push({ icon:'👤', label:'Profili Gör',
      action: () => BridgeRegistry.call('openProfileModal', uid) });
    items.push({ icon:'✏️',  label:'Takma Ad Ayarla',
      action: () => _setNicknamePrompt(uid, name) });
    items.push({ icon:'🚫', label:'Engelle',
      action: () => _blockUser(uid, name), danger: true });
    items.push({ icon:'📋', label:'Kullanıcı Adı Kopyala',
      action: () => navigator.clipboard.writeText(name).then(() => toast('Kopyalandı', 'success')) });

    // Bot context menu komutları (USER_COMMAND)
    const ctxCmds = contextCommands.filter(c => c.type === 'USER_COMMAND') || [];
    if (ctxCmds.length) {
      items.push({ sep: true });
      ctxCmds.forEach(c => items.push({
        icon: '🤖', label: c.botName ? `${c.name} (${c.botName})` : c.name,
        action: () => _triggerContextCommand('user_command', c.name, uid, null)
      }));
    }
  } else {
    items.push({ icon:'✏️',  label:'Takma Adımı Sıfırla',
      action: () => _setNicknamePrompt(uid, name) });
  }

  items.forEach(item => {
    if (item.sep) {
      const sep = document.createElement('div');
      sep.style.cssText = 'height:1px;background:var(--border,rgba(255,255,255,.08));margin:4px 0';
      menu.appendChild(sep);
      return;
    }
    const el = document.createElement('div');
    el.style.cssText = `padding:8px 14px;cursor:pointer;color:${item.danger ? '#ed4245' : 'var(--text-primary,#fff)'};display:flex;gap:10px;align-items:center;transition:background .1s`;
    el.innerHTML = `<span>${item.icon}</span><span>${item.label}</span>`;
    el.onmouseenter = () => el.style.background = item.danger ? 'rgba(237,66,69,.15)' : 'var(--brand,#2d9cdb)';
    el.onmouseleave = () => el.style.background = '';
    el.onclick = () => { menu.remove(); item.action(); };
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function _setNicknamePrompt(uid: string, currentName: string): Promise<void> {
  const nick = prompt(`Sunucu takma adı (boş = sıfırla)`, '');
  if (nick === null) return; // iptal
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/members/${uid}/nickname`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: nick.trim() || null }),
  });
  if (r.ok) {
    toast(nick.trim() ? `Takma ad: ${nick.trim()}` : 'Takma ad sıfırlandı', 'success');
    loadMembers(currentServer._id);
  } else {
    const d = await r.json();
    toast(d.error || 'Hata', 'error');
  }
}

async function _blockUser(uid: string, name: string): Promise<void> {
  if (!confirm(`${name} kullanıcısını engellemek istediğine emin misin?`)) return;
  const r = await apiFetch(`${API}/api/friends/block/${uid}`, { method: 'POST' });
  if (r.ok) toast(`${name} engellendi`, 'success');
  else { const d = await r.json(); toast(d.error || 'Hata', 'error'); }
}

async function _triggerContextCommand(type: string, commandName: string, targetUserId: string | null, targetMessageId: string | null): Promise<void> {
  await apiFetch(`${API}/api/interactions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type,
      customId: commandName,
      channelId: currentChannel?._id,
      serverId: currentServer?._id,
      targetUserId: targetUserId || null,
      targetMessageId: targetMessageId || null,
    }),
  });
}

function toggleMemberList(): void { memberListVisible = !memberListVisible; document.getElementById('member-list')?.style.display = memberListVisible ? '' : 'none'; }

// ══════════════════════════════════════════════════
// SOCKET EVENTS
// ══════════════════════════════════════════════════

export {
  loadMembers,
  memberRow,
  renderMembers,
  toggleMemberList,
};
