<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { t } from './i18n/reactive.svelte.ts';
  import { focusTrap } from './a11y/focusTrap.ts';
  import { BridgeRegistry } from './bridge-registry.js';
  import { collectVoiceDiagnostics, type VoiceDiagnosticsSnapshot } from './voice-diagnostics.ts';
  import { downgradedAudioFeatures, type AppliedAudioSettings, type TriState } from './voice-audio-settings.ts';
  import type { ConnectionQuality } from './voice-connection-quality.ts';
  import { buildEchoReport } from './voice-echo-report.ts';
  import { createLogger } from './logger.js';

  const log = createLogger('VoiceCheckPanel');

  // ── YANKI TEŞHİS RAPORU ─────────────────────────────────────────────────
  // Yankı bildirimlerinde sorulan formun yarısı elle doldurulamaz
  // (`getSettings()` çıktısı, çıkış cihazının varsayılan olup olmadığı,
  // tarayıcı/OS). Elle istemek hem zahmetli hem hataya açık; form boş
  // döndüğünde teşhis hiç başlamıyor. Burada ölçülebilen her alan doldurulur,
  // kulakla verilecek kararlar boş bırakılır.
  let copyState = $state<'idle' | 'ok' | 'fail'>('idle');


  async function copyEchoReport(): Promise<void> {
    const text = buildEchoReport({ snapshot });
    try {
      await navigator.clipboard.writeText(text);
      copyState = 'ok';
    } catch (err) {
      // Pano izni yoksa rapor KAYBOLMAZ: konsola basılır.
      log.warn('Rapor panoya kopyalanamadı', err);
      log.info(text);
      copyState = 'fail';
    }
    setTimeout(() => { copyState = 'idle'; }, 2500);
  }

  // ── FAZ K/2 — sunum yardımcıları ────────────────────────────────────────
  //
  // Hepsinin ortak kuralı: ÖLÇÜLEMEYEN değer "iyi" diye gösterilmez.
  // Bir tanılama panelinin en kötü davranışı, bilmediğini biliyormuş gibi
  // sunmaktır — kullanıcı gerçek bir sorunu ararken yanlış yöne bakar.

  const qualityLabel = (q: ConnectionQuality): string => ({
    excellent: t('voice_quality_excellent', 'Mükemmel'),
    good: t('voice_quality_good', 'İyi'),
    poor: t('voice_quality_poor', 'Zayıf'),
    unknown: t('ui_olculemiyor', 'Ölçülemiyor'),
  } satisfies Record<ConnectionQuality, string>)[q];

  /** Sayısal ölçüm; `null` ise UYDURULMAZ. */
  function metric(value: number | null | undefined, unit: string): string {
    if (value === null || value === undefined) return t("ui_olculemiyor", "Ölçülemiyor");
    return unit ? `${value} ${unit}` : String(value);
  }

  /** `true | false | 'unknown'` — üçüncü durum gizlenmez. */
  function triState(value: TriState): string {
    if (value === true) return t("ui_acik", "Açık");
    if (value === false) return t("ui_kapali", "Kapalı");
    return t("ui_tarayici_bildirmiyor", "Tarayıcı bildirmiyor");
  }

  const featureLabel = (feature: string): string => ({
    echoCancellation: t('voice_echo_cancellation', 'yankı engelleme'),
    noiseSuppression: t('voice_noise_suppression', 'gürültü bastırma'),
    autoGainControl: t('voice_auto_gain', 'otomatik kazanç'),
  } satisfies Record<string, string>)[feature] ?? feature;
  const downgraded = (applied: AppliedAudioSettings): string[] =>
    downgradedAudioFeatures(applied).map(featureLabel);

  type TestOutcome = 'not-started' | 'running' | 'signal' | 'no-signal' | 'stopped' | 'error';
  type AudioContextConstructor = typeof AudioContext;

  let visible = $state(false);
  let loading = $state(false);
  let snapshot = $state<VoiceDiagnosticsSnapshot | null>(null);
  /** Varsayılan dışı bir çıkış cihazı seçili mi? (yankı giderme sınırı) */
  let nonDefaultOutput = $derived(
    Boolean(snapshot?.outputDeviceLabel)
      && !/varsayılan|default/i.test(snapshot?.outputDeviceLabel ?? ''),
  );
  let refreshSequence = 0;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  type IceReadiness = {
    state: 'loading' | 'ready' | 'error';
    turnConfigured: boolean;
    transportPolicy: 'all' | 'relay' | 'unknown';
    warning: boolean;
    serverCount: number;
  };
  let iceReadiness = $state<IceReadiness>({
    state: 'loading', turnConfigured: false, transportPolicy: 'unknown', warning: false, serverCount: 0,
  });

  let testing = $state(false);
  let micLevel = $state(0);
  let signalDetected = $state(false);
  let testOutcome = $state<TestOutcome>('not-started');
  let testError = $state('');
  let testStream: MediaStream | null = null;
  let ownsTestStream = false;
  let audioContext: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let animationFrame = 0;
  let testTimer: ReturnType<typeof setTimeout> | null = null;

  function canonicalRtc(): Record<string, unknown> | null {
    // Required architecture: one owner only. This panel never constructs RTC.
    return BridgeRegistry.get<Record<string, unknown>>('rtc');
  }

  async function refreshIceReadiness(): Promise<void> {
    iceReadiness = { state: 'loading', turnConfigured: false, transportPolicy: 'unknown', warning: false, serverCount: 0 };
    try {
      const apiFetch = BridgeRegistry.get<(url: string, init?: RequestInit) => Promise<Response>>('apiFetch');
      if (!apiFetch) throw new Error('api owner unavailable');
      const response = await apiFetch('/api/rtc/ice-config');
      if (!response.ok) throw new Error(`ICE readiness HTTP ${response.status}`);
      const body = await response.json() as {
        iceServers?: Array<{ urls?: string | string[] }>;
        iceTransportPolicy?: unknown;
        warning?: unknown;
      };
      const servers = Array.isArray(body.iceServers) ? body.iceServers : [];
      const hasTurn = servers.some((entry) => {
        const urls = Array.isArray(entry?.urls) ? entry.urls : typeof entry?.urls === 'string' ? [entry.urls] : [];
        return urls.some((url) => /^turns?:/i.test(url));
      });
      iceReadiness = {
        state: 'ready',
        turnConfigured: hasTurn,
        transportPolicy: body.iceTransportPolicy === 'relay' ? 'relay' : body.iceTransportPolicy === 'all' ? 'all' : 'unknown',
        warning: typeof body.warning === 'string' && body.warning.length > 0,
        serverCount: servers.length,
      };
    } catch (error) {
      log.warn('ICE readiness could not be loaded', error);
      iceReadiness = { state: 'error', turnConfigured: false, transportPolicy: 'unknown', warning: false, serverCount: 0 };
    }
  }

  async function refresh(): Promise<void> {
    const seq = ++refreshSequence;
    loading = snapshot === null;
    try {
      const next = await collectVoiceDiagnostics(canonicalRtc(), testStream);
      if (seq !== refreshSequence || !visible) return;
      snapshot = next;
    } catch (error) {
      log.warn('Voice diagnostics refresh failed', error);
    } finally {
      if (seq === refreshSequence) loading = false;
    }
  }

  function startRefreshTimer(): void {
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (visible) void refresh(); }, 2_000);
  }

  function open(): void {
    visible = true;
    snapshot = null;
    testOutcome = 'not-started';
    testError = '';
    micLevel = 0;
    signalDetected = false;
    void refresh();
    void refreshIceReadiness();
    startRefreshTimer();
  }

  function close(): void {
    visible = false;
    refreshSequence += 1;
    if (refreshTimer) clearInterval(refreshTimer);
    refreshTimer = null;
    stopMicTest('stopped');
  }

  function mediaErrorMessage(error: unknown): string {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'NotAllowedError' || name === 'SecurityError') return t("ui_mikrofon_izni_engellendi", "Mikrofon izni engellendi.");
    if (name === 'NotFoundError' || name === 'OverconstrainedError') return t("ui_secili_giris_cihazi_kullanilamiyor", "Seçili giriş cihazı kullanılamıyor.");
    if (name === 'NotReadableError') return t("ui_mikrofona_erisilemiyor_baska_bir_uygulama_kullaniyor", "Mikrofona erişilemiyor; başka bir uygulama kullanıyor olabilir.");
    return t("ui_mikrofon_testi_baslatilamadi", "Mikrofon testi başlatılamadı.");
  }

  function audioContextConstructor(): AudioContextConstructor | null {
    const extended = globalThis as typeof globalThis & { webkitAudioContext?: AudioContextConstructor };
    return globalThis.AudioContext ?? extended.webkitAudioContext ?? null;
  }

  function updateMeter(): void {
    if (!testing || !analyser) return;
    const samples = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(samples);
    let squares = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      squares += normalized * normalized;
    }
    const rms = Math.sqrt(squares / samples.length);
    micLevel = Math.min(100, Math.round(rms * 420));
    if (micLevel >= 3) signalDetected = true;
    animationFrame = requestAnimationFrame(updateMeter);
  }

  async function startMicTest(): Promise<void> {
    if (testing) { stopMicTest('stopped'); return; }
    testError = '';
    signalDetected = false;
    micLevel = 0;

    try {
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
      const rtc = canonicalRtc() as {
        selectedMicId?: string | null;
        getLocalStream?: () => MediaStream | null;
        localStream?: MediaStream | null;
        audioProcessingConstraints?: () => MediaTrackConstraints;
      } | null;
      const canonicalStream = rtc?.getLocalStream?.() ?? rtc?.localStream ?? null;
      const canonicalTrack = canonicalStream?.getAudioTracks?.().find(track => track.readyState === 'live' && track.enabled);

      if (canonicalTrack && canonicalStream) {
        testStream = canonicalStream;
        ownsTestStream = false;
      } else {
        // ════════════════════════════════════════════════════════════════
        // TEST, ARAMANIN KENDISIYLE AYNI KISITLARI KULLANIR
        // ════════════════════════════════════════════════════════════════
        // Onceden burada CIPLAK `audio: true` isteniyordu — yani yanki
        // giderme, gurultu bastirma ve kazanc kisitlari HIC verilmiyordu.
        // Sonuc: mikrofon testi, aramanin kullandigi yapilandirmadan BASKA
        // bir yapilandirmayi olcuyordu. `getSettings()` ciktisi tarayicinin
        // `audio: true` varsayilanlarini gosteriyor, kullanici ise bunu
        // "aramada yanki giderme acik/kapali" diye okuyordu.
        //
        // Teshis araci, teshis ettigi seyi yeniden uretmezse yaniltir.
        const canonicalConstraints = rtc?.audioProcessingConstraints?.();
        testStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            ...(canonicalConstraints ?? {
              echoCancellation: true, noiseSuppression: true, autoGainControl: true,
            }),
            ...(rtc?.selectedMicId ? { deviceId: { exact: rtc.selectedMicId } } : {}),
          },
          video: false,
        });
        ownsTestStream = true;
      }

      const Context = audioContextConstructor();
      if (!Context) throw Object.assign(new Error('unsupported'), { name: 'NotSupportedError' });
      audioContext = new Context();
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      audioContext.createMediaStreamSource(testStream).connect(analyser);
      testing = true;
      testOutcome = 'running';
      updateMeter();
      testTimer = setTimeout(() => stopMicTest(signalDetected ? 'signal' : 'no-signal'), 8_000);
      void refresh();
    } catch (error) {
      if (ownsTestStream) testStream?.getTracks().forEach(track => track.stop());
      testStream = null;
      ownsTestStream = false;
      testing = false;
      testOutcome = 'error';
      testError = mediaErrorMessage(error);
      void refresh();
    }
  }

  function stopMicTest(outcome: TestOutcome = 'stopped'): void {
    if (animationFrame) cancelAnimationFrame(animationFrame);
    animationFrame = 0;
    if (testTimer) clearTimeout(testTimer);
    testTimer = null;
    if (ownsTestStream) testStream?.getTracks().forEach(track => track.stop());
    testStream = null;
    ownsTestStream = false;
    analyser = null;
    if (audioContext) void audioContext.close().catch(() => {});
    audioContext = null;
    if (testing) testOutcome = outcome === 'stopped' && signalDetected ? 'signal' : outcome;
    testing = false;
    micLevel = 0;
  }

  function microphoneText(): string {
    if (!snapshot) return t("ui_olculuyor", "Ölçülüyor…");
    if (!snapshot.mediaApiAvailable) return t("ui_tarayici_desteklemiyor", "Tarayıcı desteklemiyor");
    if (snapshot.microphonePermission === 'denied') return t("ui_izin_engellendi", "İzin engellendi");
    if (snapshot.selectedInputUnavailable) return t("ui_secili_cihaz_yok", "Seçili cihaz yok");
    return snapshot.microphoneDetected ? t("ui_algilandi", "Algılandı") : t("ui_algilanmadi", "Algılanmadı");
  }

  function inputText(): string {
    if (testOutcome === 'running') return signalDetected ? t("ui_sinyal_aliniyor", "Sinyal alınıyor") : t("ui_test_suruyor", "Test sürüyor");
    if (testOutcome === 'signal') return t("ui_sinyal_algilandi", "Sinyal algılandı");
    if (testOutcome === 'no-signal') return t("ui_sinyal_algilanmadi", "Sinyal algılanmadı");
    if (testOutcome === 'error') return t("ui_test_basarisiz", "Test başarısız");
    return t("ui_test_baslatilmadi", "Test başlatılmadı");
  }

  function outputText(): string {
    if (!snapshot) return t("ui_olculuyor", "Ölçülüyor…");
    if (snapshot.outputDetected === null) return t("ui_tarayici_raporlamiyor", "Tarayıcı raporlamıyor");
    if (snapshot.selectedOutputUnavailable) return t("ui_secili_cihaz_yok", "Seçili cihaz yok");
    return snapshot.outputDetected ? t("ui_kullanilabilir", "Kullanılabilir") : t("ui_algilanmadi", "Algılanmadı");
  }

  function connectionText(): string {
    if (!snapshot) return t("ui_olculuyor", "Ölçülüyor…");
    if (!snapshot.rtcAvailable) return t("ui_rtc_sahibi_hazir_degil", "RTC sahibi hazır değil");
    if (!snapshot.inVoice) return t("ui_ses_kanalinda_degil", "Ses kanalında değil");
    if (snapshot.signalingConnected === false) return t("ui_sinyal_baglantisi_kapali", "Sinyal bağlantısı kapalı");
    if (snapshot.connectionState === 'connected') return t("ui_es_baglantisi_kuruldu", "Eş bağlantısı kuruldu");
    if (snapshot.connectionState === 'failed') return t("ui_es_baglantisi_kurulamadi", "Eş bağlantısı kurulamadı");
    if (snapshot.peerCount === 0 && snapshot.signalingConnected === true) return t("ui_signaling_bagli_henuz_es_yok", "Signaling bağlı · henüz eş yok");
    return snapshot.connectionState ? t('voice_connection_state', 'Bağlantı: {state}', { state: snapshot.connectionState }) : t("ui_durum_henuz_olculemedi", "Durum henüz ölçülemedi");
  }

  let actionableErrors = $derived.by(() => {
    const errors: string[] = [];
    if (!snapshot) return errors;
    if (!snapshot.mediaApiAvailable) errors.push(t("ui_bu_tarayici_mikrofon_erisimini_desteklemiyor", "Bu tarayıcı mikrofon erişimini desteklemiyor."));
    else if (snapshot.microphonePermission === 'denied') errors.push(t("ui_mikrofon_izni_engellendi_tarayici_site_izinlerini_ac", "Mikrofon izni engellendi. Tarayıcı site izinlerini açın."));
    else if (snapshot.selectedInputUnavailable) errors.push(t("ui_secili_giris_cihazi_kullanilamiyor_cihaz_ayarlarinda", "Seçili giriş cihazı kullanılamıyor. Cihaz ayarlarından başka bir mikrofon seçin."));
    else if (snapshot.microphonePermission === 'granted' && !snapshot.microphoneDetected) errors.push(t("ui_kullanilabilir_mikrofon_algilanmadi", "Kullanılabilir mikrofon algılanmadı."));
    if (snapshot.selectedOutputUnavailable) errors.push(t("ui_secili_cikis_cihazi_kullanilamiyor", "Seçili çıkış cihazı kullanılamıyor."));
    if (snapshot.inVoice && snapshot.signalingConnected === false) errors.push(t("ui_ses_kanalindasiniz_ancak_signaling_baglantisi_kapali", "Ses kanalındasınız ancak signaling bağlantısı kapalı."));
    if (snapshot.inVoice && snapshot.signalingConnected === true && snapshot.connectionState === 'failed') {
      errors.push(t("ui_signaling_bagli_ancak_es_baglantisi_kurulamadi", "Signaling bağlı ancak eş bağlantısı kurulamadı."));
    }
    if (testOutcome === 'no-signal') errors.push(t("ui_mikrofon_testi_sirasinda_giris_sinyali_algilanmadi", "Mikrofon testi sırasında giriş sinyali algılanmadı."));
    if (testError) errors.push(testError);
    return [...new Set(errors)];
  });

  function onKeyDown(event: KeyboardEvent): void {
    if (visible && event.key === 'Escape') { event.preventDefault(); close(); }
  }

  function onVoiceStateChange(): void { if (visible) void refresh(); }

  onMount(() => {
    BridgeRegistry.register('openVoiceCheck', open);
    BridgeRegistry.register('closeVoiceCheck', close);
    document.addEventListener('bridge:voice-joined', onVoiceStateChange);
    document.addEventListener('bridge:voice-left', onVoiceStateChange);
  });

  onDestroy(() => {
    close();
    BridgeRegistry.unregister('openVoiceCheck');
    BridgeRegistry.unregister('closeVoiceCheck');
    document.removeEventListener('bridge:voice-joined', onVoiceStateChange);
    document.removeEventListener('bridge:voice-left', onVoiceStateChange);
  });
