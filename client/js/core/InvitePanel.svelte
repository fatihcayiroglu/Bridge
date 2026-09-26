<!-- client/js/core/InvitePanel.svelte -->
<!--
  UX/P0 — DAVET AKIŞI (ürünün EN KRİTİK eksik akışı).

  ════════════════════════════════════════════════════════════════════════════
  BULUNAN KUSUR
  ════════════════════════════════════════════════════════════════════════════
  Ölçüm: istemcinin TAMAMINDA `POST /api/servers/invites` çağrısı YOKTU.
  Yalnızca `EmptyServerStart.svelte` içinde `/invites/:code/use` (bir kodla
  KATILMA) vardı. Yani bir sunucu sahibi davet OLUŞTURAMIYORDU — sunucu
  paylaşılamaz durumdaydı. Bu kozmetik bir eksik değil, çekirdek ürün akışının
  yokluğuydu.

  Ayrıca kabuktaki sunucu adı düğmesi `disabled aria-disabled="true"` idi;
  Discord'un birincil "Invite People / Server Settings" girişi Bridge'de hiç
  yoktu.

  ════════════════════════════════════════════════════════════════════════════
  KANONİK SAHİPLİK
  ════════════════════════════════════════════════════════════════════════════
  · Backend sözleşmesi AYNEN kullanılır: `POST /api/servers/invites`
    gövde `{ serverId, maxUses }` → `{ code, expiresAt, maxUses, serverName }`.
  · İKİNCİ bir davet servisi/veri modeli KURULMAZ.
  · Yetki sunucudadır: uç üyelik ister ve üye olmayana 403 döner. İstemci
    yetkiyi TAKLİT ETMEZ; sunucunun cevabını dürüstçe gösterir.
  · Aktif sunucu kanonik kaynaktan okunur (`AppState` → `currentServer`).
