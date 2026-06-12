// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/IpBanPanel.svelte
//              client/js/core/ip-ban-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/ip-ban.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Admin paneli IP Ban sekmesi UI

import { BridgeRegistry } from './bridge-registry.js';

// ── Tip tanımları ─────────────────────────────────────────────

interface IpBan {
  ip: string;
  reason: string;
  bannedAt: string;
  expiresAt?: string | null;
}

interface ApiFetchFn {
  (url: string, opts?: RequestInit): Promise<Response>;
}

// ── Admin sekme hook ──────────────────────────────────────────

const _origOpen = BridgeRegistry.get('openAdminDashboard') as (() => Promise<void>) | undefined;
BridgeRegistry.register('openAdminDashboard', async function () {
  await _origOpen?.();
  if (document.getElementById('atab-ip-bans')) return;
  const sidebar = document.querySelector<HTMLElement>('#admin-overlay [id^="atab-"]')?.parentElement;
  if (!sidebar) return;
  const closeBtn = sidebar.querySelector('button:last-child');
  const btn = document.createElement('button');
  btn.id = 'atab-ip-bans';
  btn.textContent = '🚫 IP Banları';
  btn.onclick = () => BridgeRegistry.call('adminTab', 'ip-bans');
  btn.style.cssText = 'background:none;border:none;color:var(--text-muted,#999);padding:10px 16px;text-align:left;cursor:pointer;font-size:14px;width:100%;transition:background .15s;';
  sidebar.insertBefore(btn, closeBtn ?? null);
});

const _origTab = BridgeRegistry.get('adminTab') as ((tab: string) => Promise<void>) | undefined;
BridgeRegistry.register('adminTab', async function (tab: string) {
  await _origTab?.(tab);
  if (tab === 'ip-bans') {
    const content = document.getElementById('admin-content');
    if (content) await loadAdminIpBans(content);
  }
});

// ── Ana yükleme fonksiyonu ────────────────────────────────────

export async function loadAdminIpBans(el: HTMLElement): Promise<void> {
  el.innerHTML = _ipBanShell();
  await _refreshBanList();
}

function _ipBanShell(): string {
  return `
    <h2 style="color:#fff;margin:0 0 6px;">🚫 IP Ban Yönetimi</h2>
    <p style="color:#888;font-size:13px;margin:0 0 20px;">
      Engellenen IP'ler tüm API isteklerini reddeder. Kalıcı veya süreli olarak ayarlanabilir.
    </p>
    <div style="background:#1e1e30;border-radius:10px;padding:20px;margin-bottom:20px;">
      <div style="color:#aaa;font-size:13px;font-weight:700;margin-bottom:14px;">➕ Yeni IP Engelle</div>
      <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:flex-end;">
        <div style="flex:1;min-width:140px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">IP Adresi *</label>
          <input id="ipban-ip" type="text" placeholder="1.2.3.4 veya 2001:db8::1"
            style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;border-radius:6px;color:#fff;padding:8px 10px;font-size:13px;outline:none;" />
        </div>
        <div style="flex:2;min-width:180px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">Sebep</label>
          <input id="ipban-reason" type="text" placeholder="Spam, abuse, brute-force…"
            style="width:100%;box-sizing:border-box;background:#111;border:1px solid #444;border-radius:6px;color:#fff;padding:8px 10px;font-size:13px;outline:none;" />
        </div>
        <div style="min-width:160px;">
          <label style="font-size:11px;color:#888;display:block;margin-bottom:4px;">Süre</label>
          <select id="ipban-duration"
            style="width:100%;background:#111;border:1px solid #444;border-radius:6px;color:#fff;padding:8px 10px;font-size:13px;outline:none;">
            <option value="0">Kalıcı</option>
            <option value="3600000">1 Saat</option>
            <option value="86400000">1 Gün</option>
            <option value="604800000">1 Hafta</option>
            <option value="2592000000">30 Gün</option>
          </select>
        </div>
        <button onclick="BridgeRegistry.call('ipBanAdd')"
          style="padding:8px 18px;background:#2d9cdb;border:none;border-radius:6px;color:#fff;font-size:13px;cursor:pointer;white-space:nowrap;font-weight:600;">
          🚫 Engelle
        </button>
      </div>
      <div id="ipban-error" style="color:#ed4245;font-size:12px;margin-top:8px;display:none;"></div>
    </div>
    <div style="background:#1e1e30;border-radius:10px;padding:20px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">
        <div style="color:#aaa;font-size:13px;font-weight:700;">🔒 Aktif Engeller</div>
        <button onclick="BridgeRegistry.call('_ipBanRefresh')"
          style="background:#333;border:none;color:#aaa;border-radius:5px;padding:4px 10px;font-size:12px;cursor:pointer;">
          ↻ Yenile
        </button>
      </div>
      <div id="ipban-list"><div style="color:#555;font-size:13px;">Yükleniyor…</div></div>
    </div>`;
}

