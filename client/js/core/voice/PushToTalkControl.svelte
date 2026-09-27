<!-- client/js/core/voice/PushToTalkControl.svelte -->
<!--
  BAS-KONUŞ (PUSH-TO-TALK) AYARLARI

  ══════════════════════════════════════════════════════════════════════════
  KAPATILAN GERÇEK BOŞLUK — ÇALIŞAN AMA ERİŞİLEMEYEN ÖZELLİK
  ══════════════════════════════════════════════════════════════════════════
  Bas-konuş MEKANİZMASI eksiksizdi: `VoicePTTController` mount ediliyor,
  hold/toggle modları, tuş yakalama, `localStorage['bridgePTT']` kalıcılığı
  ve metin alanı bastırması hepsi çalışıyordu.

  Ama HİÇBİR ÜRETİM ARAYÜZÜ onu açmıyordu:
    · `setPttEnabled` kayıtlıydı  → çağıran YOK
    · `BridgePTT.setEnabled`      → çağıran YOK
    · `setPttMode` export edildi  → registry'ye KAYDEDİLMEMİŞ
    · tuş atama arayüzü           → YOK

  Yani kullanıcı bas-konuşu geliştirici konsolu olmadan AÇAMIYORDU. Bu bir
  platform kısıtı değil, kapatılabilir bir ürün boşluğuydu.

  ── TASARIM ──────────────────────────────────────────────────────────────
  İKİNCİ bir PTT sahibi KURULMAZ:

    · DAVRANIŞ sahibi  → VoicePTTController (tuş dinleme, mute çağrıları)
    · KALICILIK sahibi → voice/ptt-settings.ts (tek anahtar: `bridgePTT`)

  Bu ayrım gereklidir çünkü VoicePanel YALNIZCA ses sahnesi açıldığında mount
  edilir. Yalnızca registry okunsaydı kullanıcı bas-konuşu ancak ZATEN bir
  aramadayken yapılandırabilirdi. Projede bunun kanonik örneği zaten var:
  hassasiyet eşiği `input-sensitivity.ts`te tutulur, kontrol yazar, VAD okur.

  Yeniden okuma sinyali `bridge:ptt-changed` DOM olayıdır: ayarlar paneli
  VoicePanel'in bileşen ağacında değildir, bu yüzden `onStatusChange` buraya
  ulaşmaz.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from '../bridge-registry.js';
  import { t } from '../i18n/reactive.svelte.ts';
  import {
    loadPttSettings, savePttSettings, PTT_CHANGED_EVENT, type PTTSettings,
  } from './ptt-settings.ts';

  /**
   * KALICILIK kanonik modulden gelir; DAVRANIS sahibi hala
   * `VoicePTTController`dir.
   *
   * NEDEN registry'ye BAGLI DEGIL: VoicePanel yalnizca ses sahnesi acildiginda
   * mount edilir. Yalnizca registry okunsaydi kullanici bas-konusu ancak ZATEN
   * bir aramadayken yapilandirabilirdi — ayarlari onceden hazirlamak mumkun
   * olmazdi. Bu, hassasiyet kontrolunun `input-sensitivity.ts` ile kurdugu
   * deseni birebir izler.
   */
  let settings  = $state<PTTSettings>(loadPttSettings());
  let capturing = $state(false);

  /**
   * Fiziksel klavye yoksa bas-konus anlamli degildir.
   *
   * Dokunmatik cihazda calisiyormus gibi gostermek yerine ACIKCA soylenir.
   * Bu MASAUSTU icin bir platform engeli DEGILDIR — yalnizca bu cihaz icin.
   */
  const touchOnly = typeof matchMedia === 'function'
    && matchMedia('(hover: none) and (pointer: coarse)').matches;

  function refresh(): void {
    settings  = loadPttSettings();
    capturing = Boolean(BridgeRegistry.call<boolean>('voicePanel:isPttCapturing'));
  }

  function write(patch: Partial<PTTSettings>): void {
    settings = { ...settings, ...patch };
    savePttSettings(settings);
  }

  function setEnabled(on: boolean): void { write({ enabled: on }); }
  function setMode(mode: 'hold' | 'toggle'): void { write({ mode }); }
  function clearKey(): void { write({ key: null }); }

  /**
   * Tus yakalama.
   *
   * Denetleyici mount EDILMISSE onun kanonik yakalamasi kullanilir (tek sahip).
   * Degilse — ayarlar aramadan once aciliyorsa — ayni sozlesmeyle yerel olarak
   * yakalanir ve ayni kayda yazilir.
   */
  function startCapture(): void {
    if (BridgeRegistry.has('voicePanel:startPttKeyCapture')) {
      BridgeRegistry.call('voicePanel:startPttKeyCapture');
      capturing = true;
      return;
    }
    capturing = true;
    document.addEventListener('keydown', localCapture, true);
  }

  function stopLocalCapture(): void {
    document.removeEventListener('keydown', localCapture, true);
    capturing = false;
  }

  /** Denetleyicideki `_buildLabel` ile AYNI sozlesme. */
  function buildLabel(e: KeyboardEvent): string {
    const mods = ['ControlLeft','ControlRight','AltLeft','AltRight',
                  'ShiftLeft','ShiftRight','MetaLeft','MetaRight'];
    const parts: string[] = [];
    if (e.ctrlKey  && !mods.slice(0, 2).includes(e.code)) parts.push('Ctrl');
    if (e.altKey   && !mods.slice(2, 4).includes(e.code)) parts.push('Alt');
    if (e.shiftKey && !mods.slice(4, 6).includes(e.code)) parts.push('Shift');
    if (e.metaKey  && !mods.slice(6, 8).includes(e.code)) parts.push('Meta');
    if (!mods.includes(e.code)) {
      parts.push(e.key === ' ' ? 'Space' : (e.key?.length === 1 ? e.key.toUpperCase() : e.key));
    }
    return parts.join('+') || e.code;
  }

  function localCapture(e: KeyboardEvent): void {
    // Yakalama tusu BASKA hicbir Bridge eylemini tetiklemez.
    e.preventDefault();
    e.stopPropagation();
    if (e.code === 'Escape') { stopLocalCapture(); return; }
    stopLocalCapture();
    write({ key: { code: e.code, label: buildLabel(e) } });
  }

  onMount(() => {
    refresh();
    document.addEventListener(PTT_CHANGED_EVENT, refresh);
  });
  onDestroy(() => {
    document.removeEventListener(PTT_CHANGED_EVENT, refresh);
    stopLocalCapture();
  });
