<!-- client/js/core/voice/InputSensitivityControl.svelte -->
<!--
  GİRİŞ HASSASİYETİ — ses etkinleştirme eşiği.

  ════════════════════════════════════════════════════════════════════════════
  KAPATILAN GERÇEK BOŞLUK
  ════════════════════════════════════════════════════════════════════════════
  VAD eşikleri sabit kodlanmıştı; kullanıcının yapabileceği hiçbir şey yoktu.
  Gürültülü bir odada mikrofon sürekli açılıyor, sessiz bir mikrofonda konuşma
  hiç algılanmıyordu.

  ── TASARIM ───────────────────────────────────────────────────────────────
  İKİNCİ bir ses hattı KURULMAZ. Ölçüm zaten çalışan VAD'den gelir
  (`bridge:voice-input-level`), bu bileşen yalnızca gösterir ve eşiği yazar.

  GİZLİLİK: yalnızca tek bir sayı (RMS) okunur. Ses örneği ne saklanır ne de
  gönderilir.

  PTT BAĞIMSIZDIR: bas-konuş etkinken eşik hiç kullanılmaz; bu yüzden o modda
  kontrol açıkça "etkisiz" olarak işaretlenir — sessizce yanıltmak yerine.
-->
<script lang="ts">
  import { t } from '../i18n/reactive.svelte.ts';
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from '../bridge-registry.js';
  import {
    loadSensitivity, saveSensitivity, clampThreshold, levelToPercent,
    SENSITIVITY_RANGE, type SensitivitySetting,
  } from './input-sensitivity.ts';

  let setting = $state<SensitivitySetting>(loadSensitivity());
  let levelRms = $state(0);

  let levelPct     = $derived(levelToPercent(levelRms));
  let thresholdPct = $derived(levelToPercent(setting.threshold));
  let isManual     = $derived(setting.mode === 'manual');
  /** Şu an eşiğin üstünde miyiz — kullanıcı ayarı "hissedebilmeli". */
  let over         = $derived(isManual && levelRms >= setting.threshold);

  /** Bas-konuş etkinse eşik uygulanmaz; kontrol yanıltıcı olmamalı. */
  let pttActive = $state(false);

  function onLevel(event: Event): void {
    levelRms = Number((event as CustomEvent<{ rms?: number }>).detail?.rms ?? 0);
  }

  function persist(): void {
    saveSensitivity(setting);
    // Ölçüm yeni eşikle YENİDEN kurulur; çalışan gate'in eşiği değişmez.
    if (BridgeRegistry.has('voice:sensitivityChanged')) {
      BridgeRegistry.call('voice:sensitivityChanged');
    }
  }

  function setMode(mode: 'auto' | 'manual'): void {
    setting = { ...setting, mode };
    persist();
  }

  function setThreshold(value: number): void {
    setting = { ...setting, threshold: clampThreshold(value) };
    persist();
  }

  /** PTT durumu DEGISEBILIR; not bayat kalmamali. */
  function syncPtt(): void {
    const status = BridgeRegistry.has('voicePanel:getPttStatus')
      ? BridgeRegistry.call<{ enabled?: boolean }>('voicePanel:getPttStatus')
      : null;
    pttActive = Boolean(status?.enabled);
  }

  onMount(() => {
    document.addEventListener('bridge:voice-input-level', onLevel);
    // Ayni panelde PTT acilip kapatilabilir; "etkisiz" notu ANINDA guncellenir.
    document.addEventListener('bridge:ptt-changed', syncPtt);
    syncPtt();
  });

  onDestroy(() => {
    document.removeEventListener('bridge:voice-input-level', onLevel);
    document.removeEventListener('bridge:ptt-changed', syncPtt);
  });
</script>

