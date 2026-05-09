// core/server-settings.js
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Sunucu ayarlarÄ± UI: emoji yÃ¶netimi, sunucu ayarlarÄ± modalÄ±,
// banner/ikon yÃ¼kleme, webhook yÃ¶netimi, audit log export,
// SSO ayarlarÄ±, plugin yÃ¶netimi.
//
// Ã–nceki adÄ±: core/api.js (yanlÄ±ÅŸ isimlendirilmiÅŸti)
// apiFetch ve API sabiti: core/auth.js ve core/globals.js iÃ§inde
// â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

// â”€â”€â”€ SERVER EMOJI INLINE PICKER (in message box) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function toggleServerEmojiPicker() {
  const existing = document.getElementById('server-emoji-picker');
  if (existing) { existing.remove(); return; }
  if (!serverEmojiCache.length) { toast('HenÃ¼z emoji yok. SaÄŸ tÄ±kla â†’ Emoji YÃ¶netimi', 'error'); return; }

  const picker = document.createElement('div');
  picker.id = 'server-emoji-picker';

  // Arama kutusu
  const searchWrap = document.createElement('div');
  searchWrap.style.cssText = 'padding:6px 8px 4px;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Emoji ara...';
  searchInput.style.cssText = 'width:100%;box-sizing:border-box;padding:5px 8px;border-radius:6px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);font-size:12px;outline:none;';
  searchWrap.appendChild(searchInput);
  picker.appendChild(searchWrap);

  // Scroll alanÄ±
  const scrollArea = document.createElement('div');
  scrollArea.style.cssText = 'overflow-y:auto;max-height:260px;padding:0 4px 4px;';
  picker.appendChild(scrollArea);

  function renderEmojiGroups(filter = '') {
    scrollArea.innerHTML = '';
    // Sunucu bazlÄ± grupla
    const groups = {};
    for (const e of serverEmojiCache) {
      if (filter && !e.name.includes(filter.toLowerCase())) continue;
      const key = e.serverId;
      if (!groups[key]) groups[key] = { name: e.serverName || 'Sunucu', icon: e.serverIcon || 'ğŸŒ', emojis: [] };
      groups[key].emojis.push(e);
    }
    if (!Object.keys(groups).length) {
      scrollArea.innerHTML = '<div style="padding:8px;color:var(--text-muted);font-size:12px;text-align:center;">SonuÃ§ yok</div>';
      return;
    }
    for (const [sid, group] of Object.entries(groups)) {
      const label = document.createElement('div');
      label.className = 'sep-label';
      label.textContent = (group.icon + ' ' + group.name).toUpperCase();
      scrollArea.appendChild(label);
      const grid = document.createElement('div');
      grid.className = 'ep-grid';
      for (const e of group.emojis) {
        const btn = document.createElement('button');
        btn.title = ':' + e.name + ':';
        const img = document.createElement('img');
        img.src = API + e.url;
        img.alt = ':' + e.name + ':';
        img.style.cssText = 'width:28px;height:28px;object-fit:contain;border-radius:4px;';
        btn.appendChild(img);
        btn.addEventListener('click', () => { insertEmojiShortcode(':' + e.name + ':'); picker.remove(); });
        grid.appendChild(btn);
      }
      scrollArea.appendChild(grid);
    }
  }

  renderEmojiGroups();
  searchInput.addEventListener('input', () => renderEmojiGroups(searchInput.value.trim()));

  const triggerBtn = document.getElementById('server-emoji-picker-btn');
  const rect = triggerBtn?.getBoundingClientRect();
  if (rect) {
    picker.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
    picker.style.right = (window.innerWidth - rect.right) + 'px';
    picker.style.position = 'fixed';
  }
  document.body.appendChild(picker);
  searchInput.focus();
  setTimeout(() => {
    document.addEventListener('click', function h(e) {
      if (!picker.contains(e.target) && e.target !== triggerBtn) {
        picker.remove(); document.removeEventListener('click', h);
      }
    });
  }, 50);
}

function insertEmojiShortcode(code) {
  document.getElementById('server-emoji-picker')?.remove();
  const input = document.getElementById('msg-input');
  if (!input) return;
  const start = input.selectionStart, end = input.selectionEnd;
  const val = input.value;
  input.value = val.slice(0, start) + code + ' ' + val.slice(end);
  input.setSelectionRange(start + code.length + 1, start + code.length + 1);
  input.focus();
}

