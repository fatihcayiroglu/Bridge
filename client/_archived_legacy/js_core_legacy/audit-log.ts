// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AuditLogPanel.svelte
//              client/js/core/audit-log-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { apiFetch } from './api-fetch.js';
import { getAPI } from './globals.js';
// core/audit-log.ts
// Filtreler, sayfalama, CSV/JSON export

import { BridgeRegistry } from './bridge-registry.js';

// ── Types ────────────────────────────────────────────────────────────────────

interface AuditLogEntry {
  _id?: string;
  action: string;
  actorName?: string;
  targetName?: string;
  detail?: string;
  createdAt: number;
}

interface AuditLogResponse {
  logs?: AuditLogEntry[];
  total?: number;
  hasMore?: boolean;
  error?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────

const AUDIT_PAGE_SIZE = 50;

const ACTION_ICONS: Record<string, string> = {
  TIMEOUT: '⏱️', BAN: '🔨', KICK: '👢', UNBAN: '✅',
  kick: '👢', ban: '🔨', timeout: '⏱️', unban: '✅',
  MESSAGE_DELETE: '🗑️', message_delete: '🗑️',
  CHANNEL_CREATE: '📁', channel_create: '📁',
  CHANNEL_DELETE: '❌', channel_delete: '❌',
  ROLE_UPDATE: '🎭', role_assign: '🎭',
  MEMBER_ROLE_ADD: '➕', MEMBER_ROLE_REMOVE: '➖',
  server_update: '⚙️', SERVER_UPDATE: '⚙️',
};

const ACTION_LABELS: Record<string, string> = {
  TIMEOUT: 'susturdu',     timeout: 'susturdu',
  BAN: 'yasakladı',        ban: 'yasakladı',
  KICK: 'attı',            kick: 'attı',
  UNBAN: 'yasağını kaldırdı', unban: 'yasağını kaldırdı',
  MESSAGE_DELETE: 'mesajını sildi', message_delete: 'mesajını sildi',
  CHANNEL_CREATE: 'kanal oluşturdu', channel_create: 'kanal oluşturdu',
  CHANNEL_DELETE: 'kanalı sildi',    channel_delete: 'kanalı sildi',
  ROLE_UPDATE: 'rolünü güncelledi',  role_assign: 'rol atadı',
  MEMBER_ROLE_ADD: 'rolünü ekledi',  MEMBER_ROLE_REMOVE: 'rolünü kaldırdı',
  server_update: 'sunucuyu güncelledi',
};

// ── Module state ──────────────────────────────────────────────────────────────

let _auditServerId: string | null = null;
let _auditPage    = 0;
let _auditTotal   = 0;
let _auditDebounce: ReturnType<typeof setTimeout> | null = null;

// ── Helpers ───────────────────────────────────────────────────────────────────

function _actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

function _relTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000)    return `${Math.floor(diff / 1000)}s önce`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}dk önce`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}sa önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
}

function _aesc(s: unknown): string {
  return String(s ?? '').replace(/[<>&"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' } as Record<string, string>)[c]!
  );
}

function _getInput<T extends HTMLElement = HTMLInputElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

// ── Main load ─────────────────────────────────────────────────────────────────

async function loadAuditLog(offset = 0): Promise<void> {
  const serverId = _auditServerId;
  if (!serverId) return;
  _auditPage = Math.floor(offset / AUDIT_PAGE_SIZE);

  const list = document.getElementById('audit-list');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-3)">Yükleniyor…</div>';

  const action = (_getInput('audit-filter-action') as HTMLSelectElement)?.value ?? '';
  const actor  = _getInput('audit-filter-actor')?.value?.trim() ?? '';
  const after  = _getInput('audit-filter-after')?.value ?? '';
  const before = _getInput('audit-filter-before')?.value ?? '';

  const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE), offset: String(offset) });
  if (action) params.set('action', action);
  if (after)  params.set('after',  after);
  if (before) params.set('before', before);

  try {
    const r   = await apiFetch(`${getAPI()}/api/servers/${serverId}/audit-log?${params}`);
    const data: AuditLogResponse = await r.json();

    if (!r.ok) {
      list.innerHTML = `<div style="color:var(--red);padding:16px">${_aesc(data.error ?? 'Erişim reddedildi')}</div>`;
      return;
    }

    let logs = data.logs ?? [];

    // Client-side actor filter (server only filters by actorId; this is by name)
    if (actor) {
      const al = actor.toLowerCase();
      logs = logs.filter(l =>
        (l.actorName ?? '').toLowerCase().includes(al) ||
        (l.targetName ?? '').toLowerCase().includes(al)
      );
    }

    _auditTotal = data.total ?? logs.length;
    const label = document.getElementById('audit-total-label');
    if (label) label.textContent = `Toplam ${_auditTotal} kayıt`;

    _renderAuditLogs(list, logs);
    _renderAuditPagination(offset, data.hasMore ?? false);

  } catch {
    list.innerHTML = '<div style="color:var(--red);padding:16px">Bağlantı hatası</div>';
  }
}

function loadAuditLogDebounced(): void {
  if (_auditDebounce) clearTimeout(_auditDebounce);
  _auditDebounce = setTimeout(() => loadAuditLog(0), 350);
}

// ── Renderers ─────────────────────────────────────────────────────────────────

function _renderAuditLogs(container: HTMLElement, logs: AuditLogEntry[]): void {
  if (!logs.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3)">Kayıt bulunamadı</div>';
    return;
  }

  container.innerHTML = logs.map(log => {
    const icon = ACTION_ICONS[log.action] ?? '📌';
    const rel  = _relTime(log.createdAt);
    const d    = new Date(log.createdAt).toLocaleString('tr-TR');
    return `
      <div class="audit-entry">
        <div class="audit-icon">${icon}</div>
        <div class="audit-content">
          <div class="audit-main">
            <strong class="audit-actor">${_aesc(log.actorName)}</strong>
            <span class="audit-action-label">${_actionLabel(log.action)}</span>
            <strong class="audit-target">${_aesc(log.targetName)}</strong>
            ${log.detail ? `<span class="audit-detail">(${_aesc(log.detail)})</span>` : ''}
          </div>
          <div class="audit-time" title="${d}">${rel}</div>
        </div>
      </div>`;
  }).join('');
}

function _renderAuditPagination(offset: number, hasMore: boolean): void {
  const bar  = document.getElementById('audit-pagination');
  const prev = document.getElementById('audit-prev') as HTMLButtonElement | null;
  const next = document.getElementById('audit-next') as HTMLButtonElement | null;
  const info = document.getElementById('audit-page-info');
  if (!bar) return;

  const show = offset > 0 || hasMore;
  bar.style.display = show ? 'flex' : 'none';
  if (!show) return;

  if (prev) prev.disabled = offset === 0;
  if (next) next.disabled = !hasMore;
  if (info) info.textContent = `Sayfa ${_auditPage + 1}`;
}

function auditChangePage(delta: number): void {
  const newOffset = (_auditPage + delta) * AUDIT_PAGE_SIZE;
  if (newOffset < 0) return;
  loadAuditLog(newOffset);
  document.getElementById('audit-list')?.scrollTo(0, 0);
}

// ── Export ────────────────────────────────────────────────────────────────────

async function exportAuditLog(format: 'json' | 'csv' = 'json'): Promise<void> {
  const serverId = _auditServerId;
  if (!serverId) return;

  const action = (_getInput('audit-filter-action') as HTMLSelectElement)?.value ?? '';
  const after  = _getInput('audit-filter-after')?.value ?? '';
  const before = _getInput('audit-filter-before')?.value ?? '';

  const params = new URLSearchParams({ format });
  if (action) params.set('action', action);
  if (after)  params.set('after',  after);
  if (before) params.set('before', before);

  const url   = `${getAPI()}/api/servers/${serverId}/audit-log/export?${params}`;
  const token = localStorage.getItem('token') ?? sessionStorage.getItem('token') ?? '';

  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { BridgeRegistry.call('toast', 'Export başarısız', 'error'); return; }

    const blob     = await r.blob();
    const blobUrl  = URL.createObjectURL(blob);
    const ts       = new Date().toISOString().slice(0, 10);
    const filename = `audit-${serverId}-${ts}.${format}`;

    const a    = document.createElement('a');
    a.href     = blobUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(blobUrl);
    BridgeRegistry.call('toast', `✅ ${format.toUpperCase()} indirildi`, 'success');
  } catch {
    BridgeRegistry.call('toast', 'Export hatası', 'error');
  }
}

// ── Open modal ────────────────────────────────────────────────────────────────

async function openAuditLog(serverId: string): Promise<void> {
  _auditServerId = serverId;
  _auditPage     = 0;
  _auditTotal    = 0;

  // Reset filters
  const actionSel = _getInput<HTMLSelectElement>('audit-filter-action');
  const actorIn   = _getInput('audit-filter-actor');
  const afterIn   = _getInput('audit-filter-after');
  const beforeIn  = _getInput('audit-filter-before');
  if (actionSel) actionSel.value = '';
  if (actorIn)   actorIn.value   = '';
  if (afterIn)   afterIn.value   = '';
  if (beforeIn)  beforeIn.value  = '';

  const modal = document.getElementById('audit-modal');
  if (modal) modal.style.display = 'flex';

  await loadAuditLog(0);
}

// ── Server menu injection ─────────────────────────────────────────────────────

const _origOpenServerMenu: Function | undefined = BridgeRegistry.get('openServerMenu');
if (typeof _origOpenServerMenu === 'function') {
  BridgeRegistry.register('openServerMenu', function (serverId: string, ...rest: unknown[]) {
    const result = _origOpenServerMenu.apply(this, [serverId, ...rest]);
    setTimeout(() => {
      const menu =
        document.getElementById('server-ctx-menu') ??
        document.querySelector<HTMLElement>('.server-menu');
      if (!menu || (menu as HTMLElement & { dataset: DOMStringMap }).dataset.auditBtn) return;
      (menu as HTMLElement & { dataset: DOMStringMap }).dataset.auditBtn = '1';

      const btn = document.createElement('div');
      btn.className = 'server-menu-item';
      btn.innerHTML = '📋 Audit Log';
      btn.onclick = () => { menu.remove(); openAuditLog(serverId); };

      const modBtn = [...menu.querySelectorAll<HTMLElement>('.server-menu-item')]
        .find(el => el.textContent?.includes('Moderasyon') || el.textContent?.includes('AutoMod'));
      if (modBtn) modBtn.after(btn);
      else menu.appendChild(btn);
    }, 50);
    return result;
  });
}

export {
  auditChangePage,
  exportAuditLog,
  loadAuditLog,
  loadAuditLogDebounced,
  openAuditLog,
};
