<!-- Production thread surface. Safe Svelte text rendering; no legacy HTML-string owner. -->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onDestroy, onMount, tick } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';

  type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;
  type SocketHandler = (payload: unknown) => void;
  type SocketLike = {
    emit(event: string, ...args: unknown[]): void;
    on(event: string, handler: SocketHandler): void;
    off(event: string, handler: SocketHandler): void;
  };
  interface ThreadRow {
    _id: string;
    parentMessageId?: string;
    channelId?: string;
    serverId?: string;
    name?: string;
    messageCount?: number;
    locked?: boolean;
  }
  interface ThreadMessage {
    _id: string;
    userId?: string;
    displayName?: string;
    avatarColor?: string;
    content?: string;
    createdAt?: number;
    editedAt?: number;
  }

  let visible = $state(false);
  let loading = $state(false);
  let loadingOlder = $state(false);
  let sending = $state(false);
  let error = $state('');
  let thread = $state<ThreadRow | null>(null);
  let messages = $state<ThreadMessage[]>([]);
  let hasOlder = $state(false);
  let draft = $state('');
  let parentPreview = $state('');
  let boundSocket: SocketLike | null = null;
  let returnFocus: HTMLElement | null = null;
  let retryNonce = '';
  let retryContent = '';
  let generation = 0;

  function api(): ApiFetch | null { return BridgeRegistry.get<ApiFetch>('apiFetch') ?? null; }
  function socket(): SocketLike | null { return BridgeRegistry.get<SocketLike>('socket') ?? null; }

  function currentUserId(): string {
    const me = BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe');
    return String(me?._id ?? me?.id ?? 'anonymous');
  }

  function draftKey(threadId: string): string {
    return `bridge:thread-draft:${currentUserId()}:${threadId}`;
  }

  function loadDraft(threadId: string): string {
    try { return localStorage.getItem(draftKey(threadId)) ?? ''; } catch { return ''; }
  }

  function persistDraft(): void {
    if (!thread?._id) return;
    try {
      if (draft) localStorage.setItem(draftKey(thread._id), draft);
      else localStorage.removeItem(draftKey(thread._id));
    } catch { /* storage may be unavailable */ }
  }

  function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  function safeNumber(value: unknown): number | undefined {
    if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
    if (typeof value !== 'string' || !value.trim()) return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  function safeMessage(value: unknown): ThreadMessage | null {
    const row = asRecord(value);
    if (!row) return null;
    const id = typeof row._id === 'string' ? row._id : '';
    if (!id) return null;
    return {
      _id: id,
      userId: typeof row.userId === 'string' ? row.userId : undefined,
      displayName: typeof row.displayName === 'string' ? row.displayName : t('unknown_user'),
      avatarColor: typeof row.avatarColor === 'string' ? row.avatarColor : undefined,
      content: typeof row.content === 'string' ? row.content : '',
      createdAt: safeNumber(row.createdAt),
      editedAt: safeNumber(row.editedAt),
    };
  }

  function mergeMessage(value: unknown): void {
    const msg = safeMessage(value);
    if (!msg || messages.some(existing => existing._id === msg._id)) return;
    messages = [...messages, msg].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
  }

  function bindSocket(): void {
    const next = socket();
    if (boundSocket === next) return;
    if (boundSocket) boundSocket.off('thread:message:new', onRealtimeMessage);
    boundSocket = next;
    boundSocket?.on('thread:message:new', onRealtimeMessage);
  }

  function onRealtimeMessage(payload: unknown): void {
    const event = asRecord(payload);
    if (!thread || !event || String(event.threadId ?? '') !== thread._id) return;
    mergeMessage(event.msg);
  }

  async function fetchMessages(prepend = false): Promise<void> {
    const fetcher = api();
    const active = thread;
    if (!fetcher || !active) return;
    if (prepend) loadingOlder = true; else loading = true;
    error = '';
    try {
      const oldest = prepend && messages.length ? messages[0]?.createdAt : undefined;
      const params = new URLSearchParams({ limit: '50' });
      if (oldest) params.set('before', String(oldest));
      const response = await fetcher(`/api/threads/${encodeURIComponent(active._id)}/messages?${params}`);
      if (!response.ok) {
        error = response.status === 403 ? t("ui_bu_thread_gecmisini_gorme_yetkiniz_yok", "Bu thread geçmişini görme yetkiniz yok.") : t("ui_thread_mesajlari_yuklenemedi", "Thread mesajları yüklenemedi.");
        return;
      }
      const body = await response.json() as unknown;
      if (thread?._id !== active._id || !Array.isArray(body)) return;
      const page = body.map(safeMessage).filter((m): m is ThreadMessage => Boolean(m));
      if (prepend) {
        const ids = new Set(messages.map(m => m._id));
        messages = [...page.filter(m => !ids.has(m._id)), ...messages];
      } else {
        messages = page;
      }
      hasOlder = page.length === 50;
    } catch {
      if (thread?._id === active._id) error = t("ui_thread_mesajlari_yuklenemedi", "Thread mesajları yüklenemedi.");
    } finally {
      if (prepend) loadingOlder = false; else loading = false;
    }
  }

  async function openExisting(threadId: string, preview = ''): Promise<void> {
    const fetcher = api();
    if (!fetcher || !threadId || threadId.length > 128) return;
    if (thread?._id && thread._id !== threadId) { persistDraft(); socket()?.emit('thread:leave', thread._id); thread = null; }
    const myGeneration = ++generation;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visible = true;
    loading = true;
    error = '';
    messages = [];
    parentPreview = preview.slice(0, 200);
    try {
      const response = await fetcher(`/api/threads/${encodeURIComponent(threadId)}`);
      const candidate = asRecord(await response.json().catch(() => null));
      if (generation !== myGeneration) return;
      if (!response.ok || !candidate) {
        error = response.status === 403 ? t("ui_bu_thread_gecmisini_gorme_yetkiniz_yok", "Bu thread geçmişini görme yetkiniz yok.")
          : response.status === 404 ? t("ui_thread_artik_bulunamiyor", "Thread artık bulunamıyor.") : t("ui_thread_acilamadi", "Thread açılamadı.");
        return;
      }
      const id = typeof candidate._id === 'string' ? candidate._id : '';
      if (!id) { error = t("ui_thread_acilamadi", "Thread açılamadı."); return; }
      thread = {
        _id: id,
        parentMessageId: typeof candidate.parentMessageId === 'string' ? candidate.parentMessageId : undefined,
        channelId: typeof candidate.channelId === 'string' ? candidate.channelId : undefined,
        serverId: typeof candidate.serverId === 'string' ? candidate.serverId : undefined,
        name: typeof candidate.name === 'string' ? candidate.name : t('ui_thread_label', 'Thread'),
        messageCount: Number(candidate.messageCount) || 0,
        locked: Boolean(candidate.locked),
      };
      if (!parentPreview && typeof candidate.firstMessage === 'string') parentPreview = candidate.firstMessage.slice(0, 200);
      draft = loadDraft(id);
      retryNonce = '';
      retryContent = '';
      bindSocket();
      socket()?.emit('thread:join', id);
      await fetchMessages(false);
      await tick();
      document.querySelector<HTMLTextAreaElement>('.thread-composer')?.focus();
    } catch {
      if (generation === myGeneration) error = t("ui_thread_acilamadi", "Thread açılamadı.");
    } finally {
      if (generation === myGeneration) loading = false;
    }
  }

  async function open(parentMessageId: string, preview = ''): Promise<void> {
    const fetcher = api();
    if (!fetcher || !parentMessageId || parentMessageId.length > 128) return;
    if (thread) { persistDraft(); socket()?.emit('thread:leave', thread._id); thread = null; }
    const myGeneration = ++generation;
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    visible = true;
    loading = true;
    error = '';
    messages = [];
    parentPreview = preview.slice(0, 200);
    try {
      const response = await fetcher('/api/threads', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentMessageId, name: preview.slice(0, 100) }),
      });
      const raw = asRecord(await response.json().catch(() => null));
      if (generation !== myGeneration) return;
      if (!response.ok && response.status !== 409) {
        error = response.status === 403
          ? t("ui_bu_mesajda_thread_acma_yetkiniz_yok", "Bu mesajda thread açma yetkiniz yok.")
          : response.status === 404 ? t("ui_mesaj_artik_bulunamiyor", "Mesaj artık bulunamıyor.") : t("ui_thread_acilamadi", "Thread açılamadı.");
        return;
      }
      const candidate = response.status === 409 ? asRecord(raw?.thread) : raw;
      const id = typeof candidate?._id === 'string' ? candidate._id : '';
      if (!candidate || !id) { error = t("ui_thread_acilamadi", "Thread açılamadı."); return; }
      thread = {
        _id: id,
        parentMessageId,
        channelId: typeof candidate.channelId === 'string' ? candidate.channelId : undefined,
        serverId: typeof candidate.serverId === 'string' ? candidate.serverId : undefined,
        name: typeof candidate.name === 'string' ? candidate.name : t('ui_thread_label', 'Thread'),
        messageCount: Number(candidate.messageCount) || 0,
        locked: Boolean(candidate.locked),
      };
      draft = loadDraft(id);
      retryNonce = '';
      retryContent = '';
      bindSocket();
      socket()?.emit('thread:join', id);
      await fetchMessages(false);
      await tick();
      document.querySelector<HTMLTextAreaElement>('.thread-composer')?.focus();
    } catch {
      if (generation === myGeneration) error = t("ui_thread_acilamadi", "Thread açılamadı.");
    } finally {
      if (generation === myGeneration) loading = false;
    }
  }

  function close(): void {
    generation += 1;
    if (thread) socket()?.emit('thread:leave', thread._id);
    persistDraft();
    visible = false;
    thread = null;
    messages = [];
    error = '';
    const target = returnFocus;
    returnFocus = null;
    setTimeout(() => target?.isConnected && target.focus(), 0);
  }

  function newNonce(): string {
    return typeof crypto?.randomUUID === 'function'
      ? crypto.randomUUID()
      : `thr-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  async function send(): Promise<void> {
    const fetcher = api();
    const active = thread;
    const content = draft.trim();
    if (!fetcher || !active || sending || !content || content.length > 2000 || active.locked) return;
    if (!retryNonce || retryContent !== content) {
      retryNonce = newNonce();
      retryContent = content;
    }
    sending = true;
    error = '';
    try {
      const response = await fetcher(`/api/threads/${encodeURIComponent(active._id)}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, clientNonce: retryNonce }),
      });
      const body = await response.json().catch(() => null) as unknown;
      if (thread?._id !== active._id) return;
      if (!response.ok) {
        error = response.status === 423 ? t("ui_bu_thread_kilitli", "Bu thread kilitli.")
          : response.status === 403 ? t("ui_bu_threade_mesaj_gonderme_yetkiniz_yok", "Bu thread’e mesaj gönderme yetkiniz yok.")
          : t("ui_yanit_gonderilemedi_metin_korundu_yeniden_deneyebili", "Yanıt gönderilemedi. Metin korundu; yeniden deneyebilirsiniz.");
        return;
      }
      mergeMessage(body);
      draft = '';
      persistDraft();
      retryNonce = '';
      retryContent = '';
    } catch {
      if (thread?._id === active._id) error = t("ui_yanit_gonderilemedi_metin_korundu_yeniden_deneyebili", "Yanıt gönderilemedi. Metin korundu; yeniden deneyebilirsiniz.");
    } finally {
      sending = false;
    }
  }

  function keydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') { event.preventDefault(); close(); return; }
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      void send();
    }
  }

  onMount(() => {
    BridgeRegistry.register('openThread', open);
    BridgeRegistry.register('openExistingThread', openExisting);
    BridgeRegistry.register('closeThread', close);
    bindSocket();
    document.addEventListener('bridge:socket-ready', bindSocket);
  });

  onDestroy(() => {
    persistDraft();
    if (thread) socket()?.emit('thread:leave', thread._id);
    if (boundSocket) boundSocket.off('thread:message:new', onRealtimeMessage);
    document.removeEventListener('bridge:socket-ready', bindSocket);
    BridgeRegistry.unregister('openThread');
    BridgeRegistry.unregister('openExistingThread');
    BridgeRegistry.unregister('closeThread');
  });
