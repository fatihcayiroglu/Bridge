<!-- client/js/core/FocusTrap.svelte -->
<!-- Sprint 116 — a11y-focus-trap.ts → Svelte 5 Runes (WCAG 2.1 §2.1.2) -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';

  interface Props {
    active?: boolean;
    returnFocusOnDeactivate?: boolean;
    initialFocus?: string;  // CSS selector
    children?: Snippet;
  }

  let {
    active = true,
    returnFocusOnDeactivate = true,
    initialFocus,
    children,
  }: Props = $props();

  const FOCUSABLE = [
    'a[href]','button:not([disabled])','textarea:not([disabled])',
    'input:not([disabled])','select:not([disabled])','[tabindex]:not([tabindex="-1"])',
    'details > summary',
  ].join(',');

  let trapEl: HTMLDivElement | undefined;
  let _prevFocus: HTMLElement | null = null;

  function getFocusable(): HTMLElement[] {
    return Array.from(trapEl?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter(el => !el.closest('[hidden]') && !el.closest('[aria-hidden="true"]'));
  }

  function onKeyDown(e: KeyboardEvent) {
    if (!active || e.key !== 'Tab') return;
    const focusable = getFocusable();
    if (!focusable.length) { e.preventDefault(); return; }
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }

  $effect(() => {
    if (active && trapEl) {
      _prevFocus = document.activeElement as HTMLElement;
      const initial = initialFocus
        ? trapEl.querySelector<HTMLElement>(initialFocus)
        : getFocusable()[0];
      initial?.focus();
    } else if (!active && returnFocusOnDeactivate && _prevFocus) {
      _prevFocus.focus();
      _prevFocus = null;
    }
  });

  onDestroy(() => {
    if (returnFocusOnDeactivate && _prevFocus) {
      _prevFocus.focus();
    }
  });
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div bind:this={trapEl} onkeydown={onKeyDown} style="display:contents">
  {@render children?.()}
</div>
