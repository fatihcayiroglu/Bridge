// Bounded, redacted console excerpt for the pre-input WebDriverAgent startup stall. Only used by the
// existing gate (stage native-xcuitest-session, zero cases): no UI command has entered credentials yet.
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const INTEREST = /webdriveragent|wda|xcodebuild|xcrun|simctl|derived|build (succeeded|failed)|compil|linking|codesign|testmanagerd|launch|boot|timeout|timed out|error|failed|port|forward|appium:/i;
const SENSITIVE = /password|passwd|secret|token|authorization|cookie|bearer|api[_-]?key|credential|\.key\b|jwt|refresh/i;
const TOKEN_RUN = /[A-Za-z0-9+/_=-]{32,}/g;
const PROCESS = /xcodebuild|WebDriverAgent|SWBBuildService|testmanagerd|ibtoold|appium|Simulator|launchd_sim/;

export function clean(line, max = 200) {
  return String(line).replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(TOKEN_RUN, '[redacted]').replace(/\s+/g, ' ').trim().slice(0, max);
}
export function logExcerpt(text, { maxLines = 80, maxChars = 200 } = {}) {
  const kept = String(text ?? '').split('\n').filter((l) => INTEREST.test(l) && !SENSITIVE.test(l)).map((l) => clean(l, maxChars)).filter(Boolean);
  return { total: kept.length, lines: kept.slice(-maxLines) };
}
export function processExcerpt(psText, maxLines = 25) {
  return String(psText ?? '').split('\n').filter((l) => PROCESS.test(l) && !SENSITIVE.test(l)).map((l) => clean(l, 160)).slice(0, maxLines);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const log = process.argv[2];
  const run = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', timeout: 20000 }).stdout ?? '';
  const ex = existsSync(log) ? logExcerpt(readFileSync(log, 'utf8')) : { total: 0, lines: [] };
  console.log('IOS_WDA_STARTUP_DIAGNOSTICS_BEGIN');
  console.log(JSON.stringify({
    processes: processExcerpt(run('ps', ['-axo', 'pid,etime,command'])),
    bootedSimulators: run('xcrun', ['simctl', 'list', 'devices', 'booted']).split('\n').map((l) => clean(l, 120)).filter(Boolean).slice(0, 10),
    appiumLogMatchingLines: ex.total,
  }));
  for (const l of ex.lines) console.log(`appium| ${l}`);
  console.log('IOS_WDA_STARTUP_DIAGNOSTICS_END');
}
