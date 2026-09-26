<script lang="ts">
  import { t, localeTag} from '../../i18n/reactive.svelte.ts';
  import { onMount } from 'svelte';
  import { getCurrentServerFromRegistry } from '../stores/serverSettingsStore';
  import { getAPI } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';
  import { ApiResponseError, safeApiErrorMessage } from '../../api-error.ts';
  import { toast } from '../../utils.js';
  import { CHANNEL_PERMISSIONS } from '../../channel-perms/channelPermsStore.ts';

  interface PermissionState { allow: number; deny: number }
  interface UndoStatus { supported: boolean; canUndo: boolean; reason?: string }
  interface AuditEntry {
    _id?: string;
    createdAt: string | number;
    action?: string;
    actorName?: string;
    targetName?: string;
    channelName?: string;
    channelId?: string;
    detail?: string;
    old?: PermissionState | null;
    new?: PermissionState | null;
    undo?: UndoStatus;
  }
  interface PermissionChange {
    key: string;
    label: string;
    before: 'allow' | 'deny' | 'inherit';
    after: 'allow' | 'deny' | 'inherit';
  }

  const API = getAPI();
  const server = getCurrentServerFromRegistry() as { _id: string; name?: string } | null;

  let after = $state('');
  let before = $state('');
  let action = $state('');
  let entries = $state<AuditEntry[]>([]);
  let total = $state(0);
  let loading = $state(false);
  let loadError = $state('');
  let expandedIds = $state<Set<string>>(new Set());
  let confirmUndoId = $state('');
  let undoingId = $state('');
  let exporting = $state<'' | 'csv' | 'json'>('');

  function buildParams(extra: Record<string, string> = {}): string {
    const params: Record<string, string> = { ...extra };
    if (after) params.after = after;
    if (before) params.before = before;
    if (action) params.action = action;
    return new URLSearchParams(params).toString();
  }


  async function loadAudit(): Promise<void> {
    if (!server || loading) return;
    loading = true;
    loadError = '';
    confirmUndoId = '';
    try {
      const qs = buildParams({ limit: '20', ui: '1' });
      const response = await apiFetch(`${API}/api/servers/${encodeURIComponent(server._id)}/audit-log?${qs}`);
      if (!response.ok) throw new ApiResponseError(response);
      const data = await response.json() as { entries?: AuditEntry[]; logs?: AuditEntry[]; total?: number } | AuditEntry[];
      entries = Array.isArray(data) ? data : (data.entries ?? data.logs ?? []);
      total = Array.isArray(data) ? data.length : Number(data.total ?? entries.length);
    } catch (error) {
      entries = [];
      total = 0;
      loadError = safeApiErrorMessage(error, t("ui_denetim_gunlugu_yuklenemedi", "Denetim günlüğü yüklenemedi."), { report: true });
    } finally {
      loading = false;
    }
  }

  function actionLabel(value = ''): string {
    const labels: Record<string, string> = {
      PERM_UPDATE: t('audit_perm_update', 'Kanal izinleri değiştirildi'),
      PERM_DELETE: t('audit_perm_delete', 'Kanal izin override’ı kaldırıldı'),
      PERM_UNDO: t('audit_perm_undo', 'İzin değişikliği geri alındı'),
      timeout: t('audit_timeout', 'Üyeye zaman aşımı uygulandı'),
      timeout_remove: t('audit_timeout_remove', 'Zaman aşımı kaldırıldı'),
      kick: t('audit_kick', 'Üye sunucudan çıkarıldı'),
      ban: t('audit_ban', 'Üye yasaklandı'),
      unban: t('audit_unban', 'Yasak kaldırıldı'),
    };
    return labels[value] ?? (value.replace(/_/g, ' ').toLocaleLowerCase(localeTag()) || t('audit_admin_action', 'Yönetici işlemi'));
  }

  function entryKey(entry: AuditEntry, index: number): string {
    return entry._id || `${entry.createdAt}-${entry.action ?? ''}-${index}`;
  }

  function auditDate(value: string | number): Date | null {
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
  }

  function auditDateLabel(value: string | number): string {
    return auditDate(value)?.toLocaleString(localeTag()) ?? t('ui_date_unknown', 'Tarih bilinmiyor');
  }

  function stateFor(mask: PermissionState | null | undefined, bit: number): 'allow' | 'deny' | 'inherit' {
    if (mask && (Number(mask.allow) & bit) !== 0) return 'allow';
    if (mask && (Number(mask.deny) & bit) !== 0) return 'deny';
    return 'inherit';
  }

  function permissionChanges(entry: AuditEntry): PermissionChange[] {
    if (!entry.action?.startsWith('PERM_')) return [];
    return CHANNEL_PERMISSIONS.flatMap(permission => {
      const before = stateFor(entry.old, permission.bit);
      const afterState = stateFor(entry.new, permission.bit);
      return before === afterState ? [] : [{
        key: permission.key, label: t(permission.labelKey), before, after: afterState,
      }];
    });
  }

  function stateLabel(value: PermissionChange['before']): string {
    return value === 'allow' ? t("ui_izin_ver", "İzin ver") : value === 'deny' ? 'Reddet' : 'Devral';
  }

  function toggleDetails(key: string): void {
    const next = new Set(expandedIds);
    next.has(key) ? next.delete(key) : next.add(key);
    expandedIds = next;
    if (confirmUndoId && confirmUndoId !== key) confirmUndoId = '';
  }

  async function undo(entry: AuditEntry, key: string): Promise<void> {
    if (!server || !entry._id || undoingId) return;
    undoingId = key;
    loadError = '';
    try {
      const response = await apiFetch(
        `${API}/api/servers/${encodeURIComponent(server._id)}/audit-log/${encodeURIComponent(entry._id)}/undo`,
        { method: 'POST' },
      );
      if (!response.ok) throw new ApiResponseError(response);
      toast(t('aud_revert_ok', 'İzin değişikliği güvenle geri alındı.'), 'success');
      await loadAudit();
    } catch (error) {
      const message = safeApiErrorMessage(error, t("ui_degisiklik_guvenle_geri_alinamadi", "Değişiklik güvenle geri alınamadı."), { report: true });
      entry.undo = { supported: true, canUndo: false, reason: message };
      entries = [...entries];
      confirmUndoId = '';
    } finally {
      undoingId = '';
    }
  }

  async function exportAudit(format: 'csv' | 'json'): Promise<void> {
    if (!server || exporting) return;
    exporting = format;
    loadError = '';
    try {
      const qs = buildParams({ format, limit: '500' });
      const response = await apiFetch(`${API}/api/servers/${encodeURIComponent(server._id)}/audit-log?${qs}`);
      if (!response.ok) throw new ApiResponseError(response);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `audit-${server._id}-${Date.now()}.${format}`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      toast(t('audit_log_downloaded', undefined, { format: format.toUpperCase() }), 'success');
    } catch (error) {
      loadError = safeApiErrorMessage(error, t("ui_disa_aktarma_basarisiz", "Dışa aktarma başarısız."), { report: true });
    } finally {
      exporting = '';
    }
  }

  onMount(() => { void loadAudit(); });
