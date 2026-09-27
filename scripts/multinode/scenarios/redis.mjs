// Redis failure modes against a live 3-node cluster. Redis is the configured
// authority (REDIS_URL set) for rate limits, CSRF, chunk quota, WebAuthn
// challenges, presence, voice rooms, SFU ownership and cross-node Socket.IO.
//
// Modes:  A refused (process gone)   B live connections killed
//         C writes rejected (-OOM)   D hung server (SIGSTOP: TCP up, no replies)
//         E corrupt authoritative state (wrong key type)
// After every mode Redis is restored and recovery is measured WITHOUT
// restarting any Bridge node.

import {
  register, login, makeServer, connectSocket, collect, nextEvent, request, csrfToken, uploadChunk, rnd, mutate, fakeIp,
} from '../lib/client.mjs';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

async function timed(fn, budgetMs = 10_000) {
  const t0 = Date.now();
  try {
    const v = await Promise.race([fn(), sleep(budgetMs).then(() => ({ status: 'TIMEOUT' }))]);
    return { ...v, ms: Date.now() - t0 };
  } catch (err) {
    return { status: `ERR:${err.code || err.message}`, ms: Date.now() - t0 };
  }
}

export async function run({ cluster, record, measure }) {
  const url = (n) => cluster.nodeUrl(n);
  const alice = await register(url('A'), 'rd');
  const bob = await register(url('B'), 'rd');
  const { serverId, channelId } = await makeServer(url('A'), alice, [bob]);
  let aliceS = await connectSocket(url('A'), alice.token);
  let bobS = await connectSocket(url('B'), bob.token);
  aliceS.emit('channel:join', channelId);
  bobS.emit('channel:join', channelId);
  await sleep(400);
  // Redis restarted EMPTY loses every shared WS connection lease; each socket
  // is then dropped at its next lease heartbeat (connection-limit authority
  // fails closed). Real clients reconnect; so does this probe, and it counts.
  let droppedSockets = 0;
  const tapErrors = (sock) => sock.onAny((event, payload) => { if (/^(error|warn):/.test(event)) senderErrors.push(`${event}${payload?.reason ? `(${payload.reason})` : ''}`); });
  async function ensureSockets() {
    if (!aliceS.connected) {
      droppedSockets += 1;
      aliceS = await connectSocket(url('A'), alice.token).catch(() => aliceS);
      aliceS.emit('channel:join', channelId);
      tapErrors(aliceS);
    }
    if (!bobS.connected) {
      droppedSockets += 1;
      bobS = await connectSocket(url('B'), bob.token).catch(() => bobS);
      bobS.emit('channel:join', channelId);
    }
    await sleep(200);
  }

  // ── WebAuthn challenge: consumed exactly once across nodes ───────────────
  {
    const begin = await mutate(url('A'), 'POST', '/api/webauthn/register/begin', bob.token, {});
    const challenge = begin.body?.challenge;
    const cred = () => ({
      credential: {
        id: b64u(Buffer.from(`cred-${rnd()}`)), rawId: b64u(Buffer.from('x')), type: 'public-key',
        response: {
          clientDataJSON: b64u(JSON.stringify({ type: 'webauthn.create', challenge, origin: 'http://localhost:3100' })),
          attestationObject: b64u(Buffer.from('not-cbor')),
        },
      },
    });
    const [x, y] = await Promise.all([
      mutate(url('B'), 'POST', '/api/webauthn/register/complete', bob.token, cred()),
      mutate(url('C'), 'POST', '/api/webauthn/register/complete', bob.token, cred()),
    ]);
    const expired = [x, y].filter((r) => /Challenge expired/.test(String(r.body?.error))).length;
    record('RD-01', 'WebAuthn challenge issued on A is consumed exactly once when completed concurrently on B and C',
      begin.status === 200 && expired === 1 ? 'PASS' : 'FAIL',
      `begin=${begin.status}; B=${x.status} ${x.body?.error}; C=${y.status} ${y.body?.error}`);
  }

  // A probe set exercised on node B (and cross-node realtime A→B). Each mode
  // uses a fresh identity so per-user budgets (CSRF 20/5 min, spam 5/4 s)
  // consumed by earlier modes cannot masquerade as dependency failures.
  let probeUser = bob;
  const senderErrors = [];
  tapErrors(aliceS);
  async function probes() {
    const ip = fakeIp();
    const out = {};
    out.ready = await timed(async () => ({ status: (await fetch(`${url('B')}/api/health/ready`)).status }));
    out.live = await timed(async () => ({ status: (await fetch(`${url('B')}/api/health/live`)).status }));
    out.api = await timed(() => request(url('B'), 'GET', '/api/me', { token: probeUser.token, ip }));
    const csrf = await timed(() => request(url('B'), 'GET', '/api/csrf-token', { token: probeUser.token, ip }));
    out.csrf = csrf;
    out.login = await timed(() => request(url('C'), 'POST', '/api/login', { body: { username: probeUser.username, password: probeUser.password }, ip }));
    const token = csrf.status === 200 ? csrf.body?.token : null;
    out.webauthn = token
      ? await timed(() => request(url('B'), 'POST', '/api/webauthn/register/begin', { token: probeUser.token, csrf: token, body: {}, ip }))
      : { status: `csrf:${csrf.status}`, ms: 0 };
    out.chunk = token
      ? await timed(() => request(url('B'), 'POST', '/api/upload/chunk', {
        token: probeUser.token, csrf: token, ip, raw: Buffer.alloc(8, 1),
        headers: { 'Content-Type': 'application/octet-stream', 'x-upload-id': `rd-${rnd()}`, 'x-chunk-index': '0', 'x-total-chunks': '2', 'x-file-name': 'f.txt', 'x-file-type': 'text/plain' },
      }))
      : { status: `csrf:${csrf.status}`, ms: 0 };
    out.realtime = await timed(async () => {
      await ensureSockets().catch(() => undefined);
      const content = `rd-${rnd()}`;
      senderErrors.length = 0;
      const seen = nextEvent(bobS, 'message:new', (m) => m?.content === content, 3_000);
      aliceS.emit('message:send', { channelId, serverId, content, ackId: `rd-${rnd()}` });
      const got = await seen;
      return { status: got ? 'DELIVERED' : `NOT_DELIVERED${senderErrors.length ? ` sender:${senderErrors.join(',')}` : ''}` };
    }, 6_000);
    return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, { status: v.status, ms: v.ms }]));
  }
  const freshProbeUser = async () => { probeUser = await register(url('A'), 'rdp'); };

  // Healthy baseline (positive control).
  const base = await probes();
  const baseOk = base.ready.status === 200 && base.api.status === 200 && base.csrf.status === 200
    && base.login.status === 200 && base.webauthn.status === 200 && base.chunk.status === 200 && base.realtime.status === 'DELIVERED';
  record('RD-02', 'healthy baseline: every Redis-backed probe succeeds', baseOk ? 'PASS' : 'FAIL', JSON.stringify(base));

  // Security-owned probes must never succeed without Redis authority.
  const SECURITY = ['api', 'csrf', 'login', 'webauthn', 'chunk'];
  const failOpen = (p) => SECURITY.filter((k) => p[k].status === 200);
  const slow = (p) => Object.entries(p).filter(([, v]) => v.status === 'TIMEOUT').map(([k]) => k);

  async function recovery(label) {
    await freshProbeUser().catch(() => undefined);
    const t0 = Date.now();
    const deadline = t0 + 30_000;
    let p;
    while (Date.now() < deadline) {
      p = await probes();
      if (p.api.status === 200 && p.chunk.status === 200 && p.realtime.status === 'DELIVERED' && p.ready.status === 200) break;
      await sleep(250);
    }
    const ok = p && p.api.status === 200 && p.chunk.status === 200 && p.realtime.status === 'DELIVERED' && p.ready.status === 200;
    record(`RD-${label}-recover`, `mode ${label}: full recovery after Redis restored, no Bridge restart`,
      ok ? 'PASS' : 'FAIL', `${Date.now() - t0}ms ${JSON.stringify(p)}`);
    if (ok) measure(`redis.recovery_${label}_ms`, Date.now() - t0, 'ms', 'Redis restored → API, chunk quota, cross-node realtime and readiness all OK (probe-cycle resolution)');
  }

  function judge(label, name, p, extra = '') {
    const opened = failOpen(p);
    const hung = slow(p);
    record(`RD-${label}-sec`, `${name}: every security probe fails closed (no success without Redis authority)`,
      opened.length === 0 ? 'PASS' : 'FAIL', `fail-open=${JSON.stringify(opened)} ${JSON.stringify(p)} ${extra}`);
    record(`RD-${label}-ready`, `${name}: readiness reports the dependency failure (503)`,
      p.ready.status === 503 ? 'PASS' : 'FAIL', `ready=${p.ready.status}`);
    record(`RD-${label}-live`, `${name}: liveness stays 200 and no probe hangs`,
      p.live.status === 200 && hung.length === 0 ? 'PASS' : 'FAIL', `live=${p.live.status} timeouts=${JSON.stringify(hung)}`);
    record(`RD-${label}-rt`, `${name}: cross-node realtime`, 'INFO', `A→B ${p.realtime.status} (TEMPORARILY UNAVAILABLE when NOT_DELIVERED)`);
  }

  // A — refused
  await freshProbeUser();
  await cluster.stopRedis();
  await sleep(2_500);
  judge('A', 'Redis process gone (connection refused)', await probes());
  await cluster.startRedis();
  await recovery('A');

  // B — live connections killed (server stays up). Clients reconnect at once,
  // so success is legitimate here; prove the decisions still went through
  // Redis by checking the probe user's shared rate-limit bucket.
  await freshProbeUser();
  const killed = cluster.killRedisClients();
  const immediate = await probes();
  const bucket = Number(cluster.redisCli('ZCARD', `rl:global:u:${probeUser.id}`)) || 0;
  record('RD-B', 'all live Redis connections killed: clients reconnect, decisions remain Redis-authoritative',
    bucket > 0 && slow(immediate).length === 0 ? 'PASS' : 'FAIL', `killed=${killed} sharedBucketEntries=${bucket} ${JSON.stringify(immediate)}`);
  await recovery('B');

  // C — every write rejected with -OOM, reads still work
  await freshProbeUser();
  cluster.redisRejectWrites(true);
  await sleep(500);
  judge('C', 'Redis rejects writes (-OOM)', await probes());
  cluster.redisRejectWrites(false);
  await recovery('C');

  // D — hung Redis: TCP accepts, nothing answers
  await freshProbeUser();
  cluster.pauseRedis();
  await sleep(500);
  const hung = await probes();
  judge('D', 'Redis hung (SIGSTOP)', hung, `worst=${Math.max(...Object.values(hung).map((v) => v.ms))}ms`);
  measure('redis.hung_worst_probe_ms', Math.max(...Object.values(hung).map((v) => v.ms)), 'ms', 'slowest probe while Redis hung (command timeout bound)');
  cluster.resumeRedis();
  await recovery('D');

  // E — corrupt authoritative state for one user: rate-limit bucket of the wrong type
  await freshProbeUser();
  const victim = probeUser;
  const key = `rl:global:u:${victim.id}`;
  cluster.redisCli('DEL', key);
  cluster.redisCli('SET', key, 'corrupt');
  const victimProbe = await request(url('B'), 'GET', '/api/me', { token: victim.token, ip: fakeIp() });
  const otherProbe = await request(url('B'), 'GET', '/api/me', { token: alice.token, ip: fakeIp() });
  record('RD-E', 'corrupt rate-limit state (WRONGTYPE) for one user fails closed for that user only',
    victimProbe.status !== 200 && otherProbe.status === 200 ? 'PASS' : 'FAIL', `victim=${victimProbe.status} other=${otherProbe.status}`);
  cluster.redisCli('DEL', key);
  const healed = await request(url('B'), 'GET', '/api/me', { token: victim.token, ip: fakeIp() });
  record('RD-E-recover', 'removing the corrupt key restores the user without restart', healed.status === 200 ? 'PASS' : 'FAIL', `victim=${healed.status}`);

  record('RD-WS', 'sockets dropped because Redis came back without their shared connection lease (fail-closed; clients reconnect)', 'INFO',
    `${droppedSockets} forced reconnect(s) of the two probe sockets across modes A–E`);
  aliceS.close();
  bobS.close();
  void csrfToken; void login; void collect; void uploadChunk;
}
