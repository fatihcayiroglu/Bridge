// client/js/core/search.js
// Gelişmiş arama — filtre chip'leri, tarih aralığı,
//      from:kullanıcı, has:file/image/link, sayfalama

'use strict';

// ── ARAMA DURUMU ──────────────────────────────────────────────
let gsTab     = 'all';
let gsTimer   = null;
let gsFilters = {};          // { has: 'file', from: 'aliid', after: '...', before: '...' }
let gsFromMap = {};          // userId → displayName (chip label için)
let gsPage    = 0;
const GS_PAGE_SIZE = 25;

// ── CTRL+K KLAVYE KISAYOLU ────────────────────────────────────
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    openGlobalSearch();
  }
  if (e.key === 'Escape') {
    closeGlobalSearch();
    closePinsPanel();
  }
});

// ── GLOBAL SEARCH ─────────────────────────────────────────────
function openGlobalSearch() {
  const modal = document.getElementById('global-search-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  setTimeout(() => document.getElementById('gs-input')?.focus(), 50);
  gsRenderChips();
}

function closeGlobalSearch() {
  const modal = document.getElementById('global-search-modal');
  if (modal) modal.style.display = 'none';
}

function switchGsTab(tab, btn) {
  gsTab = tab;
  gsPage = 0;
  document.querySelectorAll('.gs-tab').forEach(b => b.classList.remove('active'));
  btn?.classList.add('active');
  // Hızlı filtreler sadece mesaj aramada anlamlı
  const qf = document.getElementById('gs-quick-filters');
  if (qf) qf.style.display = (tab === 'all' || tab === 'messages') ? '' : 'none';
  const q = document.getElementById('gs-input')?.value?.trim();
  if (q) doGlobalSearch(q);
}

function onGlobalSearch(val) {
  clearTimeout(gsTimer);
  gsPage = 0;
  if (!val.trim()) {
    const res = document.getElementById('gs-results');
    if (res) res.innerHTML = '<div class="gs-empty">Aramak için yazmaya başlayın…<br><span class="gs-hint">İpucu: <code>from:ali</code> · <code>has:file</code> · <code>before:2025-06-01</code></span></div>';
    document.getElementById('gs-pagination').style.display = 'none';
    return;
  }
  gsTimer = setTimeout(() => doGlobalSearch(val), 300);
}

async function doGlobalSearch(q) {
  if (!q?.trim() || !currentServer) return;
  const res = document.getElementById('gs-results');
  if (!res) return;
  res.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Aranıyor…</div>';

  try {
    // Filtre state'ini URL param'larına dönüştür
    const params = new URLSearchParams({
      q,
      serverId: currentServer._id,
      type:     gsTab,
      offset:   gsPage * GS_PAGE_SIZE,
      limit:    GS_PAGE_SIZE,
    });
    if (gsFilters.has)    params.set('has',    gsFilters.has);
    if (gsFilters.from)   params.set('from',   gsFilters.from);
    if (gsFilters.after)  params.set('after',  gsFilters.after);
    if (gsFilters.before) params.set('before', gsFilters.before);

    const r    = await apiFetch(`${API}/api/search?${params}`);
    const data = await r.json();
    if (!r.ok) {
      res.innerHTML = `<div style="color:var(--red);padding:16px">${escHtml(data.error || 'Arama başarısız')}</div>`;
      return;
    }
    renderGsResults(data, q);
    // Sayfalama
    gsRenderPagination(data.hasMore);
  } catch (err) {
    res.innerHTML = `<div style="color:var(--red);padding:16px">Bağlantı hatası</div>`;
  }
}

// ── v69: Sayfalama ─────────────────────────────────────────────
function gsChangePage(delta) {
  gsPage = Math.max(0, gsPage + delta);
  const q = document.getElementById('gs-input')?.value?.trim();
  if (q) doGlobalSearch(q);
  document.getElementById('gs-results')?.scrollTo(0, 0);
}

function gsRenderPagination(hasMore) {
  const bar  = document.getElementById('gs-pagination');
  const prev = document.getElementById('gs-prev');
  const next = document.getElementById('gs-next');
  const info = document.getElementById('gs-page-info');
  if (!bar) return;

  const show = gsPage > 0 || hasMore;
  bar.style.display = show ? '' : 'none';
  if (!show) return;

  if (prev) prev.disabled = gsPage === 0;
  if (next) next.disabled = !hasMore;
  if (info) info.textContent = `Sayfa ${gsPage + 1}`;
}

// ── v69: Filtreler ─────────────────────────────────────────────
function gsToggleFilter(key, val) {
  if (gsFilters[key] === val) {
    delete gsFilters[key];
  } else {
    gsFilters[key] = val;
  }
  gsPage = 0;
  gsRenderChips();
  gsUpdateQuickFilterButtons();
  const q = document.getElementById('gs-input')?.value?.trim();
  if (q) doGlobalSearch(q);
}

function gsClearFilters() {
  gsFilters = {};
  gsFromMap  = {};
  gsPage     = 0;
  document.getElementById('gs-from-input') && (document.getElementById('gs-from-input').value = '');
  document.getElementById('gs-date-after')  && (document.getElementById('gs-date-after').value  = '');
  document.getElementById('gs-date-before') && (document.getElementById('gs-date-before').value = '');
  gsClosePickers();
  gsRenderChips();
  gsUpdateQuickFilterButtons();
  const q = document.getElementById('gs-input')?.value?.trim();
  if (q) doGlobalSearch(q);
}

function gsRenderChips() {
  const container = document.getElementById('gs-chips');
  const clearBtn  = document.getElementById('gsf-clear');
  if (!container) return;

  const chips = [];
  if (gsFilters.has)   chips.push({ label: `📎 ${gsFilters.has}`,                    key: 'has'   });
  if (gsFilters.from)  chips.push({ label: `👤 ${gsFromMap[gsFilters.from] || gsFilters.from}`, key: 'from'  });
  if (gsFilters.after) chips.push({ label: `📅 ${gsFilters.after} sonrası`,           key: 'after' });
  if (gsFilters.before)chips.push({ label: `📅 ${gsFilters.before} öncesi`,           key: 'before'});

  container.style.display = chips.length ? 'flex' : 'none';
  if (clearBtn) clearBtn.style.display = chips.length ? '' : 'none';
  container.innerHTML = chips.map(c =>
    `<span class="gs-chip">${escHtml(c.label)}<button onclick="gsRemoveFilter('${c.key}')">×</button></span>`
  ).join('');
}

function gsRemoveFilter(key) {
  delete gsFilters[key];
  if (key === 'from') delete gsFromMap[gsFilters.from];
  gsPage = 0;
  gsRenderChips();
  gsUpdateQuickFilterButtons();
  const q = document.getElementById('gs-input')?.value?.trim();
  if (q) doGlobalSearch(q);
}

function gsUpdateQuickFilterButtons() {
  const map = { 'gsf-file': gsFilters.has === 'file', 'gsf-image': gsFilters.has === 'image', 'gsf-link': gsFilters.has === 'link' };
  for (const [id, active] of Object.entries(map)) {
    document.getElementById(id)?.classList.toggle('active', active);
  }
  const hasFilt = Object.keys(gsFilters).length > 0;
  document.getElementById('gsf-clear').style.display = hasFilt ? '' : 'none';
}

// ── v69: Kişi seçici ───────────────────────────────────────────
function gsOpenFromPicker() {
  const picker = document.getElementById('gs-from-picker');
  const date   = document.getElementById('gs-date-picker');
  if (!picker) return;
  const isOpen = picker.style.display !== 'none';
  gsClosePickers();
  if (!isOpen) {
    picker.style.display = '';
    document.getElementById('gs-from-input')?.focus();
  }
}

async function gsFromSearch(val) {
  const res = document.getElementById('gs-from-results');
  if (!res || !currentServer) return;
  if (!val.trim()) { res.innerHTML = ''; return; }
  try {
    const r    = await apiFetch(`${API}/api/servers/${currentServer._id}/members/search?q=${encodeURIComponent(val)}`);
    const data = await r.json();
    const members = (data.members || data || []).slice(0, 8);
    res.innerHTML = members.map(m => `
      <div class="gs-picker-item" onclick="gsSelectFrom('${m._id || m.userId}','${escHtml(m.displayName || m.username)}')">
        <div class="gs-avatar sm" style="background:${m.avatarColor||'#4f8ef7'}">${initials(m.displayName||m.username)}</div>
        <span>${escHtml(m.displayName || m.username)}</span>
      </div>`).join('');
  } catch { res.innerHTML = ''; }
}

function gsSelectFrom(userId, name) {
  gsFilters.from     = userId;
  gsFromMap[userId]  = name;
  gsPage             = 0;
  gsClosePickers();
  gsRenderChips();
  gsUpdateQuickFilterButtons();
  document.getElementById('gsf-from')?.classList.add('active');
  const q = document.getElementById('gs-input')?.value?.trim();
  if (q) doGlobalSearch(q);
}

// ── v69: Tarih seçici ──────────────────────────────────────────
function gsOpenDatePicker() {
  const picker = document.getElementById('gs-date-picker');
  const from   = document.getElementById('gs-from-picker');
  if (!picker) return;
  const isOpen = picker.style.display !== 'none';
  gsClosePickers();
  if (!isOpen) picker.style.display = 'flex';
}

function gsApplyDate() {
  const after  = document.getElementById('gs-date-after')?.value;
  const before = document.getElementById('gs-date-before')?.value;
  if (after)  gsFilters.after  = after;  else delete gsFilters.after;
  if (before) gsFilters.before = before; else delete gsFilters.before;
  gsPage = 0;
  gsRenderChips();
  gsUpdateQuickFilterButtons();
}

function gsCloseDatePicker() {
  document.getElementById('gs-date-picker').style.display = 'none';
  const q = document.getElementById('gs-input')?.value?.trim();
  if (q) doGlobalSearch(q);
}

function gsClosePickers() {
  const fp = document.getElementById('gs-from-picker');
  const dp = document.getElementById('gs-date-picker');
  if (fp) fp.style.display = 'none';
  if (dp) dp.style.display = 'none';
}

function renderGsResults(data, q) {
  const res = document.getElementById('gs-results');
  if (!res) return;

  // Filtreleri sorgu metninden çıkar (pure arama kelimesi için highlight)
  const pureQ = q.replace(/\b(from|before|after|has|in):\S+/g, '').trim();

  const highlight = (text) => {
    if (!text) return '';
    const safe = escHtml(text);
    if (!pureQ) return safe;
    return safe.replace(
      new RegExp(escHtml(pureQ).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'),
      m => `<mark class="gs-hl">${m}</mark>`
    );
  };

  const msgs    = data.messages || [];
  const members = data.members  || [];
  const chans   = data.channels || [];

  if (!msgs.length && !members.length && !chans.length) {
    const filtersActive = Object.keys(gsFilters).length > 0;
    res.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted);">
      <div style="font-size:32px;margin-bottom:8px">🔍</div>
      <p>"${escHtml(pureQ || q)}" için sonuç bulunamadı</p>
      ${filtersActive ? '<p style="font-size:12px">Filtreleri temizlemeyi deneyin</p>' : ''}
    </div>`;
    return;
  }

  let html = '';

  // ── Kanallar ─────────────────────────────────────────────────
  if (chans.length) {
    html += `<div class="gs-section-label">📢 Kanallar (${chans.length})</div>`;
    html += chans.map(c => `
      <div class="gs-item" onclick="jumpToChannel('${c._id}','${currentServer._id}');closeGlobalSearch()">
        <span class="gs-icon-ch">#</span>
        <div class="gs-item-body">
          <div class="gs-item-title">${highlight(c.name)}</div>
          ${c.topic ? `<div class="gs-item-sub">${highlight(c.topic.slice(0, 80))}</div>` : ''}
        </div>
        ${c.memberCount ? `<span class="gs-badge">${c.memberCount}</span>` : ''}
      </div>`).join('');
  }

  // ── Üyeler ───────────────────────────────────────────────────
  if (members.length) {
    html += `<div class="gs-section-label">👥 Üyeler (${members.length})</div>`;
    html += members.map(m => `
      <div class="gs-item" onclick="openDmWithUser('${m._id}','${escHtml(m.displayName)}','${m.avatarColor || '#4f8ef7'}');closeGlobalSearch()">
        <div class="gs-avatar" style="background:${m.avatarColor || '#4f8ef7'}">${initials(m.displayName)}</div>
        <div class="gs-item-body">
          <div class="gs-item-title">${highlight(m.displayName)}</div>
          <div class="gs-item-sub">@${highlight(m.username)}</div>
        </div>
        <button class="gs-action-btn" onclick="event.stopPropagation();gsFilterFrom('${m._id}','${escHtml(m.displayName)}')" title="Bu kişiden mesajları ara">🔍</button>
      </div>`).join('');
  }

  // ── Mesajlar ─────────────────────────────────────────────────
  if (msgs.length) {
    html += `<div class="gs-section-label">💬 Mesajlar (${msgs.length}${data.hasMore ? '+' : ''})</div>`;
    html += msgs.map(m => {
      const d       = new Date(m.createdAt).toLocaleString('tr-TR', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
      const hasFile = m.attachments?.length > 0;
      const hasImg  = m.attachments?.some(a => /\.(png|jpg|jpeg|gif|webp|svg)$/i.test(a.name || a.url || ''));
      const badge   = hasImg ? '<span class="gs-att-badge">🖼️</span>' : hasFile ? '<span class="gs-att-badge">📎</span>' : '';
      const chanName = m.channelName ? `<span class="gs-msg-ch">#${escHtml(m.channelName)}</span>` : '';

      return `
        <div class="gs-item gs-msg-item" onclick="jumpToMessage('${m._id}','${m.channelId}','${currentServer._id}');closeGlobalSearch()">
          <div class="gs-avatar" style="background:${m.avatarColor || '#4f8ef7'}">${initials(m.displayName || '?')}</div>
          <div class="gs-item-body">
            <div class="gs-item-title">
              <span class="gs-sender">${highlight(m.displayName)}</span>
              ${chanName}
              <span class="gs-msg-date">${d}</span>
              ${badge}
            </div>
            <div class="gs-item-sub gs-msg-content">${highlight(m.content?.slice(0, 150) || '')}</div>
            ${hasImg && m.attachments[0]?.url ? `<img class="gs-thumb" src="${escHtml(m.attachments[0].url)}" alt="" loading="lazy">` : ''}
          </div>
          <button class="gs-action-btn" onclick="event.stopPropagation();copyToClipboard('${escHtml(m.content?.slice(0,200)||'')}');" title="İçeriği kopyala">📋</button>
        </div>`;
    }).join('');
  }

  res.innerHTML = html;
}

