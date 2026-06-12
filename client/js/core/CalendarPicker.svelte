<!-- client/js/core/CalendarPicker.svelte -->
<!-- Sprint 116 — calendar-picker.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Tarih seçici takvim bileşeni -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('CalendarPicker');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showCalendarPicker', () => { isVisible = true; });
    BridgeRegistry.register('hideCalendarPicker', () => { isVisible = false; });
    isReady = true;
    log.info('CalendarPicker mounted');
  });
  onDestroy(() => {
    log.info('CalendarPicker destroyed');
  });
</script>

{#if isVisible}
<div class="calendar-picker" role="region" aria-label="Tarih seçici takvim bileşeni">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.calendar-picker {
  display: flex;
  flex-direction: column;
  background: var(--bridge-surface, #1e2124);
  color: var(--bridge-text, #fff);
  border-radius: 8px;
}
.bridge-error {
  padding: 12px;
  color: var(--bridge-danger, #f04747);
  font-size: .875rem;
  text-align: center;
}
</style>
