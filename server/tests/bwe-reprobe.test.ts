// server/tests/bwe-reprobe.test.ts
//
// P2 media lab (MEDIA-11): after heavy downlink congestion mediasoup's
// estimate towards a receiver stayed at its 30 kbit/s floor, no simulcast
// layer was selected and the video never came back (> 90 s) although the link
// had recovered. The receive transport is now re-probed while a simulcast
// consumer stays stalled: a temporary outgoing cap, lifted again, changes the
// allocated maximum and makes libwebrtc probe.

jest.mock('../lib/logger', () => ({ __esModule: true, default: { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() } }));

import {
  watchStalledVideo, isStalled, TICK_MS, STALL_MS, REPROBE_INTERVAL_MS, MAX_REPROBE_INTERVAL_MS, HEALTHY_RESET_MS,
  PROBE_CAP_BPS, CAP_HOLD_MS, type ReprobeConsumer, type ReprobeTransport,
} from '../socket/handlers/mediasoup/bweReprobe';

const healthy = (over: Partial<ReprobeConsumer> = {}): ReprobeConsumer => ({
  type: 'simulcast', paused: false, producerPaused: false, closed: false,
  currentLayers: { spatialLayer: 1, temporalLayer: 2 }, score: { producerScore: 10, producerScores: [10, 10] }, ...over,
});
// What mediasoup reports for a stalled consumer: producerScore is the score of
// the stream currently forwarded — none — so 0, while producerScores shows the
// producer's streams are healthy.
const stalled = (over: Partial<ReprobeConsumer> = {}): ReprobeConsumer =>
  healthy({ currentLayers: undefined, score: { producerScore: 0, producerScores: [10, 10] }, ...over });

function transport(): ReprobeTransport & { setMaxOutgoingBitrate: jest.Mock } {
  return { id: 't1', closed: false, setMaxOutgoingBitrate: jest.fn(async () => {}) };
}

// Advances fake time tick by tick so the async tick body settles in between.
async function advance(ms: number): Promise<void> {
  for (let t = 0; t < ms; t += TICK_MS) {
    await jest.advanceTimersByTimeAsync(TICK_MS);
  }
}

describe('isStalled', () => {
  it('is a simulcast/svc consumer the SFU would forward but that has no layer', () => {
    expect(isStalled(stalled())).toBe(true);
    expect(isStalled(stalled({ type: 'svc' }))).toBe(true);
  });
  it('judges the producer by all its streams: producerScore is 0 whenever no layer is forwarded', () => {
    expect(isStalled(stalled({ score: { producerScore: 0, producerScores: [0, 7] } }))).toBe(true);
  });
  it('ignores consumers that have a layer, are paused, whose producer is paused or silent, closed, or not layered', () => {
    expect(isStalled(healthy())).toBe(false);
    expect(isStalled(stalled({ paused: true }))).toBe(false);
    expect(isStalled(stalled({ producerPaused: true }))).toBe(false);
    expect(isStalled(stalled({ score: { producerScore: 0, producerScores: [0, 0] } }))).toBe(false);
    expect(isStalled(stalled({ score: { producerScore: 0, producerScores: [] } }))).toBe(false);
    expect(isStalled(stalled({ score: undefined }))).toBe(false);
    expect(isStalled(stalled({ closed: true }))).toBe(false);
    expect(isStalled(stalled({ type: 'simple' }))).toBe(false);
  });
});

