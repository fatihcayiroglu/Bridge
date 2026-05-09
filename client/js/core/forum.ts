// client/js/core/forum.js.2
// Bridge Forum KanalÄ± tam Ã¶zellik seti:
//
//  âœ… Tag sistemi (kanal bazlÄ± etiket yÃ¶netimi)
//  âœ… SÄ±ralama: En son / En yeni / En aktif
//  âœ… Tag filtresi toolbar
//  âœ… Arama
//  âœ… Pin / Lock gÃ¶stergeleri + mod aksiyonlarÄ±
//  âœ… Yeni ileti modalÄ± â€” tag seÃ§imi
//  âœ… Socket gerÃ§ek zamanlÄ± gÃ¼ncelleme
//  âœ… BoÅŸ durum illÃ¼strasyonu
//  âœ… "Kanal etiketleri yÃ¶net" (admin)

'use strict';
export {};

// â”€â”€ STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const ForumState = {
  channelId:    null,
  threads:      [],
  sort:         localStorage.getItem('bridge-forum-sort') || 'latest',
  filterTag:    null,
  searchQuery:  '',
  availTags:    [],   // [{id, name, color}]
};

// â”€â”€ INIT â€” selectChannel'dan Ã§aÄŸrÄ±lÄ±r â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadForumChannel(channelId) {
  ForumState.channelId   = channelId;
  ForumState.filterTag   = null;
  ForumState.searchQuery = '';

  const area = document.getElementById('messages-area');
  if (!area) return;

  // skeleton
  area.innerHTML = `<div class="forum-skeleton">
    <div class="forum-skeleton-bar" style="width:60%"></div>
    <div class="forum-skeleton-bar" style="width:40%;height:10px;margin-top:8px"></div>
    <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;padding:16px 0">
      ${[1,2,3,4].map(() => `<div class="forum-skeleton-card"></div>`).join('')}
    </div>
  </div>`;

  // Kanal etiketlerini yÃ¼kle
  await _loadChannelTags(channelId);
  // Thread'leri yÃ¼kle
  await _fetchAndRender();
}

// â”€â”€ SUNUCUDAN THREAD LÄ°STESÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _fetchAndRender() {
  const { channelId, sort, filterTag, searchQuery } = ForumState;
  if (!channelId) return;

  const params = new URLSearchParams({ sort });
  if (filterTag)    params.set('tag', filterTag);
  if (searchQuery)  params.set('search', searchQuery);

  const r = await apiFetch(`${API}/api/threads/channel/${channelId}?${params}`);
  ForumState.threads = r.ok ? await r.json() : [];

  _renderForum();
}

