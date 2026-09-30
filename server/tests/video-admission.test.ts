// server/tests/video-admission.test.ts
//
// Audio-first video admission (MEDIA-11). A model downlink stands in for
// mediasoup: the estimate only moves with video traffic or a probe (mediasoup
// requests no congestion feedback on forwarded audio), and a probe measures
// what the link carries. Each scenario is one of the P3 acceptance cases:
//   A/D1 narrow persistent link  — video held, audio kept, never resumed, probes bounded
//   B/D2 transient squeeze       — the floor deadlock ends after the link clears
//   D3   active decoded frames   — healthy video is never touched
//   D4   negative controls       — foreign pauses, deferred resumes, shutdown

jest.mock('../lib/logger', () => ({ __esModule: true, default: { info: jest.fn(), warn: jest.fn(), debug: jest.fn(), error: jest.fn() } }));

import {
  watchVideoAdmission, videoNeedBps, AUDIO_RESERVE_BPS, LOWEST_VIDEO_BPS, RESUME_MARGIN,
  HOLD_AFTER_MS, PROBE_MAX_INTERVAL_MS, PROBE_FIRST_MS,
  type AdmissionConsumer, type AdmissionTransport,
} from '../socket/handlers/mediasoup/videoAdmission';

type FakeConsumer = AdmissionConsumer & { keyFrames: number };

function consumer(id: string, kind: 'audio' | 'video', type = kind === 'video' ? 'simulcast' : 'simple', paused = false): FakeConsumer {
  const c: FakeConsumer = {
    id, kind, type, paused, producerPaused: false, closed: false, keyFrames: 0,
    async pause() { c.paused = true; },
    async resume() { c.paused = false; },
    async requestKeyFrame() { c.keyFrames += 1; },
  };
  return c;
}

/** Downlink model. `link` is what the path carries; `estimate` what mediasoup believes. */
function downlink(initialBps: number, probing = true) {
  const state = { link: initialBps, estimate: initialBps, statsCalls: 0, probes: 0 };
  const transport: AdmissionTransport = {
    id: 't1', closed: false,
    async getStats() { state.statsCalls += 1; return [{ availableOutgoingBitrate: state.estimate }]; },
    ...(probing ? {
      async setMaxOutgoingBitrate(bps: number) {
        // Changing the allocated maximum makes libwebrtc probe: the estimate
        // moves to what the link carries.
        if (bps > 0) { state.probes += 1; state.estimate = state.link; }
      },
    } : {}),
  };
  return { state, transport };
}

const tickFor = (ms: number) => jest.advanceTimersByTimeAsync(ms);

beforeEach(() => { jest.useFakeTimers({ now: 1_000_000 }); });
afterEach(() => { jest.useRealTimers(); });

describe('videoNeedBps', () => {
  it('reserves every forwarded audio stream plus the lowest video layer', () => {
    const list = [consumer('a1', 'audio'), consumer('a2', 'audio'), consumer('v1', 'video')];
    expect(videoNeedBps(list)).toBe(2 * AUDIO_RESERVE_BPS + LOWEST_VIDEO_BPS);
  });
  it('does not reserve audio that is not being forwarded', () => {
    const muted = consumer('a2', 'audio'); muted.producerPaused = true;
    const paused = consumer('a3', 'audio', 'simple', true);
    expect(videoNeedBps([consumer('a1', 'audio'), muted, paused])).toBe(AUDIO_RESERVE_BPS + LOWEST_VIDEO_BPS);
  });
});

