// scripts/medialab/lib/analysis.mjs
//
// Pure functions turning browser samples / timelines into measurements.
// Everything here is derived from what the receiving browser DECODED
// (tone frequency, identity colour, frame counters) or what its own
// getStats() reported — never from signaling "success" events.

export const TONE_TOLERANCE_HZ = 15;
export const TONE_MIN_SNR_DB = 20;

// Identity colours of fixtures.py converted to RGB (BT.601 full range).
const YUV = [[82, 90, 240], [145, 54, 34], [41, 240, 110], [210, 16, 146], [107, 202, 222], [170, 166, 16], [120, 200, 60], [160, 60, 200]];
export const IDENTITY_RGB = YUV.map(([y, u, v]) => {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return [c(y + 1.402 * (v - 128)), c(y - 0.344136 * (u - 128) - 0.714136 * (v - 128)), c(y + 1.772 * (u - 128))];
});

export const toneHz = (index) => 440 + 220 * index;

export function colourIndex(rgb) {
  if (!rgb) return null;
  let best = null; let bestD = Infinity;
  IDENTITY_RGB.forEach((ref, i) => {
    const d = Math.hypot(rgb[0] - ref[0], rgb[1] - ref[1], rgb[2] - ref[2]);
    if (d < bestD) { bestD = d; best = i; }
  });
  return bestD < 90 ? best : null;
}

/** Senders (client indexes) whose tone the receiver decodes right now. */
export function audibleSenders(sample, candidates) {
  const heard = [];
  for (const tr of sample.tracks.filter((t) => t.kind === 'audio')) {
    if ((tr.snrDb ?? 0) < TONE_MIN_SNR_DB) continue;
    const who = candidates.find((i) => Math.abs(tr.freq - toneHz(i)) <= TONE_TOLERANCE_HZ);
    if (who !== undefined) heard.push(who);
  }
  return heard;
}

export function visibleSenders(sample) {
  return sample.tracks.filter((t) => t.kind === 'video' && t.rgb).map((t) => colourIndex(t.rgb)).filter((i) => i !== null);
}

export function sum(list, key) { return list.reduce((a, x) => a + (Number(x[key]) || 0), 0); }

/** Flatten one sample into per-direction RTP totals + the selected path. */
export function rtp(sample) {
  const live = sample.pcs.filter((p) => p.conn !== 'closed');
  const out = live.flatMap((p) => p.outbound);
  // mediasoup-client's bandwidth "probator" receiver (mid 'probator') carries
  // only padding; it is not media and never decodes a frame.
  const inb = live.flatMap((p) => p.inbound).filter((x) => x.mid !== 'probator');
  const rin = live.flatMap((p) => p.remoteInbound);
  const pairs = live.filter((p) => p.pair).map((p) => ({ pc: p.id, dtls: p.dtlsState, ice: p.iceState, ...p.pair }));
  const k = (list, kind) => list.filter((x) => x.kind === kind);
  return {
    pcs: live.length,
    pairs,
    audioOut: { packets: sum(k(out, 'audio'), 'packetsSent'), bytes: sum(k(out, 'audio'), 'bytesSent'), streams: k(out, 'audio').length },
    videoOut: {
      packets: sum(k(out, 'video'), 'packetsSent'), bytes: sum(k(out, 'video'), 'bytesSent'), streams: k(out, 'video').length,
      layers: k(out, 'video').map((o) => ({ rid: o.rid, w: o.frameWidth, h: o.frameHeight, fps: o.framesPerSecond, active: o.active, limit: o.qualityLimitationReason, nack: o.nackCount, pli: o.pliCount, rtx: o.retransmittedPacketsSent, target: o.targetBitrate })),
    },
    audioIn: {
      packets: sum(k(inb, 'audio'), 'packetsReceived'), lost: sum(k(inb, 'audio'), 'packetsLost'), bytes: sum(k(inb, 'audio'), 'bytesReceived'),
      streams: k(inb, 'audio').length,
      concealed: sum(k(inb, 'audio'), 'concealedSamples'), samples: sum(k(inb, 'audio'), 'totalSamplesReceived'),
      fec: sum(k(inb, 'audio'), 'fecPacketsReceived'), jbDelay: sum(k(inb, 'audio'), 'jitterBufferDelay'), jbEmitted: sum(k(inb, 'audio'), 'jitterBufferEmittedCount'),
      jitterMax: Math.max(0, ...k(inb, 'audio').map((x) => x.jitter || 0)),
    },
    videoIn: {
      packets: sum(k(inb, 'video'), 'packetsReceived'), lost: sum(k(inb, 'video'), 'packetsLost'), bytes: sum(k(inb, 'video'), 'bytesReceived'),
      streams: k(inb, 'video').length, frames: sum(k(inb, 'video'), 'framesDecoded'), dropped: sum(k(inb, 'video'), 'framesDropped'),
      freezes: sum(k(inb, 'video'), 'freezeCount'), freezeS: sum(k(inb, 'video'), 'totalFreezesDuration'), nack: sum(k(inb, 'video'), 'nackCount'),
      pli: sum(k(inb, 'video'), 'pliCount'), fir: sum(k(inb, 'video'), 'firCount'), keyframes: sum(k(inb, 'video'), 'keyFramesDecoded'),
      res: k(inb, 'video').map((x) => `${x.frameWidth ?? 0}x${x.frameHeight ?? 0}@${Math.round(x.framesPerSecond ?? 0)}`),
    },
    senderView: { lost: sum(rin, 'packetsLost'), fractionLostMax: Math.max(0, ...rin.map((r) => r.fractionLost || 0)), rttMax: Math.max(0, ...rin.map((r) => r.roundTripTime || 0)) },
  };
}

