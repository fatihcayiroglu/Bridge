<!-- client/js/core/DraftManager.svelte -->
<!-- Sprint 116 — drafts.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kanal başına mesaj taslak yönetimi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('DraftManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showDraftManager', () => { isVisible = true; });
    BridgeRegistry.register('hideDraftManager', () => { isVisible = false; });
    isReady = true;
    log.info('DraftManager mounted');
  });
  onDestroy(() => {
    log.info('DraftManager destroyed');
  });
</script>

{#if isVisible}
<div class="draft-manager" role="region" aria-label="Kanal başına mesaj taslak yönetimi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.draft-manager {
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
