<!-- client/js/core/ServerMenu.svelte -->
<!--
  UX/P1 — GERÇEK SUNUCU MENÜSÜ.

  ════════════════════════════════════════════════════════════════════════════
  BULUNAN KUSUR
  ════════════════════════════════════════════════════════════════════════════
  Sunucu başlığı `disabled aria-disabled="true"` bir düğmeydi: Discord'un
  BİRİNCİL sunucu girişi (Invite / Create Channel / Server Settings / Leave)
  Bridge'de hiç yoktu. Ara düzeltmede düğme doğrudan davet panelini açıyordu;
  bu tek akışı kurtarıyor ama menüyü hâlâ vermiyordu.

  ════════════════════════════════════════════════════════════════════════════
  YALNIZ GERÇEK YETENEKLER GÖSTERİLİR
  ════════════════════════════════════════════════════════════════════════════
  Her öğe İKİ koşulu birden geçmek zorundadır:
    1. Sunucu tarafında uç GERÇEKTEN vardır, ve
    2. İstemcide o ucu çağıran CANLI bir sahip kayıtlıdır.
  Bu yüzden menü ölçüme göre şunları İÇERMEZ:

  · "Kategori Oluştur" — YOK. Sunucuda kategori diye bir VARLIK/uç yoktur;
    `category` yalnızca kanal üzerinde bir metin alanıdır. Ayrı bir kategori
    oluşturma eylemi göstermek kullanıcıya olmayan bir model vaat ederdi.
  (Final21 Faz 4 — DÜZELTİLDİ) Burada eskiden şu not vardı:

      · "Bildirim Ayarları" — DORMANT. `notification-prefs` üretim
        girdisinden (`app.ts`) erişilemiyor; kayıt hiç oluşmuyor.

  Not ESKİMİŞTİ. `app.ts:217` `./core/notification-prefs-svelte.ts`i ithal
  ediyor; o shim paneli açılışta MOUNT edip `showNotificationPrefsPanel`
  kaydını yapıyor. Çalışma zamanında doğrulandı (chromium):

      document.getElementById('notification-prefs-root') → VAR

  Bedeli: sunucuyu SESSİZE ALMAK — `POST /api/notification-prefs`
  (`serverId` + `level: 'mute'`) ile sunucuda tam destekli olduğu hâlde —
  istemcide hiçbir yerden erişilemiyordu. Öğe artık menüde ve yine
  "canlı sahip" koşuluna bağlı.

  ════════════════════════════════════════════════════════════════════════════
  YETKİ KAYNAĞI: SUNUCU (istemci varsayımı DEĞİL)
  ════════════════════════════════════════════════════════════════════════════
  Görünürlük `GET /api/servers/:sid/me/permissions` ile SUNUCUYA sorulur.
  Bu bir KOLAYLIKTIR, yetki denetimi DEĞİLDİR: her uç kendi yetkisini yine
  kendisi doğrular (kanal ucu MANAGE_CHANNELS ister, ayrılma ucu sahibi
  reddeder). İstemci tarafı görünürlük SUNUCU YETKİLENDİRMESİNİN YERİNE
  GEÇMEZ; yalnızca kullanıcıya kesin 403 alacağı kapıları göstermez.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { clampFloatingRect } from './floating-position.ts';
  import { createLogger } from './logger.js';