-->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { createLogger } from './logger.js';

  const log = createLogger('InvitePanel');

  let isVisible = $state(false);
  let loading   = $state(false);
  let error     = $state('');
  let code      = $state('');
  let expiresAt = $state<number | null>(null);
  let maxUses   = $state(0);
  let copied    = $state(false);
  let serverName = $state('');

  let copyTimer: ReturnType<typeof setTimeout> | null = null;
  let inviteServerId = '';
  let requestSeq = 0;

  const apiBase = (): string =>
    (globalThis as { BRIDGE_API?: string }).BRIDGE_API || location.origin;

  function currentServer(): { _id?: string; name?: string } | null {
    return BridgeRegistry.call<{ _id?: string; name?: string } | null>('currentServer') ?? null;
  }

  /** Paylaşılabilir tam bağlantı — kullanıcı kodu elle taşımak zorunda kalmaz. */
  let inviteLink = $derived(code ? `${apiBase()}/invite/${code}` : '');

  let expiryLabel = $derived.by(() => {
    if (!expiresAt) return t("poll_no_expiry", "Süresiz");
    const ms = expiresAt - Date.now();
    if (ms <= 0) return t("ui_suresi_doldu", "Süresi doldu");
    const h = Math.floor(ms / 3_600_000);
    if (h >= 24) return t('invite_valid_days', '{count} gün geçerli', { count: Math.floor(h / 24) });
    if (h >= 1)  return t('invite_valid_hours', '{count} saat geçerli', { count: h });
    return t('invite_valid_minutes', '{count} dakika geçerli', { count: Math.max(1, Math.round(ms / 60_000)) });
  });

  async function createInvite(): Promise<void> {
    const server = currentServer();
    if (!server?._id) { error = t("ui_once_bir_sunucu_secin", "Önce bir sunucu seçin."); return; }

    const seq = ++requestSeq;
    inviteServerId = server._id;
    loading = true; error = ''; copied = false;
    try {
      const apiFetch = BridgeRegistry.get<(u: string, o?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error(t("ui_apifetch_yok", "apiFetch yok"));
      const res = await apiFetch(`${apiBase()}/api/servers/invites`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ serverId: server._id, maxUses }),
      });
      if (seq !== requestSeq) return;
      if (res.status === 403) {
        // Sunucunun yetki kararı DÜRÜSTÇE gösterilir — istemci taklit etmez.
        error = t("ui_bu_sunucuda_davet_olusturma_yetkiniz_yok", "Bu sunucuda davet oluşturma yetkiniz yok.");
        return;
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json() as { code?: string; expiresAt?: number; maxUses?: number; serverName?: string };
      if (seq !== requestSeq) return;
      code       = String(data.code ?? '');
      expiresAt  = typeof data.expiresAt === 'number' ? data.expiresAt : null;
      maxUses    = typeof data.maxUses === 'number' && data.maxUses >= 0 ? data.maxUses : 0;
      serverName = String(data.serverName ?? server.name ?? '');
      inviteServerId = server._id;
    } catch (err) {
      log.error('Invite creation failed', err);
      error = t("ui_davet_olusturulamadi_lutfen_tekrar_deneyin", "Davet oluşturulamadı. Lütfen tekrar deneyin.");
    } finally {
      if (seq === requestSeq) loading = false;
    }
  }

  async function copyLink(): Promise<void> {
    if (!inviteLink) return;
    try {
      await navigator.clipboard.writeText(inviteLink);
      copied = true;
      if (copyTimer) clearTimeout(copyTimer);
      copyTimer = setTimeout(() => { copied = false; copyTimer = null; }, 2000);
    } catch {
      error = t("ui_panoya_kopyalanamadi_baglantiyi_elle_secebilirsiniz", "Panoya kopyalanamadı — bağlantıyı elle seçebilirsiniz.");
    }
  }

  function open(): void {
    const server = currentServer();
    if ((server?._id ?? '') !== inviteServerId) {
      // A cached code belongs to exactly one server. Invalidate both it and
      // any older in-flight response before showing another server's panel.
      requestSeq += 1;
      code = '';
      expiresAt = null;
      maxUses = 0;
      inviteServerId = '';
      loading = false;
    }
    serverName = String(server?.name ?? '');
    isVisible = true;
    error = ''; copied = false;
    if (!code && !loading) void createInvite();   // açılışta hazır bir davet üret
  }

  function close(): void {
    isVisible = false;
    copied = false;
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Escape' || !isVisible) return;
    e.preventDefault();
    close();
  }

  onMount(() => {
    BridgeRegistry.register('openInvitePanel', open);
    BridgeRegistry.register('closeInvitePanel', close);
  });
  onDestroy(() => {
    requestSeq += 1;
    if (copyTimer) clearTimeout(copyTimer);
    BridgeRegistry.unregister?.('openInvitePanel');
    BridgeRegistry.unregister?.('closeInvitePanel');
  });
</script>

<svelte:window onkeydown={onKeyDown} />