<section class="isc" aria-labelledby="isc-title">
  <div class="isc-head">
    <h4 id="isc-title">{t('isc_title', 'Giriş hassasiyeti')}</h4>
    <p class="isc-hint">
      {t('markup_sesiniz_esigi_astiginda_konusuyor_sayilirsiniz_s_58f2e2c', "Sesiniz eşiği aştığında konuşuyor sayılırsınız. Ses örneği kaydedilmez.")}
    </p>
  </div>

  {#if pttActive}
    <!-- Yanıltmamak: PTT açıkken bu ayarın hiçbir etkisi yoktur. -->
    <p class="isc-note" role="status">
      {t('markup_bas_konus_acik_konusma_tusla_bildirildigi_icin_h_cccf98f', "Bas-konuş açık — konuşma tuşla bildirildiği için hassasiyet eşiği kullanılmıyor.")}
    </p>
  {/if}

  <div class="isc-modes" role="radiogroup" aria-labelledby="isc-title">
    <button
      type="button" class="isc-mode" class:active={!isManual}
      role="radio" aria-checked={!isManual}
      onclick={() => setMode('auto')}
    >
      <strong>{t('markup_otomatik_73bf96e', "Otomatik")}</strong>
      <small>{t('isc_recommended', 'Çoğu ortam için önerilir')}</small>
    </button>
    <button
      type="button" class="isc-mode" class:active={isManual}
      role="radio" aria-checked={isManual}
      onclick={() => setMode('manual')}
    >
      <strong>{t('markup_elle_ayarla_9d2afbf', "Elle ayarla")}</strong>
      <small>{t('isc_noisy', 'Gürültülü veya çok sessiz mikrofonlar için')}</small>
    </button>
  </div>

  <!-- Ölçer HER İKİ modda da görünür: kullanıcı otomatik moddayken de
       mikrofonunun çalıştığını görebilmeli. -->
  <div class="isc-meter-wrap">
    <div
      class="isc-meter"
      class:over={over}
      role="meter"
      aria-label={t('isc_mic_level', 'Mikrofon giriş seviyesi')}
      aria-valuemin="0"
      aria-valuemax="100"
      aria-valuenow={levelPct}
    >
      <span class="isc-fill" style={`width:${levelPct}%`}></span>
      {#if isManual}
        <span class="isc-threshold" style={`inset-inline-start:${thresholdPct}%`} aria-hidden="true"></span>
      {/if}
    </div>
    {#if isManual}
      <p class="isc-state" role="status">
        {over ? t("surface_su_anda_konusuyor_say_l_yorsunuz_5c8756") : t("surface_esigin_alt_ndas_n_z_73c31e")}
      </p>
    {/if}
  </div>

  {#if isManual}
    <label class="isc-slider">
      <span>{t('isc_threshold', 'Eşik')}</span>
      <input
        type="range"
        min={SENSITIVITY_RANGE.min}
        max={SENSITIVITY_RANGE.max}
        step="0.001"
        value={setting.threshold}
        aria-describedby="isc-title"
        oninput={(e) => setThreshold(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <!-- Ham RMS kullanıcı için anlamsız; yüzde olarak gösterilir. -->
      <output>{thresholdPct}%</output>
    </label>
  {/if}
</section>

<style>
.isc { display: flex; flex-direction: column; gap: 10px; padding-top: 14px; }
.isc-head h4 { margin: 0 0 2px; font-size: var(--text-sm); }
.isc-hint { margin: 0; font-size: var(--text-2xs); color: var(--text-muted); }
.isc-note {
  padding: 7px 10px;
  margin: 0;
  font-size: var(--text-2xs);
  color: var(--warning-text, var(--yellow));
  background: var(--yellow-bg);
  border-radius: var(--radius-sm);
}

.isc-modes { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.isc-mode {
  padding: 9px 11px;
  font: inherit;
  color: var(--text-primary);
  text-align: start;
  cursor: pointer;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
}
.isc-mode:hover { background: var(--bg-4); }
/* Seçili durum RENKTEN başka işaret de taşır: `aria-checked` + kalın kenarlık. */
.isc-mode.active { border-color: var(--brand); box-shadow: inset 0 0 0 1px var(--brand); }
.isc-mode strong { display: block; font-size: var(--text-sm); }
.isc-mode small { display: block; margin-top: 2px; font-size: var(--text-2xs); color: var(--text-muted); }

.isc-meter {
  position: relative;
  height: 10px;
  overflow: hidden;
  background: var(--bg-3);
  border: 1px solid var(--border);
  border-radius: 999px;
}
.isc-fill {
  display: block;
  height: 100%;
  background: var(--text-muted);
  transition: width 80ms linear;
}
.isc-meter.over .isc-fill { background: var(--green); }
.isc-threshold {
  position: absolute;
  inset-block: -2px;
  width: 2px;
  background: var(--brand);
}
.isc-state { margin: 5px 0 0; font-size: var(--text-2xs); color: var(--text-muted); }

.isc-slider { display: flex; gap: var(--space-3); align-items: center; font-size: var(--text-2xs); color: var(--text-secondary); }
.isc-slider input { flex: 1; }
.isc-slider output { min-width: 38px; font-variant-numeric: tabular-nums; text-align: end; }

@media (prefers-reduced-motion: reduce) { .isc-fill { transition: none; } }
</style>
