// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/A11yAriaPanel.svelte
//              client/js/core/a11y-aria-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/a11y-aria.ts — Sprint 43 JS→TS geçişi
// ARIA attribute yönetimi — expanded/controls/haspopup/live region
//
// Bu modül settings-modal, dropdown'lar ve context menüler için
// dinamik ARIA state güncellemelerini merkezi bir yerden yönetir.

// ── Live region ─────────────────────────────────────────────────────────────

let _politeRegion: HTMLElement | null = null;
let _assertiveRegion: HTMLElement | null = null;

function ensureLiveRegions(): void {
  if (!_politeRegion) {
    _politeRegion = document.getElementById('a11y-live-polite');
    if (!_politeRegion) {
      _politeRegion = document.createElement('div');
      _politeRegion.id = 'a11y-live-polite';
      _politeRegion.setAttribute('aria-live', 'polite');
      _politeRegion.setAttribute('aria-atomic', 'true');
      _politeRegion.className = 'sr-only';
      document.body.appendChild(_politeRegion);
    }
  }
  if (!_assertiveRegion) {
    _assertiveRegion = document.getElementById('a11y-live-assertive');
    if (!_assertiveRegion) {
      _assertiveRegion = document.createElement('div');
      _assertiveRegion.id = 'a11y-live-assertive';
      _assertiveRegion.setAttribute('aria-live', 'assertive');
      _assertiveRegion.setAttribute('aria-atomic', 'true');
      _assertiveRegion.className = 'sr-only';
      document.body.appendChild(_assertiveRegion);
    }
  }
}

/** Ekran okuyucuya polite anons yap (bilgi mesajları, toast) */
export function announcePolite(message: string): void {
  ensureLiveRegions();
  _politeRegion!.textContent = '';
  requestAnimationFrame(() => { _politeRegion!.textContent = message; });
}

/** Ekran okuyucuya assertive anons yap (hata, kritik uyarı) */
export function announceAssertive(message: string): void {
  ensureLiveRegions();
  _assertiveRegion!.textContent = '';
  requestAnimationFrame(() => { _assertiveRegion!.textContent = message; });
}

// ── Disclosure (accordion / collapsible) ─────────────────────────────────

/**
 * Açılır/kapanır bölüm için aria-expanded + aria-controls bağla
 * @param trigger — toggle butonu
 * @param target  — açılan içerik
 * @param open    — başlangıç durumu (varsayılan: false)
 */
export function bindDisclosure(
  trigger: HTMLElement,
  target: HTMLElement,
  open = false,
): void {
  if (!trigger || !target) return;

  if (!target.id) target.id = `disclosure-${Math.random().toString(36).slice(2, 8)}`;
  trigger.setAttribute('aria-controls', target.id);
  trigger.setAttribute('aria-expanded', String(open));

  const update = (isOpen: boolean): void => {
    trigger.setAttribute('aria-expanded', String(isOpen));
    target.hidden = !isOpen;
  };

  update(open);

  trigger.addEventListener('click', () => {
    const isOpen = trigger.getAttribute('aria-expanded') === 'true';
    update(!isOpen);
  });

  trigger.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      trigger.click();
    }
  });
}

// ── Popup / dropdown ──────────────────────────────────────────────────────

export type AriaHasPopup = 'true' | 'menu' | 'listbox' | 'dialog';

/**
 * Dropdown / popup açma-kapama için ARIA state yönet.
 * @returns Cleanup fonksiyonu (MutationObserver'ı ayırır)
 */
export function bindPopupAria(
  trigger: HTMLElement,
  popup: HTMLElement,
  hasPopup: AriaHasPopup = 'menu',
): () => void {
  if (!trigger || !popup) return () => { /* noop */ };

  if (!popup.id) popup.id = `popup-${Math.random().toString(36).slice(2, 8)}`;
  trigger.setAttribute('aria-haspopup', hasPopup);
  trigger.setAttribute('aria-controls', popup.id);
  trigger.setAttribute('aria-expanded', 'false');

  const observer = new MutationObserver(() => {
    const style = (popup as HTMLElement & { style: CSSStyleDeclaration }).style;
    const visible =
      !popup.hidden &&
      style.display !== 'none' &&
      style.visibility !== 'hidden';
    trigger.setAttribute('aria-expanded', String(visible));
  });

  observer.observe(popup, { attributes: true, attributeFilter: ['hidden', 'style'] });

  return () => observer.disconnect();
}

// ── Settings modal ARIA patch ─────────────────────────────────────────────

/**
 * settings-modal için sekme paneli ARIA ilişkilerini kur
 * (role="tab", role="tabpanel", aria-selected, aria-controls)
 */
export function patchSettingsModalAria(): void {
  const modal = document.getElementById('settings-modal');
  if (!modal) return;

  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');
  modal.setAttribute('aria-label', 'Ayarlar');

  const tabs   = Array.from(modal.querySelectorAll<HTMLElement>('.settings-tab-btn, [data-settings-tab]'));
  const panels = Array.from(modal.querySelectorAll<HTMLElement>('.settings-tab-panel, [data-settings-panel]'));

  tabs.forEach((tab, i) => {
    const panel = panels[i];
    if (!panel) return;

    if (!panel.id) panel.id = `settings-panel-${i}`;
    tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', panel.id);
    tab.setAttribute('aria-selected', tab.classList.contains('active') ? 'true' : 'false');
    tab.setAttribute('tabindex', tab.classList.contains('active') ? '0' : '-1');

    panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id || `settings-tab-${i}`);
    if (!tab.id) tab.id = `settings-tab-${i}`;
  });

  const tablist = modal.querySelector<HTMLElement>('.settings-tabs, [data-tablist]');
  if (tablist) tablist.setAttribute('role', 'tablist');
}

// ── Context menu ARIA ─────────────────────────────────────────────────────

/** Context menü öğelerine role="menuitem" ve gerekli attribute'ları ekle */
export function patchContextMenuAria(menu: HTMLElement | null): void {
  if (!menu) return;
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-orientation', 'vertical');

  menu.querySelectorAll<HTMLElement>('.context-menu-item, [data-ctx-item]').forEach((item) => {
    if (!item.getAttribute('role')) item.setAttribute('role', 'menuitem');
    if (!item.getAttribute('tabindex')) item.setAttribute('tabindex', '-1');
  });

  menu.querySelectorAll<HTMLElement>('.context-menu-separator, hr').forEach((sep) =>
    sep.setAttribute('role', 'separator'),
  );
}

// ── SR-only utility style ─────────────────────────────────────────────────

/** .sr-only stilini DOM'a enjekte eder (CSS bağımsızlığı için) */
export function ensureSrOnlyStyle(): void {
  if (document.getElementById('a11y-sr-only-style')) return;
  const style = document.createElement('style');
  style.id = 'a11y-sr-only-style';
  style.textContent =
    '.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}';
  document.head.appendChild(style);
}
