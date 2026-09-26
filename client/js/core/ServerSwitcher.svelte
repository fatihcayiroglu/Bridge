<!-- client/js/core/ServerSwitcher.svelte -->
<!-- Sprint 116 — servers.ts → Svelte 5 Runes (ADR-0008 Faz 3) -->
<!-- Sunucu değiştirici ve liste paneli -->
<!--
  Faz 2 (toparlama): Sunucu rail'inin sahibi.

  Legacy karşılıkları (yalnızca davranış referans alındı, kod import edilmedi):
    historical server-switcher implementation (removed):190-195  loadServers()
    historical server-switcher implementation (removed):197-230  renderServerList()
    historical server-switcher implementation (removed):232-281  selectServer()

  Kapsam sınırı: kanal/üye yükleme Faz 3'e ait. Burada yalnızca
  bridge:load-channels / bridge:load-members olayları yayılır — legacy'nin
  (servers.ts:300-306) kullandığı adların aynısı, yeni sözleşme uydurulmadı.

  State sahibi AppState'tir; burada yerel kopya tutulmaz, seçim
  BridgeRegistry.call('setCurrentServer') ile merkeze yazılır.
-->
<script lang="ts">
  import { identityBackground, readableTextOn } from './avatar-color.ts';
  import { t, localeTag} from './i18n/reactive.svelte.ts';
  import { onDestroy, type Snippet } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { getAPI } from './globals.js';
  import { readToken } from './auth-compat.js';
  import { apiFetch } from './api-fetch.js';
  const log = createLogger('ServerSwitcher');

  let { children }: { children?: Snippet } = $props();

  interface RailServer {
    _id: string;
    name?: string;
    icon?: string;
    iconUrl?: string | null;
    [key: string]: unknown;
  }

  let servers    = $state<RailServer[]>([]);
  let activeId   = $state<string | null>(null);
  let isLoading  = $state(false);
  let loadError  = $state('');

  // Faz 10.11 — uçuştaki yükleme sırasında gelen yenileme isteği DÜŞÜRÜLMEZ,
  // sıraya alınır. Discover'dan katılım (DiscoverPanel.svelte:223) sayfayı
  // yenilemeden yalnızca `loadServers` çağırır; istek düşürülürse yeni
  // katılınan sunucu rail'e hiç gelmez (sessiz no-op).
  let pendingReload = false;

  // ── Sunucu listesi ─────────────────────────────────────────────────────────
  async function loadServers(): Promise<void> {
    const token = readToken();
    if (!token) return; // Oturum yok — bridge:auth-success beklenir.
    if (isLoading) { pendingReload = true; return; }

    isLoading = true;
    loadError = '';

    try {
      // Faz 4: apiFetch → 401'de access token'ı yeniler ve isteği bir kez tekrarlar.
      const response = await apiFetch(`${getAPI()}/api/servers`);

      if (!response.ok) {
        log.warn('Sunucu listesi isteği başarısız', { status: response.status });
        throw new Error('server-list-load-failed');
      }

      const data = await response.json() as unknown;
      servers = Array.isArray(data) ? data as RailServer[] : [];
      log.info(`${servers.length} sunucu yüklendi`);

      // Legacy servers.ts:194 — ilk sunucu otomatik seçilir.
      const stillThere = servers.some(s => s._id === activeId);
      if (!stillThere) activeId = null;
      if (!activeId && servers[0]) selectServer(servers[0]);
    } catch (error) {
      log.error('Sunucu listesi yüklenemedi', error);
      loadError = t('error_generic', 'Bir hata oluştu. Lütfen tekrar dene.');
    } finally {
      isLoading = false;
      if (pendingReload) {
        pendingReload = false;
        void loadServers();   // sıradaki yenileme — sunucu gerçeğine yakınsa
      }
    }
  }

  // ── Sunucu seçimi ──────────────────────────────────────────────────────────
  function selectServer(server: RailServer): void {
    if (!server?._id) return;

    activeId = server._id;

    // Tek state kaynağı: AppState. globals.ts proxy'leri de bunu okur.
    BridgeRegistry.call('setCurrentServer', server);

    // Legacy servers.ts:261-262 — kanal kenar çubuğu başlığı.
    const nameEl = document.getElementById('sidebar-server-name');
    if (nameEl) nameEl.textContent = server.name?.trim() || 'Bridge';

    // Faz 3 dikişi: kanal/üye yükleme bu olayları dinleyecek (legacy ile aynı adlar).
    document.dispatchEvent(new CustomEvent('bridge:load-channels', { detail: { serverId: server._id } }));
    document.dispatchEvent(new CustomEvent('bridge:load-members',  { detail: { serverId: server._id } }));

    log.info(`Sunucu seçildi: ${server.name?.trim() || server._id}`);
  }

  function iconStyle(server: RailServer): string {
    if (server.iconUrl) {
      // Legacy servers.ts:208-212 ile aynı görsel davranış.
      return `background-image:url(${getAPI()}${server.iconUrl});background-size:cover;background-position:center`;
    }
    // Özel bir emoji seçilmişse ikon arka planı boş kalır (emoji ortalanır).
    if (hasCustomIcon(server)) return '';
    // Sanat eseri yoksa: baş harf + DETERMİNİSTİK tonlu arka plan. Böylece
    // her sunucu görsel olarak ayırt edilir; "aynı 🌐 duvarı" ortadan kalkar.
    // Arka plan ÜRETİLEN bir kimlik rengidir (her chat uygulamasındaki avatar
    // renkleri gibi TEMADAN BAĞIMSIZDIR); bu yüzden ön plan da sabit-açık
    // olmalıdır. Sabit bg+fg kimlik çifti birlikte satır-içinde verilir —
    // token katmanı (tema ile dönen `--text-on-solid`) buraya UYMAZ, çünkü
    // arka plan ışık temasında da koyu kalır.
    // ÖLÇÜLEN KUSUR (Final20): ön plan SABİT `#fff` idi. Arka plan sunucu
    // id'sinden ÜRETİLİYOR, yani orta parlaklıkta tonlar da çıkıyor ve beyaz
    // baş harfler WCAG 1.4.3 (AA, 4.5:1) altına düşüyordu. axe ile canlı
    // ölçüldü — `.server-initials` için 3.1–3.5:1 aralığında ihlaller:
    // #ffffff üzerine #468a38, #8a7d38, #388a7d, #8a8438 ...
    // Mürekkep artık arka planın BAĞIL PARLAKLIĞINDAN hesaplanır; üretilen
    // her ton için doğru sonucu verir, bugünkü palete özel bir yama değildir.
    const identity = serverFallbackColor(server._id);
    return `background:${identity};color:${readableTextOn(identity)}`;
  }

  // ── SUNUCU KİMLİĞİ FALLBACK'İ (v1.124.1) ──────────────────────────────────
  // CANLI ÜRÜNDE GÖZLENDİ: sunucu rayında düzinelerce AYNI 🌐 ikonu vardı.
  // Sebep hata değil, VARSAYILAN: sunucu oluşturma `icon`u '🌐' yapıyor
  // (server tarafı). Sanat eseri olmayan meşru sunucular böylece ayırt
  // edilemez bir globe duvarına dönüşüyordu.
  //
  // Çözüm: iconUrl VE özel emoji yoksa, sunucu ADINDAN türetilmiş baş harf(ler)
  // ve id'den türetilmiş kararlı bir renk gösterilir. Meşru sunucular gizlenmez;
  // yalnızca ayırt edilebilir hâle gelir. Kullanıcının SEÇTİĞİ bir emoji (globe
  // dâhil değil, çünkü o varsayılandır) korunur.

  /** Özel (varsayılan olmayan) bir emoji ikonu var mı? */
  function hasCustomIcon(server: RailServer): boolean {
    const icon = typeof server.icon === 'string' ? server.icon.trim() : '';
    return icon !== '' && icon !== '🌐';
  }

  /** Sunucu adından 1–2 harflik kimlik. Unicode/emoji güvenli, boşsa '#'. */
  function serverInitials(name: string | undefined): string {
    const words = String(name ?? '').trim().split(/[\s\-_]+/).filter(Boolean);
    if (!words.length) return '#';
    const first = [...words[0]][0] ?? '';
    const second = words.length > 1 ? ([...words[1]][0] ?? '') : '';
    const initials = (first + second) || first || '#';
    return initials.toLocaleUpperCase(localeTag());
  }

  /**
   * id'den kararlı bir kimlik arka planı.
   *
   * Açıklık SABİT DEĞİLDİR: `identityBackground()` beyaz metnin WCAG AA'yı
   * geçtiği ilk açıklığı ÖLÇEREK bulur. Sabit `%38` bazı tonlarda (sarı-yeşil)
   * 4.2–4.3:1 veriyordu — AA altı. Ton ve doygunluk korunur.
   */
  function serverFallbackColor(id: string): string {
    let hash = 0;
    for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    return identityBackground(hash % 360);
  }

  // ── Boot ───────────────────────────────────────────────────────────────────
  function onAuthSuccess(): void { void loadServers(); }
  document.addEventListener('bridge:auth-success', onAuthSuccess);

  // Faz 10.11 — KULLANICI İZOLASYONU (Faz 10.7 sahiplik kuralı).
  // Rail çıkışta unmount EDİLMEZ; bu yüzden kendi özel durumunu kendisi
  // temizler. Aksi hâlde A'nın sunucu adları çıkıştan sonra ekranda kalır ve
  // B'nin yüklemesi başarısız olursa B'nin oturumuna taşınır.
  function onLogout(): void {
    servers       = [];
    activeId      = null;
    loadError     = '';
    pendingReload = false;
  }
  document.addEventListener('bridge:auth-logout', onLogout);

  // DiscoverPanel.svelte:224 ve discover-svelte.ts:74 zaten bu adı çağırıyor.
  BridgeRegistry.register('loadServers', () => { void loadServers(); });
  // Universal Command Palette yalnız salt-okunur bir görünüm alır; seçim
  // hâlâ bu bileşenin `selectServer` kanonik eyleminden geçer.
  BridgeRegistry.register('getAvailableServers', () => servers);
  BridgeRegistry.register('selectServer', (server: RailServer) => selectServer(server));

  // Geç mount / session restore: oturum zaten açıksa hemen yükle.
  void loadServers();

  onDestroy(() => {
    document.removeEventListener('bridge:auth-success', onAuthSuccess);
    document.removeEventListener('bridge:auth-logout', onLogout);
    BridgeRegistry.unregister('loadServers');
    BridgeRegistry.unregister('getAvailableServers');
    BridgeRegistry.unregister('selectServer');
  });
