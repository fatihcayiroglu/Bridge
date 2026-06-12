<!-- client/js/core/DiscordImportStyles.svelte -->
<!-- Sprint 116 — discord-import-styles.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Discord import stil tanımları -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('DiscordImportStyles');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showDiscordImportStyles', () => { isVisible = true; });
    BridgeRegistry.register('hideDiscordImportStyles', () => { isVisible = false; });
    isReady = true;
    log.info('DiscordImportStyles mounted');
  });
  onDestroy(() => {
    log.info('DiscordImportStyles destroyed');
  });
</script>

{#if isVisible}
<div class="discord-import-styles" role="region" aria-label="Discord import stil tanımları">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.discord-import-styles {
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
