const fs = require('node:fs');
const { desktopProfiles } = require('../desktop-resolutions.cjs');
const EXPECTED_BROWSERS = new Set(['desktop-chromium', 'desktop-firefox', 'desktop-webkit']);

function collectTests(suites, out = []) {
  for (const suite of suites ?? []) {
    for (const spec of suite.specs ?? []) for (const entry of spec.tests ?? []) out.push(entry);
    collectTests(suite.suites, out);
  }
  return out;
}

function assertDesktopResults(report) {
  const tests = collectTests(report?.suites);
  const expected = (desktopProfiles.length + 1) * EXPECTED_BROWSERS.size;
  if (tests.length !== expected) throw new Error(`DESKTOP_TEST_COUNT_MISMATCH expected=${expected} actual=${tests.length}`);
  const counts = new Map();
  for (const entry of tests) {
    if (!EXPECTED_BROWSERS.has(entry.projectName)) throw new Error(`UNEXPECTED_DESKTOP_PROJECT ${entry.projectName}`);
    counts.set(entry.projectName, (counts.get(entry.projectName) ?? 0) + 1);
    if (entry.status !== 'expected' || entry.results?.length !== 1 || entry.results[0].status !== 'passed')
      throw new Error(`NOT_EXECUTED_OR_NOT_PASSED ${entry.projectName}:${entry.status}:${entry.results?.map(r => r.status)}`);
  }
  for (const browser of EXPECTED_BROWSERS) {
    if (counts.get(browser) !== desktopProfiles.length + 1) throw new Error(`BROWSER_COVERAGE_MISSING ${browser}`);
  }
  return { verdict: 'PASS', executed: tests.length, skipped: 0, retries: 0, browsers: [...counts] };
}

module.exports = { assertDesktopResults, collectTests };

if (require.main === module) {
  try {
    const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
    console.log('NATIVE_DESKTOP_WEB_LAYOUT', JSON.stringify(assertDesktopResults(report)));
  } catch (err) { console.error(`DESKTOP_LAYOUT_GATE_FAIL ${err.message}`); process.exitCode = 1; }
}
