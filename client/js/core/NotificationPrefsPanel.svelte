<!-- client/js/core/NotificationPrefsPanel.svelte -->
<!--
  FAZ K/5 — BILDIRIM TERCIHLERI.

  ════════════════════════════════════════════════════════════════════════════
  KAPATILAN GERCEK BOSLUK
  ════════════════════════════════════════════════════════════════════════════
  Sunucu tarafi TAMDI: kanal ve sunucu seviyesinde `all | mentions | mute`,
  `muteUntil` ile erteleme ve varsayilana donus.

  Bu dosya ise 50 satirlik BOS bir kabuktu: hicbir API cagrisi, hicbir tercih
  kontrolu yoktu (`{@render children?.()}` disinda govdesi yoktu) ve uretim
  giris noktasindan HIC import edilmiyordu. Kullanici bir kanali
  SUSTURAMIYORDU — ozellik "var" gorunup yoktu.

  ── SUSTURMA BIR YETKI SINIRI DEGILDIR ────────────────────────────────────
  Tercihler yalnizca CAGIRANIN kendi kaydini degistirir (sunucu `user.id` ile
  yazar). Bu panel baskasinin ayarina dokunmaz ve hicbir yetki kararini
  istemciye tasimaz.
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import {
    fetchPrefs, saveServerLevel, saveChannelLevel, resetChannel, saveWatchWords,
    normalizeWatchWord, describeMute, snoozeUntil, isMuteActive,
    MAX_WATCH_WORDS, LEVELS, LEVEL_LABEL_KEY, LEVEL_DESCRIPTION_KEY, SNOOZE_OPTIONS,
    type NotificationLevel, type ChannelPref, type ApiFetch,
  } from './notifications/notification-prefs-client.ts';

  const log = createLogger('NotificationPrefsPanel');
  function levelLabel(level: NotificationLevel): string { return t(LEVEL_LABEL_KEY[level]); }
  function levelDescription(level: NotificationLevel): string { return t(LEVEL_DESCRIPTION_KEY[level]); }


  interface ChannelSummary { _id?: string; name?: string; type?: string }

  let isVisible   = $state(false);
  let isLoading   = $state(false);
  let error       = $state('');
  let statusText  = $state('');
  let serverLevel = $state<NotificationLevel>('default');
  let serverMuteUntil = $state<number | null>(null);
  let prefs       = $state<Map<string, ChannelPref>>(new Map());
  let channels    = $state<ChannelSummary[]>([]);
  let serverName  = $state('');
  let serverId    = $state('');
  let watchWords  = $state<string[]>([]);
  let watchInput  = $state('');
  let watchError  = $state('');
  /** Kaydedilirken tekrar tiklanmayi engeller ve satirda geri bildirim verir. */
  let busyKey     = $state('');

  function api(): ApiFetch | null {
    return BridgeRegistry.get<ApiFetch>('apiFetch') ?? null;
  }

  /** Metin kanallari — ses kanalinda "mesaj bildirimi" kavrami yoktur. */
  let textChannels = $derived(channels.filter(c => (c.type ?? 'text') === 'text' && c._id));

  function prefOf(channelId: string): ChannelPref {
    return prefs.get(channelId) ?? { channelId, level: 'default', muteUntil: null };
  }

  async function load(): Promise<void> {
    const fetcher = api();
    const server = BridgeRegistry.call<{ _id?: string; name?: string } | null>('getCurrentServer');
    serverId = String(server?._id ?? '');
    serverName = String(server?.name ?? '');

    if (!serverId) {
      // Sunucu yokken sessizce bos bir panel gostermek "ayar yok" gibi
      // gorunurdu; gercek neden budur.
      error = t("ui_bildirim_ayarlari_icin_once_bir_sunucu_secin", "Bildirim ayarları için önce bir sunucu seçin.");
      return;
    }
    if (!fetcher) { error = t("ui_bildirim_ayarlari_su_anda_yuklenemiyor", "Bildirim ayarları şu anda yüklenemiyor."); return; }

    isLoading = true;
    error = '';
    try {
      channels = BridgeRegistry.call<ChannelSummary[]>('getCurrentServerChannels') ?? [];
      const snapshot = await fetchPrefs(fetcher, serverId);
      serverLevel = snapshot.serverLevel;
      serverMuteUntil = snapshot.serverMuteUntil;
      prefs = new Map(snapshot.channels.map(p => [p.channelId, p]));
      watchWords = snapshot.watchWords;
    } catch (err) {
      log.error('Bildirim tercihleri yüklenemedi', err);
      error = t("ui_bildirim_ayarlari_yuklenemedi", "Bildirim ayarları yüklenemedi.");
    } finally {
      isLoading = false;
    }
  }

  async function setServerLevel(
    level: NotificationLevel, muteUntil: number | null = null,
  ): Promise<void> {
    const fetcher = api();
    if (!fetcher || busyKey) return;
    const previous = serverLevel;
    const previousMuteUntil = serverMuteUntil;
    busyKey = 'server';
    serverLevel = level;
    serverMuteUntil = level === 'mute' ? muteUntil : null;
    try {
      await saveServerLevel(fetcher, serverId, level, serverMuteUntil);
      statusText = t('notification_server_level', 'Sunucu bildirimi: {level}', { level: levelLabel(level) });
      error = '';
    } catch (err) {
      // GERI ALINIR: kaydedilmemis bir ayari kaydedilmis gostermek,
      // kullanicinin beklemedigi bildirimler (ya da kacirilan mesajlar)
      // olarak geri doner.
      serverLevel = previous;
      serverMuteUntil = previousMuteUntil;
      error = t("ui_ayar_kaydedilemedi", "Ayar kaydedilemedi.");
      log.error('Sunucu bildirim seviyesi kaydedilemedi', err);
    } finally {
      busyKey = '';
    }
  }

  async function setChannelLevel(
    channelId: string, level: NotificationLevel, muteUntil: number | null = null,
  ): Promise<void> {
    const fetcher = api();
    if (!fetcher || busyKey) return;
    const previous = prefs.get(channelId);
    busyKey = channelId;
    prefs = new Map(prefs).set(channelId, { channelId, level, muteUntil });
    try {
      await saveChannelLevel(fetcher, channelId, level, muteUntil);
      statusText = `${nameOf(channelId)}: ${levelLabel(level)}`;
      error = '';
    } catch (err) {
      const restored = new Map(prefs);
      if (previous) restored.set(channelId, previous); else restored.delete(channelId);
      prefs = restored;
      error = t("ui_ayar_kaydedilemedi", "Ayar kaydedilemedi.");
      log.error('Kanal bildirim seviyesi kaydedilemedi', err);
    } finally {
      busyKey = '';
    }
  }

  async function reset(channelId: string): Promise<void> {
    const fetcher = api();
    if (!fetcher || busyKey) return;
    const previous = prefs.get(channelId);
    busyKey = channelId;
    const next = new Map(prefs);
    next.delete(channelId);
    prefs = next;
    try {
      await resetChannel(fetcher, channelId);
      statusText = t('npp_reset_named', '{name}: sunucu varsayılanına döndü', { name: nameOf(channelId) });
      error = '';
    } catch (err) {
      if (previous) prefs = new Map(prefs).set(channelId, previous);
      error = t("ui_ayar_sifirlanamadi", "Ayar sıfırlanamadı.");
      log.error('Kanal tercihi sıfırlanamadı', err);
    } finally {
      busyKey = '';
    }
  }

  async function persistWatchWords(next: string[]): Promise<void> {
    const fetcher = api();
    if (!fetcher || busyKey) return;
    const previous = watchWords;
    busyKey = 'watch-words';
    watchWords = next;
    watchError = '';
    try {
      watchWords = await saveWatchWords(fetcher, serverId, next);
      statusText = watchWords.length
        ? t('watch_words_saved_count', undefined, { count: watchWords.length })
        : t("ui_takip_kelimeleri_temizlendi", "Takip kelimeleri temizlendi.");
      error = '';
    } catch (err) {
      watchWords = previous;
      watchError = t("ui_takip_kelimeleri_kaydedilemedi", "Takip kelimeleri kaydedilemedi.");
      log.error('Takip kelimeleri kaydedilemedi', err);
    } finally {
      busyKey = '';
    }
  }

  function addWatchWord(): void {
    if (busyKey) return;
    const word = normalizeWatchWord(watchInput);
    if (!word) {
      watchError = t("ui_2_32_karakterlik_tek_bir_kelime_kullanin_harf_sayi_v", "2–32 karakterlik tek bir kelime kullanın. Harf, sayı, _ ve - desteklenir.");
      return;
    }
    if (watchWords.includes(word)) {
      watchError = t("ui_bu_kelime_zaten_takip_ediliyor", "Bu kelime zaten takip ediliyor.");
      return;
    }
    if (watchWords.length >= MAX_WATCH_WORDS) {
      watchError = `En fazla ${MAX_WATCH_WORDS} kelime takip edilebilir.`;
      return;
    }
    watchInput = '';
    void persistWatchWords([...watchWords, word]);
  }

  function removeWatchWord(word: string): void {
    if (busyKey) return;
    void persistWatchWords(watchWords.filter(item => item !== word));
  }

  function onWatchKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    addWatchWord();
  }

  function nameOf(channelId: string): string {
    return textChannels.find(c => c._id === channelId)?.name ?? t("ui_kanal", "Kanal");
  }

  function open(): void { isVisible = true; statusText = ''; void load(); }
  function close(): void { isVisible = false; error = ''; watchError = ''; watchInput = ''; statusText = ''; }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
  }

  onMount(() => {
    BridgeRegistry.register('showNotificationPrefsPanel', open);
    BridgeRegistry.register('openNotificationPrefs', open);
    BridgeRegistry.register('hideNotificationPrefsPanel', close);
    log.info('Bildirim tercihleri hazır');
  });

  onDestroy(() => {
    for (const key of ['showNotificationPrefsPanel', 'openNotificationPrefs', 'hideNotificationPrefsPanel']) {
      BridgeRegistry.unregister?.(key);
    }
  });
