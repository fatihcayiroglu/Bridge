// client/js/admin/logs.ts
// Admin paneli — Loglar (📋) ve Broadcast Duyuru (📢) sekmeleri

import { _sectionTitle, _adminCard, _emptyState, _fmtTime } from './utils';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function toast(msg: string, type: string): void;
declare const API: string;

// ── Loglar ────────────────────────────────────────────────────
const _LOG_COLORS: Record<string, string> = {
  delete_user: '#e55', delete_server: '#e55',
  ip_ban: '#eb459e', ip_unban: '#57f287',
  update_user: '#faa61a', broadcast: '#8892f8',
};

export async function loadAdminLogs(el: HTMLElement): Promise<void> {
  try {
    const r = await apiFetch(`${API}/api/admin/logs`);
    if (!r.ok) return void (el.innerHTML = `<div style="color:#e55;padding:20px;">Erişim reddedildi</div>`);
    const logs: { action: string; adminUsername?: string; adminId?: string; target?: string; detail?: string; createdAt: number }[] = await r.json();

    el.innerHTML = `
      ${_sectionTitle(`📋 Admin Logları (son ${logs.length})`)}
      ${logs.length ? logs.map(l => {
        const color  = _LOG_COLORS[l.action] || '#8892f8';
        const detail = l.detail ? (() => { try { return JSON.parse(l.detail!); } catch { return null; } })() : null;
        return `
          <div style="background:#161627;border-radius:9px;padding:12px 16px;margin-bottom:8px;
                      border:1px solid #1e1e38;border-left:3px solid ${color};">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
              <div>
                <span style="color:#8892f8;font-weight:700;font-size:13px;">${escHtml(l.adminUsername || l.adminId || '?')}</span>
                <span style="color:#444;margin:0 8px;">→</span>
                <span style="color:${color};font-weight:600;font-size:13px;">${escHtml(l.action)}</span>
                ${l.target ? `<span style="color:#444;margin-left:8px;font-size:11px;font-family:monospace;">${escHtml(l.target)}</span>` : ''}
              </div>
              <span style="color:#444;font-size:11px;white-space:nowrap;flex-shrink:0;">${_fmtTime(l.createdAt)}</span>
            </div>
            ${detail ? `
              <div style="margin-top:6px;font-size:11px;color:#555;font-family:monospace;
                          background:#0f0f1a;padding:6px 10px;border-radius:5px;word-break:break-all;">
                ${escHtml(JSON.stringify(detail).slice(0, 220))}
              </div>` : ''}
          </div>`;
      }).join('') : _emptyState('Henüz log yok')}`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml((e as Error).message)}</div>`;
  }
}

// ── Broadcast ─────────────────────────────────────────────────
export function loadAdminBroadcast(el: HTMLElement): void {
  el.innerHTML = `
    ${_sectionTitle('📢 Tüm Kullanıcılara Duyuru')}
    ${_adminCard(`
      <p style="color:#888;font-size:13px;margin:0 0 16px;line-height:1.6;">
        Bu mesaj şu an bağlı olan tüm kullanıcılara Socket.io üzerinden anlık iletilir.
        Çevrimdışı kullanıcılar göremez.
      </p>
      <label style="font-size:12px;color:#666;display:block;margin-bottom:8px;">Duyuru Mesajı</label>
      <textarea id="broadcast-msg" rows="5"
        style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
               border-radius:8px;padding:12px;font-size:13px;resize:vertical;
               box-sizing:border-box;line-height:1.6;margin-bottom:14px;"
        placeholder="Tüm kullanıcılara gönderilecek mesajı yazın…"></textarea>
      <button onclick="sendBroadcast()"
        style="background:#2d9cdb;color:#fff;border:none;border-radius:8px;
               padding:10px 24px;cursor:pointer;font-size:14px;font-weight:600;">
        📢 Gönder
      </button>
    `)}`;
}

export async function sendBroadcast(): Promise<void> {
  const message = (document.getElementById('broadcast-msg') as HTMLTextAreaElement)?.value.trim();
  if (!message) return toast('Mesaj boş olamaz', 'error');
  if (!confirm(`Bu mesaj tüm aktif kullanıcılara gönderilsin mi?\n\n"${message}"`)) return;
  const r = await apiFetch(`${API}/api/admin/broadcast`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (r.ok) {
    toast('Duyuru gönderildi! 📢', 'success');
    const t = document.getElementById('broadcast-msg') as HTMLTextAreaElement | null;
    if (t) t.value = '';
  } else toast('Gönderilemedi', 'error');
}
