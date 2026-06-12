<!-- client/js/core/AuthRevokedNotice.svelte -->
<!-- Sprint 116 — auth-revoked.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Oturum iptali bildirimi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AuthRevokedNotice');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAuthRevokedNotice', () => { isVisible = true; });
    BridgeRegistry.register('hideAuthRevokedNotice', () => { isVisible = false; });
    isReady = true;
    log.info('AuthRevokedNotice mounted');
  });
  onDestroy(() => {
    log.info('AuthRevokedNotice destroyed');
  });
</script>

{#if isVisible}
<div class="auth-revoked-notice" role="region" aria-label="Oturum iptali bildirimi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.auth-revoked-notice {
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
