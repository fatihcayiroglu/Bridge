// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ModalStatePanel.svelte
//              client/js/core/modal-state-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-perms/modal-state.ts
// Modül 1/6 — Modal State, Dirty Tracking, Matrix & Row Builders
// Sprint 38: window.* → ESM export + BridgeRegistry
//
// Sorumluluk:
//   - Modal açık durumdaki state (channelId, serverPerms, snapshot, isDirty, allRows)
//   - Dirty tracking (unsaved changes badge)
//   - Permission matrix HTML üretimi (buildMatrix, buildRow)
//   - cyclePerm, updateSaveInfo

import type { PermGroup } from '../channel-perms-data';
import { BridgeRegistry } from '../bridge-registry';
import { escHtml } from '../utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────
export interface OverrideState { allow: number; deny: number; }
export interface PermRow {
  _id: string; name: string; color: string;
  isEveryone: boolean; isUser: boolean; userId?: string;
  ov: OverrideState | null;
}
export interface ChpermsState {
  channelId: string | null; serverPerms: Record<string, number>;
  snapshot: Record<string, OverrideState | null>;
  isDirty: boolean; allRows: PermRow[];
}

// ── MODULE-LEVEL STATE ────────────────────────────────────────────────────────
const S: ChpermsState = { channelId: null, serverPerms: {}, snapshot: {}, isDirty: false, allRows: [] };
let _currentChannelId: string | null = null;
let _permGroups: PermGroup[] = [];

/** channel-perms-init.ts tarafından boot sırasında bir kez çağrılır */
export function setPermGroups(groups: PermGroup[]): void { _permGroups = groups; }

// ── DIRTY TRACKING ────────────────────────────────────────────────────────────
export function markDirty(): void {
  if (S.isDirty) return;
  S.isDirty = true;
  const title = document.querySelector<HTMLElement>('#ch-perms-modal h2');
  if (title && !title.dataset['dirty']) {
    title.dataset['dirty'] = '1';
    title.insertAdjacentHTML('beforeend',
      ' <span id="dirty-badge" style="font-size:11px;background:#f0b132;color:#000;padding:2px 7px;border-radius:10px;vertical-align:middle;font-weight:700">● Kaydedilmedi</span>');
  }
}

export function clearDirty(): void {
  S.isDirty = false;
  document.getElementById('dirty-badge')?.remove();
  const title = document.querySelector<HTMLElement>('#ch-perms-modal h2');
  if (title) delete title.dataset['dirty'];
}

// ── ROW HELPERS ───────────────────────────────────────────────────────────────
export function readRow(tr: HTMLTableRowElement): OverrideState {
  let allow = 0, deny = 0;
  tr.querySelectorAll<HTMLButtonElement>('.perm-toggle').forEach(btn => {
    const bit = parseInt(btn.dataset['bit'] ?? '0', 10);
    if (btn.dataset['state'] === 'allow') allow |= bit;
    if (btn.dataset['state'] === 'deny')  deny  |= bit;
  });
  return { allow, deny };
}

export function rowIsDirty(id: string, cur: OverrideState): boolean {
  const snap = S.snapshot[id];
  if (snap === null) return true;
  const s = snap ?? { allow: 0, deny: 0 };
  return cur.allow !== s.allow || cur.deny !== s.deny;
}

export function updateSaveInfo(): void {
  const info = document.getElementById('chperms-save-info');
  if (!info) return;
  const rows = document.querySelectorAll<HTMLTableRowElement>('#ch-perms-modal tr[data-role-id]');
  let count = 0; const seen = new Set<string>();
  rows.forEach(tr => {
    const id = tr.dataset['roleId'] ?? '';
    if (seen.has(id)) return; seen.add(id);
    if (rowIsDirty(id, readRow(tr))) count++;
  });
  Object.values(S.snapshot).forEach(v => { if (v === null) count++; });
  info.textContent = count > 0 ? `${count} değişiklik — sadece bunlar kaydedilecek` : '';
}

// ── HTML ESCAPE ───────────────────────────────────────────────────────────────
// escHtml — ../utils.ts'den import edilir; burada tekrar tanımlanmıyor.

