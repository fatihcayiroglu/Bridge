// scripts/medialab/scenarios/failover.mjs
//
// SFU / node / worker / Redis failure DURING active two-way media. Client A's
// app traffic is pinned to node A, client B's to node B (sticky LB). A joins
// first, so node A owns the room and B's media signaling is redirected to A
// over a dedicated `?bridgeNode=mn-A` socket. Every case measures when media
// stopped, whether and when it resumed, and what the user was shown.

import { rtp } from '../lib/analysis.mjs';
import { sleep, waitUntil, waitAudible, waitSilent, redirects } from '../lib/util.mjs';

const both = [0, 1];

async function setup(lab, tag) {
  const [ua, ub] = await lab.users(2, tag);
  const room = await lab.voiceRoom(ua, [ub]);
  const A = await lab.client(0, ua, { node: 'A' });
  const B = await lab.client(1, ub, { node: 'B' });
  await A.joinVoice(room);
  await sleep(1500);
  await B.joinVoice(room);
  const ok = (await waitAudible(B, [0], both, 15_000)).ok && (await waitAudible(A, [1], both, 15_000)).ok;
  return { A, B, room, ok, owner: lab.roomOwner(room.channelId) };
}

async function teardown(lab) {
  for (const c of [...lab.clients]) await lab.closeClient(c);
  lab.net.down();
  lab.net.up();
  for (const n of lab.nodes) if (lab.cluster.nodes.get(n)?.exited) await lab.startNode(n);
  lab.proxy.setMode('round-robin');
  for (const n of lab.nodes) lab.proxy.restore(n);
}

/** What each client experiences after a failure at `t0`. */
async function observe(A, B, t0, { waitMs = 60_000 } = {}) {
  const stopB = await waitSilent(B, [0], both, 20_000);
  const stopA = await waitSilent(A, [1], both, 5_000);
  const backB = await waitAudible(B, [0], both, waitMs);
  const backA = await waitAudible(A, [1], both, 10_000);
  const [ua, ub] = [await A.uiState(), await B.uiState()];
  return {
    stopMsB: stopB.ok ? stopB.ms : null,
    stopMsA: stopA.ok ? stopA.ms : null,
    resumed: backB.ok && backA.ok,
    resumeMsAfterFailure: backB.ok && backA.ok ? Date.now() - t0 : null,
    uiA: ua, uiB: ub,
    pcsA: rtp(await A.sample()).pairs.map((p) => p.ice), pcsB: rtp(await B.sample()).pairs.map((p) => p.ice),
  };
}

async function manualRejoin(A, B, room) {
  const t = Date.now();
  for (const c of [A, B]) {
    if ((await c.uiState()).inVoice) await c.leaveVoice().catch(() => {});
  }
  await sleep(1000);
  for (const c of [A, B]) await c.joinVoice(room).catch(() => {});
  const ok = (await waitAudible(B, [0], both, 40_000)).ok && (await waitAudible(A, [1], both, 15_000)).ok;
  return { ok, ms: Date.now() - t };
}

