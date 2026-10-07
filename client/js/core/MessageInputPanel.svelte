<!-- client/js/core/MessageInputPanel.svelte -->
<!-- Sprint 116 — messages/input.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mesaj giriş kutusu -->
<!--
  Faz 4 (toparlama): Mesaj yazma tarafı.

  Mevcut kabuk KORUNUR: #msg-input-wrap + #msg-input (index.html:224-233).
  Yeni textarea üretilmez; bileşen var olan elemana listener bağlar.
  index.html'deki bozuk inline handler'lar (handleMsgKey/handleTypingInput/
  handleMsgPaste/sendMessage) kaldırıldı — hepsi tanımsız global çağırıyordu
  (ReferenceError). Gönder düğmesi mevcut data-bridge-action dispatcher'ına
  bağlandı; yeni window.* global üretilmedi.

  Legacy referansı (kod import edilmedi):
    messages/input.ts:133-142  message:send / message:reply emit
    messages/input.ts:253-341  sendMessage / handleMsgKey / handleTypingInput
    messages/input.ts:344-418  edit / delete akışları

  Backend sözleşmesi (değiştirilmedi):
    message:send  { channelId, serverId, content, replyToId? }
    message:edit  { messageId, channelId, content, clientNonce }
    message:delete{ messageId, channelId, clientNonce }
    typing:start / typing:stop { channelId }
