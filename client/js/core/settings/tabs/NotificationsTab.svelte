<!-- client/js/core/settings/tabs/NotificationsTab.svelte -->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../../i18n/reactive.svelte.ts';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import type { SettingsStore } from '../stores/settingsStore';
  import {
    disableWebPush, enableWebPush, getWebPushState, sendTestWebPush,
    type ApiFetch, type WebPushReason,
  } from '../../notifications/web-push-client.ts';
  import {
    loadNotificationDevicePolicy, saveNotificationDevicePolicy,
    syncNotificationDevicePolicy, isQuietHoursActive,
    type NotificationDevicePolicy,
  } from '../../notifications/notification-device-policy.ts';

  let { store: _store }: { store: SettingsStore } = $props();

  let pushSupported = $state(false);
  let pushConfigured = $state(false);
  let pushEnabled = $state(false);
  let pushPermission = $state<NotificationPermission | 'unsupported'>('unsupported');
  let pushBusy = $state(false);
  let pushStatus = $state('');
  let pushError = $state('');
  let policy = $state<NotificationDevicePolicy>(loadNotificationDevicePolicy());

  function api(): ApiFetch | null {
    return BridgeRegistry.get<ApiFetch>('apiFetch') ?? null;
  }

  function reasonText(reason?: WebPushReason): string {
    const messages: Record<WebPushReason, string> = {
      unsupported: t('push_unsupported', 'Bu tarayıcı Web Push bildirimlerini desteklemiyor.'),
      permission_denied: t('push_permission_denied', 'Bildirim izni reddedildi. Tarayıcı site ayarlarından izin verebilirsiniz.'),
      not_configured: t('push_not_configured', 'Bu Bridge sunucusunda Web Push henüz yapılandırılmamış.'),
      service_worker_unavailable: t('push_service_worker_unavailable', 'Bridge bildirim hizmeti başlatılamadı.'),
      server_unavailable: t('push_server_unavailable', 'Bildirim tercihi sunucuyla eşitlenemedi.'),
      subscribe_failed: t('push_subscribe_failed', 'Tarayıcı bildirim aboneliği oluşturulamadı.'),
      unsubscribe_failed: t('push_unsubscribe_failed', 'Sunucu bildirimi kapattı; tarayıcıdaki eski abonelik daha sonra temizlenecek.'),
    };
    return reason ? messages[reason] : t("ui_bildirim_ayari_degistirilemedi", "Bildirim ayarı değiştirilemedi.");
  }

  async function refreshPushState(): Promise<void> {
    const fetcher = api();
    if (!fetcher) {
      pushError = t("ui_bildirim_ayarlari_su_anda_kullanilamiyor", "Bildirim ayarları şu anda kullanılamıyor.");
      return;
    }
    const state = await getWebPushState(fetcher);
    pushSupported = state.supported;
    pushConfigured = state.configured;
    pushEnabled = state.subscribed;
    pushPermission = state.permission;
  }

  /** Kontrolün DEVRE DIŞI olduğu koşullar — işaretleme ile tek kaynaktan. */
  const pushBlocked = $derived(!pushSupported || !pushConfigured || pushPermission === 'denied');

  async function togglePush(): Promise<void> {
    const fetcher = api();
    // FAIL-CLOSED: engel koşulu yalnızca `disabled` özniteliğiyle korunuyordu.
    // Tarayıcı devre dışı bir düğmenin tıklamasını bastırır, ama işleyiciye
    // ulaşan HER yol (programatik çağrı, gelecekteki bir klavye kısayolu, ya
    // da testlerdeki doğrudan olay gönderimi) abonelik denemesi başlatabilirdi.
    // Koşul burada da uygulanır.
    if (!fetcher || pushBusy || pushBlocked) return;
    pushBusy = true;
    pushError = '';
    pushStatus = '';
    const desired = !pushEnabled;
    const result = desired ? await enableWebPush(fetcher) : await disableWebPush(fetcher);
    if (!result.ok) pushError = reasonText(result.reason);
    else {
      pushEnabled = desired;
      pushStatus = desired ? t("ui_web_push_bildirimleri_bu_cihazda_etkin", "Web Push bildirimleri bu cihazda etkin.") : t("ui_web_push_bildirimleri_bu_cihazda_kapali", "Web Push bildirimleri bu cihazda kapalı.");
      if (result.reason) pushStatus = reasonText(result.reason);
    }
    await refreshPushState();
    pushBusy = false;
  }

  async function testPush(): Promise<void> {
    const fetcher = api();
    if (!fetcher || pushBusy || !pushEnabled) return;
    pushBusy = true;
    pushError = '';
    pushStatus = '';
    const result = await sendTestWebPush(fetcher);
    if (result.ok) pushStatus = t("ui_test_bildirimi_gonderildi", "Test bildirimi gönderildi.");
    else pushError = reasonText(result.reason);
    pushBusy = false;
  }

  async function persistPolicy(next: NotificationDevicePolicy): Promise<void> {
    policy = next;
    await saveNotificationDevicePolicy(next);
  }

  function setDnd(enabled: boolean): void {
    void persistPolicy({ ...policy, dnd: enabled });
  }

  function setQuietEnabled(enabled: boolean): void {
    void persistPolicy({ ...policy, quietEnabled: enabled });
  }

  function setQuietTime(field: 'quietStart' | 'quietEnd', value: string): void {
    void persistPolicy({ ...policy, [field]: value });
  }

  onMount(() => {
    void refreshPushState();
    void syncNotificationDevicePolicy().then(value => { policy = value; });
  });
