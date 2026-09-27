// Competing background workers on three real nodes, sharing one PostgreSQL.
//   · scheduled messages   (claimDueBefore: FOR UPDATE SKIP LOCKED + lease)
//   · outgoing webhooks    (claimDueDeliveries + lease, external HTTP effect)
//   · ActivityPub retries  (claimPendingDeliveries + lease, external HTTP effect)
// "Crashed owner" states are written into PostgreSQL exactly as a dead worker
// leaves them, then the live nodes must recover them.

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { register, makeServer, connectSocket, mutate, request, rnd, sendMessage } from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SINK_PORT = 3190;

function startSink() {
  const hits = [];
  let hangNext = 0;
  const hanging = [];
  const server = http.createServer((req, res) => {
    const parts = [];
    req.on('data', (c) => parts.push(c));
    req.on('end', () => {
      let body = null;
      try { body = JSON.parse(Buffer.concat(parts).toString('utf8')); } catch { /* keep null */ }
      const hit = { at: Date.now(), path: req.url, delivery: req.headers['x-bridge-delivery'] || null, body, remotePort: req.socket.remotePort };
      hits.push(hit);
      if (hangNext > 0) { hangNext -= 1; hanging.push({ hit, res }); return; }
      res.writeHead(200).end('ok');
    });
  });
  return new Promise((resolve) => server.listen(SINK_PORT, '127.0.0.1', () => resolve({
    hits, server, hanging,
    hang(n = 1) { hangNext = n; },
    close() { for (const h of hanging) h.res.destroy(); return new Promise((r) => server.close(() => r())); },
  })));
}

function pidForPeerPort(port) {
  const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:ESTABLISHED', '-Fp'], { encoding: 'utf8' }).stdout || '';
  return out.split('\n').filter((l) => l.startsWith('p')).map((l) => Number(l.slice(1))).filter((p) => p !== process.pid);
}