// â”€â”€ ANA RENDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _renderForum() {
  const area = document.getElementById('messages-area');
  if (!area) return;

  const ch      = currentChannel;
  const isAdmin = me?.isAdmin || currentServer?.ownerId === me?.id;
  const tags    = ForumState.availTags;

  area.innerHTML = `
    <!-- FORUM HEADER -->
    <div class="forum-header">
      <div class="forum-header-top">
        <div>
          <h2 class="forum-title">ğŸ“‹ ${escHtml(ch?.name || 'Forum')}</h2>
          <p class="forum-desc">${escHtml(ch?.topic || 'Yeni bir ileti baÅŸlatmak iÃ§in butona tÄ±kla.')}</p>
        </div>
        <div class="forum-header-actions">
          ${isAdmin ? `<button class="btn btn-sm" onclick="openForumTagManager()" title="Etiketleri YÃ¶net">ğŸ·ï¸ Etiketler</button>` : ''}
          <button class="btn btn-primary" onclick="openNewForumThread()">âœï¸ Yeni Ä°leti</button>
        </div>
      </div>

      <!-- TOOLBAR: SÄ±ralama + Etiket filtresi + Arama -->
      <div class="forum-toolbar">
        <!-- SÄ±ralama -->
        <div class="forum-sort-pills">
          ${[
            { key: 'latest', label: 'ğŸ• Son Aktif' },
            { key: 'new',    label: 'ğŸ†• En Yeni'  },
            { key: 'top',    label: 'ğŸ”¥ En Aktif' },
          ].map(s => `
            <button class="forum-sort-pill ${ForumState.sort === s.key ? 'active' : ''}"
              onclick="setForumSort('${s.key}')">${s.label}</button>
          `).join('')}
        </div>

        <!-- Tag filtresi -->
        ${tags.length ? `
        <div class="forum-tag-filter">
          <button class="forum-tag-btn ${!ForumState.filterTag ? 'active' : ''}" onclick="setForumTagFilter(null)">TÃ¼mÃ¼</button>
          ${tags.map(t => `
            <button class="forum-tag-btn ${ForumState.filterTag === t.name ? 'active' : ''}"
              onclick="setForumTagFilter('${escHtml(t.name)}')"
              style="--tag-color:${t.color || '#5865f2'}">
              <span class="forum-tag-dot" style="background:${t.color || '#5865f2'}"></span>${escHtml(t.name)}
            </button>
          `).join('')}
        </div>` : ''}

        <!-- Arama -->
        <div class="forum-search-wrap">
          <span class="forum-search-icon">ğŸ”</span>
          <input class="forum-search-input" id="forum-search-input"
            placeholder="Ä°leti ara..."
            value="${escHtml(ForumState.searchQuery)}"
            oninput="onForumSearch(this.value)">
        </div>
      </div>
    </div>

    <!-- GRID -->
    <div class="forum-grid" id="forum-grid"></div>
  `;

  _renderForumGrid();
}

// â”€â”€ GRID Ä°Ã‡ERÄ°ÄÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _renderForumGrid() {
  const grid = document.getElementById('forum-grid');
  if (!grid) return;

  const threads = ForumState.threads;

  if (!threads.length) {
    grid.innerHTML = `
      <div class="forum-empty">
        <div class="forum-empty-icon">ğŸ’¬</div>
        <div class="forum-empty-title">${ForumState.filterTag || ForumState.searchQuery ? 'SonuÃ§ bulunamadÄ±' : 'HenÃ¼z ileti yok'}</div>
        <div class="forum-empty-sub">${ForumState.filterTag ? `"${escHtml(ForumState.filterTag)}" etiketinde ileti bulunamadÄ±.` : ForumState.searchQuery ? 'FarklÄ± bir arama terimi dene.' : 'Ä°lk iletiÅŸimi baÅŸlatmak iÃ§in Yeni Ä°leti butonuna tÄ±kla.'}</div>
        ${!ForumState.filterTag && !ForumState.searchQuery ? `<button class="btn btn-primary" style="margin-top:16px" onclick="openNewForumThread()">âœï¸ Yeni Ä°leti AÃ§</button>` : ''}
      </div>`;
    return;
  }

  grid.innerHTML = '';
  for (const t of threads) {
    const ago  = _timeAgo(t.lastMessageAt || t.createdAt);
    const tags = Array.isArray(t.tags) ? t.tags : [];
    const card = document.createElement('div');
    card.className = 'forum-card' + (t.pinned ? ' pinned' : '') + (t.locked ? ' locked' : '');
    card.dataset.threadId = t._id;
    card.onclick = () => _openForumThread(t._id, t.name);

    card.innerHTML = `
      <div class="forum-card-badges">
        ${t.pinned ? `<span class="forum-badge pin" title="SabitlenmiÅŸ">ğŸ“Œ</span>` : ''}
        ${t.locked ? `<span class="forum-badge lock" title="Kilitli">ğŸ”’</span>` : ''}
      </div>
      <div class="forum-card-title">${escHtml(t.name || 'Ä°simsiz ileti')}</div>
      ${tags.length ? `<div class="forum-card-tags">${tags.map(tag => {
        const tagObj = ForumState.availTags.find(tt => tt.name === tag);
        const color  = tagObj?.color || '#5865f2';
        return `<span class="forum-tag-chip" style="background:${color}22;color:${color};border-color:${color}44">${escHtml(tag)}</span>`;
      }).join('')}</div>` : ''}
      <div class="forum-card-preview">${escHtml((t.firstMessage || '').slice(0, 140))}${(t.firstMessage||'').length > 140 ? 'â€¦' : ''}</div>
      <div class="forum-card-footer">
        <div class="forum-card-meta">
          <span title="YanÄ±t sayÄ±sÄ±">ğŸ’¬ ${t.messageCount || 0}</span>
          <span title="KatÄ±lÄ±mcÄ±">ğŸ‘¤ ${t.participantCount || 1}</span>
          <span title="Son aktivite">ğŸ• ${ago}</span>
        </div>
        ${_isModOrAdmin() ? `
        <div class="forum-card-actions" onclick="event.stopPropagation()">
          <button class="forum-action-btn" title="${t.pinned ? 'Sabitlemeyi kaldÄ±r' : 'Sabitle'}"
            onclick="toggleForumPin('${t._id}', ${!!t.pinned})">${t.pinned ? 'ğŸ“Œ' : 'ğŸ“'}</button>
          <button class="forum-action-btn" title="${t.locked ? 'Kilidi aÃ§' : 'Kilitle'}"
            onclick="toggleForumLock('${t._id}', ${!!t.locked})">${t.locked ? 'ğŸ”“' : 'ğŸ”’'}</button>
        </div>` : ''}
      </div>`;

    grid.appendChild(card);
  }
}

