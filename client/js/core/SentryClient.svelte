<!-- client/js/core/SentryClient.svelte -->
<!-- Sprint 116 — sentry-client.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sentry hata izleme entegrasyonu -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('SentryClient');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showSentryClient', () => { isVisible = true; });
    BridgeRegistry.register('hideSentryClient', () => { isVisible = false; });
    isReady = true;
    log.info('SentryClient mounted');
  });
  onDestroy(() => {
    log.info('SentryClient destroyed');
  });
</script>

{#if isVisible}
<div class="sentry-client" role="region" aria-label="Sentry hata izleme entegrasyonu">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.sentry-client {
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