</script>

{#each servers as server (server._id)}
  <button
    type="button"
    class="server-icon tooltip"
    class:active={server._id === activeId}
    data-tip={server.name?.trim() || ''}
    data-id={server._id}
    style={iconStyle(server)}
    aria-current={server._id === activeId ? 'true' : undefined}
    aria-label={server.name?.trim() || t("cp_category_server")}
    onclick={() => selectServer(server)}
  >
    <span class="pill"></span>
    {#if !server.iconUrl}{#if hasCustomIcon(server)}{server.icon}{:else}<span class="server-initials" aria-hidden="true">{serverInitials(server.name)}</span>{/if}{/if}
    <!-- FAZ 8/2 — SUNUCU OKUNMAMIŞ ROZETİ ÇAPASI.
         Sayaç sahibi `unread-svelte.ts`tir; rail ikinci bir sayım yapmaz,
         yalnızca boyanacak yeri sağlar (ChannelItem'daki `#unread-<id>` ile
         aynı desen). -->
    <span class="srv-unread" data-server-unread={server._id} style="display:none"></span>
  </button>
{/each}

{#if loadError}
  <button
    type="button"
    class="server-icon tooltip"
    data-tip={t('sw_load_failed')}
    aria-label={t('sw_load_failed', 'Sunucular yüklenemedi, yeniden dene')}
    onclick={() => void loadServers()}
  >⚠</button>
{/if}

<!-- Faz 12 sonrası — KEŞFET AÇICISI.
     DiscoverPanel gerçek bir uygulamaydı ama onu açacak TEK bir kontrol bile
     yoktu. Rail, Discord benzeri ürünlerde keşfin doğal yeridir; panel kendi
     görünürlüğünü yönettiği için burada yalnızca registry çağrısı yapılır. -->
<button
  type="button"
  class="server-icon tooltip discover-btn"
  data-tip={t('sw_discover', 'Toplulukları Keşfet')}
  aria-label={t('sw_discover', 'Toplulukları Keşfet')}
  onclick={() => BridgeRegistry.call('showDiscoverPanel')}
>🧭</button>

{@render children?.()}

<style>
  /* FAZ 8/2 — okunmamış rozeti. Bahsetme RENKTEN başka işaret de taşır:
     `aria-label` "bahsedilme var" der ve rozet daha belirgin çizilir. */
  .srv-unread {
    position: absolute;
    inset-block-end: -2px;
    inset-inline-end: -2px;
    display: grid;
    place-items: center;
    min-width: 18px;
    height: 18px;
    padding: 0 5px;
    font-size: var(--type-badge, 11px);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    color: var(--text-on-solid);
    background: var(--bg-5, #363b54);
    border: 2px solid var(--surface-rail, var(--bg-1));
    border-radius: var(--radius-pill, 999px);
  }
  /* `:global` ZORUNLU: `has-mention` sinifi calisma aninda `classList.toggle`
     ile eklenir (unread-svelte.ts), derleyici onu sablonda goremez ve kurali
     kullanilmiyor sanip ELER. */
  :global(.srv-unread.has-mention) { background: var(--danger); }

  /* Yalnızca <button> varsayılanlarını sıfırlar; görsel dil layout.css'teki
     .server-icon kuralından gelir (yeni tasarım tanımlanmadı). */
  .server-icon {
    border: 0;
    font-family: inherit;
    -webkit-appearance: none;
    appearance: none;
  }

  /* Sanat eseri olmayan sunucular için baş-harf kimliği. Arka plan rengi
     `iconStyle()` tarafından id'den deterministik olarak verilir; buradaki
     metin her tonda okunur kalsın diye açık ve kalındır. */
  .server-initials {
    font-size: var(--type-server-initials, 17px);
    font-weight: 700;
    letter-spacing: 0.3px;
    line-height: 1;
    /* Ön plan rengi (sabit-açık) `iconStyle()` içinde üretilen kimlik arka
       planıyla BİRLİKTE satır-içinde verilir; tema-dönen token katmanına ait
       değildir. Burada rengi baştan tanımlamayız — button'dan miras alınır. */
    user-select: none;
  }
</style>
