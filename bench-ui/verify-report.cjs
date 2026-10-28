'use strict';
const fs = require('node:fs');
const path = require('node:path');
const required = ['reset', 'append', 'appendBatch100', 'filter', 'draft'];
const variants = ['svelte', 'react'];
const scenarioSpec = [
  { sampleSize: 1000, iterations: 30, warmups: 5 },
  { sampleSize: 10000, iterations: 12, warmups: 3 },
];

function verify(report) {
  if (!report || typeof report !== 'object') throw new Error('Missing benchmark report');
  if (!String(report.scope || '').includes('synthetic message-list')) {
    throw new Error('The report must identify its synthetic, non-product scope');
  }
  if (!String(report.timingDefinition || '').includes('DOM mutation')) {
    throw new Error('The report must identify DOM commit latency, not frame-wait time');
  }
  if (!report.electron || !report.chromium || !report.platform) {
    throw new Error('Missing actual runtime identification');
  }
  if (!Array.isArray(report.scenarios) || report.scenarios.length !== scenarioSpec.length) {
    throw new Error('Missing benchmark scenario');
  }
  for (const name of variants) {
    const bundle = report.bundles?.[name];
    if (!(bundle?.rawBytes > 0 && bundle?.gzipBytes > 0)) throw new Error('Missing bundle sizes: ' + name);
  }
  for (const [index, spec] of scenarioSpec.entries()) {
    const scenario = report.scenarios[index];
    if (scenario.sampleSize !== spec.sampleSize || scenario.iterations !== spec.iterations ||
        scenario.warmups !== spec.warmups) throw new Error('Unexpected test configuration at scenario ' + index);
    for (const name of variants) {
      const variant = scenario.variants?.[name];
      if (!variant) throw new Error('Missing framework: ' + name);
      if (variant.heapMB !== null && (!(variant.heapMB > 0) || !Number.isFinite(variant.heapMB))) {
        throw new Error('Invalid heap snapshot: ' + name);
      }
      for (const key of required) {
        const sample = variant.timings?.[key];
        if (!sample || sample.samples !== spec.iterations) throw new Error('Missing samples: ' + name + '/' + key);
        if (!Number.isFinite(sample.p50Ms) || sample.p50Ms <= 0 ||
            !Number.isFinite(sample.p95Ms) || sample.p95Ms < sample.p50Ms) {
          throw new Error('Invalid p50/p95: ' + name + '/' + key);
        }
      }
    }
  }
  return true;
}

module.exports = { verify };
if (require.main === module) {
  const file = path.join(__dirname, 'generated', 'report.json');
  verify(JSON.parse(fs.readFileSync(file, 'utf8')));
  console.log('BENCHMARK_REPORT_VALIDATED');
}
