import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdtempSync, readFileSync, readdirSync, statSync, mkdirSync,
  writeFileSync, symlinkSync, rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPrivateKey, createPublicKey, createHash, sign, verify } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/provision-portable-source-key.mjs');
const FROM = '2026-10-14T00:00:00.000Z';
const UNTIL = '2027-04-14T00:00:00.000Z';
function run(dir, replace = {}) {
  const flags = {
    '--out': dir,
    '--origin': 'https://source.example',
    '--active-from': FROM,
    '--active-until': UNTIL,
    ...replace,
  };
  const args = Object.entries(flags).flat();
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: 'utf8', timeout: 15000,
  });
}
function work(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-p7-key-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('offline key bootstrap matches source PKCS8 + destination SPKI + verifier registry contract', () =>
  work(dir => {
    const out = run(dir);
    assert.equal(out.status, 0, out.stderr);
    assert.equal(out.stderr, '');
    assert.deepEqual(readdirSync(dir).sort(), [
      'portable-destination-registry.json', 'portable-source-private.pem',
      'portable-source-public.pem',
    ]);
    const privatePem = readFileSync(join(dir, 'portable-source-private.pem'), 'utf8');
    const publicPem = readFileSync(join(dir, 'portable-source-public.pem'), 'utf8');
    const registry = JSON.parse(readFileSync(join(dir, 'portable-destination-registry.json'), 'utf8'));
    const key = createPrivateKey(privatePem);
    const publicKey = createPublicKey(publicPem);
    assert.equal(key.asymmetricKeyType, 'ed25519');
    assert.equal(publicKey.asymmetricKeyType, 'ed25519');
    assert.equal(createPublicKey(key).export({ type: 'spki', format: 'pem' }).toString(), publicPem);
    const fingerprint = createHash('sha256')
      .update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
    assert.match(out.stdout, new RegExp(fingerprint));
    assert.ok(!out.stdout.includes(privatePem));
    assert.ok(!out.stdout.includes(publicPem));
    assert.deepEqual(registry, {
      format: 'bridge-portable-source-trust-registry',
      version: 1,
      keys: [{
        sourceOrigin: 'https://source.example',
        publicKeyPem: publicPem,
        activeFrom: FROM,
        activeUntil: UNTIL,
        revoked: false,
      }],
    });
    const payload = Buffer.from('bridge independent source signature');
    assert.equal(verify(null, payload, publicKey, sign(null, payload, key)), true);
    if (process.platform !== 'win32') {
      for (const name of readdirSync(dir)) {
        assert.equal(statSync(join(dir, name)).mode & 0o777, 0o600);
      }
    }
  }));

test('existing key bundle is immutable and cannot be silently rotated', () =>
  work(dir => {
    assert.equal(run(dir).status, 0);
    const before = readFileSync(join(dir, 'portable-source-private.pem'));
    const second = run(dir);
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /refuse to overwrite/);
    assert.deepEqual(readFileSync(join(dir, 'portable-source-private.pem')), before);
    assert.equal(readdirSync(dir).length, 3);
  }));

test('noncanonical origins and timestamps refuse without generating files', () => {
  for (const replacements of [
    { '--origin': 'http://source.example' },
    { '--origin': 'https://source.example/path' },
    { '--origin': 'https://source.example/' },
    { '--origin': 'https://USER@source.example' },
    { '--origin': 'https://SOURCE.example' },
    { '--active-from': '2026-10-14' },
    { '--active-until': '2026-02-30T00:00:00.000Z' },
    { '--active-from': UNTIL },
  ]) {
    work(dir => {
      const x = run(dir, replacements);
      assert.notEqual(x.status, 0, JSON.stringify(replacements));
      assert.equal(readdirSync(dir).length, 0);
      assert.equal(x.stdout, '');
    });
  }
});

test('unsafe directories and output symlinks cannot receive private material', () =>
  work(dir => {
    const outside = join(dir, 'outside.pem');
    writeFileSync(outside, 'sentinel', { mode: 0o600 });
    const bundleDir = join(dir, 'safe');
    mkdirSync(bundleDir, { mode: 0o700 });
    symlinkSync(outside, join(bundleDir, 'portable-source-private.pem'));
    const result = run(bundleDir);
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(outside, 'utf8'), 'sentinel');
    assert.deepEqual(readdirSync(bundleDir), ['portable-source-private.pem']);
  }));

test('rejects output inside the repository even if the directory exists', () => {
  const result = run(ROOT);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Bridge repository/);
});

