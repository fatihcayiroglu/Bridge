// client/js/admin/shell.ts
// Admin paneli kabuğu: overlay, sekme navigasyonu, buton enjeksiyonu.

import {
  loadAdminStats,
} from './stats';
import { loadAdminUsers } from './users';
import { loadAdminServers } from './servers';
import { loadAdminIpBans } from './ip-bans';
import { loadAdminLogs, loadAdminBroadcast } from './logs';
import { loadAdminReactionRoles } from './reaction-roles';
import { loadAdminMarketplace } from './marketplace';

let _adminTab = 'stats';

export function adminInjectButton(user: { isAdmin?: boolean; displayName?: string } | null) {
  if (!user?.isAdmin) return;
  if (document.getElementById('btn-admin')) return;
  const ref = document.querySelector('.u-action-btn[data-bridge-action="openSettingsModal"]') as HTMLElement | null;
  if (!ref) return;
  const btn = document.createElement('div');
  btn.id = 'btn-admin';
  btn.className = 'u-action-btn tooltip';
  btn.setAttribute('data-tip', 'Admin Paneli');
  btn.setAttribute('role', 'button');
  btn.setAttribute('tabindex', '0');
  btn.setAttribute('aria-label', 'Admin Panelini Aç');
  btn.style.cssText = 'color:#f0a500;font-size:16px;';
  btn.textContent = '🛡️';
  btn.onclick = openAdminDashboard;
  btn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') openAdminDashboard(); };
  ref.parentNode!.insertBefore(btn, ref);
}

export async function openAdminDashboard() {
  const existing = document.getElementById('admin-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'admin-overlay';
  overlay.style.cssText = `
    position:fixed;inset:0;background:rgba(0,0,0,.82);z-index:9999;
    display:flex;align-items:stretch;font-family:inherit;`;

  const tabs = [
    { id: 'stats',          icon: '📊', label: 'İstatistik'   },
    { id: 'users',          icon: '👥', label: 'Kullanıcılar' },
    { id: 'servers',        icon: '🖥️', label: 'Sunucular'    },
    { id: 'ip-bans',        icon: '🚫', label: 'IP Yasakları' },
    { id: 'logs',           icon: '📋', label: 'Loglar'       },
    { id: 'broadcast',      icon: '📢', label: 'Duyuru'       },
    { id: 'reaction-roles', icon: '⚡', label: 'Reaction Rol' },
    { id: 'marketplace',    icon: '🛒', label: 'Marketplace'  },
  ];

  overlay.innerHTML = `
    <div style="display:flex;width:100%;height:100%;overflow:hidden;">
      <div style="width:210px;min-width:210px;background:#12121f;display:flex;flex-direction:column;border-right:1px solid #1e1e35;">
        <div style="padding:20px 16px 12px;display:flex;align-items:center;gap:10px;border-bottom:1px solid #1e1e35;">
          <span style="font-size:22px;">🛡️</span>
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
            ✕ Kapat
          </button>
        </div>
      </div>
      <div style="flex:1;overflow-y:auto;background:#0f0f1a;padding:28px 32px;" id="admin-content">
        <div style="color:#444;">Yükleniyor…</div>
      </div>
    </div>`;

  document.body.appendChild(overlay);
  const escHandler = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', escHandler); }
  };
  document.addEventListener('keydown', escHandler);
  adminTab('stats');
}

export async function adminTab(tab: string) {
  _adminTab = tab;
  document.querySelectorAll<HTMLElement>('[id^="atab-"]').forEach(b => {
    const active = b.id === `atab-${tab}`;
    b.style.background = active ? 'rgba(45,156,219,.18)' : 'none';
    b.style.color      = active ? '#8892f8' : '#6e6e9a';
    b.style.fontWeight = active ? '600' : '400';
  });
  const el = document.getElementById('admin-content') as HTMLElement;
  el.innerHTML = `<div style="color:#444;padding:40px;text-align:center;font-size:14px;">Yükleniyor…</div>`;

  if (tab === 'stats')          await loadAdminStats(el);
  if (tab === 'users')          await loadAdminUsers(el);
  if (tab === 'servers')        await loadAdminServers(el);
  if (tab === 'ip-bans')        await loadAdminIpBans(el);
  if (tab === 'logs')           await loadAdminLogs(el);
  if (tab === 'broadcast')      loadAdminBroadcast(el);
  if (tab === 'reaction-roles') await loadAdminReactionRoles(el);
  if (tab === 'marketplace')    await loadAdminMarketplace(el);
}
