<!-- client/js/core/GroupDmPanel.svelte -->
<!-- ADR-0008 Faz 2 — group-dm.ts (381 satır) → Svelte bileşeni           -->
<!-- GDM listesi, sohbet, oluştur/ayar/info modal, üye yönetimi            -->
<!-- Svelte 5 Runes API, BridgeRegistry köprüsü                            -->
<!-- Sprint 113                                                             -->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry }     from './bridge-registry.js';
  import { friendsCache }        from './globals.js';
  import { createLogger }        from './logger.js';
  // group-dm-voice.ts yüklenmiş olmalı — startGdmCall window üzerinden alınır
  // (vanilla modül, dynamic import ile lazy yükleme)
  let _gdmVoiceLoaded = false;

  const log = createLogger('GroupDmPanel');

  // ── Tipler ────────────────────────────────────────────────────────────────

  interface GdmMember {
    _id?: string;
    id?: string;
    displayName: string;
    avatarColor: string;
    username?: string;
  }

  interface GdmGroup {
    _id: string;
    name: string;
    icon?: string;
    ownerId?: string;
    memberCount?: number;
    members?: GdmMember[];
    lastMessage?: { content?: string };
  }

  interface GdmMessage {
    _id?: string;
    userId?: string;
    displayName: string;
    avatarColor: string;
    content: string;
    createdAt: string | number;
    type?: string;
  }

  interface Props {
    onClose?: () => void;
  }

  let { onClose }: Props = $props();

  // ── State ─────────────────────────────────────────────────────────────────

  let groups         = $state<GdmGroup[]>([]);
  let currentGroup   = $state<GdmGroup | null>(null);
  let messages       = $state<GdmMessage[]>([]);
  let inputValue     = $state('');
  let loading        = $state(false);
  let msgLoading     = $state(false);

  // Modaller
  type ModalKind = 'create' | 'info' | 'settings' | null;
  let activeModal    = $state<ModalKind>(null);

  // Create modal
  let createName     = $state('');
  let createIcon     = $state('');
  let createMembers  = $state('');
  let creating       = $state(false);

  // Settings modal
  let settingsName   = $state('');
  let settingsIcon   = $state('');
  let saving         = $state(false);

  // Info modal — add member
  let addMemberInput = $state('');

  // ── Helpers ───────────────────────────────────────────────────────────────

  function apiFetch(url: string, opts?: RequestInit): Promise<Response> {
    const fn = BridgeRegistry.get('apiFetch') as ((u: string, o?: RequestInit) => Promise<Response>) | undefined;
    return fn ? fn(url, opts) : fetch(url, opts);
  }

  function API(): string {
    return ((window as Record<string, unknown>)['API'] as string) ?? '';
  }

  function me(): { id: string; displayName?: string } | null {
    return (BridgeRegistry.get('getMe') as (() => { id: string } | null) | undefined)?.() ?? null;
  }

  function socket(): { emit(e: string, d?: unknown): void } | null {
    return (window as Record<string, unknown>)['socket'] as { emit(e: string, d?: unknown): void } | null;
  }

  function toast(msg: string, type = 'info'): void {
    BridgeRegistry.get('toast')?.(msg, type);
  }

  function cssColor(c: string): string {
    return (BridgeRegistry.get('cssColor') as ((c: string) => string) | undefined)?.(c) ?? c;
  }

  function initials(name: string): string {
    return (BridgeRegistry.get('initials') as ((n: string) => string) | undefined)?.(name)
      ?? name.slice(0, 2).toUpperCase();
  }

  function formatText(s: string): string {
    return (BridgeRegistry.get('formatText') as ((s: string) => string) | undefined)?.(s) ?? s;
  }

  function escHtml(s: string): string {
    return s.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c] ?? c));
  }

  // ── GDM listesi ──────────────────────────────────────────────────────────

  async function loadGroupDmList(): Promise<void> {
    loading = true;
    try {
      const r = await apiFetch(`${API()}/api/gdm`);
      if (!r.ok) return;
      groups = await r.json() as GdmGroup[];
    } catch (e) {
      log.warn('loadGroupDmList hata:', e);
    } finally {
      loading = false;
    }
  }

  // ── Grup aç / mesajlar ────────────────────────────────────────────────────

  async function openGroupDm(group: GdmGroup): Promise<void> {
    currentGroup = group;
    socket()?.emit('gdm:join', group._id);
    await loadGroupDmMessages(group._id);
  }

  async function loadGroupDmMessages(groupId: string): Promise<void> {
    msgLoading = true;
    messages = [];
    try {
      const r = await apiFetch(`${API()}/api/gdm/${groupId}/messages?limit=50`);
      if (r.ok) messages = await r.json() as GdmMessage[];
    } catch { /* ignore */ }
    msgLoading = false;
    // scroll sonuna
    setTimeout(() => {
      const area = document.getElementById('gdm-messages');
      if (area) area.scrollTop = area.scrollHeight;
    }, 0);
  }

  function sendGroupDm(): void {
    if (!currentGroup) return;
    const content = inputValue.trim();
    if (!content) return;
    if (content.length > 2000) { toast('Mesaj çok uzun', 'error'); return; }
    socket()?.emit('gdm:send', { groupId: currentGroup._id, content });
    inputValue = '';
  }

  // ── Socket events ─────────────────────────────────────────────────────────

  function _onGdmMessage(msg: GdmMessage): void {
    if (!currentGroup) return;
    messages = [...messages, msg];
    setTimeout(() => {
      const area = document.getElementById('gdm-messages');
      if (area) area.scrollTop = area.scrollHeight;
    }, 0);
  }

  function _onGdmUpdate(group: GdmGroup): void {
    groups = groups.map(g => g._id === group._id ? group : g);
    if (currentGroup?._id === group._id) currentGroup = group;
  }

  // ── Create modal ──────────────────────────────────────────────────────────

  async function createGroupDm(): Promise<void> {
    if (!createName.trim()) { toast('Grup adı gerekli', 'error'); return; }
    if (!createMembers.trim()) { toast('En az 1 üye ekle', 'error'); return; }

    const usernames = createMembers.split(',').map(u => u.trim()).filter(Boolean);
    const memberIds: string[] = [];

    for (const uname of usernames) {
      const found = (Array.from(friendsCache.values()) as { _id?: string; id?: string; username?: string }[])
        .find(f => f.username?.toLowerCase() === uname.toLowerCase());
      if (!found) { toast(`"${uname}" bulunamadı — önce arkadaş olmalısınız`, 'warning'); return; }
      memberIds.push((found._id ?? found.id) as string);
    }

    creating = true;
    try {
      const r = await apiFetch(`${API()}/api/gdm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: createName.trim(), icon: createIcon.trim() || null, memberIds }),
      });
      const data = await r.json() as GdmGroup & { error?: string };
      if (!r.ok) { toast(data.error ?? 'Oluşturulamadı', 'error'); return; }

      activeModal = null;
      createName = ''; createIcon = ''; createMembers = '';
      toast(`"${data.name}" grubu oluşturuldu! 🎉`, 'success');
      await loadGroupDmList();
      void openGroupDm(data);
    } finally {
      creating = false;
    }
  }

  // ── Info modal ────────────────────────────────────────────────────────────

  async function addGroupDmMember(): Promise<void> {
    if (!currentGroup) return;
    const uname = addMemberInput.trim();
    if (!uname) return;
    const found = (Array.from(friendsCache.values()) as { _id?: string; id?: string; username?: string }[])
      .find(f => f.username?.toLowerCase() === uname.toLowerCase());
    if (!found) { toast(`"${uname}" bulunamadı`, 'error'); return; }

    const r = await apiFetch(`${API()}/api/gdm/${currentGroup._id}/members`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: found._id ?? found.id }),
    });
    const data = await r.json() as { error?: string };
    if (!r.ok) { toast(data.error ?? 'Eklenemedi', 'error'); return; }
    toast(`${uname} gruba eklendi!`, 'success');
    addMemberInput = '';
    const gr = await apiFetch(`${API()}/api/gdm/${currentGroup._id}`);
    if (gr.ok) currentGroup = await gr.json() as GdmGroup;
  }

  async function kickGroupDmMember(userId: string, name: string): Promise<void> {
    if (!currentGroup) return;
    if (!confirm(`${name} kullanıcısını gruptan çıkarmak istediğinizden emin misiniz?`)) return;
    const r = await apiFetch(`${API()}/api/gdm/${currentGroup._id}/members/${userId}`, { method: 'DELETE' });
    const data = await r.json() as { error?: string };
    if (!r.ok) { toast(data.error ?? 'Çıkarılamadı', 'error'); return; }
    toast(`${name} gruptan çıkarıldı`, 'success');
    activeModal = null;
    await loadGroupDmList();
    const gr = await apiFetch(`${API()}/api/gdm/${currentGroup._id}`);
    if (gr.ok) currentGroup = await gr.json() as GdmGroup;
  }

  // ── Settings modal ────────────────────────────────────────────────────────

  function openSettings(): void {
    if (!currentGroup) return;
    settingsName = currentGroup.name;
    settingsIcon = currentGroup.icon ?? '';
    activeModal = 'settings';
  }

  async function saveGroupDmSettings(): Promise<void> {
    if (!currentGroup) return;
    if (!settingsName.trim()) { toast('Grup adı boş olamaz', 'error'); return; }
    saving = true;
    try {
      const r = await apiFetch(`${API()}/api/gdm/${currentGroup._id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: settingsName.trim(), icon: settingsIcon.trim() || null }),
      });
      const data = await r.json() as GdmGroup & { error?: string };
      if (!r.ok) { toast(data.error ?? 'Güncellenemedi', 'error'); return; }
      currentGroup = { ...currentGroup, name: settingsName.trim(), icon: settingsIcon.trim() || undefined };
      toast('Grup güncellendi', 'success');
      activeModal = null;
      await loadGroupDmList();
    } finally {
      saving = false;
    }
  }

  // ── Leave / delete ────────────────────────────────────────────────────────

  async function leaveGroupDm(): Promise<void> {
    if (!currentGroup) return;
    const isOwner = currentGroup.ownerId === me()?.id;
    const msg = isOwner
      ? 'Grubu dağıtmak istediğinizden emin misiniz? Tüm mesajlar silinecek.'
      : 'Gruptan ayrılmak istediğinizden emin misiniz?';
    if (!confirm(msg)) return;

    const r = isOwner
      ? await apiFetch(`${API()}/api/gdm/${currentGroup._id}`, { method: 'DELETE' })
      : await apiFetch(`${API()}/api/gdm/${currentGroup._id}/members/${me()?.id}`, { method: 'DELETE' });

    const data = await r.json() as { error?: string };
    if (!r.ok) { toast(data.error ?? 'İşlem başarısız', 'error'); return; }

    currentGroup = null;
    messages = [];
    toast(isOwner ? 'Grup dağıtıldı' : 'Gruptan ayrıldınız', 'success');
    await loadGroupDmList();
  }

  // ── GDM Voice (group-dm-voice.ts'e yönlendir) ─────────────────────────────

  async function startGdmCall(type: 'voice' | 'video'): Promise<void> {
    if (!currentGroup) return;

    // 1. Önce BridgeRegistry'de kayıtlı fonksiyon var mı kontrol et
    const registeredFn = BridgeRegistry.get('startGdmCall') as
      ((type: string, groupId: string) => void) | undefined;
    if (registeredFn) {
      registeredFn(type, currentGroup._id);
      return;
    }

    // 2. Yoksa group-dm-voice.ts'i dynamic import ile yükle
    if (!_gdmVoiceLoaded) {
      try {
        const mod = await import('./group-dm-voice.js') as Record<string, unknown>;
        // Modül yüklenince startGdmCall'u BridgeRegistry'e kaydetmesini bekle
        _gdmVoiceLoaded = true;
        // Kısa bekleme: module-level init tamamlansın
        await new Promise(r => setTimeout(r, 50));
        const fn = BridgeRegistry.get('startGdmCall') as
          ((type: string, groupId: string) => void) | undefined;
        if (fn) { fn(type, currentGroup._id); return; }
        // Modül BridgeRegistry kullanmıyorsa doğrudan window üzerinden dene
        const winFn = (window as Record<string, unknown>)['startGdmCall'] as
          ((type: string) => void) | undefined;
        winFn?.(type);
      } catch (err) {
        log.warn('[GroupDmPanel] group-dm-voice yüklenemedi:', err);
        toast('Sesli arama başlatılamadı', 'error');
      }
      return;
    }

    // 3. Yüklü ama kayıt yok — window fallback
    const winFn = (window as Record<string, unknown>)['startGdmCall'] as
      ((type: string) => void) | undefined;
    if (winFn) { winFn(type); return; }

    toast('Sesli arama modülü hazır değil', 'error');
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  onMount(() => {
    void loadGroupDmList();

    // Socket event'leri dinle
    const sock = socket();
    if (sock) {
      // Vanilla socket ile köprü: custom event yayınlanır
      window.addEventListener('bridge:gdm-message', (e: Event) => {
        _onGdmMessage((e as CustomEvent).detail as GdmMessage);
      });
      window.addEventListener('bridge:gdm-update', (e: Event) => {
        _onGdmUpdate((e as CustomEvent).detail as GdmGroup);
      });
    }

    // BridgeRegistry kayıtlar
    BridgeRegistry.register('groupDmPanel:openGroupDm',   openGroupDm);
    BridgeRegistry.register('groupDmPanel:loadList',      loadGroupDmList);
    BridgeRegistry.register('groupDmPanel:getCurrentGroup', () => currentGroup);
  });

  onDestroy(() => {
    window.removeEventListener('bridge:gdm-message', () => {});
    window.removeEventListener('bridge:gdm-update',  () => {});
    BridgeRegistry.unregister?.('groupDmPanel:openGroupDm');
    BridgeRegistry.unregister?.('groupDmPanel:loadList');
    BridgeRegistry.unregister?.('groupDmPanel:getCurrentGroup');
  });

  function messageTime(msg: GdmMessage): string {
    return new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
</script>

<div id="gdm-panel" class="gdm-panel">

  <!-- Sol: Grup listesi ────────────────────────────────────────────────── -->
  <div class="gdm-sidebar">
    <div class="gdm-sidebar-header">
      <span class="gdm-sidebar-title">💬 Grup DM</span>
      <button class="btn btn-sm" onclick={() => (activeModal = 'create')} title="Yeni Grup">+</button>
      {#if onClose}
        <button class="btn btn-sm" onclick={onClose} title="Kapat">✕</button>
      {/if}
    </div>

    {#if loading}
      <div class="gdm-loading">Yükleniyor…</div>
    {:else if groups.length === 0}
      <div class="gdm-empty">
        Grup DM yok.
        <button class="btn-link" onclick={() => (activeModal = 'create')}>Oluştur →</button>
      </div>
    {:else}
      <div id="gdm-list" class="gdm-list">
        {#each groups as g (g._id)}
          {@const isActive = currentGroup?._id === g._id}
          <!-- svelte-ignore a11y_click_events_have_key_events -->
          <div
            class="gdm-item"
            class:active={isActive}
            data-gid={g._id}
            role="button"
            tabindex="0"
            onclick={() => openGroupDm(g)}
            onkeydown={(e) => e.key === 'Enter' && openGroupDm(g)}
          >
            <div class="gdm-item-icon">{g.icon ?? '👥'}</div>
            <div class="gdm-item-body">
              <div class="gdm-item-name">{g.name}</div>
              <div class="gdm-item-preview">
                {#if g.lastMessage?.content}
                  {g.lastMessage.content.slice(0, 40)}
                {:else}
                  <span class="muted">Henüz mesaj yok</span>
                {/if}
              </div>
            </div>
            <div class="gdm-item-count muted">{g.memberCount ?? 0} üye</div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  <!-- Sağ: Sohbet alanı ───────────────────────────────────────────────── -->
  <div class="gdm-chat">
    {#if !currentGroup}
      <div class="gdm-placeholder">← Bir grup seç veya <button class="btn-link" onclick={() => (activeModal = 'create')}>yeni oluştur</button></div>
    {:else}
      <!-- Header -->
      <div id="dm-chat-header" class="gdm-header">
        <span class="gdm-header-icon">{currentGroup.icon ?? '👥'}</span>
        <span class="gdm-header-name">{currentGroup.name}</span>
        <span class="gdm-header-count muted">{currentGroup.memberCount ?? currentGroup.members?.length ?? 0} üye</span>
        <div class="gdm-header-actions">
          <button class="btn btn-sm gdm-call-btn" title="Sesli Arama" onclick={() => startGdmCall('voice')}>🎙️</button>
          <button class="btn btn-sm gdm-call-btn" title="Görüntülü Arama" onclick={() => startGdmCall('video')}>📹</button>
          <button class="btn btn-sm" title="Grup Bilgisi" onclick={() => (activeModal = 'info')}>ℹ️</button>
          {#if currentGroup.ownerId === me()?.id}
            <button class="btn btn-sm" title="Ayarlar" onclick={openSettings}>⚙️</button>
          {/if}
          <button class="btn btn-sm btn-danger" title={currentGroup.ownerId === me()?.id ? 'Grubu Dağıt' : 'Gruptan Ayrıl'} onclick={leaveGroupDm}>🚪</button>
        </div>
      </div>

      <!-- Mesajlar -->
      <div id="gdm-messages" class="gdm-messages">
        {#if msgLoading}
          <div class="gdm-loading">Mesajlar yükleniyor…</div>
        {:else}
          {#each messages as msg (msg._id ?? msg.createdAt)}
            {#if msg.type === 'system'}
              <div class="gdm-system-msg">{msg.content}</div>
            {:else}
              {@const isOwn = msg.userId === me()?.id}
              <div class="dm-msg" class:dm-own={isOwn}>
                <div class="dm-msg-avatar" style="background:{cssColor(msg.avatarColor)}">
                  {initials(msg.displayName)}
                </div>
                <div class="dm-msg-body">
                  <div class="dm-msg-header">
                    <span class="dm-msg-name">{msg.displayName}</span>
                    <span class="dm-msg-time">{messageTime(msg)}</span>
                  </div>
                  <!-- eslint-disable-next-line svelte/no-at-html-tags -->
                  <div class="dm-msg-text">{@html formatText(msg.content)}</div>
                </div>
              </div>
            {/if}
          {/each}
        {/if}
      </div>

      <!-- Input -->
      <div id="dm-input-area" class="gdm-input-area">
        <input
          type="text"
          id="dm-input"
          class="gdm-input"
          placeholder="{currentGroup.name} grubuna mesaj gönder…"
          maxlength="2000"
          bind:value={inputValue}
          onkeydown={(e) => e.key === 'Enter' && !e.shiftKey && sendGroupDm()}
        />
        <button class="btn btn-primary" onclick={sendGroupDm}>Gönder</button>
      </div>
    {/if}
  </div>
</div>

<!-- ── Create Modal ───────────────────────────────────────────────────── -->
{#if activeModal === 'create'}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-overlay" role="dialog" aria-modal="true" tabindex="-1"
    onclick={(e) => e.target === e.currentTarget && (activeModal = null)}>
    <div class="modal-card" style="max-width:420px;width:95%">
      <h2>👥 Yeni Grup DM</h2>
      <div class="form-group">
        <label for="gdm-name-input">Grup Adı</label>
        <input id="gdm-name-input" type="text" class="input-field" placeholder="Arkadaşlarım…" maxlength="64" bind:value={createName} />
      </div>
      <div class="form-group">
        <label for="gdm-icon-input">Emoji (opsiyonel)</label>
        <input id="gdm-icon-input" type="text" class="input-field" placeholder="👥" maxlength="4" style="width:80px" bind:value={createIcon} />
      </div>
      <div class="form-group">
        <label for="gdm-members-input">Üyeler (kullanıcı adı, virgülle ayır)</label>
        <input id="gdm-members-input" type="text" class="input-field" placeholder="ali, veli, …" bind:value={createMembers} />
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" disabled={creating} onclick={createGroupDm}>
          {creating ? 'Oluşturuluyor…' : 'Oluştur'}
        </button>
        <button class="btn" onclick={() => (activeModal = null)}>İptal</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Info Modal ─────────────────────────────────────────────────────── -->
{#if activeModal === 'info' && currentGroup}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-overlay" role="dialog" aria-modal="true" tabindex="-1"
    onclick={(e) => e.target === e.currentTarget && (activeModal = null)}>
    <div class="modal-card" style="max-width:360px;width:95%">
      <h2>{currentGroup.icon ?? '👥'} {currentGroup.name}</h2>
      <p class="muted" style="font-size:13px">
        {currentGroup.members?.length ?? 0} üye ·
        {currentGroup.ownerId === me()?.id ? 'Sen sahipsin' : 'Üyesin'}
      </p>

      <div class="gdm-member-list">
        {#each currentGroup.members ?? [] as member (member._id ?? member.id)}
          {@const memberId = member._id ?? member.id ?? ''}
          <div class="gdm-member-row">
            <div class="gdm-member-avatar" style="background:{cssColor(member.avatarColor)}">
              {initials(member.displayName)}
            </div>
            <span class="gdm-member-name">{member.displayName}</span>
            {#if memberId === currentGroup.ownerId}
              <span class="gdm-owner-badge">Sahip</span>
            {:else if currentGroup.ownerId === me()?.id}
              <button class="btn btn-sm btn-danger" onclick={() => kickGroupDmMember(memberId, member.displayName)}>Çıkar</button>
            {/if}
          </div>
        {/each}
      </div>

      {#if currentGroup.ownerId === me()?.id}
        <div style="margin-top:8px">
          <input type="text" id="gdm-add-member" class="input-field" placeholder="Kullanıcı adı ekle…" style="width:100%;margin-bottom:6px" bind:value={addMemberInput} />
          <button class="btn btn-primary" style="width:100%" onclick={addGroupDmMember}>+ Üye Ekle</button>
        </div>
      {/if}

      <div class="modal-footer">
        <button class="btn" onclick={() => (activeModal = null)}>Kapat</button>
      </div>
    </div>
  </div>
{/if}

<!-- ── Settings Modal ─────────────────────────────────────────────────── -->
{#if activeModal === 'settings' && currentGroup}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div class="modal-overlay" role="dialog" aria-modal="true" tabindex="-1"
    onclick={(e) => e.target === e.currentTarget && (activeModal = null)}>
    <div class="modal-card" style="max-width:380px;width:95%">
      <h2>⚙️ Grup Ayarları</h2>
      <div class="form-group">
        <label for="gdm-settings-name">Grup Adı</label>
        <input id="gdm-settings-name" type="text" class="input-field" maxlength="64" bind:value={settingsName} />
      </div>
      <div class="form-group">
        <label for="gdm-settings-icon">Emoji</label>
        <input id="gdm-settings-icon" type="text" class="input-field" maxlength="4" style="width:80px" bind:value={settingsIcon} />
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" disabled={saving} onclick={saveGroupDmSettings}>
          {saving ? 'Kaydediliyor…' : 'Kaydet'}
        </button>
        <button class="btn" onclick={() => (activeModal = null)}>İptal</button>
      </div>
    </div>
  </div>
{/if}

<style>
  .gdm-panel {
    display: flex;
    height: 100%;
    background: var(--bg-2, #2f3136);
    color: var(--text, #dcddde);
  }

  /* Sidebar */
  .gdm-sidebar {
    width: 220px;
    flex-shrink: 0;
    border-right: 1px solid var(--border, #40444b);
    display: flex;
    flex-direction: column;
    background: var(--bg-1, #202225);
  }
  .gdm-sidebar-header {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 10px 12px;
    border-bottom: 1px solid var(--border, #40444b);
    font-size: 13px;
    font-weight: 700;
  }
  .gdm-sidebar-title { flex: 1; }
  .gdm-list { overflow-y: auto; flex: 1; }
  .gdm-item {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 8px 12px;
    cursor: pointer;
    transition: background .1s;
    border-radius: 4px;
    margin: 2px 4px;
  }
  .gdm-item:hover, .gdm-item.active { background: var(--bg-hover, #4f545c); }
  .gdm-item-icon { font-size: 18px; flex-shrink: 0; }
  .gdm-item-body { flex: 1; min-width: 0; }
  .gdm-item-name { font-size: 13px; font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gdm-item-preview { font-size: 11px; color: var(--text-muted, #72767d); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .gdm-item-count { font-size: 10px; flex-shrink: 0; }
  .gdm-loading { padding: 16px; text-align: center; color: var(--text-muted, #72767d); font-size: 13px; }
  .gdm-empty { padding: 16px 12px; color: var(--text-muted, #72767d); font-size: 13px; }

  /* Chat */
  .gdm-chat {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .gdm-placeholder {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted, #72767d);
    font-size: 14px;
  }
  .gdm-header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 16px;
    border-bottom: 1px solid var(--border, #40444b);
    background: var(--bg-2, #2f3136);
  }
  .gdm-header-icon { font-size: 18px; }
  .gdm-header-name { font-weight: 700; font-size: 15px; }
  .gdm-header-count { font-size: 12px; }
  .gdm-header-actions { margin-left: auto; display: flex; gap: 6px; }
  .gdm-messages { flex: 1; overflow-y: auto; padding: 12px 16px; display: flex; flex-direction: column; gap: 4px; }
  .gdm-system-msg { text-align: center; color: var(--text-muted, #72767d); font-size: 12px; font-style: italic; padding: 4px 0; }
  .gdm-input-area { display: flex; gap: 8px; padding: 12px 16px; border-top: 1px solid var(--border, #40444b); }
  .gdm-input { flex: 1; background: var(--bg-3, #40444b); border: none; border-radius: 4px; padding: 8px 12px; color: var(--text, #dcddde); font-size: 14px; }
  .gdm-input:focus { outline: 2px solid var(--brand, #5865f2); }

  /* Messages */
  .dm-msg { display: flex; align-items: flex-start; gap: 8px; margin: 4px 0; }
  .dm-msg.dm-own { flex-direction: row-reverse; }
  .dm-msg-avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0; }
  .dm-msg-body { max-width: 70%; }
  .dm-msg-header { display: flex; gap: 6px; align-items: baseline; margin-bottom: 2px; }
  .dm-msg-name { font-size: 12px; font-weight: 700; }
  .dm-msg-time { font-size: 10px; color: var(--text-muted, #72767d); }
  .dm-msg-text { font-size: 14px; word-break: break-word; }

  /* Member list in info modal */
  .gdm-member-list { max-height: 240px; overflow-y: auto; margin: 12px 0; }
  .gdm-member-row { display: flex; align-items: center; gap: 8px; padding: 6px 0; border-bottom: 1px solid var(--border, #40444b); }
  .gdm-member-avatar { width: 32px; height: 32px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; color: #fff; flex-shrink: 0; }
  .gdm-member-name { flex: 1; font-size: 14px; }
  .gdm-owner-badge { font-size: 11px; background: var(--brand, #5865f2); color: #fff; border-radius: 3px; padding: 1px 5px; margin-left: auto; }

  /* Modals */
  .modal-overlay { position: fixed; inset: 0; z-index: 2000; background: rgba(0,0,0,.6); display: flex; align-items: center; justify-content: center; }
  .modal-card { background: var(--bg-2, #2f3136); border-radius: 8px; padding: 20px; }
  .form-group { margin-bottom: 14px; }
  .form-group label { display: block; font-size: 12px; font-weight: 600; margin-bottom: 4px; color: var(--text-muted, #72767d); text-transform: uppercase; }
  .input-field { width: 100%; background: var(--bg-3, #40444b); border: 1px solid var(--border, #40444b); border-radius: 4px; padding: 8px 10px; color: var(--text, #dcddde); font-size: 14px; box-sizing: border-box; }
  .modal-footer { display: flex; gap: 8px; margin-top: 16px; justify-content: flex-end; }

  /* Misc */
  .muted { color: var(--text-muted, #72767d); }
  .btn-link { background: none; border: none; color: var(--brand, #5865f2); cursor: pointer; font-size: 13px; padding: 0; }
  .btn-link:hover { text-decoration: underline; }
  .btn { background: var(--bg-3, #40444b); border: none; border-radius: 4px; padding: 6px 12px; color: var(--text, #dcddde); cursor: pointer; font-size: 13px; }
  .btn:hover { background: var(--bg-hover, #4f545c); }
  .btn:disabled { opacity: .6; cursor: not-allowed; }
  .btn-primary { background: var(--brand, #5865f2); color: #fff; }
  .btn-primary:hover { background: var(--brand-hover, #4752c4); }
  .btn-danger { background: var(--danger, #ed4245); color: #fff; }
  .btn-sm { padding: 3px 8px; font-size: 12px; }
</style>
