// server/socket/handlers/mediasoup/bweReprobe.ts
//
// Re-probes a receive transport whose bandwidth estimate got stuck below every
// simulcast layer (MEDIA-11, docs/MEDIA_RELIABILITY.md).
//
// After heavy downlink congestion mediasoup's estimate towards a receiver can
// fall to its floor (30 kbit/s). No simulcast layer fits, so no video is sent,
// and nothing else feeds the estimator: mediasoup requests no transport-wide
// congestion feedback on the audio it forwards (transport-wide-cc is
// `recvonly` for audio), and libwebrtc only probes when the allocated maximum
// changes — which it does not while the desired bitrate stays constant. The
// video then never comes back, however healthy the link becomes (measured:
// > 90 s, until the session was re-established for another reason).
//
// While a simulcast consumer has been stalled for STALL_MS, this briefly caps
// the transport's outgoing bitrate and lifts the cap again: each change of the
// allocated maximum makes libwebrtc send a short probe cluster, whose feedback
// moves the estimate to what the link really carries.
//
// On a link that really is narrow a probe costs audio: it lifts the estimate
// just enough for the lowest video layer, which the link cannot carry next to
// the audio, until the estimator backs off again (lab, 150 kbit/s: audio
// concealment 0 % → 9-10 % with probes every 8-16 s). So the probe's outcome
// sets the pace: a probe after which no video flowed was cheap (the link is
// still congested) and is repeated after 8, 16, then every 30 s; a probe that
// let video through which then stalled again marks a narrow link — the next
// one waits 60 s, doubling up to 5 min. Video that flows steadily for
// HEALTHY_RESET_MS resets both.

import logger from '../../../lib/logger';

export const TICK_MS = 2_000;
/** A consumer must be stalled this long before the first probe. */
export const STALL_MS = 6_000;
/** After a probe that let no video through: 8 s, doubling ... */
export const REPROBE_INTERVAL_MS = 8_000;
/** ... up to this. */
export const MAX_REPROBE_INTERVAL_MS = 30_000;
/** Video that resumed after a probe and stalled again within this window
 *  marks a narrow link ... */
export const FLAP_WINDOW_MS = 30_000;
/** ... after which the next probe waits this long, doubling ... */
export const NARROW_BACKOFF_MS = 60_000;
/** ... up to this. */
export const MAX_NARROW_BACKOFF_MS = 300_000;
/** Video must flow this long before probing starts again at full pace. */
export const HEALTHY_RESET_MS = 20_000;
/** Temporary cap: below the smallest allocated maximum mediasoup uses
 *  (initialAvailableOutgoingBitrate, 800 kbit/s), so setting it always changes
 *  the maximum, and far above the 30 kbit/s floor, so a probe is allowed. */
export const PROBE_CAP_BPS = 600_000;
export const CAP_HOLD_MS = 2_000;
/** Bridge sets no outgoing cap on its transports; 0 = unlimited. */
const NO_CAP = 0;

export interface ReprobeConsumer {
  type: string;
  closed?: boolean;
  paused?: boolean;
  producerPaused?: boolean;
  currentLayers?: unknown;
  score?: { producerScore?: number; producerScores?: number[] };
}

export interface ReprobeTransport {
  id: string;
  closed?: boolean;
  setMaxOutgoingBitrate?(bitrate: number): Promise<void>;
}

/** Video the SFU would forward (producer sending, nobody paused) but for which
 *  the bandwidth estimate selects no layer. `producerScore` cannot say whether
 *  the producer is sending: mediasoup takes it from the stream currently
 *  forwarded, so it is 0 exactly while no layer is selected. `producerScores`
 *  holds every producer stream's score. */
export function isStalled(consumer: ReprobeConsumer): boolean {
  return (consumer.type === 'simulcast' || consumer.type === 'svc')
    && !consumer.closed && !consumer.paused && !consumer.producerPaused
    && !consumer.currentLayers
    && (consumer.score?.producerScores ?? []).some((score) => score > 0);
}

/**
 * Watches one receive transport. `consumers` returns the transport's current
 * consumers; `isCurrent` is false once the transport was replaced. Returns a
 * function that stops the watch (it also stops by itself when the transport
 * closes or is replaced).
 */
export function watchStalledVideo(
  transport: ReprobeTransport,
  consumers: () => Iterable<ReprobeConsumer>,
  isCurrent: () => boolean,
  now: () => number = Date.now,
): () => void {
  if (typeof transport.setMaxOutgoingBitrate !== 'function') return () => {};
  let stalledSince: number | null = null;
  let healthySince: number | null = null;
  let lastProbeAt = -Infinity;
  let nextInterval = REPROBE_INTERVAL_MS;
  let probesSinceHealthy = 0;
  let videoAfterProbe = false;
  let narrow = false;
  let capTimer: ReturnType<typeof setTimeout> | null = null;

  const uncap = (): void => {
    if (transport.closed) return;
    transport.setMaxOutgoingBitrate!(NO_CAP).catch((err: Error) => {
      logger.warn({ transportId: transport.id, err: err.message, event: 'sfu.bwe.uncap_failed' }, '[SFU] Could not lift the re-probe cap.');
    });
  };

  const stop = (): void => {
    clearInterval(interval);
    if (capTimer) { clearTimeout(capTimer); capTimer = null; uncap(); }
  };

  const tick = async (): Promise<void> => {
    if (transport.closed || !isCurrent()) { stop(); return; }
    const t = now();
    if (![...consumers()].some(isStalled)) {
      if (t - lastProbeAt <= FLAP_WINDOW_MS) videoAfterProbe = true;
      stalledSince = null;
      healthySince ??= t;
      if (t - healthySince >= HEALTHY_RESET_MS) {
        nextInterval = REPROBE_INTERVAL_MS; probesSinceHealthy = 0; videoAfterProbe = false; narrow = false;
      }
      return;
    }
    healthySince = null;
    if (videoAfterProbe) {
      // The last probe let video through and it stalled again: a narrow link.
      videoAfterProbe = false;
      nextInterval = narrow ? Math.min(nextInterval * 2, MAX_NARROW_BACKOFF_MS) : NARROW_BACKOFF_MS;
      narrow = true;
    }
    stalledSince ??= t;
    if (t - stalledSince < STALL_MS || capTimer) return;
    if (probesSinceHealthy > 0 && t - lastProbeAt < nextInterval) return;
    if (probesSinceHealthy > 0 && !narrow) nextInterval = Math.min(nextInterval * 2, MAX_REPROBE_INTERVAL_MS);
    lastProbeAt = t;
    const first = probesSinceHealthy++ === 0;
    try {
      await transport.setMaxOutgoingBitrate!(PROBE_CAP_BPS);
    } catch (err) {
      logger.warn({ transportId: transport.id, err: (err as Error).message, event: 'sfu.bwe.reprobe_failed' }, '[SFU] Bandwidth re-probe failed.');
      return;
    }
    // One line per stall at info; the repeats of a long stall at debug.
    logger[first ? 'info' : 'debug'](
      { transportId: transport.id, stalledMs: t - stalledSince, event: 'sfu.bwe.reprobe' },
      '[SFU] Stalled video: re-probing the receive bandwidth.');
    capTimer = setTimeout(() => { capTimer = null; uncap(); }, CAP_HOLD_MS);
    capTimer.unref?.();
  };

  const interval = setInterval(() => { void tick(); }, TICK_MS);
  interval.unref?.();
  return stop;
}
