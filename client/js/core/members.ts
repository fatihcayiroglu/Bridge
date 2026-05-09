// core/members.js (split from app.js)
async function loadMembers(serverId) {
  const r = await apiFetch(`${API}/api/servers/${serverId}/members`);
  const members = await r.json();
  window.currentServerMembers = members; // cache for mention autocomplete
  renderMembers(members);
}

function renderMembers(members) {
  const online = members.filter(m => m.status !== 'offline');
  const offline = members.filter(m => m.status === 'offline');
  const content = document.getElementById('member-list-content'); content.innerHTML = '';
  if (online.length) { content.innerHTML += `<div class="member-cat">Online â€” ${online.length}</div>`; for (const m of online) content.innerHTML += memberRow(m, true); }
  if (offline.length) { content.innerHTML += `<div class="member-cat" style="margin-top:8px">Offline â€” ${offline.length}</div>`; for (const m of offline) content.innerHTML += memberRow(m, false); }
}

function memberRow(m, isOnline) {
  const statusClass = m.status === 'idle' ? 'idle' : m.status === 'dnd' ? 'dnd' : isOnline ? 'online' : 'offline';
  const isMe = m.id === me?.id;
  const dmBtn   = !isMe ? `<button class="dm-btn" data-uid="${escHtml(m.id)}" data-name="${escHtml(m.displayName)}" data-color="${cssColor(m.avatarColor)}" onclick="openDmWithUser(this.dataset.uid,this.dataset.name,this.dataset.color)" title="Mesaj At">ğŸ’¬</button>` : '';
  const callBtn = !isMe && isOnline ? `<button class="dm-btn" style="opacity:.85" title="Ara" onclick="event.stopPropagation();_memberQuickCall('${escHtml(m.id)}','${escHtml(m.displayName)}','${cssColor(m.avatarColor)}')">ğŸ“</button>` : '';

  const displayName = m.nickname || m.displayName;
  const badgeHtml = m.badge ? `<span title="${escHtml(m.badge)}" style="font-size:11px;padding:1px 5px;border-radius:3px;background:var(--brand);color:#fff;font-weight:600;margin-left:4px">${escHtml(m.badge)}</span>` : '';
  const nicknameHint = m.nickname ? `<span style="font-size:10px;color:var(--text-muted);margin-left:3px">(${escHtml(m.displayName)})</span>` : '';

  return `<div class="member-row" oncontextmenu="_memberContextMenu(event,'${escHtml(m.id)}','${escHtml(m.displayName)}','${cssColor(m.avatarColor)}',${isOnline})">
    <div class="member-avatar" style="background:${cssColor(m.avatarColor)}">${initials(displayName)}<div class="m-status ${statusClass}"></div></div>
    <span class="member-name ${isOnline ? 'is-online' : ''}">${escHtml(displayName)}${badgeHtml}${nicknameHint}</span>
    <div class="member-actions">${callBtn}${dmBtn}</div>
  </div>`;
}

function _memberQuickCall(uid, name, color) {
  openDmWithUser(uid, name, color);  // ensure DM exists
  // Small delay so DM opens first, then start call
  setTimeout(() => {
    if (window.DmCall) DmCall.startCall(uid, name, color, 'voice');
  }, 300);
}

function _memberContextMenu(e, uid, name, color, isOnline) {
  e.preventDefault();
  document.getElementById('_bridge-ctx')?.remove();
  const isMe = uid === me?.id;
  const menu = document.createElement('div');
  menu.id = '_bridge-ctx';
  menu.style.cssText = `position:fixed;left:${e.clientX}px;top:${e.clientY}px;z-index:9998;
    background:var(--bg-secondary,#2f3136);border-radius:8px;padding:6px 0;min-width:200px;
    box-shadow:0 8px 24px rgba(0,0,0,.5);font-size:13px;`;
  const items = [];
  if (!isMe) {
    items.push({ icon:'ğŸ’¬', label:'Mesaj GÃ¶nder',          action:`openDmWithUser('${uid}','${name}','${color}')` });
    if (isOnline) {
      items.push({ icon:'ğŸ“', label:'Ses AramasÄ± Yap',      action:`_memberQuickCall('${uid}','${name}','${color}')` });
      items.push({ icon:'ğŸ“¹', label:'GÃ¶rÃ¼ntÃ¼lÃ¼ Ara',        action:`openDmWithUser('${uid}','${name}','${color}');setTimeout(()=>DmCall?.startCall('${uid}','${name}','${color}','video'),300)` });
    }
    items.push({ icon:'ğŸ‘¤', label:'Profili GÃ¶r',            action:`openProfileModal && openProfileModal('${uid}')` });
    items.push({ icon:'âœï¸',  label:'Takma Ad Ayarla',       action:`_setNicknamePrompt('${uid}','${name}')` });
    items.push({ icon:'ğŸš«', label:'Engelle',                action:`_blockUser('${uid}','${name}')`, danger: true });
    items.push({ icon:'ğŸ“‹', label:'KullanÄ±cÄ± AdÄ± Kopyala', action:`navigator.clipboard.writeText('${name}').then(()=>toast('KopyalandÄ±','success'))` });

    // Bot context menu komutlarÄ± (USER_COMMAND)
    const ctxCmds = window._contextCommands?.filter(c => c.type === 'USER_COMMAND') || [];
    if (ctxCmds.length) {
      items.push({ sep: true });
      ctxCmds.forEach(c => items.push({
        icon: 'ğŸ¤–', label: c.botName ? `${c.name} (${c.botName})` : c.name,
        action: `_triggerContextCommand('user_command','${c.name}','${uid}',null)`
      }));
    }
  } else {
    items.push({ icon:'âœï¸',  label:'Takma AdÄ±mÄ± SÄ±fÄ±rla', action:`_setNicknamePrompt('${uid}','${name}')` });
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
    el.onmouseenter = () => el.style.background = item.danger ? 'rgba(237,66,69,.15)' : 'var(--brand,#5865f2)';
    el.onmouseleave = () => el.style.background = '';
    el.onclick = () => { menu.remove(); eval(item.action); };
    menu.appendChild(el);
  });
  document.body.appendChild(menu);
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 0);
}

async function _setNicknamePrompt(uid, currentName) {
  const nick = prompt(`Sunucu takma adÄ± (boÅŸ = sÄ±fÄ±rla)`, '');
  if (nick === null) return; // iptal
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/members/${uid}/nickname`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ nickname: nick.trim() || null }),
  });
  if (r.ok) {
    toast(nick.trim() ? `Takma ad: ${nick.trim()}` : 'Takma ad sÄ±fÄ±rlandÄ±', 'success');
    loadMembers(currentServer._id);
  } else {
    const d = await r.json();
    toast(d.error || 'Hata', 'error');
  }
}

async function _blockUser(uid, name) {
  if (!confirm(`${name} kullanÄ±cÄ±sÄ±nÄ± engellemek istediÄŸine emin misin?`)) return;
  const r = await apiFetch(`${API}/api/friends/block/${uid}`, { method: 'POST' });
  if (r.ok) toast(`${name} engellendi`, 'success');
  else { const d = await r.json(); toast(d.error || 'Hata', 'error'); }
}

async function _triggerContextCommand(type, commandName, targetUserId, targetMessageId) {
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

function toggleMemberList() { memberListVisible = !memberListVisible; document.getElementById('member-list').style.display = memberListVisible ? '' : 'none'; }

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SOCKET EVENTS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

