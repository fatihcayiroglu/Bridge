#!/usr/bin/env node
// e2e/android/android-journeys.mjs — P4 ANDROID EMULATOR JOURNEYS
//
// Drives the REAL packaged Capacitor app (debug APK, real Android WebView, real Android
// lifecycle and permission model) on an emulator through Playwright's Android support
// (`_android`: adb + the WebView DevTools socket). The Bridge server runs on the host and is
// reached through `adb reverse tcp:3000 tcp:3000` (the APK is built with
// BRIDGE_API_URL=http://localhost:3000).
//
// EVIDENCE CATEGORY: AUTOMATED / EMULATOR. This is NOT real-device evidence: the emulator has
// no real radio, no Bluetooth, no real microphone/camera hardware and no Google Play services
// push delivery. Every check records PASS / FAIL / SKIPPED; SKIPPED is never counted as PASS
// and the process exits non-zero on any FAIL.
//
// MODE=dryrun runs the in-page parts against desktop Chromium in a phone viewport. It exists
// ONLY to debug this harness locally (no emulator here); its output is not evidence and is
// labelled as such.

import { _android as android, chromium, devices } from '@playwright/test';
import { io } from 'socket.io-client';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const MODE = process.env.ANDROID_JOURNEY_MODE === 'dryrun' ? 'dryrun' : 'android';
const API = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PKG = process.env.ANDROID_PKG || 'com.bridge.app.debug';
const ACTIVITY = `${PKG}/com.bridge.app.MainActivity`;
const OUT_DIR = path.resolve(process.env.ANDROID_EVIDENCE_DIR || 'android/results');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const PASSWORD = 'P4-android-journey-pass-1';

fs.mkdirSync(OUT_DIR, { recursive: true });

// ── Controllable network path ───────────────────────────────────────────────
// `adb reverse` tunnels over the adb connection, NOT through the emulated radio: turning Wi-Fi and
// mobile data off in Android does not cut it (measured: the first run's "offline" message reached
// the server). The app therefore reaches the server through this proxy
// (adb reverse tcp:3000 → host PROXY_PORT → 127.0.0.1:3000). `cut()` resets every open connection
// and refuses new ones — a real loss of the path — while `svc wifi/data disable` makes the OS and the
// WebView report offline. `delay(ms)` adds one-way latency per chunk for the latency probe.
class NetPath {
  constructor(listenPort, targetPort) {
    this.listenPort = listenPort; this.targetPort = targetPort;
    this.sockets = new Set(); this.down = false; this.delayMs = 0;
    this.server = net.createServer((client) => this.accept(client));
  }
  start() { return new Promise((resolve) => this.server.listen(this.listenPort, '127.0.0.1', resolve)); }
  accept(client) {
    if (this.down) { client.destroy(); return; }
    const upstream = net.connect(this.targetPort, '127.0.0.1');
    this.sockets.add(client); this.sockets.add(upstream);
    const relay = (from, to) => from.on('data', (chunk) => {
      if (!this.delayMs) { to.write(chunk); return; }
      from.pause(); setTimeout(() => { if (!to.destroyed) to.write(chunk); from.resume(); }, this.delayMs);
    });
    relay(client, upstream); relay(upstream, client);
    const close = () => { client.destroy(); upstream.destroy(); this.sockets.delete(client); this.sockets.delete(upstream); };
    client.on('error', close); upstream.on('error', close); client.on('close', close); upstream.on('close', close);
  }
  cut() { this.down = true; for (const s of this.sockets) s.destroy(); this.sockets.clear(); }
  restore() { this.down = false; }
  delay(ms) { this.delayMs = ms; }
  stop() { this.cut(); this.server.close(); }
}
const PROXY_PORT = Number(process.env.ANDROID_PROXY_PORT || 0);
const netPath = PROXY_PORT ? new NetPath(PROXY_PORT, Number(new URL(API).port || 80)) : null;

// ── Result model ───────────────────────────────────────────────────────────
class Skip extends Error {}
const results = [];
const facts = {};
let device = null;
let page = null;

function log(...args) { console.log(`[android-journeys ${new Date().toISOString().slice(11, 19)}]`, ...args); }

async function screenshot(name) {
  const file = path.join(OUT_DIR, `${name}.png`);
  try {
    if (device) fs.writeFileSync(file, await withTimeout(device.screenshot(), 20_000, 'device screenshot'));
    else if (page) await withTimeout(page.screenshot({ path: file }), 20_000, 'page screenshot');
    return path.basename(file);
  } catch { return null; }
}

// A check that outlives this budget is a FAIL with device evidence, never a
// silent stall: one wedged WebView once hung A01 for 56 minutes until the job
// was cancelled with no result at all. The longest check of a green run takes
// ~76 s. The next check then starts from a freshly launched app.
const CHECK_BUDGET_MS = 300_000;
let wedgedBy = null;
async function overBudget(id, err) {
  const message = String(err?.message ?? err);
  if (!message.startsWith(`${id} as a whole did not answer`)) return message;
  wedgedBy = id;
  return `${message}; device evidence: ${JSON.stringify(await webViewAttachEvidence().catch((e) => `unavailable: ${e.message}`))}`;
}
async function recoverFromWedge() {
  if (!wedgedBy || MODE !== 'android') return;
  const label = `${wedgedBy} exceeding its budget`;
  wedgedBy = null;
  await restoreLaunch(label);
}

async function check(id, title, fn, { budgetMs = CHECK_BUDGET_MS } = {}) {
  const started = Date.now();
  log(`▶ ${id} ${title}`);
  await recoverFromWedge();
  try {
    const detail = await withTimeout(Promise.resolve().then(fn), budgetMs, `${id} as a whole`);
    results.push({ id, title, status: 'PASS', ms: Date.now() - started, detail: detail ?? null });
    log(`  PASS ${id}`, detail ? JSON.stringify(detail) : '');
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ id, title, status: 'SKIPPED', ms: Date.now() - started, reason: err.message });
      log(`  SKIPPED ${id}: ${err.message}`);
      return;
    }
    const message = await overBudget(id, err);
    const shot = await screenshot(`${id}-fail`);
    const dom = await domSummary();
    results.push({ id, title, status: 'FAIL', ms: Date.now() - started, error: message.slice(0, 2000), screenshot: shot, dom });
    if (dom) log(`  DOM ${id}: ${dom}`);
    log(`  FAIL ${id}: ${message}`);
  }
}

/** What the user was looking at when a check failed (the artifact host may be unreachable). */
async function domSummary() {
  if (!page) return null;
  return withTimeout(page.evaluate(() => {
    const vis = (el) => !!el && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
    const text = (el) => (el?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 240);
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(vis).map((d) => d.getAttribute('aria-label') || d.className).slice(0, 4);
    const alerts = [...document.querySelectorAll('[role="alert"], [role="status"], .toast')].filter(vis).map(text).filter(Boolean).slice(0, 4);
    return JSON.stringify({ url: location.href, app: vis(document.getElementById('app')), auth: vis(document.getElementById('auth-screen')),
      activeChannel: document.querySelector('.ch-item.active')?.getAttribute('data-id') ?? null, dialogs, alerts,
      dmPanel: vis(document.querySelector('.dm-panel')) ? text(document.querySelector('.dm-panel')) : null });
  }), 10_000, 'DOM summary').catch((e) => `unavailable: ${e.message}`);
}

/** Measurement-only probe: records numbers, asserts nothing, and is NEVER counted as a PASS. */
async function measure(id, title, fn) {
  const started = Date.now();
  log(`▶ ${id} ${title} (measurement)`);
  await recoverFromWedge();
  try {
    const detail = await withTimeout(Promise.resolve().then(fn), CHECK_BUDGET_MS, `${id} as a whole`);
    results.push({ id, title, status: 'MEASURED', ms: Date.now() - started, detail: detail ?? null });
    log(`  MEASURED ${id}`, detail ? JSON.stringify(detail) : '');
  } catch (err) {
    if (err instanceof Skip) { results.push({ id, title, status: 'SKIPPED', ms: Date.now() - started, reason: err.message }); return; }
    const message = await overBudget(id, err);
    results.push({ id, title, status: 'FAIL', ms: Date.now() - started, error: message.slice(0, 2000), screenshot: await screenshot(`${id}-fail`) });
    log(`  FAIL ${id}: ${message}`);
  }
}

