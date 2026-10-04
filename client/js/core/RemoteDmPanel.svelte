<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { t, localeTag } from './i18n/reactive.svelte.ts';
  import { ApiResponseError, safeApiErrorMessage } from './api-error.ts';

  interface RemoteDm {
    id?: string;
    apId?: string;
    actorUrl: string;
    content: string;
    summary?: string | null;
    sensitive?: boolean;
    published?: number | string;
    updatedAt?: number | string | null;
  }

  let isVisible = $state(false);
  let isLoading = $state(false);
  let isSending = $state(false);
  let items = $state<RemoteDm[]>([]);
  let errorMsg = $state('');
  let successMsg = $state('');
  let actorUrl = $state('');
  let draft = $state('');
  let loadSeq = 0;

  const apiFetch = (url: string, options?: RequestInit): Promise<Response> => {
    const fn = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
    if (!fn) return Promise.reject(new Error(t('ui_guvenli_api_istemcisi_kullanilamiyor', 'Güvenli API istemcisi kullanılamıyor.')));
    return fn(url, options);
  };

  const apiBase = (): string => {
    const api = (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
    return api || location.origin;
  };

  function stamp(value: number | string | undefined): string {
    if (value === undefined) return '';
    const numeric = Number(value);
    const ms = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return new Date(ms).toLocaleString(localeTag(), {
      day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit',
    });
  }

  function actorLabel(value: string): string {
    try {
      const u = new URL(value);
      const tail = u.pathname.split('/').filter(Boolean).at(-1) || u.hostname;
      return `${tail}@${u.hostname}`;
    } catch {
      return value;
    }
  }

  async function load(): Promise<void> {
    const seq = ++loadSeq;
    isLoading = true;
    errorMsg = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/federation/remote-dms?limit=100&page=1`);
      if (seq !== loadSeq) return;
      if (!response.ok) throw new ApiResponseError(response);
      const body = await response.json() as { items?: unknown };
      if (seq !== loadSeq) return;
      if (!Array.isArray(body?.items)) throw new Error('Invalid remote DM response');
      items = body.items as RemoteDm[];
    } catch (error) {
      if (seq === loadSeq) {
        errorMsg = safeApiErrorMessage(error, t('remote_dm_load_failed', 'Federated mesajlar yüklenemedi.'), { report: true });
      }
    } finally {
      if (seq === loadSeq) isLoading = false;
    }
  }

  async function show(): Promise<void> {
    isVisible = true;
    successMsg = '';
    await load();
  }

  function hide(): void {
    isVisible = false;
    errorMsg = '';
    successMsg = '';
  }

  async function send(): Promise<void> {
    if (isSending) return;
    const target = actorUrl.trim();
    const content = draft.trim();
    if (!target || !content) {
      errorMsg = t('remote_dm_target_content_required', 'Uzak aktör adresi ve mesaj gerekli.');
      return;
    }
    isSending = true;
    errorMsg = '';
    successMsg = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/federation/remote-dms`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ actorUrl: target, content }),
      });
      if (!response.ok) throw new ApiResponseError(response);
      draft = '';
      successMsg = t('remote_dm_sent', 'Federated mesaj teslimat kuyruğuna alındı.');
    } catch (error) {
      errorMsg = safeApiErrorMessage(error, t('remote_dm_send_failed', 'Federated mesaj gönderilemedi.'), { report: true });
    } finally {
      isSending = false;
    }
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && isVisible) hide();
  }

  onMount(() => {
    BridgeRegistry.register('showRemoteDmPanel', show);
    BridgeRegistry.register('hideRemoteDmPanel', hide);
    window.addEventListener('keydown', onKeydown);
  });

  onDestroy(() => {
    loadSeq += 1;
    BridgeRegistry.unregister('showRemoteDmPanel');
    BridgeRegistry.unregister('hideRemoteDmPanel');
    window.removeEventListener('keydown', onKeydown);
  });
</script>