// â”€â”€â”€ SERVER EMOJI MANAGEMENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openEmojiManager() {
  const modal = document.createElement('div');
  modal.id = 'emoji-manager-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1000;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:520px;width:95%;max-height:80vh;display:flex;flex-direction:column;">
      <h2 style="margin-bottom:4px;">ğŸ˜€ Server Emojileri</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Nitro gerektirmez â€¢ Sunucuya Ã¶zel â€¢ <strong style="color:var(--brand)">SÄ±nÄ±rsÄ±z emoji</strong> â€¢ Cross-server kullanÄ±m</p>
      <div style="display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;">
        <input type="text" id="new-emoji-name" class="input-field" placeholder="emoji_adÄ± (a-z, 0-9, _)" style="flex:1;min-width:140px;" maxlength="32">
        <label class="btn btn-primary" style="cursor:pointer;white-space:nowrap;">
          ğŸ“¤ YÃ¼kle
          <input type="file" id="emoji-file-input" accept="image/png,image/gif,image/webp,image/jpeg" style="display:none" onchange="uploadServerEmoji(this)">
        </label>
      </div>
      <p style="font-size:11px;color:var(--text-muted);margin:-8px 0 12px;">PNG, GIF (animasyonlu!), WebP, JPEG â€¢ Max 256KB</p>
      <div id="emoji-manager-grid" style="flex:1;overflow-y:auto;display:grid;grid-template-columns:repeat(auto-fill,minmax(80px,1fr));gap:8px;"></div>
      <div class="modal-footer" style="margin-top:16px;"><button class="btn" onclick="document.getElementById('emoji-manager-modal').remove()">Kapat</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  await refreshEmojiGrid();
}

async function refreshEmojiGrid() {
  const grid = document.getElementById('emoji-manager-grid');
  if (!grid) return;
  grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;">YÃ¼kleniyor...</div>';
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/emojis`);
  const emojis = await r.json();
  serverEmojiCache = emojis; window._emojiMap = null;
  if (!emojis.length) {
    grid.innerHTML = '<div style="color:var(--text-muted);font-size:13px;padding:8px;grid-column:1/-1;">HenÃ¼z emoji yok. YÃ¼kle!</div>';
    return;
  }
  grid.innerHTML = '';
  for (const e of emojis) {
    const card = document.createElement('div');
    card.style.cssText = 'background:var(--bg-primary);border-radius:8px;padding:8px;text-align:center;position:relative;';
    const img = document.createElement('img');
    img.src = API + e.url;
    img.alt = ':' + e.name + ':';
    img.style.cssText = 'width:40px;height:40px;object-fit:contain;display:block;margin:0 auto 4px;';
    const nameDiv = document.createElement('div');
    nameDiv.style.cssText = 'font-size:10px;color:var(--text-muted);word-break:break-all;';
    nameDiv.textContent = ':' + e.name + ':';
    const delBtn = document.createElement('button');
    delBtn.style.cssText = 'position:absolute;top:2px;right:2px;background:var(--danger);border:none;color:#fff;border-radius:50%;width:16px;height:16px;font-size:10px;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;';
    delBtn.textContent = 'Ã—';
    const eid = e._id;
    delBtn.addEventListener('click', () => deleteServerEmoji(eid));
    card.appendChild(img);
    card.appendChild(nameDiv);
    card.appendChild(delBtn);
    grid.appendChild(card);
  }
}

async function uploadServerEmoji(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 256 * 1024) { toast('Max 256KB!', 'error'); input.value = ''; return; }
  const name = (document.getElementById('new-emoji-name') as HTMLInputElement | null)?.value ?? ''.trim().toLowerCase().replace(/[^a-z0-9_]/g,'_');
  if (!name) { toast('Emoji adÄ± gir!', 'error'); input.value = ''; return; }
  const fd = new FormData();
  fd.append('emoji', file);
  fd.append('name', name);
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/emojis`, { method:'POST', body: fd });
  if (!r.ok) { const d = await r.json(); toast(d.error || 'Hata', 'error'); input.value = ''; return; }
  toast(`âœ… :${name}: eklendi!`, 'success');
  { const _t = document.getElementById('new-emoji-name') as HTMLInputElement | null; if (_t) _t.value = ''; }
  input.value = '';
  await refreshEmojiGrid();
}