/** Rates between two samples (kbit/s, loss %, concealment %). */
export function rates(a, b) {
  const ra = rtp(a); const rb = rtp(b);
  const dt = (b.t - a.t) / 1000;
  const kbps = (x, y) => Math.round(((y - x) * 8) / dt / 100) / 10;
  const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : 0);
  const aRecv = rb.audioIn.packets - ra.audioIn.packets;
  const aLost = rb.audioIn.lost - ra.audioIn.lost;
  const vRecv = rb.videoIn.packets - ra.videoIn.packets;
  const vLost = rb.videoIn.lost - ra.videoIn.lost;
  const jbD = rb.audioIn.jbDelay - ra.audioIn.jbDelay;
  const jbE = rb.audioIn.jbEmitted - ra.audioIn.jbEmitted;
  return {
    seconds: Math.round(dt * 10) / 10,
    audioOutKbps: kbps(ra.audioOut.bytes, rb.audioOut.bytes),
    audioInKbps: kbps(ra.audioIn.bytes, rb.audioIn.bytes),
    videoOutKbps: kbps(ra.videoOut.bytes, rb.videoOut.bytes),
    videoInKbps: kbps(ra.videoIn.bytes, rb.videoIn.bytes),
    audioInPps: Math.round(aRecv / dt),
    audioLossPct: pct(aLost, aRecv + aLost),
    videoLossPct: pct(vLost, vRecv + vLost),
    concealedPct: pct(rb.audioIn.concealed - ra.audioIn.concealed, rb.audioIn.samples - ra.audioIn.samples),
    jitterBufferMs: jbE > 0 ? Math.round((jbD / jbE) * 1000) : null,
    videoFps: Math.round(((rb.videoIn.frames - ra.videoIn.frames) / dt) * 10) / 10,
    freezes: rb.videoIn.freezes - ra.videoIn.freezes,
    nack: rb.videoIn.nack - ra.videoIn.nack,
    pli: rb.videoIn.pli - ra.videoIn.pli,
    fecPackets: rb.audioIn.fec - ra.audioIn.fec,
    rttMs: Math.round(Math.max(0, ...rb.pairs.map((p) => p.rtt || 0)) * 1000),
    availableOutKbps: Math.round(Math.max(0, ...rb.pairs.map((p) => p.availableOutgoingBitrate || 0)) / 1000),
    videoInRes: rb.videoIn.res,
    videoOutLayers: rb.videoOut.layers,
  };
}

/**
 * Continuity of one sender's tone at a receiver over a timeline window:
 * total audible fraction, the longest gap, and gap intervals (ms).
 */
export function toneContinuity(timeline, senderIndex, { from = 0, to = Infinity } = {}) {
  const f = toneHz(senderIndex);
  const pts = timeline.filter((e) => e.t >= from && e.t <= to);
  if (!pts.length) return { samples: 0, audiblePct: 0, longestGapMs: null, gaps: [] };
  let audible = 0; let gapStart = null; const gaps = [];
  for (const e of pts) {
    const on = e.tones.some(([freq, snr]) => Math.abs(freq - f) <= TONE_TOLERANCE_HZ && snr >= TONE_MIN_SNR_DB);
    if (on) {
      audible++;
      if (gapStart !== null) { gaps.push([gapStart, e.t]); gapStart = null; }
    } else if (gapStart === null) gapStart = e.t;
  }
  if (gapStart !== null) gaps.push([gapStart, pts[pts.length - 1].t]);
  const longest = gaps.reduce((m, [a, b]) => Math.max(m, b - a), 0);
  return { samples: pts.length, audiblePct: Math.round((audible / pts.length) * 1000) / 10, longestGapMs: longest, gaps: gaps.map(([a, b]) => ({ at: a, ms: b - a })) };
}

/** First time (>= after) the sender's tone is audible at the receiver. */
export function firstAudible(timeline, senderIndex, after = 0) {
  const f = toneHz(senderIndex);
  const hit = timeline.find((e) => e.t >= after && e.tones.some(([freq, snr]) => Math.abs(freq - f) <= TONE_TOLERANCE_HZ && snr >= TONE_MIN_SNR_DB));
  return hit ? hit.t : null;
}

/** Last time (<= before) the sender's tone was audible. */
export function lastAudible(timeline, senderIndex, before = Infinity) {
  const f = toneHz(senderIndex);
  let last = null;
  for (const e of timeline) {
    if (e.t > before) break;
    if (e.tones.some(([freq, snr]) => Math.abs(freq - f) <= TONE_TOLERANCE_HZ && snr >= TONE_MIN_SNR_DB)) last = e.t;
  }
  return last;
}

export function firstVisible(timeline, senderIndex, after = 0) {
  const hit = timeline.find((e) => e.t >= after && e.colours.some(([rgb]) => colourIndex(rgb) === senderIndex));
  return hit ? hit.t : null;
}

export function percentile(values, p) {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  return v[Math.min(v.length - 1, Math.floor((p / 100) * v.length))];
}

/** ICE / connection transition timestamps from the page's event log. */
export function connectTimes(events, since) {
  const ev = events.filter((e) => e.t >= since);
  const created = ev.filter((e) => e.ev === 'created');
  const connected = ev.filter((e) => e.ev === 'conn' && e.state === 'connected');
  const iceConnected = ev.filter((e) => e.ev === 'ice' && (e.state === 'connected' || e.state === 'completed'));
  return {
    pcsCreated: created.length,
    firstPcCreatedMs: created.length ? created[0].t - since : null,
    firstIceConnectedMs: iceConnected.length ? iceConnected[0].t - since : null,
    firstDtlsConnectedMs: connected.length ? connected[0].t - since : null,
    lastDtlsConnectedMs: connected.length ? connected[connected.length - 1].t - since : null,
    cfg: created.map((e) => e.cfg),
  };
}
