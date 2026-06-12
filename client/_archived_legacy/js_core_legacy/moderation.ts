// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ModerationPanel.svelte
//              client/js/core/moderation-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/moderation.ts
// Sprint 43: JS→TS geçişi
// Moderasyon, audit log, sunucu istatistikleri

import { apiFetch } from './api-fetch.js';
import { getAPI } from './globals.js';
import { escHtml, toast, closeModal } from './utils.js';

// Modül-scoped state (artık global değil)
let timeoutTargetId: string | null = null;
let currentServer: { _id: string; ownerId?: string } | null = null;
let notifCtxChannel: string | null = null;
let notifPrefs: Record<string, string> = {};
let me: { _id?: string } | null = null;

/** Dışarıdan state enjeksiyonu — globals.ts'den çağrılır */
export function setModerationContext(
  server: typeof currentServer,
  meUser: typeof me
): void {
  currentServer = server;
  me = meUser;
}

interface AuditLog {
  action: 'TIMEOUT' | 'BAN' | 'KICK' | 'DELETE_MSG' | string;
  targetName?: string;
  actorName: string;
  createdAt: string | number;
  detail?: string;
}

interface ServerStats {
  totalMessages?: number;
  totalMembers?: number;
  totalChannels?: number;
  activeToday?: number;
  topUsers?: Array<{ displayName: string; cnt: number }>;
}

// ── TIMEOUT ────────────────────────────────────────────────────────────────────
export function openTimeoutModal(userId: string, displayName: string): void {
  timeoutTargetId = userId;
  const nameEl = document.getElementById('timeout-target-name');
  if (nameEl) nameEl.textContent = displayName + ' kullanıcısını sustur';
  const modal = document.getElementById('timeout-modal');
  if (modal) modal.style.display = 'flex';
}

