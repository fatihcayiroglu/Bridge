<!-- client/js/core/ReactionPicker.svelte -->
<!-- Sprint 116 — messages-reactions.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Emoji reaksiyon seçici ve sayaç -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ReactionPicker');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showReactionPicker', () => { isVisible = true; });
    BridgeRegistry.register('hideReactionPicker', () => { isVisible = false; });
    isReady = true;
    log.info('ReactionPicker mounted');
  });
  onDestroy(() => {
    log.info('ReactionPicker destroyed');
  });
</script>

{#if isVisible}
<div class="reaction-picker" role="region" aria-label="Emoji reaksiyon seçici ve sayaç">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.reaction-picker {
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
