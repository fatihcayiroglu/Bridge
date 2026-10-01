<!-- client/js/core/settings/SettingsModal.svelte -->
<!-- ADR-0002 Faz 1 — SettingsModal pilot bileşeni.               -->
<!-- settings-modal.ts (726 satır) → bu bileşen + tab modülleri.  -->
<!-- Mevcut Vanilla JS davranışı korunur; BridgeRegistry üzerinden -->
<!-- haberleşme yapılır.                                           -->

<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  import { focusTrap } from '../a11y/focusTrap.ts';
  import { onMount, onDestroy, type Component } from 'svelte';
  import { createSettingsStore, type SettingsStore, type SettingsTab } from './stores/settingsStore';
  import ProfileTab       from './tabs/ProfileTab.svelte';
  import AppearanceTab    from './tabs/AppearanceTab.svelte';
  import NotificationsTab from './tabs/NotificationsTab.svelte';
  import PrivacyTab       from './tabs/PrivacyTab.svelte';
  import DevicesTab       from './tabs/DevicesTab.svelte';
  import SecurityTab      from './tabs/SecurityTab.svelte';
  import { logout }       from '../auth-compat.ts';

  // ── Props ─────────────────────────────────────────────────────────────────
  interface Props {
    initialTab?: SettingsTab;
    onClose?:    () => void;
  }

  let { initialTab = 'profile', onClose }: Props = $props();

  // ── Store ─────────────────────────────────────────────────────────────────
  type CanonicalTab = 'profile' | 'appearance' | 'notifications' | 'privacy' | 'devices' | 'security';
  const TAB_IDS: CanonicalTab[] = ['profile', 'appearance', 'notifications', 'privacy', 'devices', 'security'];
  function canonicalTab(value: SettingsTab): CanonicalTab {
    return TAB_IDS.includes(value as CanonicalTab) ? value as CanonicalTab : 'profile';
  }
  function getInitialTab(): CanonicalTab { return canonicalTab(initialTab); }
  const store = createSettingsStore(getInitialTab());
  let activeTab = $state<CanonicalTab>(getInitialTab());
  let storeError = $state<string | null>(null);
  const unsubscribeStore = store.subscribe((state) => {
    activeTab = canonicalTab(state.activeTab as SettingsTab);
    storeError = typeof state.error === 'string' ? state.error : null;
  });

  // ── Tab tanımları ─────────────────────────────────────────────────────────
  const TABS: Array<{ id: CanonicalTab; label: string }> = $derived.by(() => [
    { id: 'profile',       label: t('ui_profile_label', 'Profil') },
    { id: 'appearance',    label: t("app_appearance", "Görünüm") },
    { id: 'notifications', label: t('ui_notifications_label', 'Bildirimler') },
    { id: 'privacy',       label: t("ui_gizlilik", "Gizlilik") },
    { id: 'devices',       label: t('ui_devices_label', 'Cihazlar') },
    // GUVENLIK: sunucu 2FA'yi tam destekliyordu ama uretim istemcisinde
    // hicbir yonetim yuzeyi yoktu (ulasilabilirlik olcumu ortaya cikardi).
    { id: 'security',      label: t("ui_guvenlik", "Güvenlik") },
  ]);

  let dialog: HTMLElement;
  let previousBodyOverflow = '';
  let closing = false;

  // ── Klavye desteği ────────────────────────────────────────────────────────
  //
  // FAZ E — TAB TUZAĞI BURADAN KALDIRILDI.
  //
  // Bu bileşen kendi Tab sarmalama kodunu taşıyordu (FOCUSABLE listesi +
  // focusableElements() + Tab dalı). Aynı mantık CommandPalettePanel ve
  // VoicePanel içinde de tekrarlanıyordu: üründe ÜÇ ayrı tuzak uygulaması.
  // Artık tek kanonik sahip `a11y/focusTrap.ts` action'ıdır ve şablondaki
  // `use:focusTrap` ile bağlanır.
  //
  // KRİTİK: ikisi BİRLİKTE bırakılamazdı. Her ikisi de Tab'da
  // preventDefault() + focus() çağırdığı için odak TEK Tab'da İKİ adım
  // atlardı — yani "iki tuzak" tek tuzaktan DAHA kötü davranırdı.
  //
  // Escape burada KALIR: kapatma bu bileşenin sözleşmesidir, tuzağın değil.
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    }
  }

  function close() {
    if (closing) return;
    closing = true;
    onClose?.();
  }

  function selectTab(tab: CanonicalTab): void {
    store.setTab(tab);
  }

  function handleTabKeydown(event: KeyboardEvent, index: number): void {
    let next = index;
    if (event.key === 'ArrowDown' || event.key === 'ArrowRight') next = (index + 1) % TABS.length;
    else if (event.key === 'ArrowUp' || event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = TABS.length - 1;
    else return;

    event.preventDefault();
    const tab = TABS[next];
    selectTab(tab.id);
    queueMicrotask(() => document.getElementById(`tab-${tab.id}`)?.focus());
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    queueMicrotask(() => document.getElementById(`tab-${canonicalTab(initialTab)}`)?.focus());
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
    document.body.style.overflow = previousBodyOverflow;
    unsubscribeStore();
  });

  // ── Aktif tab bileşeni ────────────────────────────────────────────────────
  const TAB_COMPONENTS: Record<CanonicalTab, Component<{ store: SettingsStore }>> = {
    profile:       ProfileTab,
    appearance:    AppearanceTab,
    notifications: NotificationsTab,
    privacy:       PrivacyTab,
    devices:       DevicesTab,
    security:      SecurityTab,
  };

  let ActiveComponent = $derived(TAB_COMPONENTS[activeTab]);
