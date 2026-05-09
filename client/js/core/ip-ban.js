// client/js/core/ip-ban.js
// Admin paneli IP Ban sekmesi UI'ı
// admin.js'e bağımlı: apiFetch, escHtml, API sabitleri

'use strict';

// ── Admin sekmesine "ip-bans" ekleme ───────────────────────────
// admin.js openAdminDashboard() içindeki sekme listesine
// 'ip-bans' eklemek için bu fonksiyonu çağır.
// Veya doğrudan admin.js'teki tab listesine elle ekle (aşağıda açıklaması var).

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
    btn.textContent = '🚫 IP Banları';
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

// ── Ana yükleme fonksiyonu ──────────────────────────────────────
async function loadAdminIpBans(el) {
  el.innerHTML = _ipBanShell();
  await _refreshBanList();
}

function _ipBanShell() {
  return `
    <h2 style="color:#fff;margin:0 0 6px;">🚫 IP Ban Yönetimi</h2>
    <p style="color:#888;font-size:13px;margin:0 0 20px;">
      Engellenen IP'ler tüm API isteklerini reddeder. Kalıcı veya süreli olarak ayarlanabilir.
    </p>

    <!-- Yeni ban formu -->
    <div style="background:#1e1e30;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="color:#aaa;font-size:13px;font-weight:700;margin-bottom:14px;">➕ Yeni IP Engelle</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:140px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">IP Adresi *</label>
          <input id="ipban-ip" type="text" placeholder="1.2.3.4 veya 2001:db8::1"
            style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;border-radius:6px;
                   color:#fff;padding:8px 10px;font-size:13px;outline:none;" />
        </div>
        <div style="flex:2;min-width:180px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">Sebep</label>
          <input id="ipban-reason" type="text" placeholder="Spam, abuse, brute-force…"
            style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;border-radius:6px;
                   color:#fff;padding:8px 10px;font-size:13px;outline:none;" />
        </div>
        <div style="min-width:160px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">Süre</label>
          <select id="ipban-duration"
            style="width:100%;background:#111;border:1px solid #444;border-radius:6px;
                   color:#fff;padding:8px 10px;font-size:13px;outline:none;">
            <option value="0">Kalıcı</option>
            <option value="3600000">1 Saat</option>
            <option value="86400000">1 Gün</option>
            <option value="604800000">1 Hafta</option>
            <option value="2592000000">30 Gün</option>
          </select>
        </div>
        <button onclick="ipBanAdd()"
          style="padding:8px 18px;background:#5865f2;border:none;border-radius:6px;
                 color:#fff;font-size:13px;cursor:pointer;white-space:nowrap;font-weight:600;">
          🚫 Engelle
        </button>
      </div>
      <div id="ipban-error" style="color:#ed4245;font-size:12px;margin-top:8px;display:none;"></div>
    </div>

    <!-- Aktif ban listesi -->
    <div style="background:#1e1e30;border-radius:10px;padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="color:#aaa;font-size:13px;font-weight:700;">🔒 Aktif Engeller</div>
        <button onclick="_refreshBanList()"
          style="background:#333;border:none;color:#aaa;border-radius:5px;
                 padding:4px 10px;font-size:12px;cursor:pointer;">
          ↻ Yenile
        </button>
      </div>
      <div id="ipban-list">
        <div style="color:#555;font-size:13px;">Yükleniyor…</div>
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
            <th style="text-align:left;padding:6px 8px;">Bitiş</th>
            <th style="padding:6px 8px;"></th>
          </tr>
        </thead>
        <tbody>
          ${bans.map(b => _banRow(b)).join('')}
        </tbody>
      </table>
    `;
  } catch (e) {
    listEl.innerHTML = `<div style="color:#ed4245;">Bağlantı hatası: ${escHtml(e.message)}</div>`;
  }
}

function _banRow(b) {
  const bannedDate = new Date(b.bannedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
  const expiresStr = b.expiresAt
    ? new Date(b.expiresAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '<span style="color:#ed4245;">Kalıcı</span>';

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
          Kaldır
        </button>
      </td>
    </tr>
  `;
}

// ── Eylemler ────────────────────────────────────────────────────

window.ipBanAdd = async function () {
  const ip       = document.getElementById('ipban-ip')?.value?.trim();
  const reason   = document.getElementById('ipban-reason')?.value?.trim() || 'Admin ban';
  const duration = parseInt(document.getElementById('ipban-duration')?.value || '0');
  const errEl    = document.getElementById('ipban-error');

  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }

  if (!ip) {
    if (errEl) { errEl.textContent = 'IP adresi boş olamaz.'; errEl.style.display = 'block'; }
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
      if (errEl) { errEl.textContent = data.error || 'Hata oluştu.'; errEl.style.display = 'block'; }
      return;
    }

    // Formu temizle
    document.getElementById('ipban-ip').value     = '';
    document.getElementById('ipban-reason').value = '';
    document.getElementById('ipban-duration').value = '0';

    await _refreshBanList();
  } catch (e) {
    if (errEl) { errEl.textContent = e.message; errEl.style.display = 'block'; }
  }
};

window.ipBanRemove = async function (ip) {
  if (!confirm(`"${ip}" engelini kaldırmak istediğinizden emin misiniz?`)) return;

  try {
    const r    = await apiFetch(`${API}/api/admin/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) { alert(data.error || 'Kaldırma başarısız.'); return; }
    await _refreshBanList();
  } catch (e) {
    alert('Bağlantı hatası: ' + e.message);
  }
};

console.log('[Bridge] IP Ban modülü yüklendi.');

export {
  loadAdminIpBans,
};

