// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ForumPanel.svelte
//              client/js/core/forum-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/forum.ts
// Modül: Forum tag filtre + sıralama + pin/kilit kartları

import { BridgeRegistry } from './bridge-registry.js';
import { getMe, getCurrentServer, getCurrentChannel, getAPI } from './globals.js';
import { apiFetch } from './api-fetch.js';
import { escHtml, toast } from './utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ForumThread {
  _id: string;
  name?: string;
  firstMessage?: string;
  tags?: string[];
  pinned?: boolean;
  locked?: boolean;
  messageCount?: number;
  participantCount?: number;
  lastMessageAt?: number;
  createdAt: number;
}

type ForumSort = 'activity' | 'new' | 'top';

// ── Module state ──────────────────────────────────────────────────────────────

let _forumAllThreads: ForumThread[] = [];
let _forumActiveTag: string | null  = null;
let _forumSort: ForumSort           = 'activity';
let _forumAvailTags: string[]       = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

 as Record<string, string>)[c]!
  );
}

// ── Load forum channel ────────────────────────────────────────────────────────

const _origLoadForumChannel: Function =
  BridgeRegistry.get('loadForumChannel') ?? (async () => {});

BridgeRegistry.register('loadForumChannel', async function (channelId: string) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-3)">Yükleniyor...</div>';

  const API = getAPI();
  const r = await apiFetch(`${API}/api/threads/channel/${channelId}`);
  _forumAllThreads = r.ok ? await r.json() : [];
  _forumActiveTag  = null;
  _forumSort       = 'activity';

  const tagSet = new Set<string>();
  _forumAllThreads.forEach(t => (t.tags ?? []).forEach(tag => tagSet.add(tag)));
  _forumAvailTags = [...tagSet];

  const channel = getCurrentChannel();
  area.innerHTML = `
    <div class="forum-header" style="border-bottom:1px solid var(--border);padding-bottom:16px;margin-bottom:0;">
      <div style="display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:10px;">
        <div>
          <h2 style="font-size:20px;font-weight:700;color:var(--text-1);margin:0">📋 ${escHtml(channel?.name ?? '')}</h2>
          <p style="color:var(--text-3);font-size:13px;margin:4px 0 0">${escHtml(channel?.topic ?? 'Forum kanalı')}</p>
        </div>
        <button class="btn btn-primary" onclick="(window).openNewForumThread()" style="gap:6px">✏️ Yeni İleti Aç</button>
      </div>
      <div style="display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap;">
        <div style="display:flex;gap:4px;">
          <button class="forum-sort-btn ${_forumSort === 'activity' ? 'active' : ''}" onclick="(window).setForumSort('activity')">🕐 Son Aktivite</button>
          <button class="forum-sort-btn ${_forumSort === 'new' ? 'active' : ''}" onclick="(window).setForumSort('new')">✨ En Yeni</button>
          <button class="forum-sort-btn ${_forumSort === 'top' ? 'active' : ''}" onclick="(window).setForumSort('top')">🔥 En Aktif</button>
        </div>
        <div style="display:flex;gap:4px;flex-wrap:wrap;" id="forum-tag-filters">
          ${_forumAvailTags.map(tag => `
            <button class="forum-tag-btn" data-tag="${escHtml(tag)}" onclick="(window).setForumTagFilter('${escHtml(tag)}')">${escHtml(tag)}</button>
          `).join('')}
          ${_forumAvailTags.length ? `<button class="forum-tag-btn clear-tag" onclick="(window).setForumTagFilter(null)" style="display:none">✕ Temizle</button>` : ''}
        </div>
      </div>
    </div>
    <div class="forum-grid" id="forum-grid" style="padding:16px;"></div>`;

  renderForumGridV42();
});

// ── Sort & filter ─────────────────────────────────────────────────────────────

function setForumSort(sort: ForumSort): void {
  _forumSort = sort;
  document.querySelectorAll<HTMLElement>('.forum-sort-btn').forEach(b =>
    b.classList.toggle('active',
      b.textContent?.includes(sort === 'activity' ? 'Aktivite' : sort === 'new' ? 'Yeni' : 'Aktif') ?? false
    )
  );
  renderForumGridV42();
}

function setForumTagFilter(tag: string | null): void {
  _forumActiveTag = tag;
  document.querySelectorAll<HTMLElement>('.forum-tag-btn[data-tag]').forEach(b =>
    b.classList.toggle('active', b.dataset.tag === tag)
  );
  const clearBtn = document.querySelector<HTMLElement>('.forum-tag-btn.clear-tag');
  if (clearBtn) clearBtn.style.display = tag ? '' : 'none';
  renderForumGridV42();
}

// ── Grid renderer ─────────────────────────────────────────────────────────────