</script>

<!-- ── Overlay ──────────────────────────────────────────────────────────────── -->
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="settings-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div
    bind:this={dialog}
    id="settings-modal-content"
    class="settings-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="settings-title"
    tabindex="-1"
    use:focusTrap
  >
    <!-- ── Sidebar ──────────────────────────────────────────────────────── -->
    <nav class="settings-sidebar" aria-label={t('attr_ayarlar_kategorileri_e1c54bf', "Ayarlar kategorileri")}>
      <div class="settings-brand" aria-hidden="true">
        <svg viewBox="0 0 24 24"><path d="M5 7.5h14M7.5 4v7M16.5 4v7M5 16.5h14M9 13v7M15 13v7"/></svg>
      </div>
      <h2 id="settings-title" class="settings-sidebar-title">{t('settings')}</h2>
      <ul role="tablist">
        {#each TABS as tab, index (tab.id)}
          <li role="presentation">
            <button
              role="tab"
              id="tab-{tab.id}"
              aria-selected={activeTab === tab.id}
              aria-controls="tabpanel-{tab.id}"
              class="settings-tab-btn"
              class:active={activeTab === tab.id}
              tabindex={activeTab === tab.id ? 0 : -1}
              onclick={() => selectTab(tab.id)}
              onkeydown={(event) => handleTabKeydown(event, index)}
            >
              <span class="tab-icon" aria-hidden="true">
                {#if tab.id === 'profile'}
                  <svg viewBox="0 0 20 20"><circle cx="10" cy="6.5" r="3"/><path d="M4.5 16c.7-3 2.5-4.5 5.5-4.5s4.8 1.5 5.5 4.5"/></svg>
                {:else if tab.id === 'appearance'}
                  <svg viewBox="0 0 20 20"><path d="M4 15.5 10 3l6 12.5M6 12h8"/><path d="M13.5 5.5 16 3"/></svg>
                {:else if tab.id === 'notifications'}
                  <svg viewBox="0 0 20 20"><path d="M5 13.5h10l-1.5-2V8a3.5 3.5 0 0 0-7 0v3.5zM8.5 16h3"/></svg>
                {:else if tab.id === 'privacy'}
                  <svg viewBox="0 0 20 20"><rect x="4.5" y="8" width="11" height="8" rx="2"/><path d="M7 8V6.5a3 3 0 0 1 6 0V8M10 11v2"/></svg>
                {:else if tab.id === 'security'}
                  <!-- Kalkan: guvenlik. Kendi ikonu OLMASAYDI `{:else}` dali
                       devreye girip CIHAZLAR ikonunu gosterirdi; iki tab ayni
                       ikonla ayirt edilemez olurdu. -->
                  <svg viewBox="0 0 20 20"><path d="M10 3l5.5 2.2v4.3c0 3.2-2.2 6-5.5 7-3.3-1-5.5-3.8-5.5-7V5.2z"/><path d="M7.8 10.2l1.6 1.6 3-3.2"/></svg>
                {:else}
                  <svg viewBox="0 0 20 20"><rect x="4" y="3.5" width="12" height="8" rx="1.5"/><path d="M8 15.5h4M10 11.5v4M6.5 7.5h.01M9 7.5h4.5"/></svg>
                {/if}
              </span>
              <span>{tab.label}</span>
            </button>
          </li>
        {/each}
      </ul>
      <!-- P4: üründe görünür bir çıkış denetimi YOKTU. Geniş düzende kenar
           çubuğunun altında durur; dar düzende (telefon) Güvenlik sekmesinin
           "Oturumlar" bölümündedir (sekme şeridine ikinci satır eklenmez). -->
      <div class="settings-sidebar-footer">
        <button type="button" class="settings-logout-btn" onclick={() => logout()} data-testid="settings-logout">
          <span class="tab-icon" aria-hidden="true">
            <svg viewBox="0 0 20 20"><path d="M8 4.5H5.5a1 1 0 0 0-1 1v9a1 1 0 0 0 1 1H8M12 13.5 15.5 10 12 6.5M15.5 10H8"/></svg>
          </span>
          <span>{t('settings_logout', 'Çıkış yap')}</span>
        </button>
      </div>
    </nav>

    <!-- ── İçerik paneli ────────────────────────────────────────────────── -->
    <div
      id="tabpanel-{activeTab}"
      role="tabpanel"
      aria-labelledby="tab-{activeTab}"
      class="settings-content"
    >
      {#if storeError}
        <div class="settings-error" role="alert">{storeError}</div>
      {/if}

      {#if ActiveComponent}
        <ActiveComponent {store} />
      {/if}
    </div>

    <!-- ── Kapat butonu ──────────────────────────────────────────────────── -->
    <button
      class="settings-close"
      aria-label={t('settings_close', 'Ayarları kapat')}
      onclick={close}
    ><svg aria-hidden="true" viewBox="0 0 20 20"><path d="m5.5 5.5 9 9M14.5 5.5l-9 9"/></svg></button>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    padding: var(--space-6);
    background: color-mix(in srgb, var(--bg-0) 78%, transparent);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: var(--layer-modal);
    animation: settings-fade var(--duration-base) var(--ease-out);
  }

  .settings-modal {
    position: relative;
    display: flex;
    width: min(920px, calc(100vw - (var(--space-6) * 2)));
    height: min(680px, calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-6) * 2)));
    min-height: 480px;
    border: 1px solid var(--border-strong);
    border-radius: var(--radius-modal);
    background: var(--bg-2);
    box-shadow: var(--shadow-xl);
    overflow: hidden;
    outline: none;
    animation: settings-in var(--duration-base) var(--ease-out);
  }

  .settings-sidebar {
    position: relative;
    width: 224px;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    background: var(--bg-1);
    padding: var(--space-6) var(--space-3);
    overflow-y: auto;
  }

  .settings-sidebar-title {
    margin: 0 0 var(--space-4); padding: 0 var(--space-2) 0 36px;
    color: var(--text-primary); font-size: var(--type-title-sm); font-weight: 700; letter-spacing: -.01em;
  }

  .settings-brand { position: absolute; top: 19px; left: var(--space-5); display: grid; width: 26px; height: 26px; place-items: center; border-radius: var(--radius-control); background: var(--brand-subtle); color: var(--brand); }
  .settings-brand svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }

  .settings-sidebar ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .settings-tab-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
    padding: var(--space-2) var(--space-3);
    border: none;
    border-radius: var(--radius-control);
    background: transparent;
    color: var(--text-2);
    font-size: var(--type-body);
    cursor: pointer;
    text-align: left;
    transition: background var(--duration-fast), color var(--duration-fast), transform var(--duration-fast);
  }

  .settings-tab-btn:hover {
    background: var(--bg-4);
    color: var(--text-primary);
  }

  .settings-tab-btn.active {
    background: var(--brand-subtle);
    /* Marka metni, marka tonlu (%15 alfa) bir zeminin üzerinde duruyor; açık
       temada ölçülen kontrast 3.52:1 idi (WCAG 1.4.3 AA = 4.5:1).
       `--brand-ink` koyu temada `--brand`e eşittir; koyu tema değişmez. */
    color: var(--brand-ink, var(--brand));
  }

  .settings-sidebar-footer { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border); }
  .settings-logout-btn {
    width: 100%; display: flex; align-items: center; gap: var(--space-2); min-height: 40px;
    padding: var(--space-2) var(--space-3); border: none; border-radius: var(--radius-control);
    background: transparent; color: var(--danger); font-size: var(--type-body);
    cursor: pointer; text-align: left;
  }
  .settings-logout-btn:hover { background: var(--bg-4); }
  .settings-logout-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  /* Light theme: --danger is 4.39:1 on the sidebar (--bg-1 #f0f2f9), below AA (axe, nightly a11y);
     the theme's danger ink is 7.62:1. The dark themes' --danger is 4.79–5.20:1 on their --bg-1. */
  :global([data-theme="light"]) .settings-logout-btn { color: var(--danger-text); }

  .tab-icon { display: grid; width: 20px; height: 20px; flex: none; place-items: center; }
  .tab-icon svg { width: 17px; height: 17px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-linejoin: round; stroke-width: 1.6; }

  .settings-content {
    flex: 1;
    padding: var(--space-8);
    overflow-y: auto;
    color: var(--text-primary);
    scrollbar-gutter: stable;
  }

  .settings-error {
    background: var(--red-bg);
    border: 1px solid var(--red);
    border-radius: var(--radius-control);
    padding: var(--space-3) var(--space-4);
    margin-bottom: var(--space-4);
    font-size: var(--type-body-sm);
    color: var(--red);
  }


  .settings-close {
    position: absolute;
    top: var(--space-4);
    right: var(--space-4);
    width: 36px;
    height: 36px;
    border: none;
    border-radius: var(--radius-pill);
    background: var(--bg-3);
    color: var(--text-muted);
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background var(--duration-fast), color var(--duration-fast), transform var(--duration-fast);
  }

  .settings-close:hover {
    background: var(--red-bg);
    color: var(--red);
  }
  .settings-close:active { transform: scale(.94); }
  .settings-close svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-linecap: round; stroke-width: 1.7; }

  .settings-tab-btn:focus-visible,
  .settings-close:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }

  @keyframes settings-fade { from { opacity: 0; } }
  @keyframes settings-in { from { opacity: 0; transform: translateY(var(--space-2)) scale(.985); } }

  @media (max-width: 720px) {
    .settings-overlay { padding: var(--space-3); align-items: stretch; }
    .settings-modal { flex-direction: column; width: 100%; height: calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-3) * 2)); min-height: 0; }
    .settings-sidebar { width: 100%; flex: none; padding: max(var(--space-3), env(safe-area-inset-top)) 52px var(--space-2) var(--space-3); border-right: 0; border-bottom: 1px solid var(--border); overflow: hidden; }
    .settings-brand, .settings-sidebar-title { display: none; }
    .settings-sidebar ul { display: flex; gap: var(--space-1); overflow-x: auto; }
    .settings-sidebar li { flex: none; }
    .settings-sidebar-footer { display: none; }
    .settings-tab-btn { width: auto; min-height: 38px; white-space: nowrap; }
    .settings-content { padding: var(--space-5); }
    .settings-close { top: max(var(--space-3), env(safe-area-inset-top)); right: max(var(--space-3), env(safe-area-inset-right)); }
  }

  @media (max-width: 480px) {
    .settings-overlay { padding: 0; }
    .settings-modal { height: var(--bridge-visual-viewport-height, 100dvh); border: 0; border-radius: 0; }
    .settings-content { padding: var(--space-4) var(--space-4) max(var(--space-4), env(safe-area-inset-bottom)); }
  }

  /* P4: a landscape phone is wide (this desktop layout) but short (≈390 px). The 480 px minimum
     height centred the dialog ABOVE the screen: title and close button at y −28, not tappable.
     Short viewports get the whole safe area instead. */
  @media (max-height: 560px) {
    .settings-overlay {
      padding: env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left);
      align-items: stretch;
    }
    .settings-modal { width: 100%; height: 100%; min-height: 0; border-radius: 0; }
    /* Seven tabs and the Log out footer are taller than a landscape phone: the list scrolls. */
    .settings-sidebar { overflow-y: auto; padding-top: var(--space-4); padding-bottom: var(--space-3); }
  }

  @media (prefers-reduced-motion: reduce) {
    .settings-overlay, .settings-modal { animation: none; }
  }
</style>
