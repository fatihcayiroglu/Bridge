<!-- client/js/core/server-settings/tabs/EmojiTab.svelte -->
<!-- ADR-0008 Faz 2 — server-settings.ts openEmojiManager / refreshEmojiGrid /
     uploadServerEmoji / deleteServerEmoji → Svelte 5 Runes                   -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';
  import { getAPI } from '../../globals.js';
  import { apiFetch } from '../../api-fetch.js';
  import { safeApiErrorMessage } from '../../api-error.ts';
  import { toast } from '../../utils.js';

  interface ServerEmoji {
    _id:    string;
    name:   string;
    url:    string;
  }

  const API = getAPI();
  // TEK kanonik çözümleyici. Daha önce burada `BridgeRegistry.get(...)`
  // kullanılıyordu; o çağrı kayıtlı GETTER FONKSİYONUNU döndürür, sunucuyu
  // değil — bu yüzden `server._id` undefined kalıyor ve istekler
  // `/api/servers/undefined/...` adresine gidiyordu.
  const server = getCurrentServerFromRegistry() as { _id: string } | null;

  // C1.7 — BAYAT SUNUCU KAPISI (yalnız MUTASYONLAR için).
  // `server` bileşen kurulurken çözülür. Kullanıcı modal açıkken başka bir
  // sunucuya geçerse, yükleme/silme YAKALANMIŞ eski kimliğe giderdi. Arka uç
  // yetkiyi doğrular, ama iki sunucunun da sahibi olan bir kullanıcıda bu
  // sessizce YANLIŞ sunucuyu değiştirebilirdi. Fail-closed.
  //
  // NOT: `load()` (GET) bilinçli olarak kanonik davranışını korur — salt okuma,
  // mount anında çalışır ve arka uçta ayrıca izin denetimine tabidir.
  function emojiServerId(): string | null {
    const id = String(server?._id ?? '');
    if (!id || !isStillCurrentServer(id)) {
      toast(t('srv_changed2', 'Sunucu değişti — ayarlar yeniden yüklenmeli'), 'error');
      return null;
    }
    return id;
  }

  let emojis   = $state<ServerEmoji[]>([]);
  let loading  = $state(true);
  let newName  = $state('');
  let uploading = $state(false);

  // ── Load ──────────────────────────────────────────────────────────────────
  async function load(): Promise<void> {
    if (!server) {
      emojis = [];
      loading = false;
      return;
    }
    loading = true;
    try {
      const r = await apiFetch(`${API}/api/servers/${encodeURIComponent(server._id)}/emojis`);
      if (!r.ok) {
        emojis = [];
        return;
      }
      const data = await r.json();
      emojis = Array.isArray(data) ? data : [];
    } catch {
      emojis = [];
      toast(t('emo_load_failed', 'Emojiler yüklenemedi'), 'error');
    } finally {
      loading = false;
    }
  }

  // ── Upload ─────────────────────────────────────────────────────────────────
  async function handleUpload(e: Event): Promise<void> {
    const input = e.currentTarget as HTMLInputElement;
    const file  = input.files?.[0];
    if (!file || !server) return;

    if (file.size > 256 * 1024)   { toast('Max 256KB!', 'error'); input.value = ''; return; }
    const safeName = newName.trim().toLowerCase().replace(/[^a-z0-9_]/g, '_');
    if (!safeName)                 { toast(t('emo_name_req', 'Emoji adı gir!'), 'error'); input.value = ''; return; }

    uploading = true;
    try {
      const fd = new FormData();
      fd.append('emoji', file);
      fd.append('name', safeName);
      const sid = emojiServerId();
      if (!sid) return;
      const r = await apiFetch(`${API}/api/servers/${encodeURIComponent(sid)}/emojis`, { method: 'POST', body: fd });
      if (!r.ok) { toast(safeApiErrorMessage(r, t("ui_emoji_yuklenemedi", "Emoji yüklenemedi."), { report: true }), 'error'); return; }
      toast(t('emoji_added', '✅ :{name}: eklendi!', { name: safeName }), 'success');
      newName = '';
    } finally {
      uploading = false;
      input.value = '';
      await load();
    }
  }

  // ── Delete ─────────────────────────────────────────────────────────────────
  async function deleteEmoji(emojiId: string): Promise<void> {
    if (!server) return;
    const sid = emojiServerId();
    if (!sid) return;
    const r = await apiFetch(`${API}/api/servers/${encodeURIComponent(sid)}/emojis/${encodeURIComponent(emojiId)}`, { method: 'DELETE' });
    if (!r.ok) { toast(t('common_delete_failed'), 'error'); return; }
    toast(t('emoji_deleted', 'Emoji silindi'), 'success');
    await load();
  }

  // Mount
  $effect(() => { void load(); });