function assert(cond, message) { if (!cond) throw new Error(message); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/**
 * Bounds a call that has no timeout of its own (adb shell, page.evaluate, the
 * DevTools attach). The underlying call may keep running; the journey moves on
 * with an error that names what did not answer.
 */
function withTimeout(promise, ms, what) {
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not answer within ${ms} ms`)), ms);
  });
  return Promise.race([promise, expired]).finally(() => clearTimeout(timer));
}
async function until(fn, { timeout = 15_000, interval = 250, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    // Each attempt is bounded by the time left: a page.evaluate on a frozen
    // WebView never settles, and an unbounded await made this loop's own
    // timeout unreachable.
    try {
      last = await withTimeout(Promise.resolve().then(fn), Math.max(1, deadline - Date.now()), message);
      if (last) return last;
    } catch (e) { last = e; }
    await sleep(interval);
  }
  throw new Error(`timed out after ${timeout} ms waiting for ${message}${last instanceof Error ? ` (last error: ${last.message})` : ''}`);
}

// ── Host-side API (the other side of every journey) ─────────────────────────
async function http(method, url, { token, body, csrf } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  const res = await fetch(`${API}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, ok: res.ok, json };
}
async function csrfFor(token) {
  const r = await http('GET', '/api/csrf-token', { token });
  return r.json?.token || r.json?.csrfToken;
}
async function write(method, url, token, body) {
  const r = await http(method, url, { token, body, csrf: await csrfFor(token) });
  if (!r.ok) throw new Error(`${method} ${url} → ${r.status} ${JSON.stringify(r.json).slice(0, 300)}`);
  return r.json;
}
async function account(label) {
  const username = `p4${label}${Date.now().toString(36)}`.slice(0, 24);
  const reg = await http('POST', '/api/register', { body: { username, password: PASSWORD } });
  if (!reg.ok) throw new Error(`register ${label} → ${reg.status} ${JSON.stringify(reg.json)}`);
  const login = await http('POST', '/api/login', { body: { username, password: PASSWORD } });
  const token = login.json?.token || reg.json?.token;
  const me = await http('GET', '/api/me', { token });
  const user = me.json?.user ?? me.json;
  return { username, token, id: user?._id || user?.id };
}
function openSocket(token) {
  return new Promise((resolve, reject) => {
    const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: true, timeout: 8000 });
    s.once('connect', () => { const t = setTimeout(() => resolve(s), 1500); s.once('userAuthenticated', () => { clearTimeout(t); resolve(s); }); });
    s.once('connect_error', reject);
  });
}
function sendChannel(sock, serverId, channelId, content) {
  const ackId = `p4-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { sock.off('message:ack', onAck); reject(new Error(`message:ack timeout (${content})`)); }, 15_000);
    const onAck = (a) => { if (a?.ackId !== ackId) return; clearTimeout(timer); sock.off('message:ack', onAck); resolve(a); };
    sock.on('message:ack', onAck);
    sock.emit('message:send', { serverId, channelId, content, ackId });
  });
}
function sendDm(sock, toUserId, content) {
  const clientNonce = `p4dm-${Date.now().toString(36)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { done(); reject(new Error(`dm:send timeout (${content})`)); }, 15_000);
    const onMsg = (m) => { if (m?.clientNonce === clientNonce) { done(); resolve(m); } };
    const onErr = (e) => { if (e?.clientNonce === clientNonce) { done(); reject(new Error(`dm:send rejected ${e.code}`)); } };
    const done = () => { clearTimeout(timer); sock.off('dm:message', onMsg); for (const ev of ['error:message', 'error:dm_rate', 'error:dm_privacy']) sock.off(ev, onErr); };
    sock.on('dm:message', onMsg);
    for (const ev of ['error:message', 'error:dm_rate', 'error:dm_privacy']) sock.on(ev, onErr);
    sock.emit('dm:send', { toUserId, content, clientNonce });
  });
}
async function channelHas(token, channelId, needle) {
  const r = await http('GET', `/api/channels/${channelId}/messages?limit=50`, { token });
  const list = Array.isArray(r.json) ? r.json : r.json?.messages ?? [];
  return list.filter((m) => String(m.content ?? '').includes(needle));
}

