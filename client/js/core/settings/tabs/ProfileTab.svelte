<!-- client/js/core/settings/tabs/ProfileTab.svelte -->
<script lang="ts">
  import type { SettingsStore } from '../stores/settingsStore';
  import { getCurrentUser } from '../../state';

  let { store }: { store: SettingsStore } = $props();

  const user = getCurrentUser();

  let displayName = $state(user?.displayName ?? '');
  let statusText  = $state(user?.statusText  ?? '');
  let statusEmoji = $state(user?.statusEmoji ?? '');

  let dirty = $derived(
    displayName !== (user?.displayName ?? '') ||
    statusText  !== (user?.statusText  ?? '') ||
    statusEmoji !== (user?.statusEmoji ?? '')
  );

  async function save() {
    const ok = await store.save({ displayName, statusText, statusEmoji });
    if (ok) {
      // Yerel önbelleği güncelle — socket event ile de gelecek
      if (user) {
        user.displayName = displayName;
        user.statusText  = statusText;
        user.statusEmoji = statusEmoji;
      }
    }
  }
</script>

<section aria-labelledby="profile-heading">
  <h2 id="profile-heading" class="section-title">Profil Bilgileri</h2>

  <div class="field-group">
    <label class="field-label" for="display-name">Görünen Ad</label>
    <input
      id="display-name"
      class="field-input"
      type="text"
      maxlength="32"
      bind:value={displayName}
      placeholder="Görünen adınız"
    />
  </div>

  <div class="field-group">
    <label class="field-label" for="status-emoji">Durum Emoji</label>
    <input
      id="status-emoji"
      class="field-input field-input--short"
      type="text"
      maxlength="2"
      bind:value={statusEmoji}
      placeholder="😊"
    />
  </div>

  <div class="field-group">
    <label class="field-label" for="status-text">Durum Metni</label>
    <input
      id="status-text"
      class="field-input"
      type="text"
      maxlength="128"
      bind:value={statusText}
      placeholder="Durum mesajınız..."
    />
  </div>

  <div class="field-actions">
    <button
      class="btn btn--primary"
      disabled={!dirty || store.saving}
      onclick={save}
    >
      {store.saving ? 'Kaydediliyor…' : 'Kaydet'}
    </button>
  </div>
</section>

<style>
  .section-title {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 24px;
    color: var(--text-primary, #e4e6eb);
  }

  .field-group {
    margin-bottom: 20px;
  }

  .field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted, #6d6f78);
    margin-bottom: 6px;
  }

  .field-input {
    width: 100%;
    max-width: 400px;
    padding: 10px 12px;
    border: 1px solid var(--border, rgba(255,255,255,0.1));
    border-radius: 6px;
    background: var(--bg-input, rgba(0,0,0,0.2));
    color: var(--text-primary, #e4e6eb);
    font-size: 14px;
    outline: none;
    transition: border-color 0.15s;
    box-sizing: border-box;
  }

  .field-input--short { max-width: 80px; }

  .field-input:focus {
    border-color: var(--brand, #2d9cdb);
  }

  .field-actions {
    margin-top: 8px;
  }

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

  .btn--primary:disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  .btn--primary:not(:disabled):hover {
    background: var(--brand-hover, #677bc4);
  }
</style>
