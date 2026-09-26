<!-- client/js/core/server-settings/tabs/ModerationTab.svelte -->
<!--
  FAZ K+/2 — MODERASYON YÜZEYİ.

  ════════════════════════════════════════════════════════════════════════════
  KAPATILAN GERÇEK BOŞLUK
  ════════════════════════════════════════════════════════════════════════════
  Sunucu tarafı TAMDI ve izin korumalıydı (server/routes/moderation.ts):

      GET    /api/servers/:sid/bans                    → BAN_MEMBERS
      POST   /api/servers/:sid/bans                    → BAN_MEMBERS
      DELETE /api/servers/:sid/bans/:userId            → BAN_MEMBERS
      POST   /api/servers/:sid/members/:uid/timeout    → TIMEOUT_MEMBERS
      POST   /api/servers/:sid/members/:uid/kick       → KICK_MEMBERS

  İstemcide bu uçlara ULAŞAN TEK BİR YÜZEY YOKTU. `ModerationPanel.svelte`
  adında bir dosya vardı ama 51 satırlık BOŞ bir kabuktu (sıfır API çağrısı)
  ve hiçbir giriş noktasından import edilmiyordu. Sonuç: sunucu sahibi
  kimseyi banlayamıyor, susturamıyor, atamıyordu.

  ── YETKİ SINIRI NEREDE ───────────────────────────────────────────────────
  ARKA UÇTA. Buradaki izin kontrolü YALNIZCA görünürlük içindir: yetkisi
  olmayana ölü düğme göstermemek. Kanıtlanamayan bit yok sayılır
  (fail-closed) ve her yazma isteği sunucuda yeniden yetkilendirilir.
  Bu panel hiçbir kontrolü ATLAMAZ.