// ── Long-channel seeding (direct SQL, the same shape the P3 measurement used) ─────────────
const LONG_CHANNEL_MESSAGES = Number(process.env.ANDROID_LONG_CHANNEL_MESSAGES || 2000);
// #209 cold-start stress: bounded so a misconfiguration cannot stall the job.
const COLD_STARTS = Math.min(20, Math.max(1, Number(process.env.ANDROID_COLD_STARTS || 5)));
async function seedLongChannel(serverId, userId, token, count) {
  if (!process.env.DATABASE_URL) return null;
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  let pg;
  try { pg = require('../../server/node_modules/pg'); } catch { return null; }
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    // The channel is created through the API, so the running app learns of it the normal way
    // (channel:created). Only the history is bulk-inserted. (A channel inserted by SQL never
    // reached the already-loaded channel list: harness defect in the first PERF02 run.)
    const created = await write('POST', `/api/servers/${serverId}/channels`, token, { name: 'android-uzun', type: 'text' });
    const channelId = created._id || created.id || created.channel?._id;
    const base = Date.now() - count * 60_000;
    await client.query(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
      SELECT $1::text || '-' || g, $1::text, $2::text, $3::text, 'seed', 'Seed', 'Uzun kanal ölçüm mesajı #' || g || ' — gerçekçi uzunlukta bir satır.', $4::bigint + g * 60000
      FROM generate_series(1, $5::int) g`, [channelId, serverId, userId, base, count]);
    return { channelId };
  } finally { await client.end(); }
}

// ── Platform layer ─────────────────────────────────────────────────────────
const sh = async (cmd, ms = 120_000) =>
  (await withTimeout(device.shell(cmd), ms, `adb shell "${cmd.slice(0, 80)}"`)).toString().trim();

// Diagnostic probes must be much shorter than normal UI or shell operations.
// On a wedged adb bridge, collecting four 120 s probes after the 300 s
// watchdog could itself consume most of the job timeout without a report.
const DIAGNOSTIC_SHELL_BUDGET_MS = 12_000;

// Failure-only diagnostics: retain the ORIGINAL WebView assertion and capture
// enough Android state to distinguish a native crash, a stopped Activity, and
// an adb/DevTools attachment problem. No extra retry or implicit PASS.
async function webViewAttachEvidence() {
  const probes = [
    ['pid', `pidof ${PKG}`],
    ['activity', `dumpsys activity activities | grep -E 'topResumedActivity|mResumedActivity|com.bridge.app' | head -10`],
    ['process', `dumpsys activity processes | grep -E 'ProcessRecord|com.bridge.app' | head -10`],
    // Restrict logcat to native crash headers/stack frames; do not print arbitrary
    // app log lines, HTTP headers, user messages or credential-bearing fields.
    // A native (tombstone) crash names the process as ">>> pkg <<<" and the
    // signal as "signal N (SIGxxx)"; the Java patterns alone missed it.
    ['crash', `logcat -d -b crash -t 100 | grep -E 'FATAL EXCEPTION|Process: com.bridge.app|Fatal signal|>>> com.bridge.app|signal [0-9]+ \\(SIG[A-Z]+\\)|Caused by:|at com.bridge.app' | tail -15`],
  ];
  const results = await Promise.all(probes.map(async ([label, command]) => {
    try { return [label, (await sh(command, DIAGNOSTIC_SHELL_BUDGET_MS)).slice(0, 1200)]; }
    catch (err) { return [label, `probe failed: ${String(err?.message ?? err).slice(0, 120)}`]; }
  }));
  return { ...Object.fromEntries(results), exits: await processExits() };
}

/**
 * Why the OS ended this package's recent processes (ApplicationExitInfo, API 30+):
 * low-memory kill, native or Java crash, signal, ANR, or a user/force stop.
 * Only allow-listed numeric/enum fields are kept: never the free-text
 * description or trace, which can carry app data.
 */
async function processExits(limit = 6, pkg = PKG) {
  if (MODE !== 'android') return null;
  if (!/^[A-Za-z0-9_.]{1,120}$/.test(pkg)) return 'probe refused: not a package name';
  let out;
  try { out = await sh(`dumpsys activity exit-info ${pkg}`, DIAGNOSTIC_SHELL_BUDGET_MS); }
  catch (err) { return `probe failed: ${String(err?.message ?? err).slice(0, 120)}`; }
  return out.split(/ApplicationExitInfo #\d+:/).slice(1, limit + 1).map((rec) => {
    const field = (re) => (re.exec(rec) || [])[1] ?? null;
    return {
      at: field(/timestamp=(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(?:\.\d+)?)/),
      pid: Number(field(/\bpid=(\d+)/)) || null,
      process: field(/process=([A-Za-z0-9_.:]+)/),
      reason: field(/reason=(\d+ \([A-Z_ ]+\))/),
      subreason: field(/subreason=(\d+ \([A-Z_ ]+\))/),
      status: Number(field(/status=(-?\d+)/)),
      importance: Number(field(/importance=(\d+)/)),
    };
  });
}
async function exitOf(pidValue) {
  const exits = await processExits(10);
  if (!Array.isArray(exits)) return exits;
  const exit = exits.find((e) => String(e.pid) === String(pidValue)) ?? null;
  if (exit && /^12 /.test(exit.reason ?? '')) exit.dependency = await dependencyDeath(pidValue);
  return exit;
}

/**
 * Exit reason 12 (DEPENDENCY DIED) means ActivityManager killed our process
 * because a process it held a stable content-provider connection to died.
 * The exit record does not say which one; ActivityManager's own kill line
 * does ("Killing <pid>:<proc> (adj N): depends on provider <component> in
 * dying proc <process>"). Keep only those two names and the dying process's
 * allow-listed exit records, never the raw log line.
 */
async function dependencyDeath(pidValue) {
  if (!/^[0-9]{1,7}$/.test(String(pidValue ?? ''))) return null;
  let line;
  try {
    line = await sh(`logcat -d -b system,main -v brief -s ActivityManager:I | grep -E 'Killing ${pidValue}:' | tail -1`, DIAGNOSTIC_SHELL_BUDGET_MS);
  } catch (err) { return `probe failed: ${String(err?.message ?? err).slice(0, 120)}`; }
  const named = /depends on provider ([A-Za-z0-9_.$/]{1,200}) in dying proc ([A-Za-z0-9_.:]{1,120})/.exec(line);
  if (!named) return { provider: null, dyingProcess: null, killLineFound: /Killing \d+:/.test(line) };
  const [, provider, dyingProcess] = named;
  // The provider's package owns the dying process (gms.persistent belongs to
  // com.google.android.gms), so read that package's exit records.
  const exits = await processExits(10, provider.split('/')[0]);
  return {
    provider,
    dyingProcess,
    dyingProcessExits: Array.isArray(exits) ? exits.filter((e) => e.process === dyingProcess).slice(0, 2) : exits,
  };
}

async function attachPage({ timeout = 60_000 } = {}) {
  if (MODE === 'dryrun') return page;
  try {
    const attachStarted = Date.now();
    const webview = await device.webView({ pkg: PKG }, { timeout });
    const p = await withTimeout(webview.page(), Math.max(1_000, timeout - (Date.now() - attachStarted)), 'WebView DevTools page');
    p.setDefaultTimeout(20_000);
    page = p;
    return p;
  } catch (err) {
    const evidence = await webViewAttachEvidence();
    throw new Error(`Android WebView attach failed for ${PKG} after ${timeout}ms: ${String(err?.message ?? err)}; device evidence: ${JSON.stringify(evidence)}`, { cause: err });
  }
}
async function pid() { return MODE === 'dryrun' ? 'dryrun' : (await sh(`pidof ${PKG}`)) || null; }

/**
 * After a check failed inside a cold start, start the app once more exactly as
 * A01 does, so the next, independent check does not inherit a dead WebView
 * (one failed CS01 launch once turned 29 later checks red). This is not a
 * retry: the failed check stays FAIL, and a restore that fails is recorded.
 */
async function restoreLaunch(label) {
  try {
    await platform.coldLaunch();
    await attachPage();
    await until(async () => (await authVisible()) || (await appVisible()), { timeout: 45_000, message: `UI after restoring from ${label}` });
    (facts.restores ??= []).push({ after: label, ok: true });
    log(`restored a freshly launched app after ${label} (that check stays FAIL)`);
  } catch (err) {
    (facts.restores ??= []).push({ after: label, ok: false, error: String(err?.message ?? err).slice(0, 400) });
    log(`restore after ${label} failed: ${String(err?.message ?? err).slice(0, 400)}`);
  }
}

/**
 * A bounded, no-PII OS pressure snapshot. L01/ANR01 keep their original
 * PASS/FAIL semantics, but these measurements let the CI artifact distinguish
 * host CPU/memory starvation from a durable app process failure.
 *
 * Do not attach raw logcat/ANR traces here: they can contain private user data.
 */
async function androidPressureEvidence(label) {
  if (MODE !== 'android') return null;
  const outputs = {};
  const commands = {
    cpu: 'cat /proc/pressure/cpu',
    memory: 'cat /proc/pressure/memory',
    io: 'cat /proc/pressure/io',
    pid: `pidof ${PKG}`,
    // Android emulators can expose no per-cgroup/global PSI from adb shell.
    // These kernel totals are a separately labelled FALLBACK, not PSI.
    loadavg: 'cat /proc/loadavg',
    meminfo: 'cat /proc/meminfo',
  };
  for (const [key, command] of Object.entries(commands)) {
    try {
      const value = await sh(command, DIAGNOSTIC_SHELL_BUDGET_MS);
      if (key === 'pid') {
        outputs.pid = /^[0-9 ]{1,120}$/.test(value) ? value : 'unavailable';
      } else if (key === 'loadavg') {
        const match = /^(\d+(?:\.\d+)?) (\d+(?:\.\d+)?) (\d+(?:\.\d+)?) \d+\/\d+ \d+$/.exec(value);
        outputs.kernelLoadavg = match ? match.slice(1, 4).map(Number) : 'unavailable';
      } else if (key === 'meminfo') {
        const total = /^MemTotal:\s+(\d+) kB$/m.exec(value);
        const available = /^MemAvailable:\s+(\d+) kB$/m.exec(value);
        outputs.kernelMemTotalKb = total ? Number(total[1]) : 'unavailable';
        outputs.kernelMemAvailableKb = available ? Number(available[1]) : 'unavailable';
      } else {
        // Only allow the precisely defined kernel pressure text format.
        const lines = value.split('\n').filter(line =>
          /^(?:some|full) avg10=[0-9.]+ avg60=[0-9.]+ avg300=[0-9.]+ total=[0-9]+$/.test(line));
        outputs[key] = lines.length > 0 ? lines.slice(0, 2).join(' | ').slice(0, 280) : 'unavailable';
      }
    } catch {
      if (key === 'meminfo') {
        outputs.kernelMemTotalKb = 'unavailable';
        outputs.kernelMemAvailableKb = 'unavailable';
      } else {
        outputs[key === 'loadavg' ? 'kernelLoadavg' : key] = 'unavailable';
      }
    }
  }
  const item = { label, ...outputs };
  (facts.androidPressureEvidence ??= []).push(item);
  log('Android OS PSI', JSON.stringify(item));
  return item;
}


const platform = {
  async coldLaunch(extra = '') {
    if (MODE === 'dryrun') { await page.goto(API); return { totalTimeMs: null }; }
    await sh(`am force-stop ${PKG}`);
    const out = await sh(`am start -W -n ${ACTIVITY} ${extra}`);
    return {
      totalTimeMs: Number((/TotalTime:\s*(\d+)/.exec(out) || [])[1]) || null,
      // ActivityManager's own verdict on the launch (e.g. "ok"/"timeout", "COLD").
      status: (/^Status:\s*(\w+)/m.exec(out) || [])[1] ?? null,
      launchState: (/LaunchState:\s*(\w+)/.exec(out) || [])[1] ?? null,
      raw: out.split('\n').slice(-4).join(' | '),
    };
  },
  async home() { if (MODE === 'dryrun') return; await sh('input keyevent KEYCODE_HOME'); },
  async foreground() {
    if (MODE === 'dryrun') return { totalTimeMs: null };
    const out = await sh(`am start -W -n ${ACTIVITY}`);
    return { totalTimeMs: Number((/TotalTime:\s*(\d+)/.exec(out) || [])[1]) || null, launchState: (/LaunchState:\s*(\w+)/.exec(out) || [])[1] ?? null };
  },
  /**
   * Process death while backgrounded. `am kill` asks the OS for exactly what the low-memory killer
   * does, but only once the process has dropped to a background importance, so it is retried while
   * the launcher takes over. If the OS still keeps the process, it is SIGKILLed as its own uid
   * (debuggable build) — the same signal LMK sends. The method used is recorded, never hidden.
   */
  async killInBackground() {
    if (MODE === 'dryrun') throw new Skip('process death needs a device');
    let tries = 0;
    const deadline = Date.now() + 12_000;
    while (Date.now() < deadline) {
      await sh(`am kill ${PKG}`);
      tries += 1;
      await sleep(1_000);
      if (!(await pid())) return { method: 'am kill', tries };
    }
    const target = await pid();
    const state = (await sh(`dumpsys activity processes ${PKG} | grep -E "oom adj|procState|curProcState|setAdj" | head -4`).catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    const out = await sh(`run-as ${PKG} kill -9 ${target} 2>&1`).catch((err) => String(err));
    await sleep(1_000);
    if (!(await pid())) return { method: 'run-as kill -9 (am kill left it alive)', tries, stateBefore: state };
    throw new Error(`process survived am kill x${tries} and SIGKILL (${out.slice(0, 120)}); ${state}`);
  },
  async forceStop() { if (MODE === 'dryrun') throw new Skip('force-stop needs a device'); await sh(`am force-stop ${PKG}`); },
  async deepLink(url, { cold = false } = {}) {
    if (MODE === 'dryrun') throw new Skip('deep links need the native shell');
    if (cold) {
      // After force-stop Android marks the package stopped. Starting only by
      // package name has proved flaky on API 34 CI: ActivityManager reports
      // completion but no debuggable WebView appears, so every later journey
      // inherits a closed Playwright page. An explicit component still delivers
      // the VIEW intent data, while guaranteeing MainActivity is actually
      // created for the cold-start contract we are measuring.
      await sh(`am force-stop ${PKG}`);
      await sleep(500);
      return sh(`am start -W -a android.intent.action.VIEW -d '${url}' -n ${ACTIVITY}`);
    }
    return sh(`am start -W -a android.intent.action.VIEW -d '${url}' ${PKG}`);
  },
  async network(on) {
    if (MODE === 'dryrun') { await page.context().setOffline(!on); return; }
    if (!netPath) throw new Error('ANDROID_PROXY_PORT not set: adb reverse bypasses the emulated network, an offline test would be invalid');
    if (on) { netPath.restore(); await sh('svc wifi enable; svc data enable'); }
    else { await sh('svc wifi disable; svc data disable'); netPath.cut(); }
  },
  async permission(perm, grant) {
    if (MODE === 'dryrun') throw new Skip('runtime permissions need a device');
    return sh(`pm ${grant ? 'grant' : 'revoke'} ${PKG} ${perm}`);
  },
  async back() { if (MODE === 'dryrun') throw new Skip('back key needs a device'); await sh('input keyevent KEYCODE_BACK'); },
  async rotate(landscape) {
    if (MODE === 'dryrun') { await page.setViewportSize(landscape ? { width: 915, height: 412 } : { width: 412, height: 915 }); return; }
    await sh('settings put system accelerometer_rotation 0');
    await sh(`settings put system user_rotation ${landscape ? 1 : 0}`);
  },
  async memInfoKb() {
    if (MODE === 'dryrun') throw new Skip('meminfo needs a device');
    const out = await sh(`dumpsys meminfo ${PKG}`);
    return Number((/TOTAL PSS:\s*(\d+)/.exec(out) || /TOTAL\s+(\d+)/.exec(out) || [])[1]) || null;
  },
};

// ── In-page helpers ────────────────────────────────────────────────────────
const INSTRUMENT_PCS = () => {
  const w = window;
  if (w.__pcs) return;
  w.__pcs = [];
  const Orig = w.RTCPeerConnection;
  const Wrapped = function (...args) { const pc = new Orig(...args); w.__pcs.push(pc); return pc; };
  Wrapped.prototype = Orig.prototype;
  w.RTCPeerConnection = Wrapped;
};
async function outboundAudio() {
  return page.evaluate(async () => {
    // `send` describes only peer connections that carry outbound audio (the receive transport
    // stays 'new' while nobody else is in the call). `pathBytesReceived` counts bytes the SFU
    // sent back on the selected ICE pair (RTCP, consent responses): it only grows over a live path.
    const out = { pcs: 0, packetsSent: 0, videoPacketsSent: 0, audioLevel: null, states: [], send: { states: [], packets: 0, pathBytesReceived: 0 } };
    for (const pc of (window.__pcs || []).filter((p) => p.connectionState !== 'closed')) {
      out.pcs += 1;
      out.states.push(pc.connectionState);
      const stats = await pc.getStats();
      let audioOut = 0; let pairId = null;
      stats.forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'audio') audioOut += Number(r.packetsSent || 0);
        if (r.type === 'outbound-rtp' && r.kind === 'video') out.videoPacketsSent += Number(r.packetsSent || 0);
        if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') out.audioLevel = r.audioLevel;
        if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId;
      });
      out.packetsSent += audioOut;
      if (audioOut > 0) {
        out.send.states.push(pc.connectionState);
        out.send.packets += audioOut;
        const pair = pairId ? stats.get(pairId) : null;
        out.send.pathBytesReceived += Number(pair?.bytesReceived || 0);
      }
    }
    return out;
  }).catch(() => ({ pcs: 0, packetsSent: 0, videoPacketsSent: 0, audioLevel: null, states: [], send: { states: [], packets: 0, pathBytesReceived: 0 } }));
}
async function alertText(pattern) {
  return page.evaluate((src) => {
    const re = new RegExp(src, 'i');
    const t = [...document.querySelectorAll('[role="alert"], [role="status"], .toast')].map((e) => e.textContent || '').join(' | ');
    return re.test(t) ? t : null;
  }, pattern.source);
}
/** The real Android runtime-permission sheet (AOSP or Google permission controller). */
async function permissionSheet(timeout = 20_000) {
  if (MODE === 'dryrun') return { shown: false, reason: 'dryrun' };
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const xml = await sh('uiautomator dump /sdcard/p4-ui.xml >/dev/null 2>&1; cat /sdcard/p4-ui.xml').catch(() => '');
    if (/permissioncontroller/.test(xml) && /permission_(deny|allow)/.test(xml)) {
      return { shown: true, pkg: (/package="([^"]*permissioncontroller[^"]*)"/.exec(xml) || [])[1] ?? null };
    }
    await sleep(700);
  }
  const xml = await sh('uiautomator dump /sdcard/p4-ui.xml >/dev/null 2>&1; cat /sdcard/p4-ui.xml').catch(() => '');
  const packages = [...new Set([...xml.matchAll(/package="([^"]+)"/g)].map((m) => m[1]))];
  return { shown: false, foregroundPackages: packages.slice(0, 5) };
}
/**
 * Taps the first on-screen node `match` accepts, through the OS input system (`input tap`) — a real
 * touch, as a user's. (Playwright's `device.tap` needs its driver APK, which is not installed.)
 */
async function tapUiNode(match, what) {
  const xml = await sh('uiautomator dump /sdcard/p4-ui.xml >/dev/null 2>&1; cat /sdcard/p4-ui.xml');
  for (const [node] of xml.matchAll(/<node [^>]*>/g)) {
    if (!match(node)) continue;
    const b = /bounds="\[(\d+),(\d+)\]\[(\d+),(\d+)\]"/.exec(node);
    if (!b) continue;
    const [x1, y1, x2, y2] = b.slice(1).map(Number);
    await sh(`input tap ${Math.round((x1 + x2) / 2)} ${Math.round((y1 + y2) / 2)}`);
    return { x: Math.round((x1 + x2) / 2), y: Math.round((y1 + y2) / 2) };
  }
  throw new Error(`no on-screen node for ${what}`);
}
async function tapPermissionButton(kind) {
  const id = kind === 'deny' ? 'permission_deny_button' : 'permission_allow_foreground_only_button';
  const text = kind === 'deny' ? /text="(Don.t allow|Deny)"/i : /text="(While using the app|Allow)"/i;
  return tapUiNode((node) => node.includes(`:id/${id}"`) || text.test(node), `permission ${kind} button`);
}
/** A real touch on a WebView element: CSS box → device pixels via the WebView's on-screen bounds. */
async function tapWebElement(selector) {
  const box = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, dpr: window.devicePixelRatio };
  }, selector);
  if (!box) throw new Error(`no element ${selector}`);
  const xml = await sh('uiautomator dump /sdcard/p4-ui.xml >/dev/null 2>&1; cat /sdcard/p4-ui.xml');
  const wv = [...xml.matchAll(/<node [^>]*class="android\.webkit\.WebView"[^>]*>/g)].map(([n]) => /bounds="\[(\d+),(\d+)\]/.exec(n)).find(Boolean);
  if (!wv) throw new Error('WebView bounds not found on screen');
  const x = Math.round(Number(wv[1]) + box.x * box.dpr);
  const y = Math.round(Number(wv[2]) + box.y * box.dpr);
  await sh(`input tap ${x} ${y}`);
  return { x, y, dpr: box.dpr };
}
async function appVisible(p = page) {
  return p.evaluate(() => { const a = document.getElementById('app'); return !!a && getComputedStyle(a).display !== 'none' && a.getBoundingClientRect().height > 0; }).catch(() => false);
}
async function authVisible(p = page) {
  return p.evaluate(() => { const a = document.getElementById('auth-screen'); return !!a && getComputedStyle(a).display !== 'none'; }).catch(() => false);
}
async function login(username, userId) {
  await until(async () => (await authVisible()) || (await appVisible()), { timeout: 45_000, message: 'auth screen or app' });
  if (await appVisible()) return 'already-signed-in';
  // First-use onboarding wizard is marked as seen, exactly like the P2/P3 browser suites do.
  await page.evaluate((uid) => {
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
    if (uid) localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
  }, userId);
  await page.fill('#l-username', username);
  await page.fill('#l-password', PASSWORD);
  await page.click('[data-auth-action="login"]');
  await until(() => appVisible(), { timeout: 30_000, message: '#app after login' });
  return 'signed-in';
}
async function openServer(serverId) {
  await page.evaluate((sid) => {
    const el = document.querySelector(`.server-icon[data-id="${sid}"]`);
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  }, serverId);
  await until(() => page.evaluate((sid) => !!document.querySelector(`.server-icon.active[data-id="${sid}"], .server-icon[data-id="${sid}"][aria-current]`) || !!document.querySelector('.ch-item'), serverId), { message: `server ${serverId} open` });
}
async function openChannel(channelId) {
  await until(() => page.evaluate((cid) => !!document.querySelector(`.ch-item[data-id="${cid}"] .ch-open`), channelId), { message: `channel ${channelId} in list` });
  await page.evaluate((cid) => { document.querySelector(`.ch-item[data-id="${cid}"] .ch-open`)?.click(); }, channelId);
  await until(() => activeChannel().then((c) => c === channelId), { message: `channel ${channelId} active` });
}
async function activeChannel() {
  return page.evaluate(() => document.querySelector('.ch-item.active')?.getAttribute('data-id') ?? null).catch(() => null);
}
async function visibleMessage(needle) {
  return page.evaluate((n) => [...document.querySelectorAll('.msg')].some((m) => (m.textContent || '').includes(n)), needle).catch(() => false);
}
async function sendFromComposer(text) {
  await page.fill('#msg-input', text);
  await page.press('#msg-input', 'Enter');
}

