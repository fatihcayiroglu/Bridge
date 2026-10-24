#!/usr/bin/env node
// Real Capacitor WKWebView + XCUITest lifecycle, with a real PostgreSQL-backed server.
// No browser substitute, injected lifecycle event, reload, relogin, or journey retry.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { webdriverRequest } from './webdriver-http.mjs';
import { probeIndexedDbTransactions } from './indexeddb-probe.mjs';

const require = createRequire(import.meta.url);
const { Client } = require('../../server/node_modules/pg');
const API = process.env.BASE_URL || 'http://127.0.0.1:3000';
const APPIUM = process.env.APPIUM_URL || 'http://127.0.0.1:4723';
const BUNDLE = 'com.bridge.app';
const OUT = path.resolve(process.env.IOS_EVIDENCE_DIR || 'e2e/ios/results');
const password = 'Ios-D2-acceptance-only-2026';
const facts = {};
let session;
let fixtureUserId;
fs.mkdirSync(OUT, { recursive: true });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function until(predicate, label, timeout = 30_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await predicate();
    if (result) return result;
    await pause(500);
  }
  throw new Error(`Timed out: ${label}`);
}

const wd = (method, route, body, timeout) => webdriverRequest(APPIUM, method, route, body, timeout);
const command = (method, route, body) => wd(method, `/session/${session}${route}`, body);
const js = (fn, ...args) => command('POST', '/execute/sync', { script: `return (${fn.toString()})(...arguments);`, args });
const native = (name, args = {}) => command('POST', '/execute/sync', { script: `mobile: ${name}`, args: [args] });
const nativeContext = () => command('POST', '/context', { name: 'NATIVE_APP' });

async function webContext() {
  await nativeContext();
  const active = await native('activeAppInfo');
  assert.equal(active.bundleId, BUNDLE, 'The native Bridge app must own the foreground context');
  assert(Number.isInteger(active.pid) && active.pid > 0, 'Native process identity is required');
  await until(async () => {
    const contexts = await command('GET', '/contexts');
    const views = contexts.filter(value => typeof value === 'string' && value.startsWith('WEBVIEW'));
    const probe = {
      contextCount: contexts.length, webviewCount: views.length,
      maxWebviewCount: Math.max(facts.webviewProbe?.maxWebviewCount || 0, views.length),
      switched: false, packagedOrigin: false, capacitorScheme: false,
      localhost: false, bridgeDom: false, nativeIOS: false, nativeProcessMatches: false,
    };
    facts.webviewProbe = probe;
    for (const context of views) {
      // Unsigned simulator Web Inspector reports process-App rather than the
      // bundle id. The exact observed alias is allowed at discovery, but the
      // actual page must belong to the foreground com.bridge.app process.
      probe.nativeProcessMatches = Number(/^WEBVIEW_(\d+)\./.exec(context)?.[1]) === active.pid;
      if (!probe.nativeProcessMatches) continue;
      await command('POST', '/context', { name: context });
      Object.assign(probe, await js(() => ({
        switched: true,
        packagedOrigin: location.origin === 'capacitor://localhost',
        capacitorScheme: location.protocol === 'capacitor:',
        localhost: location.hostname === 'localhost',
        bridgeDom: !!document.querySelector('#auth-screen, #app'),
        nativeIOS: window.Capacitor?.getPlatform() === 'ios',
      })));
      if (probe.packagedOrigin && probe.bridgeDom && probe.nativeIOS) return true;
    }
    return false;
  }, 'Bridge packaged WKWebView context', 120_000);
}

