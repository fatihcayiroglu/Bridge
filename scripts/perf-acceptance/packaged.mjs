// Real packaged desktop PA01/PA08 executor. No application mocks, token
// injection, browser security overrides, duration overrides or invented metrics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { buildReport, probe } from './run.mjs';
import { SCENARIOS } from './scenarios.mjs';
import { validateReport, summarize } from './report.mjs';
import { createHash } from 'node:crypto';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const requireE2e = createRequire(new URL('../../e2e/package.json', import.meta.url));
const requireFact = (condition, code) => { if (!condition) throw new Error(code); };

export function validateIdentity(identity) {
  requireFact(identity.packaged && identity.appPath.endsWith('app.asar') && !identity.insecure &&
    identity.windows.length > 0 && identity.windows.every(w => w.sandbox && w.contextIsolation && !w.nodeIntegration),
  'PACKAGED_SECURITY_PRECONDITION');
}

// Allowlist only fixed, boolean facts. Never serialize input values, URLs, DOM text,
// selectors, credentials, screenshots or stack traces into acceptance artifacts.
export function closedAuthInputGeometry(data) {
  if (!data || typeof data !== 'object') return { unavailable: true };
  const names = ['buttonPresent', 'buttonEnabled', 'buttonVisible',
    'buttonCenterInViewport', 'hitIsLoginButton', 'documentFocused'];
  const result = {};
  for (const name of names) result[name] = data[name] === true;
  return result;
}

// Compare an X11 window-manager active-window snapshot against the Electron
// native handle. The artifact receives only true/false/null, never raw XIDs.
export function x11ActiveWindowMatches(text, windowId) {
  if (typeof text !== 'string' || !Number.isSafeInteger(windowId) || windowId <= 0) return null;
  const match = /_NET_ACTIVE_WINDOW\(WINDOW\): window id # (0x[0-9a-fA-F]+)\b/.exec(text);
  return match ? Number.parseInt(match[1], 16) === windowId : null;
}

export function isolatedRequestAllowed(rawUrl, method, origin) {
  try {
    const url = new URL(rawUrl);
    if (url.username || url.password) return false;
    if (url.origin === origin) return true;
    return ['GET', 'HEAD'].includes(method) && !url.pathname.startsWith('/api/');
  } catch { return false; }
}

export function validateConfig(c) {
  requireFact(c?.schema === 1 && /^[a-f0-9]{40}$/.test(c.bridgeCommit), 'CONFIG_PROVENANCE');
  const u = new URL(c.origin);
  requireFact(u.protocol === 'https:' && !u.username && !u.password && u.origin === c.origin, 'CONFIG_HTTPS_ORIGIN');
  for (const key of ['executable', 'output']) requireFact(path.isAbsolute(c[key] || ''), 'CONFIG_ABSOLUTE_PATH');
  for (const key of ['server', 'idleChannel', 'historyChannel', 'messagePrefix']) {
    requireFact(typeof c[key] === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(c[key]), 'CONFIG_FIXTURE_ID');
  }
  requireFact(typeof c.username === 'string' && c.username.length > 0 &&
    typeof c.password === 'string' && c.password.length >= 12, 'CONFIG_CREDENTIALS');
  requireFact(c.seededMessages === 10000, 'CONFIG_HISTORY_COUNT');
  return c;
}

export function normalizeMetrics(metrics, elapsedSec) {
  requireFact(Array.isArray(metrics) && metrics.some(p => p.type === 'Browser') &&
    metrics.some(p => p.type === 'Tab'), 'PROCESS_METRICS_MISSING');
  const processes = metrics.map(p => {
    requireFact(Number.isInteger(p.pid) && p.pid > 0 && typeof p.type === 'string' &&
      Number.isFinite(p.cpu?.percentCPUUsage) && p.cpu.percentCPUUsage >= 0 &&
      Number.isFinite(p.memory?.workingSetSize) && p.memory.workingSetSize >= 0, 'PROCESS_METRIC_INVALID');
    return { pid: p.pid, type: p.type, cpuPercent: p.cpu.percentCPUUsage, workingSetKiB: p.memory.workingSetSize };
  });
  return { elapsedSec, processes, cpuPercent: processes.reduce((n, p) => n + p.cpuPercent, 0),
    workingSetKiB: processes.reduce((n, p) => n + p.workingSetKiB, 0) };
}

