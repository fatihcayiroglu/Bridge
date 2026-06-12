<!-- client/js/core/TranslateButton.svelte -->
<!-- Sprint 116 — translate-btn.ts → Svelte 5 Runes -->
<script lang="ts">
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('TranslateButton');

  interface Props {
    messageId: string;
    content: string;
    targetLang?: string;
  }

  let { messageId, content, targetLang = 'tr' }: Props = $props();

  let isTranslated  = $state(false);
  let isLoading     = $state(false);
  let translated    = $state('');
  let error         = $state('');

  async function toggle() {
    if (isTranslated) { isTranslated = false; return; }
    if (translated) { isTranslated = true; return; }
    isLoading = true; error = '';
    try {
      const apiFetch = BridgeRegistry.get('apiFetch');
      const res = await apiFetch(`/api/messages/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messageId, content, targetLang }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      translated = data.translated;
      isTranslated = true;
    } catch (err) {
      error = 'Çeviri başarısız';
      log.error('Translation failed', err);
    } finally {
      isLoading = false;
    }
  }
</script>

<div class="translate-wrap">
  <button
    class="translate-btn"
    onclick={toggle}
    disabled={isLoading}
    aria-label={isTranslated ? 'Orijinali göster' : 'Çevir'}
    title={isTranslated ? 'Orijinali göster' : `${targetLang.toUpperCase()}'ye çevir`}
  >
    {#if isLoading}
      <span class="tl-spinner" aria-hidden="true"></span>
    {:else}
      🌐 {isTranslated ? 'Orijinal' : 'Çevir'}
    {/if}
  </button>
  {#if error}
    <span class="tl-error" role="alert">{error}</span>
  {/if}
  {#if isTranslated && translated}
    <div class="tl-result" lang={targetLang}>{translated}</div>
  {/if}
</div>

<style>
.translate-wrap { display: flex; flex-direction: column; gap: 4px; }
.translate-btn {
  display: inline-flex; align-items: center; gap: 4px;
  background: none; border: none; cursor: pointer;
  color: var(--bridge-muted, #99aab5); font-size: .75rem;
  padding: 2px 4px; border-radius: 4px; transition: color .12s;
}
.translate-btn:hover { color: var(--bridge-text, #fff); }
.translate-btn:disabled { opacity: .5; cursor: default; }
.tl-spinner {
  width: 10px; height: 10px; border-radius: 50%;
  border: 2px solid rgba(255,255,255,.3); border-top-color: #fff;
  animation: spin .6s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.tl-error  { font-size: .75rem; color: var(--bridge-danger, #f04747); }
.tl-result {
  font-size: .875rem; padding: 6px 10px; border-radius: 6px;
  background: var(--bridge-surface2, #2c2f33);
  border-left: 3px solid var(--bridge-blue, #2d9cdb);
  color: var(--bridge-text, #fff);
}
</style>
