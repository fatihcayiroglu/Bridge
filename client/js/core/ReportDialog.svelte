<!-- P7 B5: the report form for any reportable message (a channel message in
     MessageRenderer, a thread reply in ThreadPanel). It owns the reason, the
     optional note, the busy state and the error. The parent decides where the
     report goes (`onSubmit`) and closes it (`onClose`), which also restores focus. -->
<script lang="ts">
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';

  interface Props {
    titleId: string;
    /** Resolves true once the server accepted the report. */
    onSubmit: (reason: string, detail: string) => Promise<boolean> | boolean;
    /** `reported`: the report was accepted (the parent hides the dialog either way). */
    onClose: (reported: boolean) => void;
  }

  let { titleId, onSubmit, onClose }: Props = $props();

  let reason = $state('spam');
  let detail = $state('');
  let busy = $state(false);
  let error = $state('');

  function close(): void {
    if (busy) return;
    onClose(false);
  }

  async function submit(): Promise<void> {
    if (busy) return;
    busy = true; error = '';
    try {
      if (await onSubmit(reason, detail.trim())) {
        busy = false;
        onClose(true);
        return;
      }
      error = t("ui_rapor_gonderilemedi_lutfen_tekrar_deneyin", "Rapor gönderilemedi. Lütfen tekrar deneyin.");
    } catch {
      error = t("ui_rapor_gonderilemedi_lutfen_tekrar_deneyin", "Rapor gönderilemedi. Lütfen tekrar deneyin.");
    } finally {
      busy = false;
    }
  }
</script>

<div class="edit-history-overlay" role="presentation" onclick={close}>
  <div
    class="edit-history-dialog report-dialog"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    aria-labelledby={titleId}
    onclick={(e) => e.stopPropagation()}
    onkeydown={(e) => { if (e.key === 'Escape') { e.preventDefault(); close(); } }}
    use:focusTrap={{ active: true, initialFocus: '.report-reason' }}
  >
    <header>
      <div><strong id={titleId}>{t("report_message")}</strong><span>{t("report_queue_hint")}</span></div>
      <button type="button" class="edit-history-close" aria-label={t('attr_rapor_penceresini_kapat_276b46a', "Rapor penceresini kapat")} disabled={busy} onclick={close}>✕</button>
    </header>
    <div class="edit-history-body report-form">
      <label><span>{t('markup_neden_f136b25', "Neden")}</span>
        <select class="report-reason" bind:value={reason} disabled={busy}>
          <option value="spam">{t('report_reason_spam')}</option><option value="harassment">{t('report_reason_harassment')}</option><option value="hate">{t("report_reason_hate")}</option>
          <option value="sexual">{t("report_reason_sexual")}</option><option value="violence">{t("report_reason_violence")}</option><option value="other">{t("report_reason_other")}</option>
        </select>
      </label>
      <label><span>{t('markup_ek_bilgi_8dfb865', "Ek bilgi")} <small>{t("mod_optional")}</small></span><textarea bind:value={detail} maxlength="500" rows="4" disabled={busy}></textarea></label>
      {#if error}<p class="edit-history-error" role="alert">{error}</p>{/if}
      <div class="report-actions"><button type="button" onclick={close} disabled={busy}>{t("cancel")}</button><button type="button" class="danger-submit" onclick={() => void submit()} disabled={busy}>{busy ? t("dm_sending") : 'Raporla'}</button></div>
    </div>
  </div>
</div>

<style>
  .edit-history-overlay { position: fixed; inset: 0; z-index: var(--layer-modal); display: grid; place-items: center; padding: 20px; background: color-mix(in srgb, var(--bg-0) 78%, transparent); backdrop-filter: blur(6px); }
  .edit-history-dialog { width: min(560px, 100%); max-height: min(680px, calc(var(--bridge-visual-viewport-height, 100dvh) - 40px)); display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--border-strong); border-radius: var(--radius-modal); background: var(--bg-2); box-shadow: var(--shadow-xl); }
  .edit-history-dialog > header { display: flex; justify-content: space-between; gap: 12px; padding: 14px 16px; border-bottom: 1px solid var(--border-subtle); }
  .edit-history-dialog > header div { display: grid; gap: 3px; }
  .edit-history-dialog > header span { font-size: 11px; color: var(--text-muted); }
  .edit-history-close { width: 32px; height: 32px; border: 0; border-radius: var(--radius-sm); background: transparent; color: var(--text-secondary); cursor: pointer; }
  .edit-history-body { overflow: auto; padding: 12px 16px 16px; }
  .edit-history-error { color: var(--danger-text, #ff8f8f); }
  .report-form { display: grid; gap: 12px; }
  .report-form label { display: grid; gap: 6px; color: var(--text-secondary); font-size: 12px; }
  .report-form select, .report-form textarea { width: 100%; border: 1px solid var(--border-subtle); border-radius: var(--radius-sm); background: var(--bg-3); color: var(--text-1); padding: 9px 10px; font: inherit; }
  .report-form textarea { resize: vertical; min-height: 88px; }
  .report-actions { display: flex; justify-content: flex-end; gap: 8px; }
  .report-actions button { min-height: 34px; padding: 0 12px; border-radius: var(--radius-sm); border: 1px solid var(--border-subtle); background: var(--bg-3); color: var(--text-1); cursor: pointer; }
  .report-actions .danger-submit { background: var(--danger); border-color: transparent; color: var(--text-on-solid); }
  .report-actions button:disabled { opacity: .55; cursor: default; }
  /* Phones: a bottom sheet with full-width, 44 px actions (same as MessageRenderer's dialogs). */
  @media (max-width: 600px) {
    .edit-history-overlay { place-items: end center; padding: 0; }
    .edit-history-dialog {
      width: 100%;
      max-height: min(82dvh, var(--bridge-visual-viewport-height, 82dvh));
      border-right: 0;
      border-bottom: 0;
      border-left: 0;
      border-radius: var(--radius-modal) var(--radius-modal) 0 0;
    }
    .edit-history-dialog > header { padding-top: 12px; padding-inline: 14px; }
    .edit-history-body { padding: 12px 14px calc(16px + env(safe-area-inset-bottom)); overscroll-behavior: contain; }
    .report-actions { position: sticky; bottom: 0; padding-top: 8px; background: var(--bg-2); }
    .report-actions button { min-height: 44px; flex: 1; }
  }
</style>