describe('A / D1 — narrow persistent link (150 kbit/s)', () => {
  it('holds video, keeps it off for five minutes and probes a bounded number of times', async () => {
    const { state, transport } = downlink(900_000);
    const audio = consumer('a1', 'audio');
    const video = consumer('v1', 'video');
    const admission = watchVideoAdmission(transport, () => [audio, video], () => true);

    await tickFor(5_000);
    expect(admission.isHeld()).toBe(false);

    // The link narrows; with video flowing the estimate follows it.
    state.link = 150_000; state.estimate = 150_000;
    await tickFor(HOLD_AFTER_MS + 2_000);
    expect(admission.isHeld()).toBe(true);
    expect(video.paused).toBe(true);
    expect(audio.paused).toBe(false);

    await tickFor(5 * 60_000);
    // 150 kbit/s < (90 + 50) × 1.3: video stays held — audio keeps the link.
    expect(video.paused).toBe(true);
    expect(admission.isHeld()).toBe(true);
    // Doubling interval capped at 30 s: 3 + 6 + 12 + 24 s, then every 30 s.
    const maxProbes = 4 + Math.ceil((5 * 60_000 - (3 + 6 + 12 + 24) * 1_000) / PROBE_MAX_INTERVAL_MS) + 1;
    expect(admission.probeCount()).toBeGreaterThanOrEqual(4);
    expect(admission.probeCount()).toBeLessThanOrEqual(maxProbes);
    admission.stop();
  });
});

describe('B / D2 — transient squeeze that leaves the estimate at the floor', () => {
  async function squeezeThenClear(probing: boolean) {
    const { state, transport } = downlink(900_000, probing);
    const audio = consumer('a1', 'audio');
    const video = consumer('v1', 'video');
    const admission = watchVideoAdmission(transport, () => [audio, video], () => true);
    await tickFor(3_000);
    state.link = 64_000; state.estimate = 30_000; // squeezed to the floor
    await tickFor(20_000);
    expect(video.paused).toBe(true);
    // The link clears; with no video and no feedback on audio nothing moves the
    // estimate except a probe.
    state.link = 2_000_000;
    const clearedAt = Date.now();
    let resumedAfter: number | null = null;
    for (let waited = 0; waited < 90_000 && resumedAfter === null; waited += 1_000) {
      await tickFor(1_000);
      if (!video.paused) resumedAfter = Date.now() - clearedAt;
    }
    admission.stop();
    return { resumedAfter, video, state };
  }

  it('video returns within one capped probe interval of the link clearing and asks for a key frame', async () => {
    const { resumedAfter, video } = await squeezeThenClear(true);
    expect(resumedAfter).not.toBeNull();
    expect(resumedAfter!).toBeLessThanOrEqual(PROBE_MAX_INTERVAL_MS + 5_000);
    expect(video.keyFrames).toBe(1);
  });

  it('NEGATIVE CONTROL: without re-probing the model reproduces the > 90 s deadlock', async () => {
    const { resumedAfter, state } = await squeezeThenClear(false);
    expect(resumedAfter).toBeNull();
    expect(state.estimate).toBe(30_000);
  });
});

describe('D3 — active decoded frames', () => {
  it('healthy video is never paused and never probed', async () => {
    const { state, transport } = downlink(900_000);
    const audio = consumer('a1', 'audio');
    const video = consumer('v1', 'video');
    const admission = watchVideoAdmission(transport, () => [audio, video], () => true);
    await tickFor(60_000);
    expect(video.paused).toBe(false);
    expect(admission.probeCount()).toBe(0);
    expect(state.probes).toBe(0);
    admission.stop();
  });

  it('a dip shorter than the hold delay does not interrupt video', async () => {
    const { state, transport } = downlink(900_000);
    const video = consumer('v1', 'video');
    const admission = watchVideoAdmission(transport, () => [consumer('a1', 'audio'), video], () => true);
    await tickFor(2_000);
    state.estimate = 100_000;
    await tickFor(HOLD_AFTER_MS - 2_000);
    state.estimate = 900_000;
    await tickFor(10_000);
    expect(video.paused).toBe(false);
    expect(admission.isHeld()).toBe(false);
    admission.stop();
  });

  it('screen share (a simple consumer) is not managed', async () => {
    const { state, transport } = downlink(40_000);
    const screen = consumer('s1', 'video', 'simple');
    const admission = watchVideoAdmission(transport, () => [consumer('a1', 'audio'), screen], () => true);
    await tickFor(30_000);
    expect(screen.paused).toBe(false);
    expect(state.probes).toBe(0);
    admission.stop();
  });
});