// ── Journeys ───────────────────────────────────────────────────────────────
async function main() {
  log(`mode=${MODE} api=${API} pkg=${PKG}`);
  const me = await account('droid');
  const peer = await account('peer');
  const outsider = await account('out');
  const server = await write('POST', '/api/servers', me.token, { name: `Android P4 ${Date.now().toString(36)}` });
  const serverId = server._id || server.id || server.server?._id;
  const text = await write('POST', `/api/servers/${serverId}/channels`, me.token, { name: 'android-genel', type: 'text' });
  const other = await write('POST', `/api/servers/${serverId}/channels`, me.token, { name: 'android-ikinci', type: 'text' });
  const voice = await write('POST', `/api/servers/${serverId}/channels`, me.token, { name: 'android-ses', type: 'voice' });
  const channelId = text._id || text.id || text.channel?._id;
  const otherId = other._id || other.id || other.channel?._id;
  const voiceId = voice._id || voice.id || voice.channel?._id;
  const invite = await write('POST', '/api/servers/invites', me.token, { serverId });
  await write('POST', `/api/servers/invites/${invite.code}/use`, peer.token, {});
  const privateServer = await write('POST', '/api/servers', outsider.token, { name: `Private ${Date.now().toString(36)}` });
  const privateServerId = privateServer._id || privateServer.id || privateServer.server?._id;
  const privateChannel = await write('POST', `/api/servers/${privateServerId}/channels`, outsider.token, { name: 'gizli', type: 'text' });
  const privateChannelId = privateChannel._id || privateChannel.id || privateChannel.channel?._id;
  const peerSock = await openSocket(peer.token);
  peerSock.emit('channel:join', { channelId, serverId });
  Object.assign(facts, { deviceUser: me.username, serverId, channelId, otherId, voiceId, privateChannelId });

  if (netPath) { await netPath.start(); facts.networkPath = `adb reverse → proxy :${PROXY_PORT} → server :${netPath.targetPort}`; }
  if (MODE === 'android') {
    const list = await android.devices();
    assert(list.length > 0, 'no adb device');
    // ANDROID_SERIAL picks one device when several are attached (e.g. a USB phone).
    device = list.find((d) => d.serial() === process.env.ANDROID_SERIAL) ?? list[0];
    const qemu = (await sh('getprop ro.kernel.qemu')) || (await sh('getprop ro.boot.qemu'));
    facts.device = {
      serial: device.serial(),
      model: await sh('getprop ro.product.model'),
      release: await sh('getprop ro.build.version.release'),
      sdk: await sh('getprop ro.build.version.sdk'),
      abi: await sh('getprop ro.product.cpu.abi'),
      qemu,
      webview: ((await sh('dumpsys webviewupdate')).match(/Current WebView package \(name, version\): \(([^)]+)\)/) || [])[1] ?? null,
    };
    facts.apkInstalled = (await sh(`pm list packages ${PKG}`)).includes(PKG);
    log('device', JSON.stringify(facts.device));
  } else {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    page = await ctx.newPage();
    facts.device = { note: 'DRYRUN — desktop Chromium phone viewport, NOT evidence' };
  }

  await check('A01', 'cold launch reaches the auth screen (no stuck splash)', async () => {
    const launch = await platform.coldLaunch();
    await attachPage();
    await until(async () => (await authVisible()) || (await appVisible()), { timeout: 45_000, message: 'auth screen visible' });
    const splashGone = await page.evaluate(() => !document.getElementById('native-splash') || document.getElementById('native-splash').classList.contains('hidden'));
    assert(splashGone, 'native splash still covering the app');
    return { coldLaunchTotalMs: launch.totalTimeMs, origin: await page.evaluate(() => location.origin), api: await page.evaluate(() => globalThis.BRIDGE_API ?? null) };
  });

  // #209: the original failure was a 5 s FocusEvent ANR during a cold start
  // on a CPU-starved emulator (later killed by the OS, which made L01 COLD).
  // One green launch says little about that margin, so repeat the cold start
  // and record each launch's own main-thread stalls. PASS requires the UI
  // every time and ZERO package ANRs; timings and stalls are MEASURED facts.
  // logcat is never cleared here (ANR01 still reads the whole buffer) and
  // only frame counts, never raw log lines, are kept.
  await check('CS01', `${COLD_STARTS} consecutive cold starts reach the UI without any OS ANR`, async () => {
    if (MODE !== 'android') throw new Skip('cold-start stress needs a real Android runtime');
    const anrs = async () => (await sh("logcat -d -v brief -s ActivityManager:E | grep -cF 'ANR in com.bridge.app.debug' || true"))
      .split('\n').map(Number).find(Number.isFinite) ?? 0;
    const anrBefore = await anrs();
    const launches = [];
    for (let i = 1; i <= COLD_STARTS; i++) {
      const pressure = await androidPressureEvidence(`CS01-cold-${i}`);
      let launch = {};
      let launchedPid = null;
      try {
        launch = await platform.coldLaunch();
        launchedPid = await pid();
        await attachPage();
        await until(async () => (await authVisible()) || (await appVisible()), { timeout: 45_000, message: `UI after cold start ${i}` });
      } catch (err) {
        // Name the launch that failed and why the OS ended its process, if it did.
        facts.coldStartStress = launches;
        const exit = launchedPid ? await exitOf(launchedPid) : await processExits(2);
        await restoreLaunch(`CS01 cold start ${i}`);
        throw new Error(`cold start ${i}/${COLD_STARTS} (am start: ${launch.status ?? 'no status'}/${launch.launchState ?? 'no launch state'}; ` +
          `pid after launch ${launchedPid ?? 'none'}; OS exit record ${JSON.stringify(exit)}): ${err?.message ?? err}`, { cause: err });
      }
      const amStatus = `${launch.status ?? 'no status'}/${launch.launchState ?? 'no launch state'}`;
      const appPid = await pid();
      let stalls = [];
      if (/^[0-9]{1,7}$/.test(appPid ?? '')) {
        const out = await sh(`logcat -d -v brief -s Choreographer:I | grep -E '\\( *${appPid}\\)' | grep -oE 'Skipped [0-9]+ frames' || true`);
        stalls = (out.match(/Skipped \d+ frames/g) || []).map((line) => Number(/\d+/.exec(line)[0]));
      }
      launches.push({
        totalTimeMs: launch.totalTimeMs,
        amStatus,
        skippedFrameEvents: stalls.length,
        maxSkippedFrames: stalls.length ? Math.max(...stalls) : 0,
        load1: Array.isArray(pressure?.kernelLoadavg) ? pressure.kernelLoadavg[0] : null,
      });
    }
    const anrAfter = await anrs();
    facts.coldStartStress = launches;
    assert(anrAfter === anrBefore,
      `Android ActivityManager reported ${anrAfter - anrBefore} ANR(s) across ${COLD_STARTS} cold starts`);
    const times = launches.map((l) => l.totalTimeMs).filter(Number.isFinite);
    return {
      launches: launches.length,
      maxTotalTimeMs: times.length ? Math.max(...times) : null,
      maxSkippedFrames: Math.max(...launches.map((l) => l.maxSkippedFrames)),
      maxLoad1: Math.max(...launches.map((l) => l.load1 ?? 0)),
      newAnrs: anrAfter - anrBefore,
      runs: launches,
    };
  }, { budgetMs: Math.max(CHECK_BUDGET_MS, COLD_STARTS * 120_000) });

  await check('A02', 'login through the WebView reaches the app shell', async () => {
    const t0 = Date.now();
    const how = await login(me.username, me.id);
    return { how, ms: Date.now() - t0 };
  });

  await check('PN01', 'the notification channel named by server pushes (bridge_default) exists on the device', async () => {
    if (MODE === 'dryrun') throw new Skip('notification channels need a device');
    const lines = await until(async () => {
      const out = await sh(`dumpsys notification | grep -m4 "bridge_default"`).catch(() => '');
      return out.includes('bridge_default') ? out : null;
    }, { timeout: 15_000, message: 'bridge_default channel registered' });
    return { channel: lines.split('\n')[0].trim().slice(0, 200) };
  });

  await check('A03', 'server + channel list render and a channel opens', async () => {
    await openServer(serverId);
    await openChannel(channelId);
    return { active: await activeChannel() };
  });

  await check('M01', 'send a channel message from the composer; it persists server-side', async () => {
    const needle = `android-compose-${Date.now().toString(36)}`;
    await sendFromComposer(needle);
    await until(async () => (await channelHas(me.token, channelId, needle)).length === 1, { message: 'message persisted once' });
    await until(() => visibleMessage(needle), { message: 'message rendered' });
    return { needle };
  });

  await check('M02', 'live message from another user renders while foregrounded', async () => {
    const needle = `android-live-${Date.now().toString(36)}`;
    const t0 = Date.now();
    await sendChannel(peerSock, serverId, channelId, needle);
    await until(() => visibleMessage(needle), { message: 'live message rendered' });
    return { ms: Date.now() - t0 };
  });

  // The channel ID is part of the contract. A bare message text match can
  // conceal a navigation regression; do not silently reopen the channel.
  async function assertVisibleAfterResume(needle, label, timeout) {
    await until(async () => (await activeChannel()) === channelId && await visibleMessage(needle), {
      timeout, message: `${label}: original channel still active AND missed message visible`,
    });
  }

  await check('L01', 'background 20 s → original channel and missed message survive hot resume', async () => {
    await androidPressureEvidence('before-L01');
    const pidBefore = await pid();
    await platform.home();
    await sleep(3_000);
    const needle = `android-bg-${Date.now().toString(36)}`;
    await sendChannel(peerSock, serverId, channelId, needle);
    await until(async () => (await channelHas(me.token, channelId, needle)).length === 1,
      { message: 'L01 peer message persisted before foregrounding' });
    await sleep(17_000);
    const fg = await platform.foreground();
    const t0 = Date.now();
    await attachPage();
    const pidAfter = await pid();
    log('L01 resume context', JSON.stringify({ expectedChannel: channelId, actualChannel: await activeChannel(), pidStable: pidBefore === pidAfter, launchState: fg.launchState }));
    await androidPressureEvidence('after-L01');
    if (pidBefore !== pidAfter) throw new Error(`L01 process died (OS exit record ${JSON.stringify(await exitOf(pidBefore))}); cannot claim hot resume`);
    await assertVisibleAfterResume(needle, 'L01', 30_000);
    return { resumeTotalMs: fg.totalTimeMs, launchState: fg.launchState, visibleAfterMs: Date.now() - t0, pidStable: true, channelPreserved: true };
  });

  await check('L02', 'background 75 s → original channel and missed message recover after socket idle', async () => {
    const pidBefore = await pid();
    await platform.home();
    await sleep(5_000);
    const needle = `android-long-bg-${Date.now().toString(36)}`;
    await sendChannel(peerSock, serverId, channelId, needle);
    await until(async () => (await channelHas(me.token, channelId, needle)).length === 1,
      { message: 'L02 peer message persisted before foregrounding' });
    await sleep(70_000);
    const fg = await platform.foreground();
    const t0 = Date.now();
    await attachPage();
    const pidAfter = await pid();
    log('L02 resume context', JSON.stringify({ expectedChannel: channelId, actualChannel: await activeChannel(), pidStable: pidBefore === pidAfter, launchState: fg.launchState }));
    await assertVisibleAfterResume(needle, 'L02', 60_000);
    return { visibleAfterMs: Date.now() - t0, pidStable: pidBefore === pidAfter, channelPreserved: true };
  });

  await check('L03', 'process killed while backgrounded → relaunch restores session, channel and missed messages', async () => {
    const before = await pid();
    await platform.home();
    await until(async () => !(await sh('dumpsys activity activities | grep -m1 topResumedActivity')).includes(PKG),
      { timeout: 10_000, message: 'launcher in front (app backgrounded)' });
    await sleep(2_000);
    const killed = await platform.killInBackground();
    const needle = `android-dead-${Date.now().toString(36)}`;
    await sendChannel(peerSock, serverId, channelId, needle);
    const launch = await platform.foreground();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app restored without login' });
    assert(!(await authVisible()), 'auth screen shown after process death — session not restored');
    // Previously the harness manually reselected server/channel here, which
    // could conceal a REAL navigation loss after the WebView process died.
    // The product must restore the authorized previously active text channel.
    await until(async () => (await activeChannel()) === channelId && await visibleMessage(needle), {
      timeout: 30_000, message: 'original channel and missed message automatically restored after process death',
    });
    return { pidBefore: before, pidAfter: await pid(), kill: killed, relaunchTotalMs: launch.totalTimeMs };
  });

  await check('L04', 'force-stop (user kill) → cold relaunch restores the session', async () => {
    await platform.forceStop();
    const launch = await platform.foreground();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app restored after force-stop' });
    await until(async () => (await activeChannel()) === channelId, {
      timeout: 30_000, message: 'original authorized text channel restored after force-stop',
    });
    return { coldRelaunchTotalMs: launch.totalTimeMs, channelPreserved: true };
  });

  await check('N01', 'offline: banner shows, composed message is held, delivered exactly once on reconnect', async () => {
    await openServer(serverId);
    await openChannel(channelId);
    const needle = `android-offline-${Date.now().toString(36)}`;
    let offlineShown = false; let whileOffline = -1; let t0 = 0;
    try {
      await platform.network(false);
      offlineShown = await until(() => page.evaluate(() => {
        const b = document.querySelector('.offline-banner.offline');
        return !!b && getComputedStyle(b).display !== 'none';
      }), { timeout: 45_000, message: 'offline banner' }).then(() => true).catch(() => false);
      await sendFromComposer(needle);
      await sleep(3_000);
      whileOffline = (await channelHas(me.token, channelId, needle)).length;
    } finally {
      t0 = Date.now();
      await platform.network(true);
    }
    await until(async () => (await channelHas(me.token, channelId, needle)).length >= 1, { timeout: 60_000, message: 'queued message delivered' });
    const deliveredAfterReconnectMs = Date.now() - t0;
    await sleep(3_000);
    const copies = (await channelHas(me.token, channelId, needle)).length;
    assert(offlineShown, 'offline banner never appeared while the network was off');
    assert(whileOffline === 0, `message reached the server while offline (${whileOffline})`);
    assert(copies === 1, `queued message delivered ${copies} times`);
    return { deliveredAfterReconnectMs };
  });

  await check('N02', 'offline 30 s while another user posts → reconnect resync shows the missed message', async () => {
    const needle = `android-missed-${Date.now().toString(36)}`;
    let visibleWhileOffline = false; let t0 = 0;
    try {
      await platform.network(false);
      await sleep(5_000);
      await sendChannel(peerSock, serverId, channelId, needle);
      await sleep(25_000);
      // Negative check: with the path really cut, the message must NOT have arrived yet.
      visibleWhileOffline = await visibleMessage(needle);
    } finally {
      t0 = Date.now();
      await platform.network(true);
    }
    assert(!visibleWhileOffline, 'the message was visible while offline — the network was not actually cut');
    await until(() => visibleMessage(needle), { timeout: 60_000, message: 'missed message after reconnect' });
    return { visibleAfterReconnectMs: Date.now() - t0 };
  });

  await check('D01', 'DM from another user reaches the DM list and opens', async () => {
    const needle = `android-dm-${Date.now().toString(36)}`;
    await sendDm(peerSock, me.id, needle);
    await page.evaluate(() => document.querySelector('[data-bridge-action="showDmPanel"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await until(() => page.evaluate((u) => (document.querySelector('.dm-panel')?.textContent || '').includes(u), peer.username), { timeout: 20_000, message: 'DM conversation listed' });
    await page.evaluate((u) => {
      const row = [...document.querySelectorAll('.dm-panel button.dm-conversation')].find((e) => (e.textContent || '').includes(u));
      row?.click();
    }, peer.username);
    await until(() => page.evaluate((n) => (document.querySelector('.dm-panel')?.textContent || '').includes(n), needle), { timeout: 20_000, message: 'DM message visible' });
    await page.keyboard.press('Escape').catch(() => {});
    return { needle };
  });

  // K01 had an honest red Android API 34 emulator result (run 38160936435).
  // OS logcat proved KEYCODE_BACK was received by GoogleInputMethodService
  // while its soft keyboard was visible: Android consumes the FIRST Back to
  // hide IME, so Capacitor never receives it. That is not evidence that the
  // native Settings close handler failed. Test the two contracts separately.
  const settingsDialogVisible = () => page.evaluate(
    () => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')]
      .some(d => d.id === 'settings-modal-content' && d.getClientRects().length > 0),
  );
  const imeVisible = async () => /mInputShown=true/.test(await sh('dumpsys input_method'));

  await check('K01', 'Android back closes an open dialog with IME hidden, instead of leaving the app', async () => {
    await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await until(settingsDialogVisible, { message: 'settings dialog open' });
    // The preceding DM journey may have left a focused text field and shown
    // the OS keyboard. Blur it and explicitly VERIFY the IME is hidden:
    // otherwise the OS consumes KEYCODE_BACK before Capacitor can see it.
    const initialImeVisible = await imeVisible();
    if (initialImeVisible) {
      await page.evaluate(() => {
        const el = document.activeElement;
        if (el instanceof HTMLElement) el.blur();
      });
    }
    await until(async () => !(await imeVisible()), {
      timeout: 8_000, message: 'Android keyboard hidden before dialog-back contract',
    });
    assert(await settingsDialogVisible(), 'settings dialog closed during IME precondition');
    await platform.back(); // exactly ONE physical OS Back
    await until(async () => !(await settingsDialogVisible()), {
      timeout: 5_000, message: 'dialog closed by back with IME hidden',
    });
    const top = await sh('dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"').catch(() => '');
    assert(top.includes(PKG), `app left the foreground after back: ${top}`);
    return { top, initialImeVisible, imeHiddenBeforeBack: true };
  });

  await check('K02', 'Android Back first hides a visible soft keyboard, then closes Settings on a second press', async () => {
    await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await until(settingsDialogVisible, { message: 'K02 settings dialog open' });
    const tap = await tapWebElement('#display-name');
    await until(imeVisible, { timeout: 8_000, message: 'K02 soft keyboard visibly open on input' });
    await platform.back();
    await until(async () => !(await imeVisible()), {
      timeout: 5_000, message: 'K02 first Android Back hides the keyboard',
    });
    assert(await settingsDialogVisible(), 'K02 first Back incorrectly dismissed Settings instead of the IME');
    await platform.back();
    await until(async () => !(await settingsDialogVisible()), {
      timeout: 5_000, message: 'K02 second Android Back closes Settings',
    });
    const top = await sh('dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"').catch(() => '');
    assert(top.includes(PKG), `K02 app left foreground: ${top}`);
    return { tap, firstBackHidIme: true, secondBackClosedSettings: true };
  });

  await check('DL01', 'warm deep link bridge://channel/<id> opens that channel', async () => {
    await openChannel(otherId).catch(() => {});
    const raw = await platform.deepLink(`bridge://channel/${channelId}`);
    await attachPage();
    await until(() => activeChannel().then((c) => c === channelId), { timeout: 20_000, message: 'deep-linked channel active' });
    return { am: raw.split('\n').slice(-2).join(' | ') };
  });

  await check('DL04', 'the app-owned scheme com.bridge.app://channel/<id> opens that channel (the link format that also works on iOS)', async () => {
    await openChannel(otherId).catch(() => {});
    const raw = await platform.deepLink(`com.bridge.app://channel/${channelId}`);
    await attachPage();
    await until(() => activeChannel().then((c) => c === channelId), { timeout: 20_000, message: 'com.bridge.app link opened the channel' });
    return { am: raw.split('\n').slice(-2).join(' | ') };
  });

  await check('DL02', 'cold deep link bridge://channel/<id> opens that channel after session restore', async () => {
    await platform.deepLink(`bridge://channel/${otherId}`, { cold: true });
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app after cold deep link' });
    await until(() => activeChannel().then((c) => c === otherId), { timeout: 30_000, message: 'cold deep-linked channel active' });
    return {};
  });

  await check('DL03', 'deep link to a channel the user cannot access does not reveal it', async () => {
    const before = await activeChannel();
    await platform.deepLink(`bridge://channel/${privateChannelId}`);
    await attachPage();
    await sleep(6_000);
    const after = await activeChannel();
    const leaked = await page.evaluate((cid) => !!document.querySelector(`.ch-item[data-id="${cid}"]`), privateChannelId);
    assert(after !== privateChannelId && !leaked, 'inaccessible channel became visible through a deep link');
    return { before, after };
  });

  await check('P01', 'microphone permission denied in the real Android sheet → voice join tells the user', async () => {
    await platform.permission('android.permission.RECORD_AUDIO', false);
    // Revoking a granted runtime permission kills the process; relaunch.
    await platform.foreground();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app after permission revoke' });
    await openServer(serverId);
    await page.evaluate((cid) => { document.querySelector(`.ch-item[data-id="${cid}"] .ch-open`)?.click(); }, voiceId);
    const sheet = await permissionSheet();
    facts.micPermissionSheet = sheet;
    if (sheet.shown) await tapPermissionButton('deny');
    const text = await until(() => page.evaluate(() => {
      const t = [...document.querySelectorAll('[role="alert"], [role="status"], .toast')].map((e) => e.textContent || '').join(' | ');
      return /mikrofon|microphone/i.test(t) ? t : null;
    }), { timeout: 25_000, message: 'microphone denial explained in the UI' });
    return { osSheet: sheet, shown: text.slice(0, 200) };
  });

  await check('P03', 'microphone permission granted → voice join sends audio (SFU outbound RTP)', async () => {
    await platform.permission('android.permission.RECORD_AUDIO', true);
    await platform.forceStop();
    await platform.foreground();
    await attachPage();
    await page.addInitScript(INSTRUMENT_PCS);
    await page.reload();
    await until(() => appVisible(), { timeout: 45_000, message: 'app after grant' });
    await openServer(serverId);
    await page.evaluate((cid) => { document.querySelector(`.ch-item[data-id="${cid}"] .ch-open`)?.click(); }, voiceId);
    const flow = await until(async () => { const a = await outboundAudio(); return a.packetsSent > 20 ? a : null; }, { timeout: 45_000, message: 'outbound audio RTP' });
    facts.voice = { joinedWithOutboundAudio: flow };
    return flow;
  });

  await measure('P04', 'voice while backgrounded 60 s: does the OS keep the microphone capture alive?', async () => {
    const before = await outboundAudio();
    assert(before.packetsSent > 0, 'no active voice session to background');
    await platform.home();
    await sleep(60_000);
    const recording = MODE === 'android' ? await sh('dumpsys audio | grep -i -E "silenced|rec_activity|recording" | head -20').catch(() => '') : '';
    const fg = await platform.foreground();
    await attachPage();
    const after = await outboundAudio();
    const silenced = /silenced[:=]\s*true/i.test(recording);
    return { packetsBefore: before.packetsSent, packetsAfter: after.packetsSent, osReportsSilenced: silenced, audioDump: recording.slice(0, 1200), resumeMs: fg.totalTimeMs };
  });

  await check('V02', 'voice survives a 10 s network loss: the connection recovers and audio flows again', async () => {
    const before = await outboundAudio();
    assert(before.pcs > 0, 'no active voice session');
    let during = null;
    try {
      await platform.network(false);
      await sleep(10_000);
      during = await outboundAudio();
    } finally {
      await platform.network(true);
    }
    const t0 = Date.now();
    // Recovered = the send transport is connected AND, over the same 2 s window, audio packets
    // leave AND the SFU's bytes come back on the selected ICE pair (a live path, not packets
    // sent into the void). P2 measured recovery at 3-30 s, up to 90 s.
    let last = null;
    const after = await until(async () => {
      const a = await outboundAudio();
      await sleep(2_000);
      const b = await outboundAudio();
      last = { sendStates: b.send.states, packetsDelta: b.send.packets - a.send.packets, pathBytesDelta: b.send.pathBytesReceived - a.send.pathBytesReceived };
      return b.send.states.includes('connected') && last.packetsDelta > 40 && last.pathBytesDelta > 0 ? { ...last } : null;
    }, { timeout: 90_000, message: 'voice send path recovered (connected, audio leaving, SFU bytes returning)' })
      .catch((err) => { throw new Error(`${err.message}; last window ${JSON.stringify(last)}; during loss ${JSON.stringify(during?.send ?? null)}`); });
    return { recoveredAfterMs: Date.now() - t0, sendStatesDuringLoss: during?.send?.states ?? null, ...after };
  });

  await check('P06', 'camera permission denied in the real Android sheet → the camera toggle tells the user', async () => {
    await page.evaluate(() => document.getElementById('vc-video')?.click());
    const sheet = await permissionSheet();
    facts.cameraPermissionSheet = sheet;
    if (sheet.shown) await tapPermissionButton('deny');
    const text = await until(() => alertText(/kamera|camera/), { timeout: 25_000, message: 'camera denial explained in the UI' });
    const videoOn = await page.evaluate(() => document.getElementById('vc-video')?.getAttribute('aria-pressed'));
    assert(videoOn !== 'true', 'camera toggle claims to be on after the permission was denied');
    return { osSheet: sheet, shown: text.slice(0, 200) };
  });

  await check('P07', 'camera permission granted → video is sent (emulated camera, outbound video RTP)', async () => {
    await platform.permission('android.permission.CAMERA', true);
    await sleep(1_000);
    await page.evaluate(() => document.getElementById('vc-video')?.click());
    const sheet = await permissionSheet(4_000);
    if (sheet.shown) await tapPermissionButton('allow');
    const flow = await until(async () => { const a = await outboundAudio(); return a.videoPacketsSent > 30 ? a : null; }, { timeout: 45_000, message: 'outbound video RTP' });
    await page.evaluate(() => document.getElementById('vc-video')?.click());
    return { videoPacketsSent: flow.videoPacketsSent };
  });

  await check('V03', 'leaving voice closes the media connections', async () => {
    await page.evaluate(() => document.querySelector('.vc-controls .vc-btn-danger')?.click());
    const closed = await until(async () => (await outboundAudio()).pcs === 0, { timeout: 20_000, message: 'all peer connections closed' });
    return { closed };
  });

  await check('P02', 'notification permission state is readable without prompting', async () => {
    await platform.permission('android.permission.POST_NOTIFICATIONS', false).catch(() => {});
    await platform.foreground();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app' });
    const status = await page.evaluate(() => window.bridgePush?.status?.() ?? 'no-bridgePush');
    assert(['denied', 'prompt', 'unavailable'].includes(status), `unexpected push permission status: ${status}`);
    return { status };
  });

  await check('UI01', 'landscape: no horizontal overflow and the composer stays visible', async () => {
    await openServer(serverId);
    await openChannel(channelId);
    await platform.rotate(true);
    await sleep(2_500);
    const m = await page.evaluate(() => {
      const c = document.getElementById('msg-input')?.getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, ih: window.innerHeight, composerBottom: c ? Math.round(c.bottom) : null, composerH: c ? Math.round(c.height) : null };
    });
    await platform.rotate(false);
    await sleep(1_500);
    assert(m.sw <= m.iw + 1, `horizontal overflow in landscape: scrollWidth ${m.sw} > innerWidth ${m.iw}`);
    assert(m.composerBottom !== null && m.composerBottom <= m.ih + 1, `composer outside the landscape viewport: ${JSON.stringify(m)}`);
    return m;
  });

  await check('UI02', 'software keyboard: the composer stays above the keyboard', async () => {
    if (MODE === 'dryrun') throw new Skip('the software keyboard needs a device');
    await openChannel(channelId);
    const tap = await tapWebElement('#msg-input');
    const imeShown = await until(async () => /mInputShown=true/.test(await sh('dumpsys input_method')), { timeout: 8_000, message: 'IME shown' }).then(() => true).catch(() => false);
    await sleep(1_500);
    const m = await page.evaluate(() => {
      const r = document.getElementById('msg-input').getBoundingClientRect();
      return { composerBottom: Math.round(r.bottom), visibleHeight: Math.round(window.visualViewport?.height ?? window.innerHeight),
        innerHeight: window.innerHeight, keyboardOpenClass: document.body.classList.contains('keyboard-open'), focused: document.activeElement?.id ?? null };
    });
    if (imeShown) await platform.back();
    assert(imeShown, `the software keyboard never appeared for the composer (${JSON.stringify({ ...m, tap })})`);
    assert(m.composerBottom <= m.visibleHeight + 2, `composer hidden behind the keyboard: bottom ${m.composerBottom} > visible ${m.visibleHeight}`);
    return { ...m, tap };
  });

  await check('F01', 'attach a photo through the Android system picker → uploaded and sent as a file message', async () => {
    if (MODE === 'dryrun') throw new Skip('the system file picker needs a device');
    // A real PNG in the shared Downloads folder, indexed like any downloaded file.
    const name = `p4-photo-${Date.now().toString(36)}.png`;
    const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
    await sh(`echo ${PNG} | base64 -d > /sdcard/Download/${name}`);
    await sh(`am broadcast -a android.intent.action.MEDIA_SCANNER_SCAN_FILE -d file:///sdcard/Download/${name} >/dev/null 2>&1`).catch(() => {});
    await sleep(1_500);
    await openServer(serverId);
    await openChannel(channelId);
    // A real touch: the page may open a file chooser only from a user gesture.
    await tapWebElement('#btn-attach');
    const pickerPkg = await until(async () => {
      const xml = await sh('uiautomator dump /sdcard/p4-ui.xml >/dev/null 2>&1; cat /sdcard/p4-ui.xml').catch(() => '');
      return (/package="([^"]*(documentsui|providers\.media)[^"]*)"/.exec(xml) || [])[1] ?? null;
    }, { timeout: 15_000, message: 'system file picker in front' });
    const route = [];
    const tapName = () => tapUiNode((n) => n.includes(`text="${name}"`), name).then(() => true).catch(() => false);
    if (await tapName()) route.push('recent');
    else {
      await tapUiNode((n) => /content-desc="Show roots"/i.test(n), 'roots drawer').then(() => route.push('roots')).catch(() => {});
      await sleep(1_000);
      await tapUiNode((n) => /text="Downloads?"/i.test(n), 'Downloads root').then(() => route.push('downloads')).catch(() => {});
      await sleep(1_500);
      assert(await tapName(), `picked file not found in the picker (${pickerPkg}, route ${route.join('>')})`);
      route.push('file');
    }
    await attachPage();
    const staged = (await until(() => page.evaluate(() => (document.getElementById('msg-input') ? { text: document.querySelector('.msg-input-wrap')?.textContent ?? '' } : null)),
      { timeout: 10_000, message: 'composer back' })).text;
    await page.press('#msg-input', 'Enter');
    const sent = await until(async () => {
      const r = await http('GET', `/api/channels/${channelId}/messages?limit=20`, { token: me.token });
      const list = Array.isArray(r.json) ? r.json : r.json?.messages ?? [];
      return list.find((m) => m.fileName === name) ?? null;
    }, { timeout: 30_000, message: 'file message persisted server-side' }).catch(async (err) => {
      const shown = await page.evaluate(() => [...document.querySelectorAll('[role="alert"], .attach-error, .msg-attach-error')].map((e) => e.textContent).join(' | ')).catch(() => '');
      throw new Error(`${err.message}; composer said: ${shown.slice(0, 300)}; staged: ${staged.includes(name)}`);
    });
    return { picker: pickerPkg, route: route.join('>'), type: sent.type ?? null, fileType: sent.fileType ?? null };
  });

  await measure('N03', 'high latency (≈400 ms one way on every packet): composer send → persisted and rendered', async () => {
    if (!netPath) throw new Skip('needs the controllable network path');
    netPath.delay(400);
    try {
      const needle = `android-slow-${Date.now().toString(36)}`;
      const t0 = Date.now();
      await sendFromComposer(needle);
      await until(async () => (await channelHas(me.token, channelId, needle)).length === 1, { timeout: 40_000, message: 'message persisted under latency' });
      const persistedMs = Date.now() - t0;
      await until(() => visibleMessage(needle), { timeout: 20_000, message: 'rendered under latency' });
      return { oneWayDelayMs: 400, sendToPersistMs: persistedMs, copies: (await channelHas(me.token, channelId, needle)).length };
    } finally { netPath.delay(0); }
  });

  await measure('PERF02', 'long channel: memory, DOM and main-thread stalls while loading history (Android WebView)', async () => {
    if (MODE !== 'android') throw new Skip('the long-channel measurement is for the device WebView');
    const seeded = await seedLongChannel(serverId, me.id, me.token, LONG_CHANNEL_MESSAGES);
    if (!seeded) throw new Skip('DATABASE_URL not available to seed the channel');
    // A channel created elsewhere is not pushed to open clients (by design: channel metadata is not
    // broadcast; each client loads its authorized list). The app is reloaded — as after a restart —
    // which also gives the measurement a clean baseline.
    await page.reload();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app after reload' });
    await page.evaluate(() => {
      window.__longTasks = [];
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch {}
    });
    await openServer(serverId);
    await openChannel(seeded.channelId);
    const sample = async (step) => ({
      step,
      msgs: await page.evaluate(() => document.querySelectorAll('.msg').length),
      domNodes: await page.evaluate(() => document.getElementsByTagName('*').length),
      jsHeapMB: await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null)),
      pssKb: await platform.memInfoKb(),
      longTasks: await page.evaluate(() => window.__longTasks.length),
      longestTaskMs: await page.evaluate(() => Math.round(Math.max(0, ...window.__longTasks))),
    });
    await until(() => page.evaluate(() => document.querySelectorAll('.msg').length > 0), { timeout: 30_000, message: 'first page' });
    const rows = [await sample('open')];
    let prev = rows[0].msgs;
    for (let i = 1; i <= 40; i++) {
      // The message list scrolls inside #messages-area (MessageListPanel listens there); scrolling
      // `.msg-list` loaded nothing — harness defect in the first complete PERF02 run.
      await page.evaluate(() => { const el = document.getElementById('messages-area'); if (el) { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); } });
      const grew = await until(() => page.evaluate((p) => document.querySelectorAll('.msg').length > p, prev), { timeout: 6_000, message: 'history page' }).then(() => true).catch(() => false);
      if (!grew) break;
      prev = await page.evaluate(() => document.querySelectorAll('.msg').length);
      if (i % 5 === 0 || prev >= LONG_CHANNEL_MESSAGES) rows.push(await sample(`older#${i}`));
      if (prev >= LONG_CHANNEL_MESSAGES) break;
    }
    rows.push(await sample('end'));
    return { seeded: LONG_CHANNEL_MESSAGES, samples: rows };
  });

  await measure('PERF01', 'memory footprint after the journeys (PSS)', async () => {
    const kb = await platform.memInfoKb();
    return { totalPssKb: kb };
  });

  // Last on purpose: before P4 this launch killed the process (the negative control for P4-18).
  await check('P05', 'notification permission granted on a build without Firebase config → app launches, stays alive and says push is unavailable', async () => {
    await platform.permission('android.permission.POST_NOTIFICATIONS', true);
    await platform.forceStop();
    const launch = await platform.foreground();
    await sleep(12_000);
    const alive = await pid();
    const crash = MODE === 'android' ? await sh('logcat -d -b crash | tail -40').catch(() => '') : '';
    assert(alive, `app process died after launch with notification permission granted\n${crash.slice(-1500)}`);
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app visible' });
    const status = await page.evaluate(() => window.bridgePush?.status?.() ?? 'no-bridgePush');
    assert(status === 'unavailable', `a build without FCM must report push as unavailable, got ${status}`);
    return { pid: alive, status, launchMs: launch.totalTimeMs };
  });

  // Last: a crash here would end the process the remaining checks need.
  await check('LO01', 'sign out on a build without Firebase → sign-in screen, the app process stays alive', async () => {
    await until(() => appVisible(), { timeout: 30_000, message: 'app visible before sign-out' });
    const before = await pid();
    await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')
      ?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await until(() => page.evaluate(() => !!document.getElementById('tab-security')), { timeout: 15_000, message: 'settings open' });
    await page.evaluate(() => document.getElementById('tab-security')?.click());
    await until(() => page.evaluate(() => !!document.querySelector('[data-testid="sec-logout"]')), { timeout: 15_000, message: 'security tab' });
    await page.evaluate(() => document.querySelector('[data-testid="sec-logout"]')?.click());
    await sleep(8_000);
    const after = await pid();
    const crash = MODE === 'android' ? await sh('logcat -d -b crash | tail -40').catch(() => '') : '';
    assert(after && after === before, `app process ended after sign-out (before ${before}, after ${after})\n${crash.slice(-1500)}`);
    await attachPage();
    await until(() => authVisible(), { timeout: 20_000, message: 'sign-in screen after sign-out' });
    return { pid: after };
  });

  await check('ANR01', 'Android OS never reported an app-not-responding event during these journeys', async () => {
    if (MODE !== 'android') throw new Skip('Android OS process evidence requires a real Android runtime');
    // Unlike a JavaScript console assertion, ActivityManager's ANR record
    // survives a killed/restarted Activity. The failing 38148509383 run
    // contained a FocusEvent timeout ANR at 14:51:40 and the OS killed the
    // Activity at 14:52:04; the old tests mislabeled the later launch HOT.
    const anrLog = await sh("logcat -d -v brief -s ActivityManager:E | grep -F 'ANR in com.bridge.app.debug' || true");
    if (anrLog.includes('ANR in com.bridge.app.debug')) {
      await androidPressureEvidence('ANR01-failure');
      // Count only package-specific ANR headers, never expose raw logcat lines.
      facts.androidAnrCount = anrLog.split('\n').filter(line => line.includes('ANR in com.bridge.app.debug')).length;
    }
    assert(!anrLog.includes('ANR in com.bridge.app.debug'),
      'Android ActivityManager detected an ANR; process restart/restoration is NOT sufficient for a pass');
    return { systemAnrCount: 0 };
  });

  peerSock.close();
}

