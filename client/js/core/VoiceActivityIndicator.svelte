<!-- client/js/core/VoiceActivityIndicator.svelte -->
<!-- Sprint 116 — voice-activity-ui.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Konuşma aktivite göstergesi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('VoiceActivityIndicator');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showVoiceActivityIndicator', () => { isVisible = true; });
    BridgeRegistry.register('hideVoiceActivityIndicator', () => { isVisible = false; });
    isReady = true;
    log.info('VoiceActivityIndicator mounted');
  });
  onDestroy(() => {
    log.info('VoiceActivityIndicator destroyed');
  });
</script>

{#if isVisible}
<div class="voice-activity-indicator" role="region" aria-label="Konuşma aktivite göstergesi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.voice-activity-indicator {
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
