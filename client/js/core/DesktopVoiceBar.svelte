<!-- client/js/core/DesktopVoiceBar.svelte -->
<!-- Sprint 116 — desktop-voice-bar.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Masaüstü ses durum çubuğu -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('DesktopVoiceBar');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showDesktopVoiceBar', () => { isVisible = true; });
    BridgeRegistry.register('hideDesktopVoiceBar', () => { isVisible = false; });
    isReady = true;
    log.info('DesktopVoiceBar mounted');
  });
  onDestroy(() => {
    log.info('DesktopVoiceBar destroyed');
  });
</script>

{#if isVisible}
<div class="desktop-voice-bar" role="region" aria-label="Masaüstü ses durum çubuğu">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.desktop-voice-bar {
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
