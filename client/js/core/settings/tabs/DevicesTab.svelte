<!-- client/js/core/settings/tabs/DevicesTab.svelte -->
<!-- ADR-0002 Faz 1 — Ses/Video cihaz ayarları tabı.  -->
<!-- Sprint 54: DevicesTab tamamlandı.                 -->

<script lang="ts">
  import { t } from '../../i18n/reactive.svelte.ts';
  import { createLogger } from '../../logger.ts';
  const log = createLogger('DevicesTab');
  import type { SettingsStore } from '../stores/settingsStore';
  let { store }: { store: SettingsStore } = $props();

  // ── Cihaz listeleri ───────────────────────────────────────────────────────
  let audioInputs:  MediaDeviceInfo[] = $state([]);
  let audioOutputs: MediaDeviceInfo[] = $state([]);
  let videoInputs:  MediaDeviceInfo[] = $state([]);
  let loading       = $state(true);
  let permError     = $state<string | null>(null);

  // Kayıtlı seçimler
  let selMicId:      string = $state(localStorage.getItem('bridge:device:mic')    ?? '');
  let selSpeakerId:  string = $state(localStorage.getItem('bridge:device:speaker')  ?? '');
  let selCameraId:   string = $state(localStorage.getItem('bridge:device:camera')   ?? '');

  // Ses ayarları
  function storedVolume(key: string): number {
    const raw = localStorage.getItem(key);
    if (raw === null) return 100;
    const value = Number(raw);
    return Number.isFinite(value) && value >= 0 && value <= 200 ? value : 100;
  }

  // `Number(value) || 100` made the valid 0% setting reload as 100%.
  let inputVolume:   number = $state(storedVolume('bridge:device:inputVol'));
  let outputVolume:  number = $state(storedVolume('bridge:device:outputVol'));
  let noiseSuppression = $state(localStorage.getItem('bridge:device:noise') !== 'false');
  let echoCancellation = $state(localStorage.getItem('bridge:device:echo')  !== 'false');

  // Test
  let testing = $state(false);
  let testStream: MediaStream | null = null;
  let testTimer: ReturnType<typeof setTimeout> | null = null;
  let testRequest = 0;

  // Kaydet
  let saving = $state(false);
  let saved  = $state(false);

  // ── Cihazları yükle ───────────────────────────────────────────────────────
  async function loadDevices() {
    loading    = true;
    permError  = null;
    try {
      // İzin almak için kısa bir stream aç, hemen kapat
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      audioInputs  = devices.filter(d => d.kind === 'audioinput');
      audioOutputs = devices.filter(d => d.kind === 'audiooutput');
      videoInputs  = devices.filter(d => d.kind === 'videoinput');
    } catch {
      permError = t("ui_mikrofon_iznine_ihtiyac_duyuluyor_tarayici_izinlerin", "Mikrofon iznine ihtiyaç duyuluyor. Tarayıcı izinlerini kontrol edin.");
    } finally {
      loading = false;
    }
  }

  // ── Mikrofon testi ────────────────────────────────────────────────────────
  function stopMicTest(): void {
    testRequest += 1;
    if (testTimer !== null) clearTimeout(testTimer);
    testTimer = null;
    testStream?.getTracks().forEach(t => t.stop());
    testStream = null;
    testing = false;
  }

  async function toggleMicTest() {
    if (testing) { stopMicTest(); return; }
    const request = ++testRequest;
    try {
      testing = true;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:       selMicId ? { exact: selMicId } : undefined,
          noiseSuppression,
          echoCancellation,
        },
      });

      // A stop/unmount can happen while the permission prompt is pending.
      // Never retain a stream acquired for an obsolete request.
      if (request !== testRequest || !testing) {
        stream.getTracks().forEach(t => t.stop());
        return;
      }
      testStream = stream;
      // 5 saniye sonra otomatik durdur
      testTimer = setTimeout(() => {
        if (testStream === stream) stopMicTest();
      }, 5000);
    } catch {
      if (request === testRequest) stopMicTest();
    }
  }

  // ── Kaydet ────────────────────────────────────────────────────────────────
  let error = $state<string | null>(null);

  async function save() {
    saving = true;
    saved  = false;
    error  = null;
    try {
      // Device choices are browser-local preferences. Sending them through
      // SettingsStore.save() could never succeed because PATCH /api/me only
      // accepts profile/privacy fields. Persist locally, then publish the
      // already-committed preference to the active voice owner.
      const preferences: Array<[string, string, unknown]> = [
        ['bridge:device:mic', 'micDeviceId', selMicId],
        ['bridge:device:speaker', 'speakerDeviceId', selSpeakerId],
        ['bridge:device:camera', 'cameraDeviceId', selCameraId],
        ['bridge:device:inputVol', 'inputVolume', inputVolume],
        ['bridge:device:outputVol', 'outputVolume', outputVolume],
        ['bridge:device:noise', 'noiseSuppression', noiseSuppression],
        ['bridge:device:echo', 'echoCancellation', echoCancellation],
      ];
      for (const [storageKey, storeKey, value] of preferences) {
        localStorage.setItem(storageKey, String(value));
        store.setDevicePreference(storeKey, value);
      }

      // BridgeRegistry üzerinden aktif ses oturumuna bildir
      const reg = (window as unknown as {
        BridgeRegistry?: { call?: (m: string, data: unknown) => void }
      }).BridgeRegistry;
      reg?.call?.('voice:applyDeviceSettings', {
        micDeviceId:    selMicId,
        noiseSuppression,
        echoCancellation,
        inputVolume,
        outputVolume,
      });

      saved = true;
      setTimeout(() => { saved = false; }, 2000);
    } catch (cause) {
      log.error('Cihaz tercihleri kaydedilemedi', cause);
      error = t('dev_save_failed', 'Cihaz tercihleri kaydedilemedi. Tekrar dene.');
    } finally {
      saving = false;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  import { onMount, onDestroy } from 'svelte';
  // GIRIS HASSASIYETI — VAD esikleri sabit kodluydu, kullanicinin
  // yapabilecegi hicbir sey yoktu. Mevcut VAD hattini kullanir; ikinci bir
  // ses yolu acmaz.
  import InputSensitivityControl from '../../voice/InputSensitivityControl.svelte';
  import PushToTalkControl from '../../voice/PushToTalkControl.svelte';

  onMount(() => { loadDevices(); });

  onDestroy(() => {
    stopMicTest();
  });
</script>

<section aria-labelledby="devices-heading">
  <h2 id="devices-heading" class="section-title">{t('dev_audio_video', 'Ses &amp; Video Cihazları')}</h2>

  {#if loading}
    <p class="status-text">{t('dev_loading', 'Cihazlar yükleniyor…')}</p>
  {:else if permError}
    <div class="perm-error" role="alert">
      <span class="perm-icon">🎙️</span>
      <p>{permError}</p>
      <button class="btn btn--secondary" onclick={loadDevices}>{t('retry')}</button>
    </div>
  {:else}

    <!-- ── Giriş cihazı ─────────────────────────────────────────────────── -->
    <div class="field-group">
      <label class="field-label" for="mic-select">{t('tip_mic')}</label>
      <div class="device-row">
        <select id="mic-select" class="field-select" bind:value={selMicId}>
          <option value="">{t('dev_system_default', 'Sistem Varsayılanı')}</option>
          {#each audioInputs as d (d.deviceId)}
            <option value={d.deviceId}>{d.label || t('device_mic_fallback', undefined, { number: audioInputs.indexOf(d) + 1 })}</option>
          {/each}
        </select>
        <button
          class="btn btn--test"
          class:btn--testing={testing}
          aria-label={testing ? t('device_stop_test') : t('device_test_mic')}
          onclick={toggleMicTest}
        >
          {testing ? `⏹ ${t('device_stop_test')}` : `▶ ${t('markup_test_640ab2b')}`}
        </button>
      </div>

      <div class="volume-row">
        <label class="vol-label" for="input-vol">{t("ui_input_volume", undefined, { value: inputVolume })}</label>
        <input
          id="input-vol"
          type="range" min="0" max="200"
          bind:value={inputVolume}
          class="vol-slider"
        />
      </div>
    </div>

    <InputSensitivityControl />

    <!-- Bas-konuş: kanonik `VoicePTTController`a erişilebilir yüzey. -->
    <PushToTalkControl />

    <!-- ── Çıkış cihazı ─────────────────────────────────────────────────── -->
    <div class="field-group">
      <label class="field-label" for="speaker-select">{t('dev_speaker', 'Hoparlör')}</label>
      <select id="speaker-select" class="field-select" bind:value={selSpeakerId}>
        <option value="">{t('dev_system_default', 'Sistem Varsayılanı')}</option>
        {#each audioOutputs as d (d.deviceId)}
          <option value={d.deviceId}>{d.label || t('device_speaker_fallback', undefined, { number: audioOutputs.indexOf(d) + 1 })}</option>
        {/each}
      </select>

      <div class="volume-row">
        <label class="vol-label" for="output-vol">{t("ui_output_volume", undefined, { value: outputVolume })}</label>
        <input
          id="output-vol"
          type="range" min="0" max="200"
          bind:value={outputVolume}
          class="vol-slider"
        />
      </div>
    </div>

    <!-- ── Kamera ─────────────────────────────────────────────────────────── -->
    {#if videoInputs.length > 0}
      <div class="field-group">
        <label class="field-label" for="camera-select">{t('voice_camera')}</label>
        <select id="camera-select" class="field-select" bind:value={selCameraId}>
          <option value="">{t('dev_system_default', 'Sistem Varsayılanı')}</option>
          {#each videoInputs as d (d.deviceId)}
            <option value={d.deviceId}>{d.label || t('device_camera_fallback', undefined, { number: videoInputs.indexOf(d) + 1 })}</option>
          {/each}
        </select>
      </div>
    {/if}

    <!-- ── Gelişmiş ses ───────────────────────────────────────────────────── -->
    <div class="advanced-section">
      <p class="field-label">{t('dev_advanced_audio', 'Gelişmiş Ses İşleme')}</p>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-title">{t('dev_noise_suppress', 'Gürültü Bastırma')}</span>
          <span class="toggle-desc">{t('markup_arka_plan_sesini_azalt_e9f0898', "Arka plan sesini azalt")}</span>
        </div>
        <button
          class="toggle-btn"
          class:on={noiseSuppression}
          aria-pressed={noiseSuppression}
          aria-label={t('dev_noise_toggle', 'Gürültü bastırmayı {state}', { state: noiseSuppression ? t('common_off', 'kapat') : t('common_on', 'aç') })}
          onclick={() => { noiseSuppression = !noiseSuppression; }}
        >
          <span class="toggle-knob"></span>
        </button>
      </div>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-title">{t('markup_eko_giderme_29af580', "Eko Giderme")}</span>
          <span class="toggle-desc">{t('dev_echo_clean', 'Hoparlör yankısını temizle')}</span>
        </div>
        <button
          class="toggle-btn"
          class:on={echoCancellation}
          aria-pressed={echoCancellation}
          aria-label={t('dev_echo_toggle', 'Eko gidermeyi {state}', { state: echoCancellation ? t('common_off', 'kapat') : t('common_on', 'aç') })}
          onclick={() => { echoCancellation = !echoCancellation; }}
        >
          <span class="toggle-knob"></span>
        </button>
      </div>
    </div>

    <!-- ── Kaydet ─────────────────────────────────────────────────────────── -->
    <div class="field-actions">
      <button
        class="btn btn--primary"
        class:btn--saved={saved}
        disabled={saving}
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
      <button class="btn btn--secondary" onclick={loadDevices}>
        {t('markup_cihazlari_yenile_6007b50', "↺ Cihazları Yenile")}
      </button>
      {#if error}
        <span class="field-error" role="alert">{error}</span>
      {/if}
    </div>

  {/if}
</section>

<style>
  .section-title {
    font-size: 20px; font-weight: 700;
    margin: 0 0 24px;
    color: var(--text-primary, #e4e6eb);
  }

  .status-text { color: var(--text-muted, #6d6f78); font-size: 14px; }

  .perm-error {
    background: color-mix(in srgb, var(--danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--danger) 30%, transparent);
    border-radius: 8px;
    padding: 16px;
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 8px;
  }

  .perm-icon { font-size: 24px; }
  .perm-error p { margin: 0; font-size: 14px; color: var(--text-primary, #e4e6eb); }

  .field-group   { margin-bottom: 28px; }

  .field-label {
    display: block;
    font-size: 12px; font-weight: 600;
    text-transform: uppercase; letter-spacing: 0.06em;
    color: var(--text-muted, #6d6f78);
    margin-bottom: 8px;
  }

  .field-select {
    flex: 1;
    padding: 10px 36px 10px 12px;
    border: 1px solid var(--border, color-mix(in srgb, var(--text-primary) 10%, transparent));
    border-radius: 6px;
    background: var(--bg-input);
    color: var(--text-primary, #e4e6eb);
    font-size: 14px;
    outline: none;
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='8' viewBox='0 0 12 8'%3E%3Cpath d='M1 1l5 5 5-5' stroke='%236d6f78' stroke-width='1.5' fill='none' stroke-linecap='round'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 12px center;
    cursor: pointer;
  }

  .field-select:focus { border-color: var(--brand, #2d9cdb); }

  .device-row {
    display: flex;
    gap: 8px;
    align-items: center;
    max-width: 400px;
  }

  .volume-row {
    margin-top: 10px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    max-width: 400px;
  }

  .vol-label {
    font-size: 12px;
    color: var(--text-muted, #6d6f78);
    font-weight: 500;
  }

  .vol-slider {
    width: 100%;
    accent-color: var(--brand, #2d9cdb);
    cursor: pointer;
  }

  .advanced-section { margin-bottom: 24px; }

  /* Toggle */
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
    position: relative; width: 44px; height: 24px;
    border: none; border-radius: 12px;
    background: var(--bg-input);
    cursor: pointer; transition: background 0.2s; flex-shrink: 0;
  }

  .toggle-btn.on { background: var(--brand, #2d9cdb); }

  .toggle-knob {
    position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; border-radius: 50%;
    background: var(--text-on-solid); transition: transform 0.2s;
  }

  .toggle-btn.on .toggle-knob { transform: translateX(20px); }

  /* Butonlar */
  .field-actions { margin-top: 24px; display: flex; gap: 8px; flex-wrap: wrap; }

  .btn {
    padding: 9px 16px; border: none; border-radius: 6px;
    font-size: 14px; font-weight: 600; cursor: pointer;
    transition: opacity 0.1s, background 0.1s;
  }

  .btn--primary {
    background: var(--brand, #2d9cdb); color: var(--text-on-solid);
  }

  .btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn--primary:not(:disabled):hover { background: var(--brand-hover, #677bc4); }
  .btn--saved { background: var(--success) !important; }

  .btn--secondary {
    background: var(--bg-secondary, color-mix(in srgb, var(--text-primary) 7%, transparent));
    color: var(--text-secondary, #b0b3bb);
  }

  .btn--secondary:hover { background: color-mix(in srgb, var(--text-primary) 12%, transparent); }

  .btn--test {
    background: var(--bg-secondary, color-mix(in srgb, var(--text-primary) 7%, transparent));
    color: var(--text-secondary, #b0b3bb);
    white-space: nowrap;
    padding: 10px 14px;
  }

  .btn--testing { background: color-mix(in srgb, var(--danger) 20%, transparent); color: var(--danger); }

  .field-error {
    font-size: 13px;
    color: var(--danger);
    align-self: center;
  }
</style>
