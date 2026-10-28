import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
const read = (rel) => fs.readFileSync(new URL(rel, import.meta.url), 'utf8');
const script = read('../scripts/prebuild-wda.sh');
const workflow = read('../../.github/workflows/native-pilot-ios-browser-auth.yml');
const driver = read('../scripts/ios-browser-auth.mjs');

test('the prebuild is fail-closed with distinct codes, never skipped or tolerated', () => {
  assert.match(script, /^set -euo pipefail$/m);
  assert.match(script, /WDA_PREBUILD_PROJECT_NOT_UNIQUE/);
  assert.match(script, /WDA_PREBUILD_FAILED seconds=/);
  assert.match(script, /WDA_PREBUILD_PROJECT_NOT_UNIQUE count=\$count" >&2; exit 1; fi/);
  assert.match(script, /\| sed -E [^\n]*>&2\n  exit 1\nfi/);
  assert.ok(!/\|\| true\s*$/m.test(script.split('\n').filter((l) => l.includes('xcodebuild')).join('\n')), 'the build result is never swallowed');
  assert.match(script, /build-for-testing -project "\$projects" -scheme WebDriverAgentRunner/);
  assert.match(script, /CODE_SIGNING_ALLOWED=NO/);
  assert.match(script, /WDA_DERIVED_DATA=\$derived" >> "\$GITHUB_ENV"/);
});

test('the workflow runs the prebuild as its own bounded step before the journey', () => {
  const prebuild = workflow.indexOf('Prebuild WebDriverAgent');
  const journey = workflow.indexOf('Actual system-browser sign-in, OS callback, protected restore and revocation');
  const boot = workflow.indexOf('Boot isolated simulator and trust only the generated test CA');
  assert.ok(boot > 0 && prebuild > boot && journey > prebuild, 'boot < prebuild < journey');
  assert.match(workflow.slice(prebuild, journey), /timeout-minutes: 25\s+run: bash mobile-native-pilot\/scripts\/prebuild-wda\.sh/);
});

test('the driver uses the prebuilt agent and keeps its own deadline unchanged', () => {
  assert.match(driver, /process\.env\.WDA_DERIVED_DATA \? \{\s*'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': process\.env\.WDA_DERIVED_DATA,[\s\S]*?\} : \{\}/);
  assert.match(driver, /driverDeadlineMs/);
  assert.match(driver, /facts\.driverDeadlineMs = 480000;/);
  assert.match(driver, /\} \} \}, 480000\);/, 'the session-creation deadline matches the recorded 480 s');
});

test('run 40769336956: the agent started after 227.9 s, so the deadline is 480 s, still bounded, and the launch wait fits inside it', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  const launch = Number(/'appium:wdaLaunchTimeout': (\d+), 'appium:wdaStartupRetries': 1/.exec(s)?.[1]);
  const deadline = Number(/facts\.driverDeadlineMs = (\d+)/.exec(s)?.[1]);
  assert.ok(launch > 227942, 'the launch wait covers the observed start time');
  assert.ok(deadline > launch, 'the journey deadline outlasts the launch wait');
  assert.ok(deadline <= 600000, 'the deadline stays bounded');
  assert.match(s, /\} \} \}, 480000\);/);
});

test('the system browser page-load wait is 180 s (run 40777269820 showed a page still loading), bounded and applied', () => {
  const s = fs.readFileSync(new URL('../scripts/ios-browser-auth.mjs', import.meta.url), 'utf8');
  const ms = Number(/const BROWSER_PAGE_LOAD_MS = (\d+);/.exec(s)?.[1]);
  assert.equal(ms, 180000);
  assert.ok(ms > 60000 && ms <= 240000, 'longer than the old default, still bounded');
  assert.match(s, /\}, 'system-authentication-browser', BROWSER_PAGE_LOAD_MS\);/);
});

