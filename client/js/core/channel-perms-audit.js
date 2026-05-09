// client/js/core/channel-perms-audit.js
// ══════════════════════════════════════════════════
// Değişiklik Geçmişi sekmesi
// Bağımlılıklar: channel-perms-data.js (PERM_GROUPS, BIT_LABELS)
// ══════════════════════════════════════════════════
'use strict';

const ACTION_LABELS = {
  PERM_UPDATE:    { icon: '✏️', label: 'İzin Güncellendi' },
  PERM_DELETE:    { icon: '🗑️', label: 'Override Silindi' },
  PERM_BULK_SYNC: { icon: '🔁', label: 'Toplu Senkronize' },
};

// Aktif filtre için saklanan kanalId
let _auditChannelId = null;

/**
 * İki izin state'i arasındaki farkları HTML olarak döner.
 */
function diffPermBits(oldV, newV) {
  if (!oldV || !newV) return '';
  const changes = [];
  for (const [bit, lbl] of Object.entries(BIT_LABELS)) {
    const b = parseInt(bit);
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

/**
 * Audit log sekmesini sunucudan yükler ve render eder.
 */
window.chpermsLoadAudit = async function (channelId) {
  _auditChannelId = channelId;
  const body = document.getElementById('chperms-audit-body');
  if (!body) return;
  body.innerHTML = '<p style="color:var(--text-3);font-size:13px">Yükleniyor…</p>';

  const params = new URLSearchParams();
  const action   = document.getElementById('chperms-audit-action-filter')?.value;
  const targetId = document.getElementById('chperms-audit-role-filter')?.value;
  const since    = document.getElementById('chperms-audit-since')?.value;
  const until    = document.getElementById('chperms-audit-until')?.value;
  if (action)   params.set('action',   action);
  if (targetId) params.set('targetId', targetId);
  if (since)    params.set('since',    new Date(since).getTime());
  if (until)    params.set('until',    new Date(until + 'T23:59:59').getTime());

  try {
    const qs   = params.toString() ? '?' + params.toString() : '';
    const data = await apiFetch(
      `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/audit-log${qs}`
    );
    const logs = data.logs || [];

    // Rol filtresini ilk yüklemede doldur
    const roleFilter = document.getElementById('chperms-audit-role-filter');
    if (roleFilter && roleFilter.options.length <= 2 && logs.length > 0) {
      const seenTargets = new Map();
      for (const l of logs) {
        if (l.targetId && l.targetId !== '__everyone__' && !seenTargets.has(l.targetId)) {
          seenTargets.set(l.targetId, l.targetName || l.targetId);
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
            const al    = ACTION_LABELS[l.action] || { icon: '📝', label: l.action };
            const ts    = new Date(l.createdAt).toLocaleString('tr-TR', {
              day: '2-digit', month: '2-digit', year: 'numeric',
              hour: '2-digit', minute: '2-digit'
            });
            const rowBg = i % 2 === 0 ? 'background:var(--bg-2)' : '';
            return `<tr style="${rowBg}">
              <td style="padding:7px 8px;color:var(--text-3)">${ts}</td>
              <td style="padding:7px 8px;font-weight:600">${escHtml(l.actorName || '?')}</td>
              <td style="padding:7px 8px">${al.icon} ${escHtml(al.label)}</td>
              <td style="padding:7px 8px;color:var(--brand)">${escHtml(l.targetName || l.targetId || '—')}</td>
              <td style="padding:7px 8px">${diffPermBits(l.old, l.new)}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`;
  } catch {
    body.innerHTML = '<p style="color:var(--danger,#ed4245);font-size:13px">Geçmiş yüklenemedi.</p>';
  }
};

window.chpermsApplyAuditFilter = function () {
  if (_auditChannelId) chpermsLoadAudit(_auditChannelId);
};

window.chpermsResetAuditFilter = function () {
  ['chperms-audit-action-filter', 'chperms-audit-role-filter',
   'chperms-audit-since', 'chperms-audit-until'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  if (_auditChannelId) chpermsLoadAudit(_auditChannelId);
};

export {
  diffPermBits,
};