import { safeApiErrorMessage } from './api-error.ts';

  const log = createLogger('ServerMenu');

  // Kanonik bit değerleri — server/lib/permissions.ts ile birebir.
  const MANAGE_CHANNELS = 1 << 1;
  const MANAGE_ROLES    = 1 << 2;
  const MANAGE_SERVER   = 1 << 3;
  const ADMINISTRATOR   = 1 << 30;

  interface Item {
    id: string; label: string; glyph: string;
    danger?: boolean; run: () => void;
  }

  let isVisible = $state(false);
  let perms     = $state(0);
  let permsLoaded = $state(false);
  let leaveArmed  = $state(false);
  let leaveError  = $state('');
  let activeIndex = $state(0);
  let anchor    = $state({ top: 0, left: 0, width: 220 });

  let trigger: HTMLElement | null = null;
  let menuEl   = $state<HTMLElement | null>(null);

  const apiBase = (): string =>
    (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;

  function currentServer(): { _id?: string; name?: string; ownerId?: string } | null {
    return BridgeRegistry.call<{ _id?: string; name?: string; ownerId?: string } | null>('currentServer') ?? null;
  }
  function me(): { id?: string; _id?: string } | null {
    try { return BridgeRegistry.call<{ id?: string; _id?: string } | null>('me') ?? null; }
    catch { return null; }
  }

  let server = $derived(isVisible ? currentServer() : null);
  let serverName = $derived(server?.name?.trim() || t('cp_category_server', 'Sunucu'));

  let isOwner = $derived.by(() => {
    const s = currentServer(); const u = me();
    const uid = String(u?.id ?? u?._id ?? '');
    return Boolean(s?.ownerId && uid && s.ownerId === uid);
  });

  function can(bit: number): boolean {
    return (perms & ADMINISTRATOR) !== 0 || (perms & bit) !== 0;
  }

  /**
   * Menü içeriği: yalnız (a) yetkinin izin verdiği ve (b) CANLI bir sahibi
   * kayıtlı olan eylemler. Sahip yoksa öğe hiç üretilmez — ölü satır olmaz.
   */
  let items = $derived.by<Item[]>(() => {
    const out: Item[] = [];

    if (BridgeRegistry.has('openInvitePanel')) {
      out.push({
        id: 'invite', glyph: '🔗', label: t("inv_title", "Arkadaşlarını davet et"),
        run: () => { close(); BridgeRegistry.call('openInvitePanel'); },
      });
    }
    if (permsLoaded && can(MANAGE_CHANNELS) && BridgeRegistry.has('openCreateChannel')) {
      out.push({
        id: 'create-channel', glyph: '＋', label: t("channels_empty_cta", "Kanal oluştur"),
        run: () => { close(); BridgeRegistry.call('openCreateChannel'); },
      });
    }
    if (BridgeRegistry.has('openServerEvents')) {
      out.push({
        id: 'events', glyph: '◷', label: t('markup_sunucu_etkinlikleri_0b1faaa', 'Sunucu etkinlikleri'),
        run: () => { close(); BridgeRegistry.call('openServerEvents'); },
      });
    }
    // ── BİLDİRİM TERCİHLERİ (Final21, Faz 4) ────────────────────────────
    // Bu öğe, dosyanın başındaki nota dayanarak "DORMANT" diye DIŞARIDA
    // BIRAKILMIŞTI. Not ESKİMİŞ: `app.ts:217` `notification-prefs-svelte.ts`i
    // ithal ediyor, o shim de paneli açılışta MOUNT edip
    // `showNotificationPrefsPanel` kaydını yapıyor.
    //
    // ÇALIŞMA ZAMANINDA ölçüldü (Final21 Faz 4, chromium):
    //     document.getElementById('notification-prefs-root') → VAR
    //
    // Sonucu somuttu: sunucuyu sessize almak — günlük kullanımın en sık
    // eylemlerinden biri ve `POST /api/notification-prefs` ile SUNUCUDA TAM
    // DESTEKLİ (`serverId` + `level: 'mute'`) — istemcide HİÇBİR yerden
    // erişilemiyordu. Yapılmış, mount edilmiş, testli bir panel kullanıcıya
    // kapalıydı.
    //
    // Dosyanın kendi sözleşmesi KORUNUR: öğe yalnızca CANLI sahip kayıtlıysa
    // üretilir; sahip yoksa yine ölü satır oluşmaz.
    if (BridgeRegistry.has('showNotificationPrefsPanel')) {
      out.push({
        id: 'notifications', glyph: '🔔', label: t('surface_bildirim_ayarlar_fead6c', 'Bildirim ayarları'),
        run: () => { close(); BridgeRegistry.call('showNotificationPrefsPanel'); },
      });
    }
    // ── BOT EKLE (Final21, Faz 14) ────────────────────────────────────────
    // Pazaryerine yalnız komut paletinden (Ctrl+K → "bot") ulaşılabiliyordu;
    // bot kurmak isteyen bir yöneticinin görünür bir yolu yoktu. Kurulum
    // MANAGE_SERVER ister (sunucu da ayrıca doğrular), öğe de ona bağlıdır.
    if (permsLoaded && can(MANAGE_SERVER) && BridgeRegistry.has('openBotMarketplace')) {
      out.push({
        id: 'bots', glyph: '🧩', label: t('server_menu_add_bots', 'Bot ekle'),
        run: () => { close(); BridgeRegistry.call('openBotMarketplace'); },
      });
    }
    if (permsLoaded && (can(MANAGE_SERVER) || can(MANAGE_ROLES)) && BridgeRegistry.has('openServerSettings')) {
      out.push({
        id: 'settings', glyph: '⚙', label: t("ssm_aria", "Sunucu ayarları"),
        run: () => {
          const initialTab = can(MANAGE_SERVER) ? 'general' : 'roles';
          close();
          BridgeRegistry.call('openServerSettings', initialTab);
        },
      });
    }
    if (permsLoaded && !isOwner) {
      out.push({
        id: 'leave', glyph: '⤴', label: t("ui_sunucudan_ayril", "Sunucudan ayrıl"), danger: true,
        run: () => { void leaveServer(); },
      });
    }
    return out;
  });

  async function loadPerms(sid: string): Promise<void> {
    try {
      const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/servers/${encodeURIComponent(sid)}/me/permissions`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { permissions?: number };
      perms = Number(data.permissions) || 0;
    } catch (err) {
      // FAIL-CLOSED: yetki okunamazsa yönetim öğeleri GÖSTERİLMEZ.
      log.error('Permission fetch failed', err);
      perms = 0;
    } finally {
      permsLoaded = true;
    }
  }

  async function leaveServer(): Promise<void> {
    if (!leaveArmed) { leaveArmed = true; return; }   // iki adımlı onay
    const s = currentServer();
    if (!s?._id) return;
    leaveError = '';
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/servers/${encodeURIComponent(s._id)}/leave`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
      });
      if (!res.ok) {
        leaveError = safeApiErrorMessage(res, t("ui_sunucudan_ayrilamadin_lutfen_tekrar_dene", "Sunucudan ayrılamadın. Lütfen tekrar dene."), { report: true });
        return;
      }
      close();
      if (BridgeRegistry.has('loadServers')) BridgeRegistry.call('loadServers');
    } catch (err) {
      log.error('Leave failed', err);
      leaveError = t("ui_ayrilinamadi_lutfen_tekrar_deneyin", "Ayrılınamadı. Lütfen tekrar deneyin.");
    }
  }

  function position(): void {
    trigger = document.getElementById('server-header-btn');
    if (!trigger) return;
    const r = trigger.getBoundingClientRect();
    const width = Math.max(r.width, 220);
    const measuredHeight = menuEl?.getBoundingClientRect().height || 280;
    const point = clampFloatingRect({ left: r.left, top: r.bottom + 6, width, height: measuredHeight, margin: 8 });
    anchor = { top: point.top, left: point.left, width };
  }

  function open(): void {
    const s = currentServer();
    isVisible = true;
    leaveArmed = false; leaveError = '';
    activeIndex = 0;
    permsLoaded = false; perms = 0;
    position();
    trigger?.setAttribute('aria-expanded', 'true');
    if (s?._id) void loadPerms(s._id);
    else permsLoaded = true;   // sunucu yoksa yalnız yetkisiz öğeler kalır
  }

  function close(): void {
    if (!isVisible) return;
    isVisible = false;
    leaveArmed = false;
    trigger?.setAttribute('aria-expanded', 'false');
    // ODAK İADESİ KANONİK PRİMİTİFİNDİR: `focusTrap` etkinleşirken odaktaki
    // ögeyi (gerçek akışta bu düğmenin kendisi) saklar ve yok edilirken geri
    // verir. Burada AYRICA `trigger.focus()` çağrılmıştı; bu hem gereksizdi
    // hem de tuzağın iadesi sonra çalıştığı için ETKİSİZDİ — ikinci bir odak
    // sahibi yaratmamak için kaldırıldı.
  }

  function toggle(): void { isVisible ? close() : open(); }

  function focusItem(i: number): void {
    const nodes = menuEl?.querySelectorAll<HTMLElement>('[role="menuitem"]');
    if (!nodes?.length) return;
    const n = (i + nodes.length) % nodes.length;
    activeIndex = n;
    nodes[n]?.focus();
  }

  function onMenuKey(e: KeyboardEvent): void {
    if (e.key === 'ArrowDown')      { e.preventDefault(); focusItem(activeIndex + 1); }
    else if (e.key === 'ArrowUp')   { e.preventDefault(); focusItem(activeIndex - 1); }
    else if (e.key === 'Home')      { e.preventDefault(); focusItem(0); }
    else if (e.key === 'End')       { e.preventDefault(); focusItem(items.length - 1); }
  }

  function onWindowKey(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isVisible) return;
    e.preventDefault();
    close();
  }

  /**
   * TETIKLEYICI BAGLAMA — CANLI URUNDE YAKALANDI.
   *
   * ════════════════════════════════════════════════════════════════════════
   * NEDEN `data-bridge-action`A GUVENILMIYOR
   * ════════════════════════════════════════════════════════════════════════
   * `index.html` icindeki dispatcher KLASIK (module olmayan) bir inline
   * script'tir ve su korumayi kullanir:
   *     if (typeof BridgeRegistry !== 'undefined' && BridgeRegistry.has(action))
   * Ancak `BridgeRegistry` bir ESM disa aktarimidir ve HICBIR YERDE `window`a
   * ATANMAZ. Dolayisiyla klasik script'te `typeof BridgeRegistry` her zaman
   * `'undefined'`tir: registry dali HIC calismaz, akis yalnizca 4 vakalik
   * legacy `switch`e duser.
   *
   * OLCUM (canli urun, tarayici): kayitli bir anahtarla olusturulan sentetik
   * `data-bridge-action` dugmesi HICBIR SEY yapmadi; ayni eylem bilesen
   * yolundan cagrildiginda CALISTI. Kabuktaki dugmelerin calisiyor gorunmesi
   * dispatcher'dan DEGIL, ilgili bilesenlerin o dugmelere KENDI dinleyicisini
   * baglamasindandir (ornegin `MessageInputPanel` gonder dugmesini boyle
   * baglar, `admin-svelte` ayarlar dugmesini boyle bulur).
   *
   * NEDEN GLOBAL COZUM SECILMEDI: `window.BridgeRegistry` atamak dispatcher'i
   * canlandirirdi ama ZATEN bilesen tarafindan baglanmis dugmeler IKI KEZ
   * tetiklenirdi (ayarlar iki kez acilir, uye listesi iki kez degisip yerinde
   * kalirdi). Yani calisan dugmeleri BOZARDI.
   *
   * Bu yuzden kanonik ve kanitlanmis desen izlenir: tetikleyici burada,
   * bilesenin kendi yasam dongusunde baglanir ve birakilir.
   */
  let triggerEl: HTMLElement | null = null;
  function onTriggerClick(e: MouseEvent): void {
    e.preventDefault();
    e.stopPropagation();
    toggle();
  }

  onMount(() => {
    BridgeRegistry.register('openServerMenu', open);
    BridgeRegistry.register('closeServerMenu', close);
    BridgeRegistry.register('toggleServerMenu', toggle);

    triggerEl = document.getElementById('server-header-btn');
    triggerEl?.addEventListener('click', onTriggerClick);
  });
  onDestroy(() => {
    triggerEl?.removeEventListener('click', onTriggerClick);
    BridgeRegistry.unregister?.('openServerMenu');
    BridgeRegistry.unregister?.('closeServerMenu');
    BridgeRegistry.unregister?.('toggleServerMenu');
  });

  // Açılışta ilk öğeye odak — klavye kullanıcısı menüye "girer".
  $effect(() => {
    if (isVisible && menuEl && items.length) {
      queueMicrotask(() => position());
      focusItem(activeIndex);
    }
  });
