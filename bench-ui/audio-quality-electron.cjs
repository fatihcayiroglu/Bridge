'use strict';
// Objective PCM fidelity under the SAME Electron/Chromium audio path for both
// synthetic frontends. This is NOT subjective speech quality or a Bridge call.
const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');
const { verify } = require('./audio-quality-report.cjs');
const generated = join(__dirname, 'generated');
const variants = ['svelte', 'react'];
const scenarios = ['voice2', 'voice10', 'voice2_chat'];
const windows = {};
const WARMUPS = 1;
const ITERATIONS = 5;
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.on('window-all-closed', () => {});

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length || sorted.some(v => !Number.isFinite(v))) {
    throw new Error('AUDIO_QUALITY_INVALID_SAMPLES');
  }
  return Number(sorted[Math.ceil(ratio * sorted.length) - 1].toFixed(3));
}
function metric(s, key) {
  return ['receivedPackets', 'maxJitterMs'].includes(key) ? s.rtp[key] : s[key];
}
function summarize(samples, key) {
  const values = samples.map(s => metric(s, key));
  if (values.length !== ITERATIONS) throw new Error('AUDIO_QUALITY_COUNT_INVALID');
  return { samples: values.length, p50: percentile(values, 0.5),
    p95: percentile(values, 0.95) };
}
async function start(name) {
  const ui = readFileSync(join(generated, name + '.js'), 'utf8');
  const math = readFileSync(join(__dirname, 'audio-quality-math.js'), 'utf8');
  const runtime = readFileSync(join(__dirname, 'audio-quality-runtime.js'), 'utf8');
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{font:14px Arial;margin:0}article{height:28px;display:flex;gap:12px;border-bottom:1px solid #ddd}' +
    '.author{font-weight:600;width:85px}</style></head><body><div id="root"></div>' +
    '<script>' + ui + '</script><script>' + math + '</script><script>' + runtime +
    '</script></body></html>';
  const win = new BrowserWindow({ width: 1280, height: 800, show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true,
      sandbox: true, backgroundThrottling: false } });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  await win.webContents.executeJavaScript(
    'new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{' +
    'if(window.__audioQualityBench?.prepare&&window.__bench?.reset){clearInterval(t);resolve(true)}' +
    'else if(++n>=100){clearInterval(t);reject(new Error("AUDIO_BENCH_NOT_READY"))}},100)})');
  return win;
}
async function measure(name, mode, round) {
  const win = windows[name];
  win.show(); win.focus();
  await win.webContents.executeJavaScript(
    'window.__audioQualityBench.prepare(' + JSON.stringify(mode) + ')');
  try {
    const sample = await win.webContents.executeJavaScript(
      'window.__audioQualityBench.execute(' + JSON.stringify(mode) + ')');
    if (sample?.mode !== mode || sample.measuredMs < 2000 ||
        !Number.isFinite(sample.snrDb) || sample.sampleWindows !== 20) {
      throw new Error('AUDIO_QUALITY_SAMPLE_NOT_MEASURED_' + mode);
    }
    return { round, ...sample };
  } finally {
    await win.webContents.executeJavaScript('window.__audioQualityBench.teardown()');
  }
}
async function run() {
  const data = {};
  for (const mode of scenarios) {
    try {
      for (const name of variants) windows[name] = await start(name);
      const samples = { svelte: [], react: [] };
      for (let round = 0; round < WARMUPS + ITERATIONS; round++) {
        const order = round % 2 ? [...variants].reverse() : variants;
        for (const name of order) {
          if (round === 0) console.log('AUDIO_QUALITY_STAGE ' + JSON.stringify({ mode, name }));
          const sample = await measure(name, mode, round);
          if (round >= WARMUPS) samples[name].push(sample);
        }
      }
      data[mode] = { variants: {} };
      for (const name of variants) {
        data[mode].variants[name] = { samples: samples[name] };
        for (const key of ['snrDb', 'dropoutPercent', 'clippingPercent',
          'maxSampleGapMs', 'receivedPackets', 'maxJitterMs']) {
          data[mode].variants[name][key] = summarize(samples[name], key);
        }
      }
    } finally {
      for (const name of variants) {
        const win = windows[name];
        if (win && !win.isDestroyed()) win.destroy();
        delete windows[name];
      }
    }
  }
  const report = {
    scope: 'synthetic PCM 440Hz through REAL local WebRTC RTP; NOT subjective speech quality; NOT actual Bridge media',
    limitation: 'WebAudio Analyser 20 sampled ~43ms windows; may miss short glitches; no microphone, speaker, speech/PESQ, human listener, real network or real SFU',
    platform: process.platform, electron: process.versions.electron,
    warmups: WARMUPS, iterations: ITERATIONS, scenarios: data,
  };
  verify(report);
  writeFileSync(join(generated, 'audio-quality-report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log('AUDIO_QUALITY_AB_RESULT ' + JSON.stringify(report));
}
let deadline;
app.whenReady().then(async () => {
  deadline = setTimeout(() => { console.error('AUDIO_QUALITY_AB_DEADLINE'); app.exit(1); }, 30 * 60_000);
  try {
    await run();
    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error('AUDIO_QUALITY_AB_FAILED', error);
    clearTimeout(deadline);
    app.exit(1);
  }
}).catch(error => { console.error('AUDIO_QUALITY_AB_APP_FAILED', error); app.exit(1); });
