<!-- client/js/core/DiscordUIKit.svelte -->
<!-- Sprint 116 — discord-ui-kit.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Discord uyumluluk UI bileşenleri -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('DiscordUIKit');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showDiscordUIKit', () => { isVisible = true; });
    BridgeRegistry.register('hideDiscordUIKit', () => { isVisible = false; });
    isReady = true;
    log.info('DiscordUIKit mounted');
  });
  onDestroy(() => {
    log.info('DiscordUIKit destroyed');
  });
</script>

{#if isVisible}
<div class="discord-u-i-kit" role="region" aria-label="Discord uyumluluk UI bileşenleri">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.discord-u-i-kit {
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
