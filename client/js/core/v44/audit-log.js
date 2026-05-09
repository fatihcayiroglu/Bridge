// client/js/core/v44/audit-log.js
Filtreler, sayfalama, CSV/JSON export
'use strict';

const AUDIT_PAGE_SIZE = 50;
let _auditServerId  = null;
let _auditPage      = 0;
let _auditTotal     = 0;
let _auditDebounce  = null;

const ACTION_ICONS = {
  TIMEOUT: '⏱️', BAN: '🔨', KICK: '👢', UNBAN: '✅', kick: '👢', ban: '🔨',
  timeout: '⏱️', unban: '✅', MESSAGE_DELETE: '🗑️', message_delete: '🗑️',
  CHANNEL_CREATE: '📁', channel_create: '📁', CHANNEL_DELETE: '❌', channel_delete: '❌',
  ROLE_UPDATE: '🎭', role_assign: '🎭', MEMBER_ROLE_ADD: '➕', MEMBER_ROLE_REMOVE: '➖',
  server_update: '⚙️', SERVER_UPDATE: '⚙️',
};

function _actionLabel(action) {
  const map = {
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
  return map[action] || action;
}

function _relTime(ts) {
  const diff = Date.now() - ts;
  if (diff < 60000)    return `${Math.floor(diff / 1000)}s önce`;
  if (diff < 3600000)  return `${Math.floor(diff / 60000)}dk önce`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}sa önce`;
  return new Date(ts).toLocaleDateString('tr-TR');
}

function _aesc(s) {
  return String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

// ── Ana yükleme fonksiyonu ─────────────────────────────────────
async function loadAuditLog(offset = 0) {
  const serverId = _auditServerId;
  if (!serverId) return;
  _auditPage = Math.floor(offset / AUDIT_PAGE_SIZE);

  const list = document.getElementById('audit-list');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-3)">Yükleniyor…</div>';

  const action = document.getElementById('audit-filter-action')?.value || '';
  const actor  = (document.getElementById('audit-filter-actor')?.value || '').trim();
  const after  = document.getElementById('audit-filter-after')?.value  || '';
  const before = document.getElementById('audit-filter-before')?.value || '';

  const params = new URLSearchParams({
    limit:  AUDIT_PAGE_SIZE,
    offset,
  });
  if (action) params.set('action', action);
  if (after)  params.set('after',  after);
  if (before) params.set('before', before);

  try {
    const r    = await apiFetch(`${API}/api/servers/${serverId}/audit-log?${params}`);
    const data = await r.json();
    if (!r.ok) {
      list.innerHTML = `<div style="color:var(--red);padding:16px">${_aesc(data.error || 'Erişim reddedildi')}</div>`;
      return;
    }

    // Client-side actor filter (server sadece actorId filtreliyor, bu ise ad ile)
    let logs = data.logs || [];
    if (actor) {
      const al = actor.toLowerCase();
      logs = logs.filter(l =>
        (l.actorName || '').toLowerCase().includes(al) ||
        (l.targetName || '').toLowerCase().includes(al)
      );
    }

    _auditTotal = data.total || logs.length;
    const label = document.getElementById('audit-total-label');
    if (label) label.textContent = `Toplam ${_auditTotal} kayıt`;

    _renderAuditLogs(list, logs);
    _renderAuditPagination(offset, data.hasMore);

  } catch {
    list.innerHTML = '<div style="color:var(--red);padding:16px">Bağlantı hatası</div>';
  }
}

function loadAuditLogDebounced() {
  clearTimeout(_auditDebounce);
  _auditDebounce = setTimeout(() => loadAuditLog(0), 350);
}

function _renderAuditLogs(container, logs) {
  if (!logs.length) {
    container.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-3)">Kayıt bulunamadı</div>';
    return;
  }
  container.innerHTML = logs.map(log => {
    const icon = ACTION_ICONS[log.action] || '📌';
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

function _renderAuditPagination(offset, hasMore) {
  const bar  = document.getElementById('audit-pagination');
  const prev = document.getElementById('audit-prev');
  const next = document.getElementById('audit-next');
  const info = document.getElementById('audit-page-info');
  if (!bar) return;

  const show = offset > 0 || hasMore;
  bar.style.display = show ? 'flex' : 'none';
  if (!show) return;

  if (prev) prev.disabled = offset === 0;
  if (next) next.disabled = !hasMore;
  if (info) info.textContent = `Sayfa ${_auditPage + 1}`;
}

function auditChangePage(delta) {
  const newOffset = (_auditPage + delta) * AUDIT_PAGE_SIZE;
  if (newOffset < 0) return;
  loadAuditLog(newOffset);
  document.getElementById('audit-list')?.scrollTo(0, 0);
}

// ── Export ────────────────────────────────────────────────────
async function exportAuditLog(format = 'json') {
  const serverId = _auditServerId;
  if (!serverId) return;

  const action = document.getElementById('audit-filter-action')?.value || '';
  const after  = document.getElementById('audit-filter-after')?.value  || '';
  const before = document.getElementById('audit-filter-before')?.value || '';

  const params = new URLSearchParams({ format });
  if (action) params.set('action', action);
  if (after)  params.set('after',  after);
  if (before) params.set('before', before);

  // Tarayıcı indirme — anchor ile
  const url  = `${API}/api/servers/${serverId}/audit-log/export?${params}`;
  const token = localStorage.getItem('token') || sessionStorage.getItem('token') || '';

  try {
    const r   = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) { window.bridgeApp?.toast('Export başarısız', 'error'); return; }

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
    window.bridgeApp?.toast(`✅ ${format.toUpperCase()} indirildi`, 'success');
  } catch {
    window.bridgeApp?.toast('Export hatası', 'error');
  }
}

// ── openAuditLog — modal aç ───────────────────────────────────
async function openAuditLog(serverId) {
  _auditServerId = serverId;
  _auditPage     = 0;
  _auditTotal    = 0;

  // Filtreleri sıfırla
  const actionSel = document.getElementById('audit-filter-action');
  const actorIn   = document.getElementById('audit-filter-actor');
  const afterIn   = document.getElementById('audit-filter-after');
  const beforeIn  = document.getElementById('audit-filter-before');
  if (actionSel) actionSel.value = '';
  if (actorIn)   actorIn.value   = '';
  if (afterIn)   afterIn.value   = '';
  if (beforeIn)  beforeIn.value  = '';

  // Modal göster
  const modal = document.getElementById('audit-modal');
  if (modal) modal.style.display = 'flex';

  await loadAuditLog(0);
}

// Sunucu menüsüne Audit Log butonu ekle
const _origOpenServerMenu = window.openServerMenu;
if (typeof _origOpenServerMenu === 'function') {
  window.openServerMenu = function(serverId, ...rest) {
    const result = _origOpenServerMenu.apply(this, [serverId, ...rest]);
    setTimeout(() => {
      const menu = document.getElementById('server-ctx-menu') || document.querySelector('.server-menu');
      if (!menu || menu.dataset.auditBtn) return;
      menu.dataset.auditBtn = '1';
      const btn = document.createElement('div');
      btn.className = 'server-menu-item';
      btn.innerHTML = '📋 Audit Log';
      btn.onclick = () => { menu.remove(); openAuditLog(serverId); };
      const modBtn = [...menu.querySelectorAll('.server-menu-item')].find(el => el.textContent.includes('Moderasyon') || el.textContent.includes('AutoMod'));
      if (modBtn) modBtn.after(btn);
      else menu.appendChild(btn);
    }, 50);
    return result;
  };
}

