<!-- client/js/core/settings/tabs/PrivacyTab.svelte -->
<!-- ADR-0002 Faz 1 — Gizlilik ayarları tabı.         -->
<!-- Sprint 54: PrivacyTab tamamlandı.                 -->

<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { onDestroy, onMount } from 'svelte';
  import { expectedFromPortablePreview, portableAccountId, verifiedPortablePreview, type PortableProfilePreview } from '../portable-profile-import';
  import type { SettingsStore } from '../stores/settingsStore';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import { logout, showAuthMsg, updateUserPanel } from '../../auth-compat.js';
  let { store }: { store: SettingsStore } = $props();

  // ── State ─────────────────────────────────────────────────────────────────
  interface Me {
    dmPrivacy?: 'everyone' | 'friends' | 'none';
    presenceVisibility?: 'visible' | 'hidden';
    /** P7 B2: false for an SSO-only account (no password to type). */
    hasPassword?: boolean;
    [key: string]: unknown;
  }
  const me = BridgeRegistry.get<() => Me | null>('getMe')?.() ?? null;
  let initialDm = me?.dmPrivacy ?? 'everyone';
  let initialPresence = me?.presenceVisibility ?? 'visible';
  let directMessages  = $state<'everyone' | 'friends' | 'none'>(initialDm);
  let onlineStatus    = $state(initialPresence !== 'hidden');
  const dirty = $derived(directMessages !== initialDm || onlineStatus !== (initialPresence !== 'hidden'));

  let saving  = $state(false);
  let saved   = $state(false);
  let error   = $state<string | null>(null);
  let exporting = $state(false);
  let aiAssistance = $state(Boolean(BridgeRegistry.call<boolean>('getAiAssistanceEnabled')));
  let savedResetTimer: ReturnType<typeof setTimeout> | null = null;

  function toggleAiAssistance(): void {
    aiAssistance = !aiAssistance;
    BridgeRegistry.call('setAiAssistanceEnabled', aiAssistance);
  }

  async function exportMyData(portable = false): Promise<void> {
    if (exporting) return;
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    if (!apiFetch) { error = t("ui_veri_disa_aktarma_su_anda_kullanilamiyor", "Veri dışa aktarma şu anda kullanılamıyor."); return; }
    exporting = true;
    error = null;
    try {
      const response = await apiFetch(portable ? '/api/account/portable-export' : '/api/account/export');
      if (!response.ok) {
        error = response.status === 503
          ? t("ui_veri_disa_aktarma_bu_kurulumda_su_anda_kullanilamiyo", "Veri dışa aktarma bu kurulumda şu anda kullanılamıyor.")
          : t("ui_veriler_disa_aktarilamadi", "Veriler dışa aktarılamadı.");
        return;
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = portable
        ? `bridge-portable-identity-v1-${new Date().toISOString().slice(0, 10)}.json`
        : `bridge-personal-export-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch {
      error = t("ui_veriler_disa_aktarilamadi", "Veriler dışa aktarılamadı.");
    } finally {
      exporting = false;
    }
  }

  // P7 C3: preview and apply are deliberately separate privileged actions.
  // The imported JSON stays ONLY in memory; a second explicit checkbox + typed
  // confirmation are required before sending a profile-only, guarded UPDATE.
  let previewingPortable = $state(false);
  let portablePreview = $state<PortableProfilePreview | null>(null);
  let portablePreviewError = $state(false);
  let portableApplyAck = $state(false);
  let portableApplyPhrase = $state('');
  let applyingPortable = $state(false);
  let portableApplyError = $state<string | null>(null);
  let portableApplySuccess = $state(false);
  let portableDocument = $state.raw<unknown | null>(null);
  let portableOwner = $state<string | null>(null);
  let portableRequestSeq = 0;

  const portableHasChanges = $derived(Boolean(portablePreview?.fields.some(field => field.changed)));
  const canApplyPortable = $derived(
    portablePreview !== null && portableDocument !== null && portableOwner !== null &&
    portableHasChanges && portableApplyAck && portableApplyPhrase.trim() === 'IMPORT' &&
    !previewingPortable && !applyingPortable,
  );

  function signedInPortableOwner(): string | null {
    return portableAccountId(BridgeRegistry.call('getMe'));
  }

  function resetPortableImport(): void {
    portableRequestSeq += 1;
    // Invalidate the previous in-flight request AND release the UI lock. Its
    // finally block checks the sequence and cannot affect a newer operation.
    previewingPortable = false;
    applyingPortable = false;
    portableDocument = null;
    portableOwner = null;
    portablePreview = null;
    portablePreviewError = false;
    portableApplyAck = false;
    portableApplyPhrase = '';
    portableApplyError = null;
    portableApplySuccess = false;
  }

  async function previewPortableFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    if (!file || previewingPortable || applyingPortable) return;
    resetPortableImport();
    if (file.size > 16 * 1024) { portablePreviewError = true; return; }
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    const owner = signedInPortableOwner();
    if (!apiFetch || !owner) { portablePreviewError = true; return; }
    const seq = ++portableRequestSeq;
    previewingPortable = true;
    try {
      const content = JSON.parse(await file.text()) as unknown;
      if (seq !== portableRequestSeq || signedInPortableOwner() !== owner) return;
      const response = await apiFetch('/api/account/portable-import/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(content),
      });
      if (seq !== portableRequestSeq || signedInPortableOwner() !== owner) return;
      if (!response.ok) { portablePreviewError = true; return; }
      const result = verifiedPortablePreview(await response.json() as unknown, owner);
      if (seq !== portableRequestSeq || signedInPortableOwner() !== owner) return;
      if (!result) { portablePreviewError = true; return; }
      portableDocument = content;
      portableOwner = owner;
      portablePreview = result;
    } catch {
      if (seq === portableRequestSeq) portablePreviewError = true;
    } finally {
      if (seq === portableRequestSeq) previewingPortable = false;
    }
  }

  async function applyPortableProfile(): Promise<void> {
    if (applyingPortable || !canApplyPortable || !portablePreview || !portableDocument || !portableOwner) return;
    if (signedInPortableOwner() !== portableOwner) {
      resetPortableImport();
      portableApplyError = t('privacy_portable_account_changed', 'Hesap değişti. Dosyayı tekrar seçip önizleyin.');
      return;
    }
    const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
    if (!apiFetch) { portableApplyError = t('privacy_portable_apply_error', 'Profil içe aktarılamadı. Yeniden deneyin.'); return; }
    const owner = portableOwner;
    const seq = ++portableRequestSeq;
    const body = {
      document: portableDocument,
      expected: expectedFromPortablePreview(portablePreview),
      targetUserId: owner, // server MUST reject if authentication changed during step-up
      confirm: 'APPLY_PORTABLE_PROFILE',
    };
    applyingPortable = true;
    portableApplyError = null;
    portableApplySuccess = false;
    try {
      const response = await apiFetch('/api/account/portable-import/apply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (seq !== portableRequestSeq || signedInPortableOwner() !== owner) return;
      if (response.status === 409) {
        resetPortableImport(); // stale preview must NEVER be resubmitted
        portableApplyError = t('privacy_portable_conflict', 'Profiliniz önizlemeden sonra değişti. Dosyayı yeniden seçin ve tekrar önizleyin.');
        return;
      }
      if (!response.ok) {
        portableApplyError = response.status === 403
          ? t('privacy_portable_proof_required', 'Güvenlik doğrulaması gerekli; işlem yapılmadı.')
          : t('privacy_portable_apply_error', 'Profil içe aktarılamadı. Yeniden deneyin.');
        return;
      }
      const result = await response.json() as { ok?: boolean; applied?: boolean; targetUserId?: string; version?: number };
      if (seq !== portableRequestSeq || signedInPortableOwner() !== owner) return;
      if (result.ok !== true || result.applied !== true || result.targetUserId !== owner || result.version !== 1) {
        resetPortableImport();
        portableApplyError = t('privacy_portable_apply_error', 'Profil içe aktarılamadı. Yeniden deneyin.');
        return;
      }
      // Reflect only the verified six fields after the server's confirmed
      // atomic write. Use a fresh object so Svelte's canonical identity owner
      // and the header/profile panel see the same state (no direct mutation
      // of the prior profile reference).
      const currentMe = BridgeRegistry.call<Record<string, unknown> | null>('getMe');
      if (currentMe && portableAccountId(currentMe) === owner) {
        const updatedMe = { ...currentMe };
        for (const field of portablePreview.fields) updatedMe[field.field] = field.proposed;
        if (BridgeRegistry.has('setMe')) BridgeRegistry.call('setMe', updatedMe);
        // The existing Profile tab still reads the legacy auth-compat
        // currentUser reference. Keep it in sync with AppState, but ONLY when
        // it belongs to the same authenticated account as the accepted write.
        const legacy = globalThis as typeof globalThis & {
          currentUser?: Record<string, unknown> | null;
          me?: Record<string, unknown> | null;
        };
        if (portableAccountId(legacy.currentUser) === owner) legacy.currentUser = updatedMe;
        if (portableAccountId(legacy.me) === owner) legacy.me = updatedMe;
        updateUserPanel(updatedMe as Parameters<typeof updateUserPanel>[0]);
      }
      resetPortableImport(); // NEVER leave a successful write armed for replay
      portableApplySuccess = true;
    } catch {
      if (seq === portableRequestSeq) portableApplyError = t('privacy_portable_apply_error', 'Profil içe aktarılamadı. Yeniden deneyin.');
    } finally {
      if (seq === portableRequestSeq) applyingPortable = false;
    }
  }

  onMount(() => {
    // A new login may replace the current account while Settings remains
    // mounted. Remove even a successfully previewed previous user's details.
    const onIdentityTransition = () => resetPortableImport();
    document.addEventListener('bridge:auth-logout', onIdentityTransition);
    document.addEventListener('bridge:auth-success', onIdentityTransition);
    return () => {
      document.removeEventListener('bridge:auth-logout', onIdentityTransition);
      document.removeEventListener('bridge:auth-success', onIdentityTransition);
    };
  });

  // ── Hesabı sil (Final21 Faz 19) ──────────────────────────────────────────
  // Sunucuda eksiksiz bir silme ucu ve ön denetim vardı (`DELETE /api/account`,
  // `GET /api/account/deletion-preflight`) ama istemcide HİÇBİR giriş noktası yoktu:
  // kişi hesabını üründen silemiyordu. Akış: ön denetim → sahiplik engeli varsa listelenir
  // (sessiz devir yok) → yoksa parola + açık onay → silme → oturum kapanır.
  interface DeletionBlocker { kind: string; id: string; name?: string; memberCount: number }
  type DeleteStage = 'closed' | 'checking' | 'blocked' | 'ready' | 'deleting';
  let deleteStage    = $state<DeleteStage>('closed');
  let blockers       = $state<DeletionBlocker[]>([]);
  let deletePassword = $state('');
  let deleteAck      = $state(false);
  let deleteError    = $state<string | null>(null);
  // P7 B2: an SSO-only account has no password to type. Its deletion is proven by
  // a recent sign-in (the step-up grant its SSO sign-in returned); otherwise the
  // step-up owner explains that signing in again is needed.
  const passwordless = me?.hasPassword === false;
  const canConfirmDelete = $derived(deleteStage === 'ready' && deleteAck && (passwordless || deletePassword.length > 0));

  function blockerText(b: DeletionBlocker): string {
    return b.kind === 'server'
      ? t('privacy_delete_blocker_server', undefined, { name: b.name ?? '', count: b.memberCount })
      : t('privacy_delete_blocker_group', undefined, { count: b.memberCount });
  }

  function deletionApi(): ((url: string, init?: RequestInit) => Promise<Response>) | null {
    return BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch') ?? null;
  }

  async function startDeletion(): Promise<void> {
    const apiFetch = deletionApi();
    if (!apiFetch) { deleteError = t('privacy_delete_unavailable'); return; }
    deleteStage = 'checking';
    deleteError = null;
    try {
      const response = await apiFetch('/api/account/deletion-preflight');
      if (!response.ok) {
        deleteStage = 'closed';
        deleteError = response.status === 503 ? t('privacy_delete_unavailable') : t('privacy_delete_failed');
        return;
      }
      const body = await response.json() as { blockers?: DeletionBlocker[] };
      blockers = Array.isArray(body.blockers) ? body.blockers : [];
      deleteStage = blockers.length ? 'blocked' : 'ready';
    } catch {
      deleteStage = 'closed';
      deleteError = t('privacy_delete_failed');
    }
  }

  function cancelDeletion(): void {
    deleteStage = 'closed';
    blockers = [];
    deletePassword = '';
    deleteAck = false;
    deleteError = null;
  }

  async function confirmDeletion(): Promise<void> {
    if (!canConfirmDelete) return;
    const apiFetch = deletionApi();
    if (!apiFetch) { deleteError = t('privacy_delete_unavailable'); return; }
    deleteStage = 'deleting';
    deleteError = null;
    try {
      const response = await apiFetch('/api/account', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(passwordless ? { confirm: 'DELETE' } : { confirm: 'DELETE', password: deletePassword }),
      });
      if (response.ok) {
        deletePassword = '';
        // Sunucu oturumları ve jetonları zaten iptal etti; istemci durumu temizlenir.
        logout();
        showAuthMsg(t('privacy_delete_done'), 'success');
        return;
      }
      if (response.status === 409) {
        // Ön denetimden SONRA bir sunucu sahipliği oluşmuş olabilir.
        const body = await response.json().catch(() => ({})) as { blockers?: DeletionBlocker[] };
        blockers = Array.isArray(body.blockers) ? body.blockers : [];
        deletePassword = '';
        deleteStage = blockers.length ? 'blocked' : 'ready';
        if (!blockers.length) deleteError = t('privacy_delete_failed');
        return;
      }
      deleteStage = 'ready';
      deleteError = response.status === 400 ? t('privacy_delete_wrong_password')
        : response.status === 403 ? t('privacy_delete_needs_proof')
        : response.status === 503 ? t('privacy_delete_unavailable')
        : t('privacy_delete_failed');
    } catch {
      deleteStage = 'ready';
      deleteError = t('privacy_delete_failed');
    }
  }

  // ── Kaydet ────────────────────────────────────────────────────────────────
  async function save() {
    saving = true;
    error  = null;
    saved  = false;
    try {
      const ok = await store.save({
        dmPrivacy: directMessages,
        presenceVisibility: onlineStatus ? 'visible' : 'hidden',
      });

      if (ok) {
        const nextPresence = onlineStatus ? 'visible' : 'hidden';
        const presenceChanged = nextPresence !== initialPresence;
        initialDm = directMessages;
        initialPresence = nextPresence;
        if (me) {
          me.dmPrivacy = directMessages;
          me.presenceVisibility = nextPresence;
        }
        // Socket handshake sunucu-truth tercihini ilk presence broadcast'inden
        // önce uygular. Bağlantıyı kontrollü yenilemek, eski görünürlükle açık
        // kalan bir socket bırakmaz.
        if (presenceChanged) {
          BridgeRegistry.get<() => void>('disconnectSocket')?.();
          BridgeRegistry.get<() => void>('connectSocket')?.();
        }
        saved = true;
        if (savedResetTimer) clearTimeout(savedResetTimer);
        savedResetTimer = setTimeout(() => { savedResetTimer = null; saved = false; }, 2000);
      } else {
        error = store.error ?? 'Kaydedilemedi';
      }
    } finally {
      saving = false;
    }
  }

  onDestroy(() => {
    resetPortableImport();
    if (savedResetTimer) { clearTimeout(savedResetTimer); savedResetTimer = null; }
  });
</script>

<section aria-labelledby="privacy-heading">
  <h2 id="privacy-heading" class="section-title">{t('ui_gizlilik')}</h2>

  <!-- ── DM izinleri ────────────────────────────────────────────────────── -->
  <div class="field-group">
    <label class="field-label" for="dm-perm">{t('markup_kimden_dm_alabilirim_6df19a8', "Kimden DM alabilirim")}</label>
    <select
      id="dm-perm"
      class="field-select"
      bind:value={directMessages}
      aria-describedby="dm-perm-note"
    >
      <option value="everyone">{t('markup_herkes_20fc39a', "Herkes")}</option>
      <option value="friends">{t('priv_friends_only', 'Yalnızca arkadaşlar')}</option>
      <option value="none">{t('markup_kimse_57f657e', "Kimse")}</option>
    </select>
    <p id="dm-perm-note" class="field-note">
      {t('markup_bu_politika_yeni_dm_ve_grup_dm_baslangiclarinda__573738d', "Bu politika yeni DM ve grup DM başlangıçlarında sunucu tarafından uygulanır.")}
    </p>
  </div>

  <!-- ── Toggle satırları ───────────────────────────────────────────────── -->
  <div class="toggle-row" role="group" aria-label={t('attr_okundu_bilgisi_c68bf07', "Okundu bilgisi")}>
    <div class="toggle-info">
      <span class="toggle-title">{t('markup_okundu_bilgisi_67a0a02', "Okundu Bilgisi")}</span>
      <span class="toggle-desc">{t('priv_read_receipts', 'DM\'lerde mesajların okunduğunu göster')}</span>
    </div>
    <button
      class="toggle-btn"
      disabled
      aria-pressed="true"
      aria-label={t('priv_read_locked', 'Okundu bilgisi henüz değiştirilemiyor')}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>
  <p class="field-note">{t('priv_read_unavailable', 'Okundu bilgisi için sunucu tarafında kullanıcı tercihi henüz yok.')}</p>

  <div class="toggle-row" role="group" aria-label={t('priv_online_label', 'Çevrimiçi durumu')}>
    <div class="toggle-info">
      <span class="toggle-title">{t('priv_online_status', 'Çevrimiçi Durumu')}</span>
      <span class="toggle-desc">{t('priv_online_allow', 'Başkalarının seni çevrimiçi görmesine izin ver')}</span>
    </div>
    <button
      class="toggle-btn"
      class:on={onlineStatus}
      aria-pressed={onlineStatus}
      aria-label={t('priv_online_toggle', 'Çevrimiçi durumu {state}', { state: onlineStatus ? t('common_off', 'kapat') : t('common_on', 'aç') })}
      onclick={() => { onlineStatus = !onlineStatus; }}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>

  <div class="toggle-row" role="group" aria-label={t('attr_veri_toplama_d6d503e', "Veri toplama")}>
    <div class="toggle-info">
      <span class="toggle-title">{t('priv_anon_data', 'Anonim Kullanım Verisi')}</span>
      <span class="toggle-desc">{t('priv_anon_share', 'Uygulamayı iyileştirmek için anonim veri paylaş')}</span>
    </div>
    <button
      class="toggle-btn"
      disabled
      aria-pressed="false"
      aria-label={t('priv_anon_locked', 'Anonim veri tercihi henüz değiştirilemiyor')}
    >
      <span class="toggle-knob"></span>
    </button>
  </div>
  <p class="field-note">{t('priv_analytics_unavail', 'Bu kurulumda istemci kullanım analitiği tercihi bağlı değil.')}</p>

  <div class="privacy-card" aria-labelledby="privacy-control-heading">
    <div>
      <h3 id="privacy-control-heading">{t("privacy_data_controls")}</h3>
      <p class="field-note">{t("privacy_export_hint")}</p>
    </div>
    <button type="button" class="btn btn--secondary" disabled={exporting} onclick={() => void exportMyData()}>
      {exporting ? t("surface_haz_rlan_yor_aa7fb7") : t("surface_verilerimi_d_sa_aktar_86f34a")}
    </button>
    <button type="button" class="btn btn--secondary" disabled={exporting} data-testid="portable-identity-export"
            onclick={() => void exportMyData(true)}>
      {t('privacy_portable_export', 'Taşınabilir profilimi indir (JSON v1)')}
    </button>
    <p class="field-note">{t('privacy_portable_export_hint', 'Yalnızca profil alanlarını içerir; parola, e-posta ve mesajlar dahil değildir. Desteklenen profil alanları başka bir Bridge hesabına güvenli şekilde uygulanabilir; tam hesap ve topluluk taşıma henüz desteklenmiyor.')}</p>
    <label class="field-label" for="portable-identity-file">{t('privacy_portable_preview_select', 'Taşınabilir profil dosyasını önizle (JSON v1)')}</label>
    <input id="portable-identity-file" class="field-input" type="file" accept=".json,application/json"
           data-testid="portable-identity-preview-file" disabled={previewingPortable || applyingPortable}
           onchange={(event) => void previewPortableFile(event)} />
    {#if previewingPortable}
      <p class="field-note">{t('privacy_portable_preview_loading', 'Dosyanın bütünlüğü kontrol ediliyor…')}</p>
    {/if}
    {#if portablePreviewError}
      <p class="field-error" role="alert">{t('privacy_portable_preview_error', 'Dosya geçersiz, değiştirilmiş veya desteklenmeyen bir sürümde.')}</p>
    {/if}
    {#if portablePreview}
      <p class="field-note" role="status" data-testid="portable-identity-preview-ok">
        {t('privacy_portable_preview_result', 'Yalnızca önizleme: hesabınızda hiçbir değişiklik kaydedilmedi.')}
      </p>
      <ul class="field-note">
        {#each portablePreview.fields.filter(field => field.changed) as field (field.field)}
          <li>{field.field}: {field.current} → {field.proposed}</li>
        {/each}
      </ul>
      {#if portableHasChanges}
        <div class="field-group" data-testid="portable-identity-apply-panel">
          <p class="field-note" id="portable-import-risk">
            {t('privacy_portable_apply_warning', 'Bu işlem yalnızca görünen ad, biyografi, web sitesi, zamirler ve profil renklerini değiştirir. Kullanıcı adını, mesajları veya üyelikleri taşımaz.')}
          </p>
          <label class="field-label">
            <input type="checkbox" bind:checked={portableApplyAck} disabled={applyingPortable}
                   data-testid="portable-identity-apply-ack" />
            {t('privacy_portable_apply_ack', 'Önizlemedeki değişiklikleri kendi hesabıma uygulamak istediğimi onaylıyorum.')}
          </label>
          <label class="field-label" for="portable-import-phrase">
            {t('privacy_portable_apply_phrase', 'Onaylamak için IMPORT yazın.')}
          </label>
          <input class="field-input" id="portable-import-phrase" autocomplete="off"
                 data-testid="portable-identity-apply-phrase" bind:value={portableApplyPhrase}
                 disabled={applyingPortable} aria-describedby="portable-import-risk" />
          <button class="btn btn--secondary" type="button"
                  data-testid="portable-identity-apply"
                  disabled={!canApplyPortable}
                  onclick={() => void applyPortableProfile()}>
            {applyingPortable
              ? t('privacy_portable_applying', 'Profil uygulanıyor…')
              : t('privacy_portable_apply', 'Profil değişikliklerini uygula')}
          </button>
          <button class="btn btn--secondary" type="button" disabled={applyingPortable}
                  data-testid="portable-identity-apply-cancel"
                  onclick={resetPortableImport}>
            {t('cancel', 'İptal')}
          </button>
        </div>
      {:else}
        <p class="field-note">{t('privacy_portable_no_changes', 'İçe aktarılacak profil farkı bulunamadı.')}</p>
      {/if}
    {/if}
    {#if portableApplyError}
      <p class="field-error" role="alert" data-testid="portable-identity-apply-error">{portableApplyError}</p>
    {/if}
    {#if portableApplySuccess}
      <p class="field-note" role="status" data-testid="portable-identity-apply-success">
        {t('privacy_portable_apply_success', 'Desteklenen profil alanları güncellendi. Güncel bilgileri görmek için profilinizi yeniden açın.')}
      </p>
    {/if}
  </div>

  <div class="toggle-row" role="group" aria-label={t("privacy_ai_opt_in")}>
    <div class="toggle-info">
      <span class="toggle-title">{t("privacy_ai_opt_in")}</span>
      <span class="toggle-desc">{t('markup_ozetleme_ve_benzeri_ai_ozellikleri_icin_yerel_iz_994d61e', "Özetleme ve benzeri AI özellikleri için yerel izin. Varsayılan kapalıdır; bunu açmak tek başına veri göndermez.")}</span>
    </div>
    <button type="button" class="toggle-btn" class:on={aiAssistance} aria-pressed={aiAssistance}
            aria-label={aiAssistance ? t("surface_yapay_zeka_yard_m_n_kapat_6b0305") : t("surface_yapay_zeka_yard_m_n_ac_8580b4")}
            onclick={toggleAiAssistance}>
      <span class="toggle-knob"></span>
    </button>
  </div>
  <p class="field-note">{t('markup_ai_destegi_privacy_first_ve_opt_in_kalir_sunucu__a228a6d', "AI desteği privacy-first ve opt-in kalır. Sunucu özelliği ayrıca etkin değilse hiçbir AI çağrısı yapılmaz.")}</p>

  <!-- ── Kaydet ──────────────────────────────────────────────────────────── -->
  <div class="field-actions">
    <button
      class="btn btn--primary"
      class:btn--saved={saved}
      disabled={saving || !dirty}
      onclick={save}
    >
      {#if saving}
        {t('ui_saving')}
      {:else if saved}
        ✓ {t('ui_saved')}
      {:else}
        {t('save')}
      {/if}
    </button>
    {#if error}
      <span class="field-error" role="alert">{error}</span>
    {/if}
  </div>

  <!-- ── Hesabı sil ─────────────────────────────────────────────────────── -->
  <div class="danger-card" aria-labelledby="delete-account-heading" data-testid="delete-account">
    <h3 id="delete-account-heading">{t('privacy_delete_title')}</h3>
    <p class="field-note" id="delete-account-hint">{t('privacy_delete_hint')}</p>

    {#if deleteStage === 'closed' || deleteStage === 'checking'}
      <button type="button" class="btn btn--danger-outline" aria-describedby="delete-account-hint" data-testid="delete-account-start"
              disabled={deleteStage === 'checking'} onclick={() => void startDeletion()}>
        {deleteStage === 'checking' ? t('privacy_delete_checking') : t('privacy_delete_start')}
      </button>
    {:else if deleteStage === 'blocked'}
      <p class="field-note">{t('privacy_delete_blocked')}</p>
      <ul class="delete-blockers" data-testid="delete-account-blockers">
        {#each blockers as blocker (blocker.kind + blocker.id)}
          <li>{blockerText(blocker)}</li>
        {/each}
      </ul>
      <button type="button" class="btn btn--secondary" data-testid="delete-account-cancel" onclick={cancelDeletion}>{t('cancel')}</button>
    {:else}
      <form class="delete-form" onsubmit={(e) => { e.preventDefault(); void confirmDeletion(); }}>
        {#if passwordless}
          <p class="field-note" data-testid="delete-account-sso-note">{t('privacy_delete_sso_note')}</p>
        {:else}
          <label class="field-label" for="delete-account-password">{t('privacy_delete_password')}</label>
          <input id="delete-account-password" class="field-input" type="password" autocomplete="current-password"
                 bind:value={deletePassword} disabled={deleteStage === 'deleting'} data-testid="delete-account-password" />
        {/if}
        <label class="delete-ack">
          <input type="checkbox" bind:checked={deleteAck} disabled={deleteStage === 'deleting'} data-testid="delete-account-ack" />
          <span>{t('privacy_delete_ack')}</span>
        </label>
        <div class="delete-actions">
          <button type="submit" class="btn btn--danger" disabled={!canConfirmDelete} data-testid="delete-account-confirm">
            {deleteStage === 'deleting' ? t('privacy_delete_deleting') : t('privacy_delete_confirm')}
          </button>
          <button type="button" class="btn btn--secondary" disabled={deleteStage === 'deleting'} data-testid="delete-account-cancel" onclick={cancelDeletion}>{t('cancel')}</button>
        </div>
      </form>
    {/if}
    {#if deleteError}
      <p class="field-error" role="alert">{deleteError}</p>
    {/if}
  </div>
</section>

<style>
  .section-title {
    font-size: 20px;
    font-weight: 700;
    margin: 0 0 24px;
    color: var(--text-primary, #e4e6eb);
  }

  .field-group   { margin-bottom: 24px; }

  /* Devre dışı bırakılmış kontrolün nedenini açıklayan not. */
  .field-note {
    margin: 6px 0 0;
    font-size: var(--text-xs, .75rem);
    line-height: 1.4;
    color: var(--text-muted, #8a91ad);
  }
  .field-select:disabled { opacity: .55; cursor: not-allowed; }

  .field-label {
    display: block;
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted, #6d6f78);
    margin-bottom: 8px;
  }

  .field-select {
    width: 100%;
    max-width: 280px;
    padding: 10px 12px;
    border: 1px solid var(--border, color-mix(in srgb, var(--text-primary) 10%, transparent));
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-primary, #e4e6eb);
    font-size: 14px;
    outline: none;
    cursor: pointer;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236d6f78' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    padding-right: 36px;
  }

  .field-select:focus { border-color: var(--brand, #2d9cdb); }

  /* Toggle satırları */
  .toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 14px 0;
    border-bottom: 1px solid color-mix(in srgb, var(--text-primary) 6%, transparent);
  }

  .toggle-info  { display: flex; flex-direction: column; gap: 2px; }
  .toggle-title { font-size: 14px; font-weight: 500; color: var(--text-primary, #e4e6eb); }
  .toggle-desc  { font-size: 12px; color: var(--text-muted, #6d6f78); }

  .toggle-btn {
    position: relative;
    width: 44px;
    height: 24px;
    border: none;
    border-radius: 12px;
    background: var(--bg-input);
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
  }

  .toggle-btn.on  { background: var(--brand, #2d9cdb); }
  .toggle-btn:disabled { opacity: 0.5; cursor: not-allowed; }

  .toggle-knob {
    position: absolute;
    top: 2px; left: 2px;
    width: 20px; height: 20px;
    border-radius: 50%;
    background: var(--text-on-solid);
    transition: transform 0.2s;
  }

  .toggle-btn.on .toggle-knob { transform: translateX(20px); }

  /* Kaydet butonu */
  .field-actions { margin-top: 24px; display: flex; align-items: center; gap: 12px; }

  .btn {
    padding: 9px 20px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: opacity 0.1s, background 0.1s;
  }

  .btn--primary {
    background: var(--brand, #2d9cdb);
    color: var(--text-on-solid);
  }

  .btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn--primary:not(:disabled):hover { background: var(--brand-hover, #677bc4); }
  .btn--saved   { background: var(--success) !important; }

  .field-error {
    font-size: 13px;
    color: var(--danger);
  }

  .privacy-card { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin: 20px 0; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-surface); background: var(--bg-3); }
  .privacy-card h3 { margin: 0 0 2px; font-size: 14px; color: var(--text-primary); }
  .btn--secondary { background: var(--bg-4); color: var(--text-primary); border: 1px solid var(--border-strong); }
  .btn--secondary:hover:not(:disabled) { background: var(--bg-hover); }
  @media (max-width: 560px) { .privacy-card { align-items: stretch; flex-direction: column; } }

  /* Hesabı sil — geri alınamaz eylem, diğer ayarlardan görsel olarak ayrılır. */
  .danger-card { margin-top: 32px; padding: 16px; border: 1px solid color-mix(in srgb, var(--danger) 45%, transparent); border-radius: var(--radius-surface); background: color-mix(in srgb, var(--danger) 6%, var(--bg-3)); }
  .danger-card h3 { margin: 0 0 4px; font-size: 14px; color: var(--text-primary); }
  .danger-card .field-note { margin-bottom: 12px; }
  .delete-blockers { margin: 0 0 12px; padding-left: 20px; font-size: 13px; color: var(--text-primary); }
  .delete-form { display: flex; flex-direction: column; gap: 10px; max-width: 360px; }
  .field-input { padding: 9px 12px; border: 1px solid var(--border-strong); border-radius: 6px; background: var(--bg-input); color: var(--text-primary); font-size: 14px; }
  .field-input:focus { outline: none; border-color: var(--danger); }
  .delete-ack { display: flex; align-items: center; gap: 8px; font-size: 13px; color: var(--text-primary); cursor: pointer; }
  .delete-actions { display: flex; flex-wrap: wrap; gap: 8px; }
  .btn--danger { background: var(--danger); color: var(--text-on-solid); }
  .btn--danger:disabled { opacity: .45; cursor: not-allowed; }
  .btn--danger-outline { background: transparent; color: var(--danger); border: 1px solid var(--danger); }
  .btn--danger-outline:disabled { opacity: .6; cursor: progress; }
</style>
