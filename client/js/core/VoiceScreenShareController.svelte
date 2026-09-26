<!-- client/js/core/VoiceScreenShareController.svelte -->
<!-- Sprint 119 Refactor: Ekran paylaşımı mantığı VoicePanel.svelte'den ayrıldı (~120 satır tasarruf) -->

<script lang="ts">
  import { onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';
  import { toast } from './utils.ts';
  import { t } from './i18n/reactive.svelte.ts';

  const log = createLogger('VoiceScreenShare');

  // ── Tipler ──────────────────────────────────────────────────────────────────
  interface QualityPrefs {
    preset?: string;
    bitrateKbps?: number;
  }

  interface RtcAdapter {
    isInVoice(): boolean;
    startScreenShare(quality: string, audio: boolean): Promise<boolean>;
    stopScreenShare(): void;
    getLocalStream(): MediaStream | null;
    getRemoteScreenStream?(): MediaStream | null;
  }

  // ── Props ────────────────────────────────────────────────────────────────────
  interface Props {
    getRtc: () => RtcAdapter | null;
    onShareStarted?: () => void;
    onShareStopped?: () => void;
    qualityModalOpen?: boolean;
  }

  let { getRtc, onShareStarted, onShareStopped, qualityModalOpen = $bindable(false) }: Props = $props();

  // ── State ────────────────────────────────────────────────────────────────────
  // ── DURUM ────────────────────────────────────────────────────────────────
  // Bu bilesen MARKUP ICERMEZ: yalnizca mantik tasir ve `bind:this` ile
  // disari `export function` sunar. Ciziim VoicePanel'e aittir.
  //
  // KALDIRILAN OLU DURUM: viewVisible, loadingVisible, localStream,
  // channelName, sharerName, qualityLabel, stopBtnVisible, shareBtnVisible,
  // localBadge. Mantik VoicePanel'den buraya tasinirken (Sprint 119/120) bu
  // degiskenler de kopyalanmisti; oysa DOM artik burada degil. Yalnizca
  // YAZILIYOR, hicbir yerde OKUNMUYORLARDI.
  //
  // NEDEN SILMEK ONEMLI: VoicePanel'in KENDI `sharerName`,
  // `showScreenShareView`, `localScreenStream` durumu var. Ayni ismi tasiyan
  // ikinci bir kopya birakmak aktif bir tuzaktir — sonraki bir duzenleme
  // buradaki kopyayi guncelleyip arayuzun degismesini bekler ve hicbir sey
  // olmaz.
  let active        = $state(false);
  let miniMode      = $state(false);
  let remoteStream  = $state<MediaStream | null>(null);

  // ── Dahili: kalite etiket çevirisi ──────────────────────────────────────────
  function _label(q: string): string {
    const MAP: Record<string, string> = {
      low:    '480p / 500kbps',
      medium: '720p / 1.5Mbps',
      high:   '1080p / 3Mbps',
    };
    return MAP[q] ?? q;
  }

  function _loadQualityPrefs(): QualityPrefs {
    try {
      return JSON.parse(localStorage.getItem('bridgeSSQuality') ?? '{}');
    } catch {
      return {};
    }
  }

  function _saveQualityPrefs(prefs: QualityPrefs): void {
    try {
      localStorage.setItem('bridgeSSQuality', JSON.stringify(prefs));
    } catch { /* ignore */ }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  export function toggle(): void {
    if (active) stopShare();
    else        openQualityPicker();
  }

  export function openQualityPicker(): void {
    const prefs = _loadQualityPrefs();
    if (prefs.preset) {
      void startWithQuality(prefs.preset);
    } else {
      qualityModalOpen = true;
    }
  }

  export async function startWithQuality(quality: string): Promise<void> {
    qualityModalOpen = false;

    const saveEl    = document.getElementById('ss-save-as-default') as HTMLInputElement | null;
    const saveDefault = saveEl?.checked ?? false;
    if (saveDefault) {
      const prefs = _loadQualityPrefs();
      _saveQualityPrefs({ ...prefs, preset: quality });
    }

    const audioEl   = document.getElementById('ss-include-audio') as HTMLInputElement | null;
    const includeAudio = audioEl?.checked ?? false;

    const r = getRtc();
    if (!r?.isInVoice()) return;


    const ok = await r.startScreenShare(quality, includeAudio);

    if (!ok) {
      log.warn({ ss: 'start_failed', quality });
      return;
    }

    active = true;

    // ══════════════════════════════════════════════════════════════════════
    // GERCEK YAKALANAN SES DURUMU — KUTUNUN ISARETLI OLMASI KANIT DEGILDIR
    // ══════════════════════════════════════════════════════════════════════
    // `getDisplayMedia` ses track'i verip vermeyecegi tarayiciya, isletim
    // sistemine ve SECILEN YUZEYE baglidir (Chrome sekmede verir, cogu
    // durumda tum ekranda vermez; Firefox/Safari buyuk olcude hic vermez).
    //
    // Bu yuzden kullaniciya "ses paylasiliyor" DENMEZ; yalnizca gercekten
    // yakalanan durum bildirilir. Aksi halde karsi taraf hicbir sey duymazken
    // paylasan kisi sesin gittigini SANIRDI.
    if (includeAudio) {
      const captured = Boolean((r as unknown as { screenAudioActive?: boolean }).screenAudioActive);
      toast(t(captured ? 'ss_audio_shared' : 'ss_audio_unavailable'), captured ? 'success' : 'info');
      log.info({ ss: 'audio_state', requested: true, captured });
    }

    // Bitrate override
    try {
      const prefs = _loadQualityPrefs();
      if (prefs.bitrateKbps) {
        const pc = (r as unknown as { _pc?: RTCPeerConnection })._pc;
        if (pc) {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) {
            const params = sender.getParameters();
            if (params.encodings?.[0]) {
              params.encodings[0].maxBitrate = prefs.bitrateKbps * 1000;
              await sender.setParameters(params);
            }
          }
        }
      }
    } catch (err) {
      log.warn({ ss: 'bitrate_override_failed', err });
    }

    // Registry callback
    BridgeRegistry.get('_onScreenShareStarted')?.();
    onShareStarted?.();
    log.debug({ ss: 'started', quality });
  }

  export function stopShare(): void {
    BridgeRegistry.get('_onScreenShareStopped')?.();
    getRtc()?.stopScreenShare();
    active = false;
    onShareStopped?.();
    log.debug({ ss: 'stopped' });
  }

  /**
   * SU AN CAGRILMIYOR — FAZ K+ FANTOM SINIFLANDIRMASI: DELETE adayi.
   *
   * Istemcinin tamaminda call site YOKTUR (arama: `setRemoteStream`). Uzak
   * ekran paylasiminin KANONIK yolu VoicePanel'dedir: paylasan kisinin adini
   * kendi `sharerName` durumuna yazar (VoicePanel.svelte:437) ve `#ss-sharer
   * -name` icinde cizer (VoicePanel.svelte:890).
   *
   * `sharer` ve `ch` parametreleri BU BILESENDE hicbir zaman kullanilmadi —
   * bilesen markup icermez. Bu yuzden alt cizgiyle isaretlendiler: imza
   * korunuyor ama "bu degerler bir yere gidiyor" yanilgisi uretmiyorlar.
   *
   * SILINMEDI cunku `bind:this` ile disaridan cagrilabilecek bir yuzeydir ve
   * bu gecis lint amacli fonksiyon silmemeyi sart kosuyordu. Kalici karar
   * fantom raporunda verilir.
   */
  export function setRemoteStream(stream: MediaStream | null, _sharer: string, _ch: string): void {
    remoteStream = stream;
    if (stream) {
    } else if (!active) {
    }
  }

  export function toggleFullscreen(): void {
    const el = (document.getElementById('remote-screen-video')
      ?? document.getElementById('ss-remote-video')) as HTMLVideoElement | null;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else el.requestFullscreen().catch(() => {});
  }

  export function toggleMini(): void {
    miniMode = !miniMode;
  }

  function _hasRemote(): boolean {
    return remoteStream !== null;
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────────
  onDestroy(() => {
    if (active) stopShare();
  });
</script>
