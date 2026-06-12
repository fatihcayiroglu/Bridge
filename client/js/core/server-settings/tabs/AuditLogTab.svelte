<!-- client/js/core/server-settings/tabs/AuditLogTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts openAuditLogExport → Svelte 5 Runes  -->
<script lang="ts">
  import { getAPI } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';
  import { toast } from '../../utils.js';
  import { BridgeRegistry } from '../../bridge-registry.js';

  interface AuditEntry {
    createdAt: string | number;
    action?:   string;
    actorName?: string;
    targetName?: string;
  }

  const API    = getAPI();
  const server = BridgeRegistry.get('getCurrentServer') as { _id: string; name?: string } | null;

  let after    = $state('');
  let before   = $state('');
  let action   = $state('');
  let preview  = $state<AuditEntry[]>([]);
  let previewing = $state(false);
  let previewEmpty = $state(false);
  let previewError = $state(false);

  function buildParams(extra: Record<string, string> = {}): string {
    const p: Record<string, string> = { ...extra };
    if (after)  p.after  = after;
    if (before) p.before = before;
    if (action) p.action = action;
    return new URLSearchParams(p).toString();
  }

  async function doPreview(): Promise<void> {
    if (!server) return;
    previewing   = true;
    previewEmpty = false;
    previewError = false;
    preview      = [];
    try {
      const qs = buildParams({ limit: '10' });
      const r  = await apiFetch(`${API}/api/servers/${server._id}/audit-log?${qs}`);
      const d  = await r.json() as { logs?: AuditEntry[] } | AuditEntry[];
      const logs = Array.isArray(d) ? d : (d.logs ?? []);
      if (!logs.length) { previewEmpty = true; return; }
      preview = logs;
    } catch {
      previewError = true;
    } finally {
      previewing = false;
    }
  }

  function doExport(format: 'csv' | 'json'): void {
    if (!server) return;
    const qs = buildParams({ format });
    const url = `${API}/api/servers/${server._id}/audit-log/export?${qs}`;
    const a   = document.createElement('a');
    a.href     = url;
    a.download = `audit-${server._id}-${Date.now()}.${format}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    toast(`Audit log ${format.toUpperCase()} indiriliyor…`, 'success');
  }
</script>

<div class="audit-tab">
  <div class="audit-filters">
    <div class="form-group">
      <label for="al-after">Başlangıç Tarihi</label>
      <input id="al-after"  type="date" class="input-field" bind:value={after}  />
    </div>
    <div class="form-group">
      <label for="al-before">Bitiş Tarihi</label>
      <input id="al-before" type="date" class="input-field" bind:value={before} />
    </div>
  </div>

  <div class="form-group">
    <label for="al-action">
      Aksiyon Filtresi <span class="al-hint">(boş = tümü)</span>
    </label>
    <select id="al-action" class="input-field" bind:value={action}>
      <option value="">Tüm aksiyonlar</option>
      <option value="kick">Kick</option>
      <option value="ban">Ban</option>
      <option value="timeout">Timeout</option>
      <option value="message:delete">Mesaj Silme</option>
      <option value="role:assign">Rol Atama</option>
      <option value="channel:create">Kanal Oluşturma</option>
      <option value="channel:delete">Kanal Silme</option>
      <option value="server:update">Sunucu Güncelleme</option>
    </select>
  </div>

  <div class="form-group">
    <div class="form-label">Önizleme (son 10)</div>
    <div class="al-preview" aria-live="polite">
      {#if previewing}
        <span class="al-muted">Yükleniyor…</span>
      {:else if previewError}
        <span class="al-error">Yükleme başarısız</span>
      {:else if previewEmpty}
        <span class="al-muted">Kayıt bulunamadı</span>
      {:else if !preview.length}
        <span class="al-muted">Yüklemek için "Önizle" tıklayın</span>
      {:else}
        {#each preview as entry}
          <div class="al-row">
            <span class="al-date">
              {new Date(entry.createdAt).toLocaleString('tr-TR')}
            </span>
            <strong>{entry.action ?? ''}</strong>
            {entry.actorName ?? ''} → {entry.targetName ?? ''}
          </div>
        {/each}
      {/if}
    </div>
  </div>

  <div class="al-actions">
    <button type="button" class="btn btn-primary" onclick={doPreview} disabled={previewing}>
      👁 Önizle
    </button>
    <button
      type="button"
      class="btn btn-primary"
      style="background: var(--green, #3ba55c)"
      onclick={() => doExport('csv')}
    >⬇️ CSV İndir</button>
    <button
      type="button"
      class="btn btn-primary"
      style="background: #f0a020"
      onclick={() => doExport('json')}
    >⬇️ JSON İndir</button>
  </div>
</div>

<style>
  .audit-filters {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 10px;
    margin-bottom: 16px;
  }
  .al-hint  { font-size: 11px; color: var(--text-muted); font-weight: 400; }
  .al-preview {
    background: var(--bg-1);
    border-radius: 8px;
    padding: 10px;
    max-height: 200px;
    overflow-y: auto;
    font-size: 12px;
    font-family: monospace;
    color: var(--text-2);
    min-height: 40px;
  }
  .al-muted  { color: var(--text-muted); }
  .al-error  { color: var(--red, #ed4245); }
  .al-row {
    border-bottom: 1px solid var(--bg-5);
    padding: 4px 0;
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .al-date { color: var(--text-3); white-space: nowrap; }
  .al-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    margin-top: 16px;
  }
</style>
