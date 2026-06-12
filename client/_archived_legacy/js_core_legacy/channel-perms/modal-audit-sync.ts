// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ModalAuditSyncPanel.svelte
//              client/js/core/modal-audit-sync-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-perms/modal-audit-sync.ts
// Modül 3/6 — Audit Log & Kategori Senkronizasyon Sekmesi
// Sprint 34: ESM refactor — IIFE → export functions, window.XXX → named exports

import type { ChpermsState } from './modal-state';
import type { PermGroup } from '../channel-perms-data';
import { escHtml } from '../utils.js';

// ── Local interfaces ──────────────────────────────────────────────────────────
interface AuditOverride { allow: number; deny: number }
interface AuditLog {
  action: string; createdAt: string | number;
  actorName?: string; targetId?: string; targetName?: string;
  old?: AuditOverride; new?: AuditOverride;
}
interface SyncChannel { _id: string; name: string; type?: string; categoryId?: string; category?: string }
export interface PermOverride {
  roleId?: string; allow: number; deny: number;
  targetType?: string; targetId?: string; targetName?: string
}
interface PreviewRow { channelName: string; totalChanges: number; added?: number; updated?: number; deleted?: number }
interface PreviewResult { summary: { channelsWithChanges: number }; preview: PreviewRow[] }

// ── Runtime deps ──────────────────────────────────────────────────────────────
export interface AuditSyncDeps {
  getState:            () => ChpermsState;
  getCurrentChannelId: () => string | null;
  setCurrentChannelId: (id: string) => void;
  loadAudit:           (channelId: string) => Promise<void>;
  applyAuditFilter:    () => void;
  resetAuditFilter:    () => void;
  openModal:           (channelId: string, channelName?: string) => Promise<void>;
  toast:               (msg: string, type: string, duration?: number) => void;
  apiFetch:            (url: string, opts?: RequestInit) => Promise<Response>;
  getAPI:              () => string;
  getServerId:         () => string | null;
  permGroups:          PermGroup[];
}

let _deps: AuditSyncDeps;

