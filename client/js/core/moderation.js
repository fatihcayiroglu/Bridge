// client/js/core/moderation.js
// misc.js'den çıkarıldı: Moderasyon, audit log, sunucu istatistikleri
// timeout, ban, kick UI fonksiyonları

'use strict';

// ── TIMEOUT ───────────────────────────────────────────────────
function openTimeoutModal(userId, displayName) {
  timeoutTargetId = userId;
  const nameEl = document.getElementById('timeout-target-name');
  if (nameEl) nameEl.textContent = displayName + ' kullanıcısını sustur';
  document.getElementById('timeout-modal').style.display = 'flex';
}

async function applyTimeout() {
  if (!timeoutTargetId || !currentServer) return;
  const duration = parseInt(document.getElementById('timeout-duration').value);
  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/timeout/${timeoutTargetId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration }),
    });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Hata', 'error');
    toast('Kullanıcı susturuldu', 'success');
    closeModal('timeout-modal');
  } catch { toast('Hata', 'error'); }
}

// ── AUDIT LOG ─────────────────────────────────────────────────
async function openAuditLog() {
  if (!currentServer) return;
  document.getElementById('audit-modal').style.display = 'flex';
  const list = document.getElementById('audit-list');
  list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Yükleniyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/audit-log`);
    const logs = await r.json();
    if (!r.ok) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Yetkiniz yok veya hata oluştu.</div>';
      return;
    }
    if (!logs.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Kayıt bulunamadı.</div>';
      return;
    }
    const actionLabels = {
      TIMEOUT:    '⏱️ Susturma',
      BAN:        '🔨 Ban',
      KICK:       '👢 Kick',
      DELETE_MSG: '🗑️ Mesaj Silme',
    };
    list.innerHTML = logs.map(l => `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--bg-3);border-radius:8px;">
        <span style="font-size:20px;flex-shrink:0">${actionLabels[l.action]?.split(' ')[0] || '📋'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">
            ${actionLabels[l.action] || l.action}:
            <span style="color:var(--text-muted)">${escHtml(l.targetName || '')}</span>
          </div>
          <div style="font-size:12px;color:var(--text-muted)">
            ${escHtml(l.actorName)} tarafından · ${new Date(l.createdAt).toLocaleString('tr-TR')}
            ${l.detail ? ' · ' + escHtml(l.detail) : ''}
          </div>
        </div>
      </div>`).join('');
  } catch {
    list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Yüklenemedi.</div>';
  }
}

// ── SERVER STATS ──────────────────────────────────────────────
async function openServerStats() {
  if (!currentServer) return;
  document.getElementById('stats-modal').style.display = 'flex';
  const content = document.getElementById('stats-content');
  content.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Yükleniyor...</div>';
  try {
    const r    = await apiFetch(`${API}/api/servers/${currentServer._id}/stats`);
    const data = await r.json();
    if (!r.ok) { content.innerHTML = '<div style="color:var(--text-muted)">Yetkiniz yok.</div>'; return; }

    const bars = (data.topUsers || []).map(u => {
      const max = data.topUsers[0]?.cnt || 1;
      const pct = Math.round((u.cnt / max) * 100);
      return `<div style="display:flex;align-items:center;gap:10px;margin-bottom:6px">
        <div style="width:100px;font-size:12px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${escHtml(u.displayName)}</div>
        <div style="flex:1;height:8px;background:var(--bg-3);border-radius:4px;overflow:hidden">
          <div style="width:${pct}%;height:100%;background:var(--brand);border-radius:4px"></div>
        </div>
        <div style="width:30px;font-size:11px;color:var(--text-muted);text-align:right">${u.cnt}</div>
      </div>`;
    }).join('');

    content.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px">
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--brand)">${(data.totalMessages || 0).toLocaleString('tr-TR')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Toplam Mesaj</div>
        </div>
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--green)">${(data.totalMembers || 0).toLocaleString('tr-TR')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Üye</div>
        </div>
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--yellow)">${(data.totalChannels || 0).toLocaleString('tr-TR')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Kanal</div>
        </div>
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--purple)">${(data.activeToday || 0).toLocaleString('tr-TR')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Bugün Aktif</div>
        </div>
      </div>
      ${data.topUsers?.length ? `
        <div style="margin-bottom:8px;font-size:12px;font-weight:700;color:var(--text-muted);text-transform:uppercase;letter-spacing:.06em">
          En Aktif Üyeler (30 gün)
        </div>
        ${bars}` : ''}`;
  } catch {
    content.innerHTML = '<div style="color:var(--text-muted)">Yüklenemedi.</div>';
  }
}

// ── BAN / KICK (quick actions) ────────────────────────────────
async function kickMember(userId, displayName) {
  if (!currentServer) return;
  if (!confirm(`${displayName} kullanıcısını sunucudan atmak istediğinizden emin misiniz?`)) return;
  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/kick/${userId}`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Hata', 'error');
    toast(`${displayName} sunucudan atıldı`, 'success');
  } catch { toast('Hata', 'error'); }
}

async function banMember(userId, displayName) {
  if (!currentServer) return;
  if (!confirm(`${displayName} kullanıcısını yasaklamak istediğinizden emin misiniz?`)) return;
  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason: 'Moderator action' }),
    });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Hata', 'error');
    toast(`${displayName} yasaklandı`, 'success');
  } catch { toast('Hata', 'error'); }
}

// ── NOTIFICATION PREFERENCES ─────────────────────────────────
function showNotifCtx(e, channelId) {
  e?.stopPropagation();
  notifCtxChannel = channelId;
  const ctx = document.getElementById('notif-ctx');
  if (!ctx) return;
  const rect = e?.currentTarget?.getBoundingClientRect?.() || { bottom: 100, left: 100 };
  ctx.style.top  = rect.bottom + 4 + 'px';
  ctx.style.left = rect.left + 'px';
  ctx.style.display = 'block';
  setTimeout(() => document.addEventListener('click', () => hideNotifCtx(), { once: true }), 50);
}

function hideNotifCtx() {
  const ctx = document.getElementById('notif-ctx');
  if (ctx) ctx.style.display = 'none';
}

async function setNotifPref(level) {
  if (!notifCtxChannel) return;
  notifPrefs[notifCtxChannel] = level;
  socket?.emit('notif:pref', { channelId: notifCtxChannel, level });
  const labels = { all: '🔔 Tüm bildirimler', mentions: '🔕 Sadece mention', mute: '🔇 Sessiz' };
  toast(labels[level], 'success');
  hideNotifCtx();
}

// ── MEMBER PROFILE POPUP ──────────────────────────────────────
async function getMemberPermsClient(serverId) {
  try {
    const servers = await apiFetch(`${API}/api/servers`).then(r => r.json());
    const server  = servers.find(s => s._id === serverId);
    return { canManage: server?.ownerId === me?._id };
  } catch { return { canManage: false }; }
}

export {
  applyTimeout,
  banMember,
  getMemberPermsClient,
  hideNotifCtx,
  kickMember,
  openAuditLog,
  openServerStats,
  openTimeoutModal,
  setNotifPref,
  showNotifCtx,
};