function renderForumGridV42(): void {
  const grid = document.getElementById('forum-grid');
  if (!grid) return;

  let threads = [..._forumAllThreads];

  if (_forumActiveTag) threads = threads.filter(t => (t.tags ?? []).includes(_forumActiveTag!));

  if (_forumSort === 'activity') {
    threads.sort((a, b) => (b.lastMessageAt ?? b.createdAt) - (a.lastMessageAt ?? a.createdAt));
  } else if (_forumSort === 'new') {
    threads.sort((a, b) => b.createdAt - a.createdAt);
  } else if (_forumSort === 'top') {
    threads.sort((a, b) => (b.messageCount ?? 0) - (a.messageCount ?? 0));
  }

  // Pinned first
  threads.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));

  if (!threads.length) {
    grid.innerHTML = `<div style="text-align:center;padding:60px 20px;color:var(--text-3)">
      <div style="font-size:48px;margin-bottom:12px">💬</div>
      <div style="font-size:16px;font-weight:600">${_forumActiveTag ? `"${_forumActiveTag}" etiketinde ileti yok` : 'Henüz ileti yok'}</div>
    </div>`;
    return;
  }

  grid.innerHTML = '';
  const server  = getCurrentServer();
  const me      = getMe();
  const isMod   = server?.ownerId === (me as { id?: string } | null)?.id;

  for (const t of threads) {
    const card = document.createElement('div');
    card.className =
      'forum-card' +
      (t.pinned ? ' forum-card-pinned' : '') +
      (t.locked ? ' forum-card-locked' : '');

    const ago  = BridgeRegistry.has('timeAgo')
      ? (BridgeRegistry.call('timeAgo', t.lastMessageAt ?? t.createdAt) as string)
      : '';
    const tags = (t.tags ?? []).map(tag =>
      `<span class="forum-tag-chip" onclick="event.stopPropagation();(window).setForumTagFilter('${escHtml(tag)}')">${escHtml(tag)}</span>`
    ).join('');

    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div style="min-width:0;flex:1;">
          <div class="forum-card-title">
            ${t.pinned ? '<span title="Sabitlenmiş" style="font-size:12px;margin-right:4px;">📌</span>' : ''}
            ${t.locked ? '<span title="Kilitli" style="font-size:12px;margin-right:4px;">🔒</span>' : ''}
            ${escHtml(t.name ?? 'İsimsiz ileti')}
          </div>
          <div class="forum-card-preview">${escHtml((t.firstMessage ?? '').slice(0, 120))}${(t.firstMessage ?? '').length > 120 ? '…' : ''}</div>
          ${tags ? `<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">${tags}</div>` : ''}
        </div>
        ${isMod ? `<div class="forum-mod-actions" onclick="event.stopPropagation()">
          <button class="forum-mod-btn" title="${t.pinned ? 'Sabitlemeyi kaldır' : 'Sabitle'}"
            onclick="(window).forumTogglePin('${escHtml(t._id)}', ${!t.pinned})">${t.pinned ? '📌' : '📍'}</button>
          <button class="forum-mod-btn" title="${t.locked ? 'Kilidi aç' : 'Kilitle'}"
            onclick="(window).forumToggleLock('${escHtml(t._id)}', ${!t.locked})">${t.locked ? '🔓' : '🔒'}</button>
          <button class="forum-mod-btn" title="Etiket ekle"
            onclick="(window).forumEditTags('${escHtml(t._id)}')">🏷️</button>
        </div>` : ''}
      </div>
      <div class="forum-card-meta" style="margin-top:8px;">
        <span title="Yanıt sayısı">💬 ${t.messageCount ?? 0}</span>
        <span title="Katılımcı">👤 ${t.participantCount ?? 1}</span>
        <span title="Son aktivite">🕐 ${ago}</span>
        ${t.locked ? '<span style="color:var(--danger);font-size:11px;">Kilitli</span>' : ''}
      </div>`;

    card.addEventListener('click', () => {
      if (BridgeRegistry.has('openForumThread')) {
    BridgeRegistry.call('openForumThread', t._id, t.name);
      }
    });
    grid.appendChild(card);
  }
}

// ── Mod actions ───────────────────────────────────────────────────────────────

async function forumTogglePin(threadId: string, pinned: boolean): Promise<void> {
  const API = getAPI();
  const r = await apiFetch(`${API}/api/threads/${threadId}/pin`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pinned }),
  });
  if (!r.ok) { toast('İşlem başarısız', 'error'); return; }
  const t = _forumAllThreads.find(x => x._id === threadId);
  if (t) t.pinned = pinned;
  toast(pinned ? 'İleti sabitlendi 📌' : 'Sabitleme kaldırıldı', 'success');
  renderForumGridV42();
}

async function forumToggleLock(threadId: string, locked: boolean): Promise<void> {
  const API = getAPI();
  const r = await apiFetch(`${API}/api/threads/${threadId}/lock`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ locked }),
  });
  if (!r.ok) { toast('İşlem başarısız', 'error'); return; }
  const t = _forumAllThreads.find(x => x._id === threadId);
  if (t) t.locked = locked;
  toast(locked ? 'İleti kilitlendi 🔒' : 'Kilit açıldı 🔓', 'success');
  renderForumGridV42();
}

function forumEditTags(threadId: string): void {
  const t = _forumAllThreads.find(x => x._id === threadId);
  if (!t) return;

  // Remove any existing tag editor
  document.getElementById('forum-tag-editor')?.remove();

  const current = (t.tags ?? []).join(', ');
  const editor  = document.createElement('div');
  editor.id     = 'forum-tag-editor';
  editor.style.cssText = `
    position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);
    background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;
    padding:20px;z-index:10000;width:320px;box-shadow:0 8px 32px rgba(0,0,0,.5);`;
  editor.innerHTML = `
    <div style="font-weight:600;margin-bottom:12px;">🏷️ Etiketleri Düzenle</div>
    <input id="forum-tag-input" type="text" class="input-field"
      value="${escHtml(current)}"
      placeholder="öneri, hata, duyuru"
      style="width:100%;margin-bottom:8px;"
      maxlength="120">
    <div style="font-size:11px;color:var(--text-muted);margin-bottom:14px;">
      Virgülle ayır, maksimum 5 etiket.
    </div>
    <div style="display:flex;gap:8px;">
      <button class="btn btn-primary" id="forum-tag-save" style="flex:1;">💾 Kaydet</button>
      <button class="btn" id="forum-tag-cancel" style="flex:1;">İptal</button>
    </div>`;

  document.body.appendChild(editor);
  (document.getElementById('forum-tag-input') as HTMLInputElement).focus();

  async function _save(): Promise<void> {
    const raw  = (document.getElementById('forum-tag-input') as HTMLInputElement).value;
    const tags = raw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);
    const API  = getAPI();
    const r    = await apiFetch(`${API}/api/threads/${threadId}`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ tags }),
    });
    editor.remove();
    if (!r.ok) { toast('Etiket kaydedilemedi', 'error'); return; }
    t.tags = tags;
    const tagSet = new Set<string>();
    _forumAllThreads.forEach(th => (th.tags ?? []).forEach(tag => tagSet.add(tag)));
    _forumAvailTags = [...tagSet];
    toast('Etiketler güncellendi 🏷️', 'success');
    renderForumGridV42();
  }

  document.getElementById('forum-tag-save')!.addEventListener('click', _save);
  document.getElementById('forum-tag-cancel')!.addEventListener('click', () => editor.remove());
  (document.getElementById('forum-tag-input') as HTMLInputElement)
    .addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter') _save();
      if (e.key === 'Escape') editor.remove();
    });
}

// ── New thread modal ──────────────────────────────────────────────────────────

const _origOpenNewForumThread: Function =
  BridgeRegistry.get('openNewForumThread') ?? (() => {});

BridgeRegistry.register('openNewForumThread', function () {
  BridgeRegistry.call('_destroyTempModal');
  const API = getAPI();
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
        <button class="btn" onclick="(window)._destroyTempModal()">İptal</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.onclick = (e: MouseEvent) => {
    if (e.target === modal) BridgeRegistry.call('_destroyTempModal');
  };

  (document.getElementById('forum-title-input') as HTMLInputElement | null)?.focus();

  const submitBtn = document.getElementById('forum-submit-btn');
  if (submitBtn) {
    submitBtn.onclick = async () => {
      const name    = (document.getElementById('forum-title-input') as HTMLInputElement).value.trim();
      const body    = (document.getElementById('forum-body-input') as HTMLTextAreaElement).value.trim();
      const tagsRaw = (document.getElementById('forum-tags-input') as HTMLInputElement).value;
      const tags    = tagsRaw.split(',').map(s => s.trim()).filter(Boolean).slice(0, 5);

      if (!name) { toast('Başlık gerekli', 'error'); return; }

      const channel = getCurrentChannel();
      const r = await apiFetch(`${API}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channel?._id, name, firstMessage: body, tags }),
      });
      const data = await r.json();
      if (!r.ok) { toast(data.error ?? 'Oluşturulamadı', 'error'); return; }

      BridgeRegistry.call('_destroyTempModal');
      toast('İleti açıldı!', 'success');
      await BridgeRegistry.call('loadForumChannel', channel?._id);
      if (data.thread && BridgeRegistry.has('openForumThread')) {
      BridgeRegistry.call('openForumThread', data.thread._id, data.thread.name);
      }
    };
  }
});

export {
  forumEditTags,
  forumToggleLock,
  forumTogglePin,
  renderForumGridV42,
  setForumSort,
  setForumTagFilter,
};
