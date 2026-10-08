#!/usr/bin/env node
// scripts/abuse-lab/run.mjs — P7 B1 abuse attack lab.
//
// Measures how a REAL Bridge cluster (two `node server/dist/index.js`
// processes, NODE_ENV=production, shared PostgreSQL + Redis — the multinode
// harness in ../multinode/lib) responds to controlled abuse, and — just as
// important — to legitimate behaviour that looks similar. Every client
// alternates between the two nodes, so any counter that is not cluster-wide
// shows up as a leak.
//
//   node scripts/abuse-lab/run.mjs [--scenarios a,b] [--out DIR] [--label NAME]
//                                  [--gate] [--keep]
//
// Outcomes are measurements, not opinions:
//   attacks   BLOCKED   the attack was stopped (bounded, small accepted count)
//             LIMITED   slowed by a per-actor limit but the abusive effect still lands
//             OPEN      no control engaged
//   controls  OK              every legitimate action succeeded without a warning or delay
//             FRICTION        everything succeeded, with a warning or a short automatic
//                             delay (≤ 10 s) — measured cost, not a lost action
//             FALSE_POSITIVE  a legitimate action failed, was muted, or waited > 10 s
//   INFO      context (environment facts, resource samples)
//
// Without --gate the exit code is 0: a baseline run REPORTS gaps. With --gate
// the run fails when a control is FALSE_POSITIVE or an attack is weaker than
// the floor recorded in expectations.json (so mitigations cannot regress).

import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { Cluster, sleep, waitFor } from '../multinode/lib/cluster.mjs';
import { BROWSER, io, request, rnd } from '../multinode/lib/client.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const ALL = [
  'msgburst', 'dupslow', 'nearslow', 'mentions', 'dmspray', 'joinchurn', 'invites', 'raid', 'replaystorm',
  'legit_burst', 'legit_fast', 'legit_chat', 'legit_reconnect', 'legit_acklost', 'legit_retry',
  'legit_joins', 'legit_event', 'legit_surge', 'legit_newcomers', 'legit_modops',
  'legit_mention', 'legit_dmchat', 'legit_dmfew',
];
const selected = opt('scenarios', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = opt('label', 'baseline');
const GATE = flag('gate');
const ORDER = { OPEN: 0, LIMITED: 1, BLOCKED: 2 };

const cluster = new Cluster({ nodes: ['A', 'B'], basePort: Number(opt('base-port', 3200)), workDir: opt('work', undefined) });
const outDir = opt('out', path.join(cluster.workDir, 'report'));
fs.mkdirSync(outDir, { recursive: true });
const EXPECT = (() => {
  try {
    return Object.fromEntries(Object.entries(JSON.parse(fs.readFileSync(new URL('./expectations.json', import.meta.url), 'utf8')))
      .filter(([k]) => !k.startsWith('_')));
  } catch { return {}; }
})();

// ── reporting ────────────────────────────────────────────────────────────────
const results = [];
function record(scenario, id, name, kind, outcome, detail, metrics = {}) {
  const valid = kind === 'attack' ? ['BLOCKED', 'LIMITED', 'OPEN'] : kind === 'control' ? ['OK', 'FRICTION', 'FALSE_POSITIVE'] : ['INFO'];
  if (!valid.includes(outcome)) throw new Error(`bad outcome ${outcome} for ${kind}`);
  results.push({ scenario, id, name, kind, outcome, detail, metrics });
  console.log(`  [${outcome.padEnd(14)}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  if (Object.keys(metrics).length) console.log(`                   ${JSON.stringify(metrics)}`);
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// Every simulated person has a stable client address (198.18.0.0/15 is the
// benchmarking range), so per-IP limits behave as they would in production.
let ipSeq = 1;
const nextIp = () => { const n = ipSeq++; return `198.18.${(n >> 8) & 255}.${n & 255}`; };
const nodeUrls = () => cluster.nodeNames.map((n) => cluster.nodeUrl(n));
let rr = 0;
const anyNode = () => nodeUrls()[rr++ % cluster.nodeNames.length];

class Person {
  constructor(base, username, password, ip) { Object.assign(this, { base, username, password, ip, csrf: null, sockets: [] }); }
  headers() { return { 'X-Forwarded-For': this.ip }; }
  async api(method, urlPath, body, { base = this.base, headers = {} } = {}) {
    if (method !== 'GET' && !this.csrf) {
      const r = await request(base, 'GET', '/api/csrf-token', { token: this.token, headers: this.headers() });
      if (r.status !== 200) return r;
      this.csrf = r.body.token;
    }
    return request(base, method, urlPath, { token: this.token, body, csrf: method === 'GET' ? undefined : this.csrf, headers: { ...this.headers(), ...headers } });
  }
  socket(base = this.base) {
    return new Promise((resolve, reject) => {
      const s = io(base, {
        auth: { token: this.token }, transports: ['websocket'], reconnection: false, timeout: 15_000,
        extraHeaders: { 'User-Agent': BROWSER['User-Agent'], 'X-Forwarded-For': this.ip },
      });
      const t = setTimeout(() => { s.close(); reject(new Error(`socket auth timeout ${this.username}`)); }, 15_000);
      s.once('userAuthenticated', () => { clearTimeout(t); this.sockets.push(s); resolve(s); });
      s.once('connect_error', (err) => { clearTimeout(t); s.close(); reject(err); });
    });
  }
  close() { for (const s of this.sockets) s.close(); this.sockets = []; }
}

async function person(prefix) {
  const base = anyNode();
  const ip = nextIp();
  const username = `${prefix}_${rnd()}`;
  const password = `Ab-${rnd()}-${rnd()}!`;
  const r = await request(base, 'POST', '/api/register', {
    body: { username, email: `${username}@abuse-lab.test`, password, displayName: username }, headers: { 'X-Forwarded-For': ip },
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`register ${r.status} ${JSON.stringify(r.body)}`);
  const p = new Person(base, username, password, ip);
  p.id = r.body.user?._id || r.body.user?.id;
  p.token = r.body.token;
  // P7 B2: registration is a fresh sign-in and returns one step-up grant per
  // scope; the real client holds them in memory and sends the matching one.
  p.stepUp = r.body.stepUp?.grants ?? {};
  return p;
}
// Fixture accounts are created in small batches: registration is deliberately
// expensive (password hashing) and the lab must not overload the cluster it measures.
async function people(prefix, n) {
  const out = [];
  for (let i = 0; i < n; i += 8) out.push(...await Promise.all(Array.from({ length: Math.min(8, n - i) }, () => person(prefix))));
  return out;
}

/**
 * Makes accounts look established (created `days` ago). Real launch audiences
 * are not seconds-old accounts; raiders in this lab are. Direct SQL on the lab
 * database — fixture shaping only, never a product path.
 */
function ageAccounts(list, days = 30) {
  if (!list.length) return;
  const created = Date.now() - days * 24 * 60 * 60_000;
  const ids = list.map((p) => `'${String(p.id).replace(/'/g, "''")}'`).join(',');
  const r = spawnSync('psql', [cluster.directDatabaseUrl, '-v', 'ON_ERROR_STOP=1', '-qc',
    `UPDATE users SET "createdAt" = ${created} WHERE _id IN (${ids})`], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`ageAccounts failed: ${r.stderr}`);
}