async function api(method, route, token, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  if (token && !['GET', 'HEAD'].includes(method)) {
    const csrf = await api('GET', '/api/csrf-token', token);
    assert.equal(csrf.status, 200, 'CSRF request must succeed');
    headers['X-CSRF-Token'] = csrf.json.token || csrf.json.csrfToken;
    assert(headers['X-CSRF-Token'], 'CSRF token required');
  }
  const response = await fetch(`${API}${route}`, {
    method, headers, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  return { status: response.status, json: await response.json() };
}
async function write(method, route, token, body) {
  const result = await api(method, route, token, body);
  assert(result.status >= 200 && result.status < 300, `Fixture request failed: ${method} (${result.status})`);
  return result.json;
}
function id(value) {
  const result = value._id || value.id || value.channel?._id || value.server?._id;
  assert.equal(typeof result, 'string', 'Fixture id missing');
  assert(result.length > 0, 'Fixture id empty');
  return result;
}
async function fill(selector, text) {
  assert(await js((selector, text) => {
    const input = document.querySelector(selector);
    if (!input) return false;
    const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }, selector, text), 'Input missing');
}
async function click(selector) {
  assert(await js(selector => {
    const target = document.querySelector(selector);
    if (!target) return false;
    target.click(); return true;
  }, selector), 'Click target missing');
}
async function openChannel(channelId) {
  const selector = `.ch-item[data-id="${channelId}"] .ch-open`;
  await until(() => js(selector => !!document.querySelector(selector), selector), 'channel appears');
  await click(selector);
  await until(() => js(cid => document.querySelector('.ch-item.active')?.dataset.id === cid, channelId), 'channel active');
}

async function localCounts(userId, serverId, channelId) {
  const result = await command('POST', '/execute/async', {
    args: [userId, serverId, channelId],
    script: `
      const [userId, serverId, channelId, done] = arguments;
      const request = indexedDB.open('bridge-local-first-records-v1', 1);
      request.onupgradeneeded = () => { request.transaction.abort(); };
      request.onerror = () => done({ ok: false });
      request.onsuccess = () => {
        const db = request.result;
        const tx = db.transaction('records', 'readonly');
        const query = tx.objectStore('records').getAll();
        query.onerror = () => { db.close(); done({ ok: false }); };
        query.onsuccess = () => {
          const rows = query.result.filter(row => row.userId === userId);
          const draftId = 'channel:' + encodeURIComponent(serverId) + ':' + encodeURIComponent(channelId);
          const historyId = 'channel:' + encodeURIComponent(channelId);
          const counts = {
            draft: rows.filter(row => row.namespace === 'draft' && row.recordId === draftId).length,
            history: rows.filter(row => row.namespace === 'history' && row.recordId === historyId).length
          };
          const stats = {
            totalRecords: query.result.length, recordsForUser: rows.length,
            draftsForUser: rows.filter(row => row.namespace === 'draft').length,
            historiesForUser: rows.filter(row => row.namespace === 'history').length,
          };
          db.close(); done({ ok: true, counts, stats });
        };
      };`,
  });
  assert.equal(result.ok, true, 'Encrypted IndexedDB must be readable; memory fallback is insufficient evidence');
  facts.storageProbe = { ...result.stats, matchingDrafts: result.counts.draft, matchingHistories: result.counts.history };
  return result.counts;
}

const started = Date.now();
try {
  assert(process.env.IOS_SIMULATOR_UDID && process.env.IOS_PLATFORM_VERSION && process.env.IOS_APP_PATH && process.env.DATABASE_URL,
    'Simulator UDID/version, built app and real PostgreSQL URL are mandatory');
  facts.stage = 'fixture';
  const username = `iosd2${Date.now().toString(36)}`;
  const registered = await write('POST', '/api/register', null, { username, password });
  const loggedIn = await write('POST', '/api/login', null, { username, password });
  const token = loggedIn.token || registered.token;
  assert(token, 'Fixture login token missing');
  const me = await api('GET', '/api/me', token);
  assert.equal(me.status, 200);
  const userId = id(me.json.user || me.json);
  fixtureUserId = userId;
  const serverId = id(await write('POST', '/api/servers', token, { name: 'iOS D2 acceptance' }));
  const permanent = id(await write('POST', `/api/servers/${serverId}/channels`, token, { name: 'ios-permanent', type: 'text' }));

  facts.stage = 'native-session';
  const created = await wd('POST', '/session', { capabilities: { alwaysMatch: {
    platformName: 'iOS', 'appium:automationName': 'XCUITest',
    'appium:udid': process.env.IOS_SIMULATOR_UDID,
    'appium:platformVersion': process.env.IOS_PLATFORM_VERSION,
    'appium:app': path.resolve(process.env.IOS_APP_PATH), 'appium:bundleId': BUNDLE,
    // The workflow preboots without Simulator.app. The driver's GUI default
    // shuts that warmed simulator down and restarts it; preserve that boot.
    'appium:isHeadless': true,
    'appium:noReset': false, 'appium:autoAcceptAlerts': true,
    'appium:newCommandTimeout': 180, 'appium:wdaLaunchTimeout': 180_000,
    // Match the existing smoke's 480-second simulator boot bound. This is
    // infrastructure startup only; all product assertion deadlines stay fixed.
    'appium:simulatorStartupTimeout': 480_000,
    'appium:webviewConnectTimeout': 60_000,
    'appium:fullContextList': false,
    // Observed in run 39993002937: Web Inspector advertises the unsigned
    // Debug app as process-App, which the default bundle filter excludes.
    'appium:additionalWebviewBundleIds': ['process-App'],
  } } }, 840_000);
  session = created.sessionId;
  assert(session, 'Native XCUITest session required');
  await command('POST', '/timeouts', { script: 20_000 });
  facts.stage = 'packaged-webview';
  await webContext();
  assert(await js(() => window.Capacitor?.getPlatform() === 'ios'), 'Must drive the native iOS app');
  await until(() => js(() => {
    const auth = document.getElementById('auth-screen');
    return !!auth && auth.getClientRects().length > 0;
  }), 'login form', 90_000);
  // Suppress only first-use hints, exactly as the Android acceptance harness does.
  await js(uid => {
    localStorage.setItem('bridge_onboarding_v3:anon', 'done');
    localStorage.setItem(`bridge_onboarding_v3:${uid}`, 'done');
  }, userId);
  await fill('#l-username', username);
  await fill('#l-password', password);
  await click('[data-auth-action="login"]');
  facts.stage = 'ui-login';
  await until(() => js(() => document.getElementById('app')?.getClientRects().length > 0), 'signed-in app', 60_000);
  await until(() => js(sid => !!document.querySelector(`.server-icon[data-id="${sid}"]`), serverId), 'fixture server');
  await click(`.server-icon[data-id="${serverId}"]`);
  await openChannel(permanent);
  facts.stage = 'permanent-draft';
  const permanentDraft = 'permanent channel draft control';
  await fill('#msg-input', permanentDraft);
  await until(async () => (await localCounts(userId, serverId, permanent)).draft === 1, 'permanent encrypted draft persisted');
  // The persisted records must be protected by the native Keychain key, not
  // by a browser fallback: WKWebView cannot clone a non-extractable CryptoKey
  // (DataCloneError), which is why the native vault exists. Read-only lookup;
  // the harness never initializes a key or seeds records.
  const nativeKey = await command('POST', '/execute/async', {
    args: [userId], script: `const uid = arguments[0], done = arguments[arguments.length - 1];
      const cap = globalThis.Capacitor;
      if (cap?.isPluginAvailable?.('BridgeLocalFirstCrypto') !== true) { done({ available: false }); } else {
        cap.Plugins.BridgeLocalFirstCrypto.hasKey({ userId: uid }).then(
          value => done({ available: true, keyExists: value?.exists === true }),
          error => done({ available: true, keyExists: false, code: String(error?.code || '') }));
      }`,
  });
  facts.nativeKeyAfterDraft = nativeKey;
  assert.deepEqual(nativeKey, { available: true, keyExists: true },
    'The encrypted draft must be protected by the native Keychain key (no browser-key fallback)');
  // ...and by no browser key: the WebCrypto key store holds no key for this
  // account. Read-only: the key database is opened only if it already exists
  // (open() on a missing name would create it).
  const browserKey = await command('POST', '/execute/async', {
    args: [userId], script: `const uid = arguments[0], done = arguments[arguments.length - 1];
      (async () => {
        const names = (await indexedDB.databases()).map(d => d.name);
        if (!names.includes('bridge-local-first-keys-v1')) return { keyDatabase: false, browserKeyForAccount: false };
        const db = await new Promise((ok, ko) => { const r = indexedDB.open('bridge-local-first-keys-v1'); r.onsuccess = () => ok(r.result); r.onerror = () => ko(r.error); });
        try {
          if (!db.objectStoreNames.contains('keys')) return { keyDatabase: true, browserKeyForAccount: false };
          const row = await new Promise((ok, ko) => { const q = db.transaction('keys', 'readonly').objectStore('keys').get(uid); q.onsuccess = () => ok(q.result); q.onerror = () => ko(q.error); });
          return { keyDatabase: true, browserKeyForAccount: row !== undefined };
        } finally { db.close(); }
      })().then(done, error => done({ probeFailed: String(error?.name || 'error') }));`,
  });
  facts.browserKeyAfterDraft = browserKey;
  assert.equal(browserKey.browserKeyForAccount, false,
    `No browser WebCrypto key may exist for the account whose draft the native key protects: ${JSON.stringify(browserKey)}`);

  // Creation happens on another API session after the app already loaded the channel list.
  const tLive = Date.now();
  const doomed = id(await write('POST', `/api/servers/${serverId}/channels`, token, { name: 'ios-expiring', type: 'text' }));
  facts.stage = 'live-channel';
  await until(() => js(cid => !!document.querySelector(`.ch-item[data-id="${cid}"]`), doomed), 'live channel creation without reload');
  facts.liveListMs = Date.now() - tLive;
  const database = new Client({ connectionString: process.env.DATABASE_URL });
  await database.connect();
  try {
    // Seed one fixture message, then require the product to fetch, display and encrypt its history.
    const seeded = await database.query(`INSERT INTO messages (_id, "channelId", "serverId", "userId", username, "displayName", content, "createdAt")
      VALUES ($1, $2, $3, $4, $5, 'iOS fixture', 'ios-d2-history-control', $6)`,
    [`ios-d2-${Date.now()}`, doomed, serverId, userId, username, Date.now()]);
    assert.equal(seeded.rowCount, 1);
    await openChannel(doomed);
    facts.stage = 'encrypted-history-and-draft';
    await until(() => js(() => [...document.querySelectorAll('.msg')].some(row => row.textContent.includes('ios-d2-history-control'))), 'history displayed');
    await fill('#msg-input', 'expired channel draft control');
    await until(async () => {
      const counts = await localCounts(userId, serverId, doomed);
      return counts.draft === 1 && counts.history === 1;
    }, 'encrypted draft AND history persisted before expiry');

    await nativeContext();
    facts.stage = 'native-background';
    const before = await native('activeAppInfo');
    assert.equal(before.bundleId, BUNDLE);
    assert(Number(before.pid) > 0, 'Process identity required before backgrounding');
    await native('backgroundApp', { seconds: -1 });
    await until(async () => [2, 3].includes(await native('queryAppState', { bundleId: BUNDLE })), 'native app backgrounded');
    facts.nativeBackgroundObserved = true;
    await write('PUT', `/api/servers/${serverId}/channels/${doomed}/expiry`, token, { expiresAt: Date.now() + 7_200_000 });
    const expired = await database.query(`UPDATE channels
      SET "expiresAt" = FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) * 1000)::BIGINT - 1000
      WHERE _id = $1 AND "serverId" = $2 AND "expiryVersion" > 0`, [doomed, serverId]);
    assert.equal(expired.rowCount, 1, 'Exactly one API-configured fixture channel expires');
    assert.equal((await api('GET', `/api/channels/${doomed}/messages?limit=1`, token)).status, 404, 'Server immediately denies expired history');
    facts.serverDeniedExpiredHistory = true;
    assert([2, 3].includes(await native('queryAppState', { bundleId: BUNDLE })), 'App must still be backgrounded at expiry');
    await native('activateApp', { bundleId: BUNDLE });
    facts.stage = 'native-resume';
    const after = await native('activeAppInfo');
    assert.equal(after.bundleId, BUNDLE);
    assert.equal(after.pid, before.pid, 'A relaunch must not mask a crash during resume');
    facts.sameProcessResumed = true;
    const resumed = Date.now();
    await webContext();
    facts.stage = 'expiry-reconciliation';
    await until(() => js(cid => !document.querySelector(`.ch-item[data-id="${cid}"]`) && document.querySelector('.ch-item.active')?.dataset.id !== cid, doomed), 'expired channel removed and inactive after resume');
    await until(async () => {
      const counts = await localCounts(userId, serverId, doomed);
      return counts.draft === 0 && counts.history === 0;
    }, 'expired encrypted history AND draft deleted');
    assert(await js(cid => !Object.keys(localStorage).some(key => key.includes(cid)), doomed), 'No legacy localStorage channel record survives');
    assert(await js(() => document.querySelector('#msg-input')?.value !== 'expired channel draft control'), 'Expired draft must leave the composer');
    facts.reconciledAfterResumeMs = Date.now() - resumed;
    assert.equal((await localCounts(userId, serverId, permanent)).draft, 1, 'Permanent-channel draft must survive reconciliation');
    assert.equal((await api('GET', `/api/channels/${permanent}/messages?limit=1`, token)).status, 200, 'Permanent channel remains authorized');
    await openChannel(permanent);
    await until(() => js(expected => document.querySelector('#msg-input')?.value === expected, permanentDraft), 'permanent draft restored');
    facts.expiredEncryptedHistoryRemoved = true;
    facts.expiredEncryptedDraftRemoved = true;
    facts.permanentChannelControlPassed = true;
    facts.stage = 'complete';
  } finally { await database.end(); }
  fs.writeFileSync(path.join(OUT, 'expiry-journey.json'), JSON.stringify({
    id: 'D2L01-iOS', category: 'AUTOMATED / SIMULATOR', status: 'PASS',
    commit: process.env.GITHUB_SHA || null, ms: Date.now() - started, facts,
  }, null, 2));
  console.log(`D2L01-iOS key provider: native=${JSON.stringify(facts.nativeKeyAfterDraft)} browser=${JSON.stringify(facts.browserKeyAfterDraft)}`);
  console.log('PASS D2L01-iOS: native Keychain key, background/resume, expired history and draft purge, permanent-channel control');
} catch (error) {
  if (session && facts.stage === 'permanent-draft') {
    try {
      facts.draftEnvironment = await js(() => ({
        secureContext: globalThis.isSecureContext === true,
        webCrypto: !!globalThis.crypto?.subtle,
        indexedDB: !!globalThis.indexedDB,
        composerCount: document.querySelectorAll('#msg-input').length,
        composerHasText: (document.querySelector('#msg-input')?.value || '').length > 0,
        composerEnabled: document.querySelector('#msg-input')?.disabled === false,
        activeChannelPresent: !!document.querySelector('.ch-item.active'),
      }));
      // Read-only native lookup after a failed assertion. Never initialize a
      // key or seed app records from the harness to make persistence pass.
      facts.nativeKeyAvailability = await command('POST', '/execute/async', {
        args: [fixtureUserId], script: `const uid = arguments[0], done = arguments[arguments.length - 1];
          const cap = globalThis.Capacitor;
          const facts = { available: cap?.isPluginAvailable?.('BridgeLocalFirstCrypto') === true,
            headerPresent: cap?.PluginHeaders?.some(h => h.name === 'BridgeLocalFirstCrypto') === true };
          if (!facts.available) { done(facts); } else {
            cap.Plugins.BridgeLocalFirstCrypto.hasKey({ userId: uid }).then(value => {
              facts.keyExists = value?.exists === true; done(facts);
            }, error => {
              facts.keychainFailure = error?.code === 'LOCAL_CRYPTO_KEYCHAIN';
              const status = error?.data?.status;
              if (Number.isInteger(status)) facts.osStatus = status;
              done(facts);
            });
          }`,
      });
      facts.indexedDbKeyProbe = await command('POST', '/execute/async', {
        args: [], script: `const done = arguments[arguments.length - 1]; (${probeIndexedDbTransactions.toString()})().then(done, () => done({ probeFailed: true }));`,
      });
    } catch { facts.draftDiagnosticFailed = true; }
  }
  if (session && facts.stage === 'packaged-webview') {
    // The fixture has not logged in yet. Keep only native state/shape facts,
    // never the source tree, account data or WebDriver argument payloads.
    const probe = {};
    facts.nativeStartup = probe;
    try {
      await nativeContext();
      probe.appState = await native('queryAppState', { bundleId: BUNDLE });
      const active = await native('activeAppInfo');
      probe.bridgeIsActive = active.bundleId === BUNDLE;
      probe.activePIDPresent = Number.isInteger(active.pid) && active.pid > 0;
      const source = await command('GET', '/source');
      probe.sourceLength = source.length;
      probe.webViewCount = (source.match(/<XCUIElementTypeWebView\b/g) || []).length;
      probe.textFieldCount = (source.match(/<XCUIElementType(?:Secure)?TextField\b/g) || []).length;
      probe.alertCount = (source.match(/<XCUIElementTypeAlert\b/g) || []).length;
    } catch { probe.diagnosticFailed = true; }
  }
  fs.writeFileSync(path.join(OUT, 'expiry-journey.json'), JSON.stringify({
    id: 'D2L01-iOS', category: 'AUTOMATED / SIMULATOR', status: 'FAIL',
    commit: process.env.GITHUB_SHA || null, ms: Date.now() - started, facts,
    error: String(error.message).slice(0, 500),
  }, null, 2));
  // Booleans only (no ids or payloads): which key provider protected the draft.
  console.error(`D2L01-iOS key provider: native=${JSON.stringify(facts.nativeKeyAfterDraft ?? null)} browser=${JSON.stringify(facts.browserKeyAfterDraft ?? null)}`);
  console.error(`FAIL D2L01-iOS: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (session) {
    try { await wd('DELETE', `/session/${session}`); }
    catch { console.error('Native session cleanup failed'); process.exitCode = 1; }
  }
}
