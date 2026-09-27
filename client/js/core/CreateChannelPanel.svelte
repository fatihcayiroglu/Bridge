<!-- client/js/core/CreateChannelPanel.svelte -->
<!--
  UX/P0 — KANAL OLUŞTURMA (istemcide HİÇ YOKTU).

  ════════════════════════════════════════════════════════════════════════════
  BULUNAN KUSUR
  ════════════════════════════════════════════════════════════════════════════
  Ölçüm: sunucuda `POST /api/servers/:sid/channels` TAM olarak vardı —
  MANAGE_CHANNELS yetkisi, tür doğrulaması, hız sınırı ve sunucu başına 500
  kanal üst sınırı. İstemcide bu uca giden ÇAĞRI SAYISI SIFIRDI; istemci kanal
  listesini yalnızca GET ediyordu.

  Sonuç: bir sunucu sahibi kurduğu sunucuya KANAL EKLEYEMİYORDU. Bu, davet
  eksiğiyle aynı sınıfta bir çekirdek akış boşluğudur — kozmetik değil.

  ════════════════════════════════════════════════════════════════════════════
  KANONİK SAHİPLİK
  ════════════════════════════════════════════════════════════════════════════
  · Uç AYNEN kullanılır; ikinci bir kanal modeli/servisi KURULMAZ.
  · Liste tazeleme kanonik sahibe delege edilir: `loadChannels`
    (ChannelListManager). Burada ikinci bir kanal listesi TUTULMAZ.
  · Yetki SUNUCUDADIR. Menü yalnızca görünürlüğü ayarlar; 403 dürüstçe gösterilir.

  TÜR SEÇENEKLERİ (Final21 Faz 16'da BEŞE çıktı):
  Uç `text|voice|announcement|stage|forum` kabul eder. Bu dosya önceden yalnızca
  METİN ve SES sunuyordu; gerekçe "sahne yönlendiricisi diğerlerini render etmiyor,
  kullanıcı boş bir yüzeyle karşılaşır" idi. Kural doğrudur — "API kabul ediyor"
  bir özelliğin çalıştığı anlamına gelmez — ama ÖNCÜLÜ artık geçerli değil:
  Faz 16'da gerçek tarayıcıda ölçüldü (`p16-channel-types-probe` 7/7): forum
  yüzeyi açılıyor ve arayüzden ileti oluşturuluyor, duyuru kanalına yazılıyor,
  sahne paneli (konu, konuşmacılar, dinleyiciler, el kaldırma) hatasız render
  ediliyor. Uygulanmış ama erişilemez üç tür vardı; artık sunuluyor.
  Sahne SES/görüntü aktarımı ayrıca doğrulanmadı (insan + cihaz gerekir) ve
  panel bunu kendisi söylüyor. Duyuru TAKİBİ kurulumu yalnızca API'de; açıklama
  bu yüzden takip vaat etmez.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { createLogger } from './logger.js';
  import { safeApiErrorMessage } from './api-error.ts';

  const log = createLogger('CreateChannelPanel');

  let isVisible = $state(false);
  let busy      = $state(false);
  let error     = $state('');
  let name      = $state('');
  type ChannelKind = 'text' | 'voice' | 'announcement' | 'forum' | 'stage';
  let type      = $state<ChannelKind>('text');

  // Etiketler render anında çevrilir (çeviri işlevi reaktiftir) — dil değişince seçenekler de değişir.
  const KINDS: ReadonlyArray<{ id: ChannelKind; glyph: string; title: () => string; desc: () => string }> = [
    { id: 'text',  glyph: '#',  title: () => t('markup_metin_2c8a418', 'Metin'), desc: () => t('ccp_text_desc', 'Mesajlaşma, dosya ve tepkiler') },
    { id: 'voice', glyph: '🔊', title: () => t('cp_category_voice'),             desc: () => t('markup_sesli_sohbet_17fecd6', 'Sesli sohbet') },
    { id: 'announcement', glyph: '📢', title: () => t('ccp_type_announcement', 'Duyuru'), desc: () => t('ccp_announcement_desc', 'Önemli güncellemeler ve duyurular') },
    { id: 'forum', glyph: '💬', title: () => t('ccp_type_forum', 'Forum'), desc: () => t('ccp_forum_desc', 'Başlıklar hâlinde düzenli tartışmalar') },
    { id: 'stage', glyph: '🎙️', title: () => t('ccp_type_stage', 'Sahne'), desc: () => t('ccp_stage_desc', 'Konuşmacılar ve dinleyicilerle etkinlikler') },
  ];

  const apiBase = (): string =>
    (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;

  function currentServer(): { _id?: string; name?: string } | null {
    return BridgeRegistry.call<{ _id?: string; name?: string } | null>('currentServer') ?? null;
  }

  /** Sunucunun ad kuralının AYNISI — kullanıcı sonucu önceden görür. */
  let slug = $derived(name.trim().toLowerCase().replace(/[^a-z0-9\-_]/g, '-').slice(0, 32));
  let canSubmit = $derived(slug.length > 0 && !busy);

  async function submit(e?: Event): Promise<void> {
    e?.preventDefault();
    if (!canSubmit) return;
    const server = currentServer();
    if (!server?._id) { error = t("ui_once_bir_sunucu_secin", "Önce bir sunucu seçin."); return; }

    busy = true; error = '';
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/servers/${encodeURIComponent(server._id)}/channels`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: slug, type }),
      });

      if (res.status === 403) { error = t("ui_bu_sunucuda_kanal_olusturma_yetkiniz_yok", "Bu sunucuda kanal oluşturma yetkiniz yok."); return; }
      if (!res.ok) {
        error = safeApiErrorMessage(res, t("ui_kanal_olusturulamadi", "Kanal oluşturulamadı."), { report: true });
        return;
      }

      const channel = await res.json() as { _id?: string };
      // KANONİK sahibe delege — burada liste tutulmaz.
      if (BridgeRegistry.has('loadChannels')) BridgeRegistry.call('loadChannels', server._id);
      if (channel?._id && BridgeRegistry.has('selectChannel')) {
        BridgeRegistry.call('selectChannel', channel);
      }
      name = '';
      close();
    } catch (err) {
      log.error('Channel creation failed', err);
      error = t("ui_kanal_olusturulamadi_lutfen_tekrar_deneyin", "Kanal oluşturulamadı. Lütfen tekrar deneyin.");
    } finally {
      busy = false;
    }
  }

  function open(): void { isVisible = true; error = ''; name = ''; type = 'text'; }
  function close(): void { isVisible = false; }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isVisible) return;
    e.preventDefault();
    close();
  }

  onMount(() => {
    BridgeRegistry.register('openCreateChannel', open);
    BridgeRegistry.register('closeCreateChannel', close);
  });
  onDestroy(() => {
    BridgeRegistry.unregister?.('openCreateChannel');
    BridgeRegistry.unregister?.('closeCreateChannel');
  });
</script>

<svelte:window onkeydown={onKeyDown} />

{#if isVisible}
<div class="cc-overlay" role="presentation"
     onclick={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div class="cc-card" role="dialog" aria-modal="true" aria-labelledby="cc-title"
       use:focusTrap={{ initialFocus: '.cc-name' }}>
  <form class="cc-form" onsubmit={submit}>
    <header class="cc-head">
      <h2 id="cc-title">{t('ccp_create', t("ccp_create"))}</h2>
      <button type="button" class="cc-x" onclick={close} aria-label={t('close')}>✕</button>
    </header>

    <fieldset class="cc-types">
      <legend>{t('ccp_type', 'Kanal türü')}</legend>
      {#each KINDS as kind (kind.id)}
        <label class="cc-type" class:sel={type === kind.id}>
          <input type="radio" name="cc-type" value={kind.id} checked={type === kind.id}
                 onchange={() => (type = kind.id)} />
          <span class="cc-glyph" aria-hidden="true">{kind.glyph}</span>
          <span class="cc-tl"><strong>{kind.title()}</strong><small>{kind.desc()}</small></span>
        </label>
      {/each}
    </fieldset>

    <label class="cc-field">
      <span class="cc-label">{t('ccp_name', 'Kanal adı')}</span>
      <input class="cc-name" bind:value={name} maxlength="32" autocomplete="off"
             placeholder={t('attr_yeni_kanal_a281921', "yeni-kanal")} aria-describedby="cc-hint" />
    </label>
    <p id="cc-hint" class="cc-hint">
      {#if slug}{t("ui_create_as_name")} <code>#{slug}</code>{:else}{t("ui_slug_hint")}{/if}
    </p>

    {#if error}<p class="cc-error" role="alert">{error}</p>{/if}

    <div class="cc-actions">
      <button type="button" class="cc-ghost" onclick={close}>{t('ccp_cancel', 'Vazgeç')}</button>
      <button type="submit" class="cc-go" disabled={!canSubmit}>
        {busy ? t("surface_olusturuluyor_8d7aee") : t("ccp_create")}
      </button>
    </div>
  </form>
  </div>
</div>
{/if}

<style>
  .cc-overlay {
    position: fixed; inset: 0; z-index: 1300;
    display: grid; place-items: center;
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    padding: var(--space-4);
  }
  .cc-card {
    width: min(440px, 100%);
    background: var(--surface-1); color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-surface);
    box-shadow: var(--elevation-modal);
    padding: var(--space-5);
    display: grid; gap: var(--space-3);
    /* Faz 16: beş tür seçeneğiyle kart uzadı. Masaüstünde yüksekliği sınırsızdı;
       kısa bir pencerede (ör. 1280×560) üstü ve altı kesiliyordu — "Oluştur"
       düğmesine ulaşılamıyordu. Telefon kuralındaki sınırın aynısı. */
    max-height: calc(100dvh - 2 * var(--space-4));
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .cc-form { display: contents; }
  .cc-head { display: flex; align-items: center; gap: var(--space-3); }
  .cc-head h2 { margin: 0; flex: 1; font-size: var(--type-title-sm); }
  .cc-x {
    border: 0; background: transparent; color: var(--text-muted);
    font-size: 20px; line-height: 1; cursor: pointer;
    border-radius: var(--radius-control); padding: 2px 6px;
  }
  .cc-x:hover { background: var(--surface-hover); color: var(--text-primary); }
  .cc-types { border: 0; margin: 0; padding: 0; display: grid; gap: var(--space-2); }
  .cc-types legend { font-size: var(--type-caption); color: var(--text-muted); padding: 0 0 var(--space-1); }
  .cc-type {
    display: flex; align-items: center; gap: var(--space-3);
    padding: 10px 12px; cursor: pointer;
    background: var(--surface-2);
    border: 1px solid transparent;
    border-radius: var(--radius-control);
  }
  .cc-type:hover { background: var(--surface-hover); }
  .cc-type.sel { border-color: var(--brand); }
  .cc-type input { accent-color: var(--brand); }
  .cc-glyph { width: 20px; text-align: center; color: var(--text-muted); }
  .cc-tl { display: grid; }
  .cc-tl small { color: var(--text-muted); font-size: var(--type-caption); }
  .cc-field { display: grid; gap: var(--space-1); }
  .cc-label { font-size: var(--type-caption); color: var(--text-muted); }
  .cc-name {
    padding: 10px 12px; font: inherit; color: var(--text-primary);
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control);
  }
  .cc-name:focus-visible { outline: 2px solid var(--brand); outline-offset: 1px; }
  .cc-hint { margin: 0; font-size: var(--type-caption); color: var(--text-muted); }
  .cc-hint code { color: var(--text-2); }
  .cc-error { margin: 0; color: var(--danger); font-size: var(--type-body-sm); }
  .cc-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
  .cc-go, .cc-ghost {
    border-radius: var(--radius-control); padding: 10px 14px;
    cursor: pointer; font-weight: 600; border: 0;
    transition: background var(--duration-fast);
  }
  .cc-go { background: var(--brand); color: var(--text-on-solid); }
  .cc-go:hover:not(:disabled) { background: var(--brand-hover); }
  .cc-go:disabled { opacity: .55; cursor: default; }
  .cc-ghost { background: transparent; color: var(--text-2); border: 1px solid var(--border-subtle); }
  .cc-ghost:hover { background: var(--surface-hover); color: var(--text-primary); }

  @media (max-width: 560px) {
    .cc-overlay {
      padding: 0;
      place-items: end center;
      background: color-mix(in srgb, var(--bg-0) 76%, transparent);
      backdrop-filter: blur(5px);
    }
    .cc-card {
      width: 100%;
      max-height: min(88dvh, var(--bridge-visual-viewport-height, 88dvh));
      overflow-y: auto;
      padding: var(--space-5) var(--space-4) calc(var(--space-5) + env(safe-area-inset-bottom));
      border-right: 0; border-bottom: 0; border-left: 0;
      border-radius: var(--radius-modal) var(--radius-modal) 0 0;
      box-shadow: var(--shadow-xl);
      overscroll-behavior: contain;
    }
    .cc-x { min-width: 40px; min-height: 40px; padding: 0; }
    .cc-actions { display: grid; grid-template-columns: 1fr 1fr; }
    .cc-go, .cc-ghost, .cc-name, .cc-type { min-height: 44px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .cc-go, .cc-ghost { transition: none; }
  }
</style>
