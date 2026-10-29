// Real packaged desktop PA01/PA08 executor. No application mocks, token
// injection, browser security overrides, duration overrides or invented metrics.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
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
  let stage = 'LAUNCH';
  let securityFacts = null;
  const raw = path.join(c.output, 'resources.jsonl');
  const writeAttempt = (status, code = null) => fs.writeFileSync(path.join(c.output, 'attempt.json'), JSON.stringify({
    status, stage, code, securityFacts, bridgeCommit: c.bridgeCommit, executed: summarize(report).executed,
  }, null, 2));
  try {
    const { _electron } = requireE2e('playwright');
    const launchStart = performance.now();
    application = await _electron.launch({ executablePath: c.executable, chromiumSandbox: true,
      args: [`--user-data-dir=${profile}`], timeout: 45000 });
    stage = 'PRODUCT_WINDOW';
    const page = await application.firstWindow();
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
    stage = 'AUTHENTICATE';
    await page.locator('#l-username').waitFor({ state: 'visible' });
    const instrumentedLoginUiMs = performance.now() - launchStart;
    await page.locator('#l-username').fill(c.username);
    await page.locator('#l-password').fill(c.password);
    const login = page.waitForResponse(r => new URL(r.url()).pathname === '/api/login' && r.request().method() === 'POST');
    await page.locator('#login-form [data-auth-action="login"]').click();
    requireFact((await login).status() === 200, 'AUTHENTICATION_REJECTED');
    await page.locator(`.server-icon[data-id="${c.server}"]`).click();
    const selectChannel = id => page.locator(`.ch-item[data-id="${id}"] .ch-open`).click();
    await selectChannel(c.idleChannel);
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
      const work = activity ? activity(end).then(value => ({ value }), () => ({ failed: true })) : Promise.resolve({});
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
      requireFact(!result.failed, 'HISTORY_ACTIVITY_FAILED');
      if (activity) samples.scroll = result.value.samples;
      const entry = { id, title: scenario.title, status: 'EXECUTED', samples,
        provenance: { os: process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux',
          osVersion: os.release(), bridgeCommit: c.bridgeCommit, appVersion: identity.appVersion,
          machine: os.hostname(), startedAt, endedAt: new Date().toISOString(),
          durationSec: (performance.now() - start) / 1000, asarSha256,
          environment: process.env.GITHUB_ACTIONS === 'true' ? 'hosted CI VM' : 'operator host',
          display: process.env.XDG_SESSION_TYPE || (process.env.DISPLAY ? 'X11' : 'unspecified'),
          instrumentation: 'Playwright main-process inspector + renderer observer',
          instrumentedLoginUiMs, ...result.value?.evidence } };
      report.scenarios[report.scenarios.findIndex(s => s.id === id)] = entry;
      requireFact(validateReport(report).ok, 'REPORT_INVALID');
      fs.writeFileSync(path.join(c.output, 'report.json'), JSON.stringify(report, null, 2));
    };

    stage = 'PA01_IDLE';
    await measure('PA01');
    stage = 'PA08_HISTORY';
    await measure('PA08', async end => {
      const inViewport = async id => {
        const locator = page.locator(`.msg-list .msg[data-id="${id}"]`);
        await locator.scrollIntoViewIfNeeded();
        requireFact(await locator.evaluate(el => {
          const r = el.getBoundingClientRect();
          const view = document.getElementById('messages-area').getBoundingClientRect();
          return r.width > 0 && r.height > 0 && r.bottom > view.top && r.top < view.bottom;
        }), 'HISTORY_ENDPOINT_NOT_IN_VIEWPORT');
      };
      const seen = new Set();
      const pending = new Set();
      let invalidResponse = false;
      const onResponse = response => {
        const url = new URL(response.url());
        if (url.origin !== c.origin || url.pathname !== `/api/channels/${c.historyChannel}/messages`) return;
        const task = (async () => {
          requireFact(response.status() === 200, 'HISTORY_HTTP_STATUS');
          const data = await response.json();
          requireFact(Array.isArray(data.messages), 'HISTORY_RESPONSE_SHAPE');
          for (const message of data.messages) {
            if (typeof message._id === 'string' && message._id.startsWith(c.messagePrefix)) seen.add(message._id);
          }
        })().catch(() => { invalidResponse = true; });
        pending.add(task);
        void task.finally(() => pending.delete(task));
      };
      page.on('response', onResponse);
      try {
        await page.evaluate(() => {
          if (!PerformanceObserver.supportedEntryTypes.includes('longtask')) throw Error('LONGTASK_UNAVAILABLE');
          const state = window.__bridgePerf = { frames: [], longTasks: [], last: performance.now(), running: true };
          state.observer = new PerformanceObserver(list => state.longTasks.push(...list.getEntries().map(e => e.duration)));
          state.observer.observe({ type: 'longtask' });
          const frame = time => { if (!state.running) return; state.frames.push(time - state.last); state.last = time; requestAnimationFrame(frame); };
          requestAnimationFrame(frame);
        });
        const loadStart = performance.now();
        await selectChannel(c.historyChannel);
        await page.locator(`.msg-list .msg[data-id="${c.messagePrefix}10000"]`).waitFor({ state: 'visible' });
        await inViewport(`${c.messagePrefix}10000`);
        const firstPageVisibleMs = performance.now() - loadStart;
        let traversalMs = null;
        let direction = 0;
        while (performance.now() < end) {
          requireFact(!invalidResponse, 'HISTORY_RESPONSE_INVALID');
          if (seen.size === 10000 && traversalMs === null) {
            await page.locator(`.msg-list .msg[data-id="${c.messagePrefix}00001"]`).waitFor({ state: 'visible' });
            await inViewport(`${c.messagePrefix}00001`);
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
        const observed = await page.evaluate(() => {
          const s = window.__bridgePerf; s.running = false; s.observer.disconnect();
          return { frames: s.frames, longTasks: s.longTasks };
        });
        requireFact(observed.frames.length >= 3 && observed.frames.every(Number.isFinite), 'SCROLL_SAMPLES_MISSING');
        return { samples: observed.frames.map(frameTimeMs => ({ frameTimeMs })), evidence: {
          firstPageVisibleMs, traversalMs, uniqueMessagesObserved: seen.size,
          newestAndOldestVisible: true,
          longTaskDurationsMs: observed.longTasks, persistedFixtureCount: c.seededMessages,
          scrollMethod: 'actual product scroll handler; authenticated network responses; no registry calls',
        } };
      } finally { page.off('response', onResponse); }
    });
    stage = 'SUBSET_COMPLETE';
    writeAttempt('EXECUTED');
    console.log(JSON.stringify({ subset: ['PA01', 'PA08'], status: 'EXECUTED', ...summarize(report), performanceThresholdsQualified: false }));
    return report;
  } catch (error) {
    // WebDriver errors can include typed credentials. Never publish messages,
    // stacks, traces, screenshots or browser storage from authentication.
    const closedCodes = new Set(['PACKAGED_SECURITY_PRECONDITION','PRODUCT_ORIGIN','AUTHENTICATION_REJECTED',
      'PROCESS_METRICS_MISSING','PROCESS_METRIC_INVALID','HISTORY_ACTIVITY_FAILED','REPORT_INVALID']);
    const code = closedCodes.has(error?.message) ? error.message : 'DRIVER_OR_RUNTIME_FAILURE';
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
