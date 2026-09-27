<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte';
  import { t, localeTag} from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.ts';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { createLogger } from './logger.ts';
  import { promptProductText } from './product-dialog.ts';

  const log = createLogger('SavedPanel');
  type DestinationType = 'channel' | 'dm' | 'gdm';

  interface SavedUser {
    _id: string;
    displayName?: string;
    username?: string;
    avatarColor?: string;
  }
  interface SavedItem {
    id: string;
    savedAt: number;
    unavailable: boolean;
    remindAt?: number | null;
    remindedAt?: number | null;
    preview?: string;
    sender?: SavedUser;
    destination?: {
      type: DestinationType;
      messageId: string;
      channelId?: string;
      serverId?: string;
      dmId?: string;
      groupId?: string;
      channel?: { _id: string; name: string; type?: string };
      server?: { _id: string; name?: string; iconUrl?: string | null };
      user?: SavedUser;
      group?: { _id: string; name: string; icon?: string | null; ownerId?: string };
    };
  }
  interface SaveTarget {
    destinationType: DestinationType;
    destinationId: string;
    messageId: string;
  }

  let visible = $state(false);
  let loading = $state(false);
  let error = $state('');
  let removeError = $state('');
  let items = $state<SavedItem[]>([]);
  let requestSeq = 0;
  let contextSeq = 0;
  let focusSeq = 0;
  let destroyed = false;
  let restoreFocusOnClose = $state(true);
  let returnFocus: HTMLElement | null = null;

  const apiBase = (): string => (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;
  const apiFetch = (url: string, options?: RequestInit): Promise<Response> => {
    const fn = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
    if (!fn) return Promise.reject(new Error(t("ui_guvenli_api_istemcisi_kullanilamiyor", "Güvenli API istemcisi kullanılamıyor.")));
    return fn(url, options);
  };

  function recordOf(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' ? value as Record<string, unknown> : null;
  }

  function stringField(value: unknown, key: string): string {
    const field = recordOf(value)?.[key];
    return typeof field === 'string' && field.trim() ? field : '';
  }

  function sanitizeUser(value: unknown, requireId = false): SavedUser | undefined {
    const raw = recordOf(value);
    if (!raw) return undefined;
    const id = stringField(raw, '_id');
    if (requireId && !id) return undefined;
    const displayName = stringField(raw, 'displayName');
    const username = stringField(raw, 'username');
    if (!id && !displayName && !username) return undefined;
    return {
      _id: id,
      displayName: displayName || undefined,
      username: username || undefined,
      avatarColor: stringField(raw, 'avatarColor') || undefined,
    };
  }

  function sanitizeDestination(value: unknown): SavedItem['destination'] | undefined {
    const raw = recordOf(value);
    const type = stringField(raw, 'type');
    const messageId = stringField(raw, 'messageId');
    if (!raw || !messageId || !['channel', 'dm', 'gdm'].includes(type)) return undefined;

    if (type === 'channel') {
      const channelId = stringField(raw, 'channelId');
      if (!channelId) return undefined;
      const rawChannel = recordOf(raw.channel);
      const rawServer = recordOf(raw.server);
      const channelObjectId = stringField(rawChannel, '_id');
      const serverObjectId = stringField(rawServer, '_id');
      return {
        type,
        messageId,
        channelId,
        serverId: stringField(raw, 'serverId') || undefined,
        channel: channelObjectId ? {
          _id: channelObjectId,
          name: stringField(rawChannel, 'name') || t('ui_channel_fallback', 'kanal'),
          type: stringField(rawChannel, 'type') || undefined,
        } : undefined,
        server: serverObjectId ? {
          _id: serverObjectId,
          name: stringField(rawServer, 'name') || undefined,
        } : undefined,
      };
    }

    if (type === 'dm') {
      const user = sanitizeUser(raw.user, true);
      if (!user) return undefined;
      return { type, messageId, dmId: stringField(raw, 'dmId') || undefined, user };
    }

    const rawGroup = recordOf(raw.group);
    const groupId = stringField(rawGroup, '_id');
    if (!rawGroup || !groupId) return undefined;
    return {
      type: 'gdm',
      messageId,
      groupId: stringField(raw, 'groupId') || groupId,
      group: {
        _id: groupId,
        name: stringField(rawGroup, 'name') || 'Grup DM',
        // Saved payloads are not an image trust boundary. The canonical GDM
        // owner can resolve the current icon by id; never forward a stale URL.
        icon: null,
        ownerId: stringField(rawGroup, 'ownerId') || undefined,
      },
    };
  }

  function sanitizeItems(value: unknown): SavedItem[] | null {
    if (!Array.isArray(value)) return null;
    const seen = new Set<string>();
    const result: SavedItem[] = [];
    for (const candidate of value) {
      const raw = recordOf(candidate);
      const id = stringField(raw, 'id');
      if (!raw || !id || seen.has(id)) continue;
      seen.add(id);
      const destination = sanitizeDestination(raw.destination);
      result.push({
        id,
        savedAt: typeof raw.savedAt === 'number' && Number.isFinite(raw.savedAt) && raw.savedAt > 0 ? raw.savedAt : 0,
        unavailable: raw.unavailable === true || !destination,
        remindAt: typeof raw.remindAt === 'number' && Number.isSafeInteger(raw.remindAt) && raw.remindAt > 0 ? raw.remindAt : null,
        remindedAt: typeof raw.remindedAt === 'number' && Number.isSafeInteger(raw.remindedAt) && raw.remindedAt > 0 ? raw.remindedAt : null,
        preview: stringField(raw, 'preview') || undefined,
        sender: sanitizeUser(raw.sender),
        destination,
      });
    }
    return result;
  }

  function showActionError(): void {
    BridgeRegistry.call('toast', t("ui_islem_tamamlanamadi_lutfen_tekrar_deneyin", "İşlem tamamlanamadı. Lütfen tekrar deneyin."), 'error');
  }

  function displayName(user?: SavedUser): string {
    return user?.displayName || user?.username || 'Bridge user';
  }

  function destinationLabel(item: SavedItem): string {
    const destination = item.destination;
    if (!destination) return '';
    if (destination.type === 'channel') {
      return `${destination.server?.name || 'Bridge'} · #${destination.channel?.name || t('ui_channel_fallback', 'kanal')}`;
    }
    if (destination.type === 'gdm') return destination.group?.name || 'Grup DM';
    return displayName(destination.user);
  }

  function savedTime(value: number): string {
    if (!value) return '';
    const delta = Math.max(0, Date.now() - value);
    if (delta < 60_000) return t("ui_simdi_kaydedildi", "şimdi kaydedildi");
    if (delta < 3_600_000) return t('rel_minutes_ago', '{count} dk önce', { count: Math.floor(delta / 60_000) });
    if (delta < 86_400_000) return t('rel_hours_ago', '{count} sa önce', { count: Math.floor(delta / 3_600_000) });
    return new Date(value).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function reminderLabel(item: SavedItem): string {
    if (!item.remindAt) return t("ui_hatirlat", "Hatırlat");
    if (item.remindedAt) return t('saved_reminded_at', 'Hatırlatıldı · {date}', { date: new Date(item.remindedAt).toLocaleString(localeTag()) });
    return `⏰ ${new Date(item.remindAt).toLocaleString()}`;
  }

  function parseReminderInput(value: string): number | null {
    const input = value.trim().toLowerCase();
    const relative = input.match(/^(\d+)(m|h|d)$/);
    const now = Date.now();
    if (relative) {
      const amount = Number(relative[1]);
      const unit = relative[2];
      const ms = unit === 'm' ? amount * 60_000 : unit === 'h' ? amount * 3_600_000 : amount * 86_400_000;
      const at = now + ms;
      return Number.isSafeInteger(at) && at >= now + 5_000 && at <= now + 30 * 86_400_000 ? at : null;
    }
    const parsed = Date.parse(input.replace(' ', 'T'));
    return Number.isFinite(parsed) && parsed >= now + 5_000 && parsed <= now + 30 * 86_400_000 ? parsed : null;
  }

  async function setReminder(item: SavedItem): Promise<void> {
    if (item.unavailable) { BridgeRegistry.call('toast', t("ui_artik_erisilemeyen_bir_mesaj_icin_yeni_hatirlatici_k", "Artık erişilemeyen bir mesaj için yeni hatırlatıcı kurulamaz."), 'warning'); return; }
    const value = await promptProductText({
      title: t("ui_hatirlatici_kur", "Hatırlatıcı kur"),
      message: t("ui_ornek_30m_2h_3d_veya_2026_09_05_14_30_en_fazla_30_gu", "Örnek: 30m, 2h, 3d veya 2026-09-05 14:30. En fazla 30 gün."),
      initialValue: '', placeholder: '2h', maxLength: 32,
      confirmLabel: t('saved_reminder_set', 'Kur'), cancelLabel: t('cancel', 'İptal'),
    });
    if (value === null) return;
    const remindAt = parseReminderInput(value);
    if (!remindAt) { BridgeRegistry.call('toast', t("ui_gecerli_ve_gelecekte_bir_zaman_girin_en_fazla_30_gun", "Geçerli ve gelecekte bir zaman girin (en fazla 30 gün)."), 'error'); return; }
    try {
      const response = await apiFetch(`${apiBase()}/api/saved/${encodeURIComponent(item.id)}/reminder`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remindAt }),
      });
      if (!response.ok) { BridgeRegistry.call('toast', t("ui_hatirlatici_kurulamadi", "Hatırlatıcı kurulamadı."), 'error'); return; }
      items = items.map(row => row.id === item.id ? { ...row, remindAt, remindedAt: null } : row);
      BridgeRegistry.call('toast', t("ui_hatirlatici_kuruldu", "Hatırlatıcı kuruldu."), 'success');
    } catch { BridgeRegistry.call('toast', t("ui_hatirlatici_kurulamadi_baglantini_kontrol_et", "Hatırlatıcı kurulamadı. Bağlantını kontrol et."), 'error'); }
  }

  async function clearReminder(item: SavedItem): Promise<void> {
    try {
      const response = await apiFetch(`${apiBase()}/api/saved/${encodeURIComponent(item.id)}/reminder`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ remindAt: null }),
      });
      if (!response.ok) { BridgeRegistry.call('toast', t("ui_hatirlatici_kaldirilamadi", "Hatırlatıcı kaldırılamadı."), 'error'); return; }
      items = items.map(row => row.id === item.id ? { ...row, remindAt: null, remindedAt: null } : row);
    } catch { BridgeRegistry.call('toast', t("ui_hatirlatici_kaldirilamadi", "Hatırlatıcı kaldırılamadı."), 'error'); }
  }

  async function load(): Promise<void> {
    if (destroyed) return;
    const seq = ++requestSeq;
    const context = contextSeq;
    loading = true;
    error = '';
    removeError = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/saved`);
      if (seq !== requestSeq || context !== contextSeq || destroyed) return;
      if (!response.ok) throw new Error('request-failed');
      const data = recordOf(await response.json());
      const nextItems = sanitizeItems(data?.items);
      if (seq !== requestSeq || context !== contextSeq || destroyed) return;
      if (!data || !nextItems) throw new Error('malformed-response');
      items = nextItems;
    } catch {
      if (seq !== requestSeq || context !== contextSeq || destroyed) return;
      error = t("ui_kaydedilenler_yuklenemedi_lutfen_tekrar_deneyin", "Kaydedilenler yüklenemedi. Lütfen tekrar deneyin.");
    } finally {
      if (seq === requestSeq && context === contextSeq && !destroyed) loading = false;
    }
  }

  function open(): void {
    if (destroyed) return;
    closeExclusivePeers('saved');
    returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    restoreFocusOnClose = true;
    visible = true;
    void load();
  }

  function close(restoreFocus: boolean | Event = true): void {
    const shouldRestoreFocus = typeof restoreFocus === 'boolean' ? restoreFocus : true;
    restoreFocusOnClose = shouldRestoreFocus;
    requestSeq += 1;
    loading = false;
    visible = false;
    const target = returnFocus;
    returnFocus = null;
    const seq = ++focusSeq;
    if (!shouldRestoreFocus) return;
    queueMicrotask(() => seq === focusSeq && target?.isConnected && target.focus());
  }

  async function saveForLater(target: SaveTarget): Promise<boolean> {
    const raw = recordOf(target);
    const destinationType = stringField(raw, 'destinationType');
    const destinationId = stringField(raw, 'destinationId');
    const messageId = stringField(raw, 'messageId');
    if (destroyed || !['channel', 'dm', 'gdm'].includes(destinationType) || !destinationId || !messageId) return false;
    const context = contextSeq;
    try {
      const response = await apiFetch(`${apiBase()}/api/saved`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destinationType, destinationId, messageId }),
      });
      if (context !== contextSeq || destroyed) return false;
      if (!response.ok) throw new Error('request-failed');
      const data = recordOf(await response.json());
      if (context !== contextSeq || destroyed) return false;
      if (!data) throw new Error('malformed-response');
      BridgeRegistry.call('toast', data.created === false ? t("ui_bu_mesaj_zaten_saved_listende", "Bu mesaj zaten Saved listende.") : t("ui_mesaj_saved_listene_eklendi", "Mesaj Saved listene eklendi."), 'success');
      if (visible) void load();
      return true;
    } catch {
      if (context !== contextSeq || destroyed) return false;
      BridgeRegistry.call('toast', t("ui_mesaj_kaydedilemedi_lutfen_tekrar_deneyin", "Mesaj kaydedilemedi. Lütfen tekrar deneyin."), 'error');
      return false;
    }
  }

  async function remove(item: SavedItem): Promise<void> {
    const itemId = stringField(item, 'id');
    if (!itemId || destroyed) return;
    const context = contextSeq;
    try {
      const response = await apiFetch(`${apiBase()}/api/saved/${encodeURIComponent(itemId)}`, { method: 'DELETE' });
      if (context !== contextSeq || destroyed) return;
      if (!response.ok) { removeError = t("ui_kayit_kaldirilamadi_lutfen_tekrar_deneyin", "Kayıt kaldırılamadı. Lütfen tekrar deneyin."); return; }
      removeError = '';
      items = items.filter(candidate => candidate.id !== itemId);
    } catch {
      if (context !== contextSeq || destroyed) return;
      removeError = t("ui_kayit_kaldirilamadi_lutfen_tekrar_deneyin", "Kayıt kaldırılamadı. Lütfen tekrar deneyin.");
    }
  }

  async function openItem(item: SavedItem): Promise<void> {
    if (item.unavailable || !item.destination) return;
    const destination = item.destination;
    let owner = '';
    if (destination.type === 'channel' && destination.channelId) owner = 'navigateToChannel';
    else if (destination.type === 'dm' && destination.user?._id) owner = 'openDm';
    else if (destination.type === 'gdm' && destination.group) owner = 'groupDmPanel:openGroupDm';
    if (!owner || !BridgeRegistry.has(owner)) {
      BridgeRegistry.call('toast', t("ui_bu_konusma_su_anda_acilamiyor", "Bu konuşma şu anda açılamıyor."), 'warning');
      return;
    }
    const context = contextSeq;
    close(false);
    await tick();
    if (context !== contextSeq || destroyed) return;
    try {
      let result: unknown;
      if (destination.type === 'channel' && destination.channelId) {
        result = BridgeRegistry.call('navigateToChannel', destination.channelId, destination.messageId, destination.server);
      } else if (destination.type === 'dm' && destination.user?._id) {
        const user = destination.user;
        result = BridgeRegistry.call('openDm', user._id, displayName(user), user.avatarColor, destination.messageId);
      } else if (destination.type === 'gdm' && destination.group) {
        result = BridgeRegistry.call('groupDmPanel:openGroupDm', destination.group, destination.messageId);
      }
      if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
        void Promise.resolve(result).catch(() => showActionError());
      }
    } catch {
      showActionError();
    }
  }

  function onListKeyDown(event: KeyboardEvent): void {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
    const list = event.currentTarget as HTMLElement;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>('[data-saved-item]:not(:disabled)')];
    if (!buttons.length) return;
    const current = document.activeElement instanceof HTMLElement
      ? buttons.indexOf(document.activeElement as HTMLButtonElement)
      : -1;
    let next = current;
    if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = buttons.length - 1;
    else if (event.key === 'ArrowDown') next = Math.min(buttons.length - 1, current + 1);
    else next = Math.max(0, current < 0 ? buttons.length - 1 : current - 1);
    event.preventDefault();
    buttons[next]?.focus();
  }

  function onPanelKeyDown(event: KeyboardEvent): void {
    // Final21 UX: olay burada durduruluyordu; pencere düzeyindeki Esc işleyicisi (onKeyDown)
    // hiç çalışmadı ve panel içinde odak varken Esc paneli KAPATMIYORDU (Inbox ile aynı kusur).
    if (event.key === 'Escape' && visible) { event.preventDefault(); event.stopPropagation(); close(); return; }
    event.stopPropagation();
    const target = event.target;
    if (target instanceof Element && target.closest('.saved-list')) onListKeyDown(event);
  }

  function onKeyDown(event: KeyboardEvent): void {
    if (visible && event.key === 'Escape') close();
  }

  function onLogout(): void {
    requestSeq += 1;
    contextSeq += 1;
    focusSeq += 1;
    restoreFocusOnClose = false;
    visible = false;
    loading = false;
    items = [];
    error = '';
    removeError = '';
    returnFocus = null;
  }

  onMount(() => {
    BridgeRegistry.register('showSaved', open);
    BridgeRegistry.register('openSaved', open);
    BridgeRegistry.register('closeSaved', close);
    BridgeRegistry.register('saveForLater', (target: SaveTarget) => saveForLater(target));
    window.addEventListener('keydown', onKeyDown);
    document.addEventListener('bridge:auth-logout', onLogout);
  });

  onDestroy(() => {
    destroyed = true;
    requestSeq += 1;
    contextSeq += 1;
    focusSeq += 1;
    restoreFocusOnClose = false;
    returnFocus = null;
    window.removeEventListener('keydown', onKeyDown);
    document.removeEventListener('bridge:auth-logout', onLogout);
    for (const key of ['showSaved', 'openSaved', 'closeSaved', 'saveForLater']) BridgeRegistry.unregister(key);
    log.info('SavedPanel destroyed');
  });
</script>

{#if visible}
  <div class="saved-backdrop" role="presentation" onclick={close}>
    <div
      class="saved-panel"
      role="dialog"
      aria-modal="true"
      aria-label={t('saved_title')}
      tabindex="-1"
      use:focusTrap={{ active: visible, initialFocus: '.saved-close', returnFocus: restoreFocusOnClose }}
      onclick={(event) => event.stopPropagation()}
      onkeydown={onPanelKeyDown}
    >
      <header class="saved-header">
        <div><span class="eyebrow">{t('saved_eyebrow', 'SONRA BAK')}</span><h2>{t('saved_title', 'Kaydedilenler')}</h2><p>{t('saved_subtitle', 'Unutmak istemediğin mesajlar.')}</p></div>
        <button type="button" class="saved-close" aria-label={t('saved_close', 'Kaydedilenler panelini kapat')} onclick={close}>×</button>
      </header>

      {#if loading}
        <div class="saved-state" role="status"><strong>{t('saved_loading', 'Kaydedilenler yükleniyor')}</strong><span>{t('saved_loading_sub', 'Kişisel listen hazırlanıyor…')}</span></div>
      {:else if error}
        <div class="saved-state error" role="alert"><strong>{t('saved_load_failed', 'Kaydedilenler yüklenemedi')}</strong><span>{error}</span><button type="button" onclick={() => void load()}>{t('retry', 'Yeniden dene')}</button></div>
      {:else if items.length === 0}
        <div class="saved-state"><strong>{t('saved_empty', 'Henüz kayıt yok')}</strong><span>{t('saved_empty_sub', 'Bir mesajdaki “Sonra Bak” eylemini kullan.')}</span></div>
      {:else}
        {#if removeError}<div class="saved-remove-error" role="alert">{removeError}</div>{/if}
        <ul class="saved-list" aria-label={t('saved_list_label', 'Kaydedilen mesajlar')}>
          {#each items as item (item.id)}
            <li class="saved-item" class:unavailable={item.unavailable}>
              {#if item.unavailable}
                <div class="saved-main unavailable-copy" aria-label={t('sav_inaccessible', 'Artık erişilemeyen kaydedilmiş mesaj')}>
                  <strong>{t('sav_unavailable', 'Mesaj artık kullanılamıyor')}</strong>
                  <span>{t('sav_reason', 'Silinmiş olabilir veya konuşmaya erişimin değişmiş olabilir.')}</span>
                  <small>{savedTime(item.savedAt)}</small>
                </div>
              {:else}
                <button type="button" class="saved-main" data-saved-item onclick={() => void openItem(item)}>
                  <span class="saved-meta"><strong>{displayName(item.sender)}</strong><small>{savedTime(item.savedAt)}</small></span>
                  <span class="saved-preview">{item.preview || t("message")}</span>
                  <span class="saved-destination">{destinationLabel(item)}</span>
                </button>
              {/if}
              <div class="saved-followup">
                <button type="button" class="saved-remind" disabled={item.unavailable} title={reminderLabel(item)} onclick={() => void setReminder(item)}>{reminderLabel(item)}</button>
                {#if item.remindAt}<button type="button" class="saved-remind-clear" aria-label={t("reminder_remove")} title={t("reminder_remove")} onclick={() => void clearReminder(item)}>×</button>{/if}
              </div>
              <button type="button" class="saved-remove" aria-label={t('sav_remove', 'Saved listesinden kaldır')} title={t('sav_remove', 'Saved listesinden kaldır')} onclick={() => void remove(item)}>×</button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </div>
{/if}

<style>
  .saved-backdrop { position: fixed; inset: 0; height: var(--bridge-visual-viewport-height, 100dvh); z-index: 1450; background: color-mix(in srgb, var(--bg-0) 64%, transparent); }
  .saved-panel { position: absolute; inset: 0 0 0 auto; width: min(430px, 94vw); display: flex; flex-direction: column; background: var(--bg-2); border-left: 1px solid var(--bg-5); box-shadow: var(--shadow-lg); color: var(--text-1); }
  .saved-header { min-height: 90px; padding: 18px 18px 15px 20px; display: flex; align-items: flex-start; gap: 12px; border-bottom: 1px solid var(--bg-5); }
  .saved-header > div { min-width: 0; flex: 1; }
  .saved-header h2 { margin: 2px 0 0; font-size: 21px; letter-spacing: -.02em; }
  .saved-header p { margin: 4px 0 0; color: var(--text-3); font-size: 12px; }
  .eyebrow { color: var(--brand); font-size: 10px; font-weight: 800; letter-spacing: .12em; }
  .saved-close { width: 36px; height: 36px; border: 1px solid var(--bg-5); border-radius: 9px; background: transparent; color: var(--text-2); cursor: pointer; font-size: 23px; }
  .saved-close:hover, .saved-close:focus-visible { border-color: var(--brand); color: var(--text-1); }
  .saved-list { min-height: 0; overflow: auto; margin: 0; padding: 10px; display: grid; align-content: start; gap: 8px; list-style: none; }
  .saved-remove-error { margin: 10px 10px 0; padding: 9px 11px; border: 1px solid color-mix(in srgb, var(--danger) 45%, var(--bg-5)); border-radius: 8px; background: color-mix(in srgb, var(--danger) 10%, transparent); color: var(--danger); font-size: 12px; }
  .saved-item { min-width: 0; display: flex; align-items: stretch; border: 1px solid var(--bg-5); border-radius: 10px; background: var(--bg-3); overflow: hidden; }
  .saved-item:focus-within { border-color: var(--brand); }
  .saved-main { min-width: 0; flex: 1; padding: 12px 13px; display: grid; gap: 6px; border: 0; background: transparent; color: inherit; text-align: left; font: inherit; }
  button.saved-main { cursor: pointer; }
  button.saved-main:hover { background: var(--bg-4); }
  .saved-meta { display: flex; align-items: baseline; gap: 8px; }
  .saved-meta strong { min-width: 0; flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; }
  .saved-meta small, .unavailable-copy small { color: var(--text-3); font-size: 10px; }
  .saved-preview { overflow: hidden; color: var(--text-2); font-size: 13px; line-height: 1.42; text-overflow: ellipsis; white-space: nowrap; }
  .saved-destination { color: var(--brand); font-size: 11px; font-weight: 650; }
  .saved-remove { width: 40px; flex: none; border: 0; border-left: 1px solid var(--bg-5); background: transparent; color: var(--text-3); cursor: pointer; font-size: 19px; }
  .saved-remove:hover, .saved-remove:focus-visible { background: color-mix(in srgb, var(--danger) 12%, transparent); color: var(--danger); }
  .unavailable { border-style: dashed; }
  .unavailable-copy strong { color: var(--text-2); font-size: 13px; }
  .unavailable-copy span { color: var(--text-3); font-size: 12px; line-height: 1.4; }
  .saved-state { margin: auto; padding: 28px; display: grid; justify-items: center; gap: 6px; color: var(--text-3); text-align: center; }
  .saved-state strong { color: var(--text-1); font-size: 14px; }
  .saved-state span { font-size: 12px; }
  .saved-state.error strong { color: var(--danger); }
  .saved-state button { margin-top: 8px; min-height: 32px; border: 1px solid currentColor; border-radius: 7px; background: transparent; color: inherit; cursor: pointer; }
  @media (max-width: 600px) {
    .saved-panel { width: 100%; height: var(--bridge-visual-viewport-height, 100dvh); }
    .saved-header { padding-top: calc(14px + env(safe-area-inset-top)); }
    .saved-list { padding: 8px; }
    .saved-item { display: grid; grid-template-columns: minmax(0, 1fr) 44px; }
    .saved-main { grid-column: 1; grid-row: 1; }
    .saved-followup { grid-column: 1; grid-row: 2; padding: 0 12px 10px; }
    .saved-remove { grid-column: 2; grid-row: 1 / span 2; width: 44px; min-height: 44px; }
    .saved-remind { flex: 1; max-width: none; min-height: 36px; }
    .saved-remind-clear { width: 36px; height: 36px; }
  }
  @media (prefers-reduced-motion: no-preference) { .saved-panel { animation: saved-in var(--duration-base) var(--ease-out); } @keyframes saved-in { from { opacity: .7; transform: translateX(18px); } } }
  .saved-followup { display: flex; align-items: center; gap: 4px; }
  .saved-remind { max-width: 150px; padding: 5px 7px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; border: 1px solid var(--bg-5); border-radius: 7px; background: var(--bg-3); color: var(--text-2); cursor: pointer; font-size: 10px; }
  .saved-remind:hover:not(:disabled), .saved-remind:focus-visible { border-color: var(--brand); color: var(--text-1); }
  .saved-remind:disabled { opacity: .5; cursor: default; }
  .saved-remind-clear { width: 24px; height: 24px; border: 0; background: transparent; color: var(--text-muted); cursor: pointer; }
</style>
