export {};
// client/js/core/channel-list.js
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CHANNEL LIST â€” render, select, CRUD, NSFW, bitrate
// Ä°zin modalÄ± iÃ§in â†’ channel-permissions.js
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

// â”€â”€ Element factory â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function makeChannelEl(ch) {
  const el = document.createElement('div');
  el.className = 'ch-item';
  el.dataset.id   = ch._id;
  el.dataset.type = ch.type || 'text';

  const icon = ch.type === 'voice' ? 'ğŸ”Š'
    : ch.type === 'forum'        ? 'ğŸ“‹'
    : ch.type === 'stage'        ? 'ğŸ­'
    : ch.type === 'announcement' ? 'ğŸ“£'
    : '#';
  const nsfwBadge = ch.nsfw ? `<span title="NSFW" style="font-size:10px;background:#ed4245;color:#fff;border-radius:3px;padding:1px 4px;margin-left:4px;font-weight:700">18+</span>` : '';

  el.innerHTML = `
    <span class="ch-icon">${icon}</span>
    <span class="ch-name" style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escHtml(ch.name)}</span>
    ${nsfwBadge}
    <span class="voice-count" id="vc-${ch._id}" style="display:none"></span>
    <span class="ch-unread" id="unread-${ch._id}" style="display:none"></span>
    <button class="ch-settings-btn" title="Ayarlar" onclick="openChannelMenu('${ch._id}','${escHtml(ch.name).replace(/'/g,"\\'")}',event)" style="opacity:0;background:none;border:none;cursor:pointer;padding:2px 4px;border-radius:4px;color:var(--text-3);font-size:13px;transition:opacity .15s">âš™ï¸</button>`;

  el.addEventListener('click', () => selectChannel(ch));
  return el;
}

// â”€â”€ Load & render â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadChannels(serverId) {
  const r = await apiFetch(`${API}/api/servers/${serverId}/channels`);
  const channels = await r.json();
  window.currentServerChannels = channels;
  renderChannels(channels);
  const first = channels.find(c => c.type === 'text');
  if (first) selectChannel(first);
}

async function renderChannels(channels) {
  const list = document.getElementById('channel-list');
  // Scroll pozisyonunu kaydet
  const prevScroll = list.scrollTop;
  list.innerHTML = '';

//   load DB categories
  const cats = currentServer ? await loadCategories(currentServer._id) : [];

  if (!cats.length) {
    // Fallback: group by channel.category string (old system)
    const grouped = {};
    for (const ch of channels) { if (!grouped[ch.category]) grouped[ch.category] = []; grouped[ch.category].push(ch); }
    for (const [cat, chs] of Object.entries(grouped)) {
      const isCollapsed = collapsedCategories.has(cat);
      const catEl = document.createElement('div'); catEl.className = 'ch-category';
      catEl.innerHTML = `<span class="cat-arrow${isCollapsed?' collapsed':''}">â–¾</span> ${cat} <button class="ch-add-btn" onclick="createChannel()" title="Add channel">+</button>`;
      catEl.querySelector('.cat-arrow').addEventListener('click', e => {
        e.stopPropagation();
        if (collapsedCategories.has(cat)) collapsedCategories.delete(cat); else collapsedCategories.add(cat);
        _persistCollapsedCategories();
        renderChannels(channels);
      });
      list.appendChild(catEl);
      if (isCollapsed) continue;
      for (const ch of chs) list.appendChild(makeChannelEl(ch));
    }
    list.scrollTop = prevScroll;
    return;
  }

  // v15 category system
  const grouped = {};
  const uncategorized = [];
  for (const ch of channels) {
    if (ch.categoryId) {
      if (!grouped[ch.categoryId]) grouped[ch.categoryId] = [];
      grouped[ch.categoryId].push(ch);
    } else uncategorized.push(ch);
  }

  // Uncategorized first
  for (const ch of uncategorized) list.appendChild(makeChannelEl(ch));

  // DB categories
  for (const cat of cats.sort((a,b) => a.position - b.position)) {
    const catEl = document.createElement('div');
    catEl.className = 'ch-category';
    catEl.dataset.catId = cat._id;
    catEl.innerHTML = `<span class="cat-arrow" style="font-size:10px;transition:transform .2s">${cat.collapsed ? 'â–¶' : 'â–¼'}</span>
      <span style="flex:1">${escHtml(cat.name)}</span>
      <button class="ch-add-btn" title="Kanal Ekle" onclick="createChannelInCategory('${cat._id}',event)">+</button>`;
    catEl.addEventListener('click', e => { if (e.target.classList.contains('ch-add-btn')) return; toggleCategory(cat._id, catEl); });
    list.appendChild(catEl);

    const wrapper = document.createElement('div');
    wrapper.id = `cat-channels-${cat._id}`;
    wrapper.style.display = cat.collapsed ? 'none' : '';
    for (const ch of (grouped[cat._id] || [])) wrapper.appendChild(makeChannelEl(ch));
    list.appendChild(wrapper);
  }
  list.scrollTop = prevScroll;
}

