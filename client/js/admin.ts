// client/dist/js/admin.js â€” Admin Dashboard UI
// Sekmeler: stats | users | servers | ip-bans | logs | broadcast | reaction-roles
'use strict';
export {};

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   Admin butonunu DOM'a enjekte et â€” auth.js currentUser set ettiÄŸinde Ã§aÄŸrÄ±lÄ±r
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function adminInjectButton(user) {
  if (!user?.isAdmin) return;
  if (document.getElementById('btn-admin')) return;
  const ref = document.querySelector('.u-action-btn[onclick="openSettings()"]') as HTMLElement | null;
  if (!ref) return;
  const btn = document.createElement('div');
  btn.id = 'btn-admin';
  btn.className = 'u-action-btn tooltip';
  btn.setAttribute('data-tip', 'Admin Paneli');
  btn.setAttribute('role', 'button');
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('aria-label', 'Admin Panelini AÃ§');
  btn.style.cssText = 'color:#f0a500;font-size:16px;';
  btn.textContent = 'ğŸ›¡ï¸';
  btn.onclick = openAdminDashboard;
  btn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') openAdminDashboard(); };
  ref.parentNode.insertBefore(btn, ref);
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   Overlay & sekme altyapÄ±sÄ±
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
let _adminTab = 'stats';

async function openAdminDashboard() {
  const existing = document.getElementById('admin-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'admin-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;
    display:flex;align-items:stretch;font-family:inherit;`;

  const tabs = [
    { id: 'stats',          icon: 'ğŸ“Š', label: 'Ä°statistik'   },
    { id: 'users',          icon: 'ğŸ‘¥', label: 'KullanÄ±cÄ±lar' },
    { id: 'servers',        icon: 'ğŸ–¥ï¸', label: 'Sunucular'    },
    { id: 'ip-bans',        icon: 'ğŸš«', label: 'IP YasaklarÄ±' },
    { id: 'logs',           icon: 'ğŸ“‹', label: 'Loglar'       },
    { id: 'broadcast',      icon: 'ğŸ“¢', label: 'Duyuru'       },
    { id: 'reaction-roles', icon: 'âš¡', label: 'Reaction Rol' },
  ];

  overlay.innerHTML = `
    <div style="display:flex;width:100%;height:100%;overflow:hidden;">
      <div style="width:210px;min-width:210px;background:#12121f;display:flex;flex-direction:column;border-right:1px solid #1e1e35;">
        <div style="padding:20px 16px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1e1e35;">
          <span style="font-size:22px;">ğŸ›¡ï¸</span>
          <div>
            <div style="font-weight:700;font-size:15px;color:#e0e0f0;">Admin Paneli</div>
            <div style="font-size:11px;color:#555;">Bridge</div>
          </div>
        </div>
        <nav style="padding:8px 0;flex:1;overflow-y:auto;">
          ${tabs.map(t => `
            <button id="atab-${t.id}" onclick="adminTab('${t.id}')"
              style="width:100%;background:none;border:none;color:#6e6e9a;padding:10px 18px;
                     text-align:left;cursor:pointer;font-size:13.5px;display:flex;
                     align-items:center;gap:10px;transition:background .12s,color .12s;">
              <span style="font-size:16px;">${t.icon}</span><span>${t.label}</span>
            </button>`).join('')}
        </nav>
        <div style="padding:12px;">
          <button onclick="document.getElementById('admin-overlay').remove()"
            style="width:100%;padding:9px;background:#1e1e35;border:none;color:#888;
                   border-radius:8px;cursor:pointer;font-size:13px;">
            âœ• Kapat
          </button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;background:#0f0f1a;padding:28px 32px;" id="admin-content">
        <div style="color:#444;">YÃ¼kleniyorâ€¦</div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const escHandler = (e) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); } };
  document.addEventListener('keydown', escHandler);
  adminTab('stats');
}

