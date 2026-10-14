<!-- client/js/core/server-settings/tabs/PortableTab.svelte -->
<!-- P7 C4 — owner-facing portable community export / import.               -->
<!-- Export: download a snapshot signed with THIS installation's key.         -->
<!-- Import: verify a signed snapshot against this installation's operator-   -->
<!-- pinned keys, map every row onto an existing row, review what changes,    -->
<!-- approve once (a short-lived token kept only in memory), then apply.      -->
<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { onDestroy } from 'svelte';
  import { BridgeRegistry } from '../../bridge-registry.js';
  import {
    KINDS, MAX_BUNDLE_BYTES, applyBody, approvalBody, candidates, canonicalOrigin, classify,
    mappingProblem, parseSignedBundle, renames, reviewBody, structureRows, suggestLinks,
    type Kind, type Links, type Outcome, type Phase, type PortableStructure, type ReviewInput, type SignedBundle,
  } from '../portable-community-import';

  interface Props { serverId: string; isOwner: boolean; }
  let { serverId, isOwner }: Props = $props();

  type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
  interface Review { reviewFingerprint: string; unsafeRoleMappings: number; unsupportedPermissionRows: number }

  const base = $derived(`/api/servers/${encodeURIComponent(serverId)}`);

  let exporting = $state(false);
  let exportOutcome = $state<Outcome | null>(null);

  let bundle = $state.raw<SignedBundle | null>(null);
  let fileError = $state(false);
  let expectedOrigin = $state('');
  let expectedId = $state('');
  let target = $state.raw<PortableStructure | null>(null);
  let targetDigest = $state<string | null>(null);
  let links = $state.raw<Links>({ categories: {}, roles: {}, channels: {} });
  let review = $state.raw<Review | null>(null);
  let confirmed = $state(false);
  // The bearer approval token lives ONLY in this component's memory.
  let approval = $state.raw<{ token: string; expiresAt: number } | null>(null);
  let remaining = $state(0);
  let applied = $state.raw<{ categories: number; roles: number; channels: number } | null>(null);
  let busy = $state<Phase | null>(null);
  let outcome = $state<Outcome | 'expired' | null>(null);
  // Every action refuses to start while another is in flight, so `busy`
  // always belongs to the request that is finishing: release it even when
  // newer owner input made that request's answer stale (`seq`), or every
  // button would stay disabled until the page is reloaded.
  let seq = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const originOk = $derived(canonicalOrigin(expectedOrigin) !== null);
  const idOk = $derived(expectedId.trim().length > 0 && expectedId.trim() === expectedId && expectedId.length <= 256);
  const claimMismatch = $derived(!!bundle && originOk && idOk &&
    (expectedOrigin !== bundle.claimed.origin || expectedId !== bundle.claimed.serverId));
  const problem = $derived(bundle && target ? mappingProblem(bundle.rows, target, links) : null);
  const changes = $derived(bundle && target ? renames(bundle.rows, target, links) : []);
  const blocked = $derived(!!review && (review.unsafeRoleMappings > 0 || review.unsupportedPermissionRows > 0));

  function api(): Fetch | null { return BridgeRegistry.get<Fetch>('apiFetch') ?? null; }

  function stopTimer(): void { if (timer) { clearInterval(timer); timer = null; } }
  onDestroy(stopTimer);

  /** Any change to the inputs invalidates every later step. */
  function resetFrom(step: 'file' | 'target' | 'review'): void {
    seq += 1;
    stopTimer();
    approval = null;
    confirmed = false;
    review = null;
    applied = null;
    outcome = null;
    if (step === 'file' || step === 'target') { target = null; targetDigest = null; links = { categories: {}, roles: {}, channels: {} }; }
    if (step === 'file') { bundle = null; fileError = false; }
  }

  async function call(phase: Phase, path: string, init?: RequestInit): Promise<{ status: number; body: Record<string, unknown> }> {
    const fetcher = api();
    if (!fetcher) return { status: 0, body: {} };
    try {
      const response = await fetcher(path, init);
      let body: Record<string, unknown> = {};
      try { body = (await response.json()) as Record<string, unknown>; } catch { /* empty */ }
      return { status: response.status, body };
    } catch {
      // No answer arrived: for apply this is "outcome unknown", never "failed".
      return { status: 0, body: {} };
    }
  }
  const post = (phase: Phase, path: string, body: unknown) =>
    call(phase, path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  async function exportSnapshot(): Promise<void> {
    if (exporting || !isOwner) return;
    exporting = true;
    exportOutcome = null;
    try {
      const { status, body } = await call('export', `${base}/portable-export/attested-pair`);
      if (status !== 200 || !body.structure || !body.permissions || !body.attestation) {
        exportOutcome = classify('export', status, body.error ?? body.code);
        return;
      }
      const file = JSON.stringify({ structure: body.structure, permissions: body.permissions, attestation: body.attestation });
      const url = URL.createObjectURL(new Blob([file], { type: 'application/json' }));
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `bridge-community-signed-${new Date().toISOString().slice(0, 10)}.json`;
      anchor.style.display = 'none';
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } finally {
      exporting = false;
    }
  }

  async function chooseFile(event: Event): Promise<void> {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    input.value = '';
    resetFrom('file');
    if (!file) return;
    if (file.size > MAX_BUNDLE_BYTES) { fileError = true; return; }
    const mine = seq;
    const parsed = parseSignedBundle(await file.text());
    if (mine !== seq) return;
    if (!parsed) { fileError = true; return; }
    bundle = parsed;
  }

  async function prepare(): Promise<void> {
    if (!bundle || !originOk || !idOk || busy) return;
    resetFrom('target');
    const mine = seq;
    busy = 'target';
    try {
      const fp = await call('target', `${base}/portable-import/target-fingerprint`);
      if (mine !== seq) return;
      if (fp.status !== 200 || typeof fp.body.targetTopologyDigest !== 'string') {
        outcome = classify('target', fp.status, fp.body.error ?? fp.body.code);
        return;
      }
      const own = await call('target', `${base}/portable-export`);
      if (mine !== seq) return;
      const rows = own.status === 200 ? structureRows(own.body) : null;
      if (!rows) { outcome = classify('target', own.status, own.body.error ?? own.body.code); return; }
      targetDigest = fp.body.targetTopologyDigest;
      target = rows;
      links = suggestLinks(bundle.rows, rows);
    } finally {
      busy = null;
    }
  }

  function choose(kind: Kind, sourceId: string, targetId: string): void {
    const next: Links = { ...links, [kind]: { ...links[kind] } };
    if (targetId) next[kind][sourceId] = targetId; else delete next[kind][sourceId];
    resetFrom('review');
    links = next;
  }

  function input(): ReviewInput | null {
    if (!bundle || !target || !targetDigest) return null;
    return { bundle, expectedOrigin, expectedServerId: expectedId, targetServerId: serverId, targetDigest, links };
  }

  async function runReview(): Promise<void> {
    const req = input();
    if (!req || problem || busy) return;
    resetFrom('review');
    const mine = seq;
    busy = 'review';
    try {
      const { status, body } = await post('review', `${base}/portable-import/signed-mapping-review`, reviewBody(req));
      if (mine !== seq) return;
      const counts = (body.counts ?? {}) as Record<string, unknown>;
      if (status !== 200 || typeof body.reviewFingerprint !== 'string') {
        outcome = classify('review', status, body.error ?? body.code);
        return;
      }
      review = {
        reviewFingerprint: body.reviewFingerprint,
        unsafeRoleMappings: Number(counts.unsafeRoleMappings) || 0,
        unsupportedPermissionRows: Number(counts.unsupportedPermissionRows) || 0,
      };
    } finally {
      busy = null;
    }
  }

  async function approve(): Promise<void> {
    const req = input();
    if (!req || !review || blocked || !confirmed || busy) return;
    const mine = seq;
    busy = 'approve';
    outcome = null;
    try {
      const { status, body } = await post('approve', `${base}/portable-import/owner-approval`, approvalBody(req, review.reviewFingerprint));
      if (mine !== seq) return;
      const expiresAt = Date.parse(String(body.expiresAt));
      if (status !== 201 || typeof body.approvalToken !== 'string' || !Number.isFinite(expiresAt)) {
        outcome = classify('approve', status, body.error ?? body.code);
        return;
      }
      approval = { token: body.approvalToken, expiresAt };
      tick();
      timer = setInterval(tick, 1000);
    } finally {
      busy = null;
    }
  }

  function tick(): void {
    if (!approval) return;
    remaining = Math.max(0, Math.ceil((approval.expiresAt - Date.now()) / 1000));
    if (remaining === 0) { stopTimer(); approval = null; outcome = 'expired'; }
  }

  async function apply(): Promise<void> {
    const req = input();
    if (!req || !review || !approval || busy) return;
    const mine = seq;
    const token = approval.token;
    busy = 'apply';
    outcome = null;
    try {
      const { status, body } = await post('apply', `${base}/portable-import/mapped-apply`, applyBody(req, review.reviewFingerprint, token));
      if (mine !== seq) return;
      // Whatever happened, this token is spent or unusable: never offer it again.
      stopTimer();
      approval = null;
      confirmed = false;
      const changed = (body.changed ?? {}) as Record<string, unknown>;
      if (status === 200 && body.applied === true && body.transactionCommitted === true) {
        applied = { categories: Number(changed.categories) || 0, roles: Number(changed.roles) || 0, channels: Number(changed.channels) || 0 };
        review = null;
        return;
      }
      review = null;
      outcome = classify('apply', status, body.error ?? body.code);
    } finally {
      busy = null;
    }
  }

  function kindLabel(kind: Kind): string {
    if (kind === 'categories') return t('pci_kind_categories');
    if (kind === 'roles') return t('pci_kind_roles');
    return t('pci_kind_channels');
  }

  function outcomeText(value: Outcome | 'expired'): string {
    switch (value) {
      case 'disabled': return t('pci_disabled');
      case 'not_owner': return t('pci_owner_only');
      case 'proof_needed': return t('pci_proof_needed');
      case 'unverified': return t('pci_review_unverified');
      case 'refused': return t('pci_refused');
      case 'unknown': return t('pci_unknown');
      case 'expired': return t('pci_expired');
      case 'invalid':
      case 'error':
      default: return t('pci_error');
    }
  }
</script>

<section class="pci" aria-labelledby="pci-title">
  <h3 id="pci-title">{t('pci_title')}</h3>
  <p class="pci-muted">{t('pci_intro')}</p>

  {#if !isOwner}
    <p class="pci-note" data-testid="pci-owner-only">{t('pci_owner_only')}</p>
  {:else}
    <fieldset class="srv-section">
      <legend>{t('pci_export_title')}</legend>
      <p class="pci-muted">{t('pci_export_body', undefined, { id: serverId })}</p>
      <button type="button" class="btn" data-testid="pci-export" disabled={exporting} onclick={exportSnapshot}>
        {t('pci_export_button')}
      </button>
      {#if exportOutcome}
        <p class="pci-error" role="alert" data-testid="pci-export-error">
          {exportOutcome === 'disabled' ? t('pci_export_disabled') : outcomeText(exportOutcome)}
        </p>
      {/if}
    </fieldset>

    <fieldset class="srv-section">
      <legend>{t('pci_import_title')}</legend>

      <label for="pci-file">{t('pci_file_label')}</label>
      <input id="pci-file" type="file" accept="application/json,.json" data-testid="pci-file" onchange={chooseFile} />
      {#if fileError}
        <p class="pci-error" role="alert" data-testid="pci-file-error">{t('pci_file_invalid')}</p>
      {/if}

      {#if bundle}
        <p class="pci-claims" data-testid="pci-claims">
          {t('pci_claims', undefined, { origin: bundle.claimed.origin, id: bundle.claimed.serverId, issued: bundle.claimed.issuedAt })}
        </p>
        <label for="pci-origin">{t('pci_expect_origin')}</label>
        <input id="pci-origin" class="input-field" data-testid="pci-origin" autocomplete="off" spellcheck="false"
          value={expectedOrigin} oninput={(e) => { expectedOrigin = (e.currentTarget as HTMLInputElement).value; resetFrom('target'); }} />
        {#if expectedOrigin && !originOk}<p class="pci-error">{t('pci_origin_invalid')}</p>{/if}
        <label for="pci-source-id">{t('pci_expect_id')}</label>
        <input id="pci-source-id" class="input-field" data-testid="pci-source-id" autocomplete="off" spellcheck="false"
          value={expectedId} oninput={(e) => { expectedId = (e.currentTarget as HTMLInputElement).value; resetFrom('target'); }} />
        {#if claimMismatch}<p class="pci-warn" role="status" data-testid="pci-mismatch">{t('pci_expect_mismatch')}</p>{/if}
        <button type="button" class="btn" data-testid="pci-prepare" disabled={!originOk || !idOk || busy !== null} onclick={prepare}>
          {t('pci_load_target')}
        </button>
      {/if}

      {#if bundle && target}
        <h4>{t('pci_map_title')}</h4>
        <p class="pci-muted">{t('pci_map_hint')}</p>
        {#each KINDS as kind (kind)}
          {#if bundle.rows[kind].length > 0}
            <table class="pci-map" data-testid={`pci-map-${kind}`}>
              <caption>{kindLabel(kind)}</caption>
              <tbody>
                {#each bundle.rows[kind] as row (row.sourceId)}
                  <tr>
                    <th scope="row"><label for={`pci-${kind}-${row.sourceId}`}>{row.name}</label></th>
                    <td>
                      <select id={`pci-${kind}-${row.sourceId}`} value={links[kind][row.sourceId] ?? ''}
                        onchange={(e) => choose(kind, row.sourceId, (e.currentTarget as HTMLSelectElement).value)}>
                        <option value="">{t('pci_map_choose')}</option>
                        {#each candidates(kind, row, target) as option (option.sourceId)}
                          <option value={option.sourceId}>{option.name}</option>
                        {/each}
                      </select>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        {/each}
        {#if problem}
          <p class="pci-warn" role="status" data-testid="pci-map-problem">
            {problem === 'duplicate' ? t('pci_map_duplicate') : t('pci_map_unmapped')}
          </p>
        {/if}
        <button type="button" class="btn btn-primary" data-testid="pci-review" disabled={problem !== null || busy !== null} onclick={runReview}>
          {t('pci_review_button')}
        </button>
      {/if}

      {#if review}
        <div class="pci-review" data-testid="pci-review-result">
          <p class="pci-ok" role="status">{t('pci_review_ok')}</p>
          <h4>{t('pci_renames_title')}</h4>
          {#if changes.length === 0}
            <p class="pci-muted">{t('pci_renames_none')}</p>
          {:else}
            <ul data-testid="pci-renames">
              {#each changes as change, i (i)}
                <li>{kindLabel(change.kind)}: {change.from} → {change.to}</li>
              {/each}
            </ul>
          {/if}
          <p class="pci-muted">{t('pci_preserved')}</p>
          {#if review.unsafeRoleMappings > 0}
            <p class="pci-error" role="alert" data-testid="pci-widening">{t('pci_widening', undefined, { count: review.unsafeRoleMappings })}</p>
          {/if}
          {#if review.unsupportedPermissionRows > 0}
            <p class="pci-error" role="alert" data-testid="pci-unsupported">{t('pci_unsupported')}</p>
          {/if}
          {#if !blocked && !approval}
            <label class="pci-check">
              <input type="checkbox" data-testid="pci-confirm" checked={confirmed}
                onchange={(e) => { confirmed = (e.currentTarget as HTMLInputElement).checked; }} />
              {t('pci_confirm_label')}
            </label>
            <button type="button" class="btn btn-primary" data-testid="pci-approve" disabled={!confirmed || busy !== null} onclick={approve}>
              {t('pci_approve_button')}
            </button>
          {/if}
          {#if approval}
            <p class="pci-ok" role="status" data-testid="pci-approved">{t('pci_approved', undefined, { seconds: remaining })}</p>
            <button type="button" class="btn btn-danger" data-testid="pci-apply" disabled={busy !== null} onclick={apply}>
              {t('pci_apply_button')}
            </button>
          {/if}
        </div>
      {/if}

      {#if applied}
        <p class="pci-ok" role="status" data-testid="pci-applied">
          {t('pci_applied', undefined, { categories: applied.categories, roles: applied.roles, channels: applied.channels })}
        </p>
      {/if}
      {#if outcome}
        <p class={outcome === 'unknown' ? 'pci-warn' : 'pci-error'} role="alert" data-testid="pci-outcome" data-outcome={outcome}>
          {outcomeText(outcome)}
        </p>
      {/if}
      {#if (applied || outcome === 'unknown' || outcome === 'refused' || outcome === 'expired') && target}
        <button type="button" class="btn" data-testid="pci-again" disabled={busy !== null} onclick={prepare}>{t('pci_review_again')}</button>
      {/if}
    </fieldset>
  {/if}
</section>

<style>
  .pci { display: flex; flex-direction: column; gap: var(--space-3); }
  .pci-muted { color: var(--text-muted); font-size: var(--text-sm); }
  .pci-claims { font-size: var(--text-sm); overflow-wrap: anywhere; }
  .pci-error { color: var(--danger); }
  .pci-warn { color: var(--warning, var(--danger)); }
  .pci-ok { color: var(--success, var(--text-normal)); }
  .pci-map { width: 100%; border-collapse: collapse; margin-block: var(--space-2); }
  .pci-map caption { text-align: start; font-weight: 600; }
  .pci-map th { text-align: start; font-weight: 400; padding-inline-end: var(--space-3); overflow-wrap: anywhere; }
  .pci-check { display: flex; gap: var(--space-2); align-items: flex-start; }
</style>