// â”€â”€ TOOLBAR AKSIYONLARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function setForumSort(sort) {
  ForumState.sort = sort;
  localStorage.setItem('bridge-forum-sort', sort);
  _fetchAndRender();
}

function setForumTagFilter(tag) {
  ForumState.filterTag = tag;
  _renderForum();
  _fetchAndRender();
}

let _forumSearchTimer = null;
function onForumSearch(val) {
  ForumState.searchQuery = val;
  clearTimeout(_forumSearchTimer);
  _forumSearchTimer = setTimeout(_fetchAndRender, 350);
}

// â”€â”€ YENÄ° Ä°LETÄ° MODALI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function openNewForumThread() {
  _destroyTempModal();
  const tags = ForumState.availTags;
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:520px;width:95%">
      <h2 style="margin:0 0 18px;display:flex;align-items:center;gap:8px">âœï¸ Yeni Ä°leti AÃ§</h2>

      <div class="form-group">
        <label>BaÅŸlÄ±k <span style="color:var(--red)">*</span></label>
        <input type="text" id="forum-title-input" class="input-field"
          placeholder="Ä°leti baÅŸlÄ±ÄŸÄ±..." maxlength="100" autofocus>
        <span id="forum-title-count" style="font-size:11px;color:var(--text-muted);float:right;margin-top:2px">0/100</span>
      </div>

      ${tags.length ? `
      <div class="form-group">
        <label>Etiketler <span style="font-size:11px;color:var(--text-muted)">(en fazla 5)</span></label>
        <div id="forum-tag-picker" class="forum-tag-picker">
          ${tags.map(t => `
            <label class="forum-tag-option">
              <input type="checkbox" name="forum-tag" value="${escHtml(t.name)}" style="display:none">
              <span class="forum-tag-chip selectable" style="background:${t.color||'#5865f2'}22;color:${t.color||'#5865f2'};border-color:${t.color||'#5865f2'}44"
                onclick="_toggleTagOption(this, '${escHtml(t.name)}')">${escHtml(t.name)}</span>
            </label>
          `).join('')}
        </div>
      </div>` : ''}

      <div class="form-group">
        <label>Ä°lk Mesaj</label>
        <textarea id="forum-body-input" class="input-field" rows="5"
          placeholder="Ne hakkÄ±nda konuÅŸmak istiyorsun?"
          style="resize:vertical;min-height:100px"></textarea>
      </div>

      <div class="modal-footer">
        <button class="btn btn-primary" id="forum-submit-btn">Ä°leti AÃ§</button>
        <button class="btn" onclick="_destroyTempModal()">Ä°ptal</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };

  // BaÅŸlÄ±k karakter sayacÄ±
  const titleInput = document.getElementById('forum-title-input');
  const titleCount = document.getElementById('forum-title-count');
  titleInput.addEventListener('input', () => {
    titleCount.textContent = `${titleInput.value.length}/100`;
  });

  document.getElementById('forum-submit-btn').onclick = async () => {
    const name = titleInput.value.trim();
    const body = document.getElementById('forum-body-input')?.value.trim() || '';
    if (!name) return toast('BaÅŸlÄ±k gerekli', 'error');

    const selectedTags = [...document.querySelectorAll('input[name="forum-tag"]:checked')]
      .map(el => el.value).slice(0, 5);

    const btn = document.getElementById('forum-submit-btn');
    btn.disabled = true;
    btn.textContent = 'AÃ§Ä±lÄ±yor...';

    const r = await apiFetch(`${API}/api/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        channelId: ForumState.channelId,
        name,
        firstMessage: body,
        tags: selectedTags,
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      btn.disabled = false;
      btn.textContent = 'Ä°leti AÃ§';
      return toast(data.error || 'OluÅŸturulamadÄ±', 'error');
    }

    _destroyTempModal();
    toast('Ä°leti aÃ§Ä±ldÄ±! ğŸ‰', 'success');
    await _fetchAndRender();
    if (data.thread) _openForumThread(data.thread._id, data.thread.name);
  };
}

function _toggleTagOption(el, tagName) {
  const checkbox = el.closest('label')?.querySelector('input[type="checkbox"]');
  if (!checkbox) return;
  const checked = document.querySelectorAll('input[name="forum-tag"]:checked').length;
  if (!checkbox.checked && checked >= 5) return toast('En fazla 5 etiket seÃ§ebilirsin', 'error');
  checkbox.checked = !checkbox.checked;
  el.classList.toggle('selected', checkbox.checked);
}

// â”€â”€ ETÄ°KET YÃ–NETÄ°CÄ°SÄ° (Admin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openForumTagManager() {
  _destroyTempModal();
  const tags = ForumState.availTags;
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:440px;width:95%">
      <h2 style="margin:0 0 16px">ğŸ·ï¸ Kanal Etiketleri</h2>
      <p style="font-size:13px;color:var(--text-muted);margin-bottom:16px">En fazla 20 etiket. Ä°leti aÃ§Ä±lÄ±rken kullanÄ±cÄ±lar seÃ§ebilir.</p>
      <div id="forum-tag-list" style="display:flex;flex-direction:column;gap:8px;margin-bottom:16px">
        ${tags.map((t, i) => _tagManagerRow(t, i)).join('')}
      </div>
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:16px">
        <input id="new-tag-name" class="input-field" placeholder="Etiket adÄ±..." maxlength="20" style="flex:1">
        <input id="new-tag-color" type="color" value="#5865f2" style="width:38px;height:36px;border:none;border-radius:6px;cursor:pointer;padding:2px;background:none">
        <button class="btn btn-primary btn-sm" onclick="_addForumTag()">+ Ekle</button>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="_saveForumTags()">Kaydet</button>
        <button class="btn" onclick="_destroyTempModal()">Ä°ptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
}

function _tagManagerRow(t, i) {
  return `<div class="forum-tag-manager-row" id="forum-tag-row-${i}" data-index="${i}">
    <span class="forum-tag-dot" style="background:${t.color||'#5865f2'}"></span>
    <span style="flex:1;font-size:13px">${escHtml(t.name)}</span>
    <button class="forum-action-btn" title="Sil" onclick="_removeTagRow(${i})" style="color:var(--red)">âœ•</button>
  </div>`;
}

window._localTags = null;
function _addForumTag() {
  const name  = document.getElementById('new-tag-name')?.value?.trim();
  const color = document.getElementById('new-tag-color')?.value || '#5865f2';
  if (!name) return toast('Etiket adÄ± gerekli', 'error');
  if (!window._localTags) window._localTags = [...ForumState.availTags];
  if (window._localTags.length >= 20) return toast('En fazla 20 etiket', 'error');
  if (window._localTags.some(t => t.name.toLowerCase() === name.toLowerCase()))
    return toast('Bu etiket zaten var', 'error');
  window._localTags.push({ id: `tag-${Date.now()}`, name, color });
  const list = document.getElementById('forum-tag-list');
  if (list) list.innerHTML = window._localTags.map((t, i) => _tagManagerRow(t, i)).join('');
  { const _t = document.getElementById('new-tag-name') as HTMLInputElement | null; if (_t) _t.value = ''; }
}

function _removeTagRow(i) {
  if (!window._localTags) window._localTags = [...ForumState.availTags];
  window._localTags.splice(i, 1);
  const list = document.getElementById('forum-tag-list');
  if (list) list.innerHTML = window._localTags.map((t, idx) => _tagManagerRow(t, idx)).join('');
}

async function _saveForumTags() {
  const tags = window._localTags || ForumState.availTags;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${ForumState.channelId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ forumTags: tags }),
  });
  if (r.ok) {
    ForumState.availTags = tags;
    window._localTags = null;
    _destroyTempModal();
    toast('Etiketler kaydedildi âœ“', 'success');
    _renderForum();
  } else {
    const d = await r.json();
    toast(d.error || 'Kaydedilemedi', 'error');
  }
}

// â”€â”€ PIN / LOCK â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function toggleForumPin(threadId, currentlyPinned) {
  const r = await apiFetch(`${API}/api/threads/${threadId}/pin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned: !currentlyPinned }),
  });
  if (r.ok) {
    toast(currentlyPinned ? 'Sabitlenme kaldÄ±rÄ±ldÄ±' : 'Ä°leti sabitlendi ğŸ“Œ', 'success');
    await _fetchAndRender();
  } else toast('DeÄŸiÅŸtirilemedi', 'error');
}

