// P7 C4: DESTINATION operator tool for the pinned source-key registry.
// Offline, public material only. It never fetches a key, never trusts a key
// it was handed without an out-of-band fingerprint match, and never touches
// a private key. Every change appends a secret-free audit record.
//
//   list    --registry FILE [--at ISO]
//   add     --registry FILE --origin URL --public-key PEM --expect-fingerprint HEX
//           --active-from ISO --active-until ISO --operator NAME --reason TEXT
//   rotate  --registry FILE --origin URL --retire-fingerprint HEX --public-key PEM
//           --expect-fingerprint HEX --overlap-until ISO --active-until ISO
//           --operator NAME --reason TEXT
//   revoke  --registry FILE --fingerprint HEX --operator NAME --reason TEXT
//   env     --registry FILE
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, lstatSync, openSync, readFileSync, renameSync,
  unlinkSync, writeSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

const FORMAT = 'bridge-portable-source-trust-registry';
const MAX_KEYS = 32;
const MAX_BYTES = 64 * 1024;
const MAX_OVERLAP_MS = 30 * 24 * 3600_000;
const HEX = /^[0-9a-f]{64}$/;
const COMMANDS = {
  list: { required: ['--registry'], optional: ['--at'] },
  add: { required: ['--registry', '--origin', '--public-key', '--expect-fingerprint',
    '--active-from', '--active-until', '--operator', '--reason'], optional: [] },
  rotate: { required: ['--registry', '--origin', '--retire-fingerprint', '--public-key',
    '--expect-fingerprint', '--overlap-until', '--active-until', '--operator', '--reason'], optional: [] },
  revoke: { required: ['--registry', '--fingerprint', '--operator', '--reason'], optional: [] },
  env: { required: ['--registry'], optional: [] },
};

function refuse(reason) { throw new Error(reason); }

function parse(argv) {
  const [command, ...rest] = argv;
  const spec = COMMANDS[command];
  if (!spec) refuse('Expected one of: ' + Object.keys(COMMANDS).join(', ') + '.');
  const allowed = new Set([...spec.required, ...spec.optional]);
  const flags = {};
  if (rest.length % 2 !== 0) refuse('Every option needs exactly one value.');
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i], value = rest[i + 1];
    if (!allowed.has(key) || key in flags || !value || value.startsWith('--')) {
      refuse('Invalid or duplicated option: ' + key);
    }
    flags[key] = value;
  }
  for (const key of spec.required) if (!(key in flags)) refuse('Missing option ' + key + '.');
  return { command, flags };
}

function canonicalTime(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    refuse(label + ' must be an exact UTC ISO timestamp with milliseconds.');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) refuse('Invalid ' + label + '.');
  return time;
}
function canonicalOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { refuse('Invalid source origin.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value || parsed.username || parsed.password) {
    refuse('Source origin must be a canonical HTTPS origin without a path.');
  }
  return value;
}
function fingerprintArg(value, label) {
  if (typeof value !== 'string' || !HEX.test(value)) refuse(label + ' must be 64 lowercase hex characters.');
  return value;
}
function text(value, label) {
  // Audit fields are operator-visible metadata: bounded and single-line.
  if (typeof value !== 'string' || !value.trim() || value.length > 200 || /[\x00-\x1f\x7f]/.test(value)) {
    refuse(label + ' must be 1-200 printable characters on one line.');
  }
  return value;
}

/** Public key from a file. Private material is refused outright. */
function loadPublicKey(file) {
  const raw = readFileSync(resolve(file), 'utf8');
  if (raw.length > 4096) refuse('Public key file is too large.');
  let isPrivate = false;
  try { createPrivateKey(raw); isPrivate = true; } catch { /* expected for a public key */ }
  if (isPrivate || /PRIVATE KEY/.test(raw)) {
    refuse('That file holds PRIVATE key material. Destination operators never handle it.');
  }
  let key;
  try { key = createPublicKey(raw); } catch { refuse('Not a readable public key.'); }
  if (key.asymmetricKeyType !== 'ed25519') refuse('Source signing keys must be Ed25519.');
  return {
    pem: key.export({ type: 'spki', format: 'pem' }).toString(),
    fingerprint: createHash('sha256').update(key.export({ type: 'spki', format: 'der' })).digest('hex'),
  };
}

