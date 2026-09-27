<!-- client/js/core/EmptyServerStart.svelte -->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { onMount, onDestroy, tick } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { ApiResponseError, safeApiErrorMessage } from './api-error.ts';

  const log = createLogger('EmptyServerStart');

  type Mode = 'home' | 'create' | 'join' | 'qr';

  interface ServerRecord {
    _id: string;
    name?: string;
  }

  interface BarcodeResult {
    rawValue?: string;
  }

  interface BarcodeDetectorLike {
    detect(source: HTMLVideoElement): Promise<BarcodeResult[]>;
  }

  type BarcodeDetectorCtor = new (options: { formats: string[] }) => BarcodeDetectorLike;

  let isVisible = $state(false);
  let isLoading = $state(false);
  let isSubmitting = $state(false);
  let mode = $state<Mode>('home');
  let errorMessage = $state('');
  let statusMessage = $state('');

  let serverName = $state('');
  let serverIcon = $state('🌐');
  let inviteInput = $state('');

  let videoEl: HTMLVideoElement | undefined = $state();
  let mediaStream: MediaStream | null = null;
  let scanTimer: number | null = null;
  let isScanning = $state(false);
  let cameraMessage = $state('');
  let refreshGeneration = 0;
  let operationGeneration = 0;
  let qrGeneration = 0;

  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    const apiFetch = BridgeRegistry.get<(url: string, options?: RequestInit) => Promise<Response>>('apiFetch');
    if (!apiFetch) throw new Error(t("ui_guvenli_api_istemcisi_kullanilamiyor_lutfen_yeniden_", "Güvenli API istemcisi kullanılamıyor. Lütfen yeniden giriş yap."));
    return apiFetch(path, init);
  }

  async function postJson(path: string, body: unknown): Promise<Response> {
    return request(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  }


  // ÜRÜN KURALI: HESAP != SUNUCU ÜYELİĞİ.
  // Bu ekran eskiden `servers.length === 0` olduğunda kapatılamaz tam ekran bir
  // modal olarak açılıyordu (aria-modal, z-index 10000) ve içinde tek bir
  // kapat/atla kontrolü YOKTU. Sonuç: yeni kayıt olan bir kullanıcı, bir
  // sunucuya katılmadan veya kurmadan uygulama kabuğuna HİÇ ulaşamıyordu.
  // Sıfır sunuculu kullanıcı meşrudur; bu yüzden ekran artık kapatılabilir ve
  // kapatıldıktan sonra oturum boyunca kendiliğinden geri gelmez.
  let dismissed = $state(false);

  function dismiss(): void {
    refreshGeneration += 1;
    operationGeneration += 1;
    isLoading = false;
    isSubmitting = false;
    stopQrScanner();
    dismissed  = true;
    isVisible  = false;
  }

  function onKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape' && isVisible) dismiss();
  }

  async function refreshEmptyState(): Promise<void> {
    const generation = ++refreshGeneration;
    const me = BridgeRegistry.get<() => { _id?: string; id?: string } | null>('getMe')?.();
    if (!me?._id && !me?.id) {
      isVisible = false;
      return;
    }
    // Kullanıcı bilinçli olarak kapattıysa tekrar dayatma.
    if (dismissed) { isVisible = false; return; }

    isLoading = true;
    errorMessage = '';

    try {
      const response = await request('/api/servers');
      if (generation !== refreshGeneration || dismissed) return;

      if (response.status === 401) {
        isVisible = false;
        return;
      }

      if (!response.ok) throw new ApiResponseError(response);

      const servers = await response.json() as ServerRecord[];
      if (generation !== refreshGeneration || dismissed) return;
      const empty = Array.isArray(servers) && servers.length === 0;
      // Final21 Faz 19: bu KENDİLİĞİNDEN açılan bir karşılamadır (girişten 800 ms sonra).
      // Kişi o arada başka bir pencere açtıysa (ör. Ayarlar) kart onun ÜSTÜNE iniyor, odağı
      // çalıyor ve yaptığı işi kesiyordu (gerçek tarayıcıda ölçüldü). Açık bir iletişim
      // kutusu varken beklenir; kapanınca liste yeniden sorulup gösterilir.
      if (empty && !isVisible && anotherModalOpen()) {
        deferUntilNoModal();
        return;
      }
      isVisible = empty;

      if (isVisible) {
        mode = 'home';
        statusMessage = '';
      }
    } catch (error) {
      if (generation !== refreshGeneration || dismissed) return;
      // ══════════════════════════════════════════════════════════════════
      // KAPATILAN GERÇEK KUSUR — AĞ HATASINDA TAM EKRAN DUVAR
      // ══════════════════════════════════════════════════════════════════
      // Burada `isVisible = true` vardı. Yani `/api/servers` HERHANGİ bir
      // sebeple başarısız olursa (uyku/uyanma, wifi geçişi, anlık 5xx,
      // zaman aşımı) kullanıcı — SUNUCULARI VARKEN — tıklamaları yutan
      // tam ekran "ilk sunucunu oluştur" duvarının arkasında kalıyordu.
      //
      // ÖLÇÜLEN ETKİ (30 adımlık günlük yolculuk, adım 25): 1.5 sn'lik bir
      // çevrimdışı aralıktan sonra `.empty-server-backdrop` sunucu rayını
      // örttü; tıklama `document.elementFromPoint` ile doğrulandı.
      //
      // BAŞARISIZ İSTEK, "SUNUCUN YOK" KANITI DEĞİLDİR. Çalışan uygulamanın
      // üstüne duvar İNMEZ; hata yalnızca ZATEN bu ekranda olana gösterilir.
      if (isVisible) {
        errorMessage = safeApiErrorMessage(error, t('esr_list_failed', 'Sunucu listen yüklenemedi.'), { report: true });
      }

      // Gerçekten sunucusu OLMAYAN yeni kullanıcı, geçici bir hata yüzünden
      // karşılama ekranını tamamen kaybetmesin: sınırlı bir kez yeniden dene
      // ve ağ geri geldiğinde tekrar bak.
      scheduleRetry();
    } finally {
      if (generation === refreshGeneration) isLoading = false;
    }
  }

  /**
   * Sınırlı yeniden deneme.
   *
   * `refreshEmptyState` yalnızca mount'ta çağrılıyordu; tek bir başarısızlık
   * kalıcı sonuç doğuruyordu. Sonsuz döngü YOK: en fazla iki deneme ve
   * `online` olayında bir kez daha.
   */
  let retriesLeft = 2;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleRetry(): void {
    if (dismissed || retriesLeft <= 0 || retryTimer) return;
    retriesLeft -= 1;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      void refreshEmptyState();
    }, 4_000);
  }

  /** Kullanıcının açtığı başka bir modal iletişim kutusu ekranda mı? */
  function anotherModalOpen(): boolean {
    const shown = (el: HTMLElement): boolean => {
      for (let node: HTMLElement | null = el; node; node = node.parentElement) {
        if (node.hidden) return false;
        const style = getComputedStyle(node);
        if (style.display === 'none' || style.visibility === 'hidden') return false;
      }
      return true;
    };
    return [...document.querySelectorAll<HTMLElement>('[role="dialog"][aria-modal="true"]')]
      .some((el) => !el.classList.contains('empty-server-backdrop') && shown(el));
  }

  let deferTimer: ReturnType<typeof setTimeout> | null = null;

  function deferUntilNoModal(): void {
    if (deferTimer) return;
    deferTimer = setTimeout(() => {
      deferTimer = null;
      if (dismissed || isVisible) return;
      if (anotherModalOpen()) { deferUntilNoModal(); return; }
      void refreshEmptyState();
    }, 1_000);
  }

  function onBackOnline(): void {
    if (dismissed) return;
    retriesLeft = Math.max(retriesLeft, 1);
    void refreshEmptyState();
  }

  function extractInviteCode(value: string): string {
    const trimmed = value.trim();

    const inviteUrl = trimmed.match(/(?:bridge:\/\/invite\/|\/invite\/)([A-Za-z0-9_-]{1,64})/i);
    if (inviteUrl?.[1]) return inviteUrl[1];

    return trimmed.replace(/[^\w-]/g, '').slice(0, 64);
  }

  function selectMode(nextMode: Mode): void {
    operationGeneration += 1;
    isSubmitting = false;
    errorMessage = '';
    statusMessage = '';

    if (mode === 'qr' && nextMode !== 'qr') stopQrScanner();
    mode = nextMode;

    if (nextMode === 'qr') void startQrScanner();
  }

  async function createServer(): Promise<void> {
    const name = serverName.trim();

    if (!name) {
      errorMessage = t("ui_sunucuna_bir_ad_ver", "Sunucuna bir ad ver.");
      return;
    }

    isSubmitting = true;
    errorMessage = '';
    const generation = ++operationGeneration;

    try {
      const response = await postJson('/api/servers', {
        name,
        icon: serverIcon.trim() || '🌐',
      });
      if (generation !== operationGeneration || !isVisible || mode !== 'create') return;

      if (!response.ok) throw new ApiResponseError(response);

      statusMessage = t("ui_sunucun_olusturuldu_aciliyor", "Sunucun oluşturuldu. Açılıyor…");
      window.location.reload();
    } catch (error) {
      if (generation !== operationGeneration || !isVisible || mode !== 'create') return;
      errorMessage = safeApiErrorMessage(error, t('esr_create_failed', 'Sunucu oluşturulamadı. Tekrar dene.'), { report: true });
    } finally {
      if (generation === operationGeneration) isSubmitting = false;
    }
  }

  async function joinByInvite(value = inviteInput): Promise<void> {
    const code = extractInviteCode(value);

    if (!code) {
      errorMessage = t('esr_bad_invite', 'Geçerli bir davet kodu veya davet bağlantısı gir.');
      return;
    }

    isSubmitting = true;
    errorMessage = '';
    const generation = ++operationGeneration;

    try {
      const response = await postJson(`/api/servers/invites/${encodeURIComponent(code)}/use`, {});
      if (generation !== operationGeneration || !isVisible || mode !== 'join') return;

      if (!response.ok) throw new ApiResponseError(response);

      stopQrScanner();
      statusMessage = t("ui_sunucuya_katildin_aciliyor", "Sunucuya katıldın. Açılıyor…");
      window.location.reload();
    } catch (error) {
      if (generation !== operationGeneration || !isVisible || mode !== 'join') return;
      errorMessage = safeApiErrorMessage(error, t('esr_join_failed', 'Sunucuya katılınamadı. Davet kodunu kontrol edip tekrar dene.'), { report: true });
    } finally {
      if (generation === operationGeneration) isSubmitting = false;
    }
  }

  function stopQrScanner(): void {
    qrGeneration += 1;
    isScanning = false;

    if (scanTimer !== null) {
      window.clearTimeout(scanTimer);
      scanTimer = null;
    }

    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;

    if (videoEl) videoEl.srcObject = null;
  }

  async function startQrScanner(): Promise<void> {
    stopQrScanner();
    const generation = qrGeneration;
    cameraMessage = '';
    await tick();
    if (generation !== qrGeneration || mode !== 'qr' || !isVisible) return;

    const Detector = (globalThis as unknown as {
      BarcodeDetector?: BarcodeDetectorCtor;
    }).BarcodeDetector;

    if (!Detector || !navigator.mediaDevices?.getUserMedia) {
      cameraMessage = t("ui_bu_cihazda_kamera_ile_qr_tarama_desteklenmiyor_davet", "Bu cihazda kamera ile QR tarama desteklenmiyor. Davet kodunu aşağıya yapıştırabilirsin.");
      return;
    }

    if (!videoEl) {
      cameraMessage = t("ui_kamera_gorunumu_hazirlanamadi_davet_kodunu_yapistira", "Kamera görünümü hazırlanamadı. Davet kodunu yapıştırabilirsin.");
      return;
    }

    let acquiredStream: MediaStream | null = null;
    try {
      const detector = new Detector({ formats: ['qr_code'] });

      acquiredStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' } },
      });
      if (generation !== qrGeneration || mode !== 'qr' || !isVisible) {
        acquiredStream.getTracks().forEach((track) => track.stop());
        return;
      }
      mediaStream = acquiredStream;

      videoEl.srcObject = mediaStream;
      await videoEl.play();
      if (generation !== qrGeneration || mode !== 'qr' || !isVisible) {
        stopQrScanner();
        return;
      }
      isScanning = true;

      const scanFrame = async (): Promise<void> => {
        if (generation !== qrGeneration || !isScanning || !videoEl || mode !== 'qr') return;

        try {
          const results = await detector.detect(videoEl);
          if (generation !== qrGeneration || !isScanning || mode !== 'qr') return;
          const value = results.find((result) => result.rawValue?.trim())?.rawValue;

          if (value) {
            stopQrScanner();
            inviteInput = value;
            mode = 'join';
            await joinByInvite(value);
            return;
          }
        } catch (error) {
          log.warn('QR scan frame failed', error);
        }

        if (generation === qrGeneration && isScanning) scanTimer = window.setTimeout(() => void scanFrame(), 250);
      };

      void scanFrame();
    } catch (error) {
      if (generation !== qrGeneration || mode !== 'qr' || !isVisible) {
        if (acquiredStream && acquiredStream !== mediaStream) {
          acquiredStream.getTracks().forEach((track) => track.stop());
        }
        return;
      }
      log.warn('QR kamera açılamadı', error);
      const name = error instanceof DOMException ? error.name : '';
      cameraMessage = name === 'NotAllowedError'
        ? t('esr_camera_denied', 'Kamera izni verilmedi. Tarayıcı izinlerini kontrol et veya davet kodunu yapıştır.')
        : name === 'NotFoundError'
          ? t('esr_camera_missing', 'Kullanılabilir kamera bulunamadı. Davet kodunu yapıştırabilirsin.')
          : t('esr_camera_failed', 'Kamera açılamadı. Davet kodunu yapıştırabilirsin.');
      stopQrScanner();
    }
  }

  onMount(() => {
    BridgeRegistry.register('checkEmptyServerStart', refreshEmptyState);
    BridgeRegistry.register('openServerStart', () => {
      // Açıkça istendiğinde (ör. rail'deki "Sunucu Ekle") tekrar açılabilir —
      // kapatılmış olması kalıcı bir yasak değildir.
      dismissed = false;
      refreshGeneration += 1;
      operationGeneration += 1;
      isVisible = true;
      isLoading = false;
      isSubmitting = false;
      mode = 'home';
      errorMessage = '';
      statusMessage = '';
    });
    BridgeRegistry.register('closeServerStart', dismiss);
    window.addEventListener('keydown', onKeydown);
    window.addEventListener('online', onBackOnline);
    void refreshEmptyState();
  });

  onDestroy(() => {
    refreshGeneration += 1;
    operationGeneration += 1;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (deferTimer) { clearTimeout(deferTimer); deferTimer = null; }
    window.removeEventListener('online', onBackOnline);
    stopQrScanner();
    BridgeRegistry.unregister?.('checkEmptyServerStart');
    BridgeRegistry.unregister?.('openServerStart');
    BridgeRegistry.unregister?.('closeServerStart');
    window.removeEventListener('keydown', onKeydown);
  });
