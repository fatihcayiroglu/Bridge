// client/tests/mediasoup-client-loader.test.ts
//
// Regression: the production web bundle could not construct a mediasoup
// Device, so EVERY SFU voice join failed ("is not a constructor"). The unit
// suites mock `mediasoup-client` with named exports and never saw the shape
// the real bundle produces. The second test therefore builds the real loader
// with the production esbuild settings (esm + code splitting) and runs it.

import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mediasoupClientExports } from '../js/core/mediasoup-client-loader';

class FakeDevice {}

describe('mediasoupClientExports', () => {
  it('accepts a namespace with named exports (Node / unit-test mocks)', () => {
    const ns = { Device: FakeDevice };
    expect(mediasoupClientExports(ns).Device).toBe(FakeDevice);
  });

  it('unwraps a CommonJS namespace whose only export is default (production bundle)', () => {
    const ns = { default: { Device: FakeDevice } };
    expect(mediasoupClientExports(ns).Device).toBe(FakeDevice);
  });

  it('fails loudly instead of returning an unusable module', () => {
    expect(() => mediasoupClientExports({})).toThrow(/Device constructor/);
    expect(() => mediasoupClientExports({ default: {} })).toThrow(/Device constructor/);
    expect(() => mediasoupClientExports(null)).toThrow(/Device constructor/);
  });
});

describe('production bundle shape', () => {
  it('the lazily loaded, code-split mediasoup-client still yields a Device constructor', () => {
    const repo = path.resolve(__dirname, '..', '..');
    const work = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-msc-bundle-'));
    try {
      const entry = path.join(work, 'entry.ts');
      fs.writeFileSync(entry, [
        `import { loadMediasoupClient } from ${JSON.stringify(path.join(repo, 'client/js/core/mediasoup-client-loader.ts'))};`,
        'export async function probe() {',
        "  const raw = await import('mediasoup-client');",
        '  const mod = await loadMediasoupClient();',
        '  return { rawNamedDevice: typeof (raw as { Device?: unknown }).Device, loaderDevice: typeof mod.Device };',
        '}',
      ].join('\n'));
      // Same esbuild options that matter for the shape as scripts/build.js:
      // bundle + esm + splitting (+ the same browser targets).
      const probe = path.join(work, 'probe.mjs');
      fs.writeFileSync(probe, [
        `import { createRequire } from 'node:module';`,
        `import { pathToFileURL } from 'node:url';`,
        `const require = createRequire(${JSON.stringify(path.join(repo, 'package.json'))});`,
        `const esbuild = require('esbuild');`,
        `await esbuild.build({ entryPoints: [${JSON.stringify(entry)}], bundle: true, splitting: true, format: 'esm',`,
        `  outdir: ${JSON.stringify(path.join(work, 'out'))}, target: ['es2020', 'chrome90', 'firefox90', 'safari14.1'],`,
        `  nodePaths: [${JSON.stringify(path.join(repo, 'node_modules'))}], logLevel: 'error' });`,
        `const { probe } = await import(pathToFileURL(${JSON.stringify(path.join(work, 'out', 'entry.js'))}).href);`,
        `process.stdout.write(JSON.stringify(await probe()));`,
      ].join('\n'));
      const r = spawnSync(process.execPath, [probe], { encoding: 'utf8', timeout: 60_000 });
      expect(r.status, r.stderr).toBe(0);
      const out = JSON.parse(r.stdout) as { rawNamedDevice: string; loaderDevice: string };
      // The cause of the defect, measured on the real bundler output: a
      // code-split CommonJS chunk exposes no named `Device`.
      expect(out.rawNamedDevice).toBe('undefined');
      // The fix: the loader still hands the SFU client a constructor.
      expect(out.loaderDevice).toBe('function');
    } finally {
      fs.rmSync(work, { recursive: true, force: true });
    }
  }, 90_000);
});
