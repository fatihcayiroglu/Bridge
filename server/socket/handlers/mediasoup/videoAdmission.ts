// server/socket/handlers/mediasoup/videoAdmission.ts
//
// Audio-first video admission for one receive transport (MEDIA-11,
// docs/MEDIA_RELIABILITY.md).
//
// Two measured problems, one mechanism:
//
// 1. After heavy downlink congestion mediasoup's bandwidth estimate towards a
//    receiver can sit at its 30 kbit/s floor. No simulcast layer fits, so no
//    video is sent, and nothing feeds the estimator again: mediasoup requests
//    no transport-wide congestion feedback on the audio it forwards, and
//    libwebrtc only probes when the allocated maximum changes. Video stayed off
//    for > 90 s on a healthy link.
// 2. Re-probing alone (P2 prototype) cured that but cost audio on links that
//    stay narrow: the recovered estimate was just high enough for the lowest
//    video layer, which the link could not carry next to the audio — mediasoup's
//    layer selection reserves nothing for audio (150 kbit/s: audio concealment
//    0–0.8 % → 6.6–10.6 %).
//
// So video is ADMITTED only while the estimate covers the audio this transport
// forwards plus the lowest video layer. Below that for HOLD_AFTER_MS the camera
// consumers are paused here ("held"): the link carries audio only. While held,
// the transport is re-probed — each change of the allocated maximum makes
// libwebrtc send a short probe cluster — with a doubling interval, so a link
// that stays narrow sees a bounded number of tiny probes and keeps its audio
// clean, and a link that recovered gets its video back after the next probe.
// Video resumes only above the need plus a margin, held for RESUME_AFTER_MS,
// and asks the sender for a key frame.
//
// Scope: simulcast/SVC (camera) consumers, the ones mediasoup's layer selection
// manages. Consumers paused for any other reason — not yet resumed by the
// client, or their producer paused — are never resumed here.

import logger from '../../../lib/logger';

export const TICK_MS = 1_000;
/** Wire rate reserved per forwarded audio stream (Opus ~64 kbit/s + RTP/SRTP/UDP/IP overhead). */
export const AUDIO_RESERVE_BPS = 90_000;
/** What the lowest camera layer needs on the wire. Its average was measured at
 *  25–44 kbit/s, but key frames and layer switches burst well above that: on a
 *  150 kbit/s link audio + that layer (≈ 130 kbit/s average) cost 6.6–10.6 %
 *  audio concealment (P2). With one audio stream the hold threshold is
 *  170 kbit/s and video resumes at ≥ 221 kbit/s. */
export const LOWEST_VIDEO_BPS = 80_000;
/** Resume only above need × RESUME_MARGIN — hysteresis against flapping. */
export const RESUME_MARGIN = 1.3;
/** The estimate must stay below the need this long before video is held. */
export const HOLD_AFTER_MS = 4_000;
/** …and above need × margin this long before video is resumed. */
export const RESUME_AFTER_MS = 2_000;
/** First re-probe after a hold, doubling to PROBE_MAX_INTERVAL_MS while held. */
export const PROBE_FIRST_MS = 3_000;
export const PROBE_MAX_INTERVAL_MS = 30_000;
/** Temporary outgoing cap: below the 800 kbit/s allocated maximum mediasoup
 *  uses when nothing is desired, so setting it always changes the maximum. */
export const PROBE_CAP_BPS = 600_000;
export const CAP_HOLD_MS = 1_000;
/** Bridge sets no outgoing cap on its transports; 0 = unlimited. */
const NO_CAP = 0;

export interface AdmissionConsumer {
  id: string;
  kind: 'audio' | 'video';
  type: string;
  closed?: boolean;
  paused?: boolean;
  producerPaused?: boolean;
  pause?(): Promise<void>;
  resume(): Promise<void>;
  requestKeyFrame?(): Promise<void>;
}

export interface AdmissionTransport {
  id: string;
  closed?: boolean;
  getStats?(): Promise<Array<{ availableOutgoingBitrate?: number }>>;
  setMaxOutgoingBitrate?(bitrate: number): Promise<void>;
}

export interface VideoAdmission {
  /** The client asked to resume this consumer. Returns false while video is
   *  held: the consumer is resumed when video is admitted again. */
  requestResume(consumer: AdmissionConsumer): boolean;
  /** Whether video is currently held for this transport (for tests and logs). */
  isHeld(): boolean;
  /** Probes sent since the watch started. */
  probeCount(): number;
  stop(): void;
}

const managed = (c: AdmissionConsumer): boolean =>
  c.kind === 'video' && (c.type === 'simulcast' || c.type === 'svc') && !c.closed;

/** Bitrate this transport must carry before any camera video is worth sending. */
export function videoNeedBps(consumers: Iterable<AdmissionConsumer>): number {
  let audio = 0;
  for (const c of consumers) {
    if (c.kind === 'audio' && !c.closed && !c.paused && !c.producerPaused) audio += 1;
  }
  return audio * AUDIO_RESERVE_BPS + LOWEST_VIDEO_BPS;
}

/**
 * Watches one receive transport. `consumers` returns its current consumers;
 * `isCurrent` turns false once the transport was replaced. The watch stops by
 * itself when the transport closes or is replaced.
 */
