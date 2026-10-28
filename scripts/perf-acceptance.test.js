'use strict';
// P7 #570: the performance acceptance harness must never turn "not run" into numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const load = (f) => import(path.join(__dirname, 'perf-acceptance', f));

// Test-only fixture, never written by the harness: the shape a genuine executed entry must carry.
function executed(scenario, over = {}) {
  const samples = {};
  for (const m of scenario.metrics) samples[m] = [1, 2, 3];
  return {
    id: scenario.id, status: 'EXECUTED',
    provenance: {
      os: 'windows', osVersion: '11 23H2', bridgeCommit: 'abcdef1', appVersion: '1.125.0', machine: 'fixture-pc',
      startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:10:00Z',
      durationSec: scenario.durationSec, remoteClients: scenario.needs.remoteClients ?? 0, sfu: 'real',
    },
    samples, ...over,
  };
}

test('every scenario is well formed and metrics are from the known list', async () => {
  const { SCENARIOS, METRICS } = await load('scenarios.mjs');
  assert.equal(SCENARIOS.length, 10);
  assert.equal(new Set(SCENARIOS.map((s) => s.id)).size, 10);
  for (const s of SCENARIOS) {
    assert.ok(s.durationSec > 0 && s.metrics.length > 0 && s.needs.packagedApp === true, s.id);
    for (const m of s.metrics) assert.ok(m in METRICS, `${s.id} ${m}`);
  }
  // The gaming scenarios cannot be satisfied without game FPS and GPU evidence.
  for (const id of ['PA05', 'PA06', 'PA07']) {
    const s = SCENARIOS.find((x) => x.id === id);
    assert.ok(s.metrics.includes('gameFps') && s.metrics.includes('cpuPerProcess') && s.needs.gameCommand && s.needs.gpuCounters, id);
  }
  assert.ok(SCENARIOS.find((s) => s.id === 'PA06').metrics.includes('screenShare'));
});

test('the runner reports every scenario NOT EXECUTED, with reasons, and exits 3 (never green)', async () => {
  const run = spawnSync(process.execPath, [path.join(__dirname, 'perf-acceptance', 'run.mjs')], { encoding: 'utf8' });
  assert.equal(run.status, 3, run.stderr);
  assert.match(run.stdout, /PERF_ACCEPTANCE executed=0 notExecuted=10 complete=false/);
  assert.equal((run.stdout.match(/^NOT EXECUTED +PA\d\d /gm) || []).length, 10);
  assert.ok(!/EXECUTED +PA\d\d/.test(run.stdout.replace(/NOT EXECUTED/g, '')), 'no scenario may print as executed');
  const { buildReport, probe, missingFor } = await load('run.mjs');
  const { validateReport } = await load('report.mjs');
  const report = buildReport(probe({}, 'linux'));
  assert.deepEqual(validateReport(report), { ok: true });
  for (const e of report.scenarios) assert.ok(e.missing.includes('packagedApp'), `${e.id} needs the packaged app executor`);
  // Claiming a game command alone does not make a scenario runnable.
  const facts = { ...probe({ BRIDGE_PERF_GAME_CMD: 'game', BRIDGE_PERF_REMOTE_CLIENTS: '9' }, 'linux'), gpuCounters: true };
  const { SCENARIOS } = await load('scenarios.mjs');
  assert.ok(missingFor(SCENARIOS.find((s) => s.id === 'PA05'), facts).length > 0);
});

test('NOT EXECUTED entries must explain themselves and carry no numbers', async () => {
  const { validateEntry } = await load('report.mjs');
  const base = { id: 'PA01', status: 'NOT EXECUTED' };
  assert.equal(validateEntry({ ...base, missing: [] }).code, 'MISSING_REASON');
  assert.equal(validateEntry({ ...base }).code, 'MISSING_REASON');
  assert.equal(validateEntry({ ...base, missing: ['packagedApp'], measurements: { cpu: 3 } }).code, 'NUMBERS_WITHOUT_EXECUTION');
  assert.equal(validateEntry({ ...base, missing: ['packagedApp'], samples: { cpuPerProcess: [1, 2, 3] } }).code, 'NUMBERS_WITHOUT_EXECUTION');
  assert.deepEqual(validateEntry({ ...base, missing: ['packagedApp'] }), { ok: true });
});

test('EXECUTED entries need provenance, enough time, real SFU, enough remote clients and raw samples for every metric', async () => {
  const { validateEntry } = await load('report.mjs');
  const { SCENARIOS } = await load('scenarios.mjs');
  const s = SCENARIOS.find((x) => x.id === 'PA04');
  assert.deepEqual(validateEntry(executed(s)), { ok: true });
  assert.equal(validateEntry({ ...executed(s), provenance: undefined }).code, 'NO_PROVENANCE');
  const prov = (over) => ({ ...executed(s), provenance: { ...executed(s).provenance, ...over } });
  assert.equal(validateEntry(prov({ bridgeCommit: 'not-a-sha' })).code, 'PROVENANCE_FIELD');
  assert.equal(validateEntry(prov({ machine: '' })).code, 'PROVENANCE_FIELD');
  assert.equal(validateEntry(prov({ durationSec: s.durationSec - 1 })).code, 'TOO_SHORT');
  assert.equal(validateEntry(prov({ remoteClients: s.needs.remoteClients - 1 })).code, 'TOO_FEW_REMOTE_CLIENTS');
  assert.equal(validateEntry(prov({ sfu: 'local-parallel-rtp' })).code, 'SFU_NOT_REAL');
  const miss = executed(s); delete miss.samples.mouthToEar;
  assert.equal(validateEntry(miss).code, 'RAW_SAMPLES_REQUIRED');
  const few = executed(s); few.samples.ram = [1, 2];
  assert.equal(validateEntry(few).code, 'RAW_SAMPLES_REQUIRED');
  const extra = executed(s); extra.samples.madeUp = [1, 2, 3];
  assert.equal(validateEntry(extra).code, 'UNKNOWN_METRIC');
  assert.equal(validateEntry({ id: 'PA99', status: 'EXECUTED' }).code, 'UNKNOWN_SCENARIO');
  assert.equal(validateEntry({ id: 'PA01', status: 'PASS' }).code, 'BAD_STATUS');
});

test('a report must cover every scenario once, and is complete only when all are executed', async () => {
  const { validateReport, summarize } = await load('report.mjs');
  const { SCENARIOS } = await load('scenarios.mjs');
  const all = SCENARIOS.map((s) => executed(s));
  assert.deepEqual(validateReport({ scenarios: all }), { ok: true });
  assert.equal(summarize({ scenarios: all }).complete, true);
  assert.equal(validateReport({ scenarios: all.slice(1) }).code, 'SCENARIO_MISSING');
  assert.equal(validateReport({ scenarios: [...all, all[0]] }).code, 'DUPLICATE');
  const mixed = all.map((e, i) => (i === 0 ? { id: e.id, status: 'NOT EXECUTED', missing: ['x'] } : e));
  assert.equal(summarize({ scenarios: mixed }).complete, false);
  assert.equal(summarize({ scenarios: mixed }).notExecuted, 1);
});
