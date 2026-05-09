// client/js/core/v42/forum.js
// Modül: Forum tag filtre + sıralama + pin/kilit kartları
'use strict';
import { getMe, getCurrentServer, getCurrentChannel } from '../globals.js';

let _forumAllThreads  = [];
let _forumActiveTag   = null;
let _forumSort        = 'activity'; // 'activity' | 'new' | 'top'
let _forumAvailTags   = [];

const _origLoadForumChannel = window.loadForumChannel;
window.loadForumChannel = async function(channelId) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-3)">Yükleniyor...</div>';

  const r = await apiFetch(`${API}/api/threads/channel/${channelId}`);
  _forumAllThreads = r.ok ? await r.json() : [];
  _forumActiveTag  = null;
  _forumSort       = 'activity';

  const tagSet = new Set();
  _forumAllThreads.forEach(t => (t.tags || []).forEach(tag => tagSet.add(tag)));
  _forumAvailTags = [...tagSet];

  area.innerHTML = `
    <div class="forum-header" style="border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div>
          <h2 style="font-size:20px;font-weight:700;color:var(--text-1);margin:0">📋 ${escHtml(getCurrentChannel()?.name || '')}</h2>
          <p style="color:var(--text-3);font-size:13px;margin:4px 0 0">${escHtml(getCurrentChannel()?.topic || 'Forum kanalı')}</p>
        </div>
        <button class="btn btn-primary" onclick="openNewForumThread()" style="gap:6px">✏️ Yeni İleti Aç</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap;">
        <div style="display:flex;gap:4px;">
          <button class="forum-sort-btn ${_forumSort === 'activity' ? 'active' : ''}" onclick="setForumSort('activity')">🕐 Son Aktivite</button>
          <button class="forum-sort-btn ${_forumSort === 'new' ? 'active' : ''}" onclick="setForumSort('new')">✨ En Yeni</button>
          <button class="forum-sort-btn ${_forumSort === 'top' ? 'active' : ''}" onclick="setForumSort('top')">🔥 En Aktif</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;" id="forum-tag-filters">
          ${_forumAvailTags.map(tag => `
            <button class="forum-tag-btn" data-tag="${escHtml(tag)}" onclick="setForumTagFilter('${escHtml(tag)}')">${escHtml(tag)}</button>
          `).join('')}
          ${_forumAvailTags.length ? `<button class="forum-tag-btn clear-tag" onclick="setForumTagFilter(null)" style="display:none">✕ Temizle</button>` : ''}
        </div>
      </div>
    </div>
    <div class="forum-grid" id="forum-grid" style="padding:16px;"></div>`;

  renderForumGridV42();
};

function setForumSort(sort) {
  _forumSort = sort;
  document.querySelectorAll('.forum-sort-btn').forEach(b => b.classList.toggle('active', b.textContent.includes(sort === 'activity' ? 'Aktivite' : sort === 'new' ? 'Yeni' : 'Aktif')));
  renderForumGridV42();
}

function setForumTagFilter(tag) {
  _forumActiveTag = tag;
  document.querySelectorAll('.forum-tag-btn[data-tag]').forEach(b => b.classList.toggle('active', b.dataset.tag === tag));
  const clearBtn = document.querySelector('.forum-tag-btn.clear-tag');
  if (clearBtn) clearBtn.style.display = tag ? '' : 'none';
  renderForumGridV42();
}