export async function applyTimeout(): Promise<void> {
  if (!timeoutTargetId || !currentServer) return;
  const durationEl = document.getElementById('timeout-duration') as HTMLInputElement | null;
  const duration = parseInt(durationEl?.value ?? '0');
  try {
    const r = await apiFetch(`${getAPI()}/api/servers/${currentServer._id}/timeout/${timeoutTargetId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ duration }),
    });
    const data = await r.json() as { error?: string };
    if (!r.ok) return toast(data.error ?? 'Hata', 'error');
    toast('Kullanıcı susturuldu', 'success');
    closeModal('timeout-modal');
  } catch { toast('Hata', 'error'); }
}

// ── AUDIT LOG ──────────────────────────────────────────────────────────────────
export async function openAuditLog(): Promise<void> {
  if (!currentServer) return;
  const modal = document.getElementById('audit-modal');
  if (modal) modal.style.display = 'flex';
  const list = document.getElementById('audit-list');
  if (!list) return;
  list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Yükleniyor...</div>';
  try {
    const r = await apiFetch(`${getAPI()}/api/servers/${currentServer._id}/audit-log`);
    const logs: AuditLog[] = await r.json();
    if (!r.ok) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Yetkiniz yok veya hata oluştu.</div>';
      return;
    }
    if (!logs.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Kayıt bulunamadı.</div>';
      return;
    }
    const actionLabels: Record<string, string> = {
      TIMEOUT:    '⏱️ Susturma',
      BAN:        '🔨 Ban',
      KICK:       '👢 Kick',
      DELETE_MSG: '🗑️ Mesaj Silme',
    };
    list.innerHTML = logs.map(l => `
      <div style="display:flex;gap:10px;align-items:flex-start;padding:10px 12px;background:var(--bg-3);border-radius:8px;">
        <span style="font-size:20px;flex-shrink:0">${actionLabels[l.action]?.split(' ')[0] ?? '📋'}</span>
        <div style="flex:1;min-width:0">
          <div style="font-size:13px;font-weight:600">
            ${actionLabels[l.action] ?? l.action}:
            <span style="color:var(--text-muted)">${escHtml(l.targetName ?? '')}</span>
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

// ── SERVER STATS ───────────────────────────────────────────────────────────────
export async function openServerStats(): Promise<void> {
  if (!currentServer) return;
  const modal = document.getElementById('stats-modal');
  if (modal) modal.style.display = 'flex';
  const content = document.getElementById('stats-content');
  if (!content) return;
  content.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px">Yükleniyor...</div>';
  try {
    const r    = await apiFetch(`${getAPI()}/api/servers/${currentServer._id}/stats`);
    const data: ServerStats = await r.json();
    if (!r.ok) { content.innerHTML = '<div style="color:var(--text-muted)">Yetkiniz yok.</div>'; return; }

    const bars = (data.topUsers ?? []).map(u => {
      const max = data.topUsers![0]?.cnt ?? 1;
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
          <div style="font-size:28px;font-weight:800;color:var(--brand)">${(data.totalMessages ?? 0).toLocaleString('tr-TR')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Toplam Mesaj</div>
        </div>
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--green)">${(data.totalMembers ?? 0).toLocaleString('tr-TR')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Üye</div>
        </div>
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--yellow)">${(data.totalChannels ?? 0).toLocaleString('tr-TR')}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:4px">Kanal</div>
        </div>
        <div style="background:var(--bg-3);border-radius:10px;padding:16px;text-align:center">
          <div style="font-size:28px;font-weight:800;color:var(--purple)">${(data.activeToday ?? 0).toLocaleString('tr-TR')}</div>
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

// ── BAN / KICK ─────────────────────────────────────────────────────────────────
export async function kickMember(userId: string, displayName: string): Promise<void> {
  if (!currentServer) return;
  if (!confirm(`${displayName} kullanıcısını sunucudan atmak istediğinizden emin misiniz?`)) return;
  try {
    const r = await apiFetch(`${getAPI()}/api/servers/${currentServer._id}/kick/${userId}`, { method: 'POST' });
    const data = await r.json() as { error?: string };
    if (!r.ok) return toast(data.error ?? 'Hata', 'error');
    toast(`${displayName} sunucudan atıldı`, 'success');
  } catch { toast('Hata', 'error'); }
}

export async function banMember(userId: string, displayName: string): Promise<void> {
  if (!currentServer) return;
  if (!confirm(`${displayName} kullanıcısını yasaklamak istediğinizden emin misiniz?`)) return;
  try {
    const r = await apiFetch(`${getAPI()}/api/servers/${currentServer._id}/bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, reason: 'Moderator action' }),
    });
    const data = await r.json() as { error?: string };
    if (!r.ok) return toast(data.error ?? 'Hata', 'error');
    toast(`${displayName} yasaklandı`, 'success');
  } catch { toast('Hata', 'error'); }
}

// ── NOTIFICATION PREFERENCES ───────────────────────────────────────────────────
export function showNotifCtx(e: MouseEvent | null, channelId: string): void {
  e?.stopPropagation();
  notifCtxChannel = channelId;
  const ctx = document.getElementById('notif-ctx');
  if (!ctx) return;
  const rect = (e?.currentTarget as HTMLElement)?.getBoundingClientRect?.() ?? { bottom: 100, left: 100 };
  ctx.style.top  = rect.bottom + 4 + 'px';
  ctx.style.left = rect.left + 'px';
  ctx.style.display = 'block';
  setTimeout(() => document.addEventListener('click', hideNotifCtx, { once: true }), 50);
}

export function hideNotifCtx(): void {
  const ctx = document.getElementById('notif-ctx');
  if (ctx) ctx.style.display = 'none';
}

export async function setNotifPref(level: 'all' | 'mentions' | 'mute'): Promise<void> {
  if (!notifCtxChannel) return;
  notifPrefs[notifCtxChannel] = level;
  // socket — runtime injection yoluyla erişilir
  (window as Window & { socket?: { emit: (...a: unknown[]) => void } }).socket?.emit('notif:pref', { channelId: notifCtxChannel, level });
  const labels: Record<string, string> = { all: '🔔 Tüm bildirimler', mentions: '🔕 Sadece mention', mute: '🔇 Sessiz' };
  toast(labels[level] ?? level, 'success');
  hideNotifCtx();
}

// ── MEMBER PROFILE POPUP ───────────────────────────────────────────────────────
export async function getMemberPermsClient(serverId: string): Promise<{ canManage: boolean }> {
  try {
    const servers = await apiFetch(`${getAPI()}/api/servers`).then(r => r.json()) as Array<{ _id: string; ownerId?: string }>;
    const server  = servers.find(s => s._id === serverId);
    return { canManage: server?.ownerId === (me as { _id?: string } | null)?._id };
  } catch { return { canManage: false }; }
}
