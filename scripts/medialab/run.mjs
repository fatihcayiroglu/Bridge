#!/usr/bin/env node
// scripts/medialab/run.mjs — real-media evidence against a disposable lab
// (see README.md in this directory). Needs root, /dev/net/tun, iproute2,
// nftables, coturn, Chromium (PLAYWRIGHT_BROWSERS_PATH) and the moto S3
// server (MN_MOTO_SERVER) used by the multi-node cluster.
//
//   node scripts/medialab/run.mjs [--scenarios e2e,turn,...] [--out DIR] [--work DIR]
//
// Exit code: 0 when no check reports FAIL, 1 otherwise. BLOCKED / SKIPPED
// never count as PASS and are listed separately; INFO is a measurement.

import fs from 'node:fs';
import path from 'node:path';
import { Lab } from './lib/lab.mjs';

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : fallback;
};

export const ALL = ['e2e', 'turn', 'impair', 'netchange', 'failover', 'lifecycle', 'authz', 'multiuser', 'soak'];
const selected = opt('scenarios', ALL.join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const lab = new Lab({ workDir: opt('work', undefined) });
const outDir = opt('out', path.join(lab.workDir, 'report'));
fs.mkdirSync(outDir, { recursive: true });

const results = [];
const measurements = {};
const record = (scenario, id, name, status, detail = '', data) => {
  if (!['PASS', 'FAIL', 'BLOCKED', 'SKIPPED', 'INFO'].includes(status)) throw new Error(`bad status ${status}`);
  results.push({ scenario, id, name, status, detail, ...(data !== undefined ? { data } : {}) });
  console.log(`  [${status.padEnd(7)}] ${id} ${name}${detail ? ` — ${detail}` : ''}`);
};
const measure = (key, value, unit, note) => {
  measurements[key] = { value, unit, ...(note ? { note } : {}) };
  console.log(`  [MEASURE] ${key} = ${typeof value === 'object' ? JSON.stringify(value) : value} ${unit}${note ? ` (${note})` : ''}`);
};

let exitCode = 0;
try {
  console.log(`work dir: ${lab.workDir}`);
  await lab.up();
  console.log(JSON.stringify(lab.topology(), null, 2));
  for (const name of selected) {
    console.log(`\n=== scenario: ${name} ===`);
    const mod = await import(`./scenarios/${name}.mjs`);
    const ctx = {
      lab,
      record: (id, n, status, detail, data) => record(name, id, n, status, detail, data),
      measure: (key, value, unit, note) => measure(`${name}.${key}`, value, unit, note),
    };
    try {
      await mod.run(ctx);
    } catch (err) {
      record(name, `${name}:crash`, 'scenario aborted', 'FAIL', err.stack || String(err));
    }
    // Lab-link evidence: packets the impairment links forwarded / dropped.
    // Drops with no configured impairment would be a lab artifact.
    const links = {};
    for (const c of lab.clients) {
      try { links[c.name] = await lab.net.linkStats(c.index); } catch { /* link gone */ }
    }
    record(name, `${name}:links`, 'lab impairment-link counters', 'INFO', JSON.stringify(Object.fromEntries(Object.entries(links).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([l, st]) => [l, { up: st.up, down: st.down }]))]))));
    // Every scenario leaves the lab clean for the next one.
    for (const c of [...lab.clients]) await lab.closeClient(c);
    lab.net.down();
    lab.net.up();
    for (const n of lab.nodes) {
      if (lab.cluster.nodes.get(n)?.exited) await lab.startNode(n).catch((e) => console.log(`restart ${n}: ${e.message}`));
    }
    if (!lab.turn.proc) await lab.turn.start();
  }
} catch (err) {
  record('lab', 'lab:crash', 'lab failed', 'FAIL', err.stack || String(err));
} finally {
  const topology = (() => { try { return lab.topology(); } catch { return null; } })();
  const count = (s) => results.filter((r) => r.status === s).length;
  const summary = { PASS: count('PASS'), FAIL: count('FAIL'), BLOCKED: count('BLOCKED'), SKIPPED: count('SKIPPED'), INFO: count('INFO') };
  fs.writeFileSync(path.join(outDir, 'report.json'), JSON.stringify({ generatedAt: new Date().toISOString(), topology, summary, results, measurements }, null, 2));
  const md = [
    '# Bridge media lab report', '',
    `Generated: ${new Date().toISOString()}`, '',
    `PASS ${summary.PASS} · FAIL ${summary.FAIL} · BLOCKED ${summary.BLOCKED} · SKIPPED ${summary.SKIPPED} · INFO ${summary.INFO}`, '',
    'SKIPPED and BLOCKED are not passes. INFO rows are measurements.', '',
    '| scenario | id | check | status | detail |', '|---|---|---|---|---|',
    ...results.map((r) => `| ${r.scenario} | ${r.id} | ${r.name} | ${r.status} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ').slice(0, 400)} |`),
    '', '## Measurements', '', '| key | value | unit | note |', '|---|---|---|---|',
    ...Object.entries(measurements).map(([k, m]) => `| ${k} | ${typeof m.value === 'object' ? JSON.stringify(m.value).replace(/\|/g, '\\|') : m.value} | ${m.unit} | ${m.note || ''} |`),
  ].join('\n');
  fs.writeFileSync(path.join(outDir, 'report.md'), md);
  console.log(`\nsummary: ${JSON.stringify(summary)}\nreport: ${outDir}`);
  // The report is written first: a teardown that hangs must not lose it.
  await Promise.race([lab.down().catch(() => undefined), new Promise((r) => setTimeout(r, 60_000))]);
  if (summary.FAIL > 0) exitCode = 1;
  process.exit(exitCode);
}
