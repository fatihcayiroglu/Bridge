// scripts/medialab/scenarios/multiuser.mjs
//
// N participants in one room, every one a real browser with its own tone.
// Each receiver must decode every other participant's tone exactly once and
// never its own. Measures join latency, per-receiver bitrate, SFU worker
// load and fan-out; then concurrent joins/leaves while media flows, and the
// cleanup when everyone leaves.

import { audibleSenders, rtp, rates } from '../lib/analysis.mjs';
import { namespaceUsage } from '../lib/lab.mjs';
import { sleep, waitUntil } from '../lib/util.mjs';

function hearsAllOthers(sample, self, members) {
  const heard = audibleSenders(sample, members);
  const others = members.filter((i) => i !== self);
  const counts = Object.fromEntries(others.map((i) => [i, heard.filter((h) => h === i).length]));
  return { ok: others.every((i) => counts[i] === 1) && !heard.includes(self), counts, self: heard.includes(self) };
}

async function convergence(clients, members, timeoutMs = 20_000) {
  return waitUntil(async () => {
    const out = [];
    for (const c of clients) out.push({ c: c.index, ...hearsAllOthers(await c.sample(), c.index, members) });
    return out.every((x) => x.ok) ? out : null;
  }, { timeoutMs, intervalMs: 500 });
}

async function room(lab, n, tag) {
  const users = await lab.users(n, tag);
  const r = await lab.voiceRoom(users[0], users.slice(1));
  return { users, room: r };
}

function workerLoad(probe) {
  return Object.fromEntries(Object.entries(probe).map(([n, v]) => [n, (v.workers || []).map((w) => ({ rssKb: w.rssKb, cpuTicks: w.cpuTicks, udp: w.udpSockets }))]));
}

export async function run({ lab, record, measure }) {
  for (const n of [3, 5, 6]) {
    const { users, room: r } = await room(lab, n, `mu${n}`);
    const clients = [];
    for (let i = 0; i < n; i++) clients.push(await lab.client(i, users[i]));
    const members = clients.map((c) => c.index);
    const p0 = lab.serverProbe();
    const joinAt = {};
    for (const c of clients) { joinAt[c.index] = await c.joinVoice(r); await sleep(300); }
    const conv = await convergence(clients, members, 30_000);
    record(`MU-${n}-01`, `${n} users: every receiver decodes every other participant exactly once, never itself`, conv.ok ? 'PASS' : 'FAIL',
      conv.ok ? `converged ${conv.ms} ms after the last join` : JSON.stringify(conv.value));
    // Join latency: click -> first decoded tone of the FIRST participant, per client.
    const latency = {};
    for (const c of clients.slice(1)) {
      const tl = await c.timeline(joinAt[c.index]);
      const hit = tl.find((e) => e.tones.some(([f, snr]) => Math.abs(f - 440) <= 15 && snr >= 20));
      latency[c.index] = hit ? hit.t - joinAt[c.index] : null;
    }
    measure(`n${n}.joinToFirstAudioMs`, latency, 'ms');
    const s0 = await Promise.all(clients.map((c) => c.sample()));
    const w0 = lab.serverProbe();
    await sleep(15_000);
    const s1 = await Promise.all(clients.map((c) => c.sample()));
    const w1 = lab.serverProbe();
    const perRx = clients.map((c, i) => {
      const r2 = rates(s0[i], s1[i]);
      return { c: c.index, inKbps: r2.audioInKbps, outKbps: r2.audioOutKbps, lossPct: r2.audioLossPct, concealPct: r2.concealedPct, inboundStreams: rtp(s1[i]).audioIn.streams };
    });
    const owner = lab.roomOwner(r.channelId)?.replace('mn-', '');
    const cpu = owner && w0[owner]?.workers?.[0] && w1[owner]?.workers?.[0]
      ? Math.round(((w1[owner].workers[0].cpuTicks - w0[owner].workers[0].cpuTicks) / 100 / 15) * 1000) / 10 : null;
    measure(`n${n}.perReceiver`, perRx, '15 s window');
    measure(`n${n}.server`, { owner, workerCpuPct: cpu, before: workerLoad(p0), during: workerLoad(w1), nodeRssKb: Object.fromEntries(Object.entries(w1).map(([k, v]) => [k, v.rssKb])) }, 'worker CPU % of one core');
    measure(`n${n}.clients`, clients.map((c) => ({ c: c.index, ...namespaceUsage(c.ns) })), 'rss kB / cpu ticks');
    const fanoutOk = perRx.every((x) => x.inboundStreams === n - 1);
    record(`MU-${n}-02`, `${n} users: each receiver has exactly ${n - 1} inbound audio streams (no duplicate consumers)`, fanoutOk ? 'PASS' : 'FAIL', JSON.stringify(perRx.map((x) => x.inboundStreams)));

    if (n === 5) {
      // Concurrent churn while media flows: two leave and rejoin at once.
      const churn = clients.slice(3);
      await Promise.all(churn.map((c) => c.leaveVoice()));
      const stay = clients.slice(0, 3);
      const after = await convergence(stay, stay.map((c) => c.index), 15_000);
      record('MU-5-03', 'two users leave concurrently: the remaining three converge (no ghost audio)', after.ok ? 'PASS' : 'FAIL', after.ok ? `${after.ms} ms` : JSON.stringify(after.value));
      await Promise.all(churn.map((c) => c.joinVoice(r)));
      const back = await convergence(clients, members, 30_000);
      record('MU-5-04', 'two users rejoin concurrently: all five converge again', back.ok ? 'PASS' : 'FAIL', back.ok ? `${back.ms} ms` : JSON.stringify(back.value));
    }

    // Everyone leaves: the SFU must release every transport and the room.
    for (const c of clients) await c.leaveVoice().catch(() => {});
    await sleep(8000);
    const pEnd = lab.serverProbe();
    const leftover = Object.values(pEnd).flatMap((v) => (v.workers || []).map((w) => w.udpSockets));
    const roomKey = lab.roomOwner(r.channelId);
    record(`MU-${n}-05`, `${n} users all leave: worker transports and the Redis room ownership are released`, leftover.every((x) => x === 0) && !roomKey ? 'PASS' : 'FAIL',
      `worker UDP sockets ${JSON.stringify(leftover)}; room owner key ${roomKey}`);
    for (const c of clients) await lab.closeClient(c);
    lab.net.down();
    lab.net.up();
  }
}
