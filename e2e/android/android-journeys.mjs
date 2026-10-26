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
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { emptyProductExitLedger, mergeProductExitCheckpoint, summarizeProductExitLedger, parseFinalizationProbeMarkers, parseAnrTraceProbeMarkers, parseFontRefReleaseMarkers, parseArtExplicitGcLog, parseApplicationExits, parseDependencyKillLine, parseActivityManagerAnrs, parseAnrCpuPressure, summarizeWebViewAttachEvidence, classifyWebViewDevToolsTargets, inspectBridgeEmojiFontProvider, parseNativeEmojiStartupProbe, summarizeControlProcessExit, summarizeFreshControlProcessExit, summarizeAndroidColdLaunch, classifyAndroidDependencyDeath, classifyFreshAndroidDependencyDeath, summarizeAndroidWebViewProvider, summarizeAndroidWebViewAlternatives, redactRecentAndroidExits, parseAnrEventTimeline, stepAtOffset, inspectAnrDialogWindows, parseDeviceEpoch, parseStallControlMarkers } from './exit-diagnostics.mjs';
import { readAndroidCrashClock, collectAndroidJavaCrashEvidence } from './java-crash-probe.mjs';
import { runLifecycleReproduction, observeLifecycleWindow } from './lifecycle-reproduction.mjs';
import { pausedPreferenceControlApplies, runPausedPreferenceControl, readPausedPreference } from './paused-preference-control.mjs';
import { createDebuggerStoragePause } from './debugger-storage-pause.mjs';
import { collectKernelPressure } from './pressure-evidence.mjs';

const MODE = process.env.ANDROID_JOURNEY_MODE === 'dryrun' ? 'dryrun' : 'android';
// #209: 'product' (default) runs every Bridge reliability journey and gates CI.
// 'upstream-webview-controls' runs ONLY the unmitigated Android WebView
// reproduction controls (FD00*, CS00): debug Activities with no Bridge code
// that reproduce the upstream FontsProvider leak and its DEPENDENCY DIED kill.
// They run in the non-gating nightly diagnostic workflow; their failures stay
// real FAILs with a nonzero exit, and they are never counted in product totals.
const SUITE = process.env.ANDROID_JOURNEY_SUITE === 'upstream-webview-controls'
  ? 'upstream-webview-controls' : 'product';
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
    if (device) fs.writeFileSync(file, await device.screenshot());
    else if (page) await page.screenshot({ path: file });
    return path.basename(file);
  } catch { return null; }
}

// A01 original startup process is kept ONLY in memory for failure attribution.
// Never append this PID to the CI result JSON or diagnostic logs.
let a01InitialPid = null;
// Device epoch ms at journey start: ANR02 reads only exits recorded after it.
let journeyStartedEpochMs = null;
// Same instant on the device's local clock, the clock ApplicationExitInfo
// timestamps in `dumpsys activity exit-info` are printed in.
let journeyStartedAt = null;
// PD01: product exit history accumulated across checkpoints (memory only; the
// ledger keeps PIDs/timestamps for de-duplication and never leaves).
let productExitLedger = emptyProductExitLedger();
let productExitUnreadable = 0;
let a01LaunchStartedAt = null;
// #209 ANR03 (memory only): the device-clock origin of the ANR timeline and
// the host instant it was read at, every check's host start time, the Bridge
// process's de-duplicated event-log lines and ANR-dialog samples. Only
// offsets, process ordinals and fixed classes ever leave.
let anrOrigin = null;
const stepStarts = [];
const anrEventLines = new Set();
let anrEventReads = 0;
let anrEventReadFailures = 0;
const anrDialogSamples = [];

async function check(id, title, fn) {
  const started = Date.now();
  stepStarts.push({ id, hostMs: started });
  log(`▶ ${id} ${title}`);
  try {
    const detail = await fn();
    results.push({ id, title, status: 'PASS', ms: Date.now() - started, detail: detail ?? null });
    log(`  PASS ${id}`, detail ? JSON.stringify(detail) : '');
  } catch (err) {
    if (err instanceof Skip) {
      results.push({ id, title, status: 'SKIPPED', ms: Date.now() - started, reason: err.message });
      log(`  SKIPPED ${id}: ${err.message}`);
      return;
    }
    // #209: preserve the failure as FAIL, and record only allow-listed OS
    // exit/dependency facts before any screenshot or DevTools probe can stall.
    if (MODE === 'android' && (id === 'CS01' || id === 'L01' || id === 'ANR01')) {
      const exitFacts = await androidFailureExits();
      const safe = redactRecentAndroidExits(exitFacts);
      (facts.androidFailureExits ??= []).push({ check: id, ...safe });
      log(`Android exit evidence ${id}`, JSON.stringify(safe));
    }
    // A01 can time out with a detached/closed CDP page even while the
    // Android process and Activity are still alive. Failure-only and never
    // a retry: log only fixed booleans/counts, no page URLs, target titles,
    // raw ActivityManager output, Playwright exceptions or user content.
    if (MODE === 'android' && id === 'A01') {
      let pageClosed = null;
      try { pageClosed = typeof page?.isClosed === 'function' ? Boolean(page.isClosed()) : null; }
      catch { /* diagnostic cannot replace the original A01 failure */ }
      let osEvidence = null;
      try { osEvidence = await webViewAttachEvidence(); }
      catch { /* an unavailable probe stays unknown rather than healthy */ }
      // A successful am start response does not prove the Android process
      // survived until CDP attached. If the launch PID was observed, correlate
      // ONLY that PID against bounded OS ApplicationExitInfo on failure.
      // Matching=false means unknown, never "no crash".
      let exitEvidence = { evidenceValid: false, matchingExit: false,
        reasonCode: null, subreasonCode: null };
      let dependencyEvidence = classifyAndroidDependencyDeath(null, null);
      if (a01InitialPid !== null) {
        try {
          const endedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
          const exits = await androidFailureExits();
          if (exits.available) {
            exitEvidence = summarizeFreshControlProcessExit(
              exits.exits, a01InitialPid, PKG, a01LaunchStartedAt, endedAt);
            dependencyEvidence = classifyFreshAndroidDependencyDeath(
              exits.exits, a01InitialPid, PKG, a01LaunchStartedAt, endedAt);
          }
        } catch { /* no diagnostic error may replace A01 FAIL */ }
      }
      const a01 = {
        pageHandlePresent: Boolean(page), pageClosed, osEvidence,
        launch: facts.androidA01Launch ?? null, exitEvidence, dependencyEvidence,
      };
      facts.androidA01FailureEvidence = a01;
      log('Android A01 first-launch evidence', JSON.stringify(a01));
    }
    const shot = await screenshot(`${id}-fail`);
    const dom = await domSummary();
    results.push({ id, title, status: 'FAIL', ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 2000), screenshot: shot, dom });
    if (dom) log(`  DOM ${id}: ${dom}`);
    log(`  FAIL ${id}: ${err?.message ?? err}`);
  }
}

/** What the user was looking at when a check failed (the artifact host may be unreachable). */
async function domSummary() {
  if (!page) return null;
  // CI artifacts are retained after failures. Report only bounded counts and
  // booleans: labels, toasts, DM text, channel IDs and arbitrary URL paths
  // can contain account data or credentials. These are NOT safe to archive.
  return page.evaluate(() => {
    const visible = (el) => !!el && el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden';
    const count = (selector) =>
      Math.min(99, [...document.querySelectorAll(selector)].filter(visible).length);
    return JSON.stringify({
      packagedOrigin: location.origin === 'https://localhost',
      appVisible: visible(document.getElementById('app')),
      authVisible: visible(document.getElementById('auth-screen')),
      activeChannelPresent: Boolean(document.querySelector('.ch-item.active')),
      dialogCount: count('[role="dialog"]'),
      alertCount: count('[role="alert"], [role="status"], .toast'),
      dmPanelVisible: visible(document.querySelector('.dm-panel')),
    });
  }).catch(() => 'unavailable');
}

/** Measurement-only probe: records numbers, asserts nothing, and is NEVER counted as a PASS. */
async function measure(id, title, fn) {
  const started = Date.now();
  stepStarts.push({ id, hostMs: started });
  log(`▶ ${id} ${title} (measurement)`);
  try {
    const detail = await fn();
    results.push({ id, title, status: 'MEASURED', ms: Date.now() - started, detail: detail ?? null });
    log(`  MEASURED ${id}`, detail ? JSON.stringify(detail) : '');
  } catch (err) {
    if (err instanceof Skip) { results.push({ id, title, status: 'SKIPPED', ms: Date.now() - started, reason: err.message }); return; }
    results.push({ id, title, status: 'FAIL', ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 2000), screenshot: await screenshot(`${id}-fail`) });
    log(`  FAIL ${id}: ${err?.message ?? err}`);
  }
}

function assert(cond, message) { if (!cond) throw new Error(message); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, { timeout = 15_000, interval = 250, message = 'condition' } = {}) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try { last = await fn(); if (last) return last; } catch (e) { last = e; }
    await sleep(interval);
  }
  // Playwright and HTTP errors can embed private URLs, response bodies and
  // selectors. Keep failure/timeout attribution without archiving their text.
  throw new Error(`timed out after ${timeout} ms waiting for ${message}; last operation errored: ${last instanceof Error}`);
}

