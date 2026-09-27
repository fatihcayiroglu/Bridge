<!-- P2 — production stage control-plane owner. No fake media claims. -->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';

  let { active = false, channelId = '', channelName = '' }: {
    active?: boolean;
    channelId?: string;
    channelName?: string;
  } = $props();

  interface StageUser {
    userId: string;
    displayName?: string;
    avatarColor?: string;
    muted?: boolean;
    handRaised?: boolean;
    speaking?: boolean;
  }
  interface StageState {
    channelId: string;
    speakers: StageUser[];
    listeners: StageUser[];
    topic: string;
    live: boolean;
  }
  interface StageAck { ok: boolean; code?: string; canManage?: boolean }
  interface SocketLike {
    on(event: string, handler: (payload: unknown) => void): void;
    off(event: string, handler: (payload: unknown) => void): void;
    emit(event: string, payload: unknown, ack?: (result: StageAck) => void): void;
  }

  let boundSocket = $state<SocketLike | null>(null);
  let joinedChannelId = $state('');
  let joining = $state(false);
  let leaving = $state(false);
  let handBusy = $state(false);
  let manuallyLeft = $state(false);
  let errorText = $state('');
  let canManage = $state(false);
  let moderationBusy = $state('');
  let topicDraft = $state('');
  let room = $state<StageState>({ channelId: '', speakers: [], listeners: [], topic: '', live: false });
  let reconcileSeq = 0;

  const myUserId = (): string => {
    const me = BridgeRegistry.call<{ _id?: string; id?: string } | null>('getMe')
      ?? (globalThis as { currentUser?: { _id?: string; id?: string } }).currentUser
      ?? null;
    return String(me?._id ?? me?.id ?? '');
  };

  const me = $derived([...room.speakers, ...room.listeners].find(user => user.userId === myUserId()) ?? null);
  const myRole = $derived(room.speakers.some(user => user.userId === myUserId()) ? 'speaker' : 'listener');
  const handRaised = $derived(Boolean(me?.handRaised));

  function boundedError(code?: string): string {
    if (code === 'STAGE_UNAVAILABLE') return t("ui_bu_sahneye_katilamadin", "Bu sahneye katılamadın.");
    if (code === 'STAGE_ROLE_REJECTED') return t("ui_sahnedeki_rolun_ayarlanamadi", "Sahnedeki rolün ayarlanamadı.");
    if (code === 'STAGE_ACTION_REJECTED') return t("ui_sahne_islemi_tamamlanamadi", "Sahne işlemi tamamlanamadı.");
    return t("ui_sahne_baglantisi_tamamlanamadi_tekrar_deneyebilirsin", "Sahne bağlantısı tamamlanamadı. Tekrar deneyebilirsin.");
  }

  function emitAck(event: string, payload: unknown, timeoutMs = 5000): Promise<StageAck> {
    const socket = boundSocket;
    if (!socket) return Promise.resolve({ ok: false, code: 'SOCKET_UNAVAILABLE' });
    return new Promise(resolve => {
      let settled = false;
      const timer = globalThis.setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, code: 'TIMEOUT' });
      }, timeoutMs);
      try {
        socket.emit(event, payload, result => {
          if (settled) return;
          settled = true;
          globalThis.clearTimeout(timer);
          resolve(result && typeof result.ok === 'boolean' ? result : { ok: false });
        });
      } catch {
        globalThis.clearTimeout(timer);
        settled = true;
        resolve({ ok: false, code: 'SOCKET_UNAVAILABLE' });
      }
    });
  }

  function resetRoom(nextChannelId = ''): void {
    room = { channelId: nextChannelId, speakers: [], listeners: [], topic: '', live: false };
  }

  function onState(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const data = payload as Partial<StageState>;
    if (typeof data.channelId !== 'string' || data.channelId !== channelId) return;
    room = {
      channelId: data.channelId,
      speakers: Array.isArray(data.speakers) ? data.speakers.filter(validStageUser) : [],
      listeners: Array.isArray(data.listeners) ? data.listeners.filter(validStageUser) : [],
      topic: typeof data.topic === 'string' ? data.topic.slice(0, 200) : '',
      live: data.live === true,
    };
    topicDraft = room.topic;
  }

  function validStageUser(value: unknown): value is StageUser {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value)
      && typeof (value as { userId?: unknown }).userId === 'string');
  }

  function onHandRaise(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const data = payload as { channelId?: unknown; userId?: unknown; raised?: unknown };
    if (data.channelId !== channelId || typeof data.userId !== 'string' || typeof data.raised !== 'boolean') return;
    const patch = (users: StageUser[]) => users.map(user => user.userId === data.userId ? { ...user, handRaised: data.raised as boolean } : user);
    room = { ...room, speakers: patch(room.speakers), listeners: patch(room.listeners) };
  }

  function onTopic(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const data = payload as { channelId?: unknown; topic?: unknown };
    if (data.channelId === channelId && typeof data.topic === 'string') {
      room = { ...room, topic: data.topic.slice(0, 200) };
      topicDraft = room.topic;
    }
  }

  function onLive(payload: unknown): void {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    const data = payload as { channelId?: unknown; live?: unknown };
    if (data.channelId === channelId && typeof data.live === 'boolean') room = { ...room, live: data.live };
  }

  function bindSocket(): void {
    const next = BridgeRegistry.get<SocketLike>('socket') ?? null;
    if (next === boundSocket) return;
    unbindSocket();
    boundSocket = next;
    boundSocket?.on('stage:state', onState);
    boundSocket?.on('stage:handRaise', onHandRaise);
    boundSocket?.on('stage:topicUpdate', onTopic);
    boundSocket?.on('stage:liveUpdate', onLive);
    if (active && channelId && !manuallyLeft) void reconcileStage();
  }

  function unbindSocket(): void {
    boundSocket?.off('stage:state', onState);
    boundSocket?.off('stage:handRaise', onHandRaise);
    boundSocket?.off('stage:topicUpdate', onTopic);
    boundSocket?.off('stage:liveUpdate', onLive);
    boundSocket = null;
  }

  function wantedChannel(): string {
    return active && channelId && !manuallyLeft ? channelId : '';
  }

  async function reconcileStage(): Promise<void> {
    const wanted = wantedChannel();

    // ── KAPATILAN GERÇEK KUSUR: UÇUŞTAKİ KATILIMIN İPTALİ ────────────────
    // `reconcileSeq` bir YARIŞ KORUMASIDIR: geciken bir yanıtın, arada
    // değişmiş hedefi ezmesini engeller. Ama sayaç, çağrının HİÇBİR ŞEY
    // YAPMAYACAĞI durumda da artırılıyordu.
    //
    // Panel açılışında uzlaştırma İKİ KEZ tetiklenir (`onMount` → `bindSocket`
    // ve bağımlılık `$effect`'i). İkinci çağrı `joining` açık olduğu için
    // hemen dönüyordu — ama sayacı çoktan artırmıştı. Bu yüzden UÇUŞTAKİ
    // `stage:join` yanıtı geldiğinde `seq !== reconcileSeq` oluyor, katılım
    // geçersiz sayılıyor ve telafi amaçlı bir `stage:leave` gönderiliyordu.
    //
    // SONUÇ: sahneye katılım sunucuda açılıp hemen kapanıyor, kullanıcı
    // sahnede GÖRÜNMÜYORDU. Ölçüm: mount sonrası yayılan olaylar
    // `stage:join` → `stage:leave`; `stage:setRole` HİÇ gönderilmiyordu.
    //
    // Kural: sayaç yalnızca gerçekten bir işlem yapacak çağrıda artar.
    const mustLeavePrevious = Boolean(joinedChannelId) && joinedChannelId !== wanted;
    const mustJoin = Boolean(wanted) && joinedChannelId !== wanted && !joining && Boolean(boundSocket);
    if (!mustLeavePrevious && !mustJoin) return;

    const seq = ++reconcileSeq;

    if (joinedChannelId && joinedChannelId !== wanted) {
      const previous = joinedChannelId;
      const result = await emitAck('stage:leave', { channelId: previous });
      if (seq !== reconcileSeq) return;
      if (result.ok) {
        joinedChannelId = '';
        canManage = false;
        resetRoom(wanted);
      } else if (wanted) {
        errorText = t("ui_onceki_sahne_oturumu_kapatilamadi_tekrar_deneyebilir", "Önceki sahne oturumu kapatılamadı. Tekrar deneyebilirsin.");
        return;
      }
    }

    if (!wanted || joinedChannelId === wanted || joining || !boundSocket) return;
    joining = true;
    errorText = '';
    const startedFor = wanted;
    try {
      const joined = await emitAck('stage:join', { channelId: wanted });
      if (seq !== reconcileSeq || wanted !== channelId || !active) {
        if (joined.ok) void emitAck('stage:leave', { channelId: wanted });
        return;
      }
      if (!joined.ok) {
        errorText = boundedError(joined.code);
        return;
      }

      const role = await emitAck('stage:setRole', { channelId: wanted, role: 'listener' });
      if (seq !== reconcileSeq || wanted !== channelId || !active) {
        void emitAck('stage:leave', { channelId: wanted });
        return;
      }
      if (!role.ok) {
        void emitAck('stage:leave', { channelId: wanted });
        errorText = boundedError(role.code);
        return;
      }
      joinedChannelId = wanted;
      canManage = joined.canManage === true;
    } finally {
      if (seq === reconcileSeq) joining = false;
      // Hedef, istek uçarken DEĞİŞTİYSE (kanal geçişi / elle ayrılma) tek bir
      // yeniden uzlaştırma planlanır; `joining` artık kapalı olduğu için bu
      // çağrı erken dönmez. Yalnız hedef değiştiğinde planlanır: başarısız bir
      // katılımı sonsuz döngüye çevirmez.
      if (seq === reconcileSeq && wantedChannel() !== startedFor) {
        queueMicrotask(() => { void reconcileStage(); });
      }
    }
  }

  async function toggleHand(): Promise<void> {
    if (!joinedChannelId || handBusy) return;
    handBusy = true;
    errorText = '';
    const next = !handRaised;
    const result = await emitAck('stage:handRaise', { channelId: joinedChannelId, raised: next });
    if (!result.ok) errorText = boundedError(result.code);
    handBusy = false;
  }

  async function runModeration(event: 'stage:promote' | 'stage:demote', targetUserId: string): Promise<void> {
    if (!canManage || !joinedChannelId || moderationBusy) return;
    moderationBusy = `${event}:${targetUserId}`;
    errorText = '';
    const result = await emitAck(event, { channelId: joinedChannelId, targetUserId });
    if (!result.ok) errorText = boundedError(result.code);
    moderationBusy = '';
  }

  async function saveTopic(): Promise<void> {
    if (!canManage || !joinedChannelId || moderationBusy) return;
    const topic = topicDraft.trim().slice(0, 200);
    moderationBusy = 'topic';
    errorText = '';
    const result = await emitAck('stage:setTopic', { channelId: joinedChannelId, topic });
    if (!result.ok) errorText = boundedError(result.code);
    moderationBusy = '';
  }

  async function toggleLive(): Promise<void> {
    if (!canManage || !joinedChannelId || moderationBusy) return;
    moderationBusy = 'live';
    errorText = '';
    const result = await emitAck('stage:setLive', { channelId: joinedChannelId, live: !room.live });
    if (!result.ok) errorText = boundedError(result.code);
    moderationBusy = '';
  }

  async function leaveStage(): Promise<void> {
    if (!joinedChannelId || leaving) return;
    leaving = true;
    errorText = '';
    const leavingId = joinedChannelId;
    const result = await emitAck('stage:leave', { channelId: leavingId });
    if (result.ok) {
      manuallyLeft = true;
      joinedChannelId = '';
      canManage = false;
      resetRoom(channelId);
    } else {
      errorText = t("ui_sahneden_ayrilma_tamamlanamadi_tekrar_deneyebilirsin", "Sahneden ayrılma tamamlanamadı. Tekrar deneyebilirsin.");
    }
    leaving = false;
  }

  function retryJoin(): void {
    manuallyLeft = false;
    errorText = '';
    void reconcileStage();
  }

  function onChannelSelected(): void {
    const current = BridgeRegistry.call<{ _id?: string; type?: string } | null>('getCurrentChannel');
    if (active && current?._id === channelId && current?.type === 'stage' && manuallyLeft) retryJoin();
  }

  onMount(() => {
    document.addEventListener('bridge:socket-ready', bindSocket);
    document.addEventListener('bridge:socket-reconnected', bindSocket);
    document.addEventListener('bridge:channel-selected', onChannelSelected);
    bindSocket();
  });

  $effect(() => {
    const nextActive = active;
    const nextChannelId = channelId;
    queueMicrotask(() => {
      if (!nextActive) manuallyLeft = false;
      // Keep reconciliation dependency-scoped to the selected stage. Internal
      // join/hand/state mutations must not recursively trigger another join.
      if (nextChannelId === channelId) void reconcileStage();
    });
  });

  onDestroy(() => {
    reconcileSeq += 1;
    const leavingId = joinedChannelId;
    if (leavingId && boundSocket) {
      try { boundSocket.emit('stage:leave', { channelId: leavingId }); } catch { /* teardown best effort */ }
    }
    document.removeEventListener('bridge:socket-ready', bindSocket);
    document.removeEventListener('bridge:socket-reconnected', bindSocket);
    document.removeEventListener('bridge:channel-selected', onChannelSelected);
    unbindSocket();
  });