/** Call once during app boot. */
export function initModalAuditSync(deps: AuditSyncDeps): void {
  _deps = deps;

  // Build BIT_LABELS from injected permGroups
  for (const g of deps.permGroups) {
    for (const p of g.perms) {
      BIT_LABELS[p.bit] = p.label;
    }
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const BIT_LABELS: Record<number, string> = {};

/** Kanal tipi ikonunu döndür — bilinmeyenlerde '#' kullan */
function chanIcon(type: string | undefined): string {
  const ICONS: Record<string, string> = { voice: '🔊', VOICE: '🔊', text: '#', TEXT: '#' };
  return (ICONS as Record<string, string>)[type ?? ''] ?? '#';
}

// ── TAB GEÇİŞİ ────────────────────────────────────────────────────────────────
export function chpermsTab(tab: string): void {
  const activeTab = (document.querySelector('.chperms-tab-active') as HTMLElement | null)?.dataset?.['tab'];
  const state     = _deps.getState();
  if (activeTab === 'matrix' && tab !== 'matrix' && state.isDirty) {
    if (!confirm('Kaydedilmemiş değişiklikler var. Sekmeyi değiştirmek istiyor musun?\n(Değişiklikler kaybolmaz — geri dönüp kaydedebilirsin.)')) return;
  }

  for (const p of ['matrix', 'audit', 'sync']) {
    const el = document.getElementById(`chperms-pane-${p}`);
    if (el) el.style.display = p === tab ? 'flex' : 'none';
  }
  document.querySelectorAll<HTMLElement>('.chperms-tab').forEach(btn => {
    const active = btn.dataset['tab'] === tab;
    btn.classList.toggle('chperms-tab-active', active);
    btn.style.color        = active ? 'var(--text-1)' : 'var(--text-3)';
    btn.style.borderBottom = active ? '2px solid var(--brand)' : '2px solid transparent';
  });

  const channelId = _deps.getCurrentChannelId();
  if (tab === 'audit' && channelId) void _deps.loadAudit(channelId);
  if (tab === 'sync'  && channelId) void chpermsLoadSyncList(channelId);
}

// ── KATEGORİ SENKRONİZASYONU ──────────────────────────────────────────────────
let _syncChannels: SyncChannel[] = [];

export async function chpermsLoadSyncList(channelId: string): Promise<void> {
  const listEl = document.getElementById('chperms-sync-channel-list');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--text-3);font-size:12px">Yükleniyor…</p>';

  const serverId = _deps.getServerId();
  if (!serverId) return;

  try {
    const r    = await _deps.apiFetch(`${_deps.getAPI()}/api/servers/${serverId}/channels`);
    const data = await r.json() as SyncChannel[] | { channels?: SyncChannel[] };
    const allCh = Array.isArray(data) ? data : (data.channels ?? []);
    _syncChannels = allCh.filter(c =>
      c._id !== channelId &&
      ['text', 'TEXT', 'voice', 'VOICE', undefined, null, ''].includes(c.type as string)
    );

    if (_syncChannels.length === 0) {
      listEl.innerHTML = '<p style="color:var(--text-3);font-size:12px">Senkronize edilebilecek başka kanal yok.</p>';
      return;
    }

    const grouped: Record<string, SyncChannel[]> = {};
    for (const ch of _syncChannels) {
      const cat = ch.categoryId ?? ch.category ?? '__none__';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ch);
    }

    listEl.innerHTML = '';
    for (const [catId, channels] of Object.entries(grouped)) {
      const catName = catId === '__none__' ? '📁 Kategorisiz' : `📁 ${escHtml(catId)}`;

      const section = document.createElement('div');
      section.style.marginBottom = '10px';

      // Category header
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:4px';
      header.innerHTML = `
        <span style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase">${catName}</span>`;
      const catSelBtn = document.createElement('button');
      catSelBtn.textContent = 'Hepsini Seç';
      catSelBtn.style.cssText = 'font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid var(--bg-4);background:var(--bg-3);cursor:pointer;color:var(--text-2)';
      catSelBtn.addEventListener('click', () => chpermsSyncSelectCat(catId, true));
      header.appendChild(catSelBtn);
      section.appendChild(header);

      // Channel checkboxes
      for (const ch of channels) {
        const icon  = ch.type === 'voice' || ch.type === 'VOICE' ? '🔊' : '#';
        const label = document.createElement('label');
        label.style.cssText = 'display:flex;align-items:center;gap:8px;padding:5px 8px;border-radius:6px;cursor:pointer';
        label.addEventListener('mouseenter', () => { label.style.background = 'var(--bg-3)'; });
        label.addEventListener('mouseleave', () => { label.style.background = ''; });

        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.className = 'chperms-sync-cb';
        cb.dataset['id']  = ch._id;
        cb.dataset['cat'] = catId;
        cb.style.cssText  = 'width:15px;height:15px;cursor:pointer';
        cb.addEventListener('change', _updateSyncCount);

        label.appendChild(cb);
        label.insertAdjacentHTML('beforeend', `<span style="font-size:13px">${icon} ${escHtml(ch.name)}</span>`);
        section.appendChild(label);
      }
      listEl.appendChild(section);
    }
    _updateSyncCount();
  } catch {
    listEl.innerHTML = '<p style="color:var(--danger,#ed4245);font-size:12px">Kanallar yüklenemedi.</p>';
  }
}

function _updateSyncCount(): void {
  const cnt = document.querySelectorAll('.chperms-sync-cb:checked').length;
  const el  = document.getElementById('chperms-sync-count');
  if (el) el.textContent = cnt > 0 ? `${cnt} kanal seçili` : '';
}

export function chpermsSyncSelectAll(val: boolean): void {
  document.querySelectorAll<HTMLInputElement>('.chperms-sync-cb').forEach(cb => { cb.checked = val; });
  _updateSyncCount();
}