// â”€â”€ Select / navigate to channel â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function selectChannel(channel) {
  if (currentChannel?._id === channel._id) return;
  if (rtc?.isInVoice() && channel.type === 'text') leaveVoice();
//   Kanal deÄŸiÅŸince typing gÃ¶stergelerini sÄ±fÄ±rla
  if (typeof typingUsers !== 'undefined') typingUsers.clear();
  if (typeof updateTypingBar === 'function') updateTypingBar();
//   Mevcut kanalÄ±n scroll pozisyonunu kaydet
  if (currentChannel?._id && typeof window._saveChannelScroll === 'function') {
    window._saveChannelScroll(currentChannel._id);
  }
  currentChannel = channel;
  clearUnread(channel._id);
  document.querySelectorAll('.ch-item').forEach(el => {
    const isActive = el.getAttribute('data-id') === channel._id;
    el.classList.toggle('active', isActive);
    if (isActive) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  });

  const typeIcon = channel.type === 'voice' ? 'ğŸ”Š'
    : channel.type === 'forum'        ? 'ğŸ“‹'
    : channel.type === 'stage'        ? 'ğŸ­'
    : channel.type === 'announcement' ? 'ğŸ“£'
    : '#';
  document.getElementById('ch-h-icon').textContent = typeIcon;
  document.getElementById('ch-h-name').textContent = channel.name;
  document.getElementById('ch-h-topic').textContent = channel.topic || '';
  document.getElementById('msg-input').placeholder = `Message #${channel.name}`;

  // NSFW kanal uyarÄ±sÄ± â€” kullanÄ±cÄ± onaylamadÄ±ysa overlay gÃ¶ster
  if (channel.nsfw && !window._nsfwAccepted?.has(channel._id)) {
    _showNsfwOverlay(channel);
    return;
  }

  if (channel.type === 'forum') {
    document.getElementById('text-view').style.display = 'flex';
    document.getElementById('voice-view').style.display = 'none';
    document.getElementById('msg-input-wrap').style.display = 'none';
    socket.emit('channel:join', channel._id);
    await loadForumChannel(channel._id);
  } else if (channel.type === 'stage') {
    document.getElementById('text-view').style.display = 'none';
    document.getElementById('voice-view').style.display = 'none';
    document.getElementById('msg-input-wrap').style.display = 'none';
    loadStageChannel(channel);
  } else if (channel.type === 'text' || channel.type === 'announcement') {
    document.getElementById('text-view').style.display = 'flex';
    document.getElementById('voice-view').style.display = 'none';
    // Duyuru kanalÄ±nda sadece yÃ¶neticiler yazabilir â€” UI'da input'u gizle
    if (channel.type === 'announcement') {
      const isAdmin = me?.isAdmin || currentServer?.ownerId === me?.id;
      document.getElementById('msg-input-wrap').style.display = isAdmin ? '' : 'none';
    } else {
      document.getElementById('msg-input-wrap').style.display = '';
    }
    socket.emit('channel:join', channel._id);
    await loadMessages(channel._id);
    loadBridgeInfo(channel._id);
  } else {
    document.getElementById('text-view').style.display = 'none';
    document.getElementById('voice-view').style.display = 'flex';
    document.getElementById('msg-input-wrap').style.display = 'none';

//     bitrate gÃ¶ster + ayar butonu
    const bps    = channel.bitrate || 64000;
    const kbps   = Math.round(bps / 1000);
    const qual   = kbps >= 256 ? 'ğŸ”µ YÃ¼ksek' : kbps >= 96 ? 'ğŸŸ¢ Normal' : 'ğŸŸ¡ DÃ¼ÅŸÃ¼k';
    const titleEl = document.getElementById('voice-room-title');
    titleEl.innerHTML = `ğŸ”Š ${escHtml(channel.name)} <span style="font-size:11px;color:var(--text-muted);margin-left:6px">${qual} Â· ${kbps}kbps</span>
      <button onclick="_openVoiceBitrateSettings('${channel._id}')" title="Bitrate Ayarla" style="background:none;border:none;cursor:pointer;font-size:13px;color:var(--text-muted);margin-left:4px">âš™ï¸</button>`;

    document.getElementById('voice-peers').innerHTML = '';
    voiceChannelPeers.clear();
    renderVoicePeer({ socketId: 'local', userId: me.id, displayName: me.displayName, avatarColor: me.avatarColor }, true);
    await rtc.joinVoice(channel._id, currentServer._id);
  }
}