export async function run({ lab, record, measure }) {
  // ── 1. non-owner node (B's signaling node) dies ────────────────────────
  {
    const { A, B, room, ok, owner } = await setup(lab, 'fo1');
    record('FO-00', 'setup: A pinned to node A (owner), B pinned to node B, redirected to owner', ok && owner === 'mn-A' && redirects(B) >= 1 ? 'PASS' : 'FAIL',
      `media ${ok}; owner ${owner}; B redirects ${redirects(B)}`);
    if (ok) {
      const t0 = Date.now();
      await lab.cluster.killNode('B', 'SIGKILL');
      lab.proxy.remove('B');
      const o = await observe(A, B, t0);
      record('FO-01', 'non-owner node (B\'s app/signaling node) killed: call continues or recovers without user action', o.resumed ? 'PASS' : 'FAIL', JSON.stringify(o));
      measure('nonOwnerDeath', o, 'ms');
      if (!o.resumed) {
        const r = await manualRejoin(A, B, room);
        record('FO-01b', 'after non-owner death: manual rejoin restores two-way media', r.ok ? 'PASS' : 'FAIL', `${r.ms} ms`);
      }
    }
    await teardown(lab);
  }

  // ── 2. owner node dies (SIGKILL) ───────────────────────────────────────
  {
    const { A, B, room, ok, owner } = await setup(lab, 'fo2');
    if (ok && owner === 'mn-A') {
      const t0 = Date.now();
      await lab.cluster.killNode('A', 'SIGKILL');
      lab.proxy.remove('A');
      const o = await observe(A, B, t0, { waitMs: 70_000 });
      record('FO-02', 'SFU owner node killed: media recovers on a surviving node without user action', o.resumed ? 'PASS' : 'FAIL', JSON.stringify(o));
      record('FO-03', 'SFU owner node killed: no client is left showing a live call without media', o.resumed || (!o.uiB.inVoice && !o.uiA.inVoice) ? 'PASS' : 'FAIL',
        `A UI ${JSON.stringify(o.uiA)}; B UI ${JSON.stringify(o.uiB)}; B ICE ${JSON.stringify(o.pcsB)}`);
      measure('ownerDeath', o, 'ms');
      if (!o.resumed) {
        const r = await manualRejoin(A, B, room);
        record('FO-03b', 'after owner death: manual rejoin restores media on the surviving node', r.ok ? 'PASS' : 'FAIL', `${r.ms} ms; new owner ${lab.roomOwner(room.channelId)}`);
      }
    } else record('FO-02', 'SFU owner node killed', 'BLOCKED', `setup failed (media ${ok}, owner ${owner})`);
    await teardown(lab);
  }

  // ── 3. owner node graceful restart (SIGTERM, as in a rolling deploy) ────
  {
    const { A, B, room, ok, owner } = await setup(lab, 'fo3');
    if (ok && owner === 'mn-A') {
      const t0 = Date.now();
      await lab.cluster.killNode('A', 'SIGTERM');
      await lab.startNode('A');
      const o = await observe(A, B, t0, { waitMs: 60_000 });
      record('FO-04', 'owner node rolling restart (SIGTERM + start): media recovers without user action', o.resumed ? 'PASS' : 'FAIL', JSON.stringify(o));
      measure('ownerRestart', o, 'ms');
      if (!o.resumed) {
        const r = await manualRejoin(A, B, room);
        record('FO-04b', 'after owner restart: manual rejoin restores media', r.ok ? 'PASS' : 'FAIL', `${r.ms} ms`);
      }
    } else record('FO-04', 'owner node rolling restart', 'BLOCKED', `setup failed (media ${ok}, owner ${owner})`);
    await teardown(lab);
  }

  // ── 4. mediasoup worker process dies on the owner ───────────────────────
  {
    const { A, B, room, ok, owner } = await setup(lab, 'fo4');
    const probe = lab.serverProbe();
    const worker = probe.A?.workers?.[0]?.pid;
    if (ok && owner === 'mn-A' && worker) {
      const t0 = Date.now();
      process.kill(worker, 'SIGKILL');
      const o = await observe(A, B, t0, { waitMs: 60_000 });
      const after = lab.serverProbe();
      record('FO-05', 'mediasoup worker killed mid-call: media recovers without user action', o.resumed ? 'PASS' : 'FAIL', JSON.stringify(o));
      record('FO-06', 'worker replaced after death (pool self-heals)', (after.A?.workers?.length ?? 0) >= 1 && after.A.workers[0].pid !== worker ? 'PASS' : 'FAIL',
        `old ${worker} new ${JSON.stringify(after.A?.workers?.map((w) => w.pid))}`);
      measure('workerDeath', o, 'ms');
      if (!o.resumed) {
        const r = await manualRejoin(A, B, room);
        record('FO-05b', 'after worker death: manual rejoin restores media', r.ok ? 'PASS' : 'FAIL', `${r.ms} ms`);
      }
    } else record('FO-05', 'mediasoup worker killed', 'BLOCKED', `setup failed (media ${ok}, owner ${owner}, worker ${worker})`);
    await teardown(lab);
  }

  // ── 5. Redis unavailable during media (P1 fail-closed contract) ─────────
  {
    const { A, B, ok, owner } = await setup(lab, 'fo5');
    if (ok) {
      const redisClients = () => lab.cluster.redisCli('CLIENT', 'LIST').split('\n').filter(Boolean).length;
      const clientsBefore = redisClients();
      // Short hang: well inside the 25 s ownership watchdog.
      const t0 = Date.now();
      lab.cluster.pauseRedis();
      await sleep(10_000);
      const during = await waitAudible(B, [0], both, 2_000);
      lab.cluster.resumeRedis();
      await sleep(3000);
      const after = await waitAudible(B, [0], both, 20_000);
      record('FO-07', 'Redis hung 10 s: established media keeps flowing', during.ok && after.ok ? 'PASS' : 'FAIL',
        `during ${during.ok}, after ${after.ok} (${Date.now() - t0} ms); owner ${owner}`);
      // Let a lease refresh succeed (every NODE_HEARTBEAT_MS = 10 s) so the
      // watchdog budget is full again: it fences 25 s after the LAST
      // confirmed refresh, not after the start of an outage.
      await sleep(15_000);
      // Long hang: past the ownership lease — the room must fence (P1 fail-closed).
      const t1 = Date.now();
      lab.cluster.pauseRedis();
      const fenced = await waitSilent(B, [0], both, 45_000);
      lab.cluster.resumeRedis();
      record('FO-08', 'Redis hung past the ownership lease: the room is fenced (media stops, P1 fail-closed)', fenced.ok ? 'PASS' : 'FAIL',
        fenced.ok ? `media stopped ${fenced.ms} ms into the outage` : 'media still flowing 45 s into a Redis outage');
      const tResume = Date.now();
      const rec = await waitAudible(B, [0], both, 60_000);
      const recA = await waitAudible(A, [1], both, 15_000);
      const ui = await B.uiState();
      record('FO-09', 'after the Redis outage ends: media recovers without user action', rec.ok && recA.ok ? 'PASS' : 'FAIL',
        rec.ok ? `audible ${Date.now() - tResume} ms after Redis resumed (outage ${tResume - t1} ms)` : `not recovered 60 s after Redis resumed; B UI ${JSON.stringify(ui)}`);
      await sleep(10_000);
      const clientsAfter = redisClients();
      record('FO-10', 'Redis connections return to baseline after the outages (no leaked clients)', clientsAfter <= clientsBefore + 2 ? 'PASS' : 'FAIL',
        `Redis CLIENT LIST before ${clientsBefore}, after ${clientsAfter}`);
    } else record('FO-07', 'Redis outage during media', 'BLOCKED', 'setup failed');
    await teardown(lab);
  }
}
