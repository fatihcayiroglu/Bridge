#!/usr/bin/env node
// scripts/multinode/run.mjs — run distributed-correctness scenarios against a
// disposable multi-process Bridge cluster (see README.md in this directory).
//
//   node scripts/multinode/run.mjs [--scenarios auth,realtime,...] [--out DIR]
//                                  [--uploads per-node|shared] [--keep]
//
// Exit code: 0 when no scenario reports an unexpected FAIL, 1 otherwise.
// BLOCKED/SKIPPED results never count as PASS and are listed separately.
// known-limitations.json names individual checks that FAIL for a verified,
// documented reason: they stay FAIL in every report (marked as known) and do
// not fail the exit code; a listed check that PASSES fails the run (stale).

import fs from 'node:fs';
import path from 'node:path';
import { Cluster } from './lib/cluster.mjs';
import { RoutingProxy } from './lib/proxy.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};
const flag = (name) => args.includes(`--${name}`);

const ALL = ['auth', 'realtime', 'stale', 'nodedeath', 'redis', 'postgres', 'jobs', 'sfu', 'uploads'];
const selected = opt('scenarios', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const cluster = new Cluster({ uploads: opt('uploads', 'per-node'), workDir: opt('work', undefined) });
const outDir = opt('out', path.join(cluster.workDir, 'report'));
fs.mkdirSync(outDir, { recursive: true });

const KNOWN = Object.fromEntries(Object.entries(
  JSON.parse(fs.readFileSync(new URL('./known-limitations.json', import.meta.url), 'utf8')),
).filter(([k]) => !k.startsWith('_')));

const results = [];
const measurements = {};
const record = (scenario, id, name, status, detail = '', data) => {
  if (!['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'INFO'].includes(status)) throw new Error(`bad status ${status}`);
  const known = status === 'FAIL' && KNOWN[id] ? KNOWN[id] : undefined;
  results.push({ scenario, id, name, status, detail, ...(known ? { knownLimitation: known } : {}), ...(data !== undefined ? { data } : {}) });
  console.log(`  [${(known ? 'FAIL*' : status).padEnd(7)}] ${id} ${name}${detail ? ` — ${detail}` : ''}${known ? ' (known limitation, see known-limitations.json)' : ''}`);
};
const measure = (key, value, unit, note) => {
  measurements[key] = { value, unit, ...(note ? { note } : {}) };
  console.log(`  [MEASURE] ${key} = ${value} ${unit}${note ? ` (${note})` : ''}`);
};

let proxy;
let exitCode = 0;
try {
  console.log(`work dir: ${cluster.workDir}`);
  await cluster.up();
  proxy = new RoutingProxy({
    port: cluster.basePort,
    nodes: cluster.nodeNames.map((n) => ({ name: n, host: '127.0.0.1', port: cluster.nodePort(n) })),
  });
  await proxy.start();
  const lb = `http://127.0.0.1:${cluster.basePort}`;
  console.log(JSON.stringify(cluster.topology(), null, 2));

  for (const name of selected) {
    console.log(`\n=== scenario: ${name} ===`);
    const mod = await import(`./scenarios/${name}.mjs`);
    const ctx = {
      cluster, proxy, lb,
      record: (id, n, status, detail, data) => record(name, id, n, status, detail, data),
      measure,
    };
    try {
      await mod.run(ctx);
    } catch (err) {
      record(name, `${name}:crash`, 'scenario aborted', 'FAIL', err.stack || String(err));
    }
    // Every scenario leaves the cluster healthy for the next one.
    await mod.cleanup?.(ctx).catch(() => undefined);
    proxy.setMode('round-robin');
    for (const n of cluster.nodeNames) {
      proxy.restore(n);
      const node = cluster.nodes.get(n);
      if (!node || node.exited) await cluster.startNode(n);
    }
  }
} catch (err) {
  record('harness', 'harness:crash', 'harness failure', 'FAIL', err.stack || String(err));
} finally {
  const summary = results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  const report = {
    generatedAt: new Date().toISOString(),
    topology: cluster.topology(),
    proxy: proxy?.stats,
    pgFaultProxy: cluster.pgProxy?.stats,
    summary, measurements, results,
  };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify(report, null, 2));
  const md = [
    `# Bridge multi-node report — ${report.generatedAt}`, '',
    `Summary: ${Object.entries(summary).map(([k, v]) => `${k}=${v}`).join(', ')}`, '',
    '| Scenario | Id | Check | Status | Detail |', '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.scenario} | ${r.id} | ${r.name} | ${r.status}${r.knownLimitation ? ' (known limitation)' : ''} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 300)} |`),
    '', '## Known limitations (reported as FAIL, not counted in the exit code)', '',
    ...results.filter((r) => r.knownLimitation).map((r) => `- **${r.id}** — ${r.knownLimitation}`),
    '', '## Measurements', '', '| Key | Value | Unit | Note |', '|---|---|---|---|',
    ...Object.entries(measurements).map(([k, m]) => `| ${k} | ${m.value} | ${m.unit} | ${m.note || ''} |`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md + '\n');
  console.log(`\nsummary: ${JSON.stringify(summary)}\nreport: ${path.join(outDir, 'report.md')}`);
  if (results.some((r) => r.status === 'FAIL' && !r.knownLimitation)) exitCode = 1;
  const stale = results.filter((r) => r.status === 'PASS' && KNOWN[r.id]).map((r) => r.id);
  if (stale.length) {
    console.log(`\nknown-limitations.json lists checks that now PASS — remove them: ${stale.join(', ')}`);
    exitCode = 1;
  }
  if (!flag('keep')) {
    await proxy?.stop().catch(() => undefined);
    await cluster.down();
  }
  process.exit(exitCode);
}
