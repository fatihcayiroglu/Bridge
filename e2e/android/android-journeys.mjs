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
import path from 'node:path';

const MODE = process.env.ANDROID_JOURNEY_MODE === 'dryrun' ? 'dryrun' : 'android';
const API = process.env.BASE_URL || 'http://127.0.0.1:3000';
const PKG = process.env.ANDROID_PKG || 'com.bridge.app.debug';
const ACTIVITY = `${PKG}/com.bridge.app.MainActivity`;
const OUT_DIR = path.resolve(process.env.ANDROID_EVIDENCE_DIR || 'android/results');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const PASSWORD = 'P4-android-journey-pass-1';

fs.mkdirSync(OUT_DIR, { recursive: true });

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

async function check(id, title, fn) {
  const started = Date.now();
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
    const shot = await screenshot(`${id}-fail`);
    results.push({ id, title, status: 'FAIL', ms: Date.now() - started, error: String(err?.message ?? err).slice(0, 2000), screenshot: shot });
    log(`  FAIL ${id}: ${err?.message ?? err}`);
  }
}

/** Measurement-only probe: records numbers, asserts nothing, and is NEVER counted as a PASS. */
async function measure(id, title, fn) {
  const started = Date.now();
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

// ── Platform layer ─────────────────────────────────────────────────────────
const sh = async (cmd) => (await device.shell(cmd)).toString().trim();

async function attachPage({ timeout = 60_000 } = {}) {
  if (MODE === 'dryrun') return page;
  const webview = await device.webView({ pkg: PKG }, { timeout });
  const p = await webview.page();
  p.setDefaultTimeout(20_000);
  page = p;
  return p;
}
async function pid() { return MODE === 'dryrun' ? 'dryrun' : (await sh(`pidof ${PKG}`)) || null; }

const platform = {
  async coldLaunch(extra = '') {
    if (MODE === 'dryrun') { await page.goto(API); return { totalTimeMs: null }; }
    await sh(`am force-stop ${PKG}`);
    const out = await sh(`am start -W -n ${ACTIVITY} ${extra}`);
    return { totalTimeMs: Number((/TotalTime:\s*(\d+)/.exec(out) || [])[1]) || null, raw: out.split('\n').slice(-4).join(' | ') };
  },
  async home() { if (MODE === 'dryrun') return; await sh('input keyevent KEYCODE_HOME'); },
  async foreground() {
    if (MODE === 'dryrun') return { totalTimeMs: null };
    const out = await sh(`am start -W -n ${ACTIVITY}`);
    return { totalTimeMs: Number((/TotalTime:\s*(\d+)/.exec(out) || [])[1]) || null, launchState: (/LaunchState:\s*(\w+)/.exec(out) || [])[1] ?? null };
  },
  async killInBackground() { if (MODE === 'dryrun') throw new Skip('process death needs a device'); await sh(`am kill ${PKG}`); },
  async forceStop() { if (MODE === 'dryrun') throw new Skip('force-stop needs a device'); await sh(`am force-stop ${PKG}`); },
  async deepLink(url, { cold = false } = {}) {
    if (MODE === 'dryrun') throw new Skip('deep links need the native shell');
    if (cold) await sh(`am force-stop ${PKG}`);
    return sh(`am start -W -a android.intent.action.VIEW -d '${url}' ${PKG}`);
  },
  async network(on) {
    if (MODE === 'dryrun') { await page.context().setOffline(!on); return; }
    await sh(on ? 'svc wifi enable; svc data enable' : 'svc wifi disable; svc data disable');
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
    const out = { pcs: 0, packetsSent: 0, audioLevel: null };
    for (const pc of (window.__pcs || []).filter((p) => p.connectionState !== 'closed')) {
      out.pcs += 1;
      (await pc.getStats()).forEach((r) => {
        if (r.type === 'outbound-rtp' && r.kind === 'audio') out.packetsSent += Number(r.packetsSent || 0);
        if (r.type === 'media-source' && r.kind === 'audio' && typeof r.audioLevel === 'number') out.audioLevel = r.audioLevel;
      });
    }
    return out;
  }).catch(() => ({ pcs: 0, packetsSent: 0, audioLevel: null }));
}
async function permissionDialog(timeout = 20_000) {
  // The real Android runtime-permission sheet (com.android.permissioncontroller).
  try {
    await device.wait({ res: 'com.android.permissioncontroller:id/permission_deny_button' }, { timeout });
    return true;
  } catch { return false; }
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

  if (MODE === 'android') {
    const list = await android.devices();
    assert(list.length > 0, 'no adb device');
    device = list[0];
    facts.device = {
      model: await sh('getprop ro.product.model'),
      release: await sh('getprop ro.build.version.release'),
      sdk: await sh('getprop ro.build.version.sdk'),
      abi: await sh('getprop ro.product.cpu.abi'),
      qemu: await sh('getprop ro.kernel.qemu'),
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

  await check('A02', 'login through the WebView reaches the app shell', async () => {
    const t0 = Date.now();
    const how = await login(me.username, me.id);
    return { how, ms: Date.now() - t0 };
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

  await check('L01', 'background 20 s → message arrives meanwhile → foreground shows it', async () => {
    await platform.home();
    await sleep(3_000);
    const needle = `android-bg-${Date.now().toString(36)}`;
    await sendChannel(peerSock, serverId, channelId, needle);
    await sleep(17_000);
    const fg = await platform.foreground();
    const t0 = Date.now();
    await attachPage();
    await until(() => visibleMessage(needle), { timeout: 30_000, message: 'background message visible after resume' });
    return { resumeTotalMs: fg.totalTimeMs, launchState: fg.launchState, visibleAfterMs: Date.now() - t0, pidStable: true };
  });

  await check('L02', 'background 75 s (past socket ping timeout) → foreground resyncs without stale UI', async () => {
    await platform.home();
    await sleep(5_000);
    const needle = `android-long-bg-${Date.now().toString(36)}`;
    await sendChannel(peerSock, serverId, channelId, needle);
    await sleep(70_000);
    await platform.foreground();
    const t0 = Date.now();
    await attachPage();
    await until(() => visibleMessage(needle), { timeout: 60_000, message: 'message after long background' });
    return { visibleAfterMs: Date.now() - t0 };
  });

  await check('L03', 'process killed while backgrounded → relaunch restores session, channel and missed messages', async () => {
    const before = await pid();
    await platform.home();
    await sleep(2_000);
    await platform.killInBackground();
    await until(async () => !(await pid()), { timeout: 10_000, message: 'process gone' });
    const needle = `android-dead-${Date.now().toString(36)}`;
    await sendChannel(peerSock, serverId, channelId, needle);
    const launch = await platform.foreground();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app restored without login' });
    assert(!(await authVisible()), 'auth screen shown after process death — session not restored');
    await openServer(serverId);
    await openChannel(channelId);
    await until(() => visibleMessage(needle), { timeout: 30_000, message: 'missed message after relaunch' });
    return { pidBefore: before, pidAfter: await pid(), relaunchTotalMs: launch.totalTimeMs };
  });

  await check('L04', 'force-stop (user kill) → cold relaunch restores the session', async () => {
    await platform.forceStop();
    const launch = await platform.foreground();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app restored after force-stop' });
    return { coldRelaunchTotalMs: launch.totalTimeMs };
  });

  await check('N01', 'offline: banner shows, composed message is held, delivered exactly once on reconnect', async () => {
    await openServer(serverId);
    await openChannel(channelId);
    await platform.network(false);
    const offlineShown = await until(() => page.evaluate(() => {
      const b = document.querySelector('.offline-banner.offline');
      return !!b && getComputedStyle(b).display !== 'none';
    }), { timeout: 45_000, message: 'offline banner' }).then(() => true).catch(() => false);
    const needle = `android-offline-${Date.now().toString(36)}`;
    await sendFromComposer(needle);
    await sleep(3_000);
    const whileOffline = (await channelHas(me.token, channelId, needle)).length;
    const t0 = Date.now();
    await platform.network(true);
    await until(async () => (await channelHas(me.token, channelId, needle)).length >= 1, { timeout: 60_000, message: 'queued message delivered' });
    await sleep(3_000);
    const copies = (await channelHas(me.token, channelId, needle)).length;
    assert(offlineShown, 'offline banner never appeared while the network was off');
    assert(whileOffline === 0, `message reached the server while offline (${whileOffline})`);
    assert(copies === 1, `queued message delivered ${copies} times`);
    return { deliveredAfterReconnectMs: Date.now() - t0 };
  });

  await check('N02', 'offline 30 s while another user posts → reconnect resync shows the missed message', async () => {
    await platform.network(false);
    await sleep(5_000);
    const needle = `android-missed-${Date.now().toString(36)}`;
    await sendChannel(peerSock, serverId, channelId, needle);
    await sleep(25_000);
    const t0 = Date.now();
    await platform.network(true);
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

  await check('K01', 'Android back closes an open dialog instead of leaving the app', async () => {
    await page.evaluate(() => document.querySelector('[data-bridge-action="openSettingsModal"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await until(() => page.evaluate(() => [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some((d) => d.getClientRects().length > 0)), { message: 'settings dialog open' });
    await platform.back();
    await until(() => page.evaluate(() => ![...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some((d) => d.getClientRects().length > 0)), { timeout: 5_000, message: 'dialog closed by back' });
    const top = await sh('dumpsys activity activities | grep -m1 -E "topResumedActivity|mResumedActivity"').catch(() => '');
    assert(top.includes(PKG), `app left the foreground after back: ${top}`);
    return { top };
  });

  await check('DL01', 'warm deep link bridge://channel/<id> opens that channel', async () => {
    await openChannel(otherId).catch(() => {});
    const raw = await platform.deepLink(`bridge://channel/${channelId}`);
    await attachPage();
    await until(() => activeChannel().then((c) => c === channelId), { timeout: 20_000, message: 'deep-linked channel active' });
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
    const sheet = await permissionDialog();
    assert(sheet, 'Android microphone permission sheet did not appear on voice join');
    await device.tap({ res: 'com.android.permissioncontroller:id/permission_deny_button' });
    const text = await until(() => page.evaluate(() => {
      const t = [...document.querySelectorAll('[role="alert"], [role="status"], .toast')].map((e) => e.textContent || '').join(' | ');
      return /mikrofon|microphone/i.test(t) ? t : null;
    }), { timeout: 25_000, message: 'microphone denial explained in the UI' });
    return { shown: text.slice(0, 200) };
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

  await measure('P04', 'voice while backgrounded 20 s: does the OS keep the microphone capture alive?', async () => {
    const before = await outboundAudio();
    assert(before.packetsSent > 0, 'no active voice session to background');
    await platform.home();
    await sleep(20_000);
    const recording = MODE === 'android' ? await sh('dumpsys audio | grep -i -E "silenced|rec_activity|recording" | head -20').catch(() => '') : '';
    const fg = await platform.foreground();
    await attachPage();
    const after = await outboundAudio();
    const silenced = /silenced[:=]\s*true/i.test(recording);
    return { packetsBefore: before.packetsSent, packetsAfter: after.packetsSent, osReportsSilenced: silenced, audioDump: recording.slice(0, 1200), resumeMs: fg.totalTimeMs };
  });

  await check('P02', 'notification permission state is readable without prompting', async () => {
    await platform.permission('android.permission.POST_NOTIFICATIONS', false).catch(() => {});
    await platform.foreground();
    await attachPage();
    await until(() => appVisible(), { timeout: 45_000, message: 'app' });
    const status = await page.evaluate(() => window.bridgePush?.status?.() ?? 'no-bridgePush');
    assert(status === 'denied' || status === 'prompt', `unexpected push permission status: ${status}`);
    return { status };
  });

  await check('P05', 'notification permission granted on a build without Firebase config → app launches and stays alive', async () => {
    // Self-hosted builds without google-services.json are the documented default. Granting the
    // notification permission makes the bridge call PushNotifications.register() at launch.
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
    return { pid: alive, status, launchMs: launch.totalTimeMs, crashBuffer: crash ? crash.slice(-400) : '' };
  });

  await check('UI01', 'landscape: no horizontal overflow and the composer stays visible', async () => {
    await platform.rotate(true);
    await sleep(2_500);
    const m = await page.evaluate(() => {
      const c = document.getElementById('msg-input')?.getBoundingClientRect();
      return { sw: document.documentElement.scrollWidth, iw: window.innerWidth, ih: window.innerHeight, composerBottom: c ? Math.round(c.bottom) : null, composerH: c ? Math.round(c.height) : null };
    });
    await platform.rotate(false);
    assert(m.sw <= m.iw + 1, `horizontal overflow in landscape: scrollWidth ${m.sw} > innerWidth ${m.iw}`);
    return m;
  });

  await measure('PERF01', 'memory footprint after the journeys (PSS)', async () => {
    const kb = await platform.memInfoKb();
    return { totalPssKb: kb };
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
      evidenceCategory: MODE === 'android' ? 'AUTOMATED / EMULATOR' : 'DRYRUN (harness debugging only — NOT evidence)',
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
    try { if (device) await device.close(); } catch {}
    process.exit(summary.totals.fail > 0 ? 1 : 0);
  });
