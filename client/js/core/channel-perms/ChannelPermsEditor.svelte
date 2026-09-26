<!-- client/js/core/channel-perms/ChannelPermsEditor.svelte -->
<!--
  FAZ C2 — KANAL İZİNLERİ: GÜVENLİ, VERİ TABANLI EDİTÖR.

  NEDEN YENİ BİR BİLEŞEN:
  Tarihsel `ChannelPermsModal.svelte` bir eski dize-şablon kabuğudur: ~30
  callback prop'u alır ve önceden üretilmiş HTML dizelerini basar —
      {@html matrixHtml} · {@html auditBody} · {@html syncChannelListHtml}
  Rol adları, kanal adları ve audit kayıtları KULLANICI DENETİMİNDEDİR; bir
  kontrolcünün bu yuvalara HTML üretmesi doğrudan bir XSS yüzeyi olurdu.
  Bu yüzden o sözleşme BESLENMEZ: editör veriyi olağan Svelte metin
  enterpolasyonuyla render eder ve `{@html}` HİÇ kullanmaz.

  KAPSAM (C2): rol tabanlı izin düzenleme. Tarihsel audit/sync/bulk bölümleri
  yayınlanmaz — her biri ayrı ayrı güvenli veri render'ına dönüştürülene ve
  gerçek bir kontrolcü sözleşmesine bağlanana kadar dormant kalır.

  ERİŞİLEBİLİRLİK: üç durum RENGE BAĞLI DEĞİLDİR — her durum metin etiketi
  taşır, `radiogroup`/`radio` semantiği ve `aria-checked` ile programatik
  olarak açıktır, klavyeyle işletilebilir ve görünür odak halkası vardır.
