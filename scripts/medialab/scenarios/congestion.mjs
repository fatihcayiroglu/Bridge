// scripts/medialab/scenarios/congestion.mjs
//
// Video after congestion (MEDIA-11): on one call, repeatedly squeeze B's link
// to 64 kbit/s both ways, clear it, and time how long decoded video takes to
// come back in each direction and to reach the full-resolution layer again.
// A→B is what the SFU forwards to the congested receiver (mediasoup's
// bandwidth estimate and layer selection); B→A is B's own uplink (the
// browser's estimate). CONGESTION_CYCLES (default 3) sets the cycle count;
// CONGESTION_KBPS (default 64) and CONGESTION_SECONDS (default 20) the squeeze.

import { rates } from '../lib/analysis.mjs';
import { sleep, waitAudible } from '../lib/util.mjs';

const both = [0, 1];
const sym = (p) => ({ up: p, down: p });

export async function run({ lab, record, measure }) {
  const [ua, ub] = await lab.users(2, 'cong');
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua);
  const B = await lab.client(1, ub);
  await A.joinVoice(room);
  await sleep(1000);
  await B.joinVoice(room);
  if (!((await waitAudible(B, [0], both, 15_000)).ok && (await waitAudible(A, [1], both, 15_000)).ok)) {
    record('CONG-00', 'two-way audio before congestion', 'FAIL', 'no baseline media');
    return;
  }
  await A.toggleVideo();
  await B.toggleVideo();

  const flow = async (c) => { const s0 = await c.sample(); await sleep(2000); return rates(s0, await c.sample()); };
  const flowing = (r) => r.videoFps >= 1;
  // frameWidth survives a freeze, so the resolution only counts while frames decode.
  const full = (r) => flowing(r) && r.videoInRes.some((x) => x.startsWith('640x480'));
  // Samples both receivers in parallel until every condition held once (or
  // the timeout); each value is ms since `t0` at which it first held, or null.
  const watch = async (t0, timeoutMs) => {
    const got = { resumeAtoB: null, resumeBtoA: null, fullAtoB: null, fullBtoA: null };
    while (Date.now() - t0 < timeoutMs && Object.values(got).some((v) => v === null)) {
      const [atB, atA] = await Promise.all([flow(B), flow(A)]);
      const t = Date.now() - t0;
      if (got.resumeAtoB === null && flowing(atB)) got.resumeAtoB = t;
      if (got.resumeBtoA === null && flowing(atA)) got.resumeBtoA = t;
      if (got.fullAtoB === null && full(atB)) got.fullAtoB = t;
      if (got.fullBtoA === null && full(atA)) got.fullBtoA = t;
    }
    return got;
  };

  const cycles = Number(process.env.CONGESTION_CYCLES || 3);
  const kbps = Number(process.env.CONGESTION_KBPS || 64);
  const squeezeMs = Number(process.env.CONGESTION_SECONDS || 20) * 1000;
  const rows = [];
  for (let i = 0; i < cycles; i++) {
    const warm = await watch(Date.now(), 90_000);
    await lab.net.impair(1, sym({ rate_kbps: kbps, queue_ms: 300 }));
    await sleep(squeezeMs);
    const [sqB, sqA] = await Promise.all([flow(B), flow(A)]);
    await lab.net.impair(1, sym({}));
    const t0 = Date.now();
    const got = await watch(t0, 90_000);
    const row = {
      cycle: i + 1, clearedAt: t0, warmFullMs: { AtoB: warm.fullAtoB, BtoA: warm.fullBtoA },
      squeezed: { AtoB: `${sqB.videoInKbps}k/${sqB.videoFps}fps`, BtoA: `${sqA.videoInKbps}k/${sqA.videoFps}fps` },
      resumeMs: { AtoB: got.resumeAtoB, BtoA: got.resumeBtoA }, fullResMs: { AtoB: got.fullAtoB, BtoA: got.fullBtoA },
    };
    rows.push(row);
    console.log(`  congestion cycle ${i + 1}: ${JSON.stringify(row)}`);
  }
  measure('cycles', rows, `ms after the ${kbps} kbit/s, ${squeezeMs / 1000} s squeeze cleared (null = not within 90 s)`);
  const stuck = rows.filter((r) => r.resumeMs.AtoB === null || r.resumeMs.BtoA === null);
  record('CONG-01', `video resumes both ways after each of ${cycles} congestion cycles (${kbps} kbit/s, ${squeezeMs / 1000} s) without user action`,
    stuck.length ? 'FAIL' : 'PASS',
    rows.map((r) => `#${r.cycle} resume A→B ${r.resumeMs.AtoB ?? 'NO'} / B→A ${r.resumeMs.BtoA ?? 'NO'} ms, full ${r.fullResMs.AtoB ?? 'NO'} / ${r.fullResMs.BtoA ?? 'NO'} ms`).join('; '));
}
