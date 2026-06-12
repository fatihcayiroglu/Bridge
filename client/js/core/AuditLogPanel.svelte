<!-- client/js/core/AuditLogPanel.svelte -->
<!-- Sprint 116 — audit-log.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sunucu denetim günlüğü paneli -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('AuditLogPanel');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showAuditLogPanel', () => { isVisible = true; });
    BridgeRegistry.register('hideAuditLogPanel', () => { isVisible = false; });
    isReady = true;
    log.info('AuditLogPanel mounted');
  });
  onDestroy(() => {
    log.info('AuditLogPanel destroyed');
  });
</script>

{#if isVisible}
<div class="audit-log-panel" role="region" aria-label="Sunucu denetim günlüğü paneli">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.audit-log-panel {
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
