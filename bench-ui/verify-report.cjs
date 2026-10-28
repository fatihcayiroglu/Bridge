'use strict';
const fs = require('node:fs');
const path = require('node:path');
const required = ['reset', 'append', 'filter'];
const variants = ['svelte', 'react'];

function verify(report) {
  if (!report || typeof report !== 'object') throw new Error('Missing benchmark report');
  if (!String(report.scope || '').includes('synthetic message-list')) {
    throw new Error('The report must identify its synthetic, non-product scope');
  }
  if (report.iterations !== 30 || report.warmups !== 5 || report.sampleSize !== 1000) {
    throw new Error('Unexpected test configuration');
  }
  if (!report.electron || !report.chromium || !report.platform) {
    throw new Error('Missing actual runtime identification');
  }
  for (const name of variants) {
    const variant = report.variants?.[name];
    if (!variant) throw new Error('Missing framework: ' + name);
    if (!(variant.rawBytes > 0 && variant.gzipBytes > 0)) throw new Error('Missing bundle sizes: ' + name);
    for (const key of required) {
      const sample = variant.timings?.[key];
      if (!sample || sample.samples !== 30) throw new Error('Missing samples: ' + name + '/' + key);
      if (!Number.isFinite(sample.p50Ms) || sample.p50Ms <= 0 ||
          !Number.isFinite(sample.p95Ms) || sample.p95Ms < sample.p50Ms) {
        throw new Error('Invalid p50/p95: ' + name + '/' + key);
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
