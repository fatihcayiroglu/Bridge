// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ModalAuditPanel.svelte
//              client/js/core/modal-audit-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/channel-perms/modal-audit.ts
// Kanal izin audit log bölümü — modal-core.ts ile birlikte yüklenir
// Sprint 33: JS → TS migration
// Sprint 40: IIFE → named ESM exports, window.* temizliği
//
// Önceki: window.chpermsLoadAudit / window.chpermsApplyAuditFilter / window.chpermsResetAuditFilter
// Şimdi:  export { chpermsLoadAudit, chpermsApplyAuditFilter, chpermsResetAuditFilter }
//         + BridgeRegistry kaydı (HTML onclick uyumluluğu için)

import { PERM_GROUPS } from '../channel-perms-data.js';
import { apiFetch } from '../api-fetch.js';
import { getAPI, getCurrentServer } from '../globals.js';
import { BridgeRegistry } from '../bridge-registry.js';
import { escHtml } from '../utils.js';

// ── Tip tanımları ────────────────────────────────────────────────────────────

interface AuditOverride { allow: number; deny: number }

interface AuditLog {
  action:      string;
  createdAt:   string | number;
  actorName?:  string;
  targetId?:   string;
  targetName?: string;
  old?:        AuditOverride;
  new?:        AuditOverride;
}

// ── Bit → etiket haritası ────────────────────────────────────────────────────

const BIT_LABELS: Record<number, string> = {};
for (const g of PERM_GROUPS) {
  for (const p of g.perms) BIT_LABELS[p.bit] = p.label;
}

const ACTION_LABELS: Record<string, { icon: string; label: string }> = {
  PERM_UPDATE:    { icon: '✏️', label: 'İzin Güncellendi' },
  PERM_DELETE:    { icon: '🗑️', label: 'Override Silindi' },
  PERM_BULK_SYNC: { icon: '🔁', label: 'Toplu Senkronize' },
};

// ── Yardımcılar ──────────────────────────────────────────────────────────────

/** Eylem kodunu görüntülenebilir etikete çevirir; bilinmeyenler olduğu gibi döner */
function _actionToLabel(action: string): string {
  return (ACTION_LABELS as Record<string, { icon: string; label: string }>)[action]?.label ?? action;
}

function _diffBits(oldV: AuditOverride | undefined, newV: AuditOverride | undefined): string {
  if (!oldV || !newV) return '';
  const changes: string[] = [];
  for (const [bitStr, lbl] of Object.entries(BIT_LABELS)) {
    const b        = parseInt(bitStr, 10);
    const wasAllow = (oldV.allow & b) !== 0, nowAllow = (newV.allow & b) !== 0;
    const wasDeny  = (oldV.deny  & b) !== 0, nowDeny  = (newV.deny  & b) !== 0;
    if (wasAllow !== nowAllow || wasDeny !== nowDeny) {
      const before = wasAllow ? '✅' : wasDeny ? '❌' : '—';
      const after  = nowAllow ? '✅' : nowDeny ? '❌' : '—';
      changes.push(`<span style="font-size:11px">${lbl}: ${before}→${after}</span>`);
    }
  }
  return changes.length
    ? changes.join(' &nbsp; ')
    : '<span style="font-size:11px;color:var(--text-3)">değişiklik detayı yok</span>';
}

// ── Modül durumu ─────────────────────────────────────────────────────────────

let _auditChannelId: string | null = null;

// ── Dışa açık fonksiyonlar ───────────────────────────────────────────────────

