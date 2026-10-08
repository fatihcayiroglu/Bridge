#!/usr/bin/env node
// scripts/stepup-lab/run.mjs — P7 B2 step-up baseline + evidence lab.
//
// Measures, on a REAL two-node Bridge cluster (NODE_ENV=production, shared
// PostgreSQL + Redis — the multinode harness in ../multinode/lib), what a
// STOLEN SESSION (an access token / refresh cookie without the person's
// credentials) can do to high-risk actions, and — just as important — what the
// LEGITIMATE person experiences. The baseline run (current main, before step-up)
// had every attack OPEN and set the burst thresholds; the after-B2 run is gated.
//
//   node scripts/stepup-lab/run.mjs [--scenarios a,b] [--out DIR] [--label NAME]
//                                   [--gate] [--keep]
//
// Attacks   OPEN      reachable with a token alone (the B2 gap)
//           STEPUP    refused with 403 STEP_UP_REQUIRED
//           BLOCKED   stopped outright (an existing credential check, or the
//                     failed-proof lock)
// Controls  OK        the legitimate person was never asked for a proof
//           FRICTION  exactly one explainable proof, then the action continued
//           FALSE_POSITIVE  a legitimate action failed or needed > one proof
// INFO      context / a measured distribution
//
// The simulated LEGITIMATE client behaves like client/js/core/step-up.ts: it
// keeps the grants its sign-in returned (memory only), sends the grant for the
// action's scope in X-Bridge-Step-Up, and on a 403 STEP_UP_REQUIRED performs ONE
// proof (password, or a TOTP / backup code for a 2FA account) and retries once.
// A THIEF holds only the stolen access token — never the victim's in-memory
// grants — and every simulated person has its own client address. Requests
// alternate nodes, so grants minted on one node are verified on the other.
//
// Without --gate the exit code is 0: a run REPORTS. With --gate a control whose
// outcome differs from its expectation, or an attack weaker than its floor in
// expectations.json (OPEN < STEPUP < BLOCKED), fails the run.

import crypto from 'node:crypto';
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
  'grant_after_revocation', 'grant_other_account', 'grant_other_scope',
  'legit_mod_ordinary', 'legit_mod_cleanup', 'legit_invite_event', 'legit_fresh_signin',
  'legit_old_session', 'legit_totp', 'legit_backup_code',
];
const selected = opt('scenarios', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
const LABEL = opt('label', 'run');
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

// ── TOTP (RFC 6238, the authenticator a real person would use) ──────────────
function base32Decode(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0; let value = 0; const out = [];
  for (const ch of secret.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx < 0) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { bits -= 8; out.push((value >>> bits) & 255); }
  }
  return Buffer.from(out);
}
function totp(secret, step) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = mac[mac.length - 1] & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0');
}
const stepNow = () => Math.floor(Date.now() / 30_000);

// ── fixtures ─────────────────────────────────────────────────────────────────
let ipSeq = 1;
const nextIp = () => { const n = ipSeq++; return `198.18.${(n >> 8) & 255}.${n & 255}`; };
let rr = 0;
const nodes = () => cluster.nodeNames.map((n) => cluster.nodeUrl(n));
const anyNode = () => nodes()[rr++ % cluster.nodeNames.length];
const otherNode = (base) => nodes().find((u) => u !== base) ?? base;
const ok = (r) => r.status >= 200 && r.status < 300;
const isStepUp = (r) => r.status === 403 && r.body?.error === 'STEP_UP_REQUIRED';