async function toggleForumLock(threadId, currentlyLocked) {
  const r = await apiFetch(`${API}/api/threads/${threadId}/lock`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked: !currentlyLocked }),
  });
  if (r.ok) {
    toast(currentlyLocked ? 'Kilit aÃ§Ä±ldÄ± ğŸ”“' : 'Ä°leti kilitlendi ğŸ”’', 'success');
    await _fetchAndRender();
  } else toast('DeÄŸiÅŸtirilemedi', 'error');
}

// â”€â”€ THREAD AÃ‡ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function _openForumThread(threadId, threadName) {
  if (typeof openThread === 'function') openThread(threadId, threadName);
}

// â”€â”€ SOCKET GERÃ‡EKZAMANl GÃœNCELLEMELERÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function registerForumSocketEvents(socket) {
  socket.on('forum:thread:created', (thread) => {
    if (thread.channelId !== ForumState.channelId) return;
    // EÄŸer grid aÃ§Ä±ksa gÃ¼ncelle
    if (document.getElementById('forum-grid')) {
      ForumState.threads.unshift(thread);
      _renderForumGrid();
    }
  });

  socket.on('forum:thread:updated', ({ threadId, pinned, locked }) => {
    if (!document.getElementById('forum-grid')) return;
    const t = ForumState.threads.find(x => x._id === threadId);
    if (!t) return;
    if (pinned !== undefined) t.pinned = pinned;
    if (locked !== undefined) t.locked = locked;
    // Re-sort pinned first
    ForumState.threads.sort((a, b) => (b.pinned || 0) - (a.pinned || 0));
    _renderForumGrid();
  });
}

// â”€â”€ YARDIMCILAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function _loadChannelTags(channelId) {
  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer?._id}/channels/${channelId}`);
    if (r.ok) {
      const ch = await r.json();
      ForumState.availTags = Array.isArray(ch.forumTags) ? ch.forumTags : [];
    }
  } catch {
    ForumState.availTags = [];
  }
}

function _isModOrAdmin() {
  return me?.isAdmin || currentServer?.ownerId === me?.id;
}

function _timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1)  return 'az Ã¶nce';
  if (m < 60) return `${m}dk Ã¶nce`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}sa Ã¶nce`;
  const d = Math.floor(h / 24);
  return d === 1 ? 'dÃ¼n' : `${d}g Ã¶nce`;
}