/** One message from each person; resolves to how many were persisted. */
async function postOnce(list, c, text) {
  let posted = 0;
  const outcomes = {};
  await Promise.all(list.map(async (p) => {
    const s = await p.socket(); const w = sendWatcher(s); const id = ack();
    w.send({ channelId: c.channelId, serverId: c.serverId, content: `${text} ${rnd()}`, ackId: id });
    await w.wait([id], 8_000);
    const kind = w.outcomes.get(id)?.kind ?? 'none';
    outcomes[kind] = (outcomes[kind] || 0) + 1;
    if (kind === 'ack') posted += 1;
    p.close();
  }));
  return { posted, outcomes };
}

async function community(owner, { discoverable = false, channels = 1 } = {}) {
  const s = await owner.api('POST', '/api/servers', { name: `Lab ${rnd()}` });
  if (s.status >= 300) throw new Error(`server create ${s.status} ${JSON.stringify(s.body)}`);
  const serverId = s.body._id || s.body.id;
  const channelIds = [];
  for (let i = 0; i < channels; i++) {
    const c = await owner.api('POST', `/api/servers/${serverId}/channels`, { name: `lab-${rnd()}`, type: 'text' });
    if (c.status >= 300) throw new Error(`channel create ${c.status} ${JSON.stringify(c.body)}`);
    channelIds.push(c.body._id || c.body.id);
  }
  if (discoverable) {
    const d = await owner.api('PATCH', '/api/discover/settings', { serverId, discoverable: true, description: 'abuse lab', category: 'gaming' });
    if (d.status >= 300) throw new Error(`discoverable ${d.status} ${JSON.stringify(d.body)}`);
  }
  const inv = await owner.api('POST', '/api/servers/invites', { serverId });
  if (inv.status >= 300) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`);
  return { serverId, channelId: channelIds[0], channelIds, invite: inv.body.code };
}

/** Join through the owner's invite — fixture setup, not part of a measurement. */
async function admit(c, members) {
  for (const m of members) {
    const u = await m.api('POST', `/api/servers/invites/${c.invite}/use`, {});
    if (u.status >= 300) throw new Error(`invite use ${u.status} ${JSON.stringify(u.body)}`);
  }
}

// ── socket send helpers (outcome per ackId) ──────────────────────────────────
/**
 * Watches every send-outcome event of one socket. Outcomes are keyed by ackId:
 * ack (persisted or deduplicated), spam (error:spam reason), slowmode, timeout.
 * `error:ratelimit` (the per-event socket gate) carries no ackId: it is
 * counted separately, and the matching send simply never gets an outcome.
 */
function sendWatcher(socket) {
  const w = { outcomes: new Map(), warnings: 0, socketRateLimited: 0, firstRejectAt: null, events: [] };
  const mark = (ackId, outcome) => {
    if (!ackId || w.outcomes.has(ackId)) return;
    w.outcomes.set(ackId, { ...outcome, at: Date.now() });
    if (outcome.kind !== 'ack' && w.firstRejectAt === null) w.firstRejectAt = Date.now();
  };
  socket.on('message:ack', (a) => mark(a?.ackId, { kind: 'ack', messageId: a?.messageId }));
  socket.on('error:spam', (e) => mark(e?.ackId, { kind: 'spam', reason: e?.reason, remainingMs: e?.remainingMs }));
  socket.on('error:slowmode', (e) => mark(e?.ackId, { kind: 'slowmode' }));
  socket.on('error:timeout', (e) => mark(e?.ackId, { kind: 'timeout' }));
  socket.on('error:message', (e) => mark(e?.ackId, { kind: 'error', code: e?.code }));
  socket.on('warn:spam', () => { w.warnings += 1; });
  socket.on('error:ratelimit', () => {
    w.socketRateLimited += 1;
    if (w.firstRejectAt === null) w.firstRejectAt = Date.now();
  });
  w.send = (payload) => { socket.emit('message:send', payload); };
  w.wait = (ackIds, ms) => waitFor(() => ackIds.every((id) => w.outcomes.has(id)), { timeoutMs: ms, label: 'outcomes' }).catch(() => false);
  w.tally = (ackIds) => {
    const t = { ack: 0, spam: 0, slowmode: 0, timeout: 0, error: 0, none: 0 };
    for (const id of ackIds) t[w.outcomes.get(id)?.kind ?? 'none'] += 1;
    return t;
  };
  return w;
}
const ack = () => `lab-${rnd()}${rnd()}`;

/** Sends one DM per target over `socket`, `spacingMs` apart; counts deliveries by clientNonce. */
async function dmBatch(socket, targets, spacingMs) {
  const delivered = new Set();
  const refusals = {};
  let socketGateDropped = 0;
  const onMessage = (m) => { if (m?.clientNonce) delivered.add(m.clientNonce); };
  const onRefusal = (ev) => (e) => { const k = e?.code ?? ev; refusals[k] = (refusals[k] || 0) + 1; };
  const onGate = () => { socketGateDropped += 1; };
  socket.on('dm:message', onMessage);
  const refusalHandlers = ['error:dm_rate', 'error:dm_privacy', 'error:message'].map((ev) => [ev, onRefusal(ev)]);
  for (const [ev, h] of refusalHandlers) socket.on(ev, h);
  socket.on('error:ratelimit', onGate);
  const nonces = [];
  for (const [i, t] of targets.entries()) {
    const clientNonce = `ldm-${rnd()}-${i}`;
    nonces.push(clientNonce);
    socket.emit('dm:send', { toUserId: t.id, content: `hello ${i} ${rnd()}`, clientNonce });
    if (i < targets.length - 1) await sleep(spacingMs);
  }
  await waitFor(() => nonces.every((n) => delivered.has(n)), { timeoutMs: 6_000, label: 'dm deliveries' }).catch(() => false);
  socket.off('dm:message', onMessage);
  for (const [ev, h] of refusalHandlers) socket.off(ev, h);
  socket.off('error:ratelimit', onGate);
  return { attempted: targets.length, delivered: nonces.filter((n) => delivered.has(n)).length, refusals, socketGateDropped };
}
// The production client's send behaviour (MessageInputPanel): typed messages
// are emitted at the person's own pace; a burst/link refusal (`error:spam`,
// not a duplicate) HOLDS that message and everything typed after it until the
// server's retry time, then releases one per second (HOLD_RELEASE_SPACING_MS);
// a reconnect replays its backlog through the same 1 s release
// (`--client-replay burst` reproduces the pre-P7 replay-everything client).
const CLIENT_REPLAY = opt('client-replay', 'paced');
const HOLD_SPACING_MS = 1_000;
function clientModel(w, target) {
  const typedAt = new Map();
  const content = new Map();
  const held = [];
  let holdUntil = 0;
  let timer = null;
  let holds = 0;
  const emit = (id) => { w.outcomes.delete(id); w.send({ ...target, content: content.get(id), ackId: id }); };
  const release = () => {
    timer = null;
    const id = held.shift();
    if (id) emit(id);
    if (held.length) timer = setTimeout(release, HOLD_SPACING_MS);
  };
  const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(release, Math.max(0, holdUntil - Date.now())); };
  const onOutcome = (id) => {
    const o = w.outcomes.get(id);
    if (!o || o.kind !== 'spam' || o.reason === 'spam_duplicate' || o.reason === 'spam_repeat') return;
    holds += 1;
    holdUntil = Math.max(holdUntil, Date.now() + Math.max(1_000, Number(o.remainingMs) || 30_000));
    if (!held.includes(id)) held.unshift(id);
    schedule();
  };
  const poll = setInterval(() => { for (const id of typedAt.keys()) if (w.outcomes.get(id)?.kind === 'spam' && !w.outcomes.get(id).seen) { w.outcomes.get(id).seen = true; onOutcome(id); } }, 20);
  return {
    type(text) {
      const id = ack(); typedAt.set(id, Date.now()); content.set(id, text);
      if (Date.now() < holdUntil || held.length) { held.push(id); if (!timer) schedule(); } else emit(id);
      return id;
    },
    replay(texts) {
      const ids = texts.map((t) => { const id = ack(); typedAt.set(id, Date.now()); content.set(id, t); return id; });
      if (CLIENT_REPLAY === 'burst') { ids.forEach(emit); return ids; }
      emit(ids[0]); held.push(...ids.slice(1)); if (held.length && !timer) timer = setTimeout(release, HOLD_SPACING_MS);
      return ids;
    },
    async settle(ids, ms = 70_000) {
      await waitFor(() => ids.every((id) => w.outcomes.get(id)?.kind === 'ack' || ['duplicate', 'timeout', 'error'].includes(w.outcomes.get(id)?.kind)), { timeoutMs: ms }).catch(() => false);
      clearInterval(poll); if (timer) clearTimeout(timer);
      const delivered = ids.filter((id) => w.outcomes.get(id)?.kind === 'ack');
      const delays = delivered.map((id) => w.outcomes.get(id).at - typedAt.get(id));
      return { delivered: delivered.length, holds, maxDelayMs: delays.length ? Math.max(...delays) : null, muted: ids.some((id) => w.outcomes.get(id)?.reason === 'spam_muted') };
    },
  };
}
const controlOutcome = (r, total, warnings) =>
  r.delivered < total || r.muted || (r.maxDelayMs ?? 0) > 10_000 ? 'FALSE_POSITIVE' : (r.holds || warnings) ? 'FRICTION' : 'OK';

const tallyStatuses = (responses) => responses.reduce((acc, r) => {
  const key = `${r.status}${r.body?.error ? ` ${r.body.error}` : ''}`;
  acc[key] = (acc[key] || 0) + 1;
  return acc;
}, {});

// ── resource sampling ────────────────────────────────────────────────────────
function procSample() {
  const out = {};
  for (const [name, node] of cluster.nodes) {
    try {
      const stat = fs.readFileSync(`/proc/${node.proc.pid}/stat`, 'utf8').split(') ')[1].split(' ');
      const status = fs.readFileSync(`/proc/${node.proc.pid}/status`, 'utf8');
      out[name] = { cpuTicks: Number(stat[11]) + Number(stat[12]), rssKb: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) };
    } catch { out[name] = null; }
  }
  const info = cluster.redisCli('INFO', 'memory');
  out.redis = { usedMemory: Number(/used_memory:(\d+)/.exec(info)?.[1] ?? 0), keys: Number(cluster.redisCli('DBSIZE')) || 0 };
  return out;
}
function resourceDelta(before, after) {
  const hz = 100;
  const nodes = {};
  for (const n of cluster.nodeNames) {
    if (!before[n] || !after[n]) continue;
    nodes[n] = { cpuMs: Math.round(((after[n].cpuTicks - before[n].cpuTicks) / hz) * 1000), rssMb: +(after[n].rssKb / 1024).toFixed(1) };
  }
  return { nodes, redisKeysDelta: after.redis.keys - before.redis.keys, redisMemDeltaKb: Math.round((after.redis.usedMemory - before.redis.usedMemory) / 1024) };
}

// ── scenarios ────────────────────────────────────────────────────────────────
// Each returns nothing; it records. Fresh people/communities per scenario so a
// mute or limiter state from one never leaks into the next.
const S = {
  // A1: a single account fires messages as fast as a script can.
  async msgburst() {
    const [owner, bot] = await people('burst', 2);
    const c = await community(owner);
    await admit(c, [bot]);
    const sock = await bot.socket();
    const w = sendWatcher(sock);
    const ids = Array.from({ length: 40 }, ack);
    const t0 = Date.now();
    ids.forEach((id, i) => w.send({ channelId: c.channelId, serverId: c.serverId, content: `burst ${i} ${rnd()}`, ackId: id }));
    await w.wait(ids, 12_000);
    const t = w.tally(ids);
    // Is the account still muted 10 s later (a cool-down, not a one-off drop)?
    await sleep(10_000);
    const probe = ack();
    w.send({ channelId: c.channelId, serverId: c.serverId, content: `probe ${rnd()}`, ackId: probe });
    await w.wait([probe], 8_000);
    const stillMuted = w.outcomes.get(probe)?.kind === 'spam';
    record('msgburst', 'ATK-01', '40 unique messages fired at once by one account', 'attack',
      t.ack <= 8 ? 'BLOCKED' : t.ack <= 20 ? 'LIMITED' : 'OPEN',
      `${t.ack}/40 persisted; ${t.spam} spam-rejected, ${w.socketRateLimited} dropped by the socket gate, ${t.none} without outcome; muted after 10 s: ${stillMuted}`,
      { accepted: t.ack, spamRejected: t.spam, socketGateDropped: w.socketRateLimited, noOutcome: t.none,
        triggerLatencyMs: w.firstRejectAt ? w.firstRejectAt - t0 : null, cooldownStillActiveAt10s: stillMuted });
    bot.close();
  },

  // A2: identical text, paced just under the duplicate window.
  async dupslow() {
    const [owner, bot] = await people('dup', 2);
    const c = await community(owner);
    await admit(c, [bot]);
    const w = sendWatcher(await bot.socket());
    const spacing = 1_400;
    const ids = [];
    const t0 = Date.now();
    for (let i = 0; i < 15; i++) {
      const id = ack(); ids.push(id);
      w.send({ channelId: c.channelId, serverId: c.serverId, content: 'JOIN NOW → spam.example/free-nitro', ackId: id });
      await sleep(spacing);
    }
    await w.wait(ids, 8_000);
    const t = w.tally(ids);
    const perHour = Math.round((t.ack / ((Date.now() - t0) / 1000)) * 3600);
    record('dupslow', 'ATK-02', `identical message every ${spacing} ms (low-and-slow duplicate spam)`, 'attack',
      t.ack <= 4 ? 'BLOCKED' : t.ack < 15 ? 'LIMITED' : 'OPEN',
      `${t.ack}/15 identical messages persisted (${t.spam} rejected) → ~${perHour}/hour sustainable`,
      { accepted: t.ack, rejected: t.spam, projectedPerHour: perHour, triggerLatencyMs: w.firstRejectAt ? w.firstRejectAt - t0 : null });
    bot.close();
  },

  // A3: near-identical spam paced under the 5-per-4 s rate window.
  async nearslow() {
    const [owner, bot] = await people('near', 2);
    const c = await community(owner);
    await admit(c, [bot]);
    const w = sendWatcher(await bot.socket());
    const ids = [];
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) {
      const id = ack(); ids.push(id);
      w.send({ channelId: c.channelId, serverId: c.serverId, content: `free nitro at spam.example/${i} #${rnd()}`, ackId: id });
      await sleep(900);
    }
    await w.wait(ids, 8_000);
    const t = w.tally(ids);
    const perHour = Math.round((t.ack / ((Date.now() - t0) / 1000)) * 3600);
    record('nearslow', 'ATK-03', 'near-identical spam every 900 ms', 'attack',
      t.ack <= 6 ? 'BLOCKED' : t.ack < 20 ? 'LIMITED' : 'OPEN',
      `${t.ack}/20 persisted, ${w.warnings} warnings → ~${perHour}/hour sustainable`,
      { accepted: t.ack, rejected: 20 - t.ack, warnings: w.warnings, projectedPerHour: perHour });
    bot.close();
  },

  // A4: mass mention in one message, then repeated pings of one victim.
  async mentions() {
    const [owner, bot, victim, ...crowd] = await people('ment', 28);
    const c = await community(owner);
    await admit(c, [bot, victim, ...crowd]);
    const vs = await victim.socket();
    const pings = [];
    vs.on('mention:received', (m) => pings.push(m));
    const w = sendWatcher(await bot.socket());
    const mass = ack();
    w.send({ channelId: c.channelId, serverId: c.serverId, content: [victim, ...crowd].map((p) => `<@${p.id}>`).join(' '), ackId: mass });
    await w.wait([mass], 8_000);
    await sleep(1_000);
    const massPings = pings.length;
    record('mentions', 'ATK-04a', 'one message mentioning 26 members (no AutoMod rule configured)', 'attack',
      w.outcomes.get(mass)?.kind === 'ack' ? 'OPEN' : 'BLOCKED',
      `message ${w.outcomes.get(mass)?.kind ?? 'none'}; victim received ${massPings} mention notification(s)`,
      { mentionsInMessage: 26, accepted: w.outcomes.get(mass)?.kind === 'ack' ? 1 : 0 });
    const ids = [];
    const t0 = Date.now();
    for (let i = 0; i < 15; i++) {
      const id = ack(); ids.push(id);
      w.send({ channelId: c.channelId, serverId: c.serverId, content: `<@${victim.id}> look ${i} ${rnd()}`, ackId: id });
      await sleep(900);
    }
    await w.wait(ids, 8_000);
    await sleep(1_000);
    const repeated = pings.length - massPings;
    const t = w.tally(ids);
    record('mentions', 'ATK-04b', 'the same victim pinged every 900 ms for 13.5 s', 'attack',
      repeated <= 5 ? 'BLOCKED' : repeated < 15 ? 'LIMITED' : 'OPEN',
      `${t.ack}/15 persisted; victim received ${repeated} mention notifications in ${Math.round((Date.now() - t0) / 1000)} s`,
      { accepted: t.ack, victimNotifications: repeated, projectedPerHour: Math.round(repeated / ((Date.now() - t0) / 1000) * 3600) });
    for (const p of [bot, victim]) p.close();
  },

  // A5: one account opens DMs with many distinct recipients it barely knows,
  // paced just under the per-event socket gate (10 dm:send / 10 s) so the
  // new-conversation budget itself is what is measured.
  async dmspray() {
    const [owner, bot, ...victims] = await people('dm', 42);
    const c = await community(owner);
    await admit(c, [bot, ...victims]); // sharing a server is how the bot learns their ids
    const s = await bot.socket();
    const delivered = new Set();
    const codes = {};
    s.on('dm:message', (m) => { if (m?.clientNonce) delivered.add(m.clientNonce); });
    for (const ev of ['error:dm_rate', 'error:dm_privacy', 'error:message']) {
      s.on(ev, (e) => { const k = e?.code ?? ev; codes[k] = (codes[k] || 0) + 1; });
    }
    let gate = 0;
    s.on('error:ratelimit', () => { gate += 1; });
    const t0 = Date.now();
    for (const v of victims) {
      s.emit('dm:send', { toUserId: v.id, content: `hey ${rnd()} check spam.example/${rnd()}`, clientNonce: `n-${v.id}` });
      await sleep(1_100);
    }
    await sleep(3_000);
    const secs = (Date.now() - t0) / 1000;
    record('dmspray', 'ATK-05', `40 new DM conversations from one account over ${Math.round(secs)} s (under the socket gate)`, 'attack',
      delivered.size <= 12 ? 'BLOCKED' : delivered.size < 40 ? 'LIMITED' : 'OPEN',
      `${delivered.size}/40 distinct recipients reached; refusals ${JSON.stringify(codes)}; ${gate} dropped by the socket gate`,
      { newRecipientsReached: delivered.size, refusals: codes, socketGateDropped: gate, seconds: Math.round(secs) });
    bot.close();
  },

  // A6: one account joins and leaves a public community in a loop.
  async joinchurn() {
    const [owner, bot] = await people('churn', 2);
    const c = await community(owner, { discoverable: true });
    let joins = 0; let refused = 0;
    const t0 = Date.now();
    for (let i = 0; i < 15; i++) {
      const j = await bot.api('POST', `/api/servers/${c.serverId}/join`, {});
      if (j.status < 300) joins += 1; else refused += 1;
      await bot.api('POST', `/api/servers/${c.serverId}/leave`, {});
    }
    record('joinchurn', 'ATK-06', 'join/leave the same public community 15 times', 'attack',
      joins <= 3 ? 'BLOCKED' : joins < 15 ? 'LIMITED' : 'OPEN',
      `${joins}/15 joins accepted (${refused} refused) in ${Math.round((Date.now() - t0) / 1000)} s`, { accepted: joins, refused });
  },

  // A7: invite creation burst by a member, and one invite used by many.
  async invites() {
    const [owner, member] = await people('inv', 2);
    const c = await community(owner);
    await admit(c, [member]);
    let made = 0;
    for (let i = 0; i < 25; i++) {
      const r = await member.api('POST', '/api/servers/invites', { serverId: c.serverId });
      if (r.status < 300) made += 1;
    }
    record('invites', 'ATK-07', 'one member creates 25 invites back-to-back', 'attack',
      made <= 5 ? 'BLOCKED' : made < 25 ? 'LIMITED' : 'OPEN', `${made}/25 invites created`, { accepted: made });
  },

  // A8: coordinated raid — 60 fresh accounts (distinct addresses) hit ONE
  // public community at once through both entry routes, then post.
  async raid() {
    const owner = await person('raidown');
    const c = await community(owner, { discoverable: true });
    const raiders = await people('raider', 60);
    const t0 = Date.now();
    const responses = await Promise.all(raiders.map((r, i) => (i % 2
      ? r.api('POST', `/api/servers/${c.serverId}/join`, {})
      : r.api('POST', `/api/servers/invites/${c.invite}/use`, {}))));
    const burstMs = Date.now() - t0;
    const joined = raiders.filter((_, i) => responses[i].status < 300);
    const { posted, outcomes } = await postOnce(joined, c, 'RAID');
    // Collateral: an established person arriving right after can still join AND post.
    const late = await person('raidlate');
    ageAccounts([late]);
    const lateJoin = await late.api('POST', `/api/servers/invites/${c.invite}/use`, {});
    const latePost = lateJoin.status < 300 ? await postOnce([late], c, 'hello after raid') : { posted: 0 };
    const status = await owner.api('GET', `/api/servers/${c.serverId}/raid-protection`);
    record('raid', 'ATK-08', '60 fresh accounts from 60 addresses join one community at once (half invite, half public join), then post', 'attack',
      posted <= 5 ? 'BLOCKED' : posted < 60 ? 'LIMITED' : 'OPEN',
      `${joined.length}/60 joined in ${burstMs} ms; ${posted} raid messages persisted (${JSON.stringify(outcomes)}); established person right after: join ${lateJoin.status}, posted ${latePost.posted}/1; raid mode ${status.body?.active ? 'active' : 'inactive'}`,
      { joined: joined.length, raidMessages: posted, postOutcomes: outcomes, burstMs, statuses: tallyStatuses(responses),
        legitJoinAfterStatus: lateJoin.status, legitPostAfter: latePost.posted, raidMode: status.body ?? null });
  },

  // A9: a (buggy or hostile) client replays the same 20 ackIds five times.
  async replaystorm() {
    const [owner, bot] = await people('storm', 2);
    const c = await community(owner);
    await admit(c, [bot]);
    const s = await bot.socket();
    const w = sendWatcher(s);
    const ids = Array.from({ length: 20 }, ack);
    let acks = 0;
    s.on('message:ack', () => { acks += 1; });
    for (let round = 0; round < 5; round++) {
      ids.forEach((id, i) => w.send({ channelId: c.channelId, serverId: c.serverId, content: `storm ${i}`, ackId: id }));
      await sleep(200);
    }
    await sleep(5_000);
    const r = await owner.api('GET', `/api/channels/${c.channelId}/messages?limit=100`);
    const rows = Array.isArray(r.body) ? r.body : (r.body?.messages ?? []);
    const persisted = rows.filter((m) => String(m.content).startsWith('storm ')).length;
    record('replaystorm', 'ATK-09', '20 ackIds replayed 5× within 1 s', 'attack',
      persisted <= 20 ? 'BLOCKED' : 'OPEN',
      `${persisted} rows persisted for 20 ackIds (no duplicates means bounded); ${acks} acks for 100 emits, ${w.socketRateLimited} emits dropped by the socket gate`,
      { persisted, acks, socketGateDropped: w.socketRateLimited });
    bot.close();
  },

  // ── legitimate controls ────────────────────────────────────────────────────
  async legit_burst() {
    const [owner, u] = await people('lburst', 2);
    const c = await community(owner);
    await admit(c, [u]);
    const w = sendWatcher(await u.socket());
    const ids = [];
    for (const text of ['hey', 'did you see that', 'lol', 'ok brb']) {
      const id = ack(); ids.push(id);
      w.send({ channelId: c.channelId, serverId: c.serverId, content: text, ackId: id });
      await sleep(750);
    }
    await w.wait(ids, 8_000);
    const t = w.tally(ids);
    record('legit_burst', 'LEG-01', 'normal burst: 4 short messages in 3 s', 'control',
      t.ack === 4 && !w.warnings ? 'OK' : 'FALSE_POSITIVE', `${t.ack}/4 delivered, ${w.warnings} warnings`, { delivered: t.ack, warnings: w.warnings });
    u.close();
  },

  // Fast human typing short lines; several realistic gaps.
  async legit_fast() {
    for (const gap of [700, 1_000, 1_500]) {
      const [owner, u] = await people(`lfast${gap}`, 2);
      const c = await community(owner);
      await admit(c, [u]);
      const w = sendWatcher(await u.socket());
      const client = clientModel(w, { channelId: c.channelId, serverId: c.serverId });
      const ids = [];
      for (const text of ['wait', 'what', 'no way', 'that is insane', 'haha', 'ok but', 'seriously', 'brb']) {
        ids.push(client.type(text));
        await sleep(gap);
      }
      const r = await client.settle(ids);
      record('legit_fast', `LEG-02.${gap}`, `fast human: 8 short lines, one every ${gap} ms (production client)`, 'control',
        controlOutcome(r, 8, w.warnings),
        `${r.delivered}/8 delivered, ${r.holds} automatic holds, ${w.warnings} warnings, slowest delivery ${r.maxDelayMs} ms${r.muted ? ', MUTED' : ''}`,
        { gapMs: gap, ...r, warnings: w.warnings });
      u.close();
    }
  },

  async legit_chat() {
    const [owner, ...members] = await people('lchat', 13);
    const c = await community(owner);
    await admit(c, members);
    const sessions = await Promise.all(members.map(async (m) => {
      const w = sendWatcher(await m.socket());
      return { w, client: clientModel(w, { channelId: c.channelId, serverId: c.serverId }), ids: [] };
    }));
    const until = Date.now() + 45_000;
    await Promise.all(sessions.map(async (sess, k) => {
      await sleep(k * 150);
      while (Date.now() < until) {
        sess.ids.push(sess.client.type(`chat ${rnd()}`));
        await sleep(1_500 + Math.floor(Math.random() * 4_500));
      }
    }));
    let delivered = 0; let total = 0; let holds = 0; let warnings = 0; let maxDelayMs = 0; let muted = false;
    for (const sess of sessions) {
      const r = await sess.client.settle(sess.ids, 20_000);
      delivered += r.delivered; total += sess.ids.length; holds += r.holds; warnings += sess.w.warnings;
      maxDelayMs = Math.max(maxDelayMs, r.maxDelayMs ?? 0); muted ||= r.muted;
    }
    record('legit_chat', 'LEG-03', `active group chat: 12 people, 45 s, ${total} messages`, 'control',
      controlOutcome({ delivered, holds, maxDelayMs, muted }, total, warnings),
      `${delivered}/${total} delivered, ${holds} holds, ${warnings} warnings, slowest ${maxDelayMs} ms`,
      { messages: total, delivered, holds, warnings, maxDelayMs, falsePositiveRate: +((total - delivered) / Math.max(1, total)).toFixed(4) });
    for (const m of members) m.close();
  },

  // Messages typed while offline, replayed by the production client on reconnect.
  async legit_reconnect() {
    for (const queued of [5, 10, 25]) {
      const [owner, u] = await people(`lrec${queued}`, 2);
      const c = await community(owner);
      await admit(c, [u]);
      const w = sendWatcher(await u.socket());
      const client = clientModel(w, { channelId: c.channelId, serverId: c.serverId });
      const t0 = Date.now();
      const ids = client.replay(Array.from({ length: queued }, (_, i) => `typed offline ${i}`));
      const r = await client.settle(ids, 90_000);
      // A replay is background delivery: the yardstick is "nothing lost, nobody muted,
      // no silent drop"; its natural drain time (1 s per message) is reported, not judged.
      const outcome = r.delivered < queued || r.muted || w.socketRateLimited ? 'FALSE_POSITIVE' : (r.holds || w.warnings) ? 'FRICTION' : 'OK';
      record('legit_reconnect', `LEG-04.${queued}`, `reconnect replays ${queued} messages typed offline (client replay: ${CLIENT_REPLAY})`, 'control', outcome,
        `${r.delivered}/${queued} delivered in ${Math.round((Date.now() - t0) / 1000)} s; ${r.holds} holds, ${w.warnings} warnings, ${w.socketRateLimited} dropped by the socket gate${r.muted ? ', MUTED' : ''}`,
        { queued, ...r, warnings: w.warnings, socketGateDropped: w.socketRateLimited, convergeMs: Date.now() - t0, clientReplay: CLIENT_REPLAY });
      u.close();
    }
  },

  // ACK lost for already-delivered messages; the reconnect replays them all.
  async legit_acklost() {
    const [owner, u] = await people('lack', 2);
    const c = await community(owner);
    await admit(c, [u]);
    const texts = Array.from({ length: 25 }, (_, i) => `delivered ${i}`);
    let ids;
    {
      const w = sendWatcher(await u.socket());
      ids = texts.map(() => ack());
      for (const [i, id] of ids.entries()) {
        w.send({ channelId: c.channelId, serverId: c.serverId, content: texts[i], ackId: id });
        await sleep(1_100);
      }
      await w.wait(ids, 10_000);
      u.close();
    }
    const w = sendWatcher(await u.socket());
    const t0 = Date.now();
    if (CLIENT_REPLAY === 'burst') ids.forEach((id, i) => w.send({ channelId: c.channelId, serverId: c.serverId, content: texts[i], ackId: id }));
    else for (const [i, id] of ids.entries()) { w.send({ channelId: c.channelId, serverId: c.serverId, content: texts[i], ackId: id }); if (i < ids.length - 1) await sleep(HOLD_SPACING_MS); }
    await w.wait(ids, 15_000);
    const t = w.tally(ids);
    const r = await owner.api('GET', `/api/channels/${c.channelId}/messages?limit=100`);
    const rows = (Array.isArray(r.body) ? r.body : (r.body?.messages ?? [])).filter((m) => String(m.content).startsWith('delivered '));
    record('legit_acklost', 'LEG-05', `25 delivered messages whose ACK was lost are replayed (client replay: ${CLIENT_REPLAY})`, 'control',
      t.ack === 25 && rows.length === 25 ? 'OK' : 'FALSE_POSITIVE',
      `${t.ack}/25 re-acknowledged in ${Math.round((Date.now() - t0) / 1000)} s, ${rows.length} rows (no duplicates); ${t.none} got no ACK (${w.socketRateLimited} dropped by the socket gate)`,
      { reAcked: t.ack, persisted: rows.length, noAck: t.none, socketGateDropped: w.socketRateLimited, clientReplay: CLIENT_REPLAY });
    u.close();
  },

  async legit_retry() {
    const [owner, u] = await people('lretry', 2);
    const c = await community(owner);
    await admit(c, [u]);
    const w = sendWatcher(await u.socket());
    const id = ack();
    let acks = 0;
    u.sockets[0].on('message:ack', (a) => { if (a?.ackId === id) acks += 1; });
    for (let i = 0; i < 4; i++) {
      w.send({ channelId: c.channelId, serverId: c.serverId, content: 'slow network hello', ackId: id });
      await sleep(2_000);
    }
    const r = await owner.api('GET', `/api/channels/${c.channelId}/messages?limit=20`);
    const rows = (Array.isArray(r.body) ? r.body : (r.body?.messages ?? [])).filter((m) => m.content === 'slow network hello');
    record('legit_retry', 'LEG-06', 'slow client resends one message 4× (same ackId, 2 s apart)', 'control',
      rows.length === 1 && acks === 4 && !w.warnings ? 'OK' : 'FALSE_POSITIVE',
      `${rows.length} row persisted, ${acks}/4 acks, ${w.warnings} warnings`, { persisted: rows.length, acks });
    u.close();
  },

  async legit_joins() {
    const owner = await person('ljoinown');
    const cs = [await community(owner, { discoverable: true }), await community(owner, { discoverable: true }), await community(owner, { discoverable: true })];
    const u = await person('ljoin');
    let ok = 0;
    for (const c of cs) { const r = await u.api('POST', `/api/servers/${c.serverId}/join`, {}); if (r.status < 300) ok += 1; await sleep(3_000); }
    record('legit_joins', 'LEG-07', 'one person joins 3 public communities in ~10 s', 'control', ok === 3 ? 'OK' : 'FALSE_POSITIVE', `${ok}/3 joined`, { joined: ok });
  },

  // Organic surge: an event announcement brings many real people at once.
  async legit_event() {
    const owner = await person('levown');
    const c = await community(owner, { discoverable: true });
    const fans = await people('fan', 25);
    ageAccounts(fans);
    const t0 = Date.now();
    const res = [];
    await Promise.all(fans.map(async (f, i) => {
      await sleep(Math.floor((i / fans.length) * 15_000));
      res.push(await f.api('POST', i % 2 ? `/api/servers/${c.serverId}/join` : `/api/servers/invites/${c.invite}/use`, {}));
    }));
    const ok = res.filter((r) => r.status < 300).length;
    record('legit_event', 'LEG-08', '25 people join one community within 15 s after an announcement', 'control',
      ok === 25 ? 'OK' : 'FALSE_POSITIVE', `${ok}/25 joined in ${Math.round((Date.now() - t0) / 1000)} s`,
      { joined: ok, refused: 25 - ok, statuses: tallyStatuses(res) });
  },

  // A large organic surge (big community launch): 40 established people in
  // 10 s — crosses the balanced raid threshold — then everyone says hello.
  async legit_surge() {
    const owner = await person('lsurgeown');
    const c = await community(owner, { discoverable: true });
    const fans = await people('surge', 40);
    ageAccounts(fans);
    const t0 = Date.now();
    const res = await Promise.all(fans.map(async (f, i) => {
      await sleep(Math.floor((i / fans.length) * 10_000));
      return f.api('POST', i % 2 ? `/api/servers/${c.serverId}/join` : `/api/servers/invites/${c.invite}/use`, {});
    }));
    const joined = fans.filter((_, i) => res[i].status < 300);
    const { posted, outcomes } = await postOnce(joined, c, 'hello');
    record('legit_surge', 'LEG-10', '40 established people join one community within 10 s (large launch), then post', 'control',
      joined.length === 40 && posted === 40 ? 'OK' : 'FALSE_POSITIVE',
      `${joined.length}/40 joined in ${Math.round((Date.now() - t0) / 1000)} s, ${posted}/${joined.length} posted (${JSON.stringify(outcomes)})`,
      { joined: joined.length, posted, postOutcomes: outcomes, statuses: tallyStatuses(res) });
  },

  // The measured trade-off: brand-new legitimate accounts that arrive inside a
  // detected surge can join and read but are held from posting until raid mode
  // ends — and a moderator can lift that immediately.
  async legit_newcomers() {
    const owner = await person('lnewown');
    const c = await community(owner, { discoverable: true });
    const newcomers = await people('newcomer', 40);
    const res = await Promise.all(newcomers.map(async (f, i) => {
      await sleep(Math.floor((i / newcomers.length) * 10_000));
      return f.api('POST', i % 2 ? `/api/servers/${c.serverId}/join` : `/api/servers/invites/${c.invite}/use`, {});
    }));
    const joined = newcomers.filter((_, i) => res[i].status < 300);
    const before = await postOnce(joined, c, 'first hello');
    const lift = await owner.api('PATCH', `/api/servers/${c.serverId}/raid-protection`, { clearLockdown: true });
    const after = await postOnce(joined, c, 'hello again');
    record('legit_newcomers', 'LEG-11', '40 brand-new accounts join within 10 s, post; a moderator ends raid mode; they post again', 'control',
      joined.length === 40 && before.posted === 40 ? 'OK' : 'FALSE_POSITIVE',
      `${joined.length}/40 joined; posted ${before.posted}/40 while raid mode held them (${JSON.stringify(before.outcomes)}); moderator lift ${lift.status} released ${lift.body?.releasedHolds ?? '?'} holds; then ${after.posted}/40 posted`,
      { joined: joined.length, postedDuringHold: before.posted, liftStatus: lift.status, releasedHolds: lift.body?.releasedHolds ?? null, postedAfterLift: after.posted });
  },

  // A moderator cleaning up after a raid: ban 40 accounts as fast as possible.
  // P7 B2: a correctly signed-in moderator (fresh sign-in) carries the sign-in's
  // moderation-burst grant, exactly as the client does, so the burst step-up
  // never interrupts this cleanup (the step-up lab measures the older-session case).
  async legit_modops() {
    const owner = await person('lmod');
    const c = await community(owner);
    const raiders = await people('cleanup', 40);
    await admit(c, raiders);
    const t0 = Date.now();
    let ok = 0; const statuses = [];
    for (const r of raiders) {
      const grant = owner.stepUp['moderation-burst'];
      const res = await owner.api('POST', `/api/servers/${c.serverId}/bans`, { userId: r.id, reason: 'raid cleanup' },
        { headers: grant ? { 'X-Bridge-Step-Up': grant } : {} });
      statuses.push(res.status);
      if (res.status < 300) ok += 1;
    }
    record('legit_modops', 'LEG-09', 'owner bans 40 raid accounts back-to-back', 'control',
      ok === 40 ? 'OK' : 'FALSE_POSITIVE', `${ok}/40 bans applied in ${Math.round((Date.now() - t0) / 1000)} s`,
      { applied: ok, refused: 40 - ok, statuses: tallyStatuses(statuses.map((status) => ({ status }))) });
  },

  // ── Legitimate neighbours of the mention and DM controls (ported from #127's
  // lab, where they were LEG-03/04/05; renumbered because #129 already uses
  // those ids). B1 changed both paths — mention notifications are capped per
  // sender→target and new DM conversations are budgeted — so ordinary use of
  // each must be shown to pass untouched, not only the attack to be stopped.

  // One person mentions one member once: the message lands and the member gets
  // exactly one mention notification.
  async legit_mention() {
    const [owner, speaker, friend] = await people('lmen', 3);
    const c = await community(owner);
    await admit(c, [speaker, friend]);
    const fs = await friend.socket();
    const pings = [];
    fs.on('mention:received', (m) => pings.push(m));
    const w = sendWatcher(await speaker.socket());
    const id = ack();
    w.send({ channelId: c.channelId, serverId: c.serverId, content: `hi <@${friend.id}>, see you at the event ${rnd()}`, ackId: id });
    await w.wait([id], 8_000);
    await sleep(1_500);
    const kind = w.outcomes.get(id)?.kind ?? 'none';
    record('legit_mention', 'LEG-12', 'one explicit mention of one member (#127 LEG-03)', 'control',
      kind === 'ack' && pings.length === 1 ? (w.warnings ? 'FRICTION' : 'OK') : 'FALSE_POSITIVE',
      `message ${kind}; mentioned member received ${pings.length} notification(s)`,
      { accepted: kind === 'ack' ? 1 : 0, notifications: pings.length, warnings: w.warnings });
    for (const p of [speaker, friend]) p.close();
  },

  // Two friends with an open conversation: 5 DMs, one every 1.1 s. An existing
  // conversation never spends the new-conversation budget.
  async legit_dmchat() {
    const [owner, alice, bob] = await people('ldmc', 3);
    const c = await community(owner);
    await admit(c, [alice, bob]);
    const open = await alice.api('POST', `/api/dm/${bob.id}`, {});
    if (open.status >= 300) throw new Error(`dm open ${open.status} ${JSON.stringify(open.body)}`);
    const r = await dmBatch(await alice.socket(), Array.from({ length: 5 }, () => bob), 1_100);
    record('legit_dmchat', 'LEG-13', '5 DMs in an existing conversation, 1.1 s apart (#127 LEG-04)', 'control',
      r.delivered === 5 ? 'OK' : 'FALSE_POSITIVE',
      `${r.delivered}/5 delivered; refusals ${JSON.stringify(r.refusals)}; ${r.socketGateDropped} dropped by the socket gate`, r);
    for (const p of [alice, bob]) p.close();
  },

  // Someone new to a community messages three members they just met, 1.5 s
  // apart: three NEW conversations, well inside the budget.
  async legit_dmfew() {
    const [owner, newcomer, ...members] = await people('ldmf', 5);
    const c = await community(owner);
    await admit(c, [newcomer, ...members]);
    const r = await dmBatch(await newcomer.socket(), members, 1_500);
    record('legit_dmfew', 'LEG-14', 'DMs to 3 new recipients, 1.5 s apart (#127 LEG-05)', 'control',
      r.delivered === 3 ? 'OK' : 'FALSE_POSITIVE',
      `${r.delivered}/3 new conversations delivered; refusals ${JSON.stringify(r.refusals)}; ${r.socketGateDropped} dropped by the socket gate`, r);
    for (const p of [newcomer, ...members]) p.close();
  },
};