</script>

<div class="audit-tab">
  <header class="audit-heading">
    <div>
      <span class="audit-eyebrow">{t('audit_admin_visibility', 'Yönetim görünürlüğü')}</span>
      <h3>{t('audit_title', 'Denetim günlüğü')}</h3>
      <p>{t('markup_kim_neyi_ne_zaman_degistirdi_geri_alma_yalniz_ca_975fb03', "Kim, neyi, ne zaman değiştirdi? Geri alma yalnız çakışmasız kanal izinlerinde sunulur.")}</p>
    </div>
    <button type="button" class="al-refresh" onclick={loadAudit} disabled={loading} aria-label={t('audit_refresh', 'Denetim günlüğünü yenile')}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18 6.5L20 9M4 15l2 2.5A7 7 0 0 0 17.9 15"/></svg>
      {loading ? t("sp_loading") : t("markup_yenile_255b90e")}
    </button>
  </header>

  <div class="audit-filters" aria-label={t('audit_filters', 'Denetim günlüğü filtreleri')}>
    <label><span>{t('cperm_start', 'Başlangıç')}</span><input id="al-after" type="date" class="input-field" bind:value={after} /></label>
    <label><span>{t('cperm_end', 'Bitiş')}</span><input id="al-before" type="date" class="input-field" bind:value={before} /></label>
    <label class="audit-action-filter">
      <span>{t('audit_action_type', 'İşlem türü')}</span>
      <select id="al-action" class="input-field" bind:value={action}>
        <option value="">{t('cperm_all_actions', 'Tüm işlemler')}</option>
        <option value="PERM_UPDATE">{t('audit_perm_change', 'İzin değişikliği')}</option>
        <option value="PERM_DELETE">{t('audit_perm_remove', 'İzin kaldırma')}</option>
        <option value="PERM_UNDO">{t('audit_perm_reverted', 'Geri alınan izin')}</option>
        <option value="kick">{t('audit_member_kick', 'Üye çıkarma')}</option>
        <option value="ban">{t('markup_yasaklama_53110c3', "Yasaklama")}</option>
        <option value="unban">{t('audit_unban', 'Yasak kaldırma')}</option>
        <option value="timeout">{t('audit_timeout', 'Zaman aşımı')}</option>
        <option value="timeout_remove">{t('audit_timeout_remove', 'Zaman aşımı kaldırma')}</option>
      </select>
    </label>
    <button type="button" class="al-apply" onclick={loadAudit} disabled={loading}>{t('markup_filtrele_4d0a4d0', "Filtrele")}</button>
  </div>

  {#if loadError}
    <div class="al-alert" role="alert">
      <span aria-hidden="true">!</span><span>{loadError}</span>
      <button type="button" onclick={loadAudit}>{t('retry')}</button>
    </div>
  {/if}

  <div class="al-list-head"><strong>{t('audit_recent', 'Son işlemler')}</strong><span>{t("ui_record_count", undefined, { count: total })}</span></div>

  <div class="al-preview" aria-live="polite" aria-busy={loading}>
    {#if loading && !entries.length}
      <div class="al-state"><span class="al-spinner" aria-hidden="true"></span>{t('audit_loading', 'Denetim kayıtları yükleniyor…')}</div>
    {:else if !entries.length && !loadError}
      <div class="al-state">{t('audit_no_match', 'Bu filtrelerle eşleşen denetim kaydı yok.')}</div>
    {:else}
      {#each entries as entry, index (entryKey(entry, index))}
        {@const key = entryKey(entry, index)}
        {@const changes = permissionChanges(entry)}
        <article class="al-entry">
          <div class="al-rail" aria-hidden="true"><span></span></div>
          <div class="al-card">
            <div class="al-card-top">
              <div class="al-summary">
                <strong>{entry.channelName ? `#${entry.channelName} · ` : ''}{actionLabel(entry.action)}</strong>
                <span>{entry.actorName || t("surface_bilinmeyen_yonetici_702374")} · <time datetime={auditDate(entry.createdAt)?.toISOString()}>{auditDateLabel(entry.createdAt)}</time></span>
              </div>
              <span class="al-target">{entry.targetName || t("cp_category_server")}</span>
            </div>

            {#if changes.length}
              <div class="al-change-preview">
                {#each changes.slice(0, 2) as change}
                  <span><b>{change.key}</b> {stateLabel(change.before)} → {stateLabel(change.after)}</span>
                {/each}
                {#if changes.length > 2}<span>{t("ui_more_changes", undefined, { count: changes.length - 2 })}</span>{/if}
              </div>
            {:else if entry.detail}
              <p class="al-detail-preview">{entry.detail}</p>
            {/if}

            <div class="al-card-actions">
              <button type="button" class="al-link" aria-expanded={expandedIds.has(key)} onclick={() => toggleDetails(key)}>{expandedIds.has(key) ? t("surface_ayr_nt_lar_gizle_1533f5") : t("surface_ayr_nt_lar_gor_538cf7")}</button>
              {#if entry.undo?.supported && entry.undo.canUndo && entry._id}
                <button type="button" class="al-undo" onclick={() => { confirmUndoId = key; expandedIds = new Set([...expandedIds, key]); }}>{t('markup_geri_al_78f0bc8', "Geri al")}</button>
              {/if}
            </div>

            {#if expandedIds.has(key)}
              <div class="al-details">
                {#if changes.length}
                  <div class="al-change-list">
                    {#each changes as change}
                      <div><span><b>{change.key}</b><small>{change.label}</small></span><span class="state-{change.before}">{stateLabel(change.before)}</span><span aria-hidden="true">→</span><span class="state-{change.after}">{stateLabel(change.after)}</span></div>
                    {/each}
                  </div>
                {/if}
                {#if entry.detail}<p><b>{t('markup_not_b529cc7', "Not:")}</b> {entry.detail}</p>{/if}
                {#if entry.undo?.supported && !entry.undo.canUndo && entry.undo.reason}
                  <p class="al-no-undo"><b>{t('audit_irreversible', 'Geri alınamaz:')}</b> {entry.undo.reason}</p>
                {/if}
                {#if confirmUndoId === key && entry.undo?.canUndo}
                  <div class="al-confirm" role="group" aria-label={t('audit_revert_confirm', 'Geri alma onayı')}>
                    <span>{t('audit_revert_hint', 'Yalnız durum değişmediyse önceki izinlere dönülecek.')}</span>
                    <button type="button" onclick={() => undo(entry, key)} disabled={undoingId === key}>{undoingId === key ? t("surface_uygulan_yor_08d3cd") : t("surface_geri_almay_onayla_e36c87")}</button>
                    <button type="button" onclick={() => { confirmUndoId = ''; }}>{t('audit_cancel', 'Vazgeç')}</button>
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </article>
      {/each}
    {/if}
  </div>

  <footer class="al-footer">
    <span>{t('audit_export_hint', 'Dışa aktarma mevcut filtreleri ve en fazla 500 kaydı içerir.')}</span>
    <div>
      <button type="button" onclick={() => exportAudit('csv')} disabled={Boolean(exporting)}>{exporting === 'csv' ? t("surface_haz_rlan_yor_aa7fb7") : 'CSV indir'}</button>
      <button type="button" onclick={() => exportAudit('json')} disabled={Boolean(exporting)}>{exporting === 'json' ? t("surface_haz_rlan_yor_aa7fb7") : 'JSON indir'}</button>
    </div>
  </footer>
</div>

<style>
  .audit-tab { display: grid; gap: 15px; min-width: 0; }
  .audit-heading { display: flex; justify-content: space-between; gap: 16px; align-items: flex-start; }
  .audit-heading h3 { margin: 2px 0 4px; font-size: var(--type-title-lg); }
  .audit-heading p { margin: 0; max-width: 600px; color: var(--text-muted); font-size: var(--type-body-sm); }
  .audit-eyebrow { color: var(--brand); font-size: var(--type-caption); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .al-refresh, .al-apply, .al-footer button, .al-alert button { min-height: 34px; padding: 0 11px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text-secondary); background: var(--bg-3); cursor: pointer; font: 700 var(--type-body-sm)/1 var(--font-sans); }
  .al-refresh { display: inline-flex; align-items: center; gap: 7px; }
  .al-refresh svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 1.8; stroke-linecap: round; stroke-linejoin: round; }
  button:hover:not(:disabled) { color: var(--text-primary); background: var(--surface-hover); }
  button:focus-visible, input:focus-visible, select:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  button:disabled { opacity: .55; cursor: not-allowed; }
  .audit-filters { display: grid; grid-template-columns: minmax(120px,.7fr) minmax(120px,.7fr) minmax(180px,1fr) auto; gap: 9px; align-items: end; padding: 12px; background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-surface); }
  .audit-filters label { min-width: 0; display: grid; gap: 5px; }
  .audit-filters label > span { color: var(--text-muted); font-size: var(--type-caption); font-weight: 700; }
  .audit-filters .input-field { width: 100%; min-width: 0; margin: 0; }
  .al-apply { color: var(--text-on-solid); background: var(--brand); border-color: transparent; }
  .al-alert { display: flex; align-items: center; gap: 9px; padding: 10px 12px; color: var(--danger-text, var(--red)); background: var(--danger-bg, var(--bg-3)); border: 1px solid var(--danger, var(--red)); border-radius: var(--radius-surface); font-size: var(--type-body-sm); }
  .al-alert > span:first-child { width: 22px; height: 22px; display: grid; place-items: center; flex: none; border: 1px solid currentColor; border-radius: 50%; font-weight: 900; }
  .al-alert > span:nth-child(2) { flex: 1; }
  .al-alert button { color: inherit; background: transparent; }
  .al-list-head { display: flex; justify-content: space-between; align-items: center; color: var(--text-muted); font-size: var(--type-caption); }
  .al-list-head strong { color: var(--text-primary); font-size: var(--type-title-sm); }
  .al-preview { min-height: 120px; max-height: min(520px, 56vh); overflow-y: auto; padding-right: 4px; scrollbar-gutter: stable; }
  .al-state { min-height: 120px; display: flex; justify-content: center; align-items: center; gap: 9px; color: var(--text-muted); border: 1px dashed var(--border-strong); border-radius: var(--radius-surface); font-size: var(--type-body-sm); }
  .al-spinner { width: 16px; height: 16px; border: 2px solid var(--border-strong); border-top-color: var(--brand); border-radius: 50%; animation: al-spin .7s linear infinite; }
  .al-entry { display: grid; grid-template-columns: 18px minmax(0,1fr); }
  .al-rail { position: relative; display: flex; justify-content: center; }
  .al-rail::after { position: absolute; inset: 15px auto -2px; width: 1px; content: ''; background: var(--border); }
  .al-entry:last-child .al-rail::after { display: none; }
  .al-rail span { z-index: 1; width: 9px; height: 9px; margin-top: 16px; background: var(--brand); border: 2px solid var(--bg-2); border-radius: 50%; box-shadow: 0 0 0 1px var(--brand-border); }
  .al-card { min-width: 0; margin: 0 0 9px 4px; padding: 12px 14px; background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-surface); }
  .al-card-top { display: flex; gap: 12px; justify-content: space-between; align-items: flex-start; }
  .al-summary { min-width: 0; display: grid; gap: 3px; }
  .al-summary strong { overflow-wrap: anywhere; font-size: var(--type-body); }
  .al-summary > span { color: var(--text-muted); font-size: var(--type-caption); }
  .al-target { flex: none; max-width: 34%; overflow: hidden; padding: 3px 7px; color: var(--text-secondary); background: var(--bg-2); border: 1px solid var(--border); border-radius: var(--radius-chip); font-size: var(--type-caption); text-overflow: ellipsis; white-space: nowrap; }
  .al-change-preview { display: flex; gap: 6px; flex-wrap: wrap; margin-top: 9px; }
  .al-change-preview span { padding: 4px 7px; color: var(--text-secondary); background: var(--bg-2); border-radius: var(--radius-chip); font-size: var(--type-caption); }
  .al-detail-preview { margin: 8px 0 0; overflow: hidden; color: var(--text-muted); font-size: var(--type-body-sm); text-overflow: ellipsis; white-space: nowrap; }
  .al-card-actions { display: flex; gap: 10px; align-items: center; margin-top: 9px; }
  .al-link, .al-undo { padding: 0; color: var(--brand); background: transparent; border: 0; cursor: pointer; font: 700 var(--type-caption)/1.4 var(--font-sans); }
  .al-undo { color: var(--warning-text, var(--yellow)); }
  .al-details { display: grid; gap: 10px; margin-top: 11px; padding-top: 11px; border-top: 1px solid var(--border); }
  .al-details p { margin: 0; color: var(--text-secondary); font-size: var(--type-body-sm); }
  .al-change-list { display: grid; gap: 5px; }
  .al-change-list > div { display: grid; grid-template-columns: minmax(130px,1fr) auto 14px auto; gap: 7px; align-items: center; font-size: var(--type-caption); }
  .al-change-list > div > span:first-child { min-width: 0; display: grid; }
  .al-change-list small { color: var(--text-muted); }
  [class^="state-"] { padding: 3px 6px; border: 1px solid var(--border); border-radius: var(--radius-chip); font-weight: 700; }
  .state-allow { color: var(--success-text, var(--green)); background: var(--green-bg); }
  .state-deny { color: var(--danger-text, var(--red)); background: var(--danger-bg, var(--bg-2)); }
  .state-inherit { color: var(--text-muted); background: var(--bg-2); }
  .al-no-undo { padding: 8px 10px; border-left: 2px solid var(--text-muted); background: var(--bg-2); }
  .al-confirm { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; padding: 9px 10px; background: var(--warning-bg, var(--bg-2)); border: 1px solid var(--warning, var(--border-strong)); border-radius: var(--radius-control); font-size: var(--type-caption); }
  .al-confirm span { flex: 1; min-width: 190px; }
  .al-confirm button { min-height: 30px; padding: 0 9px; border: 1px solid var(--border-strong); border-radius: var(--radius-control); color: var(--text-secondary); background: var(--bg-3); cursor: pointer; font: 700 var(--type-caption)/1 var(--font-sans); }
  .al-confirm button:first-of-type { color: var(--text-on-solid); background: var(--brand); border-color: transparent; }
  .al-footer { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding-top: 12px; border-top: 1px solid var(--border); color: var(--text-muted); font-size: var(--type-caption); }
  .al-footer div { display: flex; gap: 7px; }
  @keyframes al-spin { to { transform: rotate(360deg); } }
  @media (max-width: 720px) { .audit-filters { grid-template-columns: 1fr 1fr; } .audit-action-filter { grid-column: 1 / -1; } .al-apply { width: 100%; } .al-footer { align-items: flex-start; flex-direction: column; } }
  @media (max-width: 480px) { .audit-heading { flex-direction: column; } .audit-filters { grid-template-columns: 1fr; } .audit-action-filter { grid-column: auto; } .al-refresh { width: 100%; justify-content: center; } .al-card-top { flex-direction: column; gap: 7px; } .al-target { max-width: 100%; } .al-change-list > div { grid-template-columns: 1fr auto 12px auto; } }
  @media (prefers-reduced-motion: reduce) { .al-spinner { animation: none; } }
</style>
