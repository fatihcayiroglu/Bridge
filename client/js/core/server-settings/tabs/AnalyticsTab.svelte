<script lang="ts">
  import { onMount } from 'svelte';
  import { apiFetch } from '../../api-fetch.ts';
  import { safeApiErrorMessage } from '../../api-error.ts';
  import { getAPI } from '../../globals.ts';
  import { t } from '../../i18n/reactive.svelte.ts';
  import { isStillCurrentServer, type ServerSettingsStore } from '../stores/serverSettingsStore.ts';

  let { store }: { store: ServerSettingsStore } = $props();

  interface Summary {
    memberCount: number; channelCount: number; totalMessages: number;
    activeUsers7d: number; activeUsers30d: number; isOwner: boolean;
    topUsers: Array<{ userId?: string; displayName: string; msgCount: number }>;
    channelBreakdown: Array<{ channelId: string; channelName: string; msgCount: number }>;
  }
  interface Growth {
    days: number;
    joinSeries: Array<{ day: string; newMembers: number }>;
    cumulativeSeries: Array<{ day: string; totalMembers: number }>;
    messageSeries: Array<{ day: string; msgCount: number }>;
  }
  interface Activity {
    hourlyDistribution: Array<{ hour: number; label: string; msgCount: number }>;
    weeklyDistribution: Array<{ dow: number; label: string; msgCount: number }>;
    peakHour: { hour: number; label: string; msgCount: number };
    peakDay: { dow: number; label: string; msgCount: number };
  }
  interface Retention {
    dau: number; wau: number; mau: number;
    dauRate: number; wauRate: number; mauRate: number; dauMauRatio: number;
  }

  let loading = $state(true);
  let refreshing = $state(false);
  let exporting = $state(false);
  let error = $state('');
  let summary = $state<Summary | null>(null);
  let growth = $state<Growth | null>(null);
  let activity = $state<Activity | null>(null);
  let retention = $state<Retention | null>(null);
  let days = $state(30);
  let generation = 0;

  // `store` bir PROP'tur. Bunu bir kez kopyalamak, ayar penceresi yeniden
  // olusturulmadan baska bir sunucuya gecerse YANLIS sunucunun analitigini
  // getirir/dışa aktarırdı. Turetme, prop degistiginde birlikte tazelenir.
  const serverId = $derived(String(store.serverId || ''));
  const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

  function bounded(value: unknown): number {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  }
  function pct(value: number, max: number): number {
    if (max <= 0) return 0;
    return Math.max(0, Math.min(100, Math.round((value / max) * 100)));
  }
  function localHour(hour: number): string {
    const shift = -new Date().getTimezoneOffset() / 60;
    const local = ((hour + shift) % 24 + 24) % 24;
    return `${String(Math.floor(local)).padStart(2, '0')}:00`;
  }
  function currentServer(): boolean {
    return Boolean(serverId) && isStillCurrentServer(serverId);
  }

  async function fetchJson<T>(path: string): Promise<T> {
    const res = await apiFetch(`${getAPI()}${path}`, { redirect: 'error' });
    if (!res.ok) throw res;
    return await res.json() as T;
  }

  async function load(nextDays = days): Promise<void> {
    const myGeneration = ++generation;
    error = '';
    if (!summary) loading = true; else refreshing = true;
    if (!currentServer()) {
      error = t('srv_changed', 'Sunucu değişti — ayarlar yeniden yüklenmeli.');
      loading = false; refreshing = false;
      return;
    }
    try {
      const sid = encodeURIComponent(serverId);
      const [s, g, a, r] = await Promise.all([
        fetchJson<Summary>(`/api/servers/${sid}/stats`),
        fetchJson<Growth>(`/api/servers/${sid}/stats/growth?days=${nextDays}`),
        fetchJson<Activity>(`/api/servers/${sid}/stats/activity`),
        fetchJson<Retention>(`/api/servers/${sid}/stats/retention`),
      ]);
      if (myGeneration !== generation || !currentServer()) return;
      summary = s; growth = g; activity = a; retention = r; days = nextDays;
    } catch (err) {
      if (myGeneration !== generation) return;
      error = safeApiErrorMessage(err, t('analytics_load_failed', 'Analitik verileri yüklenemedi.'), { report: true });
    } finally {
      if (myGeneration === generation) { loading = false; refreshing = false; }
    }
  }

  async function exportCsv(): Promise<void> {
    if (exporting || !summary?.isOwner || !currentServer()) return;
    exporting = true; error = '';
    try {
      const sid = encodeURIComponent(serverId);
      const res = await apiFetch(`${getAPI()}/api/servers/${sid}/stats/export.csv?days=${days}`, { redirect: 'error' });
      if (!res.ok) throw res;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      try {
        const a = document.createElement('a');
        a.href = url;
        a.download = `bridge-analytics-${serverId}.csv`;
        a.rel = 'noopener';
        a.click();
      } finally {
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      error = safeApiErrorMessage(err, t('analytics_export_failed', 'Analitik dışa aktarılamadı.'), { report: true });
    } finally { exporting = false; }
  }

  onMount(() => { void load(); });

  let topChannelMax = $derived(Math.max(1, ...(summary?.channelBreakdown ?? []).map(x => bounded(x.msgCount))));
  let topUserMax = $derived(Math.max(1, ...(summary?.topUsers ?? []).map(x => bounded(x.msgCount))));
  let weekMax = $derived(Math.max(1, ...(activity?.weeklyDistribution ?? []).map(x => bounded(x.msgCount))));
  let hourMax = $derived(Math.max(1, ...(activity?.hourlyDistribution ?? []).map(x => bounded(x.msgCount))));
</script>

<section class="analytics" aria-labelledby="analytics-title">
  <header class="analytics-head">
    <div>
      <h3 id="analytics-title">{t('srv_tab_analytics', 'Analitik')}</h3>
      <p>{t('analytics_desc', 'Topluluk büyümesi, aktivite ve bağlılık sinyalleri.')}</p>
    </div>
    <div class="analytics-actions">
      <label>
        <span class="sr-only">{t("analytics_period")}</span>
        <select bind:value={days} onchange={() => void load(days)} disabled={loading || refreshing}>
          <option value={7}>{t("duration_7_days")}</option><option value={30}>{t("duration_30_days")}</option><option value={90}>{t("duration_90_days")}</option>
        </select>
      </label>
      <button type="button" class="btn" onclick={() => void load(days)} disabled={loading || refreshing}>
        {refreshing ? t("surface_yenileniyor_879958") : t("markup_yenile_255b90e")}
      </button>
      {#if summary?.isOwner}
        <button type="button" class="btn" onclick={exportCsv} disabled={exporting || loading}>
          {exporting ? t("surface_haz_rlan_yor_aa7fb7") : 'CSV'}
        </button>
      {/if}
    </div>
  </header>

  {#if loading}
    <div class="analytics-state" aria-live="polite">{t('sso_loading', 'Yükleniyor…')}</div>
  {:else if error && !summary}
    <div class="analytics-state analytics-error" role="alert">
      <p>{error}</p><button type="button" class="btn" onclick={() => void load(days)}>{t('retry')}</button>
    </div>
  {:else if summary}
    {#if error}<p class="inline-error" role="alert">{error}</p>{/if}
    <div class="metric-grid" aria-label={t("analytics_server_summary")}>
      <article><strong>{nf.format(bounded(summary.memberCount))}</strong><span>{t("analytics_members")}</span></article>
      <article><strong>{nf.format(bounded(summary.totalMessages))}</strong><span>{t('message')}</span></article>
      <article><strong>{nf.format(bounded(summary.activeUsers7d))}</strong><span>{t('markup_7g_aktif_0311ab4', "7g aktif")}</span></article>
      <article><strong>{nf.format(bounded(summary.activeUsers30d))}</strong><span>{t('markup_30g_aktif_361d031', "30g aktif")}</span></article>
    </div>

    <div class="analytics-grid">
      <section class="panel">
        <h4>{t("analytics_growth")}</h4>
        <div class="trend" aria-label={t('analytics_growth_aria', undefined, { days })}>
          {#each (growth?.cumulativeSeries ?? []).slice(-30) as point (point.day)}
            {@const vals = (growth?.cumulativeSeries ?? []).slice(-30).map(x => bounded(x.totalMembers))}
            {@const min = Math.min(...vals, bounded(point.totalMembers))}
            {@const max = Math.max(...vals, bounded(point.totalMembers), min + 1)}
            <span class="trend-bar" style={`height:${18 + pct(bounded(point.totalMembers) - min, max - min) * .62}%`} title={t('analytics_day_members', undefined, { day: point.day, count: point.totalMembers })}></span>
          {/each}
        </div>
        <p class="insight">{t("ui_last_days", undefined, { days })} <strong>{nf.format((growth?.joinSeries ?? []).reduce((n, x) => n + bounded(x.newMembers), 0))}</strong> {t("analytics_new_member")}</p>
      </section>

      <section class="panel">
        <h4>{t("analytics_engagement")}</h4>
        <div class="retention-grid">
          <div><strong>{nf.format(bounded(retention?.dau ?? 0))}</strong><span>DAU · %{bounded(retention?.dauRate ?? 0)}</span></div>
          <div><strong>{nf.format(bounded(retention?.wau ?? 0))}</strong><span>WAU · %{bounded(retention?.wauRate ?? 0)}</span></div>
          <div><strong>{nf.format(bounded(retention?.mau ?? 0))}</strong><span>MAU · %{bounded(retention?.mauRate ?? 0)}</span></div>
        </div>
        <p class="insight">DAU/MAU <strong>%{bounded(retention?.dauMauRatio ?? 0)}</strong></p>
      </section>

      <section class="panel">
        <h4>{t("analytics_weekly_activity")}</h4>
        <div class="bar-list">
          {#each activity?.weeklyDistribution ?? [] as row (row.dow)}
            <div class="bar-row"><span>{row.label.slice(0, 3)}</span><i><b style={`width:${pct(bounded(row.msgCount), weekMax)}%`}></b></i><em>{nf.format(bounded(row.msgCount))}</em></div>
          {/each}
        </div>
        {#if activity?.peakDay}<p class="insight">{t("analytics_most_active_day")} <strong>{activity.peakDay.label}</strong></p>{/if}
      </section>

      <section class="panel">
        <h4>{t('markup_aktif_saatler_21e372b', "Aktif saatler")}</h4>
        <div class="hour-grid" aria-label={t('attr_saatlik_mesaj_aktivitesi_b1b20cb', "Saatlik mesaj aktivitesi")}>
          {#each activity?.hourlyDistribution ?? [] as row (row.hour)}
            <span title={t('analytics_hour_messages', undefined, { hour: localHour(row.hour), count: row.msgCount })} style={`opacity:${0.2 + (pct(bounded(row.msgCount), hourMax) / 125)}`}>{String(row.hour).padStart(2, '0')}</span>
          {/each}
        </div>
        {#if activity?.peakHour}<p class="insight">{t('markup_en_aktif_saat_bd8df18', "En aktif saat")} <strong>{localHour(activity.peakHour.hour)}</strong></p>{/if}
      </section>

      <section class="panel">
        <h4>{t('markup_en_aktif_kanallar_bcbf189', "En aktif kanallar")}</h4>
        {#if summary.channelBreakdown.length}
          <div class="bar-list">
            {#each summary.channelBreakdown.slice(0, 8) as row (row.channelId)}
              <div class="bar-row"><span>#{row.channelName}</span><i><b style={`width:${pct(bounded(row.msgCount), topChannelMax)}%`}></b></i><em>{nf.format(bounded(row.msgCount))}</em></div>
            {/each}
          </div>
        {:else}<p class="empty">{t("analytics_no_messages")}</p>{/if}
      </section>

      <section class="panel">
        <h4>{t("analytics_most_active_members")}</h4>
        {#if summary.topUsers.length}
          <div class="bar-list">
            {#each summary.topUsers.slice(0, 8) as row, i (`${row.userId ?? row.displayName}-${i}`)}
              <div class="bar-row"><span>{row.displayName}</span><i><b style={`width:${pct(bounded(row.msgCount), topUserMax)}%`}></b></i><em>{nf.format(bounded(row.msgCount))}</em></div>
            {/each}
          </div>
        {:else}<p class="empty">{t("analytics_no_activity")}</p>{/if}
      </section>
    </div>
  {/if}
</section>

<style>
  .analytics { display:grid; gap:var(--space-4); min-width:0; }
  .analytics-head { display:flex; gap:var(--space-3); align-items:flex-start; justify-content:space-between; }
  h3,h4,p { margin:0; } h3{font-size:var(--type-title-md)} h4{font-size:var(--type-body);}
  .analytics-head p,.empty,.insight { color:var(--text-muted); font-size:var(--type-caption); margin-top:4px; }
  .analytics-actions { display:flex; gap:var(--space-2); flex-wrap:wrap; justify-content:flex-end; }
  select,.btn { min-height:36px; border:1px solid var(--border-subtle); border-radius:var(--radius-control); background:var(--surface-2); color:var(--text-primary); padding:0 10px; font:inherit; }
  .btn { cursor:pointer; }.btn:disabled { opacity:.55; cursor:not-allowed; }
  .metric-grid { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); gap:var(--space-2); }
  .metric-grid article { display:grid; gap:2px; padding:12px; background:var(--surface-2); border:1px solid var(--border-subtle); border-radius:var(--radius-surface); }
  .metric-grid strong { font-size:var(--type-title-lg); }.metric-grid span { color:var(--text-muted); font-size:var(--type-caption); }
  .analytics-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:var(--space-3); }
  .panel { min-width:0; padding:14px; border:1px solid var(--border-subtle); border-radius:var(--radius-surface); background:var(--surface-1); display:grid; gap:10px; }
  .trend { height:104px; display:flex; align-items:end; gap:2px; padding-top:6px; border-bottom:1px solid var(--border-subtle); overflow:hidden; }
  .trend-bar { flex:1; min-width:2px; max-width:14px; background:var(--brand); border-radius:3px 3px 0 0; opacity:.78; }
  .retention-grid { display:grid; grid-template-columns:repeat(3,1fr); gap:8px; }
  .retention-grid div { display:grid; gap:2px; padding:10px; background:var(--surface-2); border-radius:var(--radius-control); }
  .retention-grid strong { font-size:var(--type-title-sm); }.retention-grid span{color:var(--text-muted);font-size:11px;}
  .bar-list { display:grid; gap:7px; }.bar-row{display:grid;grid-template-columns:minmax(76px,1fr) minmax(70px,2fr) auto;gap:8px;align-items:center;font-size:var(--type-caption);min-width:0}.bar-row>span{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.bar-row i{height:6px;background:var(--surface-3);border-radius:99px;overflow:hidden}.bar-row b{display:block;height:100%;background:var(--brand);border-radius:inherit}.bar-row em{font-style:normal;color:var(--text-muted);font-variant-numeric:tabular-nums}
  .hour-grid { display:grid; grid-template-columns:repeat(12,1fr); gap:4px; }.hour-grid span{display:grid;place-items:center;min-height:28px;border-radius:5px;background:var(--brand);color:var(--text-on-solid);font-size:10px;font-weight:700;}
  .analytics-state { min-height:180px; display:grid; place-content:center; gap:10px; color:var(--text-muted); text-align:center; }.analytics-error,.inline-error{color:var(--danger)}
  .sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
  @media (max-width: 760px) { .analytics-head{flex-direction:column}.analytics-actions{justify-content:flex-start}.metric-grid{grid-template-columns:repeat(2,1fr)}.analytics-grid{grid-template-columns:1fr}.hour-grid{grid-template-columns:repeat(8,1fr)} }
</style>
