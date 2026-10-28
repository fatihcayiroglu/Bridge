'use strict';

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const generated = join(__dirname, 'generated');
const iterations = 30;
const warmups = 5;
const sampleSize = 1000;
const names = ['svelte', 'react'];
const operations = [['reset', 1000], ['append', 1001], ['filter', 100]];
const windows = {};
const durations = Object.fromEntries(names.map(name => [name, { reset: [], append: [], filter: [] }]));

function percentile(values, ratio) {
  if (!values.length) throw new Error('No performance samples');
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * ratio) - 1].toFixed(2));
}

function summarize(values) {
  if (values.length !== iterations) throw new Error('Expected ' + iterations + ' samples, got ' + values.length);
  return {
    samples: values.length,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
  };
}

async function start(name) {
  const js = readFileSync(join(generated, name + '.js'), 'utf8');
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>' +
    'body{font:14px Arial;margin:0}article{height:28px;display:flex;gap:12px;border-bottom:1px solid #ddd}' +
    '.author{font-weight:600;width:85px}</style></head><body><div id="root"></div>' +
    '<script>' + js + '</script></body></html>';
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    show: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false },
  });
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  const ready = await win.webContents.executeJavaScript(
    'new Promise((resolve,reject)=>{let n=0;const t=setInterval(()=>{' +
    'if(typeof window.__bench?.reset==="function"){clearInterval(t);resolve(true)}' +
    'else if(++n>=100){clearInterval(t);reject(new Error("BENCH_NOT_READY"))}},100)})'
  );
  if (ready !== true) throw new Error(name + ': benchmark did not initialise');
  return win;
}

async function measure(name, operation, expectedCount) {
  const call = operation === 'reset' ? 'reset(1000)' : operation === 'filter' ? 'filter("message-7")' : 'append()';
  const result = await windows[name].webContents.executeJavaScript(
    '(async()=>{' +
    'const root=document.querySelector("#rows");' +
    'if(!root)throw new Error("BENCH_ROOT_MISSING");' +
    'const t=performance.now();let committedMs=null;' +
    'const observer=new MutationObserver(()=>{' +
    'if(committedMs===null && root.childElementCount===' + expectedCount + ')' +
    'committedMs=performance.now()-t;' +
    '});' +
    'observer.observe(root,{childList:true,subtree:true,characterData:true});' +
    'try{await window.__bench.' + call + ';' +
    'return {committedMs,count:root.childElementCount};' +
    '}finally{observer.disconnect()}' +
    '})()'
  );
  if (!Number.isFinite(result.committedMs) || result.committedMs <= 0 || result.count !== expectedCount) {
    throw new Error(name + ' ' + operation + ': invalid result ' + JSON.stringify(result) +
      ', expected ' + expectedCount + ' actual DOM nodes');
  }
  return result.committedMs;
}

async function run() {
  for (const name of names) windows[name] = await start(name);
  for (let i = 0; i < warmups + iterations; i++) {
    const order = i % 2 === 0 ? names : [...names].reverse();
    for (const name of order) {
      windows[name].show();
      windows[name].focus();
      for (const [operation, count] of operations) {
        const elapsed = await measure(name, operation, count);
        if (i >= warmups) durations[name][operation].push(elapsed);
      }
    }
  }

  const output = {
    scope: 'synthetic message-list renderer benchmark; NOT full Bridge or WebRTC',
    timingDefinition: 'milliseconds from state update request to DOM mutation with expected element count; excludes paint and rAF wait',
    platform: process.platform,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    viewport: '1280x800',
    warmups,
    iterations,
    sampleSize,
    variants: {},
  };
  const meta = JSON.parse(readFileSync(join(generated, 'bundle-meta.json'), 'utf8'));
  for (const name of names) {
    const heapBytes = await windows[name].webContents.executeJavaScript('performance.memory?.usedJSHeapSize ?? null');
    output.variants[name] = {
      ...meta[name],
      heapMB: heapBytes === null ? null : Number((heapBytes / 1048576).toFixed(2)),
      timings: Object.fromEntries(Object.entries(durations[name]).map(([key, values]) => [key, summarize(values)])),
    };
  }
  writeFileSync(join(generated, 'report.json'), JSON.stringify(output, null, 2) + '\n');
  console.log('BENCHMARK_RESULT ' + JSON.stringify(output));
}

let timer;
app.whenReady().then(async () => {
  timer = setTimeout(() => { console.error('BENCHMARK_DEADLINE'); app.exit(1); }, 8 * 60_000);
  try {
    await run();
    for (const win of Object.values(windows)) win.destroy();
    clearTimeout(timer);
    app.quit();
  } catch (error) {
    console.error('BENCHMARK_FAILED', error);
    clearTimeout(timer);
    app.exit(1);
  }
}).catch(error => { console.error('BENCHMARK_APP_FAILED', error); app.exit(1); });
