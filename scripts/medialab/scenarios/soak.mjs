// scripts/medialab/scenarios/soak.mjs
//
// A sustained 3-party call (SOAK_MINUTES, default 10) with periodic churn:
// mute/unmute, camera on/off, leave/rejoin and brief network interruptions.
// Every 30 s it samples server processes (node + mediasoup worker RSS, CPU,
// fds, UDP sockets), Redis SFU keys and every browser (open peer connections,
// live remote tracks, audio elements, JS heap). Growth is judged by comparing
// the first and last quarter of the samples, not by surviving without a crash.

import { audibleSenders, rtp, toneContinuity } from '../lib/analysis.mjs';
import { namespaceUsage } from '../lib/lab.mjs';
import { sleep, waitAudible } from '../lib/util.mjs';

const median = (v) => { const s = [...v].sort((a, b) => a - b); return s.length ? s[s.length >> 1] : null; };

export async function run({ lab, record, measure }) {
  const minutes = Number(process.env.SOAK_MINUTES || 10);
  const users = await lab.users(3, 'soak');
  const r = await lab.voiceRoom(users[0], users.slice(1));
  const clients = [];
  for (let i = 0; i < 3; i++) clients.push(await lab.client(i, users[i]));
  const [A, B, C] = clients;
  const members = [0, 1, 2];
  for (const c of clients) { await c.joinVoice(r); await sleep(500); }
  await waitAudible(C, [0, 1], members, 20_000);
  await A.toggleVideo();
  const start = Date.now();
  const end = start + minutes * 60_000;
  const samples = [];
  const disruptions = [];
  let tick = 0;
  while (Date.now() < end) {
    tick++;
    const t = Date.now();
    // Scheduled churn (every 30 s tick).
    if (tick % 2 === 0) { await B.toggleMute(); disruptions.push({ t, what: 'B mute toggle' }); }
    if (tick % 3 === 0) { await C.toggleVideo(); disruptions.push({ t, what: 'C camera toggle' }); }
    if (tick % 4 === 0) {
      await A.leaveVoice(); await sleep(1500); await A.joinVoice(r);
      if (!(await A.uiState()).video) await A.toggleVideo();
      disruptions.push({ t, what: 'A leave/rejoin' });
    }
    if (tick % 5 === 0) {
      await lab.net.impair(2, { up: { blackhole: true }, down: { blackhole: true } });
      await sleep(5000);
      await lab.net.impair(2, { up: {}, down: {} });
      disruptions.push({ t, what: 'C 5 s interruption' });
    }
    await sleep(Math.max(0, 30_000 - (Date.now() - t)));
    const probe = lab.serverProbe();
    const ss = await Promise.all(clients.map((c) => c.sample()));
    const heaps = await Promise.all(clients.map((c) => c.page.evaluate(() => (performance.memory ? performance.memory.usedJSHeapSize : null)).catch(() => null)));
    samples.push({
      t: Date.now() - start,
      server: Object.fromEntries(Object.entries(probe).map(([n, v]) => [n, { rssKb: v.rssKb, fds: v.fds, worker: v.workers?.[0] ? { rssKb: v.workers[0].rssKb, fds: v.workers[0].fds, udp: v.workers[0].udpSockets, cpuTicks: v.workers[0].cpuTicks } : null }])),
      redisSfuKeys: lab.redisSfuKeys().length,
      clients: ss.map((s, i) => ({
        c: i, pcsOpen: rtp(s).pcs, liveRemoteTracks: s.tracks.length, audioEls: s.remoteAudioElements,
        heard: audibleSenders(s, members), heapMb: heaps[i] ? Math.round(heaps[i] / 1048576) : null, ns: namespaceUsage(clients[i].ns).rssKb,
      })),
      bMuted: (await B.uiState()).muted,
    });
  }
  measure('samples', samples, `30 s samples over ${minutes} min`);
  measure('disruptions', disruptions, 'scheduled');

  const q = Math.max(1, Math.floor(samples.length / 4));
  const first = samples.slice(0, q); const last = samples.slice(-q);
  const series = {
    ownerNodeRssKb: (s) => Math.max(...Object.values(s.server).map((v) => v.rssKb || 0)),
    workerRssKb: (s) => Math.max(...Object.values(s.server).map((v) => v.worker?.rssKb || 0)),
    workerFds: (s) => Math.max(...Object.values(s.server).map((v) => v.worker?.fds || 0)),
    workerUdp: (s) => Math.max(...Object.values(s.server).map((v) => v.worker?.udp || 0)),
    nodeFds: (s) => Math.max(...Object.values(s.server).map((v) => v.fds || 0)),
    redisSfuKeys: (s) => s.redisSfuKeys,
    maxPcsPerClient: (s) => Math.max(...s.clients.map((c) => c.pcsOpen)),
    maxAudioEls: (s) => Math.max(...s.clients.map((c) => c.audioEls)),
    maxHeapMb: (s) => Math.max(...s.clients.map((c) => c.heapMb || 0)),
  };
  const growth = {};
  for (const [k, f] of Object.entries(series)) {
    const a = median(first.map(f)); const b = median(last.map(f));
    growth[k] = { firstQuarter: a, lastQuarter: b, ratio: a ? Math.round((b / a) * 100) / 100 : null };
  }
  measure('growth', growth, 'median first vs last quarter');
  const bounded = growth.workerUdp.lastQuarter <= 12 && growth.maxPcsPerClient.lastQuarter <= 2 && growth.maxAudioEls.lastQuarter <= 2
    && (growth.workerRssKb.ratio ?? 1) < 1.5 && (growth.ownerNodeRssKb.ratio ?? 1) < 1.5 && (growth.maxHeapMb.ratio ?? 1) < 1.5 && growth.redisSfuKeys.lastQuarter <= growth.redisSfuKeys.firstQuarter + 2;
  record('SOAK-01', `${minutes} min 3-party soak with churn: no unbounded growth (server RSS/fds/sockets, Redis keys, client PCs/tracks/heap)`, bounded ? 'PASS' : 'FAIL', JSON.stringify(growth));

  // Continuity of the one participant never disrupted on purpose: B's tone at A.
  const tl = await A.timeline(start);
  const cont = toneContinuity(tl, 1, { from: start });
  record('SOAK-02', 'B→A audio continuity over the soak (gaps only around scheduled disruptions)', 'INFO', JSON.stringify({ audiblePct: cont.audiblePct, longestGapMs: cont.longestGapMs, gaps: cont.gaps.slice(0, 40) }));
  const endHeard = samples.at(-1)?.clients.map((c) => c.heard);
  record('SOAK-03', 'everyone still hears everyone else at the end of the soak', JSON.stringify(endHeard) && samples.at(-1).clients.every((c) => members.filter((m) => m !== c.c && !(m === 1 && samples.at(-1).bMuted)).every((m) => c.heard.includes(m))) ? 'PASS' : 'FAIL', JSON.stringify({ endHeard, bMuted: samples.at(-1)?.bMuted }));
}
