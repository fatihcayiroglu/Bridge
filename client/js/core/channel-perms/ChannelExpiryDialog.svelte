<!-- client/js/core/channel-perms/ChannelExpiryDialog.svelte -->
<!--
  P7 D2 (#321): the server owner sets, changes or clears a channel's expiry.

  The server is authoritative (owner only, 1 h – 30 d window from the database clock, one
  permanent channel per server, optimistic version). This dialog re-reads the channel when it
  opens so the version it sends is the one the owner is looking at, and shows the server's
  refusal in words. When the channel expires its messages, threads, files and pins are deleted
  for everyone; moderation reports about it are kept for moderators (P7 B5 retention).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { t } from '../i18n/reactive.svelte.ts';
  import { focusTrap } from '../a11y/focusTrap.ts';
  import { apiFetch } from '../api-fetch.js';
  import { getAPI } from '../globals.js';
  import {
    EXPIRY_CHOICES, channelExpiresAt, channelExpiryVersion, formatChannelExpiry,
    requestedExpiresAt, saveChannelExpiry, type ExpiryChoiceKey, type ExpiryFailure,
  } from '../channel-list/channel-expiry.ts';

  let { serverId, channelId, channelName, onClose, onSaved }: {
    serverId: string;
    channelId: string;
    channelName: string;
    onClose: () => void;
    onSaved?: (expiresAt: number | null) => void;
  } = $props();

  let loading = $state(true);
  let saving = $state(false);
  let error = $state<string | null>(null);
  let currentExpiresAt = $state<number | null>(null);
  let version = $state(0);
  // Nothing is preselected for an expiring channel: Save must never change it by accident.
  let choice = $state<ExpiryChoiceKey | ''>('');

  const current = $derived(formatChannelExpiry(currentExpiresAt, Date.now()));
  // Saving "never" on a permanent channel, or nothing chosen, would change nothing.
  const canSave = $derived(!loading && !saving && choice !== '' && !(choice === 'never' && currentExpiresAt === null));

  const CHOICE_LABEL: Record<ExpiryChoiceKey, () => string> = {
    never: () => t('channel_expiry_never', 'Hiçbir zaman (kalıcı)'),
    '1h': () => t('channel_expiry_1h', '1 saat'),
    '24h': () => t('channel_expiry_24h', '24 saat'),
    '7d': () => t('channel_expiry_7d', '7 gün'),
    '30d': () => t('channel_expiry_30d', '30 gün'),
  };
  const FAILURE: Record<ExpiryFailure, () => string> = {
    last_permanent_channel: () => t('channel_expiry_last_permanent', 'Bir sunucuda en az bir kalıcı kanal kalmalıdır.'),
    version_conflict: () => t('channel_expiry_conflict', 'Bu kanalın süresi bu arada değişti. Kontrol edip yeniden deneyin.'),
    outside_window: () => t('channel_expiry_window', '1 saat ile 30 gün arasında seçin.'),
    forbidden: () => t('channel_expiry_owner_only', 'Kanal süresini yalnızca sunucu sahibi değiştirebilir.'),
    not_found: () => t('channel_expiry_gone', 'Bu kanal artık yok.'),
    failed: () => t('channel_expiry_failed', 'Süre kaydedilemedi.'),
  };

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const res = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/channels/${encodeURIComponent(channelId)}`);
      if (!res.ok) { error = FAILURE[res.status === 404 ? 'not_found' : 'failed'](); return; }
      const channel = await res.json() as unknown;
      currentExpiresAt = channelExpiresAt(channel);
      version = channelExpiryVersion(channel);
      choice = currentExpiresAt === null ? 'never' : '';
    } catch {
      error = FAILURE.failed();
    } finally {
      loading = false;
    }
  }

  async function save(): Promise<void> {
    if (!canSave) return;
    const selected = EXPIRY_CHOICES.find(c => c.key === choice);
    if (!selected) return;
    saving = true;
    error = null;
    const result = await saveChannelExpiry(
      apiFetch as unknown as (url: string, init?: RequestInit) => Promise<Response>, getAPI(), serverId, channelId,
      requestedExpiresAt(selected.lifetimeMs, Date.now()), version,
    );
    saving = false;
    if (!result.ok) {
      // Reload first on a conflict (it resets the error), then explain why nothing was saved.
      if (result.reason === 'version_conflict') await load();
      error = FAILURE[result.reason]();
      return;
    }
    onSaved?.(result.expiresAt);
    onClose();
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }

  onMount(() => { void load(); });
</script>

<svelte:window onkeydown={onKeydown} />

<div class="ce-overlay" role="presentation" onclick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
  <div class="ce-card" role="dialog" aria-modal="true" aria-labelledby="ce-title" use:focusTrap>
    <header class="ce-header">
      <!-- The channel name is user data: rendered as text, never HTML. -->
      <h2 class="ce-title" id="ce-title">{t('channel_expiry_title', 'Kanal süresi: {channel}', { channel: channelName })}</h2>
      <button type="button" class="ce-close" aria-label={t('close')} onclick={onClose}>✕</button>
    </header>

    {#if loading}
      <p class="ce-status" role="status">{t('channel_expiry_loading', 'Yükleniyor…')}</p>
    {:else}
      <div class="ce-body">
        <p class="ce-current" class:ce-soon={current?.soon}>
          {#if current}
            {t('channel_expiry_current', 'Sona eriyor')}: <time datetime={current.iso}>{current.absolute}</time>
          {:else}
            {t('channel_expiry_current_never', 'Bu kanal kalıcı.')}
          {/if}
        </p>
        <fieldset class="ce-choices">
          <legend>{t('channel_expiry_choose', 'Bu kanalı ve içeriğini şu süre sonra sil')}</legend>
          {#each EXPIRY_CHOICES as option (option.key)}
            <label class="ce-choice">
              <input type="radio" name="ce-choice" value={option.key} bind:group={choice} disabled={saving} />
              <span>{CHOICE_LABEL[option.key]()}</span>
            </label>
          {/each}
        </fieldset>
        <p class="ce-note">
          {t('channel_expiry_disclosure', 'Süresi dolduğunda mesajları, konuları, dosyaları ve sabitlenmiş mesajları herkes için silinir. Kanalla ilgili moderasyon şikâyetleri moderatörler için saklanır.')}
        </p>
      </div>
    {/if}

    {#if error}
      <p class="ce-error" role="alert">{error}</p>
    {/if}

    <footer class="ce-footer">
      <button type="button" class="btn" onclick={onClose}>{t('cancel')}</button>
      <button type="button" class="btn btn-primary" disabled={!canSave} onclick={save}>
        {saving ? t('ui_saving') : t('save')}
      </button>
    </footer>
  </div>
</div>

<style>
  .ce-overlay {
    position: fixed; inset: 0; z-index: var(--layer-modal);
    display: flex; align-items: center; justify-content: center;
    padding: var(--space-4);
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    backdrop-filter: blur(6px);
  }
  .ce-card {
    width: min(460px, 100%);
    display: flex; flex-direction: column;
    background: var(--surface-content);
    border: 1px solid var(--border);
    border-radius: var(--radius-modal);
    box-shadow: var(--shadow-lg);
  }
  .ce-header {
    display: flex; align-items: center; justify-content: space-between; gap: var(--space-2);
    padding: var(--space-4); border-bottom: 1px solid var(--border);
  }
  .ce-title { margin: 0; font-size: var(--text-lg); color: var(--text-primary); overflow-wrap: anywhere; }
  .ce-close {
    width: 32px; height: 32px; flex: none; cursor: pointer;
    color: var(--text-2); background: transparent;
    border: 1px solid var(--border); border-radius: var(--radius-pill);
  }
  .ce-close:hover { color: var(--text-primary); background: var(--surface-hover); }
  .ce-status { padding: var(--space-6) var(--space-4); color: var(--text-muted); text-align: center; }
  .ce-body { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-4); }
  .ce-current { margin: 0; color: var(--text-2); font-size: var(--text-sm); }
  .ce-current.ce-soon { color: var(--warning, var(--danger)); font-weight: 600; }
  .ce-choices { display: flex; flex-direction: column; gap: 6px; margin: 0; padding: 0; border: 0; }
  .ce-choices legend { margin-bottom: 6px; color: var(--text-primary); font-size: var(--text-sm); font-weight: 600; }
  .ce-choice { display: flex; align-items: center; gap: 8px; min-height: 32px; color: var(--text-2); cursor: pointer; }
  .ce-note { margin: 0; color: var(--text-muted); font-size: var(--text-xs, var(--text-sm)); }
  .ce-error { margin: 0 var(--space-4) var(--space-2); color: var(--danger); font-size: var(--text-sm); }
  .ce-footer {
    display: flex; justify-content: flex-end; gap: var(--space-2);
    padding: var(--space-4); border-top: 1px solid var(--border);
  }
  .ce-close:focus-visible, .ce-choice input:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  @media (max-width: 700px) {
    .ce-overlay { padding: 0; align-items: flex-end; }
    .ce-card { width: 100%; border-radius: var(--radius-modal) var(--radius-modal) 0 0; }
    .ce-footer { padding-bottom: calc(var(--space-4) + env(safe-area-inset-bottom)); }
    .ce-footer button, .ce-choice { min-height: 44px; }
    .ce-close { width: 40px; height: 40px; }
  }
</style>