// ── Ban listesi ───────────────────────────────────────────────

async function _refreshBanList(): Promise<void> {
  const listEl = document.getElementById('ipban-list');
  if (!listEl) return;

  const apiFetch = BridgeRegistry.get('apiFetch') as ApiFetchFn;
  const escHtml  = BridgeRegistry.get('escHtml') as (s: string) => string || ((s: string) => s);
  const API      = (BridgeRegistry.get('API') as string) ?? '';

  try {
    const r    = await apiFetch(`${API}/api/admin/ip-bans`);
    const bans = await r.json() as IpBan[] | { error?: string };

    if (!r.ok) {
      const err = (bans as { error?: string }).error ?? 'Bilinmeyen hata';
      listEl.innerHTML = `<div style="color:#ed4245;">Hata: ${escHtml(err)}</div>`;
      return;
    }

    const banList = bans as IpBan[];
    if (!banList.length) {
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
        <tbody>${banList.map(b => _banRow(b, escHtml)).join('')}</tbody>
      </table>`;
  } catch (e) {
    listEl.innerHTML = `<div style="color:#ed4245;">Bağlantı hatası: ${escHtml((e as Error).message)}</div>`;
  }
}

function _banRow(b: IpBan, escHtml: (s: string) => string): string {
  const bannedDate = new Date(b.bannedAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' });
  const expiresStr = b.expiresAt
    ? new Date(b.expiresAt).toLocaleString('tr-TR', { dateStyle: 'short', timeStyle: 'short' })
    : '<span style="color:#ed4245;">Kalıcı</span>';

  return `
    <tr style="border-bottom:1px solid #1a1a2e;">
      <td style="padding:8px;font-family:monospace;color:#fff;">${escHtml(b.ip)}</td>
      <td style="padding:8px;color:#ccc;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${escHtml(b.reason)}">${escHtml(b.reason)}</td>
      <td style="padding:8px;color:#888;">${bannedDate}</td>
      <td style="padding:8px;color:#888;">${expiresStr}</td>
      <td style="padding:8px;text-align:right;">
        <button onclick="BridgeRegistry.call('ipBanRemove', '${escHtml(b.ip)}')"
          style="background:#ed424520;border:1px solid #ed424560;color:#ed4245;border-radius:5px;padding:3px 10px;font-size:12px;cursor:pointer;">
          Kaldır
        </button>
      </td>
    </tr>`;
}

// ── BridgeRegistry eylemleri ──────────────────────────────────

BridgeRegistry.register('_ipBanRefresh', _refreshBanList);

BridgeRegistry.register('ipBanAdd', async function () {
  const ip       = (document.getElementById('ipban-ip') as HTMLInputElement | null)?.value?.trim();
  const reason   = (document.getElementById('ipban-reason') as HTMLInputElement | null)?.value?.trim() ?? 'Admin ban';
  const duration = parseInt((document.getElementById('ipban-duration') as HTMLSelectElement | null)?.value ?? '0');
  const errEl    = document.getElementById('ipban-error');
  const apiFetch = BridgeRegistry.get('apiFetch') as ApiFetchFn;
  const API      = (BridgeRegistry.get('API') as string) ?? '';

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
    const data = await r.json() as { error?: string };
    if (!r.ok) {
      if (errEl) { errEl.textContent = data.error ?? 'Hata oluştu.'; errEl.style.display = 'block'; }
      return;
    }
    (document.getElementById('ipban-ip') as HTMLInputElement | null)?.((el: HTMLInputElement) => { el.value = ''; });
    ['ipban-ip','ipban-reason'].forEach(id => {
      const el = document.getElementById(id) as HTMLInputElement | null;
      if (el) el.value = '';
    });
    const durEl = document.getElementById('ipban-duration') as HTMLSelectElement | null;
    if (durEl) durEl.value = '0';
    await _refreshBanList();
  } catch (e) {
    if (errEl) { errEl.textContent = (e as Error).message; errEl.style.display = 'block'; }
  }
});

BridgeRegistry.register('ipBanRemove', async function (ip: string) {
  const apiFetch = BridgeRegistry.get('apiFetch') as ApiFetchFn;
  const API      = (BridgeRegistry.get('API') as string) ?? '';
  if (!confirm(`"${ip}" engelini kaldırmak istediğinizden emin misiniz?`)) return;
  try {
    const r    = await apiFetch(`${API}/api/admin/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
    const data = await r.json() as { error?: string };
    if (!r.ok) { alert(data.error ?? 'Kaldırma başarısız.'); return; }
    await _refreshBanList();
  } catch (e) {
    alert('Bağlantı hatası: ' + (e as Error).message);
  }
});
