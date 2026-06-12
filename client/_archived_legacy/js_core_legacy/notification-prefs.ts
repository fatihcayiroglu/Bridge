// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/NotificationPrefsPanel.svelte
//              client/js/core/notification-prefs-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/notification-prefs.ts
// Sprint 91: Granüler bildirim tercihleri — Discord benzeri kanal & sunucu bazlı kontrol
//
// Özellikler:
//   - Kanal bazlı: Tümü / Sadece @mention / Sessiz (mevcut foundation üzerine)
//   - Sunucu bazlı override: Tümü / Sadece @mention / Sessiz / Varsayılan
//   - Zamanlı susturma: 15dk / 1s / 3s / 8s / 24s / Sonsuza kadar
//   - Mute badge: kanal listesinde 🔕 ikonu
//   - Unread suppression: sessiz kanallarda unread sayacı gösterilmez

import { apiFetch }                         from './api-fetch.js';
import { getAPI, getCurrentServer }          from './globals.js';
import { escHtml, toast }                    from './utils.js';
import { BridgeRegistry }                    from './bridge-registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export type NotifLevel = 'all' | 'mentions' | 'mute' | 'default';

interface ChannelPref {
  channelId:   string;
  level:       NotifLevel;
  muteUntil?:  number | null;  // null = forever
  updatedAt:   number;
}

// ── Module state ──────────────────────────────────────────────────────────────

const _prefs: Map<string, ChannelPref> = new Map();
let   _serverLevel: NotifLevel         = 'default';

// ── Mute duration options ─────────────────────────────────────────────────────

const MUTE_DURATIONS = [
  { label: '15 Dakika',       ms:  15 * 60 * 1000 },
  { label: '1 Saat',          ms:   1 * 60 * 60 * 1000 },
  { label: '3 Saat',          ms:   3 * 60 * 60 * 1000 },
  { label: '8 Saat',          ms:   8 * 60 * 60 * 1000 },
  { label: '24 Saat',         ms:  24 * 60 * 60 * 1000 },
  { label: 'Sonsuza Kadar',   ms:  0 },
];

// ── Load prefs for current server ─────────────────────────────────────────────

export async function loadServerNotifPrefs(): Promise<void> {
  const server = getCurrentServer() as { _id?: string } | null;
  if (!server?._id) return;
  const API = getAPI();

  try {
    const r = await apiFetch(`${API}/api/notification-prefs?serverId=${server._id}`);
    if (!r.ok) return;
    const data: { channels: ChannelPref[]; serverLevel?: NotifLevel } = await r.json();
    _prefs.clear();
    for (const p of data.channels ?? []) _prefs.set(p.channelId, p);
    _serverLevel = data.serverLevel ?? 'default';
    _applyMuteBadges();
  } catch { /* non-critical */ }
}

// ── Get effective level for a channel ────────────────────────────────────────

export function getEffectiveLevel(channelId: string): NotifLevel {
  const pref = _prefs.get(channelId);
  if (!pref) return _serverLevel === 'default' ? 'all' : _serverLevel;

  // Check if mute has expired
  if (pref.level === 'mute' && pref.muteUntil != null && pref.muteUntil > 0 && pref.muteUntil < Date.now()) {
    return _serverLevel === 'default' ? 'all' : _serverLevel;
  }
  return pref.level;
}

export function isChannelMuted(channelId: string): boolean {
  return getEffectiveLevel(channelId) === 'mute';
}

// ── Open channel notification panel ─────────────────────────────────────────

