<!-- client/js/core/VoiceVolumeControl.svelte -->
<!-- Sprint 116 — voice-volume.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Bireysel ses seviyesi ayarı -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('VoiceVolumeControl');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showVoiceVolumeControl', () => { isVisible = true; });
    BridgeRegistry.register('hideVoiceVolumeControl', () => { isVisible = false; });
    isReady = true;
    log.info('VoiceVolumeControl mounted');
  });
  onDestroy(() => {
    log.info('VoiceVolumeControl destroyed');
  });
</script>

{#if isVisible}
<div class="voice-volume-control" role="region" aria-label="Bireysel ses seviyesi ayarı">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.voice-volume-control {
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