</script>

<section aria-labelledby="notifications-heading">
  <h2 id="notifications-heading" class="section-title">{t('notifications')}</h2>

  <div class="settings-card" aria-labelledby="web-push-title">
    <div class="toggle-row">
      <div class="toggle-info">
        <span id="web-push-title" class="toggle-title">{t('markup_web_push_bildirimleri_cfce4a0', "Web Push Bildirimleri")}</span>
        <span class="toggle-desc">{t('ntf_offline_browser', 'Bridge kapalıyken veya arka plandayken tarayıcı bildirimi al')}</span>
      </div>
      <button
        class="toggle-btn"
        class:on={pushEnabled}
        type="button"
        aria-pressed={pushEnabled}
        aria-label={`Web Push bildirimlerini ${pushEnabled ? t("common_off") : t("gsp_open")}`}
        disabled={pushBusy || pushBlocked}
        onclick={() => void togglePush()}
      >
        <span class="toggle-knob"></span>
      </button>
    </div>

    {#if !pushSupported}
      <p class="field-note">{t("push_unsupported")}</p>
    {:else if !pushConfigured}
      <p class="field-note">{t("push_vapid_required")}</p>
    {:else if pushPermission === 'denied'}
      <p class="field-note warning">{t("push_permission_denied")}</p>
    {:else}
      <div class="row-actions">
        <button class="secondary-btn" type="button" disabled={pushBusy || !pushEnabled} onclick={() => void testPush()}>
          {t('markup_test_bildirimi_gonder_53619cf', "Test bildirimi gönder")}
        </button>
      </div>
    {/if}
  </div>

  <div class="settings-card" aria-labelledby="device-attention-title">
    <h3 id="device-attention-title">{t("attention_management_device")}</h3>

    <div class="toggle-row">
      <div class="toggle-info">
        <span class="toggle-title">{t("dnd_title")}</span>
        <span class="toggle-desc">{t('markup_bu_cihazdaki_mesaj_ve_arama_bildirimlerini_tamam_0529799', "Bu cihazdaki mesaj ve arama bildirimlerini tamamen sustur")}</span>
      </div>
      <button
        class="toggle-btn" class:on={policy.dnd} type="button"
        aria-pressed={policy.dnd} aria-label={policy.dnd ? t("notif_dnd_turn_off") : t("notif_dnd_turn_on")}
        onclick={() => setDnd(!policy.dnd)}
      ><span class="toggle-knob"></span></button>
    </div>

    <div class="toggle-row">
      <div class="toggle-info">
        <span class="toggle-title">{t('markup_sessiz_saatler_333396e', "Sessiz Saatler")}</span>
        <span class="toggle-desc">{t("dnd_schedule_hint")}</span>
      </div>
      <button
        class="toggle-btn" class:on={policy.quietEnabled} type="button"
        aria-pressed={policy.quietEnabled} aria-label={`Sessiz saatleri ${policy.quietEnabled ? t("common_off") : t("gsp_open")}`}
        onclick={() => setQuietEnabled(!policy.quietEnabled)}
      ><span class="toggle-knob"></span></button>
    </div>

    {#if policy.quietEnabled}
      <div class="quiet-grid" aria-label={t("quiet_hours_range")}>
        <label>
          <span>{t("audit_start")}</span>
          <input type="time" value={policy.quietStart} onchange={(e) => setQuietTime('quietStart', e.currentTarget.value)} />
        </label>
        <label>
          <span>{t("audit_end")}</span>
          <input type="time" value={policy.quietEnd} onchange={(e) => setQuietTime('quietEnd', e.currentTarget.value)} />
        </label>
      </div>
      <p class="field-note" aria-live="polite">
        {isQuietHoursActive(policy) ? t("surface_sessiz_saatler_su_anda_etkin_115bea") : t("surface_sessiz_saatler_su_anda_etkin_degil_da4ac4")}
        {t("ui_quiet_hours_overnight")}
      </p>
    {/if}
  </div>

  {#if pushError}<p class="status error" role="alert">{pushError}</p>{/if}
  {#if pushStatus}<p class="status" role="status" aria-live="polite">{pushStatus}</p>{/if}
</section>

<style>
  .section-title { font-size: 20px; font-weight: 700; margin: 0 0 24px; color: var(--text-primary, #e4e6eb); }
  .settings-card { padding: 0 0 18px; margin-bottom: 18px; border-bottom: 1px solid var(--border-subtle, rgba(255,255,255,0.08)); }
  .settings-card h3 { margin: 0 0 8px; font-size: 15px; color: var(--text-primary, #e4e6eb); }
  .toggle-row { display: flex; align-items: center; justify-content: space-between; gap: 16px; padding: 14px 0; }
  .toggle-info { display: flex; flex-direction: column; gap: 3px; min-width: 0; }
  .toggle-title { font-size: 14px; font-weight: 600; color: var(--text-primary, #e4e6eb); }
  .toggle-desc { font-size: 12px; line-height: 1.45; color: var(--text-muted, #6d6f78); }
  .toggle-btn { position: relative; width: 44px; height: 24px; border: 0; border-radius: 999px; background: var(--bg-input); cursor: pointer; transition: background 0.18s ease; flex: 0 0 auto; }
  .toggle-btn.on { background: var(--brand, #2d9cdb); }
  .toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .toggle-knob { position: absolute; top: 2px; left: 2px; width: 20px; height: 20px; border-radius: 50%; background: var(--text-on-solid, white); transition: transform 0.18s ease; }
  .toggle-btn.on .toggle-knob { transform: translateX(20px); }
  .field-note { margin: 4px 0 0; font-size: 12px; line-height: 1.45; color: var(--text-muted, #6d6f78); }
  .warning { color: var(--warning, #f0b232); }
  .row-actions { display: flex; gap: 8px; margin-top: 8px; }
  .secondary-btn { min-height: 34px; padding: 0 12px; border: 1px solid var(--border-strong, rgba(255,255,255,0.14)); border-radius: var(--radius-sm, 6px); background: var(--bg-3); color: var(--text-primary); cursor: pointer; }
  .secondary-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .quiet-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin-top: 4px; }
  .quiet-grid label { display: grid; gap: 6px; font-size: 12px; color: var(--text-secondary); }
  .quiet-grid input { min-height: 36px; padding: 0 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm, 6px); background: var(--bg-input); color: var(--text-primary); color-scheme: dark; }
  .status { margin: 8px 0 0; padding: 9px 11px; border-radius: var(--radius-sm, 6px); background: var(--bg-3); font-size: 12px; color: var(--text-secondary); }
  .status.error { color: var(--danger-text, #ff8f8f); }
  @media (max-width: 520px) { .quiet-grid { grid-template-columns: 1fr; } }
</style>