export function openChannelNotifPanel(channelId: string, channelName: string, anchorEl?: HTMLElement): void {
  document.getElementById('notif-pref-panel')?.remove();

  const existing = _prefs.get(channelId);
  const current  = existing?.level ?? 'default';
  const muteUntil= existing?.muteUntil;

  const panel = document.createElement('div');
  panel.id = 'notif-pref-panel';
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-label', 'Bildirim Tercihleri');

  // Position near anchor or center
  const pos = anchorEl
    ? (() => {
        const r = anchorEl.getBoundingClientRect();
        return `position:fixed;top:${Math.min(r.bottom + 6, window.innerHeight - 320)}px;left:${Math.min(r.left, window.innerWidth - 280)}px;`;
      })()
    : 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);';

  panel.style.cssText = `${pos}z-index:10000;width:260px;background:var(--bg-secondary);border:1px solid var(--border);border-radius:10px;box-shadow:0 8px 32px rgba(0,0,0,.4);overflow:hidden;`;

  const muteInfo = (muteUntil && muteUntil > Date.now())
    ? `<div style="font-size:11px;color:var(--text-3);padding:0 14px 8px;">🔕 ${_formatMuteUntil(muteUntil)} kadar sessiz</div>`
    : '';

  panel.innerHTML = `
    <div style="padding:12px 14px 8px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border);">
      <div>
        <div style="font-weight:700;font-size:13px;">🔔 #${escHtml(channelName)}</div>
        <div style="font-size:11px;color:var(--text-3);margin-top:1px;">Bildirim tercihleri</div>
      </div>
      <button style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:16px;padding:2px 4px;" onclick="document.getElementById('notif-pref-panel').remove()" aria-label="Kapat">✕</button>
    </div>
    ${muteInfo}

    <div style="padding:8px 0;">
      ${_levelOption('all',      '🔔',  'Tüm Mesajlar',     'Her mesajda bildirim al',      current)}
      ${_levelOption('mentions', '🔕',  'Sadece @Mention',  'Sadece mention\'da bildirim',  current)}
      ${_levelOption('mute',     '🚫',  'Sessize Al',       'Hiç bildirim alma',            current)}
      ${_serverLevel !== 'default' ? _levelOption('default', '⚙️', 'Sunucu Varsayılanı', `Sunucu ayarını kullan (${_levelLabel(_serverLevel)})`, current) : ''}
    </div>

    <div id="notif-mute-duration" style="display:${current === 'mute' ? 'block' : 'none'};border-top:1px solid var(--border);padding:8px 0;">
      <div style="font-size:11px;font-weight:600;color:var(--text-3);padding:0 14px 6px;text-transform:uppercase;letter-spacing:.4px;">Sessiz Süre</div>
      ${MUTE_DURATIONS.map(d => `
        <div class="notif-dur-item" style="padding:7px 14px;cursor:pointer;font-size:13px;color:var(--text-1);transition:background .1s;"
          onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background=''"
          onclick="window._npSetMute('${channelId}', ${d.ms})">${d.label}</div>`).join('')}
    </div>`;

  document.body.appendChild(panel);

  // Wire level buttons
  panel.querySelectorAll<HTMLElement>('[data-notif-level]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const level = btn.dataset.notifLevel as NotifLevel;
      if (level === 'mute') {
        const durSection = document.getElementById('notif-mute-duration');
        if (durSection) durSection.style.display = durSection.style.display === 'none' ? 'block' : 'none';
        return;
      }
      await _saveLevel(channelId, level, null);
      panel.remove();
    });
  });

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!panel.contains(e.target as Node)) { panel.remove(); document.removeEventListener('click', handler); }
    });
  }, 50);
}

// ── Mute with duration ───────────────────────────────────────────────────────

async function _npSetMute(channelId: string, durationMs: number): Promise<void> {
  const muteUntil = durationMs === 0 ? null : Date.now() + durationMs;
  await _saveLevel(channelId, 'mute', muteUntil);
  document.getElementById('notif-pref-panel')?.remove();
  const label = durationMs === 0 ? 'sonsuza kadar' : MUTE_DURATIONS.find(d => d.ms === durationMs)?.label ?? '';
  toast(`🔕 Kanal ${label} sessiz alındı`, 'success');
}
(window as Window & { _npSetMute?: typeof _npSetMute })._npSetMute = _npSetMute;

// ── Save to backend ──────────────────────────────────────────────────────────

async function _saveLevel(channelId: string, level: NotifLevel, muteUntil: number | null): Promise<void> {
  const API = getAPI();

  const pref: ChannelPref = { channelId, level, muteUntil, updatedAt: Date.now() };
  _prefs.set(channelId, pref);
  _applyMuteBadges();

  // Optimistic local — persist to server
  try {
    await apiFetch(`${API}/api/notification-prefs`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ channelId, level, muteUntil }),
    });
  } catch { /* non-critical — pref stored in memory */ }

  // Socket sync
  (window as Window & { socket?: { emit: (...a: unknown[]) => void } }).socket?.emit(
    'notif:pref', { channelId, level, muteUntil }
  );
}

// ── Apply mute badges to channel list ────────────────────────────────────────

function _applyMuteBadges(): void {
  document.querySelectorAll<HTMLElement>('.ch-item[data-id]').forEach(el => {
    const cid = el.dataset.id!;
    const muted = isChannelMuted(cid);
    let badge = el.querySelector<HTMLElement>('.ch-mute-badge');

    if (muted) {
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'ch-mute-badge';
        badge.title     = 'Sessiz';
        badge.textContent = '🔕';
        badge.style.cssText = 'font-size:11px;margin-left:4px;opacity:.6;';
        el.querySelector('.ch-name')?.after(badge);
      }
      // Suppress unread counter when muted
      const unread = document.getElementById(`unread-${cid}`);
      if (unread) unread.style.display = 'none';
    } else {
      badge?.remove();
    }
  });
}

// ── Open server-level notification settings ──────────────────────────────────

