// Local, sanitized voice diagnostics derived from the canonical RTC owner.
// No SDP, ICE server/candidate data, credentials, addresses, auth material, or
// media samples leave this module.

import { readAppliedAudioSettings, unknownAudioSettings, type AppliedAudioSettings } from './voice-audio-settings.js';
import { t } from './i18n/index.ts';
import { collectConnectionQuality, unknownConnectionQuality, type VoiceConnectionQuality } from './voice-connection-quality.js';

export type MicPermissionState = 'granted' | 'denied' | 'prompt' | 'unsupported' | 'unknown';

interface RtcLike {
  currentChannelId?: string | null;
  localStream?: MediaStream | null;
  selectedMicId?: string | null;
  selectedSpeakerId?: string | null;
  peers?: Map<unknown, RTCPeerConnection>;
  socket?: { connected?: boolean };
  sendTransport?: { connectionState?: string } | null;
  recvTransport?: { connectionState?: string } | null;
  isInVoice?: () => boolean;
  getLocalStream?: () => MediaStream | null;
  // SFU fallback keeps these internally. They remain canonical RTC-owned peer
  // connections; reading their public state does not create another owner.
  _p2pPeers?: Map<unknown, RTCPeerConnection>;
}

export type AppliedAudioSource = 'call' | 'mic-test' | 'none';

export interface VoiceDiagnosticsSnapshot {
  rtcAvailable: boolean;
  mediaApiAvailable: boolean;
  microphonePermission: MicPermissionState;
  microphoneDetected: boolean;
  microphoneTrackLive: boolean;
  outputDetected: boolean | null;
  inputDeviceLabel?: string;
  outputDeviceLabel?: string;
  selectedInputUnavailable: boolean;
  selectedOutputUnavailable: boolean;
  inVoice: boolean;
  signalingConnected: boolean | null;
  peerCount: number;
  connectionState?: string;
  iceState?: string;
  latencyMs?: number;
  packetLossPercent?: number;
  /**
   * Faz K2 — tarayicinin mikrofona GERCEKTEN uyguladigi ayarlar.
   * Istenen kisitlamalar (webrtc.ts) degistirilmedi; burada yalnizca
   * `MediaStreamTrack.getSettings()` ciktisi raporlanir.
   */
  appliedAudio: AppliedAudioSettings;
  /**
   * `appliedAudio` NEREDEN olculdu?
   *   'call'     — canli arama track'i (kesin)
   *   'mic-test' — mikrofon testi track'i (VEKIL; arama kisitlariyla alinir)
   *   'none'     — olcum yok
   */
  appliedAudioSource: AppliedAudioSource;
  /** Faz K2 — gercek `getStats()` olcumlerinden turetilen baglanti kalitesi. */
  connectionQuality: VoiceConnectionQuality;
}

function safeLabel(device: MediaDeviceInfo | undefined, fallback: string): string | undefined {
  if (!device) return undefined;
  const label = String(device.label ?? '').trim();
  return label || fallback;
}

async function microphonePermission(): Promise<MicPermissionState> {
  if (!navigator.permissions?.query) return 'unsupported';
  try {
    const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
    return status.state === 'granted' || status.state === 'denied' || status.state === 'prompt'
      ? status.state : 'unknown';
  } catch {
    return 'unsupported';
  }
}

function stateBySeverity(states: Array<string | undefined>, order: string[]): string | undefined {
  const known = states.filter((value): value is string => Boolean(value));
  return order.find(value => known.includes(value)) ?? known[0];
}

function peerConnections(rtc: RtcLike): RTCPeerConnection[] {
  const unique = new Set<RTCPeerConnection>();
  for (const connection of rtc.peers?.values?.() ?? []) unique.add(connection);
  for (const connection of rtc._p2pPeers?.values?.() ?? []) unique.add(connection);
  return [...unique];
}

async function measuredNetworkStats(peers: RTCPeerConnection[]): Promise<{
  latencyMs?: number; packetLossPercent?: number;
}> {
  const latencies: number[] = [];
  let packetsLost = 0;
  let packetsReceived = 0;

  await Promise.all(peers.map(async peer => {
    try {
      const reports = await peer.getStats();
      reports.forEach(report => {
        const row = report as RTCStats & Record<string, unknown>;
        if (row.type === 'candidate-pair' && row.state === 'succeeded'
          && (row.nominated === true || row.selected === true)) {
          const seconds = Number(row.currentRoundTripTime);
          if (Number.isFinite(seconds) && seconds >= 0) latencies.push(seconds * 1000);
        }
        if (row.type === 'remote-inbound-rtp') {
          const seconds = Number(row.roundTripTime);
          if (Number.isFinite(seconds) && seconds >= 0) latencies.push(seconds * 1000);
        }
        if (row.type === 'inbound-rtp') {
          const lost = Number(row.packetsLost);
          const received = Number(row.packetsReceived);
          if (Number.isFinite(lost) && lost > 0) packetsLost += lost;
          if (Number.isFinite(received) && received > 0) packetsReceived += received;
        }
      });
    } catch {
      // Stats are optional browser telemetry. Absence is rendered as absence,
      // never converted into an invented zero.
    }
  }));

  const latencyMs = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : undefined;
  const packetTotal = packetsLost + packetsReceived;
  const packetLossPercent = packetTotal > 0
    ? Math.round((packetsLost / packetTotal) * 1000) / 10
    : undefined;
  return { ...(latencyMs !== undefined ? { latencyMs } : {}), ...(packetLossPercent !== undefined ? { packetLossPercent } : {}) };
}

