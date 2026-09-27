<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { friendsCache } from './globals.js';
  import { createLogger } from './logger.js';
  import { closeExclusivePeers } from './exclusive-surface.ts';
  import { safeApiErrorMessage } from './api-error.ts';
  const log = createLogger('FriendsPanel');

  let isVisible = $state(false);
  let tab = $state<'online'|'all'|'pending'|'add'>('online');
  let friends = $state<User[]>([]);
  let pending = $state<RequestRow[]>([]);
  let username = $state('');
  let errorMsg = $state('');
  let requestSeq = 0;
  let mutationSeq = 0;
  let mutationInFlight = $state(false);
  type User = { _id: string; username?: string; displayName?: string; avatarColor?: string; status?: string };
  type RequestRow = { _id: string; userId: string; sender?: User };
  const apiFetch = (url: string, options?: RequestInit): Promise<Response> => {
    const fn = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
    if (!fn) return Promise.reject(new Error(t("ui_guvenli_api_istemcisi_kullanilamiyor", "Güvenli API istemcisi kullanılamıyor.")));
    return fn(url, options);
  };
  const apiBase = (): string => (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;
  const display = (user: User): string => user.displayName || user.username || 'Bridge user';
  const visibleFriends = $derived(friends.filter(friend => tab === 'all' || friend.status === 'online' || friend.status === 'idle'));

  function normalizedText(value: unknown, maxLength: number): string | undefined {
    if (typeof value !== 'string') return undefined;
    const normalized = value.trim().slice(0, maxLength);
    return normalized || undefined;
  }

  function normalizeUser(value: unknown, fallbackId = ''): User | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const candidate = value as Record<string, unknown>;
    const id = normalizedText(candidate._id, 128) || fallbackId;
    if (!id) return null;
    const avatarColor = typeof candidate.avatarColor === 'string' && /^(?:#[0-9a-f]{3}|#[0-9a-f]{4}|#[0-9a-f]{6}|#[0-9a-f]{8})$/i.test(candidate.avatarColor)
      ? candidate.avatarColor
      : undefined;
    const status = candidate.status === 'online' || candidate.status === 'idle' || candidate.status === 'dnd' || candidate.status === 'offline'
      ? candidate.status
      : 'offline';
    return {
      _id: id,
      username: normalizedText(candidate.username, 80),
      displayName: normalizedText(candidate.displayName, 120),
      avatarColor,
      status,
    };
  }

  function normalizeUsers(value: unknown): User[] {
    if (!Array.isArray(value)) return [];
    const unique = new Map<string, User>();
    for (const candidate of value) {
      const user = normalizeUser(candidate);
      if (!user || unique.has(user._id)) continue;
      unique.set(user._id, user);
    }
    return [...unique.values()];
  }

  function normalizeRequests(value: unknown): RequestRow[] {
    if (!Array.isArray(value)) return [];
    const unique = new Map<string, RequestRow>();
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const request = candidate as Record<string, unknown>;
      const id = normalizedText(request._id, 128) || '';
      const userId = normalizedText(request.userId, 128) || '';
      if (!id || !userId || unique.has(id)) continue;
      const sender = normalizeUser(request.sender, userId) || undefined;
      unique.set(id, { _id: id, userId, sender });
    }
    return [...unique.values()];
  }

  async function load(): Promise<void> {
    const seq = ++requestSeq;
    errorMsg = '';
    try {
      const [friendsResponse, pendingResponse] = await Promise.all([apiFetch(`${apiBase()}/api/friends`), apiFetch(`${apiBase()}/api/friends/pending`)]);
      if (!friendsResponse.ok || !pendingResponse.ok) throw new Error('friend response failed');
      const [friendData, pendingData] = await Promise.all([friendsResponse.json(), pendingResponse.json()]);
      if (seq !== requestSeq) return;
      friends = normalizeUsers(friendData);
      pending = normalizeRequests(pendingData);
      friendsCache.clear();
      for (const friend of friends) friendsCache.set(friend._id, friend);
    } catch {
      if (seq === requestSeq) errorMsg = t("ui_arkadas_listesi_yuklenemedi", "Arkadaş listesi yüklenemedi.");
    }
  }
  function open(): void { closeExclusivePeers('friends'); isVisible = true; void load(); }
  function close(): void { isVisible = false; }
  function openGroupDm(): void { close(); BridgeRegistry.call('showGroupDmPanel'); }
  async function addFriend(): Promise<void> {
    const value = username.trim(); if (!value || mutationInFlight) return;
    const seq = ++mutationSeq;
    mutationInFlight = true;
    errorMsg = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/friends/request`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ username:value }) });
      if (seq !== mutationSeq) return;
      if (!response.ok) {
        if (seq !== mutationSeq) return;
        errorMsg = safeApiErrorMessage(response, t("ui_istek_gonderilemedi", "İstek gönderilemedi."), { report: true });
        return;
      }
      username = ''; tab = 'pending'; await load();
    } catch { if (seq === mutationSeq) errorMsg = t("ui_istek_gonderilemedi", "İstek gönderilemedi."); }
    finally { if (seq === mutationSeq) mutationInFlight = false; }
  }
  async function requestAction(id: string, action: 'accept'|'decline'): Promise<void> {
    if (mutationInFlight) return;
    const seq = ++mutationSeq;
    mutationInFlight = true;
    errorMsg = '';
    try {
      const response = await apiFetch(`${apiBase()}/api/friends/${encodeURIComponent(id)}/${action}`, { method:'POST' });
      if (seq !== mutationSeq) return;
      if (!response.ok) { errorMsg = t("ui_istek_guncellenemedi", "İstek güncellenemedi."); return; }
      await load();
    } catch { if (seq === mutationSeq) errorMsg = t("ui_istek_guncellenemedi", "İstek güncellenemedi."); }
    finally { if (seq === mutationSeq) mutationInFlight = false; }
  }

  /**
   * Faz 10.5 — YENİDEN BAĞLANMADA SUNUCU GERÇEĞİNE YAKINSAMA.
   *
   * Bu panel tamamen REST-pull'dur; socket dinleyicisi YOKTUR. Bu bilinçli:
   * `load()` dizileri APPEND etmez, tamamen DEĞİŞTİRİR — dolayısıyla tekrarlı
   * yenileme yapısal olarak duplike üretemez ve socket olaylarını biriktirme
   * riski hiç doğmaz. (Bu yüzden burada 10.4'teki socket-kimliği disiplinine
   * gerek yok; panel taşıma sahibi değil.)
   *
   * Eksik olan tek şey tetikleyiciydi: kopukken sunucuda arkadaş eklenir/
   * silinir veya istek kabul/ret edilirse, panel yeniden AÇILANA kadar bayat
   * kalıyordu. Yeniden bağlanınca sunucu gerçeği çekilir.
   */
  function onSocketReconnected(): void {
    if (!isVisible) return;   // görünmeyen panel için gereksiz istek atma
    void load();
  }

  /**
   * Faz 10.5 — ÇIKIŞTA ÖZEL DURUMUN TEMİZLENMESİ.
   *
   * `friendsCache` `globals.js`'ten gelen MODÜL SEVİYESİ singleton'dır ve
   * bileşen yeniden mount edilse bile yaşar. Çıkışta temizlenmezse bir sonraki
   * kullanıcı önceki kullanıcının arkadaş verisini görebilirdi.
   */
  function onLogout(): void {
    requestSeq += 1;
    mutationSeq += 1;
    friends = [];
    pending = [];
    username = '';
    errorMsg = '';
    mutationInFlight = false;
    isVisible = false;
    friendsCache.clear();
  }

  /**
   * Faz E — ESCAPE İLE KAPANMA (ürün genelinde tek sözleşme).
   *
   * Bu panel `position:fixed; inset:0` ile TÜM ekranı kaplar ve
   * `aria-modal="true"` taşır; Escape'siz kalması, klavye kullanıcısını
   * kapatma düğmesine TAB'lamaya zorluyordu. `isVisible` değilse hiçbir şey
   * yapılmaz — gizli panel başka yüzeylerin Escape'ini yutmamalıdır.
   */
  function onEscape(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isVisible) return;
    close();
  }

  onMount(() => {
    window.addEventListener('keydown', onEscape);
    BridgeRegistry.register('showFriendsPanel', open);
    BridgeRegistry.register('openFriendsPanel', open);
    BridgeRegistry.register('hideFriendsPanel', close);
    document.addEventListener('bridge:socket-reconnected', onSocketReconnected);
    document.addEventListener('bridge:auth-logout', onLogout);
    void load();
    log.info('FriendsPanel mounted');
  });
  onDestroy(() => {
    requestSeq += 1;
    mutationSeq += 1;
    mutationInFlight = false;
    window.removeEventListener('keydown', onEscape);
    document.removeEventListener('bridge:socket-reconnected', onSocketReconnected);
    document.removeEventListener('bridge:auth-logout', onLogout);
    for (const key of ['showFriendsPanel','openFriendsPanel','hideFriendsPanel']) BridgeRegistry.unregister(key);
    log.info('FriendsPanel destroyed');
  });
</script>

{#if isVisible}
<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
<div class="friends-overlay" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) close(); }}>
<div class="friends-panel" role="dialog" aria-modal="true" aria-label={t('fr_title', 'Arkadaşlar')} use:focusTrap>
  <!--
    Faz C4.7 — GRUP DM ÜRÜN GİRİŞİ.
    Group DM bir sosyal/arkadaş özelliğidir (grup oluşturma zaten yalnız
    arkadaşlar arasından üye seçmeye izin verir), bu yüzden girişi Arkadaşlar
    panelindedir. `openDm` ile AYNI sözleşme kullanılır: kayıt defteri
    üzerinden kanonik panel açılır; ikinci bir açıcı/sahip kurulmaz.
  -->
  <header><h2>{t('fr_title', 'Arkadaşlar')}</h2><span class="header-actions"><button type="button" class="gdm-entry" onclick={openGroupDm}>{t('markup_grup_dm_93b0607', "Grup DM")}</button><button type="button" aria-label={t('fr_close', 'Arkadaşlar panelini kapat')} onclick={close}>×</button></span></header>
  <div role="tablist" aria-label={t('fr_filters', 'Arkadaş filtreleri')}>
    <button type="button" role="tab" class:active={tab==='online'} aria-selected={tab==='online'} onclick={() => tab='online'}>{t('fr_online', 'Çevrimiçi')}</button><button type="button" role="tab" class:active={tab==='all'} aria-selected={tab==='all'} onclick={() => tab='all'}>{t('inb_all', 'Tümü')}</button><button type="button" role="tab" class:active={tab==='pending'} aria-selected={tab==='pending'} onclick={() => tab='pending'}>{t("ui_pending_count", undefined, { count: pending.length })}</button><button type="button" role="tab" class:active={tab==='add'} aria-selected={tab==='add'} onclick={() => tab='add'}>{t('markup_ekle_eeeb1da', "Ekle")}</button>
  </div>
  {#if errorMsg}<p class="bridge-error" role="alert">{errorMsg}</p>{/if}
  {#if tab === 'add'}
    <form class="add-form" onsubmit={(event) => { event.preventDefault(); void addFriend(); }}><label for="friend-username">{t('fr_username', 'Kullanıcı adı')}</label><input id="friend-username" bind:value={username} autocomplete="off" placeholder={t('attr_kullanici_adi_aec235a', "kullanici_adi")}/><button class="btn btn-primary" type="submit" disabled={mutationInFlight}>{t('fr_send_request', 'İstek gönder')}</button></form>
  {:else if tab === 'pending'}
    {#if !pending.length}<p class="empty">{t('markup_bekleyen_istek_yok_582e22d', "Bekleyen istek yok.")}</p>{/if}
    {#each pending as request (request._id)}<article class="friend-row"><span class="avatar">{(request.sender?.displayName || request.sender?.username || '?').slice(0,2).toUpperCase()}</span><strong>{display(request.sender || { _id: request.userId })}</strong><span class="row-actions"><button type="button" disabled={mutationInFlight} onclick={() => requestAction(request._id,'accept')}>{t('markup_kabul_ee5fcda', "Kabul")}</button><button type="button" disabled={mutationInFlight} onclick={() => requestAction(request._id,'decline')}>{t('sw_decline')}</button></span></article>{/each}
  {:else}
    {#each visibleFriends as friend (friend._id)}<article class="friend-row"><span class="avatar">{(display(friend)).slice(0,2).toUpperCase()}</span><span class="friend-name"><strong>{display(friend)}</strong><small>@{friend.username || friend._id}</small></span><button type="button" onclick={() => BridgeRegistry.call('openDm', friend._id, display(friend), friend.avatarColor)}>{t('message')}</button></article>{/each}
    {#if !visibleFriends.length}<p class="empty">{t('fr_none', 'Henüz arkadaşınız yok.')}</p>{/if}
  {/if}
</div>
</div>
{/if}

<style>
.friends-overlay {
  position: fixed; inset: 0; z-index: var(--layer-modal);
  display: grid; place-items: center;
  padding: var(--space-6);
  background: color-mix(in srgb, var(--bg-0) 76%, transparent);
  backdrop-filter: blur(6px);
}
.friends-panel {
  display: flex; flex-direction: column;
  width: min(760px, calc(100vw - (var(--space-6) * 2)));
  max-height: min(720px, calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-6) * 2)));
  padding: var(--space-6);
  overflow: auto;
  color: var(--text-primary); background: var(--surface-1);
  border: 1px solid var(--border-strong); border-radius: var(--radius-modal);
  box-shadow: var(--shadow-xl);
}
.friends-panel header { display:flex; align-items:center; gap:var(--space-3); border-bottom:1px solid var(--border-subtle); padding-bottom:14px; }
.friends-panel h2 { margin:0; flex:1; }
.header-actions { display:flex; align-items:center; gap:var(--space-1); }
.friends-panel header button { min-width:40px; min-height:40px; border:0; border-radius:var(--radius-control); background:transparent; color:inherit; font-size:20px; cursor:pointer; }
.friends-panel header button:hover { background:var(--surface-selected); }
.friends-panel header .gdm-entry { padding:0 12px; font-size:13px; font-weight:700; }
.friends-panel [role="tablist"] { display:flex; gap:4px; padding:12px 0; border-bottom:1px solid var(--border-subtle); overflow-x:auto; scrollbar-width:thin; }
.friends-panel [role="tablist"] button,.friend-row button { min-height:40px; border:0; border-radius:var(--radius-control); background:transparent; color:var(--text-muted); padding:8px 10px; cursor:pointer; }
.friends-panel [role="tablist"] button { flex:none; white-space:nowrap; }
.friends-panel [role="tablist"] button.active,.friends-panel [role="tablist"] button:hover,.friend-row button:hover { background:var(--surface-selected); color:var(--text-primary); }
.friend-row { display:flex; align-items:center; gap:10px; padding:12px 4px; border-bottom:1px solid var(--border-subtle); min-width:0; }
.avatar { display:grid; place-items:center; width:36px; height:36px; flex:none; border-radius:50%; background:var(--brand); color:var(--text-on-solid); font-size:11px; font-weight:700; }
.friend-name { display:grid; flex:1; min-width:0; }
.friend-name strong,.friend-name small { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.friend-name small,.empty,.bridge-error { color:var(--text-muted); font-size:12px; }
.row-actions { display:flex; gap:4px; flex-wrap:wrap; justify-content:flex-end; }
.add-form { display:grid; gap:8px; width:min(400px,100%); padding-top:18px; }
.add-form input { min-height:44px; padding:10px; border:1px solid var(--border-subtle); border-radius:var(--radius-control); background:var(--surface-2); color:inherit; font:inherit; }
.bridge-error { color:var(--danger); padding:10px 0; }
.empty { padding:20px 0; }
.friends-panel button:focus-visible,.friends-panel input:focus-visible { outline:2px solid var(--focus-ring); outline-offset:2px; }

@media(max-width:700px) {
  .friends-overlay { padding:var(--space-3); align-items:stretch; }
  .friends-panel { width:100%; max-height:none; height:calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-3) * 2)); padding:var(--space-4); }
  .friend-row { align-items:flex-start; flex-wrap:wrap; }
  .friend-row > button,.row-actions { margin-left:46px; }
}
@media(max-width:480px) {
  .friends-overlay { padding:0; }
  .friends-panel { height:var(--bridge-visual-viewport-height, 100dvh); padding:max(var(--space-4), env(safe-area-inset-top)) max(var(--space-4), env(safe-area-inset-right)) max(var(--space-4), env(safe-area-inset-bottom)) max(var(--space-4), env(safe-area-inset-left)); border:0; border-radius:0; }
  .friends-panel header { position:sticky; top:calc(-1 * max(var(--space-4), env(safe-area-inset-top))); z-index:1; background:var(--surface-1); }
  .friends-panel [role="tablist"] { position:sticky; top:42px; z-index:1; background:var(--surface-1); }
}
@media(prefers-reduced-motion:reduce) { .friends-panel button { transition:none; } }
</style>
