<script lang="ts">
  import { t, localeTag} from '../core/i18n/reactive.svelte.ts';
  // client/js/admin/AdminPanel.svelte
  // Sprint 118: Admin paneli vanilla TS (10 dosya) → tek Svelte 5 Runes bileşeni
  // Kapsam: stats, users, servers, ip-bans, logs, broadcast, reaction-roles, marketplace
  // ADR-0008: BridgeRegistry üzerinden servis erişimi

  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from '../core/bridge-registry.ts';
  import { apiFetch as canonicalApiFetch } from '../core/api-fetch.ts';
  import { getAPI } from '../core/globals.ts';
  import { ApiResponseError, safeApiErrorMessage } from '../core/api-error.ts';
  import { confirmProductAction } from '../core/product-dialog.ts';
  import { focusTrap } from '../core/a11y/focusTrap.ts';

  // ── Servis alıcıları (ADR-0008 sınır kuralı) ──────────────────
  const apiFetch = canonicalApiFetch;
  const toast = (msg: string, type: string): void => { void BridgeRegistry.call('toast', msg, type); };
  const API = getAPI();

  // ── State ──────────────────────────────────────────────────────
  type Tab = 'stats' | 'users' | 'servers' | 'ip-bans' | 'logs' | 'broadcast' | 'reaction-roles' | 'marketplace';

  let activeTab = $state<Tab>('stats');
  let loading   = $state(false);
  let error     = $state('');

  // Stats
  interface StatsData {
    totals: { totalUsers: number; totalServers: number; totalMessages: number; totalDMs: number;
               onlineUsers: number; verifiedEmails: number; twoFaEnabled: number; newUsers7d: number };
    msgsByDay: { day: number; n: number }[];
    topServers: { name: string; memberCount: number }[];
    topUsers: { displayName: string; msgCount: number }[];
  }
  let stats = $state<StatsData | null>(null);

  // Users
  interface AdminUser {
    _id: string; displayName: string; username: string;
    email?: string; emailVerified: boolean; isAdmin: boolean;
    twoFactorEnabled: boolean; createdAt: number;
  }
  let users         = $state<AdminUser[]>([]);
  let userTotal     = $state(0);
  let userPage      = $state(1);
  let userPages     = $state(1);
  let userQuery     = $state('');
  let userSearchDraft = $state('');

  // Servers
  interface AdminServer { _id: string; name: string; memberCount: number; discoverable: boolean; createdAt: number }
  let servers = $state<AdminServer[]>([]);

  // IP Bans
  interface IpBan { ip: string; reason?: string; bannedAt: number; expiresAt?: number | null }
  let bans         = $state<IpBan[]>([]);
  let banIp        = $state('');
  let banReason    = $state('');
  let banDuration  = $state('');

  // Logs
  interface LogEntry { ts: number; level: string; msg: string; event?: string }
  let logs     = $state<LogEntry[]>([]);
  let logLevel = $state('');

  // Broadcast
  let broadcastMsg = $state('');

  // Reaction Roles
  interface ReactionRule { _id: string; serverId: string; channelId: string; messageId: string; emoji: string; roleId: string }
  let reactionRules  = $state<ReactionRule[]>([]);
  let rrServerId     = $state('');
  let rrChannelId    = $state('');
  let rrMessageId    = $state('');
  let rrEmoji        = $state('');
  let rrRoleId       = $state('');

  // Marketplace
  interface BotEntry { _id: string; name: string; description: string; isFeatured: boolean; createdAt: number }
  let bots       = $state<BotEntry[]>([]);
  let botQuery   = $state('');
  let botSearchDraft = $state('');
  let newBotName = $state('');
  let newBotDesc = $state('');
  let newBotToken= $state('');

  // ── Tab meta ──────────────────────────────────────────────────
  const TABS: { id: Tab; icon: string; label: string }[] = $derived.by(() => [
    { id: 'stats',          icon: '📊', label: t("ui_istatistik", "İstatistik")   },
    { id: 'users',          icon: '👥', label: t("ui_kullanicilar", "Kullanıcılar") },
    { id: 'servers',        icon: '🖥️', label: t('servers', 'Sunucular') },
    { id: 'ip-bans',        icon: '🚫', label: t("ui_ip_yasaklari", "IP Yasakları") },
    { id: 'logs',           icon: '📋', label: t('admin_logs', 'Loglar') },
    { id: 'broadcast',      icon: '📢', label: t('admin_broadcast', 'Duyuru') },
    { id: 'reaction-roles', icon: '⚡', label: t("ui_reaction_rol", "Reaction Rol") },
    { id: 'marketplace',    icon: '🛒', label: 'Marketplace' },
  ]);

  // ── Utils ─────────────────────────────────────────────────────
  function fmtDate(ts: number | null | undefined): string {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString(localeTag(), { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtTime(ts: number | null | undefined): string {
    if (!ts) return '—';
    return new Date(ts).toLocaleString(localeTag());
  }
  function n(v: number | null | undefined) {
    return typeof v === 'number' ? v.toLocaleString(localeTag()) : '—';
  }

  // ── Data loaders ──────────────────────────────────────────────
  async function loadTab(tab: Tab) {
    activeTab = tab;
    loading = true;
    error = '';
    try {
      if (tab === 'stats')           await fetchStats();
      if (tab === 'users')           await fetchUsers();
      if (tab === 'servers')         await fetchServers();
      if (tab === 'ip-bans')         await fetchBans();
      if (tab === 'logs')            await fetchLogs();
      if (tab === 'reaction-roles')  await fetchReactionRoles();
      if (tab === 'marketplace')     await fetchBots();
    } catch (e) {
      error = safeApiErrorMessage(e, t("ui_admin_verileri_yuklenemedi", "Admin verileri yüklenemedi."), { report: true });
    } finally {
      loading = false;
    }
  }

  async function fetchStats() {
    const r = await apiFetch(`${API}/api/admin/stats`);
    if (!r.ok) throw new ApiResponseError(r);
    stats = await r.json();
  }

  async function fetchUsers(q = userQuery, page = userPage) {
    userQuery = q;
    userPage = page;
    const params = new URLSearchParams({ q, page: String(page), limit: '30' });
    const r = await apiFetch(`${API}/api/admin/users?${params}`);
    if (!r.ok) throw new ApiResponseError(r);
    const data = await r.json();
    users     = data.users;
    userTotal = data.total;
    userPages = data.pages || 1;
  }

  async function fetchServers() {
    const r = await apiFetch(`${API}/api/admin/servers`);
    if (!r.ok) throw new ApiResponseError(r);
    servers = await r.json();
  }

  async function fetchBans() {
    const r = await apiFetch(`${API}/api/admin/ip-bans`);
    if (!r.ok) throw new ApiResponseError(r);
    bans = await r.json();
  }

  async function fetchLogs() {
    const params = logLevel ? `?level=${logLevel}` : '';
    const r = await apiFetch(`${API}/api/admin/logs${params}`);
    if (!r.ok) throw new ApiResponseError(r);
    logs = await r.json();
  }

  async function fetchReactionRoles() {
    const r = await apiFetch(`${API}/api/admin/reaction-roles`);
    if (!r.ok) throw new ApiResponseError(r);
    reactionRules = await r.json();
  }

  async function fetchBots(q = botQuery) {
    botQuery = q;
    const params = q ? `?q=${encodeURIComponent(q)}` : '';
    const r = await apiFetch(`${API}/api/admin/marketplace${params}`);
    if (!r.ok) throw new ApiResponseError(r);
    bots = await r.json();
  }

  // ── AĞ REDDİ SESSİZ KALMAZ ────────────────────────────────────
  // ÖLÇÜLEN KUSUR: `apiFetch` bir ağ hatasında REDDEDER (alttaki `fetch`
  // reject'i yukarı taşınır; api-fetch.ts'te üst düzey try/catch yoktur).
  // Yükleyiciler `loadTab` içindeki try/catch ile korunuyordu, ama MUTASYON
  // işleyicilerinin hiçbiri korunmuyordu: çevrimdışı bir yönetici "Sil"e
  // bastığında istek gitmiyor, hiçbir bildirim çıkmıyor ve hata yalnızca
  // yakalanmamış bir promise reddi olarak kayboluyordu — yani panel sessizce
  // "hiçbir şey olmadı" diyordu.
  //
  // `handled` her mutasyonu sarar: HTTP hatası zaten her işleyicinin kendi
  // dalında bildiriliyor; buradaki catch yalnızca TAŞIMA katmanı çöktüğünde
  // devreye girer ve kullanıcıya güvenli, çevrilmiş bir mesaj gösterir.
  async function handled(fallback: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (cause) {
      toast(safeApiErrorMessage(cause, fallback, { report: true }), 'error');
    }
  }

  // ── User actions ──────────────────────────────────────────────
  async function toggleAdmin(userId: string, makeAdmin: boolean) {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      const r = await apiFetch(`${API}/api/admin/users/${userId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAdmin: makeAdmin }),
      });
      if (r.ok) { toast(makeAdmin ? t('adm_admin_given') : t('adm_admin_granted', 'Admin yetkisi alındı'), 'success'); await fetchUsers(); }
      else toast(t('adm_op_failed', 'İşlem başarısız'), 'error');
    });
  }

  async function deleteUser(userId: string, username: string) {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!await confirmProductAction({
        title: t("adm_delete_user", "Kullanıcıyı sil"),
        message: t('adm_delete_user_q', '@{user} kullanıcısı ve tüm verileri kalıcı olarak silinsin mi?\n\nBu işlem geri alınamaz!', { user: username }),
        confirmLabel: t("ui_kalici_olarak_sil", "Kalıcı olarak sil"),
        tone: 'danger',
      })) return;
      const r = await apiFetch(`${API}/api/admin/users/${userId}`, { method: 'DELETE' });
      if (r.ok) { toast(t('admin_user_deleted', '@{username} silindi', { username }), 'success'); await fetchUsers(); return; }
      // Final21 Faz 19: sunucu kanonik politikayı uygular; başka üyeleri olan sunucunun/grup
      // sohbetinin sahibi SİLİNMEZ (409). Yönetici nedenini görmeli, genel bir hata değil.
      if (r.status === 409) {
        const body = await r.json().catch(() => ({})) as { blockers?: unknown[] };
        toast(t('admin_user_delete_blocked', undefined, { user: username, count: Array.isArray(body.blockers) ? body.blockers.length : 1 }), 'error');
        return;
      }
      toast(t('common_delete_failed'), 'error');
    });
  }

  // ── Server actions ────────────────────────────────────────────
  async function deleteServer(sid: string, name: string) {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!await confirmProductAction({
        title: t("ui_sunucuyu_sil", "Sunucuyu sil"),
        message: t('adm_delete_srv_q', '"{name}" sunucusu ve tüm içeriği kalıcı olarak silinsin mi?\n\nBu işlem geri alınamaz!', { name }),
        confirmLabel: t("ui_kalici_olarak_sil", "Kalıcı olarak sil"),
        tone: 'danger',
      })) return;
      const r = await apiFetch(`${API}/api/admin/servers/${sid}`, { method: 'DELETE' });
      if (r.ok) { toast(t('admin_item_deleted', '"{name}" silindi', { name }), 'success'); await fetchServers(); }
      else toast(t('common_delete_failed'), 'error');
    });
  }

  // ── IP ban actions ────────────────────────────────────────────
  async function addIpBan() {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!banIp.trim()) return toast('IP adresi zorunlu', 'error');
      const durationMs = banDuration === '' ? null : Number(banDuration);
      if (durationMs !== null && (!Number.isSafeInteger(durationMs) || durationMs <= 0)) {
        return toast(t('adm_invalid_ban_duration', 'Invalid ban duration'), 'error');
      }
      const r = await apiFetch(`${API}/api/admin/ip-bans`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ip: banIp.trim(), reason: banReason.trim() || 'Admin ban', durationMs }),
      });
      if (!r.ok) return toast(safeApiErrorMessage(r, t("ui_yasak_eklenemedi", "Yasak eklenemedi."), { report: true }), 'error');
      toast(t('adm_ip_banned', '{ip} yasaklandı 🚫', { ip: banIp }), 'success');
      banIp = ''; banReason = ''; banDuration = '';
      await fetchBans();
    });
  }

  async function removeIpBan(ip: string) {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!await confirmProductAction({
        title: t("ui_ip_yasagini_kaldir", "IP yasağını kaldır"),
        message: t('adm_ip_unban_q', '{ip} adresinin yasağı kaldırılsın mı?', { ip }),
        confirmLabel: t("mod_unban", "Yasağı kaldır"),
      })) return;
      const r = await apiFetch(`${API}/api/admin/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
      if (r.ok) { toast(t('adm_ip_unbanned', '{ip} yasağı kaldırıldı ✅', { ip }), 'success'); await fetchBans(); }
      else toast(t('dsc_remove_failed', 'Kaldırılamadı'), 'error');
    });
  }

  // ── Broadcast ─────────────────────────────────────────────────
  async function sendBroadcast() {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!broadcastMsg.trim()) return toast(t('adm_msg_empty', 'Mesaj boş olamaz'), 'error');
      const r = await apiFetch(`${API}/api/admin/broadcast`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: broadcastMsg.trim() }),
      });
      if (r.ok) { toast(t('adm_announced', '📢 Duyuru gönderildi'), 'success'); broadcastMsg = ''; }
      else toast(t('thr_send_failed', 'Gönderilemedi'), 'error');
    });
  }

  // ── Reaction roles ────────────────────────────────────────────
  async function addReactionRole() {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!rrServerId || !rrChannelId || !rrMessageId || !rrEmoji || !rrRoleId)
        return toast(t('adm_all_required', 'Tüm alanlar zorunlu'), 'error');
      const r = await apiFetch(`${API}/api/admin/reaction-roles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ serverId: rrServerId, channelId: rrChannelId,
                               messageId: rrMessageId, emoji: rrEmoji, roleId: rrRoleId }),
      });
      if (r.ok) {
        toast(t("ui_reaction_rol_eklendi", "⚡ Reaction rol eklendi"), 'success');
        rrServerId = rrChannelId = rrMessageId = rrEmoji = rrRoleId = '';
        await fetchReactionRoles();
      } else toast(t('common_add_failed'), 'error');
    });
  }

  async function deleteReactionRule(ruleId: string) {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!await confirmProductAction({
        title: t("ui_reaction_rol_kuralini_sil", "Reaction rol kuralını sil"),
        message: t('adm_rr_delete_q', 'Bu reaction rol kuralı silinsin mi?'),
        confirmLabel: t("adm_delete_rule", "Kuralı sil"),
        tone: 'danger',
      })) return;
      const r = await apiFetch(`${API}/api/admin/reaction-roles/${ruleId}`, { method: 'DELETE' });
      if (r.ok) { toast(t("ui_kural_silindi", "Kural silindi"), 'success'); await fetchReactionRoles(); }
      else toast(t('common_delete_failed'), 'error');
    });
  }

  // ── Marketplace actions ───────────────────────────────────────
  async function toggleFeatured(botId: string, featured: boolean) {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      const r = await apiFetch(`${API}/api/admin/marketplace/${botId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isFeatured: featured }),
      });
      if (r.ok) { toast(featured ? t('adm_featured_on', '⭐ Öne çıkarıldı') : t('adm_featured_off', 'Öne çıkarma kaldırıldı'), 'success'); await fetchBots(); }
      else toast(t('adm_update_failed', 'Güncellenemedi'), 'error');
    });
  }

  async function deleteBot(botId: string, name: string) {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!await confirmProductAction({
        title: t("ui_marketplace_botunu_sil", "Marketplace botunu sil"),
        message: t('adm_bot_delete_q', undefined, { name }),
        confirmLabel: t("ui_botu_sil", "Botu sil"),
        tone: 'danger',
      })) return;
      const r = await apiFetch(`${API}/api/admin/marketplace/${botId}`, { method: 'DELETE' });
      if (r.ok) { toast(t('admin_item_deleted', '"{name}" silindi', { name }), 'success'); await fetchBots(); }
      else toast(t('common_delete_failed'), 'error');
    });
  }

  async function addBot() {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      if (!newBotName.trim()) return toast(t('adm_bot_name_req', 'Bot adı zorunlu'), 'error');
      const r = await apiFetch(`${API}/api/admin/marketplace`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newBotName.trim(), description: newBotDesc.trim(), token: newBotToken.trim() }),
      });
      if (r.ok) {
        toast(t('admin_bot_added', 'Bot eklendi ✅'), 'success');
        newBotName = newBotDesc = newBotToken = '';
        await fetchBots();
      } else toast(t('admin_bot_add_failed'), 'error');
    });
  }

  async function refreshMarketplace() {
    await handled(t('adm_op_failed', 'İşlem başarısız'), async () => {
      const r = await apiFetch(`${API}/api/admin/marketplace/refresh`, { method: 'POST' });
      if (r.ok) { toast(t('admin_marketplace_refreshed'), 'success'); await fetchBots(); }
      else toast(t('common_refresh_failed'), 'error');
    });
  }

  // ── Canvas chart ──────────────────────────────────────────────
  let chartCanvas = $state<HTMLCanvasElement | null>(null);

  $effect(() => {
    if (activeTab === 'stats' && stats?.msgsByDay && chartCanvas) {
      drawMsgChart(chartCanvas, stats.msgsByDay);
    }
  });

  function drawMsgChart(canvas: HTMLCanvasElement, msgsByDay: { day: number; n: number }[]) {
    const ctx = canvas.getContext('2d');
    if (!ctx || !msgsByDay?.length) return;
    const dpr = window.devicePixelRatio || 1;
    const W   = Math.max(200, (canvas.parentElement?.clientWidth ?? 400) - 40);
    const H   = 120;
    canvas.width  = W * dpr; canvas.height = H * dpr;
    canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
    ctx.scale(dpr, dpr);
    const vals = msgsByDay.map(d => d.n);
    const max  = Math.max(...vals, 1);
    const PAD  = { t: 10, b: 26, l: 10, r: 10 };
    const cH   = H - PAD.t - PAD.b;
    const step = (W - PAD.l - PAD.r) / vals.length;
    const BAR  = Math.max(4, step - 4);
    ctx.strokeStyle = '#1e1e38'; ctx.lineWidth = 1;
    [0.25, 0.5, 0.75, 1].forEach(f => {
      const y = PAD.t + cH * (1 - f);
      ctx.beginPath(); ctx.moveTo(PAD.l, y); ctx.lineTo(W - PAD.r, y); ctx.stroke();
    });
    vals.forEach((v, i) => {
      const x  = PAD.l + i * step + (step - BAR) / 2;
      const bh = Math.max(2, (v / max) * cH);
      const y  = PAD.t + cH - bh;
      const g  = ctx.createLinearGradient(0, y, 0, y + bh);
      g.addColorStop(0, '#8892f8'); g.addColorStop(1, '#4a52c8');
      ctx.fillStyle = g;
      ctx.fillRect(x, y, BAR, bh);
    });
    ctx.fillStyle = '#555'; ctx.font = '10px sans-serif'; ctx.textAlign = 'center';
    const today = Math.floor(Date.now() / 86400000);
    vals.forEach((_, i) => {
      const d     = msgsByDay[i].day - today;
      const label = d === 0 ? t("ui_bugun", "Bugün") : d === -1 ? t("ui_dun", "Dün") : `${d}g`;
      ctx.fillText(label, PAD.l + i * step + step / 2, H - 8);
    });
  }

  // ── Debounce for search ───────────────────────────────────────
  let userSearchTimer: ReturnType<typeof setTimeout> | null = null;
  function onUserSearch(q: string) {
    userSearchDraft = q;
    if (userSearchTimer) clearTimeout(userSearchTimer);
    userSearchTimer = setTimeout(() => fetchUsers(q, 1), 200);
  }

  let botSearchTimer: ReturnType<typeof setTimeout> | null = null;
  function onBotSearch(q: string) {
    botSearchDraft = q;
    if (botSearchTimer) clearTimeout(botSearchTimer);
    botSearchTimer = setTimeout(() => fetchBots(q), 200);
  }

  onMount(() => loadTab('stats'));
  onDestroy(() => {
    if (userSearchTimer) clearTimeout(userSearchTimer);
    if (botSearchTimer) clearTimeout(botSearchTimer);
  });