// â”€â”€ v39: Voice bitrate settings modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _openVoiceBitrateSettings(channelId) {
  const ch = (window.currentServerChannels || []).find(c => c._id === channelId);
  if (!ch) return;
  _destroyTempModal();
  const cur = Math.round((ch.bitrate || 64000) / 1000);
  const modal = document.createElement('div');
  modal.id = '_voice-bitrate-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:380px;width:95%">
      <h2 style="margin:0 0 16px">ğŸ”Š Ses Kalitesi</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">
        Daha yÃ¼ksek bitrate = daha iyi ses kalitesi, daha fazla bant geniÅŸliÄŸi.
      </p>
      <label style="font-size:13px;font-weight:600">Bitrate: <strong id="_vbr-val">${cur}</strong> kbps</label>
      <input type="range" id="_vbr-input" min="8" max="384" step="8" value="${cur}"
        oninput="document.getElementById('_vbr-val').textContent=this.value"
        style="width:100%;margin:10px 0">
      <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-muted);margin-bottom:16px">
        <span>8kbps (DÃ¼ÅŸÃ¼k)</span><span>64kbps (Standart)</span><span>384kbps (Max)</span>
      </div>
      <div class="modal-footer" style="display:flex;gap:8px">
        <button class="btn btn-primary" id="_vbr-save">Kaydet</button>
        <button class="btn" onclick="document.getElementById('_voice-bitrate-modal')?.remove()">Ä°ptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.getElementById('_vbr-save').onclick = async () => {
    const kbps    = parseInt((document.getElementById('_vbr-input') as HTMLInputElement | null)?.value ?? '');
    const bitrate = kbps * 1000;
    modal.remove();
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bitrate }),
    });
    if (r.ok) {
      // Yerel cache gÃ¼ncelle
      if (window.currentServerChannels) {
        const idx = window.currentServerChannels.findIndex(c => c._id === channelId);
        if (idx !== -1) window.currentServerChannels[idx].bitrate = bitrate;
      }
      // Aktif baÄŸlantÄ±ya hemen uygula
      if (rtc?.isInVoice() && rtc.currentChannelId === channelId) {
        await rtc.setChannelBitrate(bitrate);
      }
      toast(`Bitrate gÃ¼ncellendi: ${kbps}kbps`, 'success');
    } else {
      const d = await r.json();
      toast(d.error || 'Hata', 'error');
    }
  };
}

// â”€â”€ NSFW overlay â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window._nsfwAccepted = window._nsfwAccepted || new Set();

