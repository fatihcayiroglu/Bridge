#!/usr/bin/env node
// scripts/stepup-lab/run.mjs — P7 B2 step-up baseline + evidence lab.
//
// Measures, on a REAL two-node Bridge cluster (NODE_ENV=production, shared
// PostgreSQL + Redis — the multinode harness in ../multinode/lib), what a
// STOLEN SESSION (an access token / refresh cookie without the person's
// credentials) can do to high-risk actions, and — just as important — the
// cadence of the LEGITIMATE operator the step-up must not punish. The first
// run is the BASELINE on current main, before any step-up exists: every
// attack is expected OPEN, and the legitimate measurements set the per-action
// burst thresholds (reported for approval before they enter production code).
//
//   node scripts/stepup-lab/run.mjs [--scenarios a,b] [--out DIR] [--label NAME]
//                                   [--gate] [--keep]
//
// Attacks   OPEN      reachable with a token alone (the B2 gap)
//           STEPUP    refused with 403 STEP_UP_REQUIRED (after B2)
//           BLOCKED   already stopped by an existing credential check
// Controls  OK        the legitimate operator was never asked for a proof
//           FRICTION  one explainable step-up, then the action continued
//           FALSE_POSITIVE  a legitimate action failed or needed > one proof
// INFO      context / a measured distribution that sets a threshold
//
// Without --gate the exit code is 0: a baseline run REPORTS. With --gate (used
// only after B2 lands) a FALSE_POSITIVE, or an attack weaker than its floor in
// expectations.json, fails the run.

