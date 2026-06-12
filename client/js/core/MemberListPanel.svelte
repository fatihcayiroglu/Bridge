<!-- client/js/core/MemberListPanel.svelte -->
<!-- Sprint 116 — members.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Üye listesi ve rol filtreleme -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('MemberListPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showMemberListPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideMemberListPanel', () => { isVisible = false; });
    isReady = true;
    log.info('MemberListPanel mounted');
  });
  onDestroy(() => {
    log.info('MemberListPanel destroyed');
  });
</script>

{#if isVisible}
<div class="member-list-panel" role="region" aria-label="Üye listesi ve rol filtreleme">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.member-list-panel {
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
