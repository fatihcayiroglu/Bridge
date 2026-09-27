<script lang="ts">
  import { t, localeTag} from '../../i18n/reactive.svelte.ts';
  import { onMount } from 'svelte';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import { safeApiErrorMessage } from '../../api-error.ts';

  type State = 'operational' | 'degraded' | 'unavailable';
  interface Service { key: string; label: string; status: State; detail: string }
  interface HealthResponse { checkedAt: number; overall: State; services: Service[]; error?: string }

  let loading = $state(true);
  let error = $state('');
  let checkedAt = $state<number | null>(null);
  let overall = $state<State>('unavailable');
  let services = $state<Service[]>([]);

  const labels: Record<State, string> = $derived.by(() => ({
    operational: t('health_operational', 'Çalışıyor'),
    degraded: t('health_degraded', 'Kısıtlı'),
    unavailable: t('health_unavailable', 'Kullanılamıyor'),
  }));

  async function load(): Promise<void> {
    const server = BridgeRegistry.get<() => { _id?: string } | null>('getCurrentServer')?.();
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    if (!server?._id || !apiFetch) {
      loading = false;
      error = t("ui_sunucu_veya_baglanti_bilgisi_kullanilamiyor", "Sunucu veya bağlantı bilgisi kullanılamıyor.");
      return;
    }
    loading = true;
    error = '';
    try {
      const response = await apiFetch(`/api/health/server/${encodeURIComponent(server._id)}/services`);
      if (!response.ok) {
        error = response.status === 403
          ? t("ui_sistem_durumunu_gormek_icin_sunucuyu_yonet_izni_gere", "Sistem durumunu görmek için Sunucuyu Yönet izni gerekir.")
          : safeApiErrorMessage(response, t("ui_sistem_durumu_alinamadi", "Sistem durumu alınamadı."), { report: true });
        return;
      }
      let body: unknown;
      try {
        body = await response.json();
      } catch {
        services = [];
        checkedAt = null;
        error = t("ui_sistem_durumu_yaniti_dogrulanamadi_tekrar_deneyebili", "Sistem durumu yanıtı doğrulanamadı. Tekrar deneyebilirsin.");
        return;
      }
      const validStates = new Set<State>(['operational', 'degraded', 'unavailable']);
      const candidate = body as Partial<HealthResponse> | null;
      const validServices = Array.isArray(candidate?.services)
        && candidate.services.every((service) => service
          && typeof service.key === 'string'
          && typeof service.label === 'string'
          && typeof service.detail === 'string'
          && validStates.has(service.status));
      if (!candidate || !validStates.has(candidate.overall as State)
        || typeof candidate.checkedAt !== 'number' || !Number.isFinite(candidate.checkedAt)
        || !validServices) {
        services = [];
        checkedAt = null;
        error = t("ui_sistem_durumu_yaniti_dogrulanamadi_tekrar_deneyebili", "Sistem durumu yanıtı doğrulanamadı. Tekrar deneyebilirsin.");
        return;
      }
      services = candidate.services as Service[];
      checkedAt = candidate.checkedAt;
      overall = candidate.overall as State;
    } catch (reason) {
      services = [];
      error = safeApiErrorMessage(reason, t("ui_sistem_durumu_alinamadi", "Sistem durumu alınamadı."), { report: true });
    } finally {
      loading = false;
    }
  }

  function timeLabel(value: number | null): string {
    if (!value || !Number.isFinite(value)) return t("ui_henuz_kontrol_edilmedi", "Henüz kontrol edilmedi");
    return new Intl.DateTimeFormat(localeTag(), { hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(value);
  }

  onMount(() => { void load(); });
</script>

<section class="health" aria-labelledby="health-title">
  <header class="health-head">
    <div>
      <span class="eyebrow">{t('hlt_title', 'Operasyonel görünürlük')}</span>
      <h3 id="health-title">{t('markup_sistem_durumu_c05e0f0', "Sistem durumu")}</h3>
      <p>{t('markup_yalniz_gercek_servis_kontrolleri_gosterilir_kull_0ac9fc5', "Yalnız gerçek servis kontrolleri gösterilir; kullanıcı etkinliği veya altyapı sırları toplanmaz.")}</p>
    </div>
    <button type="button" class="refresh" onclick={load} disabled={loading} aria-label={t('attr_sistem_durumunu_yenile_c4e6db8', "Sistem durumunu yenile")}>
      {loading ? t("surface_kontrol_ediliyor_1b2cc5") : t("markup_yenile_255b90e")}
    </button>
  </header>

  {#if loading && services.length === 0}
    <div class="state" role="status">{t('markup_servisler_kontrol_ediliyor_98c3a2a', "Servisler kontrol ediliyor…")}</div>
  {:else if error}
    <div class="state error" role="alert">
      <strong>{t('hlt_failed', 'Durum alınamadı')}</strong><span>{error}</span>
      <button type="button" onclick={load}>{t('retry')}</button>
    </div>
  {:else}
    <div class="summary" aria-live="polite">
      <span class="signal {overall}" aria-hidden="true"></span>
      <strong>{t("ui_overall_status", undefined, { status: labels[overall] })}</strong>
      <span>{t("ui_last_checked", undefined, { time: timeLabel(checkedAt) })}</span>
    </div>
    <ul class="service-list" aria-label={t('hlt_services', 'Servis sağlık durumları')}>
      {#each services as service (service.key)}
        <li class="service">
          <span class="signal {service.status}" aria-hidden="true"></span>
          <div class="service-copy">
            <strong>{service.label}</strong>
            <span>{service.detail}</span>
          </div>
          <span class="badge {service.status}">{labels[service.status]}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .health { display: grid; gap: 16px; color: var(--text-primary, #e4e6eb); }
  .health-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 18px; }
  .eyebrow { color: var(--brand, #55a7e7); font-size: 10px; font-weight: 800; letter-spacing: .1em; text-transform: uppercase; }
  h3 { margin: 4px 0 5px; font-size: 18px; }
  p { margin: 0; max-width: 520px; color: var(--text-muted, #9ba0aa); font-size: 12px; line-height: 1.5; }
  button { border: 1px solid var(--border, #3f4147); border-radius: 7px; background: var(--bg-secondary, #262830); color: inherit; cursor: pointer; font: inherit; }
  button:focus-visible { outline: 2px solid var(--brand, #55a7e7); outline-offset: 2px; }
  button:disabled { cursor: wait; opacity: .65; }
  .refresh { min-width: 84px; padding: 8px 11px; font-size: 12px; }
  .summary { display: flex; align-items: center; gap: 8px; min-height: 38px; padding: 0 12px; border: 1px solid var(--border, #3f4147); border-radius: 9px; background: color-mix(in srgb, var(--bg-secondary, #262830) 78%, transparent); font-size: 12px; }
  .summary > span:last-child { margin-left: auto; color: var(--text-muted, #9ba0aa); }
  .service-list { display: grid; gap: 8px; margin: 0; padding: 0; list-style: none; }
  .service { display: grid; grid-template-columns: 9px minmax(0, 1fr) auto; align-items: center; gap: 11px; padding: 12px; border: 1px solid var(--border, #3f4147); border-radius: 9px; background: var(--bg-secondary, #262830); }
  .service-copy { display: grid; gap: 3px; min-width: 0; }
  .service-copy strong { font-size: 13px; }
  .service-copy span { color: var(--text-muted, #9ba0aa); font-size: 11px; line-height: 1.45; overflow-wrap: anywhere; }
  .signal { width: 8px; height: 8px; border-radius: 999px; background: var(--danger, #e05260); }
  .signal.operational { background: var(--success, #3ba55d); }
  .signal.degraded { background: var(--yellow); }
  .badge { padding: 4px 7px; border-radius: 999px; background: color-mix(in srgb, var(--danger, #e05260) 14%, transparent); color: var(--danger, #e05260); font-size: 10px; font-weight: 800; }
  .badge.operational { background: color-mix(in srgb, var(--success, #3ba55d) 14%, transparent); color: var(--success, #3ba55d); }
  .badge.degraded { background: color-mix(in srgb, var(--yellow) 14%, transparent); color: var(--yellow); }
  .state { display: grid; place-items: center; gap: 8px; min-height: 180px; padding: 18px; border: 1px dashed var(--border, #3f4147); border-radius: 9px; color: var(--text-muted, #9ba0aa); text-align: center; font-size: 12px; }
  .state.error strong { color: var(--danger, #e05260); }
  .state button { padding: 7px 10px; }
  @media (max-width: 620px) {
    .health-head { flex-direction: column; }
    .refresh { width: 100%; }
    .summary { flex-wrap: wrap; padding-block: 9px; }
    .summary > span:last-child { width: 100%; margin-left: 17px; }
    .service { grid-template-columns: 9px minmax(0, 1fr); }
    .badge { grid-column: 2; justify-self: start; }
  }
  @media (prefers-reduced-motion: reduce) { * { scroll-behavior: auto !important; } }
</style>
