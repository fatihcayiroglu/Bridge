<!-- client/js/core/GroupDmPanel.svelte -->
<!-- ADR-0008 Faz 2 — group-dm.ts (381 satır) → Svelte bileşeni           -->
<!-- GDM listesi, sohbet, oluştur/ayar/info modal, üye yönetimi            -->
<!-- Svelte 5 Runes API, BridgeRegistry köprüsü                            -->
<!-- Sprint 113                                                             -->

<script lang="ts">
  import { avatarStyleFromResolved } from './avatar-color.ts';
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { onMount, onDestroy, tick } from 'svelte';
  import { BridgeRegistry }     from './bridge-registry.js';
  import { friendsCache }        from './globals.js';
  import { createLogger }        from './logger.js';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { confirmProductAction } from './product-dialog.ts';
  import { safeApiErrorMessage } from './api-error.ts';
  import { connectionLostDeliveryError, messageDeliveryError } from './message-delivery-error.ts';
  import { type DraftIdentity } from './draft-store.ts';
  import {
    clearLocalFirstDraft,
    hydrateLocalFirstDraft,
    persistLocalFirstDraftText,
  } from './local-first/draft-runtime.ts';
  import {
    normalizeGdmGroup, normalizeGdmGroups, normalizeGdmMessages,
    type GdmGroup, type GdmMessage,
  } from './group-dm-normalize.ts';
  // group-dm-voice.ts yüklenmiş olmalı — startGdmCall window üzerinden alınır
  // (vanilla modül, dynamic import ile lazy yükleme)
  let _gdmVoiceLoaded = false;

  const log = createLogger('GroupDmPanel');

  // ── Tipler ────────────────────────────────────────────────────────────────

  interface Props {
    onClose?: () => void;
  }

  let { onClose }: Props = $props();

  // ── State ─────────────────────────────────────────────────────────────────

  /**
   * FAZ C4.7 — GÖRÜNÜRLÜK. DmPanel.svelte:12 ile aynı sözleşme: panel
   * kabuğa GİZLİ mount edilir ve yalnız gerçek bir ürün eylemi
   * (`showGroupDmPanel` / `openGroupDmPanel`) onu açar.
   */
  let isVisible      = $state(false);
  let groups         = $state<GdmGroup[]>([]);
  let currentGroup   = $state<GdmGroup | null>(null);
  let messages       = $state<GdmMessage[]>([]);
  let inputValue     = $state('');
  let loading        = $state(false);
  let msgLoading     = $state(false);
  let listError      = $state(false);
  const SEND_TIMEOUT_MS = 10_000;
  const pendingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * Geçmiş sayfa boyutu. Sunucu `before` + `beforeId` bileşik imlecini
   * destekliyordu (Faz 10.6B) ama istemci yalnız son 50 mesajı istiyordu:
   * daha eski grup geçmişine arayüzden ulaşılamıyordu (P3).
   */
  const GDM_PAGE = 50;
  let hasOlder       = $state(false);
  let loadingOlder   = $state(false);

  // Modaller
  type ModalKind = 'create' | 'info' | 'settings' | null;
  let activeModal    = $state<ModalKind>(null);

  // Create modal
  let createName     = $state('');
  let createIcon     = $state('');
  let createMembers  = $state('');
  let creating       = $state(false);

  // Settings modal
  let settingsName   = $state('');
  let settingsIcon   = $state('');
  let saving         = $state(false);

  // Info modal — add member
  let addMemberInput = $state('');

  // ── Helpers ───────────────────────────────────────────────────────────────

  function apiFetch(url: string, opts?: RequestInit): Promise<Response> {
    const fn = BridgeRegistry.get('apiFetch') as ((u: string, o?: RequestInit) => Promise<Response>) | undefined;
    if (!fn) return Promise.reject(new Error(t("ui_guvenli_api_istemcisi_kullanilamiyor", "Güvenli API istemcisi kullanılamıyor.")));
    return fn(url, opts);
  }

  function API(): string {
    return ((window as Record<string, unknown>)['API'] as string) ?? '';
  }

  function me(): { id: string; displayName?: string } | null {
    const raw = (BridgeRegistry.get('getMe') as (() => { id?: unknown; _id?: unknown; displayName?: unknown } | null) | undefined)?.();
    if (!raw) return null;
    const id = typeof (raw._id ?? raw.id) === 'string' ? String(raw._id ?? raw.id).trim() : '';
    return id ? { id, displayName: typeof raw.displayName === 'string' ? raw.displayName : undefined } : null;
  }


  function gdmDraftIdentity(group: GdmGroup | null = currentGroup): DraftIdentity | null {
    const userId = me()?.id ?? '';
    const conversationId = String(group?._id ?? '').trim();
    return userId && conversationId ? { userId, kind: 'gdm', conversationId } : null;
  }

  function persistGdmDraft(text = inputValue, group: GdmGroup | null = currentGroup): void {
    const identity = gdmDraftIdentity(group);
    if (identity) persistLocalFirstDraftText(identity, text);
  }

  async function restoreGdmDraft(group: GdmGroup): Promise<string> {
    const identity = gdmDraftIdentity(group);
    if (!identity) return '';
    return (await hydrateLocalFirstDraft(identity))?.text ?? '';
  }

  function clearGdmDraft(group: GdmGroup | null = currentGroup): void {
    const identity = gdmDraftIdentity(group);
    if (identity) clearLocalFirstDraft(identity);
  }

  interface GdmSocket {
    emit(e: string, d?: unknown): void;
    on?(e: string, fn: (d: unknown) => void): void;
    off?(e: string, fn: (d: unknown) => void): void;
  }

  /**
   * FAZ C4.7 — KANONİK SOCKET SAHİBİ.
   *
   * Eskiden burada `window.socket` LEGACY GLOBAL'i okunuyordu. Bu, Faz 10.4'te
   * kurulan nesne-kimliği farkındalıklı yeniden bağlama mimarisinin DIŞINDA
   * kalıyor ve ikinci bir socket sahibi yaratıyordu — Group DM istemcisinin
   * kasıtlı olarak uykuda bırakılmasının gerekçelerinden biri tam olarak
   * buydu. Artık DmPanel.svelte:34 ile AYNI kanonik kaynak kullanılır.
   */
  const socket = (): GdmSocket | null => BridgeRegistry.get('socket') as GdmSocket | null;

  function toast(msg: string, type = 'info'): void {
    BridgeRegistry.get('toast')?.(msg, type);
  }

  function cssColor(c: string): string {
    const candidate = (BridgeRegistry.get('cssColor') as ((c: string) => string) | undefined)?.(c) ?? c;
    return /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i.test(candidate)
      ? candidate
      : 'var(--brand)';
  }

  /**
   * Görünen ad SUNUCUDAN gelir ve eksik/boş olabilir (ör. silinmiş kullanıcı,
   * eski kayıt). Eskiden doğrudan `name.slice(...)` çağrılıyordu ve `undefined`
   * gelince render sırasında istisna fırlatıyordu. Güvenilmez girdi normalize
   * edilir.
   */
  function initials(name: string | null | undefined): string {
    const safe = String(name ?? '').trim();
    if (!safe) return '?';
    return (BridgeRegistry.get('initials') as ((n: string) => string) | undefined)?.(safe)
      ?? safe.slice(0, 2).toUpperCase();
  }

  // FAZ C4: `formatText` ve `escHtml` KALDIRILDI.
  //
  // İkisi de yalnızca `{@html}` sözleşmesine hizmet ediyordu. `formatText`
  // hiç kayıtlı olmayan bir biçimlendiriciyi çözmeye çalışıp girdiyi aynen
  // döndürüyor, sonuç doğrudan innerHTML'e yazılıyordu (canlı XSS).
  // Mesaj metni artık Svelte metin enterpolasyonuyla basılıyor; elle
  // kaçışlamaya (escHtml) da gerek kalmadı. Bu yardımcıları geride bırakmak
  // aynı güvensiz yolun sessizce diriltilmesini kolaylaştırırdı.

  // ── GDM listesi ──────────────────────────────────────────────────────────

  let listLoadSeq = 0;
  /** `silent`: arka planda tazeleme — yükleniyor durumu ve hata bayrağı değişmez. */
  async function loadGroupDmList(silent = false): Promise<void> {
    const seq = ++listLoadSeq;
    if (!silent) { loading = true; listError = false; }
    try {
      const r = await apiFetch(`${API()}/api/gdm`);
      if (!r.ok) throw new Error(`group list HTTP ${r.status}`);
      const data = await r.json() as unknown;
      if (seq !== listLoadSeq) return;
      groups = normalizeGdmGroups(data, cssColor);
    } catch (e) {
      if (seq === listLoadSeq) {
        if (!silent) listError = true;
        log.warn('loadGroupDmList hata:', e);
      }
    } finally {
      if (seq === listLoadSeq) loading = false;
    }
  }

  /**
   * Açık OLMAYAN bir gruba mesaj geldiğinde yan listedeki okunmamış rozeti
   * panel yeniden açılana kadar bayat kalıyordu. Sayaç yerelde artırılmaz
   * (çift teslim şişirirdi); sunucunun türettiği liste sessizce yeniden okunur.
   */
  let listRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  function refreshGroupListSoon(): void {
    if (listRefreshTimer) clearTimeout(listRefreshTimer);
    listRefreshTimer = setTimeout(() => { listRefreshTimer = null; void loadGroupDmList(true); }, 300);
  }

  function messagesArea(): HTMLElement | null {
    return document.getElementById('gdm-messages');
  }

  function nearBottom(): boolean {
    const area = messagesArea();
    return !area || area.scrollHeight - area.scrollTop - area.clientHeight < 80;
  }

  // ── Grup aç / mesajlar ────────────────────────────────────────────────────

  async function openGroupDm(group: GdmGroup, messageId?: string): Promise<boolean> {
    closeExclusivePeers('gdm');
    isVisible = true;
    persistGdmDraft();
    const normalizedGroup = normalizeGdmGroup(group, cssColor);
    if (!normalizedGroup) {
      toast(t('gdm_gone', 'Bu konuşma artık kullanılamıyor.'), 'warning');
      return false;
    }
    currentGroup = normalizedGroup;
    inputValue = '';
    const draftGroupId = normalizedGroup._id;
    void restoreGdmDraft(normalizedGroup).then(value => {
      // Opening the local database is asynchronous; never replace characters
      // typed while hydration was in flight.
      if (currentGroup?._id !== draftGroupId || inputValue.length > 0) return;
      inputValue = value;
    });
    const loaded = await loadGroupDmMessages(normalizedGroup._id, messageId);
    if (!loaded || currentGroup?._id !== normalizedGroup._id) {
      // Üyelik kaldırılmış veya hedef silinmiş olabilir. Stale history/list
      // girdisi özel konuşma kabuğunu geri getiremez.
      if (currentGroup?._id === normalizedGroup._id) {
        currentGroup = null;
        inputValue = '';
        messages = [];
      }
      toast(t('gdm_gone', 'Bu konuşma artık kullanılamıyor.'), 'warning');
      return false;
    }
    socket()?.emit('gdm:join', normalizedGroup._id);
    socket()?.emit('gdm:read', { groupId: normalizedGroup._id });
    groups = groups.map(item => item._id === normalizedGroup._id ? { ...item, unreadCount: 0 } : item);
    if (BridgeRegistry.has('recordNavigationLocation')) {
      BridgeRegistry.call('recordNavigationLocation', {
        type: 'gdm',
        group: { _id: normalizedGroup._id, name: normalizedGroup.name },
        ...(messageId ? { messageId } : {}),
      });
    }
    return true;
  }

  /**
   * FAZ C4.6 — BAYAT GEÇMİŞ YANITI KORUMASI.
   *
   * ── KAPATILAN GERÇEK SORUN ───────────────────────────────────────────────
   * Yanıt `messages`e KOŞULSUZ atanıyordu. Yarış:
   *   1) A grubu açılır, geçmiş isteği yavaştır
   *   2) kullanıcı B grubuna geçer, B yüklenir
   *   3) A'nın yanıtı GEÇ gelir ve `messages`i ezer
   * Sonuç: B'nin başlığı altında A'nın mesajları görünürdü. Aynı yol,
   * kullanıcı A'dan ÇIKARILDIKTAN sonra gelen bir yanıtın kapatılmış
   * konuşmayı geri getirmesine de izin veriyordu.
   *
   * Çözüm: istek kimliği (sıra numarası) + grup kimliği birlikte doğrulanır.
   * İKİNCİ bir durum sahibi kurulmaz; mevcut `currentGroup` kanonik kalır.
   */
  let msgLoadSeq = 0;

  async function loadGroupDmMessages(groupId: string, messageId?: string): Promise<boolean> {
    const seq = ++msgLoadSeq;
    msgLoading = true;
    messages = [];
    // Önceki grubun yarım kalmış eski-sayfa isteği bu grubu kilitlemez.
    hasOlder = false;
    loadingOlder = false;
    try {
      const r = await apiFetch(`${API()}/api/gdm/${groupId}/messages?limit=${GDM_PAGE}`);
      if (!r.ok) return false;
      const data = await r.json() as GdmMessage[];

      // Bu yanıt hâlâ EN GÜNCEL istek mi ve grup hâlâ AÇIK mı?
      if (seq !== msgLoadSeq) return false;                 // daha yeni bir yükleme var
      if (currentGroup?._id !== groupId) return false;      // başka gruba geçildi/kapandı

      messages = normalizeGdmMessages(data, groupId, cssColor);
      hasOlder = Array.isArray(data) && data.length >= GDM_PAGE;
    } catch { return false; }
    finally {
      // Yalnız en güncel istek yükleme durumunu temizler.
      if (seq === msgLoadSeq) msgLoading = false;
    }
    // Saved hedefi varsa ona, yoksa konuşmanın sonuna git.
    setTimeout(() => {
      const area = document.getElementById('gdm-messages');
      if (!area) return;
      if (messageId) {
        const target = area.querySelector<HTMLElement>(`.dm-msg[data-id="${CSS.escape(messageId)}"]`);
        if (target) {
          const reduceMotion = globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
          target.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'center' });
          target.classList.add('dm-msg-highlight');
          setTimeout(() => target.classList.remove('dm-msg-highlight'), reduceMotion ? 1 : 1600);
          return;
        }
        toast(t('gdm_not_in_page', 'Kaydedilen mesaj son geçmiş sayfasında değil.'), 'warning');
      }
      area.scrollTop = area.scrollHeight;
    }, 0);
    return true;
  }

  /** Bir önceki geçmiş sayfası — en eski yüklü mesajın bileşik imleciyle. */
  async function loadOlder(): Promise<void> {
    const group = currentGroup;
    if (!group || loadingOlder || !hasOlder || msgLoading) return;
    const oldest = messages.find(item => item._id && !item.pending && !item.failed);
    const before = oldest ? (typeof oldest.createdAt === 'number' ? oldest.createdAt : Date.parse(String(oldest.createdAt))) : NaN;
    if (!oldest?._id || !Number.isFinite(before) || before <= 0) { hasOlder = false; return; }
    const seq = msgLoadSeq;
    const area = messagesArea();
    const prevHeight = area?.scrollHeight ?? 0;
    const prevTop = area?.scrollTop ?? 0;
    loadingOlder = true;
    try {
      const params = new URLSearchParams({ limit: String(GDM_PAGE), before: String(before), beforeId: oldest._id });
      const r = await apiFetch(`${API()}/api/gdm/${group._id}/messages?${params}`);
      if (seq !== msgLoadSeq || currentGroup?._id !== group._id) return;
      if (!r.ok) throw new Error(`group history HTTP ${r.status}`);
      const data = await r.json() as unknown;
      if (seq !== msgLoadSeq || currentGroup?._id !== group._id) return;
      if (!Array.isArray(data)) throw new Error('Invalid group history response');
      const known = new Set(messages.map(item => item._id).filter(Boolean));
      const older = normalizeGdmMessages(data, group._id, cssColor).filter(item => !item._id || !known.has(item._id));
      messages = [...older, ...messages];
      hasOlder = data.length >= GDM_PAGE;
      // Okuma yeri korunur: eklenen içerik kadar aşağı kaydırılır.
      await tick();
      const after = messagesArea();
      if (area && after === area) area.scrollTop = prevTop + (area.scrollHeight - prevHeight);
    } catch (e) {
      if (seq === msgLoadSeq) {
        log.warn('loadOlder hata:', e);
        toast(t('dm_history_load_failed', 'Daha eski mesajlar yüklenemedi.'), 'error');
      }
    } finally {
      if (seq === msgLoadSeq) loadingOlder = false;
    }
  }

  function onMessagesScroll(event: Event): void {
    const area = event.currentTarget as HTMLElement | null;
    if (area && area.scrollTop < 48) void loadOlder();
  }

  function saveForLater(message: GdmMessage): void {
    if (!currentGroup || !message._id || message.type === 'system' || message.pending || message.failed) return;
    BridgeRegistry.call('saveForLater', {
      destinationType: 'gdm', destinationId: currentGroup._id, messageId: message._id,
    });
  }

  function newClientNonce(): string {
    return globalThis.crypto?.randomUUID?.() ?? `gdm-${Date.now()}-${Math.random().toString(36).slice(2, 12)}`;
  }

  function clearPendingTimer(clientNonce: string): void {
    const timer = pendingTimers.get(clientNonce);
    if (timer) clearTimeout(timer);
    pendingTimers.delete(clientNonce);
  }

  function clearAllPendingTimers(): void {
    for (const timer of pendingTimers.values()) clearTimeout(timer);
    pendingTimers.clear();
  }

  function markSendFailed(clientNonce: string, message?: string): void {
    const resolvedMessage = message ?? t('ui_message_send_failed_retry', 'Mesaj gönderilemedi. Yeniden deneyin.');
    clearPendingTimer(clientNonce);
    messages = messages.map(item => item.clientNonce === clientNonce
      ? { ...item, pending: false, failed: true, lastError: resolvedMessage } : item);
  }

  function scheduleSendTimeout(clientNonce: string): void {
    clearPendingTimer(clientNonce);
    pendingTimers.set(clientNonce, setTimeout(() => {
      markSendFailed(clientNonce, t("ui_sunucudan_teslim_onayi_alinamadi_yeniden_deneyin", "Sunucudan teslim onayı alınamadı. Yeniden deneyin."));
    }, SEND_TIMEOUT_MS));
  }

  function onGdmSendError(value: unknown): void {
    if (!value || typeof value !== 'object') return;
    const payload = value as { event?: unknown; clientNonce?: unknown; code?: unknown };
    if (payload.event && payload.event !== 'gdm:send') return;
    if (typeof payload.clientNonce !== 'string' || !pendingTimers.has(payload.clientNonce)) return;
    markSendFailed(payload.clientNonce, messageDeliveryError(payload.code, 'gdm'));
  }

  function onSocketDisconnect(): void {
    for (const clientNonce of [...pendingTimers.keys()]) {
      markSendFailed(clientNonce, connectionLostDeliveryError());
    }
  }

  function sendGroupDm(): void {
    if (!currentGroup) return;
    const content = inputValue.trim();
    if (!content) return;
    if (content.length > 2000) { toast(t('gdm_too_long', 'Mesaj çok uzun'), 'error'); return; }
    const currentMe = me();
    const clientNonce = newClientNonce();
    const pending: GdmMessage = {
      _key: `pending:${clientNonce}`, _id: `pending:${clientNonce}`, groupId: currentGroup._id,
      userId: currentMe?.id, displayName: currentMe?.displayName || 'Sen', avatarColor: '#2d9cdb',
      content, createdAt: Date.now(), clientNonce, pending: true, failed: false,
    };
    messages = [...messages, pending];
    void tick().then(() => { const area = messagesArea(); if (area) area.scrollTop = area.scrollHeight; });
    socket()?.emit('gdm:send', { groupId: currentGroup._id, content, clientNonce });
    scheduleSendTimeout(clientNonce);
    clearGdmDraft(currentGroup);
    inputValue = '';
  }

  function retryGroupMessage(message: GdmMessage): void {
    if (!currentGroup || !message.failed || !message.clientNonce) return;
    messages = messages.map(item => item.clientNonce === message.clientNonce
      ? { ...item, pending: true, failed: false, lastError: '' } : item);
    socket()?.emit('gdm:send', {
      groupId: currentGroup._id, content: message.content, clientNonce: message.clientNonce,
    });
    scheduleSendTimeout(message.clientNonce);
  }

  // ── Socket events ─────────────────────────────────────────────────────────

  // Payload GÜVENİLMEZ girdidir (sunucudan gelir, şekli doğrulanır).
  /** Paneli kapat ve seçimi temizle (DmPanel.svelte:149 ile aynı sözleşme). */
  function closePanel(): void {
    persistGdmDraft();
    clearAllPendingTimers();
    isVisible    = false;
    currentGroup = null;
    messages     = [];
    inputValue   = '';
    activeModal  = null;
    msgLoadSeq  += 1;          // uçuştaki geçmiş yanıtını geçersiz kıl
  }

  /**
   * Kullanıcı tarafından yapılan kapatma HER ZAMAN önce bileşenin kanonik
   * durumunu kapatır. Parent callback yalnızca bildirimdir; görünürlüğün
   * sahibi değildir. Önceden production shim `#gdm-root.style.display=none`
   * yapıyor, fakat `isVisible` true kalıyordu. Sonuç: gizli panel Escape'i
   * yutuyor ve sonraki `showGroupDmPanel` çağrısı root hâlâ `display:none`
   * olduğu için ekranda hiçbir şey açmıyordu.
   */
  function backToGroupList(): void {
    persistGdmDraft();
    msgLoadSeq += 1;
    currentGroup = null;
    messages = [];
    inputValue = '';
    activeModal = null;
  }

  function requestClose(): void {
    closePanel();
    onClose?.();
  }

  // Payload GÜVENİLMEZ girdidir (sunucudan gelir, şekli doğrulanır).
  function _onGdmMessage(raw: unknown): void {
    if (!currentGroup) return;
    if (!raw || typeof raw !== 'object') return;
    const msg = raw as Partial<GdmMessage>;
    // FAZ C4.6 — KONUŞMA KİMLİĞİ DOĞRULANIR.
    // Soket, kullanıcının TÜM grup odalarına katılır (sunucu tarafında
    // `joinGroupRooms`), bu yüzden buraya BAŞKA bir grubun mesajı da düşebilir.
    // Kimlik kontrolü olmadan B grubunun mesajı, açık olan A grubunun altına
    // eklenirdi — kullanıcı yanlış konuşmada olduğunu sanarak yanıt verebilirdi.
    if (String(msg?.groupId ?? '') !== currentGroup._id) {
      if (isVisible && msg?.groupId) refreshGroupListSoon();
      return;
    }
    const normalized = normalizeGdmMessages([msg], currentGroup._id, cssColor)[0];
    if (!normalized) return;
    const clientNonce = normalized.clientNonce;
    if (clientNonce) clearPendingTimer(clientNonce);
    if (normalized._id && messages.some(item => item._id === normalized._id && !item.pending && !item.failed)) return;
    normalized._key = normalized._id || `live:${currentGroup._id}:${Date.now()}:${messages.length}`;
    normalized.pending = false;
    normalized.failed = false;
    normalized.lastError = '';
    // Geçmişi okuyan kullanıcı başkasının mesajıyla en alta atılmaz.
    const followLatest = nearBottom() || normalized.userId === me()?.id;
    messages = [...messages.filter(item => clientNonce ? item.clientNonce !== clientNonce : item._id !== normalized._id), normalized];
    socket()?.emit('gdm:read', { groupId: currentGroup._id });
    groups = groups.map(item => item._id === currentGroup?._id ? { ...item, unreadCount: 0 } : item);
    if (followLatest) {
      setTimeout(() => {
        const area = document.getElementById('gdm-messages');
        if (area) area.scrollTop = area.scrollHeight;
      }, 0);
    }
  }

  function _onGdmUpdate(raw: unknown): void {
    const group = normalizeGdmGroup(raw, cssColor);
    if (!group) return;
    groups = groups.map(g => g._id === group._id ? group : g);
    if (currentGroup?._id === group._id) currentGroup = group;
  }

  /**
   * FAZ C4.6 — ERİŞİM KALDIRILDIĞINDA İSTEMCİ DURUMU TEMİZLENİR.
   *
   * Sunucu, kullanıcı gruptan ÇIKARILDIĞINDA veya grup SİLİNDİĞİNDE
   * `gdm:deleted` yayınlar (routes/groupDm.ts). Bu olay istemcide HİÇ
   * dinlenmiyordu: erişimi kaldırılmış kullanıcının panelinde konuşma açık
   * kalıyor, mesajlar okunur durumda duruyor ve besteci (composer) hâlâ
   * gönderiyormuş gibi görünüyordu.
   *
   * Güvenlik sınırı ARKA UÇTADIR (gönderim ve geçmiş zaten reddedilir); bu
   * temizlik YANILTICI bayat erişimi ortadan kaldırır. `msgLoadSeq` artırılır
   * ki UÇUŞTAKİ bir geçmiş yanıtı kapatılmış konuşmayı geri getiremesin.
   */
  /**
   * FAZ C4.7 — NESNE KİMLİĞİ FARKINDALIKLI SOCKET BAĞLAMA.
   *
   * Kanonik kalıp DmPanel.svelte:54-71'dir. Socket nesnesi yeniden bağlanma /
   * kimlik yenileme sonrası DEĞİŞTİRİLEBİLİR; kalıcı bir `bound = true`
   * bayrağı bu durumda ya çift dinleyici ya da kalıcı olarak bayat bir bağ
   * bırakırdı. Bu yüzden BAĞLANILAN NESNE saklanır ve yalnız nesne
   * değiştiğinde yeniden bağlanılır.
   *
   * Çözme DAİMA aynı (olay, callback referansı) çiftiyle yapılır —
   * `removeAllListeners()` başka özelliklerin dinleyicilerini de silerdi.
   */
  let boundSocket: GdmSocket | null = null;

  function unbindSocket(): void {
    if (!boundSocket) return;
    boundSocket.off?.('gdm:message', _onGdmMessage);
    boundSocket.off?.('gdm:updated', _onGdmUpdate);
    boundSocket.off?.('gdm:deleted', _onGdmAccessRevoked);
    boundSocket.off?.('error:message', onGdmSendError);
    boundSocket.off?.('error:gdm_rate', onGdmSendError);
    boundSocket.off?.('disconnect', onSocketDisconnect);
    boundSocket = null;
  }

  function syncSocketBinding(): void {
    const sock = socket();
    if (!sock) { unbindSocket(); return; }
    if (boundSocket === sock) return;          // zaten BU nesneye bağlıyız
    unbindSocket();
    sock.on?.('gdm:message', _onGdmMessage);
    // The REST owner broadcasts this event after a successful group PATCH.
    // Keeping the handler unbound left other members on stale names/icons.
    sock.on?.('gdm:updated', _onGdmUpdate);
    sock.on?.('gdm:deleted', _onGdmAccessRevoked);
    sock.on?.('error:message', onGdmSendError);
    sock.on?.('error:gdm_rate', onGdmSendError);
    sock.on?.('disconnect', onSocketDisconnect);
    boundSocket = sock;
  }

  function _onGdmAccessRevoked(payload: unknown): void {
    const gid = String((payload as { groupId?: unknown } | null)?.groupId ?? '');
    if (!gid) return;

    groups = groups.filter(g => g._id !== gid);

    if (currentGroup?._id === gid) {
      clearGdmDraft(currentGroup);
      msgLoadSeq += 1;          // uçuştaki geçmiş yanıtını geçersiz kıl
      clearAllPendingTimers();
      currentGroup = null;
      messages     = [];
      inputValue   = '';
      activeModal  = null;
    }
  }

  function onLogout(): void {
    listLoadSeq += 1;
    msgLoadSeq += 1;
    clearAllPendingTimers();
    groups = [];
    currentGroup = null;
    messages = [];
    inputValue = '';
    activeModal = null;
    loading = false;
    msgLoading = false;
    listError = false;
    isVisible = false;
  }

  function onSocketLifecycle(): void {
    syncSocketBinding();
    if (!isVisible) return;
    void loadGroupDmList();
    if (currentGroup) void loadGroupDmMessages(currentGroup._id);
  }

  // ── Create modal ──────────────────────────────────────────────────────────

  async function createGroupDm(): Promise<void> {
    if (!createName.trim()) { toast(t('gdm_name_required', 'Grup adı gerekli'), 'error'); return; }
    if (!createMembers.trim()) { toast(t('gdm_need_member', 'En az 1 üye ekle'), 'error'); return; }

    const usernames = createMembers.split(',').map(u => u.trim()).filter(Boolean);
    const memberIds: string[] = [];

    for (const uname of usernames) {
      const found = (Array.from(friendsCache.values()) as { _id?: string; id?: string; username?: string }[])
        .find(f => f.username?.toLowerCase() === uname.toLowerCase());
      if (!found) { toast(t('gdm_user_nf_friend', '"{user}" bulunamadı — önce arkadaş olmalısınız', { user: uname }), 'warning'); return; }
      memberIds.push((found._id ?? found.id) as string);
    }

    creating = true;
    try {
      const r = await apiFetch(`${API()}/api/gdm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName.trim(), icon: createIcon.trim() || null, memberIds }),
      });
      if (!r.ok) { toast(safeApiErrorMessage(r, t('gdm_create_failed', 'Oluşturulamadı'), { report: true }), 'error'); return; }
      const data = await r.json() as GdmGroup;

      activeModal = null;
      createName = ''; createIcon = ''; createMembers = '';
      toast(t('gdm_created_named', '"{name}" grubu oluşturuldu! 🎉', { name: data.name }), 'success');
      await loadGroupDmList();
      void openGroupDm(data);
    } catch (error) {
      log.warn('createGroupDm hata:', error);
      toast(t('gdm_conn_error', 'Bağlantı hatası'), 'error');
    } finally {
      creating = false;
    }
  }

  // ── Info modal ────────────────────────────────────────────────────────────

  async function addGroupDmMember(): Promise<void> {
    if (!currentGroup) return;
    const uname = addMemberInput.trim();
    if (!uname) return;
    const found = (Array.from(friendsCache.values()) as { _id?: string; id?: string; username?: string }[])
      .find(f => f.username?.toLowerCase() === uname.toLowerCase());
    if (!found) { toast(t('gdm_user_nf', '"{user}" bulunamadı', { user: uname }), 'error'); return; }

    try {
      const r = await apiFetch(`${API()}/api/gdm/${currentGroup._id}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: found._id ?? found.id }),
      });
      if (!r.ok) { toast(safeApiErrorMessage(r, 'Eklenemedi', { report: true }), 'error'); return; }
      toast(t('gdm_member_added', '{name} gruba eklendi!', { name: uname }), 'success');
      addMemberInput = '';
      const gr = await apiFetch(`${API()}/api/gdm/${currentGroup._id}`);
      if (gr.ok) currentGroup = normalizeGdmGroup(await gr.json(), cssColor) ?? currentGroup;
    } catch (error) {
      log.warn('addGroupDmMember hata:', error);
      toast(t('gdm_conn_error', 'Bağlantı hatası'), 'error');
    }
  }

  async function kickGroupDmMember(userId: string, name: string): Promise<void> {
    if (!currentGroup) return;
    if (!await confirmProductAction({ title: t("ui_uyeyi_gruptan_cikar", "Üyeyi gruptan çıkar"), message: t('gdm_remove_confirm', '{name} kullanıcısını gruptan çıkarmak istediğinizden emin misiniz?', { name }), confirmLabel: t("gdm_remove", "Çıkar"), tone: 'danger' })) return;
    try {
      const r = await apiFetch(`${API()}/api/gdm/${currentGroup._id}/members/${userId}`, { method: 'DELETE' });
      if (!r.ok) { toast(safeApiErrorMessage(r, t('gdm_remove_failed', 'Çıkarılamadı'), { report: true }), 'error'); return; }
      toast(t('gdm_removed_named', '{name} gruptan çıkarıldı', { name }), 'success');
      activeModal = null;
      await loadGroupDmList();
      const gr = await apiFetch(`${API()}/api/gdm/${currentGroup._id}`);
      if (gr.ok) currentGroup = normalizeGdmGroup(await gr.json(), cssColor) ?? currentGroup;
    } catch (error) {
      log.warn('kickGroupDmMember hata:', error);
      toast(t('gdm_conn_error', 'Bağlantı hatası'), 'error');
    }
  }

  // ── Settings modal ────────────────────────────────────────────────────────

  function openSettings(): void {
    if (!currentGroup) return;
    settingsName = currentGroup.name;
    settingsIcon = currentGroup.icon ?? '';
    activeModal = 'settings';
  }

  async function saveGroupDmSettings(): Promise<void> {
    if (!currentGroup) return;
    if (!settingsName.trim()) { toast(t('gdm_name_empty', 'Grup adı boş olamaz'), 'error'); return; }
    saving = true;
    try {
      const r = await apiFetch(`${API()}/api/gdm/${currentGroup._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: settingsName.trim(), icon: settingsIcon.trim() || null }),
      });
      if (!r.ok) { toast(safeApiErrorMessage(r, t('adm_update_failed', 'Güncellenemedi'), { report: true }), 'error'); return; }
      await r.json().catch(() => ({}));
      currentGroup = { ...currentGroup, name: settingsName.trim(), icon: settingsIcon.trim() || undefined };
      toast(t('gdm_updated', 'Grup güncellendi'), 'success');
      activeModal = null;
      await loadGroupDmList();
    } catch (error) {
      log.warn('saveGroupDmSettings hata:', error);
      toast(t('gdm_conn_error', 'Bağlantı hatası'), 'error');
    } finally {
      saving = false;
    }
  }

  // ── Leave / delete ────────────────────────────────────────────────────────

  async function leaveGroupDm(): Promise<void> {
    if (!currentGroup) return;
    const isOwner = currentGroup.ownerId === me()?.id;
    const msg = isOwner
      ? t("ui_grubu_dagitmak_istediginizden_emin_misiniz_tum_mesaj", "Grubu dağıtmak istediğinizden emin misiniz? Tüm mesajlar silinecek.")
      : t("ui_gruptan_ayrilmak_istediginizden_emin_misiniz", "Gruptan ayrılmak istediğinizden emin misiniz?");
    if (!await confirmProductAction({ title: isOwner ? t("ui_grubu_dagit", "Grubu dağıt") : t("ui_gruptan_ayril", "Gruptan ayrıl"), message: msg, confirmLabel: isOwner ? t("ui_grubu_dagit", "Grubu dağıt") : t("voice_leave", "Ayrıl"), tone: 'danger' })) return;

    try {
      const r = isOwner
        ? await apiFetch(`${API()}/api/gdm/${currentGroup._id}`, { method: 'DELETE' })
        : await apiFetch(`${API()}/api/gdm/${currentGroup._id}/members/${me()?.id}`, { method: 'DELETE' });

      if (!r.ok) { toast(safeApiErrorMessage(r, t('adm_op_failed', 'İşlem başarısız'), { report: true }), 'error'); return; }

      currentGroup = null;
      messages = [];
      toast(isOwner ? t('gdm_disbanded', 'Grup dağıtıldı') : t('gdm_left', 'Gruptan ayrıldınız'), 'success');
      await loadGroupDmList();
    } catch (error) {
      log.warn('leaveGroupDm hata:', error);
      toast(t('gdm_conn_error', 'Bağlantı hatası'), 'error');
    }
  }

  // ── GDM Voice (group-dm-voice.ts'e yönlendir) ─────────────────────────────

  async function startGdmCall(type: 'voice' | 'video'): Promise<void> {
    if (!currentGroup) return;

    // 1. Önce BridgeRegistry'de kayıtlı fonksiyon var mı kontrol et
    const registeredFn = BridgeRegistry.get('startGdmCall') as
      ((type: string, groupId: string) => void) | undefined;
    if (registeredFn) {
      registeredFn(type, currentGroup._id);
      return;
    }

    // 2. Yoksa group-dm-voice.ts'i dynamic import ile yükle
    if (!_gdmVoiceLoaded) {
      try {
        await import('./group-dm-voice.js');
        // Modül yüklenince startGdmCall'u BridgeRegistry'e kaydetmesini bekle
        _gdmVoiceLoaded = true;
        // Kısa bekleme: module-level init tamamlansın
        await new Promise(r => setTimeout(r, 50));
        const fn = BridgeRegistry.get('startGdmCall') as
          ((type: string, groupId: string) => void) | undefined;
        if (fn) { fn(type, currentGroup._id); return; }
        // Modül BridgeRegistry kullanmıyorsa doğrudan window üzerinden dene
        const winFn = (window as Record<string, unknown>)['startGdmCall'] as
          ((type: string) => void) | undefined;
        if (winFn) { winFn(type); return; }
        // Modül yüklendi ama HİÇBİR sahip ortaya çıkmadı. Sessizce dönmek,
        // kullanıcıya düğmeye bastığı hâlde hiçbir şey olmadığını ve nedenini
        // söylemez; aşağıdaki "yüklü ama kayıt yok" dalıyla aynı dürüst hatayı
        // verir.
        toast(t('gdm_call_not_ready', 'Sesli arama modülü hazır değil'), 'error');
      } catch (err) {
        log.warn('[GroupDmPanel] group-dm-voice yüklenemedi:', err);
        toast(t('gdm_call_failed', 'Sesli arama başlatılamadı'), 'error');
      }
      return;
    }

    // 3. Yüklü ama kayıt yok — window fallback
    const winFn = (window as Record<string, unknown>)['startGdmCall'] as
      ((type: string) => void) | undefined;
    if (winFn) { winFn(type); return; }

    toast(t('gdm_call_not_ready', 'Sesli arama modülü hazır değil'), 'error');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  /**
   * FAZ E — ESCAPE İLE KATMANLI KAPANMA.
   *
   * Panelin üç modalı (create/members/settings) yalnızca fare ile — arka
   * perdeye tıklayarak — kapanabiliyordu. Kod tabanının geri kalanında
   * sözleşme Escape'tir (ServerSettingsModal.svelte:68, SettingsModal).
   * GDM canlı bir yüzeydir (C4.7), dolayısıyla bu sözleşmeye uymalıdır.
   *
   * İKİ KRİTİK DAVRANIŞ:
   *  1. `isVisible` DEĞİLSE hiçbir şey yapılmaz. Dinleyici `window` üzerinde
   *     ve panel gizliyken de MOUNT hâlinde durur; koşulsuz kapatma, başka
   *     yüzeylerin (modal, arama, menü) Escape'ini SESSİZCE YUTARDI.
   *  2. Yalnız EN ÜST katman kapatılır. Modal açıkken Escape önce modalı
   *     kapatır, paneli değil — aksi hâlde tek tuşla iki katman birden
   *     kaybolur ve kullanıcı bağlamını yitirir.
   */
  function onEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isVisible) return;
    if (activeModal !== null) { activeModal = null; return; }
    closePanel();
  }

  onMount(() => {
    void loadGroupDmList();
    window.addEventListener('keydown', onEscape);

    // FAZ C4.7 — TEK OLAY BORU HATTI.
    // Tarihsel `bridge:gdm-*` DOM köprüsü KALDIRILDI: hiçbir yayıncısı yoktu
    // (ölü boru hattı) ve doğrudan socket bağlamayla birlikte tutulsaydı
    // ikinci bir teslim yolu ve çift mesaj riski doğardı.
    syncSocketBinding();
    // Socket geç hazır olabilir veya kimlik yenilemesiyle DEĞİŞEBİLİR;
    // her iki yaşam döngüsü olayında da MEVCUT nesneye yeniden bağlanılır.
    document.addEventListener('bridge:socket-ready', onSocketLifecycle);
    document.addEventListener('bridge:socket-reconnected', onSocketLifecycle);
    document.addEventListener('bridge:auth-logout', onLogout);

    // BridgeRegistry kayıtlar
    BridgeRegistry.register('groupDmPanel:openGroupDm',   openGroupDm);
    BridgeRegistry.register('groupDmPanel:loadList',      loadGroupDmList);
    BridgeRegistry.register('groupDmPanel:getGroups',     () => groups);
    BridgeRegistry.register('groupDmPanel:getCurrentGroup', () => currentGroup);

    // Ürün açıcıları — DmPanel ile AYNI sözleşme (DmPanel.svelte:177-180).
    const openPanel = () => { closeExclusivePeers('gdm'); isVisible = true; void loadGroupDmList(); };
    BridgeRegistry.register('showGroupDmPanel',  openPanel);
    BridgeRegistry.register('openGroupDmPanel',  openPanel);
    BridgeRegistry.register('closeGroupDmPanel', closePanel);
  });

  onDestroy(() => {
    persistGdmDraft();
    clearAllPendingTimers();
    if (listRefreshTimer) { clearTimeout(listRefreshTimer); listRefreshTimer = null; }
    // Bağlı olduğumuz NESNEDEN çözülür — `socket()` bu anda başka bir nesne
    // döndürebilir. Aynı (olay, callback referansı) çifti kullanılır;
    // `removeAllListeners()` KULLANILMAZ (paylaşılan soket mimarisinde başka
    // sahiplerin dinleyicilerini de silerdi).
    unbindSocket();
    window.removeEventListener('keydown', onEscape);
    document.removeEventListener('bridge:socket-ready', onSocketLifecycle);
    document.removeEventListener('bridge:socket-reconnected', onSocketLifecycle);
    document.removeEventListener('bridge:auth-logout', onLogout);
    BridgeRegistry.unregister?.('showGroupDmPanel');
    BridgeRegistry.unregister?.('openGroupDmPanel');
    BridgeRegistry.unregister?.('closeGroupDmPanel');
    BridgeRegistry.unregister?.('groupDmPanel:openGroupDm');
    BridgeRegistry.unregister?.('groupDmPanel:loadList');
    BridgeRegistry.unregister?.('groupDmPanel:getGroups');
    BridgeRegistry.unregister?.('groupDmPanel:getCurrentGroup');
  });

  function messageTime(msg: GdmMessage): string {
    // Final21 Faz 19 (19-27): PostgreSQL BIGINT metin gelebilir; new Date("1790…") = Invalid Date.
    return new Date(Number(msg.createdAt)).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

{#if isVisible}
<div id="gdm-panel" class="gdm-panel" class:conversation-open={Boolean(currentGroup)} role="dialog" aria-modal="true" aria-label={t('attr_grup_direkt_mesajlar_0a71c94', "Grup direkt mesajlar")} use:focusTrap={{ active: isVisible, initialFocus: ".gdm-sidebar-header button" }}>

  <!-- Sol: Grup listesi ────────────────────────────────────────────────── -->
  <div class="gdm-sidebar">
    <div class="gdm-sidebar-header">
      <span class="gdm-sidebar-title">{t('markup_grup_dm_5e6f8be', "💬 Grup DM")}</span>
      <button class="btn btn-sm" onclick={() => (activeModal = 'create')} title={t('attr_yeni_grup_2e02cf5', "Yeni Grup")}>+</button>
      <button class="btn btn-sm" onclick={requestClose} title={t('close')} aria-label={t('gdm_close', 'Grup DM panelini kapat')}>✕</button>
    </div>

    {#if loading}
      <div class="gdm-loading">{t('gdm_loading', 'Yükleniyor…')}</div>
    {:else if listError}
      <div class="gdm-empty" role="alert">{t('gdm_list_failed', 'Grup DM listesi yüklenemedi.')}</div>
    {:else if groups.length === 0}
      <div class="gdm-empty">
        {t('markup_grup_dm_yok_e8e39ab', "Grup DM yok.")}
        <button class="btn-link" onclick={() => (activeModal = 'create')}>{t('gdm_create', 'Oluştur →')}</button>
      </div>
    {:else}
      <div id="gdm-list" class="gdm-list">
        {#each groups as g (g._id)}
          {@const isActive = currentGroup?._id === g._id}
          <!-- FAZ E — `role="button"` HEM Enter HEM Space ile etkinleşmeli.
               Yalnız Enter vardı; Space odaklı div'de sayfayı KAYDIRIYORDU
               (aktif olarak yanlış davranış). Kanonik biçim
               ChannelItem.svelte:39-45 ile aynıdır: preventDefault + ikisi. -->
          <div
            class="gdm-item"
            class:active={isActive}
            data-gid={g._id}
            role="button"
            tabindex="0"
            onclick={() => openGroupDm(g)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openGroupDm(g); }
            }}
          >
            <div class="gdm-item-icon">{g.icon ?? '👥'}</div>
            <div class="gdm-item-body">
              <div class="gdm-item-name">{g.name}</div>
              <div class="gdm-item-preview">
                {#if g.lastMessage?.content}
                  {g.lastMessage.content.slice(0, 40)}
                {:else}
                  <span class="muted">{t('gdm_no_messages', 'Henüz mesaj yok')}</span>
                {/if}
              </div>
            </div>
            {#if (g.unreadCount ?? 0) > 0}
              <span class="gdm-unread" aria-label={t('unread_messages_aria', undefined, { count: g.unreadCount ?? 0 })}>
                {(g.unreadCount ?? 0) > 99 ? '99+' : g.unreadCount}
              </span>
            {/if}
            <div class="gdm-item-count muted">{t("ui_member_count", undefined, { count: g.memberCount ?? 0 })}</div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Sağ: Sohbet alanı ───────────────────────────────────────────────── -->
  <div class="gdm-chat">
    {#if !currentGroup}
      <div class="gdm-placeholder">{t('gdm_pick_group', '← Bir grup seç veya')} <button class="btn-link" onclick={() => (activeModal = 'create')}>{t('gdm_create_new', 'yeni oluştur')}</button></div>
    {:else}
      <!-- Header -->
      <div id="dm-chat-header" class="gdm-header">
        <button type="button" class="gdm-mobile-back" aria-label={t("nav_back_group_dm_list")} onclick={backToGroupList}>←</button>
        <span class="gdm-header-icon">{currentGroup.icon ?? '👥'}</span>
        <span class="gdm-header-name">{currentGroup.name}</span>
        <span class="gdm-header-count muted">{t("ui_member_count", undefined, { count: currentGroup.memberCount ?? currentGroup.members?.length ?? 0 })}</span>
        <div class="gdm-header-actions">
          <button class="btn btn-sm gdm-call-btn" title={t('attr_sesli_arama_69f71ea', "Sesli Arama")} onclick={() => startGdmCall('voice')}>🎙️</button>
          <button class="btn btn-sm gdm-call-btn" title={t('gdm_video_call', 'Görüntülü Arama')} onclick={() => startGdmCall('video')}>📹</button>
          <button class="btn btn-sm" title={t('attr_grup_bilgisi_886cb08', "Grup Bilgisi")} onclick={() => (activeModal = 'info')}>ℹ️</button>
          {#if currentGroup.ownerId === me()?.id}
            <button class="btn btn-sm" title={t('settings')} onclick={openSettings}>⚙️</button>
          {/if}
          <button class="btn btn-sm btn-danger" title={currentGroup.ownerId === me()?.id ? t("surface_grubu_dag_t_90f3ef") : t("surface_gruptan_ayr_l_a29354")} onclick={leaveGroupDm}>🚪</button>
        </div>
      </div>

      <!-- Mesajlar -->
      <div id="gdm-messages" class="gdm-messages" onscroll={onMessagesScroll}>
        {#if msgLoading}
          <div class="gdm-loading">{t('gdm_messages_loading', 'Mesajlar yükleniyor…')}</div>
        {:else}
          {#if hasOlder}
            <button type="button" class="gdm-load-older" onclick={() => void loadOlder()} disabled={loadingOlder}>
              {loadingOlder ? t('sso_loading', 'Yükleniyor…') : t('dm_load_older', 'Daha eski mesajları yükle')}
            </button>
          {/if}
          {#each messages as msg (msg._key)}
            {#if msg.type === 'system'}
              <div class="gdm-system-msg">{msg.content}</div>
            {:else}
              {@const isOwn = msg.userId === me()?.id}
              <div class="dm-msg" class:dm-own={isOwn} class:pending={msg.pending} class:failed={msg.failed} data-id={msg._id}>
                <div class="dm-msg-avatar" style={avatarStyleFromResolved(cssColor(msg.avatarColor))}>
                  {initials(msg.displayName)}
                </div>
                <div class="dm-msg-body">
                  <div class="dm-msg-header">
                    <span class="dm-msg-name">{msg.displayName}</span>
                    <span class="dm-msg-time">{messageTime(msg)}</span>
                  </div>
                  <!--
                    FAZ C4 — CANLI XSS KAPATILDI.

                    Buradaki eski satır şuydu:
                        {@html formatText(msg.content)}
                    `formatText` BridgeRegistry'den bir biçimlendirici çözmeye
                    çalışıyor, bulamazsa girdiyi AYNEN döndürüyordu (`?? s`).
                    Kayıt sayısı SIFIRDI — yani fiilen birim fonksiyondu ve
                    saldırgan denetimindeki mesaj içeriği doğrudan innerHTML'e
                    yazılıyordu. Grup DM'deki herhangi bir katılımcı diğer tüm
                    katılımcıların tarayıcısında betik çalıştırabilirdi.

                    Biçimlendirici hiç kayıtlı olmadığı için metin
                    enterpolasyonuna geçmek HİÇBİR özelliği kaybettirmez:
                    aynı karakterler artık HTML değil METİN olarak basılır.
                    Kanonik güvenli render mimarisi MessageRenderer.svelte'tir
                    ve o da tam olarak bunu yapar ({@html kullanmaz).
                  -->
                  <div class="dm-msg-text">{msg.content}</div>
                  {#if msg.pending}
                    <small class="gdm-send-state">{t('dm_sending', 'Gönderiliyor…')}</small>
                  {:else if msg.failed}
                    <small class="gdm-send-state failed" role="alert">{msg.lastError || t('dm_send_failed', 'Gönderilemedi.')}</small>
                    <button type="button" class="gdm-retry" onclick={() => retryGroupMessage(msg)}>{t('retry', 'Yeniden dene')}</button>
                  {/if}
                </div>
                {#if msg._id && !msg.pending && !msg.failed}<button type="button" class="dm-msg-save" aria-label={t('msg_action_save')} title={t('msg_action_save')} onclick={() => saveForLater(msg)}>⌑</button>{/if}
              </div>
            {/if}
          {/each}
        {/if}
      </div>

      <!-- Input -->
      <div id="dm-input-area" class="gdm-input-area">
        <input
          type="text"
          id="dm-input"
          class="gdm-input"
          placeholder={t('gdm_msg_placeholder', '{group} grubuna mesaj gönder…', { group: currentGroup.name })}
          maxlength="2000"
          bind:value={inputValue}
          oninput={(e) => persistGdmDraft(e.currentTarget.value)}
          onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && sendGroupDm()}
        />
        <button class="btn btn-primary" onclick={sendGroupDm}>{t('gdm_send', 'Gönder')}</button>
      </div>
    {/if}
  </div>
</div>

<!-- ── Create Modal ───────────────────────────────────────────────────── -->
{#if activeModal === 'create'}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-overlay" role="dialog" aria-modal="true" tabindex="-1" use:focusTrap
    onclick={(e) => e.target === e.currentTarget && (activeModal = null)}>
    <div class="modal-card" style="max-width:420px;width:95%">
      <h2>{t('markup_yeni_grup_dm_eb903d3', "👥 Yeni Grup DM")}</h2>
      <div class="form-group">
        <label for="gdm-name-input">{t('gdm_group_name', 'Grup Adı')}</label>
        <input id="gdm-name-input" type="text" class="input-field" placeholder={t('gdm_friends_ph', 'Arkadaşlarım…')} maxlength="64" bind:value={createName} />
      </div>
      <div class="form-group">
        <label for="gdm-icon-input">{t('markup_emoji_opsiyonel_805929a', "Emoji (opsiyonel)")}</label>
        <input id="gdm-icon-input" type="text" class="input-field" placeholder="👥" maxlength="4" style="width:80px" bind:value={createIcon} />
      </div>
      <div class="form-group">
        <label for="gdm-members-input">{t('gdm_members_hint', 'Üyeler (kullanıcı adı, virgülle ayır)')}</label>
        <input id="gdm-members-input" type="text" class="input-field" placeholder={t('attr_ali_veli_6a530cd', "ali, veli, …")} bind:value={createMembers} />
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" disabled={creating} onclick={createGroupDm}>
          {creating ? t("surface_olusturuluyor_8d7aee") : t("create")}
        </button>
        <button class="btn" onclick={() => (activeModal = null)}>{t('gdm_cancel', 'İptal')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Info Modal ─────────────────────────────────────────────────────── -->
{#if activeModal === 'info' && currentGroup}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-overlay" role="dialog" aria-modal="true" tabindex="-1" use:focusTrap
    onclick={(e) => e.target === e.currentTarget && (activeModal = null)}>
    <div class="modal-card" style="max-width:360px;width:95%">
      <h2>{currentGroup.icon ?? '👥'} {currentGroup.name}</h2>
      <p class="muted" style="font-size:13px">
        {t("ui_group_member_count_suffix", undefined, { count: currentGroup.members?.length ?? 0 })}
        {currentGroup.ownerId === me()?.id ? 'Sen sahipsin' : t("surface_uyesin_ce8f81")}
      </p>

      <div class="gdm-member-list">
        {#each currentGroup.members ?? [] as member (member._id ?? member.id)}
          {@const memberId = member._id ?? member.id ?? ''}
          <div class="gdm-member-row">
            <div class="gdm-member-avatar" style={avatarStyleFromResolved(cssColor(member.avatarColor))}>
              {initials(member.displayName)}
            </div>
            <span class="gdm-member-name">{member.displayName}</span>
            {#if memberId === currentGroup.ownerId}
              <span class="gdm-owner-badge">{t('markup_sahip_fca30b8', "Sahip")}</span>
            {:else if currentGroup.ownerId === me()?.id}
              <button class="btn btn-sm btn-danger" onclick={() => kickGroupDmMember(memberId, member.displayName)}>{t('gdm_remove', 'Çıkar')}</button>
            {/if}
          </div>
        {/each}
      </div>

      {#if currentGroup.ownerId === me()?.id}
        <div style="margin-top:8px">
          <input type="text" id="gdm-add-member" class="input-field" placeholder={t('gdm_add_username_ph', 'Kullanıcı adı ekle…')} style="width:100%;margin-bottom:6px" bind:value={addMemberInput} />
          <button class="btn btn-primary" style="width:100%" onclick={addGroupDmMember}>{t('gdm_add_member', '+ Üye Ekle')}</button>
        </div>
      {/if}

      <div class="modal-footer">
        <button class="btn" onclick={() => (activeModal = null)}>{t('close')}</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Settings Modal ─────────────────────────────────────────────────── -->
{#if activeModal === 'settings' && currentGroup}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-overlay" role="dialog" aria-modal="true" tabindex="-1" use:focusTrap
    onclick={(e) => e.target === e.currentTarget && (activeModal = null)}>
    <div class="modal-card" style="max-width:380px;width:95%">
      <h2>{t('gdm_settings', '⚙️ Grup Ayarları')}</h2>
      <div class="form-group">
        <label for="gdm-settings-name">{t('gdm_group_name', 'Grup Adı')}</label>
        <input id="gdm-settings-name" type="text" class="input-field" maxlength="64" bind:value={settingsName} />
      </div>
      <div class="form-group">
        <label for="gdm-settings-icon">{t('emoji')}</label>
        <input id="gdm-settings-icon" type="text" class="input-field" maxlength="4" style="width:80px" bind:value={settingsIcon} />
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" disabled={saving} onclick={saveGroupDmSettings}>
          {saving ? t('ui_saving') : t('save')}
        </button>
        <button class="btn" onclick={() => (activeModal = null)}>{t('gdm_cancel', 'İptal')}</button>
      </div>
    </div>
  </div>
{/if}
{/if}

<style>
  /* DmPanel ile aynı sözleşme: görünür alanı kaplayan modal örtü. Konumlandırma
     yoktu; `height: 100%` yüksekliksiz `#gdm-root`a göre çözülüp içerikle
     büyüyordu ve panel kabuğun ALTINA, belge akışına düşüyordu (1280×720'de
     y=625'ten başlayıp 1109px — konuşmanın çoğu ve yazma alanı ekran dışında). */
  .gdm-panel {
    position: fixed;
    inset: 0;
    z-index: 1200;
    display: flex;
    height: 100%;
    background: var(--bg-2);
    color: var(--text);
  }

  /* Sidebar */
  .gdm-sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    background: var(--bg-1);
  }
  .gdm-sidebar-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border);
    font-size: 13px;
    font-weight: 700;
  }
  .gdm-sidebar-title { flex: 1; }
  .gdm-list { overflow-y: auto; flex: 1; }
  .gdm-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background .1s;
    border-radius: 4px;
    margin: 2px 4px;
  }
  .gdm-item:hover, .gdm-item.active { background: var(--bg-hover); }
  .gdm-item-icon { font-size: 18px; flex-shrink: 0; }
  .gdm-item-body { flex: 1; min-width: 0; }
  .gdm-item-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gdm-item-preview { font-size: 11px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gdm-unread { display: grid; place-items: center; min-width: 20px; height: 20px; padding: 0 6px; color: var(--text-on-solid); font-size: var(--type-badge); font-weight: 700; background: var(--brand); border-radius: var(--radius-pill); }
  .gdm-item-count { font-size: 10px; flex-shrink: 0; }
  .gdm-loading { padding: 16px; text-align: center; color: var(--text-muted); font-size: 13px; }
  .gdm-empty { padding: 16px 12px; color: var(--text-muted); font-size: 13px; }

  /* Chat */
  .gdm-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
  }
  .gdm-placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 14px;
  }
  .gdm-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border);
    background: var(--bg-2);
  }
  .gdm-header-icon { font-size: 18px; }
  .gdm-header-name { font-weight: 700; font-size: 15px; }
  .gdm-header-count { font-size: 12px; }
  .gdm-header-actions { margin-left: auto; display: flex; gap: 6px; }
  .gdm-messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
  .gdm-load-older { align-self: center; margin-bottom: 8px; border: 1px solid var(--border-subtle); border-radius: var(--radius-control); background: var(--surface-2); color: var(--text-primary); padding: 6px 12px; cursor: pointer; font: inherit; font-size: 12px; }
  .gdm-load-older:hover, .gdm-load-older:focus-visible { background: var(--surface-hover); }
  .gdm-load-older:disabled { opacity: .6; cursor: default; }
  .gdm-system-msg { text-align: center; color: var(--text-muted); font-size: 12px; font-style: italic; padding: 4px 0; }
  .gdm-input-area { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border); }
  .gdm-input { flex: 1; background: var(--bg-3); border: none; border-radius: 4px; padding: 8px 12px; color: var(--text); font-size: 14px; }
  .gdm-input:focus { outline: 2px solid var(--brand); }
  /* auth.css'in genel `.btn-primary { width: 100% }` kuralı (giriş formu için)
     buraya sızıyordu: düğme 815px, yazma alanı 205px oluyordu. */
  .gdm-input-area .btn { flex: none; width: auto; }

  /* Messages */
  .dm-msg { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; }
  :global(.dm-msg.dm-msg-highlight) { padding: 5px; border-radius: 8px; background: var(--brand-subtle); }
  .dm-msg-save { width: 30px; height: 30px; flex: none; border: 0; border-radius: 7px; background: transparent; color: var(--text-muted); cursor: pointer; }
  .dm-msg-save:hover, .dm-msg-save:focus-visible { background: var(--surface-hover); color: var(--text-primary); }
  .dm-msg.pending { opacity: .65; }
  .dm-msg.failed { opacity: .9; }
  .gdm-send-state { display: block; margin-top: 3px; font-size: 11px; color: var(--text-muted); }
  .gdm-send-state.failed { color: var(--danger); }
  .gdm-retry { border: 0; background: transparent; color: var(--brand); padding: 0; font: inherit; font-size: 11px; cursor: pointer; }
  .gdm-retry:hover, .gdm-retry:focus-visible { text-decoration: underline; }
  .dm-msg.dm-own { flex-direction: row-reverse; }
  .dm-msg-avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: var(--text-on-solid); flex-shrink: 0; }
  .dm-msg-body { max-width: 70%; }
  .dm-msg-header { display: flex; gap: 6px; align-items: baseline; margin-bottom: 2px; }
  .dm-msg-name { font-size: 12px; font-weight: 700; }
  .dm-msg-time { font-size: 10px; color: var(--text-muted); }
  .dm-msg-text { font-size: 14px; word-break: break-word; }

  /* Member list in info modal */
  .gdm-member-list { max-height: 240px; overflow-y: auto; margin: 12px 0; }
  .gdm-member-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border); }
  .gdm-member-avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: var(--text-on-solid); flex-shrink: 0; }
  .gdm-member-name { flex: 1; font-size: 14px; }
  .gdm-owner-badge { font-size: 11px; background: var(--brand); color: var(--text-on-solid); border-radius: 3px; padding: 1px 5px; margin-left: auto; }

  /* Modals */
  .modal-overlay { position: fixed; inset: 0; z-index: 2000; background: color-mix(in srgb, var(--bg-0) 82%, transparent); display: flex; align-items: center; justify-content: center; }
  .modal-card { background: var(--bg-2); border-radius: 8px; padding: 20px; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--text-muted); text-transform: uppercase; }
  .input-field { width: 100%; background: var(--bg-3); border: 1px solid var(--border); border-radius: 4px; padding: 8px 10px; color: var(--text); font-size: 14px; box-sizing: border-box; }
  .modal-footer { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }

  /* Misc */
  .muted { color: var(--text-muted); }
  .btn-link { background: none; border: none; color: var(--brand); cursor: pointer; font-size: 13px; padding: 0; }
  .btn-link:hover { text-decoration: underline; }
  .btn { background: var(--bg-3); border: none; border-radius: 4px; padding: 6px 12px; color: var(--text); cursor: pointer; font-size: 13px; }
  .btn:hover { background: var(--bg-hover); }
  .btn:disabled { opacity: .6; cursor: not-allowed; }
  .btn-primary { background: var(--brand); color: var(--text-on-solid); }
  .btn-primary:hover { background: var(--brand-hover); }
  .btn-danger { background: var(--danger); color: var(--text-on-solid); }
  .btn-sm { padding: 3px 8px; font-size: 12px; }


  .gdm-mobile-back { display: none; }

  @media (max-width: 700px) {
    .gdm-panel { height: var(--bridge-visual-viewport-height, 100dvh); padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
    .gdm-sidebar { width: 100%; border-right: 0; }
    .gdm-chat { display: none; min-height: 0; }
    .gdm-panel.conversation-open .gdm-sidebar { display: none; }
    .gdm-panel.conversation-open .gdm-chat { display: flex; }
    .gdm-mobile-back { display: grid; place-items: center; width: 40px; height: 40px; flex: none; border: 0; border-radius: var(--radius-control); background: transparent; color: var(--text-primary); font-size: 21px; cursor: pointer; }
    .gdm-mobile-back:hover, .gdm-mobile-back:focus-visible { background: var(--surface-hover); }
    .gdm-header { min-height: 56px; padding: 8px 10px; }
    .gdm-header-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gdm-header-count { display: none; }
    .gdm-header-actions { gap: 3px; }
    .gdm-header-actions .btn { min-width: 40px; min-height: 40px; padding: 0; }
    .gdm-messages { padding: 10px; overscroll-behavior: contain; }
    .dm-msg-body { max-width: min(82%, 520px); }
    .gdm-input-area { padding: 10px calc(10px + env(safe-area-inset-right)) calc(10px + env(safe-area-inset-bottom)) calc(10px + env(safe-area-inset-left)); }
    .gdm-input, .gdm-input-area .btn { min-height: 44px; }
    .modal-overlay { align-items: flex-end; padding-top: env(safe-area-inset-top); }
    .modal-card { width: 100%; max-height: 82dvh; overflow: auto; border-radius: var(--radius-modal) var(--radius-modal) 0 0; padding-bottom: calc(20px + env(safe-area-inset-bottom)); }
  }

</style>