async function deleteServerEmoji(emojiId) {
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/emojis/${emojiId}`, { method:'DELETE' });
  if (!r.ok) { toast('Silinemedi', 'error'); return; }
  toast('Emoji silindi', 'success');
  await refreshEmojiGrid();
}

// â”€â”€â”€ SERVER BANNER & ICON UPLOAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openServerSettings() {
  const server = currentServer;
  if (!server) return;
  const modal = document.createElement('div');
  modal.id = 'server-settings-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1000;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%;max-height:85vh;overflow-y:auto;">
      <h2 style="margin-bottom:16px;">âš™ï¸ Sunucu AyarlarÄ±</h2>

      <div style="background:var(--bg-primary);border-radius:10px;overflow:hidden;margin-bottom:20px;">
        <div id="server-banner-preview" style="height:100px;background:${server.bannerUrl ? 'url(' + API + encodeURI(server.bannerUrl) + ') center/cover' : 'linear-gradient(135deg,#5865f2,#3ba55c)'};position:relative;">
          <label style="position:absolute;bottom:6px;right:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:4px 8px;border-radius:6px;cursor:pointer;">
            ğŸ“· Banner DeÄŸiÅŸtir
            <input type="file" accept="image/*" style="display:none" onchange="uploadServerBanner(this)">
          </label>
          ${server.bannerUrl ? `<button onclick="removeServerBanner()" style="position:absolute;bottom:6px;left:6px;background:rgba(0,0,0,.6);color:#fff;font-size:11px;padding:4px 8px;border-radius:6px;border:none;cursor:pointer;">ğŸ—‘ï¸ KaldÄ±r</button>` : ''}
        </div>
        <div style="padding:12px;display:flex;align-items:center;gap:12px;">
          <div id="server-icon-preview" style="width:56px;height:56px;border-radius:50%;background:${server.iconUrl ? 'url(' + API + encodeURI(server.iconUrl) + ') center/cover' : '#'+Math.floor(Math.random()*0xFFFFFF).toString(16).padStart(6,'0')};display:flex;align-items:center;justify-content:center;font-size:24px;border:3px solid var(--bg-secondary);flex-shrink:0;cursor:pointer;position:relative;" onclick="document.getElementById('server-icon-upload').click()">
            ${server.iconUrl ? '' : (server.icon || 'ğŸŒ')}
            <div style="position:absolute;inset:0;border-radius:50%;background:rgba(0,0,0,0);display:flex;align-items:center;justify-content:center;font-size:12px;color:#fff;transition:.2s" onmouseover="this.style.background='rgba(0,0,0,.5)';this.textContent='ğŸ“·'" onmouseout="this.style.background='rgba(0,0,0,0)';this.textContent=''"></div>
          </div>
          <input type="file" id="server-icon-upload" accept="image/*" style="display:none" onchange="uploadServerIconImage(this)">
          <div>
            <div style="font-weight:700;font-size:15px;">${escHtml(server.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);">Ä°kon iÃ§in tÄ±kla</div>
          </div>
        </div>
      </div>

      <div class="form-group">
        <label>Sunucu AdÄ±</label>
        <input type="text" id="srv-name-input" class="input-field" value="${escHtml(server.name)}" maxlength="50">
      </div>
      <div class="form-group">
        <label>Sunucu Ä°konu (emoji)</label>
        <input type="text" id="srv-icon-input" class="input-field" value="${escHtml(server.icon || 'ğŸŒ')}" maxlength="8">
      </div>

      <div class="form-group">
        <label>ğŸŒ Herkese AÃ§Ä±k Profil URL'si <span style="font-size:11px;color:var(--text-muted);font-weight:400">(opsiyonel)</span></label>
        <div style="display:flex;gap:8px;align-items:center">
          <span style="color:var(--text-muted);font-size:13px;white-space:nowrap">/s/</span>
          <input type="text" id="srv-slug-input" class="input-field" placeholder="sunucu-adim" maxlength="40"
            style="flex:1" oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-]/g,'')">
          <button class="btn" style="white-space:nowrap;padding:8px 12px;font-size:12px" onclick="saveServerSlug()">Kaydet</button>
        </div>
        <div id="srv-slug-preview" style="font-size:12px;color:var(--text-muted);margin-top:4px"></div>
      </div>

      <div style="border-top:1px solid var(--border);padding-top:16px;margin-top:8px;">
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;" onclick="openEmojiManager();document.getElementById('server-settings-modal').remove()">
          ğŸ˜€ Emoji YÃ¶netimi
        </button>
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;" onclick="openWebhookManager()">
          ğŸ”— Gelen Webhook YÃ¶netimi
        </button>
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;" onclick="openOutgoingWebhookManager();document.getElementById('server-settings-modal').remove()">
          ğŸ“¤ Giden Webhook YÃ¶netimi
        </button>
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;" onclick="openOnboardingSettings();document.getElementById('server-settings-modal').remove()">
          ğŸš€ Onboarding AyarlarÄ±
        </button>
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;" onclick="openAuditLogExport();document.getElementById('server-settings-modal').remove()">
          ğŸ“‹ Audit Log Export
        </button>
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;" onclick="openSSOSettings();document.getElementById('server-settings-modal').remove()">
          ğŸ” SSO / Kurumsal GiriÅŸ
        </button>
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;" onclick="openPluginManager();document.getElementById('server-settings-modal').remove()">
          ğŸ§© Plugin YÃ¶netimi
        </button>
        <button class="btn" style="width:100%;margin-bottom:8px;justify-content:center;background:linear-gradient(135deg,#5865F2,#4752C4);color:#fff;" onclick="if(window.openDiscordImport){document.getElementById('server-settings-modal').remove();window.openDiscordImport();}else{alert('Discord Import modÃ¼lÃ¼ yÃ¼klenmedi');}">
          <span style="margin-right:6px">ğŸ“¥</span> Discord'dan Ä°Ã§e Aktar
        </button>
      </div>

      <div class="modal-footer" style="margin-top:16px;">
        <button class="btn btn-primary" onclick="saveServerSettings()">Kaydet</button>
        <button class="btn" onclick="document.getElementById('server-settings-modal').remove()">Ä°ptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Mevcut slug'Ä± yÃ¼kle
  try {
    const sr = await apiFetch(`${API}/api/servers/${server._id}/slug`);
    if (sr.ok) {
      const sd = await sr.json();
      const slugInput = document.getElementById('srv-slug-input');
      if (slugInput && sd.slug) {
        slugInput.value = sd.slug;
        const preview = document.getElementById('srv-slug-preview');
        if (preview) preview.textContent = `Profil: ${window.location.origin}/s/${sd.slug}`;
      }
    }
  } catch { /* sessiz */ }
}

async function saveServerSettings() {
  const name = (document.getElementById('srv-name-input') as HTMLInputElement | null)?.value ?? ''.trim();
  const icon = (document.getElementById('srv-icon-input') as HTMLInputElement | null)?.value ?? ''.trim();
  if (!name) { toast('Sunucu adÄ± boÅŸ olamaz', 'error'); return; }
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}`, {
    method: 'PATCH', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name, icon })
  });
  if (!r.ok) { const d = await r.json(); toast(d.error || 'Hata', 'error'); return; }
  const updated = await r.json();
  currentServer = updated;
  document.getElementById('sidebar-server-name').textContent = updated.name;
  document.querySelector(`.server-icon[data-id="${updated._id}"]`)?.setAttribute('data-tip', updated.name);
  toast('Sunucu ayarlarÄ± kaydedildi', 'success');
  document.getElementById('server-settings-modal')?.remove();
}

