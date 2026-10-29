#!/usr/bin/env node
// P7 #570: decide, from facts that can be checked here, which real-product performance scenarios could run.
// No scenario has an automated executor yet, so every one is reported NOT EXECUTED with the exact missing
// requirements. Nothing is measured, guessed or filled in. Exit code 3 means "not complete" and is never green.
import fs from 'node:fs';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { SCENARIOS, REQUIREMENT_TEXT } from './scenarios.mjs';
import { validateReport, summarize } from './report.mjs';

const has = (cmd) => spawnSync(process.platform === 'win32' ? 'where' : 'which', [cmd], { stdio: 'ignore' }).status === 0;

export function probe(env = process.env, platform = process.platform) {
  const osName = platform === 'win32' ? 'windows' : platform === 'darwin' ? 'macos' : platform === 'linux' ? 'linux' : 'other';
  return {
    os: osName,
    // An executor for the packaged app does not exist yet; this stays false until one is written and verified.
    packagedAppExecutor: false,
    remoteClients: Number.parseInt(env.BRIDGE_PERF_REMOTE_CLIENTS ?? '0', 10) || 0,
    gameCommand: Boolean(env.BRIDGE_PERF_GAME_CMD),
    gpuCounters: platform === 'win32' ? true : has('nvidia-smi'),
    audioDevice: false, // never assumed: needs an operator-confirmed route
    screenCapturePermission: false, // cannot be verified from outside the packaged app
    networkShaper: platform === 'linux' ? has('tc') : false,
    seededMessages: 0,
  };
}

export function missingFor(scenario, facts) {
  const missing = [];
  const n = scenario.needs;
  if (!n.os.includes(facts.os)) missing.push('os');
  if (n.packagedApp && !facts.packagedAppExecutor) missing.push('packagedApp');
  if (n.account && !facts.packagedAppExecutor) missing.push('account');
  if (n.remoteClients && facts.remoteClients < n.remoteClients) missing.push('remoteClients');
  for (const key of ['audioDevice', 'gameCommand', 'gpuCounters', 'screenCapturePermission', 'networkShaper']) if (n[key] && !facts[key]) missing.push(key);
  if (n.seededMessages && facts.seededMessages < n.seededMessages) missing.push('seededMessages');
  if (n.display) missing.push('display');
  return missing;
}

export function buildReport(facts = probe()) {
  const scenarios = SCENARIOS.map((s) => {
    const missing = missingFor(s, facts);
    return { id: s.id, title: s.title, status: 'NOT EXECUTED', missing, needs: missing.map((m) => ({ key: m, text: REQUIREMENT_TEXT[m] })) };
  });
  return { schema: 1, generatedAt: new Date().toISOString(), host: { os: facts.os, release: os.release(), arch: os.arch(), cpus: os.cpus().length }, scenarios };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = buildReport();
  const valid = validateReport(report);
  if (!valid.ok) { console.error(`PERF_REPORT_INVALID ${valid.code} ${valid.detail ?? ''}`); process.exit(2); }
  const out = process.argv[2];
  if (out) fs.writeFileSync(out, JSON.stringify(report, null, 2));
  const s = summarize(report);
  for (const e of report.scenarios) console.log(`${e.status.padEnd(13)} ${e.id} ${e.title} - missing: ${e.missing.join(', ') || 'none'}`);
  console.log(`PERF_ACCEPTANCE executed=${s.executed} notExecuted=${s.notExecuted} complete=${s.complete}`);
  process.exit(s.complete ? 0 : 3);
}
