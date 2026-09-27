<!-- client/js/core/server-settings/ServerSettingsModal.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts (623 satır) tam Svelte geçişi        -->
<!-- Sprint 114: Eski "buton listesi" → gerçek tab navigasyonu                 -->
<script lang="ts">
  import { focusTrap } from '../a11y/focusTrap.ts';
  import { t } from '../i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import GeneralTab   from './tabs/GeneralTab.svelte';
  import RolesTab     from './tabs/RolesTab.svelte';
  import MediaTab     from './tabs/MediaTab.svelte';
  import EmojiTab     from './tabs/EmojiTab.svelte';
  import WebhookTab   from './tabs/WebhookTab.svelte';
  import AuditLogTab  from './tabs/AuditLogTab.svelte';
  import ModerationTab from './tabs/ModerationTab.svelte';
  import MembersTab    from './tabs/MembersTab.svelte';
  import HealthTab    from './tabs/HealthTab.svelte';
  import AnalyticsTab from './tabs/AnalyticsTab.svelte';
  import BoostTab     from './tabs/BoostTab.svelte';
  import AutomationTab from './tabs/AutomationTab.svelte';
  import SsoTab       from './tabs/SsoTab.svelte';
  import PluginTab    from './tabs/PluginTab.svelte';
  import { createServerSettingsStore, getCurrentServerFromRegistry } from './stores/serverSettingsStore';
  import { BridgeRegistry } from '../bridge-registry.js';

  type TabId = 'general' | 'members' | 'roles' | 'media' | 'emoji' | 'webhooks' | 'audit' | 'moderation' | 'analytics' | 'boost' | 'automation' | 'health' | 'sso' | 'plugins' | 'onboarding';

  interface Props {
    initialTab?: TabId;
    onClose?: () => void;
  }

  let { initialTab = 'general', onClose }: Props = $props();

  const server = getCurrentServerFromRegistry();
  const store  = server ? createServerSettingsStore(server) : null;

  interface Tab { id: TabId; label: string; icon: string; }
  interface NavGroup { id: string; label: string; tabs: TabId[]; }
  // ── C1.4 — YAYINLANAN SEKME LİSTESİ (arka uç sözleşmesiyle doğrulandı) ────
  //
  // Bir sekme YALNIZCA gerçek, uçtan uca desteklenen bir arka uç sözleşmesi
  // varsa yayınlanır. Bileşen dosyasının var olması yeterli DEĞİLDİR.
  //
  // BİLEREK YAYINLANMAYANLAR (C1.4 denetimi):
  //   • plugins    → authenticated `GET /api/plugins` ile doğrulanmıştır; yayınlanır.
  //   • onboarding → `openOnboardingSettings` registry'ye HİÇ kaydedilmemiş;
  //                  düğme hiçbir şey yapmaz (ölü kontrol).
  //
  // Kural: yalan söyleyen bir kontrol yayınlamaktansa sekmeyi hiç göstermemek
  // yeğdir. Bu liste C1.5+ ilerledikçe büyüyecektir.
  // C1.5: `general` GERİ YAYINLANDI — sahte başarı kaldırıldı, gerçek
  // owner-only `PATCH /api/servers/:sid` kalıcılığı, doğrulama, kirli-durum,
  // çift-gönderim koruması, hata yüzeyi ve bayat-sunucu koruması eklendi
  // (tests/server-settings-general.test.ts, 12/12 + fail-closed kanıtı).
  // Sekme etiketleri KANONIK i18n'den gelir.
  //
  // KAPATILAN IKI KUSUR:
  //   1. "Audit Log" TURKCE arayuzde INGILIZCE duruyordu — diger dokuz
  //      sekme Turkceyken tek basina yabanci kaliyordu (ekran goruntusuyle
  //      dogrulandi).
  //   2. Etiketler bilesende SABIT KODLUYDU; dil degistirildiginde hicbiri
  //      degismiyordu.
  const TABS: Tab[] = $derived([
    { id: 'general',    label: t('srv_tab_general',    'Genel'),      icon: 'M3.5 6h5.5m4 0h3.5M3.5 14h2.5m4 0h6.5M9 6a2 2 0 1 0 4 0a2 2 0 1 0-4 0M6 14a2 2 0 1 0 4 0a2 2 0 1 0-4 0'  },
    // FAZ 8/4 — uye listeleme + rol atama UCLARI vardi, YUZEYI yoktu.
    { id: 'members',    label: t('srv_tab_members',    'Üyeler'),     icon: 'M3.5 16c.5-2.5 2-3.8 4-3.8s3.5 1.3 4 3.8M5 7.5a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0-5 0M12.8 5.3a2.2 2.2 0 0 1 0 4.4M13.8 12.3c1.3.4 2.2 1.6 2.6 3.7'  },
    { id: 'roles',      label: t('srv_tab_roles',      'Roller'),     icon: 'M3.5 9.5v-5h5l7.5 7.5-5 5zM6.5 7.5h.01'   },
    { id: 'media',      label: t('srv_tab_media',      'Görsel'),     icon: 'M3.5 4.5h13v11h-13zM5.5 13.5l3.5-3.5 2.5 2.5 1.5-1.5 2.5 2.5M7 8a1 1 0 1 0 2 0a1 1 0 1 0-2 0'  },
    { id: 'emoji',      label: t('srv_tab_emoji',      'Emoji'),      icon: 'M3.5 10a6.5 6.5 0 1 0 13 0a6.5 6.5 0 1 0-13 0M7.5 8.5h.01M12.5 8.5h.01M7 12c.8.9 1.8 1.3 3 1.3s2.2-.4 3-1.3'  },
    { id: 'webhooks',   label: t('srv_tab_webhooks',   'Webhooklar'), icon: 'M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 1 0-4.2-4.2l-1 1M11.5 8.5a3 3 0 0 0-4.2 0l-2.6 2.6a3 3 0 1 0 4.2 4.2l1-1'  },
    { id: 'audit',      label: t('srv_tab_audit',      'Denetim Kaydı'), icon: 'M6 4h8v13H6zM8 3h4v2H8zM8 8.5h4M8 11.5h4M8 14.5h2.5' },
    // FAZ K+/2 — moderasyon UÇLARI vardı, YÜZEYİ yoktu. Sekme herkese
    // görünür; içeride yetki kanıtlanamazsa eylem DEĞİL, gerekçe gösterilir.
    { id: 'moderation', label: t('srv_tab_moderation', 'Moderasyon'), icon: 'M10 3l5.5 2.2v4.3c0 3.2-2.2 6-5.5 7-3.3-1-5.5-3.8-5.5-7V5.2z'  },
    { id: 'analytics',  label: t('srv_tab_analytics',  'Analitik'),    icon: 'M4.5 16V10M8.5 16V5.5M12.5 16V8M16.5 16v-4M3 16.5h14'   },
    { id: 'boost',      label: t('srv_tab_boost',      'Boost'),       icon: 'M10 3l1.8 4.2L16 9l-4.2 1.8L10 15l-1.8-4.2L4 9l4.2-1.8z'   },
    { id: 'automation', label: t('srv_tab_automation', 'Otomasyon'),   icon: 'M11 2.5 5 11h4.5l-1 6.5L15 9h-4.5z'  },
    { id: 'health',     label: t('srv_tab_health',     'Sistem'),     icon: 'M3 10.5h3l2-4.5 3 8.5 2-4h4'   },
    { id: 'sso',        label: t('srv_tab_sso',        'SSO'),        icon: 'M3.5 10a3 3 0 1 0 6 0a3 3 0 1 0-6 0M9.5 10h7M14 10v2.5M16.5 10v2'  },
    { id: 'plugins',    label: t('srv_tab_plugins',    'Pluginler'),  icon: 'M4 7h3a1.5 1.5 0 1 1 3 0h3v3a1.5 1.5 0 1 1 0 3v3H4z'  },
  ]);

  // Final21 UX: 15 sekme tek düz listeydi ve simgeleri renkli emoji (⚙️👥😀🔗📋⚡🔐🧩) ile
  // çıplak glifler (◇ ◉ ▦) karışımıydı — kullanıcı ayarlarının tek tip çizgi simgeleriyle
  // yan yana "farklı bileşen kütüphanesi" hissi veriyordu. Simgeler artık aynı çizgi
  // dilinde (20×20, currentColor) ve sekmeler dört anlamlı gruba ayrılır.
  const GROUPS: NavGroup[] = $derived([
    { id: 'server',       label: t('ssm_group_server', 'Sunucu'),               tabs: ['general', 'media', 'emoji'] },
    { id: 'people',       label: t('ssm_group_people', 'Üyeler ve güvenlik'),    tabs: ['members', 'roles', 'moderation', 'audit'] },
    { id: 'integrations', label: t('ssm_group_integrations', 'Entegrasyonlar'), tabs: ['webhooks', 'automation', 'plugins', 'sso'] },
    { id: 'status',       label: t('ssm_group_status', 'Durum'),                 tabs: ['analytics', 'boost', 'health'] },
  ]);

  // activeTab starts from the prop; user clicks update it independently.
  // FAIL-CLOSED: yalnız YAYINLANAN bir sekme etkin olabilir.
  // C1.4 sonrası yalnız `onboarding` yayınlanmıyor; eski veya harici
  // çağıranlar hâlâ bilinmeyen sekmeler isteyebilir (ör. shim varsayılanı
  // `general`). Kelepçe olmadan `activeTab` yayınlanmayan bir kimliğe düşer;
  // ne bir gezinme öğesi ne de içerik render edilir — boş bir modal.
  // Bilinmeyen/yayınlanmayan istekler ilk yayınlanan sekmeye indirgenir.
  function getInitialTab(): TabId {
    return TABS.some(t => t.id === initialTab) ? initialTab : TABS[0]!.id;
  }
  let activeTab = $state<TabId>(getInitialTab());

  function close(): void { onClose?.(); }

  function handleKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') close();
  }

  // Onboarding/Discord import: still delegated to vanilla via BridgeRegistry
  // (not yet migrated — vanilla server-settings.ts openOnboardingSettings)
  function openOnboarding(): void {
    close();
    BridgeRegistry.call('openOnboardingSettings');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    store?.loadSlug();
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });
</script>