// ── Host-side API (the other side of every journey) ─────────────────────────
async function http(method, url, { token, body, csrf, stepUpGrant } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (stepUpGrant) headers['X-Bridge-Step-Up'] = stepUpGrant;
  const res = await fetch(`${API}${url}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, ok: res.ok, json };
}
async function csrfFor(token) {
  const r = await http('GET', '/api/csrf-token', { token });
  return r.json?.token || r.json?.csrfToken;
}
async function write(method, url, token, body, stepUpGrant) {
  const r = await http(method, url, { token, body, csrf: await csrfFor(token), stepUpGrant });
  if (!r.ok) throw new Error(`${method} API request failed (HTTP ${r.status})`);
  return r.json;
}
async function account(label) {
  const username = `p4${label}${Date.now().toString(36)}`.slice(0, 24);
  const reg = await http('POST', '/api/register', { body: { username, password: PASSWORD } });
  if (!reg.ok) throw new Error(`register ${label} failed (HTTP ${reg.status})`);
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

// ── P7 D2 expiry seeding: the real API sets the expiry (owner only, 1 h minimum), then the
// stored value is moved into the database clock's past. Nothing in the product offers a shorter
// lifetime, and the journey must not wait an hour. Requires DATABASE_URL (provided in CI);
// without it the journey FAILS instead of skipping, so a missing service is never green.
async function expireChannelNow(serverId, channelId, token) {
  if (!process.env.DATABASE_URL) throw new Error('D2L01 needs DATABASE_URL to move an API-set expiry into the past');
  // D2L01 is a legitimate account holder: obtain a fresh password proof.
  // Do not bypass the channel expiry guard or depend on a possibly stale
  // sign-in grant after the emulator's lengthy startup.
  const proof = await write('POST', '/api/step-up/password', token, {
    password: PASSWORD, scope: 'destructive-admin',
  });
  assert(proof.stepUp?.scope === 'destructive-admin' && typeof proof.stepUp?.token === 'string',
    'D2L01 destructive-admin proof required');
  await write('PUT', `/api/servers/${serverId}/channels/${channelId}/expiry`, token,
    { expiresAt: Date.now() + 2 * 60 * 60 * 1000 }, proof.stepUp.token);
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const pg = require('../../server/node_modules/pg');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const r = await client.query(`UPDATE channels SET "expiresAt" = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT - 1000
      WHERE _id = $1 AND "serverId" = $2 AND "expiryVersion" > 0`, [channelId, serverId]);
    if (r.rowCount !== 1) throw new Error('D2L01 expiry seed did not update exactly one channel');
  } finally { await client.end(); }
}

// ── Platform layer ─────────────────────────────────────────────────────────
const sh = async (cmd) => (await device.shell(cmd)).toString().trim();

// Failure-only adb probes are time-budgeted. The Android OS exit records can
// contain free-text descriptions and user data: NEVER log the original output.
async function androidFailureShell(command) {
  let timer;
  try {
    return await Promise.race([
      sh(command),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('diagnostic-timeout')), 12_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
async function androidFailureExits() {
  if (MODE !== 'android' || !/^[A-Za-z0-9_.]{1,120}$/.test(PKG)) {
    return { available: false };
  }
  let exits;
  try {
    exits = parseApplicationExits(await androidFailureShell(`dumpsys activity exit-info ${PKG}`), 6)
      .filter((item) => item.process === PKG);
  } catch {
    return { available: false, error: 'exit-info-probe-unavailable' };
  }
  const rows = [];
  for (const exit of exits.slice(0, 3)) {
    let dependency = null;
    if (/^12 /.test(exit.reason ?? '') && Number.isInteger(exit.pid)) {
      try {
        // Android may reuse a PID; timestamp and exact package are required.
        // Logcat content stays in memory; never export raw lines.
        const lines = await androidFailureShell(
          `logcat -d -b system,main -v threadtime -s ActivityManager:I | grep -F 'Killing ${exit.pid}:${PKG}' | tail -n 30`);
        dependency = parseDependencyKillLine(lines, exit.pid, PKG, exit.at);
      } catch {
        dependency = { available: false };
      }
    }
    rows.push({ ...exit, ...(dependency ? { dependency } : {}) });
  }
  return { available: true, exits: rows };
}

// Failure-only diagnostics: retain the ORIGINAL WebView assertion and capture
// enough Android state to distinguish a native crash, a stopped Activity, and
// an adb/DevTools attachment problem. No extra retry or implicit PASS.

const execFileAsync = promisify(execFileCallback);

/**
 * Failure-only, short-lived ADB localabstract forward to the exact running
 * app PID's DevTools socket. Probe /json/list via 127.0.0.1, keeping the
 * complete response ONLY in memory (never archive titles/URLs/ws endpoints).
 * This cannot turn any failed journey green, and a successful HTTP response
 * is not proof that a Playwright CDP connection or product restoration works.
 */
async function devToolsHttpProbe(appPid) {
  const unavailable = { attempted: false, httpResponsive: false, listValid: false, targetCount: 0, pageTargetCount: 0 };
  if (MODE !== 'android' || !/^[0-9]{1,8}$/.test(String(appPid))) return unavailable;
  let serial;
  try { serial = device?.serial?.(); } catch { return unavailable; }
  if (!/^[A-Za-z0-9_.:-]{1,100}$/.test(String(serial))) return unavailable;
  let port = null;
  try {
    const forwarded = await execFileAsync('adb', ['-s', serial, 'forward', 'tcp:0',
      'localabstract:webview_devtools_remote_' + appPid], { timeout: 4000, maxBuffer: 2048 });
    const candidate = String(forwarded.stdout).trim();
    if (!/^[0-9]{1,5}$/.test(candidate)) return unavailable;
    port = Number(candidate);
    if (port < 1024 || port > 65535) return unavailable;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 4000);
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: ctrl.signal });
      if (!response.ok) return { ...unavailable, attempted: true };
      const length = Number(response.headers.get('content-length') || 0);
      if (length > 1_000_000) return { ...unavailable, attempted: true };
      const raw = await response.text();
      if (raw.length > 1_000_000) return { ...unavailable, attempted: true };
      const safe = classifyWebViewDevToolsTargets(JSON.parse(raw));
      return { attempted: true, httpResponsive: true, ...safe };
    } finally { clearTimeout(timer); }
  } catch {
    return { ...unavailable, attempted: true };
  } finally {
    if (port !== null) {
      try {
        await execFileAsync('adb', ['-s', serial, 'forward', '--remove', `tcp:${port}`],
          { timeout: 4000, maxBuffer: 2048 });
      } catch { /* Debug cleanup only; original failure remains a failure. */ }
    }
  }
}

async function readAttachCrashClock() {
  if (MODE !== 'android') return null;
  return readAndroidCrashClock(androidFailureShell);
}

async function webViewAttachEvidence(crashWindowStart = null) {
  // All outputs below are held only in memory. Do NOT write raw dumpsys,
  // process records, Unix sockets, crash lines or arbitrary Playwright errors
  // to CI logs/artifacts: they can contain private identities and paths.
  const commands = {
    pid: `pidof ${PKG}`,
    activity: 'dumpsys activity activities',
    processes: 'dumpsys activity processes',
    sockets: 'cat /proc/net/unix',
    crash: 'logcat -d -b crash -v epoch -t 200',
  };
  const inputs = {};
  const probeAvailable = {};
  await Promise.all(Object.entries(commands).map(async ([name, command]) => {
    try {
      inputs[name] = await androidFailureShell(command);
      probeAvailable[name] = true;
    } catch {
      inputs[name] = '';
      probeAvailable[name] = false;
    }
  }));
  const os = summarizeWebViewAttachEvidence(inputs, PKG);
  const appCrash = await collectAndroidJavaCrashEvidence(androidFailureShell, PKG,
    crashWindowStart, inputs.crash);
  const devtoolsHttp = await devToolsHttpProbe(inputs.pid);
  return {
    probeAvailable,
    ...os,
    appCrash,
    devtoolsHttp,
    // A reachable /json/list is NOT proof that Playwright attached to a page.
    // Keep original L03 FAIL; no retries or timeout extension.
  };
}

async function attachPage({ timeout = 60_000, crashWindowStart = null } = {}) {
  if (MODE === 'dryrun') return page;
  try {
    const webview = await device.webView({ pkg: PKG }, { timeout });
    const p = await webview.page();
    p.setDefaultTimeout(20_000);
    page = p;
    return p;
  } catch (err) {
    const evidence = await webViewAttachEvidence(crashWindowStart);
    // Only fixed categories leave this diagnostic boundary. The original
    // Playwright message can contain device or URL paths and must not leak.
    const category = /Timeout/.test(String(err?.name ?? '')) ? 'timeout' : 'attach-failed';
    throw new Error(`Android WebView attach ${category} after ${timeout}ms; safe device evidence: ${JSON.stringify(evidence)}`, { cause: err });
  }
}
async function pid() { return MODE === 'dryrun' ? 'dryrun' : (await sh(`pidof ${PKG}`)) || null; }


/**
 * Read only a bounded/allowlisted font-provider summary at distinct stages.
 * This is evidence, not a retry. Never put raw dumpsys lines or app PIDs
 * in logs or CI artifacts. Failure to obtain a probe remains explicit.
 */
async function fontProviderStage(stage) {
  if (MODE !== 'android') return null;
  let record;
  try {
    const currentPid = await pid();
    const raw = await androidFailureShell('dumpsys activity processes ' + PKG);
    record = { stage, available: true, ...inspectBridgeEmojiFontProvider(raw, currentPid) };
    // Debug-only native state. Never emit or persist raw logcat. The first
    // attempt uses Android's own PID filter; if it yields no markers, use a
    // TAG-filtered fallback and verify the exact app PID in our parser.
    // Either method remains a diagnostic only; FD01 is never waived.
    let nativeEmoji = parseNativeEmojiStartupProbe('');
    let nativeCapture = 'unavailable';
    try {
      const nativeLog = await androidFailureShell(
        "logcat -d --pid " + currentPid + " -s BridgeEmojiStartupProbe:I '*:S'");
      nativeEmoji = parseNativeEmojiStartupProbe(nativeLog, currentPid);
      if (nativeEmoji.available) nativeCapture = 'pid-filtered';
    } catch {
      // Missing diagnostics must remain unknown, not false.
    }
    if (!nativeEmoji.available) {
      try {
        const taggedLog = await androidFailureShell(
          "logcat -d -b main -v brief -s BridgeEmojiStartupProbe:I '*:S'");
        nativeEmoji = parseNativeEmojiStartupProbe(taggedLog, currentPid);
        if (nativeEmoji.available) nativeCapture = 'tag-filtered-pid-verified';
      } catch {
        // Missing diagnostics must remain unknown, not false.
      }
    }
    record.nativeEmoji = nativeEmoji;
    record.nativeCapture = nativeCapture;
    // Production WebViewFontProviderRelease passes logged by THIS process by
    // the time of this read, which is AFTER the provider sample (so an upper
    // bound for "before the sample"). Read after on purpose: nothing may be
    // added between pid() and the sample that strict FD01 asserts on.
    let releaseLog = '';
    try {
      releaseLog = await androidFailureShell(
        "logcat -d -v brief --pid " + currentPid + " -s BridgeFontRefRelease:I '*:S'");
    } catch { /* unavailable stays available=false */ }
    record.fontRefRelease = parseFontRefReleaseMarkers(releaseLog, currentPid);
    // ART's own pause and wall time for each explicit GC in this process: ties
    // the heartbeat gaps above to GC pauses, or rules GC pauses out.
    let gcLog = '';
    try {
      gcLog = await androidFailureShell(
        "logcat -d -v brief --pid " + currentPid + " -e 'Explicit .*GC freed'");
    } catch { /* unavailable stays available=false */ }
    record.explicitGc = parseArtExplicitGcLog(gcLog, currentPid);
  } catch {
    record = { stage, available: false, appPidValid: false, providerSections: 0 };
  }
  (facts.fontProviderStages ??= []).push(record);
  log('Android font-provider dependency', JSON.stringify(record));
  return record;
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
  const outputs = await collectKernelPressure(androidFailureShell);
  const item = { label, ...outputs };
  (facts.androidPressureEvidence ??= []).push(item);
  log('Android OS PSI', JSON.stringify(item));
  return item;
}


const platform = {
  async coldLaunch(extra = '', { shell = sh } = {}) {
    if (MODE === 'dryrun') { await page.goto(API); return { totalTimeMs: null }; }
    await shell(`am force-stop ${PKG}`);
    const out = await shell(`am start -W -n ${ACTIVITY} ${extra}`);
    return summarizeAndroidColdLaunch(out);
  },
  async home(shell = sh) { if (MODE === 'dryrun') return; await shell('input keyevent KEYCODE_HOME'); },
  async foreground(shell = sh) {
    if (MODE === 'dryrun') return { totalTimeMs: null };
    const out = await shell(`am start -W -n ${ACTIVITY}`);
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
  async deepLink(url, { cold = false, shell = sh } = {}) {
    if (MODE === 'dryrun') throw new Skip('deep links need the native shell');
    if (cold) {
      // After force-stop Android marks the package stopped. Starting only by
      // package name has proved flaky on API 34 CI: ActivityManager reports
      // completion but no debuggable WebView appears, so every later journey
      // inherits a closed Playwright page. An explicit component still delivers
      // the VIEW intent data, while guaranteeing MainActivity is actually
      // created for the cold-start contract we are measuring.
      await shell(`am force-stop ${PKG}`);
      await sleep(500);
      return shell(`am start -W -a android.intent.action.VIEW -d '${url}' -n ${ACTIVITY}`);
    }
    return shell(`am start -W -a android.intent.action.VIEW -d '${url}' ${PKG}`);
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
/**
 * PD01: fold the current `dumpsys activity exit-info` into the product exit
 * ledger. Returns whether the history was readable. Never throws, never logs
 * raw rows, and never changes any check's outcome by itself.
 */
async function productExitCheckpoint(label) {
  if (MODE !== 'android') return false;
  try {
    const raw = await androidFailureShell(`dumpsys activity exit-info ${PKG}`);
    // Every process's rows: they share and evict the package's one history.
    const exits = parseApplicationExits(raw, 32);
    productExitLedger = mergeProductExitCheckpoint(productExitLedger, exits, journeyStartedAt, PKG);
    log('Android product exit checkpoint', label, JSON.stringify(summarizeProductExitLedger(productExitLedger)));
    return true;
  } catch {
    productExitUnreadable += 1;
    return false;
  }
}

/**
 * Device wall clock paired with the host instant it was read at:
 * { epochMs, hostMs, precision }. Milliseconds when toybox date supports %N,
 * else whole seconds (offsets are then good to about 1 s). Null if unreadable.
 */
async function deviceClockOrigin() {
  if (MODE !== 'android') return null;
  const hostBefore = Date.now();
  const precise = parseDeviceEpoch(await sh('date +%s.%N').catch(() => ''));
  const hostAfter = Date.now();
  if (precise?.precision === 'ms') return { ...precise, hostMs: Math.round((hostBefore + hostAfter) / 2) };
  const hostMs = Date.now();
  const coarse = parseDeviceEpoch(await sh('date +%s').catch(() => ''));
  return coarse ? { ...coarse, hostMs } : null;
}

const ANR_EVENT_LOG = 'logcat -b events -d -v epoch -s am_anr:I am_kill:I am_proc_died:I am_proc_start:I';

/**
 * ANR03: keep this package's ANR/kill/death/start event-log lines, read at
 * checkpoints so a rotating buffer cannot drop early ones before the end.
 * Memory only; never throws, never changes a check's outcome.
 */
async function collectAnrEvents() {
  if (MODE !== 'android') return false;
  try {
    for (const line of (await androidFailureShell(ANR_EVENT_LOG)).split(/\r?\n/)) {
      if (line.includes(PKG)) anrEventLines.add(line);
    }
    anrEventReads++;
    return true;
  } catch {
    anrEventReadFailures++;
    return false;
  }
}

/** ANR03: is an ANR dialog for the Bridge process on screen? Booleans only. */
async function anrDialogSample(label) {
  if (MODE !== 'android') return null;
  let sample;
  try {
    sample = { label, ...inspectAnrDialogWindows(await androidFailureShell('dumpsys window windows'), PKG) };
  } catch {
    sample = { label, available: false, anrDialogs: 0, focusedOnAnrDialog: null };
  }
  anrDialogSamples.push(sample);
  return sample;
}

/** Connect the Android device (or the dryrun desktop page) and record safe device facts. */
async function connectDevice() {
  if (MODE === 'android') {
    const list = await android.devices();
    assert(list.length > 0, 'no adb device');
    // ANDROID_SERIAL picks one device when several are attached (e.g. a USB phone).
    device = list.find((d) => d.serial() === process.env.ANDROID_SERIAL) ?? list[0];
    const qemu = (await sh('getprop ro.kernel.qemu')) || (await sh('getprop ro.boot.qemu'));
    const webviewUpdate = await sh('dumpsys webviewupdate');
    facts.device = {
      // Use the serial to select the device, NEVER serialize it to CI artifacts.
      serial: 'redacted',
      serialExplicitlySelected: Boolean(process.env.ANDROID_SERIAL),
      model: await sh('getprop ro.product.model'),
      release: await sh('getprop ro.build.version.release'),
      sdk: await sh('getprop ro.build.version.sdk'),
      abi: await sh('getprop ro.product.cpu.abi'),
      qemu,
      webview: summarizeAndroidWebViewProvider(webviewUpdate),
      // Only a safe count/boolean is emitted; never retain raw candidates.
      webviewAlternatives: summarizeAndroidWebViewAlternatives(webviewUpdate),
    };
    facts.apkInstalled = (await sh(`pm list packages ${PKG}`)).includes(PKG);
    journeyStartedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
    const deviceSeconds = Number(await sh('date +%s'));
    journeyStartedEpochMs = Number.isSafeInteger(deviceSeconds) && deviceSeconds > 0
      ? deviceSeconds * 1000 : null;
    anrOrigin = await deviceClockOrigin();
    log('device', JSON.stringify(facts.device));
  } else {
    const browser = await chromium.launch();
    const ctx = await browser.newContext({ ...devices['Pixel 7'] });
    page = await ctx.newPage();
    facts.device = { note: 'DRYRUN — desktop Chromium phone viewport, NOT evidence' };
  }
}

/**
 * #209 upstream WebView reproduction controls (DIAGNOSTIC, NON-GATING suite).
 * Unmitigated debug Activities without Bridge code: they reproduce the
 * unfixed-WebView FontsProvider stable-ref leak (WebView 113 on this image;
 * fixed upstream in 117.0.5938.29 / 118.0.5971.0), and a GMS restart
 * during their window kills them with DEPENDENCY DIED by design. Run only
 * when ANDROID_JOURNEY_SUITE=upstream-webview-controls.
 */
async function runUpstreamWebViewControls() {
  // Android #209 controlled differential: observe the *same installed APK*
  // running a native-only Activity before Capacitor/BridgeActivity/WebView.
  // This DEBUG-only baseline is measured, not a PASS and not an FD01 bypass.
  // A connected provider here points to startup/platform/native components;
  // absence here followed by FD01 connection narrows it to the product
  // activity/WebView initialization path. Neither outcome identifies a caller.
  await measure('FD00', 'native-only Activity FontsProvider baseline before WebView', async () => {
    if (MODE !== 'android') throw new Skip('native Android Activity required');
    await sh(`am force-stop ${PKG}`);
    try {
      const start = await sh(`am start -W -n ${PKG}/com.bridge.app.FontBaselineActivity`);
      assert(/Status: ok/.test(start), 'debug native baseline Activity failed to launch');
      await sleep(1200);
      const baselinePid = await pid();
      const raw = await androidFailureShell(`dumpsys activity processes ${PKG}`);
      const evidence = inspectBridgeEmojiFontProvider(raw, baselinePid);
      assert(evidence.appPidValid,
        'native-only baseline app PID unavailable');
      // A native-only process may legitimately have NO Connected Providers
      // section. That is an explicitly INCONCLUSIVE absence, not a proven
      // zero-dependency result; FD01 still enforces the original strict gate.
      const providerListingVerified = evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      const result = { stage: 'native-only-before-webview',
        providerListingVerified, ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      return result;
    } finally {
      // Reset native-only process: the next A01 must be an independent cold
      // product launch with original checks, permissions and thresholds.
      await sh(`am force-stop ${PKG}`).catch(() => {});
    }
  });

  // FD00P: isolate AndroidX AppCompat without WebView or Bridge JS.
  // Same installed debug APK, separately force-stopped for each baseline.
  // This is MEASURED only, NEVER a FD01 waiver or ANR/L01 pass substitute.
  await measure('FD00P', 'AppCompat-only Activity FontsProvider baseline', async () => {
    if (MODE !== 'android') throw new Skip('Android AppCompat Activity required');
    await sh('am force-stop ' + PKG);
    try {
      const start = await sh('am start -W -n ' + PKG + '/com.bridge.app.AppCompatBaselineActivity');
      assert(/Status: ok/.test(start), 'debug AppCompat-only baseline Activity failed to launch');
      await sleep(2000);
      const baselinePid = await pid();
      const raw = await androidFailureShell('dumpsys activity processes ' + PKG);
      const evidence = inspectBridgeEmojiFontProvider(raw, baselinePid);
      assert(evidence.appPidValid, 'AppCompat-only baseline app PID unavailable');
      // Missing provider listing is UNKNOWN, not a valid zero-dependency proof.
      const providerListingVerified = evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      const result = { stage: 'appcompat-only-before-webview',
        providerListingVerified, ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      return result;
    } finally {
      // Preserve a genuinely cold next baseline and final product A01.
      await sh('am force-stop ' + PKG).catch(() => {});
    }
  });

  // Isolate the WebView CONSTRUCTOR from page navigation. This debug-only
  // Activity does not call setContentView or loadUrl and does not use
  // Capacitor/plugins. Force-stop both before and after so the comparison
  // with FD00W is independent and can't contaminate A01.
  await measure('FD00C', 'constructed but never attached or navigated WebView baseline', async () => {
    if (MODE !== 'android') throw new Skip('native Android WebView required');
    await sh(`am force-stop ${PKG}`);
    try {
      const start = await sh(`am start -W -n ${PKG}/com.bridge.app.WebViewConstructorBaselineActivity`);
      assert(/Status: ok/.test(start), 'debug constructor-only WebView Activity failed to launch');
      await sleep(2000);
      const baselinePid = await pid();
      const raw = await androidFailureShell(`dumpsys activity processes ${PKG}`);
      const evidence = inspectBridgeEmojiFontProvider(raw, baselinePid);
      assert(evidence.appPidValid, 'constructor-only baseline app PID unavailable');
      const providerListingVerified = evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      const result = { stage: 'webview-constructed-not-attached-or-navigated',
        providerListingVerified, ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      return result;
    } finally {
      await sh(`am force-stop ${PKG}`).catch(() => {});
    }
  });

  // Third independently cold-started DEBUG control: attach an inert WebView
  // to the Activity, but do NOT navigate. FD00C tested construction alone;
  // FD00W will separately test about:blank navigation. All three are
  // measurements, not FD01 waivers or PASS substitutes.
  await measure('FD00A', 'attached WebView without navigation FontsProvider baseline', async () => {
    if (MODE !== 'android') throw new Skip('native Android WebView required');
    await sh(`am force-stop ${PKG}`);
    try {
      const start = await sh(`am start -W -n ${PKG}/com.bridge.app.WebViewAttachedBaselineActivity`);
      assert(/Status: ok/.test(start), 'debug attached-no-navigation WebView Activity failed to launch');
      await sleep(2000);
      const baselinePid = await pid();
      const raw = await androidFailureShell(`dumpsys activity processes ${PKG}`);
      const evidence = inspectBridgeEmojiFontProvider(raw, baselinePid);
      assert(evidence.appPidValid, 'attached no-navigation app PID unavailable');
      const providerListingVerified = evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      const result = { stage: 'webview-attached-without-navigation',
        providerListingVerified, ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      return result;
    } finally {
      await sh(`am force-stop ${PKG}`).catch(() => {});
    }
  });

  // Fourth independent DEBUG control: begin a WebView navigation without
  // attaching it to the window. FD00A checked attachment without navigation;
  // FD00W checks both. This isolates whether page load alone acquires GMS
  // FontsProvider. Failure to measure is FAIL, never a silent success.
  await measure('FD00N', 'unattached WebView loading about:blank FontsProvider baseline', async () => {
    if (MODE !== 'android') throw new Skip('native Android WebView required');
    await sh(`am force-stop ${PKG}`);
    try {
      const start = await sh(`am start -W -n ${PKG}/com.bridge.app.WebViewUnattachedNavigationBaselineActivity`);
      assert(/Status: ok/.test(start), 'debug unattached-navigation WebView Activity failed to launch');
      await sleep(2000);
      const baselinePid = await pid();
      const raw = await androidFailureShell(`dumpsys activity processes ${PKG}`);
      const evidence = inspectBridgeEmojiFontProvider(raw, baselinePid);
      assert(evidence.appPidValid, 'unattached-navigation baseline app PID unavailable');
      const providerListingVerified = evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      const result = { stage: 'webview-unattached-about-blank-navigation', providerListingVerified,
        ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      return result;
    } finally {
      await sh(`am force-stop ${PKG}`).catch(() => {});
    }
  });

  // FD00D: same WebView navigation family as FD00W, but load an inline
  // empty HTML document via loadDataWithBaseURL instead of loadUrl(about:blank).
  // JavaScript disabled, no network, Bridge assets or Capacitor plugins.
  // A provider here implicates generic document navigation, not remote fonts.
  // It remains only a measurement and never excuses strict FD01/ANR01/L01.
  await measure('FD00D', 'local inline HTML WebView navigation FontsProvider baseline', async () => {
    if (MODE !== 'android') throw new Skip('native Android WebView required');
    await sh('am force-stop ' + PKG);
    try {
      const start = await sh('am start -W -n ' + PKG + '/com.bridge.app.WebViewDataBaselineActivity');
      assert(/Status: ok/.test(start), 'debug inline HTML WebView baseline Activity failed to launch');
      await sleep(2000);
      const baselinePid = await pid();
      const raw = await androidFailureShell('dumpsys activity processes ' + PKG);
      const evidence = inspectBridgeEmojiFontProvider(raw, baselinePid);
      assert(evidence.appPidValid, 'inline HTML WebView baseline app PID unavailable');
      const providerListingVerified = evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      // Lack of a complete listing is UNKNOWN, never positive evidence of absence.
      const result = { stage: 'webview-local-inline-html-navigation',
        providerListingVerified, ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      return result;
    } finally {
      // Keep subsequent FD00W and product A01 isolated by fresh cold launch.
      await sh('am force-stop ' + PKG).catch(() => {});
    }
  });

  // FD00S: a separate DATA-SCHEME navigation experiment. Unlike FD00D's
  // loadDataWithBaseURL(null, ...) (which defaults to about:blank), loadData
  // explicitly creates a data: URL. All inputs are local; JavaScript disabled.
  // Fresh PID/force-stop isolate it from FD00D and the real product launch.
  // This is MEASURED, never a waiver or PASS for strict FD01/ANR01.
  await measure('FD00S', 'data-scheme inline HTML WebView FontsProvider control', async () => {
    if (MODE !== 'android') throw new Skip('native Android WebView required');
    await sh('am force-stop ' + PKG);
    try {
      const start = await sh('am start -W -n ' + PKG +
        '/com.bridge.app.WebViewDataSchemeBaselineActivity');
      assert(/Status: ok/.test(start), 'debug data-scheme baseline Activity failed to launch');
      await sleep(2000);
      const controlPid = await pid();
      const raw = await androidFailureShell('dumpsys activity processes ' + PKG);
      const evidence = inspectBridgeEmojiFontProvider(raw, controlPid);
      const complete = evidence.appPidValid && evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      assert(complete, 'data-scheme baseline provider evidence incomplete; do not infer absence');
      const result = { stage: 'webview-data-scheme-inline-html-navigation',
        providerListingVerified: true, ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      return result;
    } finally {
      await sh('am force-stop ' + PKG).catch(() => {});
    }
  });

  // FD00T: provider lifetime AFTER destroying a navigated WebView in the
  // SAME foreground Android process. The teardown marker is exact-PID
  // filtered, so elapsed time is never mistaken for proof of destruction.
  // Measurement only: it cannot grant FD01/L01/ANR01 a PASS.
  await measure('FD00T', 'same-process WebView destruction and provider retention', async () => {
    if (MODE !== 'android') throw new Skip('native WebView Activity required');
    await sh('am force-stop ' + PKG);
    try {
      const started = await sh('am start -W -n ' + PKG +
        '/com.bridge.app.WebViewTeardownBaselineActivity');
      assert(/Status: ok/.test(started), 'debug teardown baseline Activity failed to launch');
      await sleep(1600);
      const initialPid = await pid();
      assert(/^[0-9]{1,8}$/.test(String(initialPid)),
        'FD00T initial app process unavailable');
      const snapshot = async stage => {
        const currentPid = await pid();
        assert(currentPid === initialPid,
          'FD00T Activity process changed before ' + stage + ' observation');
        // A process can survive while Android has torn down its Activity.
        // Require the same diagnostic control to remain foreground/resumed;
        // otherwise onDestroy() could counterfeit successful WebView release.
        const resumed = await androidFailureShell(
          'dumpsys activity activities | grep -m1 topResumedActivity || true');
        assert(resumed.includes(PKG + '/com.bridge.app.WebViewTeardownBaselineActivity'),
          'FD00T Activity no longer resumed at ' + stage);
        const raw = await androidFailureShell('dumpsys activity processes ' + PKG);
        const evidence = inspectBridgeEmojiFontProvider(raw, currentPid);
        assert(evidence.appPidValid && evidence.providerSections > 0 &&
          evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown,
          'FD00T provider listing not verified at ' + stage);
        return { stage, connected: evidence.fontProviderConnected,
          stableRefs: evidence.fontProviderStableRefs,
          unstableRefs: evidence.fontProviderUnstableRefs,
          waiting: evidence.fontProviderWaiting, dead: evidence.fontProviderDead };
      };
      const before = await snapshot('webview-navigated');
      // The Activity destroys its WebView after 3.5s; the later sample
      // takes place > 7s after launch with no simulated provider death.
      await sleep(5600);
      const after = await snapshot('webview-destroyed');
      let teardownObserved = false;
      try {
        const marker = await androidFailureShell('logcat -d --pid ' + initialPid +
          " -s BridgeWebViewTeardown:I '*:S'");
        // Logcat is explicitly filtered to the SAME PID observed above.
        // Never export or persist the raw log, PIDs or unrelated Android data.
        teardownObserved = /BridgeWebViewTeardown.*stage=destroyed/.test(marker);
      } catch { /* missing marker remains failure, not a PASS */ }
      assert(teardownObserved, 'FD00T same-process WebView destroy marker unavailable');
      const result = { sameProcess: true, webviewDestroyed: true, before, after };
      facts.androidWebViewTeardownEvidence = result;
      return result;
    } finally {
      await sh('am force-stop ' + PKG).catch(() => {});
    }
  });

  // FD00G: causal intervention on the SAME PID. FD00W shows the stable ref
  // persisting >= 8 s in an idle plain WebView and FD00T shows it outliving
  // WebView.destroy(). Here the WebView stays ALIVE, attached and referenced
  // while the Activity runs the production finalization pass. A stable ref
  // that disappears was held by unreachable, finalizable garbage (Chromium
  // 113's detachFd() of the ContentResolver wrapper), not by the
  // live WebView; one that survives refutes that mechanism.
  // Measurement only: it cannot grant FD01/CS00/L01/ANR01 a PASS.
  const measureFd00g = id => measure(id, 'same-process finalization with the WebView alive and provider retention', async () => {
    if (MODE !== 'android') throw new Skip('native WebView Activity required');
    const activity = 'com.bridge.app.WebViewFinalizationBaselineActivity';
    await sh('am force-stop ' + PKG);
    const controlStartedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
    try {
      const started = await sh('am start -W -n ' + PKG + '/' + activity);
      assert(/Status: ok/.test(started), 'debug finalization baseline Activity failed to launch');
      await sleep(2000);
      const initialPid = await pid();
      assert(/^[0-9]{1,8}$/.test(String(initialPid)),
        'FD00G initial app process unavailable');
      const snapshot = async stage => {
        const currentPid = await pid();
        if (currentPid !== initialPid) {
          // Same rule as FD00W: a vanished control is a FAIL with safe,
          // device-clock-bounded exit enums, never a PID substitution.
          const controlEndedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
          let processLoss = { available: false };
          try {
            const exits = await androidFailureExits();
            if (exits.available) {
              processLoss = { available: true, ...summarizeFreshControlProcessExit(
                exits.exits, initialPid, PKG, controlStartedAt, controlEndedAt),
              dependencyEvidence: classifyFreshAndroidDependencyDeath(
                exits.exits, initialPid, PKG, controlStartedAt, controlEndedAt) };
            }
          } catch { /* unknown stays unknown */ }
          throw new Error('FD00G Activity process changed before ' + stage +
            ' observation; timestamp-bounded exit evidence: ' + JSON.stringify(processLoss));
        }
        const resumed = await androidFailureShell(
          'dumpsys activity activities | grep -m1 topResumedActivity || true');
        assert(resumed.includes(PKG + '/' + activity),
          'FD00G Activity no longer resumed at ' + stage);
        const raw = await androidFailureShell('dumpsys activity processes ' + PKG);
        const evidence = inspectBridgeEmojiFontProvider(raw, currentPid);
        assert(evidence.appPidValid && evidence.providerSections > 0 &&
          evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown,
          'FD00G provider listing not verified at ' + stage);
        return { stage, connected: evidence.fontProviderConnected,
          stableRefs: evidence.fontProviderStableRefs,
          unstableRefs: evidence.fontProviderUnstableRefs,
          waiting: evidence.fontProviderWaiting, dead: evidence.fontProviderDead };
      };
      // Non-throwing variant of snapshot()'s identity checks, for the
      // failure path: fixed booleans and exit enums only.
      const controlLiveness = async () => {
        const currentPid = await pid().catch(() => null);
        const alive = currentPid === initialPid;
        let resumed = null;
        let processLoss = null;
        if (alive) {
          resumed = (await androidFailureShell(
            'dumpsys activity activities | grep -m1 topResumedActivity || true').catch(() => ''))
            .includes(PKG + '/' + activity);
        } else {
          const controlEndedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
          processLoss = { available: false };
          try {
            const exits = await androidFailureExits();
            if (exits.available) {
              processLoss = { available: true, ...summarizeFreshControlProcessExit(
                exits.exits, initialPid, PKG, controlStartedAt, controlEndedAt),
              dependencyEvidence: classifyFreshAndroidDependencyDeath(
                exits.exits, initialPid, PKG, controlStartedAt, controlEndedAt) };
            }
          } catch { /* unknown stays unknown */ }
        }
        return { alive, resumed, processLoss };
      };
      const readMarkers = async () => parseFinalizationProbeMarkers(await androidFailureShell(
        'logcat -d -v brief --pid ' + initialPid + " -s BridgeFinalizeProbe:I '*:S'"), initialPid);
      const before = await snapshot('webview-alive-before-finalization');
      // Partial evidence survives a failure below (FD02 rule): fixed enums only.
      const evidence = { sameProcess: true, before, baselineBeforePass: null,
        markers: null, pollAttempts: 0, after: null };
      (facts.androidWebViewFinalizationEvidence ??= {})[id] = evidence;
      // A "before" sample read after the pass started is not a baseline.
      // An empty read proves nothing ("scheduled" is logged in onCreate).
      try {
        const early = await readMarkers();
        evidence.baselineBeforePass = early.scheduled ? !early.started : null;
      } catch { /* stays null */ }
      // The Activity starts the pass ~6 s after onCreate. Poll its fixed
      // markers from the SAME PID only; raw logcat never leaves memory.
      const deadline = Date.now() + 15_000;
      do {
        if (evidence.pollAttempts++) await sleep(500);
        try {
          // Never let an empty or failed later read erase markers already seen.
          const parsed = await readMarkers();
          if (parsed.scheduled || !evidence.markers) evidence.markers = parsed;
        } catch { /* keep polling until the deadline */ }
      } while (!evidence.markers?.finalized && Date.now() < deadline);
      if (!evidence.markers?.finalized) {
        // The verdict is already FAIL. Failure-only evidence: ART's
        // FinalizerWatchdog fires 10-20 s after a finalizer sticks and kills
        // 5 s after SIGQUIT, i.e. up to ~25 s after the pass starts, which is
        // past the verdict window. Keep observing for up to 15 s more (until
        // the process dies or reports an uncaught exception), then tell a dead
        // control from a pass still blocked in a live process. Never a PASS.
        const evidenceDeadline = Date.now() + 15_000;
        while (!evidence.markers?.uncaught && Date.now() < evidenceDeadline) {
          await sleep(1000);
          try {
            const parsed = await readMarkers();
            if (parsed.scheduled) evidence.markers = parsed;
          } catch { /* keep the markers already seen */ }
          if ((await pid().catch(() => null)) !== initialPid) break;
        }
        evidence.liveness = await controlLiveness();
        // A marker logged just before a kill is still in logd: read once more.
        try {
          const parsed = await readMarkers();
          if (parsed.scheduled) evidence.markers = parsed;
        } catch { /* keep the markers already seen */ }
        evidence.sameProcess = evidence.liveness.alive;
        throw new Error('FD00G finalization pass not observed; safe evidence: ' + JSON.stringify(evidence));
      }
      // ActivityThread turns the last released stable ref into ONE unstable
      // ref for CONTENT_PROVIDER_RETAIN_TIME (1000 ms) before removing it.
      await sleep(2500);
      evidence.after = await snapshot('webview-alive-after-finalization');
      return evidence;
    } finally {
      await sh('am force-stop ' + PKG).catch(() => {});
    }
  });

  // Three repetitions sample how often the pass stalls: two uninstrumented
  // "started but not finalized" runs out of three earlier ones (issue #209).
  for (const id of ['FD00G', 'FD00G-2', 'FD00G-3']) await measureFd00g(id);

  // Second, independently cold-started DEBUG-only control. This one has a
  // bare Android WebView displaying about:blank with JavaScript disabled by
  // default, but NO Capacitor, plugin registry or Bridge web application.
  // It distinguishes native-only from WebView framework initialization.
  await measure('FD00W', 'plain WebView-only FontsProvider baseline', async () => {
    if (MODE !== 'android') throw new Skip('native Android WebView required');
    await sh(`am force-stop ${PKG}`);
    // Android-local time bounds the exit observation, preventing PID-reuse attribution.
    const controlStartedAt = await sh('date +%Y-%m-%dT%H:%M:%S');
    try {
      const start = await sh(`am start -W -n ${PKG}/com.bridge.app.WebViewBaselineActivity`);
      assert(/Status: ok/.test(start), 'debug plain-WebView baseline failed to launch');
      await sleep(2000);
      const baselinePid = await pid();
      const raw = await androidFailureShell(`dumpsys activity processes ${PKG}`);
      const evidence = inspectBridgeEmojiFontProvider(raw, baselinePid);
      assert(evidence.appPidValid, 'plain-WebView baseline app PID unavailable');
      const providerListingVerified = evidence.providerSections > 0 &&
        evidence.unparsedConnections === 0 && evidence.fontProviderRefCountsKnown;
      const result = { stage: 'plain-webview-about-blank', providerListingVerified, ...evidence };
      (facts.fontProviderStages ??= []).push(result);
      // Compare the same-PID 1.5/4/8 s reference lifecycle with FD02 on
      // Bridge's actual WebView. A pristine about:blank WebView can acquire
      // this provider without any Bridge JS, Capacitor or plugins; observe
      // whether it releases it naturally while remaining foregrounded.
      // Partial samples are retained on probe failure, never a synthetic PASS.
      const decay = { sameAppProcess: true, complete: false, samples: [] };
      facts.fontProviderPlainWebViewDecay = decay;
      const baselineStarted = Date.now();
      for (const offsetMs of [1500, 4000, 8000]) {
        await sleep(Math.max(0, offsetMs - (Date.now() - baselineStarted)));
        const currentPid = await pid();
        const samePid = currentPid === baselinePid;
        if (!samePid) decay.sameAppProcess = false;
        const sample = {
          sampleAtMs: offsetMs,
          samePid,
          available: false,
          connected: null,
          stableRefs: null,
          unstableRefs: null,
          waiting: null,
          dead: null,
        };
        decay.samples.push(sample);
        // No PID substitution: a new app process cannot prove the ORIGINAL
        // provider connection was released. Treat a vanished foreground control
        // as a real FAIL; attach safe, timestamp-bounded Android exit evidence.
        if (!samePid) {
          const controlEndedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
          let processLoss = { available: false, windowValid: false,
            matchingExit: false, reasonCode: null, subreasonCode: null };
          try {
            const exits = await androidFailureExits();
            if (exits.available) {
              processLoss = { available: true, ...summarizeFreshControlProcessExit(
                exits.exits, baselinePid, PKG, controlStartedAt, controlEndedAt),
              dependencyEvidence: classifyFreshAndroidDependencyDeath(
                exits.exits, baselinePid, PKG, controlStartedAt, controlEndedAt) };
            }
          } catch { /* Unknown is honest; never emit raw Android diagnostic data. */ }
          decay.processLoss = processLoss;
          throw new Error('FD00W original foreground process disappeared; ' +
            'timestamp-bounded exit evidence: ' + JSON.stringify(processLoss));
        }
        try {
          const snapshot = await androidFailureShell(`dumpsys activity processes ${PKG}`);
          const info = inspectBridgeEmojiFontProvider(snapshot, currentPid);
          const valid = info.appPidValid && info.providerSections > 0 &&
            info.unparsedConnections === 0 && info.fontProviderRefCountsKnown;
          if (!valid) break;
          Object.assign(sample, {
            available: true,
            connected: info.fontProviderConnected,
            stableRefs: info.fontProviderStableRefs,
            unstableRefs: info.fontProviderUnstableRefs,
            waiting: info.fontProviderWaiting,
            dead: info.fontProviderDead,
          });
        } catch {
          // Report unknown; raw Android or ADB exception text stays private.
          break;
        }
      }
      decay.complete = decay.sameAppProcess && decay.samples.length === 3 &&
        decay.samples.every(sample => sample.available);
      return { ...result, samePidProviderDecay: decay };
    } finally {
      // Isolate the following real A01 cold launch from this diagnostic.
      await sh(`am force-stop ${PKG}`).catch(() => {});
    }
  });

  // #209 differential: alternate three native-only and three plain-WebView
  // cold starts BEFORE authenticated Bridge journeys. No JS or Capacitor.
  // This is a MEASUREMENT: a failed control remains FAIL, not a CS01 bypass.
  await measure('CS00', 'native-only versus plain-WebView cold-start ANR controls', async () => {
    if (MODE !== 'android') throw new Skip('Android ActivityManager required');
    const controls = [
      { kind: 'native-only', activity: 'FontBaselineActivity' },
      { kind: 'blank-webview', activity: 'WebViewBaselineActivity' },
    ];
    const anrCount = async () => {
      // Restrict to an exact package ANR marker. Never export logcat lines.
      const raw = await androidFailureShell(
        "logcat -d -v brief -s ActivityManager:E | grep -F 'ANR in com.bridge.app.debug' || true");
      const matches = raw.split('\n').filter(line =>
        line.includes('ANR in com.bridge.app.debug')).length;
      assert(matches < 100, 'CS00 ANR log count saturated');
      return matches;
    };
    const samples = [];
    let previousAnrs = await anrCount();
    facts.androidControlColdStarts = { complete: false, samples };
    try {
      for (let attempt = 1; attempt <= 3; attempt++) {
        for (const control of controls) {
          await sh('am force-stop ' + PKG);
          // Device-clock bounds distinguish this launch from older exits after
          // Android PID reuse. No CI host timestamps or raw logcat are exported.
          const controlStartedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
          const started = await sh('am start -W -n ' + PKG +
            '/com.bridge.app.' + control.activity);
          assert(/Status: ok/.test(started), 'CS00 baseline Activity failed to start');
          const firstPid = await pid();
          assert(/^[0-9]{1,8}$/.test(String(firstPid)),
            'CS00 baseline app PID unavailable');
          const resume = await androidFailureShell(
            'dumpsys activity activities | grep -m1 topResumedActivity || true');
          const expectedActivity = PKG + '/com.bridge.app.' + control.activity;
          const activityResumed = resume.includes(expectedActivity);
          await sleep(2000);
          const finalPid = await pid();
          const count = await anrCount();
          const record = {
            attempt, kind: control.kind, activityResumed,
            pidStable: firstPid === finalPid,
            pidPresentAfterObservation: /^[0-9]{1,8}$/.test(String(finalPid)),
            newlyRecordedAnrs: count - previousAnrs,
          };
          samples.push(record);
          if (!record.pidStable) {
            // Failure-only: query a *bounded* OS exit-info snapshot for the
            // original PID, but publish ONLY numeric reason codes and booleans.
            // Never disclose the PID, process names, timestamps or raw logs.
            // Absence of an exit record is UNKNOWN, not proof of no crash.
            const controlEndedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
            let exitEvidence = { windowValid: false, matchingExit: false,
              reasonCode: null, subreasonCode: null };
            let dependencyEvidence = classifyFreshAndroidDependencyDeath(
              null, firstPid, PKG, controlStartedAt, controlEndedAt);
            try {
              const info = await androidFailureExits();
              if (info.available) {
                exitEvidence = summarizeFreshControlProcessExit(
                  info.exits, firstPid, PKG, controlStartedAt, controlEndedAt);
                dependencyEvidence = classifyFreshAndroidDependencyDeath(
                  info.exits, firstPid, PKG, controlStartedAt, controlEndedAt);
              }
            } catch { /* diagnostic failure never makes the check PASS */ }
            record.exitEvidence = exitEvidence;
            record.dependencyEvidence = dependencyEvidence;
            log('CS00 safe process-loss evidence', JSON.stringify(record));
          }
          assert(activityResumed,
            'CS00 ' + control.kind + ' attempt ' + attempt + ': Activity was not foreground');
          assert(record.pidStable,
            'CS00 ' + control.kind + ' attempt ' + attempt + ': baseline Activity PID changed or vanished');
          assert(count >= previousAnrs, 'CS00 ANR log count decreased; result inconclusive');
          assert(count === previousAnrs,
            'CS00 Android OS reported an ANR during a baseline Activity');
          previousAnrs = count;
        }
      }
      facts.androidControlColdStarts.complete = true;
      return { complete: true, samples };
    } finally {
      // The product launch A01 must start in a fresh Android app process.
      await sh('am force-stop ' + PKG).catch(() => {});
    }
  });

  // AN00 (#209): ANR mechanics on THIS image, deterministically. A debug
  // Activity blocks its own main thread right after its first traversal, as a
  // cold start's first frame would; a key event sent during the stall cannot
  // be consumed either. Recorded: whether and when Android declares an ANR,
  // whether its dialog is still up after the app recovered, and what the same
  // HOME press L01 uses then does to the process (AOSP: the dialog's
  // ACTION_CLOSE_SYSTEM_DIALOGS handler kills the app, "user request after
  // error", exit reason 6). Tests the L01 reading of #209's reason-6 exits.
  // AN00 lets the app recover while the ANR is being reported; AN00-L keeps it
  // blocked well past the dialog. Measurement only.
  const measureAn00 = (id, stallMs) => measure(id, `main thread blocked ${stallMs / 1000} s after the first frame: ANR declaration, dialog lifetime, effect of HOME`, async () => {
    if (MODE !== 'android') throw new Skip('native Activity required');
    const activity = 'com.bridge.app.MainThreadStallControlActivity';
    await sh('am force-stop ' + PKG);
    const origin = await deviceClockOrigin();
    assert(origin, 'device clock unavailable; cannot place the ANR on a timeline');
    const controlStartedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
    // No -W: the stalled main thread may not report the launch complete.
    const started = await sh(`am start -n ${PKG}/${activity} --el stallMs ${stallMs}`);
    assert(!/Error/.test(started), 'stall control Activity failed to launch');
    let controlPid = null;
    let markers = parseStallControlMarkers('', null);
    const readMarkers = async () => parseStallControlMarkers(await androidFailureShell(
      'logcat -d -v brief --pid ' + controlPid + " -s BridgeStallControl:I '*:S'"), controlPid);
    for (const deadline = Date.now() + 15_000; Date.now() < deadline && !markers.began;) {
      await sleep(250);
      controlPid = await pid().catch(() => null);
      if (/^[0-9]{1,8}$/.test(String(controlPid))) markers = await readMarkers().catch(() => markers);
    }
    assert(markers.began, 'stall control process never began its stall');
    const stallBeganHostMs = Date.now();
    // Not awaited here: injection into a blocked window may wait for it.
    const injection = sh('input keyevent KEYCODE_DPAD_DOWN').catch(() => null);
    await sleep(stallMs + 4_000);
    await Promise.race([injection, sleep(5_000)]);
    markers = await readMarkers().catch(() => markers);
    const aliveBeforeHome = (await pid().catch(() => null)) === controlPid;
    const dialogBeforeHome = inspectAnrDialogWindows(
      await androidFailureShell('dumpsys window windows').catch(() => ''), PKG);
    await platform.home();
    await sleep(3_000);
    const aliveAfterHome = (await pid().catch(() => null)) === controlPid;
    const timeline = parseAnrEventTimeline(await androidFailureShell(ANR_EVENT_LOG).catch(() => ''), PKG, origin.epochMs);
    const stallBeganAtMs = stallBeganHostMs - origin.hostMs;
    // Only this control's process: the last Bridge process started in the window.
    const lastStart = [...timeline.events].reverse().find(e => e.type === 'am_proc_start');
    const anr = timeline.anrs.find(a => a.process === lastStart?.process) ?? null;
    let exit = { windowValid: false, matchingExit: false, reasonCode: null, subreasonCode: null };
    if (!aliveAfterHome) {
      const controlEndedAt = await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null);
      try {
        const exits = await androidFailureExits();
        if (exits.available) {
          exit = summarizeFreshControlProcessExit(exits.exits, controlPid, PKG, controlStartedAt, controlEndedAt);
        }
      } catch { /* unknown stays unknown */ }
    }
    await sh('am force-stop ' + PKG).catch(() => null);
    return { stallMs, originPrecision: origin.precision, stallEnded: markers.ended,
      timelineAvailable: timeline.available,
      anrDeclared: anr !== null, anrReasonClass: anr?.reasonClass ?? null,
      anrAfterStallBeganMs: anr ? anr.atMs - stallBeganAtMs : null,
      aliveBeforeHome, dialogBeforeHome, aliveAfterHome,
      killAfterAnrMs: anr?.killAfterMs ?? null, killReasonClass: anr?.killReasonClass ?? null,
      exitReasonCode: exit.reasonCode, exitSubreasonCode: exit.subreasonCode };
  });
  await measureAn00('AN00', 7_000);
  await measureAn00('AN00-L', 20_000);
}

async function main() {
  log(`mode=${MODE} suite=${SUITE} api=${API} pkg=${PKG}`);
  if (SUITE === 'upstream-webview-controls') {
    // No Bridge server, accounts or product journeys: the controls never
    // load Bridge content.
    await connectDevice();
    await runUpstreamWebViewControls();
    return;
  }
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
  // IDs and generated account names are needed in memory for the journey,
  // never in the public CI evidence artifact. Assertions below retain the
  // local bindings; `facts` contains only bounded diagnostic projections.

  if (netPath) { await netPath.start(); facts.networkPath = `adb reverse → proxy :${PROXY_PORT} → server :${netPath.targetPort}`; }
  await connectDevice();

  await check('A01', 'cold launch reaches the auth screen (no stuck splash)', async () => {
    a01InitialPid = null;
    // Android-clock bounds prevent stale ApplicationExitInfo entries from
    // masquerading as a new A01 process crash after PID reuse.
    a01LaunchStartedAt = MODE === 'android'
      ? await sh('date +%Y-%m-%dT%H:%M:%S').catch(() => null) : null;
    const launch = await platform.coldLaunch();
    // Launch status and PID existence are evidence, not proof of survival.
    // Keep the original A01 WebView and 45-second UI assertions unchanged.
    a01InitialPid = await pid().catch(() => null);
    facts.androidA01Launch = {
      ...launch, appPidPresentImmediately: /^[0-9]{1,8}$/.test(String(a01InitialPid)),
    };
    await attachPage();
    // Preserve the original 45-second failure boundary. The generic 'until'
    // helper can append untrusted Playwright error text (page URLs/paths).
    // A01 only publishes a fixed failure code; check() separately captures
    // booleans and sanitized native/CDP evidence. No restart or second try.
    try {
      await until(async () => (await authVisible()) || (await appVisible()), {
        timeout: 45_000, message: 'auth screen visible',
      });
    } catch {
      throw new Error('A01 auth/app screen was not reachable before the 45s deadline');
    }
    const splashGone = await page.evaluate(() => !document.getElementById('native-splash') || document.getElementById('native-splash').classList.contains('hidden'));
    assert(splashGone, 'native splash still covering the app');
    // Stage one: immediately after first UI render, before login or channels.
    await fontProviderStage('first-ui-before-login');
    // CI evidence is public: retain the environment contract, not URLs that
    // might carry a private host or credentials.
    return { coldLaunchTotalMs: launch.totalTimeMs,
      packagedOrigin: await page.evaluate(() => location.origin === 'https://localhost'),
      apiConfigured: await page.evaluate(() => Boolean(globalThis.BRIDGE_API)) };
  });

  // #209: repeated COLD starts on the ordinary Bridge Activity, after the
  // isolated FD00/FD00W baselines. A lone green start cannot disprove the
  // intermittent FocusEvent ANR seen in run 39017377880. This is an ASSERTING
  // check (not a measurement-only pseudo-pass), and the later ANR01 still
  // scans the entire session, even if CS01 itself fails.
  await check('CS01', 'three additional cold starts retain the app PID and report no Android ANR', async () => {
    if (MODE !== 'android') throw new Skip('actual Android ActivityManager required');
    const anrCount = async () => {
      // Raw system logs stay entirely in memory; only a bounded count is
      // retained. Never export ANR headers, reason text, PIDs or stack data.
      const raw = await androidFailureShell(
        "logcat -d -v brief -s ActivityManager:E | grep -F 'ANR in com.bridge.app.debug' || true");
      return Math.min(100, raw.split('\n').filter(line => line.includes('ANR in com.bridge.app.debug')).length);
    };
    const baselineAnrs = await anrCount();
    assert(baselineAnrs === 0, 'an OS ANR was already recorded before repeated cold starts');
    const samples = [];
    // Fixed and small on purpose; stress must not consume the entire emulator
    // CI budget or silently redefine later L01 / FD01 acceptance.
    for (let attempt = 1; attempt <= 3; attempt++) {
      const launch = await platform.coldLaunch();
      const initialPid = await pid();
      assert(/^[0-9]{1,8}$/.test(String(initialPid)),
        `cold start ${attempt}: no valid app PID after Activity launch`);
      await attachPage();
      await until(async () => (await authVisible()) || (await appVisible()), {
        timeout: 45_000,
        message: `visible UI after repeated cold start ${attempt}`,
      });
      // Catch the delayed process death that earlier cold-launch-only checks
      // missed: a 2 s OS-observation window is part of the assertion.
      await sleep(2000);
      const finalPid = await pid();
      const newAnrs = await anrCount();
      samples.push({
        attempt,
        totalTimeMs: launch.totalTimeMs,
        pidStable: finalPid === initialPid,
        anrCount: newAnrs,
      });
      facts.androidColdStartSamples = samples;
      assert(finalPid === initialPid,
        `cold start ${attempt}: Android replaced the app process after UI render`);
      assert(newAnrs === baselineAnrs,
        `cold start ${attempt}: ActivityManager reported an app ANR`);
    }
    return { attempts: samples.length, anrs: 0,
      allPidStable: samples.every(row => row.pidStable),
      maxStartMs: Math.max(...samples.map(row => row.totalTimeMs || 0)) };
  });

  // PD01 evidence: read the exit history while it still holds every startup exit.
  await productExitCheckpoint('after-startup');
  await collectAnrEvents();
  await anrDialogSample('after-startup');

  await check('A02', 'login through the WebView reaches the app shell', async () => {
    const t0 = Date.now();
    const how = await login(me.username, me.id);
    return { how, ms: Date.now() - t0 };
  });

  // In-memory only: ties FD02 decay samples to the precise app process
  // observed by FD01, even when FD01's strict assertion fails.
  let fd01Pid = null;
  // P7 Android #209: the strict FD01 assertion is kept red if a live
  // FontsProvider connection remains. Disabling EmojiCompatInitializer alone
  // does not prove which subsystem made this connection; compare stage/refs.
  await check('FD01', 'native startup does not retain a Google Play emoji font dependency', async () => {
    if (MODE !== 'android') throw new Skip('Android ActivityManager evidence requires Android');
    fd01Pid = await pid(); // Never persisted or emitted in CI evidence.
    const evidence = await fontProviderStage('after-login');
    assert(evidence?.available && evidence.appPidValid, 'app process or OS provider probe unavailable after login');
    assert(evidence.providerSections > 0,
      'Android process-provider listing missing; cannot claim no provider dependency');
    assert(evidence.unparsedConnections === 0,
      'could not parse all Android content-provider connections; cannot claim no dependency');
    assert(evidence.fontProviderRefCountsKnown,
      'provider connection reference strength unknown; cannot classify dependency');
    assert(!evidence.fontProviderConnected,
      'FontsProvider still connected; initiating component is not established. Safe stage evidence: ' +
      JSON.stringify(facts.fontProviderStages));
    return evidence;
  });


  // #209: The existing FD01 gate remains STRICT and may be red even when a
  // transient reference disappears later. Measure its lifetime on the SAME
  // foreground app process; delayed clearance is not a retry or a PASS.
  // Read no raw provider names, URLs or process details into CI artifacts.
  await measure('FD02', 'post-login FontsProvider reference decay (measurement only)', async () => {
    if (MODE !== 'android') throw new Skip('Android ActivityManager required');
    const startingPid = await pid();
    assert(/^[0-9]{1,8}$/.test(String(startingPid)), 'FD02 baseline app process unavailable');
    assert(startingPid === fd01Pid,
      'FD02 and original FD01 saw different app processes; cannot infer dependency clearance');
    const start = Date.now();
    const samples = [];
    // Persist safe partial samples immediately: a later probe failure may be
    // critical evidence, and must never make earlier observations vanish.
    facts.fontProviderDecay = { sameAppProcess: true, complete: false, samples };
    for (const offsetMs of [1500, 4000, 8000]) {
      await sleep(Math.max(0, offsetMs - (Date.now() - start)));
      const currentPid = await pid();
      const stablePid = currentPid === startingPid;
      // Preserve the original app PID, never substitute a fresh process as
      // evidence that the original provider dependency cleared.
      if (!stablePid) facts.fontProviderDecay.sameAppProcess = false;
      assert(stablePid, 'FD02 app process changed during provider reference decay');
      const raw = await androidFailureShell(`dumpsys activity processes ${PKG}`);
      const info = inspectBridgeEmojiFontProvider(raw, currentPid);
      assert(info.appPidValid && info.providerSections > 0 &&
        info.unparsedConnections === 0 && info.fontProviderRefCountsKnown,
        'FD02 Android provider evidence unavailable or unparseable');
      samples.push({
        sampleAtMs: offsetMs,
        connected: info.fontProviderConnected,
        stableRefs: info.fontProviderStableRefs,
        unstableRefs: info.fontProviderUnstableRefs,
        waiting: info.fontProviderWaiting,
        dead: info.fontProviderDead,
      });
    }
    facts.fontProviderDecay.complete = true;
    return facts.fontProviderDecay;
  });

  await check('PN01', 'the notification channel named by server pushes (bridge_default) exists on the device', async () => {
    if (MODE === 'dryrun') throw new Skip('notification channels need a device');
    const lines = await until(async () => {
      const out = await sh(`dumpsys notification | grep -m4 "bridge_default"`).catch(() => '');
      return out.includes('bridge_default') ? out : null;
    }, { timeout: 15_000, message: 'bridge_default channel registered' });
    return { channelRegistered: lines.includes('bridge_default') };
  });

  await check('A03', 'server + channel list render and a channel opens', async () => {
    await openServer(serverId);
    await openChannel(channelId);
    assert((await activeChannel()) === channelId, 'A03 expected channel did not become active');
    return { expectedChannelActive: true };
  });

  await check('M01', 'send a channel message from the composer; it persists server-side', async () => {
    const needle = `android-compose-${Date.now().toString(36)}`;
    await sendFromComposer(needle);
    await until(async () => (await channelHas(me.token, channelId, needle)).length === 1, { message: 'message persisted once' });
    await until(() => visibleMessage(needle), { message: 'message rendered' });
    return { persistedOnce: true, rendered: true };
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
    // ANR03: an ANR dialog still up here is closed by the HOME press below,
    // and AOSP then kills the app with REASON_ANR ("user request after error").
    await anrDialogSample('before-L01-home');
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
    assert(pidBefore === pidAfter, 'L01 process died; cannot claim hot resume');
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

  // P7 D2 lifecycle. Two product contracts, both measured on the device:
  //  1. A channel another device creates appears in the ALREADY-LOADED list (server-emitted
  //     `channels:changed`, server id only). Before it, nothing was emitted and the list stayed
  //     stale; this step is what failed in the first D2L01 attempt.
  //  2. A channel that expires while the app is suspended is gone on resume: not listed, not
  //     active, its unsent draft not left on the device, and the server refuses its history.
  //     The app is backgrounded, so it may miss `channel:expired`; the resume refetch must cover it.
  // The original channel is reopened at the end so the journeys after this one start unchanged.
  await check('D2L01', 'channel created elsewhere appears live; channel expiring while suspended is gone on resume', async () => {
    const created = await write('POST', `/api/servers/${serverId}/channels`, me.token, { name: 'android-gecici', type: 'text' });
    const doomedId = created._id || created.id || created.channel?._id;
    assert(typeof doomedId === 'string' && doomedId, 'D2L01 channel was not created');
    const t0 = Date.now();
    await until(() => page.evaluate((cid) => !!document.querySelector(`.ch-item[data-id="${cid}"]`), doomedId),
      { timeout: 15_000, message: 'D2L01 channel created by another device appears without a manual reload' });
    const liveListMs = Date.now() - t0;

    await openChannel(doomedId);
    const draft = `android-d2-draft-${Date.now().toString(36)}`;
    await page.fill('#msg-input', draft);
    await sleep(1_500);  // let the draft store persist it

    await platform.home();
    await sleep(3_000);
    await expireChannelNow(serverId, doomedId, me.token);
    const history = await http('GET', `/api/channels/${doomedId}/messages?limit=1`, { token: me.token });
    assert(history.status === 404, `D2L01 server still serves the expired channel's history (HTTP ${history.status})`);
    await sleep(5_000);

    const fg = await platform.foreground();
    if (MODE === 'dryrun') {
      // No native shell in the dry run: send the same signal Capacitor's appStateChange sends.
      await page.evaluate(() => window.dispatchEvent(new CustomEvent('bridge:appstate', { detail: { active: true } })));
    }
    const t1 = Date.now();
    await attachPage();
    await until(() => page.evaluate((cid) => !document.querySelector(`.ch-item[data-id="${cid}"]`), doomedId),
      { timeout: 30_000, message: 'D2L01 expired channel removed from the list after resume' });
    await until(async () => (await activeChannel()) !== doomedId,
      { timeout: 15_000, message: 'D2L01 expired channel no longer active after resume' });
    const goneAfterMs = Date.now() - t1;
    await until(() => page.evaluate((cid) => !Object.keys(localStorage).some((k) => k.includes(cid)), doomedId),
      { timeout: 15_000, message: 'D2L01 no local storage key still references the expired channel' });
    const draftVisible = await page.evaluate((d) => (document.querySelector('#msg-input')?.value ?? '') === d, draft);
    assert(!draftVisible, 'D2L01 the expired channel draft is still in the composer');

    await openChannel(channelId);
    return { liveListMs, goneAfterResumeMs: goneAfterMs, launchState: fg.launchState ?? null };
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
    // Only whether the process changed: L03 emits no PID (P05, LO01 and the
    // pressure samples still do; a pre-existing gap, not fixed here).
    return { newProcess: before !== await pid(), kill: killed, relaunchTotalMs: launch.totalTimeMs };
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

  await productExitCheckpoint('after-lifecycle');
  await collectAnrEvents();

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
    return { dmRendered: true };
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
    assert(top.includes(PKG), 'K01 app left foreground after Back');
    return { appStillForeground: true, initialImeVisible, imeHiddenBeforeBack: true };
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
    assert(top.includes(PKG), 'K02 app left foreground after Back');
    return { tap, firstBackHidIme: true, secondBackClosedSettings: true };
  });

  await check('DL01', 'warm deep link bridge://channel/<id> opens that channel', async () => {
    await openChannel(otherId).catch(() => {});
    await platform.deepLink(`bridge://channel/${channelId}`);
    await attachPage();
    await until(() => activeChannel().then((c) => c === channelId), { timeout: 20_000, message: 'deep-linked channel active' });
    return { deepLinkOpened: true };
  });

  await check('DL04', 'the app-owned scheme com.bridge.app://channel/<id> opens that channel (the link format that also works on iOS)', async () => {
    await openChannel(otherId).catch(() => {});
    await platform.deepLink(`com.bridge.app://channel/${channelId}`);
    await attachPage();
    await until(() => activeChannel().then((c) => c === channelId), { timeout: 20_000, message: 'com.bridge.app link opened the channel' });
    return { deepLinkOpened: true };
  });

  await check('DL02', 'cold deep link bridge://channel/<id> opens that channel after session restore', async () => {
    // Same-device clock BEFORE launch: an immediate startup crash must not
    // be excluded by starting observation only once CDP attachment begins.
    // A failed clock probe does not change this journey's strict verdict.
    const crashWindowStart = await readAttachCrashClock();
    await platform.deepLink(`bridge://channel/${otherId}`, { cold: true });
    await attachPage({ crashWindowStart });
    await until(() => appVisible(), { timeout: 45_000, message: 'app after cold deep link' });
    await until(() => activeChannel().then((c) => c === otherId), { timeout: 30_000, message: 'cold deep-linked channel active' });
    return { crashClockAvailable: crashWindowStart !== null };
  });

  await check('DL03', 'deep link to a channel the user cannot access does not reveal it', async () => {
    const before = await activeChannel();
    await platform.deepLink(`bridge://channel/${privateChannelId}`);
    await attachPage();
    await sleep(6_000);
    const after = await activeChannel();
    const leaked = await page.evaluate((cid) => !!document.querySelector(`.ch-item[data-id="${cid}"]`), privateChannelId);
    assert(after !== privateChannelId && !leaked, 'inaccessible channel became visible through a deep link');
    return { deniedChannelNotVisible: true, activeChannelChanged: before !== after };
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
    return { osSheet: sheet, denialExplained: Boolean(text) };
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
    // The Android audio dump contains UID, session, device and patch metadata;
    // retain only the measurement's bounded signal and explicit probe status.
    return { packetsBefore: before.packetsSent, packetsAfter: after.packetsSent,
      audioProbeAvailable: Boolean(recording.trim()),
      osReportsSilenced: recording.trim() ? silenced : null, resumeMs: fg.totalTimeMs };
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
    return { osSheet: sheet, denialExplained: Boolean(text), toggleRemainedOff: true };
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
    const crashHints = { fatalException: /FATAL EXCEPTION/.test(crash),
      nativeSignal: /signal\s+\d+|SIGSEGV|SIGABRT/.test(crash) };
    assert(alive, 'app process died after notification permission grant; safe crash flags: ' + JSON.stringify(crashHints));
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app visible' });
    const status = await page.evaluate(() => window.bridgePush?.status?.() ?? 'no-bridgePush');
    assert(status === 'unavailable', `a build without FCM must report push as unavailable, got ${status}`);
    return { processAlive: true, status, launchMs: launch.totalTimeMs };
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
    const crashHints = { fatalException: /FATAL EXCEPTION/.test(crash),
      nativeSignal: /signal\s+\d+|SIGSEGV|SIGABRT/.test(crash) };
    assert(after && after === before, 'app process changed after sign-out; safe crash flags: ' + JSON.stringify(crashHints));
    await attachPage();
    await until(() => authVisible(), { timeout: 20_000, message: 'sign-in screen after sign-out' });
    return { processStable: true };
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
      // Preserve the original OS ANR assertion. Optionally classify its
      // ActivityManager reason; never expose raw reason text or stack traces.
      // Keep other-package ANR headers in the probe so their following Reason
      // lines cannot be misattributed to this app.
      facts.androidAnrCount = anrLog.split('\n').filter(line => line.includes('ANR in com.bridge.app.debug')).length;
      try {
        const rawCategories = await androidFailureShell(
          "logcat -d -v brief -s ActivityManager:E | grep -E 'ANR in |Reason:' || true");
        const categories = parseActivityManagerAnrs(rawCategories, PKG);
        facts.androidAnrCategories = { available: true, categories };
        log('Android ANR category evidence', JSON.stringify(facts.androidAnrCategories));
      } catch {
        facts.androidAnrCategories = { available: false, error: 'anr-category-probe-unavailable' };
      }
      // CPU pressure from the same ActivityManager ANR record (load average and
      // its before/after CPU tables): tells a starved emulator from an app that
      // is busy itself. Numbers and fixed categories only (exit-diagnostics.mjs).
      try {
        const rawCpu = await androidFailureShell('logcat -d -v brief -s ActivityManager:E | tail -n 4000 || true');
        facts.androidAnrCpu = { available: true, records: parseAnrCpuPressure(rawCpu, PKG) };
        log('Android ANR CPU evidence', JSON.stringify(facts.androidAnrCpu));
      } catch {
        facts.androidAnrCpu = { available: false, error: 'anr-cpu-probe-unavailable' };
      }
    }
    assert(!anrLog.includes('ANR in com.bridge.app.debug'),
      'Android ActivityManager detected an ANR; process restart/restoration is NOT sufficient for a pass');
    return { systemAnrCount: 0 };
  });

  // PD01 (#209): strict product regression gate. ActivityManager kills a
  // client holding a STABLE provider reference with REASON_DEPENDENCY_DIED (12)
  // when the provider's process dies, which is how the WebView FontsProvider
  // leak killed WebView processes. Any reason-12 exit of the Bridge process
  // during the journeys FAILs, attributed from the durable exit description.
  // An unreadable history, or one that may have evicted a journey exit before
  // it was read, also FAILs (unverifiable is never a PASS).
  await check('PD01', 'the Bridge app process was never killed by DEPENDENCY DIED (reason 12) during these journeys', async () => {
    if (MODE !== 'android') throw new Skip('Android ApplicationExitInfo requires a real Android runtime');
    const finalReadOk = await productExitCheckpoint('final');
    const summary = { ...summarizeProductExitLedger(productExitLedger),
      unreadableCheckpoints: productExitUnreadable };
    facts.productExitLedger = summary;
    assert(finalReadOk, 'Android exit history unreadable at the end of the journeys; cannot prove no DEPENDENCY DIED');
    assert(summary.windowValid, 'device journey start time unavailable; cannot bound the exit history');
    // A recorded reason-12 exit is reported first: it is a definite failure.
    assert(summary.dependencyDeaths === 0,
      'Bridge app process was killed by DEPENDENCY DIED during the journeys: ' +
      JSON.stringify(summary.dependencyEvidence));
    assert(!summary.potentialGap,
      'Android exit history may have evicted journey exits before they were read; cannot prove no DEPENDENCY DIED');
    assert(summary.unparsedRows === 0 && summary.unknownReasons === 0,
      'Android exit history has rows whose time, PID or reason did not parse; cannot prove no DEPENDENCY DIED');
    // Positive control: CS01 and L03/L04 force-stop and kill the app, so a
    // history that really was read holds journey exits.
    assert(summary.exitsInJourney >= 1,
      'no Bridge exit recorded during the journeys although the harness stopped the app; the exit history was not really read');
    return summary;
  });

  // ANR02 (#209): for every FATAL ANR the OS recorded for this package during
  // the journeys, the app reads its own ApplicationExitInfo trace and reduces
  // the "main" thread to fixed enums: idle looper vs binder call vs lock wait,
  // and Bridge / Capacitor / WebView / framework owner, plus separate top
  // Java-frame and first-owner operations. A sampled frame does not prove
  // the cause or duration of a stall. MEASURED only: ANR01 above stays the
  // asserting gate, and zero fatal ANRs here never excuses an ANR01 failure.
  // Coverage limits: non-fatal ANRs leave no exit record, and Android keeps
  // only 16 exit records per package (config_app_exit_info_history_list_size),
  // so early-journey exits can be evicted by later force-stops.
  // ANR03 (#209): the system event log's own timeline for the Bridge process:
  // when each ANR was declared, during which check, and what ended that
  // process (kill reason, delay). ApplicationExitInfo alone records only the
  // exit, so a reason-6 exit at L01 cannot tell an ANR during L01 from an
  // earlier ANR whose dialog the L01 HOME press closed. Measurement only.
  await measure('ANR03', 'system ANR timeline: when each Bridge ANR was declared, during which check, and what ended that process', async () => {
    if (MODE !== 'android') throw new Skip('Android event log requires a real Android runtime');
    const finalRead = await collectAnrEvents();
    await anrDialogSample('end');
    const base = { originPrecision: anrOrigin?.precision ?? null, finalRead,
      eventReads: anrEventReads, eventReadFailures: anrEventReadFailures,
      dialogSamples: anrDialogSamples };
    if (!anrOrigin) return { ...base, available: false, coverage: 'unknown', reason: 'device-clock-unavailable' };
    // Bound the observation to this journey's current instant. An older ANR
    // still in logcat must not become a new ANR03 occurrence.
    const endOffsetMs = Math.max(0, Date.now() - anrOrigin.hostMs);
    const timeline = parseAnrEventTimeline([...anrEventLines].join('\n'), PKG, anrOrigin.epochMs, 64, endOffsetMs);
    if (!timeline.available) return { ...base, available: false, coverage: 'unknown',
      reason: 'no-bridge-events-in-window', unparsedLines: timeline.unparsedLines,
      preOriginEvents: timeline.preOriginEvents ?? 0, postWindowEvents: timeline.postWindowEvents ?? 0 };
    const coverage = anrEventReadFailures || !finalRead || timeline.coverage === 'partial'
      ? 'partial' : 'observed-only';
    const steps = stepStarts.map(step => ({ id: step.id, atMs: step.hostMs - anrOrigin.hostMs }));
    const anrs = timeline.anrs.map(anr => ({ ...anr, step: stepAtOffset(steps, anr.atMs),
      killStep: anr.killAfterMs === null ? null : stepAtOffset(steps, anr.atMs + anr.killAfterMs) }));
    return { ...base, available: true, coverage, events: timeline.events.length,
      processes: new Set(timeline.events.map(e => e.process)).size,
      unparsedLines: timeline.unparsedLines, truncated: timeline.truncated,
      preOriginEvents: timeline.preOriginEvents, postWindowEvents: timeline.postWindowEvents,
      anrCount: anrs.length, anrs };
  });

  await measure('ANR02', 'app-local main-thread classification of OS-recorded fatal ANRs', async () => {
    if (MODE !== 'android') throw new Skip('Android ApplicationExitInfo required');
    assert(journeyStartedEpochMs !== null, 'ANR02 device journey start time unavailable');
    await sh('am force-stop ' + PKG);
    try {
      const started = await sh('am start -W -n ' + PKG +
        '/com.bridge.app.AnrTraceProbeActivity --el sinceEpochMs ' + journeyStartedEpochMs);
      assert(/Status: ok/.test(started), 'ANR02 trace probe Activity failed to launch');
      const probePid = await pid();
      assert(/^[0-9]{1,8}$/.test(String(probePid)), 'ANR02 probe process unavailable');
      let result = parseAnrTraceProbeMarkers('', probePid);
      const deadline = Date.now() + 15_000;
      while (!result.complete && Date.now() < deadline) {
        try {
          result = parseAnrTraceProbeMarkers(await androidFailureShell(
            "logcat -d -v brief --pid " + probePid + " -s BridgeAnrTraceProbe:I '*:S'"), probePid);
        } catch { /* keep polling until the deadline */ }
        if (!result.complete) await sleep(500);
      }
      // Partial evidence survives a missing completion marker (enums only).
      facts.androidFatalAnrTraces = result;
      assert(result.complete, 'ANR02 probe did not report completion; safe evidence: ' +
        JSON.stringify(result));
      return result;
    } finally {
      await sh('am force-stop ' + PKG).catch(() => {});
    }
  });

  // EX01 runs AFTER every product verdict and ANR/exit checkpoint. It cannot
  // warm product startup, change L01 timing or add expected deaths to PD01.
  // Unlike a repeated CI run, this is one fixed, bounded experiment. Stop at
  // the first failure and preserve its process before any subsequent launch.
  if (MODE === 'android') {
    let expectedChannel = channelId;
    facts.androidLifecycleExperiment = await runLifecycleReproduction({
      prepare: async ({ signal, step }) => {
        assert(facts.device?.qemu === '1', 'EX01 requires an emulator');
        const shell = async command => {
          signal.throwIfAborted();
          const raw = await androidFailureShell(command);
          signal.throwIfAborted();
          return raw;
        };
        await step('launch', () => platform.coldLaunch('', { shell }));
        await step('attach', () => attachPage());
        await step('restore', () => until(() => authVisible(), { timeout: 45_000, message: 'EX01 signed-out baseline' }));
        await step('restore', () => login(me.username, me.id));
        await step('restore', () => openServer(serverId));
        await step('restore', () => openChannel(channelId));
        // Assert that the EX01 fixture was truly saved BEFORE force-stop.
        // Otherwise a test setup failure would look like Android data loss.
        await step('restore', async () => {
          const persisted = await page.evaluate(({ user, server, expected }) =>
            localStorage.getItem('bridge:last-navigation:v1:channel:' + user + ':' + server) === expected,
            { user: me.id, server: serverId, expected: channelId });
          facts.ex01PreferenceSavedBeforeColdLaunch = persisted === true;
          assert(persisted === true, 'EX01 channel preference missing before process restart');
        });
      },
      clock: readAttachCrashClock,
      pressure: () => collectKernelPressure(androidFailureShell),
      run: async (phase, cycle, { signal, step }) => {
        const shell = async command => {
          signal.throwIfAborted();
          const raw = await androidFailureShell(command);
          signal.throwIfAborted();
          return raw;
        };
        let beforePid;
        let launchState;
        if (phase === 'hot-resume') {
          beforePid = await shell(`pidof ${PKG}`);
          await step('background', () => platform.home(shell));
          await step('background', () => sleep(20_000));
          const launch = await step('resume', () => platform.foreground(shell));
          launchState = launch.launchState;
        } else if (phase === 'cold-start') {
          // No waiting or storage writes: sample immediately BEFORE Android's
          // force-stop, to distinguish a late in-process overwrite from
          // a process-kill/WebView persistence rollback.
          facts.ex01ColdStartPreStop = await page.evaluate(({ user, server, expected }) => {
            const value = localStorage.getItem('bridge:last-navigation:v1:channel:' + user + ':' + server);
            return {
              available: true,
              preferencePresent: value !== null,
              preferenceMatches: value === expected,
              activeChannelMatches: document.querySelector('.ch-item.active')?.getAttribute('data-id') === expected,
            };
          }, { user: me.id, server: serverId, expected: expectedChannel })
            .catch(() => ({ available: false }));
          const launch = await step('launch', () => platform.coldLaunch('', { shell }));
          launchState = launch.launchState;
          beforePid = await shell(`pidof ${PKG}`);
        } else {
          // Alternate the target, so stale active-channel state cannot pass.
          expectedChannel = cycle % 2 ? otherId : channelId;
          const raw = await step('launch', () => platform.deepLink(`bridge://channel/${expectedChannel}`, { cold: true, shell }));
          launchState = summarizeAndroidColdLaunch(raw).launchState;
          beforePid = await shell(`pidof ${PKG}`);
        }
        await step('attach', () => attachPage());
        await step('session', () => until(() => appVisible(), { timeout: 45_000, message: 'EX01 session restored' }));
        await step('channel', () => until(async () => (await activeChannel()) === expectedChannel,
          { timeout: 30_000, message: 'EX01 expected channel restored' }));
        // Observe delayed death after actual UI, as in CS01. No second launch.
        await step('settle', () => sleep(2000));
        const afterPid = await shell(`pidof ${PKG}`);
        const focused = await step('focus', () => page.evaluate(() => document.hasFocus()));
        return { beforePid, afterPid, launchState, focused,
          uiVisible: await step('restore', () => appVisible()),
          channelMatched: (await step('restore', () => activeChannel())) === expectedChannel };
      },
      observe: start => observeLifecycleWindow(androidFailureShell, PKG, start),
      failureEvidence: async start => ({
        preStop: facts.ex01ColdStartPreStop ?? { available: false },
        ui: await page.evaluate(({ expected, user, server }) => {
          const visible = id => {
            const element = document.getElementById(id);
            return Boolean(element && getComputedStyle(element).display !== 'none' && element.getBoundingClientRect().height > 0);
          };
          return { available: true, appVisible: visible('app'), authVisible: visible('auth-screen'),
            anyActiveChannel: Boolean(document.querySelector('.ch-item.active')),
            expectedChannelActive: document.querySelector('.ch-item.active')?.getAttribute('data-id') === expected,
            rememberedChannelMatches: localStorage.getItem(`bridge:last-navigation:v1:channel:${user}:${server}`) === expected,
            bootNavigation: window.__bridgeNavigationProbeV1?.inspect(user, server, expected) ?? { available: false },
            focused: document.hasFocus() };
        }, { expected: expectedChannel, user: me.id, server: serverId }).catch(() => ({ available: false })),
        // Reuse #470's exact AndroidRuntime/OS-exit correlation. The original
        // error is deliberately omitted; it can contain URLs and identities.
        attach: await webViewAttachEvidence(start),
        events: await observeLifecycleWindow(androidFailureShell, PKG, start),
      }),
    });
    log('EX01 separate lifecycle experiment', JSON.stringify(facts.androidLifecycleExperiment));
    // EX02 is a separate comparison, never a retry or replacement for EX01.
    // Pause app JavaScript, verify browser storage, then stop once. This
    // removes a late app write from the pre-stop interval without a sleep or
    // a product persistence change. The original EX01 failure remains gating.
    if (pausedPreferenceControlApplies(facts.androidLifecycleExperiment)) {
      let session = null;
      let controlPage = null;
      let pauseControl = null;
      // Only the EX02-owned target may be treated as gone after our own
      // confirmed `am force-stop`; Playwright page.isClosed() alone can lag.
      let ownedTargetStopped = false;
      const controlStart = await readAttachCrashClock();
      facts.androidPausedPreferenceControl = await runPausedPreferenceControl({
        emulatorDebug: facts.device?.qemu === '1' && PKG === 'com.bridge.app.debug',
        select: async ({ step }) => {
          await step('server', () => openServer(serverId));
          await step('channel', () => openChannel(expectedChannel));
        },
        readBefore: async ({ step }) => step('read', () => page.evaluate(({ user, server, expected }) => {
          const value = localStorage.getItem('bridge:last-navigation:v1:channel:' + user + ':' + server);
          return { available: true, preferenceMatches: value === expected,
            activeChannelMatches: document.querySelector('.ch-item.active')?.getAttribute('data-id') === expected };
        }, { user: me.id, server: serverId, expected: expectedChannel })),
        pause: async context => {
          const { step } = context;
          controlPage = page;
          session = await step('session', () => controlPage.context().newCDPSession(controlPage));
          await step('storage-domain', () => session.send('DOMStorage.enable'));
          pauseControl = createDebuggerStoragePause(session);
          return pauseControl.pause(context);
        },
        readPaused: async ({ step }) => {
          // Raw entries (including other local values) stay in this scope.
          // Only the exact expected key's presence/equality can leave it.
          const key = 'bridge:last-navigation:v1:channel:' + me.id + ':' + serverId;
          return readPausedPreference(pauseControl, async () => {
            const response = await step('read', () => session.send('DOMStorage.getDOMStorageItems', {
              storageId: { securityOrigin: 'https://localhost', isLocalStorage: true },
            }));
            return response.entries;
          }, key, expectedChannel);
        },
        coldLaunch: async ({ signal }) => {
          if (!pauseControl?.isPaused()) throw new Error('control is no longer paused');
          const launch = await platform.coldLaunch('', { shell: async command => {
            signal.throwIfAborted();
            const raw = await androidFailureShell(command);
            signal.throwIfAborted();
            return raw;
          } });
          // A verified new COLD launch means this control's prior renderer
          // was stopped. A shell response alone has no usable exit status.
          if (launch?.status === 'ok' && launch.launchState === 'COLD') ownedTargetStopped = true;
          return launch;
        },
        readBoot: async ({ step }) => {
          await step('attach', () => attachPage({ crashWindowStart: controlStart }));
          await step('probe-ready', () => until(() => page.evaluate(() =>
            typeof window.__bridgeNavigationProbeV1?.inspect === 'function'),
          { timeout: 15_000, message: 'EX02 early navigation probe ready' }));
          return step('probe', () => page.evaluate(({ user, server, expected }) =>
            window.__bridgeNavigationProbeV1.inspect(user, server, expected),
          { user: me.id, server: serverId, expected: expectedChannel }));
        },
        cleanup: async context => {
          const { step } = context;
          if (!session) return;
          const targetGone = ownedTargetStopped || controlPage?.isClosed() === true;
          try {
            if (pauseControl) await pauseControl.release(context, targetGone);
          } finally {
            // The verified stopped renderer no longer owns an attached CDP
            // target. Attempting detach can hang on its now-defunct transport.
            // A still-live target must detach successfully; never fake cleanup.
            if (!targetGone) await step('detach', () => session.detach());
          }
        },
      });
    } else {
      facts.androidPausedPreferenceControl = { case: 'EX02', status: 'NOT_APPLICABLE', reason: 'no-matching-storage-failure' };
    }
    log('EX02 independent debugger-paused storage comparison', JSON.stringify(facts.androidPausedPreferenceControl));
  }

  peerSock.close();
}