export async function runPackaged(config) {
  const c = validateConfig(config);
  requireFact(fs.existsSync(c.executable), 'PACKAGED_EXECUTABLE_MISSING');
  // Never reuse an existing profile or output directory (may contain real data).
  fs.mkdirSync(c.output, { recursive: false, mode: 0o700 });
  const profile = path.join(c.output, 'private-profile');
  fs.mkdirSync(profile, { mode: 0o700 });
  fs.writeFileSync(path.join(profile, 'desktop-settings.json'), JSON.stringify({ serverOrigin: c.origin }), { mode: 0o600 });
  const report = buildReport(probe());
  let application;
  let pageRef;
  let stage = 'LAUNCH';
  let securityFacts = null;
  let loginStatus = null;
  let onboardingDismissed = false;
  let failureUi = null;
  let blockedExternalRequests = 0;
  const networkFailures = [];
  const runtimeErrors = [];
  let historyProgress = null;
  let authInteraction = null;
  let nativeFocusFacts = null;
  let loginRequests = 0;
  // A resolved Playwright click is not proof that the native input reached the
  // renderer. Record only closed, non-sensitive facts about the transition.
  const authInputTransition = { clickResolved: false, mainFrameNavigations: 0,
    domContentLoaded: 0, beforeClick: null, afterClick: null, onFailure: null,
    x11BeforeClick: null, x11AfterClick: null, x11OnFailure: null };
  let captureAuthInput = null;
  const captureX11Window = async () => {
    if (process.platform !== 'linux' || !process.env.DISPLAY || !application) return { available: false };
    try {
      const nativeId = await application.evaluate(({ BrowserWindow }) => {
        const window = BrowserWindow.getAllWindows()[0];
        const handle = window?.getNativeWindowHandle();
        return handle?.length >= 4 ? handle.readUInt32LE(0) : null;
      });
      const query = spawnSync('xprop', ['-root', '_NET_ACTIVE_WINDOW'],
        { encoding: 'utf8', timeout: 2000, maxBuffer: 4096 });
      const matches = query.status === 0 ? x11ActiveWindowMatches(query.stdout, nativeId) : null;
      return { available: matches !== null, matchesNative: matches };
    } catch {
      return { available: false };
    }
  };
  const raw = path.join(c.output, 'resources.jsonl');
  const writeAttempt = (status, code = null) => fs.writeFileSync(path.join(c.output, 'attempt.json'), JSON.stringify({
    status, stage, code, securityFacts, loginStatus, onboardingDismissed, failureUi,
    blockedExternalRequests, networkFailures, runtimeErrors,
    historyProgress, authInteraction, loginRequests, nativeFocusFacts,
    authInputTransition, bridgeCommit: c.bridgeCommit, executed: summarize(report).executed,
  }, null, 2));
  try {
    const { _electron } = requireE2e('playwright');
    const launchStart = performance.now();
    application = await _electron.launch({ executablePath: c.executable, chromiumSandbox: true,
      args: [`--user-data-dir=${profile}`], timeout: 45000 });
    stage = 'PRODUCT_WINDOW';
    const page = await application.firstWindow();
    pageRef = page;
    page.on('framenavigated', frame => {
      if (frame === page.mainFrame()) authInputTransition.mainFrameNavigations++;
    });
    page.on('domcontentloaded', () => { authInputTransition.domContentLoaded++; });
    captureAuthInput = async () => {
      try {
        return closedAuthInputGeometry(await page.evaluate(() => {
          const button = document.querySelector('#login-form [data-auth-action="login"]');
          const docFocused = document.hasFocus();
          if (!(button instanceof HTMLElement)) return {
            buttonPresent: false, documentFocused: docFocused,
          };
          const box = button.getBoundingClientRect();
          const x = box.left + box.width / 2;
          const y = box.top + box.height / 2;
          const inViewport = box.width > 0 && box.height > 0 &&
            x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
          const top = inViewport ? document.elementFromPoint(x, y) : null;
          return {
            buttonPresent: true, buttonEnabled: !button.hasAttribute('disabled'),
            buttonVisible: box.width > 0 && box.height > 0 &&
              getComputedStyle(button).visibility !== 'hidden',
            buttonCenterInViewport: inViewport,
            hitIsLoginButton: Boolean(top && (top === button || button.contains(top))),
            documentFocused: docFocused,
          };
        }));
      } catch { return { unavailable: true }; }
    };
    await page.route('**/*', route => {
      const request = route.request();
      if (isolatedRequestAllowed(request.url(), request.method(), c.origin)) return route.continue();
      blockedExternalRequests++;
      return route.abort('blockedbyclient');
    });
    const failureCodes = new Set(['net::ERR_CERT_AUTHORITY_INVALID','net::ERR_CONNECTION_REFUSED','net::ERR_FAILED',
      'net::ERR_BLOCKED_BY_CLIENT','net::ERR_BLOCKED_BY_RESPONSE','net::ERR_ABORTED','net::ERR_SSL_PROTOCOL_ERROR']);
    page.on('requestfailed', request => {
      const u = new URL(request.url());
      if (!u.pathname.startsWith('/api/') && request.resourceType() !== 'script') return;
      const text = request.failure()?.errorText;
      networkFailures.push({ kind: u.pathname === '/api/login' ? 'login' : request.resourceType() === 'script' ? 'script' : 'api',
        code: failureCodes.has(text) ? text : 'NETWORK_FAILURE' });
    });
    page.on('pageerror', error => {
      const allowed = new Set(['TypeError','ReferenceError','SyntaxError','SecurityError','Error']);
      runtimeErrors.push({ type: allowed.has(error.name) ? error.name : 'RUNTIME_ERROR' });
    });
    page.on('request', request => {
      if (new URL(request.url()).pathname === '/api/login' && request.method() === 'POST') loginRequests++;
    });
    page.on('response', response => {
      if (new URL(response.url()).pathname === '/api/login' && response.request().method() === 'POST') loginStatus = response.status();
    });
    page.setDefaultTimeout(30000);
    await page.waitForURL(url => url.origin === c.origin, { waitUntil: 'domcontentloaded' });
    stage = 'PACKAGED_IDENTITY';
    const identity = await application.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged, appPath: app.getAppPath(), appVersion: app.getVersion(),
      insecure: ['no-sandbox', 'ignore-certificate-errors', 'disable-web-security']
        .some(flag => app.commandLine.hasSwitch(flag)),
      windows: BrowserWindow.getAllWindows().map(w => {
        const p = w.webContents.getLastWebPreferences();
        return { sandbox: p.sandbox, contextIsolation: p.contextIsolation, nodeIntegration: p.nodeIntegration };
      }),
    }));
    securityFacts = { packaged: identity.packaged, asar: identity.appPath.endsWith('app.asar'),
      insecureSwitchPresent: identity.insecure, windowCount: identity.windows.length,
      secureWindowCount: identity.windows.filter(w => w.sandbox && w.contextIsolation && !w.nodeIntegration).length };
    validateIdentity(identity);
    const asarSha256 = createHash('sha256').update(fs.readFileSync(identity.appPath)).digest('hex');
    requireFact(new URL(page.url()).origin === c.origin, 'PRODUCT_ORIGIN');
    stage = 'SERVED_UI_IDENTITY';
    const servedUi = await page.evaluate(async () => {
      const script = document.querySelector('script[type="module"][src]');
      if (!script || new URL(script.src).origin !== location.origin) throw Error('UI_IDENTITY');
      const response = await fetch(script.src, { cache: 'no-store' });
      if (!response.ok) throw Error('UI_IDENTITY');
      const bytes = await response.arrayBuffer();
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return { sha256: [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join(''), bytes: bytes.byteLength };
    });
    requireFact(/^[a-f0-9]{64}$/.test(servedUi.sha256) && servedUi.bytes > 0, 'UI_IDENTITY');
    stage = 'AUTH_RUNTIME_READY';
    await page.waitForFunction(() => typeof globalThis.login === 'function');
    requireFact(await page.evaluate(() => {
      try { return !globalThis.BRIDGE_API || new URL(globalThis.BRIDGE_API).origin === location.origin; }
      catch { return false; }
    }), 'AUTH_ORIGIN_PRECONDITION');
    stage = 'AUTH_WINDOW_FOCUS';
    // Native input requires a foreground window. Activate the actual app,
    // never force a DOM click or substitute an authentication request.
    await page.bringToFront();
    await application.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].focus(); });
    await page.waitForFunction(() => document.hasFocus());
    nativeFocusFacts = await application.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      return { focused: window.isFocused(), visible: window.isVisible() };
    });
    requireFact(nativeFocusFacts.focused && nativeFocusFacts.visible, 'NATIVE_WINDOW_FOCUS');
    stage = 'AUTH_FORM';
    await page.locator('#l-username').waitFor({ state: 'visible' });
    const instrumentedLoginUiMs = performance.now() - launchStart;
    // Observe only closed event counts, never input values, event text or URLs.
    // A successful driver click is not proof that the product delegate ran.
    await page.evaluate(() => {
      const counts = { pointerDown: 0, capturedClick: 0, bubbledClick: 0, anyPointerDown: 0, anyCapturedClick: 0, lastPointerTarget: 'none', lastClickTarget: 'none' };
      const matches = event => event.target instanceof Element &&
        Boolean(event.target.closest('#login-form [data-auth-action="login"]'));
      const category = event => matches(event) ? 'login' : event.target instanceof Element && event.target.closest('#l-username,#l-password') ? 'credential-field' : 'other';
      const down = event => { counts.anyPointerDown++; counts.lastPointerTarget = category(event); if (matches(event)) counts.pointerDown++; };
      const capture = event => { counts.anyCapturedClick++; counts.lastClickTarget = category(event); if (matches(event)) counts.capturedClick++; };
      const bubble = event => { if (matches(event)) counts.bubbledClick++; };
      document.addEventListener('pointerdown', down, true);
      document.addEventListener('click', capture, true);
      document.addEventListener('click', bubble);
      window.__bridgePerfAuth = { counts, stop() {
        document.removeEventListener('pointerdown', down, true);
        document.removeEventListener('click', capture, true);
        document.removeEventListener('click', bubble);
      } };
    });
    stage = 'AUTH_USERNAME';
    await page.locator('#l-username').fill(c.username);
    stage = 'AUTH_PASSWORD';
    await page.locator('#l-password').fill(c.password);
    const login = page.waitForResponse(r => new URL(r.url()).pathname === '/api/login' && r.request().method() === 'POST')
      .then(response => ({ response }), () => ({ unavailable: true }));
    stage = 'AUTH_SUBMIT';
    authInputTransition.beforeClick = await captureAuthInput();
    authInputTransition.x11BeforeClick = await captureX11Window();
    await page.locator('#login-form [data-auth-action="login"]').click();
    authInputTransition.clickResolved = true;
    authInputTransition.afterClick = await captureAuthInput();
    authInputTransition.x11AfterClick = await captureX11Window();
    stage = 'AUTH_RESPONSE';
    const loginResult = await login;
    requireFact(!loginResult.unavailable, 'AUTH_RESPONSE_UNAVAILABLE');
    requireFact(loginResult.response.status() === 200, 'AUTHENTICATION_REJECTED');
    authInteraction = await page.evaluate(() => {
      const state = window.__bridgePerfAuth; state.stop(); return state.counts;
    });
    stage = 'INITIAL_ONBOARDING';
    // A fresh account may show the ordinary first-use tour. Dismiss only its
    // actual visible Skip button; do not inject a completion key or credentials.
    const tour = page.locator('.ow-backdrop .ow-btn-ghost');
    try { await tour.waitFor({ state: 'visible', timeout: 3000 }); }
    catch (error) { if (error?.name !== 'TimeoutError') throw error; }
    if (await tour.isVisible()) { await tour.click(); onboardingDismissed = true; }
    stage = 'SERVER_SELECT';
    await page.locator(`.server-icon[data-id="${c.server}"]`).click();
    const selectChannel = id => page.locator(`.ch-item[data-id="${id}"] .ch-open`).click();
    stage = 'IDLE_CHANNEL_SELECT';
    await selectChannel(c.idleChannel);
    stage = 'IDLE_MESSAGE_VISIBLE';
    await page.locator('.msg-list .msg').first().waitFor({ state: 'visible' });
    await sleep(10000); // fixed warmup, not included in scenario duration

    const measure = async (id, activity) => {
      const scenario = SCENARIOS.find(s => s.id === id);
      const startedAt = new Date().toISOString();
      const start = performance.now();
      const end = start + scenario.durationSec * 1000;
      const samples = { cpuPerProcess: [], ram: [], growth: [] };
      // Prime CPU interval; the first getAppMetrics interval is not a measurement.
      await application.evaluate(({ app }) => app.getAppMetrics());
      const historyCodes = new Set(['HISTORY_HTTP_STATUS','HISTORY_RESPONSE_SHAPE','HISTORY_RESPONSE_INVALID',
        'HISTORY_TRAVERSAL_INCOMPLETE','HISTORY_ENDPOINT_NOT_IN_VIEWPORT','SCROLL_SAMPLES_MISSING',
        'CONTAINMENT_NOT_EXERCISED','HISTORY_KEYBOARD_FAILED','HISTORY_DOM_WINDOW_UNBOUNDED','UI_IDENTITY']);
      const work = activity ? activity(end).then(value => ({ value }), error => ({ failed: true,
        code: historyCodes.has(error?.message) ? error.message : error?.name === 'TimeoutError' ? 'HISTORY_DRIVER_TIMEOUT' : 'HISTORY_ACTIVITY_FAILED' })) : Promise.resolve({});
      while (performance.now() < end) {
        await sleep(1000);
        const elapsedSec = (performance.now() - start) / 1000;
        const sample = normalizeMetrics(await application.evaluate(({ app }) => app.getAppMetrics()), elapsedSec);
        fs.appendFileSync(raw, JSON.stringify({ scenario: id, ...sample }) + '\n');
        samples.cpuPerProcess.push({ elapsedSec, processes: sample.processes.map(({ pid, type, cpuPercent }) => ({ pid, type, cpuPercent })) });
        samples.ram.push({ elapsedSec, processes: sample.processes.map(({ pid, type, workingSetKiB }) => ({ pid, type, workingSetKiB })) });
        samples.growth.push({ elapsedSec, cpuPercent: sample.cpuPercent, workingSetKiB: sample.workingSetKiB });
      }
      const result = await work;
      requireFact(!result.failed, result.code || 'HISTORY_ACTIVITY_FAILED');
      if (activity) samples.scroll = result.value.samples;
      const entry = { id, title: scenario.title, status: 'EXECUTED', samples,
        provenance: { os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
          osVersion: os.release(), bridgeCommit: c.bridgeCommit, appVersion: identity.appVersion,
          machine: os.hostname(), startedAt, endedAt: new Date().toISOString(),
          durationSec: (performance.now() - start) / 1000, asarSha256, uiEntrySha256: servedUi.sha256,
          environment: process.env.GITHUB_ACTIONS === 'true' ? 'hosted CI VM' : 'operator host',
          display: process.env.XDG_SESSION_TYPE || (process.env.DISPLAY ? 'X11' : 'unspecified'),
          windowManager: process.env.BRIDGE_PERF_WINDOW_MANAGER === 'openbox' ? 'openbox' : 'unverified',
          instrumentation: id === 'PA01' ? 'Playwright main-process inspector' : 'Playwright main-process inspector + renderer observer',
          instrumentedLoginUiMs, ...result.value?.evidence } };
      report.scenarios[report.scenarios.findIndex(s => s.id === id)] = entry;
      requireFact(validateReport(report).ok, 'REPORT_INVALID');
      fs.writeFileSync(path.join(c.output, 'report.json'), JSON.stringify(report, null, 2));
    };

    stage = 'PA01_IDLE';
    await measure('PA01');
    stage = 'PA08_HISTORY';
    await measure('PA08', async end => {
      historyProgress = { responses: 0, statusCounts: {}, uniqueMessages: 0, newestVisible: false, oldestVisible: false,
        profilerAvailable: false };
      let profiler;
      const metricNames = new Set(['LayoutDuration','RecalcStyleDuration','ScriptDuration','TaskDuration',
        'JSHeapUsedSize','JSHeapTotalSize','Nodes','Documents','JSEventListeners']);
      const metrics = async () => Object.fromEntries((await profiler.send('Performance.getMetrics')).metrics
        .filter(m => metricNames.has(m.name) && Number.isFinite(m.value)).map(m => [m.name, m.value]));
      try {
        profiler = await page.context().newCDPSession(page);
        await profiler.send('Performance.enable');
        historyProgress.rendererBefore = await metrics();
        historyProgress.profilerAvailable = true;
      } catch { historyProgress.profilerAvailable = false; }
      const inViewport = async id => {
        const locator = page.locator(`.msg-list .msg[data-id="${id}"]`);
        // Virtualized rows retain lightweight scroll anchors. Reach the actual
        // endpoint with the product scroll handler before querying its article.
        if (await locator.count() === 0) {
          await page.locator('#messages-area').evaluate((el, bottom) => {
            el.scrollTop = bottom ? el.scrollHeight : 0; el.dispatchEvent(new Event('scroll'));
          }, id === `${c.messagePrefix}10000`);
          await locator.waitFor({ state: 'visible' });
        }
        await locator.scrollIntoViewIfNeeded();
        const geometry = await locator.evaluate(el => {
          const r = el.getBoundingClientRect();
          const scroller = document.getElementById('messages-area');
          const view = scroller.getBoundingClientRect();
          return { width: r.width, height: r.height, top: r.top, bottom: r.bottom,
            viewportTop: view.top, viewportBottom: view.bottom, scrollTop: scroller.scrollTop, scrollHeight: scroller.scrollHeight };
        });
        historyProgress.lastViewportCheck = { endpoint: id.endsWith('00001') ? 'oldest' : 'newest', ...geometry };
        requireFact(geometry.width > 0 && geometry.height > 0 && geometry.bottom > geometry.viewportTop && geometry.top < geometry.viewportBottom,
          'HISTORY_ENDPOINT_NOT_IN_VIEWPORT');
      };
      const seen = new Set();
      const pending = new Set();
      let invalidResponse = false;
      let responseFailure = null;
      const onResponse = response => {
        const url = new URL(response.url());
        if (url.origin !== c.origin || url.pathname !== `/api/channels/${c.historyChannel}/messages`) return;
        const task = (async () => {
          historyProgress.responses++;
          historyProgress.statusCounts[response.status()] = (historyProgress.statusCounts[response.status()] || 0) + 1;
          requireFact(response.status() === 200, 'HISTORY_HTTP_STATUS');
          const data = await response.json();
          requireFact(Array.isArray(data.messages), 'HISTORY_RESPONSE_SHAPE');
          for (const message of data.messages) {
            if (typeof message._id === 'string' && message._id.startsWith(c.messagePrefix)) seen.add(message._id);
          }
          historyProgress.uniqueMessages = seen.size;
        })().catch(error => { invalidResponse = true;
          responseFailure = ['HISTORY_HTTP_STATUS','HISTORY_RESPONSE_SHAPE'].includes(error?.message) ? error.message : 'HISTORY_RESPONSE_INVALID'; });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      };
      page.on('response', onResponse);
      try {
        await page.evaluate(() => {
          if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) throw Error('LONGTASK_UNAVAILABLE');
          const state = window.__bridgePerf = { frames: [], longTasks: [], last: performance.now(), running: true,
            skipped: new Set(), skippedPeak: 0, mountedPeak: 0 };
          state.onContainment = event => {
            if (!event.target.classList.contains('msg-contained')) return;
            if (event.skipped) state.skipped.add(event.target); else state.skipped.delete(event.target);
            state.skippedPeak = Math.max(state.skippedPeak, state.skipped.size);
          };
          document.addEventListener('contentvisibilityautostatechange', state.onContainment, true);
          state.observer = new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(e => e.duration)));
          state.observer.observe({ type: 'longtask' });
          const frame = time => { if (!state.running) return; state.frames.push(time - state.last); state.last = time; state.mountedPeak = Math.max(state.mountedPeak, document.querySelectorAll('.msg-list .msg').length); requestAnimationFrame(frame); };
          requestAnimationFrame(frame);
        });
        const loadStart = performance.now();
        await selectChannel(c.historyChannel);
        await page.locator(`.msg-list .msg[data-id="${c.messagePrefix}10000"]`).waitFor({ state: 'visible' });
        await inViewport(`${c.messagePrefix}10000`);
        historyProgress.newestVisible = true;
        const firstPageVisibleMs = performance.now() - loadStart;
        let traversalMs = null;
        let direction = 0;
        while (performance.now() < end) {
          requireFact(!invalidResponse, responseFailure || 'HISTORY_RESPONSE_INVALID');
          if (seen.size === 10000 && traversalMs === null) {
            await inViewport(`${c.messagePrefix}00001`);
            historyProgress.oldestVisible = true;
            traversalMs = performance.now() - loadStart;
          }
          await page.locator('#messages-area').evaluate((el, down) => {
            el.scrollTop = down ? el.scrollHeight : 0;
            el.dispatchEvent(new Event('scroll'));
          }, seen.size === 10000 && (direction++ % 2 === 0));
          await sleep(200);
        }
        await Promise.all([...pending]);
        requireFact(!invalidResponse && seen.size === 10000 && traversalMs !== null, 'HISTORY_TRAVERSAL_INCOMPLETE');
        await inViewport(`${c.messagePrefix}10000`);
        await page.locator(`.msg-list .msg[data-id="${c.messagePrefix}10000"]`).focus();
        await page.keyboard.press('ArrowUp');
        try {
          await page.waitForFunction(id => document.activeElement?.getAttribute('data-id') === id,
            `${c.messagePrefix}09999`, { timeout: 2000 });
        } catch { throw new Error('HISTORY_KEYBOARD_FAILED'); }
        const observed = await page.evaluate(() => {
          const s = window.__bridgePerf; s.running = false; s.observer.disconnect();
          document.removeEventListener('contentvisibilityautostatechange', s.onContainment, true);
          return { frames: s.frames, longTasks: s.longTasks, skippedPeak: s.skippedPeak, mountedPeak: s.mountedPeak };
        });
        requireFact(observed.frames.length >= 3 && observed.frames.every(Number.isFinite), 'SCROLL_SAMPLES_MISSING');
        requireFact(observed.skippedPeak > 0, 'CONTAINMENT_NOT_EXERCISED');
        requireFact(observed.mountedPeak > 0 && observed.mountedPeak <= 240, 'HISTORY_DOM_WINDOW_UNBOUNDED');
        return { samples: observed.frames.map(frameTimeMs => ({ frameTimeMs })), evidence: {
          firstPageVisibleMs, traversalMs, uniqueMessagesObserved: seen.size,
          newestAndOldestVisible: true,
          keyboardNavigation: true, offscreenSkippedPeak: observed.skippedPeak, mountedMessagePeak: observed.mountedPeak,
          longTaskDurationsMs: observed.longTasks, persistedFixtureCount: c.seededMessages,
          scrollMethod: 'actual product scroll handler; authenticated network responses; no registry calls',
        } };
      } finally {
        page.off('response', onResponse);
        try {
          historyProgress.containment = await page.evaluate(() => {
            const s = window.__bridgePerf;
            if (s) {
              s.running = false; s.observer.disconnect();
              document.removeEventListener('contentvisibilityautostatechange', s.onContainment, true);
            }
            return { supported: CSS.supports('content-visibility', 'auto'),
              eligibleRows: document.querySelectorAll('.msg-contained').length, skippedPeak: s?.skippedPeak ?? 0,
              scrollAnchors: document.querySelectorAll('[data-message-viewport-id]').length, mountedPeak: s?.mountedPeak ?? 0 };
          });
        } catch { historyProgress.containment = { unavailable: true }; }
        if (profiler) {
          try { historyProgress.rendererAfter = await metrics(); } catch { historyProgress.profilerAfterUnavailable = true; }
          await profiler.detach().catch(() => {});
        }
      }
    });
    stage = 'SUBSET_COMPLETE';
    writeAttempt('EXECUTED');
    console.log(JSON.stringify({ subset: ['PA01', 'PA08'], status: 'EXECUTED', ...summarize(report), performanceThresholdsQualified: false }));
    return report;
  } catch (error) {
    // WebDriver errors can include typed credentials. Never publish messages,
    // stacks, traces, screenshots or browser storage from authentication.
    if (pageRef && !pageRef.isClosed()) {
      if (captureAuthInput) authInputTransition.onFailure = await captureAuthInput();
      authInputTransition.x11OnFailure = await captureX11Window();
      try {
        authInteraction = await pageRef.evaluate(() => {
          const state = window.__bridgePerfAuth;
          if (!state) return null;
          state.stop(); return state.counts;
        });
        failureUi = await pageRef.evaluate(() => {
          const visible = selector => {
            const el = document.querySelector(selector);
            return Boolean(el && el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden');
          };
          return { documentReady: document.readyState === 'complete', documentFocused: document.hasFocus(),
            loginButtonCount: document.querySelectorAll('#login-form [data-auth-action="login"]').length,
            loginButtonDisabled: Boolean(document.querySelector('#login-form [data-auth-action="login"]')?.disabled),
            authMessagePresent: Boolean(document.querySelector('#auth-msg')?.textContent?.trim()),
            loginFormVisible: visible('#login-form'), usernameVisible: visible('#l-username'),
            passwordVisible: visible('#l-password'), onboardingVisible: visible('.ow-backdrop'),
            loginFunctionReady: typeof globalThis.login === 'function',
            usernamePopulated: Boolean(document.querySelector('#l-username')?.value),
            passwordPopulated: Boolean(document.querySelector('#l-password')?.value),
            moduleScriptCount: document.querySelectorAll('script[type="module"]').length,
            modalCount: document.querySelectorAll('[role="dialog"][aria-modal="true"]').length,
            serverCount: document.querySelectorAll('.server-icon[data-id]').length,
            channelCount: document.querySelectorAll('.ch-item[data-id]').length,
            messageCount: document.querySelectorAll('.msg-list .msg').length };
        });
      } catch { failureUi = { unavailable: true }; }
    }
    const closedCodes = new Set(['PACKAGED_SECURITY_PRECONDITION','PRODUCT_ORIGIN','AUTHENTICATION_REJECTED',
      'AUTH_ORIGIN_PRECONDITION','AUTH_RESPONSE_UNAVAILABLE','NATIVE_WINDOW_FOCUS',
      'HISTORY_HTTP_STATUS','HISTORY_RESPONSE_SHAPE','HISTORY_RESPONSE_INVALID','HISTORY_TRAVERSAL_INCOMPLETE',
      'HISTORY_ENDPOINT_NOT_IN_VIEWPORT','SCROLL_SAMPLES_MISSING','HISTORY_DRIVER_TIMEOUT',
      'CONTAINMENT_NOT_EXERCISED','HISTORY_KEYBOARD_FAILED','HISTORY_DOM_WINDOW_UNBOUNDED','UI_IDENTITY',
      'PROCESS_METRICS_MISSING','PROCESS_METRIC_INVALID','HISTORY_ACTIVITY_FAILED','REPORT_INVALID']);
    const code = closedCodes.has(error?.message) ? error.message : error?.name === 'TimeoutError' ? 'DRIVER_TIMEOUT' : 'DRIVER_OR_RUNTIME_FAILURE';
    writeAttempt('FAIL', code);
    console.error(`PACKAGED_PERF_FAILED:${stage}:${code}`);
    throw new Error('PACKAGED_PERF_FAILED');
  } finally {
    if (application) await application.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv[2]) {
    console.error('PACKAGED_PERF_NOT_EXECUTED:CONFIG_REQUIRED');
    process.exitCode = 3;
  } else {
    try { await runPackaged(JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))); }
    catch { console.error('PACKAGED_PERF_NOT_QUALIFIED'); process.exitCode = 1; }
  }
}
