// Future Codex task only. Same six-spec Chromium scope as the recovered run.
import path from 'node:path';
const repo = process.env.BRIDGE_HANDOFF_REPO;
const runtime = process.env.BRIDGE_HANDOFF_RUNTIME;
const output = process.env.BRIDGE_HANDOFF_OUTPUT;
if (!repo || !runtime || !output) throw new Error('Use run-chromium.sh with explicit disposable runtime and services');
const { defineConfig } = require(path.join(repo, 'e2e/node_modules/@playwright/test'));
const base = require(path.join(repo, 'e2e/playwright.config.ts')).default;
const quote = (s: string) => "'" + s.replace(/'/g, "'\\''") + "'";
export default defineConfig({
  ...base,
  testDir: path.join(repo, 'e2e/tests'),
  retries: 0,
  workers: 1,
  globalTimeout: 600_000,
  outputDir: path.join(output, 'results'),
  reporter: [['list'], ['json', { outputFile: path.join(output, 'chromium.json') }]],
  webServer: {
    ...base.webServer,
    command: 'node ' + quote(path.join(runtime, 'scripts/e2e-server.js')),
    reuseExistingServer: false,
  },
});
