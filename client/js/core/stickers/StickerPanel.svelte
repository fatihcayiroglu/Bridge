<!-- client/js/core/stickers/StickerPanel.svelte -->
<!--
  FAZ C3 — STICKER PAKETLERİ: GÜVENLİ, VERİ TABANLI PANEL.

  P3: Sticker varlıkları artık canonical `type:'sticker'` message contract'ıyla
  gönderilebilir. Byte payloadları değiştirilmez; mesaj yalnız server-verified
  sticker kimliği ve immutable safe snapshot saklar.

  YETKİ: yönetim eylemleri arka uçta MANAGE_SERVER ister
  (routes/sticker-packs.ts — POST/DELETE/PATCH). Görünürlük yalnız UX'tir;
  yetki sınırı arka uçtadır. Kanıtlanamayan yetki GİZLENİR (fail-closed).

  GÜVENLİK: `{@html}` KULLANILMAZ. Paket/sticker adları ve etiketler kullanıcı
  denetimindedir ve metin olarak basılır. Sticker URL'leri kontrolcüde beyaz
  listeden geçer; listeye giremeyen sticker hiç render edilmez.
-->
<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  import { focusTrap } from '../a11y/focusTrap.ts';
  import { createLogger } from '../logger.ts';
  import { safeServerUrl } from '../globals.ts';
  const log = createLogger('StickerPanel');
  import {
    checkStickerFiles, STICKER_MAX_FILES, STICKER_MAX_FILE_SIZE, STICKER_ACCEPTED_TYPES,
    type StickerPack, type Sticker, type RejectReason,
  } from './stickerStore.ts';

  interface Props {
    packs:       StickerPack[];
    loading:     boolean;
    busy:        boolean;
    error:       string | null;
    canManage:   boolean;
    onDeletePack: (packId: string) => void;
    onRename:    (packId: string, stickerId: string, name: string) => void;
    onCreate:    (name: string, description: string, files: File[]) => Promise<boolean>;
    onSend:      (sticker: Sticker) => boolean;
    onClose:     () => void;
  }

  let { packs, loading, busy, error, canManage, onDeletePack, onRename, onCreate, onSend, onClose }: Props = $props();

  // ── Yeni paket oluşturma ───────────────────────────────────────────────────
  let creating    = $state(false);
  let newName     = $state('');
  let newDesc     = $state('');
  let picked      = $state<File[]>([]);
  let rejected    = $state<Array<{ name: string; reason: RejectReason }>>([]);
  let fileInputEl = $state<HTMLInputElement | null>(null);
  let submitting  = $state(false);
  let createError = $state<string | null>(null);
  let failedPreviewUrls = $state<string[]>([]);

  function markPreviewFailed(url: string): void {
    if (!failedPreviewUrls.includes(url)) failedPreviewUrls = [...failedPreviewUrls, url];
  }

  const acceptAttr = STICKER_ACCEPTED_TYPES.join(',');
  const maxKb      = Math.round(STICKER_MAX_FILE_SIZE / 1024);

  const formBusy  = $derived(busy || submitting);
  const canSubmit = $derived(Boolean(newName.trim()) && picked.length > 0 && !formBusy);
  const shownError = $derived(error ?? createError);

  const REASON_TEXT: Record<RejectReason, string> = {
    type: t('sticker_unsupported_format', 'desteklenmeyen biçim (PNG, WebP veya GIF gerekli)'),
    size:  t('sticker_too_large_kb', 'çok büyük (en fazla {max} KB)', { max: maxKb }),
    count: t('sticker_file_limit_exceeded', '{max} dosya sınırı aşıldı', { max: STICKER_MAX_FILES }),
  };

  function openCreate(): void {
    creating = true;
    resetCreate();
  }

  function resetCreate(): void {
    newName  = '';
    newDesc  = '';
    picked   = [];
    rejected = [];
    createError = null;
    if (fileInputEl) fileInputEl.value = '';
  }

  function cancelCreate(): void {
    creating = false;
    resetCreate();
  }

  /**
   * Seçilen dosyalar arka uç sınırlarına göre ayrılır. Sessiz kırpma YOKTUR:
   * elenen her dosya gerekçesiyle listelenir.
   */
  function onFilesPicked(e: Event): void {
    const input = e.currentTarget as HTMLInputElement;
    const files = [...(input.files ?? [])];
    const check = checkStickerFiles(files);
    picked   = check.accepted;
    rejected = check.rejected;
  }

  async function submitCreate(): Promise<void> {
    if (!canSubmit) return;                 // çift gönderim ayrıca store'da da engelli
    submitting = true;
    createError = null;
    try {
      const okDone = await onCreate(newName, newDesc, picked);
      if (okDone) { creating = false; resetCreate(); }
    } catch (e) {
      // Props sözleşmesi Promise döndürür; beklenmedik sahip hatası tarayıcıda
      // unhandled rejection olmamalı ve form yeniden denenebilir kalmalı.
      log.error('Sticker paketi oluşturma sahibi hata verdi', e);
      createError = t('stk_create_failed', 'Paket oluşturulamadı. Tekrar dene.');
    } finally {
      submitting = false;
    }
  }

  // Silme iki adımlıdır: yanlışlıkla kalıcı veri kaybı olmasın.
  let confirmingPackId = $state('');
  let renamingPackId   = $state('');
  let renamingId       = $state('');
  let renameValue      = $state('');

  const total = $derived(packs.reduce((n, p) => n + p.stickers.length, 0));

  function askDelete(packId: string): void {
    // Onay açıkken bu düğme yerini onay kontrollerine bırakır; aynı düğmenin
    // ikinci kez çağrılabildiği sahte bir toggle durumu yoktur.
    confirmingPackId = packId;
  }

  function confirmDelete(packId: string): void {
    confirmingPackId = '';
    onDeletePack(packId);
  }

  function startRename(packId: string, s: Sticker): void {
    renamingPackId = packId;
    renamingId  = s.id;
    renameValue = s.name;
  }

  function commitRename(packId: string): void {
    const next = renameValue.trim();
    const id   = renamingId;
    const ownerPackId = renamingPackId;
    renamingPackId = '';
    renamingId = '';
    if (next && id && ownerPackId === packId) onRename(packId, id, next);
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }
</script>