export function openServerNotifSettings(): void {
  document.getElementById('server-notif-modal')?.remove();
  const modal = document.createElement('div');
  modal.id        = 'server-notif-modal';
  modal.className = 'modal-overlay';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:420px;width:94%;">
      <h2 style="margin:0 0 4px;">🔔 Sunucu Bildirim Ayarları</h2>
      <p style="font-size:13px;color:var(--text-3);margin:0 0 20px;">Kanal ayarı yoksa bu seviye geçerlidir.</p>

      <div style="display:flex;flex-direction:column;gap:8px;">
        ${(['all','mentions','mute'] as NotifLevel[]).map(l => `
          <label style="display:flex;align-items:center;gap:12px;padding:10px 14px;background:var(--bg-1);border-radius:8px;cursor:pointer;border:1.5px solid ${_serverLevel===l ? 'var(--accent)' : 'transparent'}" id="snl-${l}">
            <input type="radio" name="server-notif" value="${l}" ${_serverLevel===l?'checked':''} style="accent-color:var(--accent);">
            <div>
              <div style="font-weight:600;font-size:13px;">${_levelLabel(l)}</div>
              <div style="font-size:11px;color:var(--text-3);">${_levelDesc(l)}</div>
            </div>
          </label>`).join('')}
      </div>

      <div class="modal-footer" style="margin-top:20px;display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="document.getElementById('server-notif-modal').remove()">İptal</button>
        <button class="btn btn-primary" onclick="window._npSaveServerLevel()">💾 Kaydet</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
}

async function _npSaveServerLevel(): Promise<void> {
  const val = (document.querySelector<HTMLInputElement>('input[name="server-notif"]:checked'))?.value as NotifLevel | undefined;
  if (!val) return;
  _serverLevel = val;
  const API    = getAPI();
  const server = getCurrentServer() as { _id?: string } | null;
  if (server?._id) {
    await apiFetch(`${API}/api/notification-prefs/server`, {
      method:  'PUT',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ serverId: server._id, level: val }),
    }).catch(() => {});
  }
  _applyMuteBadges();
  toast('✅ Sunucu bildirim ayarı güncellendi', 'success');
  document.getElementById('server-notif-modal')?.remove();
}
(window as Window & { _npSaveServerLevel?: () => void })._npSaveServerLevel = _npSaveServerLevel;

// ── Socket event wiring ───────────────────────────────────────────────────────

export function bindNotifPrefSocketEvents(): void {
  const socket = (window as Window & { socket?: { on: (...a: unknown[]) => void } }).socket;
  if (!socket) return;

  socket.on('notif:pref:sync', (data: ChannelPref) => {
    _prefs.set(data.channelId, data);
    _applyMuteBadges();
  });
}

// ── Render helpers ────────────────────────────────────────────────────────────

function _levelOption(level: NotifLevel, icon: string, label: string, desc: string, current: NotifLevel): string {
  const active = current === level;
  return `
    <div data-notif-level="${level}" style="display:flex;align-items:center;gap:10px;padding:8px 14px;cursor:pointer;transition:background .1s;${active?'background:var(--bg-hover);':''}"
      onmouseenter="this.style.background='var(--bg-hover)'" onmouseleave="this.style.background='${active?'var(--bg-hover)':''}'" >
      <span style="font-size:16px;width:22px;text-align:center;">${icon}</span>
      <div style="flex:1;">
        <div style="font-size:13px;font-weight:${active?'700':'400'};color:var(--text-1);">${label}</div>
        <div style="font-size:11px;color:var(--text-3);">${desc}</div>
      </div>
      ${active ? '<span style="color:var(--accent);font-size:14px;">✓</span>' : ''}
    </div>`;
}

function _levelLabel(l: NotifLevel): string {
  return l === 'all' ? '🔔 Tüm Mesajlar' : l === 'mentions' ? '🔕 Sadece @Mention' : l === 'mute' ? '🚫 Sessiz' : '⚙️ Varsayılan';
}

function _levelDesc(l: NotifLevel): string {
  return l === 'all' ? 'Bu sunucudaki her mesaj bildirim gönderir'
    : l === 'mentions' ? 'Sadece @mention veya @everyone bildirimi alırsın'
    : '🚫 Bu sunucudan hiç bildirim almaz'
    : 'Sunucu ayarını kanallar için temel al';
}

function _formatMuteUntil(ts: number): string {
  const diff = ts - Date.now();
  if (diff <= 0) return 'süre doldu';
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  if (h > 0) return `${h}s ${m}dk`;
  return `${m}dk`;
}

// ── BridgeRegistry exports ────────────────────────────────────────────────────

BridgeRegistry.register('openChannelNotifPanel',   openChannelNotifPanel);
BridgeRegistry.register('openServerNotifSettings', openServerNotifSettings);
BridgeRegistry.register('loadServerNotifPrefs',    loadServerNotifPrefs);
BridgeRegistry.register('isChannelMuted',          isChannelMuted);
BridgeRegistry.register('getEffectiveLevel',       getEffectiveLevel);