// "Bu kişiden ara" kısayolu (üye listesindeki buton)
function gsFilterFrom(userId, name) {
  gsFilters.from     = userId;
  gsFromMap[userId]  = name;
  gsPage             = 0;
  gsTab              = 'messages';
  document.querySelectorAll('.gs-tab').forEach(b => b.classList.remove('active'));
  document.getElementById('gs-tab-messages')?.classList.add('active');
  gsRenderChips();
  gsUpdateQuickFilterButtons();
  const q = document.getElementById('gs-input')?.value?.trim() || ' ';
  doGlobalSearch(q);
}

function handleGsKey(e) {
  if (e.key === 'Escape') closeGlobalSearch();
}

async function jumpToChannel(channelId, serverId) {
  closeGlobalSearch();
  if (serverId !== currentServer?._id) {
    await selectServer(serverId);
  }
  const ch = { _id: channelId };
  await selectChannel(ch);
}

async function jumpToMessage(msgId, channelId, serverId) {
  await jumpToChannel(channelId, serverId);
  setTimeout(() => scrollToMsg(msgId), 800);
}

// ── PIN PANEL ─────────────────────────────────────────────────
async function openPinsPanel() {
  if (!currentChannel) return toast('Önce bir kanal seç', 'error');
  let panel = document.getElementById('pins-panel');
  if (panel) { panel.remove(); return; } // toggle

  panel = document.createElement('div');
  panel.id = 'pins-panel';
  panel.className = 'pins-panel';
  panel.innerHTML = `
    <div class="pins-header">
      <span>📌 Sabitlenmiş Mesajlar</span>
      <button class="icon-btn" onclick="closePinsPanel()">✕</button>
    </div>
    <div id="pins-list" class="pins-list">
      <div style="text-align:center;padding:20px;color:var(--text-muted)">Yükleniyor...</div>
    </div>`;

  document.getElementById('main-content')?.appendChild(panel) ||
  document.querySelector('.main-content')?.appendChild(panel) ||
  document.body.appendChild(panel);

  try {
    const r    = await apiFetch(`${API}/api/channels/${currentChannel._id}/pinned`);
    const pins = await r.json();
    const list = document.getElementById('pins-list');
    if (!list) return;
    if (!pins.length) {
      list.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">Sabitlenmiş mesaj yok</div>';
      return;
    }
    list.innerHTML = pins.map(p => {
      const d = new Date(p.createdAt).toLocaleDateString('tr-TR');
      return `
        <div class="pin-item" onclick="scrollToMsg('${p._id}');closePinsPanel()">
          <div class="pin-author">
            <div class="gs-avatar" style="width:24px;height:24px;font-size:11px;background:${p.avatarColor || '#4f8ef7'}">${initials(p.displayName || '?')}</div>
            <span style="font-weight:600;font-size:13px">${escHtml(p.displayName || '?')}</span>
            <span style="color:var(--text-muted);font-size:11px">${d}</span>
          </div>
          <div class="pin-content">${escHtml((p.content || '').slice(0, 150))}</div>
        </div>`;
    }).join('');
  } catch {
    const list = document.getElementById('pins-list');
    if (list) list.innerHTML = '<div style="color:var(--red);padding:16px">Yüklenemedi</div>';
  }
}