</script>

{#if isVisible}
  <div class="empty-server-backdrop" role="dialog" aria-modal="true" aria-label={t('start_screen', 'Bridge başlangıç ekranı')} use:focusTrap>
    <section class="empty-server-card">
      <button
        type="button"
        class="ess-close"
        aria-label={t('attr_kapat_ve_uygulamaya_devam_et_19e5edc', "Kapat ve uygulamaya devam et")}
        onclick={dismiss}
      >✕</button>
      <div class="brand">🌉</div>

      {#if isLoading}
        <h1>{t('start_checking', 'Sunucuların kontrol ediliyor…')}</h1>
        <p>{t('start_preparing', 'Bridge toplulukların hazırlanıyor.')}</p>
      {:else if mode === 'home'}
        <h1>{t('start_no_servers', 'Henüz bir sunucun yok')}</h1>
        <p class="intro">
          {t('markup_kendi_toplulugunu_olustur_veya_bir_arkadasinin_d_78fe4f4', "Kendi topluluğunu oluştur veya bir arkadaşının davetiyle mevcut bir sunucuya katıl.")}
        </p>

        <div class="actions">
          <button class="primary" onclick={() => selectMode('create')}>
            <span>＋</span>
            {t('create_server')}
          </button>
          <button class="secondary" onclick={() => selectMode('join')}>
            <span>🔗</span>
            {t('markup_davet_koduyla_katil_a80ff9a', "Davet Koduyla Katıl")}
          </button>
          <button class="secondary" onclick={() => selectMode('qr')}>
            <span>▣</span>
            {t('markup_qr_kod_tara_9e2a6f0', "QR Kod Tara")}
          </button>
        </div>
      {:else if mode === 'create'}
        <button class="back" onclick={() => selectMode('home')}>{t('back')}</button>
        <h1>{t('start_create_server', 'Sunucunu oluştur')}</h1>
        <p class="intro">{t('markup_ilk_olarak_adini_ve_ikonunu_belirle_sonra_kanal__9bd7034', "İlk olarak adını ve ikonunu belirle. Sonra kanal, rol ve davetlerini yönetebilirsin.")}</p>

        <label for="new-server-name">{t('start_server_name', 'Sunucu adı')}</label>
        <input
          id="new-server-name"
          bind:value={serverName}
          maxlength="50"
          placeholder={t('start_name_ph', 'Örn. Oyun Ekibi')}
          onkeydown={(event) => { if (event.key === 'Enter') void createServer(); }}
        />

        <label for="new-server-icon">{t('start_icon', 'İkon')}</label>
        <input
          id="new-server-icon"
          class="icon-input"
          bind:value={serverIcon}
          maxlength="10"
          placeholder="🌐"
        />

        <button class="primary" disabled={isSubmitting} onclick={() => void createServer()}>
          {isSubmitting ? t("surface_olusturuluyor_8d7aee") : t("create_server")}
        </button>
      {:else if mode === 'join'}
        <button class="back" onclick={() => selectMode('home')}>{t('back')}</button>
        <h1>{t('start_join_server', 'Sunucuya katıl')}</h1>
        <p class="intro">{t('start_paste_invite', 'Davet kodunu veya tam davet bağlantısını yapıştır.')}</p>

        <label for="invite-code">{t('invite_code')}</label>
        <input
          id="invite-code"
          bind:value={inviteInput}
          maxlength="512"
          placeholder={t('start_invite_ph', 'örn. a1b2c3d4 veya https://…/invite/a1b2c3d4')}
          onkeydown={(event) => { if (event.key === 'Enter') void joinByInvite(); }}
        />

        <button class="primary" disabled={isSubmitting} onclick={() => void joinByInvite()}>
          {isSubmitting ? t("surface_kat_l_n_yor_f22aa0") : t("join_server")}
        </button>

        <button class="text-action" onclick={() => selectMode('qr')}>{t('markup_bunun_yerine_qr_kod_tara_cf46034', "Bunun yerine QR kod tara")}</button>
      {:else}
        <button class="back" onclick={() => selectMode('home')}>{t('back')}</button>
        <h1>{t('markup_qr_kod_tara_f6da671', "QR kod tara")}</h1>
        <p class="intro">{t('start_show_qr', 'Arkadaşının Bridge davet QR kodunu kameraya göster.')}</p>

        <video class="scanner" bind:this={videoEl} autoplay muted playsinline></video>

        {#if cameraMessage}
          <p class="camera-message">{cameraMessage}</p>
        {:else if isScanning}
          <p class="camera-message">{t('start_camera_on', 'Kamera açık. QR kodu çerçeveye getir.')}</p>
        {/if}

        <button class="secondary" onclick={() => selectMode('join')}>
          {t('markup_davet_kodunu_yapistir_535c7a0', "Davet kodunu yapıştır")}
        </button>
      {/if}

      {#if errorMessage}
        <p class="message error" role="alert">{errorMessage}</p>
      {/if}

      {#if statusMessage}
        <p class="message success" role="status">{statusMessage}</p>
      {/if}
    </section>
  </div>
{/if}

<style>
  .ess-close {
    position: absolute;
    top: 12px;
    right: 14px;
    width: 32px;
    height: 32px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary, #9aa4b2);
    font-size: 16px;
    cursor: pointer;
    background: transparent;
    border: 1px solid var(--border, #2a2f3a);
    border-radius: 50%;
  }
  .ess-close:hover { color: var(--text-primary, var(--text-on-solid)); background: var(--bg-4, #232838); }
  .ess-close:focus-visible { outline: 2px solid var(--focus-ring, #2d9cdb); outline-offset: 2px; }

  .empty-server-backdrop {
    position: fixed;
    inset: 0;
    /* Bu bir MODAL yuzeydir, en ust katman DEGIL: tanitim turu (`--z-onboard`)
       onun da ustunde kalmalidir. Onceki `10000` sabiti tam tersini yapiyordu. */
    z-index: var(--z-modal, 300);
    display: grid;
    place-items: center;
    min-height: var(--bridge-visual-viewport-height, 100dvh);
    padding: 20px;
    overflow-y: auto;
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    backdrop-filter: blur(8px);
  }

  .empty-server-card {
    position: relative;
    width: min(100%, 460px);
    max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - 40px);
    overflow-y: auto;
    padding: 34px;
    /* Final21 UX (U-02): kart sabit KOYU bir gradyandı (#1d2336 → #131722), metin ise
       tema jetonundan geliyordu. Açık temada (işletim sistemi açıksa varsayılan) başlık
       koyu-üstü-koyu ~1.1:1 kontrastla GÖRÜNMEZDİ — yeni kullanıcının ilk gördüğü ekran.
       Gradyan arka planı axe "belirsiz" sayar, bu yüzden a11y kapıları yakalamadı.
       Kart artık diğer modal yüzeyleriyle (tanıtım turu kartı) aynı jetonları kullanır. */
    border: 1px solid var(--border);
    border-radius: 20px;
    background: var(--surface);
    color: var(--text-primary);
    box-shadow: var(--shadow-xl);
  }

  .brand {
    width: 58px;
    height: 58px;
    display: grid;
    place-items: center;
    margin-bottom: 18px;
    border-radius: 18px;
    background: var(--brand-subtle);
    font-size: 28px;
  }

  h1 {
    margin: 0 0 10px;
    font-size: 26px;
    line-height: 1.15;
  }

  .intro {
    margin: 0 0 24px;
    color: var(--text-2);
    line-height: 1.55;
  }

  .actions {
    display: grid;
    gap: 12px;
  }

  button {
    min-height: 46px;
    border: 0;
    border-radius: 11px;
    padding: 11px 14px;
    font: inherit;
    font-weight: 700;
    cursor: pointer;
  }

  button:disabled {
    cursor: wait;
    opacity: .65;
  }

  .primary {
    width: 100%;
    color: var(--text-on-solid);
    background: var(--brand);
  }

  .primary:hover:not(:disabled) {
    background: var(--brand-hover);
  }

  .secondary {
    width: 100%;
    color: var(--text-primary);
    background: var(--bg-4);
  }

  .secondary:hover {
    background: var(--bg-5);
  }

  .back,
  .text-action {
    min-height: auto;
    padding: 0;
    color: var(--text-link);
    background: transparent;
    text-align: left;
  }

  .text-action {
    display: block;
    width: 100%;
    margin-top: 14px;
    text-align: center;
  }

  label {
    display: block;
    margin: 14px 0 7px;
    color: var(--text-2);
    font-size: 14px;
    font-weight: 700;
  }

  /* ════════════════════════════════════════════════════════════════════════
     ACIK TEMADA YAZILAN METIN GORUNMUYORDU
     ════════════════════════════════════════════════════════════════════════
     KAPATILAN GERCEK KUSUR (kullanici bildirdi): sunucu adi yazilirken metin
     acik temada okunamiyordu.

     Sebep `color: var(--text-on-solid)` idi. O jeton "SOLID/marka renkli bir
     yuzeyin ustundeki metin" demektir ve acik temada BEYAZDIR
     (tokens.css:297 → #ffffff). Girisin arkaplani ise `--bg-1`, yani ACIK.
     Beyaz zemine beyaz metin.

     Dogru jeton `--text-primary`: koyu temada acik (#eef0f8), acik temada
     koyu (#1a1d2e). Kenarlik da `#3d4762` sabitiyle yaziliydi — yalnizca koyu
     temada dogru bir renk; `--border` her temada dogrudur. Odak halkasi da
     sabit rgba yerine `--focus-ring` kullanir.

     TEK SEFERLIK RENK EKLENMEDI: hepsi mevcut kanonik jetonlar. */
  input {
    width: 100%;
    box-sizing: border-box;
    min-height: 45px;
    margin-bottom: 4px;
    border: 1px solid var(--border);
    border-radius: 10px;
    padding: 10px 12px;
    outline: none;
    background: var(--bg-1);
    color: var(--text-primary);
    caret-color: var(--text-primary);
    font: inherit;
  }

  input::placeholder { color: var(--text-muted); }

  input:focus {
    border-color: var(--border-focus, var(--brand));
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--focus-ring) 25%, transparent);
  }

  input:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .icon-input {
    max-width: 100px;
  }

  .scanner {
    width: 100%;
    min-height: 210px;
    margin: 0 0 12px;
    border-radius: 13px;
    background: var(--bg-0);
    object-fit: cover;
  }

  .camera-message,
  .message {
    margin: 14px 0 0;
    text-align: center;
    line-height: 1.45;
  }

  .camera-message {
    color: var(--text-2);
  }

  .message.error {
    color: var(--danger);
  }

  .message.success {
    color: var(--success);
  }

  @media (max-width: 560px) {
    .empty-server-backdrop { align-items: flex-end; padding: 0; }
    .empty-server-card {
      width: 100%;
      max-height: min(92dvh, var(--bridge-visual-viewport-height, 92dvh));
      padding: 28px 20px calc(24px + env(safe-area-inset-bottom));
      border-right: 0; border-bottom: 0; border-left: 0;
      border-radius: var(--radius-modal) var(--radius-modal) 0 0;
    }
    .ess-close { width: 40px; height: 40px; top: 10px; right: 10px; }
    .brand { width: 52px; height: 52px; }
    h1 { padding-right: 34px; font-size: 23px; }
  }
</style>