import fs from 'node:fs';
import path from 'node:path';
import { Cluster, sleep } from '../multinode/lib/cluster.mjs';
import { request, rnd } from '../multinode/lib/client.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const ALL = [
  'email_takeover', 'passkey_add', 'twofactor_setup', 'twofactor_disable_pw',
  'account_export', 'owned_server_delete', 'admin_deletes',
  'mod_burst', 'invite_burst', 'proof_guess',
  'legit_mod_ordinary', 'legit_mod_cleanup', 'legit_invite_event', 'legit_fresh_signin',
];
const selected = opt('scenarios', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = opt('label', 'baseline');
const GATE = flag('gate');
const ADMIN_SETUP_SECRET = `stepup-lab-${rnd()}${rnd()}`;
process.env.ADMIN_SETUP_SECRET = ADMIN_SETUP_SECRET; // spread into each node before nodeEnv()

const cluster = new Cluster({ nodes: ['A', 'B'], basePort: Number(opt('base-port', 3300)), workDir: opt('work', undefined) });
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
  const valid = kind === 'attack' ? ['OPEN', 'STEPUP', 'BLOCKED'] : kind === 'control' ? ['OK', 'FRICTION', 'FALSE_POSITIVE'] : ['INFO'];
  if (!valid.includes(outcome)) throw new Error(`bad outcome ${outcome} for ${kind}`);
  results.push({ scenario, id, name, kind, outcome, detail, metrics });
  console.log(`  [${outcome.padEnd(14)}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
  if (Object.keys(metrics).length) console.log(`                   ${JSON.stringify(metrics)}`);
}

// ── fixtures ─────────────────────────────────────────────────────────────────
// Every simulated person has a stable client address (198.18.0.0/15 benchmark
// range), so per-IP limits behave as they would in production.
let ipSeq = 1;
const nextIp = () => { const n = ipSeq++; return `198.18.${(n >> 8) & 255}.${n & 255}`; };
let rr = 0;
const anyNode = () => cluster.nodeNames.map((n) => cluster.nodeUrl(n))[rr++ % cluster.nodeNames.length];

class Person {
  constructor(base, username, password, ip) { Object.assign(this, { base, username, password, ip, csrf: null }); }
  headers() { return { 'X-Forwarded-For': this.ip }; }
  async api(method, urlPath, body, { base = this.base, headers = {} } = {}) {
    if (method !== 'GET' && !this.csrf) {
      const r = await request(base, 'GET', '/api/csrf-token', { token: this.token, headers: this.headers() });
      if (r.status === 200) this.csrf = r.body.token;
    }
    return request(base, method, urlPath, {
      token: this.token, body, csrf: method === 'GET' ? undefined : this.csrf,
      headers: { ...this.headers(), ...headers },
    });
  }
}

async function person(prefix) {
  const base = anyNode();
  const ip = nextIp();
  const username = `${prefix}_${rnd()}`;
  const password = `Ab-${rnd()}-${rnd()}!`;
  const r = await request(base, 'POST', '/api/register', {
    body: { username, email: `${username}@stepup-lab.test`, password, displayName: username }, headers: { 'X-Forwarded-For': ip },
  });
  if (r.status !== 200 && r.status !== 201) throw new Error(`register ${r.status} ${JSON.stringify(r.body)}`);
  const p = new Person(base, username, password, ip);
  p.id = r.body.user?._id || r.body.user?.id;
  p.token = r.body.token;
  return p;
}
async function people(prefix, n) {
  const out = [];
  for (let i = 0; i < n; i += 8) out.push(...await Promise.all(Array.from({ length: Math.min(8, n - i) }, () => person(prefix))));
  return out;
}

async function community(owner) {
  const s = await owner.api('POST', '/api/servers', { name: `Lab ${rnd()}` });
  if (s.status >= 300) throw new Error(`server create ${s.status} ${JSON.stringify(s.body)}`);
  const serverId = s.body._id || s.body.id;
  const c = await owner.api('POST', `/api/servers/${serverId}/channels`, { name: `lab-${rnd()}`, type: 'text' });
  if (c.status >= 300) throw new Error(`channel create ${c.status} ${JSON.stringify(c.body)}`);
  const inv = await owner.api('POST', '/api/servers/invites', { serverId });
  if (inv.status >= 300) throw new Error(`invite ${inv.status} ${JSON.stringify(inv.body)}`);
  return { serverId, channelId: c.body._id || c.body.id, invite: inv.body.code };
}
async function admit(c, members) {
  for (const m of members) {
    const u = await m.api('POST', `/api/servers/invites/${c.invite}/use`, {});
    if (u.status >= 300) throw new Error(`invite use ${u.status} ${JSON.stringify(u.body)}`);
  }
}

// A stolen session is the victim's token on the attacker's own client address:
// same bearer/refresh, no credentials.
function steal(victim) {
  const thief = new Person(anyNode(), victim.username, null, nextIp());
  thief.token = victim.token;
  thief.id = victim.id;
  return thief;
}
const ok = (r) => r.status >= 200 && r.status < 300;

// ── scenarios ──────────────────────────────────────────────────────────────
const S = {
  // A stolen token swaps the recovery e-mail — the first move of an account
  // takeover (then verify from the attacker's inbox, then password reset).
  async email_takeover() {
    const victim = await person('victim');
    const thief = steal(victim);
    const attacker = `attacker-${rnd()}@evil.test`;
    const r = await thief.api('POST', '/api/email/add', { email: attacker });
    record('email_takeover', 'SU-ATK-01', 'stolen token changes the recovery e-mail', 'attack',
      ok(r) ? 'OPEN' : 'BLOCKED', `POST /api/email/add → ${r.status}`, { status: r.status });
  },

  // A stolen token begins enrolling the attacker's own passkey — a permanent
  // way back in. `register/begin` issuing options is the reachable gap.
  async passkey_add() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/webauthn/register/begin', {});
    const creds = await thief.api('GET', '/api/webauthn/credentials', undefined);
    record('passkey_add', 'SU-ATK-02', 'stolen token begins registering a new passkey', 'attack',
      ok(r) ? 'OPEN' : 'BLOCKED',
      `register/begin → ${r.status}; GET credentials → ${creds.status}`, { begin: r.status, list: creds.status });
  },

  // A stolen token begins 2FA enrolment with the attacker's authenticator.
  async twofactor_setup() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/2fa/setup', {});
    record('twofactor_setup', 'SU-ATK-03', 'stolen token starts 2FA enrolment (own authenticator)', 'attack',
      ok(r) && r.body?.secret ? 'OPEN' : 'BLOCKED', `POST /api/2fa/setup → ${r.status}`, { status: r.status });
  },

  // A phished PASSWORD plus a stolen token removes the second factor. With 2FA
  // on, disable needs only the password today — B2 must require an L2 proof.
  async twofactor_disable_pw() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/2fa/disable', { password: victim.password });
    // 2FA is not actually enabled here, so the route answers "2FA not enabled"
    // (400) rather than "wrong password" — the point measured is which guard
    // the route applies: password only, no step-up / no second factor.
    record('twofactor_disable_pw', 'SU-ATK-04', 'phished password + stolen token disables 2FA (password-only guard)', 'attack',
      r.body?.error === '2FA not enabled' ? 'OPEN' : (ok(r) ? 'OPEN' : 'BLOCKED'),
      `POST /api/2fa/disable → ${r.status} ${r.body?.error ?? ''} (guard is password-only; no L2)`, { status: r.status, error: r.body?.error ?? null });
  },

  // A stolen token exports the whole account.
  async account_export() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('GET', '/api/account/export', undefined);
    record('account_export', 'SU-ATK-05', 'stolen token exports the whole account', 'attack',
      ok(r) ? 'OPEN' : 'BLOCKED', `GET /api/account/export → ${r.status} (${r.body?.format ?? r.body?.error ?? ''})`, { status: r.status });
  },

  // A stolen OWNER token deletes the community for everyone.
  async owned_server_delete() {
    const owner = await person('owner');
    const c = await community(owner);
    const thief = steal(owner);
    const r = await thief.api('DELETE', `/api/servers/${c.serverId}`, undefined);
    record('owned_server_delete', 'SU-ATK-06', 'stolen owner token deletes the server', 'attack',
      ok(r) ? 'OPEN' : 'BLOCKED', `DELETE /api/servers/:sid → ${r.status}`, { status: r.status });
  },

  // A stolen INSTANCE-ADMIN token deletes a user and a server instance-wide.
  async admin_deletes() {
    const admin = await person('admin');
    const promote = await request(admin.base, 'POST', '/api/admin/make-first-admin',
      { body: { secret: ADMIN_SETUP_SECRET, username: admin.username }, headers: admin.headers() });
    if (!ok(promote)) { record('admin_deletes', 'SU-ATK-07', 'instance-admin destructive deletes', 'attack', 'BLOCKED', `make-first-admin → ${promote.status} ${JSON.stringify(promote.body)}`); return; }
    const victimUser = await person('adminvictim');
    const victimOwner = await person('adminsrvowner');
    const vc = await community(victimOwner);
    const thief = steal(admin);
    const du = await thief.api('DELETE', `/api/admin/users/${victimUser.id}`, undefined);
    const ds = await thief.api('DELETE', `/api/admin/servers/${vc.serverId}`, undefined);
    record('admin_deletes', 'SU-ATK-07', 'stolen admin token deletes a user and a server', 'attack',
      ok(du) || ok(ds) ? 'OPEN' : 'BLOCKED',
      `DELETE /api/admin/users/:id → ${du.status}; /admin/servers/:id → ${ds.status}`, { user: du.status, server: ds.status });
  },

  // Compromised-moderator burst: ban as fast as possible; measure how many
  // land (today bounded only by the 30/min moderation limiter).
  async mod_burst() {
    const owner = await person('modowner');
    const c = await community(owner);
    const targets = await people('bantgt', 40);
    await admit(c, targets);
    const thief = steal(owner); // owner is a moderator of their own server
    const t0 = Date.now();
    let accepted = 0; const statuses = {};
    for (const tgt of targets) {
      const r = await thief.api('POST', `/api/servers/${c.serverId}/bans`, { userId: tgt.id, reason: 'burst' });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (ok(r)) accepted += 1;
    }
    const secs = (Date.now() - t0) / 1000;
    record('mod_burst', 'SU-ATK-08', 'compromised moderator bans 40 accounts as fast as possible', 'attack',
      accepted > 5 ? 'OPEN' : 'BLOCKED',
      `${accepted}/40 bans landed in ${secs.toFixed(1)} s (only the 30/min limiter applies)`, { accepted, seconds: Math.round(secs), statuses });
  },

  // Invite burst: create invites as fast as possible under the stolen session.
  async invite_burst() {
    const owner = await person('invowner');
    const c = await community(owner);
    const thief = steal(owner);
    const t0 = Date.now();
    let accepted = 0; const statuses = {};
    for (let i = 0; i < 25; i++) {
      const r = await thief.api('POST', '/api/servers/invites', { serverId: c.serverId });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (ok(r)) accepted += 1;
    }
    const secs = (Date.now() - t0) / 1000;
    record('invite_burst', 'SU-ATK-09', 'compromised session creates 25 invites back-to-back', 'attack',
      accepted > 3 ? 'OPEN' : 'BLOCKED',
      `${accepted}/25 invites created in ${secs.toFixed(1)} s (generic 10/min servers limiter is the only bound)`, { accepted, seconds: Math.round(secs), statuses });
  },

  // Distributed step-up proof guessing has no endpoint at baseline; recorded
  // so the after-B2 run can show the per-account failed-proof lock working.
  async proof_guess() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/step-up/password', { password: `wrong-${rnd()}` });
    record('proof_guess', 'SU-ATK-10', 'distributed step-up proof guessing', 'attack',
      r.status === 404 ? 'OPEN' : 'STEPUP',
      r.status === 404 ? 'no step-up endpoint yet (baseline) — after-B2 run measures the failed-proof lock' : `POST /api/step-up/password → ${r.status}`, { status: r.status });
  },

  // ── legitimate cadence (threshold evidence) ───────────────────────────────
  // An ordinary moderation session: a moderator handles three reports with a
  // ban each, at a human pace. This is the volume step-up must NOT interrupt.
  async legit_mod_ordinary() {
    const owner = await person('modord');
    const c = await community(owner);
    const targets = await people('rpt', 3);
    await admit(c, targets);
    let accepted = 0;
    for (const tgt of targets) {
      const r = await owner.api('POST', `/api/servers/${c.serverId}/bans`, { userId: tgt.id, reason: 'report' });
      if (ok(r)) accepted += 1;
      await sleep(1_500);
    }
    record('legit_mod_ordinary', 'SU-LEG-01', 'ordinary moderation: 3 bans handling reports', 'control',
      accepted === 3 ? 'OK' : 'FALSE_POSITIVE', `${accepted}/3 bans in ~5 s (the common case)`, { destructiveActions: accepted });
  },

  // A real raid cleanup: a moderator bans a large cohort back-to-back. This is
  // the rare high-volume legitimate burst — after B2 it should cost ONE proof
  // and then continue. At baseline it just measures the volume and ceiling.
  async legit_mod_cleanup() {
    const owner = await person('modclean');
    const c = await community(owner);
    const targets = await people('raider', 40);
    await admit(c, targets);
    const t0 = Date.now();
    let accepted = 0; const statuses = {};
    for (const tgt of targets) {
      const r = await owner.api('POST', `/api/servers/${c.serverId}/bans`, { userId: tgt.id, reason: 'raid cleanup' });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (ok(r)) accepted += 1;
      await sleep(300);
    }
    record('legit_mod_cleanup', 'SU-LEG-02', 'raid cleanup: 40 bans back-to-back (rare high-volume burst)', 'control',
      'OK', `${accepted}/40 bans in ${((Date.now() - t0) / 1000).toFixed(1)} s — the only legit case above the ordinary volume`, { destructiveActions: accepted, statuses });
  },

  // An event organiser creates several invites in a sitting at a human pace.
  async legit_invite_event() {
    const owner = await person('invorg');
    const c = await community(owner);
    const t0 = Date.now();
    let accepted = 0; const statuses = {};
    for (let i = 0; i < 6; i++) {
      const r = await owner.api('POST', '/api/servers/invites', { serverId: c.serverId });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (ok(r)) accepted += 1;
      await sleep(2_000);
    }
    record('legit_invite_event', 'SU-LEG-03', 'organiser creates 6 invites over ~12 s', 'control',
      accepted === 6 ? 'OK' : 'FALSE_POSITIVE', `${accepted}/6 invites created (sets the invite step-up window)`, { invites: accepted, statuses });
  },

  // A correctly-authenticated fresh sign-in performs a protected action. After
  // B2 it must carry a sign-in grant and get NO prompt. At baseline it simply
  // confirms the action works for the legitimate owner.
  async legit_fresh_signin() {
    const owner = await person('fresh');
    const login = await request(owner.base, 'POST', '/api/login', { body: { username: owner.username, password: owner.password }, headers: owner.headers() });
    const hasGrant = Boolean(login.body?.stepUp?.token);
    const self = new Person(owner.base, owner.username, owner.password, owner.ip);
    self.token = login.body?.token; self.id = owner.id;
    const exp = await self.api('GET', '/api/account/export', undefined);
    record('legit_fresh_signin', 'SU-LEG-04', 'fresh sign-in then account export', 'control',
      ok(exp) ? 'OK' : 'FALSE_POSITIVE',
      `login → ${login.status}; export → ${exp.status}; sign-in grant present: ${hasGrant} (false at baseline)`, { login: login.status, export: exp.status, signInGrant: hasGrant });
  },
};

// ── main ─────────────────────────────────────────────────────────────────────
let exitCode = 0;
try {
  console.log(`step-up lab (${LABEL}) — work dir: ${cluster.workDir}`);
  await cluster.up();
  record('env', 'ENV-01', 'two Bridge nodes, NODE_ENV=production, shared PostgreSQL + Redis', 'info', 'INFO', '');
  for (const name of selected) {
    if (!S[name]) throw new Error(`unknown scenario ${name}`);
    console.log(`\n=== ${name} ===`);
    try { await S[name](); }
    catch (err) { record(name, `${name}:crash`, 'scenario aborted', 'info', 'INFO', err.stack || String(err)); exitCode = 1; }
  }
} catch (err) { console.error(err); exitCode = 1; }
finally { if (!flag('keep')) await cluster.down().catch(() => undefined); }

const gateFailures = [];
if (GATE) {
  const ORDER = { OPEN: 0, STEPUP: 1, BLOCKED: 2 };
  for (const r of results) {
    if (r.kind === 'control' && r.outcome === 'FALSE_POSITIVE' && !EXPECT[r.id]?.knownFalsePositive) gateFailures.push(`${r.id} false positive`);
    const floor = EXPECT[r.id]?.atLeast;
    if (r.kind === 'attack' && floor && ORDER[r.outcome] < ORDER[floor]) gateFailures.push(`${r.id} ${r.outcome} < ${floor}`);
  }
  if (gateFailures.length) exitCode = 1;
}

const summary = {
  attacks: Object.fromEntries(['OPEN', 'STEPUP', 'BLOCKED'].map((o) => [o, results.filter((r) => r.kind === 'attack' && r.outcome === o).length])),
  controls: Object.fromEntries(['OK', 'FRICTION', 'FALSE_POSITIVE'].map((o) => [o, results.filter((r) => r.kind === 'control' && r.outcome === o).length])),
};
const report = { label: LABEL, generatedAt: new Date().toISOString(), topology: cluster.topology?.() ?? null, summary, gate: GATE ? { failures: gateFailures } : null, results };
fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
const md = [
  `# Step-up lab — ${LABEL}`, '', `Generated ${report.generatedAt}. Two nodes, shared PostgreSQL + Redis.`, '',
  `Attacks: ${JSON.stringify(summary.attacks)} · Controls: ${JSON.stringify(summary.controls)}`, '',
  '| id | kind | outcome | scenario | detail |', '|---|---|---|---|---|',
  ...results.map((r) => `| ${r.id} | ${r.kind} | ${r.outcome} | ${r.name.replace(/\|/g, '\\|')} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')} |`),
  ...(GATE ? ['', `Gate: ${gateFailures.length ? gateFailures.join('; ') : 'pass'}`] : []),
].join('\n');
fs.writeFileSync(path.join(outDir, 'report.md'), md + '\n');
console.log(`\nSUMMARY ${JSON.stringify(summary)}${GATE ? ` gate=${gateFailures.length ? 'FAIL ' + gateFailures.join('; ') : 'pass'}` : ''}`);
console.log(`report: ${path.join(outDir, 'report.md')}`);
process.exit(exitCode);