</script>

{#if visible}
  <!-- `<aside>` bir yer isareti ogesidir ve uzerine klavye/fare dinleyicisi
       konmasi Svelte tarafindan hakli olarak uyarilir. Bu yuzey aslinda
       MODAL OLMAYAN bir diyalogdur: sabit konumlu, Escape ile kapanan bir
       yan panel. `role="dialog"` + `tabindex="-1"` bunu dogru anlatir ve
       Escape dinleyicisinin odaklanabilir bir kapta durmasini saglar.
       `aria-modal` VERILMEZ: arkadaki icerik hala erisilebilir. -->
  <div class="thread-panel" role="dialog" tabindex="-1" aria-labelledby="thread-panel-title" onkeydown={keydown}>
    <header class="thread-header">
      <div class="thread-heading">
        <span aria-hidden="true">🧵</span>
        <div>
          <h2 id="thread-panel-title">{thread?.name || t('ui_thread_label')}</h2>
          {#if parentPreview}<p title={parentPreview}>{parentPreview}</p>{/if}
        </div>
      </div>
      <button type="button" class="thread-close" aria-label={t('attr_thread_i_kapat_ec7c2a6', "Thread’i kapat")} onclick={close}>✕</button>
    </header>

    <div class="thread-body" aria-busy={loading}>
      {#if hasOlder}
        <button type="button" class="load-older" disabled={loadingOlder} onclick={() => void fetchMessages(true)}>
          {loadingOlder ? t("loading") : t("surface_daha_eski_yan_tlar_yukle_454e5e")}
        </button>
      {/if}
      {#if loading && messages.length === 0}
        <p class="thread-state" role="status">{t("thread_loading")}</p>
      {:else if messages.length === 0 && !error}
        <p class="thread-state">{t("thread_empty_reply")}</p>
      {/if}
      {#each messages as message (message._id)}
        <article class="thread-message">
          <div class="thread-avatar" style:background={message.avatarColor || 'var(--bg-4)'}>{(message.displayName || '?').slice(0, 2).toUpperCase()}</div>
          <div class="thread-message-content">
            <div class="thread-meta">
              <strong>{message.displayName || t('unknown_user')}</strong>
              {#if message.createdAt}<time>{new Date(message.createdAt).toLocaleString()}</time>{/if}
              {#if message.editedAt}<span>{t("msg_edited")}</span>{/if}
            </div>
            <p>{message.content || ''}</p>
          </div>
        </article>
      {/each}
    </div>

    {#if error}<p class="thread-error" role="alert">{error}</p>{/if}

    <div class="thread-compose-wrap">
      <textarea
        class="thread-composer"
        rows="2"
        maxlength="2000"
        placeholder={thread?.locked ? 'Bu thread kilitli' : t("surface_thread_e_yan_tla_b9955c")}
        disabled={!thread || thread.locked || sending}
        bind:value={draft}
        oninput={persistDraft}
        aria-label={t("thread_reply_placeholder")}
      ></textarea>
      <button type="button" class="thread-send" disabled={!draft.trim() || sending || thread?.locked} onclick={() => void send()}>
        {sending ? t("dm_sending") : t("send")}
      </button>
    </div>
  </div>
{/if}

<style>
  .thread-panel { position: fixed; z-index: var(--layer-panel, 500); top: var(--app-titlebar-height, 0px); right: 0; bottom: 0; width: min(420px, 38vw); display: flex; flex-direction: column; background: var(--bg-2); border-left: 1px solid var(--border-subtle); box-shadow: var(--shadow-xl); color: var(--text-primary); }
  .thread-header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 58px; padding: 10px 12px 10px 16px; border-bottom: 1px solid var(--border-subtle); }
  .thread-heading { display: flex; gap: 10px; min-width: 0; align-items: flex-start; }
  .thread-heading h2 { margin: 0; font-size: 15px; line-height: 1.3; }
  .thread-heading p { max-width: 280px; margin: 3px 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: 11px; }
  .thread-close { width: 34px; height: 34px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); cursor: pointer; }
  .thread-close:hover, .thread-close:focus-visible { background: var(--bg-hover); color: var(--text-primary); }
  .thread-body { flex: 1; overflow: auto; padding: 8px 0 16px; min-height: 0; }
  .thread-message { display: flex; gap: 10px; padding: 8px 14px; }
  .thread-message:hover { background: var(--bg-hover); }
  .thread-avatar { width: 32px; height: 32px; flex: 0 0 32px; border-radius: 50%; display: grid; place-items: center; font-size: 11px; font-weight: 700; }
  .thread-message-content { min-width: 0; flex: 1; }
  .thread-meta { display: flex; align-items: baseline; gap: 7px; color: var(--text-muted); font-size: 10px; }
  .thread-meta strong { color: var(--text-primary); font-size: 12px; }
  .thread-message p { margin: 2px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 13px; line-height: 1.45; }
  .thread-state, .thread-error { margin: 14px; font-size: 12px; color: var(--text-muted); }
  .thread-error { color: var(--danger-text, #ff8f8f); }
  .load-older { display: block; margin: 6px auto 10px; border: 0; background: transparent; color: var(--brand); cursor: pointer; font-size: 12px; }
  .thread-compose-wrap { display: flex; align-items: flex-end; gap: 8px; padding: 10px 12px 12px; border-top: 1px solid var(--border-subtle); background: var(--bg-2); }
  .thread-composer { flex: 1; min-height: 40px; max-height: 120px; resize: vertical; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: 9px 10px; background: var(--bg-input); color: var(--text-primary); font: inherit; font-size: 13px; }
  .thread-send { min-height: 38px; padding: 0 12px; border: 0; border-radius: var(--radius-sm); background: var(--brand); color: var(--text-on-solid); cursor: pointer; font-weight: 600; }
  .thread-send:disabled { opacity: .5; cursor: not-allowed; }
  @media (max-width: 760px) {
    .thread-panel {
      top: 0; bottom: auto; width: 100%; max-width: none;
      height: var(--bridge-visual-viewport-height, 100dvh);
      border-left: 0;
    }
    .thread-header { padding-top: max(10px, env(safe-area-inset-top)); }
    .thread-close { width: 40px; height: 40px; }
    .thread-compose-wrap { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
    .thread-send { min-height: 44px; }
  }
</style>
