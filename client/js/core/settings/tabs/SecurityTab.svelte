<!-- client/js/core/settings/tabs/SecurityTab.svelte -->
<!--
  ══════════════════════════════════════════════════════════════════════════
  GUVENLIK — IKI ADIMLI DOGRULAMA (2FA)
  ══════════════════════════════════════════════════════════════════════════
  NEDEN BU DOSYA VAR
  ──────────────────────────────────────────────────────────────────────────
  Sunucu tarafi 2FA tamamen hazir ve sertlestirilmisti (TOTP, HASHLI ve
  TEK KULLANIMLIK yedek kodlar, atomik tuketim, sabit zamanli karsilastirma,
  devre disi birakmada GERCEK parola dogrulamasi). Ancak URETIM ISTEMCISINDE
  hicbir yonetim yuzeyi YOKTU: kullanicinin 2FA'yi acmasinin yolu yoktu.
  Ulasilabilirlik olcumu bunu ortaya cikardi — `js/twoFactor.ts` hicbir giris
  noktasindan import edilmiyordu.

  Eski dosya OLDUGU GIBI baglanmadi; yetenek KANONIK Settings mimarisine
  yeniden yazildi. Tek sahip, ikinci bir guvenlik mimarisi yok.

  ── GUVENLIK DURUSU ───────────────────────────────────────────────────────
  Bu arayuz HICBIR guvenlik karari VERMEZ. Tum kararlar sunucuda kalir:
    * devre disi birakma parolayi SUNUCUDA dogrular
    * yedek kodlar sunucuda hashlenir ve tek kullanimliktir
    * kodlarin gecerliligi yalnizca sunucuda belirlenir
  Istemci yalnizca sunucunun soyledigini gosterir.

  ── YEDEK KOD GIZLILIGI ───────────────────────────────────────────────────
  Yedek kodlar YALNIZCA bilesen durumunda (bellekte) tutulur. localStorage,
  sessionStorage, IndexedDB veya gunluge YAZILMAZ. Cikista ve bilesen
  sokuldugunde temizlenir — paylasilan bir bilgisayarda sonraki kullaniciya
  gorunmemeleri icin.
-->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { t } from '../../i18n/reactive.svelte.ts';
  import type { SettingsStore } from '../stores/settingsStore';
  import { apiFetch } from '../../api-fetch.ts';
