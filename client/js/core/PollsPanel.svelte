<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.ts';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { createLogger } from './logger.ts';
  import { confirmProductAction } from './product-dialog.ts';

  const log = createLogger('PollsPanel');

  interface PollOption { id: string; text: string; voteCount: number; votedByMe: boolean }
  interface Poll {
    _id: string;
    channelId: string;
    question: string;
    options: PollOption[];
    multiSelect?: boolean;
    allowVoteChange?: boolean;
    expiresAt?: number | null;
    closed?: boolean;
    createdBy?: string;
  }
  interface Channel { _id?: string; name?: string; type?: string }
  interface SocketLike { on(event: string, handler: (payload: unknown) => void): unknown; off?(event: string, handler: (payload: unknown) => void): unknown }

  let visible = $state(false);
  let loading = $state(false);
  let saving = $state(false);
  let mutationBusy = $state('');
  let error = $state('');
  let polls = $state<Poll[]>([]);
  let question = $state('');
  let options = $state(['', '']);
  let multiSelect = $state(false);
  let allowVoteChange = $state(true);
  let duration = $state('1440');
  let channelId = $state('');
  let channelName = $state('');
  let selectedVotes = $state<Record<string, string[]>>({});
  let returnFocus: HTMLElement | null = null;
  let socket: SocketLike | null = null;

  function api() {
    return BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch') ?? null;
  }
  function currentChannel(): Channel | null {
    try { return BridgeRegistry.call<Channel | null>('getCurrentChannel') ?? null; } catch { return null; }
  }
  type PollAction = 'load' | 'create' | 'vote' | 'close' | 'delete';
  function safeError(status: number, action: PollAction): string {
    if (status === 403) return t("ui_bu_kanalda_bu_islem_icin_yetkin_yok", "Bu kanalda bu işlem için yetkin yok.");
    if (status === 404) return t("ui_kanal_veya_anket_artik_bulunamiyor", "Kanal veya anket artık bulunamıyor.");
    if (status === 409) return t("ui_anket_degisti_guncel_hali_yeniden_yuklendi", "Anket değişti. Güncel hali yeniden yüklendi.");
    if (status === 429) return t("ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_dene", "Çok hızlı işlem yapılıyor. Biraz sonra tekrar dene.");
    if (action === 'load') return t("ui_anketler_yuklenemedi", "Anketler yüklenemedi.");
    if (action === 'create') return t("ui_anket_olusturulamadi", "Anket oluşturulamadı.");
    if (action === 'close') return t("ui_anket_kapatilamadi", "Anket kapatılamadı.");
    if (action === 'delete') return t("ui_anket_silinemedi", "Anket silinemedi.");
    return t("ui_oy_kaydedilemedi", "Oy kaydedilemedi.");
  }
  function myUserId(): string {
    try {
      const me = BridgeRegistry.has('getMe') ? BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe') : null;
      return typeof me?._id === 'string' ? me._id : typeof me?.id === 'string' ? me.id : '';
    } catch { return ''; }
  }
  function normalize(raw: unknown): Poll | null {
    if (!raw || typeof raw !== 'object') return null;
    const row = raw as Record<string, unknown>;
    const id = typeof row._id === 'string' ? row._id : '';
    const q = typeof row.question === 'string' ? row.question : '';
    const rawOptions = Array.isArray(row.options) ? row.options : [];
    const normalized = rawOptions.map((value): PollOption | null => {
      if (!value || typeof value !== 'object') return null;
      const option = value as Record<string, unknown>;
      if (typeof option.id !== 'string' || typeof option.text !== 'string') return null;
      const voteCount = typeof option.voteCount === 'number' && Number.isSafeInteger(option.voteCount) && option.voteCount >= 0 ? option.voteCount : 0;
      return { id: option.id, text: option.text, voteCount, votedByMe: option.votedByMe === true };
    }).filter((v): v is PollOption => v !== null);
    if (!id || !q || normalized.length < 2) return null;
    return {
      _id: id,
      channelId: typeof row.channelId === 'string' ? row.channelId : '',
      question: q,
      options: normalized,
      multiSelect: row.multiSelect === true,
      allowVoteChange: row.allowVoteChange !== false,
      expiresAt: typeof row.expiresAt === 'number' ? row.expiresAt : null,
      closed: row.closed === true,
      createdBy: typeof row.createdBy === 'string' ? row.createdBy : undefined,
    };
  }

  // `keepError`: bir mutasyon reddedildikten sonraki ZORUNLU tazeleme, o
  // reddin kullaniciya gosterilen nedenini SILMEMELIDIR. Elle tazeleme,
  // acilis ve soket kaynakli tazelemeler eski hatayi temizlemeyi surdurur.
  async function load({ keepError = false }: { keepError?: boolean } = {}): Promise<void> {
    const fetcher = api();
    if (!fetcher || !channelId) { error = t("ui_anketler_su_anda_kullanilamiyor", "Anketler şu anda kullanılamıyor."); return; }
    loading = true; if (!keepError) error = '';
    try {
      const response = await fetcher(`/api/channels/${encodeURIComponent(channelId)}/polls`);
      if (!response.ok) { error = safeError(response.status, 'load'); polls = []; return; }
      const rows = await response.json() as unknown;
      polls = (Array.isArray(rows) ? rows : []).map(normalize).filter((p): p is Poll => p !== null);
      selectedVotes = Object.fromEntries(polls.map((poll) => [poll._id, poll.options.filter((option) => option.votedByMe).map((option) => option.id)]));
    } catch (err) {
      log.error('poll list load failed', err); error = t("ui_anketler_yuklenemedi", "Anketler yüklenemedi.");
    } finally { loading = false; }
  }

  function addOption(): void { if (options.length < 10) options = [...options, '']; }
  function removeOption(index: number): void { if (options.length > 2) options = options.filter((_, i) => i !== index); }
  function setOption(index: number, value: string): void { options = options.map((v, i) => i === index ? value : v); }

  async function createPoll(): Promise<void> {
    const fetcher = api();
    const cleaned = options.map(v => v.trim()).filter(Boolean);
    if (!fetcher || !channelId) return;
    if (!question.trim()) { error = t("ui_anket_sorusu_gerekli", "Anket sorusu gerekli."); return; }
    if (cleaned.length < 2) { error = t("ui_en_az_iki_secenek_gerekli", "En az iki seçenek gerekli."); return; }
    saving = true; error = '';
    try {
      const response = await fetcher(`/api/channels/${encodeURIComponent(channelId)}/polls`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: question.trim(), options: cleaned, multiSelect, allowVoteChange, duration: Number(duration) || 0 }),
      });
      if (!response.ok) { error = safeError(response.status, 'create'); return; }
      question = ''; options = ['', '']; multiSelect = false; allowVoteChange = true; duration = '1440';
      await load();
    } catch (err) { log.error('poll create failed', err); error = t("ui_anket_olusturulamadi", "Anket oluşturulamadı."); }
    finally { saving = false; }
  }

  function voteSelection(poll: Poll, optionId: string): void {
    const current = selectedVotes[poll._id] ?? [];
    if (poll.multiSelect) {
      selectedVotes = { ...selectedVotes, [poll._id]: current.includes(optionId) ? current.filter(id => id !== optionId) : [...current, optionId] };
    } else selectedVotes = { ...selectedVotes, [poll._id]: [optionId] };
  }

  async function submitVote(poll: Poll): Promise<void> {
    const fetcher = api();
    if (!fetcher || mutationBusy) return;
    const desired = selectedVotes[poll._id] ?? [];
    const current = poll.options.filter((option) => option.votedByMe).map((option) => option.id);
    const delta = [...new Set([...current.filter((id) => !desired.includes(id)), ...desired.filter((id) => !current.includes(id))])];
    if (!delta.length) return;
    mutationBusy = `vote:${poll._id}`; error = '';
    try {
      const removingAll = desired.length === 0 && current.length > 0;
      const response = await fetcher(`/api/polls/${encodeURIComponent(poll._id)}/vote`, removingAll
        ? { method: 'DELETE' }
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ optionIds: poll.multiSelect ? delta : desired }) });
      if (!response.ok) { error = safeError(response.status, 'vote'); await load({ keepError: true }); return; }
      const updated = normalize(await response.json());
      if (updated) {
        polls = polls.map(p => p._id === updated._id ? updated : p);
        selectedVotes = { ...selectedVotes, [poll._id]: updated.options.filter((option) => option.votedByMe).map((option) => option.id) };
      } else await load();
    } catch (err) { log.error('poll vote failed', err); error = t("ui_oy_kaydedilemedi", "Oy kaydedilemedi."); }
    finally { mutationBusy = ''; }
  }

  async function closePoll(poll: Poll): Promise<void> {
    const fetcher = api();
    if (!fetcher || mutationBusy || isClosed(poll)) return;
    mutationBusy = `close:${poll._id}`; error = '';
    try {
      const response = await fetcher(`/api/polls/${encodeURIComponent(poll._id)}/close`, { method: 'POST' });
      if (!response.ok) { error = safeError(response.status, 'close'); await load({ keepError: true }); return; }
      await load();
    } catch (err) { log.error('poll close failed', err); error = t("ui_anket_kapatilamadi", "Anket kapatılamadı."); }
    finally { mutationBusy = ''; }
  }

  async function deletePoll(poll: Poll): Promise<void> {
    if (mutationBusy) return;
    const confirmed = await confirmProductAction({
      title: t("ui_anketi_sil", "Anketi sil"),
      message: t("ui_bu_anketi_kalici_olarak_silmek_istiyor_musun", "Bu anketi kalıcı olarak silmek istiyor musun?"),
      confirmLabel: t("msg_action_delete", "Sil"),
      tone: 'danger',
    });
    if (!confirmed) return;
    const fetcher = api();
    if (!fetcher) return;
    mutationBusy = `delete:${poll._id}`; error = '';
    try {
      const response = await fetcher(`/api/polls/${encodeURIComponent(poll._id)}`, { method: 'DELETE' });
      if (!response.ok) { error = safeError(response.status, 'delete'); await load({ keepError: true }); return; }
      await load();
    } catch (err) { log.error('poll delete failed', err); error = t("ui_anket_silinemedi", "Anket silinemedi."); }
    finally { mutationBusy = ''; }
  }

  function totalVotes(poll: Poll): number { return poll.options.reduce((sum, opt) => sum + opt.voteCount, 0); }
  function percent(poll: Poll, option: PollOption): number { const total = totalVotes(poll); return total ? Math.round((option.voteCount / total) * 100) : 0; }
  function hasOwnVote(poll: Poll): boolean { return poll.options.some((option) => option.votedByMe); }
  function canChangeVote(poll: Poll): boolean { return !isClosed(poll) && (poll.allowVoteChange !== false || !hasOwnVote(poll)); }
  function isClosed(poll: Poll): boolean { return Boolean(poll.closed || (poll.expiresAt && poll.expiresAt <= Date.now())); }

  function open(): void {
    const channel = currentChannel();
    if (!channel?._id || String(channel.type ?? 'text').toLowerCase() !== 'text') {
      BridgeRegistry.call('toast', t("ui_anketler_icin_once_bir_metin_kanali_sec", "Anketler için önce bir metin kanalı seç."), 'error'); return;
    }
    closeExclusivePeers('polls');
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    channelId = channel._id; channelName = channel.name ?? t('ui_channel_fallback', 'kanal'); visible = true; void load();
  }
  function close(restore = true): void {
    visible = false; error = ''; selectedVotes = {};
    if (restore && returnFocus?.isConnected) queueMicrotask(() => returnFocus?.focus());
    returnFocus = null;
  }
  function onSocketEvent(payload: unknown): void {
    if (!visible || !payload || typeof payload !== 'object') return;
    const row = payload as Record<string, unknown>;
    const cid = typeof row.channelId === 'string' ? row.channelId : typeof (row.poll as Record<string, unknown> | undefined)?.channelId === 'string' ? String((row.poll as Record<string, unknown>).channelId) : '';
    if (!cid || cid === channelId) void load();
  }

  onMount(() => {
    BridgeRegistry.register('openPolls', open); BridgeRegistry.register('closePolls', close);
    socket = BridgeRegistry.get<SocketLike>('socket') ?? null;
    for (const event of ['poll:created', 'poll:updated', 'poll:deleted']) socket?.on(event, onSocketEvent);
  });
  onDestroy(() => {
    BridgeRegistry.unregister('openPolls'); BridgeRegistry.unregister('closePolls');
    for (const event of ['poll:created', 'poll:updated', 'poll:deleted']) socket?.off?.(event, onSocketEvent);
  });
