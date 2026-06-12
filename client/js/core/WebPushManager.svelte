<!-- client/js/core/WebPushManager.svelte -->
<!-- Sprint 116 — web-push.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Web Push bildirim yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('WebPushManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showWebPushManager', () => { isVisible = true; });
    BridgeRegistry.register('hideWebPushManager', () => { isVisible = false; });
    isReady = true;
    log.info('WebPushManager mounted');
  });
  onDestroy(() => {
    log.info('WebPushManager destroyed');
  });
</script>

{#if isVisible}
<div class="web-push-manager" role="region" aria-label="Web Push bildirim yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.web-push-manager {
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
