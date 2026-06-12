// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ModalActionsPanel.svelte
//              client/js/core/modal-actions-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-perms/modal-actions.ts
// Modül 2/6 — Toolbar Actions
// Sprint 34: ESM refactor — IIFE → export functions, window.XXX → named exports

import type { PermRow, OverrideState, ChpermsState } from './modal-state';
import type { PermGroup, PermTemplate } from '../channel-perms-data';
import { escHtml } from '../utils.js';

// ── Runtime deps (injected at module init) ────────────────────────────────────
export interface ActionDeps {
  getState:        () => ChpermsState;
  markDirty:       () => void;
  updateSaveInfo:  () => void;
  buildMatrix:     () => string;
  toast:           (msg: string, type: string) => void;
  apiFetch:        (url: string, opts?: RequestInit) => Promise<Response>;
  getAPI:          () => string;
  getServerId:     () => string | null;
  permGroups:      PermGroup[];
  permTemplates:   PermTemplate[];
}

let _deps: ActionDeps;

/** Call once during app boot, before any modal is opened. */
export function initModalActions(deps: ActionDeps): void {
  _deps = deps;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Rol/üye adını kısalt ve renk avatar için baş harfleri döndür */
function roleColor(color: string | undefined): string {
  // Geçerli hex renk döndür, yoksa marka rengine düş
  const FALLBACK = 'var(--brand,#2d9cdb)';
  if (!color) return FALLBACK;
  return /^#[0-9a-fA-F]{3,8}$/.test(color) ? color : FALLBACK;
}

function initials(name: string): string {
  return (name || '?').split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ── ŞABLON UYGULA ─────────────────────────────────────────────────────────────
export function chpermsApplyTemplate(templateId: string): void {
  if (!templateId) return;
  const tpl = _deps.permTemplates.find(t => t.id === templateId);
  if (!tpl) return;

  if (!confirm(`"${tpl.label}" şablonu uygulanacak:\n\n${tpl.desc}\n\nMevcut tüm override'lar güncellenir. Devam et?`)) {
    const sel = document.getElementById('chperms-template-select') as HTMLSelectElement | null;
    if (sel) sel.value = '';
    return;
  }

  const state   = _deps.getState();
  const applied = tpl.apply(state.allRows) as Record<string, OverrideState>;
  for (const [id, val] of Object.entries(applied)) {
    const row = state.allRows.find(r => r._id === id);
    if (row) row.ov = { allow: val.allow, deny: val.deny };
  }

  const matrixEl = document.getElementById('chperms-matrix');
  if (matrixEl) matrixEl.innerHTML = _deps.buildMatrix();
  const sel = document.getElementById('chperms-template-select') as HTMLSelectElement | null;
  if (sel) sel.value = '';
  _deps.markDirty();
  _deps.updateSaveInfo();
  _deps.toast(`"${tpl.label}" şablonu uygulandı ✅`, 'success');
}

// ── KULLANICI ARAMA ────────────────────────────────────────────────────────────
export function chpermsOpenUserSearch(): void {
  const existingPanel = document.getElementById('user-search-panel');
  if (existingPanel) { existingPanel.remove(); return; }

  const matrix = document.getElementById('chperms-matrix');
  if (!matrix) return;

  const panel = document.createElement('div');
  panel.id = 'user-search-panel';
  panel.style.cssText = [
    'position:sticky', 'top:0', 'z-index:100', 'background:var(--bg-2)',
    'border:1px solid var(--brand)', 'border-radius:8px',
    'padding:12px 16px', 'margin-bottom:16px',
  ].join(';');

  panel.innerHTML = `
    <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
      <span style="font-weight:700;font-size:13px">👤 Üyeye Özel İzin Ekle</span>
      <span style="font-size:11px;color:var(--text-3)">— rol izinlerini geçersiz kılar, en yüksek öncelik</span>
      <button id="user-search-close-btn"
        style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:16px;margin-left:auto">✕</button>
    </div>
    <input id="user-search-input" type="text" placeholder="Üye adı ara (en az 2 karakter)..."
      style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;
             border:1px solid var(--bg-4);background:var(--bg-3);color:var(--text-1);font-size:13px">
    <div id="user-search-results" style="margin-top:8px;max-height:200px;overflow:auto"></div>
  `;
  matrix.insertBefore(panel, matrix.firstChild);

  document.getElementById('user-search-close-btn')
    ?.addEventListener('click', () => document.getElementById('user-search-panel')?.remove());

  const input = document.getElementById('user-search-input') as HTMLInputElement | null;
  input?.addEventListener('input', () => void chpermsSearchUser(input.value));
  input?.focus();
}

export async function chpermsSearchUser(query: string): Promise<void> {
  const resultsEl = document.getElementById('user-search-results');
  if (!resultsEl) return;
  if (query.trim().length < 2) { resultsEl.innerHTML = ''; return; }

  const state           = _deps.getState();
  const existingUserIds = state.allRows.filter(r => r.isUser).map(r => r.userId);
  const serverId        = _deps.getServerId();
  if (!serverId) return;

  try {
    const r = await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${serverId}/members?search=${encodeURIComponent(query.trim())}&limit=8`
    );
    if (!r.ok) {
      resultsEl.innerHTML = '<p style="color:var(--text-3);font-size:12px;padding:4px 8px">Arama başarısız</p>';
      return;
    }
    const members = await r.json() as Array<{
      userId?: string; _id?: string; displayName?: string; username?: string
    }>;

    if (!members.length) {
      resultsEl.innerHTML = '<p style="color:var(--text-3);font-size:12px;padding:4px 8px">Sonuç bulunamadı</p>';
      return;
    }

    resultsEl.innerHTML = '';
    for (const m of members) {
      const uid     = m.userId ?? m._id ?? '';
      const name    = m.displayName ?? m.username ?? uid;
      const already = existingUserIds.includes(uid);

      const item = document.createElement('div');
      item.style.cssText = [
        'display:flex', 'align-items:center', 'gap:10px', 'padding:7px 10px',
        'border-radius:6px', `opacity:${already ? 0.5 : 1}`,
        `cursor:${already ? 'default' : 'pointer'}`, 'transition:background .15s',
      ].join(';');
      item.innerHTML = `
        <span style="width:30px;height:30px;border-radius:50%;background:var(--brand,#2d9cdb);
          display:flex;align-items:center;justify-content:center;
          font-size:12px;font-weight:700;color:#fff;flex-shrink:0">${escHtml(initials(name))}</span>
        <span style="font-size:13px;flex:1">${escHtml(name)}</span>
        <span style="font-size:11px;color:${already ? 'var(--text-3)' : 'var(--brand)'}">
          ${already ? 'Zaten eklendi' : '+ Ekle'}
        </span>`;
      if (!already) {
        item.addEventListener('mouseenter', () => { item.style.background = 'var(--bg-3)'; });
        item.addEventListener('mouseleave', () => { item.style.background = ''; });
        item.addEventListener('click', () => chpermsAddUser(uid, name));
      }
      resultsEl.appendChild(item);
    }
  } catch {
    resultsEl.innerHTML = '<p style="color:var(--text-3);font-size:12px;padding:4px 8px">Arama hatası</p>';
  }
}

export function chpermsAddUser(userId: string, displayName: string): void {
  const state = _deps.getState();
  const rowId = `user:${userId}`;
  if (state.allRows.find(r => r._id === rowId)) {
    _deps.toast('Bu üye zaten listede', 'info');
    return;
  }

  const newRow: PermRow = {
    _id: rowId, name: displayName, color: '#2d9cdb',
    isEveryone: false, isUser: true, userId,
    ov: { allow: 0, deny: 0 },
  };
  state.allRows.push(newRow);
  state.snapshot[rowId] = { allow: 0, deny: 0 };

  const sel = document.getElementById('chperms-role-select') as HTMLSelectElement | null;
  if (sel) {
    const opt = document.createElement('option');
    opt.value = rowId;
    opt.textContent = `👤 ${displayName}`;
    sel.appendChild(opt);
  }

  const matrixEl = document.getElementById('chperms-matrix');
  if (matrixEl) matrixEl.innerHTML = _deps.buildMatrix();
  document.getElementById('user-search-panel')?.remove();
  chpermsSelectRole(rowId);
  _deps.markDirty();
  _deps.updateSaveInfo();
  _deps.toast(`${displayName} eklendi — izinleri ayarla ve kaydet`, 'success');
}

// ── ROL/ÜYE SEÇİCİ ────────────────────────────────────────────────────────────
export function chpermsSelectRole(rowId: string): void {
  const state      = _deps.getState();
  const hasRow     = !!rowId;
  const row        = state.allRows.find(r => r._id === rowId);
  const isUser     = row?.isUser ?? false;
  const isEveryone = rowId === '__everyone__';

  for (const id of ['btn-grant-all', 'btn-deny-all', 'btn-reset-all']) {
    const el = document.getElementById(id) as HTMLButtonElement | null;
    if (el) el.disabled = !hasRow;
  }

  const syncBtn   = document.getElementById('btn-sync-server') as HTMLButtonElement | null;
  const removeBtn = document.getElementById('btn-remove-row')  as HTMLButtonElement | null;
  if (syncBtn) {
    syncBtn.disabled      = !hasRow || isUser || isEveryone;
    syncBtn.style.display = (isUser || isEveryone) ? 'none' : '';
  }
  if (removeBtn) removeBtn.disabled = !hasRow || isEveryone;

  const sel = document.getElementById('chperms-role-select') as HTMLSelectElement | null;
  if (sel && sel.value !== rowId) sel.value = rowId;

  document.querySelectorAll<HTMLTableRowElement>('#ch-perms-modal tr[data-role-id]').forEach(tr => {
    tr.style.outline      = tr.dataset['roleId'] === rowId ? '2px solid var(--brand)' : '';
    tr.style.borderRadius = '4px';
  });
}

// ── TOPLU İZİN BUTONLARI ──────────────────────────────────────────────────────
function _selectedToggles(): HTMLButtonElement[] {
  const rowId = (document.getElementById('chperms-role-select') as HTMLSelectElement | null)?.value;
  if (!rowId) return [];
  return [...document.querySelectorAll<HTMLButtonElement>(
    `#ch-perms-modal tr[data-role-id="${CSS.escape(rowId)}"] .perm-toggle`
  )];
}

type PermState = 'neutral' | 'allow' | 'deny';

function _applyState(btn: HTMLButtonElement, state: PermState): void {
  const icons:   Record<PermState, string> = { neutral: '—', allow: '✅', deny: '❌' };
  const classes: Record<PermState, string> = { neutral: '', allow: 'allow', deny: 'deny' };
  btn.dataset['state'] = state;
  btn.textContent      = icons[state];
  btn.className        = 'perm-toggle ' + classes[state];
}

export function chpermsGrantAll(): void {
  _selectedToggles().forEach(b => _applyState(b, 'allow'));
  _deps.markDirty(); _deps.updateSaveInfo();
}
export function chpermsDenyAll(): void {
  _selectedToggles().forEach(b => _applyState(b, 'deny'));
  _deps.markDirty(); _deps.updateSaveInfo();
}
export function chpermsResetAll(): void {
  _selectedToggles().forEach(b => _applyState(b, 'neutral'));
  _deps.markDirty(); _deps.updateSaveInfo();
}

// ── SUNUCU İZNİ SENKRONIZE ────────────────────────────────────────────────────
export function chpermsSyncServer(): void {
  const state = _deps.getState();
  const rowId = (document.getElementById('chperms-role-select') as HTMLSelectElement | null)?.value;
  if (!rowId || rowId === '__everyone__') return;
  const row = state.allRows.find(r => r._id === rowId);
  if (!row || row.isUser) return;
  const serverBits = state.serverPerms[rowId] ?? 0;
  _selectedToggles().forEach(btn => {
    const bit = parseInt(btn.dataset['bit'] ?? '0', 10);
    _applyState(btn, (serverBits & bit) !== 0 ? 'allow' : 'deny');
  });
  _deps.markDirty();
  _deps.updateSaveInfo();
  _deps.toast("Sunucu izinleri kanal override'larına yansıtıldı 🔄", 'success');
}

// ── SATIR KALDIR ──────────────────────────────────────────────────────────────
export function chpermsRemoveRow(): void {
  const state = _deps.getState();
  const rowId = (document.getElementById('chperms-role-select') as HTMLSelectElement | null)?.value;
  if (!rowId || rowId === '__everyone__') return;
  const row = state.allRows.find(r => r._id === rowId);
  if (!row) return;
  if (!confirm(`"${row.name}" override'ı kaldırılsın? Bu değişiklik kaydedildiğinde silinecek.`)) return;

  const idx = state.allRows.findIndex(r => r._id === rowId);
  if (idx !== -1) state.allRows.splice(idx, 1);
  state.snapshot[rowId] = null;

  const sel = document.getElementById('chperms-role-select') as HTMLSelectElement | null;
  sel?.querySelector(`option[value="${CSS.escape(rowId)}"]`)?.remove();
  if (sel) sel.value = '';
  chpermsSelectRole('');

  const matrixEl = document.getElementById('chperms-matrix');
  if (matrixEl) matrixEl.innerHTML = _deps.buildMatrix();
  _deps.markDirty();
  _deps.updateSaveInfo();
  _deps.toast(`"${row.name}" override'ı kaldırıldı — kaydetmeyi unutma`, 'info');
}
