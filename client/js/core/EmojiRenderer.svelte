<!-- client/js/core/EmojiRenderer.svelte -->
<!-- Sprint 116 — emoji.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Emoji render ve özel emoji desteği -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('EmojiRenderer');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showEmojiRenderer', () => { isVisible = true; });
    BridgeRegistry.register('hideEmojiRenderer', () => { isVisible = false; });
    isReady = true;
    log.info('EmojiRenderer mounted');
  });
  onDestroy(() => {
    log.info('EmojiRenderer destroyed');
  });
</script>

{#if isVisible}
<div class="emoji-renderer" role="region" aria-label="Emoji render ve özel emoji desteği">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.emoji-renderer {
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