async function saveServerSlug() {
  const input = document.getElementById('srv-slug-input');
  if (!input) return;
  const slug = input.value.trim();
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/slug`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ slug }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Hata', 'error');
  input.value = data.slug;
  const preview = document.getElementById('srv-slug-preview');
  if (preview) preview.textContent = `Profil: ${window.location.origin}/s/${data.slug}`;
  toast(`Profil URL ayarlandÄ±: /s/${data.slug}`, 'success');
}

async function uploadServerBanner(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('Max 8MB!', 'error'); return; }
  const fd = new FormData(); fd.append('banner', file);
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/banner`, { method:'POST', body: fd });
  if (!r.ok) { const d = await r.json(); toast(d.error||'Hata','error'); return; }
  const data = await r.json();
  currentServer.bannerUrl = data.bannerUrl;
  const preview = document.getElementById('server-banner-preview');
  if (preview) preview.style.background = `url(${API}${data.bannerUrl}) center/cover`;
  toast('Banner gÃ¼ncellendi âœ…', 'success');
}

async function removeServerBanner() {
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/banner`, { method:'DELETE' });
  if (!r.ok) return;
  currentServer.bannerUrl = null;
  const preview = document.getElementById('server-banner-preview');
  if (preview) preview.style.background = 'linear-gradient(135deg,#5865f2,#3ba55c)';
  toast('Banner kaldÄ±rÄ±ldÄ±', 'success');
}

async function uploadServerIconImage(input) {
  const file = input.files[0];
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { toast('Max 8MB!', 'error'); return; }
  const fd = new FormData(); fd.append('icon', file);
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/icon-image`, { method:'POST', body: fd });
  if (!r.ok) { const d = await r.json(); toast(d.error||'Hata','error'); return; }
  const data = await r.json();
  currentServer.iconUrl = data.iconUrl;
  const preview = document.getElementById('server-icon-preview');
  if (preview) { preview.style.background = `url(${API}${data.iconUrl}) center/cover`; preview.textContent = ''; }
  toast('Sunucu ikonu gÃ¼ncellendi âœ…', 'success');
}

