// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ModalCorePanel.svelte
//              client/js/core/modal-core-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-perms/modal-core.ts
// Sprint 63: İçerik panelleri Svelte'e taşındı (540 → ~200 satır).
// Bu modül artık sadece:
//   1. API'den veri yükleme
//   2. Svelte shell'i mount etme ve prop'larını güncelleme
//   3. Kaydet, Inheritance popup, Socket listener

import type { ChpermsState, PermRow, OverrideState } from './modal-state';
import { BridgeRegistry } from '../bridge-registry.js';
import type { PermGroup } from '../channel-perms-data';
import { escHtml } from '../utils.js';
import { mountChannelPermsShell, unmountChannelPermsShell } from './channel-perms-svelte.js';

import { createLogger } from './logger.js';
const log = createLogger('ChanPerms');


// ── Local interfaces ──────────────────────────────────────────────────────────
interface ServerRole { _id: string; name: string; color?: string; permissions?: number }
interface PermApiOverride {
  targetType?: string; targetId?: string; targetName?: string;
  allow?: number; deny?: number;
}
interface InheritanceData {
  roleName: string; isUser?: boolean; hasOverride?: boolean;
  serverDefault?: number; rolePermissions?: number;
  override?: OverrideState;
  bitSources?: Record<number, { source: string; state: string; label?: string }>;
}

// ── Runtime deps ──────────────────────────────────────────────────────────────
export interface CoreDeps {
  getState:            () => ChpermsState;
  clearDirty:          () => void;
  readRow:             (tr: HTMLTableRowElement) => OverrideState;
  rowIsDirty:          (id: string, cur: OverrideState) => boolean;
  updateSaveInfo:      () => void;
  buildMatrix:         () => string;
  setCurrentChannelId: (id: string) => void;
  markDirty:           () => void;
  chpermsTab:          (tab: string) => void;
  chpermsSelectRole:   (rowId: string) => void;
  chpermsGrantAll:     () => void;
  chpermsDenyAll:      () => void;
  chpermsResetAll:     () => void;
  chpermsSyncServer:   () => void;
  chpermsRemoveRow:    () => void;
  chpermsOpenUserSearch: () => void;
  chpermsApplyTemplate:  (id: string) => void;
  chpermsSyncSelectAll:  (val: boolean) => void;
  chpermsBulkSyncPreview:(channelId: string) => Promise<void>;
  chpermsExport:         (channelId: string) => Promise<void>;
  chpermsImportClick:    (channelId: string) => void;
  chpermsApplyAuditFilter: () => void;
  chpermsResetAuditFilter: () => void;
  chpermsShowInheritance:  (btn: HTMLButtonElement) => Promise<void>;
  toast:               (msg: string, type: string) => void;
  apiFetch:            (url: string, opts?: RequestInit) => Promise<Response>;
  getAPI:              () => string;
  getServer:           () => { _id: string; channels?: Array<{ _id: string; name: string }> } | null;
  socket?: { on: (event: string, handler: (...a: unknown[]) => void) => void; off: (event: string, handler?: (...a: unknown[]) => void) => void };
  loadServerChannels?: (serverId: string) => Promise<void>;
  renderChannels?:     () => void;
  permGroups:          PermGroup[];
  permTemplates:       Array<{ id: string; label: string }>;
}

let _deps: CoreDeps = null!;
let _shellHandle: Awaited<ReturnType<typeof mountChannelPermsShell>> = null;

export function initModalCore(deps: CoreDeps): void {
  _deps = deps;
  _registerPermSocketListener();
  BridgeRegistry.register('chpermsShowInheritance', chpermsShowInheritance as (...args: unknown[]) => unknown);
}

