// scripts/medialab/lib/analysis.test.mjs
//
// rates() differences two getStats() samples taken a few seconds apart. A
// counter that is not present in both samples must not be differenced:
//   · a transport closed or replaced inside the window (fixed earlier);
//   · a single RTP stream that ends inside the window while its transport
//     lives on, e.g. a consumer closed and recreated with a new SSRC. Its whole
//     lifetime byte count was subtracted. Run 40043090321 (IMP-04) printed
//     "B→A -57535.7 kbps -1653.5 fps" this way.
// A stream that starts inside the window counts from zero.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rates } from './analysis.mjs';

const video = (ssrc, bytes, frames, mid = '1') => ({ kind: 'video', ssrc, mid, bytesReceived: bytes, packetsReceived: bytes / 1000, framesDecoded: frames, frameWidth: 640, frameHeight: 480 });
const audio = (ssrc, bytes) => ({ kind: 'audio', ssrc, mid: '0', bytesReceived: bytes, packetsReceived: bytes / 100, concealedSamples: 0, totalSamplesReceived: bytes });
const pc = (id, inbound, conn = 'connected') => ({ id, conn, outbound: [], inbound, remoteInbound: [] });
const sample = (t, pcs) => ({ t, pcs, tracks: [] });

test('a stream alive in both samples is differenced', () => {
  const r = rates(sample(0, [pc('p1', [video(11, 1_000_000, 100)])]), sample(2000, [pc('p1', [video(11, 1_250_000, 120)])]));
  assert.equal(r.videoInKbps, 1000);
  assert.equal(r.videoFps, 10);
});

test('a stream that ends inside the window on a live transport is not subtracted', () => {
  // Consumer 11 (14 MB so far) closes; consumer 12 replaces it on the same transport.
  const a = sample(0, [pc('p1', [audio(1, 500_000), video(11, 14_000_000, 3300)])]);
  const b = sample(2000, [pc('p1', [audio(1, 516_000), video(12, 50_000, 6)])]);
  const r = rates(a, b);
  assert.ok(r.videoInKbps >= 0, `videoInKbps ${r.videoInKbps}`);
  assert.ok(r.videoFps >= 0, `videoFps ${r.videoFps}`);
  assert.equal(r.videoInKbps, 200);          // the new stream counts from zero: 50 kB in 2 s
  assert.equal(r.videoFps, 3);
  assert.equal(r.audioInKbps, 64);           // the surviving audio stream is untouched
});

test('a transport replaced inside the window still counts from zero (existing rule)', () => {
  const a = sample(0, [pc('p1', [video(11, 9_000_000, 900)])]);
  const b = sample(2000, [pc('p1', [video(11, 9_100_000, 910)], 'closed'), pc('p2', [video(21, 25_000, 4)])]);
  const r = rates(a, b);
  assert.equal(r.videoInKbps, 100);
  assert.equal(r.videoFps, 2);
});