</script>

{#if active}
  <section class="stage-session" aria-labelledby="stage-session-title" aria-busy={joining || leaving}>
    <header class="stage-head">
      <div class="stage-head-copy">
        <div class="stage-kicker">
          <span class:live={room.live} class="stage-live-dot" aria-hidden="true"></span>
          {room.live ? t('stage_live_label') : t('channel_stage')}
        </div>
        <h2 id="stage-session-title">{channelName ? `#${channelName}` : t('channel_stage')}</h2>
        <p>{room.topic || t("surface_topluluk_konusmas_a23015")}</p>
      </div>
      {#if joinedChannelId}
        <button class="stage-secondary danger" type="button" onclick={leaveStage} disabled={leaving}>
          {leaving ? t("surface_ayr_l_yor_91fb11") : t("surface_sahneden_ayr_l_70db94")}
        </button>
      {/if}
    </header>

    {#if errorText}
      <div class="stage-error" role="alert">
        <span>{errorText}</span>
        {#if !joinedChannelId}<button type="button" onclick={retryJoin}>{t('retry')}</button>{/if}
      </div>
    {/if}

    {#if canManage && joinedChannelId}
      <section class="stage-admin" aria-label={t("stage_management")}>
        <label class="topic-field">
          <span>{t('markup_konu_34b31d7', "Konu")}</span>
          <input bind:value={topicDraft} maxlength="200" placeholder={t('stage_topic_placeholder')} />
        </label>
        <button class="stage-secondary" type="button" onclick={saveTopic} disabled={Boolean(moderationBusy)}>{t('markup_konuyu_kaydet_569b862', "Konuyu kaydet")}</button>
        <button class="stage-secondary" type="button" onclick={toggleLive} disabled={Boolean(moderationBusy)} aria-pressed={room.live}>
          {moderationBusy === 'live' ? t("surface_guncelleniyor_7331f7") : room.live ? t("surface_canl_y_bitir_d2be5c") : t("surface_canl_olarak_isaretle_6d1c8e")}
        </button>
      </section>
    {/if}

    {#if joining}
      <div class="stage-state" role="status">{t("stage_joining_listener")}</div>
    {:else if manuallyLeft && !joinedChannelId}
      <div class="stage-state">
        <strong>{t("stage_left")}</strong>
        <span>{t("stage_rejoin_hint")}</span>
        <button class="stage-primary" type="button" onclick={retryJoin}>{t("stage_join_listener")}</button>
      </div>
    {:else if joinedChannelId}
      <div class="stage-grid">
        <div class="stage-column stage-speakers">
          <div class="stage-section-title">
            <h3>{t("stage_speakers")}</h3>
            <span>{room.speakers.length}</span>
          </div>
          {#if room.speakers.length === 0}
            <div class="stage-empty">{t("stage_no_speakers")}</div>
          {:else}
            <div class="speaker-grid">
              {#each room.speakers as user (user.userId)}
                <div class:speaking={user.speaking} class="speaker-card">
                  <span class="stage-avatar" style={`--stage-avatar:${/^#[0-9a-f]{3,8}$/i.test(user.avatarColor ?? '') ? user.avatarColor : 'var(--brand)'}`}>
                    {(user.displayName || '?').slice(0, 1).toUpperCase()}
                  </span>
                  <span class="speaker-name">{user.displayName || t("adm_user")}</span>
                  <span class="speaker-state">{user.muted ? t("surface_mikrofon_kapal_7a9f4a") : user.speaking ? t("surface_konusuyor_895d48") : t("surface_konusmac_4a103d")}</span>
                  {#if canManage && user.userId !== myUserId()}
                    <button class="stage-inline" type="button" onclick={() => runModeration('stage:demote', user.userId)} disabled={Boolean(moderationBusy)}>{t('markup_dinleyici_yap_a21dfc4', "Dinleyici yap")}</button>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </div>

        <aside class="stage-column stage-audience" aria-label={t('markup_dinleyiciler_2fd93a0', "Dinleyiciler")}>
          <div class="stage-section-title">
            <h3>{t('markup_dinleyiciler_2fd93a0', "Dinleyiciler")}</h3>
            <span>{room.listeners.length}</span>
          </div>
          {#if room.listeners.length === 0}
            <div class="stage-empty">{t("stage_no_listeners")}</div>
          {:else}
            <div class="listener-list">
              {#each room.listeners as user (user.userId)}
                <div class="listener-row">
                  <span class="listener-name">{user.displayName || t("adm_user")}</span>
                  <span class="listener-actions">
                    {#if user.handRaised}<span class="hand-badge" title={t("stage_hand_raised")}>✋</span>{/if}
                    {#if canManage && user.userId !== myUserId()}
                      <button class="stage-inline" type="button" onclick={() => runModeration('stage:promote', user.userId)} disabled={Boolean(moderationBusy)}>{t("stage_make_speaker")}</button>
                    {/if}
                  </span>
                </div>
              {/each}
            </div>
          {/if}
        </aside>
      </div>

      <footer class="stage-controls">
        <div class="stage-role">
          <strong>{myRole === 'speaker' ? t("surface_konusmac_4a103d") : t('stage_role_listener', 'Dinleyici')}</strong>
          <span>{myRole === 'speaker' ? t("surface_sahne_rolun_sunucu_taraf_ndan_yonetiliyor_5bd123") : t("surface_soz_almak_icin_el_kald_rabilirsin_ae919d")}</span>
        </div>
        {#if myRole === 'listener'}
          <button class:active={handRaised} class="stage-primary" type="button" onclick={toggleHand} disabled={handBusy} aria-pressed={handRaised}>
            {handBusy ? t("dm_sending") : handRaised ? 'Elini indir' : t("surface_el_kald_r_03cf1a")}
          </button>
        {/if}
      </footer>

      <p class="stage-media-note">
        {t('markup_bu_gorunum_sahne_katilimi_roller_ve_el_kaldirma__ab6e6da', "Bu görünüm sahne katılımı, roller ve el kaldırma durumunu sunucudan doğrular. Gerçek Stage SFU medya aktarımı doğrulanmadan uzaktan ses/video çalışıyor olarak gösterilmez.")}
      </p>
    {:else}
      <div class="stage-state" role="status">{t("stage_preparing")}</div>
    {/if}
  </section>
{/if}

<style>
  .stage-session { display:flex; flex-direction:column; min-width:0; min-height:0; flex:1; padding:var(--space-5); gap:var(--space-4); overflow:auto; color:var(--text-primary); }
  .stage-head { display:flex; align-items:flex-start; justify-content:space-between; gap:var(--space-4); }
  .stage-head-copy { min-width:0; }
  .stage-kicker { display:flex; align-items:center; gap:var(--space-2); color:var(--text-muted); font-size:var(--type-caption); font-weight:700; letter-spacing:.06em; }
  .stage-live-dot { width:8px; height:8px; border-radius:50%; background:var(--text-muted); }
  .stage-live-dot.live { background:var(--danger); }
  h2,h3,p { margin:0; }
  .stage-head h2 { margin-top:var(--space-1); font-size:var(--type-title); }
  .stage-head p { margin-top:var(--space-1); color:var(--text-muted); font-size:var(--type-body); }
  button { font:inherit; }
  .stage-primary,.stage-secondary { border:1px solid var(--border-subtle); border-radius:var(--radius-md); min-height:36px; padding:0 var(--space-3); cursor:pointer; }
  .stage-primary { background:var(--brand); color:var(--text-on-solid); border-color:transparent; }
  .stage-primary.active { background:var(--surface-3); color:var(--text-primary); border-color:var(--border-strong); }
  .stage-secondary { background:var(--surface-2); color:var(--text-primary); }
  .stage-secondary.danger { color:var(--danger); }
  button:disabled { opacity:.55; cursor:not-allowed; }
  button:focus-visible { outline:2px solid var(--focus-ring, var(--brand)); outline-offset:2px; }
  .stage-error { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); padding:var(--space-3); border:1px solid color-mix(in srgb, var(--danger) 35%, transparent); border-radius:var(--radius-md); background:color-mix(in srgb, var(--danger) 8%, transparent); color:var(--text-primary); }
  .stage-error button { border:0; background:transparent; color:var(--brand); cursor:pointer; font-weight:600; }
  .stage-admin { display:grid; grid-template-columns:minmax(0,1fr) auto auto; align-items:end; gap:var(--space-2); padding:var(--space-3); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:var(--surface-1); }
  .topic-field { display:flex; flex-direction:column; gap:var(--space-1); min-width:0; color:var(--text-muted); font-size:var(--type-caption); }
  .topic-field input { min-width:0; min-height:36px; border:1px solid var(--border-subtle); border-radius:var(--radius-md); background:var(--surface-2); color:var(--text-primary); padding:0 var(--space-3); font:inherit; }
  .topic-field input:focus-visible { outline:2px solid var(--focus-ring, var(--brand)); outline-offset:2px; }
  .stage-inline { border:0; background:transparent; color:var(--brand); cursor:pointer; font-size:var(--type-caption); font-weight:600; padding:var(--space-1); }
  .listener-actions { display:flex; align-items:center; gap:var(--space-2); flex:0 0 auto; }
  .stage-grid { display:grid; grid-template-columns:minmax(0, 1fr) minmax(220px, 280px); gap:var(--space-4); min-height:0; }
  .stage-column { min-width:0; border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:var(--surface-1); padding:var(--space-4); }
  .stage-section-title { display:flex; align-items:center; justify-content:space-between; margin-bottom:var(--space-3); }
  .stage-section-title h3 { font-size:var(--type-body); }
  .stage-section-title span { color:var(--text-muted); font-size:var(--type-caption); }
  .speaker-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(132px,1fr)); gap:var(--space-3); }
  .speaker-card { display:flex; flex-direction:column; align-items:center; text-align:center; gap:var(--space-2); min-width:0; padding:var(--space-4) var(--space-3); border-radius:var(--radius-md); background:var(--surface-2); border:1px solid transparent; }
  .speaker-card.speaking { border-color:var(--success, var(--brand)); }
  .stage-avatar { display:grid; place-items:center; width:48px; height:48px; border-radius:50%; background:var(--stage-avatar); color:var(--text-on-solid); font-weight:700; }
  .speaker-name,.listener-name { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:100%; }
  .speaker-name { font-weight:600; }
  .speaker-state { color:var(--text-muted); font-size:var(--type-caption); }
  .listener-list { display:flex; flex-direction:column; gap:var(--space-1); }
  .listener-row { display:flex; align-items:center; justify-content:space-between; gap:var(--space-2); min-height:34px; padding:0 var(--space-2); border-radius:var(--radius-sm); }
  .hand-badge { flex:0 0 auto; }
  .stage-empty,.stage-state { color:var(--text-muted); font-size:var(--type-body); }
  .stage-state { display:flex; flex-direction:column; align-items:center; justify-content:center; gap:var(--space-3); min-height:180px; text-align:center; }
  .stage-controls { display:flex; align-items:center; justify-content:space-between; gap:var(--space-3); padding:var(--space-3) var(--space-4); border:1px solid var(--border-subtle); border-radius:var(--radius-lg); background:var(--surface-1); }
  .stage-role { display:flex; flex-direction:column; gap:2px; min-width:0; }
  .stage-role span,.stage-media-note { color:var(--text-muted); font-size:var(--type-caption); }
  .stage-media-note { max-width:78ch; line-height:1.45; }
  @media (max-width: 760px) {
    .stage-session { padding:var(--space-4); padding-bottom:max(var(--space-4), env(safe-area-inset-bottom)); }
    .stage-head { align-items:stretch; flex-direction:column; }
    .stage-admin { grid-template-columns:1fr; align-items:stretch; }
    .stage-grid { grid-template-columns:1fr; }
    .stage-audience { max-height:220px; overflow:auto; }
    .stage-controls { align-items:stretch; flex-direction:column; }
    .stage-controls .stage-primary { width:100%; }
  }
</style>
