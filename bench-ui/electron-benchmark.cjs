'use strict';

const { app, BrowserWindow } = require('electron');
const { readFileSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const generated = join(__dirname, 'generated');
const scenarios = [
  { sampleSize: 1000, iterations: 30, warmups: 5 },
  { sampleSize: 10000, iterations: 12, warmups: 3 },
];
const names = ['svelte', 'react'];
const windows = {};
const operationNames = ['reset', 'append', 'appendBatch100', 'filter', 'draft'];

function percentile(values, ratio) {
  if (!values.length) throw new Error('No performance samples');
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.ceil(sorted.length * ratio) - 1].toFixed(2));
}

function summarize(values, expectedSamples) {
  if (values.length !== expectedSamples) throw new Error('Expected ' + expectedSamples + ' samples, got ' + values.length);
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

async function measure(name, operation, expectedCount, size, round) {
  const draftText = 'draft-' + size + '-' + round + '-' + 'x'.repeat(128);
  const call = {
    reset: 'reset(' + size + ')',
    append: 'append()',
    appendBatch100: 'appendBatch(100)',
    filter: 'filter("message-7")',
    draft: 'setDraft(' + JSON.stringify(draftText) + ')',
  }[operation];
  if (!call) throw new Error('Unknown operation ' + operation);
  const observedTarget = operation === 'draft' ? 'document.querySelector("#preview")' : 'root';
  const completion = operation === 'draft'
    ? 'observed.textContent===' + JSON.stringify(draftText)
    : 'root.childElementCount===' + expectedCount;
  const result = await windows[name].webContents.executeJavaScript(
    '(async()=>{' +
    'const root=document.querySelector("#rows");' +
    'if(!root)throw new Error("BENCH_ROOT_MISSING");' +
    'const observed=' + observedTarget + ';' +
    'if(!observed)throw new Error("BENCH_TARGET_MISSING");' +
    'const t=performance.now();let committedMs=null;' +
    'const observer=new MutationObserver(()=>{' +
    'if(committedMs===null && ' + completion + ')' +
    'committedMs=performance.now()-t;' +
    '});' +
    'observer.observe(observed,{childList:true,subtree:true,characterData:true});' +
    'try{await window.__bench.' + call + ';' +
    'return {committedMs,count:root.childElementCount,preview:document.querySelector("#preview").textContent};' +
    '}finally{observer.disconnect()}' +
    '})()'
  );
  if (!Number.isFinite(result.committedMs) || result.committedMs <= 0 ||
      result.count !== expectedCount || (operation === 'draft' && result.preview !== draftText)) {
    throw new Error(name + ' ' + operation + ': invalid result ' + JSON.stringify(result) +
      ', expected ' + expectedCount + ' actual DOM nodes');
  }
  return result.committedMs;
}

async function run() {
  for (const name of names) windows[name] = await start(name);
  const output = {
    scope: 'synthetic message-list renderer benchmark; NOT full Bridge or WebRTC',
    timingDefinition: 'milliseconds from state update request to DOM mutation with expected element count; excludes paint and rAF wait',
    platform: process.platform,
    electron: process.versions.electron,
    chromium: process.versions.chrome,
    viewport: '1280x800',
    scenarios: [],
  };
  const meta = JSON.parse(readFileSync(join(generated, 'bundle-meta.json'), 'utf8'));
  output.bundles = meta;
  for (const { sampleSize, iterations, warmups } of scenarios) {
    const values = Object.fromEntries(names.map(name => [name,
      Object.fromEntries(operationNames.map(operation => [operation, []]))]));
    const ops = [
      ['reset', sampleSize],
      ['append', sampleSize + 1],
      ['appendBatch100', sampleSize + 101],
      ['filter', sampleSize / 10 + 10],
      ['draft', sampleSize / 10 + 10],
    ];
    for (let i = 0; i < warmups + iterations; i++) {
      const order = i % 2 === 0 ? names : [...names].reverse();
      for (const name of order) {
        windows[name].show();
        windows[name].focus();
        for (const [operation, count] of ops) {
          const elapsed = await measure(name, operation, count, sampleSize, i);
          if (i >= warmups) values[name][operation].push(elapsed);
        }
      }
    }
    const report = { sampleSize, iterations, warmups, variants: {} };
    for (const name of names) {
      const heapBytes = await windows[name].webContents.executeJavaScript('performance.memory?.usedJSHeapSize ?? null');
      report.variants[name] = {
        heapMB: heapBytes === null ? null : Number((heapBytes / 1048576).toFixed(2)),
        timings: Object.fromEntries(Object.entries(values[name]).map(([key, list]) => [key, summarize(list, iterations)])),
      };
    }
    output.scenarios.push(report);
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