// ── MODAL AÇMA ────────────────────────────────────────────────────────────────
export async function openChannelPermsModal(channelId: string, channelName?: string): Promise<void> {
  const server = _deps.getServer();
  if (!server) return;

  document.getElementById('ch-perms-modal')?.remove();
  unmountChannelPermsShell();

  const S = _deps.getState();
  S.channelId = channelId; S.serverPerms = {}; S.snapshot = {}; S.isDirty = false; S.allRows = [];
  _deps.setCurrentChannelId(channelId);

  const r = await _deps.apiFetch(
    `${_deps.getAPI()}/api/servers/${server._id}/channels/${channelId}/permissions`
  );
  if (!r.ok) { _deps.toast('İzinler yüklenemedi', 'error'); return; }

  const { overrides, roles } = await r.json() as { overrides: PermApiOverride[]; roles: ServerRole[] };

  const overrideMap: Record<string, PermApiOverride> = {};
  for (const o of overrides) {
    const key = o.targetType === 'user' ? `user:${o.targetId}`
      : o.targetType === 'everyone' ? '__everyone__' : (o as { roleId?: string }).roleId ?? '';
    overrideMap[key] = o;
  }
  for (const role of roles) { S.serverPerms[role._id] = role.permissions ?? 0; }

  const evOv = overrideMap['__everyone__'];
  S.allRows.push({ _id: '__everyone__', name: '@everyone', color: '#99aab5', isEveryone: true, isUser: false,
    ov: evOv ? { allow: evOv.allow ?? 0, deny: evOv.deny ?? 0 } : { allow: 0, deny: 0 } });
  S.snapshot['__everyone__'] = evOv ? { allow: evOv.allow ?? 0, deny: evOv.deny ?? 0 } : { allow: 0, deny: 0 };

  for (const role of roles.filter(r => r._id !== '__everyone__')) {
    const ov = overrideMap[role._id];
    S.allRows.push({ _id: role._id, name: role.name, color: role.color ?? '#99aab5',
      isEveryone: false, isUser: false, ov: ov ? { allow: ov.allow ?? 0, deny: ov.deny ?? 0 } : null });
    S.snapshot[role._id] = ov ? { allow: ov.allow ?? 0, deny: ov.deny ?? 0 } : { allow: 0, deny: 0 };
  }

  for (const [key, o] of Object.entries(overrideMap)) {
    if (!key.startsWith('user:')) continue;
    const userId = key.slice(5);
    S.allRows.push({ _id: key, name: o.targetName ?? userId, color: '#2d9cdb',
      isEveryone: false, isUser: true, userId, ov: { allow: o.allow ?? 0, deny: o.deny ?? 0 } });
    S.snapshot[key] = { allow: o.allow ?? 0, deny: o.deny ?? 0 };
  }

  // ── Svelte props ─────────────────────────────────────────────────────────
  const roleOptions = S.allRows.map(r => ({ id: r._id, name: r.name, isUser: r.isUser }));
  const templateOptions = (_deps.permTemplates ?? []).map(t => ({ id: t.id, label: t.label }));
  const matrixHtml = _deps.buildMatrix();
  const resolvedName = channelName ?? channelId;

  function _tryClose(): void {
    if (_deps.getState().isDirty) {
      if (!confirm('Kaydedilmemiş değişiklikler var. Çıkmak istediğine emin misin?')) return;
    }
    document.getElementById('ch-perms-modal')?.remove();
    unmountChannelPermsShell();
  }

  _shellHandle = await mountChannelPermsShell(channelId, resolvedName, _tryClose, {
    roleOptions,
    templateOptions,
    matrixHtml,
    isDirty: false,
    saveInfo: '',
    onRoleSelect:        (id) => _deps.chpermsSelectRole(id),
    onGrantAll:          ()   => _deps.chpermsGrantAll(),
    onDenyAll:           ()   => _deps.chpermsDenyAll(),
    onResetAll:          ()   => _deps.chpermsResetAll(),
    onSyncServer:        ()   => _deps.chpermsSyncServer(),
    onRemoveRow:         ()   => _deps.chpermsRemoveRow(),
    onAddUser:           ()   => _deps.chpermsOpenUserSearch(),
    onTemplateApply:     (id) => _deps.chpermsApplyTemplate(id),
    onSave:              ()   => void saveChannelPerms(channelId),
    onAuditFilter:       ()   => _deps.chpermsApplyAuditFilter(),
    onAuditReset:        ()   => _deps.chpermsResetAuditFilter(),
    onExport:            ()   => void _deps.chpermsExport(channelId),
    onImportClick:       ()   => _deps.chpermsImportClick(channelId),
    onSyncSelectAll:     (v)  => _deps.chpermsSyncSelectAll(v),
    onBulkSyncPreview:   ()   => void _deps.chpermsBulkSyncPreview(channelId),
    onTab:               (t)  => _deps.chpermsTab(t),
  });

  if (!_shellHandle) {
    // Svelte yüklenemedi — hata logla, sessiz degredation yok
    log.error('[channel-perms] Svelte shell yüklenemedi.');
    _deps.toast('İzin modalı açılamadı. Sayfayı yenileyin.', 'error');
    return;
  }

  // Matrix içindeki inheritance butonları için event delegation
  document.querySelector('#chperms-matrix')?.addEventListener('click', e => {
    const btn = (e.target as Element).closest<HTMLButtonElement>('.inherit-btn');
    if (btn) void _deps.chpermsShowInheritance(btn);
  });
}

