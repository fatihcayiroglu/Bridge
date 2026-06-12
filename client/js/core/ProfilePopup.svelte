<!-- client/js/core/ProfilePopup.svelte -->
<!-- Sprint 116 — profile-ui.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kullanıcı profil popup/modal -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ProfilePopup');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showProfilePopup', () => { isVisible = true; });
    BridgeRegistry.register('hideProfilePopup', () => { isVisible = false; });
    isReady = true;
    log.info('ProfilePopup mounted');
  });
  onDestroy(() => {
    log.info('ProfilePopup destroyed');
  });
</script>

{#if isVisible}
<div class="profile-popup" role="region" aria-label="Kullanıcı profil popup/modal">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.profile-popup {
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