function fingerprintOfPem(pem) {
  return createHash('sha256').update(createPublicKey(pem).export({ type: 'spki', format: 'der' })).digest('hex');
}

/** Mirrors server/lib/portableSourceKeyring.ts so a bad file never deploys. */
function validate(registry) {
  if (!registry || registry.format !== FORMAT || registry.version !== 1 ||
      Object.keys(registry).length !== 3 || !Array.isArray(registry.keys) ||
      registry.keys.length < 1 || registry.keys.length > MAX_KEYS) refuse('Registry shape is invalid.');
  const seen = new Set();
  for (const k of registry.keys) {
    const fields = ['sourceOrigin', 'publicKeyPem', 'activeFrom', 'activeUntil', 'revoked'];
    if (Object.keys(k).length !== fields.length || !fields.every((f) => f in k)) refuse('Registry entry has unexpected fields.');
    canonicalOrigin(k.sourceOrigin);
    if (typeof k.revoked !== 'boolean') refuse('Registry entry revoked flag must be boolean.');
    if (canonicalTime(k.activeFrom, 'activeFrom') >= canonicalTime(k.activeUntil, 'activeUntil')) {
      refuse('Registry entry window must increase.');
    }
    const key = createPublicKey(k.publicKeyPem);
    if (key.asymmetricKeyType !== 'ed25519' || key.export({ type: 'spki', format: 'pem' }).toString() !== k.publicKeyPem) {
      refuse('Registry entry public key is not canonical Ed25519 SPKI PEM.');
    }
    const tuple = k.sourceOrigin + '\n' + fingerprintOfPem(k.publicKeyPem);
    if (seen.has(tuple)) refuse('Registry already pins that key for that origin.');
    seen.add(tuple);
  }
  const bytes = JSON.stringify(registry, null, 2) + '\n';
  if (Buffer.byteLength(bytes) > MAX_BYTES) refuse('Registry would exceed 64 KiB.');
  return bytes;
}

function registryPath(value) {
  const file = resolve(value);
  const dir = dirname(file);
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink()) refuse('Registry directory must be a real directory.');
  // The registry is public, but whoever can write it decides whom B trusts.
  if (typeof process.getuid === 'function' &&
      (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) {
    refuse('Registry directory must be owned by the operator and not group/world writable.');
  }
  if (existsSync(file) && lstatSync(file).isSymbolicLink()) refuse('Registry file must not be a symlink.');
  return file;
}

function load(file, { allowMissing = false } = {}) {
  if (!existsSync(file)) {
    if (allowMissing) return null;
    refuse('Registry file does not exist.');
  }
  let registry;
  try { registry = JSON.parse(readFileSync(file, 'utf8')); } catch { refuse('Registry is not valid JSON.'); }
  validate(registry);
  return registry;
}

/** Replace atomically: a crash leaves either the old or the new registry. */
function writeAtomic(file, bytes) {
  const temp = join(dirname(file), '.' + basename(file) + '.' + process.pid + '.tmp');
  const fd = openSync(temp, 'wx', 0o644);
  try { writeSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
  try { renameSync(temp, file); } catch (err) { try { unlinkSync(temp); } catch { /* ignore */ } throw err; }
}

function audit(file, record, bytes) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    ...record,
    registrySha256: createHash('sha256').update(bytes).digest('hex'),
  }) + '\n';
  const fd = openSync(file + '.audit.jsonl', 'a', 0o644);
  try { writeSync(fd, line); fsyncSync(fd); } finally { closeSync(fd); }
}

function state(k, now) {
  if (k.revoked) return 'revoked';
  if (now < Date.parse(k.activeFrom)) return 'pending';
  if (now >= Date.parse(k.activeUntil)) return 'expired';
  return 'active';
}