-->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { t, localeTag} from './i18n/reactive.svelte.ts';
  import { messageText } from './messages/message-format.ts';
  import {
    activeMentionQuery, applyMention, rankMentionCandidates,
    type MentionCandidate, type MentionMember, type MentionQuery,
  } from './composer/mention-query.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { type OutboxEntry } from './outbox-store.js';
  import {
    closeLocalFirstOutboxRuntime,
    hydrateLocalFirstOutbox,
    localFirstOutboxForChannel as outboxForChannel,
    patchLocalFirstOutboxEntry as patchOutboxEntry,
    putLocalFirstOutboxEntry as putOutboxEntry,
    readLocalFirstOutbox as readOutbox,
    removeLocalFirstOutboxEntry as removeOutboxEntry,
  } from './local-first/outbox-runtime.ts';
  import {
    closeMessageOperationSync,
    handleMessageOperationSocketDisconnected,
    queueDeleteMessageOperation,
    queueEditMessageOperation,
    replayMessageOperations,
  } from './local-first/message-operation-sync.ts';
  import { isProtectedMediaUrl } from './media-auth.ts';
  import {
    draftKindOf, isTextChannel, optimisticOutboxMessage, outboxPayload,
    type NewOutboxEntry, type PendingMutation, type PendingSend,
  } from './message-composer-policy.ts';
  import {
    composerSocket as socket, composerCurrentChannel as currentChannel,
    composerCurrentUser as currentUser, composerCurrentUserId as currentUserId,
    currentDraftContextKey, dropDraft, flushDraft, loadAttachmentPending, loadDraft,
    saveAttachmentPending, saveDraft, type SocketLike,
  } from './message-composer-runtime.ts';
  import {
    humanSize, localDateTimeValue, newAckId, safeMutationError, safeScheduledRow, uploadErrorText,
    type ScheduledMessageRow,
  } from './message-input-utils.ts';
  const log = createLogger('MessageInputPanel');

  let { children }: { children?: Snippet } = $props();

  interface Message {
    _id: string;
    channelId?: string;
    content?: string;
    createdAt?: number | string;
    editedAt?: number | string;
    displayName?: string;
    username?: string;
    [key: string]: unknown;
  }

  const TYPING_STOP_MS = 2000;
  const MAX_LENGTH = 2000;
  const COUNTER_THRESHOLD = 1800;
  /** ACK bu süre içinde gelmezse mesaj "failed" işaretlenir (kaybolmaz, retry edilebilir). */
  const ACK_TIMEOUT_MS = 10_000;
  const LOCAL_FIRST_SYNC_TAG = 'bridge-local-first-replay';

  /** Uçuştaki gönderimler — retry aynı ackId ile yapılır (sunucu tarafında dedup). */
  const pendingSends = new Map<string, PendingSend>();

  let pendingEdit: (PendingMutation & { content: string }) | null = null;
  const pendingDeletes = new Map<string, PendingMutation>();
  const deletingMessageIds = new Set<string>();
  let editMutationBusy = $state(false);

  function clearPendingMutationTimers(): void {
    if (pendingEdit?.timer) clearTimeout(pendingEdit.timer);
    pendingEdit = null;
    editMutationBusy = false;
    for (const pending of pendingDeletes.values()) if (pending.timer) clearTimeout(pending.timer);
    pendingDeletes.clear();
    deletingMessageIds.clear();
  }

  let input: HTMLTextAreaElement | null = null;
  let wrap: HTMLElement | null = null;
  let sendButton: HTMLButtonElement | null = null;

  let replyTarget = $state<Message | null>(null);
  let editTarget  = $state<Message | null>(null);
  // @mention önerileri (Final21 Faz 15): "@bo" yazınca kimse önerilmiyordu.
  let mentionQuery   = $state<MentionQuery | null>(null);
  let mentionOptions = $state<MentionCandidate[]>([]);
  let mentionIndex   = $state(0);
  let sendError   = $state('');
  let sendErrorKind = $state<'' | 'too_long'>('');
  let charCount   = $state(0);
  let canSend     = $state(false);
  let draftBeforeEdit: string | null = null;
  let scheduleButton: HTMLButtonElement | null = null;
  let scheduleOpen = $state(false);
  let scheduleAt = $state('');
  let scheduleBusy = $state(false);
  let scheduleError = $state('');

  let scheduledManageOpen = $state(false);
  let scheduledLoading = $state(false);
  let scheduledManageError = $state('');
  let scheduledItems = $state<ScheduledMessageRow[]>([]);
  let scheduledCancellingId = $state('');
  let scheduledLoadGeneration = 0;

  async function loadScheduledForCurrentChannel(): Promise<void> {
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    const channelId = currentChannel()?._id;
    if (!apiFetch || !channelId) {
      scheduledItems = [];
      scheduledManageError = t("ui_bekleyen_mesajlar_su_anda_yuklenemiyor", "Bekleyen mesajlar şu anda yüklenemiyor.");
      return;
    }
    const generation = ++scheduledLoadGeneration;
    scheduledLoading = true;
    scheduledManageError = '';
    try {
      const response = await apiFetch('/api/scheduled');
      if (!response.ok) {
        if (generation === scheduledLoadGeneration) scheduledManageError = t("ui_bekleyen_mesajlar_yuklenemedi", "Bekleyen mesajlar yüklenemedi.");
        return;
      }
      const body = await response.json() as unknown;
      if (generation !== scheduledLoadGeneration) return;
      const rows = Array.isArray(body) ? body.map(safeScheduledRow).filter((row): row is ScheduledMessageRow => Boolean(row)) : [];
      scheduledItems = rows
        .filter(row => row.channelId === channelId)
        .sort((a, b) => a.sendAt - b.sendAt);
    } catch {
      if (generation === scheduledLoadGeneration) scheduledManageError = t("ui_bekleyen_mesajlar_yuklenemedi", "Bekleyen mesajlar yüklenemedi.");
    } finally {
      if (generation === scheduledLoadGeneration) scheduledLoading = false;
    }
  }

  async function toggleScheduledManager(): Promise<void> {
    scheduledManageOpen = !scheduledManageOpen;
    if (scheduledManageOpen) await loadScheduledForCurrentChannel();
  }

  async function cancelScheduled(id: string): Promise<void> {
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    if (!apiFetch || !id || scheduledCancellingId) return;
    scheduledCancellingId = id;
    scheduledManageError = '';
    try {
      const response = await apiFetch(`/api/scheduled/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (response.ok || response.status === 404) {
        scheduledItems = scheduledItems.filter(item => item._id !== id);
        if (response.ok) BridgeRegistry.call('toast', t("ui_zamanlanmis_mesaj_iptal_edildi", "Zamanlanmış mesaj iptal edildi."), 'success');
        return;
      }
      scheduledManageError = response.status === 409
        ? t("ui_mesaj_gonderilmek_uzere_iptal_artik_uygulanamadi", "Mesaj gönderilmek üzere; iptal artık uygulanamadı.")
        : response.status === 400
          ? t("ui_mesaj_zaten_gonderilmis_listeyi_yenileyebilirsin", "Mesaj zaten gönderilmiş. Listeyi yenileyebilirsin.")
          : t("ui_zamanlanmis_mesaj_iptal_edilemedi", "Zamanlanmış mesaj iptal edilemedi.");
    } catch {
      scheduledManageError = t("ui_zamanlanmis_mesaj_iptal_edilemedi_baglantini_kontrol", "Zamanlanmış mesaj iptal edilemedi. Bağlantını kontrol et.");
    } finally {
      scheduledCancellingId = '';
    }
  }

  function openSchedule(): void {
    scheduleAt = localDateTimeValue(Date.now() + 15 * 60_000);
    scheduleError = '';
    scheduledManageError = '';
    scheduleOpen = true;
  }

  function closeSchedule(): void {
    scheduleOpen = false;
    scheduleError = '';
    scheduledManageOpen = false;
    scheduledManageError = '';
    scheduledLoadGeneration += 1;
    scheduledLoading = false;
  }

  async function confirmSchedule(): Promise<void> {
    if (!input || scheduleBusy) return;
    const content = input.value.trim();
    const channel = currentChannel();
    const serverId = channel?.serverId ?? BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer')?._id;
    const when = new Date(scheduleAt).getTime();
    if (attachment || editTarget || replyTarget) {
      scheduleError = t("ui_zamanlanmis_gonderim_su_anda_yalnizca_yeni_metin_mes", "Zamanlanmış gönderim şu anda yalnızca yeni metin mesajlarını destekliyor.");
      return;
    }
    if (!content) { scheduleError = t("ui_zamanlamak_icin_once_bir_mesaj_yaz", "Zamanlamak için önce bir mesaj yaz."); input.focus(); return; }
    if (!channel?._id || !serverId) { scheduleError = t("ui_kanal_su_anda_hazir_degil", "Kanal şu anda hazır değil."); return; }
    if (!Number.isFinite(when) || when <= Date.now() + 30_000) { scheduleError = t("ui_gonderim_zamani_en_az_30_saniye_ileride_olmali", "Gönderim zamanı en az 30 saniye ileride olmalı."); return; }
    if (when > Date.now() + 30 * 24 * 60 * 60_000) { scheduleError = t("ui_mesajlar_en_fazla_30_gun_ileri_zamanlanabilir", "Mesajlar en fazla 30 gün ileri zamanlanabilir."); return; }
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    if (!apiFetch) { scheduleError = t("ui_zamanlama_servisi_su_anda_hazir_degil", "Zamanlama servisi şu anda hazır değil."); return; }
    scheduleBusy = true;
    scheduleError = '';
    try {
      const response = await apiFetch('/api/scheduled', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelId: channel._id, serverId, content, sendAt: new Date(when).toISOString() }),
      });
      if (!response.ok) {
        scheduleError = response.status === 403
          ? t("ui_bu_kanalda_mesaj_zamanlama_yetkin_yok", "Bu kanalda mesaj zamanlama yetkin yok.")
          : response.status === 429 ? t("ui_cok_sik_zamanlama_yapiliyor_biraz_sonra_tekrar_dene", "Çok sık zamanlama yapılıyor. Biraz sonra tekrar dene.")
          : t("ui_mesaj_zamanlanamadi", "Mesaj zamanlanamadı.");
        return;
      }
      input.value = '';
      dropDraft(channel._id, draftKindOf(channel), serverId);
      autoGrow(); syncComposerState(); closeSchedule();
      BridgeRegistry.call('toast', t('message_scheduled_for', 'Mesaj {date} için zamanlandı.', { date: new Date(when).toLocaleString(localeTag()) }), 'success');
    } catch {
      scheduleError = t("ui_mesaj_zamanlanamadi_baglantini_kontrol_et", "Mesaj zamanlanamadı. Bağlantını kontrol et.");
    } finally { scheduleBusy = false; }
  }

  // ── UX/P0 — DOSYA EKI ──────────────────────────────────────────────────────
  // KANONIK MIMARI (sunucuda zaten tam kurulu, istemcide GIRIS YOKTU):
  //   1. POST /api/upload  (multipart alan adi: `file`)
  //      -> auth + CSRF (apiFetch), hiz siniri, magic-bytes denetimi,
  //         zararli yazilim taramasi, SVG sanitizasyonu, boost katmani siniri
  //      -> { url, fileName, fileType, size }
  //   2. socket `file:send` { channelId, serverId, fileName, fileUrl, fileType }
  //      -> path traversal korumasi, uyelik, timeout, SEND_MESSAGES yetkisi
  //      -> `message:new` yalnizca `channel:<id>` odasina yayilir (VIEW_CHANNELS)
  //
  // IKINCI BIR YUKLEME SISTEMI KURULMAZ. Dormant `upload-svelte.ts` uyandirilmaz;
  // bu akis kanonik uca ve kanonik sokete dogrudan baglanir.
  //
  // ILERLEME CUBUGU YOK: kanonik tasima `fetch` (apiFetch) uzerindedir ve fetch
  // YUKLEME ilerlemesini ACIGA CIKARMAZ. Sahte bir yuzde gostermek yerine
  // belirsiz "Yukleniyor" durumu gosterilir — dogruluk uydurma ilerlemeye yeglenir.
  let fileInput    : HTMLInputElement | null = null;
  let attachButton : HTMLButtonElement | null = null;
  let attachment  = $state<File | null>(null);
  let attachmentContextKey = '';
  let uploading   = $state(false);
  let attachError = $state('');
  let attachmentLifecycleSeq = 0;

  // Sunucu boost katmanina gore 25-100MB kabul eder; varsayilan taban 25MB.
  // Bu YALNIZCA erken geri bildirimdir — YETKILI SINIR SUNUCUDADIR (413).
  const ATTACH_SOFT_LIMIT = 25 * 1024 * 1024;
  const apiBase = (): string =>
    (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;

  /** Secilen dosyayi kabul eder; sunucu kararini TAKLIT ETMEZ, yalniz erken uyarir. */
  function acceptFile(f: File | null | undefined): void {
    attachError = '';
    if (!f) return;
    if (f.size > ATTACH_SOFT_LIMIT) {
      attachError = t('file_too_large_max', 'Dosya çok büyük (en fazla {max}).', { max: humanSize(ATTACH_SOFT_LIMIT) });
      attachment = null;
      attachmentContextKey = '';
      saveAttachmentPending(false);
    } else {
      attachment = f;
      attachmentContextKey = currentDraftContextKey();
      // Never persist bytes or file metadata. Remember only that navigation or
      // reload will require the user to reselect the file.
      saveAttachmentPending(true);
    }
    syncComposerState();
  }

  function onAttachClick(event: Event): void { event.preventDefault(); fileInput?.click(); }
  function onFileChosen(event: Event): void {
    acceptFile((event.target as HTMLInputElement).files?.[0]);
    if (fileInput) fileInput.value = '';   // ayni dosya tekrar secilebilsin
  }
  function clearAttachment(): void {
    attachment = null; attachmentContextKey = ''; attachError = ''; saveAttachmentPending(false); syncComposerState();
  }

  function retryAttachment(): void {
    if (!attachment || uploading) return;
    attachError = '';
    sendMessage();
  }

  /** Sunucunun REDDINI dogru sekilde anlatir — genel hata metni yeterli degil. */
  /**
   * Yukle -> kanonik `file:send`. BASARI, gonderim GERCEKTEN yapilana kadar
   * gosterilmez: yukleme 200 dondugu halde soket yoksa ek DUSURULMEZ,
   * kullanicida kalir ve tekrar denenebilir.
   */
  async function sendAttachment(
    file: File,
    channel: { _id?: string; serverId?: string; type?: string },
    sock: SocketLike,
  ): Promise<boolean> {
    const lifecycleSeq = attachmentLifecycleSeq;
    uploading = true; attachError = '';
    syncComposerState();
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) { attachError = t("ui_yukleme_istemcisi_hazir_degil", "Yükleme istemcisi hazır değil."); return false; }

      const fd = new FormData();
      fd.append('file', file);
      // Content-Type BILEREK ayarlanmaz: multipart sinirini tarayici yazar.
      const res = await apiFetch(`${apiBase()}/api/upload`, { method: 'POST', body: fd });
      if (lifecycleSeq !== attachmentLifecycleSeq) return false;

      if (!res.ok) {
        attachError = uploadErrorText(res.status);
        return false;
      }
      const data = await res.json() as { url?: string; fileName?: string; fileType?: string };
      if (lifecycleSeq !== attachmentLifecycleSeq) return false;
      if (!data?.url) { attachError = t("ui_yukleme_yaniti_gecersiz", "Yükleme yanıtı geçersiz."); return false; }

      const serverId = channel.serverId
        ?? BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer')?._id;
      if (!serverId) { attachError = t("ui_sunucu_baglami_bulunamadi", "Sunucu bağlamı bulunamadı."); return false; }

      const targetUrl = String(data.url);
      if (!isProtectedMediaUrl(targetUrl)) {
        attachError = t("ui_yukleme_yaniti_guvenilir_bir_dosya_adresi_icermiyor", "Yükleme yanıtı güvenilir bir dosya adresi içermiyor.");
        return false;
      }
      // Upload bytes are now a safe retryable reference. Queue the file through
      // the SAME message:send + ackId outbox as text; a failed send never
      // re-uploads the bytes and cannot create a duplicate message.
      const queued = queueOutboxEntry({
        channelId: String(channel._id), serverId, draftKind: draftKindOf(channel),
        messageType: 'file', content: '', fileUrl: targetUrl,
        fileName: data.fileName ?? file.name, fileType: data.fileType ?? file.type,
      }, sock);
      if (!queued) {
        attachError = t("ui_ek_gonderim_kuyruguna_alinamadi_dosya_secimi_korundu", "Ek gönderim kuyruğuna alınamadı; dosya seçimi korundu.");
        return false;
      }
      saveAttachmentPending(false);
      attachmentContextKey = '';
      log.info(t('file_queued_named', 'Dosya güvenilir kuyruğa alındı: {name}', { name: (data.fileName ?? file.name).slice(0, 40) }));
      return true;
    } catch (err) {
      log.error('Dosya gönderilemedi', err);
      attachError = t("ui_dosya_gonderilemedi_lutfen_tekrar_deneyin", "Dosya gönderilemedi. Lütfen tekrar deneyin.");
      return false;
    } finally {
      if (lifecycleSeq === attachmentLifecycleSeq) {
        uploading = false;
        syncComposerState();
      }
    }
  }

  let typingActive = false;
  let typingTimer: ReturnType<typeof setTimeout> | null = null;

  /** Var olan statik composer shell'inin görsel/erişilebilir durumunu tek yerden günceller. */
  function syncComposerState(): void {
    if (!input) return;
    charCount = input.value.length;
    const channel = currentChannel();
    const sock = socket();
    const connectedState = BridgeRegistry.call<boolean>('getSocketConnected');
    const connected = connectedState ?? Boolean(sock);
    const hasContent = input.value.trim().length > 0;
    // Ek varken METIN ZORUNLU DEGILDIR; yukleme surerken tekrar gonderim kilitlenir.
    const hasAttachment = Boolean(attachment);
    // Text sends use the canonical outbox; edits use the encrypted P7 operation
    // log. Both can be accepted while offline. Raw attachment bytes still need
    // a live upload path.
    const queueableTextOrEdit = hasContent;
    const liveOnlyAttachment = hasAttachment && !editTarget && Boolean(sock && connected);
    canSend = Boolean(channel?._id && isTextChannel(channel)
      && (queueableTextOrEdit || liveOnlyAttachment) && charCount <= MAX_LENGTH && !uploading && !editMutationBusy);

    input.setAttribute('maxlength', String(MAX_LENGTH));
    if (charCount >= COUNTER_THRESHOLD || sendError) input.setAttribute('aria-describedby', 'composer-status');
    else input.removeAttribute('aria-describedby');
    sendButton?.classList.toggle('send-has-content', hasContent && charCount <= MAX_LENGTH);
    if (sendButton) {
      sendButton.disabled = !canSend;
      sendButton.setAttribute('aria-disabled', String(!canSend));
    }
  }

  /** Persist first, then render/emit. A storage failure never clears input. */
  function queueOutboxEntry(inputEntry: NewOutboxEntry, sock: SocketLike | null): OutboxEntry | null {
    const userId = currentUserId();
    if (!userId) { sendError = t("ui_oturum_kimligi_bulunamadi", "Oturum kimliği bulunamadı."); return null; }
    lastOutboxUserId = userId;

    const connectedState = BridgeRegistry.call<boolean>('getSocketConnected');
    const connected = connectedState ?? Boolean(sock);
    const entry: OutboxEntry = {
      ...inputEntry,
      ackId: newAckId(),
      userId,
      createdAt: Date.now(),
      state: connected && sock ? 'sending' : 'queued',
      attempts: 0,
    };

    if (!putOutboxEntry(entry)) {
      sendError = t("ui_gonderim_kuyrugu_dolu_veya_depolama_kullanilamiyor_b", "Gönderim kuyruğu dolu veya depolama kullanılamıyor. Bekleyen mesajları yeniden deneyin.");
      syncComposerState();
      return null;
    }

    pendingSends.set(entry.ackId, { entry, timer: null });
    BridgeRegistry.call('appendMessage', optimisticOutboxMessage(entry, currentUser()));
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
    dispatchSend(entry, sock);
    return entry;
  }

  // ── Gönderme ───────────────────────────────────────────────────────────────
  function sendMessage(): void {
    if (!input) return;
    const content = input.value.trim();

    // ── EK AKISI ─────────────────────────────────────────────────────────────
    // Sunucu sozlesmesi geregi `file:send` mesaji `content: ''` ile olusur;
    // yani tek mesajda metin+dosya BIRLESTIRILEMEZ. Kullanicinin yazdigi metin
    // KAYBOLMAZ: dosya gonderildikten sonra ayri bir mesaj olarak gonderilir.
    if (attachment && !editTarget) {
      const channel = currentChannel();
      const sock = socket();
      if (!channel?._id) { sendError = t("pl_pick_channel", "Önce bir kanal seç"); syncComposerState(); return; }
      if (!sock)         { sendError = t("ui_baglanti_yok_dosya_gonderilemedi", "Bağlantı yok — dosya gönderilemedi"); syncComposerState(); return; }
      if (uploading) return;

      const file = attachment;
      sendError = '';
      void (async () => {
        const ok = await sendAttachment(file, channel, sock);
        if (!ok) return;              // ek DUSURULMEZ — kullanici tekrar deneyebilir
        attachment = null;
        syncComposerState();
        if (content) sendMessage();   // artik ek yok: normal metin yolu
      })();
      return;
    }

    if (!content) return;
    if (content.length > MAX_LENGTH) { sendErrorKind = 'too_long'; sendError = t('message_too_long_max', 'Mesaj çok uzun (en fazla {max} karakter)', { max: MAX_LENGTH }); syncComposerState(); return; }

    const channel = currentChannel();
    const sock = socket();
    if (!channel?._id) { sendError = t("pl_pick_channel", "Önce bir kanal seç"); syncComposerState(); return; }
    sendError = '';

    if (editTarget) {
      if (pendingEdit || editMutationBusy) return;
      const nonce = newAckId();
      const messageId = editTarget._id;
      const baseVersion = Number(editTarget.editedAt ?? editTarget.createdAt);
      if (!Number.isSafeInteger(baseVersion) || baseVersion < 0) {
        sendError = t('mutation_connection_failed', 'İşlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.');
        syncComposerState();
        return;
      }

      // Persist BEFORE socket emit. If durable storage fails the user's edit
      // stays in the composer and the server is never told it succeeded.
      pendingEdit = { nonce, messageId, content, timer: null };
      editMutationBusy = true;
      sendError = '';
      syncComposerState();

      void queueEditMessageOperation({
        opId: nonce,
        messageId,
        channelId: channel._id,
        content,
        baseVersion,
      }).then(({ dispatched }) => {
        if (pendingEdit?.nonce !== nonce) return;
        editMutationBusy = dispatched;
        if (!dispatched) sendError = t('ui_offline_waiting');
        syncComposerState();
      }).catch((error: unknown) => {
        if (pendingEdit?.nonce !== nonce) return;
        pendingEdit = null;
        editMutationBusy = false;
        sendError = t('mutation_connection_failed', 'İşlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.');
        log.warn('edit.oplog.enqueue.failed', error);
        syncComposerState();
      });
      return;
    }

    // ── Teslim durum makinesi: queued → sending → sent | failed → retry ──────
    const serverId = channel.serverId ?? BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer')?._id;
    if (!serverId) { sendError = t("ui_sunucu_baglami_bulunamadi", "Sunucu bağlamı bulunamadı."); syncComposerState(); return; }
    const entry = queueOutboxEntry({
      channelId: channel._id,
      serverId,
      draftKind: draftKindOf(channel),
      messageType: 'normal',
      content,
      ...(replyTarget ? {
        replyToId: replyTarget._id,
        replyPreview: {
          _id: replyTarget._id,
          displayName: String(replyTarget.displayName ?? replyTarget.username ?? ''),
          content: String(replyTarget.content ?? '').slice(0, 100),
        },
      } : {}),
    }, sock);
    if (!entry) return;

    // Faz 8.2 — SEND SEMANTİĞİ:
    // Taslak burada SİLİNMEZ. Metin yalnızca ACK ile teslim onaylandığında
    // temizlenir (resolvePendingSend). Gönderim başarısız olursa taslak yerinde
    // kalır ve kullanıcı kanala döndüğünde metnini bulur — teslim durum
    // makinesindeki "failed + retry" kaydına ek bir güvence.
    // Çift kalıcılık yok: pending mesaj bellekte, taslak depoda tutulur.
    input.value = '';
    autoGrow();
    syncComposerState();
    clearReply();
    stopTyping();
  }

  /**
   * Canonical sticker send owner. Sticker bytes are never re-uploaded or mutated;
   * the durable outbox stores only the server-scoped asset identity plus the
   * already-normalized optimistic snapshot. Server ACK remains authoritative.
   */
  function sendSticker(sticker: { id: string; packId: string; name: string; url: string; width: number; height: number }): boolean {
    const channel = currentChannel();
    if (!channel?._id || !isTextChannel(channel)) { sendError = t("ui_sticker_gondermek_icin_bir_metin_kanali_sec", "Sticker göndermek için bir metin kanalı seç."); syncComposerState(); return false; }
    const serverId = channel.serverId ?? BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer')?._id;
    if (!serverId || !sticker?.id || !sticker.packId) { sendError = t("ui_sticker_baglami_gecersiz", "Sticker bağlamı geçersiz."); syncComposerState(); return false; }
    const url = String(sticker.url ?? '');
    if (!/^\/uploads\/stickers\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url) || url.includes('..')) {
      sendError = t("ui_sticker_basvurusu_guvenilir_degil", "Sticker başvurusu güvenilir değil."); syncComposerState(); return false;
    }
    const entry = queueOutboxEntry({
      channelId: String(channel._id), serverId, draftKind: draftKindOf(channel),
      messageType: 'sticker', content: '', stickerPackId: String(sticker.packId), stickerId: String(sticker.id),
      stickerSnapshot: {
        id: String(sticker.id), packId: String(sticker.packId), name: String(sticker.name ?? '').slice(0, 100), url,
        width: Number.isFinite(Number(sticker.width)) ? Number(sticker.width) : 160,
        height: Number.isFinite(Number(sticker.height)) ? Number(sticker.height) : 160,
      },
    }, socket());
    return Boolean(entry);
  }

  // ── Final21 UX (U-11): hız sınırı / yavaş mod beklemesi ─────────────────────
  // Sunucu anti-spam (5 mesaj / 4 sn → 30 sn blok) ve yavaş modda gönderimi ACK'siz
  // reddeder. Eskiden istemci bunu bilmiyordu: mesaj 10 sn "Gönderiliyor…" kalıyor,
  // sonra "Sunucu onayı zaman aşımına uğradı" deniyordu; blok sürerken "Yeniden dene"
  // aynı hatayla düşüyordu. Şimdi ret ackId ile eşlenir; geçici retlerde mesaj GERÇEK
  // nedenle sırada bekler ve sunucunun bildirdiği süre dolunca aralıklarla kendiliğinden
  // gönderilir (aynı ackId → sunucuda çift kayıt oluşmaz). Bekleme sürerken yazılan yeni
  // mesajlar boşuna gönderilip reddedilmez, sıraya girer. Kalıcı retler (aynı metin art
  // arda, moderatör susturması) gerçek nedenle başarısız olur; otomatik deneme YOK.
  const HOLD_RELEASE_SPACING_MS = 1_000; // anti-spam penceresinin (5 mesaj / 4 sn) altında
  let holdUntil = 0;
  let holdReason = '';
  let holdTimer: ReturnType<typeof setTimeout> | null = null;
  const heldAckIds: string[] = [];
  let lastSpamWarningAt = 0;

  function holdEntry(entry: OutboxEntry, reason: string): void {
    const queued = patchOutboxEntry(entry.userId, entry.ackId, { state: 'queued', lastError: reason })
      ?? { ...entry, state: 'queued' as const, lastError: reason };
    pendingSends.set(entry.ackId, { entry: queued, timer: null });
    if (!heldAckIds.includes(entry.ackId)) heldAckIds.push(entry.ackId);
    BridgeRegistry.call('updateMessage', { _id: `pending:${entry.ackId}`, pending: true, queued: true, failed: false, lastError: reason });
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
  }

  function releaseHeld(): void {
    holdTimer = null;
    const next = heldAckIds.shift();
    if (next) {
      const item = pendingSends.get(next);
      if (item && item.entry.state === 'queued') dispatchSend(item.entry, socket());
    }
    if (heldAckIds.length && !holdTimer) holdTimer = setTimeout(releaseHeld, HOLD_RELEASE_SPACING_MS);
  }

  function scheduleRelease(): void {
    if (holdTimer) clearTimeout(holdTimer);
    holdTimer = setTimeout(releaseHeld, Math.max(0, holdUntil - Date.now()));
  }

  /**
   * Sunucu bekleyen bir gönderimi reddetti. `amount`: hız sınırında kalan ms,
   * yavaş mod ve susturmada kalan saniye.
   */
  function rejectPendingSend(ackId: string, kind: 'rate' | 'slowmode' | 'duplicate' | 'timeout', amount: number): void {
    const item = pendingSends.get(ackId);
    if (!item) return;
    if (item.timer) { clearTimeout(item.timer); item.timer = null; }
    if (kind === 'duplicate') {
      failPendingSend(ackId, t('send_failed_duplicate', 'Aynı mesajı art arda gönderdin.'));
      return;
    }
    if (kind === 'timeout') {
      const minutes = Math.max(1, Math.ceil((Number(amount) || 0) / 60));
      failPendingSend(ackId, t('send_failed_timeout', 'Bu sunucuda geçici olarak susturuldun. {minutes} dk sonra tekrar yazabilirsin.', { minutes }));
      return;
    }
    const waitMs = kind === 'slowmode' ? Math.max(1, Number(amount) || 1) * 1000 : Math.max(1_000, Number(amount) || 30_000);
    const wasHolding = Date.now() < holdUntil;
    holdUntil = Math.max(holdUntil, Date.now() + waitMs);
    holdReason = kind === 'slowmode'
      ? t('send_hold_slow_row', 'Sırada — yavaş mod')
      : t('send_hold_rate_row', 'Sırada — hız sınırı');
    holdEntry(item.entry, holdReason);
    // Yavaş modun geri sayımını composer zaten gösteriyor (SlowModeIndicator);
    // hız sınırı ise başka hiçbir yerde anlatılmıyordu.
    if (kind === 'rate' && !wasHolding) {
      const seconds = Math.ceil((holdUntil - Date.now()) / 1000);
      BridgeRegistry.call('toast', t('send_hold_rate_toast', 'Çok hızlı mesaj gönderiyorsun. Sıradaki mesajların {seconds} sn sonra otomatik gönderilecek.', { seconds }), 'warning');
    }
    scheduleRelease();
  }

  /** Mesaj teslim edildi ama sunucu hızın sınıra yaklaştığını bildirdi (warn:spam). */
  function noteSpamWarning(): void {
    if (Date.now() - lastSpamWarningAt < 30_000) return;
    lastSpamWarningAt = Date.now();
    BridgeRegistry.call('toast', t('send_spam_warn_toast', 'Biraz yavaşla — bu hızla devam edersen gönderim kısa bir süre durdurulur.'), 'info');
  }

  /** Emit + ACK timeout. Offline items remain queued without a false timeout. */
  function dispatchSend(entry: OutboxEntry, sock: SocketLike | null): void {
    const existing = pendingSends.get(entry.ackId);
    if (existing?.timer) clearTimeout(existing.timer);

    const connectedState = BridgeRegistry.call<boolean>('getSocketConnected');
    const connected = connectedState ?? Boolean(sock);
    if (!sock || !connected) {
      const queued = patchOutboxEntry(entry.userId, entry.ackId, { state: 'queued', lastError: '' }) ?? { ...entry, state: 'queued' as const };
      pendingSends.set(entry.ackId, { entry: queued, timer: null });
      BridgeRegistry.call('updateMessage', {
        _id: `pending:${entry.ackId}`, pending: true, queued: true, failed: false, lastError: '',
      });
      document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
      return;
    }

    // Bekleme sürerken gönderilen mesaj boşuna reddedilmesin: sıraya girer (U-11).
    if (Date.now() < holdUntil) {
      holdEntry(entry, holdReason || t('send_hold_rate_row', 'Sırada — hız sınırı'));
      if (!holdTimer) scheduleRelease();
      return;
    }

    const sending = patchOutboxEntry(entry.userId, entry.ackId, {
      state: 'sending', attempts: entry.attempts + 1, lastAttemptAt: Date.now(), lastError: '',
    }) ?? { ...entry, state: 'sending' as const, attempts: entry.attempts + 1, lastAttemptAt: Date.now() };

    BridgeRegistry.call('updateMessage', {
      _id: `pending:${entry.ackId}`, pending: true, queued: false, failed: false, lastError: '',
    });

    const timer = setTimeout(() => {
      const failed = patchOutboxEntry(sending.userId, sending.ackId, {
        state: 'failed', lastError: t("ui_sunucu_onayi_zaman_asimina_ugradi", "Sunucu onayı zaman aşımına uğradı."),
      }) ?? { ...sending, state: 'failed' as const };
      pendingSends.set(failed.ackId, { entry: failed, timer: null });
      BridgeRegistry.call('updateMessage', {
        _id: `pending:${failed.ackId}`, pending: false, queued: false, failed: true,
        lastError: t("ui_sunucu_onayi_zaman_asimina_ugradi", "Sunucu onayı zaman aşımına uğradı."),
      });
      document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
      log.warn(`Mesaj ACK zaman aşımı (${failed.ackId.slice(0, 8)}) — retry edilebilir`);
    }, ACK_TIMEOUT_MS);

    pendingSends.set(sending.ackId, { entry: sending, timer });
    sock.emit('message:send', outboxPayload(sending));
  }

  /** Retry — AYNI ackId ile gönderilir; sunucu ilk isteği kaydettiyse duplicate oluşmaz. */
  function retrySend(ackId: string): void {
    const entry = pendingSends.get(ackId);
    const sock = socket();
    if (!entry) return;
    BridgeRegistry.call('updateMessage', { _id: `pending:${ackId}`, pending: true, queued: !sock, failed: false, lastError: '' });
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
    dispatchSend(entry.entry, sock);
    log.info(`Mesaj yeniden gönderiliyor (${ackId.slice(0, 8)})`);
  }

  /**
   * Final21 UX (U-12) — başarısız mesajı VAZGEÇ. Eskiden başarısız bir mesajın tek
   * çıkışı "Yeniden dene" idi; kalıcı bir hatada (kanal silindi, yetki gitti,
   * içerik reddedildi) mesaj kalıcı giden kutusunda sonsuza dek kalıyordu. Yalnız
   * `failed` kayıt silinir: uçuştaki bir gönderimi geri çağırmak mümkün değildir
   * (sunucu zaten kaydetmiş olabilir), o yüzden `sending` bu yoldan kaldırılamaz.
   */
  function discardSend(ackId: string): void {
    const item = pendingSends.get(ackId);
    const userId = item?.entry.userId ?? currentUserId();
    const stored = userId ? readOutbox(userId).find((entry) => entry.ackId === ackId) : undefined;
    const entry = item?.entry ?? stored;
    if (!entry || entry.state !== 'failed') return;
    if (item?.timer) clearTimeout(item.timer);
    pendingSends.delete(ackId);
    removeOutboxEntry(entry.userId, ackId);
    // Aynı metin taslak olarak da saklanıyorsa (ACK gelmediği için silinmemişti)
    // vazgeçilen mesaj kanal açıldığında kutuya GERİ gelmesin.
    if (loadDraftFor(entry).trim() === entry.content.trim()) dropDraft(entry.channelId, entry.draftKind, entry.serverId);
    BridgeRegistry.call('removeMessage', `pending:${ackId}`);
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
  }

  function loadDraftFor(entry: OutboxEntry): string {
    return currentChannel()?._id === entry.channelId ? loadDraft() : '';
  }

  /**
   * Kanal açılınca geri yüklenecek taslak. Taslak ACK'e kadar bilerek tutulur
   * (Faz 8.2), ama aynı metin kalıcı giden kutusunda başarısız/sıradaki bir mesaj
   * olarak zaten GÖRÜNÜYORSA onu kutuya da koymak metni İKİ KEZ gösterir: ölçüldü —
   * yeniden yüklemeden sonra kullanıcının yazdığı yeni metin eski başarısız metnin
   * SONUNA eklenip tek mesaj olarak gönderildi ("…12hizli ikinci tur 1"). Taslak
   * silinmez (giden kutusu yalnız bellekte kalmışsa tek kopya odur); yalnız kutuya
   * konmaz.
   */
  function restorableDraft(channelId: string): string {
    const draft = loadDraft();
    const userId = currentUserId();
    if (!draft.trim() || !userId) return draft;
    const shownAsOutbox = outboxForChannel(userId, channelId)
      .some((entry) => entry.content.trim() === draft.trim());
    return shownAsOutbox ? '' : draft;
  }

  /** ACK geldi (teslim onaylandı) → zamanlayıcıyı kapat ve taslağı temizle. */
  function resolvePendingSend(ackId: string): void {
    const entry = pendingSends.get(ackId);
    if (entry?.timer) clearTimeout(entry.timer);
    if (entry) {
      pendingSends.delete(ackId);
      removeOutboxEntry(entry.entry.userId, ackId);
    } else {
      const userId = currentUserId();
      if (userId) removeOutboxEntry(userId, ackId);
    }
    // Faz 8.2: taslak YALNIZCA burada temizlenir. Gönderim anındaki kanal
    // kullanılır — ACK gecikirse kullanıcı başka kanala geçmiş olabilir ve
    // yanlış kanalın taslağı silinmemeli.
    if (entry) dropDraft(entry.entry.channelId, entry.entry.draftKind, entry.entry.serverId);
  }

  /** Sunucu handler'ı hata verdi (error:message) → pending kaydı failed yap. */
  function failPendingSend(ackId: string, message = t('ui_message_send_failed', 'Mesaj gönderilemedi.')): void {
    if (!pendingSends.has(ackId)) return;
    const entry = pendingSends.get(ackId)!;
    if (entry.timer) { clearTimeout(entry.timer); entry.timer = null; }
    const failed = patchOutboxEntry(entry.entry.userId, ackId, { state: 'failed', lastError: message })
      ?? { ...entry.entry, state: 'failed' as const, lastError: message };
    pendingSends.set(ackId, { entry: failed, timer: null });
    BridgeRegistry.call('updateMessage', { _id: `pending:${ackId}`, pending: false, queued: false, failed: true, lastError: message });
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
  }

  let hydratedUserId = '';
  let hydratingOutboxUserId = '';
  let outboxHydrationSeq = 0;
  let lastOutboxUserId = '';

  function clearPendingMemory(): void {
    pendingSends.forEach(item => { if (item.timer) clearTimeout(item.timer); });
    pendingSends.clear();
  }

  function installHydratedOutbox(userId: string, entries: OutboxEntry[]): void {
    // Hydration can finish AFTER the user has already sent a message. The old
    // implementation called clearPendingMemory(), which cancelled that live
    // ACK timer and reinstalled the row as `sending` with timer=null. Keep the
    // existing same-account timer handle instead; hydration must never create a
    // second network send or reset its delivery deadline.
    const previous = new Map(pendingSends);
    pendingSends.clear();

    // A different account must never inherit timers. Same-account in-flight
    // timers stay scheduled and are attached to the hydrated row below.
    for (const pending of previous.values()) {
      if (pending.entry.userId !== userId && pending.timer) clearTimeout(pending.timer);
    }

    hydratedUserId = userId;
    hydratingOutboxUserId = '';
    lastOutboxUserId = userId;

    const installed = new Set<string>();
    for (const entry of entries) {
      const current = previous.get(entry.ackId);
      const inFlight = current?.entry.userId === userId && current.timer
        ? current
        : null;
      pendingSends.set(entry.ackId, inFlight ?? { entry, timer: null });
      installed.add(entry.ackId);
    }

    // Generation guards should make this unnecessary, but fail safe: a
    // same-account live send must not disappear if a browser returns a stale
    // initialization snapshot.
    for (const [ackId, pending] of previous) {
      if (
        !installed.has(ackId)
        && pending.entry.userId === userId
        && pending.timer
      ) {
        pendingSends.set(ackId, pending);
      }
    }
  }

  /**
   * Start encrypted migration/hydration once per authenticated user.
   *
   * The synchronous return is only for optimistic rendering. Replay is blocked
   * until hydratedUserId is set by authenticated encrypted read-back.
   */
  function hydrateOutbox(): OutboxEntry[] {
    const userId = currentUserId();
    if (!userId) return [];
    lastOutboxUserId = userId;
    if (hydratedUserId === userId) return readOutbox(userId);

    if (hydratingOutboxUserId !== userId) {
      hydratingOutboxUserId = userId;
      const seq = ++outboxHydrationSeq;
      void hydrateLocalFirstOutbox(userId).then(entries => {
        if (seq !== outboxHydrationSeq || currentUserId() !== userId) return;
        installHydratedOutbox(userId, entries);
        renderCurrentOutbox();
        replayOutbox();
      }).catch(error => {
        if (seq !== outboxHydrationSeq) return;
        hydratingOutboxUserId = '';
        log.error('Şifreli giden kutusu yüklenemedi', error);
        sendError = t(
          'ui_gonderim_kuyrugu_dolu_veya_depolama_kullanilamiyor_b',
          'Gönderim kuyruğu dolu veya depolama kullanılamıyor. Bekleyen mesajları yeniden deneyin.',
        );
        syncComposerState();
      });
    }

    return readOutbox(userId);
  }

  function renderCurrentOutbox(): void {
    const userId = currentUserId();
    const channelId = currentChannel()?._id;
    if (!userId || !channelId) return;
    hydrateOutbox();
    for (const entry of outboxForChannel(userId, channelId)) {
      BridgeRegistry.call('appendMessage', optimisticOutboxMessage(entry, currentUser()));
    }
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
  }

  /** Reconnect/auth recovery: replay queued entries once on this connection. */
  function replayOutbox(): void {
    syncComposerState();
    const sock = socket();
    const connected = BridgeRegistry.call<boolean>('getSocketConnected') ?? Boolean(sock);
    if (!sock || !connected) return;

    const userId = currentUserId();
    if (!userId) return;
    hydrateOutbox();
    // Never replay from an unverified legacy/immediate view. Migration first,
    // then the same ackIds are safe to replay from encrypted canonical state.
    if (hydratedUserId !== userId) return;

    // P7 B1 (abuse lab LEG-04/LEG-05): replaying every queued send at once
    // tripped the server spam window (5 per 4 s → 30 s mute after 7) and the
    // socket event gate (20 per 10 s, dropped without an ACK, so delivered
    // messages showed "failed"). Replay is paced through the same held FIFO and
    // spacing the rate-limit hold already uses: one send now, then one per
    // HOLD_RELEASE_SPACING_MS. Same ackIds; still exactly one replay owner.
    let dispatchedNow = Date.now() < holdUntil || heldAckIds.length > 0;
    for (const stored of readOutbox(userId)) {
      const current = pendingSends.get(stored.ackId);
      if (current?.timer || current?.entry.state === 'sending' || stored.state === 'failed') continue;
      const entry = current?.entry ?? stored;
      pendingSends.set(entry.ackId, { entry, timer: null });
      if (!dispatchedNow) {
        dispatchedNow = true;
        dispatchSend(entry, sock);
      } else if (!heldAckIds.includes(entry.ackId)) {
        heldAckIds.push(entry.ackId);
      }
    }
    if (heldAckIds.length && !holdTimer) {
      holdTimer = setTimeout(releaseHeld, Math.max(HOLD_RELEASE_SPACING_MS, holdUntil - Date.now()));
    }
    renderCurrentOutbox();
  }

  function requestBackgroundReplayWake(): void {
    if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    void navigator.serviceWorker.ready.then(registration => {
      const withSync = registration as ServiceWorkerRegistration & {
        sync?: { register(tag: string): Promise<void> };
      };
      return withSync.sync?.register(LOCAL_FIRST_SYNC_TAG);
    }).catch(error => log.warn('localfirst.sync.register.failed', error));
  }

  function onBrowserOnline(): void {
    replayDurableMessageQueues();
  }

  function onBrowserOffline(): void {
    onSocketDisconnected();
  }

  function onAppState(event: Event): void {
    const active = (event as CustomEvent<{ active?: boolean }>).detail?.active;
    if (active === true) replayDurableMessageQueues();
  }

  function onServiceWorkerMessage(event: MessageEvent): void {
    const data = event.data as { type?: string; online?: boolean } | null;
    if (
      data?.type === 'SW_LOCAL_FIRST_REPLAY'
      || (data?.type === 'SW_NETWORK_STATUS' && data.online === true)
    ) {
      replayDurableMessageQueues();
    }
  }

  /** ACK may have been lost; durable queues become replayable on reconnect. */
  function onSocketDisconnected(): void {
    void handleMessageOperationSocketDisconnected();
    if (pendingEdit) {
      editMutationBusy = false;
      sendError = t('ui_offline_waiting');
    }
    syncComposerState();
    for (const [ackId, item] of pendingSends) {
      if (item.entry.state !== 'sending') continue;
      if (item.timer) clearTimeout(item.timer);
      const queued = patchOutboxEntry(item.entry.userId, ackId, { state: 'queued', lastError: '' })
        ?? { ...item.entry, state: 'queued' as const };
      pendingSends.set(ackId, { entry: queued, timer: null });
      BridgeRegistry.call('updateMessage', { _id: `pending:${ackId}`, pending: true, queued: true, failed: false, lastError: '' });
    }
    document.dispatchEvent(new CustomEvent('bridge:messages-updated'));
    requestBackgroundReplayWake();
  }

  function replayDurableMessageQueues(): void {
    replayOutbox();
    void replayMessageOperations(true);
  }

  function onAuthSuccess(): void {
    hydratedUserId = '';
    hydrateOutbox();
    renderCurrentOutbox();
    replayDurableMessageQueues();
  }

  function onMessageOperationDispatched(event: Event): void {
    const detail = (event as CustomEvent<{ opId?: string; kind?: string }>).detail;
    if (detail?.kind === 'edit-message' && pendingEdit?.nonce === detail.opId) {
      editMutationBusy = true;
      sendError = '';
      syncComposerState();
    }
  }

  function onMessageOperationQueued(event: Event): void {
    const detail = (event as CustomEvent<{ opId?: string; kind?: string }>).detail;
    if (detail?.kind === 'edit-message' && pendingEdit?.nonce === detail.opId) {
      editMutationBusy = false;
      sendError = t('ui_offline_waiting');
      syncComposerState();
    }
  }

  function onMessageOperationTimeout(event: Event): void {
    const detail = (event as CustomEvent<{ opId?: string; kind?: string; targetId?: string }>).detail;
    if (!detail?.opId) return;

    if (detail.kind === 'edit-message' && pendingEdit?.nonce === detail.opId) {
      pendingEdit = null;
      editMutationBusy = false;
      sendError = t("ui_duzenleme_icin_sunucu_onayi_alinamadi_metnin_korunuy", "Düzenleme için sunucu onayı alınamadı. Metnin korunuyor; tekrar deneyebilirsin.");
      syncComposerState();
      return;
    }

    if (detail.kind === 'delete-message') {
      const pending = pendingDeletes.get(detail.opId);
      if (!pending) return;
      pendingDeletes.delete(detail.opId);
      deletingMessageIds.delete(pending.messageId);
      BridgeRegistry.call('toast', t("ui_silme_islemi_icin_sunucu_onayi_alinamadi_tekrar_dene", "Silme işlemi için sunucu onayı alınamadı. Tekrar deneyebilirsin."), 'error');
    }
  }

  // ── Typing ─────────────────────────────────────────────────────────────────
  function startTyping(): void {
    const channel = currentChannel();
    const sock = socket();
    if (!channel?._id || !sock) return;

    if (!typingActive) {
      typingActive = true;
      sock.emit('typing:start', { channelId: channel._id });
    }
    if (typingTimer) clearTimeout(typingTimer);
    typingTimer = setTimeout(stopTyping, TYPING_STOP_MS);
  }

  function stopTyping(): void {
    if (typingTimer) { clearTimeout(typingTimer); typingTimer = null; }
    if (!typingActive) return;
    typingActive = false;
    const channel = currentChannel();
    socket()?.emit('typing:stop', { channelId: channel?._id });
  }

  // ── Düzenle / yanıtla / sil ────────────────────────────────────────────────
  function startEditMessage(message: Message): void {
    if (!input || !message?._id) return;
    // Düzenleme, composer'daki kanal taslağını geçici olarak örter. Taslağı
    // hem bellekte hem DraftManager'da koru; iptal/kayıt sonrası geri getir.
    if (!editTarget) {
      draftBeforeEdit = input.value;
      saveDraft(input.value);
      flushDraft();
    }
    editTarget = message;
    replyTarget = null;
    // Stored channel content is HTML-sanitized; editing must start from what was typed,
    // or saving re-encodes it ("&lt;" → "&amp;lt;") on every edit (Final21 Phase 15).
    input.value = messageText(message);
    autoGrow();
    syncComposerState();
    input.focus();
  }
  function cancelEdit(restoreDraft = true): void {
    const hadEdit = Boolean(editTarget);
    editTarget = null;
    if (input && hadEdit) {
      input.value = restoreDraft ? (draftBeforeEdit ?? loadDraft()) : '';
      autoGrow();
      syncComposerState();
    }
    draftBeforeEdit = null;
  }
  function setReplyTarget(message: Message): void {
    if (!message?._id) return;
    // Düzenleme metni bir yanıt taslağına dönüşmemeli. Önce asıl kanal
    // taslağını geri yükle, sonra reply bağlamına geç.
    if (editTarget) cancelEdit(true);
    replyTarget = message;
    syncComposerState();
    input?.focus();
  }
  function clearReply(): void { replyTarget = null; }

  function deleteMessage(messageId: string): void {
    const channel = currentChannel();
    if (!messageId || !channel?._id || deletingMessageIds.has(messageId)) return;

    const nonce = newAckId();
    deletingMessageIds.add(messageId);
    pendingDeletes.set(nonce, { nonce, messageId, timer: null });

    void queueDeleteMessageOperation({
      opId: nonce,
      messageId,
      channelId: channel._id,
    }).then(({ dispatched }) => {
      if (!pendingDeletes.has(nonce)) return;
      if (!dispatched) BridgeRegistry.call('toast', t('ui_offline_waiting'), 'info');
    }).catch((error: unknown) => {
      pendingDeletes.delete(nonce);
      deletingMessageIds.delete(messageId);
      log.warn('delete.oplog.enqueue.failed', error);
      BridgeRegistry.call('toast', t('mutation_connection_failed', 'İşlem tamamlanamadı. Bağlantını kontrol edip tekrar dene.'), 'error');
    });
  }

  function resolveEditMutation(clientNonce: string, messageId: string): void {
    if (!pendingEdit || pendingEdit.nonce !== clientNonce || pendingEdit.messageId !== messageId) return;
    if (pendingEdit.timer) clearTimeout(pendingEdit.timer);
    pendingEdit = null;
    editMutationBusy = false;
    sendError = '';
    log.info(`Mesaj düzenleme sunucu tarafından onaylandı: ${messageId.slice(0, 8)}`);
    cancelEdit(true);
    BridgeRegistry.call('toast', t("ui_mesaj_duzenlendi", "Mesaj düzenlendi."), 'success');
    syncComposerState();
  }

  function failEditMutation(clientNonce: string, code?: string): void {
    if (!pendingEdit || pendingEdit.nonce !== clientNonce) return;
    if (pendingEdit.timer) clearTimeout(pendingEdit.timer);
    pendingEdit = null;
    editMutationBusy = false;
    sendError = safeMutationError(code);
    syncComposerState();
  }

  function resolveDeleteMutation(clientNonce: string, messageId: string): void {
    const pending = pendingDeletes.get(clientNonce);
    if (!pending || pending.messageId !== messageId) return;
    if (pending.timer) clearTimeout(pending.timer);
    pendingDeletes.delete(clientNonce);
    deletingMessageIds.delete(messageId);
    log.info(`Mesaj silme sunucu tarafından onaylandı: ${messageId.slice(0, 8)}`);
    BridgeRegistry.call('toast', t("ui_mesaj_silindi", "Mesaj silindi."), 'success');
  }

  function failDeleteMutation(clientNonce: string, code?: string): void {
    const pending = pendingDeletes.get(clientNonce);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    pendingDeletes.delete(clientNonce);
    deletingMessageIds.delete(pending.messageId);
    BridgeRegistry.call('toast', safeMutationError(code), 'error');
  }

  // ── Girdi olayları ─────────────────────────────────────────────────────────
  function autoGrow(): void {
    if (!input) return;
    input.style.height = 'auto';
    // `scrollHeight` can be zero while the shell is mounting or the composer
    // is temporarily hidden. Never collapse the one-line input in that state.
    input.style.height = `${Math.min(Math.max(input.scrollHeight, 38), 180)}px`;
  }

  function syncMentionAria(): void {
    if (!input) return;
    // A textarea is a textbox: aria-expanded/combobox are not allowed on it, but
    // aria-autocomplete, aria-controls and aria-activedescendant are.
    input.setAttribute('aria-autocomplete', 'list');
    if (mentionOptions.length) {
      input.setAttribute('aria-controls', 'mention-suggestions');
      input.setAttribute('aria-activedescendant', `mention-option-${mentionIndex}`);
    } else {
      input.removeAttribute('aria-controls');
      input.removeAttribute('aria-activedescendant');
    }
  }

  function closeMentions(): void {
    if (!mentionOptions.length && !mentionQuery) return;
    mentionQuery = null;
    mentionOptions = [];
    mentionIndex = 0;
    syncMentionAria();
  }

  function updateMentionSuggestions(): void {
    if (!input || input.selectionStart !== input.selectionEnd) { closeMentions(); return; }
    const found = activeMentionQuery(input.value, input.selectionStart ?? input.value.length);
    if (!found) { closeMentions(); return; }
    const members = BridgeRegistry.has('getCurrentServerMembers')
      ? BridgeRegistry.call<MentionMember[]>('getCurrentServerMembers')
      : [];
    const options = rankMentionCandidates(Array.isArray(members) ? members : [], found.query);
    mentionQuery = options.length ? found : null;
    mentionOptions = options;
    if (mentionIndex >= options.length) mentionIndex = 0;
    syncMentionAria();
  }

  function chooseMention(option: MentionCandidate): void {
    if (!input || !mentionQuery) return;
    const next = applyMention(input.value, input.selectionStart ?? input.value.length, mentionQuery, option.username);
    input.value = next.text;
    input.setSelectionRange(next.caret, next.caret);
    closeMentions();
    onInput();
    input.focus();
  }

  function onCaretMove(event: Event): void {
    if (event instanceof KeyboardEvent && !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    updateMentionSuggestions();
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (mentionOptions.length) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const count = mentionOptions.length;
        mentionIndex = (mentionIndex + (event.key === 'ArrowDown' ? 1 : count - 1)) % count;
        syncMentionAria();
        return;
      }
      if ((event.key === 'Enter' && !event.shiftKey) || event.key === 'Tab') {
        event.preventDefault();
        const option = mentionOptions[mentionIndex];
        if (option) chooseMention(option);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMentions();
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      sendMessage();
      return;
    }
    if (event.key === 'Escape') {
      if (editTarget) cancelEdit();
      else if (replyTarget) clearReply();
    }
  }

  function onInput(): void {
    autoGrow();
    updateMentionSuggestions();
    if (input && input.value.length <= MAX_LENGTH && sendErrorKind === 'too_long') { sendError = ''; sendErrorKind = ''; }
    if (input && input.value.trim().length > 0) startTyping();
    else stopTyping();
    // Faz 8.2: taslak kaydı (DraftManager debounce uygular).
    // Düzenleme modunda kaydedilmez — düzenlenen mesajın içeriği taslak
    // değildir, aksi halde Esc sonrası eski mesaj metni taslak olarak kalırdı.
    if (input && !editTarget) saveDraft(input.value);
    syncComposerState();
  }

  function onPaste(event: ClipboardEvent): void {
    // Faz 5 notu ARTIK GECERSIZ: dosya yapistirma gercekten destekleniyor.
    // Pano dosya iceriyorsa varsayilan metin yapistirma engellenir ve dosya
    // composer'a EK olarak alinir; metin panosu davranisi degismez.
    const files = event.clipboardData?.files;
    if (!files || files.length === 0) return;
    event.preventDefault();
    acceptFile(files[0]);
  }

  /** Surukle-birak: composer kabugu uzerine birakilan ilk dosya EK olur. */
  function onDragOver(event: DragEvent): void {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
  function onDrop(event: DragEvent): void {
    const f = event.dataTransfer?.files?.[0];
    if (!f) return;
    event.preventDefault();
    acceptFile(f);
  }

  // Kanal değişince composer sıfırlanır ve doğru kanal adı gösterilir.
  function onChannelSelected(): void {
    // Faz 8.2 — ÖNCE eski kanalın bekleyen taslağı diske indirilir. Bu satır
    // olmadan debounce penceresi (400ms) içinde kanal değiştiren kullanıcı
    // son yazdıklarını kaybederdi. `getCurrentChannel` bu noktada zaten YENİ
    // kanalı döndürüyor; bu yüzden anahtar DraftManager'da yazma kurulurken
    // donduruluyor (scheduleWrite) ve flush doğru kanala yazıyor.
    flushDraft();

    stopTyping();
    cancelEdit(false);
    clearReply();
    closeMentions();
    sendError = '';
    closeSchedule();
    const channel = currentChannel();
    // A File object is deliberately not persisted and must never follow the
    // user into another destination. Its old destination already has a small
    // boolean recovery hint stored from acceptFile().
    const nextAttachmentContext = currentDraftContextKey();
    if (attachment && attachmentContextKey !== nextAttachmentContext) {
      attachment = null;
      attachmentContextKey = '';
    }
    uploading = false;
    if (!attachment) attachError = loadAttachmentPending() ? t("ui_ek_dosya_yeniden_secilmeli", "Ek dosya yeniden seçilmeli.") : '';
    // Yer tutucu INGILIZCE sabit kodluydu ("Message #general") ve Turkce
    // arayuzde oldugu gibi gorunuyordu — hem de urunun EN COK kullanilan
    // yuzeyinde. Kanonik i18n'e alindi.
    if (input) {
      input.placeholder = channel?.name
        ? `${t('composer_placeholder', 'Mesaj gönder')} #${channel.name}`
        : t('composer_placeholder_empty', 'Mesaj gönder');
    }

    // Yeni kanalın taslağı geri yüklenir (yoksa kutu temizlenir — önceki
    // kanalın metni yeni kanalda görünmemeli).
    if (input) {
      input.value = channel?._id ? restorableDraft(String(channel._id)) : '';
      autoGrow();
    }

    // Composer yalnızca metin kanallarında görünür (legacy channel-list.ts:146-153).
    const isText = isTextChannel(channel);
    if (wrap) wrap.style.display = channel?._id && isText ? '' : 'none';
    syncComposerState();
    renderCurrentOutbox();
  }

  function onSendClick(event: Event): void { event.preventDefault(); sendMessage(); }

  function onDraftHydrated(event: Event): void {
    const detail = (event as CustomEvent<{
      userId?: string;
      kind?: string;
      conversationId?: string;
      serverId?: string;
      attachmentPending?: boolean;
    }>).detail;
    const channel = currentChannel();
    const userId = currentUserId();
    if (!detail || !channel?._id || !userId) return;

    const kind = draftKindOf(channel);
    const serverId = kind === 'channel'
      ? channel.serverId ?? BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer')?._id ?? ''
      : undefined;

    if (
      detail.userId !== userId
      || detail.conversationId !== String(channel._id)
      || detail.kind !== kind
      || (kind === 'channel' && detail.serverId !== serverId)
    ) return;

    // Hydration is asynchronous. Never overwrite characters typed while the
    // encrypted database was opening.
    if (input && !editTarget && input.value.length === 0) {
      input.value = restorableDraft(String(channel._id));
      autoGrow();
      syncComposerState();
    }

    if (!attachment && !uploading) {
      attachError = detail.attachmentPending
        ? t("ui_ek_dosya_yeniden_secilmeli", "Ek dosya yeniden seçilmeli.")
        : '';
    }
  }

  onMount(() => {
    input = document.getElementById('msg-input') as HTMLTextAreaElement | null;
    wrap  = document.getElementById('msg-input-wrap');
    // index.html'deki data-bridge-action dispatcher'ı BridgeRegistry'yi global
    // sanıyor (index.html:1011) — ESM export olduğu için registry'ye ulaşamıyor.
    // Global üretmek yerine düğmeye doğrudan burada bağlanılıyor.
    sendButton = document.querySelector<HTMLButtonElement>('#msg-input-wrap [data-bridge-action="sendMessage"]');

    input?.addEventListener('keydown', onKeyDown);
    input?.addEventListener('input', onInput);
    input?.addEventListener('click', onCaretMove);
    input?.addEventListener('keyup', onCaretMove);
    input?.addEventListener('blur', closeMentions);
    input?.addEventListener('paste', onPaste);
    sendButton?.addEventListener('click', onSendClick);

    // Ek dugmesi ve gizli dosya girisi de AYNI nedenle dogrudan baglanir.
    fileInput    = document.getElementById('msg-file-input') as HTMLInputElement | null;
    attachButton = document.getElementById('btn-attach') as HTMLButtonElement | null;
    scheduleButton = document.getElementById('btn-schedule-message') as HTMLButtonElement | null;
    attachButton?.addEventListener('click', onAttachClick);
    scheduleButton?.addEventListener('click', openSchedule);
    fileInput?.addEventListener('change', onFileChosen);
    wrap?.addEventListener('dragover', onDragOver);
    wrap?.addEventListener('drop', onDrop);
    document.addEventListener('bridge:channel-selected', onChannelSelected);
    document.addEventListener('bridge:draft-hydrated', onDraftHydrated);
    // Faz 8.2: çıkışta görünür taslak metni ekranda kalmamalı — bir sonraki
    // kullanıcı giriş yaptığında composer'da eski metni görmesin.
    document.addEventListener('bridge:auth-logout', onLogout);
    document.addEventListener('bridge:auth-success', onAuthSuccess);
    document.addEventListener('bridge:socket-ready', replayDurableMessageQueues);
    document.addEventListener('bridge:socket-reconnected', replayDurableMessageQueues);
    document.addEventListener('bridge:socket-disconnected', onSocketDisconnected);
    window.addEventListener('online', onBrowserOnline);
    window.addEventListener('offline', onBrowserOffline);
    window.addEventListener('bridge:appstate', onAppState);
    navigator.serviceWorker?.addEventListener('message', onServiceWorkerMessage);
    document.addEventListener('bridge:message-operation-dispatched', onMessageOperationDispatched);
    document.addEventListener('bridge:message-operation-queued', onMessageOperationQueued);
    document.addEventListener('bridge:message-operation-timeout', onMessageOperationTimeout);

    onChannelSelected();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) onBrowserOffline();
    else replayDurableMessageQueues();
    log.info('Mesaj girişi hazır');
  });

  function onLogout(): void {
    attachmentLifecycleSeq += 1;
    if (input) { input.value = ''; autoGrow(); }
    cancelEdit(false);
    clearReply();
    sendError = '';
    closeSchedule();
    attachment = null;
    attachmentContextKey = '';
    uploading = false;
    attachError = '';
    // Faz 10.7 — uçuştaki gönderimler ÖNCEKİ kullanıcıya aittir.
    // Bu bileşen çıkışta unmount edilmediği için `pendingSends` yaşıyordu:
    // A'nın ACK zaman aşımı zamanlayıcıları B'nin oturumunda ateşlenip
    // `updateMessage` ile B'nin mesaj listesine yazabiliyordu.
    clearPendingMemory();
    clearPendingMutationTimers();
    hydratedUserId = '';
    hydratingOutboxUserId = '';
    outboxHydrationSeq += 1;
    if (lastOutboxUserId) closeLocalFirstOutboxRuntime(lastOutboxUserId);
    lastOutboxUserId = '';
    closeMessageOperationSync();
    syncComposerState();
  }

  // MessageListPanel bu adları çağırıyor; gönder düğmesi data-bridge-action="sendMessage".
  BridgeRegistry.register('sendMessage', () => sendMessage());
  BridgeRegistry.register('sendSticker', (sticker: { id: string; packId: string; name: string; url: string; width: number; height: number }) => sendSticker(sticker));
  BridgeRegistry.register('setReplyTarget', (message: Message) => setReplyTarget(message));
  BridgeRegistry.register('startEditMessage', (message: Message) => startEditMessage(message));
  BridgeRegistry.register('deleteMessage', (messageId: string) => deleteMessage(messageId));
  // Teslim durum makinesi köprüleri (MessageLoader ACK/hata olaylarında çağırır)
  BridgeRegistry.register('retrySend', (ackId: string) => retrySend(ackId));
  BridgeRegistry.register('discardSend', (ackId: string) => discardSend(ackId));
  BridgeRegistry.register('rejectPendingSend', (ackId: string, kind: 'rate' | 'slowmode' | 'duplicate' | 'timeout', amount: number) => rejectPendingSend(ackId, kind, amount));
  BridgeRegistry.register('noteSpamWarning', () => noteSpamWarning());
  BridgeRegistry.register('resolvePendingSend', (ackId: string) => resolvePendingSend(ackId));
  BridgeRegistry.register('failPendingSend', (ackId: string, message?: string) => failPendingSend(ackId, message));
  BridgeRegistry.register('resolveEditMutation', (clientNonce: string, messageId: string) => resolveEditMutation(clientNonce, messageId));
  BridgeRegistry.register('failEditMutation', (clientNonce: string, code?: string) => failEditMutation(clientNonce, code));
  BridgeRegistry.register('resolveDeleteMutation', (clientNonce: string, messageId: string) => resolveDeleteMutation(clientNonce, messageId));
  BridgeRegistry.register('failDeleteMutation', (clientNonce: string, code?: string) => failDeleteMutation(clientNonce, code));

  onDestroy(() => {
    attachmentLifecycleSeq += 1;
    // Bekleyen taslak yazması kaybolmadan diske indirilir.
    flushDraft();
    input?.removeEventListener('keydown', onKeyDown);
    input?.removeEventListener('input', onInput);
    input?.removeEventListener('click', onCaretMove);
    input?.removeEventListener('keyup', onCaretMove);
    input?.removeEventListener('blur', closeMentions);
    input?.removeEventListener('paste', onPaste);
    sendButton?.removeEventListener('click', onSendClick);
    attachButton?.removeEventListener('click', onAttachClick);
    scheduleButton?.removeEventListener('click', openSchedule);
    fileInput?.removeEventListener('change', onFileChosen);
    wrap?.removeEventListener('dragover', onDragOver);
    wrap?.removeEventListener('drop', onDrop);
    document.removeEventListener('bridge:channel-selected', onChannelSelected);
    document.removeEventListener('bridge:draft-hydrated', onDraftHydrated);
    document.removeEventListener('bridge:auth-logout', onLogout);
    document.removeEventListener('bridge:auth-success', onAuthSuccess);
    document.removeEventListener('bridge:socket-ready', replayDurableMessageQueues);
    document.removeEventListener('bridge:socket-reconnected', replayDurableMessageQueues);
    document.removeEventListener('bridge:socket-disconnected', onSocketDisconnected);
    window.removeEventListener('online', onBrowserOnline);
    window.removeEventListener('offline', onBrowserOffline);
    window.removeEventListener('bridge:appstate', onAppState);
    navigator.serviceWorker?.removeEventListener('message', onServiceWorkerMessage);
    document.removeEventListener('bridge:message-operation-dispatched', onMessageOperationDispatched);
    document.removeEventListener('bridge:message-operation-queued', onMessageOperationQueued);
    document.removeEventListener('bridge:message-operation-timeout', onMessageOperationTimeout);
    stopTyping();
    // Uçuştaki ACK zamanlayıcıları da bırakılmalı (leak yok).
    clearPendingMemory();
    clearPendingMutationTimers();
    BridgeRegistry.unregister('sendMessage');
    BridgeRegistry.unregister('sendSticker');
    BridgeRegistry.unregister('setReplyTarget');
    BridgeRegistry.unregister('startEditMessage');
    BridgeRegistry.unregister('deleteMessage');
    BridgeRegistry.unregister('retrySend');
    BridgeRegistry.unregister('discardSend');
    BridgeRegistry.unregister('rejectPendingSend');
    BridgeRegistry.unregister('noteSpamWarning');
    if (holdTimer) { clearTimeout(holdTimer); holdTimer = null; }
    BridgeRegistry.unregister('resolvePendingSend');
    BridgeRegistry.unregister('failPendingSend');
    BridgeRegistry.unregister('resolveEditMutation');
    BridgeRegistry.unregister('failEditMutation');
    BridgeRegistry.unregister('resolveDeleteMutation');
    BridgeRegistry.unregister('failDeleteMutation');
    closeMessageOperationSync();
  });
