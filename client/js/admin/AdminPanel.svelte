<script lang="ts">
  // client/js/admin/AdminPanel.svelte
  // Sprint 118: Admin paneli vanilla TS (10 dosya) → tek Svelte 5 Runes bileşeni
  // Kapsam: stats, users, servers, ip-bans, logs, broadcast, reaction-roles, marketplace
  // ADR-0008: BridgeRegistry üzerinden servis erişimi

  import { onMount } from 'svelte';

  // ── Servis alıcıları (ADR-0008 sınır kuralı) ──────────────────
  const apiFetch: (url: string, opts?: RequestInit) => Promise<Response> =
    (url, opts) => (window as any).BridgeRegistry?.call('apiFetch', url, opts) ?? fetch(url, opts);
  const toast: (msg: string, type: string) => void =
    (msg, type) => (window as any).BridgeRegistry?.call('toast', msg, type);
  const escHtml = (s: string) =>
    (window as any).BridgeRegistry?.call('escHtml', s) ?? s.replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const API: string = (window as any).API ?? '';

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
  const TABS: { id: Tab; icon: string; label: string }[] = [
    { id: 'stats',          icon: '📊', label: 'İstatistik'   },
    { id: 'users',          icon: '👥', label: 'Kullanıcılar' },
    { id: 'servers',        icon: '🖥️', label: 'Sunucular'    },
    { id: 'ip-bans',        icon: '🚫', label: 'IP Yasakları' },
    { id: 'logs',           icon: '📋', label: 'Loglar'       },
    { id: 'broadcast',      icon: '📢', label: 'Duyuru'       },
    { id: 'reaction-roles', icon: '⚡', label: 'Reaction Rol' },
    { id: 'marketplace',    icon: '🛒', label: 'Marketplace'  },
  ];

  // ── Utils ─────────────────────────────────────────────────────
  function fmtDate(ts: number | null | undefined): string {
    if (!ts) return '—';
    return new Date(ts).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
  }
  function fmtTime(ts: number | null | undefined): string {
    if (!ts) return '—';
    return new Date(ts).toLocaleString('tr-TR');
  }
  function n(v: number | null | undefined) {
    return typeof v === 'number' ? v.toLocaleString('tr-TR') : '—';
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
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  async function fetchStats() {
    const r = await apiFetch(`${API}/api/admin/stats`);
    if (!r.ok) throw new Error(`Erişim reddedildi (${r.status})`);
    stats = await r.json();
  }

  async function fetchUsers(q = userQuery, page = userPage) {
    userQuery = q;
    userPage = page;
    const params = new URLSearchParams({ q, page: String(page), limit: '30' });
    const r = await apiFetch(`${API}/api/admin/users?${params}`);
    if (!r.ok) throw new Error('Erişim reddedildi');
    const data = await r.json();
    users     = data.users;
    userTotal = data.total;
    userPages = data.pages || 1;
  }

  async function fetchServers() {
    const r = await apiFetch(`${API}/api/admin/servers`);
    if (!r.ok) throw new Error('Erişim reddedildi');
    servers = await r.json();
  }

  async function fetchBans() {
    const r = await apiFetch(`${API}/api/admin/ip-bans`);
    if (!r.ok) throw new Error('Erişim reddedildi');
    bans = await r.json();
  }

  async function fetchLogs() {
    const params = logLevel ? `?level=${logLevel}` : '';
    const r = await apiFetch(`${API}/api/admin/logs${params}`);
    if (!r.ok) throw new Error('Erişim reddedildi');
    logs = await r.json();
  }

  async function fetchReactionRoles() {
    const r = await apiFetch(`${API}/api/admin/reaction-roles`);
    if (!r.ok) throw new Error('Erişim reddedildi');
    reactionRules = await r.json();
  }

  async function fetchBots(q = botQuery) {
    botQuery = q;
    const params = q ? `?q=${encodeURIComponent(q)}` : '';
    const r = await apiFetch(`${API}/api/admin/marketplace${params}`);
    if (!r.ok) throw new Error('Erişim reddedildi');
    bots = await r.json();
  }

  // ── User actions ──────────────────────────────────────────────
  async function toggleAdmin(userId: string, makeAdmin: boolean) {
    const r = await apiFetch(`${API}/api/admin/users/${userId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isAdmin: makeAdmin }),
    });
    if (r.ok) { toast(makeAdmin ? '⭐ Admin yetkisi verildi' : 'Admin yetkisi alındı', 'success'); await fetchUsers(); }
    else toast('İşlem başarısız', 'error');
  }

  async function deleteUser(userId: string, username: string) {
    if (!confirm(`@${username} kullanıcısı ve tüm verileri kalıcı olarak silinsin mi?\n\nBu işlem geri alınamaz!`)) return;
    const r = await apiFetch(`${API}/api/admin/users/${userId}`, { method: 'DELETE' });
    if (r.ok) { toast(`@${username} silindi`, 'success'); await fetchUsers(); }
    else toast('Silinemedi', 'error');
  }

  // ── Server actions ────────────────────────────────────────────
  async function deleteServer(sid: string, name: string) {
    if (!confirm(`"${name}" sunucusu ve tüm içeriği kalıcı olarak silinsin mi?\n\nBu işlem geri alınamaz!`)) return;
    const r = await apiFetch(`${API}/api/admin/servers/${sid}`, { method: 'DELETE' });
    if (r.ok) { toast(`"${name}" silindi`, 'success'); await fetchServers(); }
    else toast('Silinemedi', 'error');
  }

  // ── IP ban actions ────────────────────────────────────────────
  async function addIpBan() {
    if (!banIp.trim()) return toast('IP adresi zorunlu', 'error');
    const r = await apiFetch(`${API}/api/admin/ip-bans`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: banIp.trim(), reason: banReason.trim() || 'Admin ban',
                             durationMs: banDuration ? parseInt(banDuration) : null }),
    });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Yasak eklenemedi', 'error');
    toast(`${banIp} yasaklandı 🚫`, 'success');
    banIp = ''; banReason = ''; banDuration = '';
    await fetchBans();
  }

  async function removeIpBan(ip: string) {
    if (!confirm(`${ip} adresinin yasağı kaldırılsın mı?`)) return;
    const r = await apiFetch(`${API}/api/admin/ip-bans/${encodeURIComponent(ip)}`, { method: 'DELETE' });
    if (r.ok) { toast(`${ip} yasağı kaldırıldı ✅`, 'success'); await fetchBans(); }
    else toast('Kaldırılamadı', 'error');
  }

  // ── Broadcast ─────────────────────────────────────────────────
  async function sendBroadcast() {
    if (!broadcastMsg.trim()) return toast('Mesaj boş olamaz', 'error');
    const r = await apiFetch(`${API}/api/admin/broadcast`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: broadcastMsg.trim() }),
    });
    if (r.ok) { toast('📢 Duyuru gönderildi', 'success'); broadcastMsg = ''; }
    else toast('Gönderilemedi', 'error');
  }

  // ── Reaction roles ────────────────────────────────────────────
  async function addReactionRole() {
    if (!rrServerId || !rrChannelId || !rrMessageId || !rrEmoji || !rrRoleId)
      return toast('Tüm alanlar zorunlu', 'error');
    const r = await apiFetch(`${API}/api/admin/reaction-roles`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serverId: rrServerId, channelId: rrChannelId,
                             messageId: rrMessageId, emoji: rrEmoji, roleId: rrRoleId }),
    });
    if (r.ok) {
      toast('⚡ Reaction rol eklendi', 'success');
      rrServerId = rrChannelId = rrMessageId = rrEmoji = rrRoleId = '';
      await fetchReactionRoles();
    } else toast('Eklenemedi', 'error');
  }

  async function deleteReactionRule(ruleId: string) {
    if (!confirm('Bu reaction rol kuralı silinsin mi?')) return;
    const r = await apiFetch(`${API}/api/admin/reaction-roles/${ruleId}`, { method: 'DELETE' });
    if (r.ok) { toast('Kural silindi', 'success'); await fetchReactionRoles(); }
    else toast('Silinemedi', 'error');
  }

  // ── Marketplace actions ───────────────────────────────────────
  async function toggleFeatured(botId: string, featured: boolean) {
    const r = await apiFetch(`${API}/api/admin/marketplace/${botId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ isFeatured: featured }),
    });
    if (r.ok) { toast(featured ? '⭐ Öne çıkarıldı' : 'Öne çıkarma kaldırıldı', 'success'); await fetchBots(); }
    else toast('Güncellenemedi', 'error');
  }

  async function deleteBot(botId: string, name: string) {
    if (!confirm(`"${name}" botu marketplace'den silinsin mi?`)) return;
    const r = await apiFetch(`${API}/api/admin/marketplace/${botId}`, { method: 'DELETE' });
    if (r.ok) { toast(`"${name}" silindi`, 'success'); await fetchBots(); }
    else toast('Silinemedi', 'error');
  }

  async function addBot() {
    if (!newBotName.trim()) return toast('Bot adı zorunlu', 'error');
    const r = await apiFetch(`${API}/api/admin/marketplace`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newBotName.trim(), description: newBotDesc.trim(), token: newBotToken.trim() }),
    });
    if (r.ok) {
      toast('Bot eklendi ✅', 'success');
      newBotName = newBotDesc = newBotToken = '';
      await fetchBots();
    } else toast('Bot eklenemedi', 'error');
  }

  async function refreshMarketplace() {
    const r = await apiFetch(`${API}/api/admin/marketplace/refresh`, { method: 'POST' });
    if (r.ok) { toast('Marketplace yenilendi', 'success'); await fetchBots(); }
    else toast('Yenilenemedi', 'error');
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
      const label = d === 0 ? 'Bugün' : d === -1 ? 'Dün' : `${d}g`;
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
</script>

<!-- ── Shell ──────────────────────────────────────────────────── -->
<div class="admin-overlay" role="dialog" aria-modal="true" aria-label="Admin Paneli">
  <div class="admin-shell">

    <!-- Sidebar -->
    <aside class="admin-sidebar">
      <div class="admin-sidebar-header">
        <span class="admin-sidebar-icon" aria-hidden="true">🛡️</span>
        <div>
          <div class="admin-sidebar-title">Admin Paneli</div>
          <div class="admin-sidebar-sub">Bridge</div>
        </div>
      </div>
      <nav class="admin-nav" aria-label="Admin sekmeleri">
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
        <button class="admin-close-btn" onclick={() => document.getElementById('admin-overlay')?.remove()}>
          ✕ Kapat
        </button>
      </div>
    </aside>

    <!-- Content -->
    <main class="admin-content" id="admin-content">
      {#if loading}
        <div class="admin-loading" aria-live="polite">Yükleniyor…</div>
      {:else if error}
        <div class="admin-error" role="alert">⚠️ {error}</div>

      {:else if activeTab === 'stats' && stats}
        <!-- ── Stats ─────────────────────────────────────────── -->
        <h2 class="section-title">📊 Genel İstatistikler</h2>
        <div class="stat-grid">
          {#each [
            { icon: '👥', label: 'Toplam Kullanıcı', val: stats.totals.totalUsers,    color: '#8892f8' },
            { icon: '🖥️', label: 'Toplam Sunucu',    val: stats.totals.totalServers,  color: '#8892f8' },
            { icon: '💬', label: 'Toplam Mesaj',      val: stats.totals.totalMessages, color: '#57f287' },
            { icon: '📨', label: 'Toplam DM',         val: stats.totals.totalDMs,      color: '#57f287' },
            { icon: '🟢', label: 'Çevrimiçi',         val: stats.totals.onlineUsers,   color: '#43b581' },
            { icon: '📧', label: 'E-posta Doğrulı',   val: stats.totals.verifiedEmails,color: '#faa61a' },
            { icon: '🔐', label: '2FA Aktif',         val: stats.totals.twoFaEnabled,  color: '#faa61a' },
            { icon: '🆕', label: 'Bu Hafta Kayıt',    val: stats.totals.newUsers7d,    color: '#eb459e' },
          ] as item}
            <div class="stat-card">
              <div class="stat-label"><span>{item.icon}</span><span>{item.label}</span></div>
              <div class="stat-value" style="color:{item.color}">{n(item.val)}</div>
            </div>
          {/each}
        </div>
        <div class="card" style="margin-bottom:28px">
          <div class="card-label">📈 Son 7 Günlük Mesaj Trafiği</div>
          <canvas bind:this={chartCanvas} height="120" style="width:100%;display:block"></canvas>
        </div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div class="card">
            <div class="card-label">🏆 En Büyük Sunucular</div>
            {#each stats.topServers as s, i}
              <div class="row-item">
                <span class="row-label">{i+1}. {s.name}</span>
                <span style="color:#8892f8;font-weight:600">{n(s.memberCount)} üye</span>
              </div>
            {:else}
              <div class="empty">Sunucu yok</div>
            {/each}
          </div>
          <div class="card">
            <div class="card-label">💬 En Aktif Kullanıcılar (30 gün)</div>
            {#each stats.topUsers as u, i}
              <div class="row-item">
                <span class="row-label">{i+1}. {u.displayName}</span>
                <span style="color:#57f287;font-weight:600">{n(u.msgCount)} msg</span>
              </div>
            {:else}
              <div class="empty">Veri yok</div>
            {/each}
          </div>
        </div>

      {:else if activeTab === 'users'}
        <!-- ── Users ──────────────────────────────────────────── -->
        <h2 class="section-title">👥 Kullanıcılar</h2>
        <div style="display:flex;align-items:center;gap:12px;margin-bottom:18px">
          <input
            class="search-input"
            placeholder="Kullanıcı adı, e-posta ara…"
            value={userSearchDraft}
            oninput={(e) => onUserSearch((e.target as HTMLInputElement).value)}
            aria-label="Kullanıcı ara"
          />
          <span class="muted-count">{n(userTotal)} kullanıcı</span>
        </div>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr>
                <th>Kullanıcı</th><th>E-posta</th><th>2FA</th><th>Admin</th><th>Kayıt</th><th style="text-align:right">İşlemler</th>
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
                  <td class="tc">{u.twoFactorEnabled ? '🔐' : '<span class="muted">—</span>'}</td>
                  <td class="tc">{u.isAdmin ? '⭐' : '—'}</td>
                  <td class="tc muted nowrap">{fmtDate(u.createdAt)}</td>
                  <td style="text-align:right">
                    <div class="action-row">
                      <button
                        class="btn-action"
                        class:danger={u.isAdmin}
                        onclick={() => toggleAdmin(u._id, !u.isAdmin)}
                      >{u.isAdmin ? '⬇ Yetkiyi Al' : '⬆ Admin Yap'}</button>
                      <button class="btn-icon-danger" onclick={() => deleteUser(u._id, u.username)} aria-label="Kullanıcıyı sil">🗑</button>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="6" class="empty">Kullanıcı bulunamadı</td></tr>
              {/each}
            </tbody>
          </table>
        </div>
        <div class="pagination" aria-label="Sayfalama">
          {#if userPage > 1}
            <button class="btn-page" onclick={() => fetchUsers(userQuery, userPage - 1)}>← Önceki</button>
          {/if}
          <span class="muted">{userPage} / {userPages}</span>
          {#if userPage < userPages}
            <button class="btn-page" onclick={() => fetchUsers(userQuery, userPage + 1)}>Sonraki →</button>
          {/if}
        </div>

      {:else if activeTab === 'servers'}
        <!-- ── Servers ─────────────────────────────────────────── -->
        <h2 class="section-title">🖥️ Sunucular ({n(servers.length)})</h2>
        <div class="table-wrap">
          <table class="admin-table">
            <thead>
              <tr><th>Sunucu</th><th>Üyeler</th><th>Keşif</th><th>Oluşturulma</th><th style="text-align:right">İşlem</th></tr>
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
                    <button class="btn-icon-danger" onclick={() => deleteServer(s._id, s.name)}>🗑 Sil</button>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="5" class="empty">Sunucu yok</td></tr>
              {/each}
            </tbody>
          </table>
        </div>

      {:else if activeTab === 'ip-bans'}
        <!-- ── IP Bans ─────────────────────────────────────────── -->
        <h2 class="section-title">🚫 IP Yasakları</h2>
        <div class="card" style="margin-bottom:24px">
          <div class="card-label">➢ Yeni IP Yasağı</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
            <label class="field-label">
              IP Adresi *
              <input class="field-input" bind:value={banIp} placeholder="192.168.1.1 veya ::1" maxlength="45" />
            </label>
            <label class="field-label">
              Sebep
              <input class="field-input" bind:value={banReason} placeholder="Spam, brute force…" maxlength="200" />
            </label>
            <label class="field-label">
              Süre
              <select class="field-input" bind:value={banDuration}>
                <option value="">Kalıcı</option>
                <option value="3600000">1 Saat</option>
                <option value="86400000">1 Gün</option>
                <option value="604800000">1 Hafta</option>
                <option value="2592000000">30 Gün</option>
              </select>
            </label>
          </div>
          <button class="btn-primary" onclick={addIpBan}>🚫 Yasak Ekle</button>
        </div>
        <div class="muted" style="font-weight:600;margin-bottom:12px">Aktif Yasaklar ({bans.length})</div>
        {#if bans.length}
          <div class="table-wrap">
            <table class="admin-table">
              <thead>
                <tr><th>IP</th><th>Sebep</th><th>Tarih</th><th>Bitiş</th><th style="text-align:right">İşlem</th></tr>
              </thead>
              <tbody>
                {#each bans as b}
                  {@const expired = b.expiresAt && b.expiresAt <= Date.now()}
                  <tr>
                    <td class="mono" style="color:#eb459e;font-weight:600">{b.ip}</td>
                    <td class="muted">{b.reason || '—'}</td>
                    <td class="muted nowrap">{fmtTime(b.bannedAt)}</td>
                    <td class="nowrap">
                      {#if !b.expiresAt}
                        <span style="color:#faa61a">Kalıcı</span>
                      {:else if expired}
                        <span style="color:#e55">Süresi Doldu</span>
                      {:else}
                        <span class="muted">{fmtTime(b.expiresAt)}</span>
                      {/if}
                    </td>
                    <td style="text-align:right">
                      <button class="btn-success" onclick={() => removeIpBan(b.ip)}>✅ Kaldır</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty">Aktif IP yasağı yok</div>
        {/if}

      {:else if activeTab === 'logs'}
        <!-- ── Logs ────────────────────────────────────────────── -->
        <h2 class="section-title">📋 Loglar</h2>
        <div style="display:flex;gap:12px;margin-bottom:18px;align-items:center">
          <select class="field-input" style="max-width:180px" bind:value={logLevel}
            onchange={fetchLogs}>
            <option value="">Tüm Seviyeler</option>
            <option value="error">Error</option>
            <option value="warn">Warn</option>
            <option value="info">Info</option>
            <option value="debug">Debug</option>
          </select>
          <button class="btn-page" onclick={fetchLogs}>🔄 Yenile</button>
        </div>
        {#if logs.length}
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>Zaman</th><th>Seviye</th><th>Event</th><th>Mesaj</th></tr></thead>
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
          <div class="empty">Log bulunamadı</div>
        {/if}

      {:else if activeTab === 'broadcast'}
        <!-- ── Broadcast ───────────────────────────────────────── -->
        <h2 class="section-title">📢 Sistem Duyurusu</h2>
        <div class="card" style="max-width:600px">
          <div class="card-label">Tüm bağlı kullanıcılara sistem mesajı gönder</div>
          <textarea
            class="broadcast-textarea"
            bind:value={broadcastMsg}
            placeholder="Duyuru metni…"
            rows="5"
            aria-label="Duyuru metni"
          ></textarea>
          <div style="display:flex;gap:10px;margin-top:14px;align-items:center">
            <button class="btn-primary" onclick={sendBroadcast}>📢 Gönder</button>
            <span class="muted" style="font-size:12px">{broadcastMsg.length} karakter</span>
          </div>
        </div>

      {:else if activeTab === 'reaction-roles'}
        <!-- ── Reaction Roles ──────────────────────────────────── -->
        <h2 class="section-title">⚡ Reaction Roller</h2>
        <div class="card" style="margin-bottom:24px">
          <div class="card-label">➢ Yeni Kural Ekle</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
            {#each [
              { label: 'Sunucu ID *',  bind: 'rrServerId',  ph: 'server-id' },
              { label: 'Kanal ID *',   bind: 'rrChannelId', ph: 'channel-id' },
              { label: 'Mesaj ID *',   bind: 'rrMessageId', ph: 'message-id' },
              { label: 'Emoji *',      bind: 'rrEmoji',     ph: '👍 veya :thumbsup:' },
              { label: 'Rol ID *',     bind: 'rrRoleId',    ph: 'role-id' },
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
          <button class="btn-primary" onclick={addReactionRole}>⚡ Kural Ekle</button>
        </div>
        {#if reactionRules.length}
          <div class="table-wrap">
            <table class="admin-table">
              <thead><tr><th>Sunucu</th><th>Kanal</th><th>Mesaj</th><th>Emoji</th><th>Rol</th><th>İşlem</th></tr></thead>
              <tbody>
                {#each reactionRules as rule}
                  <tr>
                    <td class="mono muted" style="font-size:11px">{rule.serverId}</td>
                    <td class="mono muted" style="font-size:11px">{rule.channelId}</td>
                    <td class="mono muted" style="font-size:11px">{rule.messageId}</td>
                    <td style="font-size:20px;text-align:center">{rule.emoji}</td>
                    <td class="mono muted" style="font-size:11px">{rule.roleId}</td>
                    <td>
                      <button class="btn-icon-danger" onclick={() => deleteReactionRule(rule._id)} aria-label="Kuralı sil">🗑</button>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {:else}
          <div class="empty">Reaction rol kuralı yok</div>
        {/if}

      {:else if activeTab === 'marketplace'}
        <!-- ── Marketplace ─────────────────────────────────────── -->
        <h2 class="section-title">🛒 Bot Marketplace</h2>
        <div style="display:flex;gap:12px;margin-bottom:18px;align-items:center">
          <input class="search-input" placeholder="Bot ara…" value={botSearchDraft}
            oninput={(e) => onBotSearch((e.target as HTMLInputElement).value)} aria-label="Bot ara" />
          <button class="btn-page" onclick={refreshMarketplace}>🔄 Yenile</button>
        </div>
        <div class="card" style="margin-bottom:24px">
          <div class="card-label">➢ Yeni Bot Ekle</div>
          <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
            <label class="field-label">Ad * <input class="field-input" bind:value={newBotName} placeholder="BotAdı" /></label>
            <label class="field-label">Açıklama <input class="field-input" bind:value={newBotDesc} placeholder="Açıklama…" /></label>
            <label class="field-label">Token <input class="field-input" type="password" bind:value={newBotToken} placeholder="bot-token" /></label>
          </div>
          <button class="btn-primary" onclick={addBot}>➕ Bot Ekle</button>
        </div>
        <div class="table-wrap">
          <table class="admin-table">
            <thead><tr><th>Bot</th><th>Öne Çıkan</th><th>Eklenme</th><th style="text-align:right">İşlemler</th></tr></thead>
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
                        {bot.isFeatured ? '★ Geri Al' : '⭐ Öne Çıkar'}
                      </button>
                      <button class="btn-icon-danger" onclick={() => deleteBot(bot._id, bot.name)} aria-label="Botu sil">🗑</button>
                    </div>
                  </td>
                </tr>
              {:else}
                <tr><td colspan="4" class="empty">Bot bulunamadı</td></tr>
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
    position: fixed; inset: 0; background: rgba(0,0,0,.82); z-index: 9999;
    display: flex; align-items: stretch; font-family: inherit;
  }
  .admin-shell { display: flex; width: 100%; height: 100%; overflow: hidden; }

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
  .btn-success { background: #0f2018; color: #57f287; border: 1px solid #1a3a28; border-radius: 6px; padding: 4px 12px; cursor: pointer; font-size: 11px; font-weight: 600; }

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