/** modal-core dışından dirty/saveInfo/matrixHtml güncellemek için */
export function updateModalProps(patch: Record<string, unknown>): void {
  _shellHandle?.updateProps(patch);
}

// ── INHERITANCE POPUP ─────────────────────────────────────────────────────────
export async function chpermsShowInheritance(btn: HTMLButtonElement): Promise<void> {
  const bit = parseInt(btn.dataset['bit'] ?? '0', 10);
  const roleId = btn.dataset['roleId'] ?? '';
  const rect = btn.getBoundingClientRect();
  const channelId = _deps.getState().channelId;
  const server = _deps.getServer();
  if (!server || !channelId) return;

  document.getElementById('chperms-inherit-popup')?.remove();
  const popup = document.createElement('div');
  popup.id = 'chperms-inherit-popup';
  popup.style.cssText = [
    'position:fixed',
    `top:${Math.min(rect.bottom + 4, window.innerHeight - 260)}px`,
    `left:${Math.max(rect.left - 180, 8)}px`,
    'z-index:30000', 'background:var(--bg-1)', 'border:1px solid var(--bg-4)',
    'border-radius:10px', 'padding:14px 16px', 'min-width:260px',
    'max-width:320px', 'box-shadow:var(--shadow-lg)', 'font-size:12px',
  ].join(';');
  popup.innerHTML = '<div style="color:var(--text-3)">Yükleniyor…</div>';
  document.body.appendChild(popup);

  const _close = (e: Event): void => {
    if (!popup.contains(e.target as Node) && e.target !== btn) {
      popup.remove();
      document.removeEventListener('mousedown', _close as EventListener);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', _close as EventListener), 50);

  try {
    const r = await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${server._id}/channels/${channelId}/permissions/inheritance/${encodeURIComponent(roleId)}`
    );
    const data = await r.json() as InheritanceData;

    let permLabel = `Bit 0x${bit.toString(16)}`;
    for (const g of _deps.permGroups) {
      const p = g.perms.find(p => p.bit === bit);
      if (p) { permLabel = p.label; break; }
    }

    const src = data.bitSources?.[bit];
    const SOURCE_ICONS: Record<string, string> = {
      channel_override: '📌', role: '🏷️', server_default: '🌐', none: '🚫',
    };
    const icon = SOURCE_ICONS[src?.source ?? ''] ?? 'ℹ';
    const state = src?.state === 'allow' ? '✅ İzin Veriliyor' : '❌ Reddediliyor';
    const stateColor = src?.state === 'allow' ? 'var(--online,#3ba55c)' : 'var(--danger,#ed4245)';

    popup.innerHTML = `
      <div style="font-weight:800;font-size:13px;margin-bottom:10px;color:var(--text-1)">${icon} ${escHtml(permLabel)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:18px">${src?.state === 'allow' ? '✅' : '❌'}</span>
        <span style="font-weight:700;color:${stateColor}">${state}</span>
      </div>
      <div style="background:var(--bg-2);border-radius:7px;padding:8px 10px;margin-bottom:8px">
        <div style="font-size:11px;color:var(--text-3);margin-bottom:2px">KAYNAK</div>
        <div style="font-size:12px;color:var(--text-1);font-weight:600">${icon} ${escHtml(src?.label ?? 'Bilinmiyor')}</div>
      </div>
      <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;font-weight:600">İZİN ZİNCİRİ</div>
      <div style="display:flex;flex-direction:column;gap:3px">${_inheritanceChain(data, bit)}</div>
      <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--bg-4);font-size:10px;color:var(--text-3)">
        Rol: <strong>${escHtml(data.roleName)}</strong>
        ${data.hasOverride ? ' · <span style="color:var(--brand)">Kanal override var</span>' : ''}
      </div>`;
  } catch {
    popup.innerHTML = '<div style="color:var(--danger,#ed4245);font-size:12px">Kalıtım bilgisi yüklenemedi</div>';
  }
}

function _inheritanceChain(data: InheritanceData, bit: number): string {
  const rows: string[] = [];
  const fromDefault = ((data.serverDefault ?? 0) & bit) !== 0;
  rows.push(_chainRow('🌐 Sunucu Varsayılanı', fromDefault ? 'allow' : 'none',
    data.bitSources?.[bit]?.source === 'server_default'));
  if (!data.isUser && data.rolePermissions !== undefined) {
    const fromRole = (data.rolePermissions & bit) !== 0;
    rows.push(_chainRow(`🏷️ Rol: ${escHtml(data.roleName)}`, fromRole ? 'allow' : 'none',
      data.bitSources?.[bit]?.source === 'role'));
  }
  if (data.hasOverride && data.override) {
    const ovrAllow = (data.override.allow & bit) !== 0;
    const ovrDeny  = (data.override.deny  & bit) !== 0;
    const st = ovrAllow ? 'allow' : ovrDeny ? 'deny' : 'neutral';
    rows.push(_chainRow('📌 Kanal Override', st, data.bitSources?.[bit]?.source === 'channel_override'));
  }
  return rows.join('');
}

function _chainRow(label: string, state: string, isActive: boolean): string {
  const icon = state === 'allow' ? '✅' : state === 'deny' ? '❌' : '—';
  const color = isActive ? 'var(--brand)' : 'var(--text-3)';
  const weight = isActive ? '700' : '400';
  return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;
    padding:3px 6px;border-radius:5px;${isActive ? 'background:var(--brand-bg,rgba(45,156,219,.08))' : ''}">
    <span>${icon}</span>
    <span style="color:${color};font-weight:${weight};flex:1">${label}</span>
    ${isActive ? '<span style="font-size:9px;color:var(--brand);font-weight:800">◀ ETKİN</span>' : ''}
  </div>`;
}

// ── KAYDET ────────────────────────────────────────────────────────────────────
export async function saveChannelPerms(channelId: string): Promise<void> {
  const S = _deps.getState();
  const rows = document.querySelectorAll<HTMLTableRowElement>('#ch-perms-modal tr[data-role-id]');
  const overrides: object[] = [];
  const deletes: string[] = [];
  const seen = new Set<string>();

  for (const row of rows) {
    const id = row.dataset['roleId'] ?? '';
    if (seen.has(id)) continue;
    seen.add(id);
    const cur = _deps.readRow(row);
    if (!_deps.rowIsDirty(id, cur)) continue;
    const rowData = S.allRows.find(r => r._id === id);
    if (id === '__everyone__') {
      overrides.push({ roleId: '__everyone__', allow: cur.allow, deny: cur.deny, targetType: 'everyone' });
    } else if (rowData?.isUser) {
      overrides.push({ roleId: id, allow: cur.allow, deny: cur.deny,
        targetType: 'user', targetId: rowData.userId, targetName: rowData.name });
    } else {
      overrides.push({ roleId: id, allow: cur.allow, deny: cur.deny });
    }
  }
  for (const [snapId, val] of Object.entries(S.snapshot)) {
    if (val !== null) continue;
    deletes.push(snapId);
  }

  if (overrides.length === 0 && deletes.length === 0) {
    _deps.toast('Değişiklik yok, kaydedilecek bir şey bulunamadı.', 'info');
    return;
  }

  const server = _deps.getServer();
  if (!server) return;

  try {
    await _deps.apiFetch(
      `${_deps.getAPI()}/api/servers/${server._id}/channels/${channelId}/permissions/batch`,
      { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ overrides, deletes }) }
    );
    rows.forEach(row => {
      const id = row.dataset['roleId'] ?? '';
      if (S.snapshot[id] !== null) S.snapshot[id] = _deps.readRow(row);
    });
    for (const id of Object.keys(S.snapshot)) {
      if (S.snapshot[id] === null) delete S.snapshot[id];
    }
    _deps.clearDirty();
    _deps.updateSaveInfo();
    _deps.toast(`${overrides.length + deletes.length} izin değişikliği kaydedildi ✅`, 'success');
    document.getElementById('ch-perms-modal')?.remove();
    unmountChannelPermsShell();
  } catch {
    _deps.toast('Kaydetme sırasında hata oluştu', 'error');
  }
}

// ── SOCKET LİSTENER ───────────────────────────────────────────────────────────
function _registerPermSocketListener(): void {
  let _attempts = 0;
  const _try = (): void => {
    if (!_deps.socket) {
      if (++_attempts < 20) setTimeout(_try, 500);
      return;
    }
    _deps.socket.off('permissions:updated', _onPermsUpdated);
    _deps.socket.on('permissions:updated', _onPermsUpdated);
  };

  function _onPermsUpdated({ serverId, channelId }: { serverId: string; channelId: string }): void {
    const server = _deps.getServer();
    if (!server || server._id !== serverId) return;
    if (typeof _deps.loadServerChannels === 'function') {
      void _deps.loadServerChannels(serverId);
    } else if (typeof _deps.renderChannels === 'function') {
      _deps.renderChannels();
    }
    const modal = document.getElementById('ch-perms-modal');
    const state = _deps.getState();
    if (modal && state.channelId === channelId && !state.isDirty) {
      _deps.toast('⚠️ Bu kanalın izinleri başka bir admin tarafından güncellendi', 'info');
    }
  }

  _try();
}