function renderForumGridV42() {
  const grid = document.getElementById('forum-grid');
  if (!grid) return;

  let threads = [..._forumAllThreads];

  if (_forumActiveTag) threads = threads.filter(t => (t.tags || []).includes(_forumActiveTag));

  if (_forumSort === 'activity') threads.sort((a, b) => (b.lastMessageAt || b.createdAt) - (a.lastMessageAt || a.createdAt));
  else if (_forumSort === 'new')  threads.sort((a, b) => b.createdAt - a.createdAt);
  else if (_forumSort === 'top')  threads.sort((a, b) => (b.messageCount || 0) - (a.messageCount || 0));

  threads.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  if (!threads.length) {
    grid.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--text-3)">
      <div style="font-size:48px;margin-bottom:12px">💬</div>
      <div style="font-size:16px;font-weight:600">${_forumActiveTag ? `"${_forumActiveTag}" etiketinde ileti yok` : 'Henüz ileti yok'}</div>
    </div>`;
    return;
  }

  grid.innerHTML = '';
  const isMod = getCurrentServer()?.ownerId === getMe()?.id;

  for (const t of threads) {
    const card = document.createElement('div');
    card.className = 'forum-card' + (t.pinned ? ' forum-card-pinned' : '') + (t.locked ? ' forum-card-locked' : '');
    const ago = typeof timeAgo === 'function' ? timeAgo(t.lastMessageAt || t.createdAt) : '';
    const tags = (t.tags || []).map(tag =>
      `<span class="forum-tag-chip" onclick="event.stopPropagation();setForumTagFilter('${escHtml(tag)}')">${escHtml(tag)}</span>`
    ).join('');

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="min-width:0;flex:1;">
          <div class="forum-card-title">
            ${t.pinned ? '<span title="Sabitlenmiş" style="font-size:12px;margin-right:4px;">📌</span>' : ''}
            ${t.locked ? '<span title="Kilitli" style="font-size:12px;margin-right:4px;">🔒</span>' : ''}
            ${escHtml(t.name || 'İsimsiz ileti')}
          </div>
          <div class="forum-card-preview">${escHtml((t.firstMessage || '').slice(0, 120))}${(t.firstMessage||'').length > 120 ? '…' : ''}</div>
          ${tags ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${tags}</div>` : ''}
        </div>
        ${isMod ? `<div class="forum-mod-actions" onclick="event.stopPropagation()">
          <button class="forum-mod-btn" title="${t.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle'}" onclick="forumTogglePin('${escHtml(t._id)}', ${!t.pinned})">${t.pinned ? '📌' : '📍'}</button>
          <button class="forum-mod-btn" title="${t.locked ? 'Kilidi aç' : 'Kilitle'}" onclick="forumToggleLock('${escHtml(t._id)}', ${!t.locked})">${t.locked ? '🔓' : '🔒'}</button>
          <button class="forum-mod-btn" title="Etiket ekle" onclick="forumEditTags('${escHtml(t._id)}')">🏷️</button>
        </div>` : ''}
      </div>
      <div class="forum-card-meta" style="margin-top:8px;">
        <span title="Yanıt sayısı">💬 ${t.messageCount || 0}</span>
        <span title="Katılımcı">👤 ${t.participantCount || 1}</span>
        <span title="Son aktivite">🕐 ${ago}</span>
        ${t.locked ? '<span style="color:var(--danger);font-size:11px;">Kilitli</span>' : ''}
      </div>`;

    card.addEventListener('click', () => {
      if (typeof openForumThread === 'function') openForumThread(t._id, t.name);
    });
    grid.appendChild(card);
  }
}

async function forumTogglePin(threadId, pinned) {
  const r = await apiFetch(`${API}/api/threads/${threadId}/pin`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!r.ok) return toast('İşlem başarısız', 'error');
  const t = _forumAllThreads.find(x => x._id === threadId);
  if (t) t.pinned = pinned;
  toast(pinned ? 'İleti sabitlendi 📌' : 'Sabitleme kaldırıldı', 'success');
  renderForumGridV42();
}

async function forumToggleLock(threadId, locked) {
  const r = await apiFetch(`${API}/api/threads/${threadId}/lock`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked }),
  });
  if (!r.ok) return toast('İşlem başarısız', 'error');
  const t = _forumAllThreads.find(x => x._id === threadId);
  if (t) t.locked = locked;
  toast(locked ? 'İleti kilitlendi 🔒' : 'Kilit açıldı 🔓', 'success');
  renderForumGridV42();
}

function forumEditTags(threadId) {
  const t = _forumAllThreads.find(x => x._id === threadId);
  if (!t) return;
  const current = (t.tags || []).join(', ');
  const input = prompt('Etiketleri düzenle (virgülle ayır, max 5):', current);
  if (input === null) return;
  const tags = input.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
  apiFetch(`${API}/api/threads/${threadId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tags }),
  }).then(async r => {
    if (!r.ok) return toast('Etiket kaydedilemedi', 'error');
    t.tags = tags;
    const tagSet = new Set();
    _forumAllThreads.forEach(th => (th.tags || []).forEach(tag => tagSet.add(tag)));
    _forumAvailTags = [...tagSet];
    toast('Etiketler güncellendi 🏷️', 'success');
    renderForumGridV42();
  });
}

const _origOpenNewForumThread = window.openNewForumThread;
window.openNewForumThread = function() {
  if (typeof _destroyTempModal === 'function') _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:500px;width:95%">
      <h2>✏️ Yeni İleti Aç</h2>
      <div class="form-group">
        <label>Başlık</label>
        <input type="text" id="forum-title-input" class="input-field" placeholder="İleti başlığı..." maxlength="100">
      </div>
      <div class="form-group">
        <label>İçerik</label>
        <textarea id="forum-body-input" class="input-field" rows="4" placeholder="Ne hakkında konuşmak istiyorsun?" style="resize:vertical"></textarea>
      </div>
      <div class="form-group">
        <label>Etiketler <span style="font-weight:400;color:var(--text-muted);font-size:11px">(virgülle ayır, max 5 — ör: öneri, hata, duyuru)</span></label>
        <input type="text" id="forum-tags-input" class="input-field" placeholder="öneri, hata, soru">
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" id="forum-submit-btn">İleti Aç</button>
        <button class="btn" onclick="_destroyTempModal()">İptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
  document.getElementById('forum-title-input').focus();
  document.getElementById('forum-submit-btn').onclick = async () => {
    const name  = document.getElementById('forum-title-input').value.trim();
    const body  = document.getElementById('forum-body-input').value.trim();
    const tagsRaw = document.getElementById('forum-tags-input').value;
    const tags  = tagsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
    if (!name) return toast('Başlık gerekli', 'error');
    const r = await apiFetch(`${API}/api/threads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ channelId: getCurrentChannel()?._id, name, firstMessage: body, tags }),
    });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Oluşturulamadı', 'error');
    _destroyTempModal();
    toast('İleti açıldı!', 'success');
    await window.loadForumChannel(getCurrentChannel()._id);
    if (data.thread && typeof openForumThread === 'function') openForumThread(data.thread._id, data.thread.name);
  };
};

// Expose globals
