<script lang="ts">
  import { onMount, onDestroy, tick } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { t } from './i18n/reactive.svelte.ts';
  import { createLogger } from './logger.js';
  import { ApiResponseError, safeApiErrorMessage } from './api-error.ts';

  const log = createLogger('RemoteDmPanel');

  interface RemoteUser {
    _id: string;
    username?: string;
    displayName?: string;
  }

  interface RemoteMessage {
    _id: string;
    dmId: string;
    userId: string;
    displayName?: string;
    content: string;
    createdAt?: number | string;
    direction?: 'in' | 'out';
  }

  interface RemoteConversation {
    _id: string;
    dmId: string;
    threadId: string;
    federated: true;
    actorUrl: string;
    other: RemoteUser;
    lastMessage?: RemoteMessage | null;
  }

  let isVisible = $state(false);
  let isLoading = $state(false);
  let isSending = $state(false);
  let loadingOlder = $state(false);
  let hasOlder = $state(false);
  let conversations = $state<RemoteConversation[]>([]);
  let active = $state<RemoteConversation | null>(null);
  let messages = $state<RemoteMessage[]>([]);
  let draft = $state('');
  let errorMsg = $state('');
  let messagesEl = $state<HTMLDivElement | null>(null);
  let requestSeq = 0;
  let shellButton: HTMLButtonElement | null = null;
  let shellObserver: MutationObserver | null = null;
  const PAGE_SIZE = 50;

  const apiFetch = (url: string, options?: RequestInit): Promise<Response> => {
    const fn = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
    if (!fn) return Promise.reject(new Error(t('ui_guvenli_api_istemcisi_kullanilamiyor', 'Güvenli API istemcisi kullanılamıyor.')));
    return fn(url, options);
  };

  const apiBase = (): string => {
    const api = (globalThis as { BRIDGE_API?: string }).BRIDGE_API;
    return api || location.origin;
  };

  const name = (conversation: RemoteConversation): string =>
    conversation.other.displayName || conversation.other.username || conversation.actorUrl;

  function initials(conversation: RemoteConversation): string {
    return name(conversation).replace(/^@/, '').slice(0, 2).toUpperCase();
  }

  function messageTime(value: number | string | undefined): string {
    if (value === undefined) return '';
    const numeric = Number(value);
    const ms = Number.isFinite(numeric) ? numeric : Date.parse(String(value));
    if (!Number.isFinite(ms) || ms <= 0) return '';
    return new Date(ms).toLocaleString();
  }

  async function loadConversations(): Promise<void> {
    const seq = ++requestSeq;
    isLoading = true;
    errorMsg = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/federation/remote-dms`);
      if (!response.ok) throw new ApiResponseError(response);
      const data = await response.json() as unknown;
      if (seq !== requestSeq) return;
      if (!Array.isArray(data)) throw new Error('Invalid remote DM list');
      conversations = data as RemoteConversation[];
    } catch (error) {
      if (seq === requestSeq) errorMsg = safeApiErrorMessage(error, t('dm_history_load_failed', 'Daha eski mesajlar yüklenemedi.'), { report: true });
    } finally {
      if (seq === requestSeq) isLoading = false;
    }
  }

  async function openConversation(conversation: RemoteConversation): Promise<void> {
    const seq = ++requestSeq;
    active = conversation;
    messages = [];
    draft = '';
    hasOlder = false;
    loadingOlder = false;
    errorMsg = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/federation/remote-dms/${encodeURIComponent(conversation.threadId)}/messages?limit=${PAGE_SIZE}`);
      if (!response.ok) throw new ApiResponseError(response);
      const data = await response.json() as unknown;
      if (seq !== requestSeq) return;
      if (!Array.isArray(data)) throw new Error('Invalid remote DM history');
      messages = data as RemoteMessage[];
      hasOlder = data.length >= PAGE_SIZE;
      await tick();
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (error) {
      if (seq === requestSeq) errorMsg = safeApiErrorMessage(error, t('dm_history_load_failed', 'Daha eski mesajlar yüklenemedi.'), { report: true });
    }
  }

  async function loadOlder(): Promise<void> {
    const conversation = active;
    const oldest = messages[0];
    if (!conversation || !oldest || loadingOlder || !hasOlder) return;
    const beforeNumber = Number(oldest.createdAt);
    const before = Number.isFinite(beforeNumber) ? beforeNumber : Date.parse(String(oldest.createdAt || ''));
    if (!Number.isFinite(before)) { hasOlder = false; return; }
    loadingOlder = true;
    const seq = requestSeq;
    try {
      const response = await apiFetch(`${apiBase()}/api/federation/remote-dms/${encodeURIComponent(conversation.threadId)}/messages?limit=${PAGE_SIZE}&before=${Math.max(0, Math.trunc(before))}`);
      if (!response.ok) throw new ApiResponseError(response);
      const data = await response.json() as unknown;
      if (seq !== requestSeq) return;
      if (!Array.isArray(data)) throw new Error('Invalid remote DM history');
      const known = new Set(messages.map(message => message._id));
      const older = (data as RemoteMessage[]).filter(message => !known.has(message._id));
      messages = [...older, ...messages];
      hasOlder = data.length >= PAGE_SIZE;
    } catch (error) {
      if (seq === requestSeq) errorMsg = safeApiErrorMessage(error, t('dm_history_load_failed', 'Daha eski mesajlar yüklenemedi.'), { report: true });
    } finally {
      if (seq === requestSeq) loadingOlder = false;
    }
  }

  async function sendMessage(): Promise<void> {
    const conversation = active;
    const draftAtSubmit = draft;
    const content = draftAtSubmit.trim();
    if (!conversation || !content || isSending) return;
    if (content.length > 2000) {
      errorMsg = t('message_too_long_max', 'Mesaj çok uzun (en fazla {max} karakter)', { max: 2000 });
      return;
    }
    const seq = requestSeq;
    isSending = true;
    errorMsg = '';
    const clientNonce = globalThis.crypto?.randomUUID?.() ?? `apdm-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    try {
      const response = await apiFetch(`${apiBase()}/api/federation/remote-dms/${encodeURIComponent(conversation.threadId)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, clientNonce }),
      });
      if (!response.ok) throw new ApiResponseError(response);
      const message = await response.json() as RemoteMessage;
      if (!message || typeof message._id !== 'string' || typeof message.content !== 'string') throw new Error('Invalid remote DM send response');
      conversations = conversations.map(item => item.threadId === conversation.threadId ? { ...item, lastMessage: message } : item);
      if (seq !== requestSeq || active?.threadId !== conversation.threadId) return;
      if (!messages.some(item => item._id === message._id)) messages = [...messages, message];
      if (draft === draftAtSubmit) draft = '';
      await tick();
      if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
    } catch (error) {
      if (seq === requestSeq && active?.threadId === conversation.threadId) {
        errorMsg = safeApiErrorMessage(error, t('dm_send_failed', 'Gönderilemedi.'), { report: true });
      }
    } finally {
      isSending = false;
    }
  }

  function openPanel(): void {
    BridgeRegistry.call('closeDmPanel');
    isVisible = true;
    active = null;
    messages = [];
    draft = '';
    void loadConversations();
  }

  function close(): void {
    requestSeq += 1;
    isVisible = false;
    active = null;
    messages = [];
    draft = '';
    errorMsg = '';
  }

  function back(): void {
    requestSeq += 1;
    active = null;
    messages = [];
    draft = '';
    errorMsg = '';
  }

  function onEscape(event: KeyboardEvent): void {
    if (event.key === 'Escape' && isVisible) close();
  }

  function installShellButton(): void {
    if (shellButton?.isConnected) return;
    const dmButton = document.querySelector<HTMLButtonElement>('[data-bridge-action="showDmPanel"]');
    if (!dmButton?.parentElement) return;
    const existing = document.querySelector<HTMLButtonElement>('[data-bridge-action="showRemoteDmPanel"]');
    if (existing) { shellButton = existing; return; }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = dmButton.className;
    button.dataset.bridgeAction = 'showRemoteDmPanel';
    const label = `${t('ui_open_direct_messages', 'Direkt mesajları aç')} · ActivityPub`;
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tip', label);
    button.innerHTML = '<svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3.5 9h17M3.5 15h17M12 3c2.3 2.5 3.5 5.5 3.5 9S14.3 18.5 12 21M12 3C9.7 5.5 8.5 8.5 8.5 12S9.7 18.5 12 21"/></svg>';
    button.addEventListener('click', openPanel);
    dmButton.insertAdjacentElement('afterend', button);
    shellButton = button;
  }

  onMount(() => {
    BridgeRegistry.register('showRemoteDmPanel', openPanel);
    installShellButton();
    shellObserver = new MutationObserver(installShellButton);
    shellObserver.observe(document.body, { childList: true, subtree: true });
    window.addEventListener('keydown', onEscape);
  });

  onDestroy(() => {
    BridgeRegistry.unregister('showRemoteDmPanel');
    shellObserver?.disconnect();
    shellObserver = null;
    window.removeEventListener('keydown', onEscape);
    if (shellButton) {
      shellButton.removeEventListener('click', openPanel);
      shellButton.remove();
      shellButton = null;
    }
    requestSeq += 1;
    log.info('RemoteDmPanel destroyed');
  });