export async function chpermsLoadAudit(channelId: string): Promise<void> {
  _auditChannelId = channelId;
  const body = document.getElementById('chperms-audit-body');
  if (!body) return;
  body.innerHTML = '<p style="color:var(--text-3);font-size:13px">Yükleniyor…</p>';

  const params = new URLSearchParams();
  const action   = (document.getElementById('chperms-audit-action-filter') as HTMLSelectElement | null)?.value;
  const targetId = (document.getElementById('chperms-audit-role-filter')   as HTMLSelectElement | null)?.value;
  const since    = (document.getElementById('chperms-audit-since')          as HTMLInputElement  | null)?.value;
  const until    = (document.getElementById('chperms-audit-until')          as HTMLInputElement  | null)?.value;
  if (action)   params.set('action',   action);
  if (targetId) params.set('targetId', targetId);
  if (since)    params.set('since',    String(new Date(since).getTime()));
  if (until)    params.set('until',    String(new Date(until + 'T23:59:59').getTime()));

  const server = getCurrentServer() as { _id: string } | null;
  if (!server) {
    body.innerHTML = '<p style="color:var(--danger,#ed4245);font-size:13px">Sunucu bilgisi alınamadı.</p>';
    return;
  }

  try {
    const qs  = params.toString() ? '?' + params.toString() : '';
    const res = await apiFetch(
      `${getAPI()}/api/servers/${server._id}/channels/${channelId}/permissions/audit-log${qs}`
    );
    const data = await res.json() as { logs?: AuditLog[] };
    const logs = data.logs ?? [];

    // Rol dropdown'ını doldur (ilk yüklemede bir kez)
    const roleFilter = document.getElementById('chperms-audit-role-filter') as HTMLSelectElement | null;
    if (roleFilter && roleFilter.options.length <= 2 && logs.length > 0) {
      const seenTargets = new Map<string, string>();
      for (const l of logs) {
        if (l.targetId && l.targetId !== '__everyone__' && !seenTargets.has(l.targetId)) {
          seenTargets.set(l.targetId, l.targetName ?? l.targetId);
        }
      }
      for (const [id, name] of seenTargets) {
        const opt = document.createElement('option');
        opt.value = id;
        opt.textContent = name;
        roleFilter.appendChild(opt);
      }
    }

    if (logs.length === 0) {
      body.innerHTML = `<p style="color:var(--text-3);font-size:13px;padding:20px 0">
        ${params.toString() ? '🔍 Bu filtreyle eşleşen kayıt yok.' : 'Henüz kayıtlı değişiklik yok.'}
      </p>`;
      return;
    }

    body.innerHTML = `
      <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;padding:6px 0">
        ${logs.length} kayıt gösteriliyor
        ${params.toString() ? ' <span style="color:var(--brand)">(filtrelenmiş)</span>' : ''}
      </div>
      <table style="width:100%;border-collapse:collapse;font-size:12px">
        <thead>
          <tr style="border-bottom:2px solid var(--bg-4)">
            <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:130px">Tarih</th>
            <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:110px">Yapan</th>
            <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:90px">İşlem</th>
            <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:110px">Hedef</th>
            <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px">Değişiklikler</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map((l, i) => {
            const al    = ACTION_LABELS[l.action] ?? { icon: '📝', label: l.action };
            const ts    = new Date(l.createdAt).toLocaleString('tr-TR', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit',
            });
            const rowBg = i % 2 === 0 ? 'background:var(--bg-2)' : '';
            return `<tr style="${rowBg}">
              <td style="padding:7px 8px;color:var(--text-3)">${ts}</td>
              <td style="padding:7px 8px;font-weight:600">${escHtml(l.actorName ?? '?')}</td>
              <td style="padding:7px 8px">${al.icon} ${escHtml(al.label)}</td>
              <td style="padding:7px 8px;color:var(--brand)">${escHtml(l.targetName ?? l.targetId ?? '—')}</td>
              <td style="padding:7px 8px">${_diffBits(l.old, l.new)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch {
    body.innerHTML = '<p style="color:var(--danger,#ed4245);font-size:13px">Geçmiş yüklenemedi.</p>';
  }
}

export function chpermsApplyAuditFilter(): void {
  if (_auditChannelId) void chpermsLoadAudit(_auditChannelId);
}

export function chpermsResetAuditFilter(): void {
  for (const id of ['chperms-audit-action-filter', 'chperms-audit-role-filter',
                    'chperms-audit-since', 'chperms-audit-until']) {
    const el = document.getElementById(id) as HTMLInputElement | HTMLSelectElement | null;
    if (el) el.value = '';
  }
  if (_auditChannelId) void chpermsLoadAudit(_auditChannelId);
}

// ── BridgeRegistry — HTML data-bridge-action uyumluluğu ─────────────────────
BridgeRegistry.register('chpermsLoadAudit',        (channelId: unknown) => chpermsLoadAudit(channelId as string));
BridgeRegistry.register('chpermsApplyAuditFilter', () => chpermsApplyAuditFilter());
BridgeRegistry.register('chpermsResetAuditFilter', () => chpermsResetAuditFilter());

export const channelPermsAuditReady = true;