export function chpermsSyncSelectCat(catId: string, val: boolean): void {
  document.querySelectorAll<HTMLInputElement>(`.chperms-sync-cb[data-cat="${catId}"]`).forEach(cb => { cb.checked = val; });
  _updateSyncCount();
}

// ── BULK SYNC ÖNİZLEME ────────────────────────────────────────────────────────
export async function chpermsBulkSyncPreview(channelId: string): Promise<void> {
  const checkedIds = [...document.querySelectorAll<HTMLInputElement>('.chperms-sync-cb:checked')]
    .map(cb => cb.dataset['id'] ?? '').filter(Boolean);
  if (checkedIds.length === 0) { _deps.toast('Hiç kanal seçilmedi', 'error'); return; }

  const statusEl = document.getElementById('chperms-sync-status');
  if (statusEl) statusEl.textContent = 'Önizleme yükleniyor…';

  const serverId = _deps.getServerId();
  if (!serverId) return;

  let overrides: PermOverride[] = [];
  try {
    const r    = await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions`
    );
    const data = await r.json() as { overrides?: PermOverride[] };
    overrides  = (data.overrides ?? []).map(o => ({
      roleId: o.roleId, allow: o.allow ?? 0, deny: o.deny ?? 0,
      targetType: o.targetType, targetId: o.targetId, targetName: o.targetName,
    }));
  } catch {
    _deps.toast('Kaynak kanal izinleri alınamadı', 'error');
    if (statusEl) statusEl.textContent = '';
    return;
  }

  let preview: PreviewResult | null = null;
  try {
    const r2 = await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync/preview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: checkedIds, overrides }) }
    );
    preview = await r2.json() as PreviewResult;
  } catch {
    _deps.toast('Önizleme yüklenemedi', 'error');
    if (statusEl) statusEl.textContent = '';
    return;
  }
  if (statusEl) statusEl.textContent = '';
  _showSyncPreviewModal(channelId, checkedIds, overrides, preview);
}

function _showSyncPreviewModal(
  channelId: string, checkedIds: string[], overrides: PermOverride[], preview: PreviewResult
): void {
  document.getElementById('chperms-preview-modal')?.remove();
  const { preview: rows } = preview;
  const noChanges = rows.every(r => r.totalChanges === 0);

  const rowsHtml = rows.map(ch => {
    const hasChange = ch.totalChanges > 0;
    const badges: string[] = [];
    if (ch.added)   badges.push(`<span style="background:var(--green-bg,rgba(59,165,92,.15));color:var(--online,#3ba55c);padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">+${ch.added} ekle</span>`);
    if (ch.updated) badges.push(`<span style="background:rgba(250,166,26,.15);color:#faa61a;padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">~${ch.updated} güncelle</span>`);
    if (ch.deleted) badges.push(`<span style="background:rgba(237,66,69,.15);color:var(--danger,#ed4245);padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">-${ch.deleted} sil</span>`);
    return `<tr style="${hasChange ? '' : 'opacity:.5'}">
      <td style="padding:7px 8px;font-size:13px"># ${escHtml(ch.channelName)}</td>
      <td style="padding:7px 8px">${hasChange ? badges.join(' ') : '<span style="font-size:11px;color:var(--text-3)">değişiklik yok</span>'}</td>
    </tr>`;
  }).join('');

  const modal = document.createElement('div');
  modal.id = 'chperms-preview-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:10000;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.7)';
  modal.innerHTML = `
    <div style="background:var(--bg-1);border-radius:12px;padding:24px;width:560px;max-height:80vh;display:flex;flex-direction:column;gap:16px">
      <h3 style="margin:0;font-size:16px">🔁 Toplu Senkronizasyon Önizlemesi</h3>
      <div style="font-size:13px;color:var(--text-2)">${checkedIds.length} kanala uygulanacak değişiklikler:</div>
      <div style="overflow-y:auto;flex:1">
        ${noChanges
          ? '<p style="color:var(--text-3);font-size:13px">Tüm hedef kanallar kaynak kanalla zaten aynı — değişiklik yok.</p>'
          : `<table style="width:100%;border-collapse:collapse;font-size:13px">
              <thead><tr style="border-bottom:2px solid var(--bg-4)">
                <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px">Kanal</th>
                <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px">Değişiklikler</th>
              </tr></thead>
              <tbody>${rowsHtml}</tbody>
            </table>`}
      </div>
      <div id="chperms-preview-actions" style="display:flex;gap:10px;justify-content:flex-end"></div>
    </div>`;
  document.body.appendChild(modal);

  const actionsEl = modal.querySelector('#chperms-preview-actions')!;
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn';
  cancelBtn.style.padding = '8px 18px';
  cancelBtn.textContent = 'İptal';
  cancelBtn.addEventListener('click', () => modal.remove());
  actionsEl.appendChild(cancelBtn);

  if (!noChanges) {
    const applyBtn = document.createElement('button');
    applyBtn.className = 'btn btn-primary';
    applyBtn.style.cssText = 'padding:8px 18px;font-weight:700';
    applyBtn.textContent = '✅ Uygula';
    applyBtn.addEventListener('click', () => void chpermsBulkSync(channelId, checkedIds, overrides));
    actionsEl.appendChild(applyBtn);
  }
}

export async function chpermsBulkSync(channelId: string, checkedIds: string[], overrides: PermOverride[]): Promise<void> {
  document.getElementById('chperms-preview-modal')?.remove();
  const statusEl = document.getElementById('chperms-sync-status');
  if (statusEl) statusEl.textContent = 'Uygulanıyor…';

  const serverId = _deps.getServerId();
  if (!serverId) return;

  try {
    await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions/bulk-sync`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: checkedIds, overrides }) }
    );
    if (statusEl) statusEl.textContent = '';
    _deps.toast(`✅ ${checkedIds.length} kanal güncellendi`, 'success');
  } catch {
    if (statusEl) statusEl.textContent = '';
    _deps.toast('Toplu senkronizasyon başarısız', 'error');
  }
}

