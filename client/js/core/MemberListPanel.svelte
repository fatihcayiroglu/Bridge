<!-- client/js/core/MemberListPanel.svelte -->
<!-- Phase 9: canonical member-list data + presentation owner. -->
<script lang="ts">
  import { avatarStyle } from './avatar-color.ts';
  import { onMount, onDestroy } from 'svelte';
  import { t } from './i18n/reactive.svelte.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { getAPI } from './globals.js';
  import { apiFetch } from './api-fetch.js';

  const log = createLogger('MemberListPanel');

  interface Member {
    _id?: string;
    id?: string;
    username?: string;
    displayName?: string;
    nickname?: string;
    avatarColor?: string;
    avatarUrl?: string | null;
    status?: 'online' | 'idle' | 'dnd' | 'offline' | string;
    activity?: string;
    badge?: string;
  }

  let members = $state<Member[]>([]);
  let isLoading = $state(false);
  let loadError = $state('');
  let requestSeq = 0;
  let currentServerId: string | null = null;

  type PresenceStatus = 'online' | 'idle' | 'dnd' | 'offline';
  type PresencePayload = { userId: string; status: PresenceStatus; statusText?: string; statusEmoji?: string };
  type SocketLike = {
    on(event: 'user:status', handler: (payload: PresencePayload) => void): void;
    off(event: 'user:status', handler: (payload: PresencePayload) => void): void;
  };
  let boundSocket: SocketLike | null = null;

  const online = $derived(members.filter(member => member.status !== 'offline'));
  const offline = $derived(members.filter(member => member.status === 'offline'));

  /**
   * UX — ÜYEDEN DOĞRUDAN MESAJ (P0).
   *
   * BULUNAN KUSUR: üye satırları ZATEN `<button>` idi ama HİÇBİR tıklama
   * eylemi yoktu — yani üye listesi tümüyle atıldı. Discord'da bir üyeye
   * tıklamak DM başlatmanın BİRİNCİL yoludur.
   *
   * Bridge'de DM'e ulaşmanın tek yolları şunlardı:
   *   · sohbet başlığındaki "Direkt mesajlar" düğmesi (yalnız LİSTE açar)
   *   · Arkadaşlar paneli (yalnız ARKADAŞ olunan kişiler)
   * Yani "sunucuda gördüğüm kişiye yazmak" akışı YOKTU.
   *
   * KANONİK SAHİP: `openDm` (DmPanel.svelte kaydeder). Burada YENİ bir DM
   * durumu/soketi kurulmaz — yalnızca mevcut sahibe delege edilir.
   */
  function startDm(member: Member): void {
    const id = memberId(member);
    if (!id) return;
    if (!BridgeRegistry.has('openDm')) return;   // sahip yoksa sessizce yok say
    BridgeRegistry.call('openDm', id, memberName(member), member.avatarColor);
  }

  /**
   * BIRINCIL satir eylemi: KISIYI goster, konusmaya ISINLANMA.
   *
   * Ilk duzeltmede satir tiklamasi dogrudan DM aciyordu; bu, "kime tikladigimi
   * once gormek isterim" beklentisini bozar ve yanlislikla sohbet acar.
   * Discord'un temel davranisi da once PROFIL gostermektir. Mesaj eylemi
   * popover icinde one cikarilir; ayrica satirda hizli bir kisayol kalir.
   *
   * Profil sahibi yoksa (ör. bilesen mount edilmemisse) DM'e duserek eski
   * davranis korunur — kullanici hicbir zaman tiklayip hicbir sey olmamasiyla
   * karsilasmaz.
   */
  function openProfile(member: Member): void {
    const id = memberId(member);
    if (!id) return;
    if (BridgeRegistry.has('openMemberProfile')) {
      BridgeRegistry.call('openMemberProfile', id);
      return;
    }
    startDm(member);
  }

  function memberId(member: Member): string {
    return String(member._id ?? member.id ?? member.username ?? member.displayName ?? '').trim();
  }

  function normalizeMembers(value: unknown): Member[] {
    if (!Array.isArray(value)) return [];
    const unique = new Map<string, Member>();
    for (const candidate of value) {
      if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) continue;
      const member = candidate as Member;
      const id = memberId(member);
      // A missing or duplicated identity would make keyed rendering ambiguous
      // and could route a profile/DM action to the wrong person. Fail closed.
      if (!id || unique.has(id)) continue;
      unique.set(id, member);
    }
    return [...unique.values()];
  }

  function memberName(member: Member): string {
    return member.nickname || member.displayName || member.username || 'Bridge member';
  }

  function initials(name: string): string {
    return name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'B';
  }

  function safeAvatar(value?: string | null): string | null {
    if (!value) return null;
    if (value.startsWith('/')) return `${getAPI()}${value}`;
    try {
      const parsed = new URL(value, location.origin);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch { return null; }
  }

  function statusLabel(status?: string): string {
    if (status === 'idle')    return t('status_idle',    'Boşta');
    if (status === 'dnd')     return t('status_dnd',     'Rahatsız etmeyin');
    if (status === 'offline') return t('members_offline','Çevrimdışı');
    return t('members_online', 'Çevrimiçi');
  }

  function onPresenceUpdate(payload: PresencePayload): void {
    if (!payload?.userId) return;
    let changed = false;
    const next = members.map(member => {
      if (memberId(member) !== payload.userId) return member;
      changed = true;
      return { ...member, status: payload.status };
    });
    if (changed) members = next;
  }

  function syncSocketBinding(): void {
    const next = BridgeRegistry.get<SocketLike>('socket');
    if (next === boundSocket) return;
    boundSocket?.off('user:status', onPresenceUpdate);
    boundSocket = next;
    boundSocket?.on('user:status', onPresenceUpdate);
  }

  async function loadMembers(serverId: string): Promise<void> {
    if (!serverId) return;
    currentServerId = serverId;
    const seq = ++requestSeq;
    isLoading = true;
    loadError = '';

    try {
      const response = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/members`);
      if (!response.ok) {
        log.warn('Üye listesi isteği başarısız', { status: response.status, serverId });
        throw new Error('member-list-load-failed');
      }
      const data = await response.json() as unknown;
      if (seq !== requestSeq) return;
      members = normalizeMembers(data);
    } catch (error) {
      if (seq !== requestSeq) return;
      members = [];
      log.error('Üye listesi yüklenemedi', error);
      loadError = t('members_load_failed', 'Üyeler yüklenemedi.');
    } finally {
      if (seq === requestSeq) isLoading = false;
    }
    // Üye sayısına bağlı yüzeyler (boş kanalda davet önerisi, U-06) güncel listeyi okusun.
    if (seq === requestSeq) document.dispatchEvent(new CustomEvent('bridge:members-updated', { detail: { serverId } }));
  }

  function toggleMemberList(): void {
    const panel = document.getElementById('member-list');
    if (!panel) return;
    const hidden = panel.hidden || panel.classList.contains('is-collapsed');
    panel.hidden = false;
    panel.classList.toggle('is-collapsed', !hidden);
    const button = document.getElementById('btn-members');
    button?.setAttribute('aria-expanded', String(hidden));
  }

  function onLoadMembers(event: Event): void {
    const serverId = (event as CustomEvent<{ serverId?: string }>).detail?.serverId;
    if (serverId) void loadMembers(serverId);
  }

  onMount(() => {
    document.addEventListener('bridge:load-members', onLoadMembers);
    document.addEventListener('bridge:socket-ready', syncSocketBinding);
    document.addEventListener('bridge:socket-reconnected', syncSocketBinding);
    syncSocketBinding();
    BridgeRegistry.register('loadMembers', (serverId?: string) => void loadMembers(serverId ?? currentServerId ?? ''));
    // Liste henüz boşken de kayıt vardır; böylece tüketiciler ağ zamanlamasına
    // göre var/yok olan bir sözleşmeyle karşılaşmaz. Dönüş salt-okunur keşif
    // içindir; profil/DM eylemlerinin sahipliği değişmez.
    BridgeRegistry.register('getCurrentServerMembers', () => members);
    BridgeRegistry.register('currentServerMembers', () => members);
    BridgeRegistry.register('toggleMemberList', toggleMemberList);

    const server = BridgeRegistry.call<{ _id?: string } | null>('getCurrentServer');
    if (server?._id) void loadMembers(server._id);
  });

  onDestroy(() => {
    // Invalidate any fetch that resolves after this component relinquishes
    // ownership. This also prevents a stale finally block from mutating state.
    requestSeq += 1;
    currentServerId = null;
    document.removeEventListener('bridge:load-members', onLoadMembers);
    document.removeEventListener('bridge:socket-ready', syncSocketBinding);
    document.removeEventListener('bridge:socket-reconnected', syncSocketBinding);
    boundSocket?.off('user:status', onPresenceUpdate);
    boundSocket = null;
    BridgeRegistry.unregister('loadMembers');
    BridgeRegistry.unregister('getCurrentServerMembers');
    BridgeRegistry.unregister('toggleMemberList');
    BridgeRegistry.unregister('currentServerMembers');
  });
</script>

<div class="member-panel" role="region" aria-label={t('members_title', 'Üyeler')} aria-busy={isLoading}>
  <div class="member-panel-head">
    <div>
      <span class="member-panel-eyebrow">{t('members_eyebrow', 'Topluluk')}</span>
      <h2>{t('members_title', 'Üyeler')}</h2>
    </div>
    <span class="member-total" aria-label={`${members.length} ${t('members_title', 'Üyeler')}`}>{members.length}</span>
  </div>

  {#if isLoading && members.length === 0}
    <div class="member-state" role="status">
      <span class="member-state-dot"></span>
      {t('members_loading', 'Üyeler yükleniyor…')}
    </div>
  {:else if loadError}
    <div class="member-state member-state-error" role="alert">
      <span>{t('members_load_failed', 'Üyeler yüklenemedi.')}</span>
      <button type="button" onclick={() => void loadMembers(currentServerId ?? '')}>{t('retry', 'Yeniden dene')}</button>
    </div>
  {:else if members.length === 0}
    <div class="member-state">{t('members_empty', 'Gösterilecek üye yok.')}</div>
  {:else}
    {#if online.length > 0}
      <div class="member-cat">{t('members_online', 'Çevrimiçi')} — {online.length}</div>
      {#each online as member (memberId(member))}
        {@const name = memberName(member)}
        {@const avatar = safeAvatar(member.avatarUrl)}
        <button class="member-row" type="button" onclick={() => openProfile(member)}
                title={`${name} — ${statusLabel(member.status)} · ${t('open_profile', 'Profili aç')}`}
                aria-label={`${name} — ${t('open_profile', 'Profili aç')}`}>
          <span class="member-avatar" style={avatarStyle(member.avatarColor)}>
            {#if avatar}<img src={avatar} alt="" loading="lazy" />{:else}{initials(name)}{/if}
            <span class="m-status {member.status || 'online'}"></span>
          </span>
          <span class="member-copy">
            <span class="member-name is-online">{name}</span>
            {#if member.activity}<span class="member-activity">{member.activity}</span>{/if}
          </span>
          {#if member.badge}<span class="member-badge">{member.badge}</span>{/if}
        </button>
      {/each}
    {/if}

    {#if offline.length > 0}
      <div class="member-cat member-cat-offline">{t('members_offline', 'Çevrimdışı')} — {offline.length}</div>
      {#each offline as member (memberId(member))}
        {@const name = memberName(member)}
        {@const avatar = safeAvatar(member.avatarUrl)}
        <button class="member-row member-row-offline" type="button" onclick={() => openProfile(member)}
                title={`${name} — ${statusLabel(member.status)} · ${t('open_profile', 'Profili aç')}`}
                aria-label={`${name} — ${t('open_profile', 'Profili aç')}`}>
          <span class="member-avatar" style={avatarStyle(member.avatarColor)}>
            {#if avatar}<img src={avatar} alt="" loading="lazy" />{:else}{initials(name)}{/if}
            <span class="m-status offline"></span>
          </span>
          <span class="member-copy"><span class="member-name">{name}</span></span>
          {#if member.badge}<span class="member-badge">{member.badge}</span>{/if}
        </button>
      {/each}
    {/if}
  {/if}
</div>

<style>
  .member-panel { min-height: 100%; color: var(--text-primary); }
  .member-panel-head {
    min-height: 58px; padding: 12px 14px 10px;
    display: flex; align-items: center; justify-content: space-between;
    border-bottom: 1px solid var(--border);
  }
  .member-panel-eyebrow {
    display: block; color: var(--text-muted); font-size: var(--type-caption);
    font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
  }
  .member-panel-head h2 { margin-top: 1px; font-size: var(--type-title-sm); font-weight: 700; letter-spacing: -.01em; }
  .member-total {
    min-width: 24px; height: 22px; padding: 0 7px; border: 1px solid var(--border);
    border-radius: var(--radius-pill); display: grid; place-items: center;
    color: var(--text-muted); background: var(--bg-3); font-size: var(--type-caption); font-weight: 700;
  }
  .member-cat {
    padding: 18px 14px 6px; color: var(--text-muted); font-size: var(--type-caption);
    font-weight: 750; letter-spacing: .075em; text-transform: uppercase;
  }
  .member-cat-offline { padding-top: 22px; }
  .member-row {
    width: calc(100% - 12px); min-height: 42px; margin: 1px 6px; padding: 5px 8px;
    border: 0; border-radius: var(--radius-control); background: transparent; color: inherit;
    display: flex; align-items: center; gap: 9px; text-align: left; cursor: pointer;
    transition: background var(--duration-fast), color var(--duration-fast);
  }
  .member-row:hover, .member-row:focus-visible { background: var(--surface-hover); }
  /* ── ÇEVRİMDIŞI SATIRLAR: OPACITY YERİNE RENK ─────────────────────────────
     ÖLÇÜLEN KUSUR (Final20): satırın tamamı `opacity: .58` ile soluklaştırılıyordu.
     Opaklık METNİ DE soluklaştırır: açık temada `--text-muted` (#5f6689) beyaz
     üzerinde %58 ile #a2a6bb'ye dönüşüyor ve kontrast 5.6:1'den 2.6:1'e
     düşüyordu — WCAG 1.4.3 (AA) 4.5:1 ister. axe ile canlı ölçüldü.
     Ayrıca opaklık avatarı da soluklaştırdığı için baş harflerin hesaplanmış
     okunabilir mürekkebini de geçersiz kılıyordu.
     Çevrimdışılık zaten İKİ ayrı işaretle belli: ayrı başlık ("Çevrimdışı — N")
     ve durum noktası. Metin rengi bu bilgiyi taşımak zorunda değil; soluk
     görünüm yalnızca AVATARA uygulanır, metin tam kontrastta kalır. */
  .member-row-offline .member-avatar { filter: saturate(0.55); }
  .member-row-offline:hover .member-avatar,
  .member-row-offline:focus-visible .member-avatar { filter: none; }
  .member-avatar {
    position: relative; width: 32px; height: 32px; flex: 0 0 32px; border-radius: var(--radius-avatar);
    display: grid; place-items: center; color: white; font-size: var(--type-label); font-weight: 750; overflow: visible;
  }
  .member-avatar img { width: 100%; height: 100%; border-radius: inherit; object-fit: cover; }
  .m-status {
    position: absolute; right: -1px; bottom: -1px; width: 10px; height: 10px;
    border: 2px solid var(--bg-1); border-radius: 50%; background: var(--status-online);
  }
  .m-status.idle { background: var(--status-idle); }
  .m-status.dnd { background: var(--status-dnd); }
  .m-status.offline { background: var(--status-offline); }
  .member-copy { min-width: 0; flex: 1; display: flex; flex-direction: column; }
  .member-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: var(--type-body-sm); font-weight: 560; }
  .member-name.is-online { color: var(--text-2); }
  .member-activity { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-muted); font-size: var(--type-caption); }
  .member-badge { flex: none; max-width: 54px; overflow: hidden; text-overflow: ellipsis; padding: 2px 5px; border-radius: var(--radius-chip); background: var(--brand-subtle); color: var(--brand); font-size: var(--type-badge); font-weight: 750; }
  .member-state { margin: 18px 12px; padding: 12px; border: 1px solid var(--border); border-radius: var(--radius-surface); color: var(--text-muted); background: var(--bg-3); font-size: var(--type-body-sm); display: flex; align-items: center; gap: 8px; }
  .member-state-dot { width: 7px; height: 7px; border-radius: 50%; background: var(--brand); animation: memberPulse 1.2s ease-in-out infinite; }
  .member-state-error { color: var(--danger); flex-wrap: wrap; }
  .member-state button { border: 0; border-bottom: 1px solid currentColor; background: none; color: inherit; font: inherit; cursor: pointer; }
  @keyframes memberPulse { 50% { opacity: .35; transform: scale(.75); } }
</style>
