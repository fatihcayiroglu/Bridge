// client/js/admin/reaction-roles.ts
// Admin paneli — Reaction Roller sekmesi (⚡)

import { _adminCard, _sectionTitle } from './utils';

declare function apiFetch(url: string, opts?: RequestInit): Promise<Response>;
declare function escHtml(s: string): string;
declare function toast(msg: string, type: string): void;
declare const API: string;
declare const currentServer: { _id: string } | null | undefined;

export async function loadAdminReactionRoles(el: HTMLElement): Promise<void> {
  if (!currentServer) {
    el.innerHTML = `
      ${_sectionTitle('⚡ Reaction Roller')}
      <div style="color:#888;padding:24px;background:#161627;border-radius:10px;border:1px solid #1e1e38;text-align:center;">
        Önce sol panelden bir sunucu seçmelisin.
      </div>`;
    return;
  }
  const sid = currentServer._id;
  let roles: { _id: string; name: string; color?: string }[] = [];
  let channels: { _id: string; name: string; type: string }[] = [];
  let rules: { _id: string; channelId: string; messageId: string; emoji: string; roleId: string }[] = [];
  try {
    const [rr, rc, rrules] = await Promise.all([
      apiFetch(`${API}/api/servers/${sid}/roles`).then(r => r.json()),
      apiFetch(`${API}/api/servers/${sid}/channels`).then(r => r.json()),
      apiFetch(`${API}/api/servers/${sid}/reaction-roles`).then(r => r.json()),
    ]);
    roles    = Array.isArray(rr)     ? rr     : [];
    channels = Array.isArray(rc)     ? rc     : [];
    rules    = Array.isArray(rrules) ? rrules : [];
  } catch {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Veri yüklenemedi.</div>`;
    return;
  }

  const roleMap    = Object.fromEntries(roles.map(r => [r._id, r]));
  const channelMap = Object.fromEntries(channels.map(c => [c._id, c]));

  el.innerHTML = `
    ${_sectionTitle('⚡ Reaction Roller')}
    <div style="max-width:720px;">
      ${_adminCard(`
        <div style="font-size:13px;font-weight:700;color:#aaa;margin-bottom:16px;text-transform:uppercase;letter-spacing:.06em;">➢ Yeni Kural</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Kanal</label>
            <select id="rr-channel" style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:13px;">
              <option value="">— Kanal seç —</option>
              ${channels.filter(c => c.type === 'text').map(c =>
                `<option value="${escHtml(c._id)}">#${escHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Mesaj ID</label>
            <input id="rr-msgid" placeholder="Sağ tık → ID kopyala"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:13px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Emoji</label>
            <input id="rr-emoji" placeholder="👍" maxlength="64"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:20px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Verilecek Rol</label>
            <select id="rr-role" style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:13px;">
              <option value="">— Rol seç —</option>
              ${roles.map(r => `<option value="${escHtml(r._id)}" style="color:${r.color||'#ccc'}">${escHtml(r.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <button onclick="addReactionRole('${escHtml(sid)}')"
          style="background:#2d9cdb;color:#fff;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:13px;font-weight:600;">
          ✚ Kural Ekle
        </button>
      `, 'margin-bottom:24px;')}

      <div style="color:#666;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
        📋 Aktif Kurallar (${rules.length})
      </div>
      ${rules.length ? rules.map(rule => {
        const ch   = channelMap[rule.channelId];
        const role = roleMap[rule.roleId];
        return `
          <div style="display:flex;align-items:center;gap:14px;background:#161627;border-radius:9px;
                      padding:13px 16px;margin-bottom:8px;border:1px solid #1e1e38;">
            <span style="font-size:26px;min-width:30px;text-align:center;">${escHtml(rule.emoji)}</span>
            <div style="flex:1;">
              <div style="font-size:13px;color:#bbb;">
                <span style="color:#555;">#</span>${escHtml(ch?.name || rule.channelId)}
                <span style="color:#333;margin:0 6px;">›</span>
                <span style="color:#555;font-family:monospace;font-size:11px;">${escHtml((rule.messageId||'').slice(0,12))}…</span>
              </div>
              <div style="font-size:12px;color:#666;margin-top:3px;">
                Tepki →
                <span style="color:${role?.color||'#8892f8'};font-weight:600;">${escHtml(role?.name || rule.roleId)}</span>
                rolü ver/al
              </div>
            </div>
            <button onclick="deleteReactionRule('${escHtml(sid)}','${escHtml(rule._id)}')"
              style="background:#1e1a1a;color:#e55;border:1px solid #3a2020;
                     border-radius:7px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600;">
              🗑️ Sil
            </button>
          </div>`;
      }).join('') : `
        <div style="color:#444;padding:28px;text-align:center;background:#161627;border-radius:9px;border:1px solid #1e1e38;">
          Henüz reaction-role kuralı yok
        </div>`}
    </div>`;
}

export async function addReactionRole(sid: string): Promise<void> {
  const channelId = (document.getElementById('rr-channel') as HTMLSelectElement)?.value?.trim();
  const messageId = (document.getElementById('rr-msgid')   as HTMLInputElement)?.value?.trim();
  const emoji     = (document.getElementById('rr-emoji')   as HTMLInputElement)?.value?.trim();
  const roleId    = (document.getElementById('rr-role')    as HTMLSelectElement)?.value?.trim();
  if (!channelId || !messageId || !emoji || !roleId) return toast('Tüm alanları doldur', 'error');
  const r = await apiFetch(`${API}/api/servers/${sid}/reaction-roles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, messageId, emoji, roleId }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Eklenemedi', 'error');
  toast('Kural eklendi! ⚡', 'success');
  await loadAdminReactionRoles(document.getElementById('admin-content') as HTMLElement);
}

export async function deleteReactionRule(sid: string, rrId: string): Promise<void> {
  const r = await apiFetch(`${API}/api/servers/${sid}/reaction-roles/${rrId}`, { method: 'DELETE' });
  if (!r.ok) return toast('Silinemedi', 'error');
  toast('Kural silindi', 'info');
  await loadAdminReactionRoles(document.getElementById('admin-content') as HTMLElement);
}