</script>

{#if isVisible}
<!-- svelte-ignore a11y_click_events_have_key_events -->
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div class="np-overlay" role="presentation" onclick={close}>
  <div
    class="np-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby="np-title"
    tabindex="-1"
    onclick={(e) => e.stopPropagation()}
    onkeydown={onKeyDown}
    use:focusTrap={{ active: isVisible, initialFocus: '.np-close' }}
  >
    <header class="np-header">
      <div>
        <span class="np-eyebrow">{t('notifications')}</span>
        <h2 id="np-title">{serverName || t("surface_bildirim_ayarlar_fead6c")}</h2>
      </div>
      <button type="button" class="np-close" onclick={close} aria-label={t('npp_close', 'Bildirim ayarlarını kapat')}>✕</button>
    </header>

    <p class="np-sr-only" role="status" aria-live="polite">{statusText}</p>

    <div class="np-body" aria-busy={isLoading}>
      {#if error}
        <p class="np-error" role="alert">{error}</p>
      {/if}

      {#if isLoading}
        <p class="np-muted">{t('sso_loading', 'Yükleniyor…')}</p>
      {:else if serverId}
        <section class="np-section" aria-labelledby="np-server-title">
          <h3 id="np-server-title">{t('npp_server_default', 'Sunucu varsayılanı')}</h3>
          <p class="np-muted">{t('npp_default_hint', 'Kanal için ayrı bir seçim yapmadıysanız bu geçerlidir.')}</p>
          <div class="np-levels" role="radiogroup" aria-labelledby="np-server-title">
            {#each LEVELS as level (level)}
              <button
                type="button"
                class="np-level"
                class:active={serverLevel === level}
                role="radio"
                aria-checked={serverLevel === level}
                disabled={busyKey !== ''}
                onclick={() => void setServerLevel(level)}
              >
                <strong>{levelLabel(level)}</strong>
                <small>{levelDescription(level)}</small>
              </button>
            {/each}
          </div>
          {#if serverLevel === 'mute'}
            {@const serverPref = { channelId: `server:${serverId}`, level: serverLevel, muteUntil: serverMuteUntil }}
            <div class="np-snooze np-server-snooze">
              <span class="np-snooze-state">
                {isMuteActive(serverPref) ? describeMute(serverPref) : t("surface_erteleme_suresi_doldu_121782")}
              </span>
              <div class="np-snooze-options">
                {#each SNOOZE_OPTIONS as option (option.id)}
                  <button
                    type="button" class="np-snooze-btn"
                    disabled={busyKey !== ''}
                    onclick={() => void setServerLevel('mute', snoozeUntil(option))}
                  >{t(option.labelKey)}</button>
                {/each}
              </div>
            </div>
          {/if}
        </section>

        <section class="np-section np-watch-section" aria-labelledby="np-watch-title">
          <div class="np-watch-heading">
            <div>
              <h3 id="np-watch-title">{t('markup_takip_edilen_kelimeler_e01de83', "Takip edilen kelimeler")}</h3>
              <p class="np-muted">{t('markup_mention_edilmeseniz_de_bu_sunucudaki_secili_keli_c89d211', "Mention edilmeseniz de bu sunucudaki seçili kelimeler geçtiğinde bildirim alın. Sessize alınmış kanal veya sunucu yine bildirim üretmez.")}</p>
            </div>
            <span class="np-watch-count" aria-label={t('watch_words_count_aria', undefined, { current: watchWords.length, max: MAX_WATCH_WORDS })}>{watchWords.length}/{MAX_WATCH_WORDS}</span>
          </div>

          <div class="np-watch-entry">
            <input
              type="text"
              maxlength="32"
              autocomplete="off"
              spellcheck="false"
              placeholder={t("watch_words_example")}
              aria-label={t('attr_takip_edilecek_kelime_e9d3ae1', "Takip edilecek kelime")}
              aria-describedby="np-watch-help"
              bind:value={watchInput}
              onkeydown={onWatchKeyDown}
              disabled={busyKey !== '' || watchWords.length >= MAX_WATCH_WORDS}
            />
            <button
              type="button"
              class="np-watch-add"
              onclick={addWatchWord}
              disabled={busyKey !== '' || !watchInput.trim() || watchWords.length >= MAX_WATCH_WORDS}
            >{t('markup_ekle_eeeb1da', "Ekle")}</button>
          </div>
          <p id="np-watch-help" class="np-watch-help">{t("watch_words_exact_hint")}</p>
          {#if watchError}
            <p class="np-watch-error" role="alert">{watchError}</p>
          {/if}
          {#if watchWords.length}
            <div class="np-watch-chips" aria-label={t('markup_takip_edilen_kelimeler_e01de83', "Takip edilen kelimeler")}>
              {#each watchWords as word (word)}
                <span class="np-watch-chip">
                  <span>{word}</span>
                  <button
                    type="button"
                    aria-label={t('watchword_remove_aria', undefined, { word })}
                    disabled={busyKey !== ''}
                    onclick={() => removeWatchWord(word)}
                  >×</button>
                </span>
              {/each}
            </div>
          {:else}
            <p class="np-muted np-watch-empty">{t("watch_words_empty")}</p>
          {/if}
        </section>

        <section class="np-section" aria-labelledby="np-channels-title">
          <h3 id="np-channels-title">{t('npp_channel_settings', 'Kanal ayarları')}</h3>
          {#if !textChannels.length}
            <p class="np-muted">{t('npp_no_channels', 'Bu sunucuda ayarlanabilir metin kanalı yok.')}</p>
          {:else}
            <ul class="np-channels">
              {#each textChannels as channel (channel._id)}
                {@const pref = prefOf(channel._id!)}
                {@const overridden = pref.level !== 'default'}
                <li class="np-channel" class:busy={busyKey === channel._id}>
                  <div class="np-channel-head">
                    <span class="np-channel-name">#{channel.name ?? t("ui_channel_fallback")}</span>
                    {#if overridden}
                      <span class="np-tag">{levelLabel(pref.level)}</span>
                      <button
                        type="button" class="np-reset"
                        disabled={busyKey !== ''}
                        onclick={() => void reset(channel._id!)}
                      >{t('npp_reset', 'Varsayılana dön')}</button>
                    {/if}
                  </div>

                  <div class="np-levels np-levels-compact" role="radiogroup" aria-label={t("notif_channel_level_label", undefined, { channel: channel.name ?? t("ui_channel_fallback") })}>
                    {#each LEVELS as level (level)}
                      <button
                        type="button"
                        class="np-level np-level-compact"
                        class:active={pref.level === level}
                        role="radio"
                        aria-checked={pref.level === level}
                        disabled={busyKey !== ''}
                        onclick={() => void setChannelLevel(channel._id!, level)}
                      >{levelLabel(level)}</button>
                    {/each}
                  </div>

                  {#if pref.level === 'mute'}
                    <div class="np-snooze">
                      <span class="np-snooze-state">
                        {isMuteActive(pref) ? describeMute(pref) : t("surface_erteleme_suresi_doldu_121782")}
                      </span>
                      <div class="np-snooze-options">
                        {#each SNOOZE_OPTIONS as option (option.id)}
                          <button
                            type="button" class="np-snooze-btn"
                            disabled={busyKey !== ''}
                            onclick={() => void setChannelLevel(channel._id!, 'mute', snoozeUntil(option))}
                          >{t(option.labelKey)}</button>
                        {/each}
                      </div>
                    </div>
                  {/if}
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      {/if}
    </div>
  </div>
</div>
{/if}

<style>
.np-overlay {
  position: fixed;
  inset: 0;
  z-index: var(--layer-modal);
  display: flex;
  justify-content: center;
  padding: clamp(32px, 7vh, 72px) 16px 24px;
  background: color-mix(in srgb, var(--bg-0) 82%, transparent);
  backdrop-filter: blur(8px) saturate(110%);
}

.np-panel {
  display: flex;
  flex-direction: column;
  width: min(620px, 100%);
  max-height: min(660px, calc(var(--bridge-visual-viewport-height, 100dvh) - 96px));
  overflow: hidden;
  color: var(--text-primary);
  background: var(--bg-2);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-modal);
  box-shadow: var(--shadow-xl);
}

.np-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 16px 18px 12px;
  border-bottom: 1px solid var(--border-faint);
}
.np-eyebrow {
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: .06em;
  color: var(--text-muted);
  text-transform: uppercase;
}
.np-header h2 { margin: 2px 0 0; font-size: var(--text-lg); }
.np-close {
  padding: 4px 9px;
  font-size: var(--text-base);
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: 0;
}
.np-close:hover { color: var(--text-primary); }

.np-body { flex: 1; padding: 4px 18px 18px; overflow-y: auto; }
.np-section { margin-top: 18px; }
.np-section h3 { margin: 0 0 2px; font-size: var(--text-base); }
.np-muted { margin: 0 0 10px; font-size: var(--text-sm); color: var(--text-muted); }
.np-error {
  padding: 9px 12px;
  margin: 12px 0 0;
  font-size: var(--text-sm);
  color: var(--danger-text, var(--danger));
  background: var(--danger-bg, var(--bg-3));
  border-radius: var(--radius-sm);
}

.np-levels { display: grid; grid-template-columns: repeat(auto-fit, minmax(160px, 1fr)); gap: 8px; }
.np-level {
  padding: 10px 12px;
  font: inherit;
  color: var(--text-primary);
  text-align: start;
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.np-level:hover:not(:disabled) { background: var(--bg-4); }
.np-level:disabled { cursor: default; opacity: .6; }
/* Secili durum RENKTEN BASKA isaret de tasir: kenarlik kalinlasir ve
   `aria-checked` ekran okuyucuya durumu soyler. */
.np-level.active { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
.np-level strong { display: block; font-size: var(--text-sm); }
.np-level small { display: block; margin-top: 2px; font-size: var(--text-2xs); color: var(--text-muted); }


.np-watch-heading { display: flex; gap: 12px; align-items: flex-start; justify-content: space-between; }
.np-watch-heading .np-muted { margin-bottom: 8px; }
.np-watch-count {
  flex: 0 0 auto;
  padding: 2px 7px;
  font-size: var(--text-2xs);
  color: var(--text-muted);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.np-watch-entry { display: flex; gap: 7px; }
.np-watch-entry input {
  min-width: 0;
  flex: 1;
  padding: 8px 10px;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  background: var(--bg-1);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.np-watch-entry input:focus-visible { border-color: var(--brand); outline: 2px solid color-mix(in srgb, var(--brand) 35%, transparent); outline-offset: 1px; }
.np-watch-add {
  min-height: 36px;
  padding: 7px 12px;
  font: inherit;
  font-size: var(--text-sm);
  font-weight: 600;
  color: var(--button-primary-text, white);
  cursor: pointer;
  background: var(--brand);
  border: 0;
  border-radius: var(--radius-sm);
}
.np-watch-add:disabled { cursor: default; opacity: .55; }
.np-watch-help { margin: 5px 0 0; font-size: var(--text-2xs); color: var(--text-muted); }
.np-watch-error { margin: 6px 0 0; font-size: var(--text-xs); color: var(--danger-text, var(--danger)); }
.np-watch-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 9px; }
.np-watch-chip {
  display: inline-flex;
  gap: 5px;
  align-items: center;
  max-width: 100%;
  padding: 4px 5px 4px 9px;
  font-size: var(--text-xs);
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.np-watch-chip > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.np-watch-chip button {
  display: grid;
  width: 24px;
  height: 24px;
  padding: 0;
  place-items: center;
  font: inherit;
  color: var(--text-muted);
  cursor: pointer;
  background: transparent;
  border: 0;
  border-radius: 50%;
}
.np-watch-chip button:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-4); }
.np-watch-empty { margin-top: 8px; }

.np-channels { padding: 0; margin: 0; list-style: none; }
.np-channel {
  padding: 11px 0;
  border-bottom: 1px solid var(--border-faint);
}
.np-channel.busy { opacity: .6; }
.np-channel-head { display: flex; gap: var(--space-2); align-items: center; margin-bottom: 7px; }
.np-channel-name { font-size: var(--text-sm); font-weight: 600; }
.np-tag {
  padding: 1px 7px;
  font-size: var(--text-2xs);
  color: var(--brand);
  background: var(--brand-bg-low, var(--brand-bg));
  border-radius: 999px;
}
.np-reset {
  margin-inline-start: auto;
  font: inherit;
  font-size: var(--text-2xs);
  color: var(--text-muted);
  cursor: pointer;
  background: none;
  border: 0;
  text-decoration: underline;
}
.np-reset:hover:not(:disabled) { color: var(--text-primary); }

.np-levels-compact { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 6px; }
.np-level-compact { padding: 6px 9px; font-size: var(--text-xs); text-align: center; }

.np-snooze { margin-top: 8px; }
.np-snooze-state { font-size: var(--text-2xs); color: var(--text-muted); }
.np-snooze-options { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 5px; }
.np-snooze-btn {
  padding: 4px 9px;
  font: inherit;
  font-size: var(--text-2xs);
  color: var(--text-secondary);
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.np-snooze-btn:hover:not(:disabled) { color: var(--text-primary); background: var(--bg-4); }
.np-snooze-btn:disabled { cursor: default; opacity: .6; }

.np-sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
}

@media (max-width: 600px) {
  .np-overlay { align-items: flex-end; padding: 0; }
  .np-panel {
    width: 100%;
    max-height: min(var(--bridge-visual-viewport-height, 100dvh), 100dvh);
    border-right: 0;
    border-bottom: 0;
    border-left: 0;
    border-radius: var(--radius-modal) var(--radius-modal) 0 0;
  }
  .np-header { padding-top: max(14px, env(safe-area-inset-top)); }
  .np-body { padding-bottom: max(18px, env(safe-area-inset-bottom)); }
  .np-watch-entry input, .np-watch-add { min-height: 44px; }
  .np-watch-chip button { width: 32px; height: 32px; }
}

</style>
