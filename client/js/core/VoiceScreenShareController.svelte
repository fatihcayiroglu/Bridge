<!-- client/js/core/VoiceScreenShareController.svelte -->
<!-- Sprint 119 Refactor: Ekran paylaşımı mantığı VoicePanel.svelte'den ayrıldı (~120 satır tasarruf) -->

<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { BridgeRegistry } from './bridge-registry.js';
  import { createLogger } from './logger.js';

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
  let active        = $state(false);
  let viewVisible   = $state(false);
  let miniMode      = $state(false);
  let loadingVisible = $state(false);
  let localStream   = $state<MediaStream | null>(null);
  let remoteStream  = $state<MediaStream | null>(null);
  let channelName   = $state('');
  let sharerName    = $state('');
  let qualityLabel  = $state('');
    let stopBtnVisible   = $state(false);
  let shareBtnVisible  = $state(true);
  let localBadge       = $state(false);

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

    loadingVisible = true;
    stopBtnVisible = false;
    shareBtnVisible = false;

    const ok = await r.startScreenShare(quality, includeAudio);
    loadingVisible = false;

    if (!ok) {
      log.warn({ ss: 'start_failed', quality });
      shareBtnVisible = true;
      return;
    }

    active = true;
    viewVisible = true;
    stopBtnVisible = true;
    localBadge = true;
    qualityLabel = _label(quality);

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
    localStream = null;
    stopBtnVisible = false;
    shareBtnVisible = true;
    localBadge = false;
    qualityLabel = '';
    if (!_hasRemote()) viewVisible = false;
    onShareStopped?.();
    log.debug({ ss: 'stopped' });
  }

  export function setRemoteStream(stream: MediaStream | null, sharer: string, ch: string): void {
    remoteStream = stream;
    sharerName   = sharer;
    channelName  = ch;
    if (stream) {
      viewVisible = true;
      stopBtnVisible = false;
    } else if (!active) {
      viewVisible = false;
    }
  }

  export function toggleFullscreen(): void {
    const el = document.getElementById('ss-remote-video') as HTMLVideoElement | null;
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