-->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { onMount } from 'svelte';
  import { apiFetch } from '../../api-fetch.js';
  import { getAPI } from '../../globals.js';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';
  import { fetchMyPermissions, hasPerm } from '../../permissions/myPermissions.js';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import { safeApiErrorMessage } from '../../api-error.ts';

  /** `server/lib/permissions.ts` yansıması — yalnız bu yüzeyde gerekenler. */
  const PERM_KICK_MEMBERS    = 1 << 4;
  const PERM_BAN_MEMBERS     = 1 << 5;
  const PERM_TIMEOUT_MEMBERS = 1 << 7;
  const PERM_MANAGE_MESSAGES = 1 << 9;

  interface BanRow {
    userId?: string;
    username?: string;
    displayName?: string;
    reason?: string;
    bannedAt?: number;
    [key: string]: unknown;
  }
  interface ReportRow {
    id: string; messageId: string; channelId: string; reason: string; detail?: string; createdAt?: number;
    channel?: { _id?: string; name?: string };
    message?: { displayName?: string; preview?: string };
    reporter?: { _id?: string; displayName?: string };
  }
  interface MemberRow {
    userId?: string; _id?: string;
    username?: string; displayName?: string;
  }

  const server = getCurrentServerFromRegistry();
  const serverId = String(server?._id ?? server?.id ?? '');

  let perms      = $state(0);
  let bans       = $state<BanRow[]>([]);
  let members    = $state<MemberRow[]>([]);
  let reports    = $state<ReportRow[]>([]);
  let loading    = $state(true);
  let error      = $state('');
  let notice     = $state('');
  let busyId     = $state('');

  // Eylem formu
  let targetId   = $state('');
  let reason     = $state('');

  let canBan     = $derived(hasPerm(perms, PERM_BAN_MEMBERS));
  let canKick    = $derived(hasPerm(perms, PERM_KICK_MEMBERS));
  let canTimeout = $derived(hasPerm(perms, PERM_TIMEOUT_MEMBERS));
  let canReports = $derived(hasPerm(perms, PERM_MANAGE_MESSAGES) || reports.length > 0);
  let canAnything = $derived(canBan || canKick || canTimeout || canReports);

  const TIMEOUT_PRESETS = $derived.by(() => [
    { label: t("ui_5_dakika", "5 dakika"), minutes: 5 },
    { label: t("ui_10_dakika", "10 dakika"), minutes: 10 },
    { label: t("ui_1_saat", "1 saat"), minutes: 60 },
    { label: t("ui_1_gun", "1 gün"), minutes: 1440 },
  ]);

  function nameOf(row: { displayName?: string; username?: string; userId?: string }): string {
    return row.displayName || row.username || row.userId || t('ui_unknown_user', 'Bilinmeyen kullanıcı');
  }

  function whenOf(ts: unknown): string {
    const n = Number(ts);
    return Number.isFinite(n) && n > 0 ? new Date(n).toLocaleString() : '';
  }

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      // Ürün tarafından yazılmış, çevrilmiş ve güvenli bir mesajı `throw` edip
      // aşağıda `safeApiErrorMessage`e vermek onu YOK EDİYORDU: Response
      // olmayan bir Error sınıflandırılamaz ve genel yedek metin döner.
      if (!serverId) { error = t("ssm_no_server", "Sunucu seçilmedi."); return; }
      perms = await fetchMyPermissions(serverId);

      // Üye listesi KANONİK kaynaktan okunur; bu panel ikinci bir üye
      // sahibi kurmaz ve kendi listesini çekmez.
      members = readMembers();

      // Report visibility is channel-scoped on the server. Fetching this list
      // does not grant anything: the backend filters every row through the
      // caller's effective MANAGE_MESSAGES permission for that channel.
      const reportRes = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/reports`);
      if (!isStillCurrentServer(serverId)) return;
      if (reportRes.ok) {
        const payload = await reportRes.json() as { reports?: ReportRow[] };
        reports = Array.isArray(payload.reports) ? payload.reports : [];
      } else if (reportRes.status !== 403) {
        error = safeApiErrorMessage(reportRes, t("ui_rapor_kuyrugu_yuklenemedi", "Rapor kuyruğu yüklenemedi."), { report: true });
      }

      if (hasPerm(perms, PERM_BAN_MEMBERS)) {
        const res = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/bans`);
        if (!isStillCurrentServer(serverId)) return;
        if (res.status === 403) {
          // Sunucu son sözü söyler; istemci sinyali bayat olabilir.
          bans = [];
        } else if (!res.ok) {
          error = safeApiErrorMessage(res, t("ui_moderasyon_verileri_yuklenemedi", "Moderasyon verileri yüklenemedi."), { report: true });
          return;
        } else {
          const data = await res.json() as BanRow[];
          bans = Array.isArray(data) ? data : [];
        }
      }
    } catch (err) {
      error = safeApiErrorMessage(err, t("ui_moderasyon_verileri_yuklenemedi", "Moderasyon verileri yüklenemedi."), { report: true });
    } finally {
      loading = false;
    }
  }

  /**
   * `getCurrentServerMembers` kanonik salt-okunur görünümdür.
   * Kayıtlı değilse liste boş kalır ve form kimlik girişine düşer —
   * uydurma bir üye listesi üretilmez.
   */
  function readMembers(): MemberRow[] {
    if (!BridgeRegistry.has('getCurrentServerMembers')) return [];
    const list = BridgeRegistry.call<MemberRow[]>('getCurrentServerMembers');
    return Array.isArray(list) ? list : [];
  }

  /** Ortak yazma sarmalayıcısı — her yol AYNI hata/başarı sözleşmesini kullanır. */
  async function run(key: string, label: string, request: () => Promise<Response>): Promise<boolean> {
    if (busyId) return false;
    if (!serverId || !isStillCurrentServer(serverId)) {
      error = t("ui_sunucu_degisti_moderasyon_verileri_yeniden_yuklenmel", "Sunucu değişti — moderasyon verileri yeniden yüklenmeli.");
      return false;
    }
    busyId = key;
    error = '';
    notice = '';
    try {
      const res = await request();
      if (res.status === 403) { error = t("ui_bu_islem_icin_yetkiniz_yok", "Bu işlem için yetkiniz yok."); return false; }
      if (res.status === 429) { error = t("ui_cok_hizli_islem_yapiyorsunuz_biraz_bekleyin", "Çok hızlı işlem yapıyorsunuz. Biraz bekleyin."); return false; }
      if (!res.ok) {
        error = safeApiErrorMessage(res, t("ui_moderasyon_islemi_tamamlanamadi", "Moderasyon işlemi tamamlanamadı."), { report: true });
        return false;
      }
      notice = label;
      return true;
    } catch (cause) {
      error = safeApiErrorMessage(cause, t("ui_moderasyon_islemi_tamamlanamadi", "Moderasyon işlemi tamamlanamadı."), { report: true });
      return false;
    } finally {
      busyId = '';
    }
  }

  async function banUser(): Promise<void> {
    const id = targetId.trim();
    if (!id) { error = t("ui_kullanici_secin", "Kullanıcı seçin."); return; }
    const ok = await run('ban', t('moderation_banned_id', '{id} yasaklandı.', { id }), () =>
      apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/bans`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: id, reason: reason.trim() || undefined }),
      }));
    if (ok) { targetId = ''; reason = ''; await load(); }
  }

  async function unban(userId: string): Promise<void> {
    if (!userId) { error = t("ui_kullanici_kimligi_eksik", "Kullanıcı kimliği eksik."); return; }
    const ok = await run(`unban:${userId}`, t('audit_unban', 'Yasak kaldırıldı'), () =>
      apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/bans/${encodeURIComponent(userId)}`,
        { method: 'DELETE' }));
    if (ok) await load();
  }

  async function kickUser(): Promise<void> {
    const id = targetId.trim();
    if (!id) { error = t("ui_kullanici_secin", "Kullanıcı seçin."); return; }
    const ok = await run('kick', t('moderation_kicked_id', '{id} sunucudan çıkarıldı.', { id }), () =>
      apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(id)}/kick`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() || undefined }),
      }));
    if (ok) { targetId = ''; reason = ''; }
  }

  async function timeoutUser(minutes: number): Promise<void> {
    const id = targetId.trim();
    if (!id) { error = t("ui_kullanici_secin", "Kullanıcı seçin."); return; }
    await run('timeout', t('moderation_muted_minutes', '{id} {minutes} dakika susturuldu.', { id, minutes }), () =>
      apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/members/${encodeURIComponent(id)}/timeout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ durationMs: minutes * 60_000, reason: reason.trim() || undefined }),
      }));
  }

  const REPORT_REASON_LABELS: Record<string, string> = $derived.by(() => ({
    spam: t('report_reason_spam', 'Spam'),
    harassment: t('report_reason_harassment', 'Taciz'),
    hate: t('report_reason_hate', 'Nefret söylemi'),
    sexual: t('report_reason_sexual', 'Uygunsuz cinsel içerik'),
    violence: t('report_reason_violence', 'Şiddet'),
    other: t('report_reason_other', 'Diğer'),
  }));

  async function resolveReport(report: ReportRow, resolution: 'resolved' | 'dismissed'): Promise<void> {
    const label = resolution === 'resolved' ? t("ui_rapor_cozuldu", "Rapor çözüldü.") : t("ui_rapor_reddedildi", "Rapor reddedildi.");
    const ok = await run(`report:${report.id}`, label, () =>
      apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/reports/${encodeURIComponent(report.id)}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution }),
      }));
    if (ok) reports = reports.filter(row => row.id !== report.id);
  }

  function openReportedMessage(report: ReportRow): void {
    if (!report.channelId || !report.messageId || !BridgeRegistry.has('navigateToChannel')) {
      error = t("ui_raporlanan_mesaj_su_anda_acilamiyor", "Raporlanan mesaj şu anda açılamıyor."); return;
    }
    BridgeRegistry.call('navigateToChannel', report.channelId, report.messageId, server);
  }

  onMount(() => { void load(); });
</script>

<div class="mod-tab">
  {#if loading}
    <p class="mod-muted">{t('mod_loading', 'Yükleniyor…')}</p>

  {:else if error && !canAnything}
    <p class="mod-error" role="alert">{error}</p>

  {:else if !canAnything}
    <!-- Yetkisiz kullanıcıya ölü kontrol GÖSTERİLMEZ; nedeni açıkça yazılır. -->
    <div class="mod-empty">
      <h3>{t('markup_moderasyon_yetkiniz_yok_4e301f1', "Moderasyon yetkiniz yok")}</h3>
      <p class="mod-muted">
        {t('markup_uye_cikarma_susturma_veya_yasaklama_icin_sunucu__2973bab', "Üye çıkarma, susturma veya yasaklama için sunucu yöneticisinden")}
        <strong>KICK_MEMBERS</strong>, <strong>TIMEOUT_MEMBERS</strong> {t('markup_veya_a8c8ca1', "veya")}
        <strong>BAN_MEMBERS</strong> {t('markup_yetkisi_isteyin_63db795', "yetkisi isteyin.")}
      </p>
    </div>

  {:else}
    {#if error}<p class="mod-error" role="alert">{error}</p>{/if}
    {#if notice}<p class="mod-notice" role="status">{notice}</p>{/if}

    <section class="mod-section" aria-labelledby="mod-action-title">
      <h3 id="mod-action-title">{t('mod_member_action', 'Üye işlemi')}</h3>
      <p class="mod-muted">{t('mod_reauth_hint', 'İşlemler sunucuda yeniden yetkilendirilir ve denetim günlüğüne yazılır.')}</p>

      <div class="mod-form">
        <label class="mod-field">
          <span>{t('mod_user', 'Kullanıcı')}</span>
          {#if members.length}
            <select bind:value={targetId} disabled={busyId !== ''}>
              <option value="">{t('mod_choose', 'Seçin…')}</option>
              {#each members as member (member.userId ?? member._id)}
                <option value={String(member.userId ?? member._id ?? '')}>{nameOf(member)}</option>
              {/each}
            </select>
          {:else}
            <input type="text" bind:value={targetId} placeholder={t('mod_user_id', 'Kullanıcı kimliği')} disabled={busyId !== ''} />
          {/if}
        </label>

        <label class="mod-field">
          <span>{t('mod_reason', 'Gerekçe')} <small>{t('mod_optional', '(isteğe bağlı)')}</small></span>
          <input type="text" bind:value={reason} maxlength="400" placeholder={t('mod_audit_note', 'Denetim günlüğüne yazılır')} disabled={busyId !== ''} />
        </label>
      </div>

      <div class="mod-actions">
        {#if canTimeout}
          <div class="mod-group" role="group" aria-label={t('mod_timed_mute', 'Süreli susturma')}>
            <span class="mod-group-label">{t('voice_mute')}</span>
            {#each TIMEOUT_PRESETS as preset (preset.minutes)}
              <button type="button" class="mod-btn" disabled={busyId !== ''} onclick={() => void timeoutUser(preset.minutes)}>
                {preset.label}
              </button>
            {/each}
          </div>
        {/if}

        <div class="mod-group">
          {#if canKick}
            <button type="button" class="mod-btn mod-btn-warn" disabled={busyId !== ''} onclick={() => void kickUser()}>
              {t('markup_sunucudan_cikar_d2b7051', "Sunucudan çıkar")}
            </button>
          {/if}
          {#if canBan}
            <button type="button" class="mod-btn mod-btn-danger" disabled={busyId !== ''} onclick={() => void banUser()}>
              {t('ban')}
            </button>
          {/if}
        </div>
      </div>
    </section>

    {#if canReports}
      <section class="mod-section" aria-labelledby="mod-reports-title">
        <h3 id="mod-reports-title">{t("moderation_message_reports")} <span class="mod-count">{reports.length}</span></h3>
        <p class="mod-muted">{t("moderation_reports_scope")}</p>
        {#if reports.length === 0}
          <p class="mod-muted">{t("moderation_no_open_reports")}</p>
        {:else}
          <ul class="mod-reports">
            {#each reports as report (report.id)}
              <li class="mod-report">
                <div class="mod-report-main">
                  <div class="mod-report-meta"><strong>{REPORT_REASON_LABELS[report.reason] ?? t('report_reason_other', 'Diğer')}</strong><span>#{report.channel?.name ?? report.channelId}</span><span>{whenOf(report.createdAt)}</span></div>
                  <p><strong>{report.message?.displayName ?? t('ui_bridge_user')}:</strong> {report.message?.preview || t("surface_mesaj_icerigi_yok_23c6dd")}</p>
                  {#if report.detail}<small>{t('moderation_report_note', undefined, { detail: report.detail })}</small>{/if}
                  <small>{t('moderation_reporter', undefined, { name: report.reporter?.displayName ?? t('ui_bridge_user') })}</small>
                </div>
                <div class="mod-report-actions">
                  <button type="button" class="mod-btn" disabled={busyId !== ''} onclick={() => openReportedMessage(report)}>{t('pin_jump')}</button>
                  <button type="button" class="mod-btn" disabled={busyId !== ''} onclick={() => void resolveReport(report, 'dismissed')}>{t('dmc_reject')}</button>
                  <button type="button" class="mod-btn mod-btn-warn" disabled={busyId !== ''} onclick={() => void resolveReport(report, 'resolved')}>{t("moderation_resolved")}</button>
                </div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    {#if canBan}
      <section class="mod-section" aria-labelledby="mod-bans-title">
        <h3 id="mod-bans-title">{t('mod_banned', 'Yasaklılar')} <span class="mod-count">{bans.length}</span></h3>
        {#if !bans.length}
          <p class="mod-muted">{t('mod_nobody_banned', 'Bu sunucuda yasaklı kimse yok.')}</p>
        {:else}
          <ul class="mod-bans">
            {#each bans as ban (ban.userId)}
              <li class="mod-ban">
                <div class="mod-ban-who">
                  <strong>{nameOf(ban)}</strong>
                  {#if ban.reason}<small>{ban.reason}</small>{/if}
                  {#if whenOf(ban.bannedAt)}<small class="mod-when">{whenOf(ban.bannedAt)}</small>{/if}
                </div>
                <button
                  type="button" class="mod-btn"
                  disabled={busyId !== ''}
                  onclick={() => void unban(String(ban.userId ?? ''))}
                >{t('mod_unban', 'Yasağı kaldır')}</button>
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<style>
.mod-tab { display: flex; flex-direction: column; gap: 6px; }
.mod-section { padding-top: 14px; }
.mod-section + .mod-section { margin-top: 6px; border-top: 1px solid var(--border-faint); }
.mod-section h3 { margin: 0 0 2px; font-size: var(--text-base); }
.mod-muted { margin: 0 0 10px; font-size: var(--text-sm); color: var(--text-muted); }
.mod-count {
  padding: 0 7px;
  font-size: var(--text-2xs);
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  background: var(--bg-3);
  border-radius: 999px;
}

.mod-error, .mod-notice {
  padding: 8px 11px;
  margin: 0 0 10px;
  font-size: var(--text-sm);
  border-radius: var(--radius-sm);
}
.mod-error  { color: var(--danger-text, var(--danger)); background: var(--danger-bg, var(--bg-3)); }
.mod-notice { color: var(--green); background: var(--green-bg); }

.mod-empty { padding: 26px 4px; }
.mod-empty h3 { margin: 0 0 6px; font-size: var(--text-base); }

.mod-form { display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 10px; }
.mod-field { display: flex; flex-direction: column; gap: 4px; font-size: var(--text-sm); }
.mod-field span { font-weight: 600; color: var(--text-secondary); }
.mod-field small { font-weight: 400; color: var(--text-muted); }
.mod-field input, .mod-field select {
  padding: 7px 10px;
  font: inherit;
  font-size: var(--text-sm);
  color: var(--text-primary);
  background: var(--bg-input, var(--bg-3));
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}

.mod-actions { display: flex; flex-wrap: wrap; gap: 14px; margin-top: 12px; }
.mod-group { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.mod-group-label { font-size: var(--text-2xs); font-weight: 700; letter-spacing: .05em; color: var(--text-muted); text-transform: uppercase; }

.mod-btn {
  padding: 6px 12px;
  font: inherit;
  font-size: var(--text-xs);
  color: var(--text-primary);
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.mod-btn:hover:not(:disabled) { background: var(--bg-4); }
.mod-btn:disabled { cursor: default; opacity: .55; }
.mod-btn-warn   { color: var(--yellow); border-color: var(--yellow); }
.mod-btn-danger { color: var(--danger); border-color: var(--danger); }

.mod-reports { display: grid; gap: 8px; padding: 0; margin: 0; list-style: none; }
.mod-report { display: flex; align-items: flex-start; gap: 12px; padding: 10px 0; border-bottom: 1px solid var(--border-faint); }
.mod-report-main { display: grid; gap: 4px; flex: 1; min-width: 0; }
.mod-report-main p { margin: 0; font-size: var(--text-sm); overflow-wrap: anywhere; }
.mod-report-main small { color: var(--text-muted); }
.mod-report-meta { display: flex; flex-wrap: wrap; gap: 7px; align-items: center; color: var(--text-muted); font-size: var(--text-2xs); }
.mod-report-meta strong { color: var(--danger-text, var(--danger)); }
.mod-report-actions { display: flex; flex-wrap: wrap; gap: 6px; justify-content: flex-end; }
@media (max-width: 720px) { .mod-report { flex-direction: column; } .mod-report-actions { width: 100%; justify-content: flex-start; } }

.mod-bans { padding: 0; margin: 0; list-style: none; }
.mod-ban {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  padding: 9px 0;
  border-bottom: 1px solid var(--border-faint);
}
.mod-ban-who { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.mod-ban-who strong { font-size: var(--text-sm); }
.mod-ban-who small { font-size: var(--text-2xs); color: var(--text-muted); }
.mod-when { font-variant-numeric: tabular-nums; }
</style>
