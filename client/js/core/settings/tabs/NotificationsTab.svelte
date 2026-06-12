<!-- client/js/core/settings/tabs/NotificationsTab.svelte -->
<script lang="ts">
  import type { SettingsStore } from '../stores/settingsStore';
  let { store }: { store: SettingsStore } = $props();

  // Web Push durumu — mevcut web-push.ts'ten senkronize gelir
  let pushEnabled = $state(window.__bridgePushEnabled ?? false);
  let pushBusy = $state(false);

  async function togglePush() {
    pushBusy = true;
    try {
      const registry = window.BridgeRegistry;
      if (pushEnabled) {
        await registry?.call?.('push:disable');
        pushEnabled = false;
      } else {
        await registry?.call?.('push:enable');
        pushEnabled = true;
      }
    } finally {
      pushBusy = false;
    }
  }
</script>

<section aria-labelledby="notifications-heading">
  <h2 id="notifications-heading" class="section-title">Bildirimler</h2>

  <div class="toggle-row">
    <div class="toggle-info">
      <span class="toggle-title">Web Push Bildirimleri</span>
      <span class="toggle-desc">Çevrimdışıyken tarayıcı bildirimi al</span>
    </div>
    <button
      class="toggle-btn"
      class:on={pushEnabled}
      aria-pressed={pushEnabled}
      aria-label="Web Push bildirimlerini {pushEnabled ? 'kapat' : 'aç'}"
      disabled={pushBusy}
      onclick={togglePush}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>
</section>

<style>
  .section-title { font-size: 20px; font-weight: 700; margin: 0 0 24px; color: var(--text-primary, #e4e6eb); }

  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 0;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }

  .toggle-info { display: flex; flex-direction: column; gap: 2px; }
  .toggle-title { font-size: 14px; font-weight: 500; color: var(--text-primary, #e4e6eb); }
  .toggle-desc  { font-size: 12px; color: var(--text-muted, #6d6f78); }

  .toggle-btn {
    position: relative;
    width: 44px;
    height: 24px;
    border: none;
    border-radius: 12px;
    background: var(--bg-input, rgba(0,0,0,0.3));
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }

  .toggle-btn.on { background: var(--brand, #2d9cdb); }
  .toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .toggle-knob {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s;
  }

  .toggle-btn.on .toggle-knob { transform: translateX(20px); }
</style>
