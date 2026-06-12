<!-- client/js/core/UploadManager.svelte -->
<!-- Sprint 116 — upload.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Dosya yükleme ilerleme yöneticisi -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('UploadManager');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showUploadManager', () => { isVisible = true; });
    BridgeRegistry.register('hideUploadManager', () => { isVisible = false; });
    isReady = true;
    log.info('UploadManager mounted');
  });
  onDestroy(() => {
    log.info('UploadManager destroyed');
  });
</script>

{#if isVisible}
<div class="upload-manager" role="region" aria-label="Dosya yükleme ilerleme yöneticisi">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.upload-manager {
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
