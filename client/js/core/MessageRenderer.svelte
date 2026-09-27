<!-- client/js/core/MessageRenderer.svelte -->
<!-- Sprint 116 — messages/renderer.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Mesaj HTML üretici -->
<!--
  Faz 4 (toparlama): Tek bir mesajın görünümü.

  GÜVENLİK: legacy renderer innerHTML + elle escape kullanıyordu. Burada tüm
  kullanıcı içeriği Svelte'in metin enterpolasyonu ile basılır ({...}), yani
  hiçbir yerde innerHTML/@html YOKTUR — XSS yüzeyi kapalıdır.
  Sunucu ayrıca içeriği sanitize ediyor (messages-send.ts:171 sanitizeMessageContent).

  Ek koruma: dosya/ek URL'leri yalnızca göreli yol veya http(s) ise link yapılır
  (javascript:, data: vb. şemalar reddedilir).
-->
<script lang="ts">
  import { onDestroy } from 'svelte';
  import {
    getMediaCredentialGeneration,
    isProtectedMediaUrl,
    renewMediaCredential,
    withMediaRetry,
  } from './media-auth.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { safeServerUrl } from './globals.ts';
  import { buildPermalink, copyToClipboard } from './permalink/message-permalink.ts';
  import MessageActionSheet, { type SheetAction } from './MessageActionSheet.svelte';
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { formatMessage, messageText, type FormatNode } from './messages/message-format.ts';

  export interface MessageData {
    _id: string;
    userId?: string;
    username?: string;
    displayName?: string;
    avatarColor?: string;
    avatarUrl?: string | null;
    content?: string;
    type?: string;
    createdAt?: number;
    channelId?: string;
    serverId?: string;
    editedAt?: number;
    reactions?: Record<string, unknown>;
    /** Teslim durumu (yalnızca istemci tarafı — sunucudan gelmez). */
    pending?: boolean;
    /** Persisted outbox item waiting for a socket connection. */
    queued?: boolean;
    failed?: boolean;
    ackId?: string;
    /** Human-readable server denial/failure reason retained by the outbox. */
    lastError?: string;
    /** Gönderim anındaki anlık görüntü. `deleted` sunucu tarafında işaretlenir
     *  (lib/deleteMessageCascade.ts) → orijinal silinse de durum reload'da korunur. */
    replyTo?: { _id?: string; displayName?: string; content?: string; deleted?: boolean } | null;
    fileUrl?: string;
    fileName?: string;
    fileType?: string;
    sticker?: { id?: string; packId?: string; name?: string; url?: string; width?: number; height?: number } | null;
    /** Set by the server when a bot authored the message (lib/botInteractionReply.ts). */
    botId?: string | null;
    /** Set by the server for incoming-webhook posts. */
    isWebhook?: boolean;
    [key: string]: unknown;
  }

  interface LinkEmbed {
    url: string;
    title: string;
    description?: string | null;
    siteName?: string;
  }

  interface Props {
    message?: MessageData | null;
    currentUserId?: string | null;
    onReply?: (message: MessageData) => void;
    onThread?: (message: MessageData) => void;
    onEdit?: (message: MessageData) => void;
    onDelete?: (message: MessageData) => void;
    onSave?: (message: MessageData) => void;
    onReport?: (message: MessageData, reason: string, detail: string) => Promise<boolean> | boolean;
    /** Sabitle/kaldır — KANONIK `message:pin` olayına delege eder (toggle). */
    onPin?: (message: MessageData) => void;
    /** Announcement kanalında server-authoritative publish/crosspost. */
    onCrosspost?: (message: MessageData) => void;
    canCrosspost?: boolean;
    crosspostBusy?: boolean;
    /** MANAGE_MESSAGES kanıtlanabiliyorsa true; ölü/yanıltıcı kontrol gösterilmez. */
    canPin?: boolean;
    /** Tepki ekle/kaldir — KANONIK `message:react` olayina delege eder. */
    onReact?: (message: MessageData, emoji: string) => void;
    /** Orijinal mesaja atla (yalnızca yüklüyse verilir). */
    onJumpToReply?: (messageId: string) => void;
    /** Orijinal mesajın yüklü listedeki güncel hali — düzenlenmişse yeni içerik gösterilir. */
    replySource?: { content?: string; displayName?: string; deletedAt?: number | null } | null;
    /** Başarısız gönderimi aynı ackId ile yeniden dener (sunucu tarafında dedup edilir). */
    onRetry?: (ackId: string) => void;
    /** Başarısız gönderimden vazgeçer: kalıcı giden kutusundan ve listeden kaldırır (U-12). */
    onDiscard?: (ackId: string) => void;
    /**
     * Ardışık gruplama: aynı yazarın kısa aralıkla attığı takip mesajı.
     * Avatar ve başlık satırı çizilmez; saat yalnızca hover'da görünür.
     */
    compact?: boolean;
    /**
     * DOLASAN TABINDEX (roving tabindex).
     *
     * KAPATILAN GERCEK KUSUR: `.msg-actions` temel durumda
     * `visibility: hidden` idi. Bu, icindeki dugmeleri ODAKLANAMAZ yapar.
     * `.msg` de odaklanabilir degildi. Sonuc: duz bir metin mesajinda
     * `.msg:focus-within` KURALI HIC ATESLENEMEZDI ve yanitla/duzenle/sil
     * yalnizca HOVER ile, yani YALNIZCA FAREYLE erisilebiliyordu.
     * (WCAG 2.1.1 Klavye, Seviye A.)
     *
     * Neden her dugmeyi tek tek odaklanabilir YAPMADIK: 50 mesajlik bir
     * kanalda bu ~300 tab duragi demekti; yazma alanina ulasmak imkansiz
     * hale gelirdi. Kanonik cozum ARIA'nin dolasan tabindex desenidir:
     * TUM gunluk icin TEK durak, mesajlar arasinda ok tuslariyla gezinme.
     */
    tabIndex?: number;
    /** Odak bu mesaja gectiginde listeye haber verir (dolasan durum listede). */
    onFocusMessage?: (messageId: string) => void;
  }

  let { message = null, currentUserId = null, onReply, onThread, onEdit, onDelete, onSave, onReport, onPin, canPin = false, onCrosspost, canCrosspost = false, crosspostBusy = false, onReact, onJumpToReply, replySource = null, onRetry, onDiscard, compact = false, tabIndex = -1, onFocusMessage }: Props = $props();

  /** Sabitli mi — `message:pinned` olayı store'daki `pinned` alanını günceller. */
  const isPinned = $derived(Boolean(message?.pinned));
  /** Sabitleme yalnızca gerçekten teslim edilmiş mesajlarda anlamlıdır
   *  (`pending`/`queued`/`failed` değil — `isDelivered` ile aynı sözleşme). */
  const canShowPin = $derived(
    canPin && Boolean(onPin) && Boolean(message?._id)
    && !message?.pending && !message?.queued && !message?.failed,
  );

  // Yanıt önizlemesinin durumu:
  //   deleted  → orijinal silinmiş (sunucu işaretlemesi veya yüklü kopyada deletedAt)
  //   jumpable → orijinal şu an yüklü, tıklanınca ona gidilebilir
  const replyDeleted = $derived(Boolean(message?.replyTo?.deleted || replySource?.deletedAt));
  const replyJumpable = $derived(Boolean(!replyDeleted && replySource && message?.replyTo?._id && onJumpToReply));
  // Orijinal yüklüyse onun GÜNCEL içeriği gösterilir (düzenleme anında yansır),
  // değilse gönderim anındaki anlık görüntü kullanılır.
  const replyAuthor  = $derived(replySource?.displayName ?? message?.replyTo?.displayName ?? t('unknown_user'));
  const replyText    = $derived(messageText(replySource?.content !== undefined ? replySource : message?.replyTo));
  // Channel content is stored HTML-sanitized (entities encoded); show what was typed,
  // with the formatting that was asked for (messages/message-format.ts, Final21 Phase 15).
  const contentNodes = $derived(message?.content ? formatMessage(messageText(message)) : []);

  const isSystem = $derived(message?.type === 'system');
  // ══════════════════════════════════════════════════════════════════════
  // MOBİL EYLEM SAYFASI — UZUN BASMA
  // ══════════════════════════════════════════════════════════════════════
  // Dokunmatikte masaüstü çubuğu kalıcı görünüp mesaj genişliğinin ~%45'ini
  // yiyordu. Artık çubuk dokunmatikte gizli; eylemler uzun basınca açılan
  // sayfadan gelir. İş mantığı BURADA ÇOĞALTILMAZ: sayfa, masaüstü
  // çubuğuyla AYNI işleyicileri ve AYNI izin koşullarını kullanır.
  let sheetOpen = $state(false);
  /** Sağ tıkla açıldıysa imleç noktası; uzun basmada null (alttan açılan sayfa). */
  let sheetAnchor = $state<{ x: number; y: number } | null>(null);
  let historyOpen = $state(false);
  let historyLoading = $state(false);
  let historyError = $state('');
  let historyEntries = $state<Array<{ content: string; editedAt?: number }>>([]);
  let historyReturnFocus: HTMLElement | null = null;
  let reportOpen = $state(false);
  let reportReason = $state('spam');
  let reportDetail = $state('');
  let reportBusy = $state(false);
  let reportError = $state('');
  let reportReturnFocus: HTMLElement | null = null;

  function openReport(event?: Event): void {
    if (!onReport || isOwn || !isDelivered) return;
    reportReturnFocus = (event?.currentTarget instanceof HTMLElement ? event.currentTarget : null)
      ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    reportReason = 'spam'; reportDetail = ''; reportError = ''; reportOpen = true;
  }

  function closeReport(): void {
    if (reportBusy) return;
    reportOpen = false;
    const target = reportReturnFocus; reportReturnFocus = null;
    queueMicrotask(() => target?.isConnected && target.focus({ preventScroll: true }));
  }

  async function submitReport(): Promise<void> {
    const reported = message;
    if (!onReport || reportBusy || !reported) return;
    reportBusy = true; reportError = '';
    try {
      const ok = await onReport(reported, reportReason, reportDetail.trim());
      if (ok) {
        reportOpen = false;
        reportDetail = '';
        const target = reportReturnFocus;
        reportReturnFocus = null;
        queueMicrotask(() => target?.isConnected && target.focus({ preventScroll: true }));
        return;
      }
      reportError = t("ui_rapor_gonderilemedi_lutfen_tekrar_deneyin", "Rapor gönderilemedi. Lütfen tekrar deneyin.");
    } catch {
      reportError = t("ui_rapor_gonderilemedi_lutfen_tekrar_deneyin", "Rapor gönderilemedi. Lütfen tekrar deneyin.");
    } finally {
      reportBusy = false;
    }
  }
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let pressStart: { x: number; y: number } | null = null;
  let pressFired = false;

  /** Kaydırma niyetini uzun basmadan ayıran eşik. */
  const LONG_PRESS_MS = 450;
  const MOVE_CANCEL_PX = 10;

  async function openEditHistory(trigger?: HTMLElement | null): Promise<void> {
    if (!message?._id || !message.editedAt || historyLoading) return;
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    if (!apiFetch) return;
    historyReturnFocus = trigger ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    historyOpen = true;
    historyLoading = true;
    historyError = '';
    historyEntries = [];
    try {
      const response = await apiFetch(`/api/messages/${encodeURIComponent(message._id)}/history`);
      if (!response.ok) {
        historyError = response.status === 403
          ? t("ui_bu_mesajin_duzenleme_gecmisini_gorme_yetkiniz_yok", "Bu mesajın düzenleme geçmişini görme yetkiniz yok.")
          : t("ui_duzenleme_gecmisi_yuklenemedi", "Düzenleme geçmişi yüklenemedi.");
        return;
      }
      const body = await response.json() as { editHistory?: unknown; current?: unknown };
      const rows: Array<{ content: string; editedAt?: number }> = [];
      if (Array.isArray(body.editHistory)) {
        for (const item of body.editHistory) {
          if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
          const row = item as Record<string, unknown>;
          if (typeof row.content !== 'string') continue;
          rows.push({ content: row.content, editedAt: Number(row.editedAt) || undefined });
        }
      }
      if (body.current && typeof body.current === 'object' && !Array.isArray(body.current)) {
        const row = body.current as Record<string, unknown>;
        if (typeof row.content === 'string') rows.push({ content: row.content, editedAt: Number(row.editedAt) || undefined });
      }
      historyEntries = rows;
    } catch {
      historyError = t("ui_duzenleme_gecmisi_yuklenemedi", "Düzenleme geçmişi yüklenemedi.");
    } finally {
      historyLoading = false;
    }
  }

  function closeEditHistory(): void {
    historyOpen = false;
    historyError = '';
    const target = historyReturnFocus;
    historyReturnFocus = null;
    setTimeout(() => target?.isConnected && target.focus(), 0);
  }

  function cancelPress(): void {
    if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    pressStart = null;
  }

  function onPointerDown(e: PointerEvent): void {
    // Yalnızca DOKUNMA/kalem: fare uzun basması masaüstü davranışını bozmasın.
    if (e.pointerType === 'mouse') return;
    pressFired = false;
    pressStart = { x: e.clientX, y: e.clientY };
    pressTimer = setTimeout(() => {
      pressTimer = null;
      pressFired = true;
      sheetAnchor = null;
      sheetOpen = true;
    }, LONG_PRESS_MS);
  }

  function onPointerMove(e: PointerEvent): void {
    if (!pressStart) return;
    // Dikey kaydırma sırasında YANLIŞLIKLA açılmasın.
    if (Math.abs(e.clientX - pressStart.x) > MOVE_CANCEL_PX
      || Math.abs(e.clientY - pressStart.y) > MOVE_CANCEL_PX) cancelPress();
  }

  function onPointerUp(): void { cancelPress(); }

  /**
   * Final21 UX — masaüstü sağ tık / Menü tuşu. Eskiden sağ tık tarayıcının kendi
   * menüsünü açıyordu; mesaj eylemleri yalnız üzerine gelince beliren simge
   * çubuğundaydı. Discord'dan gelen kullanıcının kas hafızası sağ tıktır. Aynı
   * yetki koşullu eylem listesi (`sheetActions`) imlecin yanında açılır — yeni bir
   * eylem modeli YOK. Tarayıcı menüsü şu durumlarda KORUNUR, çünkü orada
   * kullanıcının istediği şey odur: mesaj içinde seçili metin varsa (kopyalama)
   * ya da bağlantı/görsel üzerinde sağ tıklandıysa (adresi kopyala, görseli aç).
   */
  function onContextMenu(e: MouseEvent): void {
    if (!message || sheetActions.length === 0) return;
    const target = e.target instanceof Element ? e.target : null;
    if (target?.closest('a[href], img, video, audio, input, textarea, .mas-sheet')) return;
    const selection = globalThis.getSelection?.();
    const article = e.currentTarget instanceof HTMLElement ? e.currentTarget : null;
    if (selection && !selection.isCollapsed && article && selection.anchorNode && article.contains(selection.anchorNode)) return;
    e.preventDefault();
    // Klavyeden (Menü tuşu / Shift+F10) gelen olayda koordinat 0'dır: menü mesajın
    // sağ üstünde açılır.
    if (article && e.clientX === 0 && e.clientY === 0) {
      const r = article.getBoundingClientRect();
      sheetAnchor = { x: r.right - 24, y: r.top + 8 };
    } else {
      sheetAnchor = { x: e.clientX, y: e.clientY };
    }
    sheetOpen = true;
  }

  async function copyMessageText(): Promise<void> {
    const text = typeof message?.content === 'string' ? message.content : '';
    if (!text) return;
    const ok = await copyToClipboard(text);
    BridgeRegistry.call('toast', ok ? t('surface_kopyaland_02526a', 'Kopyalandı ✓') : t('msg_text_copy_failed', 'Metin kopyalanamadı'), ok ? 'success' : 'warning');
  }

  /** Uzun basma tetiklendiyse ARDINDAN gelen tıklama yutulur. */
  function onClickCapture(e: MouseEvent): void {
    if (!pressFired) return;
    // The sheet is rendered inside the article. If a browser does not emit the
    // synthetic click on release, the flag can still be set when the user taps
    // a sheet action; that real action must never be swallowed.
    if (e.target instanceof Element && e.target.closest('.mas-sheet')) {
      pressFired = false;
      return;
    }
    pressFired = false;
    e.preventDefault();
    e.stopPropagation();
  }

  /**
   * Sayfadaki eylemler — masaüstü çubuğundaki KOŞULLARIN AYNISI.
   * Yetkisiz eylem burada ÜRETİLMEZ.
   */
  const sheetActions = $derived.by<SheetAction[]>(() => {
    // No message, no actions: every entry below hands the message to a callback
    // that requires one, so the sheet must not be built for an empty slot.
    const current = message;
    if (!current) return [];
    const list: SheetAction[] = [];
    // Teslim edilmemiş (bekleyen/başarısız) mesajın sunucu kimliği yoktur: ona tepki
    // vermek ya da yanıt yazmak var olmayan bir mesaja komut göndermek olurdu.
    if (isDelivered) {
      list.push({ id: 'react', label: t('msg_action_react', 'Tepki ekle'), run: () => { pickerOpen = true; } });
      list.push({ id: 'reply', label: t('msg_action_reply', 'Yanıtla'),    run: () => onReply?.(current) });
    }
    if (typeof current.content === 'string' && current.content.trim()) {
      list.push({ id: 'copy', label: t('msg_action_copy_text', 'Metni kopyala'), run: () => void copyMessageText() });
    }
    if (current.failed && isOwn && onDiscard) {
      list.push({ id: 'discard', label: t('msg_action_delete', 'Sil'), danger: true, run: () => onDiscard(String(current.ackId ?? '')) });
    }
    if (canPermalink) {
      list.push({ id: 'link', label: t('msg_action_link', 'Bağlantıyı kopyala'), run: () => void copyPermalink() });
    }
    if (isDelivered) {
      if (onThread) list.push({ id: 'thread', label: t("thread_open", "Thread aç"), run: () => onThread(current) });
      list.push({ id: 'save', label: t('msg_action_save', 'Sonra oku'), run: () => onSave?.(current) });
      if (!isOwn && onReport) list.push({ id: 'report', label: t("report_message", "Mesajı raporla"), danger: true, run: () => openReport() });
    }
    if (canCrosspost && isDelivered && onCrosspost) {
      list.push({ id: 'crosspost', label: crosspostBusy ? t("ui_yayinlaniyor", "Yayınlanıyor…") : t("ui_duyuruyu_yayinla", "Duyuruyu yayınla"), run: () => { if (!crosspostBusy) onCrosspost(current); } });
    }
    if (canShowPin) {
      list.push({
        id: 'pin',
        label: isPinned ? t('unpin', 'Sabitlemeyi Kaldır') : t('pin', 'Sabitle'),
        run: () => onPin?.(current),
      });
    }
    if (isOwn && isDelivered) {
      list.push({ id: 'edit',   label: t('msg_action_edit', 'Düzenle'), run: () => onEdit?.(current) });
      list.push({ id: 'delete', label: t('msg_action_delete', 'Sil'), danger: true, run: () => onDelete?.(current) });
    }
    return list;
  });

  const isOwn    = $derived(Boolean(message?.userId && currentUserId && message.userId === currentUserId));
  // Pending/queued/failed rows have no stable server id. Offering edit/delete
  // would emit commands for `pending:<ackId>` that the server cannot honor.
  const isDelivered = $derived(Boolean(!message?.pending && !message?.queued && !message?.failed));
  const author   = $derived(message?.displayName || message?.username || t('unknown_user'));
  // A bot or webhook picks its own name, so the name alone could impersonate a member.
  // The marker comes only from server-set fields, never from the content (Final21 Phase 14).
  const isAppAuthor = $derived(Boolean(message?.botId) || message?.isWebhook === true);

  const initials = $derived(
    author.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'B'
  );

  const timeText = $derived.by(() => {
    if (!message?.createdAt) return '';
    const date = new Date(Number(message.createdAt));
    if (Number.isNaN(date.getTime())) return '';
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  });
  const timeIso = $derived.by(() => {
    if (!message?.createdAt) return undefined;
    const date = new Date(Number(message.createdAt));
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  });
  const timeTitle = $derived.by(() => {
    if (!message?.createdAt) return '';
    const date = new Date(Number(message.createdAt));
    return Number.isNaN(date.getTime())
      ? ''
      : date.toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
  });

  const reactionList = $derived.by(() => {
    const raw = message?.reactions;
    if (!raw || typeof raw !== 'object') return [] as Array<{ emoji: string; count: number }>;
    return Object.entries(raw)
      .map(([emoji, users]) => ({ emoji, count: Array.isArray(users) ? users.length : Number(users) || 0 }))
      .filter(r => r.count > 0);
  });

  /** javascript:/data: gibi şemaları eler; yalnızca göreli veya http(s) kabul edilir. */
  // Final21 Faz 19 (19-28): sunucu-göreli ek/avatar paketlenmiş mobil uygulamada API kökenine bağlanır.
  function safeUrl(url?: string): string | null {
    return safeServerUrl(url);
  }


  const linkEmbeds = $derived.by(() => {
    let raw: unknown = message?.embeds;
    if (typeof raw === 'string') {
      try { raw = JSON.parse(raw); } catch { return [] as LinkEmbed[]; }
    }
    if (!Array.isArray(raw)) return [] as LinkEmbed[];
    const result: LinkEmbed[] = [];
    for (const candidate of raw.slice(0, 3)) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const row = candidate as Record<string, unknown>;
      const url = safeUrl(typeof row.url === 'string' ? row.url : undefined);
      if (!url) continue;
      const title = typeof row.title === 'string' ? row.title.trim().slice(0, 240) : '';
      const description = typeof row.description === 'string' ? row.description.trim().slice(0, 500) : '';
      const siteName = typeof row.siteName === 'string' ? row.siteName.trim().slice(0, 100) : '';
      if (!title && !description && !siteName) continue;
      result.push({ url, title: title || siteName || new URL(url).hostname, description: description || null, siteName: siteName || new URL(url).hostname });
    }
    return result;
  });

  // ── TEPKILER ───────────────────────────────────────────────────────────────
  // BULUNAN KUSUR: tepki CIPLERI zaten render ediliyordu ama kullanicinin
  // tepki EKLEMESININ hicbir yolu yoktu: `messages-reactions-svelte.ts`,
  // `MessageReactions.svelte` ve `ReactionPicker.svelte` uretim girisinden
  // (`app.ts`) ERISILEMEZ (DORMANT) ve hicbir sey kaydetmiyorlar.
  // Sunucuda `message:react` TAM olarak var (toggle + `message:reaction` yayini).
  //
  // Cozum: kalici ikon yigini yaratmadan TEK bir "tepki" girisi ve KISA bir
  // hizli set. Buyuk bir emoji kutuphanesi ACILMAZ — urun yuzeyi sakin kalir.
  const QUICK_EMOJIS = ['👍', '❤️', '😄', '🎉', '👀', '🙏'];
  let pickerOpen = $state(false);

  // ── FAZ K+/4 — KALICI BAĞLANTI ─────────────────────────────────────────
  // Arama bir mesaja atlayabiliyordu ama kimse bir mesaja BAĞLANTI
  // VEREMİYORDU: "şuna bak" demenin tek yolu ekran görüntüsüydü.
  // Bağlantı bir ANAHTAR DEĞİLDİR — yalnızca hedefi taşır; erişimi olmayan
  // biri açtığında kanonik gezinme sahibi başarısız döner.
  let linkCopied = $state(false);
  let linkTimer: ReturnType<typeof setTimeout> | null = null;

  /** Kanal/sunucu bilinmeyen satır (bekleyen gönderim, DM) bağlantılanamaz. */
  const canPermalink = $derived(Boolean(
    message?._id && message?.channelId && message?.serverId
    && !message?.pending && !message?.queued && !message?.failed,
  ));

  async function copyPermalink(): Promise<void> {
    if (!message?.channelId || !message?.serverId) return;
    const url = buildPermalink(
      { serverId: message.serverId, channelId: message.channelId, messageId: message._id },
      window.location.href,
    );
    const ok = await copyToClipboard(url);
    // Pano yoksa (güvensiz bağlam) SESSİZ KALINMAZ: kullanıcı bağlantıyı
    // elle kopyalayabilsin diye gösterilir.
    if (!ok) {
      BridgeRegistry.call('toast', t('copy_link_failed_url', 'Bağlantı kopyalanamadı: {url}', { url }), 'warning');
      return;
    }
    linkCopied = true;
    if (linkTimer) clearTimeout(linkTimer);
    linkTimer = setTimeout(() => { linkCopied = false; }, 1800);
  }

  function react(emoji: string): void {
    if (!message) return;
    onReact?.(message, emoji);
    pickerOpen = false;
  }
  const fileHref = $derived(safeUrl(message?.fileUrl));
  const stickerHref = $derived((() => {
    if (message?.type !== 'sticker') return null;
    const url = String(message?.sticker?.url ?? '');
    return /^\/uploads\/stickers\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(url) && !url.includes('..') ? url : null;
  })());
  let trackedStickerHref = $state<string | null>(null);
  let stickerImageFailed = $state(false);
  let trackedFileHref = $state<string | null>(null);
  let renderedFileHref = $state<string | null>(null);
  let mediaGeneration = $state(getMediaCredentialGeneration());
  let mediaRetryCount = $state(0);
  let mediaRenewing = $state(false);
  let mediaFailed = $state(false);
  let imageViewerOpen = $state(false);
  let imageViewerTrigger: HTMLButtonElement | null = null;

  function openImageViewer(trigger: HTMLButtonElement): void {
    imageViewerTrigger = trigger;
    imageViewerOpen = true;
  }

  function closeImageViewer(): void {
    if (!imageViewerOpen) return;
    imageViewerOpen = false;
    queueMicrotask(() => imageViewerTrigger?.focus());
  }

  $effect(() => {
    if (stickerHref === trackedStickerHref) return;
    trackedStickerHref = stickerHref;
    stickerImageFailed = false;
  });

  $effect(() => {
    if (fileHref === trackedFileHref) return;
    trackedFileHref = fileHref;
    renderedFileHref = fileHref;
    mediaGeneration = getMediaCredentialGeneration();
    mediaRetryCount = 0;
    mediaRenewing = false;
    mediaFailed = false;
    imageViewerOpen = false;
  });

  async function recoverProtectedMedia(): Promise<void> {
    const failedUrl = fileHref;
    if (!failedUrl || !isProtectedMediaUrl(failedUrl) || mediaRetryCount >= 1) {
      mediaFailed = true;
      mediaRenewing = false;
      return;
    }

    // Claim this element's only retry before awaiting, so duplicate error events
    // from the same media node cannot create a second recovery path.
    mediaRetryCount = 1;
    mediaRenewing = true;
    const renewed = await renewMediaCredential(mediaGeneration);
    if (fileHref !== failedUrl) return;

    mediaRenewing = false;
    if (!renewed) {
      mediaFailed = true;
      return;
    }

    mediaGeneration = getMediaCredentialGeneration();
    renderedFileHref = withMediaRetry(failedUrl, mediaGeneration);
  }

  function retryProtectedMedia(): void {
    if (!fileHref || !isProtectedMediaUrl(fileHref) || mediaRenewing) return;
    mediaRetryCount = 0;
    mediaFailed = false;
    void recoverProtectedMedia();
  }

  async function openProtectedFile(event: MouseEvent): Promise<void> {
    const url = fileHref;
    if (!url || !isProtectedMediaUrl(url) || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();

    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;

    const probe = async (target: string): Promise<Response | null> => {
      try { return await fetch(target, { method: 'HEAD', credentials: 'include' }); }
      catch { return null; }
    };

    let target = url;
    let response = await probe(target);
    if (response?.status === 401 && mediaRetryCount < 1) {
      mediaRetryCount = 1;
      const renewed = await renewMediaCredential(mediaGeneration);
      if (renewed) {
        mediaGeneration = getMediaCredentialGeneration();
        target = withMediaRetry(url, mediaGeneration);
        response = await probe(target);
      }
    }

    if (response?.ok) {
      if (popup) popup.location.replace(target);
      else window.location.assign(target);
      return;
    }

    popup?.close();
    mediaFailed = true;
  }
  const avatarHref = $derived(safeUrl(message?.avatarUrl ?? undefined));
  // ── Final21 Faz 8 — F21-8-02: YÜKLENEMEYEN AVATAR ZARİFÇE DÜŞER ──────────
  // Mesaj avatarı yazarın o anki avatarının ANLIK GÖRÜNTÜSÜDÜR. Dosya meşru
  // biçimde yok olabilir (kullanıcı avatarını AÇIKÇA kaldırdı, depolama
  // kesintisi). Eskiden yedek yoktu ve kırık bir resim çiziliyordu; artık renk +
  // baş harf avatarına düşülür. Hata, avatar adresi değişince sıfırlanır.
  let avatarFailed = $state(false);
  let avatarFailedFor: string | null | undefined;
  const showAvatarImage = $derived(Boolean(avatarHref) && !(avatarFailed && avatarFailedFor === avatarHref));
  function onAvatarError(): void {
    avatarFailedFor = avatarHref;
    avatarFailed = true;
  }
  const avatarColor = $derived(
    /^#[0-9a-f]{3,8}$/i.test(String(message?.avatarColor ?? ''))
      ? String(message?.avatarColor)
      : 'var(--brand)',
  );
  const fileKind = $derived.by(() => {
    const type = String(message?.fileType ?? '').toLowerCase();
    if (type.startsWith('image/')) return 'image';
    if (type.startsWith('video/')) return 'video';
    if (type.startsWith('audio/')) return 'audio';
    return 'file';
  });

  onDestroy(() => {
    cancelPress();
    if (linkTimer) { clearTimeout(linkTimer); linkTimer = null; }
  });
</script>

{#snippet formatted(nodes: FormatNode[])}
  {#each nodes as node, index (index)}
    {#if node.kind === 'text'}{node.text}{:else if node.kind === 'strong'}<strong>{@render formatted(node.children)}</strong>{:else if node.kind === 'em'}<em>{@render formatted(node.children)}</em>{:else if node.kind === 'underline'}<u>{@render formatted(node.children)}</u>{:else if node.kind === 'strike'}<s>{@render formatted(node.children)}</s>{:else if node.kind === 'code'}<code class="md-code">{node.text}</code>{:else if node.kind === 'codeblock'}<pre class="md-pre" data-language={node.language || undefined}><code>{node.text}</code></pre>{:else if node.kind === 'quote'}<blockquote class="md-quote">{@render formatted(node.children)}</blockquote>{:else if node.kind === 'link'}<a class="md-link" href={node.href} target="_blank" rel="noopener noreferrer">{node.text}</a>{/if}
  {/each}
{/snippet}

{#if message}
  {#if isSystem}
    <article class="msg msg-system" data-id={message._id} aria-label={t('msg_system', 'Sistem mesajı')}>
      <span class="sys-text">{messageText(message)}</span>
    </article>
  {:else}
    <!--
      DOLASAN TABINDEX (roving tabindex) — KASITLI

      Derleyici `a11y_no_noninteractive_tabindex` uyarisi verir: `<article>`
      etkilesimli bir oge degildir ama `tabindex` tasir. Bu, ARIA'nin
      bilesik-widget kalibidir ve linter bunu ayirt edemez:

        · Gunluk TEK bir Tab duragidir. Icerideki mesaj sayisi kadar durak
          OLUSTURULMAZ (aksi halde mesaj basina 6 durak olurdu — olculdu).
        · Yalnizca `rovingId` mesaji `tabindex="0"`, digerleri `-1` tasir;
          ok tuslariyla gezinilir.
        · `<article>` + `aria-label` sohbet mesaji icin dogru anlamdir ve
          etkilesimli bir role DONUSTURULMEZ (buton/link degildir).

      Kanit: `e2e/tests/keyboard-journeys.spec.ts` bu davranisi gercek
      tarayicida surer (tek durak, ok gezintisi, odak korunmasi).
    -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <article
      class="msg"
      class:msg-pending={message.pending}
      class:msg-failed={message.failed}
      class:msg-compact={compact}
      data-id={message._id}
      data-delivery-state={message.failed ? 'failed' : message.queued ? 'queued' : message.pending ? 'pending' : 'sent'}
      aria-label={t('message_from_author_aria', undefined, { author })}
      tabindex={tabIndex}
      onfocus={() => onFocusMessage?.(String(message._id))}
      onpointerdown={onPointerDown}
      onpointermove={onPointerMove}
      onpointerup={onPointerUp}
      onpointercancel={onPointerUp}
      onclickcapture={onClickCapture}
      oncontextmenu={onContextMenu}
    >
      {#if compact}
        <!-- Gruplanmış takip mesajı: avatar sütunu saatin hover'da görüneceği
             dar bir oluğa dönüşür; hizalama bozulmaz. -->
        <time class="msg-gutter" datetime={timeIso} title={timeTitle} aria-label={timeTitle}>{timeText}</time>
      {:else}
        <div class="msg-avatar" style={!showAvatarImage ? `background:${avatarColor}` : ''}>
          {#if showAvatarImage}
            <img src={avatarHref} alt="" onerror={onAvatarError} />
          {:else}
            {initials}
          {/if}
        </div>
      {/if}

      <div class="msg-body">
        {#if message.replyTo}
          {#if replyDeleted}
            <div class="msg-reply-ref msg-reply-deleted" data-reply-state="deleted">
              <span class="reply-content"><em>{t('markup_orijinal_mesaj_silindi_80fb8f5', "orijinal mesaj silindi")}</em></span>
            </div>
          {:else if replyJumpable}
            <button
              type="button"
              class="msg-reply-ref msg-reply-jump"
              data-reply-state="jumpable"
              data-reply-id={message.replyTo._id}
              title={t('attr_orijinal_mesaja_git_6ad9095', "Orijinal mesaja git")}
              onclick={() => onJumpToReply?.(message.replyTo!._id!)}
            >
              <span class="reply-author">{replyAuthor}</span>
              <span class="reply-content">{replyText}</span>
            </button>
          {:else}
            <div class="msg-reply-ref" data-reply-state="snapshot" title={t('msg_reply_not_loaded', 'Orijinal mesaj bu sayfada yüklü değil')}>
              <span class="reply-author">{replyAuthor}</span>
              <span class="reply-content">{replyText}</span>
            </div>
          {/if}
        {/if}

        {#if !compact}
          <header class="msg-head">
            <span class="msg-author">{author}</span>
            {#if isAppAuthor}<span class="msg-app-badge">{t('message_bot_badge', 'BOT')}</span>{/if}
            <time class="msg-time" datetime={timeIso} title={timeTitle}>{timeText}</time>
            {#if message.editedAt}<button type="button" class="msg-edited msg-edited-btn" onclick={(e) => void openEditHistory(e.currentTarget)}>{t('msg_edited', '(düzenlendi)')}</button>{/if}
          </header>
        {:else if message.editedAt}
          <button type="button" class="msg-edited msg-edited-inline msg-edited-btn" onclick={(e) => void openEditHistory(e.currentTarget)}>{t('msg_edited', '(düzenlendi)')}</button>
        {/if}

        {#if contentNodes.length}
          <div class="msg-content">{@render formatted(contentNodes)}</div>
        {/if}

        {#if linkEmbeds.length}
          <div class="msg-link-previews" aria-label={t("link_previews")}>
            {#each linkEmbeds as embed (embed.url)}
              <a class="msg-link-preview" href={embed.url} target="_blank" rel="noopener noreferrer">
                <small>{embed.siteName}</small>
                <strong>{embed.title}</strong>
                {#if embed.description}<span>{embed.description}</span>{/if}
                <em>{new URL(embed.url).hostname}</em>
              </a>
            {/each}
          </div>
        {/if}

        {#if message.failed}
          <div class="msg-delivery msg-delivery-failed" role="alert" data-delivery="failed">
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M10 3.25 17 16H3L10 3.25Z"/><path d="M10 7.5v3.75M10 14h.01"/></svg>
            <span>{message.lastError || t("adm_send_failed")}</span>
            <button type="button" onclick={() => onRetry?.(String(message.ackId ?? ''))}>{t('retry')}</button>
            {#if onDiscard && isOwn}
              <button type="button" class="msg-delivery-discard" onclick={() => onDiscard?.(String(message.ackId ?? ''))}>{t('msg_action_delete', 'Sil')}</button>
            {/if}
          </div>
        {:else if message.queued}
          <span class="msg-delivery msg-delivery-pending" data-delivery="queued" aria-live="polite">
            <!-- Sırada bekleme nedeni bağlantı dışında bir şeyse (hız sınırı, yavaş mod) o gösterilir (U-11). -->
            <span class="delivery-dot" aria-hidden="true"></span>{message.lastError || t('markup_baglanti_bekleniyor_17cbab2', "Bağlantı bekleniyor…")}
          </span>
        {:else if message.pending}
          <span class="msg-delivery msg-delivery-pending" data-delivery="pending" aria-live="polite">
            <span class="delivery-dot" aria-hidden="true"></span>{t('dm_sending')}
          </span>
        {/if}

        {#if stickerHref}
          <div class="msg-sticker-wrap" data-message-kind="sticker">
            {#if stickerImageFailed}
              <div class="msg-sticker-fallback" role="img" aria-label={t('sticker_named_unavailable_aria', undefined, { name: message.sticker?.name || t('sticker') })}>
                <span class="msg-sticker-fallback-mark" aria-hidden="true">◇</span>
                <span>{t("sticker_image_unavailable")}</span>
              </div>
            {:else}
              <img
                class="msg-sticker"
                src={stickerHref}
                alt={message.sticker?.name || t('sticker')}
                width={Math.min(320, Math.max(32, Number(message.sticker?.width) || 160))}
                height={Math.min(320, Math.max(32, Number(message.sticker?.height) || 160))}
                loading="lazy" decoding="async"
                onerror={() => { stickerImageFailed = true; }}
              />
            {/if}
            {#if message.sticker?.name}<span class="msg-sticker-name">{message.sticker.name}</span>{/if}
          </div>
        {/if}

        {#if fileHref}
          <div class="msg-attachment" data-attachment-kind={fileKind}>
            {#if mediaRenewing}
              <div class="msg-attachment-state" role="status">{t('msg_attach_reconnect', 'Ek yeniden bağlanıyor…')}</div>
            {:else if mediaFailed}
              <div class="msg-attachment-state msg-attachment-error" role="alert">
                <span>{t('msg_attach_failed', 'Ek yüklenemedi.')}</span>
                {#if isProtectedMediaUrl(fileHref)}<button type="button" onclick={retryProtectedMedia}>{t('retry')}</button>{/if}
              </div>
            {:else if fileKind === 'image'}
              <button
                type="button"
                class="msg-image-button"
                aria-label={t('image_expand_named_aria', undefined, { name: message.fileName ?? t("srv_tab_media") })}
                onclick={(e) => openImageViewer(e.currentTarget)}
              >
                <img class="msg-media msg-image" src={renderedFileHref ?? fileHref} alt={message.fileName ?? t("surface_mesaj_gorseli_8deb00")} loading="lazy" decoding="async" onerror={recoverProtectedMedia} />
              </button>
            {:else if fileKind === 'video'}
              <!-- svelte-ignore a11y_media_has_caption -- User uploads do not carry a separate caption-track contract. -->
              <video class="msg-media msg-video" src={renderedFileHref ?? fileHref} controls preload="metadata" aria-label={message.fileName ?? t("surface_mesaj_videosu_b4ac7a")} onerror={recoverProtectedMedia}></video>
            {:else if fileKind === 'audio'}
              <audio class="msg-audio" src={renderedFileHref ?? fileHref} controls preload="metadata" aria-label={message.fileName ?? t("surface_mesaj_ses_dosyas_f2b58f")} onerror={recoverProtectedMedia}></audio>
            {:else}
              <a class="msg-file" href={fileHref} target="_blank" rel="noopener noreferrer" onclick={openProtectedFile}>
                <span class="file-icon" aria-hidden="true"><svg viewBox="0 0 20 20"><path d="M6 2.75h5l3 3V17H6z"/><path d="M11 2.75V6h3M8 10h4M8 13h4"/></svg></span>
                <span class="file-copy"><strong>{message.fileName ?? t('search_has_file')}</strong><small>{message.fileType ?? t("surface_dosyay_ac_7ebd5f")}</small></span>
                <svg class="file-open" aria-hidden="true" viewBox="0 0 20 20"><path d="M8 5h7v7M15 5l-8 8M13 15H5V7"/></svg>
              </a>
            {/if}
            {#if fileKind !== 'file' && message.fileName}<span class="file-caption">{message.fileName}</span>{/if}
          </div>
        {/if}

        {#if reactionList.length}
          <div class="msg-reactions" aria-label={t('msg_reactions', 'Mesaj reaksiyonları')}>
            {#each reactionList as reaction (reaction.emoji)}
              <button type="button" class="msg-reaction" title={t('reaction_count_title', undefined, { count: reaction.count })}
                      aria-label={t('reaction_toggle_aria', undefined, { emoji: reaction.emoji })}
                      onclick={() => react(reaction.emoji)}>
                <span aria-hidden="true">{reaction.emoji}</span><span>{reaction.count}</span>
              </button>
            {/each}
          </div>
        {/if}

        <!-- ══════════════════════════════════════════════════════════════
             HIZLI TEPKI SIRASI — `.msg-body` ICINDE OLMAK ZORUNDA
             ══════════════════════════════════════════════════════════════
             Bu blok onceden `</article>`den hemen once, yani dogrudan `.msg`in
             cocuguydu. `.msg` `display:flex` oldugu icin sira BIR FLEX OGESI
             haline geliyor ve mesajin ALTINA degil YANINA diziliyordu. Tam o
             noktada `position:absolute; right:18px; top:-12px; z-index:2` olan
             `.msg-actions` duruyor.

             OLCULDU (1280x720, tek satirlik mesaj, Chromium):
               .msg-emoji-row  x=798..1012  y=15..48
               .msg-actions    x=736..1012  y=-3..35   (z-index 2)
               elementFromPoint(ilk emoji butonunun merkezi)
                 -> "Mesaj baglantisini kopyala" BUTONU

             Yani kullanici hizli tepki vermeye calistiginda tiklama eylem
             cubuguna gidiyordu: tepki eklenmiyor, baglanti kopyalaniyordu.
             Uc motorda da boyleydi; tarayiciya ozgu degil, duzen kusuruydu.

             Tasarim niyeti CSS'in kendisinde yaziliydi: `margin-left: 52px`
             (avatar oluguna hizalanmis KENDI SATIRI). Blok `.msg-body` icine
             alinarak o niyet gerceklestirildi; govde zaten metin sutununda
             basladigi icin 52px'lik telafi payi da kaldirildi.
        -->
        {#if pickerOpen}
          <div class="msg-emoji-row" role="group" aria-label={t('msg_quick_react', 'Hızlı tepki')}>
            {#each QUICK_EMOJIS as e (e)}
              <button type="button" onclick={() => react(e)} aria-label={t('reaction_toggle_aria', undefined, { emoji: e })}>{e}</button>
            {/each}
          </div>
        {/if}
      </div>

      <div class="msg-actions">
        {#if isDelivered}
          <button type="button" title={t('msg_action_react')} aria-label={t('msg_action_react')}
                  aria-expanded={pickerOpen} onclick={() => (pickerOpen = !pickerOpen)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M7.5 8.5h.01M12.5 8.5h.01M7 12c.8.9 1.8 1.3 3 1.3s2.2-.4 3-1.3"/></svg>
          </button>
          <button type="button" title={t('msg_reply', 'Yanıtla')} aria-label={t('msg_reply', 'Yanıtla')} onclick={() => onReply?.(message)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8 6 4 10l4 4M4 10h6.5c3 0 5 1.8 5.5 4.5"/></svg>
          </button>
        {/if}
        {#if canPermalink}
          <button
            type="button"
            class="msg-link-btn"
            class:copied={linkCopied}
            title={linkCopied ? t("surface_baglant_kopyaland_cad0a7") : t("surface_mesaj_baglant_s_n_kopyala_6bf661")}
            aria-label={linkCopied ? t("surface_baglant_kopyaland_cad0a7") : t("surface_mesaj_baglant_s_n_kopyala_6bf661")}
            onclick={() => void copyPermalink()}
          >
            {#if linkCopied}
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m4 10 4 4 8-8"/></svg>
            {:else}
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 1 0-4.2-4.2l-1 1"/><path d="M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 1 0 4.2 4.2l1-1"/></svg>
            {/if}
          </button>
        {/if}
        {#if isDelivered && onThread}
          <button type="button" title={t("thread_open")} aria-label={t("thread_open")} onclick={() => onThread?.(message)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M6 3.5h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H9l-4 3v-3H6a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2z"/><path d="M7 7h6M7 9.5h4"/></svg>
          </button>
        {/if}
        {#if isDelivered}
          <button type="button" title={t('msg_action_save')} aria-label={t('msg_action_save')} onclick={() => onSave?.(message)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M5.5 3.5h9v13L10 13.4l-4.5 3.1z"/></svg>
          </button>
          {#if !isOwn && onReport}
            <button type="button" class="danger" title={t("report_message")} aria-label={t("report_message")} onclick={openReport}>
              <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M5 17V3m0 1h8.5l-1.5 3 1.5 3H5"/></svg>
            </button>
          {/if}
        {/if}
        {#if canCrosspost && isDelivered && onCrosspost}
          <button type="button" disabled={crosspostBusy} title={t("announcement_publish_followers")} aria-label={t("announcement_publish_followers")} onclick={() => onCrosspost?.(message)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M3.5 9.5h4l5-4v9l-5-4h-4z"/><path d="M13.5 7c1 .7 1.5 1.5 1.5 2.5s-.5 1.8-1.5 2.5M15.5 5c1.7 1.2 2.5 2.7 2.5 4.5S17.2 12.8 15.5 14"/></svg>
          </button>
        {/if}
        {#if canShowPin}
          <button
            type="button"
            class:pinned-on={isPinned}
            title={isPinned ? t('unpin', 'Sabitlemeyi Kaldır') : t('pin', 'Sabitle')}
            aria-label={isPinned ? t('unpin', 'Sabitlemeyi Kaldır') : t('pin', 'Sabitle')}
            aria-pressed={isPinned}
            onclick={() => onPin?.(message)}
          >
            <svg aria-hidden="true" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="m11.5 3.5 5 5-2.5.8-3.3 3.3-.8 3.4-1.7-1.7-2.5 2.5-.9-.9 2.5-2.5-1.7-1.7 3.4-.8 3.3-3.3z"/></svg>
          </button>
        {/if}
        {#if isOwn && isDelivered}
          <button type="button" title={t('msg_edit', 'Düzenle')} aria-label={t('msg_edit', 'Düzenle')} onclick={() => onEdit?.(message)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="m4 14.5-.5 2 2-.5L15 6.5 13.5 5zM12.5 6l1.5 1.5M4 11V4h7M9 16h7V9"/></svg>
          </button>
          <button class="danger" type="button" title={t('msg_action_delete')} aria-label={t('msg_action_delete')} onclick={() => onDelete?.(message)}>
            <svg aria-hidden="true" viewBox="0 0 20 20"><path d="M4 6h12M8 3.5h4l1 2.5M6 6l.75 10h6.5L14 6M8.5 9v4M11.5 9v4"/></svg>
          </button>
        {/if}
      </div>

      {#if imageViewerOpen && fileKind === 'image' && fileHref}
        <div class="image-viewer-overlay" role="presentation" onclick={closeImageViewer}>
          <div
            class="image-viewer-dialog"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            aria-label={message.fileName ? t("image_preview_named", undefined, { name: message.fileName }) : t("surface_gorsel_onizlemesi_ab5419")}
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeImageViewer(); } }}
            use:focusTrap={{ active: imageViewerOpen, initialFocus: '.image-viewer-close' }}
          >
            <header>
              <strong>{message.fileName ?? t("srv_tab_media")}</strong>
              <div>
                <a href={renderedFileHref ?? fileHref} target="_blank" rel="noopener noreferrer" onclick={openProtectedFile}>{t("action_open_new_tab")}</a>
                <button type="button" class="image-viewer-close" aria-label={t("image_preview_close")} onclick={closeImageViewer}>✕</button>
              </div>
            </header>
            <div class="image-viewer-stage">
              <img src={renderedFileHref ?? fileHref} alt={message.fileName ?? t("surface_mesaj_gorseli_8deb00")} onerror={recoverProtectedMedia} />
            </div>
          </div>
        </div>
      {/if}

      {#if reportOpen}
        <div class="edit-history-overlay" role="presentation" onclick={closeReport}>
          <div
            class="edit-history-dialog report-dialog"
            role="dialog"
            aria-modal="true"
            tabindex="-1"
            aria-labelledby={`report-message-title-${message._id}`}
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeReport(); } }}
            use:focusTrap={{ active: reportOpen, initialFocus: '.report-reason' }}
          >
            <header>
              <div><strong id={`report-message-title-${message._id}`}>{t("report_message")}</strong><span>{t("report_queue_hint")}</span></div>
              <button type="button" class="edit-history-close" aria-label={t('attr_rapor_penceresini_kapat_276b46a', "Rapor penceresini kapat")} disabled={reportBusy} onclick={closeReport}>✕</button>
            </header>
            <div class="edit-history-body report-form">
              <label><span>{t('markup_neden_f136b25', "Neden")}</span>
                <select class="report-reason" bind:value={reportReason} disabled={reportBusy}>
                  <option value="spam">{t('report_reason_spam')}</option><option value="harassment">{t('report_reason_harassment')}</option><option value="hate">{t("report_reason_hate")}</option>
                  <option value="sexual">{t("report_reason_sexual")}</option><option value="violence">{t("report_reason_violence")}</option><option value="other">{t("report_reason_other")}</option>
                </select>
              </label>
              <label><span>{t('markup_ek_bilgi_8dfb865', "Ek bilgi")} <small>{t("mod_optional")}</small></span><textarea bind:value={reportDetail} maxlength="500" rows="4" disabled={reportBusy}></textarea></label>
              {#if reportError}<p class="edit-history-error" role="alert">{reportError}</p>{/if}
              <div class="report-actions"><button type="button" onclick={closeReport} disabled={reportBusy}>{t("cancel")}</button><button type="button" class="danger-submit" onclick={() => void submitReport()} disabled={reportBusy}>{reportBusy ? t("dm_sending") : 'Raporla'}</button></div>
            </div>
          </div>
        </div>
      {/if}

      {#if historyOpen}
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="edit-history-overlay" role="presentation" onclick={closeEditHistory}>
          <div
            class="edit-history-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby={`edit-history-title-${message._id}`}
            tabindex="-1"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); closeEditHistory(); } }}
            use:focusTrap={{ active: historyOpen, initialFocus: '.edit-history-close' }}
          >
            <header>
              <div>
                <strong id={`edit-history-title-${message._id}`}>{t("message_history")}</strong>
                <span>{t("message_history_text_only")}</span>
              </div>
              <button type="button" class="edit-history-close" aria-label={t("message_history_close")} onclick={closeEditHistory}>✕</button>
            </header>
            <div class="edit-history-body" aria-busy={historyLoading}>
              {#if historyLoading}
                <p role="status">{t("message_history_loading")}</p>
              {:else if historyError}
                <p class="edit-history-error" role="alert">{historyError}</p>
              {:else if historyEntries.length === 0}
                <p>{t("message_history_none")}</p>
              {:else}
                <ol>
                  {#each historyEntries as entry, index}
                    <li>
                      <div class="edit-history-meta">
                        <strong>{index === historyEntries.length - 1 ? t("surface_guncel_surum_85e518") : t("message_edit_version", undefined, { number: index + 1 })}</strong>
                        {#if entry.editedAt}<time>{new Date(entry.editedAt).toLocaleString()}</time>{/if}
                      </div>
                      <p>{messageText(entry)}</p>
                    </li>
                  {/each}
                </ol>
              {/if}
            </div>
          </div>
        </div>
      {/if}

      <!-- Mobil eylem sayfasi: uzun basma ile acilir. Masaustunde hicbir
           sey degismez (yalnizca dokunma/kalem uzun basmasi tetikler). -->
      <MessageActionSheet
        open={sheetOpen}
        actions={sheetActions}
        preview={typeof message.content === 'string' ? message.content.slice(0, 80) : ''}
        anchor={sheetAnchor}
        onClose={() => { sheetOpen = false; sheetAnchor = null; }}
      />

    </article>
  {/if}
{/if}

<style>
  .msg-reaction { cursor: pointer; border: 1px solid var(--bg-5); font: inherit; }
  .msg-attachment-state {
    display: flex; align-items: center; min-height: 48px; padding: 10px 12px;
    color: var(--text-2); background: var(--bg-3); border: 1px solid var(--bg-5);
    border-radius: var(--r-md, 8px); font-size: 13px;
  }
  .msg-attachment-error { color: var(--danger, #e05260); }
  .msg-attachment-error { display: flex; align-items: center; gap: 8px; }
  .msg-attachment-error button { min-height: 30px; padding: 0 9px; border: 1px solid currentColor; border-radius: var(--r-sm); background: transparent; color: inherit; font: inherit; font-size: 11px; cursor: pointer; }
  .msg-reaction:hover { background: var(--bg-5); }
  .msg-emoji-row {
    display: flex; gap: 4px; margin: 4px 0 2px;
    padding: 4px; width: max-content;
    background: var(--bg-3); border: 1px solid var(--bg-5);
    border-radius: var(--r-md, 8px);
  }
  .msg-emoji-row button {
    border: 0; background: none; cursor: pointer;
    font-size: 15px; line-height: 1; padding: 4px 5px; border-radius: 6px;
  }
  .msg-emoji-row button:hover { background: var(--bg-5); }
  .msg {
    display: flex; gap: 10px; min-width: 0;
    /* Tasarım denetimi: gruplar arası nefes payı içeride değil, grup başında
       verilir — böylece takip mesajları sıkı, yeni konuşma bloğu ayrık durur. */
    padding: 2px 18px;
    position: relative;
    transition: background var(--duration-fast, 90ms) ease, opacity var(--duration-fast, 90ms) ease;
  }
  .msg:not(.msg-compact) { margin-top: 10px; padding-top: 2px; }
  .msg:hover { background: var(--msg-hover, rgba(255,255,255,.03)); }
  /* FAZ K+/4 — kopyalandı durumu RENKTEN başka işaret de taşır: ikon
     onay imine döner ve erişilebilir ad değişir. */
  .msg-link-btn.copied { color: var(--green); }

  /* Sabitli durum RENKTEN başka işaret de taşır: buton `aria-pressed=true`
     (ekran okuyucu) ve etiket "Sabitlemeyi kaldır" olur; renk yalnızca ek
     görsel ipucudur. */
  .msg-actions button.pinned-on { color: var(--brand, var(--accent)); }

  .msg:hover .msg-actions,
  .msg:focus-within .msg-actions { opacity: 1; visibility: visible; pointer-events: auto; transform: translateY(0); }

  /* Dolasan tabindex ile mesaj artik odaklanabilir; odak GORUNUR olmali
     (WCAG 2.4.7). `:focus-visible` kullanilir: fareyle tiklayinca halka
     cikmaz, klavyeyle gelince cikar. */
  .msg:focus { outline: none; }
  .msg:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: -2px;
    border-radius: var(--r-md, 6px);
  }

  /* ── Ardışık (gruplanmış) mesaj ────────────────────────────────────────
     Avatar sütunu genişliğinde bir oluk bırakılır; saat yalnızca hover'da
     belirir. Böylece hizalama korunur ama tekrar eden metadata gürültüsü
     ekrandan kalkar. */
  .msg-gutter {
    width: 38px; flex-shrink: 0;
    font-size: var(--text-xs, 11px);
    font-variant-numeric: tabular-nums;
    color: var(--text-muted);
    text-align: right;
    line-height: 1.45;
    opacity: 0; cursor: default;
    transition: opacity var(--duration-fast, 90ms) ease;
    user-select: none;
  }
  .msg:hover .msg-gutter { opacity: 1; }
  .msg-edited-btn { border: 0; padding: 0; background: transparent; cursor: pointer; text-decoration: none; }
  .msg-edited-btn:hover, .msg-edited-btn:focus-visible { color: var(--text-primary); text-decoration: underline; }
  .edit-history-overlay { position: fixed; inset: 0; z-index: var(--layer-modal); display: grid; place-items: center; padding: 20px; background: color-mix(in srgb, var(--bg-0) 78%, transparent); backdrop-filter: blur(6px); }
  .edit-history-dialog { width: min(560px, 100%); max-height: min(680px, calc(var(--bridge-visual-viewport-height, 100dvh) - 40px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-modal); background: var(--bg-2); box-shadow: var(--shadow-xl); }
  .edit-history-dialog > header { display: flex; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
  .edit-history-dialog > header div { display: grid; gap: 3px; }
  .edit-history-dialog > header span { font-size: 11px; color: var(--text-muted); }
  .edit-history-close { width: 32px; height: 32px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); cursor: pointer; }
  .edit-history-body { overflow: auto; padding: 12px 16px 16px; }
  .edit-history-body ol { display: grid; gap: 10px; margin: 0; padding: 0; list-style: none; }
  .edit-history-body li { padding: 10px 12px; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); background: var(--bg-3); }
  .edit-history-body li p { margin: 6px 0 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .edit-history-meta { display: flex; justify-content: space-between; gap: 10px; font-size: 10px; color: var(--text-muted); }
  .edit-history-meta strong { color: var(--text-secondary); }
  .edit-history-error { color: var(--danger-text, #ff8f8f); }
  .report-form { display: grid; gap: 12px; }
  .report-form label { display: grid; gap: 6px; color: var(--text-secondary); font-size: 12px; }
  .report-form select, .report-form textarea { width: 100%; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-3); color: var(--text-1); padding: 9px 10px; font: inherit; }
  .report-form textarea { resize: vertical; min-height: 88px; }
  .report-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .report-actions button { min-height: 34px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); background: var(--bg-3); color: var(--text-1); cursor: pointer; }
  .report-actions .danger-submit { background: var(--danger); border-color: transparent; color: var(--text-on-solid); }
  .report-actions button:disabled { opacity: .55; cursor: default; }
  .msg-edited-inline { font-size: var(--text-xs, 11px); color: var(--text-muted); margin-left: 6px; }
  .msg-avatar {
    width: 38px; height: 38px; border-radius: 50%;
    display: flex; align-items: center; justify-content: center;
    font-size: 13px; font-weight: 700; color: var(--text-on-solid);
    background: var(--bg-4, #40444b); flex-shrink: 0; overflow: hidden; cursor: default;
  }
  .msg-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .msg-body { flex: 1; min-width: 0; }
  .msg-head { display: flex; align-items: baseline; gap: 7px; min-width: 0; line-height: 1.25; }
  .msg-author { min-width: 0; overflow: hidden; color: var(--text-primary); cursor: default; font-size: var(--text-base, 14px); font-weight: 650; text-decoration: none; text-overflow: ellipsis; white-space: nowrap; }
  .msg-author:hover { text-decoration: none; }
  .msg-app-badge { flex: none; align-self: center; padding: 0 5px; border-radius: 4px; background: var(--brand); color: var(--text-on-solid); font-size: 10px; font-weight: 700; line-height: 16px; letter-spacing: .02em; text-transform: uppercase; }
  /* Sayısal hizalama: saatler alt alta kaydığında rakamlar aynı genişlikte olsun. */
  .msg-time { flex: none; font-size: var(--text-xs, 11px); color: var(--text-muted); font-variant-numeric: tabular-nums; }
  .msg-edited { font-size: var(--text-xs, 11px); color: var(--text-muted); }
  .msg-content { max-width: 82ch; color: var(--text-2); font-size: 14px; line-height: 1.48; overflow-wrap: anywhere; white-space: pre-wrap; }
  .msg-content .md-code { padding: 0 4px; border-radius: 4px; background: var(--bg-4); font-family: var(--font-mono); font-size: 0.9em; }
  .msg-content .md-pre { max-width: 100%; margin: 4px 0; padding: 8px 10px; overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--bg-1); white-space: pre; }
  .msg-content .md-pre code { font-family: var(--font-mono); font-size: 13px; }
  .msg-content .md-quote { margin: 2px 0; padding-left: 10px; border-left: 3px solid var(--border-strong); color: var(--text-secondary); }
  .msg-content .md-link { color: var(--brand-ink, var(--brand)); text-decoration: underline; text-underline-offset: 2px; }
  .msg-reply-ref {
    display: flex; gap: 6px; font-size: 12px; color: var(--text-3);
    position: relative; border-left: 0; padding-left: 22px; margin: -1px 0 4px;
    align-items: center;
  }
  .msg-reply-ref::before { content: ''; position: absolute; left: 7px; top: 50%; width: 9px; height: 12px; border-left: 2px solid var(--bg-5); border-top: 2px solid var(--bg-5); border-radius: 5px 0 0; }
  /* Tıklanabilir önizleme — buton varsayılanları sıfırlanır, görsel dil aynı kalır. */
  button.msg-reply-ref {
    background: none; border: 0;
    font: inherit; font-size: 12px; text-align: left; cursor: pointer; width: fit-content;
    max-width: 100%; padding: 0 0 0 22px;
  }
  button.msg-reply-ref:hover .reply-author,
  button.msg-reply-ref:hover .reply-content { color: var(--text-1); }
  .msg-reply-jump:hover::before { border-color: var(--brand); }
  .msg-reply-deleted { font-style: italic; opacity: .8; }
  .reply-author { flex: none; max-width: 160px; overflow: hidden; color: var(--text-2); font-weight: 650; text-overflow: ellipsis; white-space: nowrap; }
  .reply-content { min-width: 0; max-width: min(420px, 52vw); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msg-link-previews { display: grid; gap: 6px; width: min(520px, 100%); margin-top: 7px; }
  .msg-link-preview { display: grid; gap: 3px; padding: 10px 12px; overflow: hidden; border: 1px solid var(--border-subtle); border-left: 3px solid var(--brand); border-radius: var(--radius-md); background: var(--bg-3); color: inherit; text-decoration: none; }
  .msg-link-preview:hover, .msg-link-preview:focus-visible { border-color: var(--brand-border, var(--brand)); background: var(--bg-4); outline: 0; }
  .msg-link-preview small { color: var(--text-muted); font-size: 10px; font-weight: 650; text-transform: uppercase; letter-spacing: .04em; }
  .msg-link-preview strong { overflow: hidden; color: var(--text-1); font-size: 13px; line-height: 1.35; text-overflow: ellipsis; white-space: nowrap; }
  .msg-link-preview span { display: -webkit-box; overflow: hidden; color: var(--text-2); font-size: 12px; line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2; line-clamp: 2; }
  .msg-link-preview em { overflow: hidden; color: var(--text-muted); font-size: 10px; font-style: normal; text-overflow: ellipsis; white-space: nowrap; }
  .msg-attachment { display: grid; width: fit-content; max-width: min(520px, 100%); gap: 4px; margin-top: 7px; }
  .msg-image-button { display: block; max-width: 100%; padding: 0; border: 0; border-radius: var(--r-lg); background: transparent; cursor: zoom-in; }
  .msg-image-button:focus-visible { outline: 2px solid var(--brand); outline-offset: 2px; }
  .image-viewer-overlay { position: fixed; inset: 0; z-index: var(--layer-modal); display: grid; place-items: center; padding: 20px; background: color-mix(in srgb, var(--bg-0) 88%, transparent); backdrop-filter: blur(8px); }
  .image-viewer-dialog { width: min(1120px, 100%); height: min(820px, calc(var(--bridge-visual-viewport-height, 100dvh) - 40px)); display: grid; grid-template-rows: auto minmax(0,1fr); overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-modal); background: var(--bg-1); box-shadow: var(--shadow-xl); }
  .image-viewer-dialog > header { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 8px 12px; border-bottom: 1px solid var(--border-subtle); }
  .image-viewer-dialog > header strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .image-viewer-dialog > header div { display: flex; align-items: center; gap: 8px; flex: none; }
  .image-viewer-dialog > header a { color: var(--text-link, var(--brand)); font-size: 12px; text-decoration: none; }
  .image-viewer-close { width: 36px; height: 36px; border: 0; border-radius: var(--r-sm); background: var(--bg-3); color: var(--text-2); cursor: pointer; }
  .image-viewer-stage { min-height: 0; display: grid; place-items: center; overflow: auto; overscroll-behavior: contain; padding: 12px; }
  .image-viewer-stage img { display: block; max-width: 100%; max-height: 100%; object-fit: contain; }
  .msg-media { display: block; max-width: min(460px, 100%); max-height: 340px; border: 1px solid var(--bg-5); border-radius: var(--r-lg); background: var(--bg-2); object-fit: contain; }
  .msg-video { width: min(460px, 100%); }
  .msg-audio { display: block; width: min(360px, 100%); accent-color: var(--brand); }
  .file-caption { color: var(--text-3); font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .msg-file { display: flex; align-items: center; gap: 10px; min-width: 220px; max-width: min(380px, 100%); padding: 10px 12px; border: 1px solid var(--bg-5); border-radius: var(--r-lg); background: var(--bg-3); color: var(--text-2); text-decoration: none; }
  .msg-file:hover { border-color: var(--brand); background: var(--bg-4); }
  .file-icon { display: grid; width: 34px; height: 34px; flex: none; place-items: center; border-radius: var(--r-md); background: var(--brand-subtle); color: var(--brand); }
  .file-icon svg, .file-open { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
  .file-copy { display: grid; min-width: 0; flex: 1; }
  .file-copy strong, .file-copy small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .file-copy strong { color: var(--text-1); font-size: 13px; font-weight: 600; }
  .file-copy small { color: var(--text-3); font-size: 11px; }
  .file-open { flex: none; color: var(--text-3); }
  .msg-reactions { display: flex; gap: 5px; margin-top: 5px; flex-wrap: wrap; }
  .msg-reaction {
    display: inline-flex; align-items: center; gap: 5px; min-height: 24px; padding: 1px 7px;
    border: 1px solid var(--bg-5); border-radius: 999px; background: var(--bg-3); color: var(--text-2); font-size: 12px; font-variant-numeric: tabular-nums;
  }
  .msg-system { justify-content: center; margin: 7px 0; padding: 3px 18px; color: var(--text-3); font-size: 12px; font-style: normal; text-align: center; }
  /* Teslim durumu — mevcut tasarım korunur, yalnızca hafif ipucu verilir. */
  .msg-pending { opacity: .72; }
  .msg-failed { background: color-mix(in srgb, var(--red) 5%, transparent); }
  .msg-delivery { min-height: 20px; font-size: 11px; color: var(--text-3); display: inline-flex; align-items: center; gap: 6px; margin-top: 2px; }
  .msg-delivery svg { width: 14px; height: 14px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }
  .delivery-dot { width: 6px; height: 6px; border: 1.5px solid currentColor; border-top-color: transparent; border-radius: 50%; animation: delivery-spin .8s linear infinite; }
  @keyframes delivery-spin { to { transform: rotate(360deg); } }
  .msg-delivery-failed { color: var(--danger); }
  .msg-delivery button {
    background: none; border: 1px solid currentColor; border-radius: var(--r-sm, 4px);
    color: inherit; font: inherit; font-size: 11px; padding: 1px 6px; cursor: pointer;
  }
  /* İkincil çıkış: çerçevesiz; birincil yol "Yeniden dene" olarak kalır. */
  .msg-delivery button.msg-delivery-discard { border-color: transparent; color: var(--text-2); text-decoration: underline; text-underline-offset: 2px; }
  .msg-delivery button.msg-delivery-discard:hover { color: var(--danger); }
  .msg-actions {
    position: absolute; right: 18px; top: -12px; z-index: 2;
    display: flex; gap: 2px; opacity: 0; visibility: hidden; pointer-events: none;
    transform: translateY(2px); transition: opacity var(--duration-fast, 90ms), transform var(--duration-fast, 90ms), visibility var(--duration-fast, 90ms);
    border: 1px solid var(--bg-5); border-radius: var(--r-md, 6px); padding: 2px;
    background: var(--bg-2); box-shadow: var(--shadow-sm, 0 4px 12px rgba(0,0,0,.18));
  }
  .msg-actions button {
    display: grid; width: 32px; height: 32px; padding: 0; place-items: center;
    background: none; border: 0; border-radius: var(--r-sm, 4px); color: var(--text-3); cursor: pointer;
  }
  .msg-actions button:hover { color: var(--text-1); background: var(--bg-3); }
  .msg-actions button.danger:hover { color: var(--red); background: color-mix(in srgb, var(--red) 12%, transparent); }
  .msg-actions svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.65; }
  /* Final21 UX (U-13) — eylem erişimi CİHAZ YETENEĞİNE göre ayrılır, genişliğe göre DEĞİL.
     Eskiden `(hover: none), (pointer: coarse)` çubuğu her mesajın YANINDA kalıcı gösteriyor,
     uzun basma sayfası ise yalnız `max-width: 600px` altında devreye giriyordu. Ölçüm
     (768×1024 dokunmatik tablet): 8 ikonluk çubuk HER mesajda, metin ~120 px sütuna sıkıştı.
     Aynı genişlik kuralı, dar bir masaüstü penceresindeki FARE kullanıcısından eylemleri
     tamamen alıyordu (uzun basma fareyi yok sayar). Şimdi:
       · hover YOK (telefon, tablet)  → çubuk düzenden çıkar; uzun basma sayfası; klavye
         odağında katman çubuk (aşağıdaki kurallar) — her genişlikte;
       · hover VAR (fare, iz dörtgeni) → her genişlikte olağan üzerine-gelme katmanı. */
  @media (hover: none) {
    .msg-actions { display: none; }
    /* `:focus-visible` — dokunuşla gelen odakta EŞLEŞMEZ, yalnız klavye odağında (UX-18). */
    .msg:focus-visible .msg-actions,
    .msg:has(:focus-visible) .msg-actions {
      display: flex;
      position: absolute;
      right: 8px;
      top: -10px;
      opacity: 1;
      visibility: visible;
      pointer-events: auto;
      border: 1px solid var(--bg-5);
      border-radius: var(--radius-md);
      background: var(--bg-2);
      box-shadow: var(--shadow-sm);
    }
  }
  @media (hover: hover) and (pointer: coarse) {
    .msg-actions button { width: 36px; height: 36px; }
  }
  @media (max-width: 600px) {
    .msg { gap: 8px; padding-left: 10px; padding-right: 10px; }
    .msg-avatar, .msg-gutter { width: 34px; }
    .msg-avatar { height: 34px; }
    .reply-content { max-width: 44vw; }

    /* ══════════════════════════════════════════════════════════════════
       ÇÖZÜLDÜ — ESKİ NOT AŞAĞIDA KAYIT İÇİN BIRAKILDI
       ══════════════════════════════════════════════════════════════════
       BİLİNEN MOBİL BOŞLUK — ÇÖZÜMÜ CSS DEĞİL, BİLEŞEN
       ══════════════════════════════════════════════════════════════════
       Dokunmatikte hover olmadığı için yukarıdaki `(pointer: coarse)` kuralı
       eylem çubuğunu KALICI görünür yapar ve `position: static` ile mesajın
       yanında yer kaplar.

       ÖLÇÜLEN ETKİ (412px telefon): 6 ikon x 36px, genişliğin ~%45'ini alıyor;
       metin satır başına üç kelimeye düşüyor.

       DENENDİ VE GERİ ALINDI: çubuğu `position: absolute` yapmak metne tam
       genişliği geri kazandırdı ama çubuk mesaj METNİNİN ÜZERİNE binip içeriği
       GİZLEDİ. Gizlenen metin, sıkışmış metinden DAHA KÖTÜDÜR.

       Eylemleri mobilde gizlemek de mümkün değil: mesajlar için bağlam menüsü
       YOK (sağ tık yalnızca aynı çubuğu gösteriyor), yani çubuk bu eylemlerin
       TEK erişim yolu. Gizlemek onları erişilemez yapardı.

       DOĞRU ÇÖZÜM: uzun basınca açılan bir eylem sayfası (action sheet).
       Bu bir BİLEŞEN işidir, CSS ayarı değil; kanıtsız bir düzen değişikliği
       yapmak yerine boşluk burada kayıtlıdır.

       ÇÖZÜM UYGULANDI: `MessageActionSheet.svelte` (uzun basma). Aşağıdaki
       kural çubuğu dokunmatikte düzenden ÇIKARIR; klavye kullanıcısı için
       odaklandığında KATMAN olarak geri gelir (klavyeyle gezerken kaydırma
       yoktur, dolayısıyla üste binmesi sorun değildir). */
    /* Eylem çubuğunun dokunmatik davranışı yukarıdaki `(hover: none)` bloğunda (U-13). */
    .image-viewer-overlay { padding: 0; }
    .image-viewer-dialog { width: 100%; height: var(--bridge-visual-viewport-height, 100dvh); border: 0; border-radius: 0; }
    .image-viewer-dialog > header { padding-top: calc(8px + env(safe-area-inset-top)); }
    .image-viewer-stage { padding-bottom: calc(12px + env(safe-area-inset-bottom)); }
    .edit-history-overlay {
      place-items: end center;
      padding: 0;
    }
    .edit-history-dialog {
      width: 100%;
      max-height: min(82dvh, var(--bridge-visual-viewport-height, 82dvh));
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: var(--radius-modal) var(--radius-modal) 0 0;
    }
    .edit-history-dialog > header {
      padding-top: 12px;
      padding-inline: 14px;
    }
    .edit-history-body {
      padding: 12px 14px calc(16px + env(safe-area-inset-bottom));
      overscroll-behavior: contain;
    }
    .report-actions {
      position: sticky;
      bottom: 0;
      padding-top: 8px;
      background: var(--bg-2);
    }
    .report-actions button { min-height: 44px; flex: 1; }
  }
  @media (prefers-reduced-motion: reduce) { .delivery-dot { animation: none; border-top-color: currentColor; } }

  .msg-sticker-wrap {
    width: fit-content; max-width: min(320px, 70vw);
    display: flex; flex-direction: column; align-items: flex-start; gap: var(--space-1);
    margin-top: var(--space-1);
  }
  .msg-sticker {
    display: block; max-width: min(320px, 70vw); max-height: 320px; width: auto; height: auto;
    object-fit: contain; background: transparent;
  }
  .msg-sticker-fallback {
    min-width: 148px; min-height: 96px; max-width: min(320px, 70vw);
    padding: var(--space-3); box-sizing: border-box;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: var(--space-1);
    border: 1px dashed var(--border); border-radius: var(--radius-control);
    background: var(--bg-3); color: var(--text-muted); text-align: center; font-size: var(--text-xs);
  }
  .msg-sticker-fallback-mark { font-size: 26px; line-height: 1; color: var(--text-2); }
  .msg-sticker-name { font-size: var(--text-xs); color: var(--text-muted); }
</style>
