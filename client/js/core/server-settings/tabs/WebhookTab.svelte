<!-- client/js/core/server-settings/tabs/WebhookTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts openWebhookManager → Svelte 5 Runes  -->
<script lang="ts">
  import { getAPI, currentServerChannels } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';
  import { toast } from '../../utils.js';
  import { BridgeRegistry } from '../../bridge-registry.js';

  interface Webhook {
    _id:         string;
    name:        string;
    url:         string;
    channelId:   string;
    channelName?: string;
  }

  const API    = getAPI();
  const server = BridgeRegistry.get('getCurrentServer') as { _id: string } | null;

  // Text channels only (same filter as vanilla)
  const textChannels = (currentServerChannels as Array<{ _id: string; name: string; type?: string }>)
    .filter(c => c.type === 'text');

  let webhooks    = $state<Webhook[]>([]);
  let loading     = $state(true);
  let creating    = $state(false);
  let newChannel  = $state(textChannels[0]?._id ?? '');
  let newName     = $state('');
  let copyTip     = $state<string | null>(null);

  // ── Load ──────────────────────────────────────────────────────────────────
  async function load(): Promise<void> {
    loading = true;
    const all: Webhook[] = [];
    for (const ch of textChannels) {
      try {
        const r = await apiFetch(`${API}/api/channels/${ch._id}/webhooks`);
        if (r.ok) {
          const whs = await r.json() as Webhook[];
          all.push(...whs.map(w => ({ ...w, channelName: ch.name })));
        }
      } catch { /* skip */ }
    }
    webhooks = all;
    loading  = false;
  }

  // ── Create ─────────────────────────────────────────────────────────────────
  async function createWebhook(): Promise<void> {
    if (!newChannel || !newName.trim()) { toast('Kanal ve isim zorunlu', 'error'); return; }
    creating = true;
    try {
      const r = await apiFetch(`${API}/api/channels/${newChannel}/webhooks`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName.trim() }),
      });
      if (!r.ok) { const d = await r.json(); toast(d.error ?? 'Hata', 'error'); return; }
      toast('✅ Webhook oluşturuldu', 'success');
      newName = '';
      await load();
    } finally {
      creating = false;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function deleteWebhook(channelId: string, webhookId: string): Promise<void> {
    const r = await apiFetch(`${API}/api/channels/${channelId}/webhooks/${webhookId}`, { method: 'DELETE' });
    if (!r.ok) { toast('Silinemedi', 'error'); return; }
    toast('Webhook silindi', 'success');
    await load();
  }

  // ── Copy URL ───────────────────────────────────────────────────────────────
  async function copyUrl(url: string, id: string): Promise<void> {
    await navigator.clipboard.writeText(url).catch(() => {});
    copyTip = id;
    setTimeout(() => { copyTip = null; }, 1800);
  }

  $effect(() => { void load(); });
</script>

<div class="webhook-tab">
  <p class="webhook-hint">
    Webhooklar; GitHub, Stripe gibi dış servislerin kanalınıza mesaj göndermesini sağlar.
  </p>

  <!-- Create form -->
  <div class="form-group">
    <label for="webhook-channel-select">Yeni Webhook</label>
    <div class="webhook-create-row">
      <select id="webhook-channel-select" class="input-field" bind:value={newChannel}>
        {#each textChannels as ch (ch._id)}
          <option value={ch._id}>#{ch.name}</option>
        {/each}
      </select>
      <input
        class="input-field"
        placeholder="Webhook adı"
        maxlength="80"
        bind:value={newName}
        onkeydown={(e) => { if (e.key === 'Enter') void createWebhook(); }}
      />
      <button
        type="button"
        class="btn btn-primary"
        disabled={creating}
        onclick={createWebhook}
      >
        {creating ? '…' : '+ Oluştur'}
      </button>
    </div>
  </div>

  <!-- Webhook list -->
  {#if loading}
    <div class="webhook-loading">Yükleniyor…</div>
  {:else if !webhooks.length}
    <div class="webhook-empty">Henüz webhook yok.</div>
  {:else}
    <div class="webhook-list">
      {#each webhooks as wh (wh._id)}
        <div class="webhook-item">
          <div class="webhook-meta">
            <span class="webhook-name">{wh.name}</span>
            <span class="webhook-channel">#{wh.channelName ?? wh.channelId}</span>
          </div>
          <div class="webhook-actions">
            <button
              type="button"
              class="btn btn-sm"
              onclick={() => void copyUrl(wh.url, wh._id)}
            >
              {copyTip === wh._id ? '✅ Kopyalandı' : '🔗 URL Kopyala'}
            </button>
            <button
              type="button"
              class="btn btn-sm btn-danger"
              onclick={() => void deleteWebhook(wh.channelId, wh._id)}
            >Sil</button>
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .webhook-hint  { font-size: 13px; color: var(--text-muted); margin: 0 0 16px; }
  .webhook-create-row {
    display: flex; gap: 8px; flex-wrap: wrap; align-items: center;
  }
  .webhook-create-row .input-field:first-child { flex: 1; min-width: 120px; }
  .webhook-create-row .input-field:nth-child(2) { flex: 1.5; min-width: 140px; }
  .webhook-loading, .webhook-empty {
    color: var(--text-muted); font-size: 13px; text-align: center; padding: 20px 0;
  }
  .webhook-list { margin-top: 12px; display: flex; flex-direction: column; gap: 8px; }
  .webhook-item {
    background: var(--bg-1);
    border-radius: 8px;
    padding: 10px 12px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
  }
  .webhook-meta    { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .webhook-name    { font-weight: 600; font-size: 13px; }
  .webhook-channel { font-size: 11px; color: var(--text-muted); }
  .webhook-actions { display: flex; gap: 6px; flex-shrink: 0; }
  .btn-danger { background: var(--danger, #ed4245); color: #fff; }
  .btn-danger:hover { opacity: .85; }
</style>
