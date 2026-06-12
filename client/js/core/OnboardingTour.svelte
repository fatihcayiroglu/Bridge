<!-- client/js/core/OnboardingTour.svelte -->
<!-- Sprint 116 — onboarding-tour.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Arayüz tanıtım turu overlay -->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('OnboardingTour');

  let { children }: { children?: Snippet } = $props();

  let isReady   = $state(false);
  let isVisible = $state(false);
  let hasError  = $state(false);
  let errorMsg  = $state('');

  onMount(() => {
    BridgeRegistry.register('showOnboardingTour', () => { isVisible = true; });
    BridgeRegistry.register('hideOnboardingTour', () => { isVisible = false; });
    isReady = true;
    log.info('OnboardingTour mounted');
  });
  onDestroy(() => {
    log.info('OnboardingTour destroyed');
  });
</script>

{#if isVisible}
<div class="onboarding-tour" role="region" aria-label="Arayüz tanıtım turu overlay">
  {#if hasError}
    <div class="bridge-error" role="alert">{errorMsg}</div>
  {:else}
    {@render children?.()}
  {/if}
</div>
{/if}

<style>
.onboarding-tour {
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