import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const startScript = new URL('../scripts/start-wda.sh', import.meta.url).pathname;
function sandbox({ curlOk, xcodebuildExits }) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wda-start-'));
  fs.mkdirSync(path.join(root, 'e2e/ios/node_modules/appium-webdriveragent/WebDriverAgent.xcodeproj'), { recursive: true });
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'xcodebuild'), xcodebuildExits ? '#!/bin/sh\necho "boom /Users/runner/secret/path"; exit 2\n' : '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'curl'), curlOk ? '#!/bin/sh\nexit 0\n' : '#!/bin/sh\nexit 7\n', { mode: 0o755 });
  const temp = path.join(root, 'tmp'); fs.mkdirSync(temp);
  const ghEnv = path.join(root, 'gh_env'); fs.writeFileSync(ghEnv, '');
  return { root, temp, ghEnv, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: temp, GITHUB_ENV: ghEnv, IOS_SIMULATOR_UDID: 'UDID', WDA_DERIVED_DATA: path.join(root, 'dd'), WDA_POLL_SECONDS: '0.2' } };
}
const runStart = (box, extra = {}) => spawnSync('bash', [startScript], { cwd: box.root, env: { ...box.env, ...extra }, encoding: 'utf8', timeout: 30000 });

test('start-wda.sh reports the start time and hands the URL to the journey through GITHUB_ENV', () => {
  const box = sandbox({ curlOk: true });
  const r = runStart(box);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /WDA_STARTED seconds=\d+/);
  assert.match(fs.readFileSync(box.ghEnv, 'utf8'), /^WDA_URL=http:\/\/127\.0\.0\.1:8100$/m);
  assert.match(fs.readFileSync(path.join(box.temp, 'bridge-wda.pid'), 'utf8'), /^\d+\n$/);
  try { process.kill(Number(fs.readFileSync(path.join(box.temp, 'bridge-wda.pid'), 'utf8')), 'SIGTERM'); } catch {}
});

test('start-wda.sh fails closed on a timeout and on an exited process, with distinct codes, and never exports the URL', () => {
  const slow = sandbox({ curlOk: false });
  const t = runStart(slow, { WDA_START_LIMIT_SECONDS: '1' });
  assert.equal(t.status, 1);
  assert.match(t.stderr, /WDA_START_TIMEOUT seconds=\d+ limit=1/);
  assert.equal(fs.readFileSync(slow.ghEnv, 'utf8'), '');
  const dead = sandbox({ curlOk: false, xcodebuildExits: true });
  const e = runStart(dead);
  assert.equal(e.status, 1);
  assert.match(e.stderr, /WDA_PROCESS_EXITED seconds=\d+/);
  assert.ok(!e.stderr.includes('/Users/runner/secret'), 'runner paths are redacted');
  assert.equal(fs.readFileSync(dead.ghEnv, 'utf8'), '');
});

test('start-wda.sh refuses a missing or ambiguous WebDriverAgent project', () => {
  const box = sandbox({ curlOk: true });
  fs.rmSync(path.join(box.root, 'e2e/ios/node_modules/appium-webdriveragent'), { recursive: true });
  const r = runStart(box);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /WDA_START_PROJECT_NOT_UNIQUE count=0/);
});

test('the workflow starts the agent between the prebuild and the journey, bounded, and stops it; the journey prefers it', () => {
  const prebuild = workflow.indexOf('Prebuild WebDriverAgent');
  const start = workflow.indexOf('Start WebDriverAgent');
  const journey = workflow.indexOf('Actual system-browser sign-in, OS callback, protected restore and revocation');
  assert.ok(prebuild > 0 && start > prebuild && journey > start, 'prebuild < start < journey');
  assert.match(workflow.slice(start, journey), /timeout-minutes: 20\s+run: bash mobile-native-pilot\/scripts\/start-wda\.sh/);
  assert.match(workflow, /bridge-wda\.pid/);
  assert.match(driver, /process\.env\.WDA_URL \? \{ 'appium:webDriverAgentUrl': process\.env\.WDA_URL \} : process\.env\.WDA_DERIVED_DATA \?/);
  assert.match(driver, /facts\.driverDeadlineMs = 480000;/, 'the session deadline is not raised again');
});