</script>

<svelte:window onkeydown={onWindowKey} onresize={() => isVisible && position()} />

{#if isVisible}
<div class="sm-scrim" role="presentation"
     onclick={(e) => { if (e.target === e.currentTarget) close(); }}></div>

<div class="sm-menu" role="menu" tabindex="-1" aria-label={t('server_menu_aria', undefined, { server: serverName })}
     bind:this={menuEl}
     onkeydown={onMenuKey}
     use:focusTrap={{ initialFocus: '[role="menuitem"]' }}
     style={`top:${anchor.top}px; left:${anchor.left}px; min-width:${anchor.width}px;`}>

  {#if !permsLoaded}
    <p class="sm-state" aria-live="polite">{t('markup_yetkiler_okunuyor_ba69a24', "Yetkiler okunuyor…")}</p>
  {/if}

  {#each items as item, i (item.id)}
    <button type="button" role="menuitem" class="sm-item" class:danger={item.danger}
            tabindex={i === activeIndex ? 0 : -1}
            onclick={item.run}
            onfocus={() => (activeIndex = i)}>
      <span class="sm-glyph" aria-hidden="true">{item.glyph}</span>
      <span class="sm-label">
        {#if item.id === 'leave' && leaveArmed}{t("ui_confirm_leave")}{:else}{item.label}{/if}
      </span>
    </button>
  {/each}

  {#if permsLoaded && !items.length}
    <p class="sm-state">{t('sm_no_actions', 'Bu sunucuda kullanılabilir eylem yok.')}</p>
  {/if}

  {#if leaveError}<p class="sm-error" role="alert">{leaveError}</p>{/if}
</div>
{/if}

<style>
  .sm-scrim { position: fixed; inset: 0; z-index: 1190; background: transparent; }
  .sm-menu {
    position: fixed; z-index: 1200;
    background: var(--surface-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-surface);
    box-shadow: var(--elevation-modal);
    padding: var(--space-1);
    display: grid; gap: 1px;
    max-width: min(300px, calc(100vw - 24px));
  }
  .sm-item {
    display: flex; align-items: center; gap: var(--space-3);
    width: 100%; text-align: left;
    padding: 9px 10px;
    border: 0; background: transparent;
    color: var(--text-2); font: inherit; cursor: pointer;
    border-radius: var(--radius-control);
    transition: background var(--duration-fast), color var(--duration-fast);
  }
  .sm-item:hover, .sm-item:focus-visible { background: var(--surface-hover); color: var(--text-primary); }
  .sm-item:focus-visible { outline: 2px solid var(--brand); outline-offset: -2px; }
  .sm-item.danger { color: var(--danger); }
  .sm-item.danger:hover, .sm-item.danger:focus-visible {
    background: color-mix(in srgb, var(--danger) 14%, transparent); color: var(--danger);
  }
  .sm-glyph { width: 18px; text-align: center; flex-shrink: 0; }
  .sm-label { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .sm-state, .sm-error {
    margin: 0; padding: 8px 10px;
    font-size: var(--type-caption); color: var(--text-muted);
  }
  .sm-error { color: var(--danger); white-space: normal; }
</style>