class Person {
  constructor(base, username, password, ip) {
    Object.assign(this, { base, username, password, ip, csrf: null, grants: {}, proofs: 0, refusals: [] });
  }
  headers() { return { 'X-Forwarded-For': this.ip }; }
  async api(method, urlPath, body, { base = this.base, headers = {} } = {}) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (method !== 'GET' && !this.csrf) {
        const r = await request(base, 'GET', '/api/csrf-token', { token: this.token, headers: this.headers() });
        if (r.status === 200) this.csrf = r.body.token;
      }
      const r = await request(base, method, urlPath, {
        token: this.token, body, csrf: method === 'GET' ? undefined : this.csrf,
        headers: { ...this.headers(), ...headers },
      });
      if (attempt === 0 && r.status === 403 && /csrf/i.test(String(r.body?.error ?? ''))) { this.csrf = null; continue; }
      return r;
    }
    throw new Error('unreachable');
  }
  /** Keeps a sign-in's grants (memory only), as startApp does. */
  rememberSignIn(stepUp) {
    this.grants = {};
    for (const [scope, token] of Object.entries(stepUp?.grants ?? {})) this.grants[scope] = token;
  }
  /** One proof for `scope`, the way the client prompt does it. */
  async prove(refusal, base) {
    this.proofs += 1;
    const secondFactor = refusal.methods.includes('totp');
    let r;
    if (secondFactor && this.backupCodes?.length && this.preferBackup) {
      r = await this.api('POST', '/api/2fa/step-up', { code: this.backupCodes.shift(), scope: refusal.scope }, { base });
    } else if (secondFactor) {
      let step = Math.max(stepNow() - 1, (this.lastStep ?? 0) + 1);
      while (step > stepNow() + 1) { await sleep(1_000); step = Math.max(stepNow() - 1, (this.lastStep ?? 0) + 1); }
      this.lastStep = step;
      r = await this.api('POST', '/api/2fa/step-up', { code: totp(this.totpSecret, step), scope: refusal.scope }, { base });
    } else {
      r = await this.api('POST', '/api/step-up/password', { password: this.password, scope: refusal.scope }, { base });
    }
    if (!ok(r) || !r.body?.stepUp?.token) throw new Error(`proof ${r.status} ${JSON.stringify(r.body)}`);
    this.grants[refusal.scope] = r.body.stepUp.token;
    return r.body.stepUp;
  }
  /**
   * A protected action as the real client performs it. The proof and the retry
   * go to the OTHER node, so grants are verified cross-node.
   */
  async act(method, urlPath, body, scope, { base = this.base } = {}) {
    const held = this.grants[scope];
    let r = await this.api(method, urlPath, body, { base, headers: held ? { 'X-Bridge-Step-Up': held } : {} });
    if (!isStepUp(r)) return r;
    this.refusals.push(r.body);
    const other = otherNode(base);
    await this.prove(r.body, other);
    r = await this.api(method, urlPath, body, { base: other, headers: { 'X-Bridge-Step-Up': this.grants[r.body.scope] } });
    return r;
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
  p.rememberSignIn(r.body.stepUp);
  return p;
}
async function people(prefix, n) {
  const out = [];
  for (let i = 0; i < n; i += 8) out.push(...await Promise.all(Array.from({ length: Math.min(8, n - i) }, () => person(prefix))));
  return out;
}
/** The same person after a page reload or > 10 min: a valid session, no in-memory grants. */
function olderSession(p) { p.grants = {}; return p; }

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

/** Enables 2FA the way the Security tab does (fresh sign-in grant → setup → verify). */
async function enableTwoFactor(p) {
  const setup = await p.act('POST', '/api/2fa/setup', {}, 'account-security');
  if (!ok(setup) || !setup.body?.secret) throw new Error(`2fa setup ${setup.status} ${JSON.stringify(setup.body)}`);
  p.totpSecret = setup.body.secret;
  const step = stepNow() - 1;
  const verify = await p.act('POST', '/api/2fa/verify', { code: totp(p.totpSecret, step) }, 'account-security');
  if (!ok(verify) || !verify.body?.token) throw new Error(`2fa verify ${verify.status} ${JSON.stringify(verify.body)}`);
  p.lastStep = step;
  p.backupCodes = verify.body.backupCodes;
  // Enabling 2FA rotates the security session: new access token, every grant revoked.
  p.token = verify.body.token; p.grants = {}; p.csrf = null;
  p.proofs = 0; p.refusals = [];
  return p;
}

// A stolen session is the victim's token on the attacker's own client address:
// same bearer, no credentials and none of the victim's in-memory grants.
function steal(victim) {
  const thief = new Person(anyNode(), victim.username, null, nextIp());
  thief.token = victim.token;
  thief.id = victim.id;
  return thief;
}
const attackOutcome = (r) => (ok(r) ? 'OPEN' : isStepUp(r) ? 'STEPUP' : 'BLOCKED');
const describe = (r) => `${r.status}${r.body?.error ? ` ${r.body.error}` : ''}${r.body?.reasons ? ` [${r.body.reasons.join(',')}]` : ''}`;

