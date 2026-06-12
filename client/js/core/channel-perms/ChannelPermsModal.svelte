<!-- client/js/core/channel-perms/ChannelPermsModal.svelte
     Sprint 63: İçerik panelleri vanilla modal-core.ts'den Svelte'e taşındı.
     - Matrix, Audit, Sync panelleri artık gerçek Svelte bileşenleri
     - dirty-badge Svelte reaktivitesiyle yönetilir
     - modal-core.ts artık sadece veri yükleme + prop güncellemesi yapar -->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';

  interface RoleOption  { id: string; name: string; isUser?: boolean }
  interface TemplateOpt { id: string; label: string }

  interface Props {
    channelId:        string;
    channelName:      string;
    onClose:          () => void;
    onTab:            (tab: string) => void;
    activeTab?:       string;
    onEscapeRequest?: () => void;
    roleOptions?:     RoleOption[];
    templateOptions?: TemplateOpt[];
    isDirty?:         boolean;
    saveInfo?:        string;
    matrixHtml?:      string;
    onRoleSelect?:    (id: string) => void;
    onGrantAll?:      () => void;
    onDenyAll?:       () => void;
    onResetAll?:      () => void;
    onSyncServer?:    () => void;
    onRemoveRow?:     () => void;
    onAddUser?:       () => void;
    onTemplateApply?: (id: string) => void;
    onSave?:          () => void;
    onAuditFilter?:   () => void;
    onAuditReset?:    () => void;
    onExport?:        () => void;
    onImportClick?:   () => void;
    onSyncSelectAll?:   (v: boolean) => void;
    onBulkSyncPreview?: () => void;
    auditBody?:           string;
    auditActionFilter?:   string;
    auditRoleFilter?:     string;
    auditSince?:          string;
    auditUntil?:          string;
    syncChannelListHtml?: string;
    syncCount?:           string;
    syncStatus?:          string;
    selectedRoleId?:      string;
  }

  let {
    channelId, channelName, onClose, onTab,
    activeTab           = 'matrix',
    onEscapeRequest,
    roleOptions         = [],
    templateOptions     = [],
    isDirty             = false,
    saveInfo            = '',
    matrixHtml          = '',
    onRoleSelect, onGrantAll, onDenyAll, onResetAll,
    onSyncServer, onRemoveRow, onAddUser, onTemplateApply,
    onSave, onAuditFilter, onAuditReset, onExport, onImportClick,
    onSyncSelectAll, onBulkSyncPreview,
    auditBody           = '<p class="ch-hint">Audit sekmesi açılınca yükleniyor…</p>',
    auditActionFilter   = '',
    auditRoleFilter     = '',
    auditSince          = '',
    auditUntil          = '',
    syncChannelListHtml = '<p class="ch-hint">Kanallar yükleniyor…</p>',
    syncCount           = '',
    syncStatus          = '',
    selectedRoleId      = '',
  }: Props = $props();

  const TABS = [
    { id: 'matrix', label: 'İzin Matrisi' },
    { id: 'audit',  label: 'Audit Log' },
    { id: 'sync',   label: 'Senkronize' },
  ];

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') (onEscapeRequest ?? onClose)();
  }
  onMount(()  => window.addEventListener('keydown', onKey));
  onDestroy(() => window.removeEventListener('keydown', onKey));

  const hasSelection = $derived(!!selectedRoleId);
</script>

<div
  id="ch-perms-modal"
  class="ch-perms-overlay"
  role="dialog"
  aria-modal="true"
  aria-label="Kanal izinleri — #{channelName}"
  tabindex="-1"
  data-testid="backdrop"
  onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}
  onkeydown={onKey}
