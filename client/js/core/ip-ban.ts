// client/js/core/ip-ban.js
// Admin paneli IP Ban sekmesi UI'Ä±
// admin.js'e baÄŸÄ±mlÄ±: apiFetch, escHtml, API sabitleri

'use strict';
export {};

// â”€â”€ Admin sekmesine "ip-bans" ekleme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// admin.js openAdminDashboard() iÃ§indeki sekme listesine
// 'ip-bans' eklemek iÃ§in bu fonksiyonu Ã§aÄŸÄ±r.
// Veya doÄŸrudan admin.js'teki tab listesine elle ekle (aÅŸaÄŸÄ±da aÃ§Ä±klamasÄ± var).

(function patchAdminTabs() {
  const _origOpen = window.openAdminDashboard;
  window.openAdminDashboard = async function () {
    await _origOpen?.();

    // Sidebar'a IP Ban sekmesi ekle (zaten varsa atlat)
    if (document.getElementById('atab-ip-bans')) return;
    const sidebar = document.querySelector('#admin-overlay [id^="atab-"]')?.parentElement;
    if (!sidebar) return;

    const closeBtn = sidebar.querySelector('button:last-child');
    const btn = document.createElement('button');
    btn.id = 'atab-ip-bans';
    btn.textContent = 'ğŸš« IP BanlarÄ±';
    btn.onclick = () => adminTab('ip-bans');
    btn.style.cssText = 'background:none;border:none;color:var(--text-muted,#999);padding:10px 16px;text-align:left;cursor:pointer;font-size:14px;width:100%;transition:background .15s;';
    sidebar.insertBefore(btn, closeBtn);
  };

  // adminTab switch'ine ip-bans ekle
  const _origTab = window.adminTab;
  window.adminTab = async function (tab) {
    await _origTab?.(tab);
    if (tab === 'ip-bans') {
      const content = document.getElementById('admin-content');
      if (content) await loadAdminIpBans(content);
    }
  };
})();

// â”€â”€ Ana yÃ¼kleme fonksiyonu â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadAdminIpBans(el) {
  el.innerHTML = _ipBanShell();
  await _refreshBanList();
}

function _ipBanShell() {
  return `
    <h2 style="color:#fff;margin:0 0 6px;">ğŸš« IP Ban YÃ¶netimi</h2>
    <p style="color:#888;font-size:13px;margin:0 0 20px;">
      Engellenen IP'ler tÃ¼m API isteklerini reddeder. KalÄ±cÄ± veya sÃ¼reli olarak ayarlanabilir.
    </p>

    <!-- Yeni ban formu -->
    <div style="background:#1e1e30;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="color:#aaa;font-size:13px;font-weight:700;margin-bottom:14px;">â• Yeni IP Engelle</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:140px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">IP Adresi *</label>
          <input id="ipban-ip" type="text" placeholder="1.2.3.4 veya 2001:db8::1"
            style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;border-radius:6px;
                   color:#fff;padding:8px 10px;font-size:13px;outline:none;" />
        </div>
        <div style="flex:2;min-width:180px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">Sebep</label>
          <input id="ipban-reason" type="text" placeholder="Spam, abuse, brute-forceâ€¦"
            style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;border-radius:6px;
                   color:#fff;padding:8px 10px;font-size:13px;outline:none;" />
        </div>
        <div style="min-width:160px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">SÃ¼re</label>
          <select id="ipban-duration"
            style="width:100%;background:#111;border:1px solid #444;border-radius:6px;
                   color:#fff;padding:8px 10px;font-size:13px;outline:none;">
            <option value="0">KalÄ±cÄ±</option>
            <option value="3600000">1 Saat</option>
            <option value="86400000">1 GÃ¼n</option>
            <option value="604800000">1 Hafta</option>
            <option value="2592000000">30 GÃ¼n</option>
          </select>
        </div>
        <button onclick="ipBanAdd()"
          style="padding:8px 18px;background:#5865f2;border:none;border-radius:6px;
                 color:#fff;font-size:13px;cursor:pointer;white-space:nowrap;font-weight:600;">
          ğŸš« Engelle
        </button>
      </div>
      <div id="ipban-error" style="color:#ed4245;font-size:12px;margin-top:8px;display:none;"></div>
    </div>

    <!-- Aktif ban listesi -->
    <div style="background:#1e1e30;border-radius:10px;padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="color:#aaa;font-size:13px;font-weight:700;">ğŸ”’ Aktif Engeller</div>
        <button onclick="_refreshBanList()"
          style="background:#333;border:none;color:#aaa;border-radius:5px;
                 padding:4px 10px;font-size:12px;cursor:pointer;">
          â†» Yenile
        </button>
      </div>
      <div id="ipban-list">
        <div style="color:#555;font-size:13px;">YÃ¼kleniyorâ€¦</div>
      </div>
    </div>
  `;
}