<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  id="server-settings-modal"
  class="ss-overlay"
  role="dialog"
  aria-modal="true"
  aria-label={t('ssm_aria', 'Sunucu ayarları')}
  tabindex="-1"
    use:focusTrap
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div class="ss-card">
    {#if !server || !store}
      <p>{t('ssm_no_server', 'Sunucu seçilmedi.')}</p>
      <button type="button" class="btn" onclick={close}>{t('close')}</button>
    {:else}
      <!-- Header -->
      <div class="ss-header">
        <h2 class="ss-title">{t('ssm_aria', 'Sunucu ayarları')}</h2>
        <button type="button" class="ss-close" aria-label={t('close')} onclick={close}><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/></svg></button>
      </div>

      <div class="ss-body">
        <!-- Sidebar nav -->
        <nav class="ss-nav" aria-label={t('attr_ayar_kategorileri_62c7d25', "Ayar kategorileri")}>
          <!-- `data-tab`: KALICI test/otomasyon kancasi. Etiket artik
               i18n'den gelir ve dile gore degisir; kimlik degismez. -->
          {#each GROUPS as group (group.id)}
            <h3 class="ss-nav-group">{group.label}</h3>
            {#each TABS.filter((tab) => group.tabs.includes(tab.id)) as tab (tab.id)}
              <button
                type="button"
                class="ss-nav-btn"
                class:active={activeTab === tab.id}
                data-tab={tab.id}
                onclick={() => { activeTab = tab.id; }}
                aria-current={activeTab === tab.id ? 'page' : undefined}
              >
                <svg class="ss-nav-icon" aria-hidden="true" viewBox="0 0 20 20"><path d={tab.icon}/></svg>
                <span class="ss-nav-label">{tab.label}</span>
              </button>
            {/each}
          {/each}

          <!-- Non-tab actions (delegated to vanilla or BridgeRegistry) -->
          <!-- C1.4: "Giden Webhook" ve "Discord İçe Aktar" delege düğmeleri
               KALDIRILDI — `openOutgoingWebhookManager` ve `openDiscordImport`
               registry'ye HİÇ kaydedilmemiş; tıklandığında sessizce hiçbir şey
               yapmıyorlardı (ölü kontrol). Gerçek sahipleri bağlandığında geri
               eklenebilirler. -->
        </nav>

        <!-- Tab content -->
        <div class="ss-content">
          {#if activeTab === 'general'}
            <GeneralTab {store} />
          {:else if activeTab === 'members'}
            <MembersTab />
          {:else if activeTab === 'roles'}
            <RolesTab />
          {:else if activeTab === 'media'}
            <MediaTab {store} />
          {:else if activeTab === 'emoji'}
            <EmojiTab />
          {:else if activeTab === 'webhooks'}
            <WebhookTab />
          {:else if activeTab === 'audit'}
            <AuditLogTab />
          {:else if activeTab === 'moderation'}
            <ModerationTab />
          {:else if activeTab === 'analytics'}
            <AnalyticsTab {store} />
          {:else if activeTab === 'boost'}
            <BoostTab />
          {:else if activeTab === 'automation'}
            <AutomationTab />
          {:else if activeTab === 'health'}
            <HealthTab />
          {:else if activeTab === 'sso'}
            <SsoTab />
          {:else if activeTab === 'plugins'}
            <PluginTab />
          {:else if activeTab === 'onboarding'}
            <div class="ss-delegated">
              <p>{t('ssm_onboarding', 'Onboarding ayarları için:')}</p>
              <button type="button" class="btn btn-primary" onclick={openOnboarding}>
                {t('markup_onboarding_ayarlarini_ac_5500b78', "🚀 Onboarding Ayarlarını Aç")}
              </button>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  /* ── Overlay ───────────────────────────────────────────────── */
  .ss-overlay {
    display: flex;
    position: fixed;
    inset: 0;
    z-index: var(--layer-modal);
    padding: var(--space-6);
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    backdrop-filter: blur(6px);
    align-items: center;
    justify-content: center;
  }

  /* ── Card ──────────────────────────────────────────────────── */
  .ss-card {
    width: min(920px, calc(100vw - (var(--space-6) * 2)));
    height: min(720px, calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-6) * 2)));
    min-height: 0;
    background: var(--bg-primary, #1e1f22);
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-modal);
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: var(--shadow-xl);
  }

  /* ── Header ────────────────────────────────────────────────── */
  .ss-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 16px 20px 12px;
    border-bottom: 1px solid var(--border, #3f4147);
    flex-shrink: 0;
  }
  .ss-title { margin: 0; font-size: 16px; font-weight: 700; }
  .ss-close {
    display: grid;
    width: 36px; height: 36px; padding: 0; place-items: center;
    background: var(--bg-3); border: none;
    color: var(--text-muted); cursor: pointer;
    font-size: 16px; border-radius: var(--radius-pill);
  }
  .ss-close:hover { background: var(--bg-3); color: var(--text-primary); }

  /* ── Body (sidebar + content) ──────────────────────────────── */
  .ss-body {
    display: flex;
    flex: 1;
    overflow: hidden;
  }

  /* ── Sidebar nav ───────────────────────────────────────────── */
  .ss-nav {
    width: 148px;
    flex-shrink: 0;
    background: var(--bg-secondary, #2b2d31);
    padding: 8px 6px;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow-y: auto;
    border-right: 1px solid var(--border, #3f4147);
  }
  .ss-nav-btn {
    display: flex;
    align-items: center;
    gap: 8px;
    background: none;
    border: none;
    color: var(--text-secondary, #b5bac1);
    cursor: pointer;
    padding: 7px 10px;
    border-radius: 6px;
    font-size: 13px;
    text-align: left;
    width: 100%;
    transition: background .1s, color .1s;
  }
  .ss-nav-btn:hover      { background: var(--bg-3, #35373c); color: var(--text-primary); }
  /* Marka metni, marka tonlu (alfa) bir zeminin üzerinde; açık temada ölçülen
     kontrast 3.5:1 idi (WCAG 1.4.3 AA = 4.5:1). `--brand-ink` koyu temada
     `--brand`e eşittir, dolayısıyla koyu tema görünümü değişmez. */
  .ss-nav-btn.active     { background: var(--brand-alpha, rgba(45,156,219,.2)); color: var(--brand-ink, var(--brand, #2d9cdb)); font-weight: 600; }
  .ss-nav-icon           { width: 18px; height: 18px; flex-shrink: 0; fill: none; stroke: currentColor; stroke-width: 1.6; stroke-linecap: round; stroke-linejoin: round; }
  .ss-nav-group {
    margin: 12px 10px 4px; font-size: 11px; font-weight: 700; letter-spacing: .04em;
    text-transform: uppercase; color: var(--text-muted);
  }
  .ss-nav-group:first-child { margin-top: 4px; }
  .ss-close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; }

  /* ── Tab content ───────────────────────────────────────────── */
  .ss-content {
    flex: 1;
    overflow-y: auto;
    padding: 20px;
  }

  .ss-delegated {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
    padding: 8px 0;
  }
  .ss-delegated p { color: var(--text-muted); font-size: 13px; margin: 0; }

  .ss-nav-btn:focus-visible,
  .ss-close:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }

  @media (max-width: 720px) {
    .ss-overlay { padding: var(--space-3); align-items: stretch; }
    .ss-card {
      width: 100%;
      height: calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-3) * 2));
    }
    .ss-header { padding: var(--space-3) 52px var(--space-3) var(--space-4); }
    .ss-body { flex-direction: column; }
    .ss-nav {
      width: 100%;
      flex: none;
      flex-direction: row;
      gap: var(--space-1);
      padding: var(--space-2) var(--space-3);
      overflow-x: auto;
      overflow-y: hidden;
      border-right: 0;
      border-bottom: 1px solid var(--border);
      scrollbar-width: thin;
    }
    .ss-nav-btn { width: auto; min-height: 40px; flex: none; white-space: nowrap; }
    .ss-nav-group { display: none; }
    .ss-content { padding: var(--space-5); }
    .ss-close { position: absolute; top: var(--space-3); right: var(--space-3); }
    .ss-card { position: relative; }
  }

  @media (max-width: 480px) {
    .ss-overlay { padding: 0; }
    .ss-card {
      width: 100%;
      height: var(--bridge-visual-viewport-height, 100dvh);
      border: 0;
      border-radius: 0;
      padding-bottom: env(safe-area-inset-bottom);
    }
    .ss-header { padding-top: max(var(--space-3), env(safe-area-inset-top)); }
    .ss-nav { padding-inline: max(var(--space-3), env(safe-area-inset-left)) max(var(--space-3), env(safe-area-inset-right)); }
    .ss-content { padding: var(--space-4); }
  }

  @media (prefers-reduced-motion: reduce) {
    .ss-nav-btn, .ss-close { transition: none; }
  }
</style>
