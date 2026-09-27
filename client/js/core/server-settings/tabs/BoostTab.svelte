<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { onMount } from 'svelte';
  import { apiFetch } from '../../api-fetch.js';
  import { getAPI } from '../../globals.js';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import { safeApiErrorMessage } from '../../api-error.ts';
  import { confirmProductAction } from '../../product-dialog.ts';
  import { getCurrentServerFromRegistry, isStillCurrentServer } from '../stores/serverSettingsStore';

  interface BoostPayload {
    count?: number; tier?: number; perks?: string[]; uploadLimitMB?: number; audioBitrate?: number;
    boosters?: Array<{ userId?: string; boostedAt?: number }>;
  }

  const server = getCurrentServerFromRegistry();
  const serverId = String(server?._id ?? server?.id ?? '');
  let data = $state<BoostPayload | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state('');
  let notice = $state('');

  function meId(): string {
    const me = BridgeRegistry.call<Record<string, unknown> | null>('getMe') ?? {};
    return String(me._id ?? me.id ?? '');
  }
  // BOŞ KİMLİK EŞLEŞMEZ. `meId()` kimlik çözülemediğinde boş dize döner ve
  // `userId` alanı eksik bir boost satırı da boş dizeye normalleşir; ikisini
  // karşılaştırmak "bu sunucuyu sen boost ettin" YANLIŞ sonucunu üretir ve
  // birincil eyleme YIKICI "boostu kaldır" düğmesini koyardı.
  let boosting = $derived.by(() => {
    const me = meId();
    return Boolean(me) && Boolean(data?.boosters?.some(row => String(row.userId ?? '') === me));
  });

  async function load(): Promise<void> {
    loading = true; error = '';
    try {
      if (!serverId || !isStillCurrentServer(serverId)) { error = t("ui_sunucu_degisti_boost_bilgileri_yeniden_yuklenmeli", "Sunucu değişti — boost bilgileri yeniden yüklenmeli."); return; }
      const res = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/boosts`);
      if (!res.ok) { error = safeApiErrorMessage(res, t("ui_boost_bilgileri_yuklenemedi", "Boost bilgileri yüklenemedi."), { report: true }); data = null; return; }
      data = await res.json() as BoostPayload;
    } catch (cause) {
      error = safeApiErrorMessage(cause, t("ui_boost_bilgileri_yuklenemedi", "Boost bilgileri yüklenemedi."), { report: true });
    } finally { loading = false; }
  }

  async function mutate(next: boolean): Promise<void> {
    if (busy || !serverId || !isStillCurrentServer(serverId)) { error = t("ui_sunucu_degisti_boost_islemi_iptal_edildi", "Sunucu değişti — boost işlemi iptal edildi."); return; }
    if (!next) {
      const ok = await confirmProductAction({
        title: t("ui_boostu_kaldir", "Boostu kaldır"),
        message: t("ui_bu_sunucu_icin_aktif_boostunu_kaldirmak_istiyor_musu", "Bu sunucu için aktif boostunu kaldırmak istiyor musun?"),
        confirmLabel: t("ui_boostu_kaldir", "Boostu kaldır"), tone: 'danger',
      });
      if (!ok) return;
    }
    busy = true; error = ''; notice = '';
    try {
      const res = await apiFetch(`${getAPI()}/api/servers/${encodeURIComponent(serverId)}/boosts`, { method: next ? 'POST' : 'DELETE' });
      if (!res.ok && !(next && res.status === 409)) {
        error = safeApiErrorMessage(res, next ? t("ui_sunucu_boost_edilemedi", "Sunucu boost edilemedi.") : t("ui_boost_kaldirilamadi", "Boost kaldırılamadı."), { report: true });
        return;
      }
      await load();
      notice = next ? t("ui_sunucu_boost_edildi", "Sunucu boost edildi.") : t("ui_boost_kaldirildi", "Boost kaldırıldı.");
    } catch (cause) {
      error = safeApiErrorMessage(cause, next ? t("ui_sunucu_boost_edilemedi", "Sunucu boost edilemedi.") : t("ui_boost_kaldirilamadi", "Boost kaldırılamadı."), { report: true });
    } finally { busy = false; }
  }

  onMount(() => { void load(); });
</script>

<section aria-labelledby="boost-heading" class="boost-tab">
  <div class="boost-head">
    <div><h2 id="boost-heading">{t('markup_sunucu_boost_166f63c', "Sunucu Boost")}</h2><p>{t("boost_summary_hint")}</p></div>
    {#if data}<span class="tier">{t('boost_level', undefined, { level: Number(data.tier ?? 0) })}</span>{/if}
  </div>
  {#if loading}<p class="state" aria-live="polite">{t("boost_loading")}</p>
  {:else if error && !data}<p class="state error" role="alert">{error}</p><button type="button" class="btn" onclick={() => void load()}>{t('retry')}</button>
  {:else if data}
    {#if error}<p class="state error" role="alert">{error}</p>{/if}
    {#if notice}<p class="state success" role="status">{notice}</p>{/if}
    <div class="metrics">
      <div><strong>{Number(data.count ?? 0)}</strong><span>{t('markup_aktif_boost_9d9eb21', "Aktif boost")}</span></div>
      <div><strong>{Number(data.uploadLimitMB ?? 25)} MB</strong><span>{t('markup_dosya_limiti_956f288', "Dosya limiti")}</span></div>
      <div><strong>{Number(data.audioBitrate ?? 96)} kbps</strong><span>{t("boost_voice_cap")}</span></div>
    </div>
    <div class="perks">
      <h3>{t('markup_aktif_avantajlar_5583eca', "Aktif avantajlar")}</h3>
      {#if Array.isArray(data.perks) && data.perks.length}<ul>{#each data.perks as perk}<li>{perk}</li>{/each}</ul>{:else}<p>{t("boost_no_benefits")}</p>{/if}
    </div>
    <button type="button" class:danger={boosting} class="btn primary" disabled={busy} onclick={() => void mutate(!boosting)}>
      {busy ? t("surface_isleniyor_33889c") : boosting ? t("ui_boostu_kaldir") : 'Sunucuyu boost et'}
    </button>
  {/if}
</section>

<style>
  .boost-tab{display:grid;gap:16px}.boost-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.boost-head h2{margin:0;font-size:var(--type-title-sm)}.boost-head p,.state,.perks p{margin:5px 0 0;color:var(--text-2);font-size:var(--type-body-sm)}.tier{padding:5px 9px;border:1px solid var(--border-subtle);border-radius:var(--radius-pill);color:var(--brand);font-weight:700}.metrics{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px}.metrics div{display:grid;gap:3px;padding:12px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-1)}.metrics strong{font-size:var(--type-title-sm)}.metrics span{color:var(--text-muted);font-size:var(--type-caption)}.perks{padding:12px;border:1px solid var(--border-subtle);border-radius:var(--radius-control)}.perks h3{margin:0 0 8px;font-size:var(--type-body-md)}.perks ul{margin:0;padding-left:20px;color:var(--text-2)}.btn{justify-self:start;padding:8px 12px;border:1px solid var(--border-subtle);border-radius:var(--radius-control);background:var(--surface-2);color:var(--text-primary);cursor:pointer}.primary{background:var(--brand);color:var(--text-on-solid);border-color:var(--brand)}.danger{background:var(--danger);border-color:var(--danger)}.error{color:var(--danger)}.success{color:var(--success)}.btn:focus-visible{outline:2px solid var(--focus-ring);outline-offset:2px}@media(max-width:620px){.metrics{grid-template-columns:1fr}.boost-head{align-items:stretch;flex-direction:column}.tier{align-self:flex-start}}
</style>