async function adminTab(tab) {
  _adminTab = tab;
  document.querySelectorAll('[id^="atab-"]').forEach(b => {
    const active = b.id === `atab-${tab}`;
    b.style.background = active ? 'rgba(88,101,242,.18)' : 'none';
    b.style.color      = active ? '#8892f8' : '#6e6e9a';
    b.style.fontWeight = active ? '600' : '400';
  });
  const el = document.getElementById('admin-content');
  el.innerHTML = `<div style="color:#444;padding:40px;text-align:center;font-size:14px;">YÃ¼kleniyorâ€¦</div>`;

  if (tab === 'stats')          await loadAdminStats(el);
  if (tab === 'users')          await loadAdminUsers(el);
  if (tab === 'servers')        await loadAdminServers(el);
  if (tab === 'ip-bans')        await loadAdminIpBans(el);
  if (tab === 'logs')           await loadAdminLogs(el);
  if (tab === 'broadcast')      loadAdminBroadcast(el);
  if (tab === 'reaction-roles') await loadAdminReactionRoles(el);
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   Ortak yardÄ±mcÄ±lar
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
const _adminCard = (content, extra = '') =>
  `<div style="background:#161627;border-radius:12px;padding:20px;border:1px solid #1e1e38;${extra}">${content}</div>`;

const _statCard = (icon, label, value, color = '#8892f8') => `
  <div style="background:#161627;border-radius:12px;padding:18px 20px;border:1px solid #1e1e38;">
    <div style="color:#555;font-size:12px;margin-bottom:6px;display:flex;align-items:center;gap:6px;">
      <span>${icon}</span><span>${label}</span>
    </div>
    <div style="color:${color};font-size:26px;font-weight:700;">
      ${typeof value === 'number' ? value.toLocaleString('tr-TR') : (value ?? 'â€”')}
    </div>
  </div>`;

const _sectionTitle = (text) =>
  `<h2 style="color:#d0d0f0;margin:0 0 20px;font-size:18px;font-weight:700;">${text}</h2>`;

const _emptyState = (msg) =>
  `<div style="color:#444;padding:40px;text-align:center;font-size:14px;">${msg}</div>`;

function _fmtDate(ts) {
  if (!ts) return 'â€”';
  return new Date(ts).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}
function _fmtTime(ts) {
  if (!ts) return 'â€”';
  return new Date(ts).toLocaleString('tr-TR');
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ğŸ“Š Ä°statistik
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function loadAdminStats(el) {
  try {
    const r = await apiFetch(`${API}/api/admin/stats`);
    if (!r.ok) return el.innerHTML = `<div style="color:#e55;padding:20px;">EriÅŸim reddedildi (${r.status})</div>`;
    const { totals, msgsByDay, topServers, topUsers } = await r.json();

    el.innerHTML = `
      ${_sectionTitle('ğŸ“Š Genel Ä°statistikler')}
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px;margin-bottom:28px;">
        ${_statCard('ğŸ‘¥', 'Toplam KullanÄ±cÄ±',  totals.totalUsers,    '#8892f8')}
        ${_statCard('ğŸ–¥ï¸', 'Toplam Sunucu',     totals.totalServers,  '#8892f8')}
        ${_statCard('ğŸ’¬', 'Toplam Mesaj',       totals.totalMessages, '#57f287')}
        ${_statCard('ğŸ“¨', 'Toplam DM',          totals.totalDMs,      '#57f287')}
        ${_statCard('ğŸŸ¢', 'Ã‡evrimiÃ§i',          totals.onlineUsers,   '#43b581')}
        ${_statCard('ğŸ“§', 'E-posta DoÄŸrulÄ±',    totals.verifiedEmails,'#faa61a')}
        ${_statCard('ğŸ”', '2FA Aktif',          totals.twoFaEnabled,  '#faa61a')}
        ${_statCard('ğŸ†•', 'Bu Hafta KayÄ±t',     totals.newUsers7d,    '#eb459e')}
      </div>
      <div style="margin-bottom:28px;">
        ${_adminCard(`
          <div style="color:#888;font-size:13px;margin-bottom:14px;font-weight:600;">ğŸ“ˆ Son 7 GÃ¼nlÃ¼k Mesaj TrafiÄŸi</div>
          <canvas id="admin-msg-chart" height="120" style="width:100%;display:block;"></canvas>
        `)}
      </div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px;">
        ${_adminCard(`
          <div style="color:#888;font-size:13px;margin-bottom:14px;font-weight:600;">ğŸ† En BÃ¼yÃ¼k Sunucular</div>
          ${topServers.length ? topServers.map((s, i) => `
            <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e1e38;font-size:13px;">
              <span style="color:#bbb;">${i+1}. ${escHtml(s.name)}</span>
              <span style="color:#8892f8;font-weight:600;">${s.memberCount.toLocaleString('tr-TR')} Ã¼ye</span>
            </div>`).join('') : _emptyState('Sunucu yok')}
        `)}
        ${_adminCard(`
          <div style="color:#888;font-size:13px;margin-bottom:14px;font-weight:600;">ğŸ’¬ En Aktif KullanÄ±cÄ±lar (30 gÃ¼n)</div>
          ${topUsers.length ? topUsers.map((u, i) => `
            <div style="display:flex;justify-content:space-between;padding:7px 0;border-bottom:1px solid #1e1e38;font-size:13px;">
              <span style="color:#bbb;">${i+1}. ${escHtml(u.displayName)}</span>
              <span style="color:#57f287;font-weight:600;">${u.msgCount.toLocaleString('tr-TR')} msg</span>
            </div>`).join('') : _emptyState('Veri yok')}
        `)}
      </div>`;

    requestAnimationFrame(() => _drawMsgChart(msgsByDay));
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml(e.message)}</div>`;
  }
}

function _drawMsgChart(msgsByDay) {
  const canvas = document.getElementById('admin-msg-chart') as HTMLCanvasElement | null;
  if (!canvas || !msgsByDay?.length) return;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const dpr = window.devicePixelRatio || 1;
  const W   = Math.max(200, (canvas.parentElement as HTMLElement).clientWidth - 40);
  const H   = 120;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width  = W + 'px';
  canvas.style.height = H + 'px';
  ctx.scale(dpr, dpr);

  const vals = msgsByDay.map(d => d.n);
  const max  = Math.max(...vals, 1);
  const PAD  = { t: 10, b: 26, l: 10, r: 10 };
  const chartH = H - PAD.t - PAD.b;
  const step   = (W - PAD.l - PAD.r) / vals.length;
  const BAR    = Math.max(4, step - 4);

  // Grid
  ctx.strokeStyle = '#1e1e38';
  ctx.lineWidth = 1;
  [0.25, 0.5, 0.75, 1].forEach(f => {
    const y = PAD.t + chartH * (1 - f);
    ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
  });

  // Bars
  vals.forEach((v, i) => {
    const x  = PAD.l + i * step + (step - BAR) / 2;
    const bh = Math.max(2, (v / max) * chartH);
    const y  = PAD.t + chartH - bh;
    const g  = ctx.createLinearGradient(0, y, 0, y + bh);
    g.addColorStop(0, '#8892f8'); g.addColorStop(1, '#4a52c8');
    ctx.fillStyle = g;
    if (ctx.roundRect) {
      ctx.beginPath(); ctx.roundRect(x, y, BAR, bh, [3, 3, 0, 0]); ctx.fill();
    } else {
      ctx.fillRect(x, y, BAR, bh);
    }
  });

  // Labels
  ctx.fillStyle = '#555';
  ctx.font = `${10 * dpr / dpr}px sans-serif`;
  ctx.textAlign = 'center';
  const today = Math.floor(Date.now() / 86400000);
  vals.forEach((_, i) => {
    const d = msgsByDay[i].day - today;
    const label = d === 0 ? 'BugÃ¼n' : d === -1 ? 'DÃ¼n' : `${d}g`;
    ctx.fillText(label, PAD.l + i * step + step / 2, H - 8);
  });
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ğŸ‘¥ KullanÄ±cÄ±lar
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
let _adminUserQ = '';

async function loadAdminUsers(el, q = _adminUserQ, page = 1) {
  _adminUserQ = q;
  try {
    const params = new URLSearchParams({ q, page, limit: 30 });
    const r = await apiFetch(`${API}/api/admin/users?${params}`);
    if (!r.ok) return el.innerHTML = `<div style="color:#e55;padding:20px;">EriÅŸim reddedildi</div>`;
    const data = await r.json();

    el.innerHTML = `
      ${_sectionTitle('ğŸ‘¥ KullanÄ±cÄ±lar')}
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px;">
        <input id="admin-user-q" placeholder="KullanÄ±cÄ± adÄ±, e-posta araâ€¦" value="${escHtml(q)}"
          style="flex:1;max-width:320px;background:#161627;border:1px solid #2a2a45;color:#ccc;
                 border-radius:8px;padding:9px 14px;font-size:13px;"
          oninput="clearTimeout(window._aut);window._aut=setTimeout(()=>
            loadAdminUsers(document.getElementById('admin-content'),this.value,1),280)" />
        <span style="color:#555;font-size:13px;">${data.total.toLocaleString('tr-TR')} kullanÄ±cÄ±</span>
      </div>
      <div style="overflow-x:auto;border-radius:10px;border:1px solid #1e1e38;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#12121f;">
              <th style="text-align:left;padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">KullanÄ±cÄ±</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">E-posta</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">2FA</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Admin</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">KayÄ±t</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;text-align:right;">Ä°ÅŸlemler</th>
            </tr>
          </thead>
          <tbody>
            ${data.users.length ? data.users.map(u => `
              <tr id="urow-${u._id}" style="border-bottom:1px solid #1a1a2e;">
                <td style="padding:10px 14px;">
                  <div style="font-weight:600;color:#d0d0f0;">${escHtml(u.displayName)}</div>
                  <div style="color:#555;font-size:11px;">@${escHtml(u.username)}</div>
                </td>
                <td style="text-align:center;padding:10px 14px;">
                  ${u.email
                    ? `<span title="${escHtml(u.email)}">${u.emailVerified ? 'âœ…' : 'âš ï¸'}</span>`
                    : '<span style="color:#333;">â€”</span>'}
                </td>
                <td style="text-align:center;padding:10px 14px;">${u.twoFactorEnabled ? 'ğŸ”' : '<span style="color:#333;">â€”</span>'}</td>
                <td style="text-align:center;padding:10px 14px;">${u.isAdmin ? 'â­' : '<span style="color:#333;">â€”</span>'}</td>
                <td style="text-align:center;padding:10px 14px;color:#555;white-space:nowrap;">${_fmtDate(u.createdAt)}</td>
                <td style="text-align:right;padding:10px 14px;">
                  <div style="display:flex;gap:6px;justify-content:flex-end;">
                    <button onclick="adminToggleAdmin('${u._id}',${!u.isAdmin})"
                      style="background:${u.isAdmin ? '#2a1010' : '#1a1e3a'};color:${u.isAdmin ? '#e55' : '#8892f8'};
                             border:1px solid ${u.isAdmin ? '#3a1515' : '#2a3070'};border-radius:6px;
                             padding:4px 10px;cursor:pointer;font-size:11px;font-weight:600;white-space:nowrap;">
                      ${u.isAdmin ? 'â¬‡ Yetkiyi Al' : 'â¬† Admin Yap'}
                    </button>
                    <button onclick="adminDeleteUser('${u._id}','${escHtml(u.username)}')"
                      style="background:#1e1a1a;color:#e55;border:1px solid #3a2020;
                             border-radius:6px;padding:4px 10px;cursor:pointer;font-size:11px;">
                      ğŸ—‘
                    </button>
                  </div>
                </td>
              </tr>`).join('') : `
              <tr><td colspan="6" style="padding:32px;text-align:center;color:#444;">KullanÄ±cÄ± bulunamadÄ±</td></tr>`}
          </tbody>
        </table>
      </div>
      <div style="display:flex;gap:8px;margin-top:18px;justify-content:center;align-items:center;">
        ${data.page > 1 ? `
          <button onclick="loadAdminUsers(document.getElementById('admin-content'),
                           document.getElementById('admin-user-q')?.value||'',${data.page-1})"
            style="background:#161627;color:#888;border:1px solid #1e1e38;
                   padding:6px 16px;border-radius:7px;cursor:pointer;font-size:13px;">â† Ã–nceki</button>` : ''}
        <span style="color:#555;font-size:13px;">${data.page} / ${data.pages || 1}</span>
        ${data.page < data.pages ? `
          <button onclick="loadAdminUsers(document.getElementById('admin-content'),
                           document.getElementById('admin-user-q')?.value||'',${data.page+1})"
            style="background:#161627;color:#888;border:1px solid #1e1e38;
                   padding:6px 16px;border-radius:7px;cursor:pointer;font-size:13px;">Sonraki â†’</button>` : ''}
      </div>`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml(e.message)}</div>`;
  }
}

