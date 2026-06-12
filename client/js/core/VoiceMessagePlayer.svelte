<!-- client/js/core/VoiceMessagePlayer.svelte -->
<!-- Sprint 116 — voice-messages.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sesli mesaj oynatıcı -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('VoiceMessagePlayer');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showVoiceMessagePlayer', () => { isVisible = true; });
    BridgeRegistry.register('hideVoiceMessagePlayer', () => { isVisible = false; });
    isReady = true;
    log.info('VoiceMessagePlayer mounted');
  });
  onDestroy(() => {
    log.info('VoiceMessagePlayer destroyed');
  });
</script>

{#if isVisible}
<div class="voice-message-player" role="region" aria-label="Sesli mesaj oynatıcı">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.voice-message-player {
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
