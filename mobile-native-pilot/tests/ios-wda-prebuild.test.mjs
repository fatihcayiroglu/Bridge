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