async function openWebhookManager() {
  if (!currentServer) return;
  const channels = serverChannels.filter(c => c.type === 'text');

  const modal = document.createElement('div');
  modal.id = 'webhook-manager-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1100;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:520px;width:95%;max-height:85vh;overflow-y:auto;">
      <h2 style="margin-bottom:4px;">ğŸ”— Webhook YÃ¶netimi</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">
        Webhooklar; GitHub, Stripe gibi dÄ±ÅŸ servislerin kanalÄ±nÄ±za mesaj gÃ¶ndermesini saÄŸlar.
      </p>

      <div class="form-group">
        <label>Yeni Webhook</label>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <select id="wh-channel-select" class="input-field" style="flex:1;">
            ${channels.map(c => `<option value="${escHtml(c._id)}">#${escHtml(c.name)}</option>`).join('')}
          </select>
          <input type="text" id="wh-name-input" class="input-field" placeholder="Webhook adÄ±" maxlength="80" style="flex:1.5;">
          <button class="btn btn-primary" onclick="createWebhook()" style="white-space:nowrap;">+ OluÅŸtur</button>
        </div>
      </div>

      <div id="webhook-list" style="margin-top:12px;">
        <div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">â³ YÃ¼kleniyorâ€¦</div>
      </div>

      <div class="modal-footer" style="margin-top:16px;">
        <button class="btn" onclick="document.getElementById('webhook-manager-modal').remove()">Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Load webhooks for all text channels
  await loadWebhookList();
}

async function loadWebhookList() {
  const listEl = document.getElementById('webhook-list');
  if (!listEl) return;

  const channels = serverChannels.filter(c => c.type === 'text');
  let allWebhooks = [];

  for (const ch of channels) {
    try {
      const r = await apiFetch(`${API}/api/channels/${ch._id}/webhooks`);
      if (r.ok) {
        const whs = await r.json();
        allWebhooks.push(...whs.map(w => ({ ...w, channelName: ch.name })));
      }
    } catch { /* skip */ }
  }

  if (!allWebhooks.length) {
    listEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">HenÃ¼z webhook yok.</div>`;
    return;
  }

  listEl.innerHTML = allWebhooks.map(w => `
    <div class="webhook-item" style="background:var(--bg-primary);border-radius:8px;padding:12px;margin-bottom:8px;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
        <div style="min-width:0;">
          <div style="font-weight:600;font-size:14px;">ğŸ”— ${escHtml(w.name)}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:2px;">#${escHtml(w.channelName)}</div>
        </div>
        <button class="btn" style="font-size:11px;padding:4px 10px;flex-shrink:0;color:var(--danger);"
          onclick="deleteWebhook('${escHtml(w.channelId)}','${escHtml(w._id)}')">ğŸ—‘ï¸ Sil</button>
      </div>
      <div style="margin-top:8px;display:flex;gap:6px;align-items:center;">
        <input readonly value="${location.origin}${escHtml(w.url)}"
          style="flex:1;font-size:11px;font-family:monospace;background:var(--bg-secondary);border:1px solid var(--border);border-radius:6px;padding:5px 8px;color:var(--text-muted);"
          onclick="this.select()">
        <button class="btn" style="font-size:11px;padding:4px 10px;flex-shrink:0;"
          onclick="navigator.clipboard.writeText('${location.origin}${escHtml(w.url)}').then(()=>toast('KopyalandÄ±!','success'))">
          ğŸ“‹ Kopyala
        </button>
      </div>
    </div>`).join('');
}