import { saveToken } from '../../auth-compat.ts';
  import { getAPI } from '../../globals.ts';

  // `store` kanonik tab sozlesmesidir; bu tab sunucuyla dogrudan konusur.
  let { store: _store }: { store: SettingsStore } = $props();
  const API = getAPI();

  type Asama = 'yukleniyor' | 'kapali' | 'kurulum' | 'dogrulama' | 'kodlar' | 'acik' | 'devredisi' | 'yenile';

  let asama       = $state<Asama>('yukleniyor');
  let hata        = $state<string | null>(null);
  let mesgul      = $state(false);
  let enabled     = $state(false);
  let kalanYedek  = $state<number | null>(null);

  // Kurulum durumu — gecicidir.
  let gizliAnahtar = $state<string>('');
  let qrKod        = $state<string>('');
  let totpKodu     = $state('');

  // HASSAS: yalnizca bellekte.
  let yedekKodlar  = $state<string[]>([]);
  let parola       = $state('');

  /** Hassas alanlari temizler. Cikis, sokme ve akis bitiminde cagrilir. */
  function hassasiTemizle(): void {
    yedekKodlar = [];
    parola = '';
    gizliAnahtar = '';
    qrKod = '';
    totpKodu = '';
  }

  async function govde(res: Response): Promise<Record<string, unknown>> {
    try { return (await res.json()) as Record<string, unknown>; } catch { return {}; }
  }
  function sunucuHatasi(p: Record<string, unknown>, varsayilan: string): string {
    return typeof p.error === 'string' && p.error ? p.error : varsayilan;
  }

  // ── Durum ────────────────────────────────────────────────────────────────
  async function durumYukle(): Promise<void> {
    hata = null;
    try {
      const res = await apiFetch(`${API}/api/2fa/status`);
      const p = await govde(res as unknown as Response);
      if (!res.ok) { hata = sunucuHatasi(p, t("ui_durum_alinamadi", "Durum alınamadı.")); asama = 'kapali'; return; }
      enabled = Boolean(p.enabled);
      kalanYedek = typeof p.backupRemaining === 'number' ? p.backupRemaining : null;
      asama = enabled ? 'acik' : 'kapali';
    } catch {
      hata = t("ui_sunucuya_ulasilamadi", "Sunucuya ulaşılamadı.");
      asama = 'kapali';
    }
  }

  // ── Etkinlestirme ────────────────────────────────────────────────────────
  async function kurulumBaslat(): Promise<void> {
    mesgul = true; hata = null;
    try {
      const res = await apiFetch(`${API}/api/2fa/setup`, { method: 'POST' });
      const p = await govde(res as unknown as Response);
      if (!res.ok) { hata = sunucuHatasi(p, t("ui_kurulum_baslatilamadi", "Kurulum başlatılamadı.")); return; }
      gizliAnahtar = String(p.secret ?? '');
      qrKod        = String(p.qrCode ?? '');
      asama = 'kurulum';
    } catch { hata = t("ui_sunucuya_ulasilamadi", "Sunucuya ulaşılamadı."); }
    finally { mesgul = false; }
  }

  async function kodDogrula(): Promise<void> {
    const kod = totpKodu.trim();
    if (!kod) { hata = t("ui_dogrulama_kodunu_girin", "Doğrulama kodunu girin."); return; }
    mesgul = true; hata = null;
    try {
      const res = await apiFetch(`${API}/api/2fa/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: kod }),
      });
      const p = await govde(res as unknown as Response);
      if (!res.ok) {
        // BASARISIZ DOGRULAMA ASLA "acik" durumuna gecmez.
        hata = sunucuHatasi(p, t("ui_kod_dogrulanamadi", "Kod doğrulanamadı."));
        return;
      }
      if (typeof p.token === 'string') saveToken(p.token);
      const kodlar = Array.isArray(p.backupCodes) ? (p.backupCodes as string[]) : [];
      yedekKodlar = kodlar;
      totpKodu = '';
      gizliAnahtar = '';
      qrKod = '';
      enabled = true;
      kalanYedek = kodlar.length;
      asama = 'kodlar';
    } catch { hata = t("ui_sunucuya_ulasilamadi", "Sunucuya ulaşılamadı."); }
    finally { mesgul = false; }
  }

  function kodlariKapat(): void {
    yedekKodlar = [];
    asama = 'acik';
  }

  // ── Yedek kod yenileme ───────────────────────────────────────────────────
  // Kodlar tukendiginde veya sizdigindan suphelenildiginde yeni set alinir.
  // Sunucu eski seti ATAR; istemci de onceki seti bellekte TUTMAZ.
  async function yedekKodlariYenile(): Promise<void> {
    if (!parola) { hata = t("ui_parolanizi_girin", "Parolanızı girin."); return; }
    mesgul = true; hata = null;
    try {
      const res = await apiFetch(`${API}/api/2fa/backup-codes/regenerate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: parola }),
      });
      const p = await govde(res as unknown as Response);
      if (!res.ok) {
        // Basarisiz yenileme ESKI kodlari gecersiz gostermez.
        hata = sunucuHatasi(p, 'Yedek kodlar yenilenemedi.');
        return;
      }
      const kodlar = Array.isArray(p.backupCodes) ? (p.backupCodes as string[]) : [];
      parola = '';                      // hassas alan hemen temizlenir
      yedekKodlar = kodlar;             // ONCEKI set uzerine YAZILIR
      kalanYedek = kodlar.length;
      asama = 'kodlar';
    } catch { hata = t("ui_sunucuya_ulasilamadi", "Sunucuya ulaşılamadı."); }
    finally { mesgul = false; }
  }

  // ── Devre disi birakma ───────────────────────────────────────────────────
  async function devreDisiBirak(): Promise<void> {
    if (!parola) { hata = t("ui_parolanizi_girin", "Parolanızı girin."); return; }
    mesgul = true; hata = null;
    try {
      const res = await apiFetch(`${API}/api/2fa/disable`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: parola }),
      });
      const p = await govde(res as unknown as Response);
      if (!res.ok) {
        // Yanlis parola BASARI gibi gosterilmez.
        hata = sunucuHatasi(p, t("ui_devre_disi_birakilamadi", "Devre dışı bırakılamadı."));
        return;
      }
      if (typeof p.token === 'string') saveToken(p.token);
      hassasiTemizle();
      enabled = false;
      kalanYedek = null;
      asama = 'kapali';
    } catch { hata = t("ui_sunucuya_ulasilamadi", "Sunucuya ulaşılamadı."); }
    finally { mesgul = false; }
  }

  // ── Final21 UX (U-01): kurtarma e-postası ──────────────────────────────────
  // Sunucu şifre sıfırlamayı destekliyordu ama kullanıcının e-posta ekleyebileceği HİÇBİR
  // yer yoktu (kayıtta da e-posta istenmez); yani sıfırlama kimseye ulaşamıyordu. Adres
  // doğrulanana kadar sıfırlama bu adrese GÖNDERİLMEZ (routes/email.ts).
  let epostaKayitli    = $state<string | null>(null);
  let epostaDogrulandi = $state(false);
  let epostaGirdi      = $state('');
  let epostaMesaj      = $state<string | null>(null);
  let epostaHata       = $state<string | null>(null);
  let epostaMesgul     = $state(false);

  async function epostaYukle(): Promise<void> {
    try {
      const res = await apiFetch(`${API}/api/me`);
      if (!res.ok) return;
      const p = await govde(res);
      epostaKayitli = typeof p.email === 'string' && p.email ? p.email : null;
      epostaDogrulandi = p.emailVerified === true;
    } catch { /* bölüm boş kalır; 2FA etkilenmez */ }
  }

  async function epostaGonder(path: string, body?: Record<string, string>): Promise<boolean> {
    epostaHata = null;
    epostaMesaj = null;
    epostaMesgul = true;
    try {
      const res = await apiFetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      });
      if (!res.ok) {
        epostaHata = res.status === 429
          ? t('auth_too_many_attempts', 'Çok fazla deneme yapıldı. Biraz bekleyip tekrar dene.')
          : t('sec_recovery_failed', 'Bu adres kaydedilemedi.');
        return false;
      }
      epostaMesaj = t('tfa_mail_sent', 'Doğrulama e-postası gönderildi');
      return true;
    } catch { epostaHata = t('ui_sunucuya_ulasilamadi', 'Sunucuya ulaşılamadı.'); return false; }
    finally { epostaMesgul = false; }
  }

  async function epostaKaydet(): Promise<void> {
    const email = epostaGirdi.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      epostaMesaj = null;
      epostaHata = t('auth_forgot_invalid', 'Geçerli bir e-posta adresi gir.');
      return;
    }
    if (await epostaGonder('/api/email/add', { email })) {
      epostaKayitli = email.toLowerCase();
      epostaDogrulandi = false;
      epostaGirdi = '';
    }
  }

  // ── Yasam dongusu ────────────────────────────────────────────────────────
  const cikisDinleyici = () => { hassasiTemizle(); enabled = false; asama = 'kapali'; };

  onMount(() => {
    document.addEventListener('bridge:auth-logout', cikisDinleyici);
    void durumYukle();
    void epostaYukle();
  });
  onDestroy(() => {
    document.removeEventListener('bridge:auth-logout', cikisDinleyici);
    hassasiTemizle();
  });
