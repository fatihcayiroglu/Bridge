// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ThreadArchivePanel.svelte
//              client/js/core/thread-archive-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/thread-archive.ts  (Sprint 91)
// Thread Arşivi — Discord'un "Active Threads" ve "Archived Threads" paneli
//
// Özellikler:
//   - Kanal başlığında aktif thread sayısı rozeti
//   - Thread listesi paneli (aktif + arşivlenmiş)
//   - Thread arama
//   - Thread arşivleme / arşivden çıkarma
//   - Otomatik arşiv süresi göstergesi
//   - Discord'a paralel: 24s / 3 gün / 7 gün / Manuel seçenekleri

import { apiFetch }                          from './api-fetch.js';
import { getAPI, getCurrentServer, getCurrentChannel } from './globals.js';
import { escHtml, toast }                    from './utils.js';
import { BridgeRegistry }                    from './bridge-registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ThreadItem {
  _id:           string;
  name:          string;
  channelId:     string;
  parentMessageId?: string;
  messageCount?: number;
  participantCount?: number;
  locked?:       boolean;
  archived?:     boolean;
  archivedAt?:   number;
  autoArchiveDuration?: number; // hours: 1, 24, 72, 168
  lastMessageAt?: number;
  createdAt:     number;
  tags?:         string[];
  pinned?:       boolean;
}

// ── Open thread list panel ────────────────────────────────────────────────────

export async function openThreadListPanel(channelId: string, channelName: string): Promise<void> {
  document.getElementById('thread-list-panel')?.remove();
  const API = getAPI();

  const panel = document.createElement('div');
  panel.id = 'thread-list-panel';
  panel.style.cssText = `
    position:fixed; top:0; right:0; bottom:0;
    width:min(360px, 100vw);
    background:var(--bg-secondary);
    border-left:1px solid var(--border);
    z-index:900;
    display:flex; flex-direction:column;
    box-shadow:-4px 0 16px rgba(0,0,0,.3);
    transform:translateX(100%);
    transition:transform .2s ease;
  `;

  panel.innerHTML = `
    <div style="padding:16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0;">
      <span style="font-size:18px;">🧵</span>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:15px;">Thread'ler</div>
        <div style="font-size:12px;color:var(--text-3);">#${escHtml(channelName)}</div>
      </div>
      <button style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:16px;padding:4px;" onclick="document.getElementById('thread-list-panel').remove()" aria-label="Kapat">✕</button>
    </div>

    <!-- Search -->
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0;">
      <div style="position:relative;">
        <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);color:var(--text-3);">🔍</span>
        <input id="thread-list-search" type="text" placeholder="Thread ara..."
          style="width:100%;padding:8px 10px 8px 32px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;box-sizing:border-box;"
          oninput="window._tlSearch(this.value, '${channelId}')">
      </div>
    </div>

    <!-- Tabs -->
    <div style="display:flex;border-bottom:1px solid var(--border);flex-shrink:0;">
      <button id="tl-tab-active" onclick="window._tlSetTab('active','${channelId}')"
        style="flex:1;padding:10px;border:none;cursor:pointer;font-size:13px;font-weight:700;background:transparent;color:var(--accent);border-bottom:2px solid var(--accent);">
        Aktif
      </button>
      <button id="tl-tab-archived" onclick="window._tlSetTab('archived','${channelId}')"
        style="flex:1;padding:10px;border:none;cursor:pointer;font-size:13px;font-weight:400;background:transparent;color:var(--text-3);border-bottom:2px solid transparent;">
        Arşiv
      </button>
    </div>

    <!-- List -->
    <div id="thread-list-content" style="flex:1;overflow-y:auto;padding:8px;">
      <div style="text-align:center;padding:30px;color:var(--text-3);">Yükleniyor...</div>
    </div>
  `;

  document.body.appendChild(panel);
  // Animate in
  requestAnimationFrame(() => { panel.style.transform = 'translateX(0)'; });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!panel.contains(e.target as Node)) {
        panel.style.transform = 'translateX(100%)';
        setTimeout(() => { panel.remove(); document.removeEventListener('click', handler); }, 200);
      }
    });
  }, 100);

  await _loadThreadList(channelId, 'active', '');
}
BridgeRegistry.register('openThreadListPanel', openThreadListPanel);

// ── Load thread list ──────────────────────────────────────────────────────────

let _tlCurrentTab: 'active' | 'archived' = 'active';
let _tlQuery = '';

