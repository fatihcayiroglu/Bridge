<!-- client/js/core/DraftManager.svelte -->
<!-- Sprint 116 stub → Faz 8.2: gerçek taslak yönetimi -->
<!--
  Faz 8.2 (feature recovery): Kanal başına mesaj taslakları.

  KAYBOLAN DAVRANIŞ: Bu bileşen `show/hide` kaydından ibaret boş bir kabuktu;
  hiç storage, hiç kaydetme, hiç geri yükleme yoktu. Kullanıcı kanal
  değiştirince yazdığı yarım mesaj sessizce kayboluyordu.

  SORUMLULUK SINIRI (yeni paralel state framework YOK):
    - draft-store.ts        → saf kalıcılık (anahtar, IO, sınırlar, hata toleransı)
    - DraftManager.svelte   → ZAMANLAMA (debounce/flush) + registry sözleşmesi
    - MessageInputPanel     → #msg-input textarea'sının TEK sahibi

  Bu bileşen DOM'a dokunmaz; textarea'yı okumaz/yazmaz.

  KİMLİK: taslak anahtarı kullanıcı + konuşma türü + konuşma id'sinden üretilir.
  Kullanıcı kimliği AppState'ten (`getMe`) gelir — auth-compat.ts artık
  `setMe` çağırıyor (Faz 8.2'de kapatılan boşluk).
-->
<script lang="ts">
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import {
    draftKey,
    type ConversationKind, type DraftIdentity,
  } from './draft-store.js';
  import {
    clearLocalFirstDraft,
    closeLocalFirstDraftRuntime,
    hydrateLocalFirstDraft,
    peekLocalFirstDraft,
    persistLocalFirstDraft,
    persistLocalFirstDraftText,
  } from './local-first/draft-runtime.ts';

  const log = createLogger('DraftManager');

  let { children }: { children?: Snippet } = $props();

  /**
   * Her tuş vuruşunda senkron localStorage yazmamak için bekleme.
   * Kısa tutuluyor: kanal değişimi zaten flush ediyor, ama sekme çökmesi
   * gibi flush'sız senaryolarda kaybı 400ms ile sınırlıyor.
   */
  const DEBOUNCE_MS = 400;

  /** Bekleyen yazma — anahtar KURULUM anında dondurulur (bkz. scheduleWrite). */
  let pending: { identity: DraftIdentity; text: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const hydrationStarted = new Set<string>();
  let lastAuthenticatedUserId = '';

  // ── Kimlik çözümleme ───────────────────────────────────────────────────────

  function currentUserId(): string | null {
    const me = BridgeRegistry.get<() => { _id?: string; id?: string } | null>('getMe')?.();
    const userId = me?._id ?? me?.id ?? null;
    if (userId) lastAuthenticatedUserId = userId;
    return userId;
  }

  /** Kanal tipinden konuşma türü. DM'ler ayrı anahtar alanına düşer. */
  function kindOf(channel: { type?: string } | null): ConversationKind {
    const type = String(channel?.type ?? 'text').toLowerCase();
    if (type === 'group-dm' || type === 'group_dm' || type === 'gdm') return 'gdm';
    return type === 'dm' ? 'dm' : 'channel';
  }

  /** Şu anki konuşmanın taslak kimliği; oturum veya kanal yoksa `null`. */
  function currentIdentity(): DraftIdentity | null {
    const userId = currentUserId();
    if (!userId) return null;
    const channel = BridgeRegistry.get<() => { _id?: string; type?: string; serverId?: string } | null>('getCurrentChannel')?.();
    if (!channel?._id) return null;
    const kind = kindOf(channel);
    const serverId = kind === 'channel'
      ? channel.serverId ?? BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer')?._id
      : undefined;
    if (kind === 'channel' && !serverId) return null;
    return { userId, kind, conversationId: channel._id, ...(serverId ? { serverId } : {}) };
  }

  function sameIdentity(a: DraftIdentity, b: DraftIdentity): boolean {
    return draftKey(a) === draftKey(b);
  }

  function ensureHydrated(identity: DraftIdentity): void {
    const key = draftKey(identity);
    if (!key || hydrationStarted.has(key)) return;
    hydrationStarted.add(key);

    void hydrateLocalFirstDraft(identity).then(snapshot => {
      document.dispatchEvent(new CustomEvent('bridge:draft-hydrated', {
        detail: {
          userId: identity.userId,
          kind: identity.kind,
          conversationId: identity.conversationId,
          serverId: identity.serverId,
          text: snapshot?.text ?? '',
          attachmentPending: snapshot?.attachmentPending === true,
        },
      }));
    }).catch(error => {
      hydrationStarted.delete(key);
      log.warn('Şifreli taslak hydrate edilemedi', error);
    });
  }

  // ── Yazma zamanlaması ──────────────────────────────────────────────────────

  /** Bekleyen yazmayı ŞİMDİ diske indirir. */
  function flush(): void {
    if (timer) { clearTimeout(timer); timer = null; }
    if (!pending) return;
    const { identity, text } = pending;
    pending = null;
    const attachmentPending = peekLocalFirstDraft(identity)?.attachmentPending === true;
    persistLocalFirstDraft(identity, text, attachmentPending);
  }

  /**
   * Yazmayı geciktirir. Kimlik ÇAĞRI ANINDA çözülüp saklanır: kullanıcı
   * bekleme dolmadan kanal değiştirirse metin ESKİ kanala yazılır, yenisinin
   * taslağını ezmez.
   */
  function scheduleWrite(text: string): void {
    const identity = currentIdentity();
    if (!identity) return;

    // Farklı bir konuşmaya ait bekleyen yazma varsa önce onu indir.
    if (pending && !sameIdentity(pending.identity, identity)) flush();

    pending = { identity, text };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; flush(); }, DEBOUNCE_MS);
  }

  // ── Registry sözleşmesi (minimal) ──────────────────────────────────────────

  /** Şu anki konuşmanın taslağını döndürür. */
  function getDraft(): string {
    const identity = currentIdentity();
    if (!identity) return '';
    // Bekleyen yazma varsa depodan değil ondan oku — yeni yazılan metin
    // debounce penceresi içinde kanal değişse bile kaybolmasın.
    if (pending && sameIdentity(pending.identity, identity)) return pending.text;
    ensureHydrated(identity);
    return peekLocalFirstDraft(identity)?.text ?? '';
  }

  /** Taslağı günceller (debounce'lu). Boş metin taslağı siler. */
  function setDraft(text: string): void {
    scheduleWrite(typeof text === 'string' ? text : '');
  }

  /**
   * Taslağı siler.
   *
   * @param conversationId - Hedef konuşma. Verilmezse şu anki konuşma.
   *   Başarılı gönderim ACK'i geldiğinde kullanıcı başka kanala geçmiş
   *   olabilir; bu yüzden çağıran GÖNDERİM ANINDAKİ kanalı iletir ve yanlış
   *   kanalın taslağı silinmez.
   * @param kind - Konuşma türü (kanal/DM). Verilmezse mevcut kanaldan çıkarılır.
   */
  function clearDraft(conversationId?: string, kind?: ConversationKind, serverId?: string): void {
    const userId = currentUserId();
    if (!userId) return;

    const current = currentIdentity();
    const target: DraftIdentity | null = conversationId
      ? {
          userId,
          kind: kind ?? (current?.conversationId === conversationId ? current.kind : 'channel'),
          conversationId,
          ...((kind ?? current?.kind) === 'channel'
            ? { serverId: serverId ?? (current?.conversationId === conversationId ? current.serverId : undefined) }
            : {}),
        }
      : current;
    if (!target || !draftKey(target)) return;

    if (pending && sameIdentity(pending.identity, target)) {
      pending = null;
      if (timer) { clearTimeout(timer); timer = null; }
    }
    clearLocalFirstDraft(target);
  }

  function getDraftAttachmentPending(): boolean {
    const identity = currentIdentity();
    if (!identity) return false;
    ensureHydrated(identity);
    return peekLocalFirstDraft(identity)?.attachmentPending === true;
  }

  function setDraftAttachmentPending(value: boolean): void {
    const identity = currentIdentity();
    if (!identity) return;

    const text = pending && sameIdentity(pending.identity, identity)
      ? pending.text
      : (peekLocalFirstDraft(identity)?.text ?? '');
    persistLocalFirstDraft(identity, text, value === true);
  }

  // ── Oturum değişimi ────────────────────────────────────────────────────────

  /**
   * Çıkışta bekleyen yazma İPTAL edilir. Aksi halde debounce penceresi
   * içindeki metin, çıkış sonrası hâlâ eski kullanıcının anahtarına yazılırdı.
   * Depodaki taslaklar silinmez — kullanıcı geri girdiğinde kendi taslağını
   * bulur; anahtar kullanıcı bazlı olduğu için başkasına görünmez.
   */
  function onLogout(): void {
    pending = null;
    if (timer) { clearTimeout(timer); timer = null; }
    hydrationStarted.clear();
    if (lastAuthenticatedUserId) closeLocalFirstDraftRuntime(lastAuthenticatedUserId);
    lastAuthenticatedUserId = '';
    log.info('Oturum kapandı — bekleyen taslak yazması iptal edildi ve local-first runtime kapatıldı');
  }

  onMount(() => {
    BridgeRegistry.register('getDraft', getDraft);
    BridgeRegistry.register('setDraft', setDraft);
    BridgeRegistry.register('clearDraft', clearDraft);
    BridgeRegistry.register('flushDraft', flush);
    BridgeRegistry.register('getDraftAttachmentPending', getDraftAttachmentPending);
    BridgeRegistry.register('setDraftAttachmentPending', setDraftAttachmentPending);
    document.addEventListener('bridge:auth-logout', onLogout);
    log.info('Taslak yöneticisi hazır');
  });

  onDestroy(() => {
    // Bileşen yok edilirken bekleyen metin diske indirilir — kayıp olmasın.
    flush();
    document.removeEventListener('bridge:auth-logout', onLogout);
    BridgeRegistry.unregister('getDraft');
    BridgeRegistry.unregister('setDraft');
    BridgeRegistry.unregister('clearDraft');
    BridgeRegistry.unregister('flushDraft');
    BridgeRegistry.unregister('getDraftAttachmentPending');
    BridgeRegistry.unregister('setDraftAttachmentPending');
  });
</script>

{@render children?.()}