async function createWebhook() {
  const channelId = document.getElementById('wh-channel-select')?.value;
  const name      = document.getElementById('wh-name-input')?.value.trim();
  if (!channelId || !name) { toast('Kanal ve ad gerekli', 'error'); return; }

  const r = await apiFetch(`${API}/api/channels/${channelId}/webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const d = await r.json();
  if (!r.ok) { toast(d.error || 'Hata', 'error'); return; }

  { const _t = document.getElementById('wh-name-input') as HTMLInputElement | null; if (_t) _t.value = ''; }
  toast('Webhook oluÅŸturuldu!', 'success');
  await loadWebhookList();
}

async function deleteWebhook(channelId, webhookId) {
  if (!confirm('Bu webhook\'u silmek istediÄŸinizden emin misiniz?')) return;
  const r = await apiFetch(`${API}/api/channels/${channelId}/webhooks/${webhookId}`, { method: 'DELETE' });
  if (!r.ok) { const d = await r.json(); toast(d.error || 'Silinemedi', 'error'); return; }
  toast('Webhook silindi', 'success');
  await loadWebhookList();
}

// â”€â”€ v70: Audit Log Export Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openAuditLogExport() {
  const server = currentServer;
  if (!server) return;

  const modal = document.createElement('div');
  modal.id = 'audit-export-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1001;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:500px;width:95%;max-height:85vh;overflow-y:auto;">
      <h2 style="margin-bottom:16px;">ğŸ“‹ Audit Log Export</h2>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:16px;">
        <div class="form-group">
          <label>BaÅŸlangÄ±Ã§ Tarihi</label>
          <input type="date" id="al-after"  class="input-field">
        </div>
        <div class="form-group">
          <label>BitiÅŸ Tarihi</label>
          <input type="date" id="al-before" class="input-field">
        </div>
      </div>

      <div class="form-group" style="margin-bottom:16px;">
        <label>Aksiyon Filtresi <span style="font-size:11px;color:var(--text-muted)">(boÅŸ = tÃ¼mÃ¼)</span></label>
        <select id="al-action" class="input-field">
          <option value="">TÃ¼m aksiyonlar</option>
          <option value="kick">Kick</option>
          <option value="ban">Ban</option>
          <option value="timeout">Timeout</option>
          <option value="message:delete">Mesaj Silme</option>
          <option value="role:assign">Rol Atama</option>
          <option value="channel:create">Kanal OluÅŸturma</option>
          <option value="channel:delete">Kanal Silme</option>
          <option value="server:update">Sunucu GÃ¼ncelleme</option>
        </select>
      </div>

      <div style="margin-bottom:16px;">
        <label style="font-size:13px;font-weight:600;display:block;margin-bottom:6px;">Ã–nizleme (son 10)</label>
        <div id="al-preview" style="background:var(--bg-1);border-radius:8px;padding:10px;max-height:200px;overflow-y:auto;font-size:12px;font-family:monospace;color:var(--text-2);">
          <div style="color:var(--text-muted)">YÃ¼klemek iÃ§in "Ã–nizle" tÄ±klayÄ±n</div>
        </div>
      </div>

      <div class="modal-footer" style="gap:8px;flex-wrap:wrap;">
        <button class="btn btn-primary" onclick="alPreview()">ğŸ‘ï¸ Ã–nizle</button>
        <button class="btn btn-primary" onclick="alExport('csv')" style="background:var(--green)">â¬‡ï¸ CSV Ä°ndir</button>
        <button class="btn btn-primary" onclick="alExport('json')" style="background:#f0a020">â¬‡ï¸ JSON Ä°ndir</button>
        <button class="btn" onclick="document.getElementById('audit-export-modal').remove()">Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

function _alBuildParams(extra = {}) {
  const after  = document.getElementById('al-after')?.value;
  const before = document.getElementById('al-before')?.value;
  const action = document.getElementById('al-action')?.value;
  const p = { ...extra };
  if (after)  p.after  = after;
  if (before) p.before = before;
  if (action) p.action = action;
  return new URLSearchParams(p).toString();
}

async function alPreview() {
  const srv = currentServer;
  const el  = document.getElementById('al-preview');
  if (!el || !srv) return;
  el.innerHTML = '<div style="color:var(--text-muted)">YÃ¼kleniyorâ€¦</div>';
  try {
    const qs = _alBuildParams({ limit: 10 });
    const r  = await apiFetch(`${API}/api/servers/${srv._id}/audit-log?${qs}`);
    const d  = await r.json();
    const logs = d.logs || d;
    if (!logs.length) { el.innerHTML = '<div style="color:var(--text-muted)">KayÄ±t bulunamadÄ±</div>'; return; }
    el.innerHTML = logs.map(l => {
      const dt = new Date(l.createdAt).toLocaleString('tr-TR');
      return `<div style="border-bottom:1px solid var(--bg-5);padding:4px 0;"><span style="color:var(--text-3)">${escHtml(dt)}</span> <b>${escHtml(l.action || '')}</b> ${escHtml(l.actorName || '')} â†’ ${escHtml(l.targetName || '')}</div>`;
    }).join('');
  } catch { el.innerHTML = '<div style="color:var(--red)">YÃ¼kleme baÅŸarÄ±sÄ±z</div>'; }
}

async function alExport(format) {
  const srv = currentServer;
  if (!srv) return;
  const qs  = _alBuildParams({ format });
  const url = `${API}/api/servers/${srv._id}/audit-log/export?${qs}`;
  // Dosya indirme
  const a = document.createElement('a');
  a.href = url;
  a.download = `audit-${srv._id}-${Date.now()}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  toast(`Audit log ${format.toUpperCase()} indiriliyorâ€¦`, 'success');
}

// â”€â”€ v70: SSO AyarlarÄ± Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openSSOSettings() {
  const modal = document.createElement('div');
  modal.id = 'sso-settings-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1001;';

  let cfg = {};
  try {
    const r = await apiFetch(`${API}/api/sso/config`);
    if (r.ok) cfg = await r.json();
  } catch {}

  const oidcEnabled = cfg.oidc?.enabled ? 'âœ… Aktif' : 'â›” Pasif';
  const samlEnabled = cfg.saml?.enabled ? 'âœ… Aktif' : 'â›” Pasif';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:500px;width:95%;max-height:85vh;overflow-y:auto;">
      <h2 style="margin-bottom:16px;">ğŸ” SSO / Kurumsal GiriÅŸ</h2>

      <div style="background:var(--bg-1);border-radius:10px;padding:14px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:10px;">Durum</div>
        <div style="display:flex;gap:16px;">
          <div><b>OIDC:</b> ${oidcEnabled}</div>
          <div><b>SAML:</b> ${samlEnabled}</div>
        </div>
      </div>

      <div style="background:var(--bg-1);border-radius:10px;padding:14px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;">OIDC (OpenID Connect)</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
          .env dosyasÄ±na ÅŸunlarÄ± ekleyin:
        </div>
        <pre style="background:var(--bg-3);padding:10px;border-radius:8px;font-size:11px;overflow-x:auto;margin:0;">OIDC_ENABLED=true
OIDC_ISSUER=https://accounts.google.com
OIDC_CLIENT_ID=your-client-id
OIDC_CLIENT_SECRET=your-client-secret
OIDC_SCOPES=openid email profile</pre>
        <div style="margin-top:8px;font-size:12px;color:var(--text-muted)">
          GiriÅŸ URL: <code style="background:var(--bg-3);padding:2px 6px;border-radius:4px;">/api/sso/oidc/start</code>
        </div>
      </div>

      <div style="background:var(--bg-1);border-radius:10px;padding:14px;margin-bottom:16px;">
        <div style="font-size:13px;font-weight:700;margin-bottom:8px;">SAML 2.0</div>
        <div style="font-size:12px;color:var(--text-muted);margin-bottom:8px;">
          .env dosyasÄ±na ÅŸunlarÄ± ekleyin:
        </div>
        <pre style="background:var(--bg-3);padding:10px;border-radius:8px;font-size:11px;overflow-x:auto;margin:0;">SAML_ENABLED=true
SAML_ENTRY_POINT=https://idp.example.com/sso/saml
SAML_ISSUER=https://bridge.example.com</pre>
        ${cfg.metadataUrl ? `<div style="margin-top:8px;font-size:12px;color:var(--text-muted)">SP Metadata: <a href="${escHtml(cfg.metadataUrl)}" target="_blank" style="color:var(--brand)">${escHtml(cfg.metadataUrl)}</a></div>` : ''}
      </div>

      <div style="background:var(--bg-3);border-radius:8px;padding:10px;margin-bottom:16px;font-size:12px;color:var(--text-muted);">
        ğŸ’¡ SSO ile giriÅŸ yapan kullanÄ±cÄ±lar ÅŸifre olmadan hesap oluÅŸturur. E-posta eÅŸleÅŸmesi ile mevcut hesaplara SSO baÄŸlanÄ±r.
      </div>

      <div class="modal-footer">
        <button class="btn" onclick="document.getElementById('sso-settings-modal').remove()">Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

// â”€â”€ v70: Plugin YÃ¶netimi Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openPluginManager() {
  const modal = document.createElement('div');
  modal.id = 'plugin-manager-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1001;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:520px;width:95%;max-height:85vh;overflow-y:auto;">
      <h2 style="margin-bottom:4px;">ğŸ§© Plugin YÃ¶netimi</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Sunucuda yÃ¼klÃ¼ aktif plugin'ler</p>
      <div id="plugin-list">
        <div style="text-align:center;padding:20px;color:var(--text-muted)">YÃ¼kleniyorâ€¦</div>
      </div>
      <div style="background:var(--bg-1);border-radius:8px;padding:12px;margin-top:16px;font-size:12px;color:var(--text-muted);">
        ğŸ’¡ Plugin eklemek iÃ§in <code style="background:var(--bg-3);padding:1px 5px;border-radius:4px;">plugins/</code> klasÃ¶rÃ¼ne yeni bir dizin ekleyin ve sunucuyu yeniden baÅŸlatÄ±n.
        <a href="https://github.com/bridge/bridge/blob/main/plugins/README.md" target="_blank" style="color:var(--brand);display:block;margin-top:4px;">ğŸ“– Plugin GeliÅŸtirme KÄ±lavuzu â†’</a>
      </div>
      <div class="modal-footer" style="margin-top:16px;">
        <button class="btn" onclick="document.getElementById('plugin-manager-modal').remove()">Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });

  // Plugin listesini yÃ¼kle
  try {
    const r = await apiFetch(`${API}/api/plugins`);
    const plugins = r.ok ? await r.json() : [];
    const el = document.getElementById('plugin-list');
    if (!plugins.length) {
      el.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">YÃ¼klÃ¼ plugin bulunamadÄ±</div>';
      return;
    }
    el.innerHTML = plugins.map(p => `
      <div style="background:var(--bg-1);border-radius:10px;padding:14px;margin-bottom:10px;display:flex;gap:12px;align-items:flex-start;">
        <div style="font-size:28px;flex-shrink:0;">ğŸ§©</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:14px;">${escHtml(p.name || p.id)}</div>
          <div style="font-size:11px;color:var(--brand);margin-bottom:4px;">v${escHtml(p.version || '?')} Â· ${escHtml(p.author || 'Bilinmeyen')}</div>
          ${p.description ? `<div style="font-size:12px;color:var(--text-muted);">${escHtml(p.description)}</div>` : ''}
        </div>
        <span style="background:var(--green);color:#fff;font-size:10px;font-weight:700;padding:2px 8px;border-radius:10px;flex-shrink:0;">AKTÄ°F</span>
      </div>`).join('');
  } catch {
    const el = document.getElementById('plugin-list');
    if (el) el.innerHTML = '<div style="color:var(--red);padding:16px">Plugin listesi alÄ±namadÄ±</div>';
  }
}

