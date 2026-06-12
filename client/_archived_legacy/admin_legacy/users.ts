// client/js/admin/users.ts
// Admin paneli — Kullanıcılar sekmesi (👥)

import { _sectionTitle, _fmtDate } from './utils';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function toast(msg: string, type: string): void;
declare const API: string;

let _adminUserQ = '';

export async function loadAdminUsers(el: HTMLElement, q = _adminUserQ, page = 1): Promise<void> {
  _adminUserQ = q;
  try {
    const params = new URLSearchParams({ q, page: String(page), limit: '30' });
    const r = await apiFetch(`${API}/api/admin/users?${params}`);
    if (!r.ok) return void (el.innerHTML = `<div style="color:#e55;padding:20px;">Erişim reddedildi</div>`);
    const data = await r.json();

    el.innerHTML = `
      ${_sectionTitle('👥 Kullanıcılar')}
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
        <input id="admin-user-q" placeholder="Kullanıcı adı, e-posta ara…" value="${escHtml(q)}"
          style="flex:1;max-width:320px;background:#161627;border:1px solid #2a2a45;color:#ccc;
                 border-radius:8px;padding:9px 14px;font-size:13px;"
          oninput="this.dispatchEvent(new CustomEvent('bridge:admin-search',{bubbles:true,detail:{q:this.value}}))" />
        <span style="color:#555;font-size:13px;">${data.total.toLocaleString('tr-TR')} kullanıcı</span>
      </div>
      <div style="overflow-x:auto;border-radius:10px;border:1px solid #1e1e38;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#12121f;">
              <th style="text-align:left;padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Kullanıcı</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">E-posta</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">2FA</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Admin</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Kayıt</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;text-align:right;">İşlemler</th>
            </tr>
          </thead>
          <tbody>
            ${data.users.length ? data.users.map((u: {
              _id: string; displayName: string; username: string;
              email?: string; emailVerified: boolean; isAdmin: boolean;
              twoFactorEnabled: boolean; createdAt: number;
            }) => `
              <tr id="urow-${u._id}" style="border-bottom:1px solid #1a1a2e;">
                <td style="padding:10px 14px;">
                  <div style="font-weight:600;color:#d0d0f0;">${escHtml(u.displayName)}</div>
                  <div style="color:#555;font-size:11px;">@${escHtml(u.username)}</div>
                </td>
                <td style="text-align:center;padding:10px 14px;">
                  ${u.email
                    ? `<span title="${escHtml(u.email)}">${u.emailVerified ? '✅' : '⚠️'}</span>`
                    : '<span style="color:#333;">—</span>'}
                </td>
                <td style="text-align:center;padding:10px 14px;">${u.twoFactorEnabled ? '🔐' : '<span style="color:#333;">—</span>'}</td>
                <td style="text-align:center;padding:10px 14px;">${u.isAdmin ? '⭐' : '<span style="color:#333;">—</span>'}</td>
                <td style="text-align:center;padding:10px 14px;color:#555;white-space:nowrap;">${_fmtDate(u.createdAt)}</td>
                <td style="text-align:right;padding:10px 14px;">
                  <div style="display:flex;gap:6px;justify-content:flex-end;">
                    <button onclick="adminToggleAdmin('${u._id}',${!u.isAdmin})"
                      style="background:${u.isAdmin ? '#2a1010' : '#1a1e3a'};color:${u.isAdmin ? '#e55' : '#8892f8'};
                             border:1px solid ${u.isAdmin ? '#3a1515' : '#2a3070'};border-radius:6px;
                             padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap;">
                      ${u.isAdmin ? '⬇ Yetkiyi Al' : '⬆ Admin Yap'}
                    </button>
                    <button onclick="adminDeleteUser('${u._id}','${escHtml(u.username)}')"
                      style="background:#1e1a1a;color:#e55;border:1px solid #3a2020;
                             border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;">
                      🗑
                    </button>
                  </div>
                </td>
              </tr>`).join('') : `
              <tr><td colspan="6" style="padding:32px;text-align:center;color:#444;">Kullanıcı bulunamadı</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="display:flex;gap:8px;margin-top:18px;justify-content:center;align-items:center;">
        ${data.page > 1 ? `
          <button onclick="loadAdminUsers(document.getElementById('admin-content'),
                           document.getElementById('admin-user-q')?.value||'',${data.page-1})"
            style="background:#161627;color:#888;border:1px solid #1e1e38;
                   padding:6px 16px;border-radius:7px;cursor:pointer;font-size:13px;">← Önceki</button>` : ''}
        <span style="color:#555;font-size:13px;">${data.page} / ${data.pages || 1}</span>
        ${data.page < data.pages ? `
          <button onclick="loadAdminUsers(document.getElementById('admin-content'),
                           document.getElementById('admin-user-q')?.value||'',${data.page+1})"
            style="background:#161627;color:#888;border:1px solid #1e1e38;
                   padding:6px 16px;border-radius:7px;cursor:pointer;font-size:13px;">Sonraki →</button>` : ''}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml((e as Error).message)}</div>`;
  }
}

export async function adminToggleAdmin(userId: string, makeAdmin: boolean): Promise<void> {
  const r = await apiFetch(`${API}/api/admin/users/${userId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAdmin: makeAdmin }),
  });
  if (r.ok) {
    toast(makeAdmin ? '⭐ Admin yetkisi verildi' : 'Admin yetkisi alındı', 'success');
    loadAdminUsers(document.getElementById('admin-content') as HTMLElement);
  } else toast('İşlem başarısız', 'error');
}

export async function adminDeleteUser(userId: string, username: string): Promise<void> {
  if (!confirm(`@${username} kullanıcısı ve tüm verileri kalıcı olarak silinsin mi?\n\nBu işlem geri alınamaz!`)) return;
  const r = await apiFetch(`${API}/api/admin/users/${userId}`, { method: 'DELETE' });
  if (r.ok) {
    toast(`@${username} silindi`, 'success');
    loadAdminUsers(document.getElementById('admin-content') as HTMLElement);
  } else toast('Silinemedi', 'error');
}
