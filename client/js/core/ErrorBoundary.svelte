<!-- client/js/core/ErrorBoundary.svelte -->
<!-- Sprint 116 — error-boundary.ts (197 satır) → Svelte 5 Runes -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('ErrorBoundary');

  interface ErrorInfo { message: string; stack?: string; component?: string; ts: number; }

  let errors       = $state<ErrorInfo[]>([]);
  let showDevPanel = $state(false);
  let isDev        = $state(false);

  function captureError(err: unknown, component?: string) {
    const info: ErrorInfo = {
      message: err instanceof Error ? err.message : String(err),
      stack:   err instanceof Error ? err.stack : undefined,
      component,
      ts: Date.now(),
    };
    errors = [...errors, info].slice(-20); // max 20
    log.error('UI Error captured', info);

    // Report to Sentry if available
    const sentry = BridgeRegistry.get('sentry');
    if (sentry) sentry.captureException(err, { extra: { component } });
  }

  function clearErrors() { errors = []; }

  function onUnhandledRejection(e: PromiseRejectionEvent) {
    captureError(e.reason, 'Promise');
  }
  function onGlobalError(e: ErrorEvent) {
    captureError(e.error ?? e.message, 'Global');
  }

  onMount(() => {
    isDev = import.meta.env?.DEV === true || import.meta.env?.DEV === 'true' || window.location.hostname === 'localhost';
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    window.addEventListener('error', onGlobalError);
    BridgeRegistry.register('captureUIError', captureError);
    BridgeRegistry.register('clearUIErrors', clearErrors);
    return () => {
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      window.removeEventListener('error', onGlobalError);
    };
  });

  function fmt(ts: number) {
    return new Date(ts).toLocaleTimeString('tr-TR');
  }
</script>

<!-- Dev error panel -->
{#if isDev && errors.length > 0}
<div class="eb-dev-panel" role="log" aria-label="UI Hata Günlüğü">
  <div class="eb-dev-header">
    <span>⚠️ {errors.length} UI hatası</span>
    <button onclick={() => (showDevPanel = !showDevPanel)} aria-label="Toggle">
      {showDevPanel ? '▲' : '▼'}
    </button>
    <button onclick={clearErrors} aria-label="Temizle">✕</button>
  </div>
  {#if showDevPanel}
    <ul class="eb-dev-list">
      {#each errors as err (err.ts)}
        <li class="eb-dev-item">
          <span class="eb-time">{fmt(err.ts)}</span>
          {#if err.component}<span class="eb-comp">[{err.component}]</span>{/if}
          <span class="eb-msg">{err.message}</span>
        </li>
      {/each}
    </ul>
  {/if}
</div>
{/if}

<style>
.eb-dev-panel {
  position: fixed; bottom: 0; left: 0; right: 0;
  background: #1a0a0a; border-top: 2px solid #f04747;
  z-index: 99999; font-family: monospace; font-size: .75rem;
  max-height: 200px; overflow: auto;
}
.eb-dev-header {
  display: flex; align-items: center; gap: 8px;
  padding: 6px 12px; background: #2a0a0a; color: #f04747;
  position: sticky; top: 0;
}
.eb-dev-header button {
  background: none; border: none; cursor: pointer; color: #f04747;
}
.eb-dev-list { list-style: none; margin: 0; padding: 4px 0; }
.eb-dev-item { padding: 3px 12px; display: flex; gap: 8px; color: #ffaaaa; }
.eb-time { color: #888; flex-shrink: 0; }
.eb-comp { color: #ffcc66; flex-shrink: 0; }
.eb-msg  { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
</style>
