<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onDestroy, onMount } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';

  const log = createLogger('ForumChannel');
  type SortMode = 'latest' | 'new' | 'top';
  type ApiFetch = (url: string, init?: RequestInit) => Promise<Response>;
  type SocketLike = { on(event: string, handler: (payload: unknown) => void): void; off?(event: string, handler: (payload: unknown) => void): void };
  interface ThreadRow {
    _id: string;
    channelId: string;
    name: string;
    firstMessage: string;
    tags: string[];
    createdAt: number;
    lastMessageAt: number;
    messageCount: number;
    participantCount: number;
    pinned: boolean;
    locked: boolean;
  }

  let { active = false, channelId = '', channelName = '' }: { active?: boolean; channelId?: string; channelName?: string } = $props();
  let loading = $state(false);
  let creating = $state(false);
  let error = $state('');
  let threads = $state<ThreadRow[]>([]);
  let sort = $state<SortMode>('latest');
  let search = $state('');
  let tagFilter = $state('');
  let canManage = $state(false);
  let mutationBusy = $state('');
  let title = $state('');
  let firstMessage = $state('');
  let tagsText = $state('');
  let createOpen = $state(false);
  let loadedKey = '';
  let boundSocket: SocketLike | null = null;

  function api(): ApiFetch | null { return BridgeRegistry.get<ApiFetch>('apiFetch') ?? null; }
  function safeError(status: number, action: 'load' | 'create' | 'manage'): string {
    if (status === 403) return t("ui_bu_forumu_kullanma_yetkin_yok", "Bu forumu kullanma yetkin yok.");
    if (status === 404) return t("ui_forum_kanali_artik_bulunamiyor", "Forum kanalı artık bulunamıyor.");
    if (status === 429) return t("ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_dene", "Çok hızlı işlem yapılıyor. Biraz sonra tekrar dene.");
    if (action === 'manage') return t("ui_forum_iletisi_guncellenemedi", "Forum iletisi güncellenemedi.");
    return action === 'create' ? t("ui_forum_iletisi_olusturulamadi", "Forum iletisi oluşturulamadı.") : t("ui_forum_iletileri_yuklenemedi", "Forum iletileri yüklenemedi.");
  }
  function normalizeThread(value: unknown): ThreadRow | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row._id !== 'string' || typeof row.name !== 'string') return null;
    return {
      _id: row._id,
      channelId: typeof row.channelId === 'string' ? row.channelId : '',
      name: row.name,
      firstMessage: typeof row.firstMessage === 'string' ? row.firstMessage : '',
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string').slice(0, 5) : [],
      createdAt: Number(row.createdAt) || 0,
      lastMessageAt: Number(row.lastMessageAt) || Number(row.createdAt) || 0,
      messageCount: Math.max(0, Number(row.messageCount) || 0),
      participantCount: Math.max(0, Number(row.participantCount) || 0),
      pinned: Boolean(row.pinned),
      locked: Boolean(row.locked),
    };
  }
  function relativeTime(epoch: number): string {
    if (!epoch) return '';
    const delta = Math.max(0, Date.now() - epoch);
    if (delta < 60_000) return t("ui_az_once", "az önce");
    if (delta < 3_600_000) return t('rel_minutes_ago', '{count} dk önce', { count: Math.floor(delta / 60_000) });
    if (delta < 86_400_000) return t('rel_hours_ago', '{count} sa önce', { count: Math.floor(delta / 3_600_000) });
    return t('rel_days_ago', '{count} gün önce', { count: Math.floor(delta / 86_400_000) });
  }

  // `keepError`: reddedilen bir yönetim işleminden sonraki zorunlu tazeleme,
  // reddin NEDENİNİ silmemelidir. Aksi hâlde 403/404 yanıtları sessizce
  // yutulur ve kullanıcı işlemin neden olmadığını hiç göremez.
  async function load(keepError = false): Promise<void> {
    const fetcher = api();
    const requestedChannel = channelId;
    if (!active || !fetcher || !requestedChannel) return;
    loading = true; if (!keepError) error = '';
    try {
      const params = new URLSearchParams({ sort });
      if (search.trim()) params.set('search', search.trim().slice(0, 100));
      if (tagFilter) params.set('tag', tagFilter);
      const response = await fetcher(`/api/threads/channel/${encodeURIComponent(requestedChannel)}?${params}`);
      if (!response.ok) { error = safeError(response.status, 'load'); threads = []; canManage = false; return; }
      canManage = response.headers.get('X-Bridge-Forum-Can-Manage') === '1';
      const raw = await response.json() as unknown;
      if (!active || channelId !== requestedChannel) return;
      threads = (Array.isArray(raw) ? raw : []).map(normalizeThread).filter((thread): thread is ThreadRow => thread !== null);
    } catch (err) {
      log.error('forum load failed', err);
      if (active && channelId === requestedChannel) error = t("ui_forum_iletileri_yuklenemedi", "Forum iletileri yüklenemedi.");
    } finally { if (channelId === requestedChannel) loading = false; }
  }

  function parseTags(): string[] {
    return [...new Set(tagsText.split(',').map((tag) => tag.trim()).filter(Boolean))].slice(0, 5).map((tag) => tag.slice(0, 20));
  }
  async function createThread(): Promise<void> {
    const fetcher = api();
    const requestedChannel = channelId;
    if (!fetcher || !requestedChannel || creating) return;
    if (!title.trim()) { error = t("ui_ileti_basligi_gerekli", "İleti başlığı gerekli."); return; }
    creating = true; error = '';
    try {
      const response = await fetcher('/api/threads', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: requestedChannel, name: title.trim(), firstMessage: firstMessage.trim(), tags: parseTags() }),
      });
      const body = await response.json().catch(() => null) as { thread?: unknown } | null;
      if (!response.ok) { error = safeError(response.status, 'create'); return; }
      const created = normalizeThread(body?.thread);
      title = ''; firstMessage = ''; tagsText = ''; createOpen = false;
      await load();
      if (created) BridgeRegistry.call('openExistingThread', created._id, created.firstMessage);
    } catch (err) { log.error('forum create failed', err); error = t("ui_forum_iletisi_olusturulamadi", "Forum iletisi oluşturulamadı."); }
    finally { creating = false; }
  }

  async function setThreadState(thread: ThreadRow, kind: 'pin' | 'lock', desired: boolean): Promise<void> {
    const fetcher = api();
    if (!fetcher || !canManage || mutationBusy) return;
    mutationBusy = `${kind}:${thread._id}`; error = '';
    try {
      const response = await fetcher(`/api/threads/${encodeURIComponent(thread._id)}/${kind}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(kind === 'pin' ? { pinned: desired } : { locked: desired }),
      });
      if (!response.ok) { error = safeError(response.status, 'manage'); await load(true); return; }
      await load();
    } catch (err) { log.error(`forum ${kind} failed`, err); error = t("ui_forum_iletisi_guncellenemedi", "Forum iletisi güncellenemedi."); }
    finally { mutationBusy = ''; }
  }

  function openThread(thread: ThreadRow): void {
    BridgeRegistry.call('openExistingThread', thread._id, thread.firstMessage);
  }
  function onForumMutation(payload: unknown): void {
    if (!active) return;
    if (payload && typeof payload === 'object') {
      const cid = (payload as Record<string, unknown>).channelId;
      if (typeof cid === 'string' && cid !== channelId) return;
    }
    void load();
  }
  function bindSocket(): void {
    const next = BridgeRegistry.get<SocketLike>('socket') ?? null;
    if (next === boundSocket) return;
    if (boundSocket) for (const event of ['forum:thread:created', 'forum:thread:updated', 'forum:thread:deleted']) boundSocket.off?.(event, onForumMutation);
    boundSocket = next;
    if (boundSocket) for (const event of ['forum:thread:created', 'forum:thread:updated', 'forum:thread:deleted']) boundSocket.on(event, onForumMutation);
  }

  $effect(() => {
    const key = active && channelId ? `${channelId}:${sort}:${tagFilter}` : '';
    if (!key) { loadedKey = ''; threads = []; error = ''; return; }
    if (key !== loadedKey) { loadedKey = key; void load(); }
  });

  onMount(() => {
    bindSocket();
    document.addEventListener('bridge:socket-ready', bindSocket);
    document.addEventListener('bridge:socket-reconnected', bindSocket);
  });
  onDestroy(() => {
    if (boundSocket) for (const event of ['forum:thread:created', 'forum:thread:updated', 'forum:thread:deleted']) boundSocket.off?.(event, onForumMutation);
    document.removeEventListener('bridge:socket-ready', bindSocket);
    document.removeEventListener('bridge:socket-reconnected', bindSocket);
  });
</script>

{#if active}
<section class="forum-surface" aria-labelledby="forum-title">
  <header class="forum-header">
    <div class="forum-heading"><small>{t('markup_forum_cf1d2c9', "Forum")}</small><h2 id="forum-title">#{channelName || 'forum'}</h2></div>
    <button type="button" class="primary" onclick={() => { createOpen = !createOpen; error = ''; }}>{createOpen ? t("ccp_cancel") : t('forum_new_post_button', 'Yeni ileti')}</button>
  </header>

  <div class="forum-toolbar">
    <div class="sort-group" aria-label={t("forum_sort")}>
      <button type="button" class:active={sort === 'latest'} aria-pressed={sort === 'latest'} onclick={() => sort = 'latest'}>{t('markup_son_aktivite_525548d', "Son aktivite")}</button>
      <button type="button" class:active={sort === 'new'} aria-pressed={sort === 'new'} onclick={() => sort = 'new'}>{t('markup_en_yeni_cbadd34', "En yeni")}</button>
      <button type="button" class:active={sort === 'top'} aria-pressed={sort === 'top'} onclick={() => sort = 'top'}>{t('markup_en_aktif_8d48504', "En aktif")}</button>
    </div>
    <select class="tag-filter" bind:value={tagFilter} aria-label={t("forum_filter_tag")} onchange={() => void load()}>
      <option value="">{t("forum_all_tags")}</option>
      {#each [...new Set(threads.flatMap((thread) => thread.tags))].sort() as tag}<option value={tag}>{tag}</option>{/each}
    </select>
    <form class="forum-search" onsubmit={(event) => { event.preventDefault(); void load(); }}>
      <input maxlength="100" bind:value={search} placeholder={t('attr_forumda_ara_9550147', "Forumda ara")} aria-label={t('attr_forumda_ara_9550147', "Forumda ara")} />
      <button type="submit" class="secondary" disabled={loading}>{t('search')}</button>
    </form>
  </div>

  {#if createOpen}
    <section class="create-box" aria-labelledby="forum-create-title">
      <h3 id="forum-create-title">{t('markup_yeni_forum_iletisi_e4b33ab', "Yeni forum iletisi")}</h3>
      <input maxlength="100" bind:value={title} placeholder={t("forum_title")} aria-label={t("forum_post_title")} />
      <textarea maxlength="500" rows="4" bind:value={firstMessage} placeholder={t("forum_first_message_optional")} aria-label={t("forum_first_message")}></textarea>
      <input maxlength="120" bind:value={tagsText} placeholder={t("forum_tags_example")} aria-label={t('attr_etiketler_b0d9943', "Etiketler")} />
      <div class="create-actions"><small>{t('markup_en_fazla_5_etiket_a25038a', "En fazla 5 etiket.")}</small><button type="button" class="primary" disabled={creating} onclick={() => void createThread()}>{creating ? t("surface_olusturuluyor_8d7aee") : t("surface_iletiyi_olustur_ee618c")}</button></div>
    </section>
  {/if}

  {#if error}<p class="forum-error" role="alert">{error}</p>{/if}
  <div class="forum-list" aria-busy={loading}>
    {#if loading && threads.length === 0}<p class="forum-state" role="status">{t("forum_loading")}</p>
    {:else if !loading && threads.length === 0}<p class="forum-state">{t("forum_empty")}</p>{/if}
    {#each threads as thread (thread._id)}
      <article class="thread-card">
        <button type="button" class="thread-open" onclick={() => openThread(thread)}>
          <div class="thread-main">
            <div class="thread-title">{#if thread.pinned}<span aria-label={t("forum_pinned")}>📌</span>{/if}{#if thread.locked}<span aria-label={t('attr_kilitli_0457b3f', "Kilitli")}>🔒</span>{/if}<strong>{thread.name}</strong></div>
            {#if thread.firstMessage}<p>{thread.firstMessage}</p>{/if}
            {#if thread.tags.length}<div class="tags">{#each thread.tags as tag}<span>{tag}</span>{/each}</div>{/if}
          </div>
          <div class="thread-meta"><span>{t("ui_reply_count", undefined, { count: thread.messageCount })}</span><span>{t("ui_participant_count", undefined, { count: thread.participantCount || 1 })}</span><span>{relativeTime(thread.lastMessageAt)}</span></div>
        </button>
        {#if canManage}<div class="thread-manage" aria-label={t("ui_thread_moderation_aria", undefined, { thread: thread.name })}><button type="button" class="secondary" disabled={Boolean(mutationBusy)} onclick={() => void setThreadState(thread, 'pin', !thread.pinned)}>{thread.pinned ? t("surface_sabitlemeyi_kald_r_d7722a") : t("pin")}</button><button type="button" class="secondary" disabled={Boolean(mutationBusy)} onclick={() => void setThreadState(thread, 'lock', !thread.locked)}>{thread.locked ? t("surface_kilidi_ac_09e9f5") : t("ui_lock")}</button></div>{/if}
      </article>
    {/each}
  </div>
</section>
{/if}

<style>
  .forum-surface{display:flex;flex:1;min-width:0;min-height:0;flex-direction:column;color:var(--text-primary);background:var(--bg-1)}
  .forum-header,.forum-toolbar,.create-actions{display:flex;align-items:center;justify-content:space-between;gap:var(--space-3)}
  .forum-header{padding:var(--space-4) var(--space-5);border-bottom:1px solid var(--border)}
  .forum-heading small{color:var(--text-muted);font-size:var(--text-xs);font-weight:700;letter-spacing:.06em;text-transform:uppercase}.forum-heading h2{margin:2px 0 0;font-size:var(--type-title)}
  button,input,textarea,select{font:inherit}.primary,.secondary,.sort-group button{border-radius:var(--radius-control);cursor:pointer}.primary{padding:8px 12px;border:0;background:var(--brand);color:var(--text-on-solid);font-weight:700}.secondary,.sort-group button{padding:7px 10px;border:1px solid var(--border);background:var(--bg-3);color:var(--text-secondary)}
  .forum-toolbar{padding:var(--space-3) var(--space-5);border-bottom:1px solid var(--border);flex-wrap:wrap}.sort-group{display:flex;gap:var(--space-1)}.sort-group button.active{border-color:var(--brand);color:var(--text-primary);background:var(--brand-muted)}.forum-search{display:flex;gap:var(--space-2)}
  input,textarea{box-sizing:border-box;padding:9px 10px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--bg-input);color:var(--text-primary)}.forum-search input{width:min(260px,44vw)}
  .create-box{margin:var(--space-4) var(--space-5) 0;padding:var(--space-4);display:grid;gap:var(--space-2);border:1px solid var(--border);border-radius:var(--radius-surface);background:var(--bg-2)}.create-box h3{margin:0 0 var(--space-1);font-size:var(--text-base)}.create-actions small{color:var(--text-muted)}
  .forum-error{margin:var(--space-3) var(--space-5) 0;padding:9px 11px;border-radius:var(--radius-control);color:var(--danger);background:var(--danger-bg)}
  .forum-list{display:grid;gap:var(--space-2);padding:var(--space-4) var(--space-5) max(var(--space-5),env(safe-area-inset-bottom));overflow:auto}.forum-state{padding:var(--space-8);text-align:center;color:var(--text-muted)}
  .thread-card{display:flex;width:100%;align-items:flex-start;justify-content:space-between;gap:var(--space-4);padding:var(--space-4);text-align:left;border:1px solid var(--border);border-radius:var(--radius-surface);background:var(--bg-2);color:inherit;cursor:pointer}.thread-card:hover,.thread-card:focus-visible{border-color:var(--border-strong);background:var(--bg-3)}.thread-main{min-width:0}.thread-title{display:flex;align-items:center;gap:var(--space-1)}.thread-main p{margin:6px 0 0;max-width:70ch;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text-secondary);font-size:var(--text-sm)}.tags{display:flex;flex-wrap:wrap;gap:var(--space-1);margin-top:8px}.tags span{padding:2px 7px;border-radius:999px;background:var(--bg-4);color:var(--text-muted);font-size:var(--text-xs)}.thread-meta{display:flex;flex:0 0 auto;gap:var(--space-3);color:var(--text-muted);font-size:var(--text-xs)}
  button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}button:disabled{opacity:.55;cursor:not-allowed}
  @media(max-width:720px){.forum-header,.forum-toolbar{padding-left:var(--space-3);padding-right:var(--space-3)}.forum-search{width:100%}.forum-search input{flex:1;width:auto}.create-box{margin-left:var(--space-3);margin-right:var(--space-3)}.forum-list{padding-left:var(--space-3);padding-right:var(--space-3)}.thread-card{flex-direction:column}.thread-meta{flex-wrap:wrap}.thread-main p{white-space:normal;display:-webkit-box;-webkit-line-clamp:2;line-clamp:2;-webkit-box-orient:vertical}}
.tag-filter{padding:8px 10px;border:1px solid var(--border);border-radius:var(--radius-control);background:var(--bg-input);color:var(--text-primary)}.thread-open{display:flex;flex:1;min-width:0;width:100%;border:0;background:transparent;color:inherit;text-align:left;cursor:pointer}.thread-manage{display:flex;gap:6px;flex-wrap:wrap;padding:0 12px 12px}.thread-manage .secondary{padding:6px 9px}
</style>