</script>

<svelte:window onkeydown={onKeyDown} />

{#if visible}
  <div class="vcheck-overlay" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) close(); }}>
    <div class="vcheck-panel" role="dialog" aria-modal="true" aria-labelledby="vcheck-title"
         use:focusTrap={{ initialFocus: '.vcheck-close' }}>
      <header class="vcheck-header">
        <div>
          <span class="vcheck-eyebrow">{t('vc_title', 'Yerel ses tanılaması')}</span>
          <h2 id="vcheck-title">{t('voice_check', 'Ses Kontrolü')}</h2>
          <p>{t('markup_ses_kaydedilmez_veya_yuklenmez_yalniz_bu_cihazda_435c462', "Ses kaydedilmez veya yüklenmez. Yalnız bu cihazdaki ölçülebilir durumlar gösterilir.")}</p>
        </div>
        <button type="button" class="vcheck-close" onclick={close} aria-label={t('voice_check_close', 'Ses Kontrolü’nü kapat')}>✕</button>
      </header>

      <div class="vcheck-body" aria-busy={loading}>
        <div class="vcheck-grid" aria-live="polite">
          <article class="vcheck-card">
            <span class="vcheck-card-icon" aria-hidden="true">{snapshot?.microphoneDetected ? '✓' : '—'}</span>
            <span><strong>{t('tip_mic')}</strong><small>{microphoneText()}</small></span>
          </article>
          <article class="vcheck-card">
            <span class="vcheck-card-icon" aria-hidden="true">{signalDetected ? '✓' : '—'}</span>
            <span><strong>{t('vc_input', 'Giriş')}</strong><small>{inputText()}</small></span>
          </article>
          <article class="vcheck-card">
            <span class="vcheck-card-icon" aria-hidden="true">{snapshot?.outputDetected === true ? '✓' : '—'}</span>
            <span><strong>{t('vc_output', 'Çıkış')}</strong><small>{outputText()}</small></span>
          </article>
          <article class="vcheck-card">
            <span class="vcheck-card-icon" aria-hidden="true">{snapshot?.connectionState === 'connected' ? '✓' : '—'}</span>
            <span><strong>{t('vc_connection', 'Bağlantı')}</strong><small>{connectionText()}</small></span>
          </article>
        </div>

        <section class="vcheck-meter-section" aria-labelledby="vcheck-mic-test">
          <div class="vcheck-section-head">
            <div><h3 id="vcheck-mic-test">{t('markup_mikrofon_testi_da6ab65', "Mikrofon testi")}</h3><p>{t('vc_level_local', 'Seviye yalnız tarayıcı belleğinde analiz edilir.')}</p></div>
            <button type="button" class="vcheck-primary" onclick={startMicTest}>
              {testing ? 'Testi durdur' : t("surface_testi_baslat_6ceeb7")}
            </button>
          </div>
          <div class="vcheck-meter" role="progressbar" aria-label={t('vc_mic_level', 'Mikrofon giriş seviyesi')}
               aria-valuemin="0" aria-valuemax="100" aria-valuenow={micLevel}>
            <span style={`width:${micLevel}%`}></span>
          </div>
          <p class="vcheck-meter-label" role="status">{inputText()}</p>
        </section>

        {#if snapshot}
          <dl class="vcheck-details">
            {#if snapshot.inputDeviceLabel}<div><dt>{t('vc_input_device', 'Giriş cihazı')}</dt><dd>{snapshot.inputDeviceLabel}</dd></div>{/if}
            {#if snapshot.outputDeviceLabel}<div><dt>{t('vc_output_device', 'Çıkış cihazı')}</dt><dd>{snapshot.outputDeviceLabel}</dd></div>{/if}
            <div><dt>{t('markup_mikrofon_izni_1fecdc3', "Mikrofon izni")}</dt><dd>{snapshot.microphonePermission}</dd></div>
            <div><dt>{t('markup_signaling_67ad91c', "Signaling")}</dt><dd>{snapshot.signalingConnected === null ? t("ui_olculemiyor") : snapshot.signalingConnected ? t("voice_connected") : t("voice_disconnected")}</dd></div>
            {#if snapshot.connectionState}<div><dt>{t('vc_conn_state', 'Bağlantı durumu')}</dt><dd>{snapshot.connectionState}</dd></div>{/if}
            {#if snapshot.iceState}<div><dt>{t('markup_ice_durumu_951eb3b', "ICE durumu")}</dt><dd>{snapshot.iceState}</dd></div>{/if}
            {#if snapshot.latencyMs !== undefined}<div><dt>{t('markup_gecikme_ce94b56', "Gecikme")}</dt><dd>{snapshot.latencyMs} ms</dd></div>{/if}
            {#if snapshot.packetLossPercent !== undefined}<div><dt>{t('vc_packet_loss', 'Paket kaybı')}</dt><dd>%{snapshot.packetLossPercent}</dd></div>{/if}
          </dl>

          <!--
            FAZ K/2 — ÖLÇÜLEN AMA HİÇ GÖSTERİLMEYEN VERİ.
            `collectVoiceDiagnostics` bağlantı kalitesini ve tarayıcının
            mikrofona GERÇEKTEN uyguladığı ayarları zaten hesaplıyordu; iki
            alan da hiçbir yüzeyde çizilmiyordu. Ölçüp saklamak, kullanıcı
            için ölçmemekle aynıdır.
          -->
          <section class="vcheck-quality" aria-labelledby="vcheck-quality-title">
            <div class="vcheck-section-head">
              <div>
                <h3 id="vcheck-quality-title">{t('vc_conn_quality', 'Bağlantı kalitesi')}</h3>
                <p>{t('vc_real', 'Gerçek')} <code>getStats()</code> {t('vc_no_identifiers', 'ölçümleri. Adres, ICE adayı veya kimlik bilgisi gösterilmez.')}</p>
              </div>
              <span class="vcheck-badge" data-quality={snapshot.connectionQuality.quality}>
                {qualityLabel(snapshot.connectionQuality.quality)}
              </span>
            </div>
            <dl class="vcheck-details">
              <div><dt>{t('markup_gecikme_rtt_58d5bd5', "Gecikme (RTT)")}</dt><dd>{metric(snapshot.connectionQuality.latencyMs, 'ms')}</dd></div>
              <div><dt>{t('markup_jitter_70a5b3c', "Jitter")}</dt><dd>{metric(snapshot.connectionQuality.jitterMs, 'ms')}</dd></div>
              <div><dt>{t('vc_packet_loss', 'Paket kaybı')}</dt><dd>{metric(snapshot.connectionQuality.packetLossPercent, '%')}</dd></div>
              <div><dt>{t('vc_measured_conn', 'Ölçülen bağlantı')}</dt><dd>{snapshot.connectionQuality.sampledPeers}</dd></div>
            </dl>
          </section>

          <section class="vcheck-applied" aria-labelledby="vcheck-applied-title">
            <div class="vcheck-section-head">
              <div>
                <h3 id="vcheck-applied-title">{t('vc_applied_audio', 'Uygulanan ses ayarları')}</h3>
                <!-- İSTENEN kısıtlama ile UYGULANAN ayar aynı şey değildir;
                     burada yalnızca ikincisi raporlanır. -->
                <p>{t('vc_applied_hint', 'Tarayıcının mikrofona gerçekten uyguladığı değerler.')}</p>
                <!--
                  ÖLÇÜM KAYNAĞI GİZLENMEZ. Mikrofon testi track'i, aramanın
                  KENDİSİ değildir: aynı kısıtlarla alınır ama ayrı bir
                  yakalamadır. Kaynağı yazmazsak tek kişilik bir ölçüm, iki
                  kişilik bir aramanın kanıtı gibi okunur.
                -->
                {#if snapshot.appliedAudioSource === 'call'}
                  <p class="vcheck-source">{t('vc_source_live', 'Kaynak: canlı arama akışı.')}</p>
                {:else if snapshot.appliedAudioSource === 'mic-test'}
                  <p class="vcheck-source">
                    {t('markup_kaynak_mikrofon_testi_akisi_aramanin_kisitlariyl_ce93a48', "Kaynak: mikrofon testi akışı — aramanın kısıtlarıyla alındı,")}
                    <strong>{t('vc_proxy_measure', 'vekil ölçüm')}</strong> {t("ui_proxy_not_live_call")}
                  </p>
                {/if}
              </div>
            </div>
            {#if !snapshot.appliedAudio.supported}
              <p class="vcheck-muted">{t('vc_not_reported', 'Bu tarayıcı uygulanan ayarları bildirmiyor.')}</p>
            {:else if !snapshot.appliedAudio.trackLive}
              <p class="vcheck-muted">{t('vc_no_stream', 'Canlı bir mikrofon akışı yok — ölçüm alınamıyor.')}</p>
            {:else}
              <dl class="vcheck-details">
                <div><dt>{t('vc_echo_cancel', 'Yankı engelleme')}</dt><dd>{triState(snapshot.appliedAudio.audio.echoCancellation)}</dd></div>
                <div><dt>{t('vc_noise_suppress', 'Gürültü bastırma')}</dt><dd>{triState(snapshot.appliedAudio.audio.noiseSuppression)}</dd></div>
                <div><dt>{t('vc_auto_gain', 'Otomatik kazanç')}</dt><dd>{triState(snapshot.appliedAudio.audio.autoGainControl)}</dd></div>
                <div><dt>{t('vc_sample_rate', 'Örnekleme')}</dt><dd>{metric(snapshot.appliedAudio.audio.sampleRate, 'Hz')}</dd></div>
                <div><dt>{t('ui_kanal')}</dt><dd>{metric(snapshot.appliedAudio.audio.channelCount, '')}</dd></div>
              </dl>
              {#if downgraded(snapshot.appliedAudio).length}
                <p class="vcheck-warn" role="status">
                  {t("ui_browser_not_applied", undefined, { items: downgraded(snapshot.appliedAudio).join(', ') })}
                </p>
              {/if}
              <!--
                ÇIKIŞ CİHAZI UYARISI — yankı gidermenin bilinen sınırı.
                Tarayıcının yankı gidericisi VARSAYILAN render akışını
                referans alır. Ses `setSinkId` ile başka bir cihaza
                yönlendirildiğinde, giderici o sesi izlemediği için iptal
                EDEMEZ. Bu bir Bridge kusuru değildir, ama kullanıcı
                hoparlörle konuşurken yankının SEBEBİ olabilir ve sessiz
                kalmak kullanıcıyı yanlış yere baktırır.
              -->
              {#if nonDefaultOutput}
                <p class="vcheck-warn" role="status">
                  {t('markup_varsayilan_olmayan_bir_cikis_cihazi_secili_taray_b5a0a89', "Varsayılan olmayan bir çıkış cihazı seçili. Tarayıcının yankı gidericisi yalnızca varsayılan çıkışı izler; hoparlörle konuşurken yankı duyarsanız çıkışı sistem varsayılanına alıp tekrar deneyin.")}
                </p>
              {/if}
            {/if}
          </section>
        {/if}

        <section class="vcheck-quality" aria-labelledby="vcheck-relay-title">
          <div class="vcheck-section-head">
            <div>
              <h3 id="vcheck-relay-title">{t("voice_network_relay_ready")}</h3>
              <p>{t('markup_kimlik_bilgileri_ve_turn_adresleri_gosterilmeden_c272325', "Kimlik bilgileri ve TURN adresleri gösterilmeden yalnız etkin RTC politikası özetlenir.")}</p>
            </div>
            <span class="vcheck-badge" data-quality={iceReadiness.state === 'ready' && iceReadiness.turnConfigured ? 'good' : 'unknown'}>
              {#if iceReadiness.state === 'loading'}{t("ui_checking")}
              {:else if iceReadiness.state === 'error'}{t("ui_unmeasurable")}
              {:else if iceReadiness.turnConfigured}{t("ui_turn_ready")}
              {:else}{t("ui_stun_direct")}
              {/if}
            </span>
          </div>
          <dl class="vcheck-details">
            <div><dt>{t("voice_turn_config")}</dt><dd>{iceReadiness.state !== 'ready' ? t("ui_olculemiyor") : iceReadiness.turnConfigured ? 'Mevcut' : t("surface_yap_land_r_lmam_s_ab9284")}</dd></div>
            <div><dt>{t("voice_ice_transport_policy")}</dt><dd>{iceReadiness.transportPolicy === 'relay' ? t("surface_yaln_z_relay_16ce01") : iceReadiness.transportPolicy === 'all' ? t("surface_dogrudan_relay_78c399") : t("ui_olculemiyor")}</dd></div>
            <div><dt>{t('markup_ice_sunucu_girdisi_252407e', "ICE sunucu girdisi")}</dt><dd>{iceReadiness.state === 'ready' ? iceReadiness.serverCount : '—'}</dd></div>
            <div><dt>{t("voice_operator_warning")}</dt><dd>{iceReadiness.state === 'ready' ? iceReadiness.warning ? t("surface_var_yap_land_rmay_kontrol_edin_1dcbda") : t('voice_check_none', 'Yok') : '—'}</dd></div>
          </dl>
          {#if iceReadiness.state === 'ready' && !iceReadiness.turnConfigured}
            <p class="vcheck-meter-label">{t('markup_kisitli_nat_firewall_aglarinda_gercek_relay_kani_b86cfde', "Kısıtlı NAT/firewall ağlarında gerçek relay kanıtı olmadan bağlantı garantisi verilemez.")}</p>
          {/if}
        </section>

        {#if actionableErrors.length}
          <section class="vcheck-errors" aria-labelledby="vcheck-errors-title">
            <h3 id="vcheck-errors-title">{t('markup_dikkat_gerekenler_a253097', "Dikkat gerekenler")}</h3>
            <ul>{#each actionableErrors as error}<li>{error}</li>{/each}</ul>
          </section>
        {/if}
      </div>

      <footer class="vcheck-footer">
        <span>{t('vc_no_ice', 'ICE kimlik bilgileri ve ağ adresleri gösterilmez.')}</span>
        <div class="vcheck-actions">
          <button
            type="button"
            class="vcheck-secondary"
            onclick={() => void copyEchoReport()}
          >
            {copyState === 'ok' ? t("surface_kopyaland_02526a") : copyState === 'fail' ? t("surface_konsola_yaz_ld_1e91e3") : t("surface_yank_raporunu_kopyala_7a6ccb")}
          </button>
          <button type="button" class="vcheck-secondary" onclick={() => void refresh()} disabled={loading}>{t('markup_yenile_255b90e', "Yenile")}</button>
        </div>
      </footer>
    </div>
  </div>
{/if}

<style>
.vcheck-actions { display: flex; gap: var(--space-2, 8px); }
.vcheck-source { font-size: var(--text-xs, 11px); color: var(--text-3); margin-top: 2px; }

/* FAZ K/2 — bağlantı kalitesi + uygulanan ses ayarları. */
.vcheck-quality,
.vcheck-applied { margin-top: 18px; }

.vcheck-badge {
  align-self: center;
  padding: 4px 11px;
  font-size: var(--text-2xs);
  font-weight: 700;
  letter-spacing: .04em;
  text-transform: uppercase;
  border: 1px solid var(--border);
  border-radius: 999px;
  /* Renk TEK BAŞINA anlam taşımaz: rozetin metni de kaliteyi söyler,
     böylece renk körü kullanıcı da aynı bilgiyi alır. */
  color: var(--text-muted);
  background: var(--bg-3);
}
.vcheck-badge[data-quality='excellent'] { color: var(--green);  background: var(--green-bg);  border-color: var(--green); }
.vcheck-badge[data-quality='good']      { color: var(--yellow); background: var(--yellow-bg); border-color: var(--yellow); }
.vcheck-badge[data-quality='poor']      { color: var(--danger); background: var(--danger-bg, var(--bg-3)); border-color: var(--danger); }

.vcheck-muted { margin: 6px 0 0; font-size: var(--text-sm); color: var(--text-muted); }
.vcheck-warn  { margin: 8px 0 0; font-size: var(--text-sm); color: var(--warning-text, var(--yellow)); }

  .vcheck-overlay { position: fixed; inset: 0; z-index: var(--layer-modal); display: grid; place-items: center; padding: 20px; background: color-mix(in srgb, var(--bg-0) 82%, transparent); backdrop-filter: blur(8px) saturate(110%); }
  .vcheck-panel { width: min(720px, 100%); max-height: min(780px, calc(var(--bridge-visual-viewport-height, 100dvh) - 40px)); display: flex; flex-direction: column; overflow: hidden; color: var(--text-primary); background: var(--bg-2); border: 1px solid var(--border-strong); border-radius: var(--radius-modal); box-shadow: var(--shadow-xl); }
  .vcheck-header { display: flex; gap: 18px; align-items: flex-start; padding: 20px 22px 16px; background: var(--bg-3); border-bottom: 1px solid var(--border); }
  .vcheck-header > div { flex: 1; min-width: 0; }
  .vcheck-eyebrow { color: var(--brand); font-size: var(--type-caption); font-weight: 800; letter-spacing: .08em; text-transform: uppercase; }
  .vcheck-header h2 { margin: 3px 0 4px; font-size: var(--type-title-lg); }
  .vcheck-header p, .vcheck-section-head p, .vcheck-meter-label { margin: 0; color: var(--text-muted); font-size: var(--type-body-sm); }
  .vcheck-close { border: 0; border-radius: var(--radius-control); padding: 5px 8px; color: var(--text-muted); background: transparent; cursor: pointer; font-size: 18px; }
  .vcheck-close:hover, .vcheck-close:focus-visible { color: var(--text-primary); background: var(--surface-hover); }
  .vcheck-body { min-height: 0; overflow-y: auto; padding: 18px 22px; display: grid; gap: 16px; }
  .vcheck-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 9px; }
  .vcheck-card { min-width: 0; display: flex; gap: 9px; align-items: center; padding: 12px; background: var(--bg-3); border: 1px solid var(--border); border-radius: var(--radius-surface); }
  .vcheck-card-icon { width: 24px; height: 24px; flex: 0 0 24px; display: grid; place-items: center; color: var(--brand); background: var(--brand-subtle); border-radius: 50%; font-weight: 900; }
  .vcheck-card span:last-child { min-width: 0; display: grid; gap: 2px; }
  .vcheck-card strong, .vcheck-card small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .vcheck-card strong { font-size: var(--type-body-sm); }
  .vcheck-card small { color: var(--text-muted); font-size: var(--type-caption); }
  .vcheck-meter-section { display: grid; gap: 10px; padding: 14px; border: 1px solid var(--border); border-radius: var(--radius-surface); background: var(--bg-3); }
  .vcheck-section-head { display: flex; gap: 16px; align-items: center; justify-content: space-between; }
  .vcheck-section-head h3, .vcheck-errors h3 { margin: 0 0 2px; font-size: var(--type-title-sm); }
  .vcheck-primary, .vcheck-secondary { border: 1px solid transparent; border-radius: var(--radius-control); padding: 8px 12px; color: var(--text-on-solid); background: var(--brand); cursor: pointer; font: 700 var(--type-body-sm)/1 var(--font-sans); white-space: nowrap; }
  .vcheck-secondary { color: var(--text-2); background: transparent; border-color: var(--border-strong); }
  .vcheck-primary:hover { background: var(--brand-hover); }
  .vcheck-secondary:hover { color: var(--text-primary); background: var(--surface-hover); }
  .vcheck-meter { height: 10px; overflow: hidden; background: var(--bg-1); border: 1px solid var(--border); border-radius: var(--radius-pill); }
  .vcheck-meter span { display: block; height: 100%; background: linear-gradient(90deg, var(--brand), var(--green)); transition: width 80ms linear; }
  .vcheck-details { margin: 0; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); border: 1px solid var(--border); border-radius: var(--radius-surface); overflow: hidden; }
  .vcheck-details div { min-width: 0; display: grid; gap: 3px; padding: 10px 12px; border-bottom: 1px solid var(--border); }
  .vcheck-details div:nth-child(odd) { border-right: 1px solid var(--border); }
  .vcheck-details dt { color: var(--text-muted); font-size: var(--type-caption); }
  .vcheck-details dd { margin: 0; overflow-wrap: anywhere; font-size: var(--type-body-sm); font-weight: 650; }
  .vcheck-errors { padding: 12px 14px; color: var(--warning-text, var(--text-primary)); background: var(--warning-bg, var(--bg-3)); border: 1px solid var(--warning, var(--border-strong)); border-radius: var(--radius-surface); }
  .vcheck-errors ul { margin: 7px 0 0; padding-left: 20px; display: grid; gap: 4px; font-size: var(--type-body-sm); }
  .vcheck-footer { display: flex; gap: 14px; align-items: center; padding: 12px 22px; color: var(--text-muted); background: var(--bg-3); border-top: 1px solid var(--border); font-size: var(--type-caption); }
  .vcheck-footer span { flex: 1; }
  @media (max-width: 720px) { .vcheck-overlay { padding: 0; align-items: stretch; } .vcheck-panel { width: 100%; max-height: none; height: var(--bridge-visual-viewport-height, 100dvh); border: 0; border-radius: 0; } .vcheck-header { padding-top: max(12px, env(safe-area-inset-top)); } .vcheck-body { padding-bottom: calc(16px + env(safe-area-inset-bottom)); } .vcheck-grid { grid-template-columns: repeat(2, minmax(0, 1fr)); } .vcheck-details { grid-template-columns: 1fr; } .vcheck-details div:nth-child(odd) { border-right: 0; } }
  @media (prefers-reduced-motion: reduce) { .vcheck-meter span { transition: none; } }
</style>
