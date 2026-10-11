#!/usr/bin/env node
// Launch the ACTUAL packaged macOS Bridge.app and prove its first-run page
// exists as a native Chromium renderer. No mocked Electron objects or test
// replacement HTML. This proves renderer bootstrap, not OS-window visibility.
// DevTools is enabled ONLY for this isolated CI process, on localhost.
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'darwin') {
  throw new Error('macOS packaged smoke must run on a real macOS runner');
}

const arch = process.arch === 'arm64' ? 'mac-arm64' : 'mac';
const executable = path.resolve('electron/release', arch, 'Bridge.app/Contents/MacOS/Bridge');
if (!existsSync(executable)) throw new Error(`No packaged Bridge.app native executable: ${executable}`);

function availableLoopbackPort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') return reject(new Error('No IPv4 loopback port'));
      server.close((err) => err ? reject(err) : resolve(address.port));
    });
  });
}

const workspace = mkdtempSync(path.join(tmpdir(), 'bridge-macos-smoke-'));
let child = null;
let stderr = '';
let stdout = '';
let stopped = false;
try {
  const port = await availableLoopbackPort();
  child = spawn(executable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(workspace, 'profile')}`,
  ], {
    env: { ...process.env, HOME: workspace },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (s) => { stdout = (stdout + s).slice(-8000); });
  child.stderr.on('data', (s) => { stderr = (stderr + s).slice(-8000); });
  child.once('error', (err) => { stopped = true; stderr += String(err); });
  child.once('exit', () => { stopped = true; });

  const deadline = Date.now() + 45_000;
  let lastDetail = 'no renderer target reported';
  let succeeded = false;
  while (Date.now() < deadline) {
    if (stopped || child.exitCode !== null) {
      throw new Error(`Packaged macOS Bridge exited before the first-run page loaded (${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1600) });
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error('DevTools targets were not an array');
      const appPage = targets.find((t) => t?.type === 'page' &&
        t?.title === 'Bridge' &&
        /^file:\/\//.test(t?.url ?? '') &&
        /\/static\/connect\.html(?:[?#]|$)/.test(t?.url ?? ''));
      if (appPage) {
        succeeded = true;
        console.log(`PASS: macOS ${process.arch} native packaged Bridge launched; first-run connect.html renderer loaded`);
        break;
      }
      // Only log safe target types and page URLs from the isolated app.
      lastDetail = `Native process alive, targets: ${targets.map((t) => t?.type).join(', ') || 'none'}`;
    } catch (err) {
      lastDetail = String(err?.message ?? err).slice(0,220);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (!succeeded) throw new Error(`Packaged macOS first-run renderer did not load in 45s: ${lastDetail}`);
} catch (err) {
  console.error('FAIL: macOS packaged first-run smoke:', String(err?.message ?? err));
  if (stdout) console.error('App stdout (truncated):', stdout);
  if (stderr) console.error('App stderr (truncated):', stderr);
  process.exitCode = 1;
} finally {
  if (child && !stopped) {
    child.kill('SIGTERM');
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (!stopped) child.kill('SIGKILL');
  }
  rmSync(workspace, { recursive: true, force: true });
}
