// client/js/admin/ip-bans.ts
// Admin paneli — IP Yasakları sekmesi (🚫)

import { _adminCard, _sectionTitle, _emptyState, _fmtTime } from './utils';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function toast(msg: string, type: string): void;
declare const API: string;

export async function loadAdminIpBans(el: HTMLElement): Promise<void> {
  try {
    const r = await apiFetch(`${API}/api/admin/ip-bans`);
    if (!r.ok) return void (el.innerHTML = `<div style="color:#e55;padding:20px;">Erişim reddedildi</div>`);
    const bans: { ip: string; reason?: string; bannedAt: number; expiresAt?: number | null }[] = await r.json();

    el.innerHTML = `
      ${_sectionTitle('🚫 IP Yasakları')}
      ${_adminCard(`
        <div style="font-size:13px;font-weight:700;color:#aaa;margin-bottom:14px;text-transform:uppercase;letter-spacing:.06em;">➢ Yeni IP Yasağı</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px;">
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">IP Adresi *</label>
            <input id="ipban-ip" placeholder="192.168.1.1 veya ::1" maxlength="45"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
                     border-radius:7px;padding:9px 12px;font-size:13px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Sebep</label>
            <input id="ipban-reason" placeholder="Spam, brute force…" maxlength="200"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
                     border-radius:7px;padding:9px 12px;font-size:13px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Süre</label>
            <select id="ipban-duration"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
                     border-radius:7px;padding:9px 12px;font-size:13px;">
              <option value="">Kalıcı</option>
              <option value="3600000">1 Saat</option>
              <option value="86400000">1 Gün</option>
              <option value="604800000">1 Hafta</option>
              <option value="2592000000">30 Gün</option>
            </select>
          </div>
        </div>
        <button onclick="adminAddIpBan()"
          style="background:#2d9cdb;color:#fff;border:none;border-radius:8px;
                 padding:9px 22px;cursor:pointer;font-size:13px;font-weight:600;">
          🚫 Yasak Ekle
        </button>
      `, 'margin-bottom:24px;')}

      <div style="color:#666;font-size:13px;font-weight:600;margin-bottom:12px;">
        Aktif Yasaklar (${bans.length})
      </div>
      ${bans.length ? `
        <div style="border-radius:10px;border:1px solid #1e1e38;overflow:hidden;">
          <table style="width:100%;border-collapse:collapse;font-size:13px;">
            <thead>
              <tr style="background:#12121f;">
                <th style="text-align:left;padding:10px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">IP</th>
                <th style="padding:10px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Sebep</th>
                <th style="padding:10px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Tarih</th>
                <th style="padding:10px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Bitiş</th>
                <th style="padding:10px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;text-align:right;">İşlem</th>
              </tr>
            </thead>
            <tbody>
              ${bans.map(b => {
                const expired = b.expiresAt && b.expiresAt <= Date.now();
                const expLabel = !b.expiresAt
                  ? '<span style="color:#faa61a;">Kalıcı</span>'
                  : expired
                    ? '<span style="color:#e55;">Süresi Doldu</span>'
                    : `<span style="color:#888;">${_fmtTime(b.expiresAt)}</span>`;
                return `
                  <tr style="border-bottom:1px solid #1a1a2e;">
                    <td style="padding:10px 14px;font-family:monospace;color:#eb459e;font-weight:600;">${escHtml(b.ip)}</td>
                    <td style="padding:10px 14px;color:#888;">${escHtml(b.reason || '—')}</td>
                    <td style="padding:10px 14px;color:#555;white-space:nowrap;">${_fmtTime(b.bannedAt)}</td>
                    <td style="padding:10px 14px;white-space:nowrap;">${expLabel}</td>
                    <td style="text-align:right;padding:10px 14px;">
                      <button onclick="adminRemoveIpBan('${escHtml(b.ip)}')"
                        style="background:#0f2018;color:#57f287;border:1px solid #1a3a28;
                               border-radius:6px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:600;">
                        ✅ Kaldır
                      </button>
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : _emptyState('Aktif IP yasağı yok')}`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml((e as Error).message)}</div>`;
  }
}

export async function adminAddIpBan(): Promise<void> {
  const ip         = (document.getElementById('ipban-ip') as HTMLInputElement)?.value.trim();
  const reason     = (document.getElementById('ipban-reason') as HTMLInputElement)?.value.trim() || 'Admin ban';
  const durationMs = (document.getElementById('ipban-duration') as HTMLSelectElement)?.value || null;
  if (!ip) return toast('IP adresi zorunlu', 'error');
  const r = await apiFetch(`${API}/api/admin/ip-bans`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, reason, durationMs: durationMs ? parseInt(durationMs) : null }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Yasak eklenemedi', 'error');
  toast(`${ip} yasaklandı 🚫`, 'success');
  loadAdminIpBans(document.getElementById('admin-content') as HTMLElement);
}

export async function adminRemoveIpBan(ip: string): Promise<void> {
  if (!confirm(`${ip} adresinin yasağı kaldırılsın mı?`)) return;
  const r = await apiFetch(`${API}/api/admin/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
  if (r.ok) {
    toast(`${ip} yasağı kaldırıldı ✅`, 'success');
    loadAdminIpBans(document.getElementById('admin-content') as HTMLElement);
  } else toast('Kaldırılamadı', 'error');
}
