// client/js/core/discover-svelte.ts
// Sprint 114: DiscoverPanel Svelte mount shim
//
// ADR-0008 Faz 2 — voice-svelte.ts / group-dm-svelte.ts ile aynı pattern.
// vanilla discover.ts + discover-enhanced.ts'teki BridgeRegistry kayıtlarını
// koruyarak geriye dönük uyumluluğu sağlar.
//
// DOMContentLoaded + bridge:socket-ready dual-listener pattern:
//   DOMContentLoaded: normal sayfa yükü için
//   bridge:socket-ready: modül geç yüklendiyse güvenlik ağı

import { mount } from 'svelte';
import { BridgeRegistry } from './bridge-registry.ts';
import DiscoverPanel from './DiscoverPanel.svelte';

// Çifte mount koruması
let _discoverPanelInstance: ReturnType<typeof mount> | null = null;

function _mountDiscoverPanel(): void {
  const target = document.getElementById('discover-root');
  if (!target || _discoverPanelInstance) return;

  _discoverPanelInstance = mount(DiscoverPanel, { target });
}

function _unmountDiscoverPanel(): void {
  if (_discoverPanelInstance) {
    // Svelte 5 unmount
    (_discoverPanelInstance as unknown as { destroy?: () => void })?.destroy?.();
    _discoverPanelInstance = null;
    const target = document.getElementById('discover-root');
    if (target) target.innerHTML = '';
  }
}

// ── Lifecycle mount noktaları (voice-svelte.ts ile aynı pattern) ──────────────

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _mountDiscoverPanel, { once: true });
} else {
  // DOMContentLoaded zaten geçti (modül geç yüklendi)
  _mountDiscoverPanel();
}

// bridge:socket-ready: socket bağlandığında mount güvenlik ağı
document.addEventListener('bridge:socket-ready', _mountDiscoverPanel, { once: true });

// ── BridgeRegistry — geriye dönük uyumluluk export'ları ─────────────────────

// discover.ts'in eski export'ları: initDiscover, onDiscoverMount, onDiscoverUnmount
// discover-enhanced.ts'in eski export'u: initDiscoverEnhanced
// Svelte bileşeni kendi init/cleanup'ını $effect ile yönetiyor,
// bu shim'ler eski çağrıları boş promise ile absorbe eder.

BridgeRegistry.register('initDiscover',            () => Promise.resolve());
BridgeRegistry.register('initDiscoverEnhanced',    () => Promise.resolve());
BridgeRegistry.register('onDiscoverMount',         _mountDiscoverPanel);
BridgeRegistry.register('onDiscoverUnmount',       _unmountDiscoverPanel);

// joinServerFromDiscover: discover.ts'in public export'u — eski bot/plugin kodu
// kullanabilir. Svelte bileşeni kendi joinServer fonksiyonunu $effect içinde
// çağırıyor; bu registry kaydı sadece dış çağrılar için.
BridgeRegistry.register('joinServerFromDiscover', async (serverId: string) => {
  const { apiFetch } = await import('./api-fetch.js');
  const { getAPI }   = await import('./globals.js');
  const API = getAPI();
  const r = await apiFetch(`${API}/api/servers/${serverId}/join`, { method: 'POST' });
  if (!r.ok) {
    const d = await r.json().catch(() => ({})) as { error?: string };
    BridgeRegistry.call('toast', d.error ?? 'Katılım başarısız', 'error');
    return;
  }
  BridgeRegistry.call('toast', '✅ Topluluğa katıldın!', 'success');
  BridgeRegistry.call('loadServers');
});
