import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, generateKeyPairSync } from 'node:crypto';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts/portable-trust-registry.mjs');
const ORIGIN = 'https://source.example';

function cli(...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', timeout: 15000 });
}
function work(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-p7-trust-'));
  chmodSync(dir, 0o700);
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
function keyFile(dir, name) {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = join(dir, name + '.pub.pem');
  const priv = join(dir, name + '.priv.pem');
  writeFileSync(pub, publicKey.export({ type: 'spki', format: 'pem' }));
  writeFileSync(priv, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  const fingerprint = createHash('sha256').update(publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { pub, priv, fingerprint };
}
const iso = (ms) => new Date(ms).toISOString();
function add(reg, k, extra = {}) {
  const flags = {
    '--registry': reg, '--origin': ORIGIN, '--public-key': k.pub,
    '--expect-fingerprint': k.fingerprint,
    '--active-from': iso(Date.now() - 3600_000), '--active-until': iso(Date.now() + 90 * 86400_000),
    '--operator': 'dest-operator', '--reason': 'initial pin after phone confirmation', ...extra,
  };
  return cli('add', ...Object.entries(flags).flat());
}
const auditLines = (reg) => readFileSync(reg + '.audit.jsonl', 'utf8').trim().split('\n').map((l) => JSON.parse(l));

test('add pins only an out-of-band confirmed key and writes a secret-free audit record', () => work((dir) => {
  const reg = join(dir, 'registry.json');
  const k = keyFile(dir, 'a');
  const wrong = add(reg, k, { '--expect-fingerprint': 'f'.repeat(64) });
  assert.equal(wrong.status, 1);
  assert.match(wrong.stderr, /Fingerprint mismatch/);
  assert.equal(existsSync(reg), false, 'a mismatched key must not create a registry');

  const ok = add(reg, k);
  assert.equal(ok.status, 0, ok.stderr);
  const registry = JSON.parse(readFileSync(reg, 'utf8'));
  assert.equal(registry.keys.length, 1);
  assert.equal(registry.keys[0].revoked, false);
  const [record] = auditLines(reg);
  assert.equal(record.action, 'add');
  assert.equal(record.fingerprint, k.fingerprint);
  assert.equal(record.registrySha256, createHash('sha256').update(readFileSync(reg)).digest('hex'));
  const auditText = readFileSync(reg + '.audit.jsonl', 'utf8');
  assert.doesNotMatch(auditText, /BEGIN|PRIVATE/);

  const dup = add(reg, k);
  assert.equal(dup.status, 1, 'the same key cannot be pinned twice for one origin');
}));

test('a private key file is refused even when its fingerprint is supplied', () => work((dir) => {
  const reg = join(dir, 'registry.json');
  const k = keyFile(dir, 'a');
  const out = add(reg, k, { '--public-key': k.priv });
  assert.equal(out.status, 1);
  assert.match(out.stderr, /PRIVATE key material/);
  assert.doesNotMatch(out.stderr + out.stdout, /BEGIN/);
}));

test('rotate keeps both keys only for a bounded overlap; revoke is unconditional', () => work((dir) => {
  const reg = join(dir, 'registry.json');
  const oldKey = keyFile(dir, 'old');
  const newKey = keyFile(dir, 'new');
  assert.equal(add(reg, oldKey).status, 0);
  const rotate = (extra = {}) => cli('rotate', ...Object.entries({
    '--registry': reg, '--origin': ORIGIN, '--retire-fingerprint': oldKey.fingerprint,
    '--public-key': newKey.pub, '--expect-fingerprint': newKey.fingerprint,
    '--overlap-until': iso(Date.now() + 7 * 86400_000), '--active-until': iso(Date.now() + 180 * 86400_000),
    '--operator': 'dest-operator', '--reason': 'scheduled rotation', ...extra,
  }).flat());

  assert.equal(rotate({ '--overlap-until': iso(Date.now() + 45 * 86400_000) }).status, 1, 'overlap > 30 days');
  assert.equal(rotate({ '--overlap-until': iso(Date.now() - 1000) }).status, 1, 'overlap in the past');
  assert.equal(rotate({ '--active-until': iso(Date.now() + 86400_000) }).status, 1, 'new key must outlive overlap');
  const ok = rotate();
  assert.equal(ok.status, 0, ok.stderr);
  const keys = JSON.parse(readFileSync(reg, 'utf8')).keys;
  assert.equal(keys.length, 2);
  const listed = cli('list', '--registry', reg);
  assert.equal(listed.status, 0);
  assert.equal(listed.stdout.trim().split('\n').filter((l) => l.startsWith('active')).length, 2);
  const after = cli('list', '--registry', reg, '--at', iso(Date.now() + 8 * 86400_000));
  assert.match(after.stdout, new RegExp('expired .*' + oldKey.fingerprint));
  assert.match(after.stdout, new RegExp('active .*' + newKey.fingerprint));

  const revoked = cli('revoke', '--registry', reg, '--fingerprint', newKey.fingerprint,
    '--operator', 'dest-operator', '--reason', 'suspected compromise');
  assert.equal(revoked.status, 0, revoked.stderr);
  assert.match(cli('list', '--registry', reg).stdout, new RegExp('revoked .*' + newKey.fingerprint));
  assert.deepEqual(auditLines(reg).map((r) => r.action), ['add', 'rotate', 'revoke']);
}));

test('env emits canonical base64 of the public registry only', () => work((dir) => {
  const reg = join(dir, 'registry.json');
  const k = keyFile(dir, 'a');
  assert.equal(add(reg, k).status, 0);
  const out = cli('env', '--registry', reg);
  assert.equal(out.status, 0);
  const line = out.stdout.trim();
  const name = line.slice(0, line.indexOf('='));
  const value = line.slice(line.indexOf('=') + 1);
  assert.equal(name, 'BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64');
  const decoded = Buffer.from(value, 'base64');
  assert.equal(decoded.toString('base64'), value);
  assert.doesNotMatch(decoded.toString('utf8'), /PRIVATE/);
  assert.equal(JSON.parse(decoded.toString('utf8')).keys[0].revoked, false);
}));

test('refuses world-writable directories, symlinked registries and unknown options', () => work((dir) => {
  const k = keyFile(dir, 'a');
  chmodSync(dir, 0o777);
  assert.equal(add(join(dir, 'registry.json'), k).status, 1);
  chmodSync(dir, 0o700);
  writeFileSync(join(dir, 'elsewhere.json'), '{}');
  symlinkSync(join(dir, 'elsewhere.json'), join(dir, 'linked.json'));
  assert.equal(add(join(dir, 'linked.json'), k).status, 1);
  assert.equal(cli('add', '--registry', join(dir, 'r.json'), '--bogus', 'x').status, 1);
  assert.equal(cli('delete-everything').status, 1);
}));