async function adminToggleAdmin(userId, makeAdmin) {
  const r = await apiFetch(`${API}/api/admin/users/${userId}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ isAdmin: makeAdmin }),
  });
  if (r.ok) {
    toast(makeAdmin ? 'â­ Admin yetkisi verildi' : 'Admin yetkisi alÄ±ndÄ±', 'success');
    loadAdminUsers(document.getElementById('admin-content'));
  } else toast('Ä°ÅŸlem baÅŸarÄ±sÄ±z', 'error');
}

async function adminDeleteUser(userId, username) {
  if (!confirm(`@${username} kullanÄ±cÄ±sÄ± ve tÃ¼m verileri kalÄ±cÄ± olarak silinsin mi?\n\nBu iÅŸlem geri alÄ±namaz!`)) return;
  const r = await apiFetch(`${API}/api/admin/users/${userId}`, { method: 'DELETE' });
  if (r.ok) {
    toast(`@${username} silindi`, 'success');
    loadAdminUsers(document.getElementById('admin-content'));
  } else toast('Silinemedi', 'error');
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ğŸ–¥ï¸ Sunucular
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function loadAdminServers(el) {
  try {
    const r = await apiFetch(`${API}/api/admin/servers`);
    if (!r.ok) return el.innerHTML = `<div style="color:#e55;padding:20px;">EriÅŸim reddedildi</div>`;
    const servers = await r.json();

    el.innerHTML = `
      ${_sectionTitle(`ğŸ–¥ï¸ Sunucular (${servers.length})`)}
      <div style="overflow-x:auto;border-radius:10px;border:1px solid #1e1e38;">
        <table style="width:100%;border-collapse:collapse;font-size:13px;">
          <thead>
            <tr style="background:#12121f;">
              <th style="text-align:left;padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Sunucu</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">Ãœyeler</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">KeÅŸif</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">OluÅŸturulma</th>
              <th style="padding:11px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;text-align:right;">Ä°ÅŸlem</th>
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
                  ${s.discoverable ? 'âœ…' : '<span style="color:#333;">â€”</span>'}
                </td>
                <td style="text-align:center;padding:10px 14px;color:#555;white-space:nowrap;">${_fmtDate(s.createdAt)}</td>
                <td style="text-align:right;padding:10px 14px;">
                  <button onclick="adminDeleteServer('${s._id}','${escHtml(s.name)}')"
                    style="background:#1e1a1a;color:#e55;border:1px solid #3a2020;
                           border-radius:6px;padding:4px 12px;cursor:pointer;font-size:12px;font-weight:600;">
                    ğŸ—‘ Sil
                  </button>
                </td>
              </tr>`).join('') : `
              <tr><td colspan="5" style="padding:32px;text-align:center;color:#444;">Sunucu yok</td></tr>`}
          </tbody>
        </table>
      </div>`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml(e.message)}</div>`;
  }
}

async function adminDeleteServer(sid, name) {
  if (!confirm(`"${name}" sunucusu ve tÃ¼m iÃ§eriÄŸi kalÄ±cÄ± olarak silinsin mi?\n\nBu iÅŸlem geri alÄ±namaz!`)) return;
  const r = await apiFetch(`${API}/api/admin/servers/${sid}`, { method: 'DELETE' });
  if (r.ok) {
    toast(`"${name}" silindi`, 'success');
    loadAdminServers(document.getElementById('admin-content'));
  } else toast('Silinemedi', 'error');
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ğŸš« IP YasaklarÄ±
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function loadAdminIpBans(el) {
  try {
    const r = await apiFetch(`${API}/api/admin/ip-bans`);
    if (!r.ok) return el.innerHTML = `<div style="color:#e55;padding:20px;">EriÅŸim reddedildi</div>`;
    const bans = await r.json();

    el.innerHTML = `
      ${_sectionTitle('ğŸš« IP YasaklarÄ±')}
      ${_adminCard(`
        <div style="font-size:13px;font-weight:700;color:#aaa;margin-bottom:14px;text-transform:uppercase;letter-spacing:.06em;">â• Yeni IP YasaÄŸÄ±</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px;">
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">IP Adresi *</label>
            <input id="ipban-ip" placeholder="192.168.1.1 veya ::1" maxlength="45"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
                     border-radius:7px;padding:9px 12px;font-size:13px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Sebep</label>
            <input id="ipban-reason" placeholder="Spam, brute forceâ€¦" maxlength="200"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
                     border-radius:7px;padding:9px 12px;font-size:13px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">SÃ¼re</label>
            <select id="ipban-duration"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
                     border-radius:7px;padding:9px 12px;font-size:13px;">
              <option value="">KalÄ±cÄ±</option>
              <option value="3600000">1 Saat</option>
              <option value="86400000">1 GÃ¼n</option>
              <option value="604800000">1 Hafta</option>
              <option value="2592000000">30 GÃ¼n</option>
            </select>
          </div>
        </div>
        <button onclick="adminAddIpBan()"
          style="background:#5865f2;color:#fff;border:none;border-radius:8px;
                 padding:9px 22px;cursor:pointer;font-size:13px;font-weight:600;">
          ğŸš« Yasak Ekle
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
                <th style="padding:10px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;">BitiÅŸ</th>
                <th style="padding:10px 14px;color:#555;font-weight:600;border-bottom:1px solid #1e1e38;text-align:right;">Ä°ÅŸlem</th>
              </tr>
            </thead>
            <tbody>
              ${bans.map(b => {
                const expired = b.expiresAt && b.expiresAt <= Date.now();
                const expLabel = !b.expiresAt
                  ? '<span style="color:#faa61a;">KalÄ±cÄ±</span>'
                  : expired
                    ? '<span style="color:#e55;">SÃ¼resi Doldu</span>'
                    : `<span style="color:#888;">${_fmtTime(b.expiresAt)}</span>`;
                return `
                  <tr style="border-bottom:1px solid #1a1a2e;">
                    <td style="padding:10px 14px;font-family:monospace;color:#eb459e;font-weight:600;">${escHtml(b.ip)}</td>
                    <td style="padding:10px 14px;color:#888;">${escHtml(b.reason || 'â€”')}</td>
                    <td style="padding:10px 14px;color:#555;white-space:nowrap;">${_fmtTime(b.bannedAt)}</td>
                    <td style="padding:10px 14px;white-space:nowrap;">${expLabel}</td>
                    <td style="text-align:right;padding:10px 14px;">
                      <button onclick="adminRemoveIpBan('${escHtml(b.ip)}')"
                        style="background:#0f2018;color:#57f287;border:1px solid #1a3a28;
                               border-radius:6px;padding:4px 12px;cursor:pointer;font-size:11px;font-weight:600;">
                        âœ… KaldÄ±r
                      </button>
                    </td>
                  </tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>` : _emptyState('Aktif IP yasaÄŸÄ± yok')}`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml(e.message)}</div>`;
  }
}

async function adminAddIpBan() {
  const ip         = document.getElementById('ipban-ip')?.value.trim();
  const reason     = document.getElementById('ipban-reason')?.value.trim() || 'Admin ban';
  const durationMs = document.getElementById('ipban-duration')?.value || null;
  if (!ip) return toast('IP adresi zorunlu', 'error');
  const r = await apiFetch(`${API}/api/admin/ip-bans`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ip, reason, durationMs: durationMs ? parseInt(durationMs) : null }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Yasak eklenemedi', 'error');
  toast(`${ip} yasaklandÄ± ğŸš«`, 'success');
  loadAdminIpBans(document.getElementById('admin-content'));
}

async function adminRemoveIpBan(ip) {
  if (!confirm(`${ip} adresinin yasaÄŸÄ± kaldÄ±rÄ±lsÄ±n mÄ±?`)) return;
  const r = await apiFetch(`${API}/api/admin/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
  if (r.ok) {
    toast(`${ip} yasaÄŸÄ± kaldÄ±rÄ±ldÄ± âœ…`, 'success');
    loadAdminIpBans(document.getElementById('admin-content'));
  } else toast('KaldÄ±rÄ±lamadÄ±', 'error');
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ğŸ“‹ Admin LoglarÄ±
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
const _LOG_COLORS = {
  delete_user: '#e55', delete_server: '#e55',
  ip_ban: '#eb459e', ip_unban: '#57f287',
  update_user: '#faa61a', broadcast: '#8892f8',
};

async function loadAdminLogs(el) {
  try {
    const r = await apiFetch(`${API}/api/admin/logs`);
    if (!r.ok) return el.innerHTML = `<div style="color:#e55;padding:20px;">EriÅŸim reddedildi</div>`;
    const logs = await r.json();

    el.innerHTML = `
      ${_sectionTitle(`ğŸ“‹ Admin LoglarÄ± (son ${logs.length})`)}
      ${logs.length ? logs.map(l => {
        const color  = _LOG_COLORS[l.action] || '#8892f8';
        const detail = l.detail ? (() => { try { return JSON.parse(l.detail); } catch { return null; } })() : null;
        return `
          <div style="background:#161627;border-radius:9px;padding:12px 16px;margin-bottom:8px;
                      border:1px solid #1e1e38;border-left:3px solid ${color};">
            <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;">
              <div>
                <span style="color:#8892f8;font-weight:700;font-size:13px;">${escHtml(l.adminUsername || l.adminId)}</span>
                <span style="color:#444;margin:0 8px;">â†’</span>
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
      }).join('') : _emptyState('HenÃ¼z log yok')}`;
  } catch (e) {
    el.innerHTML = `<div style="color:#e55;padding:20px;">Hata: ${escHtml(e.message)}</div>`;
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   ğŸ“¢ Broadcast Duyuru
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
function loadAdminBroadcast(el) {
  el.innerHTML = `
    ${_sectionTitle('ğŸ“¢ TÃ¼m KullanÄ±cÄ±lara Duyuru')}
    ${_adminCard(`
      <p style="color:#888;font-size:13px;margin:0 0 16px;line-height:1.6;">
        Bu mesaj ÅŸu an baÄŸlÄ± olan tÃ¼m kullanÄ±cÄ±lara Socket.io Ã¼zerinden anlÄ±k iletilir.
        Ã‡evrimdÄ±ÅŸÄ± kullanÄ±cÄ±lar gÃ¶remez.
      </p>
      <label style="font-size:12px;color:#666;display:block;margin-bottom:8px;">Duyuru MesajÄ±</label>
      <textarea id="broadcast-msg" rows="5"
        style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;
               border-radius:8px;padding:12px;font-size:13px;resize:vertical;
               box-sizing:border-box;line-height:1.6;margin-bottom:14px;"
        placeholder="TÃ¼m kullanÄ±cÄ±lara gÃ¶nderilecek mesajÄ± yazÄ±nâ€¦"></textarea>
      <button onclick="sendBroadcast()"
        style="background:#5865f2;color:#fff;border:none;border-radius:8px;
               padding:10px 24px;cursor:pointer;font-size:14px;font-weight:600;">
        ğŸ“¢ GÃ¶nder
      </button>
    `)}`;
}

async function sendBroadcast() {
  const message = document.getElementById('broadcast-msg')?.value.trim();
  if (!message) return toast('Mesaj boÅŸ olamaz', 'error');
  if (!confirm(`Bu mesaj tÃ¼m aktif kullanÄ±cÄ±lara gÃ¶nderilsin mi?\n\n"${message}"`)) return;
  const r = await apiFetch(`${API}/api/admin/broadcast`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message }),
  });
  if (r.ok) {
    toast('Duyuru gÃ¶nderildi! ğŸ“¢', 'success');
    { const _t = document.getElementById('broadcast-msg') as HTMLInputElement | null; if (_t) _t.value = ''; }
  } else toast('GÃ¶nderilemedi', 'error');
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   âš¡ Reaction Roller
   â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
async function loadAdminReactionRoles(el) {
  if (!currentServer) {
    el.innerHTML = `
      ${_sectionTitle('âš¡ Reaction Roller')}
      <div style="color:#888;padding:24px;background:#161627;border-radius:10px;border:1px solid #1e1e38;text-align:center;">
        Ã–nce sol panelden bir sunucu seÃ§melisin.
      </div>`;
    return;
  }
  const sid = currentServer._id;
  let roles = [], channels = [], rules = [];
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
    el.innerHTML = `<div style="color:#e55;padding:20px;">Veri yÃ¼klenemedi.</div>`;
    return;
  }

  const roleMap    = Object.fromEntries(roles.map(r => [r._id, r]));
  const channelMap = Object.fromEntries(channels.map(c => [c._id, c]));

  el.innerHTML = `
    ${_sectionTitle('âš¡ Reaction Roller')}
    <div style="max-width:720px;">
      ${_adminCard(`
        <div style="font-size:13px;font-weight:700;color:#aaa;margin-bottom:16px;text-transform:uppercase;letter-spacing:.06em;">â• Yeni Kural</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;">
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Kanal</label>
            <select id="rr-channel" style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:13px;">
              <option value="">â€” Kanal seÃ§ â€”</option>
              ${channels.filter(c => c.type === 'text').map(c =>
                `<option value="${escHtml(c._id)}">#${escHtml(c.name)}</option>`).join('')}
            </select>
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Mesaj ID</label>
            <input id="rr-msgid" placeholder="SaÄŸ tÄ±k â†’ ID kopyala"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:13px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Emoji</label>
            <input id="rr-emoji" placeholder="ğŸ‘" maxlength="64"
              style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:20px;box-sizing:border-box;" />
          </div>
          <div>
            <label style="font-size:11px;color:#666;display:block;margin-bottom:5px;">Verilecek Rol</label>
            <select id="rr-role" style="width:100%;background:#0f0f1a;color:#ccc;border:1px solid #2a2a45;border-radius:7px;padding:9px 12px;font-size:13px;">
              <option value="">â€” Rol seÃ§ â€”</option>
              ${roles.map(r => `<option value="${escHtml(r._id)}" style="color:${r.color||'#ccc'}">${escHtml(r.name)}</option>`).join('')}
            </select>
          </div>
        </div>
        <button onclick="addReactionRole('${escHtml(sid)}')"
          style="background:#5865f2;color:#fff;border:none;border-radius:8px;padding:10px 22px;cursor:pointer;font-size:13px;font-weight:600;">
          âœš Kural Ekle
        </button>
      `, 'margin-bottom:24px;')}

      <div style="color:#666;font-size:13px;font-weight:700;text-transform:uppercase;letter-spacing:.06em;margin-bottom:12px;">
        ğŸ“‹ Aktif Kurallar (${rules.length})
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
                <span style="color:#333;margin:0 6px;">â€º</span>
                <span style="color:#555;font-family:monospace;font-size:11px;">${escHtml((rule.messageId||'').slice(0,12))}â€¦</span>
              </div>
              <div style="font-size:12px;color:#666;margin-top:3px;">
                Tepki â†’
                <span style="color:${role?.color||'#8892f8'};font-weight:600;">${escHtml(role?.name || rule.roleId)}</span>
                rolÃ¼ ver/al
              </div>
            </div>
            <button onclick="deleteReactionRule('${escHtml(sid)}','${escHtml(rule._id)}')"
              style="background:#1e1a1a;color:#e55;border:1px solid #3a2020;
                     border-radius:7px;padding:6px 14px;cursor:pointer;font-size:12px;font-weight:600;">
              ğŸ—‘ï¸ Sil
            </button>
          </div>`;
      }).join('') : `
        <div style="color:#444;padding:28px;text-align:center;background:#161627;border-radius:9px;border:1px solid #1e1e38;">
          HenÃ¼z reaction-role kuralÄ± yok
        </div>`}
    </div>`;
}

async function addReactionRole(sid) {
  const channelId = document.getElementById('rr-channel')?.value?.trim();
  const messageId = document.getElementById('rr-msgid')?.value?.trim();
  const emoji     = document.getElementById('rr-emoji')?.value?.trim();
  const roleId    = document.getElementById('rr-role')?.value?.trim();
  if (!channelId || !messageId || !emoji || !roleId) return toast('TÃ¼m alanlarÄ± doldur', 'error');
  const r = await apiFetch(`${API}/api/servers/${sid}/reaction-roles`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ channelId, messageId, emoji, roleId }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Eklenemedi', 'error');
  toast('Kural eklendi! âš¡', 'success');
  await loadAdminReactionRoles(document.getElementById('admin-content'));
}

async function deleteReactionRule(sid, rrId) {
  const r = await apiFetch(`${API}/api/servers/${sid}/reaction-roles/${rrId}`, { method: 'DELETE' });
  if (!r.ok) return toast('Silinemedi', 'error');
  toast('Kural silindi', 'info');
  await loadAdminReactionRoles(document.getElementById('admin-content'));
}