<svelte:window on:keydown={onKeydown} />

<div class="sp-overlay" role="presentation"
     onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="sp-card" role="dialog" aria-modal="true" aria-label={t('attr_sticker_paketleri_0a29186', "Sticker paketleri")} use:focusTrap>
    <header class="sp-header">
      <h2 class="sp-title">{t('markup_sticker_paketleri_71620ba', "Sticker Paketleri")}</h2>
      <button type="button" class="sp-close" aria-label={t('close')} onclick={onClose}>✕</button>
    </header>

    {#if shownError}
      <p class="sp-error" role="alert">{shownError}</p>
    {/if}

    <!--
      OLUŞTURMA: yalnız MANAGE_SERVER kanıtlanmışsa. Görünürlük UX'tir;
      arka uç (routes/sticker-packs.ts POST) yetkiyi kendisi doğrular.
    -->
    {#if canManage}
      <div class="sp-create">
        {#if !creating}
          <button type="button" class="sp-btn sp-btn-primary" disabled={busy} onclick={openCreate}>
            {t('markup_yeni_paket_olustur_1af4da4', "Yeni paket oluştur")}
          </button>
        {:else}
          <form class="sp-form" onsubmit={(e) => { e.preventDefault(); void submitCreate(); }}>
            <label class="sp-field">
              <span class="sp-label">{t('stk_pack_name', 'Paket adı')}</span>
              <input class="sp-input" type="text" bind:value={newName} disabled={formBusy}
                     placeholder={t('stk_name_ph', 'Örnek: Kedi Paketi')} required />
            </label>

            <label class="sp-field">
              <span class="sp-label">{t('stk_description', 'Açıklama')} <span class="sp-optional">{t('stk_optional', '(isteğe bağlı)')}</span></span>
              <input class="sp-input" type="text" bind:value={newDesc} disabled={formBusy} />
            </label>

            <label class="sp-field">
              <span class="sp-label">{t('stk_files', 'Sticker dosyaları')}</span>
              <input
                class="sp-file"
                type="file"
                multiple
                accept={acceptAttr}
                bind:this={fileInputEl}
                disabled={formBusy}
                onchange={onFilesPicked}
              />
              <span class="sp-hint">
                {t("ui_sticker_upload_hint", undefined, { maxKb, maxFiles: STICKER_MAX_FILES })}
              </span>
            </label>

            {#if picked.length}
              <p class="sp-picked">{t("ui_files_selected", undefined, { count: picked.length })}</p>
              <ul class="sp-picked-list">
                {#each picked as f (f.name)}
                  <!-- Dosya adı KULLANICI VERİSİDİR — metin olarak basılır. -->
                  <li class="sp-picked-item" title={f.name}>{f.name}</li>
                {/each}
              </ul>
            {/if}

            {#if rejected.length}
              <ul class="sp-rejected" role="alert">
                {#each rejected as r (r.name + r.reason)}
                  <li class="sp-rejected-item">{r.name} — {REASON_TEXT[r.reason]}</li>
                {/each}
              </ul>
            {/if}

            <div class="sp-form-actions">
              <button type="button" class="sp-btn" disabled={formBusy} onclick={cancelCreate}>{t('ccp_cancel', 'Vazgeç')}</button>
              <button type="submit" class="sp-btn sp-btn-primary" disabled={!canSubmit}>
                {formBusy ? t("loading") : t("surface_paketi_olustur_3ccbad")}
              </button>
            </div>
          </form>
        {/if}
      </div>
    {/if}

    {#if loading}
      <p class="sp-status">{t('stk_loading', 'Paketler yükleniyor…')}</p>
    {:else if !packs.length}
      <p class="sp-status">{t('stk_empty', 'Bu sunucuda henüz sticker paketi yok.')}</p>
    {:else}
      <p class="sp-summary">{t('sticker_summary_count', undefined, { packs: packs.length, stickers: total })}</p>

      <div class="sp-body">
        {#each packs as pack (pack._id)}
          <section class="sp-pack">
            <div class="sp-pack-head">
              <div class="sp-pack-meta">
                <!-- Paket adı/açıklaması KULLANICI VERİSİDİR — metin olarak basılır. -->
                <h3 class="sp-pack-name">{pack.name}</h3>
                {#if pack.description}
                  <p class="sp-pack-desc">{pack.description}</p>
                {/if}
              </div>

              {#if canManage}
                {#if confirmingPackId === pack._id}
                  <div class="sp-confirm">
                    <span class="sp-confirm-text">{t('stk_delete_confirm', 'Paket ve tüm sticker’ları silinsin mi?')}</span>
                    <button type="button" class="sp-btn" disabled={busy}
                            onclick={() => { confirmingPackId = ''; }}>{t('ccp_cancel', 'Vazgeç')}</button>
                    <button type="button" class="sp-btn sp-btn-danger" disabled={busy}
                            onclick={() => confirmDelete(pack._id)}>{t('delete')}</button>
                  </div>
                {:else}
                  <button type="button" class="sp-btn" disabled={busy}
                          onclick={() => askDelete(pack._id)}>{t('markup_paketi_sil_26e9946', "Paketi sil")}</button>
                {/if}
              {/if}
            </div>

            <ul class="sp-grid">
              {#each pack.stickers as st (st.id)}
                <li class="sp-item">
                  <!-- URL kontrolcüde beyaz listeden geçti. Immutable legacy payload
                       bozuksa tarayıcının kırık-görsel simgesi yerine erişilebilir bir
                       fallback gösterilir; asset byte'ına dokunulmaz. -->
                  {#if failedPreviewUrls.includes(st.url)}
                    <div class="sp-img-fallback" role="img" aria-label={t('sticker_named_unavailable_aria', undefined, { name: st.name })}>
                      <span class="sp-img-fallback-mark" aria-hidden="true">◇</span>
                      <span>{t("sticker_preview_unavailable")}</span>
                    </div>
                  {:else}
                    <img class="sp-img" src={safeServerUrl(st.url)} alt={st.name} width={st.width} height={st.height}
                         loading="lazy" decoding="async" onerror={() => markPreviewFailed(st.url)} />
                  {/if}

                  {#if canManage && renamingPackId === pack._id && renamingId === st.id}
                    <input
                      class="sp-rename"
                      type="text"
                      bind:value={renameValue}
                      aria-label={t('sticker_new_name_aria', undefined, { name: st.name })}
                      disabled={busy}
                      onkeydown={(e) => {
                        if (e.key === 'Enter') commitRename(pack._id);
                        if (e.key === 'Escape') {
                          e.stopPropagation();
                          renamingPackId = '';
                          renamingId = '';
                        }
                      }}
                      onblur={() => commitRename(pack._id)}
                    />
                  {:else}
                    <span class="sp-name" title={st.name}>{st.name}</span>
                    <button type="button" class="sp-send-btn" disabled={busy}
                            aria-label={t('sticker_send_named_aria', undefined, { name: st.name })}
                            onclick={() => { if (onSend(st)) onClose(); }}>{t("send")}</button>
                    {#if canManage}
                      <button type="button" class="sp-rename-btn" disabled={busy}
                              aria-label={t('sticker_rename_named_aria', undefined, { name: st.name })}
                              onclick={() => startRename(pack._id, st)}>{t('stk_rename', 'Yeniden adlandır')}</button>
                    {/if}
                  {/if}
                </li>
              {/each}
            </ul>
          </section>
        {/each}
      </div>
    {/if}

    <footer class="sp-footer">
      <span class="sp-note">{t('markup_sticker_gonderimi_sunucu_onayiyla_teslim_edilir__cc84840', "Sticker gönderimi sunucu onayıyla teslim edilir; başarısız gönderimler mesaj kuyruğundan yeniden denenebilir.")}</span>
    </footer>
  </div>
</div>

<style>
  .sp-overlay {
    position: fixed; inset: 0; z-index: var(--layer-modal);
    display: flex; align-items: center; justify-content: center;
    padding: var(--space-4);
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    backdrop-filter: blur(6px);
  }
  .sp-card {
    width: min(760px, 100%); max-height: min(760px, calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-4) * 2)));
    display: flex; flex-direction: column; overflow: hidden;
    background: var(--surface-content);
    border: 1px solid var(--border);
    border-radius: var(--radius-modal);
    box-shadow: var(--shadow-lg);
  }
  .sp-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: var(--space-4); border-bottom: 1px solid var(--border);
  }
  .sp-title { margin: 0; font-size: var(--text-lg); color: var(--text-primary); }
  .sp-close {
    width: 32px; height: 32px; cursor: pointer;
    color: var(--text-2); background: transparent;
    border: 1px solid var(--border); border-radius: var(--radius-pill);
  }
  .sp-close:hover { color: var(--text-primary); background: var(--surface-hover); }
  .sp-error   { margin: var(--space-3) var(--space-4) 0; color: var(--danger); font-size: var(--text-sm); }
  .sp-status  { padding: var(--space-6) var(--space-4); color: var(--text-muted); text-align: center; }
  .sp-summary { margin: var(--space-3) var(--space-4) 0; color: var(--text-muted); font-size: var(--text-xs); }
  .sp-body    { padding: var(--space-4); overflow-y: auto; display: flex; flex-direction: column; gap: var(--space-5); }
  .sp-pack-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    gap: var(--space-3); margin-bottom: var(--space-2);
  }
  .sp-pack-meta { min-width: 0; }
  .sp-pack-name { margin: 0; font-size: var(--text-sm); color: var(--text-primary); }
  .sp-pack-desc { margin: 2px 0 0; font-size: var(--text-xs); color: var(--text-muted); }
  .sp-confirm { display: flex; align-items: center; gap: var(--space-2); flex-shrink: 0; }
  .sp-confirm-text { font-size: var(--text-xs); color: var(--text-2); }
  .sp-btn {
    padding: 4px 9px; cursor: pointer; font-size: var(--text-xs);
    color: var(--text-2); background: var(--bg-3);
    border: 1px solid var(--border); border-radius: var(--radius-control);
  }
  .sp-btn:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-primary); }
  .sp-btn:disabled { opacity: .5; cursor: not-allowed; }
  .sp-btn-danger { border-color: var(--danger); color: var(--danger); }
  .sp-btn-primary { background: var(--brand); color: var(--text-on-solid); border-color: var(--brand); }
  .sp-btn-primary:hover:not(:disabled) { background: var(--brand-hover); color: var(--text-on-solid); }
  .sp-close:focus-visible, .sp-btn:focus-visible, .sp-input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }
  .sp-create { padding: var(--space-3) var(--space-4) 0; }
  .sp-form {
    display: flex; flex-direction: column; gap: var(--space-3);
    padding: var(--space-3); border: 1px solid var(--border);
    border-radius: var(--radius-control); background: var(--bg-3);
  }
  .sp-field { display: flex; flex-direction: column; gap: 4px; }
  .sp-label { font-size: var(--text-xs); color: var(--text-2); font-weight: 600; }
  .sp-optional { font-weight: 400; color: var(--text-muted); }
  .sp-input {
    padding: 6px 8px; font-size: var(--text-sm); color: var(--text-primary);
    background: var(--surface-content); border: 1px solid var(--border);
    border-radius: var(--radius-control);
  }
  .sp-file { font-size: var(--text-xs); color: var(--text-2); }
  .sp-hint { font-size: var(--text-xs); color: var(--text-muted); }
  .sp-picked { margin: 0; font-size: var(--text-xs); color: var(--text-2); }
  .sp-picked-list, .sp-rejected {
    list-style: none; margin: 0; padding: 0; max-height: 108px; overflow-y: auto;
    display: flex; flex-direction: column; gap: 2px;
  }
  .sp-picked-item, .sp-rejected-item {
    font-size: var(--text-xs);
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sp-picked-item  { color: var(--text-muted); }
  .sp-rejected-item { color: var(--danger); }
  .sp-form-actions { display: flex; justify-content: flex-end; gap: var(--space-2); }
  .sp-input:focus-visible, .sp-file:focus-visible {
    outline: 2px solid var(--focus-ring); outline-offset: 2px;
  }
  .sp-grid {
    list-style: none; margin: 0; padding: 0;
    display: grid; grid-template-columns: repeat(auto-fill, minmax(104px, 1fr)); gap: var(--space-3);
  }
  .sp-item {
    display: flex; flex-direction: column; align-items: center; gap: 4px;
    padding: var(--space-2); border-radius: var(--radius-control);
    background: var(--bg-3); border: 1px solid var(--border);
  }
  .sp-img { width: 72px; height: 72px; object-fit: contain; display: block; }
  .sp-img-fallback {
    width: 72px; height: 72px; padding: 6px; box-sizing: border-box;
    display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 3px;
    border: 1px dashed var(--border); border-radius: var(--radius-control);
    color: var(--text-muted); background: var(--surface-content);
    font-size: 10px; line-height: 1.15; text-align: center;
  }
  .sp-img-fallback-mark { font-size: 20px; line-height: 1; color: var(--text-2); }
  .sp-name {
    font-size: var(--text-xs); color: var(--text-2);
    max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .sp-rename {
    width: 100%; font-size: var(--text-xs);
    padding: 2px 4px; color: var(--text-primary);
    background: var(--surface-content); border: 1px solid var(--brand);
    border-radius: var(--radius-control);
  }
  .sp-send-btn {
    width: 100%; border: 1px solid var(--border); border-radius: var(--radius-sm);
    background: var(--surface-hover); color: var(--text-primary); cursor: pointer; padding: 5px 8px;
  }
  .sp-send-btn:hover, .sp-send-btn:focus-visible { background: var(--surface-active); outline: none; }
  .sp-send-btn:disabled { opacity: .55; cursor: default; }
  .sp-rename-btn {
    font-size: var(--text-xs); cursor: pointer; padding: 2px 6px;
    color: var(--text-muted); background: transparent;
    border: 1px solid var(--border); border-radius: var(--radius-control);
  }
  .sp-rename-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--surface-hover); }
  .sp-rename-btn:disabled { opacity: .5; cursor: not-allowed; }
  .sp-footer {
    padding: var(--space-3) var(--space-4);
    border-top: 1px solid var(--border);
  }
  .sp-note { font-size: var(--text-xs); color: var(--text-muted); }
  .sp-close:focus-visible, .sp-btn:focus-visible,
  .sp-rename-btn:focus-visible, .sp-rename:focus-visible {
    outline: 2px solid var(--focus-ring); outline-offset: 2px;
  }

  @media (max-width: 600px) {
    .sp-overlay { padding: 0; align-items: stretch; }
    .sp-card { width: 100%; max-height: none; height: var(--bridge-visual-viewport-height, 100dvh); border: 0; border-radius: 0; }
    .sp-header { padding-top: max(var(--space-4), env(safe-area-inset-top)); }
    .sp-close { width: 40px; height: 40px; }
    .sp-body { padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom)); }
    .sp-pack-head { flex-direction: column; }
    .sp-confirm { width: 100%; flex-wrap: wrap; }
    .sp-btn { min-height: 40px; }
  }
</style>
