// client/js/admin/admin-svelte.ts
// Sprint 118: AdminPanel.svelte için mount shim
// Önceki 10 vanilla TS dosyasının (shell, stats, users, servers, ip-bans,
// logs, reaction-roles, marketplace, utils, index) yerini alır.
//
// ADR-0008: voice-svelte.ts / group-dm-svelte.ts pattern'iyle birebir uyumlu.
//   - DOMContentLoaded + bridge:socket-ready çift listener (geç yükleme güvenlik ağı)
//   - _adminPanelInstance guard: çifte mount koruması
//   - BridgeRegistry: tüm public API'lar geriye dönük uyumluluk için kayıtlı

import { mount, unmount } from 'svelte';
import AdminPanel from './AdminPanel.svelte';
import { BridgeRegistry } from '../core/bridge-registry.ts';
import { t } from '../core/i18n/index.ts';

let _adminPanelInstance: ReturnType<typeof mount> | null = null;
let _adminPanelContainer: HTMLElement | null = null;
let _adminPanelObserver: MutationObserver | null = null;

export function unmountAdminPanel(removeContainer = true) {
  const instance = _adminPanelInstance;
  const container = _adminPanelContainer;
  _adminPanelInstance = null;
  _adminPanelContainer = null;
  _adminPanelObserver?.disconnect();
  _adminPanelObserver = null;
  if (instance) void unmount(instance);
  if (removeContainer && container?.isConnected) container.remove();
}

export function closeAdminDashboard() {
  unmountAdminPanel(true);
}

export function mountAdminPanel() {
  if (_adminPanelInstance) return;

  // Admin overlay container — önceki shell.ts'teki gibi body'e ekleniyor
  const container = document.createElement('div');
  container.id = 'admin-overlay';
  document.body.appendChild(container);
  _adminPanelContainer = container;

  _adminPanelInstance = mount(AdminPanel, { target: container });

  // Overlay dışarıdan kaldırılırsa Svelte instance'ını da gerçekten dispose et.
  _adminPanelObserver?.disconnect();
  _adminPanelObserver = new MutationObserver(() => {
    if (!container.isConnected) unmountAdminPanel(false);
  });
  _adminPanelObserver.observe(document.body, { childList: true });
}

// ── Buton enjeksiyonu (shell.ts'ten taşındı) ──────────────────
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
  btn.setAttribute('aria-label', t('ts_admin_open', 'Admin Panelini Aç'));
  btn.style.cssText = 'color:#f0a500;font-size:16px;';
  btn.textContent = '🛡️';
  btn.onclick = openAdminDashboard;
  btn.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') openAdminDashboard(); };
  ref.parentNode!.insertBefore(btn, ref);
}

export function openAdminDashboard() {
  const existing = document.getElementById('admin-overlay');
  if (existing || _adminPanelInstance) {
    if (_adminPanelInstance) unmountAdminPanel(true);
    else existing?.remove();
    return;
  }
  mountAdminPanel();
}

// adminTab artık Svelte state üzerinden yönetiliyor —
// dışarıdan doğrudan çağırmak için BridgeRegistry üzerinden erişilebilir
export function adminTab(_tab: string) {
  // no-op: AdminPanel.svelte kendi state'ini yönetiyor
  // Geriye dönük uyumluluk için korundu
}

// ── BridgeRegistry kayıtları (geriye dönük uyumluluk) ─────────
function registerBridgeApi() {
  BridgeRegistry.register('adminInjectButton',  adminInjectButton);
  BridgeRegistry.register('openAdminDashboard', openAdminDashboard);
  BridgeRegistry.register('closeAdminDashboard', closeAdminDashboard);
  BridgeRegistry.register('adminTab',           adminTab);
}

// ── Mount timing ──────────────────────────────────────────────
// DOMContentLoaded: normal yükleme
// bridge:socket-ready: modül geç yüklenmişse güvenlik ağı
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', registerBridgeApi, { once: true });
} else {
  registerBridgeApi();
}
document.addEventListener('bridge:socket-ready', registerBridgeApi, { once: true });