</script>

{#if mentionOptions.length}
  <div class="mention-suggestions" id="mention-suggestions" role="listbox" aria-label={t('mention_suggestions_aria', 'Bahsedilecek kişi önerileri')}>
    {#each mentionOptions as option, index (option.id)}
      <div
        class="mention-option"
        class:active={index === mentionIndex}
        id={`mention-option-${index}`}
        role="option"
        aria-selected={index === mentionIndex}
        tabindex="-1"
        onmousedown={(event) => { event.preventDefault(); chooseMention(option); }}
      ><span class="mention-name">{option.displayName}</span><span class="mention-username">@{option.username}</span></div>
    {/each}
  </div>
  <span class="mention-sr-only" role="status" aria-live="polite">{t('mention_suggestions_count', '{count} öneri — ok tuşları ve Enter ile seç', { count: mentionOptions.length })}</span>
{/if}

{#if replyTarget}
  <div class="composer-context composer-reply" data-composer-mode="reply">
    <span class="context-mark" aria-hidden="true"></span>
    <span class="context-copy"><small>{t('mip_replying', 'Yanıtlanıyor')}</small><strong>{replyTarget.displayName ?? replyTarget.username ?? t("message")}</strong>{#if replyTarget.content}<em>{replyTarget.content}</em>{/if}</span>
    <button type="button" onclick={clearReply} aria-label={t('mip_cancel_reply', 'Yanıtı iptal et')}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>
  </div>
{/if}

{#if editTarget}
  <div class="composer-context composer-edit" data-composer-mode="edit">
    <span class="context-mark" aria-hidden="true"></span>
    <span class="context-copy"><small>{t('mip_editing', 'Mesaj düzenleniyor')}</small><strong>{t('markup_enter_ile_kaydet_esc_ile_iptal_et_dbc8fce', "Enter ile kaydet · Esc ile iptal et")}</strong></span>
    <button type="button" onclick={() => cancelEdit(true)} aria-label={t('mip_cancel_edit', 'Düzenlemeyi iptal et')}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8"/></svg></button>
  </div>
{/if}

{#if attachment || uploading || attachError}
  <div class="composer-context composer-attach" data-composer-mode="attach">
    <span class="context-mark" aria-hidden="true"></span>
    <span class="context-copy">
      <small>{uploading ? t("sp_loading") : t('tip_attach')}</small>
      <strong>{attachment?.name ?? t('search_has_file')}</strong>
      {#if attachment}<em>{humanSize(attachment.size)}</em>{/if}
    </span>
    {#if attachError}<span class="attach-error" role="alert">{attachError}</span>{/if}
    {#if attachError && attachment && !uploading}
      <button type="button" class="attach-retry" onclick={retryAttachment}>{t('retry')}</button>
    {/if}
    <button type="button" onclick={clearAttachment} disabled={uploading} aria-label={t('mip_remove_attach', 'Eki kaldır')}>
      <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m6 6 8 8M14 6l-8 8"/></svg>
    </button>
  </div>
{/if}

{#if scheduleOpen}
  <div class="composer-context composer-schedule" data-composer-mode="schedule">
    <span class="context-mark" aria-hidden="true"></span>
    <span class="context-copy"><small>{t("schedule_send_later")}</small><strong>{t("schedule_choose_time")}</strong></span>
    <input class="schedule-input" type="datetime-local" bind:value={scheduleAt} min={localDateTimeValue(Date.now() + 30_000)} aria-label={t("schedule_send_time")} />
    {#if scheduleError}<span class="attach-error" role="alert">{scheduleError}</span>{/if}
    <button type="button" class="schedule-manage-toggle" aria-expanded={scheduledManageOpen} onclick={() => void toggleScheduledManager()}>
      {t('markup_bekleyenler_88c80ae', "Bekleyenler")}
    </button>
    <button type="button" class="schedule-confirm" disabled={scheduleBusy} onclick={() => void confirmSchedule()} aria-label={t("schedule_message")}>{scheduleBusy ? '…' : '✓'}</button>
    <button type="button" onclick={closeSchedule} disabled={scheduleBusy} aria-label={t('attr_zamanlama_panelini_kapat_0f1b112', "Zamanlama panelini kapat")}>✕</button>

    {#if scheduledManageOpen}
      <section class="schedule-manager" aria-label={t("schedule_pending_channel")}>
        <div class="schedule-manager-head">
          <strong>{t('markup_bu_kanaldaki_bekleyenler_ad4b2b0', "Bu kanaldaki bekleyenler")}</strong>
          <button type="button" disabled={scheduledLoading || Boolean(scheduledCancellingId)} onclick={() => void loadScheduledForCurrentChannel()}>{t('markup_yenile_255b90e', "Yenile")}</button>
        </div>
        {#if scheduledManageError}<p class="schedule-manager-error" role="alert">{scheduledManageError}</p>{/if}
        {#if scheduledLoading}
          <p class="schedule-manager-state" role="status">{t("loading")}</p>
        {:else if scheduledItems.length === 0}
          <p class="schedule-manager-state">{t("schedule_empty")}</p>
        {:else}
          <ul class="schedule-list">
            {#each scheduledItems as item (item._id)}
              <li>
                <div>
                  <time datetime={new Date(item.sendAt).toISOString()}>{new Date(item.sendAt).toLocaleString()}</time>
                  <p>{item.content}</p>
                </div>
                <button type="button" class="schedule-cancel" disabled={Boolean(scheduledCancellingId)} onclick={() => void cancelScheduled(item._id)}>
                  {scheduledCancellingId === item._id ? t("surface_iptal_ediliyor_296b2c") : t("cancel")}
                </button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  </div>
{/if}

{#if sendError || charCount >= COUNTER_THRESHOLD}
  <div id="composer-status" class="composer-status" class:composer-error={Boolean(sendError)} role={sendError ? 'alert' : 'status'}>
    {#if sendError}<span>{sendError}</span>{/if}
    {#if charCount >= COUNTER_THRESHOLD}<span class="composer-counter" class:over-limit={charCount > MAX_LENGTH}>{charCount}/{MAX_LENGTH}</span>{/if}
  </div>
{/if}

{@render children?.()}

<style>
  .mention-suggestions {
    display: grid; gap: 1px; max-height: 260px; overflow-y: auto;
    margin: 0 14px 4px; padding: 4px; border: 1px solid var(--bg-5); border-radius: var(--r-lg);
    background: var(--bg-2); box-shadow: var(--shadow-md);
  }
  .mention-option { display: flex; align-items: baseline; gap: 8px; min-height: 32px; padding: 6px 10px; border-radius: var(--radius-control); cursor: pointer; }
  .mention-option.active, .mention-option:hover { background: var(--surface-hover); }
  .mention-name { color: var(--text-primary); font-weight: 600; }
  .mention-username { color: var(--text-muted); font-size: 12px; }
  .mention-sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
  .composer-context {
    display: flex; align-items: center; gap: 9px; min-height: 42px;
    margin: 0 14px; padding: 6px 9px 6px 12px; border: 1px solid var(--bg-5); border-bottom: 0;
    border-radius: var(--r-lg) var(--r-lg) 0 0; background: var(--bg-3); color: var(--text-3); font-size: 12px;
  }
  .context-mark { width: 3px; height: 25px; flex: none; border-radius: 99px; background: var(--brand); }
  .composer-attach .context-mark { background: var(--green, #3ba55d); }
  .composer-attach .context-copy em { color: var(--text-3); font-style: normal; }
  .attach-error { min-width: 0; overflow: hidden; color: var(--danger); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .attach-retry { min-height: 32px; padding: 0 10px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); background: var(--bg-3); color: var(--text-1); font: inherit; font-size: 11px; font-weight: 650; cursor: pointer; white-space: nowrap; }
  .attach-retry:hover { background: var(--bg-4); }
  .composer-edit .context-mark { background: var(--yellow, #f0b132); }
  .context-copy { display: flex; min-width: 0; flex: 1; align-items: baseline; gap: 7px; }
  .context-copy small { color: var(--text-3); font-size: 10px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
  .context-copy strong { color: var(--text-1); font-size: 12px; font-weight: 650; white-space: nowrap; }
  .context-copy em { min-width: 0; overflow: hidden; color: var(--text-3); font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
  .composer-context button {
    display: grid; width: 32px; height: 32px; flex: none; padding: 0; place-items: center;
    background: none; border: 0; border-radius: var(--r-sm); color: inherit; cursor: pointer;
  }
  .composer-context button:hover { background: var(--bg-4); color: var(--text-1); }
  .composer-context svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.8; }
  .composer-status { display: flex; justify-content: space-between; min-height: 20px; margin: 0 18px; padding: 2px 7px; color: var(--text-3); font-size: 11px; }
  .composer-status > :only-child { margin-left: auto; }
  .composer-error { color: var(--danger); }
  .composer-counter { margin-left: auto; color: var(--text-3); font-variant-numeric: tabular-nums; }
  .composer-counter.over-limit { color: var(--danger); font-weight: 650; }
  @media (max-width: 600px) {
    .composer-context { margin-inline: 8px; }
    .context-copy em { display: none; }
  }

  .composer-schedule { flex-wrap: wrap; }
  .schedule-input { min-width: 190px; padding: 6px 8px; color: var(--text-primary); background: var(--bg-input); border: 1px solid var(--border); border-radius: var(--radius-control); }
  .schedule-input:focus-visible, .schedule-confirm:focus-visible, .schedule-manage-toggle:focus-visible, .schedule-manager button:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .schedule-confirm { color: var(--text-on-solid); background: var(--brand); border-radius: var(--radius-control); }
  .schedule-manage-toggle { width: auto !important; min-width: 82px; padding-inline: 9px !important; font-size: 11px; font-weight: 650; }
  .schedule-manager { width: 100%; padding: 8px; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--bg-2); }
  .schedule-manager-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 6px; color: var(--text-1); }
  .schedule-manager-head button { width: auto; height: 26px; padding-inline: 8px; font-size: 11px; }
  .schedule-manager-state, .schedule-manager-error { margin: 4px 0; font-size: 11px; }
  .schedule-manager-error { color: var(--danger); }
  .schedule-list { display: grid; gap: 5px; max-height: 190px; margin: 0; padding: 0; overflow: auto; list-style: none; }
  .schedule-list li { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 7px 8px; border-radius: var(--r-sm); background: var(--bg-3); }
  .schedule-list li > div { min-width: 0; }
  .schedule-list time { color: var(--text-3); font-size: 10px; }
  .schedule-list p { max-width: 560px; margin: 2px 0 0; overflow: hidden; color: var(--text-2); font-size: 11px; text-overflow: ellipsis; white-space: nowrap; }
  .schedule-cancel { width: auto !important; padding-inline: 8px !important; color: var(--danger) !important; font-size: 11px; }
  @media (max-width: 560px) {
    .schedule-input { flex: 1 1 100%; width: 100%; }
    .schedule-list li { align-items: flex-start; }
    .schedule-list p { max-width: 220px; }
  }
</style>
