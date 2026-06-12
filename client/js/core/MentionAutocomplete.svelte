<!-- client/js/core/MentionAutocomplete.svelte -->
<!-- Sprint 116 — mention-autocomplete.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mention otomatik tamamlama -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MentionAutocomplete');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMentionAutocomplete', () => { isVisible = true; });
    BridgeRegistry.register('hideMentionAutocomplete', () => { isVisible = false; });
    isReady = true;
    log.info('MentionAutocomplete mounted');
  });
  onDestroy(() => {
    log.info('MentionAutocomplete destroyed');
  });
</script>

{#if isVisible}
<div class="mention-autocomplete" role="region" aria-label="Mention otomatik tamamlama">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.mention-autocomplete {
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