main()
  .catch(async (err) => {
    results.push({ id: 'HARNESS', title: 'journey setup', status: 'FAIL', error: String(err?.stack ?? err).slice(0, 3000) });
    log('HARNESS FAILURE', err?.stack ?? err);
  })
  .finally(async () => {
    const summary = {
      suite: SUITE,
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
    console.log(SUITE === 'product'
      ? 'suite: product (Bridge reliability journeys; the upstream WebView reproduction controls run in the separate non-gating diagnostic workflow and are not counted here)'
      : 'suite: upstream-webview-controls (DIAGNOSTIC, NON-GATING: unmitigated upstream WebView reproduction controls; a FAIL is a real failure and is never counted as a pass)');
    console.log(`device: ${JSON.stringify(facts.device ?? {})}`);
    for (const r of results) console.log(`${r.status.padEnd(8)} ${r.id.padEnd(7)} ${r.title}${r.error ? `\n          ↳ ${r.error.split('\n')[0]}` : ''}${r.reason ? `\n          ↳ ${r.reason}` : ''}${r.detail ? `\n          ↳ ${JSON.stringify(r.detail)}` : ''}`);
    console.log(`TOTAL pass=${summary.totals.pass} fail=${summary.totals.fail} skipped=${summary.totals.skipped} measured=${summary.totals.measured} (skipped and measured are never counted as pass)`);
    try { if (device) await device.close(); } catch {}
    process.exit(summary.totals.fail > 0 || facts.androidLifecycleExperiment?.status === 'FAIL' ? 1 : 0);
  });
