'use strict';

// Identical *synthetic* UI stress + *real local WebRTC RTP* under Electron.
// React/Svelte are the only variable; this does not implement React Bridge voice.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { verify } = require('./audio-report.cjs');

const generated = join(__dirname, 'generated');
const names = ['svelte', 'react'];
const WARMUPS = 2;
const ITERATIONS = 8;
const SAMPLE_SIZE = 10_000;
const UPDATES = 8;
const windows = {};

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

function percentile(values, ratio) {
  if (!values.length) throw new Error('AUDIO_NO_SAMPLES');
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(ratio * sorted.length) - 1].toFixed(4));
}

function summary(samples, key) {
  const values = samples.map(x => x[key]);
  if (values.length !== ITERATIONS || values.some(x => !Number.isFinite(x) || x < 0)) {
    throw new Error('AUDIO_BAD_METRIC_' + key);
  }
  return { samples: values.length, p50: percentile(values, 0.5), p95: percentile(values, 0.95) };
}

async function start(name) {
  const js = readFileSync(join(generated, name + '.js'), 'utf8');
  const audio = readFileSync(join(__dirname, 'audio-runtime.js'), 'utf8');
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{font:14px Arial;margin:0}article{height:28px;display:flex;gap:12px;border-bottom:1px solid #ddd}' +
    '.author{font-weight:600;width:85px}</style></head><body><div id="root"></div>' +
    '<script>' + js + '</script><script>' + audio + '</script></body></html>';
  const win = new BrowserWindow({
    width: 1280, height: 800, show: true,
    webPreferences: {
      nodeIntegration: false, contextIsolation: true, sandbox: true,
      backgroundThrottling: false,
    },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(
    'new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{' +
    'if(typeof window.__bench?.reset==="function"&&typeof window.__audioBench?.run==="function")' +
    '{clearInterval(t);resolve(true)}else if(++n>=100){clearInterval(t);' +
    'reject(new Error("AUDIO_BENCH_NOT_READY"))}},100)})');
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Performance.enable');
  return win;
}

async function taskDuration(win) {
  const { metrics } = await win.webContents.debugger.sendCommand('Performance.getMetrics');
  const task = metrics?.find(x => x.name === 'TaskDuration')?.value;
  if (!Number.isFinite(task) || task < 0) throw new Error('AUDIO_TASK_DURATION_UNAVAILABLE');
  return task;
}

function osSnapshot(win, beforeMetrics, afterMetrics) {
  const pid = win.webContents.getOSProcessId();
  const previous = beforeMetrics.find(item => item.pid === pid);
  const process = afterMetrics.find(item => item.pid === pid);
  const workingSetKB = process?.memory?.workingSetSize;
  // Electron CPUUsage uses percentCPUUsage, NOT percentCPU. The latter was
  // silently undefined in the first run and left all three OS CPU values null.
  // Both calls bound one measurement interval; never label this a peak/instant.
  const cpu = process?.cpu?.percentCPUUsage;
  const cpuBefore = previous?.cpu?.cumulativeCPUUsage;
  const cpuAfter = process?.cpu?.cumulativeCPUUsage;
  return {
    rendererWorkingSetMB: Number.isFinite(workingSetKB) && workingSetKB > 0
      ? Number((workingSetKB / 1024).toFixed(2)) : null,
    cpuIntervalPercent: Number.isFinite(cpu) && cpu >= 0 ? Number(cpu.toFixed(2)) : null,
    cpuIntervalSeconds: Number.isFinite(cpuBefore) && Number.isFinite(cpuAfter) &&
      cpuAfter >= cpuBefore ? Number((cpuAfter - cpuBefore).toFixed(6)) : null,
  };
}

async function measure(name, round) {
  const win = windows[name];
  win.show();
  win.focus();
  const metricsBefore = app.getAppMetrics();
  const before = await taskDuration(win);
  const result = await win.webContents.executeJavaScript(
    'window.__audioBench.run(' + SAMPLE_SIZE + ',' + UPDATES + ')');
  const after = await taskDuration(win);
  const metricsAfter = app.getAppMetrics();
  if (!result?.senderConnected || !result?.receiverConnected ||
      result.observedRows !== SAMPLE_SIZE + UPDATES * 100 ||
      !Number.isFinite(result.uiWorkMs) || result.uiWorkMs <= 0 ||
      !Number.isFinite(after - before) || after - before < 0) {
    throw new Error('AUDIO_COMPARISON_INVALID_' + name + '_' + round);
  }
  return {
    round,
    uiWorkMs: Number(result.uiWorkMs.toFixed(3)),
    idleDurationMs: Number(result.idleDurationMs.toFixed(3)),
    stressDurationMs: Number(result.stressDurationMs.toFixed(3)),
    idleJitterMs: result.idle?.jitterMs,
    stressJitterMs: result.stressed?.jitterMs,
    idleLossPercent: result.idle?.packetLossPercent,
    stressLossPercent: result.stressed?.packetLossPercent,
    idlePacketsReceived: result.idle?.receivedPackets,
    stressPacketsReceived: result.stressed?.receivedPackets,
    idlePacketsSent: result.idle?.sentPackets,
    stressPacketsSent: result.stressed?.sentPackets,
    rendererTaskSeconds: Number((after - before).toFixed(6)),
    ...osSnapshot(win, metricsBefore, metricsAfter),
  };
}

async function run() {
  for (const name of names) windows[name] = await start(name);
  const samples = Object.fromEntries(names.map(name => [name, []]));
  for (let round = 0; round < WARMUPS + ITERATIONS; round++) {
    const order = round % 2 === 0 ? names : [...names].reverse();
    for (const name of order) {
      const record = await measure(name, round);
      if (round >= WARMUPS) samples[name].push(record);
    }
  }
  const report = {
    scope: 'synthetic 10000-message React/Svelte Electron renderer under real local WebRTC audio RTP; NOT Bridge full voice parity',
    transport: 'two real RTCPeerConnections with 48kHz Web Audio 440Hz generated track, local ICE only; no external network, mic or playback',
    timingDefinition: 'stressed UI duration includes actual DOM commit and two rAF per operation; CDP TaskDuration is renderer main-thread proxy, NOT OS CPU percent',
    limitation: 'RTP jitter and packet-loss measurements are LOCAL LOOPBACK, NOT real-network latency, perceived audio quality, microphone or system audio',
    platform: process.platform,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    sampleSize: SAMPLE_SIZE,
    updates: UPDATES,
    warmups: WARMUPS,
    iterations: ITERATIONS,
    variants: {},
  };
  for (const name of names) {
    const s = samples[name];
    report.variants[name] = {
      samples: s,
      uiWorkMs: summary(s, 'uiWorkMs'),
      idleDurationMs: summary(s, 'idleDurationMs'),
      stressDurationMs: summary(s, 'stressDurationMs'),
      idleJitterMs: summary(s, 'idleJitterMs'),
      stressJitterMs: summary(s, 'stressJitterMs'),
      idleLossPercent: summary(s, 'idleLossPercent'),
      stressLossPercent: summary(s, 'stressLossPercent'),
      rendererTaskSeconds: summary(s, 'rendererTaskSeconds'),
      cpuIntervalPercent: summary(s, 'cpuIntervalPercent'),
      cpuDefinition: 'Electron renderer percentCPUUsage average over bounded sample interval; not whole app or peak CPU',
      memoryDefinition: 'Electron renderer working-set single snapshot after each round; NOT total app RAM',
    };
  }
  verify(report);
  writeFileSync(join(generated, 'audio-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('AUDIO_AB_RESULT ' + JSON.stringify(report));
}

let timer;
app.whenReady().then(async () => {
  timer = setTimeout(() => { console.error('AUDIO_AB_DEADLINE'); app.exit(1); }, 14 * 60_000);
  try {
    await run();
    clearTimeout(timer);
    for (const win of Object.values(windows)) win.destroy();
    app.quit();
  } catch (error) {
    console.error('AUDIO_AB_FAILED', error);
    clearTimeout(timer);
    app.exit(1);
  }
}).catch(error => { console.error('AUDIO_AB_APP_FAILED', error); app.exit(1); });
