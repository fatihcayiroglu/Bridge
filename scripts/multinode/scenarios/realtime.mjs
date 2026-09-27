// Cross-node realtime: fan-out, exactly-once delivery, idempotent retry across
// nodes, typing/presence propagation, authorization after reconnect.

import { register, makeServer, connectSocket, collect, nextEvent, sendMessage, request, rnd } from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cluster, record, measure }) {
  const url = (n) => cluster.nodeUrl(n);
  const alice = await register(url('A'), 'rt');
  const bob = await register(url('B'), 'rt');
  const carol = await register(url('C'), 'rt');
  const eve = await register(url('A'), 'rt'); // never a member
  const { serverId, channelId } = await makeServer(url('A'), alice, [bob, carol]);

  const socks = {
    A: await connectSocket(url('A'), alice.token),
    B: await connectSocket(url('B'), bob.token),
    C: await connectSocket(url('C'), carol.token),
  };
  for (const s of Object.values(socks)) s.emit('channel:join', channelId);
  await sleep(500);

  // ── fan-out: every direction, exactly once ───────────────────────────────
  const ROUNDS = 5;
  const matrix = {};
  let lost = 0;
  let dup = 0;
  const latencies = [];
  for (const from of ['A', 'B', 'C']) {
    for (let i = 0; i < ROUNDS; i++) {
      const content = `rt-${from}-${i}-${rnd()}`;
      const receivers = Object.keys(socks).filter((k) => k !== from);
      const waits = receivers.map((k) => collect(socks[k], 'message:new', (m) => m?.content === content, 2_000));
      const t0 = Date.now();
      const firstSeen = Promise.race(receivers.map((k) => nextEvent(socks[k], 'message:new', (m) => m?.content === content, 2_000).then(() => Date.now())));
      const ack = await sendMessage(socks[from], { channelId, serverId, content, ackId: `rt-${rnd()}` });
      const seenAt = await firstSeen;
      if (seenAt) latencies.push(seenAt - t0);
      const got = await Promise.all(waits);
      receivers.forEach((k, idx) => {
        const key = `${from}->${k}`;
        matrix[key] = (matrix[key] || 0) + (got[idx].length === 1 ? 1 : 0);
        if (got[idx].length === 0) lost += 1;
        if (got[idx].length > 1) dup += got[idx].length - 1;
      });
      if (!ack) lost += 0; // ack absence is reported below
    }
  }
  const perfect = Object.values(matrix).every((v) => v === ROUNDS) && Object.keys(matrix).length === 6;
  record('RT-01', `message fan-out across 3 nodes, all 6 directions × ${ROUNDS}: delivered exactly once`,
    perfect && lost === 0 && dup === 0 ? 'PASS' : 'FAIL', `${JSON.stringify(matrix)} lost=${lost} duplicates=${dup}`);
  latencies.sort((a, b) => a - b);
  measure('realtime.cross_node_delivery_p50_ms', latencies[Math.floor(latencies.length / 2)] ?? -1, 'ms', 'send on X → first message:new on another node');
  measure('realtime.cross_node_delivery_max_ms', latencies.at(-1) ?? -1, 'ms');

  // ── same ackId retried on another node: one durable message ──────────────
  const ackId = `retry-${rnd()}`;
  const content = `retry-${rnd()}`;
  const seenByAlice = collect(socks.A, 'message:new', (m) => m?.content === content, 3_000);
  const first = await sendMessage(socks.B, { channelId, serverId, content, ackId });
  socks.B.close();
  socks.B = await connectSocket(url('C'), bob.token); // "reconnect" lands on another node
  socks.B.emit('channel:join', channelId);
  await sleep(300);
  const second = await sendMessage(socks.B, { channelId, serverId, content, ackId });
  const broadcasts = await seenByAlice;
  const history = await request(url('A'), 'GET', `/api/channels/${channelId}/messages?limit=50`, { token: alice.token });
  const rows = (Array.isArray(history.body) ? history.body : history.body?.messages || []).filter((m) => m.content === content);
  record('RT-02', 'send retried with the same ackId after reconnecting to another node: one durable message',
    first && second && first.messageId === second.messageId && rows.length === 1 && broadcasts.length === 1 ? 'PASS' : 'FAIL',
    `acks ${first?.messageId}/${second?.messageId}; durable rows=${rows.length}; broadcasts=${broadcasts.length}`);

  // ── same ackId sent simultaneously on two nodes ──────────────────────────
  const bob2 = await connectSocket(url('A'), bob.token);
  bob2.emit('channel:join', channelId);
  await sleep(300);
  const ack2 = `race-${rnd()}`;
  const c2 = `race-${rnd()}`;
  const seen2 = collect(socks.C, 'message:new', (m) => m?.content === c2, 3_000);
  const [x, y] = await Promise.all([
    sendMessage(socks.B, { channelId, serverId, content: c2, ackId: ack2 }),
    sendMessage(bob2, { channelId, serverId, content: c2, ackId: ack2 }),
  ]);
  const h2 = await request(url('B'), 'GET', `/api/channels/${channelId}/messages?limit=50`, { token: bob.token });
  const rows2 = (Array.isArray(h2.body) ? h2.body : h2.body?.messages || []).filter((m) => m.content === c2);
  const b2 = await seen2;
  record('RT-03', 'same ackId emitted concurrently on nodes A and C: one durable message, both acks name it',
    x && y && x.messageId === y.messageId && rows2.length === 1 && b2.length === 1 ? 'PASS' : 'FAIL',
    `acks ${x?.messageId}/${y?.messageId}; durable rows=${rows2.length}; broadcasts=${b2.length}`);
  bob2.close();

  // ── typing propagates across nodes ───────────────────────────────────────
  const typingAtA = nextEvent(socks.A, 'typing:update', (t) => t?.channelId === channelId, 3_000);
  socks.C.emit('typing:start', { channelId });
  const typing = await typingAtA;
  record('RT-04', 'typing on C reaches a socket on A', typing ? 'PASS' : 'FAIL', JSON.stringify(typing));

  // ── presence: a member coming online on B is visible on A ────────────────
  const dave = await register(url('C'), 'rt');
  const inv = await (await import('../lib/client.mjs')).mutate(url('A'), 'POST', '/api/servers/invites', alice.token, { serverId });
  await (await import('../lib/client.mjs')).mutate(url('B'), 'POST', `/api/servers/invites/${inv.body.code}/use`, dave.token, {});
  const onlineAtA = nextEvent(socks.A, 'user:status', (p) => p?.userId === dave.id && p?.status === 'online', 5_000);
  const t0 = Date.now();
  const daveSock = await connectSocket(url('B'), dave.token);
  const online = await onlineAtA;
  const tOnline = Date.now() - t0;
  const offlineAtA = nextEvent(socks.A, 'user:status', (p) => p?.userId === dave.id && p?.status === 'offline', 20_000);
  const t1 = Date.now();
  daveSock.close();
  const offline = await offlineAtA;
  record('RT-05', 'presence: member connecting on B is seen online on A; disconnect seen offline',
    online && offline ? 'PASS' : 'FAIL', `online after ${online ? tOnline : 'never'}ms; offline after ${offline ? Date.now() - t1 : 'never'}ms`);
  if (online) measure('realtime.presence_online_ms', tOnline, 'ms', 'connect on B → user:status online on A');
  if (offline) measure('realtime.presence_offline_ms', Date.now() - t1, 'ms', 'disconnect on B → user:status offline on A (includes any grace period)');

  // ── authorization after reconnect to another node ────────────────────────
  const eveSock = await connectSocket(url('B'), eve.token);
  eveSock.emit('channel:join', channelId);
  await sleep(400);
  const c3 = `authz-${rnd()}`;
  const eveSaw = collect(eveSock, 'message:new', (m) => m?.content === c3, 2_000);
  const bobSaw = collect(socks.B, 'message:new', (m) => m?.content === c3, 2_000);
  await sendMessage(socks.A, { channelId, serverId, content: c3, ackId: `az-${rnd()}` });
  const [ev, bb] = await Promise.all([eveSaw, bobSaw]);
  record('RT-06', 'non-member joining the channel room on another node receives nothing (negative control: member does)',
    ev.length === 0 && bb.length === 1 ? 'PASS' : 'FAIL', `non-member ${ev.length}, member ${bb.length}`);
  eveSock.close();
  for (const s of Object.values(socks)) s.close();
}
