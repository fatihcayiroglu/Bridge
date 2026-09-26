<!-- client/js/core/settings/tabs/ProfileTab.svelte -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import type { SettingsStore } from '../stores/settingsStore';
  import { getCurrentUser } from '../../state';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import { updateUserPanel } from '../../auth-compat.ts';

  type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';
  type PresenceAck = { ok: boolean; status?: PresenceStatus; code?: string };
  type SocketLike = {
    connected?: boolean;
    emit(event: 'status:update', payload: { status: PresenceStatus }, ack: (result: PresenceAck) => void): void;
  };

  let { store }: { store: SettingsStore } = $props();

  const user = getCurrentUser();
  const currentDisplayName = user?.displayName ?? '';

  function normalizePresence(value: unknown): PresenceStatus {
    return value === 'idle' || value === 'dnd' || value === 'offline' || value === 'online'
      ? value
      : 'online';
  }

  const presenceOptions: Array<{ value: PresenceStatus; label: string; hint: string }> = $derived.by(() => [
    { value: 'online',  label: t("members_online", "Çevrimiçi"),          hint: t("ui_bridge_acikken_cevrimici_gorun", "Bridge açıkken çevrimiçi görün.") },
    { value: 'idle',    label: t("status_idle", "Boşta"),              hint: t("ui_daha_az_dikkat_cekici_bir_durum_goster", "Daha az dikkat çekici bir durum göster.") },
    { value: 'dnd',     label: t("status_dnd", "Rahatsız etmeyin"),   hint: t("ui_musait_olmadigini_acikca_belirt", "Müsait olmadığını açıkça belirt.") },
    { value: 'offline', label: t("ui_cevrimdisi_gorun", "Çevrimdışı görün"),   hint: t("ui_bagli_olsan_bile_cevrimdisi_gorun", "Bağlı olsan bile çevrimdışı görün.") },
  ]);

  let initialDisplayName = $state(currentDisplayName);
  let displayName = $state(currentDisplayName);
  let saving = $state(false);
  let dirty = $derived(displayName !== initialDisplayName);

  let presenceStatus = $state<PresenceStatus>(normalizePresence(user?.presenceStatus ?? user?.status));
  let savingPresence = $state(false);
  let presenceError = $state('');

  async function save() {
    if (saving || !dirty) return;
    saving = true;
    try {
      const ok = await store.save({ displayName });
      if (ok) {
        initialDisplayName = displayName;
        if (user) {
          user.displayName = displayName;
          updateUserPanel(user);
        }
      }
    } finally {
      saving = false;
    }
  }

  async function setPresence(next: PresenceStatus): Promise<void> {
    if (savingPresence || next === presenceStatus) return;
    const socket = BridgeRegistry.get<SocketLike>('socket');
    if (!socket?.connected) {
      presenceError = t("ui_durum_degistirilemedi_baglantini_kontrol_edip_yenide", "Durum değiştirilemedi. Bağlantını kontrol edip yeniden dene.");
      return;
    }

    savingPresence = true;
    presenceError = '';
    try {
      const result = await new Promise<PresenceAck>((resolve) => {
        let settled = false;
        const timer = window.setTimeout(() => {
          if (!settled) {
            settled = true;
            resolve({ ok: false, code: 'ACK_TIMEOUT' });
          }
        }, 5_000);
        socket.emit('status:update', { status: next }, (ack) => {
          if (settled) return;
          settled = true;
          window.clearTimeout(timer);
          resolve(ack && typeof ack === 'object' ? ack : { ok: false, code: 'INVALID_ACK' });
        });
      });

      if (!result.ok) {
        presenceError = result.code === 'INVALID_STATUS'
          ? t("ui_bu_durum_secenegi_kullanilamiyor", "Bu durum seçeneği kullanılamıyor.")
          : t("ui_durum_degistirilemedi_yeniden_dene", "Durum değiştirilemedi. Yeniden dene.");
        return;
      }

      // ACK is authoritative. Do not move the selected state before success.
      presenceStatus = next;
      if (user) {
        user.presenceStatus = next;
        user.status = result.status ?? next;
        updateUserPanel(user);
      }
    } finally {
      savingPresence = false;
    }
  }
</script>