function main() {
  const { command, flags } = parse(process.argv.slice(2));
  const file = registryPath(flags['--registry']);
  const out = (s) => process.stdout.write(s + '\n');

  if (command === 'list') {
    const now = flags['--at'] ? canonicalTime(flags['--at'], '--at') : Date.now();
    for (const k of load(file).keys) {
      out([state(k, now).padEnd(8), k.sourceOrigin, fingerprintOfPem(k.publicKeyPem), k.activeFrom, k.activeUntil].join('  '));
    }
    return;
  }
  if (command === 'env') {
    const bytes = validate(load(file));
    out('BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64=' + Buffer.from(bytes.trimEnd()).toString('base64'));
    return;
  }

  const operator = text(flags['--operator'], '--operator');
  const reason = text(flags['--reason'], '--reason');

  if (command === 'add' || command === 'rotate') {
    const origin = canonicalOrigin(flags['--origin']);
    const expected = fingerprintArg(flags['--expect-fingerprint'], '--expect-fingerprint');
    const key = loadPublicKey(flags['--public-key']);
    // The pin is only as good as this comparison: the fingerprint must come
    // from the SOURCE operator over a channel independent of the key file.
    if (key.fingerprint !== expected) {
      refuse('Fingerprint mismatch: the key file is ' + key.fingerprint + ', not the independently confirmed value.');
    }
    const until = canonicalTime(flags['--active-until'], '--active-until');
    const registry = command === 'add'
      ? (load(file, { allowMissing: true }) ?? { format: FORMAT, version: 1, keys: [] })
      : load(file);
    let record;
    if (command === 'add') {
      const from = canonicalTime(flags['--active-from'], '--active-from');
      if (from >= until) refuse('Active window must increase.');
      registry.keys.push({ sourceOrigin: origin, publicKeyPem: key.pem,
        activeFrom: flags['--active-from'], activeUntil: flags['--active-until'], revoked: false });
      record = { action: 'add', sourceOrigin: origin, fingerprint: key.fingerprint,
        activeFrom: flags['--active-from'], activeUntil: flags['--active-until'] };
    } else {
      const retire = fingerprintArg(flags['--retire-fingerprint'], '--retire-fingerprint');
      const now = Date.now();
      const overlap = canonicalTime(flags['--overlap-until'], '--overlap-until');
      const old = registry.keys.find((k) => k.sourceOrigin === origin && fingerprintOfPem(k.publicKeyPem) === retire);
      if (!old) refuse('No pinned key with that fingerprint for that origin.');
      if (state(old, now) !== 'active') refuse('Only an active key can be rotated; revoke or add instead.');
      if (retire === key.fingerprint) refuse('The new key must differ from the retiring key.');
      if (overlap <= now || overlap > Date.parse(old.activeUntil) || overlap - now > MAX_OVERLAP_MS) {
        refuse('Overlap must end in the future, within the old key window and within 30 days.');
      }
      if (until <= overlap) refuse('The new key must outlive the overlap.');
      const activeFrom = new Date(now).toISOString();
      old.activeUntil = flags['--overlap-until'];
      registry.keys.push({ sourceOrigin: origin, publicKeyPem: key.pem,
        activeFrom, activeUntil: flags['--active-until'], revoked: false });
      record = { action: 'rotate', sourceOrigin: origin, retiredFingerprint: retire,
        fingerprint: key.fingerprint, overlapUntil: flags['--overlap-until'],
        activeFrom, activeUntil: flags['--active-until'] };
    }
    const bytes = validate(registry);
    writeAtomic(file, bytes);
    audit(file, { ...record, operator, reason }, bytes);
    out(command + ' recorded for ' + key.fingerprint + '. Deploy with: ' + basename(process.argv[1]) + ' env --registry ' + flags['--registry']);
    return;
  }

  // Emergency revocation is unconditional and takes effect when B reloads
  // the registry; it also cancels approvals already staged for that key.
  const target = fingerprintArg(flags['--fingerprint'], '--fingerprint');
  const registry = load(file);
  const hits = registry.keys.filter((k) => fingerprintOfPem(k.publicKeyPem) === target);
  if (hits.length === 0) refuse('No pinned key has that fingerprint.');
  for (const k of hits) k.revoked = true;
  const bytes = validate(registry);
  writeAtomic(file, bytes);
  audit(file, { action: 'revoke', fingerprint: target, origins: hits.map((k) => k.sourceOrigin), operator, reason }, bytes);
  out('revoked ' + target + ' for ' + hits.length + ' origin(s). Redeploy B now.');
}

try { main(); } catch (err) {
  process.stderr.write('Portable trust registry refused: ' + err.message + '\n');
  process.exitCode = 1;
}
