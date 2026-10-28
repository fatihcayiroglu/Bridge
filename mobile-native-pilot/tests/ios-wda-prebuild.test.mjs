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
  assert.match(driver, /process\.env\.WDA_DERIVED_DATA \? \{ 'appium:usePrebuiltWDA': true, 'appium:derivedDataPath': process\.env\.WDA_DERIVED_DATA \} : \{\}/);
  assert.match(driver, /driverDeadlineMs/);
  assert.match(driver, /facts\.driverDeadlineMs = 240000;/);
  assert.match(driver, /\} \} \}, 240000\);/, 'the session-creation deadline is not raised');
});
