<!-- client/js/core/stickers/StickerOpener.svelte -->
<!--
  FAZ C3 — STICKER PANELİ AÇICISI + KONTROLCÜ KÖPRÜSÜ.

  Kanal başlığındaki mevcut araç çubuğuna yerleşir (ServerSettingsOpener ile
  aynı yüzey); ikinci bir kabuk/panel sistemi kurulmaz.

  GÖRÜNÜRLÜK: paket LİSTELEME arka uçta VIEW_CHANNELS ister — yani sunucunun
  her üyesi görebilir. Bu yüzden açıcı, geçerli bir sunucu çözülebiliyorsa
  gösterilir; sunucu yoksa GİZLENİR (boş kimlikle istek üretilmez).
  YÖNETİM eylemleri ayrıca MANAGE_SERVER ister ve yalnız kanıtlanırsa açılır.

  BAĞLAM: panel açılırken serverId O ANDA yakalanır ve kontrolcüye aynen
  geçirilir; sonradan "şu an hangi sunucu?" diye sorulmaz. Sunucu değişiminde
  panel kapatılır ve yetki önbelleği temizlenir (bayat yüzey kalmaz).
-->
<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from '../bridge-registry.js';
  import { createLogger } from '../logger.js';
  import { canManageServer, clearPermsCache } from '../permissions/myPermissions.ts';
  import { createStickerController } from './stickerStore.ts';
  import StickerPanel from './StickerPanel.svelte';

  const log = createLogger('StickerOpener');

  interface CurrentServer { _id?: string; id?: string }

  let serverId  = $state('');
  let open      = $state(false);
  let canManage = $state(false);
  let version   = $state(0);

  type Controller = ReturnType<typeof createStickerController>;
  let controller: Controller | null = null;

  // Uçuştaki asenkron işler bağlam değişince sonuç uygulamamalı.
  let openSeq = 0;

  function snap() {
    void version;
    return controller?.snapshot ?? null;
  }

  const packs   = $derived(snap()?.packs   ?? []);
  const loading = $derived(snap()?.loading ?? false);
  const busy    = $derived(snap()?.busy    ?? false);
  const error   = $derived(snap()?.error   ?? null);

  function bump(): void { version += 1; }

  function refresh(): void {
    const server = BridgeRegistry.call<CurrentServer | null>('getCurrentServer') ?? null;
    serverId = String(server?._id ?? server?.id ?? '');
  }

  async function openPanel(): Promise<void> {
    refresh();
    if (!serverId) return;                 // boş kimlikle asla açma

    const seq = ++openSeq;
    const sid = serverId;
    const nextController = createStickerController(sid);

    controller = nextController;
    open       = true;
    canManage  = false;                    // kanıtlanana kadar yönetim YOK
    bump();

    await nextController.load();
    if (seq !== openSeq || controller !== nextController || !open) return;
    bump();

    const allowed = await canManageServer(sid);
    if (seq !== openSeq || controller !== nextController || !open) return;
    canManage = allowed;
    bump();
  }

  function closePanel(): void {
    // Kapatma yalnız görünürlüğü değiştirmez: yükleme/yetki sonucunun kapalı
    // bir yüzeye sonradan uygulanmasını ve gereksiz ikinci isteği de iptal eder.
    openSeq   += 1;
    open       = false;
    controller = null;
    canManage  = false;
    bump();
  }

  /**
   * UÇUŞTAKİ İSTEK ARAYÜZE YANSIMALI.
   *
   * Kontrolcü düz bir nesnedir; `busy` alanını Svelte kendiliğinden izlemez.
   * `bump()` YALNIZCA istek bittikten sonra çağrılırsa, istek süresince arayüz
   * hâlâ `busy=false` okur: yükleme durumu görünmez ve kontroller etkin kalır.
   * Kontrolcü `busy = true` atamasını ilk `await`ten ÖNCE yapar, bu yüzden
   * çağrıyı başlatıp HEMEN bump etmek doğru durumu yayınlar.
   */
  async function track<T>(owner: Controller, run: () => Promise<T>): Promise<T> {
    const p = run();      // `busy = true` senkron olarak atanır
    if (controller === owner) bump(); // arayüz yükleme durumunu şimdi görür
    try {
      return await p;
    } finally {
      // Eski bir kontrolcünün tamamlanması yeni açılmış paneli dürtmemeli;
      // ancak sahibi hâlâ etkinse hata yolunda da `busy=false` yayınlanmalı.
      if (controller === owner) bump();
    }
  }

  async function onDeletePack(packId: string): Promise<void> {
    const owner = controller;
    if (!owner) return;
    await track(owner, () => owner.deletePack(packId));
  }

  async function onRename(packId: string, stickerId: string, name: string): Promise<void> {
    const owner = controller;
    if (!owner) return;
    await track(owner, () => owner.renameSticker(packId, stickerId, name));
  }

  async function onCreate(name: string, description: string, files: File[]): Promise<boolean> {
    const owner = controller;
    if (!owner) return false;
    return track(owner, () => owner.createPack(name, description, files));
  }

  function onSend(sticker: import('./stickerStore.ts').Sticker): boolean {
    const ok = BridgeRegistry.call<boolean>('sendSticker', sticker) === true;
    if (!ok) BridgeRegistry.call('toast', t("ui_sticker_gonderim_kuyruguna_alinamadi", "Sticker gönderim kuyruğuna alınamadı."), 'error');
    return ok;
  }

  // Sunucu değişimi: ServerSwitcher.svelte:98 yalnız sunucu seçiminde yayar.
  const onContextChange = () => {
    openSeq += 1;
    clearPermsCache();
    if (open) closePanel();
    refresh();
  };

  onMount(() => {
    refresh();
    BridgeRegistry.register('openStickerPanel', openPanel);
    document.addEventListener('bridge:load-channels', onContextChange);
    document.addEventListener('bridge:auth-success', onContextChange);
    document.addEventListener('bridge:auth-logout', onContextChange);
    log.info('Sticker açıcısı bağlandı');
  });

  onDestroy(() => {
    // `openPanel()` onMount yaşam süresinden uzun yaşayabilir. Yok edilen
    // bileşenin permission sonucunu uygulamasına izin verme.
    openSeq   += 1;
    open       = false;
    controller = null;
    canManage  = false;
    BridgeRegistry.unregister('openStickerPanel');
    document.removeEventListener('bridge:load-channels', onContextChange);
    document.removeEventListener('bridge:auth-success', onContextChange);
    document.removeEventListener('bridge:auth-logout', onContextChange);
  });
</script>

{#if serverId}
  <button
    type="button"
    class="h-btn tooltip sticker-opener"
    data-tip={t('stk_open_packs', 'Sticker paketlerini aç')}
    aria-label={t('stk_open_packs', 'Sticker paketlerini aç')}
    onclick={openPanel}
  >
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <path d="M14.5 3.5H7a3 3 0 0 0-3 3v11a3 3 0 0 0 3 3h6l7-7V9"/>
      <path d="M13 20.5V15a2 2 0 0 1 2-2h5.5"/>
    </svg>
  </button>
{/if}

{#if open}
  <StickerPanel
    {packs}
    {loading}
    {busy}
    {error}
    {canManage}
    {onDeletePack}
    {onRename}
    {onCreate}
    {onSend}
    onClose={closePanel}
  />
{/if}
