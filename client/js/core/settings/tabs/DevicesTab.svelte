<!-- client/js/core/settings/tabs/DevicesTab.svelte -->
<!-- ADR-0002 Faz 1 — Ses/Video cihaz ayarları tabı.  -->
<!-- Sprint 54: DevicesTab tamamlandı.                 -->

<script lang="ts">
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
  let inputVolume:   number = $state(Number(localStorage.getItem('bridge:device:inputVol'))  || 100);
  let outputVolume:  number = $state(Number(localStorage.getItem('bridge:device:outputVol')) || 100);
  let noiseSuppression = $state(localStorage.getItem('bridge:device:noise') !== 'false');
  let echoCancellation = $state(localStorage.getItem('bridge:device:echo')  !== 'false');

  // Test
  let testing = $state(false);
  let testStream: MediaStream | null = null;

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
      permError = 'Mikrofon iznine ihtiyaç duyuluyor. Tarayıcı izinlerini kontrol edin.';
    } finally {
      loading = false;
    }
  }

  // ── Mikrofon testi ────────────────────────────────────────────────────────
  async function toggleMicTest() {
    if (testing) {
      testStream?.getTracks().forEach(t => t.stop());
      testStream = null;
      testing    = false;
      return;
    }
    try {
      testing    = true;
      testStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          deviceId:       selMicId ? { exact: selMicId } : undefined,
          noiseSuppression,
          echoCancellation,
        },
      });
      // 5 saniye sonra otomatik durdur
      setTimeout(() => {
        if (testing) {
          testStream?.getTracks().forEach(t => t.stop());
          testStream = null;
          testing    = false;
        }
      }, 5000);
    } catch {
      testing = false;
    }
  }

  // ── Kaydet ────────────────────────────────────────────────────────────────
  let error = $state<string | null>(null);

  async function save() {
    saving = true;
    saved  = false;
    error  = null;
    try {
      const ok = await store.save({
        deviceMicId:         selMicId,
        deviceSpeakerId:     selSpeakerId,
        deviceCameraId:      selCameraId,
        deviceInputVolume:   inputVolume,
        deviceOutputVolume:  outputVolume,
        deviceNoiseSuppression: noiseSuppression,
        deviceEchoCancellation: echoCancellation,
      });

      if (ok) {
        localStorage.setItem('bridge:device:mic',       selMicId);
        localStorage.setItem('bridge:device:speaker',   selSpeakerId);
        localStorage.setItem('bridge:device:camera',    selCameraId);
        localStorage.setItem('bridge:device:inputVol',  String(inputVolume));
        localStorage.setItem('bridge:device:outputVol', String(outputVolume));
        localStorage.setItem('bridge:device:noise',     String(noiseSuppression));
        localStorage.setItem('bridge:device:echo',      String(echoCancellation));

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
      } else {
        error = store.error ?? 'Kaydedilemedi';
      }
    } finally {
      saving = false;
    }
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────
  import { onMount, onDestroy } from 'svelte';

  onMount(() => { loadDevices(); });

  onDestroy(() => {
    testStream?.getTracks().forEach(t => t.stop());
  });
</script>

<section aria-labelledby="devices-heading">
  <h2 id="devices-heading" class="section-title">Ses &amp; Video Cihazları</h2>

  {#if loading}
    <p class="status-text">Cihazlar yükleniyor…</p>
  {:else if permError}
    <div class="perm-error" role="alert">
      <span class="perm-icon">🎙️</span>
      <p>{permError}</p>
      <button class="btn btn--secondary" onclick={loadDevices}>Tekrar Dene</button>
    </div>
  {:else}

    <!-- ── Giriş cihazı ─────────────────────────────────────────────────── -->
    <div class="field-group">
      <label class="field-label" for="mic-select">Mikrofon</label>
      <div class="device-row">
        <select id="mic-select" class="field-select" bind:value={selMicId}>
          <option value="">Sistem Varsayılanı</option>
          {#each audioInputs as d (d.deviceId)}
            <option value={d.deviceId}>{d.label || `Mikrofon ${audioInputs.indexOf(d) + 1}`}</option>
          {/each}
        </select>
        <button
          class="btn btn--test"
          class:btn--testing={testing}
          aria-label={testing ? 'Testi durdur' : 'Mikrofonu test et'}
          onclick={toggleMicTest}
        >
          {testing ? '⏹ Durdur' : '▶ Test'}
        </button>
      </div>

      <div class="volume-row">
        <label class="vol-label" for="input-vol">Giriş Ses: {inputVolume}%</label>
        <input
          id="input-vol"
          type="range" min="0" max="200"
          bind:value={inputVolume}
          class="vol-slider"
        />
      </div>
    </div>

    <!-- ── Çıkış cihazı ─────────────────────────────────────────────────── -->
    <div class="field-group">
      <label class="field-label" for="speaker-select">Hoparlör</label>
      <select id="speaker-select" class="field-select" bind:value={selSpeakerId}>
        <option value="">Sistem Varsayılanı</option>
        {#each audioOutputs as d (d.deviceId)}
          <option value={d.deviceId}>{d.label || `Hoparlör ${audioOutputs.indexOf(d) + 1}`}</option>
        {/each}
      </select>

      <div class="volume-row">
        <label class="vol-label" for="output-vol">Çıkış Ses: {outputVolume}%</label>
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
        <label class="field-label" for="camera-select">Kamera</label>
        <select id="camera-select" class="field-select" bind:value={selCameraId}>
          <option value="">Sistem Varsayılanı</option>
          {#each videoInputs as d (d.deviceId)}
            <option value={d.deviceId}>{d.label || `Kamera ${videoInputs.indexOf(d) + 1}`}</option>
          {/each}
        </select>
      </div>
    {/if}

    <!-- ── Gelişmiş ses ───────────────────────────────────────────────────── -->
    <div class="advanced-section">
      <p class="field-label">Gelişmiş Ses İşleme</p>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-title">Gürültü Bastırma</span>
          <span class="toggle-desc">Arka plan sesini azalt</span>
        </div>
        <button
          class="toggle-btn"
          class:on={noiseSuppression}
          aria-pressed={noiseSuppression}
          aria-label="Gürültü bastırmayı {noiseSuppression ? 'kapat' : 'aç'}"
          onclick={() => { noiseSuppression = !noiseSuppression; }}
        >
          <span class="toggle-knob"></span>
        </button>
      </div>

      <div class="toggle-row">
        <div class="toggle-info">
          <span class="toggle-title">Eko Giderme</span>
          <span class="toggle-desc">Hoparlör yankısını temizle</span>
        </div>
        <button
          class="toggle-btn"
          class:on={echoCancellation}
          aria-pressed={echoCancellation}
          aria-label="Eko gidermeyi {echoCancellation ? 'kapat' : 'aç'}"
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
          Kaydediliyor…
        {:else if saved}
          ✓ Kaydedildi
        {:else}
          Kaydet
        {/if}
      </button>
      <button class="btn btn--secondary" onclick={loadDevices}>
        ↺ Cihazları Yenile
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
    background: rgba(237,66,69,0.1);
    border: 1px solid rgba(237,66,69,0.3);
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
    border: 1px solid var(--border, rgba(255,255,255,0.1));
    border-radius: 6px;
    background: var(--bg-input, rgba(0,0,0,0.2));
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
    border-bottom: 1px solid rgba(255,255,255,0.06);
  }

  .toggle-info  { display: flex; flex-direction: column; gap: 2px; }
  .toggle-title { font-size: 14px; font-weight: 500; color: var(--text-primary, #e4e6eb); }
  .toggle-desc  { font-size: 12px; color: var(--text-muted, #6d6f78); }

  .toggle-btn {
    position: relative; width: 44px; height: 24px;
    border: none; border-radius: 12px;
    background: var(--bg-input, rgba(0,0,0,0.3));
    cursor: pointer; transition: background 0.2s; flex-shrink: 0;
  }

  .toggle-btn.on { background: var(--brand, #2d9cdb); }

  .toggle-knob {
    position: absolute; top: 2px; left: 2px;
    width: 20px; height: 20px; border-radius: 50%;
    background: #fff; transition: transform 0.2s;
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
    background: var(--brand, #2d9cdb); color: #fff;
  }

  .btn--primary:disabled { opacity: 0.45; cursor: not-allowed; }
  .btn--primary:not(:disabled):hover { background: var(--brand-hover, #677bc4); }
  .btn--saved { background: #3ba55d !important; }

  .btn--secondary {
    background: var(--bg-secondary, rgba(255,255,255,0.07));
    color: var(--text-secondary, #b0b3bb);
  }

  .btn--secondary:hover { background: rgba(255,255,255,0.12); }

  .btn--test {
    background: var(--bg-secondary, rgba(255,255,255,0.07));
    color: var(--text-secondary, #b0b3bb);
    white-space: nowrap;
    padding: 10px 14px;
  }

  .btn--testing { background: rgba(237,66,69,0.2); color: #ed4245; }

  .field-error {
    font-size: 13px;
    color: #ed4245;
    align-self: center;
  }
</style>
