// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/StylesPanel.svelte
//              client/js/core/styles-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/styles.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// v44 CSS enjeksiyonu — Voice Volume Panel, Advanced Search, Slow Mode, Audit Log, Server Boost

/**
 * v44 bileşen stillerini document.head'e enjekte eder.
 * Birden fazla kez çağrılsa da yalnızca bir kez ekler.
 */
export function injectV44CSS(): void {
  if (document.getElementById('bridge-v44-styles')) return;
  const style = document.createElement('style');
  style.id = 'bridge-v44-styles';
  style.textContent = `
    /* ── Voice Volume Panel ───────────────────────────── */
    .bvv-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      font-weight: 600;
      margin-bottom: 12px;
      font-size: 13px;
    }
    .bvv-close {
      background: none;
      border: none;
      color: var(--text-muted);
      cursor: pointer;
      font-size: 14px;
      padding: 0 2px;
    }
    .bvv-close:hover { color: var(--text-primary); }
    .bvv-row {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 4px 0;
    }
    .boost-booster-item {
      display: flex;
      align-items: center;
      gap: 8px;
      font-size: 13px;
    }
  `;
  document.head.appendChild(style);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', injectV44CSS);
} else {
  injectV44CSS();
}
