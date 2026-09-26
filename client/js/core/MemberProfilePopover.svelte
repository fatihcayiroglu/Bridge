<!-- client/js/core/MemberProfilePopover.svelte -->
<!--
  UX/P1 — ÜYE PROFİLİ (kompakt popover).

  ════════════════════════════════════════════════════════════════════════════
  NEDEN YENİ BİR YÜZEY, `profile.ts` DEĞİL
  ════════════════════════════════════════════════════════════════════════════
  `js/profile.ts` gerçek profil davranışı içerir AMA üretimde HİÇ YÜKLENMEZ:
  `index.html` yalnızca `app.js` çeker; o dosya ayrı bir build girdisidir ve
  hiçbir runtime mekanizması onu talep etmez. Yani `openProfileModal` kaydı
  üretimde hiç oluşmaz — profil ERİŞİLEMEZDİ.

  Onu canlandırmak yerine kompakt bir popover yazıldı, çünkü:
   · İstenen etkileşim tam sayfa MODAL değil, satır yanında POPOVER.
   · `profile.ts` legacy IIFE + `innerHTML` tabanlıdır. Svelte metin
     enterpolasyonu YAPISAL olarak kaçışlar; yeni bir HTML enjeksiyon yüzeyi
     üretime sokulmaz (Faz G9'da canlı `{@html}` sinkleri sıfırlanmıştı).
   · `profile.ts` içinde `bannerUrl` bir CSS `url('…')` içine KAÇIŞLANMADAN
     giriyor (betik çalıştırmaz ama enjeksiyondur). Dormant kalması tercih
     edildi; bu bilinçli bir bırakma, gözden kaçma değil.

  İKİNCİ SAHİP YARATILMAZ:
   · Veri: mevcut kanonik uç `GET /api/users/:id`.
   · Mesaj: kanonik `openDm` (DmPanel sahibi) — yeni DM durumu/soketi YOK.
   · Bu bileşen SUNUM katmanıdır; kendi kalıcı profil durumunu tutmaz.

  YETKİ: moderasyon eylemleri BURADA render EDİLMEZ. Sunucu yetkisi taklit
  edilmez; yalnız her kullanıcı için geçerli olan eylemler gösterilir.
-->
<script lang="ts">
  import { avatarStyle } from './avatar-color.ts';
  import { safeServerUrl } from './globals.ts';
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { createLogger } from './logger.js';
  import { confirmProductAction } from './product-dialog.ts';

  const log = createLogger('MemberProfilePopover');

  interface Profile {
    _id?: string; id?: string;
    username?: string; displayName?: string;
    avatarColor?: string; avatarUrl?: string | null;
    status?: string; statusText?: string; statusEmoji?: string;
    bio?: string; pronouns?: string; location?: string;
  }

  let isVisible = $state(false);
  let loading   = $state(false);
  let error     = $state('');
  let profile   = $state<Profile | null>(null);
  let userId    = $state('');
  let requestGeneration = 0;

  // ── SUNUCU ROLLERI (KANONIK rol sistemi) ───────────────────────────────────
  // ONCEKI HAL: roller GOSTERILMIYORDU cunku uye->rol eslemesi hicbir uctan
  // okunamiyordu (`/:sid/members` yalnizca kullanici + nickname donuyordu).
  // ARTIK kanonik uc var:
  //     GET /api/servers/:sid/members/:uid/roles
  // Bu uc YETKI BITLERINI DONDURMEZ ve `displayOnProfile=false` rolleri
  // SUNUCUDA eler — istemci filtresine guvenilmez.
  interface ProfileRole { _id: string; name: string; color: string; position: number }
  let roles = $state<ProfileRole[]>([]);
  let rolesExpanded = $state(false);

  /** Kompakt gorunumde ilk N rol; gerisi [+N] ile acilir. */
  const ROLE_PREVIEW = 3;
  let visibleRoles = $derived(rolesExpanded ? roles : roles.slice(0, ROLE_PREVIEW));
  let hiddenRoleCount = $derived(Math.max(0, roles.length - ROLE_PREVIEW));

  /** Rol rengi yalniz guvenli hex ise kullanilir (stil enjeksiyonu olmaz). */
  function roleColor(value: unknown): string {
    return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : 'var(--text-muted)';
  }

  async function loadRoles(id: string, generation: number): Promise<void> {
    roles = []; rolesExpanded = false;
    try {
      const server = BridgeRegistry.call<{ _id?: string } | null>('currentServer');
      const sid = server?._id;
      if (!sid || !id) return;
      const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
      if (!apiFetch) return;
      const res = await apiFetch(`${apiBase()}/api/servers/${encodeURIComponent(sid)}/members/${encodeURIComponent(id)}/roles`);
      if (generation !== requestGeneration || !res.ok) return; // FAIL-CLOSED
      const list = await res.json() as ProfileRole[];
      if (generation !== requestGeneration) return;
      roles = Array.isArray(list) ? list : [];
    } catch (err) {
      if (generation !== requestGeneration) return;
      log.error('Role load failed', err);
      roles = [];
    }
  }

  // ── ARKADAŞLIK (KANONİK sistem, uydurma YOK) ───────────────────────────────
  // Kanonik uçlar: GET /api/friends · POST /api/friends/request {username}
  //                DELETE /api/friends/:friendId
  // İkinci bir arkadaşlık modeli/servisi KURULMAZ; durum sunucudan okunur.
  //
  type FriendState = 'unknown' | 'self' | 'friend' | 'none' | 'pending';
  let friendState = $state<FriendState>('unknown');
  let friendBusy  = $state(false);
  let friendNote  = $state('');

  type BlockState = 'unknown' | 'self' | 'blocked' | 'clear';
  let blockState = $state<BlockState>('unknown');
  let blockBusy = $state(false);
  let blockNote = $state('');

  function meId(): string {
    try {
      const u = BridgeRegistry.call<{ id?: string; _id?: string } | null>('me');
      return String(u?.id ?? u?._id ?? '');
    } catch { return ''; }
  }

  /** Görüntülenen kişi zaten arkadaş mı? Sunucudan okunur, tahmin edilmez. */
  async function loadFriendState(id: string, generation: number): Promise<void> {
    friendNote = '';
    if (!id) { friendState = 'unknown'; return; }
    if (id === meId()) { friendState = 'self'; return; }
    try {
      const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
      if (!apiFetch) { friendState = 'unknown'; return; }
      const res = await apiFetch(`${apiBase()}/api/friends`);
      if (generation !== requestGeneration) return;
      if (!res.ok) { friendState = 'unknown'; return; }
      const list = await res.json() as Array<{ _id?: string; id?: string }>;
      if (generation !== requestGeneration) return;
      const hit = Array.isArray(list) && list.some(u => String(u._id ?? u.id ?? '') === id);
      friendState = hit ? 'friend' : 'none';
    } catch {
      if (generation !== requestGeneration) return;
      friendState = 'unknown';   // FAIL-CLOSED: bilinmiyorsa eylem gösterilmez
    }
  }


  /** Yalnız çağıranın kendi engel kenarı okunur; karşı tarafın engeli oracle olmaz. */
  async function loadBlockState(id: string, generation: number): Promise<void> {
    blockNote = '';
    if (!id) { blockState = 'unknown'; return; }
    if (id === meId()) { blockState = 'self'; return; }
    try {
      const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
      if (!apiFetch) { blockState = 'unknown'; return; }
      const res = await apiFetch(`${apiBase()}/api/friends/blocks`);
      if (generation !== requestGeneration) return;
      if (!res.ok) { blockState = 'unknown'; return; }
      const data = await res.json() as { blocks?: Array<{ userId?: string }> };
      if (generation !== requestGeneration) return;
      const hit = Array.isArray(data.blocks) && data.blocks.some(row => String(row.userId ?? '') === id);
      blockState = hit ? 'blocked' : 'clear';
    } catch (err) {
      if (generation !== requestGeneration) return;
      log.error('Block state load failed', err);
      blockState = 'unknown';
    }
  }

  function blockFailure(status: number, action: 'block' | 'unblock'): string {
    if (status === 401 || status === 403) return t("ui_bu_islem_icin_oturumunuzu_yenileyin", "Bu işlem için oturumunuzu yenileyin.");
    if (status === 404) return t("ui_kullanici_artik_erisilebilir_degil", "Kullanıcı artık erişilebilir değil.");
    if (status === 429) return t("ui_cok_hizli_islem_yapiliyor_biraz_sonra_tekrar_deneyin", "Çok hızlı işlem yapılıyor. Biraz sonra tekrar deneyin.");
    return action === 'block' ? t("ui_kullanici_engellenemedi", "Kullanıcı engellenemedi.") : t("ui_engel_kaldirilamadi", "Engel kaldırılamadı.");
  }

  async function blockUser(): Promise<void> {
    if (!userId || blockBusy || blockState !== 'clear') return;
    const confirmed = await confirmProductAction({
      title: t("ui_kullaniciyi_engelle", "Kullanıcıyı engelle"),
      message: t('friend_remove_confirm_named', '{name} ile arkadaşlık kaldırılacak ve doğrudan etkileşimler engellenecek.', { name }),
      confirmLabel: t('perm_deny_label'),
      // The canonical option is `tone`; `destructive` was silently ignored, so
      // the block-user confirmation rendered without its danger styling.
      tone: 'danger',
    });
    if (!confirmed || !isVisible || userId === meId()) return;
    const target = userId;
    const generation = requestGeneration;
    blockBusy = true; blockNote = '';
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/friends/blocks`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: target }),
      });
      if (generation !== requestGeneration || target !== userId) return;
      if (!res.ok) { blockNote = blockFailure(res.status, 'block'); return; }
      blockState = 'blocked'; friendState = 'none'; friendNote = '';
      blockNote = t("ui_kullanici_engellendi", "Kullanıcı engellendi.");
    } catch (err) {
      if (generation !== requestGeneration) return;
      log.error('Block user failed', err);
      blockNote = t("ui_kullanici_engellenemedi", "Kullanıcı engellenemedi.");
    } finally {
      if (generation === requestGeneration) blockBusy = false;
    }
  }

  async function unblockUser(): Promise<void> {
    if (!userId || blockBusy || blockState !== 'blocked') return;
    const target = userId;
    const generation = requestGeneration;
    blockBusy = true; blockNote = '';
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/friends/blocks/${encodeURIComponent(target)}`, { method: 'DELETE' });
      if (generation !== requestGeneration || target !== userId) return;
      if (!res.ok) { blockNote = blockFailure(res.status, 'unblock'); return; }
      blockState = 'clear';
      blockNote = t("ui_engel_kaldirildi", "Engel kaldırıldı.");
      void loadFriendState(target, generation);
    } catch (err) {
      if (generation !== requestGeneration) return;
      log.error('Unblock user failed', err);
      blockNote = t("ui_engel_kaldirilamadi", "Engel kaldırılamadı.");
    } finally {
      if (generation === requestGeneration) blockBusy = false;
    }
  }

  async function addFriend(): Promise<void> {
    const uname = profile?.username;
    if (!uname || friendBusy) return;
    const generation = requestGeneration;
    friendBusy = true; friendNote = '';
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/friends/request`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: uname }),
      });
      if (generation !== requestGeneration) return;
      if (res.status === 409) { friendState = 'pending'; friendNote = t("ui_zaten_bir_istek_var", "Zaten bir istek var."); return; }
      if (!res.ok) { friendNote = t("ui_istek_gonderilemedi", "İstek gönderilemedi."); return; }
      friendState = 'pending';
      friendNote  = t("ui_istek_gonderildi", "İstek gönderildi.");
    } catch (err) {
      if (generation !== requestGeneration) return;
      log.error('Friend request failed', err);
      friendNote = t("ui_istek_gonderilemedi", "İstek gönderilemedi.");
    } finally {
      if (generation === requestGeneration) friendBusy = false;
    }
  }

  async function removeFriend(): Promise<void> {
    if (!userId || friendBusy) return;
    const generation = requestGeneration;
    friendBusy = true; friendNote = '';
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/friends/${encodeURIComponent(userId)}`, { method: 'DELETE' });
      if (generation !== requestGeneration) return;
      if (!res.ok) { friendNote = t("ui_arkadasliktan_cikarilamadi", "Arkadaşlıktan çıkarılamadı."); return; }
      friendState = 'none';
    } catch (err) {
      if (generation !== requestGeneration) return;
      log.error('Friend removal failed', err);
      friendNote = t("ui_arkadasliktan_cikarilamadi", "Arkadaşlıktan çıkarılamadı.");
    } finally {
      if (generation === requestGeneration) friendBusy = false;
    }
  }

  /** Sunucudan gelen presence — uydurma yok, bilinmiyorsa gösterilmez. */
  const PRESENCE: Record<string, string> = $derived.by(() => ({
    online: t('presence_online', 'Çevrimiçi'), idle: t('presence_idle', 'Boşta'), dnd: t('presence_dnd', 'Rahatsız etmeyin'), offline: t('presence_offline', 'Çevrimdışı'),
  }));
  let presenceLabel = $derived(PRESENCE[String(profile?.status ?? '')] ?? '');

  const apiBase = (): string =>
    (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;

  let name = $derived(profile?.displayName || profile?.username || t('ui_bridge_user', 'Bridge kullanıcısı'));
  let handle = $derived(profile?.username ? `@${profile.username}` : '');
  let statusLine = $derived(
    [profile?.statusEmoji, profile?.statusText].filter(Boolean).join(' ').trim(),
  );

  /** Renk yalnız güvenli bir hex ise kullanılır (stil enjeksiyonu olmaz). */
  /** Avatar yalnız http(s) veya site-içi göreli yol olabilir. */
  function safeAvatar(value: unknown): string | null {
    return safeServerUrl(value);
  }
  // Final21 UX: mesajlarda ve kullanıcı panelinde baş harfler kelimelerden alınır ("Deniz Test" → DT);
  // burada ilk iki HARF alınıyordu (DE) — aynı kişi iki farklı avatarla görünüyordu.
  function initials(v: string): string {
    return (v || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0] ?? '').join('').toUpperCase() || '?';
  }

  async function load(id: string, generation = requestGeneration): Promise<void> {
    loading = true; error = ''; profile = null;
    try {
      const apiFetch = BridgeRegistry.get<(u: string) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/users/${encodeURIComponent(id)}`);
      if (generation !== requestGeneration) return;
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const nextProfile = await res.json() as Profile;
      if (generation !== requestGeneration) return;
      profile = nextProfile;
    } catch (err) {
      if (generation !== requestGeneration) return;
      log.error('Profile load failed', err);
      error = t("ui_profil_yuklenemedi", "Profil yüklenemedi.");
    } finally {
      if (generation === requestGeneration) loading = false;
    }
  }

  function open(id: string): void {
    if (!id) return;
    const generation = ++requestGeneration;
    userId = id;
    isVisible = true;
    friendState = 'unknown'; friendNote = ''; friendBusy = false;
    blockState = 'unknown'; blockNote = ''; blockBusy = false;
    void load(id, generation);
    void loadFriendState(id, generation);
    void loadBlockState(id, generation);
    void loadRoles(id, generation);
  }
  function close(): void {
    requestGeneration += 1;
    isVisible = false;
    loading = false; profile = null; error = '';
  }

  /** Kendi profilinde "Mesaj gönder" kendine DM açmaktı; beklenen eylem profili düzenlemektir. */
  function editOwnProfile(): void {
    close();
    BridgeRegistry.call('openSettingsModal', 'profile');
  }

  function message(): void {
    if (!userId || !BridgeRegistry.has('openDm')) return;
    // KANONİK sahibe delege — burada DM durumu kurulmaz.
    BridgeRegistry.call('openDm', userId, name, profile?.avatarColor);
    close();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isVisible) return;
    e.preventDefault();
    close();
  }

  onMount(() => {
    BridgeRegistry.register('openMemberProfile', open);
    BridgeRegistry.register('closeMemberProfile', close);
  });
  onDestroy(() => {
    BridgeRegistry.unregister?.('openMemberProfile');
    BridgeRegistry.unregister?.('closeMemberProfile');
  });
</script>

<svelte:window onkeydown={onKeyDown} />

{#if isVisible}
<div class="mp-overlay" role="presentation"
     onclick={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div class="mp-card" role="dialog" aria-modal="true" aria-label={t('mpp_profile', 'Üye profili')}
       use:focusTrap={{ initialFocus: '.mp-msg' }}>

    {#if loading}
      <p class="mp-state" aria-live="polite">{t('sso_loading', 'Yükleniyor…')}</p>
    {:else if error}
      <p class="mp-state mp-error" role="alert">{error}</p>
      <button type="button" class="mp-ghost" onclick={() => load(userId)}>{t('retry')}</button>
    {:else if profile}
      <div class="mp-head">
        <span class="mp-avatar" style={avatarStyle(profile.avatarColor)}>
          {#if safeAvatar(profile.avatarUrl)}
            <img src={safeAvatar(profile.avatarUrl)} alt="" />
          {:else}{initials(name)}{/if}
        </span>
        <span class="mp-id">
          <strong class="mp-name">{name}</strong>
          {#if handle}<span class="mp-handle">{handle}</span>{/if}
        </span>
      </div>

      {#if presenceLabel}
        <p class="mp-presence"><span class={`mp-dot mp-dot-${profile.status}`} aria-hidden="true"></span>{presenceLabel}</p>
      {/if}
      {#if statusLine}<p class="mp-status">{statusLine}</p>{/if}
      {#if profile.pronouns}<p class="mp-meta">{profile.pronouns}</p>{/if}
      {#if profile.bio}<p class="mp-bio">{profile.bio}</p>{/if}

      {#if roles.length}
        <div class="mp-roles" role="group" aria-label={t('attr_sunucu_rolleri_fb7c7bc', "Sunucu rolleri")}>
          {#each visibleRoles as role (role._id)}
            <!-- Renk YALNIZCA vurgudur: rol ADI her zaman okunabilir metindir,
                 yani bilgi renkle TASINMAZ (erisilebilirlik gereksinimi). -->
            <span class="mp-role" title={role.name}>
              <span class="mp-role-dot" style={`background:${roleColor(role.color)}`} aria-hidden="true"></span>
              <span class="mp-role-name">{role.name}</span>
            </span>
          {/each}
          {#if hiddenRoleCount > 0 && !rolesExpanded}
            <button type="button" class="mp-role mp-role-more" onclick={() => (rolesExpanded = true)}
                    aria-label={t('role_show_more_aria', undefined, { count: hiddenRoleCount })}>+{hiddenRoleCount}</button>
          {/if}
        </div>
      {/if}

      <div class="mp-actions">
        {#if friendState === 'self'}
          <button type="button" class="mp-msg" onclick={editOwnProfile}>{t('mpp_edit_profile', 'Profili düzenle')}</button>
        {:else}
          <button type="button" class="mp-msg" onclick={message}>{t('mpp_send_message', 'Mesaj gönder')}</button>
        {/if}

        <!-- Arkadaslik eylemi YALNIZ durum SUNUCUDAN bilindiginde gosterilir.
             'unknown' (okunamadi) veya 'self' ise hicbir sey render edilmez —
             tiklandiginda calismayacak bir dugme gostermek yanilticidir. -->
        {#if friendState === 'none' && blockState !== 'blocked'}
          <button type="button" class="mp-friend" onclick={addFriend} disabled={friendBusy}>
            {friendBusy ? t("dm_sending") : t("surface_arkadas_ekle_37b967")}
          </button>
        {:else if friendState === 'pending' && blockState !== 'blocked'}
          <button type="button" class="mp-friend" disabled>{t('mpp_pending', 'İstek bekliyor')}</button>
        {:else if friendState === 'friend' && blockState !== 'blocked'}
          <button type="button" class="mp-friend" onclick={removeFriend} disabled={friendBusy}>
            {friendBusy ? t("surface_kald_r_l_yor_95230b") : t("surface_arkadasl_ktan_c_kar_11343e")}
          </button>
        {/if}
        {#if blockState === 'clear'}
          <button type="button" class="mp-block" onclick={blockUser} disabled={blockBusy}>
            {blockBusy ? t('profile_blocking') : t('perm_deny_label')}
          </button>
        {:else if blockState === 'blocked'}
          <button type="button" class="mp-block" onclick={unblockUser} disabled={blockBusy}>
            {blockBusy ? t("surface_kald_r_l_yor_95230b") : t("surface_engeli_kald_r_4902bf")}
          </button>
        {/if}
      </div>
      {#if friendNote}<p class="mp-note" role="status">{friendNote}</p>{/if}
      {#if blockNote}<p class="mp-note" role="status">{blockNote}</p>{/if}
    {/if}

    <button type="button" class="mp-x" onclick={close} aria-label={t('attr_profili_kapat_b6f365f', "Profili kapat")}>✕</button>
  </div>
</div>
{/if}

<style>
  .mp-overlay {
    position: fixed; inset: 0; z-index: 1250;
    display: grid; place-items: center;
    background: color-mix(in srgb, var(--bg-0) 72%, transparent);
    backdrop-filter: blur(5px);
    padding: var(--space-4);
  }
  .mp-card {
    position: relative;
    width: min(320px, 100%);
    max-height: calc(var(--bridge-visual-viewport-height, 100dvh) - (var(--space-4) * 2));
    overflow-y: auto;
    background: var(--surface-1);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-surface);
    box-shadow: var(--elevation-modal);
    padding: var(--space-4);
    display: grid; gap: var(--space-2);
  }
  .mp-head { display: flex; align-items: center; gap: var(--space-3); min-width: 0; }
  .mp-avatar {
    width: 48px; height: 48px; border-radius: var(--radius-avatar);
    display: grid; place-items: center; flex-shrink: 0;
    color: var(--text-on-solid); font-weight: 800; font-size: var(--type-body);
    overflow: hidden;
  }
  .mp-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .mp-id { display: grid; min-width: 0; }
  .mp-name { font-size: var(--type-title-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-handle, .mp-meta { color: var(--text-muted); font-size: var(--type-caption); }
  .mp-status { margin: 0; font-size: var(--type-body-sm); color: var(--text-2); }
  .mp-bio { margin: 0; font-size: var(--type-body-sm); color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
  .mp-state { margin: 0; color: var(--text-muted); font-size: var(--type-body-sm); }
  .mp-error { color: var(--danger); }
  .mp-msg {
    margin-top: var(--space-1);
    border: 0; border-radius: var(--radius-control);
    background: var(--brand); color: var(--text-on-solid);
    padding: 10px 14px; cursor: pointer; font-weight: 600;
    transition: background var(--duration-fast);
  }
  .mp-msg:hover { background: var(--brand-hover); }
  .mp-roles { display: flex; flex-wrap: wrap; gap: 4px; max-height: 76px; overflow-y: auto; }
  .mp-role {
    display: inline-flex; align-items: center; gap: 5px;
    max-width: 140px; padding: 2px 8px;
    background: var(--surface-2); border: 1px solid var(--border-subtle);
    border-radius: 99px; font-size: var(--type-caption); color: var(--text-2);
  }
  .mp-role-dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
  .mp-role-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mp-role-more { cursor: pointer; font: inherit; color: var(--text-2); }
  .mp-role-more:hover { background: var(--surface-hover); color: var(--text-primary); }
  .mp-actions { display: flex; gap: var(--space-2); flex-wrap: wrap; }
  .mp-actions .mp-msg { flex: 1; min-width: 132px; }
  .mp-friend, .mp-block {
    flex: 1; min-width: 132px;
    border: 1px solid var(--border-subtle); background: transparent;
    color: var(--text-2); border-radius: var(--radius-control);
    padding: 10px 12px; cursor: pointer; font-weight: 600;
    transition: background var(--duration-fast), color var(--duration-fast);
  }
  .mp-friend:hover:not(:disabled), .mp-block:hover:not(:disabled) { background: var(--surface-hover); color: var(--text-primary); }
  .mp-friend:disabled, .mp-block:disabled { opacity: .6; cursor: default; }
  .mp-note { margin: 0; font-size: var(--type-caption); color: var(--text-muted); }
  .mp-presence { display: flex; align-items: center; gap: 6px; margin: 0; font-size: var(--type-body-sm); color: var(--text-2); }
  .mp-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-muted); flex: none; }
  .mp-dot-online { background: var(--green, #3ba55d); }
  .mp-dot-idle { background: var(--yellow, #f0b132); }
  .mp-dot-dnd { background: var(--danger); }
  .mp-ghost {
    border: 1px solid var(--border-subtle); background: transparent;
    color: var(--text-2); border-radius: var(--radius-control);
    padding: 8px 12px; cursor: pointer;
  }
  .mp-x {
    position: absolute; top: 8px; right: 8px;
    border: 0; background: transparent; color: var(--text-muted);
    font-size: 16px; line-height: 1; cursor: pointer;
    border-radius: var(--radius-control); padding: 2px 6px;
  }
  .mp-x:hover { background: var(--surface-hover); color: var(--text-primary); }
  .mp-x:focus-visible, .mp-msg:focus-visible, .mp-friend:focus-visible, .mp-block:focus-visible, .mp-ghost:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  @media (max-width: 480px) {
    .mp-overlay { place-items: end center; padding: 0; }
    .mp-card {
      width: 100%;
      max-height: min(86dvh, var(--bridge-visual-viewport-height, 86dvh));
      padding: var(--space-5) var(--space-4) calc(var(--space-5) + env(safe-area-inset-bottom));
      border-right: 0; border-bottom: 0; border-left: 0;
      border-radius: var(--radius-modal) var(--radius-modal) 0 0;
      box-shadow: var(--shadow-xl);
    }
    .mp-x { width: 40px; height: 40px; top: 10px; right: 10px; padding: 0; }
    .mp-actions { display: grid; grid-template-columns: 1fr 1fr; }
    .mp-actions .mp-msg, .mp-friend, .mp-block { min-width: 0; min-height: 44px; }
  }
</style>
