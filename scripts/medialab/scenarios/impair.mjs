// scripts/medialab/scenarios/impair.mjs
//
// Synthetic WAN impairment on ONE participant's link (B), both directions,
// while A and B exchange audio and camera video through the SFU:
//   A→B media = SFU→B downlink (impaired)   B→A media = B→SFU uplink (impaired)
// Every profile is applied live, allowed to settle, then measured from what
// the receivers decoded (tone continuity, concealment, frames, resolution)
// and from getStats (loss, jitter buffer, NACK/PLI, bitrate, RTT). The
// impairment link's own counters prove the impairment was really applied.

import { rates, toneContinuity, rtp } from '../lib/analysis.mjs';
import { sleep, waitAudible } from '../lib/util.mjs';

const both = [0, 1];

// One-way values on B's link; `up` = B→SFU, `down` = SFU→B.
const sym = (p) => ({ up: p, down: p });
export const PROFILES = [
  ['baseline', sym({})],
  ['latency-low-20ms', sym({ delay_ms: 20 })],
  ['latency-moderate-75ms', sym({ delay_ms: 75 })],
  ['latency-high-200ms', sym({ delay_ms: 200 })],
  ['jitter-low-30±5ms', sym({ delay_ms: 30, jitter_ms: 5 })],
  ['jitter-moderate-50±20ms', sym({ delay_ms: 50, jitter_ms: 20 })],
  ['jitter-severe-100±60ms', sym({ delay_ms: 100, jitter_ms: 60 })],
  ['loss-1%', sym({ loss: 1 })],
  ['loss-3%', sym({ loss: 3 })],
  ['loss-5%', sym({ loss: 5 })],
  ['loss-10%', sym({ loss: 10 })],
  ['loss-20%', sym({ loss: 20 })],
  ['burst-loss-GE', sym({ gilbert: { p_good_to_bad: 0.02, p_bad_to_good: 0.25, loss_in_bad: 0.9 } })],
  ['bw-comfortable-2000k', sym({ rate_kbps: 2000, queue_ms: 200 })],
  ['bw-constrained-500k', sym({ rate_kbps: 500, queue_ms: 200 })],
  ['bw-severe-150k', sym({ rate_kbps: 150, queue_ms: 200 })],
  ['bw-extreme-64k', sym({ rate_kbps: 64, queue_ms: 300 })],
  ['latency+jitter-100±30ms', sym({ delay_ms: 100, jitter_ms: 30 })],
  ['latency+loss-100ms+5%', sym({ delay_ms: 100, loss: 5 })],
  ['loss+bw-5%+500k', sym({ loss: 5, rate_kbps: 500, queue_ms: 200 })],
];

