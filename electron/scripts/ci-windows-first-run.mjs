#!/usr/bin/env node
// Non-publishing Windows native smoke. Launches the real electron-builder
// win-unpacked executable; checks Chromium's actual first-run renderer through
// localhost DevTools. A compile-only or mocked Electron test is not sufficient.
// Evidence: Windows CI runner, unpacked unsigned executable (NOT installed NSIS,
// code signing, SmartScreen, microphone/camera, or human desktop interaction).
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

if (process.platform !== 'win32') {
  throw new Error('Windows packaged smoke must run on a native Windows runner');
}
const executable = path.resolve('electron/release/win-unpacked/Bridge.exe');
if (!existsSync(executable)) throw new Error(`Missing real packaged Bridge.exe: ${executable}`);

async function availablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close();
        reject(new Error('No IPv4 loopback port'));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

const workspace = mkdtempSync(path.join(tmpdir(), 'bridge-windows-native-'));
let child = null;
let stopped = false;
let stdout = '';
let stderr = '';
try {
  const port = await availablePort();
  child = spawn(executable, [
    '--remote-debugging-address=127.0.0.1',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${path.join(workspace, 'profile')}`,
  ], {
    env: {
      ...process.env,
      APPDATA: path.join(workspace, 'roaming'),
      LOCALAPPDATA: path.join(workspace, 'local'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout = (stdout + chunk).slice(-1200); });
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-1200); });
  child.on('error', (error) => { stopped = true; stderr += String(error); });
  child.on('exit', () => { stopped = true; });

  const deadline = Date.now() + 45_000;
  let lastDetail = 'no renderer target';
  let passed = false;
  while (Date.now() < deadline) {
    if (stopped || child.exitCode !== null) {
      throw new Error(`Packaged Bridge.exe exited before first-run renderer loaded (exit ${child.exitCode})`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(1600),
      });
      if (!response.ok) throw new Error(`DevTools HTTP ${response.status}`);
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error('Invalid native renderer target list');
      const appPage = targets.find((item) =>
        item?.type === 'page' &&
        item?.title === 'Bridge' &&
        /^file:\/\//.test(item?.url ?? '') &&
        /\/static\/connect\.html(?:[?#]|$)/.test(item?.url ?? ''));
      if (appPage) {
        console.log('PASS: Windows x64 packaged Bridge.exe loaded native first-run connect.html renderer');
        passed = true;
        break;
      }
      lastDetail = `Executable alive; renderer target types: ${targets.map((x) => x?.type).join(', ') || 'none'}`;
    } catch (error) {
      lastDetail = String(error?.message ?? error).slice(0, 220);
    }
    await new Promise((resolve) => setTimeout(resolve, 750));
  }
  if (!passed) throw new Error(`Windows packaged first-run renderer did not load in 45s: ${lastDetail}`);
} catch (error) {
  console.error('FAIL: Windows packaged native first-run smoke:', String(error?.message ?? error));
  if (stdout) console.error('Process stdout (truncated):', stdout);
  if (stderr) console.error('Process stderr (truncated):', stderr);
  process.exitCode = 1;
} finally {
  if (child && !stopped) {
    child.kill();
    await Promise.race([
      new Promise((resolve) => child.once('exit', resolve)),
      new Promise((resolve) => setTimeout(resolve, 3_000)),
    ]);
    if (!stopped) child.kill();
  }
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 250 });
}
