<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { safeHexColor } from '../../avatar-color.ts';
  import { onMount } from 'svelte';
  import { apiFetch } from '../../api-fetch.js';
  import { getAPI } from '../../globals.js';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';
  import { safeApiErrorMessage } from '../../api-error.ts';

  interface RoleRow {
    _id: string;
    name: string;
    color?: string;
    position?: number;
    displayOnProfile?: boolean;
  }

  const server = getCurrentServerFromRegistry();
  const serverId = String(server?._id ?? server?.id ?? '');

  let roles = $state<RoleRow[]>([]);
  let loading = $state(true);
  let error = $state('');
  let savingRoleId = $state('');

  const safeColor = (value: unknown): string => safeHexColor(value, 'var(--text-muted)');

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      // Ürün tarafından yazılmış, çevrilmiş ve güvenli mesajları `throw` edip
      // aşağıdaki `catch` içinde `safeApiErrorMessage`e vermek onları YOK
      // EDİYORDU: Response olmayan bir Error sınıflandırılamaz ve genel yedek
      // metin döner. Kullanıcı "Sunucu seçilmedi." / "Rolleri yönetme
      // yetkiniz yok." yerine "Roller yüklenemedi." görüyordu.
      if (!serverId) { error = t("ssm_no_server", "Sunucu seçilmedi."); roles = []; return; }
      const res = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/roles`);
      if (!res.ok) {
        if (res.status === 403) {
          error = t("ui_rolleri_yonetme_yetkiniz_yok", "Rolleri yönetme yetkiniz yok.");
          roles = [];
          return;
        }
        error = safeApiErrorMessage(res, t("ui_roller_yuklenemedi", "Roller yüklenemedi."), { report: true });
        roles = [];
        return;
      }
      const data = await res.json() as RoleRow[];
      roles = (Array.isArray(data) ? data : [])
        .map(role => ({ ...role, displayOnProfile: role.displayOnProfile !== false }))
        .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0));
    } catch (err) {
      error = safeApiErrorMessage(err, t("ui_roller_yuklenemedi", "Roller yüklenemedi."), { report: true });
      roles = [];
    } finally {
      loading = false;
    }
  }

  async function setProfileVisibility(role: RoleRow, next: boolean, input: HTMLInputElement): Promise<void> {
    if (savingRoleId) {
      input.checked = role.displayOnProfile !== false;
      return;
    }
    if (!isStillCurrentServer(serverId)) {
      error = t("ui_sunucu_degisti_roller_yeniden_yuklenmeli", "Sunucu değişti — roller yeniden yüklenmeli.");
      input.checked = role.displayOnProfile !== false;
      return;
    }

    savingRoleId = role._id;
    error = '';
    try {
      const res = await apiFetch(
        `${getAPI()}/api/servers/${encodeURIComponent(serverId)}/roles/${encodeURIComponent(role._id)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayOnProfile: next }),
        },
      );
      if (!res.ok) {
        error = safeApiErrorMessage(res, t("ui_rol_guncellenemedi", "Rol güncellenemedi."), { report: true });
        input.checked = role.displayOnProfile !== false;
        return;
      }
      const updated = await res.json() as RoleRow;
      roles = roles.map(item => item._id === role._id
        ? { ...item, displayOnProfile: updated.displayOnProfile !== false }
        : item);
    } catch (err) {
      error = safeApiErrorMessage(err, t("ui_rol_guncellenemedi", "Rol güncellenemedi."), { report: true });
      input.checked = role.displayOnProfile !== false;
    } finally {
      savingRoleId = '';
    }
  }

  onMount(() => { void load(); });
</script>

<section aria-labelledby="roles-heading">
  <h2 id="roles-heading" class="roles-title">{t('markup_profil_rolleri_9d2dc77', "Profil rolleri")}</h2>
  <p class="roles-help">
    {t('markup_uyelerin_profillerinde_hangi_sunucu_rollerinin_g_9b664c7', "Üyelerin profillerinde hangi sunucu rollerinin görüneceğini seçin. Bu ayar izinleri veya rol hiyerarşisini değiştirmez.")}
  </p>

  {#if loading}
    <p class="roles-state" aria-live="polite">{t('rt_loading', 'Roller yükleniyor…')}</p>
  {:else if error && roles.length === 0}
    <p class="roles-state roles-error" role="alert">{error}</p>
    <button type="button" class="roles-retry" onclick={() => void load()}>{t('retry')}</button>
  {:else if roles.length === 0}
    <p class="roles-state">{t('markup_bu_sunucuda_rol_yok_18e2681', "Bu sunucuda rol yok.")}</p>
  {:else}
    {#if error}<p class="roles-state roles-error" role="alert">{error}</p>{/if}
    <div class="roles-list" aria-label={t('attr_sunucu_rolleri_fb7c7bc', "Sunucu rolleri")}>
      {#each roles as role (role._id)}
        <label class="role-row">
          <span class="role-identity">
            <span class="role-dot" style={`background:${safeColor(role.color)}`} aria-hidden="true"></span>
            <span class="role-name" title={role.name}>{role.name}</span>
          </span>
          <span class="role-control">
            <span>{role.displayOnProfile !== false ? t("surface_profilde_gosteriliyor_0232ec") : t('role_hidden_profile')}</span>
            <input
              type="checkbox"
              checked={role.displayOnProfile !== false}
              disabled={Boolean(savingRoleId)}
              aria-label={t('role_show_profile_aria', undefined, { role: role.name })}
              onchange={(event) => {
                const input = event.currentTarget;
                void setProfileVisibility(role, input.checked, input);
              }}
            />
          </span>
        </label>
      {/each}
    </div>
  {/if}
</section>

<style>
  .roles-title { margin: 0; font-size: var(--type-title-sm); color: var(--text-primary); }
  .roles-help { margin: 6px 0 16px; color: var(--text-2); font-size: var(--type-body-sm); line-height: 1.45; }
  .roles-state { margin: 0 0 10px; color: var(--text-muted); font-size: var(--type-body-sm); }
  .roles-error { color: var(--danger); }
  .roles-retry {
    border: 1px solid var(--border-subtle); border-radius: var(--radius-control);
    background: var(--surface-2); color: var(--text-primary); padding: 8px 12px; cursor: pointer;
  }
  .roles-list { display: grid; gap: 6px; max-height: 52vh; overflow-y: auto; padding-right: 4px; }
  .role-row {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    min-height: 44px; padding: 8px 10px; border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control); background: var(--surface-1);
  }
  .role-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .role-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .role-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
  .role-control { display: flex; align-items: center; gap: 10px; flex: none; color: var(--text-2); font-size: var(--type-caption); }
  .role-control input { width: 18px; height: 18px; accent-color: var(--brand); }
  .role-control input:focus-visible, .roles-retry:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  @media (max-width: 620px) {
    .role-row { align-items: flex-start; flex-direction: column; gap: 8px; }
    .role-control { width: 100%; justify-content: space-between; }
  }
</style>