async function _loadThreadList(channelId: string, tab: 'active' | 'archived', query: string): Promise<void> {
  const API     = getAPI();
  const content = document.getElementById('thread-list-content');
  if (!content) return;
  content.innerHTML = '<div style="text-align:center;padding:30px;color:var(--text-3);">Yükleniyor...</div>';

  try {
    const params = new URLSearchParams({ tab, ...(query ? { q: query } : {}) });
    const r = await apiFetch(`${API}/api/threads/channel/${channelId}?${params}`);
    const threads: ThreadItem[] = r.ok ? await r.json() : [];
    content.innerHTML = _renderThreadList(threads, tab, channelId);
  } catch {
    content.innerHTML = '<div style="text-align:center;padding:30px;color:var(--red);">Yüklenemedi</div>';
  }
}

// ── Render list ───────────────────────────────────────────────────────────────

function _renderThreadList(threads: ThreadItem[], tab: 'active' | 'archived', channelId: string): string {
  if (!threads.length) {
    return `<div style="text-align:center;padding:40px 20px;color:var(--text-3);">
      ${tab === 'active'
        ? '🧵 Aktif thread yok.<br><span style="font-size:12px;">Mesaja tıklayarak thread açabilirsin.</span>'
        : '📦 Arşivlenmiş thread yok.'}
    </div>`;
  }

  return threads.map(t => _threadItem(t, channelId)).join('');
}

function _threadItem(t: ThreadItem, channelId: string): string {
  const age   = _relTime(t.lastMessageAt ?? t.createdAt);
  const count = t.messageCount ?? 0;
  const participants = t.participantCount ?? 0;

  const badges = [
    t.pinned  ? `<span style="font-size:10px;background:var(--accent);color:#fff;border-radius:4px;padding:1px 5px;">📌</span>` : '',
    t.locked  ? `<span style="font-size:10px;background:#ed4245;color:#fff;border-radius:4px;padding:1px 5px;">🔒</span>` : '',
    t.archived? `<span style="font-size:10px;background:var(--bg-5);color:var(--text-3);border-radius:4px;padding:1px 5px;">📦</span>` : '',
  ].filter(Boolean).join('');

  const autoArchiveLabel = t.autoArchiveDuration
    ? `• Arşiv: ${_archiveLabel(t.autoArchiveDuration)}`
    : '';

  return `
    <div style="padding:10px;border-radius:8px;cursor:pointer;transition:background .1s;margin-bottom:2px;"
      onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background=''"
      onclick="window._tlOpenThread('${t._id}','${escHtml(t.name)}')">
      <div style="display:flex;align-items:flex-start;gap:8px;">
        <span style="font-size:16px;margin-top:1px;">${t.locked ? '🔒' : '🧵'}</span>
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">
            <span style="font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(t.name)}</span>
            ${badges}
          </div>
          <div style="display:flex;gap:8px;font-size:11px;color:var(--text-3);margin-top:2px;flex-wrap:wrap;">
            <span>💬 ${count}</span>
            ${participants ? `<span>👥 ${participants}</span>` : ''}
            <span>🕐 ${age}</span>
            ${autoArchiveLabel ? `<span>${autoArchiveLabel}</span>` : ''}
          </div>
          ${(t.tags ?? []).length ? `<div style="display:flex;gap:3px;margin-top:4px;flex-wrap:wrap;">
            ${(t.tags ?? []).slice(0,3).map(tag => `<span style="background:var(--bg-1);border-radius:12px;padding:1px 6px;font-size:10px;color:var(--text-3);">${escHtml(tag)}</span>`).join('')}
          </div>` : ''}
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;flex-shrink:0;">
          ${!t.archived
            ? `<button onclick="event.stopPropagation();window._tlArchiveThread('${t._id}','${channelId}')"
                style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12px;padding:2px 4px;border-radius:4px;" title="Arşivle">📦</button>`
            : `<button onclick="event.stopPropagation();window._tlUnarchiveThread('${t._id}','${channelId}')"
                style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:12px;padding:2px 4px;border-radius:4px;" title="Arşivden çıkar">📤</button>`}
        </div>
      </div>
    </div>`;
}

// ── Window handlers ───────────────────────────────────────────────────────────

(window as Window & { _tlSetTab?: (tab: 'active' | 'archived', channelId: string) => void })._tlSetTab =
  (tab, channelId) => {
    _tlCurrentTab = tab;
    ['active', 'archived'].forEach(t => {
      const btn = document.getElementById(`tl-tab-${t}`);
      if (!btn) return;
      const active = t === tab;
      btn.style.fontWeight    = active ? '700' : '400';
      btn.style.color         = active ? 'var(--accent)' : 'var(--text-3)';
      btn.style.borderBottom  = active ? '2px solid var(--accent)' : '2px solid transparent';
    });
    _loadThreadList(channelId, tab, _tlQuery);
  };

(window as Window & { _tlSearch?: (q: string, channelId: string) => void })._tlSearch =
  (q, channelId) => {
    _tlQuery = q;
    _loadThreadList(channelId, _tlCurrentTab, q);
  };

(window as Window & { _tlOpenThread?: (id: string, name: string) => void })._tlOpenThread =
  (id, name) => {
    BridgeRegistry.call('openThread', id, name);
    document.getElementById('thread-list-panel')?.remove();
  };

(window as Window & { _tlArchiveThread?: (id: string, channelId: string) => Promise<void> })._tlArchiveThread =
  async (id, channelId) => {
    const API = getAPI();
    const r = await apiFetch(`${API}/api/threads/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: true }),
    });
    if (!r.ok) { toast('Arşivlenemedi', 'error'); return; }
    toast('📦 Thread arşivlendi', 'success');
    _loadThreadList(channelId, _tlCurrentTab, _tlQuery);
  };

