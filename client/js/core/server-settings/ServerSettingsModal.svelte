<!-- client/js/core/server-settings/ServerSettingsModal.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts (623 satır) tam Svelte geçişi        -->
<!-- Sprint 114: Eski "buton listesi" → gerçek tab navigasyonu                 -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import GeneralTab   from './tabs/GeneralTab.svelte';
  import MediaTab     from './tabs/MediaTab.svelte';
  import EmojiTab     from './tabs/EmojiTab.svelte';
  import WebhookTab   from './tabs/WebhookTab.svelte';
  import AuditLogTab  from './tabs/AuditLogTab.svelte';
  import SsoTab       from './tabs/SsoTab.svelte';
  import PluginTab    from './tabs/PluginTab.svelte';
  import { createServerSettingsStore, getCurrentServerFromRegistry } from './stores/serverSettingsStore';
  import { BridgeRegistry } from '../bridge-registry.js';

  type TabId = 'general' | 'media' | 'emoji' | 'webhooks' | 'audit' | 'sso' | 'plugins' | 'onboarding';

  interface Props {
    initialTab?: TabId;
    onClose?: () => void;
  }

  let { initialTab = 'general', onClose }: Props = $props();

  const server = getCurrentServerFromRegistry();
  const store  = server ? createServerSettingsStore(server) : null;

  interface Tab { id: TabId; label: string; icon: string; }
  const TABS: Tab[] = [
    { id: 'general',    label: 'Genel',       icon: '⚙️'  },
    { id: 'media',      label: 'Görsel',       icon: '🖼'  },
    { id: 'emoji',      label: 'Emoji',        icon: '😀'  },
    { id: 'webhooks',   label: 'Webhooklar',   icon: '🔗'  },
    { id: 'audit',      label: 'Audit Log',    icon: '📋'  },
    { id: 'sso',        label: 'SSO',          icon: '🔐'  },
    { id: 'plugins',    label: 'Plugin',       icon: '🧩'  },
    { id: 'onboarding', label: 'Onboarding',   icon: '🚀'  },
  ];

  // activeTab starts from the prop; user clicks update it independently.
  function getInitialTab(): TabId { return initialTab; }
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
  function openDiscordImport(): void {
    close();
    BridgeRegistry.call('openDiscordImport');
  }
  function openOutgoingWebhooks(): void {
    close();
    BridgeRegistry.call('openOutgoingWebhookManager');
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
  aria-label="Sunucu ayarları"
  tabindex="-1"
  onclick={(e) => { if (e.target === e.currentTarget) close(); }}
>
  <div class="ss-card">
    {#if !server || !store}
      <p>Sunucu seçilmedi.</p>
      <button type="button" class="btn" onclick={close}>Kapat</button>
    {:else}
      <!-- Header -->
      <div class="ss-header">
        <h2 class="ss-title">⚙️ Sunucu Ayarları</h2>
        <button type="button" class="ss-close" aria-label="Kapat" onclick={close}>✕</button>
      </div>

      <div class="ss-body">
        <!-- Sidebar nav -->
        <nav class="ss-nav" aria-label="Ayar kategorileri">
          {#each TABS as tab (tab.id)}
            <button
              type="button"
              class="ss-nav-btn"
              class:active={activeTab === tab.id}
              onclick={() => { activeTab = tab.id; }}
              aria-current={activeTab === tab.id ? 'page' : undefined}
            >
              <span class="ss-nav-icon">{tab.icon}</span>
              <span class="ss-nav-label">{tab.label}</span>
            </button>
          {/each}

          <!-- Non-tab actions (delegated to vanilla or BridgeRegistry) -->
          <div class="ss-nav-divider"></div>
          <button type="button" class="ss-nav-btn ss-nav-btn--action" onclick={openOutgoingWebhooks}>
            <span class="ss-nav-icon">📤</span>
            <span class="ss-nav-label">Giden Webhook</span>
          </button>
          <button type="button" class="ss-nav-btn ss-nav-btn--action" onclick={openDiscordImport}>
            <span class="ss-nav-icon">📥</span>
            <span class="ss-nav-label">Discord İçe Aktar</span>
          </button>
        </nav>

        <!-- Tab content -->
        <div class="ss-content">
          {#if activeTab === 'general'}
            <GeneralTab {store} />
          {:else if activeTab === 'media'}
            <MediaTab {store} />
          {:else if activeTab === 'emoji'}
            <EmojiTab />
          {:else if activeTab === 'webhooks'}
            <WebhookTab />
          {:else if activeTab === 'audit'}
            <AuditLogTab />
          {:else if activeTab === 'sso'}
            <SsoTab />
          {:else if activeTab === 'plugins'}
            <PluginTab />
          {:else if activeTab === 'onboarding'}
            <div class="ss-delegated">
              <p>Onboarding ayarları için:</p>
              <button type="button" class="btn btn-primary" onclick={openOnboarding}>
                🚀 Onboarding Ayarlarını Aç
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
    z-index: 1000;
    background: rgba(0, 0, 0, 0.55);
    align-items: center;
    justify-content: center;
  }

  /* ── Card ──────────────────────────────────────────────────── */
  .ss-card {
    width: min(760px, 95vw);
    max-height: 85vh;
    background: var(--bg-primary, #1e1f22);
    border-radius: 12px;
    display: flex;
    flex-direction: column;
    overflow: hidden;
    box-shadow: 0 8px 32px rgba(0,0,0,.45);
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
    background: none; border: none;
    color: var(--text-muted); cursor: pointer;
    font-size: 16px; padding: 4px 8px; border-radius: 4px;
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
  .ss-nav-btn.active     { background: var(--brand-alpha, rgba(88,101,242,.2)); color: var(--brand, #5865f2); font-weight: 600; }
  .ss-nav-btn--action    { color: var(--text-muted); font-size: 12px; }
  .ss-nav-icon           { font-size: 15px; flex-shrink: 0; }
  .ss-nav-divider        { height: 1px; background: var(--border); margin: 6px 4px; }

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
</style>
