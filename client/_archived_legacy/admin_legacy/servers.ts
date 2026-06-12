// client/js/admin/servers.ts
// Admin paneli — Sunucular sekmesi (🖥️)

import { _sectionTitle, _fmtDate } from './utils';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function toast(msg: string, type: string): void;
declare const API: string;

export async function loadAdminServers(el: HTMLElement): Promise<void> {
  try {
    const r = await apiFetch(`${API}/api/admin/servers`);
    if (!r.ok) return void (el.innerHTML = `<div style="color:#e55;padding:20px;">Erişim reddedildi</div>`);
    const servers: { _id: string; name: string; memberCount: number; discoverable: boolean; createdAt: number }[] = await r.json();

    el.innerHTML = `
      ${_sectionTitle(`🖥️ Sunucular (${servers.length})`)}
      <div style="overflow-x:auto;border-radius:10px;border:1px solid #1e1e38;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#12121f;">
              <th style="text-align:left;padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Sunucu</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Üyeler</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Keşif</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Oluşturulma</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;text-align:right;">İşlem</th>
            </tr>
          </thead>
          <tbody>
            ${servers.length ? servers.map(s => `
              <tr style="border-bottom:1px solid #1a1a2e;">
                <td style="padding:10px 14px;">
                  <div style="font-weight:600;color:#d0d0f0;">${escHtml(s.name)}</div>
                  <div style="color:#444;font-size:10px;font-family:monospace;margin-top:2px;">${s._id}</div>
                </td>
                <td style="text-align:center;padding:10px 14px;color:#8892f8;font-weight:600;">
                  ${s.memberCount.toLocaleString('tr-TR')}
                </td>
                <td style="text-align:center;padding:10px 14px;">
                  ${s.discoverable ? '✅' : '<span style="color:#333;">—</span>'}
                </td>
                <td style="text-align:center;padding:10px 14px;color:#555;white-space:nowrap;">${_fmtDate(s.createdAt)}</td>
                <td style="text-align:right;padding:10px 14px;">
                  <button onclick="adminDeleteServer('${s._id}','${escHtml(s.name)}')"
                    style="background:#1e1a1a;color:#e55;border:1px solid #3a2020;
                           border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">
                    🗑 Sil
                  </button>
                </td>
              </tr>`).join('') : `
              <tr><td colspan="5" style="padding:32px;text-align:center;color:#444;">Sunucu yok</td></tr>`}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml((e as Error).message)}</div>`;
  }
}

export async function adminDeleteServer(sid: string, name: string): Promise<void> {
  if (!confirm(`"${name}" sunucusu ve tüm içeriği kalıcı olarak silinsin mi?\n\nBu işlem geri alınamaz!`)) return;
  const r = await apiFetch(`${API}/api/admin/servers/${sid}`, { method: 'DELETE' });
  if (r.ok) {
    toast(`"${name}" silindi`, 'success');
    loadAdminServers(document.getElementById('admin-content') as HTMLElement);
  } else toast('Silinemedi', 'error');
}
