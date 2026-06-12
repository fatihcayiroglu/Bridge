<!-- client/js/core/BadgeDisplay.svelte -->
<!-- Sprint 116 — badges.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kullanıcı rozet gösterimi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('BadgeDisplay');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showBadgeDisplay', () => { isVisible = true; });
    BridgeRegistry.register('hideBadgeDisplay', () => { isVisible = false; });
    isReady = true;
    log.info('BadgeDisplay mounted');
  });
  onDestroy(() => {
    log.info('BadgeDisplay destroyed');
  });
</script>

{#if isVisible}
<div class="badge-display" role="region" aria-label="Kullanıcı rozet gösterimi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.badge-display {
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
