<!-- client/js/core/SlowModeIndicator.svelte -->
<!-- Sprint 116 — slow-mode.ts → Svelte 5 Runes -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';

  let cooldown       = $state(0);
  let slowModeSecs   = $state(0);
  let isActive       = $state(false);

  let _timer: ReturnType<typeof setInterval> | null = null;

  function startCooldown(secs: number) {
    cooldown = secs; isActive = true;
    if (_timer) clearInterval(_timer);
    _timer = setInterval(() => {
      cooldown--;
      if (cooldown <= 0) {
        cooldown = 0; isActive = false;
        if (_timer) { clearInterval(_timer); _timer = null; }
      }
    }, 1000);
  }

  function setSlowMode(secs: number) {
    slowModeSecs = secs;
  }

  let pct = $derived(slowModeSecs > 0 ? (cooldown / slowModeSecs) * 100 : 0);
  let label = $derived(
    isActive
      ? `Yavaş mod: ${cooldown}s bekle`
      : slowModeSecs > 0 ? `Yavaş mod: ${slowModeSecs}s` : ''
  );

  onMount(() => {
    BridgeRegistry.register('startSlowModeCooldown', startCooldown);
    BridgeRegistry.register('setSlowMode', setSlowMode);
  });
  onDestroy(() => {
    if (_timer) clearInterval(_timer);
  });
</script>

{#if slowModeSecs > 0}
<div class="slow-mode {isActive ? 'active' : ''}" role="status" aria-label={label} title={label}>
  <div class="sm-icon" aria-hidden="true">🐌</div>
  {#if isActive}
    <div class="sm-bar">
      <div class="sm-fill" style="width:{pct}%"></div>
    </div>
    <span class="sm-secs">{cooldown}s</span>
  {:else}
    <span class="sm-secs">{slowModeSecs}s</span>
  {/if}
</div>
{/if}

<style>
.slow-mode {
  display: flex; align-items: center; gap: 5px;
  padding: 2px 8px; border-radius: 4px;
  background: var(--bridge-surface2, #2c2f33);
  font-size: .75rem; color: var(--bridge-muted, #99aab5);
}
.slow-mode.active { color: var(--bridge-yellow, #faa61a); }
.sm-bar {
  width: 48px; height: 4px; border-radius: 2px;
  background: var(--bridge-surface3, #393c40); overflow: hidden;
}
.sm-fill {
  height: 100%; border-radius: 2px;
  background: var(--bridge-yellow, #faa61a);
  transition: width 1s linear;
}
.sm-icon { font-size: .8rem; }
</style>