</script>

<div class="sec-tab" data-testid="security-tab">
  <section class="sec-section" data-testid="sec-recovery">
    <h3>{t('sec_recovery_title', 'Kurtarma e-postası')}</h3>
    <p class="sec-desc">{t('sec_recovery_desc', 'Şifreni unutursan sıfırlama bağlantısı yalnızca bu adrese, adres doğrulandıktan sonra gönderilir.')}</p>
    {#if epostaKayitli}
      <p class="sec-state" class:on={epostaDogrulandi} data-testid="sec-recovery-state">
        {epostaKayitli} — {epostaDogrulandi ? t('sec_recovery_verified', 'Doğrulandı') : t('sec_recovery_pending', 'Doğrulama bekleniyor — gelen kutundaki bağlantıya tıkla.')}
      </p>
      {#if !epostaDogrulandi}
        <button class="sec-btn" onclick={() => void epostaGonder('/api/email/resend')} disabled={epostaMesgul} data-testid="sec-recovery-resend">
          {t('sec_recovery_resend', 'Bağlantıyı yeniden gönder')}
        </button>
      {/if}
    {/if}
    <label class="sec-label" for="sec-recovery-email">{t('markup_e_posta_0ff610b', 'E-posta')}</label>
    <div class="sec-row">
      <input
        id="sec-recovery-email" class="sec-input sec-grow" data-testid="sec-recovery-input"
        type="email" autocomplete="email" bind:value={epostaGirdi}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void epostaKaydet(); } }} />
      <button class="sec-btn primary" onclick={epostaKaydet} disabled={epostaMesgul} data-testid="sec-recovery-save">
        {t('sec_recovery_save', 'Kaydet ve doğrula')}
      </button>
    </div>
    {#if epostaMesaj}<p class="sec-state on" role="status" data-testid="sec-recovery-message">{epostaMesaj}</p>{/if}
    {#if epostaHata}<p class="sec-error" role="alert" data-testid="sec-recovery-error">{epostaHata}</p>{/if}
  </section>

  <h3>{t('sec_2fa_title', 'İki Adımlı Doğrulama')}</h3>
  <p class="sec-desc">
    {t('sec_2fa_desc', 'Hesabınıza girişte parolanıza ek olarak doğrulama uygulamanızdan bir kod istenir.')}
  </p>

  {#if hata}
    <p class="sec-error" role="alert" data-testid="sec-error">{hata}</p>
  {/if}

  {#if asama === 'yukleniyor'}
    <p data-testid="sec-loading">{t('sec_loading', 'Yükleniyor…')}</p>

  {:else if asama === 'kapali'}
    <p class="sec-state" data-testid="sec-state">{t('sec_2fa_off', '2FA kapalı')}</p>
    <button class="sec-btn primary" onclick={kurulumBaslat} disabled={mesgul} data-testid="sec-enable">
      {t('sec_enable', 'İki adımlı doğrulamayı aç')}
    </button>

  {:else if asama === 'kurulum'}
    <p>{t('sec_scan', 'Doğrulama uygulamanızla QR kodu okutun veya anahtarı elle girin.')}</p>
    {#if qrKod}
      <img class="sec-qr" src={qrKod} alt={t('sec_qr_alt', '2FA QR kodu')} data-testid="sec-qr" />
    {/if}
    <label class="sec-label" for="sec-secret">{t('sec_manual', 'Elle giriş anahtarı')}</label>
    <code class="sec-secret" id="sec-secret" data-testid="sec-secret">{gizliAnahtar}</code>

    <label class="sec-label" for="sec-code">{t('sec_code', 'Uygulamadaki 6 haneli kod')}</label>
    <input
      id="sec-code" class="sec-input" data-testid="sec-code"
      bind:value={totpKodu} inputmode="numeric" autocomplete="one-time-code"
      maxlength="8" placeholder="123456" />
    <button class="sec-btn primary" onclick={kodDogrula} disabled={mesgul} data-testid="sec-verify">
      {t('sec_verify', 'Doğrula ve etkinleştir')}
    </button>

  {:else if asama === 'kodlar'}
    <p class="sec-warn" data-testid="sec-codes-warning">
      {t('sec_codes_warn', 'Bu yedek kodları güvenli bir yere kaydedin. Bir daha gösterilmeyecekler. Her kod yalnızca BİR kez kullanılabilir.')}
    </p>
    <ul class="sec-codes" data-testid="sec-codes">
      {#each yedekKodlar as kod (kod)}
        <li><code>{kod}</code></li>
      {/each}
    </ul>
    <button class="sec-btn" onclick={kodlariKapat} data-testid="sec-codes-done">
      {t('sec_codes_done', 'Kaydettim, kapat')}
    </button>

  {:else if asama === 'acik'}
    <p class="sec-state on" data-testid="sec-state">{t('sec_2fa_on', '2FA açık')}</p>
    {#if kalanYedek !== null}
      <p class="sec-remaining" data-testid="sec-remaining">
        {t('sec_backup_left', 'Kalan yedek kod')}: {kalanYedek}
      </p>
    {/if}
    <div class="sec-row">
      <button class="sec-btn" onclick={() => { hata = null; parola = ''; asama = 'yenile'; }} data-testid="sec-regen-start">
        {t('sec_regen', 'Yedek kodları yenile')}
      </button>
      <button class="sec-btn danger" onclick={() => { hata = null; asama = 'devredisi'; }} data-testid="sec-disable-start">
        {t('sec_disable', 'İki adımlı doğrulamayı kapat')}
      </button>
    </div>

  {:else if asama === 'yenile'}
    <p class="sec-warn" data-testid="sec-regen-warning">
      {t('sec_regen_warn', 'Yeni kodlar üretilince ESKİ yedek kodlarınız geçersiz olur.')}
    </p>
    <label class="sec-label" for="sec-regen-pass">{t('sec_password', 'Parola')}</label>
    <input
      id="sec-regen-pass" class="sec-input" data-testid="sec-regen-password"
      type="password" bind:value={parola} autocomplete="current-password" />
    <div class="sec-row">
      <button class="sec-btn primary" onclick={yedekKodlariYenile} disabled={mesgul} data-testid="sec-regen-confirm">
        {t('sec_regen_do', 'Yenile')}
      </button>
      <button class="sec-btn" onclick={() => { parola = ''; hata = null; asama = 'acik'; }} data-testid="sec-regen-cancel">
        {t('sec_cancel', 'Vazgeç')}
      </button>
    </div>

  {:else if asama === 'devredisi'}
    <p>{t('sec_disable_confirm', 'Kapatmak için parolanızı girin.')}</p>
    <label class="sec-label" for="sec-pass">{t('sec_password', 'Parola')}</label>
    <input
      id="sec-pass" class="sec-input" data-testid="sec-password"
      type="password" bind:value={parola} autocomplete="current-password" />
    <div class="sec-row">
      <button class="sec-btn danger" onclick={devreDisiBirak} disabled={mesgul} data-testid="sec-disable-confirm">
        {t('sec_disable_do', 'Kapat')}
      </button>
      <button class="sec-btn" onclick={() => { parola = ''; hata = null; asama = 'acik'; }} data-testid="sec-disable-cancel">
        {t('sec_cancel', 'Vazgeç')}
      </button>
    </div>
  {/if}
</div>

<style>
  /*
    TASARIM SISTEMI: yalnizca TANIMLI tokenlar kullanilir ve ham renk yazilmaz.
    Ilk yazimda `--bridge-warning` / `--bridge-accent` (tanimsiz) ve uc adet
    ham `#fff` vardi; `design-system-tokens` testi ikisini de dogru sekilde
    reddetti. Uyari icin `--bridge-yellow`, birincil eylem icin
    `--bridge-blue`, katman ustu metin icin `--text-on-solid` kanoniktir.
  */
  .sec-tab { display: flex; flex-direction: column; gap: 10px; max-width: 460px; }
  h3 { margin: 0; font-size: 1.05rem; }
  .sec-desc { margin: 0; color: var(--bridge-muted); font-size: .88rem; }
  .sec-state { font-weight: 600; }
  .sec-state.on { color: var(--bridge-green); }
  .sec-remaining { font-size: .85rem; color: var(--bridge-muted); margin: 0; }
  .sec-error { color: var(--bridge-danger); font-size: .85rem; margin: 0; }
  .sec-warn { color: var(--bridge-yellow); font-size: .85rem; margin: 0; }
  .sec-label { font-size: .78rem; text-transform: uppercase; letter-spacing: .04em;
    color: var(--bridge-muted); }
  .sec-secret { font-family: monospace; background: var(--bridge-surface2);
    padding: 6px 8px; border-radius: 4px; word-break: break-all; }
  /* QR icin ZEMIN VERILMEZ.
     Ilk yazimda `background: var(--text-on-solid)` kullanildi ve
     `theme-on-solid-misuse` testi bunu dogru sekilde reddetti: o token
     KATMAN USTU METIN icindir, zemin icin degil. Sunucunun dondurdugu QR
     zaten kendi acik zeminini tasiyan bir PNG'dir, bu yuzden ek zemin
     gereksizdir. */
  .sec-qr { width: 168px; height: 168px; padding: 6px; border-radius: 6px; }
  .sec-input { padding: 7px 9px; border-radius: 5px; border: 1px solid var(--bridge-surface4);
    background: var(--bridge-surface2); color: inherit; }
  .sec-codes { display: grid; grid-template-columns: repeat(2, 1fr); gap: 4px;
    list-style: none; padding: 10px; margin: 0; background: var(--bridge-surface2);
    border-radius: 6px; font-family: monospace; }
  .sec-row { display: flex; gap: 8px; }
  .sec-section { display: flex; flex-direction: column; gap: 10px; padding-bottom: 14px; margin-bottom: 4px;
    border-bottom: 1px solid var(--bridge-surface4); }
  .sec-grow { flex: 1; min-width: 0; }
  .sec-btn { padding: 7px 12px; border-radius: 5px; border: none; cursor: pointer;
    background: var(--bridge-surface3); color: inherit; font-size: .87rem; }
  .sec-btn.primary { background: var(--bridge-blue); color: var(--text-on-solid); }
  .sec-btn.danger  { background: var(--bridge-danger); color: var(--text-on-solid); }
  .sec-btn:disabled { opacity: .55; cursor: default; }
</style>