<section aria-labelledby="profile-heading">
  <h2 id="profile-heading" class="section-title">{t('profile')}</h2>

  <div class="field-group">
    <label class="field-label" for="display-name">{t('prf_display_name', 'Görünen Ad')}</label>
    <input
      id="display-name"
      class="field-input"
      type="text"
      maxlength="32"
      bind:value={displayName}
      placeholder={t('prf_display_ph', 'Görünen adınız')}
    />
  </div>

  <div class="field-group presence-group">
    <span class="field-label" id="presence-label">{t("profile_presence_status")}</span>
    <div class="presence-options" role="radiogroup" aria-labelledby="presence-label" aria-busy={savingPresence}>
      {#each presenceOptions as option (option.value)}
        <button
          type="button"
          class="presence-option"
          class:is-selected={presenceStatus === option.value}
          role="radio"
          aria-checked={presenceStatus === option.value}
          disabled={savingPresence}
          onclick={() => void setPresence(option.value)}
        >
          <span class="presence-dot {option.value}" aria-hidden="true"></span>
          <span class="presence-copy">
            <strong>{option.label}</strong>
            <small>{option.hint}</small>
          </span>
          {#if savingPresence && presenceStatus !== option.value}
            <span class="presence-saving" aria-hidden="true"></span>
          {/if}
        </button>
      {/each}
    </div>
    <p class="field-note">{t('markup_secimin_hesabina_kaydedilir_ve_yeniden_baglandig_c311fbc', "Seçimin hesabına kaydedilir ve yeniden bağlandığında korunur. Gizli varlık tercihi her zaman önceliklidir.")}</p>
    {#if presenceError}<p class="field-error" role="alert">{presenceError}</p>{/if}
  </div>

  <div class="field-actions">
    <button
      class="btn btn--primary"
      disabled={!dirty || saving}
      onclick={save}
    >
      {saving ? t('ui_saving') : t('save')}
    </button>
  </div>
</section>

<style>
  .section-title {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 24px;
    color: var(--text-primary, #e4e6eb);
  }

  .field-group { margin-bottom: 20px; }

  .field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted, #6d6f78);
    margin-bottom: 6px;
  }

  .field-input {
    width: 100%;
    max-width: 400px;
    padding: 10px 12px;
    border: 1px solid var(--border, rgba(255,255,255,0.1));
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-primary, #e4e6eb);
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }

  .field-input:focus { border-color: var(--brand, #2d9cdb); }

  .presence-group { max-width: 520px; }
  .presence-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
  .presence-option {
    min-width: 0;
    min-height: 58px;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 9px 10px;
    text-align: left;
    color: var(--text-primary, #e4e6eb);
    background: var(--bg-3, rgba(255,255,255,.035));
    border: 1px solid var(--border, rgba(255,255,255,.1));
    border-radius: var(--radius-md, 8px);
    cursor: pointer;
  }
  .presence-option:hover:not(:disabled) { background: var(--bg-hover, rgba(255,255,255,.06)); }
  .presence-option:focus-visible { outline: 2px solid var(--focus, var(--brand, #2d9cdb)); outline-offset: 2px; }
  .presence-option.is-selected { border-color: var(--brand, #2d9cdb); background: var(--brand-subtle, rgba(45,156,219,.09)); }
  .presence-option:disabled { cursor: wait; opacity: .7; }
  .presence-dot { width: 10px; height: 10px; flex: 0 0 10px; border-radius: 50%; background: var(--success, #23a55a); }
  .presence-dot.idle { background: var(--warning, #f0b232); }
  .presence-dot.dnd { background: var(--danger, #f23f43); }
  .presence-dot.offline { background: var(--text-muted, #6d6f78); }
  .presence-copy { min-width: 0; display: grid; gap: 2px; }
  .presence-copy strong { font-size: 13px; line-height: 1.2; }
  .presence-copy small { color: var(--text-muted, #6d6f78); font-size: 11px; line-height: 1.25; }
  .presence-saving { margin-left: auto; width: 12px; height: 12px; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: spin .7s linear infinite; }

  .field-actions { margin-top: 8px; }
  .field-note { max-width: 520px; margin: 8px 0 0; color: var(--text-muted, #6d6f78); font-size: 12px; line-height: 1.45; }
  .field-error { max-width: 520px; margin: 7px 0 0; color: var(--danger, #f23f43); font-size: 12px; }

  .btn { padding: 9px 20px; border: none; border-radius: 6px; font-size: 14px; font-weight: 600; cursor: pointer; transition: opacity 0.1s, background 0.1s; }
  .btn--primary { background: var(--brand, #2d9cdb); color: var(--text-on-solid); }
  .btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn--primary:not(:disabled):hover { background: var(--brand-hover, #677bc4); }

  @keyframes spin { to { transform: rotate(360deg); } }
  @media (max-width: 600px) { .presence-options { grid-template-columns: 1fr; } }
  @media (prefers-reduced-motion: reduce) { .presence-saving { animation: none; } }
</style>