describe('watchStalledVideo', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); });

  it('does nothing while video flows', async () => {
    const t = transport();
    const stop = watchStalledVideo(t, () => [healthy()], () => true);
    await advance(60_000);
    expect(t.setMaxOutgoingBitrate).not.toHaveBeenCalled();
    stop();
  });

  it('re-probes a stalled consumer after STALL_MS: caps, then lifts the cap', async () => {
    const t = transport();
    const stop = watchStalledVideo(t, () => [stalled()], () => true);
    await advance(STALL_MS);
    expect(t.setMaxOutgoingBitrate).not.toHaveBeenCalled();
    await advance(TICK_MS);
    expect(t.setMaxOutgoingBitrate.mock.calls).toEqual([[PROBE_CAP_BPS]]);
    await advance(CAP_HOLD_MS);
    expect(t.setMaxOutgoingBitrate.mock.calls).toEqual([[PROBE_CAP_BPS], [0]]);
    stop();
  });

  // Probe times (ms since the watch started) for a consumer stalled throughout.
  async function probeTimes(consumerAt: (ms: number, probes: number[]) => ReprobeConsumer, totalMs: number): Promise<number[]> {
    const t = transport();
    let elapsed = 0;
    const times: number[] = [];
    t.setMaxOutgoingBitrate.mockImplementation(async (b: number) => { if (b === PROBE_CAP_BPS) times.push(elapsed); });
    const stop = watchStalledVideo(t, () => [consumerAt(elapsed, times)], () => true);
    for (; elapsed < totalMs;) { elapsed += TICK_MS; await jest.advanceTimersByTimeAsync(TICK_MS); }
    stop();
    return times;
  }

  it('backs off while the stall persists: 8, 16, then every 30 s (a narrow link is not probed every 8 s)', async () => {
    const times = await probeTimes(() => stalled(), 130_000);
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    expect(times[0]).toBe(STALL_MS + TICK_MS);
    expect(gaps.slice(0, 3)).toEqual([REPROBE_INTERVAL_MS, 2 * REPROBE_INTERVAL_MS, MAX_REPROBE_INTERVAL_MS]);
    expect(gaps.slice(2).every((g) => g === MAX_REPROBE_INTERVAL_MS)).toBe(true);
  });

  it('a brief recovery after a probe does not reset the backoff', async () => {
    // Stalled, except the tick right after each probe sees video — a narrow link
    // where the probe briefly lets the lowest layer through.
    const flickers: number[] = [];
    const times = await probeTimes((ms, probes) => {
      const last = probes[probes.length - 1];
      if (last !== undefined && ms - last > 0 && ms - last <= TICK_MS) { flickers.push(ms); return healthy(); }
      return stalled();
    }, 130_000);
    const gaps = times.slice(1).map((x, i) => x - times[i]);
    expect(flickers.length).toBeGreaterThan(0);
    // Each flicker restarts the stall clock, but never the backoff.
    expect(gaps[0]).toBeGreaterThanOrEqual(REPROBE_INTERVAL_MS);
    expect(gaps[1]).toBeGreaterThanOrEqual(2 * REPROBE_INTERVAL_MS);
    expect(gaps.slice(2).every((g) => g >= MAX_REPROBE_INTERVAL_MS)).toBe(true);
  });

  it('video flowing for HEALTHY_RESET_MS restores the fast first probe', async () => {
    const t = transport();
    let consumer = stalled();
    const stop = watchStalledVideo(t, () => [consumer], () => true);
    await advance(STALL_MS + TICK_MS + REPROBE_INTERVAL_MS + 2 * REPROBE_INTERVAL_MS);
    expect(t.setMaxOutgoingBitrate.mock.calls.filter(([b]) => b === PROBE_CAP_BPS)).toHaveLength(3);
    consumer = healthy();
    await advance(HEALTHY_RESET_MS + TICK_MS);
    t.setMaxOutgoingBitrate.mockClear();
    consumer = stalled();
    await advance(STALL_MS + TICK_MS);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledWith(PROBE_CAP_BPS);
    await advance(REPROBE_INTERVAL_MS);
    expect(t.setMaxOutgoingBitrate.mock.calls.filter(([b]) => b === PROBE_CAP_BPS)).toHaveLength(2);
    stop();
  });

  it('stops probing once video flows', async () => {
    const t = transport();
    let consumer = stalled();
    const stop = watchStalledVideo(t, () => [consumer], () => true);
    await advance(STALL_MS + TICK_MS);
    consumer = healthy();
    t.setMaxOutgoingBitrate.mockClear();
    await advance(120_000);
    expect(t.setMaxOutgoingBitrate.mock.calls.filter(([b]) => b === PROBE_CAP_BPS)).toHaveLength(0);
    stop();
  });

  it('needs a continuous stall: a consumer that recovers restarts the clock', async () => {
    const t = transport();
    let consumer = stalled();
    const stop = watchStalledVideo(t, () => [consumer], () => true);
    await advance(STALL_MS - TICK_MS);
    consumer = healthy();
    await advance(TICK_MS);
    consumer = stalled();
    await advance(STALL_MS - TICK_MS);
    expect(t.setMaxOutgoingBitrate).not.toHaveBeenCalled();
    stop();
  });

  it('one stalled consumer among healthy ones is enough', async () => {
    const t = transport();
    const stop = watchStalledVideo(t, () => [healthy(), stalled(), healthy({ type: 'simple' })], () => true);
    await advance(STALL_MS + TICK_MS);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledWith(PROBE_CAP_BPS);
    stop();
  });

  it('stops by itself when the transport closes or is replaced', async () => {
    const closing = transport();
    watchStalledVideo(closing, () => [stalled()], () => true);
    closing.closed = true;
    await advance(60_000);
    expect(closing.setMaxOutgoingBitrate).not.toHaveBeenCalled();

    const replaced = transport();
    let current = true;
    watchStalledVideo(replaced, () => [stalled()], () => current);
    current = false;
    await advance(60_000);
    expect(replaced.setMaxOutgoingBitrate).not.toHaveBeenCalled();
  });

  it('stop() during a probe lifts the cap at once', async () => {
    const t = transport();
    const stop = watchStalledVideo(t, () => [stalled()], () => true);
    await advance(STALL_MS + TICK_MS);
    expect(t.setMaxOutgoingBitrate.mock.calls).toEqual([[PROBE_CAP_BPS]]);
    stop();
    await Promise.resolve();
    expect(t.setMaxOutgoingBitrate.mock.calls).toEqual([[PROBE_CAP_BPS], [0]]);
    await advance(60_000);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledTimes(2);
  });

  it('a rejected cap is logged, not thrown, and retried after the backoff interval', async () => {
    const t = transport();
    t.setMaxOutgoingBitrate.mockRejectedValueOnce(new Error('transport closed'));
    const stop = watchStalledVideo(t, () => [stalled()], () => true);
    await advance(STALL_MS + TICK_MS);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledTimes(1);
    await advance(REPROBE_INTERVAL_MS - TICK_MS);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledTimes(1);
    await advance(TICK_MS);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledTimes(2);
    stop();
  });

  it('is inert for a transport without setMaxOutgoingBitrate', async () => {
    const t = { id: 'old', closed: false } as ReprobeTransport;
    const stop = watchStalledVideo(t, () => [stalled()], () => true);
    await advance(60_000);
    stop();
  });
});