</script>

{#if visible}
<div class="polls-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div class="polls-panel" role="dialog" aria-modal="true" tabindex="-1" aria-labelledby="polls-title" use:focusTrap={{ initialFocus: '.polls-close' }} onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}>
    <header><div><small>{t('markup_anketler_0f56aa6', "Anketler")}</small><h2 id="polls-title">#{channelName}</h2></div><button class="polls-close" type="button" onclick={() => close()} aria-label={t('attr_anketleri_kapat_e67b359', "Anketleri kapat")}>✕</button></header>
    <div class="polls-body">
      {#if error}<p class="poll-error" role="alert">{error}</p>{/if}
      <section class="poll-create" aria-labelledby="poll-create-title">
        <h3 id="poll-create-title">{t('markup_yeni_anket_d382f0f', "Yeni anket")}</h3>
        <input class="poll-input" maxlength="300" bind:value={question} placeholder={t('attr_ne_sormak_istiyorsun_a560f82', "Ne sormak istiyorsun?")} aria-label={t('attr_anket_sorusu_38b62d1', "Anket sorusu")} />
        <div class="poll-options-edit">
          {#each options as value, index}
            <div class="poll-option-edit"><input class="poll-input" maxlength="100" value={value} oninput={(e) => setOption(index, e.currentTarget.value)} placeholder={t('poll_option_number', undefined, { number: index + 1 })} aria-label={t('poll_option_number', undefined, { number: index + 1 })} />{#if options.length > 2}<button type="button" onclick={() => removeOption(index)} aria-label={t('poll_option_delete_aria', undefined, { number: index + 1 })}>✕</button>{/if}</div>
          {/each}
        </div>
        <div class="poll-create-actions"><button type="button" class="secondary" disabled={options.length >= 10 || saving} onclick={addOption}>{t("poll_add_option")}</button><label><input type="checkbox" bind:checked={multiSelect}/> {t("poll_multiple_choice")}</label><label><input type="checkbox" bind:checked={allowVoteChange}/> {t("poll_change_vote")}</label><select bind:value={duration} aria-label={t("poll_duration")}><option value="0">{t("poll_no_expiry")}</option><option value="60">{t('ui_1_saat')}</option><option value="1440">{t('markup_24_saat_475bfd0', "24 saat")}</option><option value="4320">{t("duration_3_days")}</option><option value="10080">{t("duration_7_days")}</option></select><button type="button" class="primary" disabled={saving} onclick={() => void createPoll()}>{saving ? t('ui_saving') : t("surface_anket_olustur_b1ea4a")}</button></div>
      </section>
      <section class="poll-list" aria-labelledby="poll-list-title"><div class="list-head"><h3 id="poll-list-title">{t('ui_kanal_anketleri')}</h3><button type="button" class="secondary" disabled={loading} onclick={() => void load()}>{loading ? t("loading") : t("markup_yenile_255b90e")}</button></div>
        {#if !loading && polls.length === 0}<p class="poll-muted">{t("poll_empty")}</p>{/if}
        {#each polls as poll (poll._id)}
          <article class="poll-card"><div class="poll-card-head"><strong>{poll.question}</strong><span>{isClosed(poll) ? t("ui_kapali") : t("ui_acik")} · {t('poll_votes_count', undefined, { count: totalVotes(poll) })}</span></div>
            <div class="poll-votes">
              {#each poll.options as option (option.id)}
                <label class:disabled={!canChangeVote(poll)}><input type={poll.multiSelect ? 'checkbox' : 'radio'} name={`poll-${poll._id}`} disabled={!canChangeVote(poll)} checked={(selectedVotes[poll._id] ?? []).includes(option.id)} onchange={() => voteSelection(poll, option.id)} /><span class="vote-copy"><span>{option.text}</span><small>{percent(poll, option)}% · {option.voteCount}</small></span></label>
              {/each}
            </div>
            {#if canChangeVote(poll)}<button type="button" class="primary vote-submit" disabled={Boolean(mutationBusy)} onclick={() => void submitVote(poll)}>{t('markup_oyu_kaydet_5a3a4f3', "Oyu kaydet")}</button>{:else if !isClosed(poll) && hasOwnVote(poll)}<p class="poll-muted vote-locked">{t("poll_vote_change_disabled")}</p>{/if}
            {#if poll.createdBy === myUserId()}<div class="poll-owner-actions">{#if !isClosed(poll)}<button type="button" class="secondary" disabled={Boolean(mutationBusy)} onclick={() => void closePoll(poll)}>{t('markup_anketi_kapat_9e943fb', "Anketi kapat")}</button>{/if}<button type="button" class="danger-action" disabled={Boolean(mutationBusy)} onclick={() => void deletePoll(poll)}>{t('ui_anketi_sil')}</button></div>{/if}
          </article>
        {/each}
      </section>
    </div>
  </div>
</div>
{/if}

<style>
.polls-overlay{position:fixed;inset:0;z-index:var(--layer-modal);display:grid;place-items:center;padding:24px;background:color-mix(in srgb,var(--bg-0) 82%,transparent);backdrop-filter:blur(8px)}
.polls-panel{width:min(760px,100%);max-height:min(760px,calc(var(--bridge-visual-viewport-height,100dvh) - 48px));display:flex;flex-direction:column;overflow:hidden;color:var(--text-primary);background:var(--bg-2);border:1px solid var(--border-strong);border-radius:var(--radius-modal);box-shadow:var(--shadow-xl)}
header,.list-head,.poll-card-head,.poll-create-actions,.poll-option-edit{display:flex;align-items:center} header{justify-content:space-between;padding:16px 18px;border-bottom:1px solid var(--border)} header small{color:var(--text-muted);text-transform:uppercase;font-weight:700;letter-spacing:.06em} header h2{margin:2px 0 0;font-size:var(--text-lg)} button,select,.poll-input{font:inherit}.polls-close,.secondary{color:var(--text-secondary);background:var(--bg-3);border:1px solid var(--border);border-radius:var(--radius-control);cursor:pointer}.polls-close{padding:6px 9px}.polls-body{padding:16px 18px 20px;overflow:auto}.poll-create,.poll-list{padding:14px;border:1px solid var(--border);border-radius:var(--radius-surface);background:var(--bg-1)}.poll-list{margin-top:14px}.poll-create h3,.poll-list h3{margin:0 0 10px;font-size:var(--text-base)}.poll-input,select{padding:9px 10px;color:var(--text-primary);background:var(--bg-input);border:1px solid var(--border);border-radius:var(--radius-control)}.poll-create>.poll-input{width:100%;box-sizing:border-box}.poll-options-edit{display:grid;gap:7px;margin-top:8px}.poll-option-edit{gap:6px}.poll-option-edit .poll-input{flex:1}.poll-option-edit button{border:0;background:transparent;color:var(--text-muted);cursor:pointer}.poll-create-actions{flex-wrap:wrap;gap:8px;margin-top:10px}.poll-create-actions label{display:flex;gap:5px;align-items:center;font-size:var(--text-sm);color:var(--text-secondary)}.primary{padding:8px 12px;color:var(--text-on-solid);background:var(--brand);border:0;border-radius:var(--radius-control);font-weight:700;cursor:pointer}.secondary{padding:7px 10px}.list-head{justify-content:space-between}.poll-card{margin-top:10px;padding:12px;border:1px solid var(--border);border-radius:var(--radius-surface);background:var(--bg-2)}.poll-card-head{justify-content:space-between;gap:10px}.poll-card-head span,.poll-muted{color:var(--text-muted);font-size:var(--text-sm)}.poll-votes{display:grid;gap:6px;margin-top:10px}.poll-votes label{display:flex;align-items:center;gap:8px;padding:8px;border-radius:var(--radius-control);background:var(--bg-3);cursor:pointer}.poll-votes label.disabled{cursor:default;opacity:.75}.vote-copy{display:flex;justify-content:space-between;gap:12px;width:100%}.vote-copy small{color:var(--text-muted)}.vote-submit{margin-top:9px}.vote-locked{margin:9px 0 0}.poll-owner-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:9px}.danger-action{padding:7px 10px;color:var(--danger);background:var(--danger-bg);border:1px solid color-mix(in srgb,var(--danger) 35%,var(--border));border-radius:var(--radius-control);font-weight:700;cursor:pointer}.poll-error{padding:9px 11px;margin:0 0 12px;color:var(--danger);background:var(--danger-bg);border-radius:var(--radius-control)}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}button:disabled{opacity:.55;cursor:not-allowed}@media(max-width:620px){.polls-overlay{padding:0}.polls-panel{max-height:none;height:var(--bridge-visual-viewport-height,100dvh);border-radius:0}header{padding-top:max(16px,env(safe-area-inset-top))}.polls-body{padding-bottom:max(20px,env(safe-area-inset-bottom))}.poll-card-head,.vote-copy{align-items:flex-start;flex-direction:column}.poll-create-actions{align-items:stretch;flex-direction:column}.poll-owner-actions{align-items:stretch;flex-direction:column}}
</style>
