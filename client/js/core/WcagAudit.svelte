<!-- client/js/core/WcagAudit.svelte -->
<!-- Sprint 116 — a11y-wcag-aa.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- WCAG AA uyumluluk denetim yardımcısı -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('WcagAudit');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showWcagAudit', () => { isVisible = true; });
    BridgeRegistry.register('hideWcagAudit', () => { isVisible = false; });
    isReady = true;
    log.info('WcagAudit mounted');
  });
  onDestroy(() => {
    log.info('WcagAudit destroyed');
  });
</script>

{#if isVisible}
<div class="wcag-audit" role="region" aria-label="WCAG AA uyumluluk denetim yardımcısı">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.wcag-audit {
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