>
  <div class="ch-perms-panel" data-testid="panel">

    <header class="ch-perms-header">
      <h2 class="ch-perms-title">
        🔐 Kanal İzinleri — #{channelName}
        {#if isDirty}
          <span class="dirty-badge">● Kaydedilmedi</span>
        {/if}
      </h2>
      <button type="button" class="ch-perms-close" onclick={onClose} aria-label="Kapat">✕</button>
    </header>

    <div class="ch-perms-tabs" role="tablist">
      {#each TABS as t}
        <button
          type="button" role="tab"
          class="chperms-tab"
          class:chperms-tab-active={activeTab === t.id}
          aria-selected={activeTab === t.id}
          data-tab={t.id}
          onclick={() => onTab(t.id)}
        >{t.label}</button>
      {/each}
    </div>

    <div class="ch-perms-content">

      <!-- ── MATRIX ──────────────────────────────────────────────── -->
      {#if activeTab === 'matrix'}
        <div id="chperms-pane-matrix" class="pane">
          <div class="ch-toolbar">
            <select
              id="chperms-role-select" class="ch-select"
              onchange={(e) => onRoleSelect?.((e.target as HTMLSelectElement).value)}
            >
              <option value="">— Rol / Üye Seç —</option>
              {#each roleOptions as r}
                <option value={r.id}>{r.isUser ? '👤 ' : ''}{r.name}</option>
              {/each}
            </select>

            <button type="button" class="btn" disabled={!hasSelection} onclick={() => onGrantAll?.()}>✅ Tümüne Ver</button>
            <button type="button" class="btn" disabled={!hasSelection} onclick={() => onDenyAll?.()}>❌ Tümünü Reddet</button>
            <button type="button" class="btn" disabled={!hasSelection} onclick={() => onResetAll?.()}>— Tümünü Sıfırla</button>
            <button type="button" class="btn" disabled={!hasSelection} onclick={() => onSyncServer?.()}>🔄 Sunucudan Eşitle</button>
            <button type="button" class="btn btn-danger" disabled={!hasSelection} onclick={() => onRemoveRow?.()}>🗑 Kaldır</button>

            <div class="spacer"></div>
            <button type="button" class="btn" onclick={() => onAddUser?.()}>👤 Üye Ekle</button>

            {#if templateOptions.length}
              <select
                class="ch-select ch-select-sm"
                onchange={(e) => {
                  const v = (e.target as HTMLSelectElement).value;
                  if (v) { onTemplateApply?.(v); (e.target as HTMLSelectElement).value = ''; }
                }}
              >
                <option value="">🗂 Şablon Uygula</option>
                {#each templateOptions as t}
                  <option value={t.id}>{t.label}</option>
                {/each}
              </select>
            {/if}
          </div>

          <!-- vanilla buildMatrix() HTML -->
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div id="chperms-matrix">{@html matrixHtml}</div>
        </div>

      <!-- ── AUDIT ───────────────────────────────────────────────── -->
      {:else if activeTab === 'audit'}
        <div id="chperms-pane-audit" class="pane">
          <div class="ch-toolbar">
            <select id="chperms-audit-action-filter" class="ch-select ch-select-sm" value={auditActionFilter}>
              <option value="">Tüm işlemler</option>
              <option value="PERM_UPDATE">İzin Güncellendi</option>
              <option value="PERM_DELETE">Override Silindi</option>
              <option value="PERM_BULK_SYNC">Toplu Senkronize</option>
            </select>
            <select id="chperms-audit-role-filter" class="ch-select ch-select-sm" value={auditRoleFilter}>
              <option value="">Tüm hedefler</option>
              {#each roleOptions as r}
                <option value={r.id}>{r.name}</option>
              {/each}
            </select>
            <input id="chperms-audit-since" type="date" class="ch-input" value={auditSince} aria-label="Başlangıç" />
            <input id="chperms-audit-until" type="date" class="ch-input" value={auditUntil} aria-label="Bitiş" />
            <button type="button" class="btn" id="btn-audit-filter" onclick={() => onAuditFilter?.()}>🔍 Filtrele</button>
            <button type="button" class="btn" id="btn-audit-reset"  onclick={() => onAuditReset?.()}>↩ Sıfırla</button>
            <div class="spacer"></div>
            <button type="button" class="btn" id="btn-export"       onclick={() => onExport?.()}>⬇ Dışa Aktar</button>
            <button type="button" class="btn" id="btn-import"       onclick={() => onImportClick?.()}>⬆ İçe Aktar</button>
          </div>
          <!-- eslint-disable-next-line svelte/no-at-html-tags -->
          <div id="chperms-audit-body">{@html auditBody}</div>
        </div>

      <!-- ── SYNC ────────────────────────────────────────────────── -->
      {:else if activeTab === 'sync'}
        <div id="chperms-pane-sync" class="pane">
          <p class="ch-hint" style="margin:0">Bu kanalın izinlerini seçili diğer kanallara kopyala.</p>

          <div class="sync-wrap">
            <div class="ch-label" id="chperms-sync-label">🎯 Hangi Kanallara Uygulanmak?</div>
            <!-- eslint-disable-next-line svelte/no-at-html-tags -->
            <div id="chperms-sync-channel-list" class="sync-list" aria-labelledby="chperms-sync-label">{@html syncChannelListHtml}</div>
          </div>

          <div class="ch-toolbar">
            <button type="button" class="btn" id="btn-sync-select-all"   onclick={() => onSyncSelectAll?.(true)}>Tümünü Seç</button>
            <button type="button" class="btn" id="btn-sync-deselect-all" onclick={() => onSyncSelectAll?.(false)}>Hiçbirini Seçme</button>
            <span id="chperms-sync-count" class="ch-hint">{syncCount}</span>
          </div>

          <div class="ch-toolbar">
            <button type="button" class="btn btn-primary" id="btn-bulk-sync-preview" onclick={() => onBulkSyncPreview?.()}>
              🔁 Önizle ve Uygula
            </button>
            <span id="chperms-sync-status" class="ch-hint">{syncStatus}</span>
          </div>
        </div>
      {/if}

    </div><!-- /.ch-perms-content -->

    <footer class="ch-perms-footer">
      <span id="chperms-save-info" class="ch-hint">{saveInfo}</span>
      <button type="button" class="btn"          id="chperms-cancel-btn" onclick={onClose}>İptal</button>
      <button type="button" class="btn btn-primary" id="chperms-save-btn" onclick={() => onSave?.()}>💾 Kaydet</button>
    </footer>

  </div>
</div>

<style>
  .ch-perms-overlay {
    position: fixed; inset: 0; z-index: 9000;
    display: flex; align-items: center; justify-content: center;
    background: rgba(0,0,0,0.7);
  }
  .ch-perms-panel {
    background: var(--bg-1); border-radius: 12px;
    width: min(96vw, 920px); max-height: 90vh;
    display: flex; flex-direction: column; overflow: hidden;
  }
  .ch-perms-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 20px 24px 0; flex-shrink: 0;
  }
  .ch-perms-title {
    margin: 0; font-size: 18px;
    display: flex; align-items: center; gap: 8px;
  }
  .dirty-badge {
    font-size: 11px; background: #f0b132; color: #000;
    padding: 2px 7px; border-radius: 10px; font-weight: 700;
  }
  .ch-perms-close {
    background: none; border: none; cursor: pointer;
    font-size: 20px; color: var(--text-3); line-height: 1;
  }
  .ch-perms-close:hover { color: var(--text-1); }
  .ch-perms-tabs {
    display: flex; border-bottom: 1px solid var(--bg-4);
    padding: 0 24px; flex-shrink: 0;
  }
  :global(.chperms-tab) {
    padding: 10px 18px; background: none; border: none; cursor: pointer;
    font-size: 13px; font-weight: 600; color: var(--text-3);
    border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  :global(.chperms-tab-active) { color: var(--text-1); border-bottom-color: var(--brand); }
  .ch-perms-content { flex: 1; overflow-y: auto; padding: 20px 24px; }
  .ch-perms-footer {
    display: flex; align-items: center; gap: 10px;
    padding: 14px 24px; border-top: 1px solid var(--bg-4); flex-shrink: 0;
  }
  .pane { display: flex; flex-direction: column; gap: 16px; }
  .ch-toolbar { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
  .spacer { flex: 1; }
  .ch-select {
    padding: 6px 10px; border-radius: 6px; border: 1px solid var(--bg-4);
    background: var(--bg-2); color: var(--text-1); font-size: 13px; min-width: 160px;
  }
  .ch-select-sm { min-width: unset; font-size: 12px; }
  .ch-input {
    padding: 5px 8px; border-radius: 6px; border: 1px solid var(--bg-4);
    background: var(--bg-2); color: var(--text-1); font-size: 12px;
  }
  .ch-hint { font-size: 12px; color: var(--text-3); }
  .ch-label { display: block; font-size: 12px; font-weight: 700; color: var(--text-2); margin-bottom: 8px; }
  .sync-wrap { margin-bottom: 0; }
  .sync-list {
    display: flex; flex-direction: column; gap: 6px;
    max-height: 280px; overflow-y: auto;
    padding: 10px; background: var(--bg-2); border-radius: 8px; border: 1px solid var(--bg-4);
  }
</style>