async function _refreshBanList() {
  const listEl = document.getElementById('ipban-list');
  if (!listEl) return;

  try {
    const r    = await apiFetch(`${API}/api/admin/ip-bans`);
    const bans = await r.json();

    if (!r.ok) {
      listEl.innerHTML = `<div style="color:#ed4245;">Hata: ${escHtml(bans.error || 'Bilinmeyen hata')}</div>`;
      return;
    }

    if (!bans.length) {
      listEl.innerHTML = '<div style="color:#555;font-size:13px;">Aktif IP engeli yok.</div>';
      return;
    }

    listEl.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:13px;">
        <thead>
          <tr style="color:#888;border-bottom:1px solid #2a2a40;">
            <th style="text-align:left;padding:6px 8px;">IP Adresi</th>
            <th style="text-align:left;padding:6px 8px;">Sebep</th>
            <th style="text-align:left;padding:6px 8px;">Eklenme</th>
            <th style="text-align:left;padding:6px 8px;">BitiÅŸ</th>
            <th style="padding:6px 8px;"></th>
          </tr>
        </thead>
        <tbody>
          ${bans.map(b => _banRow(b)).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    listEl.innerHTML = `<div style="color:#ed4245;">BaÄŸlantÄ± hatasÄ±: ${escHtml(e.message)}</div>`;
  }
}

function _banRow(b) {
  const bannedDate = new Date(b.bannedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
  const expiresStr = b.expiresAt
    ? new Date(b.expiresAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '<span style="color:#ed4245;">KalÄ±cÄ±</span>';

  return `
    <tr style="border-bottom:1px solid #1a1a2e;">
      <td style="padding:8px 8px;font-family:monospace;color:#fff;">${escHtml(b.ip)}</td>
      <td style="padding:8px 8px;color:#ccc;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;"
          title="${escHtml(b.reason)}">${escHtml(b.reason)}</td>
      <td style="padding:8px 8px;color:#888;">${bannedDate}</td>
      <td style="padding:8px 8px;color:#888;">${expiresStr}</td>
      <td style="padding:8px 8px;text-align:right;">
        <button onclick="ipBanRemove('${escHtml(b.ip)}')"
          style="background:#ed424520;border:1px solid #ed424560;color:#ed4245;
                 border-radius:5px;padding:3px 10px;font-size:12px;cursor:pointer;">
          KaldÄ±r
        </button>
      </td>
    </tr>
  `;
}

// â”€â”€ Eylemler â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

window.ipBanAdd = async function () {
  const ip       = document.getElementById('ipban-ip')?.value?.trim();
  const reason   = document.getElementById('ipban-reason')?.value?.trim() || 'Admin ban';
  const duration = parseInt(document.getElementById('ipban-duration')?.value || '0');
  const errEl    = document.getElementById('ipban-error');

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  if (!ip) {
    if (errEl) { errEl.textContent = 'IP adresi boÅŸ olamaz.'; errEl.style.display = 'block'; }
    return;
  }

  try {
    const r    = await apiFetch(`${API}/api/admin/ip-bans`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip, reason, durationMs: duration || null }),
    });
    const data = await r.json();

    if (!r.ok) {
      if (errEl) { errEl.textContent = data.error || 'Hata oluÅŸtu.'; errEl.style.display = 'block'; }
      return;
    }

    // Formu temizle
    { const _t = document.getElementById('ipban-ip') as HTMLInputElement | null; if (_t) _t.value = ''; }
    { const _t = document.getElementById('ipban-reason') as HTMLInputElement | null; if (_t) _t.value = ''; }
    { const _t = document.getElementById('ipban-duration') as HTMLInputElement | null; if (_t) _t.value = '0'; }

    await _refreshBanList();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  }
};

window.ipBanRemove = async function (ip) {
  if (!confirm(`"${ip}" engelini kaldÄ±rmak istediÄŸinizden emin misiniz?`)) return;

  try {
    const r    = await apiFetch(`${API}/api/admin/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) { alert(data.error || 'KaldÄ±rma baÅŸarÄ±sÄ±z.'); return; }
    await _refreshBanList();
  } catch (e) {
    alert('BaÄŸlantÄ± hatasÄ±: ' + e.message);
  }
};

window.loadAdminIpBans = loadAdminIpBans;

console.log('[Bridge] IP Ban modÃ¼lÃ¼ yÃ¼klendi.');

