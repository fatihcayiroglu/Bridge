#!/usr/bin/env node
// P6 federation retry/outage evidence.
//
// Runs two real production Bridge processes, each with its own PostgreSQL and
// Redis, behind real HTTPS fronts. Only the Bridge app processes see a shared
// libfaketime offset file; PostgreSQL, Redis and this harness stay on real time.
// We advance the virtual clock only while the relevant app is stopped and then
// use the production startup-recovery path to execute each due retry. This
// compresses the default multi-day backoff into a few minutes without changing
// FEDERATION_DELIVERY_RETRY_DELAYS_MS or the worker implementation.
//
// Evidence:
//   1) an outage survives restart and drains when the peer returns;
//   2) the exact default delay sequence is persisted generation by generation;
//   3) one initial attempt + 12 retries = 13 failed network attempts;
//   4) the 13th failed attempt dead-letters the durable row and emits the
//      max-retries log event.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import dns from 'node:dns/promises';
import { Instance, sleep, waitFor } from '../selfhost/lib/instance.mjs';
import { register, mutate, request, rnd } from '../multinode/lib/client.mjs';
import { makeLabPki, TlsFront } from './lib/tls.mjs';

const RETRY_DELAYS_MS = [
  30_000, 120_000, 600_000, 1_800_000, 3_600_000, 7_200_000,
  14_400_000, 28_800_000, 43_200_000, 86_400_000, 86_400_000, 86_400_000,
];
const RETRY_TOTAL_MS = RETRY_DELAYS_MS.reduce((a, b) => a + b, 0);
const EXPECTED_NETWORK_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;
const STEP_MARGIN_MS = 5_000;

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const workDir = opt('work', fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-retrylab-')));
const outDir = opt('out', path.join(workDir, 'report'));
fs.mkdirSync(workDir, { recursive: true });
fs.mkdirSync(outDir, { recursive: true });

const HOSTS = { a: 'retry-a.bridge.test', b: 'retry-b.bridge.test' };
const PORTS = { a: 18543, b: 18544 };
const ORIGIN = { a: `https://${HOSTS.a}:${PORTS.a}`, b: `https://${HOSTS.b}:${PORTS.b}` };
const actorUrl = (k, username) => `${ORIGIN[k]}/api/federation/users/${username}`;
const fakeFile = path.join(workDir, 'faketime.rc');
const libfaketime = process.env.LIBFAKETIME_PATH || '';
let offsetMs = 0;

const results = [];
function check(id, name, ok, detail = '', data) {
  const status = ok ? 'PASS' : 'FAIL';
  results.push({ id, name, status, detail, ...(data === undefined ? {} : { data }) });
  console.log(`  [${status.padEnd(4)}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) throw new Error(`${id} failed: ${name}${detail ? ` (${detail})` : ''}`);
}
function measure(id, name, detail, data) {
  results.push({ id, name, status: 'MEASURED', detail, ...(data === undefined ? {} : { data }) });
  console.log(`  [MEASURED] ${id} ${name} — ${detail}`);
}
function sqlLit(value) { return String(value).replaceAll("'", "''"); }
function setOffset(nextMs) {
  offsetMs = Math.ceil(nextMs / 1000) * 1000;
  const tmp = `${fakeFile}.tmp`;
  // Relative offsets are seconds by default in libfaketime.
  fs.writeFileSync(tmp, `+${Math.trunc(offsetMs / 1000)}\n`);
  fs.renameSync(tmp, fakeFile);
}
function fakeNow() { return Date.now() + offsetMs; }
async function eventually(fn, timeoutMs = 20_000, intervalMs = 100) {
  try { return await waitFor(fn, { timeoutMs, intervalMs, label: 'retry-lab condition' }); }
  catch { return null; }
}
function queueCount(inst) { return Number(inst.psql('bridge', 'SELECT count(*) FROM ap_delivery_queue')); }
function queueRow(inst, id) {
  const raw = inst.psql('bridge', `SELECT attempts || '|' || "nextAt" || '|' || "createdAt" FROM ap_delivery_queue WHERE _id='${sqlLit(id)}'`);
  if (!raw) return null;
  const [attempts, nextAt, createdAt] = raw.split('|').map(Number);
  return { attempts, nextAt, createdAt };
}
function newestQueueId(inst) {
  return inst.psql('bridge', 'SELECT _id FROM ap_delivery_queue ORDER BY "createdAt" DESC, _id DESC LIMIT 1');
}
function allLogs(inst) {
  if (!fs.existsSync(inst.logs)) return '';
  return fs.readdirSync(inst.logs)
    .filter((n) => n.startsWith(`${inst.name}-`) && n.endsWith('.log'))
    .sort()
    .map((n) => fs.readFileSync(path.join(inst.logs, n), 'utf8'))
    .join('\n');
}

const lab = { inst: {}, front: {}, pki: null, users: {} };
async function startApp(k, tag) { return lab.inst[k].start({ tag }); }
async function stopApp(k) { return lab.inst[k].stop(); }

async function main() {
  if (!libfaketime || !fs.existsSync(libfaketime)) {
    throw Object.assign(new Error(`LIBFAKETIME_PATH is missing or invalid: ${libfaketime || '<empty>'}`), { blocked: true });
  }
  for (const host of Object.values(HOSTS)) {
    const addr = await dns.lookup(host).catch(() => null);
    if (addr?.address !== '127.0.0.1') {
      throw Object.assign(new Error(`${host} must resolve to 127.0.0.1`), { blocked: true });
    }
  }

  setOffset(0);
  lab.pki = makeLabPki(path.join(workDir, 'pki'), Object.values(HOSTS));
  const commonFakeEnv = {
    LD_PRELOAD: libfaketime,
    FAKETIME_TIMESTAMP_FILE: fakeFile,
    FAKETIME_NO_CACHE: '1',
    FAKETIME_DONT_FAKE_MONOTONIC: '1',
    NODE_EXTRA_CA_CERTS: lab.pki.caFile,
    SSRF_ALLOWLIST: Object.values(HOSTS).join(','),
    BRIDGE_EGRESS_LOCAL_HOSTS: Object.values(HOSTS).join(','),
    BRIDGE_EGRESS_RECORD_LAB: '1',
    AI_PROVIDER: 'none',
  };

  let basePort = 18500;
  for (const k of ['a', 'b']) {
    const inst = new Instance({
      name: `retry-${k}`,
      workDir,
      pgPort: basePort + 1,
      redisPort: basePort + 2,
      appPort: basePort + 3,
      env: {
        ...commonFakeEnv,
        INSTANCE_URL: ORIGIN[k],
        BASE_URL: ORIGIN[k],
        INSTANCE_NAME: `Retry Lab ${k.toUpperCase()}`,
        WEBAUTHN_RP_ID: HOSTS[k],
        WEBAUTHN_ORIGIN: ORIGIN[k],
        ALLOWED_ORIGINS: `${ORIGIN[k]},http://127.0.0.1:${basePort + 3}`,
        ADMIN_SETUP_SECRET: `retry-lab-admin-${k}`,
      },
    });
    basePort += 10;
    lab.inst[k] = inst;
    await inst.startPg({ fresh: true });
    await inst.startRedis();
    await startApp(k, 'boot');
    const front = new TlsFront({ hostname: HOSTS[k], port: PORTS[k], upstreamPort: inst.appPort, pki: lab.pki });
    front.connectionEvents = [];
    await front.start();
    front.server.on('connection', () => front.connectionEvents.push({ at: Date.now(), mode: front.mode }));
    lab.front[k] = front;
  }

  lab.users.alice = await register(lab.inst.a.base, 'retryalice');
  lab.users.bob = await register(lab.inst.b.base, 'retrybob');
  // Force actor documents/keys to exist before outage injection. The harness
  // talks to each app's internal HTTP listener here; actual federation below
  // still uses the CA-signed HTTPS fronts.
  const actorA = await request(lab.inst.a.base, 'GET', `/api/federation/users/${lab.users.alice.username}`);
  const actorB = await request(lab.inst.b.base, 'GET', `/api/federation/users/${lab.users.bob.username}`);
  check('FR-00', 'both real Bridge actor documents are live before the outage', actorA.status === 200 && actorB.status === 200,
    `A=${actorA.status} B=${actorB.status}`);

  // Bob follows Alice while the link is healthy, so later Alice posts use the
  // normal follower fan-out path and create a durable delivery intent on A.
  const follow = await mutate(lab.inst.b.base, 'POST', '/api/federation/follow', lab.users.bob.token,
    { actorUrl: actorUrl('a', lab.users.alice.username) });
  check('FR-01', 'Bob@B follows Alice@A over signed HTTPS', follow.status === 200, `status=${follow.status}`);
  const followed = await eventually(() => Number(lab.inst.a.psql('bridge',
    `SELECT count(*) FROM ap_follows WHERE "actorUrl"='${sqlLit(actorUrl('b', lab.users.bob.username))}'`)) === 1);
  const accepted = await eventually(() => lab.inst.b.psql('bridge',
    `SELECT accepted FROM ap_outgoing_follows WHERE "targetActorUrl"='${sqlLit(actorUrl('a', lab.users.alice.username))}'`) === 't');
  check('FR-02', 'follow and signed Accept settle before outage testing', Boolean(followed && accepted),
    `followed=${Boolean(followed)} accepted=${Boolean(accepted)}`);
  const empty = await eventually(() => queueCount(lab.inst.a) === 0 && queueCount(lab.inst.b) === 0);
  check('FR-03', 'baseline durable delivery queues are empty', Boolean(empty),
    `A=${queueCount(lab.inst.a)} B=${queueCount(lab.inst.b)}`);

  // ── Recovery before exhaustion ───────────────────────────────────────────
  lab.front.b.setMode('refuse');
  const recoveryContent = `retry recovery ${rnd()}`;
  const connRecoveryStart = lab.front.b.connectionEvents.length;
  const recoveryPost = await mutate(lab.inst.a.base, 'POST', `/api/federation/users/${lab.users.alice.username}/outbox`,
    lab.users.alice.token, { content: recoveryContent, visibility: 'public' });
  check('FR-04', 'local publish succeeds while the follower instance is unreachable', recoveryPost.status < 300,
    `status=${recoveryPost.status}`);
  const queuedRecovery = await eventually(() => queueCount(lab.inst.a) === 1 && lab.front.b.connectionEvents.length > connRecoveryStart);
  check('FR-05', 'failed initial network attempt leaves one durable retry row', Boolean(queuedRecovery),
    `queue=${queueCount(lab.inst.a)} tcpAttempts=${lab.front.b.connectionEvents.length - connRecoveryStart}`);
  const recoveryId = newestQueueId(lab.inst.a);
  const recoveryInitial = queueRow(lab.inst.a, recoveryId);
  check('FR-06', 'initial failure persists generation 0 at the 30s backoff',
    recoveryInitial?.attempts === 0 && recoveryInitial.nextAt - fakeNow() > 20_000 && recoveryInitial.nextAt - fakeNow() <= 35_000,
    JSON.stringify(recoveryInitial));

  await stopApp('a');
  await stopApp('b');
  setOffset(31_000);
  await startApp('a', 'recovery-retry-1');
  const retry1 = await eventually(() => queueRow(lab.inst.a, recoveryId)?.attempts === 1);
  const retry1Row = queueRow(lab.inst.a, recoveryId);
  check('FR-07', 'restart recovery performs retry #1 and persists the 120s generation', Boolean(retry1) &&
    retry1Row.nextAt - fakeNow() > 105_000 && retry1Row.nextAt - fakeNow() <= 125_000,
    JSON.stringify(retry1Row));
  await stopApp('a');

  setOffset(157_000); // 31s + 120s + margin; retry #2 is now due.
  await startApp('b', 'recovery-peer-back');
  lab.front.b.setMode('open');
  await startApp('a', 'recovery-retry-2');
  const drainedRecovery = await eventually(() => queueRow(lab.inst.a, recoveryId) === null, 25_000, 100);
  const timeline = await request(lab.inst.b.base, 'GET', '/api/federation/timeline?limit=50', { token: lab.users.bob.token });
  const visible = timeline.status === 200 && (timeline.body.items || []).some((m) => String(m.content).includes(recoveryContent));
  check('FR-08', 'peer return drains the durable row and the federated note reaches B', Boolean(drainedRecovery && visible),
    `drained=${Boolean(drainedRecovery)} visible=${visible} timelineStatus=${timeline.status}`);

  // ── Full default schedule to dead-letter ────────────────────────────────
  lab.front.b.setMode('refuse');
  const deadContent = `retry deadletter ${rnd()}`;
  const deadConnStart = lab.front.b.connectionEvents.length;
  const deadPost = await mutate(lab.inst.a.base, 'POST', `/api/federation/users/${lab.users.alice.username}/outbox`,
    lab.users.alice.token, { content: deadContent, visibility: 'public' });
  check('FR-09', 'second publish also succeeds while B is unreachable', deadPost.status < 300, `status=${deadPost.status}`);
  const queuedDead = await eventually(() => queueCount(lab.inst.a) === 1 && lab.front.b.connectionEvents.length > deadConnStart);
  check('FR-10', 'dead-letter probe records its failed initial attempt durably', Boolean(queuedDead),
    `queue=${queueCount(lab.inst.a)} tcpAttempts=${lab.front.b.connectionEvents.length - deadConnStart}`);
  const deadId = newestQueueId(lab.inst.a);
  const deadInitial = queueRow(lab.inst.a, deadId);
  check('FR-11', 'dead-letter probe starts at retry generation 0', deadInitial?.attempts === 0,
    JSON.stringify(deadInitial));

  await stopApp('a');
  await stopApp('b');
  let virtual = offsetMs;
  const persisted = [];
  for (let i = 0; i < RETRY_DELAYS_MS.length; i++) {
    virtual += RETRY_DELAYS_MS[i] + STEP_MARGIN_MS;
    setOffset(virtual);
    const beforeConnections = lab.front.b.connectionEvents.length;
    await startApp('a', `dead-retry-${i + 1}`);
    if (i < RETRY_DELAYS_MS.length - 1) {
      const expectedAttempts = i + 1;
      const progressed = await eventually(() => queueRow(lab.inst.a, deadId)?.attempts === expectedAttempts, 20_000, 100);
      const row = queueRow(lab.inst.a, deadId);
      const expectedNextDelay = RETRY_DELAYS_MS[i + 1];
      const remaining = row ? row.nextAt - fakeNow() : NaN;
      const oneNetworkAttempt = lab.front.b.connectionEvents.length - beforeConnections === 1;
      check(`FR-S${String(i + 1).padStart(2, '0')}`,
        `retry #${i + 1} persists generation ${expectedAttempts} with next delay ${expectedNextDelay}ms`,
        Boolean(progressed && row && remaining > expectedNextDelay - 15_000 && remaining <= expectedNextDelay + 2_000 && oneNetworkAttempt),
        `row=${JSON.stringify(row)} remaining=${remaining} tcpDelta=${lab.front.b.connectionEvents.length - beforeConnections}`);
      persisted.push({ retry: i + 1, attempts: row.attempts, expectedNextDelay, remaining });
    } else {
      const gone = await eventually(() => queueRow(lab.inst.a, deadId) === null, 20_000, 100);
      const oneNetworkAttempt = lab.front.b.connectionEvents.length - beforeConnections === 1;
      check('FR-S12', 'retry #12 performs the final failed network attempt and removes the exhausted row',
        Boolean(gone && oneNetworkAttempt),
        `gone=${Boolean(gone)} tcpDelta=${lab.front.b.connectionEvents.length - beforeConnections}`);
    }
    await stopApp('a');
  }

  const deadTcpAttempts = lab.front.b.connectionEvents.length - deadConnStart;
  const logs = allLogs(lab.inst.a);
  const deadLetterLogged = logs.includes('federation.delivery.max_retries') && logs.includes(deadId);
  check('FR-12', 'default schedule makes exactly 13 failed network attempts (1 initial + 12 retries)',
    deadTcpAttempts === EXPECTED_NETWORK_ATTEMPTS,
    `observed=${deadTcpAttempts} expected=${EXPECTED_NETWORK_ATTEMPTS}`);
  check('FR-13', 'schedule exhaustion emits the dead-letter event with the durable delivery id', deadLetterLogged,
    `id=${deadId}`);
  check('FR-14', 'dead-letter leaves no durable queue row behind', queueRow(lab.inst.a, deadId) === null,
    `remainingQueue=${queueCount(lab.inst.a)}`);
  measure('FR-M1', 'default retry horizon exercised under accelerated virtual time',
    `${RETRY_TOTAL_MS} ms = ${(RETRY_TOTAL_MS / 86_400_000).toFixed(3)} days; observed virtual offset ${(offsetMs / 86_400_000).toFixed(3)} days`,
    { delays: RETRY_DELAYS_MS, persisted, expectedNetworkAttempts: EXPECTED_NETWORK_ATTEMPTS });

  fs.writeFileSync(path.join(outDir, 'retry-outage-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    defaultRetryDelaysMs: RETRY_DELAYS_MS,
    defaultRetryTotalMs: RETRY_TOTAL_MS,
    expectedNetworkAttempts: EXPECTED_NETWORK_ATTEMPTS,
    finalVirtualOffsetMs: offsetMs,
    results,
  }, null, 2));
}

let fatal = null;
try {
  await main();
} catch (err) {
  fatal = err;
  console.error(err?.stack || err);
  results.push({ id: 'FR-FATAL', name: 'retry outage lab completed', status: err?.blocked ? 'BLOCKED' : 'FAIL', detail: String(err?.message || err) });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, 'retry-outage-results.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    defaultRetryDelaysMs: RETRY_DELAYS_MS,
    defaultRetryTotalMs: RETRY_TOTAL_MS,
    expectedNetworkAttempts: EXPECTED_NETWORK_ATTEMPTS,
    finalVirtualOffsetMs: offsetMs,
    results,
  }, null, 2));
} finally {
  for (const front of Object.values(lab.front)) await front.stop().catch(() => undefined);
  for (const inst of Object.values(lab.inst)) await inst.destroy().catch(() => undefined);
}

if (fatal) process.exitCode = 1;
else console.log(`Retry/outage evidence PASS — ${EXPECTED_NETWORK_ATTEMPTS} attempts across ${(RETRY_TOTAL_MS / 86_400_000).toFixed(3)} days of the default schedule.`);
