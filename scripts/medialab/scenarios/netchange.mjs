// scripts/medialab/scenarios/netchange.mjs
//
// Client network changes during active media: a Wi-Fi -> cellular style
// handoff (new interface + new address, the old one disappears), the same
// handoff on a relay-only (TURN) network, and a longer address loss. Measures
// interruption -> usable media and checks for ghost / duplicate state.

import { rtp } from '../lib/analysis.mjs';
import { sleep, waitAudible, waitSilent, paths } from '../lib/util.mjs';

const both = [0, 1];

async function pair(lab, tag) {
  const [ua, ub] = await lab.users(2, tag);
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua);
  const B = await lab.client(1, ub);
  await A.joinVoice(room);
  await sleep(1000);
  await B.joinVoice(room);
  const ok = (await waitAudible(B, [0], both, 20_000)).ok && (await waitAudible(A, [1], both, 20_000)).ok;
  return { A, B, room, ok };
}

async function reset(lab) {
  for (const c of [...lab.clients]) await lab.closeClient(c);
  lab.net.down();
  lab.net.up();
}

async function handoffCase(lab, record, measure, { id, label, relay }) {
  if (relay) lab.net.blockDirectSfu(true);
  const { A, B, ok } = await pair(lab, id.toLowerCase().replace(/[^a-z0-9]/g, ''));
  if (!ok) { record(id, label, 'BLOCKED', 'no baseline two-way media'); await reset(lab); return; }
  const before = paths(await B.sample());
  const t0 = Date.now();
  const { from, to } = await lab.net.handoff(1, 'b');
  const stop = await waitSilent(B, [0], both, 10_000);
  const backB = await waitAudible(B, [0], both, 60_000);
  const backA = await waitAudible(A, [1], both, 15_000);
  const sb = await B.sample(); const sa = await A.sample();
  const ui = await B.uiState();
  const liveAudioA = sa.tracks.filter((t) => t.kind === 'audio').length;
  const recovered = backB.ok && backA.ok;
  record(id, `${label}: media resumes on the new path without user action`, recovered ? 'PASS' : 'FAIL',
    `${from}->${to}; ${recovered ? `usable ${Date.now() - t0} ms after handoff` : 'NOT recovered in 60 s'}; before ${before.join(', ')}; after ${paths(sb).join(', ') || 'none'}; UI ${JSON.stringify(ui)}; A live audio tracks ${liveAudioA}`);
  record(`${id}-ghost`, `${label}: no ghost or duplicate peers/tracks at the other participant`, liveAudioA <= 1 && sa.remoteAudioElements <= 1 ? 'PASS' : 'FAIL',
    `A live audio tracks ${liveAudioA}; A remote audio elements ${sa.remoteAudioElements}`);
  measure(`handoff.${relay ? 'relay' : 'direct'}`, { recovered, stopMs: stop.ok ? stop.ms : null, usableAfterMs: recovered ? Date.now() - t0 : null, pcsB: rtp(sb).pairs.map((p) => p.ice) }, 'ms');
  lab.net.blockDirectSfu(false);
  await reset(lab);
}

export async function run({ lab, record, measure }) {
  await handoffCase(lab, record, measure, { id: 'NC-01', label: 'Wi-Fi→cellular handoff (new interface + address, direct path)', relay: false });
  await lab.restartNodes({ FORCE_TURN: 'true' });
  await lab.settle();
  await handoffCase(lab, record, measure, { id: 'NC-02', label: 'handoff on a relay-only network (TURN route change)', relay: true });
  await lab.restartNodes({ FORCE_TURN: 'false' });
  await lab.settle();
}
