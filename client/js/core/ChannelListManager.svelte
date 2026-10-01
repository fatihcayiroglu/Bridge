<!-- client/js/core/ChannelListManager.svelte -->
<!-- Sprint 116 — channel-list.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Kanal listesi ve kategori ağacı -->
<!--
  Faz 3 (toparlama): Kanal listesinin controller'ı.

  View YENİDEN YAZILMADI — mevcut hazır bileşenler kullanılıyor:
    core/channel-list/channel-list-svelte.ts  mountOrUpdateChannelList(listEl, props)
    core/channel-list/ChannelList.svelte      kategori gruplama + collapse
    core/channel-list/ChannelItem.svelte      kanal satırı + context menu düğmesi

  Legacy karşılıkları (yalnızca davranış referansı, kod import edilmedi):
    historical channel-list implementation (removed):55-63   loadChannels()
    historical channel-list implementation (removed):65-96   renderChannels()
    historical channel-list implementation (removed):99-161  selectChannel()

  Kapsam sınırı: mesaj yükleme/gönderme Faz 4'e ait. Kanal seçildiğinde
  yalnızca AppState güncellenir ve mevcut `bridge:channel-selected`
  sözleşmesi yayılır (js/mobile.ts:190 zaten bunu dinliyor).
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { getAPI } from './globals.js';
  import { readToken } from './auth-compat.js';
  import { mountOrUpdateChannelList, unmountChannelList } from './channel-list/channel-list-svelte.js';
  import { apiFetch } from './api-fetch.js';
  import { activeChannelSurvives, decideAccessReaction, type AccessEvent } from './channel-list/access-revocation.ts';
  const log = createLogger('ChannelListManager');

  let { children }: { children?: Snippet } = $props();

  interface Channel {
    _id: string;
    name: string;
    type?: string;
    topic?: string;
    category?: string;
    categoryId?: string | null;
    position?: number;
    [key: string]: unknown;
  }
  interface Category { _id: string; name: string; position: number; collapsed?: boolean; [key: string]: unknown }
  interface ServerSummary { _id: string; name?: string; iconUrl?: string | null; [key: string]: unknown }
  interface PendingNavigation {
    serverId: string;
    channelId: string;
    messageId?: string;
    resolve: (success: boolean) => void;
    timeoutId: ReturnType<typeof setTimeout>;
  }

  const COLLAPSED_KEY = 'bridge_collapsed_cats'; // legacy globals.ts:115 ile aynı anahtar

  let viewHost: HTMLDivElement | null = null;
  let isLoading = $state(false);
  let loadError = $state('');

  // İmperatif state (view'a prop olarak geçiliyor, template'te kullanılmıyor)
  let channels: Channel[] = [];
  let categories: Category[] = [];
  let serverId: string | null = null;
  let activeChannelId: string | null = null;
  let requestSeq = 0;
  let pendingNavigation: PendingNavigation | null = null;
  let destroyed = false;
  const collapsed = new Set<string>(readCollapsed());

  function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.trim().length > 0;
  }

  function safeGroupKey(value: unknown): value is string {
    return nonEmptyString(value)
      && value !== '__proto__'
      && value !== 'prototype'
      && value !== 'constructor';
  }

  function sanitizeChannel(value: unknown): Channel | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (!nonEmptyString(raw._id) || !nonEmptyString(raw.name)) return null;
    const channel = {
      ...raw,
      _id: raw._id,
      name: raw.name,
    } as Channel;
    if (typeof raw.type !== 'string') delete channel.type;
    if (typeof raw.topic !== 'string') delete channel.topic;
    if (!safeGroupKey(raw.category)) delete channel.category;
    if (raw.categoryId !== null && !safeGroupKey(raw.categoryId)) delete channel.categoryId;
    if (typeof raw.position !== 'number' || !Number.isFinite(raw.position)) delete channel.position;
    return channel;
  }

  function sanitizeChannels(value: unknown): Channel[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: Channel[] = [];
    for (const candidate of value) {
      const channel = sanitizeChannel(candidate);
      if (!channel || seen.has(channel._id)) continue;
      seen.add(channel._id);
      result.push(channel);
    }
    return result;
  }

  function sanitizeCategories(value: unknown): Category[] {
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    const result: Category[] = [];
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object') continue;
      const raw = candidate as Record<string, unknown>;
      if (!safeGroupKey(raw._id) || !nonEmptyString(raw.name) || seen.has(raw._id)) continue;
      seen.add(raw._id);
      result.push({
        ...raw,
        _id: raw._id,
        name: raw.name,
        position: typeof raw.position === 'number' && Number.isFinite(raw.position) ? raw.position : 0,
        collapsed: typeof raw.collapsed === 'boolean' ? raw.collapsed : undefined,
      });
    }
    return result;
  }

  function finishPendingNavigation(intent: PendingNavigation, success: boolean): void {
    clearTimeout(intent.timeoutId);
    if (pendingNavigation === intent) pendingNavigation = null;
    intent.resolve(success);
  }

  function readCollapsed(): string[] {
    try {
      const parsed = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]') as unknown;
      return Array.isArray(parsed) ? parsed.filter(safeGroupKey) : [];
    }
    catch { return []; }
  }
  function persistCollapsed(): void {
    try { localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed])); } catch { /* depolama kapalı */ }
  }

  function channelIconKind(type?: string): string {
    // ChannelItem.svelte ile aynı güvenli, kapalı eşleme. Başlıktaki SVG
    // grubu data attribute üzerinden seçilir; ürün ikonu olarak emoji yoktur.
    if (type === 'voice' || type === 'forum' || type === 'stage' || type === 'announcement') return type;
    return 'text';
  }

  // ── View render ────────────────────────────────────────────────────────────
  async function renderView(): Promise<void> {
    if (!viewHost || destroyed) return;
    const ok = await mountOrUpdateChannelList(viewHost, {
      channels,
      // Canonical DB categories are loaded from /api/servers/:serverId/categories.
      // ChannelList still has a legacy fallback for older responses, but shipping
      // categoryId grouping no longer depends on a stale local-only owner.
      categories,
      collapsedCategoryKeys: collapsed,
      activeChannelId,
      onSelect: (channel) => selectChannel(channel as Channel),
      // Faz 9 yalnız çalışan eylemleri gösterir. Bu registry sahipleri henüz
      // taşınmadıysa view callback almaz ve ilgili ölü kontrolleri render etmez.
      onOpenMenu: BridgeRegistry.has('openChannelMenu')
        ? (channelId, name, event) => BridgeRegistry.call('openChannelMenu', channelId, name, event)
        : undefined,
      onCreateChannel: BridgeRegistry.has('createChannel')
        ? () => BridgeRegistry.call('createChannel')
        : undefined,
      onCreateInCategory: BridgeRegistry.has('createChannelInCategory')
        ? (categoryId, event) => BridgeRegistry.call('createChannelInCategory', categoryId, event)
        : undefined,
      onToggleCategory: (key) => {
        if (collapsed.has(key)) collapsed.delete(key); else collapsed.add(key);
        persistCollapsed();
        void renderView();
      },
    });
    if (!ok && !destroyed) log.error('Kanal listesi view mount edilemedi');
  }

  // ── Kanal listesi ──────────────────────────────────────────────────────────
  async function loadChannels(targetServerId: string, force = false): Promise<void> {
    if (destroyed || !nonEmptyString(targetServerId)) return;
    const token = readToken();
    if (!token) return;

    // Aynı sunucu için gereksiz tekrar istek (legacy'de yoktu — duplicate guard).
    if (!force && targetServerId === serverId && (isLoading || channels.length > 0)) return;

    const seq = ++requestSeq;
    const switching = targetServerId !== serverId;
    serverId = targetServerId;
    // Set before the first await: a navigation arriving while the list is in flight waits for it.
    isLoading = true;
    loadError = '';

    if (switching) {
      // Sunucu değişti: önceki sunucunun listesi bir an bile görünmemeli.
      channels = [];
      categories = [];
      activeChannelId = null;
      BridgeRegistry.call('setCurrentServerChannels', []);
      await renderView();

    }

    try {
      // Faz 4: apiFetch → 401'de access token'ı yeniler ve isteği bir kez tekrarlar.
      const base = `${getAPI()}/api/servers/${encodeURIComponent(targetServerId)}`;
      // Categories are presentation metadata, while the channel response is
      // the authorization-bearing primary resource. Start both requests in
      // parallel, but never make a slow/broken category endpoint hold the
      // authorized channel list hostage. The category promise owns its
      // rejection immediately so a later early return cannot produce an
      // unhandled rejection.
      const channelResponsePromise = apiFetch(`${base}/channels`);
      const categoryResponsePromise: Promise<Response | null> = apiFetch(`${base}/categories`)
        .catch((error: unknown) => {
          log.warn('Kanal kategorileri yüklenemedi; güvenli yedek gruplama kullanılacak', error);
          return null;
        });
      const response = await channelResponsePromise;
      if (!response.ok) {
        log.warn('Kanal listesi isteği başarısız', { status: response.status, serverId: targetServerId });
        throw new Error('channel-list-load-failed');
      }
      const data = await response.json() as unknown;

      // Race guard: geç dönen eski isteğin yanıtı yeni sunucunun state'ini ezemez.
      if (seq !== requestSeq) {
        log.info(`Bayat kanal yanıtı yok sayıldı (seq ${seq} < ${requestSeq})`);
        return;
      }

      channels = sanitizeChannels(data);
      // Final21 Faz 16: açık kanal yetkili listede artık YOKSA (erişim kaldırıldı,
      // kanal silindi) görünüm onu bırakır. Aksi hâlde `activeChannelId` dolu
      // kaldığı için aşağıdaki otomatik seçim hiç çalışmaz ve kullanıcı okuyamadığı
      // bir kanalın donmuş görünümüne bakmaya devam ederdi.
      if (!activeChannelSurvives(activeChannelId, channels.map(c => c._id))) {
        activeChannelId = null;
        BridgeRegistry.call('setCurrentChannel', null);
      }
      // Render the primary response immediately. Categories arrive below and
      // update this same canonical view when available.
      categories = [];
      BridgeRegistry.call('setCurrentServerChannels', channels);
      log.info(`${channels.length} kanal yüklendi`);
      await renderView();
      isLoading = false;

      // Cross-server navigation is consumed only AFTER the authorized list
      // arrives. Consuming it in the switching preamble searched an empty
      // array and made every cross-server Inbox/Saved destination fail.
      let selectedByPendingNavigation = false;
      if (pendingNavigation?.serverId === targetServerId) {
        const intent = pendingNavigation;
        const target = channels.find(c => c._id === intent.channelId);
        if (target) {
          selectChannel(target, intent.messageId);
          if (intent.messageId) BridgeRegistry.call('jumpToMessage', intent.messageId);
          finishPendingNavigation(intent, true);
          selectedByPendingNavigation = true;
        } else {
          finishPendingNavigation(intent, false);
          BridgeRegistry.call('toast', t("gdm_gone", "Bu konuşma artık kullanılamıyor."), 'warning');
        }
      }

      // Legacy channel-list.ts:61-62 — ilk metin kanalı otomatik seçilir.
      const first = channels.find(c => (c.type ?? 'text') === 'text');
      if (first && !activeChannelId && !selectedByPendingNavigation) selectChannel(first);

      // Apply optional presentation metadata only if this request is still the
      // current server. HTTP, network and malformed-JSON failures all preserve
      // the already-rendered channel list and its fallback grouping.
      const categoryResponse = await categoryResponsePromise;
      if (seq !== requestSeq) return;
      if (categoryResponse?.ok) {
        try {
          const categoryData = await categoryResponse.json() as unknown;
          if (seq !== requestSeq) return;
          categories = sanitizeCategories(categoryData);
          await renderView();
        } catch (error) {
          log.warn('Kanal kategori yanıtı geçersiz; güvenli yedek gruplama kullanılacak', error);
        }
      }
    } catch (error) {
      if (seq !== requestSeq) return;
      log.error('Kanal listesi yüklenemedi', error);
      loadError = t('error_generic', 'Bir hata oluştu. Lütfen tekrar dene.');
      if (pendingNavigation?.serverId === targetServerId) {
        finishPendingNavigation(pendingNavigation, false);
      }
    } finally {
      if (seq === requestSeq) isLoading = false;
    }
  }

  // ── Kanal seçimi ───────────────────────────────────────────────────────────
  function selectChannel(channel: Channel, historyMessageId?: string): void {
    if (destroyed) return;
    const safeChannel = sanitizeChannel(channel);
    if (!safeChannel) return;
    channel = safeChannel;
    if (historyMessageId !== undefined && !nonEmptyString(historyMessageId)) historyMessageId = undefined;
    if (channel._id === activeChannelId) {
      // Aynı kanal içindeki arama/Inbox/Saved hedefi ayrı bir anlamlı konumdur.
      if (historyMessageId) recordChannelLocation(channel, historyMessageId);

      // ══════════════════════════════════════════════════════════════════
      // KAPATILAN GERÇEK KUSUR — AYRILDIKTAN SONRA TEKRAR KATILINAMIYORDU
      // ══════════════════════════════════════════════════════════════════
      // Burada koşulsuz `return` vardı ve HİÇBİR olay yayılmıyordu.
      //
      // Ses kanalından "Ses kanalından ayrıl" düğmesiyle çıkıldığında kanal
      // SEÇİLİ kalır. Kullanıcı geri dönmek için aynı kanala tıkladığında
      // seçim DEĞİŞMEDİĞİ için bu erken çıkış devreye giriyor,
      // `bridge:channel-selected` yayılmıyor, `ChannelStagePanel` hiç
      // haberdar olmuyor ve `syncVoiceSession()` ÇALIŞMIYORDU.
      //
      // ÖLÇÜLEN ETKİ (iki tarayıcı): ayrıldıktan sonra kanala iki kez
      // tıklandı; yeni `RTCPeerConnection` HİÇ oluşmadı, karşı taraf sesi
      // geri almadı. Kullanıcı ancak BAŞKA bir kanala geçip dönerek
      // yeniden katılabiliyordu.
      //
      // Seçim gerçekten değişmedi; bu yüzden seçim durumu DEĞİŞTİRİLMEZ.
      // Yalnızca ses oturumunun sahibi haberdar edilir ki durumu uzlaştırsın.
      // `syncVoiceSession()` zaten "bu kanalda zaten sesteyim" durumunda
      // erken çıkar, dolayısıyla çift katılım oluşmaz.
      if (channel.type === 'voice' || channel.type === 'stage') {
        document.dispatchEvent(new CustomEvent('bridge:channel-selected', {
          detail: { channelId: channel._id },
        }));
      }
      return;
    }

    activeChannelId = channel._id;
    BridgeRegistry.call('setCurrentChannel', channel);

    // Kanal başlığı — legacy channel-list.ts:123-126 (DOM kopyalanmadı, davranış korundu)
    const iconEl  = document.getElementById('ch-h-icon');
    const nameEl  = document.getElementById('ch-h-name');
    const topicEl = document.getElementById('ch-h-topic');
    if (iconEl)  iconEl.dataset.channelType = channelIconKind(channel.type);
    if (nameEl)  nameEl.textContent  = channel.name;
    if (topicEl) topicEl.textContent = channel.topic ?? '';

    // Faz 8.3 — SAHİPLİK: metin/ses görünüm geçişi buradan ALINDI.
    // Liste bileşeni yalnızca SEÇİM yapar; hangi sahnenin görüneceğine
    // ChannelStagePanel.svelte karar verir (aşağıdaki channel-selected
    // olayını dinliyor). Böylece yönlendirme tek sahipte toplanır ve
    // ses/desteklenmeyen türler için dürüst durum ekranı çizilebilir.

    void renderView(); // aktif kanal vurgusu

    // Faz 4 dikişi — mevcut sözleşme (js/mobile.ts:190 dinliyor), yeni event icat edilmedi.
    document.dispatchEvent(new CustomEvent('bridge:channel-selected', { detail: { channelId: channel._id } }));

    recordChannelLocation(channel, historyMessageId);

    log.info(`Kanal seçildi: #${channel.name}`);
  }

  function recordChannelLocation(channel: Channel, messageId?: string): void {
    if (!BridgeRegistry.has('recordNavigationLocation')) return;
    const server = BridgeRegistry.has('getCurrentServer')
      ? BridgeRegistry.call<ServerSummary | null>('getCurrentServer')
      : BridgeRegistry.has('currentServer')
        ? BridgeRegistry.call<ServerSummary | null>('currentServer')
        : null;
    BridgeRegistry.call('recordNavigationLocation', {
      type: 'channel',
      channelId: channel._id,
      ...(messageId ? { messageId } : {}),
      ...(server?._id ? { server: { _id: server._id, name: server.name } } : {}),
    });
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function onLoadChannels(event: Event): void {
    const detail = (event as CustomEvent<{ serverId?: string }>).detail;
    if (nonEmptyString(detail?.serverId)) void loadChannels(detail.serverId);
  }

  function onLogout(): void {
    requestSeq += 1;
    if (pendingNavigation) finishPendingNavigation(pendingNavigation, false);
    channels = [];
    categories = [];
    serverId = null;
    activeChannelId = null;
    isLoading = false;
    loadError = '';
    BridgeRegistry.call('setCurrentServerChannels', []);
    BridgeRegistry.call('setCurrentChannel', null);
    void renderView();
  }

  // ── ERİŞİM DEĞİŞİKLİKLERİ (Final21 Faz 16) ─────────────────────────────────
  // Sunucu atma/yasaklamada `membership:revoked`, bir yetki değişikliği kanalı
  // gizlediğinde `channel:access-revoked`, her kanal yetkisi yazımında
  // `permissions:updated` yayar. Hiçbirini dinleyen istemci kodu YOKTU.
  type AccessSocket = { on?(e: string, h: (p: unknown) => void): unknown; off?(e: string, h: (p: unknown) => void): unknown };
  const ACCESS_EVENTS: AccessEvent[] = ['membership:revoked', 'channel:access-revoked', 'permissions:updated'];
  const accessHandlers = new Map<AccessEvent, (payload: unknown) => void>(
    ACCESS_EVENTS.map(event => [event, (payload: unknown) => onAccessEvent(event, payload)]),
  );
  let accessSocket: AccessSocket | null = null;

  function onAccessEvent(event: AccessEvent, payload: unknown): void {
    const reaction = decideAccessReaction(event, payload, { currentServerId: serverId, activeChannelId });
    if (reaction.reloadServers) BridgeRegistry.call('loadServers');
    if (reaction.reloadChannelsOf) void loadChannels(reaction.reloadChannelsOf, true);
    if (reaction.notice === 'server-access-lost') {
      BridgeRegistry.call('toast', t('access_server_lost', 'Bu sunucuya erişimin kaldırıldı.'), 'warning');
    } else if (reaction.notice === 'channel-access-lost') {
      BridgeRegistry.call('toast', t('access_channel_lost', 'Bu kanala erişimin kaldırıldı.'), 'warning');
    }
  }

  function syncAccessSocket(): void {
    const socket = BridgeRegistry.get<AccessSocket>('socket') ?? null;
    if (socket === accessSocket) return;
    for (const [event, handler] of accessHandlers) accessSocket?.off?.(event, handler);
    accessSocket = socket;
    for (const [event, handler] of accessHandlers) accessSocket?.on?.(event, handler);
  }

  onMount(() => {
    syncAccessSocket();
    document.addEventListener('bridge:socket-ready', syncAccessSocket);
    document.addEventListener('bridge:socket-reconnected', syncAccessSocket);
    document.addEventListener('bridge:load-channels', onLoadChannels);
    document.addEventListener('bridge:auth-logout', onLogout);
    // ServerSwitcher bu bileşenden önce sunucu seçmiş olabilir.
    const server = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer');
    if (nonEmptyString(server?._id)) void loadChannels(server._id);
  });

  // Legacy socket olayları (channel:created/updated) bu adı çağırıyordu.
  BridgeRegistry.register('loadChannels', (id?: string) => { void loadChannels(id ?? serverId ?? '', true); });
  BridgeRegistry.register('selectChannel', (channel: Channel) => selectChannel(channel));

  /**
   * ── ARAMA SONUCUNDAN KANALA GIT ────────────────────────────────────────────
   * BULUNAN KUSUR: `SearchPanel.navigateToResult()` KORUMASIZ olarak
   *   BridgeRegistry.call('navigateToChannel', channelId, messageId)
   * cagiriyordu, ancak bu ad HICBIR YERDE register EDILMIYORDU. `call()`
   * kayitsiz anahtarda sessizce `undefined` doner: sonuca tiklamak paneli
   * kapatiyor ama HICBIR YERE GITMIYORDU — arama sonucu olu bir baglantiydi.
   *
   * Kanal listesi bu uygulamada kanalin KANONIK sahibidir; secim burada yapilir.
   * Ikinci bir gezinme sahibi kurulmaz.
   */
  async function navigateToChannel(channelId: string, messageId?: string, targetServer?: ServerSummary): Promise<boolean> {
    if (destroyed || !nonEmptyString(channelId)) return false;
    if (messageId !== undefined && !nonEmptyString(messageId)) messageId = undefined;
    const target = channels.find(c => c._id === channelId);
    if (!target) {
      const targetServerId = nonEmptyString(targetServer?._id) ? targetServer._id : null;
      // P4 (MEASURED, Android 14 emulator, cold `bridge://channel/<id>`): the app had already
      // selected the target server and its channel list was still in flight. The empty list
      // was read as "no such channel" → "not available" toast, then the first text channel was
      // auto-selected. The intent now waits for that authorized list and is decided there.
      if (isLoading && serverId && (targetServerId ?? serverId) === serverId) {
        if (pendingNavigation) finishPendingNavigation(pendingNavigation, false);
        return new Promise<boolean>(resolve => {
          const intent: PendingNavigation = {
            serverId: serverId as string,
            channelId,
            messageId,
            resolve,
            timeoutId: setTimeout(() => {
              if (pendingNavigation !== intent) return;
              finishPendingNavigation(intent, false);
              BridgeRegistry.call('toast', t("gdm_gone", "Bu konuşma artık kullanılamıyor."), 'warning');
            }, 10_000),
          };
          pendingNavigation = intent;
        });
      }
      if (targetServerId && targetServerId !== serverId) {
        if (!BridgeRegistry.has('selectServer')) return false;
        if (pendingNavigation) finishPendingNavigation(pendingNavigation, false);
        return new Promise<boolean>(resolve => {
          const intent: PendingNavigation = {
            serverId: targetServerId,
            channelId,
            messageId,
            resolve,
            timeoutId: setTimeout(() => {
              if (pendingNavigation !== intent) return;
              finishPendingNavigation(intent, false);
              BridgeRegistry.call('toast', t("gdm_gone", "Bu konuşma artık kullanılamıyor."), 'warning');
            }, 10_000),
          };
          pendingNavigation = intent;
          BridgeRegistry.call('selectServer', targetServer);
        });
      } else {
        BridgeRegistry.call('toast', t("gdm_gone", "Bu konuşma artık kullanılamıyor."), 'warning');
      }
      return false;
    }
    selectChannel(target, messageId);
    // Mesaj kimligi verildiyse liste sahibine iletilir (varsa) — burada
    // kaydirma mantigi TEKRARLANMAZ.
    if (messageId && BridgeRegistry.has('jumpToMessage')) {
      BridgeRegistry.call('jumpToMessage', messageId);
    }
    return true;
  }
  BridgeRegistry.register('navigateToChannel', navigateToChannel);

  /**
   * Kenar cubugundaki "+" kanal olusturma girisi. `ChannelList` bu geri
   * cagriyi YALNIZCA kayitliysa render eder (yukaridaki `has()` korumasi),
   * bu yuzden kayit olmadan olu bir dugme olusmuyordu — ama yetenek de
   * kenar cubugundan ERISILEMIYORDU. Kanonik diyaloga baglanir.
   */
  BridgeRegistry.register('createChannel', () => {
    if (BridgeRegistry.has('openCreateChannel')) BridgeRegistry.call('openCreateChannel');
  });

  onDestroy(() => {
    destroyed = true;
    requestSeq += 1;
    document.removeEventListener('bridge:load-channels', onLoadChannels);
    document.removeEventListener('bridge:auth-logout', onLogout);
    document.removeEventListener('bridge:socket-ready', syncAccessSocket);
    document.removeEventListener('bridge:socket-reconnected', syncAccessSocket);
    for (const [event, handler] of accessHandlers) accessSocket?.off?.(event, handler);
    accessSocket = null;
    BridgeRegistry.unregister('loadChannels');
    BridgeRegistry.unregister('selectChannel');
    BridgeRegistry.unregister('navigateToChannel');
    if (pendingNavigation) finishPendingNavigation(pendingNavigation, false);
    BridgeRegistry.unregister('createChannel');
    unmountChannelList();
  });
</script>

<div class="channel-list-host" bind:this={viewHost}></div>

{#if isLoading}
  <div class="ch-status" role="status" aria-live="polite">{t('clm_loading', 'Kanallar yükleniyor…')}</div>
{:else if loadError}
  <div class="ch-status ch-status-error" role="alert">
    <span>{t('clm_failed', 'Kanallar yüklenemedi')}</span>
    <button type="button" onclick={() => void loadChannels(serverId ?? '', true)}>{t('retry')}</button>
  </div>
{/if}

{@render children?.()}

<style>
  /* Mevcut kenar çubuğu tipografisiyle uyumlu; yeni tasarım dili tanımlanmadı. */
  .ch-status {
    padding: 8px 12px;
    color: var(--text-3);
    font-size: 12px;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .ch-status-error { color: var(--danger); flex-wrap: wrap; }
  .ch-status button {
    background: none;
    border: 1px solid currentColor;
    border-radius: var(--r-sm, 4px);
    color: inherit;
    font: inherit;
    font-size: 11px;
    padding: 2px 8px;
    cursor: pointer;
  }
</style>