export function watchVideoAdmission(
  transport: AdmissionTransport,
  consumers: () => Iterable<AdmissionConsumer>,
  isCurrent: () => boolean,
  now: () => number = Date.now,
  /** Told when video is held (true) or admitted again (false) — the client shows why video stopped. */
  onChange?: (held: boolean) => void,
): VideoAdmission {
  let held = false;
  let belowSince: number | null = null;
  let aboveSince: number | null = null;
  let nextProbeAt = 0;
  let probeInterval = PROBE_FIRST_MS;
  let probes = 0;
  let capTimer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  let busy = false;
  /** Consumers WE paused, or whose client resume we deferred. Only these are resumed here. */
  const heldIds = new Set<string>();

  const canProbe = typeof transport.setMaxOutgoingBitrate === 'function';
  const canMeasure = typeof transport.getStats === 'function';

  const uncap = (): void => {
    if (transport.closed || !canProbe) return;
    transport.setMaxOutgoingBitrate!(NO_CAP).catch((err: Error) => {
      logger.warn({ transportId: transport.id, err: err.message, event: 'sfu.admission.uncap_failed' }, '[SFU] Could not lift the re-probe cap.');
    });
  };

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    clearInterval(interval);
    if (capTimer) { clearTimeout(capTimer); capTimer = null; uncap(); }
  };

  const estimate = async (): Promise<number | null> => {
    if (!canMeasure) return null;
    try {
      const stats = await transport.getStats!();
      const value = stats.find((s) => typeof s.availableOutgoingBitrate === 'number')?.availableOutgoingBitrate;
      return typeof value === 'number' && Number.isFinite(value) ? value : null;
    } catch {
      return null;
    }
  };

  const hold = async (bps: number, need: number): Promise<void> => {
    held = true;
    aboveSince = null;
    probeInterval = PROBE_FIRST_MS;
    nextProbeAt = now() + PROBE_FIRST_MS;
    for (const c of consumers()) {
      if (!managed(c) || c.paused || !c.pause) continue;
      heldIds.add(c.id);
      await c.pause().catch(() => undefined);
    }
    logger.info({ transportId: transport.id, estimateBps: bps, needBps: need, event: 'sfu.admission.hold' },
      '[SFU] Downlink estimate below audio + lowest video layer: video held, audio kept.');
    onChange?.(true);
  };

  const admit = async (bps: number, need: number): Promise<void> => {
    held = false;
    belowSince = null;
    for (const c of consumers()) {
      if (!managed(c) || !heldIds.has(c.id)) continue;
      heldIds.delete(c.id);
      await c.resume().catch(() => undefined);
      await c.requestKeyFrame?.().catch(() => undefined);
    }
    heldIds.clear();
    logger.info({ transportId: transport.id, estimateBps: bps, needBps: need, probes, event: 'sfu.admission.resume' },
      '[SFU] Downlink estimate covers audio + video again: video resumed.');
    onChange?.(false);
  };

  const probe = async (t: number): Promise<void> => {
    if (!canProbe || capTimer) return;
    nextProbeAt = t + probeInterval;
    probeInterval = Math.min(probeInterval * 2, PROBE_MAX_INTERVAL_MS);
    try {
      await transport.setMaxOutgoingBitrate!(PROBE_CAP_BPS);
    } catch (err) {
      logger.warn({ transportId: transport.id, err: (err as Error).message, event: 'sfu.admission.probe_failed' }, '[SFU] Bandwidth re-probe failed.');
      return;
    }
    probes += 1;
    logger.debug({ transportId: transport.id, probes, event: 'sfu.admission.probe' }, '[SFU] Re-probing the receive bandwidth while video is held.');
    capTimer = setTimeout(() => { capTimer = null; uncap(); }, CAP_HOLD_MS);
    capTimer.unref?.();
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (transport.closed || !isCurrent()) { stop(); return; }
    if (busy) return;
    busy = true;
    try {
      const list = [...consumers()];
      const video = list.filter(managed);
      if (!video.length) {
        // Nothing to admit: forget any hold so a new camera starts admitted.
        if (held) onChange?.(false);
        held = false; belowSince = null; aboveSince = null; heldIds.clear();
        return;
      }
      const bps = await estimate();
      if (bps === null || stopped) return;
      const need = videoNeedBps(list);
      const t = now();
      if (!held) {
        if (bps < need) {
          belowSince ??= t;
          if (t - belowSince >= HOLD_AFTER_MS) await hold(bps, need);
        } else {
          belowSince = null;
        }
        return;
      }
      if (bps >= need * RESUME_MARGIN) {
        aboveSince ??= t;
        if (t - aboveSince >= RESUME_AFTER_MS) { await admit(bps, need); return; }
      } else {
        aboveSince = null;
      }
      if (t >= nextProbeAt) await probe(t);
    } finally {
      busy = false;
    }
  };

  const interval = setInterval(() => { void tick(); }, TICK_MS);
  interval.unref?.();

  return {
    requestResume(consumer) {
      if (held && managed(consumer)) { heldIds.add(consumer.id); return false; }
      return true;
    },
    isHeld: () => held,
    probeCount: () => probes,
    stop,
  };
}
