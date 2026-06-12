<!-- client/js/core/ServerProfilePanel.svelte -->
<!-- Sprint 116 — server-profile.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sunucu profil ve hakkında paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ServerProfilePanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showServerProfilePanel', () => { isVisible = true; });
    BridgeRegistry.register('hideServerProfilePanel', () => { isVisible = false; });
    isReady = true;
    log.info('ServerProfilePanel mounted');
  });
  onDestroy(() => {
    log.info('ServerProfilePanel destroyed');
  });
</script>

{#if isVisible}
<div class="server-profile-panel" role="region" aria-label="Sunucu profil ve hakkında paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.server-profile-panel {
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
