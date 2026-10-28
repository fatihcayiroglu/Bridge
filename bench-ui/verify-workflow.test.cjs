'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');

test('runtime job explicitly installs and verifies the pinned Electron executable', () => {
  const workflow = readFileSync(join(__dirname, '../.github/workflows/desktop-ui-ab-benchmark.yml'), 'utf8');
  assert.match(workflow, /node electron\/node_modules\/electron\/install\.js/);
  assert.match(workflow, /test -x electron\/node_modules\/electron\/dist\/electron/);
  assert.match(workflow, /xvfb-run -a electron\/node_modules\/electron\/dist\/electron/);
});

test('latency benchmark measures DOM commit, not a fixed animation-frame wait', () => {
  const runner = readFileSync(join(__dirname, 'electron-benchmark.cjs'), 'utf8');
  assert.match(runner, /new MutationObserver/);
  assert.match(runner, /root\.childElementCount/);
  assert.match(runner, /return result\.committedMs/);
  assert.doesNotMatch(runner, /return result\.elapsedMs/);
});