function _showNsfwOverlay(channel) {
  document.getElementById('text-view').style.display = 'flex';
  document.getElementById('voice-view').style.display = 'none';
  document.getElementById('msg-input-wrap').style.display = 'none';
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.innerHTML = `
    <div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100%;gap:16px;padding:40px;text-align:center;">
      <div style="font-size:48px">ğŸ”</div>
      <div style="font-size:20px;font-weight:700;color:var(--text-primary)">#${escHtml(channel.name)}</div>
      <div style="font-size:14px;color:var(--text-muted);max-width:360px">
        Bu kanal <strong>yetiÅŸkinlere yÃ¶nelik (NSFW)</strong> iÃ§erik barÄ±ndÄ±rabilir. Devam etmek iÃ§in onaylayÄ±n.
      </div>
      <button onclick="_nsfwAcceptChannel('${channel._id}')" style="padding:10px 24px;background:#ed4245;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer;">
        Devam Et (18+)
      </button>
      <button onclick="selectChannel(channels.find(c=>c._id==='${channel._id}')?.previousSibling || currentChannel)" style="background:none;border:none;color:var(--text-muted);font-size:13px;cursor:pointer;text-decoration:underline">Geri DÃ¶n</button>
    </div>`;
}

function _nsfwAcceptChannel(channelId) {
  window._nsfwAccepted.add(channelId);
  const ch = (window.currentServerChannels || []).find(c => c._id === channelId);
  if (ch) selectChannel(ch);
}

// â”€â”€ Bridge info bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadBridgeInfo(channelId) {
  try {
    const r = await apiFetch(`${API}/api/bridges?channelId=${channelId}`);
    if (!r.ok) return;
    const bridges = await r.json();
    let bar = document.getElementById('bridge-info-bar');
    if (!bridges.length) { bar?.remove(); return; }
    if (!bar) {
      bar = document.createElement('div'); bar.id = 'bridge-info-bar'; bar.className = 'bridge-info-bar';
      document.getElementById('channel-header').after(bar);
    }
    bar.innerHTML = `ğŸŒ‰ <strong>Bridge aktif:</strong> ${bridges.map(b => `#${escHtml(b.label || b.targetChannelId.slice(0,8))}`).join(', ')} <button onclick="openBridgeModal()" style="margin-left:8px;background:none;border:none;cursor:pointer;color:var(--brand);font-size:12px;">YÃ¶net</button>`;
  } catch { /* ignore */ }
}

// â”€â”€ Channel context menu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openChannelMenu(channelId, channelName, e) {
  e.stopPropagation();
  document.getElementById('ch-ctx-menu')?.remove();
  const ch   = (window.currentServerChannels || []).find(c => c._id === channelId);
  const menu = document.createElement('div'); menu.id = 'ch-ctx-menu'; menu.className = 'ctx-menu';
  menu.style.cssText = `position:fixed;top:${e.clientY}px;left:${e.clientX}px;z-index:9999`;

  const nsfwLabel = ch?.nsfw ? 'âœ… NSFW (kaldÄ±r)' : 'ğŸ” NSFW olarak iÅŸaretle';
  menu.innerHTML = `
    <div class="ctx-item" id="ctx-rename">âœï¸ Yeniden AdlandÄ±r</div>
    <div class="ctx-item" id="ctx-nsfw">${nsfwLabel}</div>
    ${ch?.type === 'voice' ? `<div class="ctx-item" id="ctx-bitrate">ğŸ™ï¸ Ses Kalitesi (Bitrate)</div>` : ''}
    <div class="ctx-item" id="ctx-perms">ğŸ›¡ï¸ Ä°zinler</div>
    <div class="ctx-item" id="ctx-delete" style="color:var(--red)">ğŸ—‘ï¸ Sil</div>`;
  document.body.appendChild(menu);

  document.getElementById('ctx-rename').onclick = () => { menu.remove(); showRenameChannelModal(channelId, channelName); };
  document.getElementById('ctx-delete').onclick = () => { menu.remove(); showDeleteChannelModal(channelId, channelName); };
  document.getElementById('ctx-perms').onclick  = () => { menu.remove(); openChannelPermsModal(channelId, channelName); };
  document.getElementById('ctx-nsfw').onclick   = async () => {
    menu.remove();
    const newNsfw = ch ? !ch.nsfw : true;
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nsfw: newNsfw }),
    });
    if (r.ok) {
      if (ch) ch.nsfw = newNsfw;
      toast(newNsfw ? 'ğŸ” Kanal NSFW olarak iÅŸaretlendi' : 'NSFW kaldÄ±rÄ±ldÄ±', 'success');
      loadChannels(currentServer._id);
    } else { const d = await r.json(); toast(d.error || 'Hata', 'error'); }
  };
  if (ch?.type === 'voice') {
    document.getElementById('ctx-bitrate')?.addEventListener('click', () => { menu.remove(); _openVoiceBitrateSettings(channelId); });
  }
  setTimeout(() => document.addEventListener('click', () => menu.remove(), { once: true }), 10);
}

