// Abrupt node death (SIGKILL) with active clients and in-flight work.
// NOTE: SIGKILL of a process lets the kernel close its TCP sockets, so clients
// notice immediately. A host/network partition is detected only by Socket.IO's
// ping timeout (pingInterval + pingTimeout); that case is not measured here.

import {
  register, makeServer, connectSocket, connectSocketLB, collect, nextEvent, request, rnd, uploadChunk, mutate,
} from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function run({ cluster, lb, record, measure }) {
  const url = (n) => cluster.nodeUrl(n);
  const alice = await register(url('B'), 'nd');
  const bob = await register(url('A'), 'nd');
  const carol = await register(url('C'), 'nd');
  const { serverId, channelId } = await makeServer(url('B'), alice, [bob, carol]);

  const aliceS = await connectSocket(url('B'), alice.token);
  const carolS = await connectSocket(url('C'), carol.token);
  const bobS = await connectSocketLB(lb, bob.token, { prefer: 'A' });
  for (const s of [aliceS, carolS, bobS]) s.emit('channel:join', channelId);
  await sleep(400);

  // ── pre-death quota state: bob holds the maximum chunk sessions via A ────
  let preQuota = 0;
  for (let i = 0; i < 4; i++) {
    const r = await uploadChunk(url('A'), bob.token, { uploadId: `nd-${i}-${rnd()}`, index: 0, total: 2, body: Buffer.alloc(16, 1) });
    if (r.status === 200) preQuota += 1;
  }

  // ── in-flight message burst; node A dies mid-burst ───────────────────────
  // Anti-spam policy is 5 messages / 4 s per user; a human-rate stream of one
  // message per second stays within product policy on both sides of the kill.
  const N = 12;
  const outbox = new Map(); // ackId -> content, removed when acked
  const acked = new Map();
  bobS.on('message:ack', (a) => { if (outbox.has(a.ackId)) { acked.set(a.ackId, a.messageId); outbox.delete(a.ackId); } });
  const seenByAlice = new Map();
  aliceS.on('message:new', (m) => { if (String(m?.content || '').startsWith('nd-burst-')) seenByAlice.set(m.content, (seenByAlice.get(m.content) || 0) + 1); });
  const contents = [];
  let killedAt = 0;
  for (let i = 0; i < N; i++) {
    const ackId = `ndb-${i}-${rnd()}`;
    const content = `nd-burst-${i}-${rnd()}`;
    contents.push(content);
    outbox.set(ackId, content);
    bobS.emit('message:send', { channelId, serverId, content, ackId });
    if (i === 4) {
      killedAt = Date.now();
      await cluster.killNode('A', 'SIGKILL');
    }
    await sleep(1_000);
  }

  // Client retry semantics: after re-authenticating on a live node, re-join
  // and re-send every un-acked message with its ORIGINAL ackId.
  await (async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !bobS.authentications.some((t) => t > killedAt)) await sleep(20);
  })();
  const reauth = bobS.authentications.find((t) => t > killedAt);
  record('ND-01', 'client on the killed node re-authenticates through the LB on a surviving node',
    reauth ? 'PASS' : 'FAIL', reauth ? `${reauth - killedAt}ms after SIGKILL` : 'never');
  if (reauth) measure('failover.client_reconnect_ms', reauth - killedAt, 'ms', 'SIGKILL node A → socket re-authenticated on B/C via LB');
  bobS.emit('channel:join', channelId);
  await sleep(300);
  // message:send is limited to RL_SOCK_MSG_MAX (20) per 10 s per user, one
  // budget for the whole cluster. A well-behaved client paces its retries.
  let rateLimited = 0;
  bobS.on('error:ratelimit', () => { rateLimited += 1; });
  const rejections = {};
  bobS.onAny((event, payload) => {
    if (/^(error|warn):/.test(event)) {
      const key = `${event}${payload?.reason ? `(${payload.reason})` : ''}${payload?.code ? `[${payload.code}]` : ''}`;
      rejections[key] = (rejections[key] || 0) + 1;
    }
  });
  const allAckedDeadline = Date.now() + 45_000;
  while (outbox.size && Date.now() < allAckedDeadline) {
    for (const [ackId, content] of [...outbox]) {
      if (!outbox.has(ackId)) continue;
      bobS.emit('message:send', { channelId, serverId, content, ackId });
      await sleep(1_000);
    }
    await sleep(1_000);
  }
  measure('failover.retry_rate_limited_events', rateLimited, 'count', 'error:ratelimit seen while re-sending (socket.io also flushes its offline buffer on reconnect)');
  record('ND-02a', 'server rejections seen by the retrying client', 'INFO', JSON.stringify(rejections));
  if (!outbox.size) measure('failover.all_messages_acked_ms', Date.now() - killedAt, 'ms', 'SIGKILL → every in-flight send acknowledged after client retry');
  await sleep(1_500);

  const history = await request(url('C'), 'GET', `/api/channels/${channelId}/messages?limit=100`, { token: carol.token });
  const rows = Array.isArray(history.body) ? history.body : history.body?.messages || [];
  const durable = contents.map((c) => rows.filter((m) => m.content === c).length);
  const lost = durable.filter((n) => n === 0).length;
  const dups = durable.filter((n) => n > 1).length;
  record('ND-02', `in-flight stream of ${N} sends (1/s) across node death: no durable loss, no durable duplicates`,
    outbox.size === 0 && lost === 0 && dups === 0 ? 'PASS' : 'FAIL', `unacked=${outbox.size} lost=${lost} duplicated=${dups}`);
  const liveDup = [...seenByAlice.values()].filter((n) => n > 1).length;
  const liveMissed = contents.filter((c) => !seenByAlice.has(c)).length;
  record('ND-03', 'live delivery to an observer on B across the failover: no duplicates',
    liveDup === 0 ? 'PASS' : 'FAIL', `duplicated live events=${liveDup}; missed live events=${liveMissed} (durable history is authoritative)`);
  record('ND-04', 'live events missed by observers during node death (committed on A, broadcast lost with A)', 'INFO',
    `${liveMissed}/${N} — at-most-once realtime; clients recover from durable history on reconnect/refetch`);

  // ── auth + quota authority after failover ────────────────────────────────
  const meB = await request(url('B'), 'GET', '/api/me', { token: bob.token });
  record('ND-05', 'access token keeps working on surviving nodes after its issuing node died', meB.status === 200 ? 'PASS' : 'FAIL', `B ${meB.status}`);
  const fifth = await uploadChunk(url('B'), bob.token, { uploadId: `nd-5-${rnd()}`, index: 0, total: 2, body: Buffer.alloc(16, 1) });
  record('ND-06', 'chunk-session quota taken on dead node A still binds on B (Redis authority, no reset on node death)',
    preQuota === 4 && fifth.status === 429 ? 'PASS' : 'FAIL', `sessions via A=${preQuota}; 5th via B → ${fifth.status} ${fifth.body?.code || ''}`);

  // ── presence after node death ────────────────────────────────────────────
  // Bob's socket on A was never cleaned up by A. When his replacement socket
  // closes, observers should see him offline — once the dead socket's
  // presence entry is recognised as stale.
  const offline = nextEvent(aliceS, 'user:status', (p) => p?.userId === bob.id && p?.status === 'offline', 120_000);
  const t0 = Date.now();
  bobS.io.opts.reconnection = false;
  bobS.close();
  const off = await offline;
  record('ND-07', 'user whose previous node died is eventually shown offline after the replacement socket closes',
    off ? 'PASS' : 'FAIL', off ? `${Date.now() - t0}ms` : 'not within 120s');
  if (off) measure('failover.presence_offline_after_dead_node_ms', Date.now() - t0, 'ms', 'includes stale-socket expiry of the dead node');
  const status = await request(url('C'), 'GET', `/api/users/${bob.id}`, { token: carol.token });
  record('ND-08', 'presence read after node death', 'INFO', `GET /api/users/:id status=${status.body?.status}`);

  // ── restore A: rejoin without corrupting shared state ────────────────────
  const tr = Date.now();
  await cluster.startNode('A');
  measure('failover.node_restart_ready_ms', Date.now() - tr, 'ms', 'process start → /api/health/ready 200');
  const bob2 = await connectSocket(url('A'), bob.token);
  bob2.emit('channel:join', channelId);
  await sleep(300);
  const c = `nd-after-${rnd()}`;
  const got = Promise.all([aliceS, carolS].map((s) => collect(s, 'message:new', (m) => m?.content === c, 2_000)));
  const ack = nextEvent(bob2, 'message:ack', () => true, 5_000);
  bob2.emit('message:send', { channelId, serverId, content: c, ackId: `nda-${rnd()}` });
  const [ga, gc] = await got;
  record('ND-09', 'restored node A serves traffic and fans out to B and C exactly once',
    (await ack) && ga.length === 1 && gc.length === 1 ? 'PASS' : 'FAIL', `B=${ga.length} C=${gc.length}`);
  const quotaAfter = await uploadChunk(url('A'), bob.token, { uploadId: `nd-6-${rnd()}`, index: 0, total: 2, body: Buffer.alloc(16, 1) });
  record('ND-10', 'restarted node A does not reset the shared chunk quota', quotaAfter.status === 429 ? 'PASS' : 'FAIL', `A → ${quotaAfter.status}`);
  bob2.close(); aliceS.close(); carolS.close();
  void mutate;
}
