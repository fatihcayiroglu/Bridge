<!-- client/js/core/ForumPanel.svelte -->
<!-- Sprint 116 — forum.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Forum kanal listesi ve thread paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ForumPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showForumPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideForumPanel', () => { isVisible = false; });
    isReady = true;
    log.info('ForumPanel mounted');
  });
  onDestroy(() => {
    log.info('ForumPanel destroyed');
  });
</script>

{#if isVisible}
<div class="forum-panel" role="region" aria-label="Forum kanal listesi ve thread paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.forum-panel {
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