// ── main ─────────────────────────────────────────────────────────────────────
let exitCode = 0;
const resources = {};
try {
  console.log(`abuse lab (${LABEL}) — work dir: ${cluster.workDir}`);
  await cluster.up();
  record('env', 'ENV-01', 'production requires REDIS_URL (server/lib/env.ts); the in-process limiter fallback is reachable only outside production', 'info', 'INFO', '');
  for (const name of selected) {
    if (!S[name]) throw new Error(`unknown scenario ${name}`);
    console.log(`\n=== ${name} ===`);
    const before = procSample();
    const t0 = Date.now();
    try {
      await S[name]();
    } catch (err) {
      record(name, `${name}:crash`, 'scenario aborted', 'info', 'INFO', err.stack || String(err));
      exitCode = 1;
    }
    resources[name] = { wallMs: Date.now() - t0, ...resourceDelta(before, procSample()) };
    console.log(`  [RESOURCE] ${JSON.stringify(resources[name])}`);
  }
} catch (err) {
  console.error(err);
  exitCode = 1;
} finally {
  if (!flag('keep')) await cluster.down().catch(() => undefined);
}

// Gate: controls must not false-positive; attacks must meet their recorded floor.
const gateFailures = [];
if (GATE) {
  for (const r of results) {
    if (r.kind === 'control' && r.outcome === 'FALSE_POSITIVE' && !EXPECT[r.id]?.knownFalsePositive) gateFailures.push(`${r.id} false positive`);
    const floor = EXPECT[r.id]?.atLeast;
    if (r.kind === 'attack' && floor && ORDER[r.outcome] < ORDER[floor]) gateFailures.push(`${r.id} ${r.outcome} < ${floor}`);
  }
  if (gateFailures.length) exitCode = 1;
}

