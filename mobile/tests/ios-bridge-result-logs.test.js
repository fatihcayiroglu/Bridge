'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { redactIosBridgeResults, RAW, SAFE } = require('../scripts/redact-ios-bridge-results.js');
const SDK = path.resolve(__dirname, '../../node_modules/@capacitor/ios');
const RELATIVE_SOURCE = 'Capacitor/Capacitor/CapacitorBridge.swift';
const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ios-result-privacy-'));
  roots.push(root);
  const sdk = path.join(root, 'node_modules/@capacitor/ios');
  for (const file of ['package.json', RELATIVE_SOURCE]) {
    fs.mkdirSync(path.dirname(path.join(sdk, file)), { recursive: true });
    fs.copyFileSync(path.join(SDK, file), path.join(sdk, file));
  }
  // Tests also run after cap sync applied the patch. Reconstruct only that
  // known original line in this disposable copy; retain the actual SDK body.
  const source = path.join(sdk, RELATIVE_SOURCE);
  fs.writeFileSync(source, fs.readFileSync(source, 'utf8').replace(SAFE, RAW));
  return { root, sdk, file: path.join(sdk, RELATIVE_SOURCE) };
}

afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('redacts the installed SDK result logger only, preserves delivery/error handling, and is idempotent', () => {
  const { root, file } = fixture();
  const before = fs.readFileSync(file, 'utf8');
  expect(before).toContain(RAW); // the shipped logger is the negative control
  expect(redactIosBridgeResults(root)).toEqual({ changed: true });
  const after = fs.readFileSync(file, 'utf8');
  expect(after).toBe(before.replace(RAW, SAFE));
  expect(after).not.toContain(RAW);
  expect(redactIosBridgeResults(root)).toEqual({ changed: false });
  expect(fs.readFileSync(file, 'utf8')).toBe(after);
});

it.each(['sdk-version', 'unknown-source', 'duplicate-logger'])('fails closed for %s without changing SDK source', kind => {
  const { root, sdk, file } = fixture();
  if (kind === 'sdk-version') fs.writeFileSync(path.join(sdk, 'package.json'), JSON.stringify({ version: '8.4.4' }));
  if (kind === 'unknown-source') fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(RAW, 'CAPLog.print("changed logger")'));
  if (kind === 'duplicate-logger') fs.appendFileSync(file, `\n${RAW}\n`);
  const before = fs.readFileSync(file, 'utf8');
  expect(() => redactIosBridgeResults(root)).toThrow(/IOS_RESULT_LOG_.*REVIEW_REQUIRED/);
  expect(fs.readFileSync(file, 'utf8')).toBe(before);
});

it('refuses a shared dependency symlink without changing the target', () => {
  const target = fixture();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-ios-result-shared-'));
  roots.push(root);
  fs.symlinkSync(path.join(target.root, 'node_modules'), path.join(root, 'node_modules'), 'dir');
  const before = fs.readFileSync(target.file, 'utf8');
  expect(() => redactIosBridgeResults(root)).toThrow('IOS_RESULT_LOG_SHARED_DEPENDENCY_ROOT');
  expect(fs.readFileSync(target.file, 'utf8')).toBe(before);
});