// ── scenarios ──────────────────────────────────────────────────────────────
const S = {
  // A stolen token swaps the recovery e-mail — the first move of an account
  // takeover (then verify from the attacker's inbox, then password reset).
  async email_takeover() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/email/add', { email: `attacker-${rnd()}@evil.test` });
    record('email_takeover', 'SU-ATK-01', 'stolen token changes the recovery e-mail', 'attack',
      attackOutcome(r), `POST /api/email/add → ${describe(r)}`, { status: r.status, scope: r.body?.scope ?? null });
  },

  // A stolen token begins enrolling the attacker's own passkey.
  async passkey_add() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/webauthn/register/begin', {});
    const creds = await thief.api('GET', '/api/webauthn/credentials', undefined);
    record('passkey_add', 'SU-ATK-02', 'stolen token begins registering a new passkey', 'attack',
      attackOutcome(r), `register/begin → ${describe(r)}; GET credentials (read-only, unprotected) → ${creds.status}`, { begin: r.status, list: creds.status });
  },

  // A stolen token begins 2FA enrolment with the attacker's authenticator.
  async twofactor_setup() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/2fa/setup', {});
    record('twofactor_setup', 'SU-ATK-03', 'stolen token starts 2FA enrolment (own authenticator)', 'attack',
      ok(r) && r.body?.secret ? 'OPEN' : attackOutcome(r), `POST /api/2fa/setup → ${describe(r)}`, { status: r.status });
  },

  // A phished PASSWORD plus a stolen token tries to remove the second factor of
  // an account that really has 2FA on: a level-2 proof is required.
  async twofactor_disable_pw() {
    const victim = await enableTwoFactor(await person('victim2fa'));
    const thief = steal(victim);
    const r = await thief.api('POST', '/api/2fa/disable', { password: victim.password });
    record('twofactor_disable_pw', 'SU-ATK-04', 'phished password + stolen token disables 2FA', 'attack',
      attackOutcome(r), `POST /api/2fa/disable (correct password) → ${describe(r)} level=${r.body?.level ?? '-'}`, { status: r.status, level: r.body?.level ?? null });
  },

  // A stolen token exports the whole account.
  async account_export() {
    const victim = await person('victim');
    const thief = steal(victim);
    const r = await thief.api('GET', '/api/account/export', undefined);
    record('account_export', 'SU-ATK-05', 'stolen token exports the whole account', 'attack',
      attackOutcome(r), `GET /api/account/export → ${describe(r)}`, { status: r.status });
  },

  // A stolen OWNER token deletes the community for everyone.
  async owned_server_delete() {
    const owner = await person('owner');
    const c = await community(owner);
    const thief = steal(owner);
    const r = await thief.api('DELETE', `/api/servers/${c.serverId}`, undefined);
    record('owned_server_delete', 'SU-ATK-06', 'stolen owner token deletes the server', 'attack',
      attackOutcome(r), `DELETE /api/servers/:sid → ${describe(r)}`, { status: r.status });
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
    const outcome = ok(du) || ok(ds) ? 'OPEN' : isStepUp(du) && isStepUp(ds) ? 'STEPUP' : 'BLOCKED';
    record('admin_deletes', 'SU-ATK-07', 'stolen admin token deletes a user and a server', 'attack',
      outcome, `DELETE /api/admin/users/:id → ${describe(du)}; /admin/servers/:id → ${describe(ds)}`, { user: du.status, server: ds.status });
  },

  // Compromised-moderator burst: ban as fast as possible.
  async mod_burst() {
    const owner = await person('modowner');
    const c = await community(owner);
    const targets = await people('bantgt', 40);
    await admit(c, targets);
    const thief = steal(owner); // the owner is a moderator of their own server
    const t0 = Date.now();
    let accepted = 0; const statuses = {}; let firstStepUpAt = null;
    for (const [i, tgt] of targets.entries()) {
      const r = await thief.api('POST', `/api/servers/${c.serverId}/bans`, { userId: tgt.id, reason: 'burst' });
      const key = isStepUp(r) ? '403 STEP_UP_REQUIRED' : String(r.status);
      statuses[key] = (statuses[key] || 0) + 1;
      if (ok(r)) accepted += 1;
      if (isStepUp(r) && firstStepUpAt === null) firstStepUpAt = i + 1;
    }
    const secs = (Date.now() - t0) / 1000;
    const outcome = accepted > 5 ? 'OPEN' : firstStepUpAt !== null ? 'STEPUP' : 'BLOCKED';
    record('mod_burst', 'SU-ATK-08', 'compromised moderator bans 40 accounts as fast as possible', 'attack',
      outcome, `${accepted}/40 bans landed in ${secs.toFixed(1)} s; first STEP_UP_REQUIRED at request ${firstStepUpAt ?? '-'}`,
      { accepted, seconds: Math.round(secs), firstStepUpAt, statuses });
  },

  // Invite burst: deferred in B2 (the existing 10/min limiter stays the bound).
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
    record('invite_burst', 'SU-ATK-09', 'compromised session creates 25 invites back-to-back (deferred in B2)', 'attack',
      accepted > 3 ? 'OPEN' : 'BLOCKED',
      `${accepted}/25 invites in ${secs.toFixed(1)} s — bound by the unchanged 10/min limiter (approved deferral)`, { accepted, seconds: Math.round(secs), statuses });
  },

  // Distributed step-up proof guessing: every guess from a fresh address and
  // alternating nodes, so per-IP limits never apply — only the per-account lock.
  async proof_guess() {
    const victim = await person('victim');
    const thief = steal(victim);
    const statuses = [];
    for (let i = 0; i < 7; i++) {
      thief.ip = nextIp(); thief.base = anyNode(); thief.csrf = null;
      const r = await thief.api('POST', '/api/step-up/password', { password: `wrong-${rnd()}`, scope: 'account-security' });
      statuses.push(r.status === 429 ? `429 ${r.body?.error}` : `${r.status}${r.body?.locked ? ' locked' : ''}`);
    }
    thief.ip = nextIp(); thief.base = anyNode(); thief.csrf = null;
    const right = await thief.api('POST', '/api/step-up/password', { password: victim.password, scope: 'account-security' });
    // The owner is not locked out of signing in, and sign-in brings fresh grants.
    const login = await request(otherNode(thief.base), 'POST', '/api/login', { body: { username: victim.username, password: victim.password }, headers: victim.headers() });
    const wrongAccepted = statuses.filter((s) => s.startsWith('400')).length;
    const locked = right.status === 429 && ok(login) && Boolean(login.body?.stepUp?.grants?.['account-security']);
    record('proof_guess', 'SU-ATK-10', 'distributed step-up proof guessing (new IP + alternating node per guess)', 'attack',
      locked && wrongAccepted <= 5 ? 'BLOCKED' : wrongAccepted > 5 ? 'OPEN' : 'STEPUP',
      `guesses → ${statuses.join(', ')}; correct password after lock → ${describe(right)}; owner sign-in → ${login.status} (grant: ${Boolean(login.body?.stepUp)})`,
      { guessesChecked: wrongAccepted, lockedAfter: wrongAccepted, correctAfterLock: right.status, ownerLogin: login.status });
  },

  // A grant (e.g. read out of a compromised page's memory) does not survive
  // "sign out everywhere": tokenVersion++ revokes every grant.
  async grant_after_revocation() {
    const victim = await person('revoke');
    const grant = victim.grants['sensitive-export'];
    const out = await victim.api('POST', '/api/logout-all', {});
    const login = await request(victim.base, 'POST', '/api/login', { body: { username: victim.username, password: victim.password }, headers: victim.headers() });
    const thief = new Person(anyNode(), victim.username, null, nextIp());
    thief.token = login.body?.token; // even WITH a valid new session token…
    const r = await thief.api('GET', '/api/account/export', undefined, { headers: { 'X-Bridge-Step-Up': grant } });
    record('grant_after_revocation', 'SU-ATK-11', 'stolen grant replayed after sign-out-everywhere', 'attack',
      attackOutcome(r), `logout-all → ${out.status}; export with the old grant + a new session → ${describe(r)}`, { status: r.status, reasons: r.body?.reasons ?? null });
  },

  // The attacker's OWN valid grant does not unlock the victim's account.
  async grant_other_account() {
    const victim = await person('victim');
    const attacker = await person('attacker');
    const thief = steal(victim);
    const r = await thief.api('GET', '/api/account/export', undefined, { headers: { 'X-Bridge-Step-Up': attacker.grants['sensitive-export'] } });
    record('grant_other_account', 'SU-ATK-12', "stolen token + the attacker's own grant", 'attack',
      attackOutcome(r), `export → ${describe(r)}`, { status: r.status, reasons: r.body?.reasons ?? null });
  },

  // A grant for one scope never authorises another (e.g. a moderation-burst
  // grant obtained during a cleanup cannot export or delete the account).
  async grant_other_scope() {
    const victim = await person('victim');
    const thief = steal(victim);
    const modGrant = victim.grants['moderation-burst'];
    const exp = await thief.api('GET', '/api/account/export', undefined, { headers: { 'X-Bridge-Step-Up': modGrant } });
    const del = await thief.api('DELETE', '/api/account', { confirm: 'DELETE' }, { headers: { 'X-Bridge-Step-Up': modGrant } });
    record('grant_other_scope', 'SU-ATK-13', 'a grant for one scope used for another (export, account deletion)', 'attack',
      ok(exp) || ok(del) ? 'OPEN' : isStepUp(exp) && isStepUp(del) ? 'STEPUP' : 'BLOCKED',
      `export → ${describe(exp)}; delete account → ${describe(del)}`, { export: exp.status, delete: del.status });
  },

  // ── legitimate people ─────────────────────────────────────────────────────
  // Ordinary moderation from an OLDER session (no grant held): three bans at a
  // human pace stay under the burst threshold and are never interrupted.
  async legit_mod_ordinary() {
    const owner = await person('modord');
    const c = await community(owner);
    const targets = await people('rpt', 3);
    await admit(c, targets);
    olderSession(owner);
    let accepted = 0;
    for (const tgt of targets) {
      const r = await owner.act('POST', `/api/servers/${c.serverId}/bans`, { userId: tgt.id, reason: 'report' }, 'moderation-burst');
      if (ok(r)) accepted += 1;
      await sleep(1_500);
    }
    record('legit_mod_ordinary', 'SU-LEG-01', 'ordinary moderation: 3 bans handling reports (older session)', 'control',
      accepted === 3 && owner.proofs === 0 ? 'OK' : 'FALSE_POSITIVE', `${accepted}/3 bans, ${owner.proofs} proofs asked`, { destructiveActions: accepted, proofs: owner.proofs });
  },

  // A real raid cleanup from an older session: asked ONCE at the burst, then the
  // cleanup continues with that grant (the unchanged 30/min limiter still bounds it).
  async legit_mod_cleanup() {
    const owner = await person('modclean');
    const c = await community(owner);
    const targets = await people('raider', 40);
    await admit(c, targets);
    olderSession(owner);
    const t0 = Date.now();
    let accepted = 0; const statuses = {};
    for (const tgt of targets) {
      const r = await owner.act('POST', `/api/servers/${c.serverId}/bans`, { userId: tgt.id, reason: 'raid cleanup' }, 'moderation-burst');
      const key = isStepUp(r) ? '403 STEP_UP_REQUIRED' : String(r.status);
      statuses[key] = (statuses[key] || 0) + 1;
      if (ok(r)) accepted += 1;
      await sleep(300);
    }
    const stepUpsAfterProof = statuses['403 STEP_UP_REQUIRED'] ?? 0;
    record('legit_mod_cleanup', 'SU-LEG-02', 'raid cleanup: 40 bans back-to-back (older session)', 'control',
      owner.proofs === 1 && stepUpsAfterProof === 0 && accepted >= 25 ? 'FRICTION' : 'FALSE_POSITIVE',
      `${accepted}/40 bans in ${((Date.now() - t0) / 1000).toFixed(1)} s; ${owner.proofs} proof (asked at the burst: ${owner.refusals[0]?.reasons?.join(',') ?? '-'}); 429s are the unchanged 30/min limiter (baseline 30/40)`,
      { destructiveActions: accepted, proofs: owner.proofs, statuses });
  },

  // An event organiser creates several invites in a sitting (unchanged by B2).
  async legit_invite_event() {
    const owner = await person('invorg');
    const c = await community(owner);
    let accepted = 0; const statuses = {};
    for (let i = 0; i < 6; i++) {
      const r = await owner.api('POST', '/api/servers/invites', { serverId: c.serverId });
      statuses[r.status] = (statuses[r.status] || 0) + 1;
      if (ok(r)) accepted += 1;
      await sleep(2_000);
    }
    record('legit_invite_event', 'SU-LEG-03', 'organiser creates 6 invites over ~12 s', 'control',
      accepted === 6 ? 'OK' : 'FALSE_POSITIVE', `${accepted}/6 invites created`, { invites: accepted, statuses });
  },

  // A correctly-authenticated FRESH sign-in performs protected actions without
  // any prompt: the sign-in grants cover them (minted on one node, used on the other).
  async legit_fresh_signin() {
    const owner = await person('fresh');
    const c = await community(owner);
    const login = await request(owner.base, 'POST', '/api/login', { body: { username: owner.username, password: owner.password }, headers: owner.headers() });
    const self = new Person(otherNode(owner.base), owner.username, owner.password, owner.ip);
    self.token = login.body?.token; self.id = owner.id;
    self.rememberSignIn(login.body?.stepUp);
    const exp = await self.act('GET', '/api/account/export', undefined, 'sensitive-export');
    const del = await self.act('DELETE', `/api/servers/${c.serverId}`, undefined, 'destructive-admin');
    record('legit_fresh_signin', 'SU-LEG-04', 'fresh sign-in then export + server deletion (cross-node)', 'control',
      ok(exp) && ok(del) && self.proofs === 0 ? 'OK' : 'FALSE_POSITIVE',
      `login → ${login.status} (grants: ${Object.keys(login.body?.stepUp?.grants ?? {}).length}); export → ${exp.status}; delete server → ${del.status}; proofs asked: ${self.proofs}`,
      { login: login.status, export: exp.status, deleteServer: del.status, proofs: self.proofs });
  },

  // An OLDER session (reload / > 10 min) exports: one explainable password proof.
  async legit_old_session() {
    const p = olderSession(await person('older'));
    const exp = await p.act('GET', '/api/account/export', undefined, 'sensitive-export');
    const again = await p.act('GET', '/api/account/export', undefined, 'sensitive-export');
    record('legit_old_session', 'SU-LEG-05', 'older session exports twice (proof on one node, export on the other)', 'control',
      ok(exp) && ok(again) && p.proofs === 1 ? 'FRICTION' : 'FALSE_POSITIVE',
      `first → ${exp.status} after ${p.proofs} proof (${p.refusals[0]?.reasons?.join(',') ?? '-'}, methods ${p.refusals[0]?.methods?.join('/') ?? '-'}); second → ${again.status} with the held grant`,
      { export: exp.status, again: again.status, proofs: p.proofs });
  },

  // A 2FA account proves with its authenticator (TOTP, level 2).
  async legit_totp() {
    const p = await enableTwoFactor(await person('totp'));
    const exp = await p.act('GET', '/api/account/export', undefined, 'sensitive-export');
    record('legit_totp', 'SU-LEG-06', '2FA account exports with one TOTP proof', 'control',
      ok(exp) && p.proofs === 1 ? 'FRICTION' : 'FALSE_POSITIVE',
      `export → ${exp.status}; refusal level ${p.refusals[0]?.level ?? '-'}, methods ${p.refusals[0]?.methods?.join('/') ?? '-'}; proofs ${p.proofs}`,
      { export: exp.status, level: p.refusals[0]?.level ?? null, proofs: p.proofs });
  },

  // A 2FA account that lost its authenticator proves with a backup code.
  async legit_backup_code() {
    const p = await enableTwoFactor(await person('backup'));
    p.preferBackup = true;
    const before = p.backupCodes.length;
    const exp = await p.act('GET', '/api/account/export', undefined, 'sensitive-export');
    record('legit_backup_code', 'SU-LEG-07', '2FA account exports with one backup-code proof', 'control',
      ok(exp) && p.proofs === 1 ? 'FRICTION' : 'FALSE_POSITIVE',
      `export → ${exp.status}; backup codes ${before} → ${p.backupCodes.length}; proofs ${p.proofs}`,
      { export: exp.status, proofs: p.proofs });
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
    const want = EXPECT[r.id];
    if (r.kind === 'control') {
      if (want?.outcome && r.outcome !== want.outcome) gateFailures.push(`${r.id} ${r.outcome} ≠ ${want.outcome}`);
      else if (r.outcome === 'FALSE_POSITIVE' && !want?.knownFalsePositive) gateFailures.push(`${r.id} false positive`);
    }
    if (r.kind === 'attack' && want?.atLeast && ORDER[r.outcome] < ORDER[want.atLeast]) gateFailures.push(`${r.id} ${r.outcome} < ${want.atLeast}`);
    if (r.id.endsWith(':crash')) gateFailures.push(`${r.id}`);
  }
  for (const id of Object.keys(EXPECT)) {
    if (!results.some((r) => r.id === id) && selected.length === ALL.length) gateFailures.push(`${id} not measured`);
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