</script>

<div class="emoji-tab">
  <p class="emoji-tab-hint">
    {t('markup_nitro_gerektirmez_sunucuya_ozel_3561903', "Nitro gerektirmez • Sunucuya özel •")} <strong>{t('emo_unlimited', 'Sınırsız emoji')}</strong> {t('markup_cross_server_kullanim_2c63c5e', "• Cross-server kullanım")}
  </p>

  <div class="emoji-upload-row">
    <input
      class="input-field"
      placeholder={t('emo_name_ph', 'emoji_adı (a-z, 0-9, _)')}
      maxlength="32"
      bind:value={newName}
    />
    <label class="btn btn-primary emoji-upload-label" class:disabled={uploading}>
      {t('upload')}
      <input
        type="file"
        accept="image/png,image/gif,image/webp,image/jpeg"
        style="display:none"
        disabled={uploading}
        onchange={handleUpload}
      />
    </label>
  </div>
  <p class="emoji-upload-hint">{t('markup_png_gif_animasyonlu_webp_jpeg_max_256kb_e2841e4', "PNG, GIF (animasyonlu!), WebP, JPEG • Max 256KB")}</p>

  {#if loading}
    <div class="emoji-loading">{t('sso_loading', 'Yükleniyor…')}</div>
  {:else if !emojis.length}
    <div class="emoji-empty">{t('emo_none', 'Henüz emoji yok. Yükle!')}</div>
  {:else}
    <div class="emoji-grid">
      {#each emojis as e (e._id)}
        <div class="emoji-card">
          <img src="{API}{e.url}" alt=":{e.name}:" class="emoji-img" />
          <div class="emoji-name">:{e.name}:</div>
          <button
            type="button"
            class="emoji-del-btn"
            aria-label={t('msg_action_delete')}
            onclick={() => deleteEmoji(e._id)}
          >×</button>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .emoji-tab-hint  { font-size: 13px; color: var(--text-muted); margin: 0 0 12px; }
  .emoji-upload-row {
    display: flex; gap: 8px; flex-wrap: wrap; margin-bottom: 6px;
  }
  .emoji-upload-row .input-field { flex: 1; min-width: 140px; }
  .emoji-upload-label { cursor: pointer; white-space: nowrap; }
  .emoji-upload-label.disabled { opacity: .5; pointer-events: none; }
  .emoji-upload-hint { font-size: 11px; color: var(--text-muted); margin: 0 0 16px; }
  .emoji-loading, .emoji-empty {
    color: var(--text-muted); font-size: 13px; padding: 16px 0; text-align: center;
  }
  .emoji-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(80px, 1fr));
    gap: 8px;
    max-height: 320px;
    overflow-y: auto;
  }
  .emoji-card {
    background: var(--bg-primary);
    border-radius: 8px;
    padding: 8px;
    text-align: center;
    position: relative;
  }
  .emoji-img  { width: 40px; height: 40px; object-fit: contain; display: block; margin: 0 auto 4px; }
  .emoji-name { font-size: 10px; color: var(--text-muted); word-break: break-all; }
  .emoji-del-btn {
    position: absolute; top: 2px; right: 2px;
    background: var(--danger, #e05260); border: none; color: var(--text-on-solid);
    border-radius: 50%; width: 16px; height: 16px;
    font-size: 10px; cursor: pointer;
    display: flex; align-items: center; justify-content: center;
    line-height: 1;
  }
  .emoji-del-btn:hover { opacity: .8; }
</style>
