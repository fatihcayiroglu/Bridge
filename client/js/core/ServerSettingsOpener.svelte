<!-- client/js/core/ServerSettingsOpener.svelte -->
<!--
  FAZ C1.3 — SUNUCU AYARLARI CANLI AÇICISI.

  Sunucu Ayarları modalı (ServerSettingsModal.svelte, 250 satır + 7 sekme)
  gerçek bir uygulamaydı ama ürüne HİÇ bağlanmamıştı: shim'i app.ts'ten import
  edilmiyordu ve onu açacak tek bir kontrol bile yoktu.

  YETKİ: arka uç `PATCH /api/servers/:sid` için SAHİP-ONLY davranır
  (routes/servers/core.ts:348 → `server.ownerId !== user.id` ⇒ 403).
  Bu yüzden açıcı yalnızca sunucu SAHİBİNE gösterilir; sıradan bir üyeye
  kaydedemeyeceği bir yüzey vaat edilmez.

  ÖNEMLİ: görünürlük yalnızca UX'tir. Güvenlik sınırı arka uçtur; bu bileşen
  hiçbir yetki kararı vermez, yalnız yetkisi olmayan kullanıcıya yanıltıcı
  kontrol göstermez. Sahiplik bilgisi yoksa buton GİZLENİR (fail-closed).
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';

  const log = createLogger('ServerSettingsOpener');

  interface CurrentServer { _id?: string; ownerId?: string; name?: string }
  interface CurrentUser   { _id?: string; id?: string }

  let serverId = $state('');
  let isOwner  = $state(false);

  /** Kanonik durumdan geçerli sunucuyu ve kullanıcıyı çözer. */
  function refresh(): void {
    const server = BridgeRegistry.call<CurrentServer | null>('getCurrentServer') ?? null;
    const me     = BridgeRegistry.call<CurrentUser | null>('me') ?? null;

    serverId = String(server?._id ?? '');
    const myId    = String(me?._id ?? me?.id ?? '');
    const ownerId = String(server?.ownerId ?? '');

    // Sahiplik kanıtlanamıyorsa GÖSTERME — yanlış vaatte bulunma.
    isOwner = Boolean(serverId) && Boolean(myId) && ownerId === myId;
  }

  function open(): void {
    if (!serverId || !isOwner) return;   // boş/undefined sunucuya asla açma
    void BridgeRegistry.call('openServerSettings');
  }

  // Sunucu değişimi rail tarafından bu olayla duyurulur (ServerSwitcher:98).
  const onServerChange = () => refresh();

  onMount(() => {
    refresh();
    document.addEventListener('bridge:load-channels', onServerChange);
    document.addEventListener('bridge:auth-success', onServerChange);
    document.addEventListener('bridge:auth-logout', onServerChange);
    log.info('Sunucu Ayarları açıcısı bağlandı');
  });

  onDestroy(() => {
    document.removeEventListener('bridge:load-channels', onServerChange);
    document.removeEventListener('bridge:auth-success', onServerChange);
    document.removeEventListener('bridge:auth-logout', onServerChange);
  });
</script>

{#if isOwner}
  <button
    type="button"
    class="h-btn tooltip server-settings-opener"
    data-tip={t('sso_open_settings', 'Sunucu ayarlarını aç')}
    aria-label={t('sso_open_settings', 'Sunucu ayarlarını aç')}
    onclick={open}
  >
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor"
         stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
      <circle cx="12" cy="12" r="3"/>
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.36.4.66.73.87.31.2.67.31 1.04.31H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
    </svg>
  </button>
{/if}