(window as Window & { _tlUnarchiveThread?: (id: string, channelId: string) => Promise<void> })._tlUnarchiveThread =
  async (id, channelId) => {
    const API = getAPI();
    const r = await apiFetch(`${API}/api/threads/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ archived: false }),
    });
    if (!r.ok) { toast('İşlem başarısız', 'error'); return; }
    toast('📤 Thread aktif edildi', 'success');
    _loadThreadList(channelId, _tlCurrentTab, _tlQuery);
  };

// ── Thread count badge in channel header ──────────────────────────────────────

export async function updateThreadCountBadge(channelId: string): Promise<void> {
  const API  = getAPI();
  const badge = document.getElementById(`thread-count-badge-${channelId}`);
  if (!badge) return;

  try {
    const r = await apiFetch(`${API}/api/threads/channel/${channelId}/count`);
    if (!r.ok) return;
    const { active } = await r.json() as { active: number };
    badge.textContent = active > 0 ? `🧵 ${active}` : '';
    badge.style.display = active > 0 ? 'inline-flex' : 'none';
  } catch { /* non-critical */ }
}
BridgeRegistry.register('updateThreadCountBadge', updateThreadCountBadge);

// ── Auto-archive duration selector ────────────────────────────────────────────

export async function openAutoArchiveSettings(threadId: string, currentDuration: number): Promise<void> {
  document.getElementById('auto-archive-modal')?.remove();
  const API = getAPI();

  const options = [
    { h: 1,   label: '1 Saat' },
    { h: 24,  label: '24 Saat' },
    { h: 72,  label: '3 Gün' },
    { h: 168, label: '1 Hafta' },
  ];

  const modal = document.createElement('div');
  modal.id        = 'auto-archive-modal';
  modal.className = 'modal-overlay';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:340px;width:94%;">
      <h3 style="margin:0 0 6px;">⏱️ Otomatik Arşiv Süresi</h3>
      <p style="font-size:12px;color:var(--text-3);margin:0 0 16px;">Thread bu süre boyunca etkisiz kalırsa otomatik arşivlenir.</p>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${options.map(o => `
          <label style="display:flex;align-items:center;gap:10px;padding:10px 12px;background:var(--bg-1);border-radius:8px;cursor:pointer;border:1.5px solid ${currentDuration===o.h?'var(--accent)':'transparent'}">
            <input type="radio" name="auto-archive" value="${o.h}" ${currentDuration===o.h?'checked':''} style="accent-color:var(--accent);">
            <span style="font-size:14px;">${o.label}</span>
          </label>`).join('')}
      </div>
      <div class="modal-footer" style="margin-top:16px;display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="document.getElementById('auto-archive-modal').remove()">İptal</button>
        <button class="btn btn-primary" onclick="window._saveAutoArchive('${threadId}')">Kaydet</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}
BridgeRegistry.register('openAutoArchiveSettings', openAutoArchiveSettings);

(window as Window & { _saveAutoArchive?: (threadId: string) => Promise<void> })._saveAutoArchive =
  async (threadId) => {
    const val = parseInt((document.querySelector<HTMLInputElement>('input[name="auto-archive"]:checked'))?.value ?? '24');
    const API = getAPI();
    const r = await apiFetch(`${API}/api/threads/${threadId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ autoArchiveDuration: val }),
    });
    if (!r.ok) { toast('Ayar kaydedilemedi', 'error'); return; }
    toast(`⏱️ Otomatik arşiv: ${val}s`, 'success');
    document.getElementById('auto-archive-modal')?.remove();
  };

// ── Helpers ───────────────────────────────────────────────────────────────────

function _relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60000)  return 'az önce';
  if (diff < 3600000)return `${Math.floor(diff/60000)}dk`;
  if (diff < 86400000) return `${Math.floor(diff/3600000)}s`;
  return `${Math.floor(diff/86400000)}g`;
}

function _archiveLabel(hours: number): string {
  if (hours < 24)  return `${hours}s`;
  if (hours < 168) return `${Math.floor(hours/24)} gün`;
  return '1 hafta';
}