</script>

<!-- ── Shell ──────────────────────────────────────────────────── -->
<div class="admin-overlay" role="dialog" aria-modal="true" tabindex="-1" aria-label={t('markup_admin_paneli_558cee8', "Admin Paneli")} use:focusTrap={{ active: true, initialFocus: 'button.admin-close-btn' }} onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); BridgeRegistry.call('closeAdminDashboard'); } }}>
  <div class="admin-shell">

    <!-- Sidebar -->
    <aside class="admin-sidebar">
      <div class="admin-sidebar-header">
        <span class="admin-sidebar-icon" aria-hidden="true">🛡️</span>
        <div>
          <div class="admin-sidebar-title">{t('markup_admin_paneli_558cee8', "Admin Paneli")}</div>
          <div class="admin-sidebar-sub">Bridge</div>
        </div>
      </div>
      <nav class="admin-nav" aria-label={t('attr_admin_sekmeleri_6552c09', "Admin sekmeleri")}>
        {#each TABS as tab}
          <button
            class="admin-nav-btn"
            class:active={activeTab === tab.id}
            aria-current={activeTab === tab.id ? 'page' : undefined}
            onclick={() => loadTab(tab.id)}
          >
            <span aria-hidden="true">{tab.icon}</span>
            <span>{tab.label}</span>
          </button>
        {/each}
      </nav>
      <div class="admin-sidebar-footer">
        <button class="admin-close-btn" onclick={() => void BridgeRegistry.call('closeAdminDashboard')}>
          {t('close')}
        </button>
      </div>
    </aside>

    <!-- Content -->
    <main class="admin-content" id="admin-content">
      {#if loading}
        <div class="admin-loading" aria-live="polite">{t('mod_loading', 'Yükleniyor…')}</div>
      {:else if error}
        <div class="admin-error" role="alert">⚠️ {error}</div>

      {:else if activeTab === 'stats' && stats}
        <!-- ── Stats ─────────────────────────────────────────── -->
        <h2 class="section-title">{t('adm_general_stats', '📊 Genel İstatistikler')}</h2>
        <div class="stat-grid">
          {#each [
            { icon: '👥', label: t("surface_toplam_kullan_c_4defaa"), val: stats.totals.totalUsers,    color: '#8892f8' },
            { icon: '🖥️', label: t("surface_toplam_sunucu_a34936"),    val: stats.totals.totalServers,  color: '#8892f8' },
            { icon: '💬', label: t("surface_toplam_mesaj_822dcb"),      val: stats.totals.totalMessages, color: '#2ecc9a' },
            { icon: '📨', label: t("surface_toplam_dm_ad180c"),         val: stats.totals.totalDMs,      color: '#2ecc9a' },
            { icon: '🟢', label: t("online"),         val: stats.totals.onlineUsers,   color: '#2ecc9a' },
            { icon: '📧', label: t("surface_e_posta_dogrul_a635db"),   val: stats.totals.verifiedEmails,color: '#faa61a' },
            { icon: '🔐', label: '2FA Aktif',         val: stats.totals.twoFaEnabled,  color: '#faa61a' },
            { icon: '🆕', label: t("surface_bu_hafta_kay_t_7a91e5"),    val: stats.totals.newUsers7d,    color: '#2d9cdb' },
          ] as item}
            <div class="stat-card">
              <div class="stat-label"><span>{item.icon}</span><span>{item.label}</span></div>
              <div class="stat-value" style="color:{item.color}">{n(item.val)}</div>
            </div>
          {/each}
        </div>
        <div class="card" style="margin-bottom:28px">
          <div class="card-label">{t('adm_msg_traffic_7d', '📈 Son 7 Günlük Mesaj Trafiği')}</div>
          <canvas bind:this={chartCanvas} height="120" style="width:100%;display:block"></canvas>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div class="card">
            <div class="card-label">{t('adm_biggest_servers', '🏆 En Büyük Sunucular')}</div>
            {#each stats.topServers as s, i}
              <div class="row-item">
                <span class="row-label">{i+1}. {s.name}</span>
                <span style="color:#8892f8;font-weight:600">{t("ui_member_count", undefined, { count: n(s.memberCount) })}</span>
              </div>
            {:else}
              <div class="empty">{t('markup_sunucu_yok_0a6c1da', "Sunucu yok")}</div>
            {/each}
          </div>
          <div class="card">
            <div class="card-label">{t('adm_most_active_30d', '💬 En Aktif Kullanıcılar (30 gün)')}</div>
            {#each stats.topUsers as u, i}
              <div class="row-item">
                <span class="row-label">{i+1}. {u.displayName}</span>
                <span style="color:#2ecc9a;font-weight:600">{n(u.msgCount)} msg</span>
              </div>
            {:else}
              <div class="empty">{t('markup_veri_yok_84eb31e', "Veri yok")}</div>
            {/each}
          </div>
        </div>

      {:else if activeTab === 'users'}
        <!-- ── Users ──────────────────────────────────────────── -->
        <h2 class="section-title">{t('adm_users_heading', '👥 Kullanıcılar')}</h2>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          <input
            class="search-input"
            placeholder={t('adm_search_users_ph', 'Kullanıcı adı, e-posta ara…')}
            value={userSearchDraft}
            oninput={(e) => onUserSearch((e.target as HTMLInputElement).value)}
            aria-label={t('adm_search_users', 'Kullanıcı ara')}
          />
          <span class="muted-count">{t("ui_user_count", undefined, { count: n(userTotal) })}</span>
        </div>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>{t('mod_user', 'Kullanıcı')}</th><th>{t('markup_e_posta_0ff610b', "E-posta")}</th><th>2FA</th><th>Admin</th><th>{t('adm_registered', 'Kayıt')}</th><th style="text-align:right">{t('adm_actions', 'İşlemler')}</th>
              </tr>
            </thead>
            <tbody>
              {#each users as u}
                <tr>
                  <td>
                    <div class="user-name">{u.displayName}</div>
                    <div class="user-handle">@{u.username}</div>
                  </td>
                  <td class="tc">
                    {#if u.email}
                      <span title={u.email}>{u.emailVerified ? '✅' : '⚠️'}</span>
                    {:else}
                      <span class="muted">—</span>
                    {/if}
                  </td>
                  <td class="tc">{#if u.twoFactorEnabled}🔐{:else}<span class="muted">—</span>{/if}</td>
                  <td class="tc">{u.isAdmin ? '⭐' : '—'}</td>
                  <td class="tc muted nowrap">{fmtDate(u.createdAt)}</td>
                  <td style="text-align:right">
                    <div class="action-row">
                      <button
                        class="btn-action"
                        class:danger={u.isAdmin}
                        onclick={() => toggleAdmin(u._id, !u.isAdmin)}
                      >{u.isAdmin ? '⬇ Yetkiyi Al' : '⬆ Admin Yap'}</button>
                      <button class="btn-icon-danger" onclick={() => deleteUser(u._id, u.username)} aria-label={t('adm_delete_user', 'Kullanıcıyı sil')}>🗑</button>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="6" class="empty">{t('adm_no_users', 'Kullanıcı bulunamadı')}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="pagination" aria-label="Sayfalama">
          {#if userPage > 1}
            <button class="btn-page" onclick={() => fetchUsers(userQuery, userPage - 1)}>{t('adm_prev', '← Önceki')}</button>
          {/if}
          <span class="muted">{userPage} / {userPages}</span>
          {#if userPage < userPages}
            <button class="btn-page" onclick={() => fetchUsers(userQuery, userPage + 1)}>{t('markup_sonraki_acceaf9', "Sonraki →")}</button>
          {/if}
        </div>

      {:else if activeTab === 'servers'}
        <!-- ── Servers ─────────────────────────────────────────── -->
        <h2 class="section-title">🖥️ {t('servers', 'Sunucular')} ({n(servers.length)})</h2>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>{t('cp_category_server')}</th><th>{t('adm_members', 'Üyeler')}</th><th>{t('adm_discover', 'Keşif')}</th><th>{t('adm_created', 'Oluşturulma')}</th><th style="text-align:right">{t('adm_action', 'İşlem')}</th></tr>
            </thead>
            <tbody>
              {#each servers as s}
                <tr>
                  <td>
                    <div class="user-name">{s.name}</div>
                    <div class="mono muted">{s._id}</div>
                  </td>
                  <td class="tc" style="color:#8892f8;font-weight:600">{n(s.memberCount)}</td>
                  <td class="tc">{s.discoverable ? '✅' : '—'}</td>
                  <td class="tc muted nowrap">{fmtDate(s.createdAt)}</td>
                  <td style="text-align:right">
                    <button class="btn-icon-danger" onclick={() => deleteServer(s._id, s.name)}>{t('delete')}</button>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="5" class="empty">{t('markup_sunucu_yok_0a6c1da', "Sunucu yok")}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>

      {:else if activeTab === 'ip-bans'}
        <!-- ── IP Bans ─────────────────────────────────────────── -->
        <h2 class="section-title">{t('adm_ip_bans', '🚫 IP Yasakları')}</h2>
        <div class="card" style="margin-bottom:24px">
          <div class="card-label">{t('adm_new_ip_ban', '➢ Yeni IP Yasağı')}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
            <label class="field-label">
              {t('markup_ip_adresi_62003eb', "IP Adresi *")}
              <input class="field-input" bind:value={banIp} placeholder="192.168.1.1 veya ::1" maxlength="45" />
            </label>
            <label class="field-label">
              {t('reason')}
              <input class="field-input" bind:value={banReason} placeholder="Spam, brute force…" maxlength="200" />
            </label>
            <label class="field-label">
              {t('duration')}
              <select class="field-input" bind:value={banDuration}>
                <option value="">{t('adm_permanent', 'Kalıcı')}</option>
                <option value="3600000">{t('ui_1_saat')}</option>
                <option value="86400000">{t('adm_one_day', '1 Gün')}</option>
                <option value="604800000">{t('markup_1_hafta_e3401e1', "1 Hafta")}</option>
                <option value="2592000000">{t('adm_thirty_days', '30 Gün')}</option>
              </select>
            </label>
          </div>
          <button class="btn-primary" onclick={addIpBan}>{t('markup_yasak_ekle_47c5664', "🚫 Yasak Ekle")}</button>
        </div>
        <div class="muted" style="font-weight:600;margin-bottom:12px">Aktif Yasaklar ({bans.length})</div>
        {#if bans.length}
          <div class="table-wrap">
            <table class="admin-table">
              <thead>
                <tr><th>IP</th><th>{t('reason')}</th><th>{t('markup_tarih_6ddab1b', "Tarih")}</th><th>{t('cperm_end', 'Bitiş')}</th><th style="text-align:right">{t('adm_action', 'İşlem')}</th></tr>
              </thead>
              <tbody>
                {#each bans as b}
                  {@const expired = b.expiresAt && b.expiresAt <= Date.now()}
                  <tr>
                    <td class="mono" style="color:#2d9cdb;font-weight:600">{b.ip}</td>
                    <td class="muted">{b.reason || '—'}</td>
                    <td class="muted nowrap">{fmtTime(b.bannedAt)}</td>
                    <td class="nowrap">
                      {#if !b.expiresAt}
                        <span style="color:#faa61a">{t('adm_permanent', 'Kalıcı')}</span>
                      {:else if expired}
                        <span style="color:#e55">{t('adm_expired', 'Süresi Doldu')}</span>
                      {:else}
                        <span class="muted">{fmtTime(b.expiresAt)}</span>
                      {/if}
                    </td>
                    <td style="text-align:right">
                      <button class="btn-success" onclick={() => removeIpBan(b.ip)}>{t('adm_remove_ok', '✅ Kaldır')}</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty">{t('adm_no_ip_bans', 'Aktif IP yasağı yok')}</div>
        {/if}

      {:else if activeTab === 'logs'}
        <!-- ── Logs ────────────────────────────────────────────── -->
        <h2 class="section-title">{t('markup_loglar_e75839f', "📋 Loglar")}</h2>
        <div style="display:flex;gap:12px;margin-bottom:18px;align-items:center">
          <select class="field-input" style="max-width:180px" bind:value={logLevel}
            onchange={fetchLogs}>
            <option value="">{t('adm_all_levels', 'Tüm Seviyeler')}</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
          <button class="btn-page" onclick={fetchLogs}>{t('markup_yenile_3e186b7', "🔄 Yenile")}</button>
        </div>
        {#if logs.length}
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>{t('markup_zaman_444dff3', "Zaman")}</th><th>{t('markup_seviye_9a0ffa2', "Seviye")}</th><th>Event</th><th>{t('message')}</th></tr></thead>
              <tbody>
                {#each logs as l}
                  <tr>
                    <td class="muted nowrap mono" style="font-size:11px">{fmtTime(l.ts)}</td>
                    <td>
                      <span class="log-badge log-{l.level}">{l.level.toUpperCase()}</span>
                    </td>
                    <td class="muted mono" style="font-size:11px">{l.event || '—'}</td>
                    <td style="font-size:13px;color:#ccc">{l.msg}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty">{t('adm_no_logs', 'Log bulunamadı')}</div>
        {/if}

      {:else if activeTab === 'broadcast'}
        <!-- ── Broadcast ───────────────────────────────────────── -->
        <h2 class="section-title">{t('markup_sistem_duyurusu_300c33d', "📢 Sistem Duyurusu")}</h2>
        <div class="card" style="max-width:600px">
          <div class="card-label">{t('adm_broadcast_hint', 'Tüm bağlı kullanıcılara sistem mesajı gönder')}</div>
          <textarea
            class="broadcast-textarea"
            bind:value={broadcastMsg}
            placeholder={t('attr_duyuru_metni_e2e300a', "Duyuru metni…")}
            rows="5"
            aria-label={t('attr_duyuru_metni_de48e9d', "Duyuru metni")}
          ></textarea>
          <div style="display:flex;gap:10px;margin-top:14px;align-items:center">
            <button class="btn-primary" onclick={sendBroadcast}>{t('adm_send', '📢 Gönder')}</button>
            <span class="muted" style="font-size:12px">{broadcastMsg.length} karakter</span>
          </div>
        </div>

      {:else if activeTab === 'reaction-roles'}
        <!-- ── Reaction Roles ──────────────────────────────────── -->
        <h2 class="section-title">{t('markup_reaction_roller_97bd747', "⚡ Reaction Roller")}</h2>
        <div class="card" style="margin-bottom:24px">
          <div class="card-label">{t('markup_yeni_kural_ekle_25013b1', "➢ Yeni Kural Ekle")}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
            {#each [
              { label: t("surface_sunucu_id_a89a4e"),  bind: 'rrServerId',  ph: 'server-id' },
              { label: t("surface_kanal_id_fff445"),   bind: 'rrChannelId', ph: 'channel-id' },
              { label: t("surface_mesaj_id_5d5520"),   bind: 'rrMessageId', ph: 'message-id' },
              { label: 'Emoji *',      bind: 'rrEmoji',     ph: '👍 veya :thumbsup:' },
              { label: t("surface_rol_id_460d56"),     bind: 'rrRoleId',    ph: 'role-id' },
            ] as f}
              <label class="field-label">
                {f.label}
                {#if f.bind === 'rrServerId'}
                  <input class="field-input" bind:value={rrServerId} placeholder={f.ph} />
                {:else if f.bind === 'rrChannelId'}
                  <input class="field-input" bind:value={rrChannelId} placeholder={f.ph} />
                {:else if f.bind === 'rrMessageId'}
                  <input class="field-input" bind:value={rrMessageId} placeholder={f.ph} />
                {:else if f.bind === 'rrEmoji'}
                  <input class="field-input" bind:value={rrEmoji} placeholder={f.ph} />
                {:else}
                  <input class="field-input" bind:value={rrRoleId} placeholder={f.ph} />
                {/if}
              </label>
            {/each}
          </div>
          <button class="btn-primary" onclick={addReactionRole}>{t('markup_kural_ekle_17e703b', "⚡ Kural Ekle")}</button>
        </div>
        {#if reactionRules.length}
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>{t('cp_category_server')}</th><th>{t('ui_kanal')}</th><th>{t('message')}</th><th>{t('emoji')}</th><th>{t('markup_rol_a73f134', "Rol")}</th><th>{t('adm_action', 'İşlem')}</th></tr></thead>
              <tbody>
                {#each reactionRules as rule}
                  <tr>
                    <td class="mono muted" style="font-size:11px">{rule.serverId}</td>
                    <td class="mono muted" style="font-size:11px">{rule.channelId}</td>
                    <td class="mono muted" style="font-size:11px">{rule.messageId}</td>
                    <td style="font-size:20px;text-align:center">{rule.emoji}</td>
                    <td class="mono muted" style="font-size:11px">{rule.roleId}</td>
                    <td>
                      <button class="btn-icon-danger" onclick={() => deleteReactionRule(rule._id)} aria-label={t('adm_delete_rule', 'Kuralı sil')}>🗑</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty">{t('adm_no_reaction_roles', 'Reaction rol kuralı yok')}</div>
        {/if}

      {:else if activeTab === 'marketplace'}
        <!-- ── Marketplace ─────────────────────────────────────── -->
        <h2 class="section-title">{t('markup_bot_marketplace_0fa982d', "🛒 Bot Marketplace")}</h2>
        <div style="display:flex;gap:12px;margin-bottom:18px;align-items:center">
          <input class="search-input" placeholder={t('attr_bot_ara_52f815f', "Bot ara…")} value={botSearchDraft}
            oninput={(e) => onBotSearch((e.target as HTMLInputElement).value)} aria-label={t('attr_bot_ara_0294678', "Bot ara")} />
          <button class="btn-page" onclick={refreshMarketplace}>{t('markup_yenile_3e186b7', "🔄 Yenile")}</button>
        </div>
        <div class="card" style="margin-bottom:24px">
          <div class="card-label">{t('markup_yeni_bot_ekle_83a4518', "➢ Yeni Bot Ekle")}</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
            <label class="field-label">{t('markup_ad_248f2c6', "Ad *")} <input class="field-input" bind:value={newBotName} placeholder={t('adm_bot_name_ph', 'BotAdı')} /></label>
            <label class="field-label">{t('adm_description', 'Açıklama')} <input class="field-input" bind:value={newBotDesc} placeholder={t('adm_description_ph', 'Açıklama…')} /></label>
            <label class="field-label">Token <input class="field-input" type="password" bind:value={newBotToken} placeholder="bot-token" /></label>
          </div>
          <button class="btn-primary" onclick={addBot}>{t('markup_bot_ekle_f0a2644', "➕ Bot Ekle")}</button>
        </div>
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>{t('markup_bot_3a3192e', "Bot")}</th><th>{t('adm_featured', 'Öne Çıkan')}</th><th>{t('markup_eklenme_8133164', "Eklenme")}</th><th style="text-align:right">{t('adm_actions', 'İşlemler')}</th></tr></thead>
            <tbody>
              {#each bots as bot}
                <tr>
                  <td>
                    <div class="user-name">{bot.name}</div>
                    <div class="muted" style="font-size:11px">{bot.description}</div>
                  </td>
                  <td class="tc">{bot.isFeatured ? '⭐' : '—'}</td>
                  <td class="tc muted nowrap">{fmtDate(bot.createdAt)}</td>
                  <td style="text-align:right">
                    <div class="action-row">
                      <button class="btn-action" onclick={() => toggleFeatured(bot._id, !bot.isFeatured)}>
                        {bot.isFeatured ? '★ Geri Al' : t("surface_one_c_kar_e3982b")}
                      </button>
                      <button class="btn-icon-danger" onclick={() => deleteBot(bot._id, bot.name)} aria-label={t('ui_botu_sil')}>🗑</button>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="4" class="empty">{t('adm_no_bots', 'Bot bulunamadı')}</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/if}
    </main>
  </div>
</div>

<style>
  .admin-overlay {
    position: fixed; inset: 0; height: var(--bridge-visual-viewport-height, 100dvh);
    background: rgba(0,0,0,.82); /* Yonetim ortusu bir MODALDIR; modal katmani zaten tanimli. */
    z-index: var(--z-modal);
    display: flex; align-items: stretch; font-family: inherit;
  }
  .admin-shell { display: flex; width: 100%; height: 100%; overflow: hidden; }

  @media (max-width: 720px) {
    .admin-overlay {
      padding-top: env(safe-area-inset-top);
      padding-right: env(safe-area-inset-right);
      padding-bottom: env(safe-area-inset-bottom);
      padding-left: env(safe-area-inset-left);
      box-sizing: border-box;
    }
    .admin-shell { flex-direction: column; min-height: 0; }
    .admin-sidebar { width: 100%; min-width: 0; max-height: 42%; border-right: 0; border-bottom: 1px solid #1e1e35; }
    .admin-nav { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); }
    .admin-nav-btn { min-height: 44px; }
    .admin-content { min-height: 0; padding: 20px 16px; }
  }

  /* Sidebar */
  .admin-sidebar {
    width: 210px; min-width: 210px; background: #12121f;
    display: flex; flex-direction: column; border-right: 1px solid #1e1e35;
  }
  .admin-sidebar-header {
    padding: 20px 16px 12px; display: flex; align-items: center; gap: 10px;
    border-bottom: 1px solid #1e1e35;
  }
  .admin-sidebar-icon { font-size: 22px; }
  .admin-sidebar-title { font-weight: 700; font-size: 15px; color: #e0e0f0; }
  .admin-sidebar-sub  { font-size: 11px; color: #555; }
  .admin-nav { padding: 8px 0; flex: 1; overflow-y: auto; }
  .admin-nav-btn {
    width: 100%; background: none; border: none; color: #6e6e9a; padding: 10px 18px;
    text-align: left; cursor: pointer; font-size: 13.5px; display: flex; align-items: center;
    gap: 10px; transition: background .12s, color .12s;
  }
  .admin-nav-btn:hover { background: rgba(45,156,219,.1); color: #aab0e8; }
  .admin-nav-btn.active { background: rgba(45,156,219,.18); color: #8892f8; font-weight: 600; }
  .admin-sidebar-footer { padding: 12px; }
  .admin-close-btn {
    width: 100%; padding: 9px; background: #1e1e35; border: none; color: #888;
    border-radius: 8px; cursor: pointer; font-size: 13px;
  }
  .admin-close-btn:hover { background: #2a2a45; color: #ccc; }

  /* Content */
  .admin-content { flex: 1; overflow-y: auto; background: #0f0f1a; padding: 28px 32px; }
  .admin-loading { color: #444; padding: 40px; text-align: center; font-size: 14px; }
  .admin-error   { color: #e55; padding: 20px; font-size: 14px; }
  .section-title { color: #d0d0f0; margin: 0 0 20px; font-size: 18px; font-weight: 700; }

  /* Stat cards */
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 12px; margin-bottom: 28px; }
  .stat-card { background: #161627; border-radius: 12px; padding: 18px 20px; border: 1px solid #1e1e38; }
  .stat-label { color: #555; font-size: 12px; margin-bottom: 6px; display: flex; align-items: center; gap: 6px; }
  .stat-value { font-size: 26px; font-weight: 700; }

  /* Cards */
  .card { background: #161627; border-radius: 12px; padding: 20px; border: 1px solid #1e1e38; }
  .card-label { color: #888; font-size: 13px; margin-bottom: 14px; font-weight: 600; }
  .row-item { display: flex; justify-content: space-between; padding: 7px 0; border-bottom: 1px solid #1e1e38; font-size: 13px; }
  .row-label { color: #bbb; }

  /* Tables */
  .table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid #1e1e38; }
  .admin-table { width: 100%; border-collapse: collapse; font-size: 13px; }
  .admin-table thead tr { background: #12121f; }
  .admin-table th { text-align: left; padding: 11px 14px; color: #555; font-weight: 600; border-bottom: 1px solid #1e1e38; white-space: nowrap; }
  .admin-table tbody tr { border-bottom: 1px solid #1a1a2e; }
  .admin-table tbody tr:hover { background: rgba(255,255,255,.02); }
  .admin-table td { padding: 10px 14px; }

  /* Form controls */
  .field-label { font-size: 11px; color: #666; display: block; }
  .field-input {
    width: 100%; background: #0f0f1a; color: #ccc; border: 1px solid #2a2a45;
    border-radius: 7px; padding: 9px 12px; font-size: 13px; box-sizing: border-box;
    margin-top: 5px;
  }
  .field-input:focus { outline: none; border-color: #4a52c8; }
  .search-input {
    flex: 1; max-width: 320px; background: #161627; border: 1px solid #2a2a45; color: #ccc;
    border-radius: 8px; padding: 9px 14px; font-size: 13px;
  }
  .search-input:focus { outline: none; border-color: #4a52c8; }
  .broadcast-textarea {
    width: 100%; background: #0f0f1a; color: #ccc; border: 1px solid #2a2a45;
    border-radius: 8px; padding: 12px; font-size: 13px; box-sizing: border-box;
    resize: vertical; font-family: inherit;
  }

  /* Buttons */
  .btn-primary { background: #2d9cdb; color: #fff; border: none; border-radius: 8px; padding: 9px 22px; cursor: pointer; font-size: 13px; font-weight: 600; }
  .btn-primary:hover { background: #2489c4; }
  .btn-page { background: #161627; color: #888; border: 1px solid #1e1e38; padding: 6px 16px; border-radius: 7px; cursor: pointer; font-size: 13px; }
  .btn-page:hover { color: #ccc; }
  .btn-action { background: #1a1e3a; color: #8892f8; border: 1px solid #2a3070; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 11px; font-weight: 600; white-space: nowrap; }
  .btn-action.danger { background: #2a1010; color: #e55; border-color: #3a1515; }
  .btn-action:hover { opacity: .85; }
  .btn-icon-danger { background: #1e1a1a; color: #e55; border: 1px solid #3a2020; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  .btn-success { background: #0f2018; color: #2ecc9a; border: 1px solid #1a3a28; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 11px; font-weight: 600; }

  /* Helpers */
  .muted { color: #555; }
  .muted-count { color: #555; font-size: 13px; }
  .nowrap { white-space: nowrap; }
  .mono { font-family: monospace; }
  .tc { text-align: center; }
  .empty { color: #444; padding: 40px; text-align: center; font-size: 14px; }
  .action-row { display: flex; gap: 6px; justify-content: flex-end; }
  .user-name { font-weight: 600; color: #d0d0f0; }
  .user-handle { color: #555; font-size: 11px; }
  .pagination { display: flex; gap: 8px; margin-top: 18px; justify-content: center; align-items: center; }

  /* Log level badges */
  .log-badge { border-radius: 4px; padding: 2px 7px; font-size: 10px; font-weight: 700; }
  .log-error { background: #2a0f0f; color: #e55; }
  .log-warn  { background: #2a1f0a; color: #faa61a; }
  .log-info  { background: #0a1a2a; color: #57aaff; }
  .log-debug { background: #1a1a2a; color: #888; }
</style>