async function waitUntil(fn, ms, step = 500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

export async function run({ cluster, record, measure }) {
  const url = (n) => cluster.nodeUrl(n);
  const owner = await register(url('A'), 'jb');
  const watcher = await register(url('B'), 'jb');
  const { serverId, channelId } = await makeServer(url('A'), owner, [watcher]);
  const watchSock = await connectSocket(url('C'), watcher.token);
  watchSock.emit('channel:join', channelId);
  await sleep(400);
  const live = new Map();
  watchSock.on('message:new', (m) => { if (m?._id) live.set(m._id, (live.get(m._id) || 0) + 1); });

  const history = async () => {
    const h = await request(url('B'), 'GET', `/api/channels/${channelId}/messages?limit=100`, { token: owner.token });
    return Array.isArray(h.body) ? h.body : h.body?.messages || [];
  };
  const schedule = async (node, content, inMs) => {
    const r = await mutate(url(node), 'POST', '/api/scheduled', owner.token,
      { channelId, serverId, content, sendAt: new Date(Date.now() + inMs).toISOString() });
    if (r.status >= 300) throw new Error(`schedule ${r.status} ${JSON.stringify(r.body)}`);
    return r.body._id || r.body.id;
  };

  // ── 1. three competing schedulers, same due work ─────────────────────────
  const K = 10;
  const due = [];
  for (let i = 0; i < K; i++) due.push({ content: `sched-${i}-${rnd()}`, id: await schedule('ABC'[i % 3], `sched-${i}-${rnd()}`, 3_000) });
  // content is set from the create call; re-read authoritative content
  const rows = cluster.psql(`SELECT _id || '|' || content FROM scheduled_msgs WHERE _id IN (${due.map((d) => `'${d.id}'`).join(',')})`).split('\n');
  const byId = Object.fromEntries(rows.map((r) => r.split('|')));
  const t0 = Date.now();
  const done = await waitUntil(async () => {
    const h = await history();
    return due.every((d) => h.some((m) => m.content === byId[d.id])) ? h : null;
  }, 80_000, 1_000);
  const h1 = done || await history();
  const counts = due.map((d) => h1.filter((m) => m.content === byId[d.id]).length);
  const sentFlags = cluster.psql(`SELECT count(*) FROM scheduled_msgs WHERE sent AND _id IN (${due.map((d) => `'${d.id}'`).join(',')})`);
  record('JOB-01', `${K} due schedules raced by 3 nodes' workers: each dispatched exactly once`,
    counts.every((c) => c === 1) && Number(sentFlags) === K ? 'PASS' : 'FAIL', `durable counts=${JSON.stringify(counts)} sent=${sentFlags}`);
  if (done) measure('jobs.scheduled_dispatch_all_ms', Date.now() - t0, 'ms', 'create (due +3s) → all 10 durable; bounded by the 30s worker interval');
  await sleep(1_000);
  const dupLive = [...live.values()].filter((n) => n > 1).length;
  record('JOB-02', 'scheduled dispatch fan-out: no duplicate live events', dupLive === 0 ? 'PASS' : 'FAIL', `duplicated=${dupLive}`);

  // ── 2. owner died after claim (lease abandoned) ──────────────────────────
  const s1 = await schedule('A', `sched-orphan-${rnd()}`, 600_000);
  const c1 = cluster.psql(`SELECT content FROM scheduled_msgs WHERE _id='${s1}'`);
  const leaseEnd = Date.now() + 20_000;
  cluster.psql(`UPDATE scheduled_msgs SET "sendAt"=${Date.now() - 1000}, "claimOwner"='scheduled:crashed-worker', "claimUntil"=${leaseEnd}, "dispatchAttempts"=1 WHERE _id='${s1}'`);
  const early = await waitUntil(async () => (await history()).some((m) => m.content === c1), leaseEnd - Date.now() - 1_000, 1_000);
  const recovered = await waitUntil(async () => (await history()).some((m) => m.content === c1) ? Date.now() : null, 75_000, 500);
  const n1 = (await history()).filter((m) => m.content === c1).length;
  record('JOB-03', 'schedule claimed by a crashed worker: untouched while the lease is valid, then dispatched exactly once',
    !early && recovered && n1 === 1 ? 'PASS' : 'FAIL', `during-lease=${!!early} recovered=${!!recovered} durable=${n1}`);
  if (recovered) measure('jobs.scheduled_lease_recovery_ms', recovered - leaseEnd, 'ms', 'lease expiry → dispatched by a live node (≤ 30s worker interval)');

  // ── 3. owner died after the effect, before finalizing ────────────────────
  const s2 = await schedule('B', `sched-halfdone-${rnd()}`, 600_000);
  const c2 = cluster.psql(`SELECT content FROM scheduled_msgs WHERE _id='${s2}'`);
  const ownerSock = await connectSocket(url('A'), owner.token);
  ownerSock.emit('channel:join', channelId);
  await sleep(300);
  const ack = await sendMessage(ownerSock, { channelId, serverId, content: c2, ackId: `half-${rnd()}` });
  cluster.psql(`UPDATE messages SET "scheduledId"='${s2}' WHERE _id='${ack.messageId}'`);
  const lease2 = Date.now() + 5_000;
  cluster.psql(`UPDATE scheduled_msgs SET "sendAt"=${Date.now() - 1000}, "claimOwner"='scheduled:crashed-worker', "claimUntil"=${lease2}, "dispatchAttempts"=1 WHERE _id='${s2}'`);
  const finalized = await waitUntil(async () => cluster.psql(`SELECT sent FROM scheduled_msgs WHERE _id='${s2}'`) === 't', 75_000, 1_000);
  const n2 = Number(cluster.psql(`SELECT count(*) FROM messages WHERE "scheduledId"='${s2}'`));
  record('JOB-04', 'crash after the message was written but before finalize: recovery reuses it (no duplicate)',
    finalized && n2 === 1 ? 'PASS' : 'FAIL', `finalized=${!!finalized} messagesWithScheduledId=${n2}`);
  ownerSock.close();

  // ── 4. outgoing webhook: 3 competing delivery workers ────────────────────
  const sink = await startSink();
  try {
    const wh = await mutate(url('A'), 'POST', `/api/servers/${serverId}/outgoing-webhooks`, owner.token,
      { name: 'mn-sink', url: `http://localhost:${SINK_PORT}/hook`, events: ['message:new'] });
    if (wh.status >= 300) throw new Error(`webhook create ${wh.status} ${JSON.stringify(wh.body)}`);
    const senders = {};
    for (const n of ['A', 'B', 'C']) {
      senders[n] = await connectSocket(url(n), owner.token);
      senders[n].emit('channel:join', channelId);
    }
    await sleep(400);
    const M = 9;
    const sent = [];
    for (let i = 0; i < M; i++) {
      const content = `wh-${i}-${rnd()}`;
      const a = await sendMessage(senders['ABC'[i % 3]], { channelId, serverId, content, ackId: `wh-${rnd()}` });
      sent.push({ content, id: a?.messageId });
      await sleep(900); // anti-spam policy: 5 messages / 4 s
    }
    await waitUntil(() => sent.every((s) => sink.hits.some((h) => h.body?.message?._id === s.id || h.body?._id === s.id || JSON.stringify(h.body).includes(s.id))), 30_000);
    const perMsg = sent.map((s) => sink.hits.filter((h) => JSON.stringify(h.body).includes(s.id)).length);
    const deliveries = new Set(sink.hits.map((h) => h.delivery)).size;
    record('JOB-05', `${M} message events, 3 competing webhook workers: each delivered exactly once`,
      perMsg.every((n) => n === 1) && deliveries === sink.hits.length ? 'PASS' : 'FAIL', `per-message=${JSON.stringify(perMsg)} hits=${sink.hits.length} distinctDeliveryIds=${deliveries}`);

    // Delivery owner dies while the receiver is holding the request (the
    // effect reached the receiver; the worker never records completion).
    sink.hang(1);
    const before = sink.hits.length;
    const content = `wh-kill-${rnd()}`;
    const a = await sendMessage(senders.C, { channelId, serverId, content, ackId: `whk-${rnd()}` });
    const held = await waitUntil(() => sink.hits.slice(before).find((h) => JSON.stringify(h.body).includes(a.messageId)), 20_000, 100);
    let killedNode = null;
    if (held) {
      const pids = pidForPeerPort(held.remotePort);
      for (const [name, node] of cluster.nodes) if (pids.includes(node.proc.pid)) killedNode = name;
      if (killedNode) await cluster.killNode(killedNode, 'SIGKILL');
    }
    const killedAt = Date.now();
    const redelivered = await waitUntil(() => {
      const hits = sink.hits.filter((h) => JSON.stringify(h.body).includes(a.messageId));
      return hits.length >= 2 ? hits : null;
    }, 200_000, 1_000);
    const sameId = redelivered && new Set(redelivered.map((h) => h.delivery)).size === 1;
    record('JOB-06', 'webhook owner killed mid-delivery: redelivered by a live node with the SAME X-Bridge-Delivery id (at-least-once, dedupable)',
      held && killedNode && redelivered && sameId ? 'PASS' : 'FAIL',
      `held=${!!held} killed=${killedNode} redeliveries=${redelivered?.length ?? 0} sameDeliveryId=${sameId}`);
    if (redelivered) measure('jobs.webhook_redelivery_after_owner_death_ms', redelivered.at(-1).at - killedAt, 'ms', 'SIGKILL of the delivering node → redelivery (120s lease + 5s poll)');
    for (const s of Object.values(senders)) s.close();
    if (killedNode) await cluster.startNode(killedNode); // three competitors again

    // ── 5. ActivityPub retry queue: 3 competing workers ──────────────────
    const Q = 12;
    const qids = [];
    for (let i = 0; i < Q; i++) {
      const id = `mnq-${i}-${rnd()}`;
      qids.push(id);
      const payload = JSON.stringify({ inboxUrl: `http://localhost:${SINK_PORT}/inbox`, activity: { id: `urn:mn:${id}`, type: 'Create' }, fromUser: null }).replace(/'/g, "''");
      cluster.psql(`INSERT INTO ap_delivery_queue (_id, payload, attempts, "nextAt", "createdAt") VALUES ('${id}', '${payload}'::jsonb, 1, ${Date.now() - 1000}, ${Date.now()})`);
    }
    await waitUntil(() => qids.every((id) => sink.hits.some((h) => h.path === '/inbox' && JSON.stringify(h.body).includes(`urn:mn:${id}`))), 80_000, 1_000);
    const remaining = () => Number(cluster.psql(`SELECT count(*) FROM ap_delivery_queue WHERE _id IN (${qids.map((i) => `'${i}'`).join(',')})`));
    const drained = await waitUntil(() => remaining() === 0, 15_000, 250);
    const leftRows = cluster.psql(`SELECT _id || ' attempts=' || attempts || ' owner=' || coalesce("claimOwner",'-') FROM ap_delivery_queue WHERE _id IN (${qids.map((i) => `'${i}'`).join(',')})`);
    // A row left behind after a successful delivery would be re-sent by the
    // next worker cycle; watch one full cycle for any late duplicate.
    await sleep(35_000);
    const perAct = qids.map((id) => sink.hits.filter((h) => h.path === '/inbox' && JSON.stringify(h.body).includes(`urn:mn:${id}`)).length);
    const left = remaining();
    record('JOB-07a', 'ActivityPub queue rows left after all deliveries succeeded', 'INFO', `drained=${!!drained} rows=${JSON.stringify(leftRows)}`);
    record('JOB-07', `${Q} due ActivityPub retries raced by 3 nodes (SKIP LOCKED): each delivered exactly once, queue drained`,
      perAct.every((n) => n === 1) && left === 0 ? 'PASS' : 'FAIL', `per-activity=${JSON.stringify(perAct)} remainingRows=${left}`);
  } finally {
    await sink.close();
    watchSock.close();
  }
}