// â”€â”€ Rename / delete modals â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function showRenameChannelModal(channelId, oldName) {
  showInputModal({ title: `Rename #${oldName}`, label: 'New channel name', defaultValue: oldName, confirmText: 'Rename',
    onConfirm: async (name) => {
      if (!name || name.trim() === oldName) return;
      const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
      const data = await r.json(); if (!r.ok) return toast(data.error, 'error');
      toast('Channel renamed', 'success'); loadChannels(currentServer._id);
    }
  });
}

function showDeleteChannelModal(channelId, name) {
  showConfirmModal({ title: `Delete #${name}?`, message: 'All messages will be permanently lost.', confirmText: 'Delete', danger: true,
    onConfirm: async () => {
      const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}`, { method: 'DELETE' });
      const data = await r.json(); if (!r.ok) return toast(data.error, 'error');
      toast(`#${name} deleted`, 'success'); loadChannels(currentServer._id);
    }
  });
}

// â”€â”€ Create channel modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function createChannel() {
  _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal'; modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;width:95%">
      <h2>Kanal OluÅŸtur</h2>
      <div class="form-group">
        <label>Kanal AdÄ±</label>
        <input type="text" id="modal-input-field" class="input-field" placeholder="yeni-kanal" maxlength="32">
      </div>
      <div class="form-group" style="margin-top:10px">
        <label>Tip</label>
        <select id="modal-ch-type" class="input-field" onchange="_channelTypeChanged(this.value)">
          <option value="text"># Metin KanalÄ±</option>
          <option value="voice">ğŸ”Š Ses KanalÄ±</option>
          <option value="announcement">ğŸ“£ Duyuru KanalÄ±</option>
          <option value="forum">ğŸ“‹ Forum KanalÄ±</option>
          <option value="stage">ğŸ­ Sahne KanalÄ±</option>
        </select>
      </div>
      <div class="form-group" style="margin-top:10px">
        <label style="display:flex;align-items:center;gap:8px;cursor:pointer">
          <input type="checkbox" id="modal-ch-nsfw" style="width:16px;height:16px;cursor:pointer">
          <span>ğŸ” NSFW Kanal <span style="color:var(--text-muted);font-size:12px">(18+ uyarÄ±sÄ± gÃ¶sterir)</span></span>
        </label>
      </div>
      <div id="modal-bitrate-wrap" style="display:none;margin-top:10px">
        <label>Bitrate: <strong id="modal-bitrate-val">64</strong> kbps</label>
        <input type="range" id="modal-ch-bitrate" min="8" max="384" step="8" value="64"
          oninput="document.getElementById('modal-bitrate-val').textContent=this.value"
          style="width:100%;margin-top:6px">
      </div>
      <div class="modal-footer" style="margin-top:16px">
        <button class="btn btn-primary" id="modal-confirm-btn">OluÅŸtur</button>
        <button class="btn" id="modal-cancel-btn">Ä°ptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) _destroyTempModal(); };
  document.getElementById('modal-cancel-btn').onclick = _destroyTempModal;
  document.getElementById('modal-input-field').focus();
  document.getElementById('modal-confirm-btn').onclick = async () => {
    const name    = document.getElementById('modal-input-field')?.value?.trim();
    const type    = document.getElementById('modal-ch-type')?.value || 'text';
    const nsfw    = document.getElementById('modal-ch-nsfw')?.checked || false;
    const bitrate = parseInt(document.getElementById('modal-ch-bitrate')?.value || '64') * 1000;
    if (!name) return;
    _destroyTempModal();
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, type, nsfw, bitrate, category: 'GENERAL' }),
    });
    const data = await r.json();
    if (!r.ok) return toast(data.error, 'error');
    toast(`#${data.name} oluÅŸturuldu`, 'success');
    loadChannels(currentServer._id);
  };
}

