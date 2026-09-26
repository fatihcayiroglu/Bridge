<!-- client/js/core/server-settings/tabs/WebhookTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts openWebhookManager → Svelte 5 Runes  -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';
  import { getAPI, currentServerChannels } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';
  import { safeApiErrorMessage } from '../../api-error.ts';
  import { toast } from '../../utils.js';
  import { onDestroy } from 'svelte';

  interface Webhook {
    _id:         string;
    name:        string;
    channelId:   string;
    channelName?: string;
  }

  interface CreatedWebhook extends Webhook {
    token?: string;
  }

  const API    = getAPI();
  // TEK kanonik çözümleyici. Daha önce burada `BridgeRegistry.get(...)`
  // kullanılıyordu; o çağrı kayıtlı GETTER FONKSİYONUNU döndürür, sunucuyu
  // değil — bu yüzden `server._id` undefined kalıyor ve istekler
  // `/api/servers/undefined/...` adresine gidiyordu.
  const server = getCurrentServerFromRegistry() as { _id: string } | null;

  // C1.8 — KANAL LİSTESİ REAKTİF OLMALI.
  // Eskiden `const` idi: liste bileşen kurulurken bir kez hesaplanıyordu.
  // Kullanıcı modal açıkken sunucu değiştirirse liste ESKİ sunucunun
  // kanallarını göstermeye devam ediyor ve webhook YANLIŞ sunucunun kanalına
  // oluşturulabiliyordu. `$derived` her zaman kanonik geçerli sunucunun
  // kanallarını verir.
  const textChannels = $derived(
    (currentServerChannels as Array<{ _id: string; name: string; type?: string }>)
      .filter(c => c.type === 'text'),
  );

  /**
   * Seçilen kanalın GEÇERLİ sunucuya ait olduğunu doğrular.
   * Arka uç da kanaldan `serverId` türetip yetki kontrolü yapar (webhooks.ts:82),
   * ama iki sunucunun da sahibi olan bir kullanıcıda istemci tarafı sessizce
   * yanlış sunucuya yazabilirdi. Fail-closed: doğrulanamıyorsa reddet.
   */
  function assertChannelInCurrentServer(channelId: string): boolean {
    if (!channelId) { toast(t('whk_no_channel', 'Kanal seçilmedi'), 'error'); return false; }
    if (!server || !isStillCurrentServer(server._id)) {
      toast(t('srv_changed2', 'Sunucu değişti — ayarlar yeniden yüklenmeli'), 'error'); return false;
    }
    if (!textChannels.some(c => c._id === channelId)) {
      toast(t('whk_wrong_server', 'Kanal bu sunucuya ait değil'), 'error'); return false;
    }
    return true;
  }

  let webhooks    = $state<Webhook[]>([]);
  let loading     = $state(true);
  let creating    = $state(false);
  // Seçili kanal, kanal listesini TAKİP etmelidir. Başlangıç değerini bir kez
  // yakalamak, liste sonradan yüklendiğinde seçimi boş bırakır; sunucu
  // değiştiğinde ise ESKİ sunucunun kanalı seçili kalırdı.
  let newChannel  = $state('');
  let newName     = $state('');
  let copyTip     = $state<string | null>(null);
  let createdWebhookUrl = $state('');
  let copyTimer: ReturnType<typeof setTimeout> | null = null;

  // Geçerli kanal listesi değiştiğinde seçimi güvenli tut: seçili kanal artık
  // bu sunucuya ait değilse ilk geçerli kanala düş (yoksa boşalt).
  $effect(() => {
    const list = textChannels;
    if (!list.some(c => c._id === newChannel)) {
      newChannel = list[0]?._id ?? '';
    }
  });

  // ── Load ──────────────────────────────────────────────────────────────────
  async function load(): Promise<void> {
    loading = true;
    const all: Webhook[] = [];
    for (const ch of textChannels) {
      try {
        const r = await apiFetch(`${API}/api/channels/${encodeURIComponent(ch._id)}/webhooks`);
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
    if (!newChannel || !newName.trim()) { toast(t("ui_kanal_ve_isim_zorunlu", "Kanal ve isim zorunlu"), 'error'); return; }
    if (!assertChannelInCurrentServer(newChannel)) return;
    creating = true;
    try {
      const r = await apiFetch(`${API}/api/channels/${encodeURIComponent(newChannel)}/webhooks`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ name: newName.trim() }),
      });
      if (!r.ok) { toast(safeApiErrorMessage(r, t("ui_webhook_olusturulamadi", "Webhook oluşturulamadı."), { report: true }), 'error'); return; }
      const created = await r.json() as CreatedWebhook;
      if (typeof created?._id !== 'string' || typeof created?.token !== 'string' || !created.token) {
        toast(t('whk_secret_missing', 'Webhook oluşturuldu ancak gizli URL alınamadı; webhooku silip yeniden oluşturun.'), 'error');
        await load();
        return;
      }
      createdWebhookUrl = `${API}/api/webhooks/${encodeURIComponent(created._id)}?token=${encodeURIComponent(created.token)}`;
      toast(t('whk_created', '✅ Webhook oluşturuldu'), 'success');
      newName = '';
      await load();
    } catch {
      toast(t('whk_create_failed', 'Webhook oluşturulamadı'), 'error');
    } finally {
      creating = false;
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function deleteWebhook(channelId: string, webhookId: string): Promise<void> {
    if (!assertChannelInCurrentServer(channelId)) return;
    try {
      const r = await apiFetch(
        `${API}/api/channels/${encodeURIComponent(channelId)}/webhooks/${encodeURIComponent(webhookId)}`,
        { method: 'DELETE' },
      );
      if (!r.ok) { toast(t('common_delete_failed'), 'error'); return; }
      toast(t('webhook_deleted', 'Webhook silindi'), 'success');
      await load();
    } catch {
      toast(t('whk_delete_failed', 'Webhook silinemedi'), 'error');
    }
  }

  // ── Copy URL ───────────────────────────────────────────────────────────────
  async function copyUrl(url: string, id: string): Promise<void> {
    try {
      if (!navigator.clipboard?.writeText) throw new Error('clipboard unavailable');
      await navigator.clipboard.writeText(url);
      copyTip = id;
      if (copyTimer !== null) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => {
        copyTimer = null;
        copyTip = null;
      }, 1800);
    } catch {
      toast(t('whk_copy_failed', 'Webhook URL kopyalanamadı'), 'error');
    }
  }

  $effect(() => { void load(); });
  onDestroy(() => {
    if (copyTimer !== null) clearTimeout(copyTimer);
  });