// ── EXPORT / IMPORT ───────────────────────────────────────────────────────────
export async function chpermsExport(channelId: string): Promise<void> {
  const serverId = _deps.getServerId();
  if (!serverId) return;
  try {
    const r    = await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions`
    );
    const data = await r.json();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = `channel-perms-${channelId}.json`;
    a.click(); URL.revokeObjectURL(url);
  } catch { _deps.toast('Dışa aktarma başarısız', 'error'); }
}

export function chpermsImportClick(channelId: string): void {
  const input    = document.createElement('input');
  input.type     = 'file';
  input.accept   = '.json';
  input.onchange = () => void chpermsImportFile(channelId, input);
  input.click();
}

export async function chpermsImportFile(channelId: string, input: HTMLInputElement): Promise<void> {
  const file = input.files?.[0];
  if (!file) return;

  let data: { overrides?: PermOverride[] };
  try {
    data = JSON.parse(await file.text()) as { overrides?: PermOverride[] };
  } catch { _deps.toast('Geçersiz JSON dosyası', 'error'); return; }

  if (!data.overrides || !Array.isArray(data.overrides)) {
    _deps.toast('Dosya formatı tanınmadı', 'error'); return;
  }
  if (!confirm(`${data.overrides.length} override içe aktarılacak. Mevcut override'lar silinecek. Devam et?`)) return;

  const serverId = _deps.getServerId();
  if (!serverId) return;

  try {
    await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${serverId}/channels/${channelId}/permissions/import`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides: data.overrides }) }
    );
    _deps.toast('İzinler içe aktarıldı ✅', 'success');
    void _deps.openModal(channelId);
  } catch { _deps.toast('İçe aktarma başarısız', 'error'); }
}
