<!-- client/js/core/OnboardingWizard.svelte -->
<!-- Sprint 121 — Tam onboarding implementasyonu (Sprint 116 stub'ını replace eder) -->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  const log = createLogger('OnboardingWizard');

  const STORAGE_PREFIX = 'bridge_onboarding_v3';
  /**
   * Tur GECIKMELI acilir ve bu gecikme, kabugun diger ilk-calistirma
   * yuzeylerinden UZUN olmalidir.
   *
   * NEDEN: `EmptyServerStart` de kimlik dogrulamadan 800 ms sonra kontrol
   * edilir (app.ts). Ikisi ayni anda tetiklenince YARIS olusuyordu: tur
   * acilip hemen ardindan bos-sunucu modali USTUNE biniyor, odak tuzagi
   * yiginin tepesi bos-sunucu ekrani oluyordu. Sonuc: icinde odak
   * tutulamayan, faresi calismayan yarim bir tur.
   *
   * Sunucusu olmayan kullanicida DOGRU ilk yuzey bos-sunucu ekranidir
   * (eyleme gecirilebilir); tur genel bilgidir ve bekleyebilir.
   */
  const AUTO_SHOW_DELAY_MS = 1600;

  function currentUserId(): string {
    try {
      const me = BridgeRegistry.get<() => { _id?: unknown } | null>('getMe')?.();
      return typeof me?._id === 'string' && me._id.trim() ? me._id : '';
    } catch (error) {
      log.warn('Onboarding kullanıcı kapsamı okunamadı', error);
      return '';
    }
  }

  /**
   * Faz 8.1 — durum KULLANICI BAZLI tutulur.
   * Önceden tek bir global anahtar vardı: aynı tarayıcıda A kullanıcısı
   * onboarding'i tamamlayınca, sonradan giren B kullanıcısı sihirbazı hiç
   * görmüyordu (state sızıntısı). Kullanıcı bilinmiyorsa anonim anahtar
   * kullanılır ve giriş sonrası kullanıcıya özel anahtar devreye girer.
   *
   * NOT: Bu yalnızca bir UX durumudur — hiçbir yetki/izin kararı buna dayanmaz.
   */
  function storageKey(): string {
    // call() yerine get(): kayıt yoksa dev ortamında uyarı basılmasın.
    const userId = currentUserId();
    return userId ? `${STORAGE_PREFIX}:${userId}` : `${STORAGE_PREFIX}:anon`;
  }

  /**
   * Oturum var mı? Depolama sözleşmesi auth-compat.ts:36 `readToken()` ile
   * aynıdır; modül yan etkilerini test ortamına taşımamak için burada
   * yalnızca okuma yapılır. Bu bir yetki kontrolü DEĞİLDİR — sadece
   * sihirbazın giriş ekranının üstünde açılmasını engeller.
   */
  function isAuthenticated(): boolean {
    try {
      return Boolean(localStorage.getItem('token') || localStorage.getItem('bridge_token'));
    } catch {
      return false;
    }
  }

  let _autoShowTimer: ReturnType<typeof setTimeout> | null = null;
  let _transitionTimer: ReturnType<typeof setTimeout> | null = null;

  function cancelAutoShow(): void {
    if (!_autoShowTimer) return;
    clearTimeout(_autoShowTimer);
    _autoShowTimer = null;
  }

  function cancelTransition(): void {
    if (!_transitionTimer) return;
    clearTimeout(_transitionTimer);
    _transitionTimer = null;
  }

  /**
   * ════════════════════════════════════════════════════════════════════════
   * KULLANICI ZATEN CALISMAYA BASLADIYSA TURU ZORLA ACMA
   * ════════════════════════════════════════════════════════════════════════
   * KAPATILAN GERCEK KUSUR: tur, kimlik dogrulamadan 800 ms SONRA aciliyordu.
   * Kabuk o anda ZATEN etkilesime hazirdir. Kullanici bir kanala tiklamaya
   * baslamis olabilir ve tam o sirada tam ekran bir modal onune atlar:
   * tiklama calinir, odak kayar, kullanici ne oldugunu anlamaz.
   *
   * Bu, "modal tiklamalari engelliyor" seklinde raporlanan surtunmenin
   * gercek kaynagidir. Modalin KENDISI dogrudur (kapat, Atla, Esc, arkaplan
   * tiklamasi, odak tuzagi ve odak iadesi hepsi var) — sorun ZAMANLAMADIR.
   *
   * Kural: kullanici gecikme penceresinde herhangi bir sey yaptiysa tur
   * KENDILIGINDEN acilmaz. Kaybolmaz da: komut paletinden ("Tanıtım Turunu
   * Göster") her zaman acilabilir ve bir sonraki oturumda yeniden denenir.
   */
  /** Baska bir modal yuzunden kac kez ertelendi (sinirli bekleme). */
  let _deferrals = 0;
  const MAX_DEFERRALS = 20;          // ~32 sn; sonsuz dongu YOK

  let _userActed = false;
  /**
   * Yalnizca KABUKLA etkilesim turu bastirir.
   *
   * Once her tiklama sayiliyordu; ama sunucusu olmayan kullanici once
   * bos-sunucu modalini kapatir ve o TIKLAMA da "kullanici calisiyor" diye
   * yorumlanip turu kalici olarak susturuyordu. Yani en yaygin yeni-kullanici
   * yolunda tur HIC gorunmuyordu.
   *
   * Amac "kullanicinin YARIM KALAN isini bolme"dir; baska bir diyalogu
   * kapatmak yarim kalan bir is degildir.
   */
  const _markActed = (ev: Event): void => {
    const target = ev.target as HTMLElement | null;
    if (target?.closest?.('[role="dialog"]')) return;   // modal ici — kabuk degil
    _userActed = true;
    cancelAutoShow();
    removeActivityListeners();
  };
  const ACTIVITY_EVENTS = ['pointerdown', 'keydown'] as const;

  function removeActivityListeners(): void {
    for (const ev of ACTIVITY_EVENTS) document.removeEventListener(ev, _markActed, true);
  }

  function armActivityListeners(): void {
    removeActivityListeners();
    for (const ev of ACTIVITY_EVENTS) document.addEventListener(ev, _markActed, true);
  }

  /** Bu kullanıcı sihirbazı daha önce tamamlamadıysa kısa gecikmeyle göster. */
  function maybeAutoShow(): void {
    // Auth token can be restored before AppState publishes the authenticated
    // user. Never schedule against the anonymous key in that gap: wait for the
    // canonical auth-success event so completion remains user-scoped.
    const userId = currentUserId();
    if (!isAuthenticated() || !userId) return;
    const scheduledKey = storageKey();
    let seen = false;
    try { seen = Boolean(localStorage.getItem(scheduledKey)); } catch { seen = false; }
    if (seen || isVisible || _autoShowTimer || _userActed) return;
    _autoShowTimer = setTimeout(() => {
      _autoShowTimer = null;
      // Bekleme sirasinda kullanici bir sey yaptiysa ARAYA GIRME.
      if (_userActed) return;
      // Oturum/kimlik bu zamanlayıcı kurulurkenki kapsamdan değiştiyse eski
      // kullanıcının uygunluk kararı yeni kullanıcıya taşınamaz.
      if (!isAuthenticated() || storageKey() !== scheduledKey) return;
      try { if (localStorage.getItem(scheduledKey)) return; } catch { /* gösterim yine güvenlidir */ }

      // ── BASKA BIR MODAL ACIKSA BEKLE (VAZGECME) ─────────────────────────
      // Sunucusu olmayan yeni kullanicida `EmptyServerStart` de modal olarak
      // acilir. Ikisi ust uste bindiginde odak tuzagi yiginin TEPESINI
      // uygular (bos-sunucu ekrani) ve tur, icinde odak tutamayan, faresi
      // calismayan yarim bir diyalog haline gelirdi.
      //
      // Tur ARAYA GIREN taraftir, bu yuzden sirasini bekler. VAZGECMEZ:
      // vazgecseydi, en yaygin yeni-kullanici yolunda (hic sunucusu yok)
      // tur HIC gorunmezdi. Diger yuzey kapaninca acilir.
      if (document.querySelector('[role="dialog"][aria-modal="true"]')) {
        if (_deferrals++ < MAX_DEFERRALS) maybeAutoShow();
        return;
      }
      show();
    }, AUTO_SHOW_DELAY_MS);
  }

  function onAuthSuccess(): void {
    // Giriş sonrası `getMe` dolduğunda kullanıcıya özel anahtar okunur.
    cancelAutoShow();
    _deferrals = 0;
    _userActed = false;
    armActivityListeners();
    maybeAutoShow();
  }

  function onAuthLogout(): void {
    cancelAutoShow();
    cancelTransition();
    isVisible = false;
    step = 0;
    animating = false;
    _deferrals = 0;
    _userActed = false;
    armActivityListeners();
  }

  interface Step {
    icon:  'bridge' | 'invite' | 'bot' | 'voice' | 'keyboard' | 'check';
    title: string;
    body:  string;
    tip?:  string;
  }

  // Final21 UX (U-05) — tur 8 adımdan 6 adıma indi ve her iddia koda karşı doğrulandı.
  // Kaldırılanlar YANLIŞTI, yalnız fazla değil:
  //   · "DM penceresinde kilit simgesine tıkla" (E2EE): o denetim Faz 11'de ürün yüzeyinden
  //     bilerek kaldırıldı (doğrulanmamış güvenlik güvencesi) — tur her yeni kullanıcıya
  //     var olmayan bir şifreleme vaat ediyordu;
  //   · "sol çubukta yer küre simgesi" (federasyon): istemcide böyle bir denetim YOK;
  //   · Bot Marketi "sunucu ayarlarından" değil, sunucu menüsündeki "Bot ekle"den açılır;
  //   · 6. ve 7. adım ikisi de Ctrl+K idi ve biri "komut paleti", biri "arama" diyordu.
  // Eklenen: sunucu kuran birinin İLK işi olan davet — tur tam da sunucu oluşturulunca açılır.
  const STEPS: Step[] = $derived([
    {
      icon:  'bridge',
      title: t('onb_s1_title', 'Bridge\'e Hoş Geldin'),
      body:  t('onb_v2_welcome_body', 'Sunucular, kanallar ve özel mesajlarla arkadaşlarınla konuş. Bu kısa tur bir dakika sürer.'),
      tip:   t('onb_s1_tip', 'Dilediğinde Esc veya "Atla" ile çıkabilirsin.'),
    },
    {
      icon:  'invite',
      title: t('inv_title', 'Arkadaşlarını davet et'),
      body:  t('onb_v2_invite_body', 'Sol üstte sunucunun adına tıkla ve “Arkadaşlarını davet et”i seç. Oluşan bağlantıyı paylaşman yeterli.'),
      tip:   t('onb_v2_invite_tip', 'Bağlantıyı alan herkes sunucuna katılabilir.'),
    },
    {
      icon:  'voice',
      title: t('onb_s5_title', 'Ses Kanalları & Ekran Paylaşımı'),
      body:  t('onb_s5_body', 'Bir ses kanalına girerek mikrofon, dinleme, kamera ve ekran paylaşımı kontrollerini aynı ses yüzeyinden yönetebilirsin.'),
      tip:   t('onb_s5_tip', 'Tarayıcı izni verilmezse Bridge durumu açıkça gösterir ve sessiz katılımı korur.'),
    },
    {
      icon:  'bot',
      title: t('onb_s4_title', 'Bot Marketi'),
      body:  t('onb_v2_bots_body', 'Müzik, anket ve moderasyon için bot ekleyebilirsin: sunucunun adına tıkla ve “Bot ekle”yi seç.'),
      tip:   undefined,
    },
    {
      icon:  'keyboard',
      title: t('onb_v2_keys_title', 'Komut paleti ve kısayollar'),
      body:  t('onb_v2_keys_body', 'Ctrl+K komut paletini açar: kanallara, sunuculara, arkadaşlarına ve ayarlara klavyeden git.'),
      tip:   t('onb_v2_keys_tip', 'Ses kanalındayken Ctrl+Shift+M mikrofonu, Ctrl+Shift+D sesi kapatır. Esc açık pencereyi kapatır.'),
    },
    {
      icon:  'check',
      title: t('onb_s8_title', 'Hazırsın!'),
      body:  t('onb_s8_body', 'Bridge\'i keşfetmeye başlayabilirsin. Profil, görünüm, bildirim, gizlilik ve cihaz seçeneklerine Ayarlar\'dan ulaşabilirsin.'),
      tip:   undefined,
    },
  ]);

  let isVisible  = $state(false);
  let step       = $state(0);
  let animating  = $state(false);

  // `STEPS` artık `$derived`: adım metinleri çeviriden gelir ve dil
  // değişince yeniden üretilir. Bu yüzden uzunluğu da türev olarak okunur —
  // düz `STEPS.length` yalnızca İLK değeri yakalardı.
  const total    = $derived(STEPS.length);
  const current  = $derived(STEPS[step]);
  const isLast   = $derived(step === total - 1);
  const progress = $derived(((step + 1) / total) * 100);

  /** Acik istek (komut paleti) — `_userActed` bunu ENGELLEMEZ. */
  function show(): void  {
    cancelAutoShow();
    removeActivityListeners();
    isVisible = true;
  }
  
  async function hide(): Promise<void>  { 
    cancelTransition();
    animating = false;
    isVisible = false; 
    await _persist(); 
  }

  function scheduleStep(target: number, delay: number): void {
    cancelTransition();
    animating = true;
    _transitionTimer = setTimeout(() => {
      _transitionTimer = null;
      step = Math.max(0, Math.min(total - 1, target));
      animating = false;
    }, delay);
  }

  function next(): void {
    if (animating) return;
    if (isLast) { hide(); return; }
    scheduleStep(step + 1, 180);
  }

  function prev(): void {
    if (animating || step === 0) return;
    scheduleStep(step - 1, 180);
  }

  function goTo(i: number): void {
    if (animating || i === step || !Number.isInteger(i) || i < 0 || i >= total) return;
    scheduleStep(i, 120);
  }

  /**
   * Global product tour completion is intentionally local and user-scoped.
   * Server onboarding is a different contract: it may contain rules/questions,
   * assign default roles and send a welcome message. Completing that contract
   * from this generic tour would skip its actual requirements and trigger
   * unrelated side effects.
   */
  async function _persist(): Promise<void> {
    try { 
      localStorage.setItem(storageKey(), 'done');
    } catch { 
      /* ignore */ 
    }
  }

  function _handleKey(e: KeyboardEvent): void {
    if (!isVisible) return;
    if (e.key === 'Escape')      { hide(); return; }
    if (e.key === 'ArrowRight')  { next(); return; }
    if (e.key === 'ArrowLeft')   { prev(); return; }
  }

  onMount(() => {
    BridgeRegistry.register('showOnboardingWizard', show);
    BridgeRegistry.register('hideOnboardingWizard', hide);
    document.addEventListener('keydown', _handleKey);

    // Faz 8.1 — otomatik açılış YALNIZCA giriş yapmış kullanıcı için.
    // Önceden mount anında (auth ekranı üstünde, oturum yokken bile) açılıyordu.
    document.addEventListener('bridge:auth-success', onAuthSuccess);
    document.addEventListener('bridge:auth-logout', onAuthLogout);
    armActivityListeners();
    if (isAuthenticated()) maybeAutoShow();

    log.info('OnboardingWizard mounted');
  });

  onDestroy(() => {
    BridgeRegistry.unregister?.('showOnboardingWizard');
    BridgeRegistry.unregister?.('hideOnboardingWizard');
    document.removeEventListener('keydown', _handleKey);
    document.removeEventListener('bridge:auth-success', onAuthSuccess);
    document.removeEventListener('bridge:auth-logout', onAuthLogout);
    removeActivityListeners();
    cancelAutoShow();
    cancelTransition();
  });
</script>

{#if isVisible}
<div
  class="ow-backdrop"
  role="dialog"
  use:focusTrap
  aria-modal="true"
  aria-label={t('onb_wizard', 'Onboarding sihirbazı')}
  tabindex="-1"
  onclick={(e) => { if ((e.target as HTMLElement).classList.contains('ow-backdrop')) hide(); }}
  onkeydown={_handleKey}
>
  <div class="ow-card" class:animating>

    <!-- Kapat -->
    <button class="ow-close" onclick={hide} aria-label={t('close')}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg></button>

    <!-- Progress bar -->
    <!-- A11Y: role="progressbar" ERİŞİLEBİLİR AD zorunludur (axe:
         aria-progressbar-name, serious). Adsız progressbar ekran okuyucuda
         yalnızca "ilerleme çubuğu" diye duyurulur; neyin ilerlediği bilinmez.
         aria-valuemin de eklendi: 0..max değil, 1..max ölçeği kullanılıyor. -->
    <div
      class="ow-progress-bar"
      role="progressbar"
      aria-label={t('attr_onboarding_ilerlemesi_8c8138f', "Onboarding ilerlemesi")}
      aria-valuemin={1}
      aria-valuenow={step + 1}
      aria-valuemax={total}
    >
      <div class="ow-progress-fill" style="width:{progress}%"></div>
    </div>

    <!-- Step dots -->
    <div class="ow-dots" role="tablist" aria-label={t('onb_steps', 'Adımlar')}>
      {#each STEPS as _, i}
        <button
          class="ow-dot"
          class:active={i === step}
          class:done={i < step}
          onclick={() => goTo(i)}
          role="tab"
          aria-selected={i === step}
          aria-label={t('onb_step_n', 'Adım {n}', { n: i + 1 })}
        ></button>
      {/each}
    </div>

    <!-- İçerik -->
    <div class="ow-body" class:animating>
      <div class="ow-icon" aria-hidden="true">
        {#if current.icon === 'bridge'}<svg viewBox="0 0 48 48"><path d="M8 35V21m32 14V21M8 26c6-11 12-11 16 0 4-11 10-11 16 0M6 35h36M14 35v-8m20 8v-8M21 35V24m6 11V24"/></svg>
        {:else if current.icon === 'invite'}<svg viewBox="0 0 48 48"><circle cx="19" cy="16" r="8"/><path d="M5 41c1-8 7-13 14-13s13 5 14 13M37 16v12M31 22h12"/></svg>
        {:else if current.icon === 'bot'}<svg viewBox="0 0 48 48"><rect x="8" y="14" width="32" height="26" rx="7"/><path d="M24 8v6M18 27h.01M30 27h.01M17 34h14"/></svg>
        {:else if current.icon === 'voice'}<svg viewBox="0 0 48 48"><rect x="18" y="6" width="12" height="24" rx="6"/><path d="M10 23v2a14 14 0 0 0 28 0v-2M24 39v5M17 44h14"/></svg>
        {:else if current.icon === 'keyboard'}<svg viewBox="0 0 48 48"><rect x="4" y="11" width="40" height="27" rx="4"/><path d="M10 18h2m5 0h2m5 0h2m5 0h2m5 0h2M10 25h2m5 0h2m5 0h2m5 0h2m5 0h2M13 32h22"/></svg>
        {:else}<svg viewBox="0 0 48 48"><circle cx="24" cy="24" r="19"/><path d="m15 24 6 6 13-13"/></svg>{/if}
      </div>
      <h2 class="ow-title">{current.title}</h2>
      <p class="ow-text">{current.body}</p>
      {#if current.tip}
        <div class="ow-tip" role="note">
          <span class="ow-tip-icon" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M9 18h6M10 22h4"/><path d="M8.2 15.4A7 7 0 1 1 15.8 15.4C14.7 16.2 14.4 17 14.4 18h-4.8c0-1-.3-1.8-1.4-2.6Z"/></svg></span>
          {current.tip}
        </div>
      {/if}
    </div>

    <!-- Adım sayacı -->
    <div class="ow-counter" aria-live="polite">{step + 1} / {total}</div>

    <!-- Butonlar -->
    <div class="ow-actions">
      {#if step > 0}
        <button class="ow-btn ow-btn-secondary" onclick={prev} aria-label={t('onb_prev_step', 'Önceki adım')}>
          {t('back')}
        </button>
      {:else}
        <button class="ow-btn ow-btn-ghost" onclick={hide} aria-label={t('attr_onboarding_i_atla_daab9bd', "Onboarding'i atla")}>
          {t('markup_atla_fd3df22', "Atla")}
        </button>
      {/if}

      <button class="ow-btn ow-btn-primary" onclick={next} aria-label={isLast ? 'Tamamla' : t("surface_sonraki_ad_m_afa07d")}>
        {isLast ? t("finish") : t('continue', 'Devam')}
      </button>
    </div>

  </div>
</div>
{/if}

<style>
.ow-backdrop {
  position: fixed;
  inset: 0;
  /* KANONIK KATMAN. Onceden `9999` sabitiydi; EmptyServerStart ise `10000`
     kullaniyordu ve BU YUZDEN turun ustune biniyordu. Sonuc: sunucusu olmayan
     YENI bir kullanici turu FARE ILE kapatamiyordu — `Kapat` ve `Atla`
     tiklamalari bos sunucu kartina gidiyordu (Esc calisiyordu, o yuzden kusur
     klavye testinde gorunmuyordu).
     Tasarim sistemi zaten en ust katmani onboarding'e ayirmis: `--z-onboard`.
     Sihirli sayilar yerine o kullanilir. */
  z-index: var(--z-onboard, 600);
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  backdrop-filter: blur(6px);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
  min-height: var(--bridge-visual-viewport-height, 100dvh);
  overflow-y: auto;
  animation: ow-fade-in 0.2s ease;
}

@keyframes ow-fade-in {
  from { opacity: 0; }
  to   { opacity: 1; }
}

.ow-card {
  position: relative;
  width: 100%;
  max-width: 480px;
  background: var(--surface);
  border: 1px solid var(--border, rgba(120,120,255,0.18));
  border-radius: 20px;
  max-height: min(760px, calc(var(--bridge-visual-viewport-height, 100dvh) - 32px));
  overflow-y: auto;
  padding: 36px 32px 28px;
  box-shadow: var(--shadow-xl);
  animation: ow-slide-up 0.25s cubic-bezier(0.34,1.56,0.64,1);
}

@keyframes ow-slide-up {
  from { transform: translateY(32px) scale(0.96); opacity: 0; }
  to   { transform: translateY(0) scale(1);       opacity: 1; }
}

.ow-close {
  position: absolute;
  top: 14px;
  right: 14px;
  background: none;
  border: none;
  color: var(--muted);
  font-size: 16px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
  line-height: 1;
  transition: color 0.15s, background 0.15s;
}
.ow-close svg { display: block; width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }
.ow-close:hover { color: var(--text, var(--text-primary)); background: color-mix(in srgb, var(--text-primary) 8%, transparent); }

.ow-progress-bar {
  height: 3px;
  background: color-mix(in srgb, var(--text-primary) 8%, transparent);
  border-radius: 2px;
  margin-bottom: 20px;
  overflow: hidden;
}
.ow-progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--accent), var(--accent-g));
  border-radius: 2px;
  transition: width 0.3s ease;
}

.ow-dots {
  display: flex;
  /* Butonlar artik 24px genis; gorsel araligi korumak icin bosluk kucultuldu. */
  gap: 0;
  justify-content: center;
  margin-bottom: 28px;
}
/* ══════════════════════════════════════════════════════════════════════════
   WCAG 2.2 SC 2.5.8 — HEDEF BOYUTU (MINIMUM)
   ══════════════════════════════════════════════════════════════════════════
   Bu noktalar dekoratif DEGIL: her biri `onclick={() => goTo(i)}` tasiyan,
   role="tab" olan GERCEK bir gezinme dugmesi. Gercek render'da 8x8 CSS px
   olculdu (aktif olan 10x10) — gerekli minimumun ucte biri.
   Ince motor kontrolu kisitli kullanicilar ve dokunmatik kullanicilar icin
   isabet ettirilemez bir hedefti.

   COZUM: GORSEL nokta 8px KALIR (tasarim degismez), dugmenin kendisi 24x24
   seffaf bir hedefe donusur ve nokta ::before ile ortalanir. Boylece gorunum
   korunur, hedef standarda uyar. `gap` 6px -> 0 yapildi ki noktalar arasi
   gorsel bosluk buyumesin ve hedefler ust uste BINMESIN. */
.ow-dot {
  width: 24px;
  height: 24px;
  border: none;
  background: none;
  cursor: pointer;
  padding: 0;
  display: grid;
  place-items: center;
}
.ow-dot::before {
  content: '';
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--text-primary) 30%, transparent);
  transition: background 0.2s, transform 0.2s;
}
.ow-dot.active::before  { background: var(--accent); transform: scale(1.3); }
.ow-dot.done::before    { background: var(--accent-g); }

.ow-body { transition: opacity 0.18s; }
.ow-body.animating { opacity: 0; }

.ow-icon {
  display: grid;
  place-items: center;
  width: 58px;
  height: 58px;
  margin-inline: auto;
  text-align: center;
  margin-bottom: 16px;
  line-height: 1;
  color: var(--brand);
  background: var(--brand-bg);
  border: 1px solid var(--brand-border);
  border-radius: var(--radius-surface);
}
.ow-icon svg { width: 34px; height: 34px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

.ow-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text, #eeeeff);
  text-align: center;
  margin-bottom: 12px;
  line-height: 1.3;
}

.ow-text {
  font-size: 14px;
  color: var(--muted);
  text-align: center;
  line-height: 1.65;
  margin-bottom: 16px;
}

.ow-tip {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  background: color-mix(in srgb, var(--brand) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--brand) 20%, transparent);
  border-radius: 10px;
  padding: 10px 14px;
  font-size: 12.5px;
  color: var(--text, #ccc);
  line-height: 1.5;
  margin-bottom: 8px;
}
.ow-tip-icon { width: 16px; height: 16px; flex-shrink: 0; margin-top: 1px; color: var(--brand); }
.ow-tip-icon svg { display: block; width: 100%; height: 100%; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }

.ow-counter {
  text-align: center;
  font-size: 11px;
  color: var(--muted);
  margin: 12px 0 20px;
  letter-spacing: 0.5px;
}

.ow-actions {
  display: flex;
  gap: 10px;
  justify-content: space-between;
}

.ow-btn {
  flex: 1;
  padding: 11px 20px;
  border-radius: 10px;
  border: none;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: opacity 0.15s, transform 0.15s, background 0.15s;
}
.ow-btn:hover  { opacity: 0.88; transform: translateY(-1px); }
.ow-btn:active { transform: translateY(0); }

.ow-btn-primary {
  /* Final21 UX (U-05): turuncu→mor gradyan uygulamanın hiçbir başka birincil
     düğmesinde yoktu; birincil eylem her yerde aynı marka dolgusudur. */
  background: var(--brand);
  color: var(--text-on-solid);
}
.ow-btn-primary:hover { background: var(--brand-hover, var(--brand)); opacity: 1; }
.ow-btn-secondary {
  background: color-mix(in srgb, var(--text-primary) 6%, transparent);
  color: var(--text, #ccc);
  border: 1px solid color-mix(in srgb, var(--text-primary) 10%, transparent);
}
.ow-btn-ghost {
  background: none;
  color: var(--muted);
  border: 1px solid transparent;
}
.ow-btn-ghost:hover { color: var(--text, #ccc); background: color-mix(in srgb, var(--text-primary) 5%, transparent); }

@media (max-width: 480px) {
  .ow-backdrop { align-items: flex-end; padding: 0; }
  .ow-card {
    max-height: min(90dvh, var(--bridge-visual-viewport-height, 90dvh));
    padding: 28px 20px calc(22px + env(safe-area-inset-bottom));
    border-right: 0; border-bottom: 0; border-left: 0;
    border-radius: var(--radius-modal) var(--radius-modal) 0 0;
  }
  .ow-title   { font-size: 19px; }
  .ow-icon    { width: 52px; height: 52px; }
  .ow-close   { width: 40px; height: 40px; padding: 0; display: grid; place-items: center; }
  .ow-btn     { min-height: 44px; }
}

@media (prefers-reduced-motion: reduce) {
  .ow-backdrop, .ow-card, .ow-progress-fill, .ow-body, .ow-dot::before { animation: none; transition: none; }
  .ow-btn:hover { transform: none; }
}
</style>