main()
  .catch(async (err) => {
    results.push({ id: 'HARNESS', title: 'journey setup', status: 'FAIL', error: String(err?.stack ?? err).slice(0, 3000) });
    log('HARNESS FAILURE', err?.stack ?? err);
  })
  .finally(async () => {
    const summary = {
      // Derived from the device itself, never assumed: an emulator reports ro.kernel.qemu / ro.boot.qemu = 1.
      evidenceCategory: MODE !== 'android' ? 'DRYRUN (harness debugging only — NOT evidence)'
        : facts.device?.qemu === '1' ? 'AUTOMATED / EMULATOR'
        : facts.device?.serial ? 'AUTOMATED / REAL DEVICE' : 'UNKNOWN (device not identified — NOT evidence)',
      runId: RUN_ID,
      commit: process.env.GITHUB_SHA ?? null,
      facts,
      totals: {
        pass: results.filter((r) => r.status === 'PASS').length,
        fail: results.filter((r) => r.status === 'FAIL').length,
        skipped: results.filter((r) => r.status === 'SKIPPED').length,
        measured: results.filter((r) => r.status === 'MEASURED').length,
      },
      results,
    };
    fs.writeFileSync(path.join(OUT_DIR, 'android-evidence.json'), JSON.stringify(summary, null, 2));
    console.log('\n══════ ANDROID JOURNEY EVIDENCE ══════');
    console.log(`category: ${summary.evidenceCategory}`);
    console.log(`device: ${JSON.stringify(facts.device ?? {})}`);
    for (const r of results) console.log(`${r.status.padEnd(8)} ${r.id.padEnd(7)} ${r.title}${r.error ? `\n          ↳ ${r.error.split('\n')[0]}` : ''}${r.reason ? `\n          ↳ ${r.reason}` : ''}${r.detail ? `\n          ↳ ${JSON.stringify(r.detail)}` : ''}`);
    console.log(`TOTAL pass=${summary.totals.pass} fail=${summary.totals.fail} skipped=${summary.totals.skipped} measured=${summary.totals.measured} (skipped and measured are never counted as pass)`);
    try { if (device) await withTimeout(device.close(), 10_000, 'adb device close'); } catch {}
    process.exit(summary.totals.fail > 0 ? 1 : 0);
  });
