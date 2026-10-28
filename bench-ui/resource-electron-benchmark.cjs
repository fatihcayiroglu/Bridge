'use strict';
// Windows/macOS/Linux Electron process measurements using the SAME synthetic
// React/Svelte UI and actual LOCAL audio/video RTCPeerConnection RTP.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { verify } = require('./resource-report.cjs');
const generated = join(__dirname, 'generated');
const variants = ['svelte', 'react'];
const scenarios = ['idle', 'messages', 'voice2', 'voice5', 'voice10',
  'video2', 'screen2', 'voice2_chat'];
const WARMUPS = 1;
const ITERATIONS = 5;
const windows = {};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
// Between scenarios there are intentionally no windows for a moment. Keep
// Electron alive on Windows/Linux so the next isolated scenario can start.
app.on('window-all-closed', () => {});

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length || sorted.some(x => !Number.isFinite(x) || x < 0)) {
    throw new Error('RESOURCE_INVALID_SAMPLES');
  }
  return Number(sorted[Math.ceil(ratio * sorted.length) - 1].toFixed(3));
}
function summarize(samples, prop) {
  const v = samples.map(s => s[prop]);
  if (v.length !== ITERATIONS) throw new Error('RESOURCE_SAMPLE_COUNT_INVALID');
  return { samples: v.length, p50: percentile(v, 0.5), p95: percentile(v, 0.95) };
}
async function start(name) {
  const ui = readFileSync(join(generated, name + '.js'), 'utf8');
  const workload = readFileSync(join(__dirname, 'resource-media-runtime.js'), 'utf8');
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{font:14px Arial;margin:0}article{height:28px;display:flex;gap:12px;border-bottom:1px solid #ddd}' +
    '.author{font-weight:600;width:85px}</style></head><body><div id="root"></div>' +
    '<script>' + ui + '</script><script>' + workload + '</script></body></html>';
  const win = new BrowserWindow({
    width: 1280, height: 800, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true,
      sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(
    'new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{' +
    'if(typeof window.__bench?.reset==="function"&&typeof window.__resourceBench?.prepare==="function")' +
    '{clearInterval(t);resolve(true)}else if(++n>=100){clearInterval(t);' +
    'reject(new Error("RESOURCE_BENCH_NOT_READY"))}},100)})');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  return win;
}
async function taskDuration(win) {
  const { metrics } = await win.webContents.debugger.sendCommand('Performance.getMetrics');
  const t = metrics?.find(x => x.name === 'TaskDuration')?.value;
  if (!Number.isFinite(t) || t < 0) throw new Error('RESOURCE_TASK_DURATION_MISSING');
  return t;
}
function cpuAndMemory(win, beforeMetrics, afterMetrics) {
  const pid = win.webContents.getOSProcessId();
  const before = beforeMetrics.find(x => x.pid === pid);
  const after = afterMetrics.find(x => x.pid === pid);
  const cpuPercent = after?.cpu?.percentCPUUsage;
  const workingSetKB = after?.memory?.workingSetSize;
  if (!Number.isFinite(cpuPercent) || cpuPercent < 0 ||
      !Number.isFinite(workingSetKB) || workingSetKB <= 0) {
    throw new Error('RESOURCE_OS_CPU_OR_RAM_NOT_MEASURED ' + JSON.stringify({
      rendererFoundBefore: !!before,
      rendererFoundAfter: !!after,
      cpuPercentValid: Number.isFinite(cpuPercent) && cpuPercent >= 0,
      workingSetValid: Number.isFinite(workingSetKB) && workingSetKB > 0,
      processKinds: afterMetrics.map(x => x.type),
    }));
  }
  const cumulativeBefore = before?.cpu?.cumulativeCPUUsage;
  const cumulativeAfter = after?.cpu?.cumulativeCPUUsage;
  const cpuSeconds = Number.isFinite(cumulativeBefore) && Number.isFinite(cumulativeAfter) &&
    cumulativeAfter >= cumulativeBefore ? Number((cumulativeAfter - cumulativeBefore).toFixed(4)) : null;
  // The GPU process is shared by all windows. It cannot be attributed to one
  // renderer, so it is expressly NOT a comparative GPU-percentage result.
  return {
    rendererCpuIntervalPercent: Number(cpuPercent.toFixed(3)),
    rendererCpuIntervalSeconds: cpuSeconds,
    rendererWorkingSetMB: Number((workingSetKB / 1024).toFixed(3)),
  };
}

async function measure(name, mode, round) {
  const win = windows[name];
  win.show();
  win.focus();
  await win.webContents.executeJavaScript('window.__resourceBench.prepare(' + JSON.stringify(mode) + ')');
  try {
    const metricsBefore = app.getAppMetrics();
    const taskBefore = await taskDuration(win);
    const result = await win.webContents.executeJavaScript(
      'window.__resourceBench.execute(' + JSON.stringify(mode) + ')');
    const taskAfter = await taskDuration(win);
    const metricsAfter = app.getAppMetrics();
    const taskSeconds = taskAfter - taskBefore;
    if (result?.mode !== mode || result.measuredMs < 1200 ||
        !Number.isFinite(taskSeconds) || taskSeconds < 0) {
      throw new Error('RESOURCE_SCENARIO_NOT_MEASURED_' + mode +
        ' ' + JSON.stringify({
          measuredMs: result?.measuredMs ?? null,
          returnedMode: result?.mode ?? null,
          rendererTaskDeltaSeconds: Number.isFinite(taskSeconds) ? taskSeconds : null,
        }));
    }
    return {
      round, mode,
      measuredMs: Number(result.measuredMs.toFixed(3)),
      uiWorkMs: Number(result.uiWorkMs.toFixed(3)),
      rendererTaskSeconds: Number(taskSeconds.toFixed(6)),
      audio: result.audio, video: result.video,
      // The first round is explicitly a warmup, not one of the five accepted
      // samples. Some Windows hosts initially report no renderer CPU/RAM.
      // All FIVE recorded rounds still require genuine process metrics.
      ...(round === 0 ? {} : cpuAndMemory(win, metricsBefore, metricsAfter)),
    };
  } finally {
    await win.webContents.executeJavaScript('window.__resourceBench.teardown()');
  }
}
async function run() {
  const data = {};
  for (const mode of scenarios) {
    // Open clean renderer processes for EVERY workload. Otherwise 10,800
    // message nodes and GC from an earlier mode contaminate later RAM values.
    try {
      for (const name of variants) windows[name] = await start(name);
      const samples = Object.fromEntries(variants.map(name => [name, []]));
      for (let round = 0; round < WARMUPS + ITERATIONS; round++) {
        const order = round % 2 ? [...variants].reverse() : variants;
        for (const name of order) {
          if (round === 0) console.log('RESOURCE_SCENARIO_START ' + JSON.stringify({ mode, name }));
          const sample = await measure(name, mode, round);
          if (round >= WARMUPS) samples[name].push(sample);
        }
      }
      data[mode] = { variants: {} };
      for (const name of variants) {
        const s = samples[name];
        data[mode].variants[name] = {
          samples: s,
          cpuPercent: summarize(s, 'rendererCpuIntervalPercent'),
          workingSetMB: summarize(s, 'rendererWorkingSetMB'),
          taskSeconds: summarize(s, 'rendererTaskSeconds'),
          measuredMs: summarize(s, 'measuredMs'),
          uiWorkMs: summarize(s, 'uiWorkMs'),
        };
      }
    } finally {
      for (const name of variants) {
        const win = windows[name];
        if (win && !win.isDestroyed()) {
          if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach();
          win.destroy();
        }
        delete windows[name];
      }
    }
  }
  const report = {
    scope: 'synthetic Svelte/React UI and actual LOCAL WebRTC RTP; NOT a full feature-equivalent Bridge client',
    mediaDefinition: 'voice2/voice5/voice10 use 1/4/9 local point-to-point RTP links, NOT a real multiuser SFU or remote users',
    videoDefinition: 'video2 and screen2 are generated 15fps canvas streams, NOT physical camera/OS screen capture/system audio',
    cpuDefinition: 'Electron CPUUsage.percentCPUUsage averaged over bounded renderer interval; NOT whole-app CPU or battery',
    ramDefinition: 'Electron renderer process working-set snapshots, NOT total application memory or GPU process memory',
    latencyDefinition: 'local ICE candidate RTT only when actually present; NOT acoustic end-to-end/real network latency',
    platform: process.platform,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    warmups: WARMUPS,
    iterations: ITERATIONS,
    scenarios: data,
  };
  verify(report);
  writeFileSync(join(generated, 'resource-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('RESOURCE_AB_RESULT ' + JSON.stringify(report));
}

let timer;
app.whenReady().then(async () => {
  timer = setTimeout(() => { console.error('RESOURCE_AB_DEADLINE'); app.exit(1); }, 28 * 60_000);
  try {
    await run();
    clearTimeout(timer);
    for (const win of Object.values(windows)) win.destroy();
    app.quit();
  } catch (error) {
    console.error('RESOURCE_AB_FAILED', error);
    clearTimeout(timer);
    app.exit(1);
  }
}).catch(error => { console.error('RESOURCE_AB_APP_FAILED', error); app.exit(1); });