// ── MATRIX BUILDER ────────────────────────────────────────────────────────────
export function buildMatrix(): string {
  if (S.allRows.length === 0)
    return '<p style="color:var(--text-3);padding:20px">Henüz override yok.</p>';

  // Dep-injection yoluyla gelen _permGroups kullanılır (window.PERM_GROUPS artık kullanılmıyor)
  const permGroups: PermGroup[] = _permGroups.length > 0
    ? _permGroups
    : (window as Record<string, unknown>)['PERM_GROUPS'] as PermGroup[] ?? []; // fallback: eski path
  const userRows = S.allRows.filter(r => r.isUser);
  const otherRows = S.allRows.filter(r => !r.isUser);

  const hoverStyle = `<style>#chperms-matrix td:hover .perm-inherit-btn{opacity:1!important}#chperms-matrix td{position:relative}</style>`;
  let userSectionNote = userRows.length > 0
    ? `<div style="font-size:11px;color:var(--brand);margin-bottom:8px;padding:6px 10px;background:var(--brand-bg,rgba(45,156,219,.08));border-radius:6px;border-left:3px solid var(--brand)">👤 Üye bazlı override'lar sunucudaki en yüksek önceliğe sahiptir.</div>`
    : '';

  let html = '';
  for (const group of permGroups) {
    html += `<div style="margin-bottom:24px">
      <div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--text-3);margin-bottom:10px;display:flex;align-items:center;gap:8px">
        ${group.label}<div style="flex:1;height:1px;background:var(--bg-4)"></div></div>
      ${userSectionNote}
      <table class="perm-matrix" style="width:100%;border-collapse:collapse">
        <thead><tr>
          <th style="min-width:145px;text-align:left;padding:6px 8px;font-size:11px;color:var(--text-3);font-weight:600">Rol / Üye</th>
          ${group.perms.map(p => `<th style="min-width:76px;padding:4px 2px;font-size:10px;color:var(--text-3);font-weight:600;text-align:center;line-height:1.2"><span title="${escHtml(p.desc)}" style="cursor:help;border-bottom:1px dotted var(--text-3);display:inline-block">${escHtml(p.label)}</span></th>`).join('')}
        </tr></thead>
        <tbody>${[...otherRows, ...userRows].map(row => buildRow(row, group.perms)).join('')}</tbody>
      </table></div>`;
    userSectionNote = '';
  }
  return hoverStyle + html;
}

export function buildRow(row: PermRow, perms: PermGroup['perms']): string {
  const ov = row.ov ?? { allow: 0, deny: 0 };
  let cells = `<td style="padding:6px 8px"><span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;${row.isEveryone?'font-weight:700;color:var(--brand)':''}${row.isUser?'font-style:italic':''}">
    <span style="width:10px;height:10px;border-radius:${row.isUser?'3px':'50%'};background:${row.color||'#99aab5'};flex-shrink:0"></span>
    ${row.isUser?'👤 ':''}${escHtml(row.name)}</span></td>`;
  for (const perm of perms) {
    const allowed = (ov.allow & perm.bit) !== 0, denied = (ov.deny & perm.bit) !== 0;
    const state = allowed ? 'allow' : denied ? 'deny' : 'neutral';
    cells += `<td style="text-align:center;padding:3px;position:relative">
      <button class="perm-toggle ${allowed?'allow':denied?'deny':''}" data-bit="${perm.bit}" data-state="${state}" data-role-id="${escHtml(row._id)}" data-bridge-action="cyclePerm" title="${escHtml(perm.desc)}">${allowed?'✅':denied?'❌':'—'}</button>
      <button class="perm-inherit-btn" data-bit="${perm.bit}" data-role-id="${escHtml(row._id)}" data-bridge-action="chpermsShowInheritance" title="Bu iznin kaynağını göster" style="position:absolute;top:1px;right:1px;background:none;border:none;cursor:pointer;font-size:9px;color:var(--text-3);opacity:0;transition:opacity .15s;padding:1px 3px;border-radius:3px;line-height:1">ℹ</button></td>`;
  }
  return `<tr data-role-id="${escHtml(row._id)}" style="${row.isEveryone?'background:var(--brand-bg-low,rgba(45,156,219,.07));border-bottom:2px solid var(--bg-4)':row.isUser?'background:var(--brand-bg-xlow,rgba(45,156,219,.04));border-left:3px solid var(--brand,#2d9cdb)':''}">${cells}</tr>`;
}

// ── CYCLE PERM ────────────────────────────────────────────────────────────────
export function cyclePerm(btn: HTMLButtonElement): void {
  const states = ['neutral', 'allow', 'deny'] as const;
  type PS = typeof states[number];
  const icons: Record<PS, string> = { neutral: '—', allow: '✅', deny: '❌' };
  const classes: Record<PS, string> = { neutral: '', allow: 'allow', deny: 'deny' };
  const cur = (btn.dataset['state'] ?? 'neutral') as PS;
  const next = states[(states.indexOf(cur) + 1) % states.length];
  btn.dataset['state'] = next; btn.textContent = icons[next];
  btn.className = 'perm-toggle ' + classes[next];
  markDirty(); updateSaveInfo();
}

// ── ACCESSORS ─────────────────────────────────────────────────────────────────
export function setCurrentChannelId(id: string): void { _currentChannelId = id; }
export function getCurrentChannelId(): string | null { return _currentChannelId; }
export function getState(): Readonly<ChpermsState> { return S; }
export function setState(patch: Partial<ChpermsState>): void { Object.assign(S, patch); }

// ── BridgeRegistry ────────────────────────────────────────────────────────────
BridgeRegistry.register('cyclePerm',                   (btn: HTMLButtonElement) => cyclePerm(btn));
BridgeRegistry.register('chpermsMarkDirty',            () => markDirty());
BridgeRegistry.register('chpermsClearDirty',           () => clearDirty());
BridgeRegistry.register('chpermsUpdateSaveInfo',       () => updateSaveInfo());
BridgeRegistry.register('chpermsBuildMatrix',          () => buildMatrix());
BridgeRegistry.register('chpermsBuildRow',             (r: PermRow, p: PermGroup['perms']) => buildRow(r, p));
BridgeRegistry.register('chpermsSetCurrentChannelId',  (id: string) => setCurrentChannelId(id));
