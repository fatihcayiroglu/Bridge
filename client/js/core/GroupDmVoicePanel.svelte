<!-- client/js/core/GroupDmVoicePanel.svelte -->
<!-- Sprint 116 — group-dm-voice.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Grup DM sesli arama paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('GroupDmVoicePanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showGroupDmVoicePanel', () => { isVisible = true; });
    BridgeRegistry.register('hideGroupDmVoicePanel', () => { isVisible = false; });
    isReady = true;
    log.info('GroupDmVoicePanel mounted');
  });
  onDestroy(() => {
    log.info('GroupDmVoicePanel destroyed');
  });
</script>

{#if isVisible}
<div class="group-dm-voice-panel" role="region" aria-label="Grup DM sesli arama paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.group-dm-voice-panel {
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
