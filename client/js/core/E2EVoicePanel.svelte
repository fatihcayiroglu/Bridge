<!-- client/js/core/E2EVoicePanel.svelte -->
<!-- Sprint 116 — e2e-voice.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- E2EE sesli arama paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('E2EVoicePanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showE2EVoicePanel', () => { isVisible = true; });
    BridgeRegistry.register('hideE2EVoicePanel', () => { isVisible = false; });
    isReady = true;
    log.info('E2EVoicePanel mounted');
  });
  onDestroy(() => {
    log.info('E2EVoicePanel destroyed');
  });
</script>

{#if isVisible}
<div class="e2-e-voice-panel" role="region" aria-label="E2EE sesli arama paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.e2-e-voice-panel {
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