</script>

<div class="webhook-tab">
  <p class="webhook-hint">
    {t('markup_webhooklar_github_stripe_gibi_dis_servislerin_ka_6aff7e3', "Webhooklar; GitHub, Stripe gibi dış servislerin kanalınıza mesaj göndermesini sağlar.")}
  </p>

  <!-- Create form -->
  <div class="form-group">
    <label for="webhook-channel-select">{t('markup_yeni_webhook_c8dc1c8', "Yeni Webhook")}</label>
    <div class="webhook-create-row">
      <select id="webhook-channel-select" class="input-field" bind:value={newChannel}>
        {#each textChannels as ch (ch._id)}
          <option value={ch._id}>#{ch.name}</option>
        {/each}
      </select>
      <input
        class="input-field"
        placeholder={t('whk_name', 'Webhook adı')}
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
        {creating ? '…' : t("surface_olustur_762008")}
      </button>
    </div>
  </div>

  {#if createdWebhookUrl}
    <div class="webhook-secret" role="status">
      <p>{t('whk_url_once', 'Bu gizli webhook URL’si yalnızca şimdi gösterilir. Güvenli bir yere kopyalayın.')}</p>
      <code>{createdWebhookUrl}</code>
      <div class="webhook-secret-actions">
        <button type="button" class="btn btn-sm" onclick={() => void copyUrl(createdWebhookUrl, 'created')}>
          {copyTip === 'created' ? t("surface_kopyaland_3273da") : t('whk_copy_url', 'URL Kopyala')}
        </button>
        <button type="button" class="btn btn-sm" onclick={() => { createdWebhookUrl = ''; }}>
          {t('close', 'Kapat')}
        </button>
      </div>
    </div>
  {/if}

  <!-- Webhook list -->
  {#if loading}
    <div class="webhook-loading">{t('sso_loading', 'Yükleniyor…')}</div>
  {:else if !webhooks.length}
    <div class="webhook-empty">{t('whk_none', 'Henüz webhook yok.')}</div>
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
              class="btn btn-sm btn-danger"
              onclick={() => void deleteWebhook(wh.channelId, wh._id)}
            >{t('delete')}</button>
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
  .webhook-secret {
    margin-top: 12px; padding: 12px; border: 1px solid var(--warning, #d8a63f); border-radius: 8px;
    background: var(--bg-1); display: grid; gap: 8px;
  }
  .webhook-secret p { margin: 0; font-size: 12px; color: var(--text-muted); }
  .webhook-secret code { overflow-wrap: anywhere; user-select: all; font-size: 11px; }
  .webhook-secret-actions { display: flex; gap: 6px; }
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
  .btn-danger { background: var(--danger, #e05260); color: var(--text-on-solid); }
  .btn-danger:hover { opacity: .85; }
</style>