</script>

{#if isVisible}
<div class="remote-dm-panel" class:conversation-open={Boolean(active)} role="dialog" aria-modal="true" aria-label={t('attr_direkt_mesajlar_676de62', 'Direkt mesajlar')} use:focusTrap>
  <aside class="remote-dm-sidebar">
    <div class="remote-dm-heading">
      <div><h2>{t('attr_direkt_mesajlar_676de62', 'Direkt mesajlar')}</h2><small>ActivityPub</small></div>
      <button type="button" aria-label={t('attr_dm_panelini_kapat_3725cce', 'DM panelini kapat')} onclick={close}>×</button>
    </div>
    {#if errorMsg}<p class="remote-dm-error" role="alert">{errorMsg}</p>{/if}
    {#if isLoading}
      <p class="remote-dm-muted">{t('sso_loading', 'Yükleniyor…')}</p>
    {:else if !conversations.length}
      <p class="remote-dm-muted">{t('dm_none', 'Henüz bir DM konuşmanız yok.')}</p>
    {/if}
    {#each conversations as conversation (conversation.threadId)}
      <button type="button" class="remote-dm-conversation" class:active={active?.threadId === conversation.threadId} onclick={() => void openConversation(conversation)}>
        <span class="remote-dm-avatar">{initials(conversation)}</span>
        <span class="remote-dm-person"><strong>{name(conversation)}</strong><small>{conversation.lastMessage?.content || conversation.actorUrl}</small></span>
      </button>
    {/each}
  </aside>
  <section class="remote-dm-chat" aria-label={t('dm_conversation', 'DM konuşması')}>
    {#if active}
      <header class="remote-dm-chat-header">
        <button type="button" class="remote-dm-back" aria-label={t('nav_back_dm_list')} onclick={back}>←</button>
        <span class="remote-dm-avatar">{initials(active)}</span>
        <span class="remote-dm-peer"><strong>{name(active)}</strong><small>{active.actorUrl}</small></span>
      </header>
      <div class="remote-dm-messages" bind:this={messagesEl} aria-live="polite">
        {#if hasOlder}<button type="button" class="remote-dm-older" disabled={loadingOlder} onclick={() => void loadOlder()}>{loadingOlder ? t('sso_loading', 'Yükleniyor…') : t('dm_load_older', 'Daha eski mesajları yükle')}</button>{/if}
        {#each messages as message (message._id)}
          <article class="remote-dm-message" class:outgoing={message.direction === 'out'}><div>
            <strong>{message.displayName || (message.direction === 'out' ? t('ui_bridge_user') : name(active))}</strong>
            {#if message.createdAt}<time>{messageTime(message.createdAt)}</time>{/if}
            <p>{message.content}</p>
          </div></article>
        {/each}
      </div>
      <form class="remote-dm-composer" onsubmit={(event) => { event.preventDefault(); void sendMessage(); }}>
        <textarea bind:value={draft} maxlength="2000" rows="1" placeholder={t('attr_mesaj_yaz_410bf7e', 'Mesaj yaz…')} aria-label={t('dm_message', 'DM mesajı')}></textarea>
        <button class="btn btn-primary" type="submit" disabled={!draft.trim() || isSending}>{isSending ? t('dm_sending', 'Gönderiliyor…') : t('dm_send', 'Gönder')}</button>
      </form>
    {:else}<div class="remote-dm-empty"><h3>{t('dm_private_convos', 'Özel konuşmalarınız')}</h3></div>{/if}
  </section>
</div>
{/if}

<style>
.remote-dm-panel{position:fixed;inset:0;z-index:var(--z-modal);display:grid;grid-template-columns:300px minmax(0,1fr);grid-template-rows:minmax(0,1fr);background:var(--surface-1);color:var(--text-primary)}
.remote-dm-sidebar{display:flex;flex-direction:column;min-width:0;padding:16px;background:var(--surface-2);border-right:1px solid var(--border-subtle);overflow:auto}.remote-dm-heading,.remote-dm-chat-header{display:flex;align-items:center;gap:10px}.remote-dm-heading>div{display:grid;gap:1px;flex:1}.remote-dm-heading h2{font-size:18px;margin:0}.remote-dm-heading small{color:var(--text-muted);font-size:11px}.remote-dm-heading button{border:0;background:transparent;color:inherit;font-size:24px;cursor:pointer}.remote-dm-muted,.remote-dm-person small,.remote-dm-peer small{color:var(--text-muted);font-size:12px}.remote-dm-error{color:var(--danger);font-size:12px}
.remote-dm-conversation{display:flex;align-items:center;gap:10px;border:0;background:transparent;color:inherit;padding:9px 6px;text-align:left;border-radius:var(--radius-control);cursor:pointer}.remote-dm-conversation:hover,.remote-dm-conversation.active{background:var(--surface-selected)}.remote-dm-avatar{display:grid;place-items:center;width:34px;height:34px;border-radius:50%;background:var(--brand);color:var(--text-on-solid);font-size:11px;font-weight:700;flex:none}.remote-dm-person,.remote-dm-peer{display:grid;min-width:0;flex:1}.remote-dm-person strong,.remote-dm-person small,.remote-dm-peer small{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.remote-dm-chat{display:grid;grid-template-rows:auto minmax(0,1fr) auto;min-width:0;min-height:0}.remote-dm-chat-header{padding:14px 16px;border-bottom:1px solid var(--border-subtle)}.remote-dm-back{display:none;border:0;background:transparent;color:inherit;font-size:20px;cursor:pointer}.remote-dm-messages{overflow:auto;padding:18px}.remote-dm-message{display:flex;margin:0 0 14px;max-width:78%}.remote-dm-message.outgoing{margin-inline-start:auto}.remote-dm-message>div{padding:9px 11px;border-radius:12px;background:var(--surface-2);min-width:0}.remote-dm-message.outgoing>div{background:var(--brand-subtle)}.remote-dm-message strong{font-size:12px}.remote-dm-message time{margin-inline-start:8px;color:var(--text-muted);font-size:11px}.remote-dm-message p{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}.remote-dm-older{display:block;margin:0 auto 14px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-2);color:inherit;padding:6px 12px;cursor:pointer}.remote-dm-composer{display:flex;gap:8px;padding:14px;border-top:1px solid var(--border-subtle)}.remote-dm-composer textarea{flex:1;resize:none;min-height:38px;padding:10px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-2);color:inherit;font:inherit}.remote-dm-composer .btn{flex:none;width:auto}.remote-dm-empty{display:grid;place-content:center;color:var(--text-muted)}
@media(max-width:700px){.remote-dm-panel{grid-template-columns:1fr;height:var(--bridge-visual-viewport-height,100dvh)}.remote-dm-chat{display:none}.remote-dm-panel.conversation-open .remote-dm-sidebar{display:none}.remote-dm-panel.conversation-open .remote-dm-chat{display:grid}.remote-dm-back{display:grid;place-items:center;width:40px;height:40px}.remote-dm-composer{padding-bottom:calc(10px + env(safe-area-inset-bottom))}.remote-dm-composer textarea,.remote-dm-composer button{min-height:44px}}
</style>