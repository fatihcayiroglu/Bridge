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
  watchStalledVideo, isStalled, TICK_MS, STALL_MS, REPROBE_INTERVAL_MS, PROBE_CAP_BPS, CAP_HOLD_MS,
  type ReprobeConsumer, type ReprobeTransport,
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

  it('keeps re-probing at REPROBE_INTERVAL_MS while stalled, and stops once video flows', async () => {
    const t = transport();
    let consumer = stalled();
    const stop = watchStalledVideo(t, () => [consumer], () => true);
    await advance(STALL_MS + TICK_MS + 2 * REPROBE_INTERVAL_MS);
    const probes = t.setMaxOutgoingBitrate.mock.calls.filter(([b]) => b === PROBE_CAP_BPS).length;
    expect(probes).toBe(3);
    consumer = healthy();
    t.setMaxOutgoingBitrate.mockClear();
    await advance(60_000);
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

  it('a rejected cap is logged, not thrown, and retried on the next interval', async () => {
    const t = transport();
    t.setMaxOutgoingBitrate.mockRejectedValueOnce(new Error('transport closed'));
    const stop = watchStalledVideo(t, () => [stalled()], () => true);
    await advance(STALL_MS + TICK_MS);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledTimes(1);
    await advance(REPROBE_INTERVAL_MS);
    expect(t.setMaxOutgoingBitrate).toHaveBeenCalledWith(PROBE_CAP_BPS);
    expect(t.setMaxOutgoingBitrate.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });

  it('is inert for a transport without setMaxOutgoingBitrate', async () => {
    const t = { id: 'old', closed: false } as ReprobeTransport;
    const stop = watchStalledVideo(t, () => [stalled()], () => true);
    await advance(60_000);
    stop();
  });
});
