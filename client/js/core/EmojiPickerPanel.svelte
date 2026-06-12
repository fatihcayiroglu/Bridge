<!-- client/js/core/EmojiPickerPanel.svelte -->
<!-- Sprint 116 — emoji-picker.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Emoji seçici popup paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('EmojiPickerPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showEmojiPickerPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideEmojiPickerPanel', () => { isVisible = false; });
    isReady = true;
    log.info('EmojiPickerPanel mounted');
  });
  onDestroy(() => {
    log.info('EmojiPickerPanel destroyed');
  });
</script>

{#if isVisible}
<div class="emoji-picker-panel" role="region" aria-label="Emoji seçici popup paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.emoji-picker-panel {
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
