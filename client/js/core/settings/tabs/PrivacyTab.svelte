<!-- client/js/core/settings/tabs/PrivacyTab.svelte -->
<!-- ADR-0002 Faz 1 — Gizlilik ayarları tabı.         -->
<!-- Sprint 54: PrivacyTab tamamlandı.                 -->

<script lang="ts">
  import type { SettingsStore } from '../stores/settingsStore';
  let { store }: { store: SettingsStore } = $props();

  // ── State ─────────────────────────────────────────────────────────────────
  let directMessages  = $state<'everyone' | 'friends' | 'none'>(
    (localStorage.getItem('bridge:privacy:dm') as 'everyone' | 'friends' | 'none') ?? 'everyone',
  );
  let readReceipts    = $state(localStorage.getItem('bridge:privacy:readReceipts') !== 'false');
  let onlineStatus    = $state(localStorage.getItem('bridge:privacy:onlineStatus') !== 'false');
  let dataCollection  = $state(localStorage.getItem('bridge:privacy:analytics')    !== 'false');

  let saving  = $state(false);
  let saved   = $state(false);
  let error   = $state<string | null>(null);

  // ── Kaydet ────────────────────────────────────────────────────────────────
  async function save() {
    saving = true;
    error  = null;
    saved  = false;
    try {
      const ok = await store.save({
        privacyDirectMessages: directMessages,
        privacyReadReceipts:   readReceipts,
        privacyOnlineStatus:   onlineStatus,
        privacyAnalytics:      dataCollection,
      });

      if (ok) {
        localStorage.setItem('bridge:privacy:dm',            directMessages);
        localStorage.setItem('bridge:privacy:readReceipts',  String(readReceipts));
        localStorage.setItem('bridge:privacy:onlineStatus',  String(onlineStatus));
        localStorage.setItem('bridge:privacy:analytics',     String(dataCollection));
        saved = true;
        setTimeout(() => { saved = false; }, 2000);
      } else {
        error = store.error ?? 'Kaydedilemedi';
      }
    } finally {
      saving = false;
    }
  }
</script>

<section aria-labelledby="privacy-heading">
  <h2 id="privacy-heading" class="section-title">Gizlilik</h2>

  <!-- ── DM izinleri ────────────────────────────────────────────────────── -->
  <div class="field-group">
    <label class="field-label" for="dm-perm">Kimden DM alabilirim</label>
    <select id="dm-perm" class="field-select" bind:value={directMessages}>
      <option value="everyone">Herkes</option>
      <option value="friends">Yalnızca arkadaşlar</option>
      <option value="none">Kimse</option>
    </select>
  </div>

  <!-- ── Toggle satırları ───────────────────────────────────────────────── -->
  <div class="toggle-row" role="group" aria-label="Okundu bilgisi">
    <div class="toggle-info">
      <span class="toggle-title">Okundu Bilgisi</span>
      <span class="toggle-desc">DM'lerde mesajların okunduğunu göster</span>
    </div>
    <button
      class="toggle-btn"
      class:on={readReceipts}
      aria-pressed={readReceipts}
      aria-label="Okundu bilgisini {readReceipts ? 'kapat' : 'aç'}"
      onclick={() => { readReceipts = !readReceipts; }}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>

  <div class="toggle-row" role="group" aria-label="Çevrimiçi durumu">
    <div class="toggle-info">
      <span class="toggle-title">Çevrimiçi Durumu</span>
      <span class="toggle-desc">Başkalarının seni çevrimiçi görmesine izin ver</span>
    </div>
    <button
      class="toggle-btn"
      class:on={onlineStatus}
      aria-pressed={onlineStatus}
      aria-label="Çevrimiçi durumu {onlineStatus ? 'kapat' : 'aç'}"
      onclick={() => { onlineStatus = !onlineStatus; }}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>

  <div class="toggle-row" role="group" aria-label="Veri toplama">
    <div class="toggle-info">
      <span class="toggle-title">Anonim Kullanım Verisi</span>
      <span class="toggle-desc">Uygulamayı iyileştirmek için anonim veri paylaş</span>
    </div>
    <button
      class="toggle-btn"
      class:on={dataCollection}
      aria-pressed={dataCollection}
      aria-label="Anonim veri toplamayı {dataCollection ? 'kapat' : 'aç'}"
      onclick={() => { dataCollection = !dataCollection; }}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>

  <!-- ── Kaydet ──────────────────────────────────────────────────────────── -->
  <div class="field-actions">
    <button
      class="btn btn--primary"
      class:btn--saved={saved}
      disabled={saving}
      onclick={save}
    >
      {#if saving}
        Kaydediliyor…
      {:else if saved}
        ✓ Kaydedildi
      {:else}
        Kaydet
      {/if}
    </button>
    {#if error}
      <span class="field-error" role="alert">{error}</span>
    {/if}
  </div>
</section>

<style>
  .section-title {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 24px;
    color: var(--text-primary, #e4e6eb);
  }

  .field-group   { margin-bottom: 24px; }

  .field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted, #6d6f78);
    margin-bottom: 8px;
  }

  .field-select {
    width: 100%;
    max-width: 280px;
    padding: 10px 12px;
    border: 1px solid var(--border, rgba(255,255,255,0.1));
    border-radius: 6px;
    background: var(--bg-input, rgba(0,0,0,0.2));
    color: var(--text-primary, #e4e6eb);
    font-size: 14px;
    outline: none;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236d6f78' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 36px;
  }

  .field-select:focus { border-color: var(--brand, #2d9cdb); }

  /* Toggle satırları */
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 0;
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }

  .toggle-info  { display: flex; flex-direction: column; gap: 2px; }
  .toggle-title { font-size: 14px; font-weight: 500; color: var(--text-primary, #e4e6eb); }
  .toggle-desc  { font-size: 12px; color: var(--text-muted, #6d6f78); }

  .toggle-btn {
    position: relative;
    width: 44px;
    height: 24px;
    border: none;
    border-radius: 12px;
    background: var(--bg-input, rgba(0,0,0,0.3));
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }

  .toggle-btn.on  { background: var(--brand, #2d9cdb); }
  .toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .toggle-knob {
    position: absolute;
    top: 2px; left: 2px;
    width: 20px; height: 20px;
    border-radius: 50%;
    background: #fff;
    transition: transform 0.2s;
  }

  .toggle-btn.on .toggle-knob { transform: translateX(20px); }

  /* Kaydet butonu */
  .field-actions { margin-top: 24px; display: flex; align-items: center; gap: 12px; }

  .btn {
    padding: 9px 20px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.1s, background 0.1s;
  }

  .btn--primary {
    background: var(--brand, #2d9cdb);
    color: #fff;
  }

  .btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn--primary:not(:disabled):hover { background: var(--brand-hover, #677bc4); }
  .btn--saved   { background: #3ba55d !important; }

  .field-error {
    font-size: 13px;
    color: #ed4245;
  }
</style>
