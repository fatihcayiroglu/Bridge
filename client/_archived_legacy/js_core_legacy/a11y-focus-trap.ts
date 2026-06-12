// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/A11yFocusTrapPanel.svelte
//              client/js/core/a11y-focus-trap-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/a11y-focus-trap.ts
// Focus trap yöneticisi — tüm modal/dropdown/context-menu için tek kaynak

const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
  'details > summary',
].join(', ');

interface TrapOptions {
  returnTo?: Element | null;
}

interface TrapContainer extends HTMLElement {
  _a11yCleanup?: () => void;
}

/**
 * Activate focus trap on container.
 * Returns a cleanup function that releases the trap.
 */
export function trapFocus(container: TrapContainer, opts: TrapOptions = {}): () => void {
  if (!container) return () => {};

  const returnTo = opts.returnTo ?? document.activeElement;

  function getFocusable(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
      el => !el.closest('[hidden]') && !el.closest('[aria-hidden="true"]')
    );
  }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key !== 'Tab') return;
    const focusable = getFocusable();
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last)  { e.preventDefault(); first.focus(); }
    }
  }

  function handleEscape(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.stopPropagation(); releaseFocus(cleanup); }
  }

  container.addEventListener('keydown', handleKeydown);
  container.addEventListener('keydown', handleEscape);

  const focusable      = getFocusable();
  const initialFocus   =
    container.querySelector<HTMLElement>('[data-autofocus]') ??
    focusable[0] ??
    container;
  requestAnimationFrame(() => (initialFocus as HTMLElement).focus?.());

  function cleanup(): void {
    container.removeEventListener('keydown', handleKeydown);
    container.removeEventListener('keydown', handleEscape);
    if (returnTo && typeof (returnTo as HTMLElement).focus === 'function') {
      (returnTo as HTMLElement).focus();
    }
  }

  container._a11yCleanup = cleanup;
  return cleanup;
}

export function releaseFocus(cleanupFn?: () => void): void {
  if (typeof cleanupFn === 'function') cleanupFn();
}

export function initGlobalEscapeHandler(): void {
  document.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const openModal = document.querySelector<TrapContainer>(
      '[role="dialog"][aria-modal="true"]:not([hidden]):not([style*="display: none"])'
    );
    if (!openModal) return;
    const closeBtn = openModal.querySelector<HTMLElement>(
      '[data-modal-close], .modal-close, [aria-label*="Kapat"]'
    );
    if (closeBtn) closeBtn.click();
    else if (typeof openModal._a11yCleanup === 'function') openModal._a11yCleanup();
  }, true);
}