{#if isVisible}
  <div class="remote-dm-panel" role="dialog" aria-modal="true" aria-label={t('remote_dm_title', 'Federated direkt mesajlar')} use:focusTrap>
    <aside class="remote-dm-sidebar">
      <div class="remote-dm-heading">
        <h2>{t('remote_dm_title', 'Federated direkt mesajlar')}</h2>
        <button type="button" class="remote-dm-close" aria-label={t('close', 'Kapat')} onclick={hide}>×</button>
      </div>
      <p class="remote-dm-hint">{t('remote_dm_hint', 'Diğer ActivityPub sunucularından sana gelen özel mesajlar.')}</p>
      {#if isLoading}
        <p role="status">{t('loading', 'Yükleniyor…')}</p>
      {:else if items.length === 0}
        <p class="remote-dm-empty">{t('remote_dm_empty', 'Henüz federated özel mesaj yok.')}</p>
      {:else}
        <div class="remote-dm-list">
          {#each items as item (item.id || item.apId)}
            <article class="remote-dm-row">
              <div class="remote-dm-meta">
                <strong>{actorLabel(item.actorUrl)}</strong>
                <time>{stamp(item.published)}</time>
              </div>
              {#if item.sensitive && item.summary}<div class="remote-dm-summary">{item.summary}</div>{/if}
              <p>{item.content}</p>
            </article>
          {/each}
        </div>
      {/if}
    </aside>

    <section class="remote-dm-compose" aria-label={t('remote_dm_compose', 'Federated mesaj gönder')}>
      <h3>{t('remote_dm_compose', 'Federated mesaj gönder')}</h3>
      <label>
        <span>{t('remote_dm_actor_url', 'Uzak aktör adresi')}</span>
        <input bind:value={actorUrl} placeholder="https://example.social/users/alice" autocomplete="off" />
      </label>
      <label>
        <span>{t('dm_message', 'Mesaj')}</span>
        <textarea bind:value={draft} maxlength="5000" rows="7" placeholder={t('remote_dm_message_placeholder', 'Mesajını yaz…')}></textarea>
      </label>
      {#if errorMsg}<p class="remote-dm-error" role="alert">{errorMsg}</p>{/if}
      {#if successMsg}<p class="remote-dm-success" role="status">{successMsg}</p>{/if}
      <div class="remote-dm-actions">
        <button type="button" onclick={hide}>{t('cancel', 'İptal')}</button>
        <button type="button" class="primary" disabled={isSending} onclick={() => void send()}>
          {isSending ? t('dm_sending', 'Gönderiliyor…') : t('dm_send', 'Gönder')}
        </button>
      </div>
    </section>
  </div>
{/if}

<style>
  .remote-dm-panel{position:fixed;inset:0;z-index:1210;display:grid;grid-template-columns:minmax(280px,1fr) minmax(300px,420px);background:var(--surface-1);color:var(--text-primary)}
  .remote-dm-sidebar{min-width:0;padding:20px;background:var(--surface-2);border-right:1px solid var(--border-subtle);overflow:auto}
  .remote-dm-heading{display:flex;align-items:center;gap:12px}.remote-dm-heading h2{margin:0;flex:1;font-size:20px}.remote-dm-close{border:0;background:transparent;color:inherit;font-size:28px;cursor:pointer}
  .remote-dm-hint,.remote-dm-empty{color:var(--text-secondary)}.remote-dm-list{display:grid;gap:10px;margin-top:16px}
  .remote-dm-row{border:1px solid var(--border-subtle);border-radius:var(--radius-control);padding:12px;background:var(--surface-1)}
  .remote-dm-row p{white-space:pre-wrap;overflow-wrap:anywhere;margin:8px 0 0}.remote-dm-meta{display:flex;justify-content:space-between;gap:12px;color:var(--text-secondary);font-size:13px}.remote-dm-meta strong{color:var(--text-primary);overflow-wrap:anywhere}.remote-dm-summary{font-weight:600;margin-top:8px}
  .remote-dm-compose{padding:24px;display:flex;flex-direction:column;gap:16px;overflow:auto}.remote-dm-compose h3{margin:0}.remote-dm-compose label{display:grid;gap:6px}.remote-dm-compose input,.remote-dm-compose textarea{width:100%;box-sizing:border-box;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-2);color:var(--text-primary);padding:10px;font:inherit}.remote-dm-compose textarea{resize:vertical}
  .remote-dm-error{color:var(--danger-text);margin:0}.remote-dm-success{color:var(--success-text,var(--text-primary));margin:0}.remote-dm-actions{display:flex;justify-content:flex-end;gap:8px}.remote-dm-actions button{border:1px solid var(--border-subtle);border-radius:var(--radius-control);padding:9px 14px;background:var(--surface-2);color:inherit;cursor:pointer}.remote-dm-actions .primary{background:var(--accent);color:var(--accent-contrast,#fff);border-color:transparent}.remote-dm-actions button:disabled{opacity:.6;cursor:default}
  @media(max-width:700px){.remote-dm-panel{grid-template-columns:1fr;overflow:auto}.remote-dm-sidebar{border-right:0;border-bottom:1px solid var(--border-subtle)}.remote-dm-compose{padding:18px}}
</style>
