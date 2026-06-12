<!-- client/js/core/OutgoingWebhooksPanel.svelte -->
<!-- Sprint 116 — outgoing-webhooks.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Giden webhook yönetim paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('OutgoingWebhooksPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showOutgoingWebhooksPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideOutgoingWebhooksPanel', () => { isVisible = false; });
    isReady = true;
    log.info('OutgoingWebhooksPanel mounted');
  });
  onDestroy(() => {
    log.info('OutgoingWebhooksPanel destroyed');
  });
</script>

{#if isVisible}
<div class="outgoing-webhooks-panel" role="region" aria-label="Giden webhook yönetim paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.outgoing-webhooks-panel {
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
