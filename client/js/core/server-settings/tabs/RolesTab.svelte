<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { safeHexColor } from '../../avatar-color.ts';
  import { onMount } from 'svelte';
  import { apiFetch } from '../../api-fetch.js';
  import { getAPI } from '../../globals.js';
  import { fetchMyPermissions, hasPerm, PERM_MANAGE_ROLES } from '../../permissions/myPermissions.js';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';
  import { safeApiErrorMessage } from '../../api-error.ts';

  interface RoleRow {
    _id: string;
    name: string;
    color?: string;
    position?: number;
    permissions?: number;
    displayOnProfile?: boolean;
  }
  type EditorMode = 'closed' | 'create' | 'edit';
  type PermissionOption = { bit: number; label: string };
  type PermissionGroup = { title: string; options: PermissionOption[] };

  // Mirrors the backend's supported flag allowlist (server/lib/permissions.ts).
  // Never treat a client-side flag as authorization: the API enforces the
  // actor's grant ceiling, role hierarchy and MANAGE_ROLES on every mutation.
  const PERMISSION_GROUPS: PermissionGroup[] = [
    { title: t('role_group_general', 'Genel'), options: [
      { bit: 1 << 0, label: t('role_perm_view', 'Kanalları görüntüle') },
      { bit: 1 << 8, label: t('role_perm_send', 'Mesaj gönder') },
      { bit: 1 << 15, label: t('role_perm_history', 'Mesaj geçmişini oku') },
      { bit: 1 << 10, label: t('role_perm_embeds', 'Bağlantıları göm') },
      { bit: 1 << 11, label: t('role_perm_files', 'Dosya ekle') },
      { bit: 1 << 12, label: t('role_perm_reactions', 'Tepki ekle') },
      { bit: 1 << 13, label: t('role_perm_slash', 'Slash komutlarını kullan') },
      { bit: 1 << 14, label: t('role_perm_mentions', 'Herkesten bahset') },
      { bit: 1 << 21, label: t('role_perm_bots', 'Bot komutlarını kullan') },
    ] },
    { title: t('role_group_voice', 'Ses'), options: [
      { bit: 1 << 16, label: t('role_perm_connect', 'Ses kanalına bağlan') },
      { bit: 1 << 17, label: t('role_perm_speak', 'Konuş') },
      { bit: 1 << 18, label: t('role_perm_mute', 'Üyeleri sustur') },
      { bit: 1 << 19, label: t('role_perm_deafen', 'Üyeleri sağırlaştır') },
      { bit: 1 << 20, label: t('role_perm_move', 'Üyeleri taşı') },
    ] },
    { title: t('role_group_moderation', 'Moderasyon ve yönetim'), options: [
      { bit: 1 << 4, label: t('role_perm_kick', 'Üyeleri çıkar') },
      { bit: 1 << 5, label: t('role_perm_ban', 'Üyeleri yasakla') },
      { bit: 1 << 6, label: t('role_perm_nicknames', 'Takma adları yönet') },
      { bit: 1 << 7, label: t('role_perm_timeout', 'Üyeleri zaman aşımına al') },
      { bit: 1 << 9, label: t('role_perm_manage_messages', 'Mesajları yönet') },
      { bit: 1 << 1, label: t('role_perm_manage_channels', 'Kanalları yönet') },
      { bit: 1 << 2, label: t('role_perm_manage_roles', 'Rolleri yönet') },
      { bit: 1 << 3, label: t('role_perm_manage_server', 'Sunucuyu yönet') },
      { bit: 1 << 24, label: t('role_perm_manage_webhooks', 'Webhookları yönet') },
    ] },
    { title: t('role_group_admin', 'Yüksek yetki'), options: [
      { bit: 1 << 30, label: t('role_perm_administrator', 'Yönetici (tüm izinler)') },
    ] },
  ];
  const KNOWN_MASK = PERMISSION_GROUPS.flatMap(g => g.options).reduce((mask, option) => mask | option.bit, 0);
  function canonicalMask(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) ||
        value < 0 || value > 0x7fffffff || (value & ~KNOWN_MASK) !== 0) return null;
    return value;
  }
  function editorColor(value: unknown): string {
    if (typeof value !== 'string') return '#99aab5';
    if (/^#[0-9a-fA-F]{6}$/.test(value)) return value;
    if (/^#[0-9a-fA-F]{3}$/.test(value)) {
      return '#' + [...value.slice(1)].map(char => char + char).join('');
    }
    return '#99aab5';
  }

  const server = getCurrentServerFromRegistry();
  const serverId = String(server?._id ?? server?.id ?? '');
  const endpoint = () => `${getAPI()}/api/servers/${encodeURIComponent(serverId)}/roles`;
  const safeColor = (value: unknown): string => safeHexColor(value, 'var(--text-muted)');
  let roles = $state<RoleRow[]>([]);
  let loading = $state(true);
  let canManage = $state(false);
  let error = $state('');
  let notice = $state('');
  let savingRoleId = $state('');
  let busyKey = $state('');
  let editorMode = $state<EditorMode>('closed');
  let editingId = $state('');
  let formName = $state('');
  let formColor = $state('#99aab5');
  let formPermissions = $state(0);
  let pendingDeleteId = $state('');
  let formError = $state('');

  const busy = $derived(Boolean(savingRoleId || busyKey));

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      if (!serverId) { error = t('ssm_no_server', 'Sunucu seçilmedi.'); roles = []; return; }
      // Permissions are a display signal only, never a replacement for API checks.
      canManage = hasPerm(await fetchMyPermissions(serverId), PERM_MANAGE_ROLES);
      if (!isStillCurrentServer(serverId)) return;
      const res = await apiFetch(endpoint());
      if (!isStillCurrentServer(serverId)) return;
      if (!res.ok) {
        error = res.status === 403
          ? t('ui_rolleri_yonetme_yetkiniz_yok', 'Rolleri yönetme yetkiniz yok.')
          : safeApiErrorMessage(res, t('ui_roller_yuklenemedi', 'Roller yüklenemedi.'), { report: true });
        roles = [];
        return;
      }
      const data = await res.json() as RoleRow[];
      if (!isStillCurrentServer(serverId)) return;
      roles = (Array.isArray(data) ? data : [])
        .map(role => ({ ...role, displayOnProfile: role.displayOnProfile !== false }))
        .sort((a, b) => Number(b.position ?? 0) - Number(a.position ?? 0));
    } catch (err) {
      error = safeApiErrorMessage(err, t('ui_roller_yuklenemedi', 'Roller yüklenemedi.'), { report: true });
      roles = [];
    } finally {
      loading = false;
    }
  }

  function openCreate(): void {
    if (!canManage || busy) return;
    editorMode = 'create';
    editingId = '';
    formName = '';
    formColor = '#99aab5';
    // Explicit 0 is safer than the backend's legacy default SEND_MESSAGES.
    formPermissions = 0;
    formError = '';
    error = '';
    pendingDeleteId = '';
  }

  function openEdit(role: RoleRow): void {
    if (!canManage || busy) return;
    const mask = canonicalMask(role.permissions);
    if (mask === null) {
      error = t('role_unknown_mask', 'Bu rolün izinleri güvenli biçimde okunamadı. Düzenleme engellendi.');
      return;
    }
    editorMode = 'edit';
    editingId = role._id;
    formName = role.name;
    formColor = editorColor(role.color);
    formPermissions = mask;
    formError = '';
    error = '';
    pendingDeleteId = '';
  }

  function closeEditor(): void {
    if (busy) return;
    editorMode = 'closed';
    editingId = '';
    formError = '';
  }

  function setPermission(bit: number, enabled: boolean): void {
    formPermissions = enabled ? (formPermissions | bit) : (formPermissions & ~bit);
  }

  async function saveRole(): Promise<void> {
    if (!canManage || busy || editorMode === 'closed') return;
    if (!isStillCurrentServer(serverId)) {
      formError = t('ui_sunucu_degisti_roller_yeniden_yuklenmeli', 'Sunucu değişti — roller yeniden yüklenmeli.');
      return;
    }
    const name = formName.trim();
    if (!name || name.length > 32) {
      formError = t('role_name_bounds', 'Rol adı 1–32 karakter olmalıdır.');
      return;
    }
    if (canonicalMask(formPermissions) === null) {
      formError = t('role_invalid_permissions', 'Geçersiz rol izinleri.');
      return;
    }
    const isCreate = editorMode === 'create';
    const id = editingId;
    if (!isCreate && !roles.some(role => role._id === id)) return;
    busyKey = isCreate ? 'create' : `edit:${id}`;
    formError = '';
    notice = '';
    try {
      const res = await apiFetch(isCreate ? endpoint() : `${endpoint()}/${encodeURIComponent(id)}`, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, color: formColor, permissions: formPermissions }),
      });
      if (!isStillCurrentServer(serverId)) {
        formError = t('ui_sunucu_degisti_roller_yeniden_yuklenmeli', 'Sunucu değişti — roller yeniden yüklenmeli.');
        return;
      }
      if (!res.ok) {
        formError = safeApiErrorMessage(res, t('ui_rol_guncellenemedi', 'Rol güncellenemedi.'), { report: true });
        return;
      }
      // No optimistic privilege state: refresh the server's canonical roles.
      editorMode = 'closed';
      editingId = '';
      notice = isCreate ? t('role_created', 'Rol oluşturuldu.') : t('role_updated', 'Rol güncellendi.');
      await load();
    } catch (err) {
      formError = safeApiErrorMessage(err, t('ui_rol_guncellenemedi', 'Rol güncellenemedi.'), { report: true });
    } finally {
      busyKey = '';
    }
  }

  async function removeRole(role: RoleRow): Promise<void> {
    if (!canManage || busy || pendingDeleteId !== role._id) return;
    if (!isStillCurrentServer(serverId)) {
      error = t('ui_sunucu_degisti_roller_yeniden_yuklenmeli', 'Sunucu değişti — roller yeniden yüklenmeli.');
      pendingDeleteId = '';
      return;
    }
    busyKey = `delete:${role._id}`;
    error = '';
    notice = '';
    try {
      const res = await apiFetch(`${endpoint()}/${encodeURIComponent(role._id)}`, { method: 'DELETE' });
      if (!isStillCurrentServer(serverId)) {
        error = t('ui_sunucu_degisti_roller_yeniden_yuklenmeli', 'Sunucu değişti — roller yeniden yüklenmeli.');
        return;
      }
      if (!res.ok) {
        error = safeApiErrorMessage(res, t('role_delete_failed', 'Rol silinemedi.'), { report: true });
        return;
      }
      pendingDeleteId = '';
      notice = t('role_deleted', 'Rol silindi.');
      await load();
    } catch (err) {
      error = safeApiErrorMessage(err, t('role_delete_failed', 'Rol silinemedi.'), { report: true });
    } finally {
      busyKey = '';
    }
  }

  async function setProfileVisibility(role: RoleRow, next: boolean, input: HTMLInputElement): Promise<void> {
    if (!canManage || busy) {
      input.checked = role.displayOnProfile !== false;
      return;
    }
    if (!isStillCurrentServer(serverId)) {
      error = t('ui_sunucu_degisti_roller_yeniden_yuklenmeli', 'Sunucu değişti — roller yeniden yüklenmeli.');
      input.checked = role.displayOnProfile !== false;
      return;
    }
    savingRoleId = role._id;
    error = '';
    try {
      const res = await apiFetch(`${endpoint()}/${encodeURIComponent(role._id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayOnProfile: next }),
      });
      if (!isStillCurrentServer(serverId)) {
        input.checked = role.displayOnProfile !== false;
        return;
      }
      if (!res.ok) {
        error = safeApiErrorMessage(res, t('ui_rol_guncellenemedi', 'Rol güncellenemedi.'), { report: true });
        input.checked = role.displayOnProfile !== false;
        return;
      }
      const updated = await res.json() as RoleRow;
      roles = roles.map(item => item._id === role._id
        ? { ...item, displayOnProfile: updated.displayOnProfile !== false }
        : item);
    } catch (err) {
      error = safeApiErrorMessage(err, t('ui_rol_guncellenemedi', 'Rol güncellenemedi.'), { report: true });
      input.checked = role.displayOnProfile !== false;
    } finally {
      savingRoleId = '';
    }
  }

  onMount(() => { void load(); });
</script>

<section aria-labelledby="roles-heading" class="role-settings">
  <header class="roles-heading">
    <div>
      <h2 id="roles-heading" class="roles-title">{t('srv_tab_roles', 'Roller')}</h2>
      <p class="roles-help">{t('role_editor_help', 'Roller sunucu genelinde yetkileri belirler. Üye atamaları Üyeler sekmesinde yönetilir.')}</p>
    </div>
    {#if canManage && !loading && !(error && roles.length === 0)}
      <button type="button" class="role-action role-primary role-create" onclick={openCreate} disabled={busy} aria-label={t('role_create', 'Rol oluştur')}>
        {t('role_create', 'Rol oluştur')}
      </button>
    {/if}
  </header>

  {#if loading}
    <p class="roles-state" aria-live="polite">{t('rt_loading', 'Roller yükleniyor…')}</p>
  {:else if error && roles.length === 0}
    <p class="roles-state roles-error" role="alert">{error}</p>
    <button type="button" class="roles-retry" onclick={() => void load()}>{t('retry')}</button>
  {:else}
    {#if error}<p class="roles-state roles-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="roles-state roles-notice" role="status">{notice}</p>{/if}
    {#if !canManage}
      <p class="roles-help">{t('ui_manage_roles_required', 'Rol değiştirmek için Rolleri yönet izni gerekiyor.')}</p>
    {/if}
    {#if roles.length === 0}
      <p class="roles-state">{t('markup_bu_sunucuda_rol_yok_18e2681', 'Bu sunucuda rol yok.')}</p>
    {:else}
      <div class="roles-list" aria-label={t('attr_sunucu_rolleri_fb7c7bc', 'Sunucu rolleri')}>
        {#each roles as role (role._id)}
          <div class="role-row">
            <span class="role-identity">
              <span class="role-dot" style={`background:${safeColor(role.color)}`} aria-hidden="true"></span>
              <span class="role-name" title={role.name}>{role.name}</span>
            </span>
            {#if canManage}
              <span class="role-control">
                <label class="role-visibility">
                  <span>{role.displayOnProfile !== false ? t('surface_profilde_gosteriliyor_0232ec', 'Profilde gösteriliyor') : t('role_hidden_profile', 'Profilde gizli')}</span>
                  <input type="checkbox" checked={role.displayOnProfile !== false} disabled={busy}
                    aria-label={t('role_show_profile_aria', undefined, { role: role.name })}
                    onchange={(event) => { void setProfileVisibility(role, event.currentTarget.checked, event.currentTarget); }} />
                </label>
                <button type="button" class="role-action role-edit" disabled={busy}
                  aria-label={t('role_edit_named', '{role} düzenle', { role: role.name })}
                  onclick={() => openEdit(role)}>{t('edit', 'Düzenle')}</button>
                <button type="button" class="role-action role-delete" disabled={busy}
                  aria-label={t('role_delete_named', '{role} sil', { role: role.name })}
                  onclick={() => { pendingDeleteId = pendingDeleteId === role._id ? '' : role._id; editorMode = 'closed'; }}>
                  {t('delete', 'Sil')}
                </button>
              </span>
            {:else}
              <span class="roles-readonly">{t('role_view_only', 'Salt okunur')}</span>
            {/if}
          </div>
          {#if canManage && pendingDeleteId === role._id}
            <div class="role-confirm" role="group" aria-label={t('role_delete_confirm_named', '{role} rolünü silmeyi onayla', { role: role.name })}>
              <span>{t('role_delete_warning', 'Rol silme işlemi geri alınamaz ve üyeleri etkileyebilir.')}</span>
              <button type="button" class="role-action role-danger" disabled={busy} onclick={() => void removeRole(role)}>
                {t('role_confirm_delete', 'Silmeyi onayla')}
              </button>
              <button type="button" class="role-action" disabled={busy} onclick={() => { pendingDeleteId = ''; }}>
                {t('cancel', 'İptal')}
              </button>
            </div>
          {/if}
        {/each}
      </div>
    {/if}
  {/if}

  {#if canManage && !loading && !(error && roles.length === 0) && editorMode !== 'closed'}
    <form class="role-editor" aria-label={t('role_editor', 'Rol düzenleyici')} onsubmit={(event) => { event.preventDefault(); void saveRole(); }}>
      <h3>{editorMode === 'create' ? t('role_create', 'Rol oluştur') : t('role_edit', 'Rolü düzenle')}</h3>
      {#if formError}<p class="roles-state roles-error" role="alert">{formError}</p>{/if}
      <div class="role-fields">
        <label>{t('role_name', 'Rol adı')}
          <input class="role-name-input" type="text" maxlength="32" required bind:value={formName} disabled={busy} />
        </label>
        <label>{t('role_color', 'Rol rengi')}
          <input class="role-color-input" type="color" bind:value={formColor} disabled={busy} />
        </label>
      </div>
      <p class="roles-help">{t('role_permissions_warning', 'Yalnızca sahip olduğunuz izinleri verebilirsiniz. Yönetici izni tüm yetkileri içerir.')}</p>
      <div class="role-permission-groups">
        {#each PERMISSION_GROUPS as group (group.title)}
          <fieldset class="role-permission-group">
            <legend>{group.title}</legend>
            {#each group.options as option (option.bit)}
              <label class="role-permission">
                <input type="checkbox" checked={(formPermissions & option.bit) !== 0} disabled={busy}
                  onchange={(event) => setPermission(option.bit, event.currentTarget.checked)} />
                <span>{option.label}</span>
              </label>
            {/each}
          </fieldset>
        {/each}
      </div>
      <div class="role-editor-actions">
        <button type="submit" class="role-action role-primary" disabled={busy}>{t('save', 'Kaydet')}</button>
        <button type="button" class="role-action" disabled={busy} onclick={closeEditor}>{t('cancel', 'İptal')}</button>
      </div>
    </form>
  {/if}
</section>

<style>
  .role-settings { display: grid; gap: 12px; }
  .roles-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
  .roles-title { margin: 0; font-size: var(--type-title-sm); color: var(--text-primary); }
  .roles-help { margin: 6px 0 12px; font-size: var(--type-body-sm); line-height: 1.45; color: var(--text-2); }
  .roles-state { margin: 0 0 10px; color: var(--text-muted); }
  .roles-error { color: var(--danger); }
  .roles-notice { color: var(--green); }
  .roles-retry, .role-action {
    padding: 8px 10px; border: 1px solid var(--border-subtle); border-radius: var(--radius-control);
    background: var(--surface-2); color: var(--text-primary); font: inherit; cursor: pointer;
  }
  .role-action:disabled { cursor: default; opacity: .55; }
  .role-primary { border-color: var(--brand); }
  .role-danger, .role-delete { color: var(--danger); }
  .roles-list { display: grid; gap: 6px; max-height: 52vh; overflow-y: auto; padding-right: 4px; }
  .role-row {
    display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 12px;
    min-height: 44px; padding: 8px 10px; border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control); background: var(--surface-1);
  }
  .role-identity { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .role-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
  .role-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-primary); }
  .role-control { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; color: var(--text-2); font-size: var(--type-caption); }
  .role-visibility { display: flex; align-items: center; gap: 7px; }
  .role-control input, .role-permission input { width: 18px; height: 18px; accent-color: var(--brand); }
  .roles-readonly { color: var(--text-muted); font-size: var(--type-caption); }
  .role-editor { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control); background: var(--surface-1); }
  .role-editor h3 { margin: 0; font-size: var(--type-title-sm); }
  .role-fields { display: flex; flex-wrap: wrap; gap: 12px; }
  .role-fields label { display: grid; gap: 6px; }
  .role-name-input { min-width: 190px; padding: 8px; font: inherit; color: var(--text-primary);
    background: var(--surface-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-control); }
  .role-color-input { width: 64px; min-height: 38px; }
  .role-permission-groups { display: grid; grid-template-columns: repeat(auto-fit,minmax(195px,1fr)); gap: 9px; }
  .role-permission-group { min-width: 0; margin: 0; padding: 10px; border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control); }
  .role-permission-group legend { font-weight: 600; }
  .role-permission { display: flex; align-items: center; gap: 8px; padding: 4px 0; font-size: var(--type-body-sm); }
  .role-editor-actions, .role-confirm { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .role-confirm { padding: 10px; border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control); font-size: var(--type-body-sm); }
  .role-editor :is(input,button):focus-visible, .role-settings button:focus-visible {
    outline: 2px solid var(--focus-ring); outline-offset: 2px;
  }
  @media (max-width: 620px) {
    .roles-heading { flex-wrap: wrap; }
    .role-row { align-items: flex-start; flex-direction: column; }
    .role-control { width: 100%; }
  }
</style>
