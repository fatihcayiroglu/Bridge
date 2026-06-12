<!-- client/js/core/settings/SettingsModal.svelte -->
<!-- ADR-0002 Faz 1 — SettingsModal pilot bileşeni.               -->
<!-- settings-modal.ts (726 satır) → bu bileşen + tab modülleri.  -->
<!-- Mevcut Vanilla JS davranışı korunur; BridgeRegistry üzerinden -->
<!-- haberleşme yapılır.                                           -->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { createSettingsStore, type SettingsTab } from './stores/settingsStore';
  import ProfileTab       from './tabs/ProfileTab.svelte';
  import AppearanceTab    from './tabs/AppearanceTab.svelte';
  import NotificationsTab from './tabs/NotificationsTab.svelte';
  import PrivacyTab       from './tabs/PrivacyTab.svelte';
  import DevicesTab       from './tabs/DevicesTab.svelte';

  // ── Props ─────────────────────────────────────────────────────────────────
  interface Props {
    initialTab?: SettingsTab;
    onClose?:    () => void;
  }

  let { initialTab = 'profile', onClose }: Props = $props();

  // ── Store ─────────────────────────────────────────────────────────────────
  function getInitialTab(): SettingsTab { return initialTab; }
  const store = createSettingsStore(getInitialTab());

  // ── Tab tanımları ─────────────────────────────────────────────────────────
  const TABS: Array<{ id: SettingsTab; label: string; icon: string }> = [
    { id: 'profile',       label: 'Profil',       icon: '👤' },
    { id: 'appearance',    label: 'Görünüm',       icon: '🎨' },
    { id: 'notifications', label: 'Bildirimler',   icon: '🔔' },
    { id: 'privacy',       label: 'Gizlilik',      icon: '🔒' },
    { id: 'devices',       label: 'Cihazlar',      icon: '🎙️' },
  ];

  // ── Klavye desteği ────────────────────────────────────────────────────────
  function handleKeydown(e: KeyboardEvent) {
    if (e.key === 'Escape') close();
  }

  function close() {
    onClose?.();
    // BridgeRegistry köprüsü aracılığıyla Vanilla JS tarafını bilgilendir
    (window as unknown as { BridgeRegistry?: { emit?: (ev: string) => void } })
      .BridgeRegistry?.emit?.('settings:closed');
  }

  onMount(() => {
    window.addEventListener('keydown', handleKeydown);
    // İlk odağı modal'a ver — a11y
    document.getElementById('settings-modal-content')?.focus();
  });

  onDestroy(() => {
    window.removeEventListener('keydown', handleKeydown);
  });

  // ── Aktif tab bileşeni ────────────────────────────────────────────────────
  const TAB_COMPONENTS: Record<SettingsTab, any> = {
    profile:       ProfileTab,
    appearance:    AppearanceTab,
    notifications: NotificationsTab,
    privacy:       PrivacyTab,
    devices:       DevicesTab,
  };

  let ActiveComponent = $derived(TAB_COMPONENTS[store.activeTab] as any);
</script>

<!-- ── Overlay ──────────────────────────────────────────────────────────────── -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<div
  class="settings-overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Ayarlar"
  tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div
    id="settings-modal-content"
    class="settings-modal"
    tabindex="-1"
  >
    <!-- ── Sidebar ──────────────────────────────────────────────────────── -->
    <nav class="settings-sidebar" aria-label="Ayarlar kategorileri">
      <h2 class="settings-sidebar-title">Ayarlar</h2>
      <ul role="tablist">
        {#each TABS as tab (tab.id)}
          <li role="presentation">
            <button
              role="tab"
              id="tab-{tab.id}"
              aria-selected={store.activeTab === tab.id}
              aria-controls="tabpanel-{tab.id}"
              class="settings-tab-btn"
              class:active={store.activeTab === tab.id}
              onclick={() => store.setTab(tab.id)}
            >
              <span class="tab-icon" aria-hidden="true">{tab.icon}</span>
              {tab.label}
            </button>
          </li>
        {/each}
      </ul>
    </nav>

    <!-- ── İçerik paneli ────────────────────────────────────────────────── -->
    <div
      id="tabpanel-{store.activeTab}"
      role="tabpanel"
      aria-labelledby="tab-{store.activeTab}"
      class="settings-content"
    >
      {#if store.error}
        <div class="settings-error" role="alert">{store.error}</div>
      {/if}

      {#if ActiveComponent}
        <ActiveComponent {store} />
      {/if}
    </div>

    <!-- ── Kapat butonu ──────────────────────────────────────────────────── -->
    <button
      class="settings-close"
      aria-label="Ayarları kapat"
      onclick={close}
    >✕</button>
  </div>
</div>

<style>
  .settings-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.6);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
  }

  .settings-modal {
    position: relative;
    display: flex;
    width: min(900px, 95vw);
    height: min(680px, 90vh);
    background: var(--bg-primary, #1a1b1e);
    border-radius: 12px;
    overflow: hidden;
    outline: none;
  }

  .settings-sidebar {
    width: 220px;
    flex-shrink: 0;
    background: var(--bg-secondary, #141517);
    padding: 24px 12px;
    overflow-y: auto;
  }

  .settings-sidebar-title {
    font-size: 11px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted, #6d6f78);
    padding: 0 8px 12px;
    margin: 0 0 4px;
  }

  .settings-sidebar ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .settings-tab-btn {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 12px;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--text-secondary, #b0b3bb);
    font-size: 14px;
    cursor: pointer;
    text-align: left;
    transition: background 0.1s, color 0.1s;
  }

  .settings-tab-btn:hover {
    background: var(--bg-hover, rgba(255,255,255,0.06));
    color: var(--text-primary, #e4e6eb);
  }

  .settings-tab-btn.active {
    background: var(--bg-active, rgba(114, 137, 218, 0.15));
    color: var(--brand, #2d9cdb);
  }

  .tab-icon { font-size: 16px; }

  .settings-content {
    flex: 1;
    padding: 32px;
    overflow-y: auto;
    color: var(--text-primary, #e4e6eb);
  }

  .settings-error {
    background: rgba(237, 66, 69, 0.12);
    border: 1px solid rgba(237, 66, 69, 0.4);
    border-radius: 6px;
    padding: 10px 14px;
    margin-bottom: 16px;
    font-size: 13px;
    color: #ed4245;
  }


  .settings-close {
    position: absolute;
    top: 12px;
    right: 12px;
    width: 32px;
    height: 32px;
    border: none;
    border-radius: 50%;
    background: var(--bg-hover, rgba(255,255,255,0.08));
    color: var(--text-secondary, #b0b3bb);
    font-size: 16px;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: background 0.1s, color 0.1s;
  }

  .settings-close:hover {
    background: rgba(237, 66, 69, 0.15);
    color: #ed4245;
  }
</style>