describe('D4 — negative controls', () => {
  it('a consumer the client never resumed is not resumed by admission', async () => {
    const { state, transport } = downlink(900_000);
    const flowing = consumer('v1', 'video');
    const notYetResumed = consumer('v2', 'video', 'simulcast', true);
    const admission = watchVideoAdmission(transport, () => [consumer('a1', 'audio'), flowing, notYetResumed], () => true);
    state.link = 100_000; state.estimate = 100_000;
    await tickFor(HOLD_AFTER_MS + 2_000);
    expect(flowing.paused).toBe(true);
    state.link = 2_000_000;
    await tickFor(PROBE_FIRST_MS + 5_000);
    expect(flowing.paused).toBe(false);
    expect(notYetResumed.paused).toBe(true);
    admission.stop();
  });

  it('a client resume during a hold is deferred and honoured when video is admitted', async () => {
    const { state, transport } = downlink(900_000);
    const flowing = consumer('v1', 'video');
    const late = consumer('v2', 'video', 'simulcast', true);
    const list = [consumer('a1', 'audio'), flowing];
    const admission = watchVideoAdmission(transport, () => list, () => true);
    state.link = 100_000; state.estimate = 100_000;
    await tickFor(HOLD_AFTER_MS + 2_000);
    list.push(late);
    expect(admission.requestResume(late)).toBe(false);
    expect(late.paused).toBe(true);
    // Audio is never deferred.
    expect(admission.requestResume(consumer('a2', 'audio'))).toBe(true);
    state.link = 2_000_000;
    await tickFor(PROBE_FIRST_MS + 5_000);
    expect(late.paused).toBe(false);
    expect(late.keyFrames).toBe(1);
    admission.stop();
  });

  it('resume needs the margin, not just the need', async () => {
    const { state, transport } = downlink(900_000);
    const video = consumer('v1', 'video');
    const admission = watchVideoAdmission(transport, () => [consumer('a1', 'audio'), video], () => true);
    state.link = 100_000; state.estimate = 100_000;
    await tickFor(HOLD_AFTER_MS + 2_000);
    const need = AUDIO_RESERVE_BPS + LOWEST_VIDEO_BPS;
    state.link = Math.floor(need * (RESUME_MARGIN - 0.05)); // above the need, below the margin
    await tickFor(60_000);
    expect(video.paused).toBe(true);
    admission.stop();
  });

  it('stops polling when the transport closes or is replaced', async () => {
    const { state, transport } = downlink(900_000);
    let current = true;
    const admission = watchVideoAdmission(transport, () => [consumer('a1', 'audio'), consumer('v1', 'video')], () => current);
    await tickFor(3_000);
    const calls = state.statsCalls;
    current = false;
    await tickFor(10_000);
    expect(state.statsCalls).toBe(calls);
    expect(admission.isHeld()).toBe(false);
  });

  it('a transport without stats is left alone', async () => {
    const video = consumer('v1', 'video');
    const admission = watchVideoAdmission({ id: 't2' }, () => [consumer('a1', 'audio'), video], () => true);
    await tickFor(30_000);
    expect(video.paused).toBe(false);
    expect(admission.probeCount()).toBe(0);
    admission.stop();
  });
});

describe('hold notifications', () => {
  it('tells the receiver when video is held and when it is admitted again', async () => {
    const { state, transport } = downlink(900_000);
    const changes: boolean[] = [];
    const admission = watchVideoAdmission(transport, () => [consumer('a1', 'audio'), consumer('v1', 'video')], () => true, Date.now, (held) => changes.push(held));
    state.link = 100_000; state.estimate = 100_000;
    await tickFor(HOLD_AFTER_MS + 2_000);
    expect(changes).toEqual([true]);
    state.link = 2_000_000;
    await tickFor(PROBE_FIRST_MS + 5_000);
    expect(changes).toEqual([true, false]);
    admission.stop();
  });
});