-->
<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  import { focusTrap } from '../a11y/focusTrap.ts';
  import {
    CHANNEL_PERMISSIONS, type PermissionExplanationResponse, type RolePreviewResponse, type PermState,
  } from './channelPermsStore.ts';

  interface Role { _id: string; name: string }

  interface Props {
    channelName:    string;
    roles:          Role[];
    selectedRoleId: string;
    loading:        boolean;
    saving:         boolean;
    dirty:          boolean;
    error:          string | null;
    explanationLoading: boolean;
    explanationError: string | null;
    explanation: PermissionExplanationResponse | null;
    rolePreviewLoading: boolean;
    rolePreviewError: string | null;
    rolePreview: RolePreviewResponse | null;
    stateOf:        (roleId: string, bit: number) => PermState;
    onSelectRole:   (roleId: string) => void;
    onSetState:     (roleId: string, bit: number, state: PermState) => void;
    onSave:         () => void;
    onReset:        () => void;
    onExplain:      () => void;
    onPreviewRole:  (roleId: string) => void;
    onClose:        () => void;
  }

  let {
    channelName, roles, selectedRoleId, loading, saving, dirty, error,
    explanationLoading, explanationError, explanation,
    rolePreviewLoading, rolePreviewError, rolePreview,
    stateOf, onSelectRole, onSetState, onSave, onReset, onExplain, onPreviewRole, onClose,
  }: Props = $props();

  let previewRoleId = $state('__everyone__');

  const STATES: { id: PermState; label: string; sign: string }[] = $derived.by(() => [
    { id: 'deny',    label: t('perm_deny_label', 'Engelle'), sign: '✕' },
    { id: 'inherit', label: t('perm_inherit_label', 'Devral'),  sign: '/' },
    { id: 'allow',   label: t("ui_izin_ver", "İzin ver"), sign: '✓' },
  ]);

  const busy = $derived(loading || saving);

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }

  /**
   * Kirliyken rol değiştirmek sessizce kayıp yaratır. C2 stratejisi: kirliyken
   * rol değişimini ENGELLE ve kullanıcıdan Kaydet/Geri al iste. Bunun için
   * ayrı bir onay çerçevesi kurulmaz.
   */
  function selectRole(id: string): void {
    if (dirty || busy) return;
    onSelectRole(id);
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="cp-overlay" role="presentation"
     onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="cp-card" role="dialog" aria-modal="true" aria-label={t('attr_kanal_izinleri_e781f5f', "Kanal izinleri")} use:focusTrap>
    <header class="cp-header">
      <!-- Kanal adı KULLANICI VERİSİDİR — metin olarak basılır, HTML olarak değil. -->
      <h2 class="cp-title">{t("ui_channel_permissions_title", undefined, { channel: channelName })}</h2>
      <button type="button" class="cp-close" aria-label={t('close')} onclick={onClose}>✕</button>
    </header>

    {#if error}
      <p class="cp-error" role="alert">{error}</p>
    {/if}

    {#if loading}
      <p class="cp-status">{t('cpe_loading', 'İzinler yükleniyor…')}</p>
    {:else}
      {#if !roles.length}
        <p class="cp-status">{t('cpe_no_roles', 'Bu sunucuda düzenlenebilir rol yok.')}</p>
      {:else}
        <div class="cp-body">
        <nav class="cp-roles" aria-label={t('roles')}>
          {#each roles as role (role._id)}
            <button
              type="button"
              class="cp-role"
              class:selected={role._id === selectedRoleId}
              aria-current={role._id === selectedRoleId ? 'true' : undefined}
              disabled={busy || (dirty && role._id !== selectedRoleId)}
              onclick={() => selectRole(role._id)}
            >{role.name}</button>
          {/each}
          {#if dirty}
            <p class="cp-hint">{t('cpe_save_first', 'Rol değiştirmek için önce kaydet veya geri al.')}</p>
          {/if}
        </nav>

        <div class="cp-matrix">
          {#each CHANNEL_PERMISSIONS as perm (perm.bit)}
            {@const current = stateOf(selectedRoleId, perm.bit)}
            <div class="cp-row">
              <span class="cp-perm" id={`cp-label-${perm.key}`}>{t(perm.labelKey)}</span>
              <div class="cp-states" role="radiogroup" aria-labelledby={`cp-label-${perm.key}`}>
                {#each STATES as st (st.id)}
                  <button
                    type="button"
                    class="cp-state"
                    class:active={current === st.id}
                    data-state={st.id}
                    role="radio"
                    aria-checked={current === st.id}
                    disabled={busy}
                    onclick={() => onSetState(selectedRoleId, perm.bit, st.id)}
                  >
                    <span aria-hidden="true">{st.sign}</span>
                    <span class="cp-state-label">{st.label}</span>
                  </button>
                {/each}
              </div>
            </div>
          {/each}
        </div>
        </div>
      {/if}

      <section class="cp-explain" aria-labelledby="cp-explain-title">
        <div class="cp-explain-head">
          <div>
            <h3 id="cp-explain-title">{t('cpe_why_perms', 'Etkin izinlerim neden böyle?')}</h3>
            <p>{t('cpe_why_hint', 'Kanal kararının sunucu rolleri ve kanal kurallarıyla nasıl oluştuğunu gösterir.')}</p>
          </div>
          <button type="button" class="btn" disabled={explanationLoading} onclick={onExplain}>
            {explanationLoading ? t("surface_ac_klan_yor_f1856e") : explanation ? t("markup_yenile_255b90e") : t("surface_ac_kla_a0e294")}
          </button>
        </div>

        {#if explanationError}
          <p class="cp-explain-error" role="alert">{explanationError}</p>
        {:else if explanation}
          <div class="cp-explain-list">
            {#each explanation.permissions as permission (permission.key)}
              <article class="cp-explain-row" data-effective={permission.effective}>
                <div class="cp-explain-result">
                  <strong>{permission.label}</strong>
                  <span>{permission.allowed ? t("surface_izin_verildi_49d86c") : t('permission_denied_label')}</span>
                </div>
                <p>{permission.message}</p>
                <small>{t('permission_base_sources', undefined, { sources: permission.base.sources.join(' · ') })}</small>
                {#if permission.overrides.length}
                  <ul aria-label={t('permission_rules_aria', undefined, { permission: permission.label })}>
                    {#each permission.overrides as override}
                      <li>{override.label}: {override.state === 'allowed' ? t("surface_izin_veriyor_d47aad") : t('permission_denies_verb')}</li>
                    {/each}
                  </ul>
                {/if}
              </article>
            {/each}
          </div>
        {/if}
      </section>

      <section class="cp-preview" aria-labelledby="cp-preview-title">
        <div class="cp-preview-head">
          <div>
            <h3 id="cp-preview-title">{t('cpe_view_as_role', 'Rol olarak görüntüle')}</h3>
            <p>{t('cpe_view_as_hint', 'Bu rolün sunucudaki kanal erişimini salt okunur olarak simüle eder.')}</p>
          </div>
          <div class="cp-preview-controls">
            <label for="cp-preview-role">{t('markup_rol_a73f134', "Rol")}</label>
            <select id="cp-preview-role" bind:value={previewRoleId} disabled={rolePreviewLoading}>
              <option value="__everyone__">@everyone</option>
              {#each roles as role (role._id)}
                <option value={role._id}>{role.name}</option>
              {/each}
            </select>
            <button type="button" class="btn" disabled={rolePreviewLoading}
                    onclick={() => onPreviewRole(previewRoleId)}>
              {rolePreviewLoading ? t("surface_onizleniyor_598803") : t("surface_rolu_onizle_35b098")}
            </button>
          </div>
        </div>
        <p class="cp-preview-safety">{t('markup_yalniz_simulasyon_kullanici_oturumu_veya_kimlik__d0442a8', "Yalnız simülasyon — kullanıcı oturumu veya kimlik doğrulama anahtarı oluşturulmaz.")}</p>
        {#if dirty}
          <p class="cp-preview-note">{t('cpe_unsaved_note', 'Kaydedilmemiş değişiklikler önizlemeye dahil değildir.')}</p>
        {/if}

        {#if rolePreviewError}
          <p class="cp-preview-error" role="alert">{rolePreviewError}</p>
        {:else if rolePreview}
          <div class="cp-preview-summary" aria-label={t("ui_role_access_summary_aria", undefined, { role: rolePreview.role.name })}>
            <strong>{rolePreview.role.name}</strong>
            <span>{t("ui_visible_channels_summary", undefined, { visible: rolePreview.summary.visibleChannels, total: rolePreview.summary.totalChannels })}</span>
            <span>{t("ui_sendable_channels_summary", undefined, { count: rolePreview.summary.sendableChannels })}</span>
            <span>{t('role_attachable_summary', undefined, { count: rolePreview.summary.attachableChannels })}</span>
            <span>{t("ui_manageable_channels_summary", undefined, { count: rolePreview.summary.manageableChannels })}</span>
          </div>
          <div class="cp-preview-list">
            {#each rolePreview.channels as channel (channel.channelId)}
              <article class="cp-preview-channel" data-visible={channel.visible ? 'true' : 'false'}>
                <div class="cp-preview-channel-head">
                  <strong>{channel.type === 'voice' ? '🔊' : '#'} {channel.name}</strong>
                  <span>{channel.visible ? t("surface_gorunur_ae1536") : t('common_hidden')}</span>
                </div>
                <ul aria-label={t("ui_channel_capabilities_aria", undefined, { channel: channel.name })}>
                  <li>{t("ui_message_capability", undefined, { state: channel.capabilities.sendMessages ? t("ui_yes") : t("ui_no") })}</li>
                  <li>{t("ui_file_capability", undefined, { state: channel.capabilities.attachFiles ? t("ui_yes") : t("ui_no") })}</li>
                  <li>{t("ui_management_capability", undefined, { state: channel.capabilities.manageMessages ? t("ui_yes") : t("ui_no") })}</li>
                  <li>{t("ui_voice_connect_capability", undefined, { state: channel.capabilities.connect ? t("ui_yes") : t("ui_no") })}</li>
                  <li>{t("ui_speak_capability", undefined, { state: channel.capabilities.speak ? t("ui_yes") : t("ui_no") })}</li>
                </ul>
              </article>
            {/each}
          </div>
        {/if}
      </section>

      {#if roles.length}
        <footer class="cp-footer">
          <button type="button" class="btn" disabled={!dirty || busy} onclick={onReset}>{t('markup_geri_al_78f0bc8', "Geri al")}</button>
          <button type="button" class="btn btn-primary" disabled={!dirty || busy} onclick={onSave}>
            {saving ? t('ui_saving') : t('save')}
          </button>
        </footer>
      {/if}
    {/if}
  </div>
</div>

<style>
  .cp-overlay {
    position: fixed; inset: 0; z-index: var(--layer-modal);
    display: flex; align-items: center; justify-content: center;
    padding: var(--space-4);
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    backdrop-filter: blur(6px);
  }
  .cp-card {
    width: min(720px, 100%); max-height: min(760px, calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-4) * 2)));
    display: flex; flex-direction: column; overflow-x: hidden; overflow-y: auto;
    background: var(--surface-content);
    border: 1px solid var(--border);
    border-radius: var(--radius-modal);
    box-shadow: var(--shadow-lg);
  }
  .cp-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-4); border-bottom: 1px solid var(--border);
  }
  .cp-title { margin: 0; font-size: var(--text-lg); color: var(--text-primary); }
  .cp-close {
    width: 32px; height: 32px; cursor: pointer;
    color: var(--text-2); background: transparent;
    border: 1px solid var(--border); border-radius: var(--radius-pill);
  }
  .cp-close:hover { color: var(--text-primary); background: var(--surface-hover); }
  .cp-error  { margin: var(--space-3) var(--space-4) 0; color: var(--danger); font-size: var(--text-sm); }
  .cp-status { padding: var(--space-6) var(--space-4); color: var(--text-muted); text-align: center; }
  .cp-body   { display: flex; gap: var(--space-4); padding: var(--space-4); overflow: hidden; }
  .cp-roles  { display: flex; flex-direction: column; gap: 4px; min-width: 160px; overflow-y: auto; }
  .cp-role {
    padding: 8px 10px; text-align: left; cursor: pointer;
    color: var(--text-2); background: transparent;
    border: 1px solid transparent; border-radius: var(--radius-control);
  }
  .cp-role:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-primary); }
  .cp-role.selected { background: var(--brand-subtle); color: var(--text-primary); border-color: var(--brand); }
  .cp-role:disabled { opacity: .5; cursor: not-allowed; }
  .cp-hint { margin: 8px 0 0; font-size: var(--text-xs); color: var(--text-muted); }
  .cp-matrix { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
  .cp-row {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-3);
    padding: 6px 8px; border-radius: var(--radius-control);
  }
  .cp-row:hover { background: var(--surface-hover); }
  .cp-perm   { font-size: var(--text-sm); color: var(--text-primary); }
  .cp-states { display: flex; gap: 4px; flex-shrink: 0; }
  .cp-state {
    display: flex; align-items: center; gap: 4px;
    padding: 4px 8px; cursor: pointer; font-size: var(--text-xs);
    color: var(--text-2); background: var(--bg-3);
    border: 1px solid var(--border); border-radius: var(--radius-control);
  }
  .cp-state:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-primary); }
  .cp-state:disabled { opacity: .5; cursor: not-allowed; }
  /* Durum RENKLE DEĞİL, metin + kenarlık + kalınlıkla da ayırt edilir. */
  .cp-state.active { color: var(--text-primary); border-color: var(--brand); background: var(--brand-subtle); font-weight: 700; }
  .cp-state[data-state='deny'].active  { border-color: var(--danger); }
  .cp-state[data-state='allow'].active { border-color: var(--success); }
  .cp-state-label { white-space: nowrap; }
  .cp-explain { margin: 0 var(--space-4) var(--space-4); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--bg-3); }
  .cp-explain-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .cp-explain h3 { margin: 0; color: var(--text-primary); font-size: var(--text-sm); }
  .cp-explain-head p { margin: 3px 0 0; color: var(--text-muted); font-size: var(--text-xs); }
  .cp-explain-error { margin: var(--space-3) 0 0; color: var(--danger); font-size: var(--text-xs); }
  .cp-explain-list { max-height: 220px; margin-top: var(--space-3); display: grid; gap: 6px; overflow-y: auto; }
  .cp-explain-row { padding: 8px 10px; border-left: 3px solid var(--danger); border-radius: 4px; background: var(--surface-content); }
  .cp-explain-row[data-effective='allowed'] { border-left-color: var(--success); }
  .cp-explain-result { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
  .cp-explain-result strong { color: var(--text-primary); font-size: var(--text-xs); }
  .cp-explain-result span { color: var(--text-2); font-size: var(--text-xs); font-weight: 700; }
  .cp-explain-row p { margin: 4px 0; color: var(--text-2); font-size: var(--text-xs); }
  .cp-explain-row small { color: var(--text-muted); }
  .cp-explain-row ul { margin: 5px 0 0; padding-left: 18px; color: var(--text-muted); font-size: var(--text-xs); }
  .cp-preview { margin: 0 var(--space-4) var(--space-4); padding: var(--space-3); border: 1px solid var(--border); border-radius: var(--radius-control); background: var(--bg-3); }
  .cp-preview-head { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--space-3); }
  .cp-preview h3 { margin: 0; color: var(--text-primary); font-size: var(--text-sm); }
  .cp-preview-head p { margin: 3px 0 0; color: var(--text-muted); font-size: var(--text-xs); }
  .cp-preview-controls { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; justify-content: flex-end; }
  .cp-preview-controls label { color: var(--text-muted); font-size: var(--text-xs); }
  .cp-preview-controls select { max-width: 180px; padding: 6px 8px; color: var(--text-primary); background: var(--surface-content); border: 1px solid var(--border); border-radius: var(--radius-control); }
  .cp-preview-safety, .cp-preview-note, .cp-preview-error { margin: var(--space-2) 0 0; font-size: var(--text-xs); }
  .cp-preview-safety { color: var(--text-2); }
  .cp-preview-note { color: var(--warning); }
  .cp-preview-error { color: var(--danger); }
  .cp-preview-summary { margin-top: var(--space-3); display: flex; gap: 6px; flex-wrap: wrap; color: var(--text-2); font-size: var(--text-xs); }
  .cp-preview-summary strong, .cp-preview-summary span { padding: 4px 7px; background: var(--surface-content); border: 1px solid var(--border); border-radius: var(--radius-pill); }
  .cp-preview-list { max-height: 220px; margin-top: var(--space-3); display: grid; gap: 6px; overflow-y: auto; }
  .cp-preview-channel { min-width: 0; padding: 8px 10px; border-left: 3px solid var(--success); border-radius: 4px; background: var(--surface-content); }
  .cp-preview-channel[data-visible='false'] { border-left-color: var(--danger); opacity: .8; }
  .cp-preview-channel-head { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--text-primary); font-size: var(--text-xs); }
  .cp-preview-channel-head strong { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .cp-preview-channel ul { margin: 6px 0 0; padding: 0; display: flex; gap: 4px 10px; flex-wrap: wrap; list-style: none; color: var(--text-muted); font-size: var(--text-xs); }
  .cp-footer {
    display: flex; justify-content: flex-end; gap: var(--space-2);
    padding: var(--space-4); border-top: 1px solid var(--border);
  }
  .cp-close:focus-visible, .cp-role:focus-visible,
  .cp-state:focus-visible, .cp-preview-controls select:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  @media (max-width: 700px) {
    .cp-overlay { padding: 0; align-items: stretch; }
    .cp-card { width: 100%; max-height: none; height: var(--bridge-visual-viewport-height, 100dvh); border: 0; border-radius: 0; }
    .cp-header { padding-top: max(var(--space-4), env(safe-area-inset-top)); }
    .cp-close { width: 40px; height: 40px; }
    .cp-body { flex-direction: column; overflow-y: auto; }
    .cp-roles { min-width: 0; flex-direction: row; overflow-x: auto; overflow-y: hidden; padding-bottom: 4px; scrollbar-width: none; }
    .cp-roles::-webkit-scrollbar { display: none; }
    .cp-role { flex: none; min-height: 40px; white-space: nowrap; }
    .cp-matrix { overflow: visible; }
    .cp-row { align-items: flex-start; flex-direction: column; }
    .cp-states { width: 100%; }
    .cp-state { flex: 1; justify-content: center; min-height: 40px; }
    .cp-explain, .cp-preview { margin-inline: var(--space-4); }
    .cp-preview-head, .cp-explain-head { align-items: stretch; flex-direction: column; }
    .cp-preview-controls { justify-content: flex-start; }
    .cp-footer { position: sticky; bottom: 0; padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom)); background: var(--surface-content); }
    .cp-footer button { min-height: 44px; }
  }
</style>