</script>

<section class="ptt" aria-labelledby="ptt-title">
  <div class="ptt-head">
    <h4 id="ptt-title">{t('ptt_title', 'Bas-konuş')}</h4>
    <p class="ptt-hint">{t('ptt_hint', '')}</p>
  </div>

  {#if touchOnly}
    <!-- Dürüst bozulma: çalışıyormuş gibi gösterme. -->
    <p class="ptt-note" role="status">{t('ptt_unavailable', '')}</p>
  {:else}
    <label class="ptt-row ptt-toggle">
      <input
        type="checkbox"
        checked={settings.enabled}
        onchange={(e) => setEnabled((e.currentTarget as HTMLInputElement).checked)}
      />
      <span>{t('ptt_enable', '')}</span>
    </label>

    {#if settings.enabled}
      <!-- Mod seçimi: iki kanonik mod da denetleyicide GERÇEKTEN destekli. -->
      <div class="ptt-row">
        <span class="ptt-label" id="ptt-mode-label">{t('ptt_mode', '')}</span>
        <div class="ptt-modes" role="radiogroup" aria-labelledby="ptt-mode-label">
          {#each [
            { id: 'hold',   label: t('ptt_mode_hold', ''),   desc: t('ptt_mode_hold_desc', '') },
            { id: 'toggle', label: t('ptt_mode_toggle', ''), desc: t('ptt_mode_toggle_desc', '') },
          ] as opt (opt.id)}
            <button
              type="button"
              role="radio"
              class="ptt-mode"
              class:selected={settings.mode === opt.id}
              aria-checked={settings.mode === opt.id}
              title={opt.desc}
              onclick={() => setMode(opt.id as 'hold' | 'toggle')}
            >{opt.label}</button>
          {/each}
        </div>
      </div>

      <div class="ptt-row">
        <span class="ptt-label" id="ptt-key-label">{t('ptt_key', '')}</span>
        <div class="ptt-key-controls">
          <!--
            Yakalama sırasında canlı bölge: klavye/ekran okuyucu kullanıcısı
            Bridge'in tuş beklediğini DUYMALI. İptal Escape ile yapılır ve bu
            denetleyicinin kanonik davranışıdır.
          -->
          <output class="ptt-key-display" class:capturing aria-live="polite">
            {capturing
              ? t('ptt_capturing', '')
              : (settings.key?.label ?? t('ptt_key_none', ''))}
          </output>
          <button type="button" class="ptt-btn" onclick={startCapture} disabled={capturing}>
            {settings.key ? t('ptt_key_change', '') : t('ptt_key_set', '')}
          </button>
          {#if settings.key}
            <button type="button" class="ptt-btn" onclick={clearKey} disabled={capturing}>
              {t('ptt_key_clear', '')}
            </button>
          {/if}
        </div>
      </div>

      {#if !settings.key}
        <!-- Yarım yapılandırma sessiz kalmaz: açık ama tuşsuz PTT çalışmaz. -->
        <p class="ptt-note ptt-warn" role="status">{t('ptt_needs_key', '')}</p>
      {/if}
    {/if}
  {/if}
</section>

<style>
  .ptt {
    display: grid;
    gap: 10px;
    margin: 18px 0;
    padding: 14px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface-2);
  }
  .ptt-head h4 { margin: 0; font-size: var(--text-md); }
  .ptt-hint { margin: 4px 0 0; color: var(--text-muted); font-size: var(--text-sm); }

  .ptt-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  .ptt-label { min-width: 92px; color: var(--text-secondary); font-size: var(--text-sm); }

  .ptt-toggle { cursor: pointer; }
  .ptt-toggle input { width: 16px; height: 16px; accent-color: var(--brand); }

  .ptt-modes { display: flex; gap: 6px; }
  .ptt-mode {
    /* Dokunma hedefi projenin erişilebilirlik sözleşmesini karşılar. */
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }
  /* Seçili durum RENKTEN başka işaret de taşır: kenarlık ve kalınlık. */
  .ptt-mode.selected {
    border-color: var(--brand);
    background: var(--brand-bg);
    font-weight: 600;
  }
  .ptt-mode:focus-visible,
  .ptt-btn:focus-visible { outline: 2px solid var(--focus-ring); outline-offset: 2px; }

  .ptt-key-controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .ptt-key-display {
    min-width: 132px;
    padding: 5px 10px;
    border: 1px dashed var(--border-strong);
    border-radius: var(--radius-sm);
    color: var(--text-primary);
    font-family: var(--font-mono);
    font-size: var(--text-sm);
  }
  .ptt-key-display.capturing {
    border-style: solid;
    border-color: var(--brand);
    color: var(--brand);
  }

  .ptt-btn {
    min-height: 32px;
    padding: 0 12px;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-primary);
    font: inherit;
    font-size: var(--text-sm);
    cursor: pointer;
  }
  .ptt-btn:disabled { opacity: .55; cursor: default; }

  .ptt-note { margin: 0; color: var(--text-muted); font-size: var(--text-sm); }
  .ptt-warn { color: var(--warning); }

  @media (prefers-reduced-motion: no-preference) {
    .ptt-key-display { transition: border-color var(--duration-fast) var(--ease-out); }
  }
</style>