const summary = {
  attacks: Object.fromEntries(['BLOCKED', 'LIMITED', 'OPEN'].map((o) => [o, results.filter((r) => r.kind === 'attack' && r.outcome === o).length])),
  controls: Object.fromEntries(['OK', 'FRICTION', 'FALSE_POSITIVE'].map((o) => [o, results.filter((r) => r.kind === 'control' && r.outcome === o).length])),
};
const report = { label: LABEL, generatedAt: new Date().toISOString(), topology: cluster.topology(), summary, gate: GATE ? { failures: gateFailures } : null, results, resources };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const md = [
  `# Abuse lab — ${LABEL}`, '', `Generated ${report.generatedAt}. Nodes: ${cluster.nodeNames.join(', ')} (shared PostgreSQL + Redis).`, '',
  `Attacks: ${JSON.stringify(summary.attacks)} · Controls: ${JSON.stringify(summary.controls)}`, '',
  '| id | kind | outcome | scenario | detail |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.kind} | ${r.outcome} | ${r.name.replace(/\|/g, '\\|')} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
  '', '## Resources per scenario', '', '```json', JSON.stringify(resources, null, 2), '```',
  ...(GATE ? ['', `Gate: ${gateFailures.length ? gateFailures.join('; ') : 'pass'}`] : []),
].join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), md + '\n');
console.log(`\nSUMMARY ${JSON.stringify(summary)}${GATE ? ` gate=${gateFailures.length ? 'FAIL ' + gateFailures.join('; ') : 'pass'}` : ''}`);
console.log(`report: ${path.join(outDir, 'report.md')}`);
process.exit(exitCode);
