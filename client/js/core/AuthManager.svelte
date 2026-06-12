<!-- client/js/core/AuthManager.svelte -->
<!-- Sprint 116 — auth.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kimlik doğrulama akışı yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AuthManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAuthManager', () => { isVisible = true; });
    BridgeRegistry.register('hideAuthManager', () => { isVisible = false; });
    isReady = true;
    log.info('AuthManager mounted');
  });
  onDestroy(() => {
    log.info('AuthManager destroyed');
  });
</script>

{#if isVisible}
<div class="auth-manager" role="region" aria-label="Kimlik doğrulama akışı yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.auth-manager {
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
