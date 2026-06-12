// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/A11yKeyboardPanel.svelte
//              client/js/core/a11y-keyboard-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/a11y-keyboard.ts
// Klavye navigasyon yardımcıları: roving tabindex, space/enter normalisation, dropdown keyboard

type Orientation = 'horizontal' | 'vertical' | 'both';

// ── Roving tabindex ────────────────────────────────────────────────────────────

export function initRovingTabindex(
  container: HTMLElement,
  itemSelector: string,
  orientation: Orientation = 'vertical'
): void {
  if (!container) return;

  function getItems(): HTMLElement[] {
    return Array.from(container.querySelectorAll<HTMLElement>(itemSelector)).filter(
      el => !(el as HTMLButtonElement).disabled && !el.getAttribute('aria-disabled')
    );
  }

  function setActive(items: HTMLElement[], index: number): void {
    items.forEach((el, i) => {
      el.setAttribute('tabindex', i === index ? '0' : '-1');
      if (i === index) el.focus();
    });
  }

  container.addEventListener('keydown', (e: KeyboardEvent) => {
    const items   = getItems();
    const current = items.indexOf(document.activeElement as HTMLElement);
    if (current === -1) return;

    let next = current;

    if ((orientation === 'vertical' || orientation === 'both') && e.key === 'ArrowDown') {
      e.preventDefault(); next = (current + 1) % items.length;
    } else if ((orientation === 'vertical' || orientation === 'both') && e.key === 'ArrowUp') {
      e.preventDefault(); next = (current - 1 + items.length) % items.length;
    } else if ((orientation === 'horizontal' || orientation === 'both') && e.key === 'ArrowRight') {
      e.preventDefault(); next = (current + 1) % items.length;
    } else if ((orientation === 'horizontal' || orientation === 'both') && e.key === 'ArrowLeft') {
      e.preventDefault(); next = (current - 1 + items.length) % items.length;
    } else if (e.key === 'Home') {
      e.preventDefault(); next = 0;
    } else if (e.key === 'End') {
      e.preventDefault(); next = items.length - 1;
    } else {
      return;
    }

    setActive(items, next);
  });

  // Initialise tabindex
  const items    = getItems();
  const selected = items.findIndex(
    el => el.getAttribute('aria-selected') === 'true' || el.getAttribute('tabindex') === '0'
  );
  items.forEach((el, i) => el.setAttribute('tabindex', i === Math.max(0, selected) ? '0' : '-1'));
}

// ── Space / Enter → click normalisation ───────────────────────────────────────

export function normalizeSpaceEnterClick(root: HTMLElement | Document = document): void {
  root.addEventListener('keydown', (e: Event) => {
    const ke = e as KeyboardEvent;
    if (ke.key !== ' ' && ke.key !== 'Enter') return;
    const el   = ke.target as HTMLElement;
    const role = el.getAttribute('role');
    const clickableRoles = ['button', 'menuitem', 'option', 'tab', 'treeitem', 'gridcell'];
    if (!clickableRoles.includes(role ?? '')) return;
    if (el.tagName === 'BUTTON' || el.tagName === 'A') return;
    ke.preventDefault();
    el.click();
  });
}

// ── Dropdown / context-menu keyboard ──────────────────────────────────────────

export function bindDropdownKeyboard(
  trigger: HTMLElement,
  menu: HTMLElement,
  itemSelector = '[role="menuitem"]'
): void {
  if (!trigger || !menu) return;

  trigger.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
      if ((menu as HTMLElement).hidden || (menu as HTMLElement).style.display === 'none') return;
      e.preventDefault();
      (menu.querySelector<HTMLElement>(itemSelector))?.focus();
    }
  });

  menu.addEventListener('keydown', (e: KeyboardEvent) => {
    const items = Array.from(menu.querySelectorAll<HTMLElement>(itemSelector));
    const idx   = items.indexOf(document.activeElement as HTMLElement);

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      items[(idx + 1) % items.length]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      items[(idx - 1 + items.length) % items.length]?.focus();
    } else if (e.key === 'Escape' || e.key === 'Tab') {
      trigger.focus();
    }
  });
}

// ── Channel list keyboard init ────────────────────────────────────────────────

export function initChannelListKeyboard(): void {
  document.querySelectorAll<HTMLElement>('.channel-list, #dm-list').forEach(list => {
    initRovingTabindex(list, '.channel-item, .dm-item', 'vertical');
  });
}