export async function run({ lab, record, measure }) {
  const [ua, ub] = await lab.users(2, 'imp');
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua);
  const B = await lab.client(1, ub);
  await A.joinVoice(room);
  await sleep(1000);
  await B.joinVoice(room);
  const ok = (await waitAudible(B, [0], both, 15_000)).ok && (await waitAudible(A, [1], both, 15_000)).ok;
  if (!ok) { record('IMP-00', 'two-way audio before impairment', 'FAIL', 'no baseline media'); return; }
  await A.toggleVideo();
  await B.toggleVideo();
  await sleep(12_000);

  const table = [];
  // IMPAIR_ONLY=interruptions skips the profile matrix (targeted re-runs).
  const profiles = process.env.IMPAIR_ONLY === 'interruptions' ? [] : PROFILES;
  for (const [name, profile] of profiles) {
    await lab.net.impair(1, profile);
    const applied = Date.now();
    await sleep(6000);
    const a0 = await A.sample(); const b0 = await B.sample(); const l0 = await lab.net.linkStats(1);
    await sleep(15_000);
    const a1 = await A.sample(); const b1 = await B.sample(); const l1 = await lab.net.linkStats(1);
    const tlB = await B.timeline(applied); const tlA = await A.timeline(applied);
    const atB = rates(b0, b1); const atA = rates(a0, a1);
    const d = (dir, key) => (l1.a[dir][key] - l0.a[dir][key]);
    const linkLoss = (dir) => {
      const rx = d(dir, 'rx_pkts');
      return rx ? Math.round(((d(dir, 'drop_loss') + d(dir, 'drop_queue')) / rx) * 1000) / 10 : 0;
    };
    const contB = toneContinuity(tlB, 0, { from: b0.t, to: b1.t });
    const contA = toneContinuity(tlA, 1, { from: a0.t, to: a1.t });
    const firstRes = tlB.find((e) => e.colours.length)?.colours?.[0];
    const lastRes = tlB[tlB.length - 1]?.colours?.[0];
    const row = {
      profile: name,
      linkDropPct: { down: linkLoss('down'), up: linkLoss('up') },
      downlink_AtoB: {
        audioLossPct: atB.audioLossPct, concealedPct: atB.concealedPct, jitterBufferMs: atB.jitterBufferMs, fec: atB.fecPackets,
        toneAudiblePct: contB.audiblePct, longestToneGapMs: contB.longestGapMs,
        videoKbps: atB.videoInKbps, videoFps: atB.videoFps, videoRes: atB.videoInRes.join(','), freezes: atB.freezes, nack: atB.nack, pli: atB.pli,
        resAtApply: firstRes ? `${firstRes[1]}x${firstRes[2]}` : null, resAfter: lastRes ? `${lastRes[1]}x${lastRes[2]}` : null,
        rttMs: atB.rttMs,
      },
      uplink_BtoA: {
        audioLossPct: atA.audioLossPct, concealedPct: atA.concealedPct, jitterBufferMs: atA.jitterBufferMs,
        toneAudiblePct: contA.audiblePct, longestToneGapMs: contA.longestGapMs,
        videoKbps: atA.videoInKbps, videoFps: atA.videoFps, videoRes: atA.videoInRes.join(','), freezes: atA.freezes,
        senderLayersB: rates(b0, b1).videoOutLayers.map((l) => `${l.rid}:${l.w ?? 0}x${l.h ?? 0}@${l.fps ?? 0}/${l.limit}`).join(' '),
        senderAvailableOutKbps: atB.availableOutKbps,
      },
    };
    table.push(row);
    measure(`profile.${name}`, row, 'window 15 s after 6 s settle');
  }
  await lab.net.impair(1, sym({}));

  // Classification against conservative usability bars (audio first).
  if (!table.length) record('IMP-01', 'impairment matrix', 'SKIPPED', 'IMPAIR_ONLY=interruptions (targeted run; the matrix is executed in full runs)');
  const usable = (r) => r.downlink_AtoB.toneAudiblePct >= 95 && r.uplink_BtoA.toneAudiblePct >= 95 && r.downlink_AtoB.concealedPct <= 5 && r.uplink_BtoA.concealedPct <= 5;
  const verdicts = table.map((r) => `${r.profile}: ${usable(r) ? 'audio usable' : 'audio DEGRADED'} (A→B audible ${r.downlink_AtoB.toneAudiblePct}% conceal ${r.downlink_AtoB.concealedPct}%, B→A audible ${r.uplink_BtoA.toneAudiblePct}% conceal ${r.uplink_BtoA.concealedPct}%, video ${r.downlink_AtoB.videoRes}@${r.downlink_AtoB.videoKbps}kbps)`);
  if (table.length) record('IMP-01', 'impairment matrix executed (per-profile measurements recorded)', 'INFO', verdicts.join(' | '));
  const mustBeUsable = ['baseline', 'latency-low-20ms', 'latency-moderate-75ms', 'jitter-low-30±5ms', 'loss-1%', 'loss-3%', 'bw-comfortable-2000k'];
  const bad = table.filter((r) => mustBeUsable.includes(r.profile) && !usable(r)).map((r) => r.profile);
  if (table.length) record('IMP-02', 'mild profiles keep audio usable (≥95 % audible, ≤5 % concealment both ways)', bad.length ? 'FAIL' : 'PASS', bad.length ? `degraded: ${bad.join(', ')}` : mustBeUsable.join(', '));
  const lowBw = table.find((r) => r.profile === 'bw-severe-150k');
  if (table.length) record('IMP-03', 'severe bandwidth (150 kbit/s): video yields, audio stays audible', lowBw && lowBw.downlink_AtoB.toneAudiblePct >= 90 ? 'PASS' : 'FAIL',
    lowBw ? `A→B audible ${lowBw.downlink_AtoB.toneAudiblePct}% conceal ${lowBw.downlink_AtoB.concealedPct}% video ${lowBw.downlink_AtoB.videoRes} ${lowBw.downlink_AtoB.videoKbps} kbps` : 'missing');

  // ── interruptions (blackhole both directions) ───────────────────────────
  for (const seconds of [2, 5, 10, 20, 40]) {
    await waitAudible(B, [0], both, 30_000);
    const start = Date.now();
    await lab.net.impair(1, sym({ blackhole: true }));
    await sleep(seconds * 1000);
    await lab.net.impair(1, sym({}));
    const end = Date.now();
    const back = await waitAudible(B, [0], both, 60_000);
    const backA = await waitAudible(A, [1], both, 10_000);
    const tl = await B.timeline(start - 2000);
    const ui = await B.uiState();
    const events = (await B.events(start)).filter((e) => e.ev === 'ice' || e.ev === 'conn').map((e) => `${e.t - start}ms pc${e.pc}:${e.ev}=${e.state}`);
    const recovered = back.ok && backA.ok;
    const cont = toneContinuity(tl, 0, { from: start - 1000 });
    record(`IMP-INT-${seconds}s`, `${seconds} s interruption: media resumes without user action`, recovered ? 'PASS' : 'FAIL',
      `${recovered ? `A→B audible ${back.ms} ms after link restored (B→A ${backA.ms} ms later)` : 'NOT recovered within 60 s'}; longest gap ${cont.longestGapMs} ms; UI ${JSON.stringify(ui)}; ICE/conn events ${events.join(', ')}`);
    measure(`interruption.${seconds}s`, { recovered, resumeAfterRestoreMs: back.ok ? back.ms : null, bResumeAtA: backA.ok ? backA.ms : null, uiInVoice: ui.inVoice, pcs: rtp(await B.sample()).pcs }, 'ms');
    if (!recovered) {
      // Rejoin so the next step starts from a working call.
      if ((await B.uiState()).inVoice) await B.leaveVoice().catch(() => {});
      await sleep(1500);
      await B.joinVoice(room).catch(() => {});
      await waitAudible(B, [0], both, 20_000);
      if (!(await B.uiState()).video) await B.toggleVideo().catch(() => {});
    }
  }
}
