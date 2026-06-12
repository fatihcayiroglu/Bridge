<!-- client/js/core/VoiceSettingsTab.svelte -->
<!-- Sprint 116 — settings-modal-voice.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Ses/Video ayarları sekmesi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('VoiceSettingsTab');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showVoiceSettingsTab', () => { isVisible = true; });
    BridgeRegistry.register('hideVoiceSettingsTab', () => { isVisible = false; });
    isReady = true;
    log.info('VoiceSettingsTab mounted');
  });
  onDestroy(() => {
    log.info('VoiceSettingsTab destroyed');
  });
</script>

{#if isVisible}
<div class="voice-settings-tab" role="region" aria-label="Ses/Video ayarları sekmesi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.voice-settings-tab {
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