function _channelTypeChanged(type) {
  const bitrateWrap = document.getElementById('modal-bitrate-wrap');
  if (bitrateWrap) bitrateWrap.style.display = type === 'voice' ? '' : 'none';

  // Forum hint
  let hint = document.getElementById('modal-type-hint');
  if (!hint) {
    hint = document.createElement('p');
    hint.id = 'modal-type-hint';
    hint.style.cssText = 'font-size:12px;color:var(--text-muted);margin-top:6px;';
    bitrateWrap?.insertAdjacentElement('afterend', hint);
  }
  const hints = {
    forum:        'ğŸ“‹ Ãœyeler konu baÅŸlÄ±ÄŸÄ± aÃ§ar; her konu ayrÄ± bir thread olur. Etiket sistemi ve sÄ±ralama desteklenir.',
    announcement: 'ğŸ“£ Sadece yÃ¶neticiler mesaj gÃ¶nderebilir. Ã–nemli duyurular iÃ§in idealdir.',
    stage:        'ğŸ­ KonuÅŸmacÄ±/dinleyici ayrÄ±mÄ± olan sesli kanal. Etkinlikler ve sunumlar iÃ§in.',
    voice:        'ğŸ”Š GerÃ§ek zamanlÄ± ses ve video kanalÄ±.',
    text:         '',
  };
  hint.textContent = hints[type] || '';
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// GENERIC MODAL HELPERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function showInputModal({ title, label, defaultValue = '', confirmText = 'OK', extras = '', onConfirm }) {
  _destroyTempModal();
  const modal = document.createElement('div'); modal.id = 'temp-modal'; modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-card" style="max-width:400px;width:95%"><h2>${escHtml(title)}</h2><div class="form-group"><label>${escHtml(label)}</label><input type="text" id="modal-input-field" class="input-field" value="${escHtml(defaultValue)}"></div>${extras}<div class="modal-footer"><button class="btn btn-primary" id="modal-confirm-btn">${escHtml(confirmText)}</button><button class="btn" id="modal-cancel-btn">Cancel</button></div></div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) _destroyTempModal(); };
  document.getElementById('modal-cancel-btn').onclick = _destroyTempModal;
  const field = document.getElementById('modal-input-field'); field.focus(); field.select();
  field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); _confirmTempModal(onConfirm); } if (e.key === 'Escape') _destroyTempModal(); });
  document.getElementById('modal-confirm-btn').onclick = () => _confirmTempModal(onConfirm);
}

function showConfirmModal({ title, message, confirmText = 'Confirm', danger = false, onConfirm }) {
  _destroyTempModal();
  const modal = document.createElement('div'); modal.id = 'temp-modal'; modal.className = 'modal-overlay';
  modal.innerHTML = `<div class="modal-card" style="max-width:380px;width:95%"><h2>${escHtml(title)}</h2><p style="color:var(--text-muted);margin-bottom:16px">${escHtml(message)}</p><div class="modal-footer"><button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" id="modal-confirm-btn">${escHtml(confirmText)}</button><button class="btn" id="modal-cancel-btn">Cancel</button></div></div>`;
  document.body.appendChild(modal);
  modal.onclick = (e) => { if (e.target === modal) _destroyTempModal(); };
  document.getElementById('modal-cancel-btn').onclick = _destroyTempModal;
  document.getElementById('modal-confirm-btn').onclick = () => { _destroyTempModal(); onConfirm(); };
  document.addEventListener('keydown', function esc(e) { if (e.key === 'Escape') { _destroyTempModal(); document.removeEventListener('keydown', esc); } });
}

function _confirmTempModal(onConfirm) { const val = document.getElementById('modal-input-field')?.value?.trim() ?? ''; _destroyTempModal(); onConfirm(val); }
function _destroyTempModal() { document.getElementById('temp-modal')?.remove(); }