function closePinsPanel() {
  document.getElementById('pins-panel')?.remove();
}

// ── DRAFT SAVE/RESTORE ────────────────────────────────────────
function saveDraft(channelId, text) {
  if (!channelId) return;
  if (text?.trim()) {
    msgDrafts[channelId] = text;
  } else {
    delete msgDrafts[channelId];
  }
}

function restoreDraft(channelId) {
  return msgDrafts[channelId] || '';
}

// CSS — search result styles
const searchStyle = document.createElement('style');
searchStyle.textContent = `
  .gs-section-label {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    padding: 12px 16px 4px;
  }
  .gs-item {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px 16px;
    cursor: pointer;
    border-radius: 6px;
    margin: 0 4px;
    transition: background 0.1s;
  }
  .gs-item:hover { background: var(--bg-hover); }
  .gs-avatar {
    width: 32px;
    height: 32px;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 12px;
    font-weight: 700;
    color: white;
    flex-shrink: 0;
  }
  .gs-item-body { flex: 1; min-width: 0; }
  .gs-item-title { font-size: 14px; font-weight: 600; }
  .gs-item-sub {
    font-size: 12px;
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    margin-top: 2px;
  }
  .pins-panel {
    position: fixed;
    top: 0;
    right: 0;
    width: 320px;
    height: 100%;
    background: var(--bg-2);
    border-left: 1px solid var(--border);
    z-index: var(--z-sidebar);
    display: flex;
    flex-direction: column;
    animation: slideInRight 0.2s var(--ease-out);
  }
  @keyframes slideInRight {
    from { transform: translateX(100%); opacity: 0; }
    to   { transform: translateX(0);   opacity: 1; }
  }
  .pins-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px;
    border-bottom: 1px solid var(--border);
    font-weight: 700;
  }
  .pins-list { flex: 1; overflow-y: auto; padding: 8px; }
  .pin-item {
    padding: 10px;
    border-radius: 6px;
    cursor: pointer;
    margin-bottom: 4px;
    border: 1px solid var(--border);
    background: var(--bg-3);
    transition: background 0.1s;
  }
  .pin-item:hover { background: var(--bg-hover); }
  .pin-author {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-bottom: 4px;
  }
  .pin-content {
    font-size: 13px;
    color: var(--text-muted);
    line-height: 1.4;
  }
`;
document.head.appendChild(searchStyle);

export {
  closeGlobalSearch,
  closePinsPanel,
  doGlobalSearch,
  gsApplyDate,
  gsChangePage,
  gsClearFilters,
  gsCloseDatePicker,
  gsClosePickers,
  gsFilterFrom,
  gsFromSearch,
  gsOpenDatePicker,
  gsOpenFromPicker,
  gsRemoveFilter,
  gsRenderChips,
  gsRenderPagination,
  gsSelectFrom,
  gsToggleFilter,
  gsUpdateQuickFilterButtons,
  handleGsKey,
  jumpToChannel,
  jumpToMessage,
  onGlobalSearch,
  openGlobalSearch,
  openPinsPanel,
  renderGsResults,
  restoreDraft,
  saveDraft,
  switchGsTab,
};