{#if isVisible}
<div class="inv-overlay" role="presentation"
     onclick={(e) => { if (e.target === e.currentTarget) close(); }}>
  <div class="inv-card" role="dialog" aria-modal="true" aria-labelledby="inv-title"
       use:focusTrap={{ initialFocus: '.inv-link' }}>
    <header class="inv-head">
      <h2 id="inv-title">{t('inv_title', 'Arkadaşlarını davet et')}</h2>
      <button type="button" class="inv-x" onclick={close} aria-label={t('attr_davet_penceresini_kapat_0378294', "Davet penceresini kapat")}>✕</button>
    </header>

    {#if serverName}
      <p class="inv-sub">{t("ui_invite_share_server", undefined, { server: serverName })}</p>
    {/if}

    {#if error}
      <p class="inv-error" role="alert">{error}</p>
    {/if}

    {#if loading && !code}
      <div class="inv-loading" aria-live="polite">{t('inv_creating', 'Davet oluşturuluyor…')}</div>
    {:else if code}
      <div class="inv-linkrow">
        <input class="inv-link" readonly value={inviteLink}
               aria-label={t('inv_link', 'Davet bağlantısı')}
               onfocus={(e) => (e.currentTarget as HTMLInputElement).select()} />
        <button type="button" class="inv-copy" class:copied onclick={copyLink}>
          {copied ? t("surface_kopyaland_9810c7") : t('copy')}
        </button>
      </div>
      <p class="inv-meta">{expiryLabel}{maxUses > 0 ? ` · ${t('invite_max_uses', undefined, { count: maxUses })}` : t("surface_s_n_rs_z_kullan_m_c7eae3")}</p>
      <button type="button" class="inv-new" onclick={createInvite} disabled={loading}>
        {loading ? t("surface_olusturuluyor_8d7aee") : t("surface_yeni_baglant_olustur_a59a04")}
      </button>
    {/if}
  </div>
</div>
{/if}

<style>
  .inv-overlay {
    position: fixed; inset: 0; z-index: var(--layer-modal);
    display: grid; place-items: center;
    background: color-mix(in srgb, var(--bg-0) 82%, transparent);
    padding: var(--space-4);
  }
  .inv-card {
    width: min(440px, 100%);
    background: var(--surface-1);
    color: var(--text-primary);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-surface);
    box-shadow: var(--elevation-modal);
    padding: var(--space-5);
    display: grid; gap: var(--space-3);
  }
  .inv-head { display: flex; align-items: center; gap: var(--space-3); }
  .inv-head h2 { margin: 0; flex: 1; font-size: var(--type-title-sm); }
  .inv-x {
    border: 0; background: transparent; color: var(--text-muted);
    font-size: 20px; line-height: 1; cursor: pointer;
    border-radius: var(--radius-control); padding: 2px 6px;
  }
  .inv-x:hover { background: var(--surface-hover); color: var(--text-primary); }
  .inv-sub, .inv-meta { margin: 0; color: var(--text-muted); font-size: var(--type-body-sm); }
  .inv-error { margin: 0; color: var(--danger); font-size: var(--type-body-sm); }
  .inv-loading { color: var(--text-muted); font-size: var(--type-body-sm); padding: var(--space-2) 0; }
  .inv-linkrow { display: flex; gap: var(--space-2); }
  .inv-link {
    flex: 1; min-width: 0;
    padding: 10px 12px;
    background: var(--bg-input);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control);
    color: var(--text-primary); font: inherit;
  }
  .inv-copy, .inv-new {
    border: 0; border-radius: var(--radius-control);
    background: var(--brand); color: var(--text-on-solid);
    padding: 10px 14px; cursor: pointer; font-weight: 600;
    transition: background var(--duration-fast);
    white-space: nowrap;
  }
  .inv-copy:hover, .inv-new:hover { background: var(--brand-hover); }
  .inv-copy.copied { background: var(--green); }
  .inv-new { background: transparent; color: var(--text-2); border: 1px solid var(--border-subtle); }
  .inv-new:hover { background: var(--surface-hover); color: var(--text-primary); }
  .inv-new:disabled { opacity: .6; cursor: default; }

  @media (max-width: 560px) {
    .inv-overlay {
      padding: 0;
      place-items: end center;
      background: color-mix(in srgb, var(--bg-0) 76%, transparent);
      backdrop-filter: blur(5px);
    }
    .inv-card {
      width: 100%;
      max-height: min(88dvh, var(--bridge-visual-viewport-height, 88dvh));
      overflow-y: auto;
      padding: var(--space-5) var(--space-4) calc(var(--space-5) + env(safe-area-inset-bottom));
      border-right: 0; border-bottom: 0; border-left: 0;
      border-radius: var(--radius-modal) var(--radius-modal) 0 0;
      box-shadow: var(--shadow-xl);
      overscroll-behavior: contain;
    }
    .inv-x { min-width: 40px; min-height: 40px; padding: 0; }
    .inv-linkrow { flex-direction: column; }
    .inv-copy, .inv-new { min-height: 44px; }
  }

  @media (prefers-reduced-motion: reduce) {
    .inv-copy, .inv-new { transition: none; }
  }
</style>
