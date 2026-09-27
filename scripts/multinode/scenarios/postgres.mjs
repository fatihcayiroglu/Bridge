// PostgreSQL disruption during real state transitions, through the fault proxy
// that sits between every Bridge node and the database.

import {
  register, login, refresh, makeServer, connectSocket, nextEvent, collect, request, mutate, rnd, fakeIp,
} from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(fn, ms, step = 250) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { const v = await fn(); if (v) return v; await sleep(step); }
  return null;
}

export async function run({ cluster, record, measure }) {
  const url = (n) => cluster.nodeUrl(n);
  const pg = cluster.pgProxy;
  const u = await register(url('A'), 'pg');
  // Readiness first (unauthenticated, not charged to the account budget), then
  // ONE authenticated read per node: polling /api/me in a tight loop exhausts
  // the account's own global quota (200/window) and turns recovery into 429s.
  const allOk = async () => {
    const ready = await Promise.all(['A', 'B', 'C'].map((n) => fetch(`${url(n)}/api/health/ready`).then((r) => r.status).catch(() => 0)));
    if (!ready.every((s) => s === 200)) return false;
    const rs = await Promise.all(['A', 'B', 'C'].map((n) => request(url(n), 'GET', '/api/me', { token: u.token, ip: fakeIp() }).catch(() => ({ status: 0 }))));
    return rs.every((r) => r.status === 200);
  };
  const alive = () => ['A', 'B', 'C'].filter((n) => cluster.nodes.get(n) && !cluster.nodes.get(n).exited);

  // ── 1. database crash (immediate shutdown) and restart ───────────────────
  cluster.stopPostgres('immediate');
  const during = await request(url('B'), 'GET', '/api/me', { token: u.token, ip: fakeIp() });
  const ready = (await fetch(`${url('B')}/api/health/ready`)).status;
  const live = (await fetch(`${url('B')}/api/health/live`)).status;
  record('PG-01', 'database down: authenticated API refuses (no stale-auth success), readiness 503, liveness 200',
    during.status >= 500 && ready === 503 && live === 200 ? 'PASS' : 'FAIL', `api=${during.status} ready=${ready} live=${live}`);
  await sleep(2_000);
  record('PG-01b', 'database down: no Bridge process crashes (every node survives the outage)',
    alive().length === 3 ? 'PASS' : 'FAIL', `alive=${alive().join(',')}`);
  const tr = Date.now();
  cluster.restartPostgres();
  const back = await waitUntil(allOk, 60_000);
  record('PG-02', 'database restarted: all nodes recover without a Bridge restart', back ? 'PASS' : 'FAIL', `${Date.now() - tr}ms`);
  if (back) measure('postgres.restart_recovery_ms', Date.now() - tr, 'ms', 'pg_ctl start → /api/me 200 on A, B and C');

  // ── 2. every pooled connection severed (network blip) ────────────────────
  pg.cutAll();
  const tc = Date.now();
  const results = [];
  for (let i = 0; i < 30; i++) results.push((await request(url('ABC'[i % 3]), 'GET', '/api/me', { token: u.token, ip: fakeIp() })).status);
  const failed = results.filter((s) => s !== 200).length;
  const recovered = await waitUntil(allOk, 30_000);
  record('PG-03', 'all DB connections severed: pools reconnect; failures are bounded and recover without restart',
    recovered ? 'PASS' : 'FAIL', `failed ${failed}/30 immediately after the cut; recovered in ${Date.now() - tc}ms`);
  measure('postgres.connection_cut_failed_requests', failed, 'count', 'of 30 requests right after severing every pooled connection');

  // ── 3. refresh rotation: COMMIT reached the server, reply lost ───────────
  {
    const ip = fakeIp();
    const s = await login(url('A'), u, ip);
    const tf = pg.armTargeted({ match: /refresh_tokens/, onCommit: true, mode: 'reply-lost' });
    const r = await refresh(url('B'), s.refresh, ip);
    const fired = tf.fired > 0;
    await sleep(300);
    const family = cluster.psql(`SELECT count(*) || '/' || count(*) FILTER (WHERE used) FROM refresh_tokens WHERE family = (SELECT family FROM refresh_tokens WHERE "userId"='${u.id}' ORDER BY "createdAt" DESC LIMIT 1)`);
    const retry = await refresh(url('C'), s.refresh, ip);
    const after = cluster.psql(`SELECT count(*) FROM refresh_tokens WHERE "userId"='${u.id}' AND NOT used`);
    // Consistent outcomes only: the rotation committed as a whole (old used +
    // successor present), and the blind retry is treated as replay.
    record('PG-04', 'refresh COMMIT reply lost: rotation is all-or-nothing; the blind retry is a replay that revokes the family (fail closed)',
      fired && r.status >= 500 && family === '2/1' && retry.status === 401 && retry.body?.reason === 'reuse' ? 'PASS' : 'FAIL',
      `fired=${fired} first=${r.status} family(rows/used)=${family} retry=${retry.status} ${retry.body?.reason} liveTokensAfter=${after}`);
    record('PG-04i', 'user impact of an ambiguous refresh', 'INFO', 'session must re-login (documented replay contract; security over availability)');
  }
  {
    const ip = fakeIp();
    const s = await login(url('A'), u, ip);
    const tf = pg.armTargeted({ match: /refresh_tokens/, onCommit: true, mode: 'fail' });
    const r = await refresh(url('B'), s.refresh, ip);
    await sleep(300);
    const retry = await refresh(url('C'), s.refresh, ip);
    record('PG-05', 'refresh transaction lost BEFORE COMMIT: rolled back, the same token rotates on retry (no lockout, no half state)',
      tf.fired > 0 && r.status >= 500 && retry.status === 200 ? 'PASS' : 'FAIL', `first=${r.status} retry=${retry.status}`);
  }

  // ── 4. message INSERT committed, reply lost ──────────────────────────────
  // The send handler resolves a failed INSERT against the durable (userId,
  // ackId) row, so the ambiguity is settled server-side; a client retry with
  // the same ackId must converge on the same single row either way.
  {
    const owner = await register(url('A'), 'pg');
    const peer = await register(url('A'), 'pg');
    const { serverId, channelId } = await makeServer(url('A'), owner, [peer]);
    const sock = await connectSocket(url('B'), owner.token);
    const obs = await connectSocket(url('C'), peer.token);
    sock.emit('channel:join', channelId);
    obs.emit('channel:join', channelId);
    await sleep(300);
    const ackId = `pg-${rnd()}`;
    const content = `pg-ambiguous-${rnd()}`;
    const live = collect(obs, 'message:new', (m) => m?.content === content, 12_000);
    const tf = pg.armTargeted({ match: /INSERT INTO "?messages"? /i, mode: 'reply-lost' });
    const firstAck = nextEvent(sock, 'message:ack', (a) => a?.ackId === ackId, 4_000);
    sock.emit('message:send', { channelId, serverId, content, ackId });
    const a1 = await firstAck;
    let a2 = null;
    for (let i = 0; i < 5 && !a2; i++) {
      await sleep(1_000);
      const p = nextEvent(sock, 'message:ack', (a) => a?.ackId === ackId, 3_000);
      sock.emit('message:send', { channelId, serverId, content, ackId });
      a2 = await p;
    }
    const rows = cluster.psql(`SELECT string_agg(_id, ',') FROM messages WHERE content='${content}'`).split(',').filter(Boolean);
    const acksAgree = [a1, a2].filter(Boolean).every((a) => a.messageId === rows[0]);
    record('PG-06', 'message INSERT committed but reply lost: exactly one durable row; every ack (first and retry) names that row',
      tf.fired > 0 && rows.length === 1 && a2 && acksAgree ? 'PASS' : 'FAIL',
      `fired=${tf.fired > 0} firstAck=${a1 ? 'canonical' : 'none'} retryAck=${a2 ? 'canonical' : 'none'} acksAgree=${acksAgree} durableRows=${rows.length}`);
    const seen = await live;
    record('PG-06r', 'live fan-out of a message whose INSERT committed ambiguously: observers receive it exactly once',
      seen.length === 1 ? 'PASS' : 'FAIL', `observer message:new events=${seen.length}`);
    sock.close(); obs.close();
  }

  // ── 5. job claim committed, reply lost: owner never learns it holds it ───
  {
    const owner = await register(url('A'), 'pg');
    const { serverId, channelId } = await makeServer(url('A'), owner);
    const content = `pg-sched-${rnd()}`;
    const sc = await mutate(url('A'), 'POST', '/api/scheduled', owner.token,
      { channelId, serverId, content, sendAt: new Date(Date.now() + 2_000).toISOString() });
    const tf = pg.armTargeted({ match: /scheduled_msgs/, onCommit: true, mode: 'reply-lost' });
    const armedAt = Date.now();
    const fired = await waitUntil(() => tf.fired > 0, 40_000, 200);
    const done = await waitUntil(() => Number(cluster.psql(`SELECT count(*) FROM messages WHERE content='${content}'`)) > 0 ? Date.now() : null, 200_000, 1_000);
    const n = Number(cluster.psql(`SELECT count(*) FROM messages WHERE content='${content}'`));
    record('PG-07', 'scheduled claim COMMIT reply lost: the orphaned lease expires and the message is dispatched exactly once',
      sc.status < 300 && fired && done && n === 1 ? 'PASS' : 'FAIL', `claimFaulted=${!!fired} dispatched=${!!done} durable=${n}`);
    if (done && fired) measure('postgres.orphaned_claim_recovery_ms', done - tf.fired, 'ms', 'ambiguous claim → dispatched (120s lease + ≤30s poll)');
    void armedAt;
  }

  // Every targeted fault above severs a connection that a node had CHECKED OUT
  // of its pool mid-transaction — the exact state that crashed a node in PG-01.
  record('PG-08', 'no Bridge process crashed across every PostgreSQL fault in this scenario',
    alive().length === 3 ? 'PASS' : 'FAIL', `alive=${alive().join(',')} faults=${JSON.stringify(pg.stats)}`);
}