/**
 * @param fallbackStream Arama DISINDA olcum yapabilmek icin kullanilan yedek
 *   ses akisi (mikrofon testi). Kanonik arama track'i VARSA o tercih edilir;
 *   yedek yalnizca hicbir arama track'i yokken devreye girer.
 *
 *   NEDEN GEREKLI: `appliedAudio` yalnizca canli bir track'ten okunabilir.
 *   Arama disinda tum alanlar `unknown` donuyordu, yani "yanki giderme
 *   gercekten uygulaniyor mu" sorusu ANCAK iki kisilik bir arama sirasinda
 *   yanitlanabiliyordu. Oysa bu sorunun yanitini tek kisi de alabilir.
 */
export async function collectVoiceDiagnostics(
  rawRtc: unknown,
  fallbackStream?: MediaStream | null,
): Promise<VoiceDiagnosticsSnapshot> {
  const rtc = rawRtc && typeof rawRtc === 'object' ? rawRtc as RtcLike : null;
  const mediaApiAvailable = typeof navigator.mediaDevices?.enumerateDevices === 'function'
    && typeof navigator.mediaDevices?.getUserMedia === 'function';
  const permission = await microphonePermission();

  let inputs: MediaDeviceInfo[] = [];
  let outputs: MediaDeviceInfo[] = [];
  if (mediaApiAvailable) {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      inputs = devices.filter(device => device.kind === 'audioinput');
      outputs = devices.filter(device => device.kind === 'audiooutput');
    } catch {
      // Enumeration may be blocked by browser policy. Unknown is not missing.
    }
  }

  const selectedInput = rtc?.selectedMicId
    ? inputs.find(device => device.deviceId === rtc.selectedMicId) : inputs.find(device => device.deviceId === 'default') ?? inputs[0];
  const selectedOutput = rtc?.selectedSpeakerId
    ? outputs.find(device => device.deviceId === rtc.selectedSpeakerId) : outputs.find(device => device.deviceId === 'default') ?? outputs[0];
  const selectedInputUnavailable = Boolean(rtc?.selectedMicId && !selectedInput);
  const selectedOutputUnavailable = Boolean(rtc?.selectedSpeakerId && !selectedOutput);

  const callStream = rtc?.getLocalStream?.() ?? rtc?.localStream ?? null;
  const callTrackLive = callStream?.getAudioTracks?.().some(t => t.readyState === 'live') ?? false;
  // Kanonik arama track'i ONCELIKLIDIR; yedek yalnizca o yokken kullanilir.
  const measuredStream = callTrackLive ? callStream : (fallbackStream ?? callStream);
  const localStream = callStream;
  // Uygulanan ses ayarlari canli track'ten okunur; track yoksa "bilinmiyor".
  const appliedAudio = measuredStream
    ? readAppliedAudioSettings(measuredStream) : unknownAudioSettings(false);
  // Olcumun NEREDEN geldigi rapora girer: mikrofon testi bir VEKILDIR,
  // arama track'i degildir. Ikisini karistirmak teshisi yaniltir.
  const appliedAudioSource: AppliedAudioSource = callTrackLive
    ? 'call' : (fallbackStream ? 'mic-test' : 'none');
  const audioTrack = localStream?.getAudioTracks?.()[0];
  const microphoneTrackLive = Boolean(audioTrack && audioTrack.readyState === 'live');
  const inVoice = Boolean(rtc?.isInVoice?.() ?? rtc?.currentChannelId);
  const peers = rtc ? peerConnections(rtc) : [];
  const transportStates = [rtc?.sendTransport?.connectionState, rtc?.recvTransport?.connectionState];
  const connectionState = stateBySeverity(
    [...peers.map(peer => peer.connectionState), ...transportStates],
    ['failed', 'disconnected', 'connecting', 'new', 'connected', 'closed'],
  );
  const iceState = stateBySeverity(
    peers.map(peer => peer.iceConnectionState),
    ['failed', 'disconnected', 'checking', 'new', 'connected', 'completed', 'closed'],
  );
  const network = await measuredNetworkStats(peers);
  // Faz K2 — jitter + paket sayaclari + siniflandirma; olcum yoksa unknown.
  const connectionQuality = peers.length ? await collectConnectionQuality(peers) : unknownConnectionQuality();

  const canEnumerateOutput = typeof HTMLMediaElement !== 'undefined'
    && 'setSinkId' in HTMLMediaElement.prototype;

  return {
    appliedAudio,
    appliedAudioSource,
    connectionQuality,
    rtcAvailable: Boolean(rtc),
    mediaApiAvailable,
    microphonePermission: permission,
    microphoneDetected: permission !== 'denied' && inputs.length > 0,
    microphoneTrackLive,
    // Some browsers intentionally do not expose audio outputs. In that case
    // report unknown (null), not the false claim "no output device".
    outputDetected: canEnumerateOutput ? outputs.length > 0 : null,
    ...(safeLabel(selectedInput, t('voice_default_microphone')) ? { inputDeviceLabel: safeLabel(selectedInput, t('voice_default_microphone')) } : {}),
    ...(safeLabel(selectedOutput, t('voice_default_output')) ? { outputDeviceLabel: safeLabel(selectedOutput, t('voice_default_output')) } : {}),
    selectedInputUnavailable,
    selectedOutputUnavailable,
    inVoice,
    signalingConnected: typeof rtc?.socket?.connected === 'boolean' ? rtc.socket.connected : null,
    peerCount: peers.length,
    ...(connectionState ? { connectionState } : {}),
    ...(iceState ? { iceState } : {}),
    ...network,
  };
}
