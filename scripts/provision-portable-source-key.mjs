// P7 C4 offline operator provisioning. No HTTP, no automatic trust bootstrap.
// Run ONLY in a protected provisioning environment, outside the Git worktree.
import { generateKeyPairSync, createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync, openSync, closeSync, writeFileSync, unlinkSync } from 'node:fs';
import { resolve, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const NAMES = Object.freeze({
  secret: 'portable-source-private.pem',
  public: 'portable-source-public.pem',
  registry: 'portable-destination-registry.json',
});
function refuse(reason) { throw new Error(reason); }

function options(argv) {
  const keys = new Set(['--out', '--origin', '--active-from', '--active-until']);
  if (argv.length !== 8) refuse('Expected --out, --origin, --active-from and --active-until.');
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i], val = argv[i + 1];
    if (!keys.has(key) || key in result || !val || val.startsWith('--')) {
      refuse('Invalid or duplicated provisioning option.');
    }
    result[key] = val;
  }
  if (Object.keys(result).length !== keys.size) refuse('Missing provisioning option.');
  return result;
}
function canonicalTime(value) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    refuse('Expected exact UTC ISO timestamps with milliseconds.');
  }
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) {
    refuse('Invalid UTC timestamp.');
  }
  return time;
}
function canonicalOrigin(value) {
  let parsed;
  try { parsed = new URL(value); } catch { refuse('Invalid source origin.'); }
  if (parsed.protocol !== 'https:' || parsed.origin !== value ||
      parsed.pathname !== '/' || parsed.search || parsed.hash ||
      parsed.username || parsed.password) {
    refuse('Source origin must be a canonical HTTPS origin without a path.');
  }
  return value;
}
function destination(value) {
  // Node's POSIX mode does not enforce Windows ACLs. Refuse an unverifiable
  // security guarantee rather than writing a potentially public private key.
  if (process.platform === 'win32' || typeof process.getuid !== 'function') {
    refuse('Provision in a hardened POSIX environment with mode-0700 storage.');
  }
  const dir = resolve(value);
  if (dir === ROOT || dir.startsWith(ROOT + sep)) {
    refuse('Refusing to store signing material inside the Bridge repository.');
  }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(dir) !== dir) {
    refuse('Output must be an existing real directory, not a symlink.');
  }
  if (info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
    refuse('Output directory must be owned by the operator and mode 0700.');
  }
  const paths = Object.values(NAMES).map(name => join(dir, name));
  if (paths.some(path => existsSync(path))) {
    refuse('Output already exists; refuse to overwrite a key or registry.');
  }
  return paths;
}

function main() {
  const flags = options(process.argv.slice(2));
  const sourceOrigin = canonicalOrigin(flags['--origin']);
  const activeFrom = flags['--active-from'];
  const activeUntil = flags['--active-until'];
  if (canonicalTime(activeFrom) >= canonicalTime(activeUntil)) {
    refuse('Signing key active window must increase.');
  }
  const paths = destination(flags['--out']);
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const privatePem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicPem = publicKey.export({ format: 'pem', type: 'spki' }).toString();
  const fingerprint = createHash('sha256')
    .update(publicKey.export({ format: 'der', type: 'spki' })).digest('hex');
  const registry = JSON.stringify({
    format: 'bridge-portable-source-trust-registry',
    version: 1,
    keys: [{ sourceOrigin, publicKeyPem: publicPem, activeFrom, activeUntil, revoked: false }],
  }, null, 2) + '\n';

  const created = [];
  try {
    for (const [index, content] of [privatePem, publicPem, registry].entries()) {
      // wx and mode 0600: never truncate an existing secret or follow an
      // already present final-path symlink; only trusted operators see files.
      // Record the newly created file before writing its bytes. A disk-full
      // or partial-write failure then cleans up even the incomplete key.
      const fd = openSync(paths[index], 'wx', 0o600);
      created.push(paths[index]);
      try { writeFileSync(fd, content, { encoding: 'utf8' }); }
      finally { closeSync(fd); }
    }
  } catch {
    // Never leave half-provisioned files after a write failure.
    for (const file of created.reverse()) {
      try { unlinkSync(file); } catch { /* still report failure */ }
    }
    refuse('Could not write the key bundle; check destination permissions.');
  }
  process.stdout.write('Ed25519 source public-key SHA-256: ' + fingerprint + '\n');
  process.stdout.write('Created three restricted local files; private PEM was NOT printed.\n');
  process.stdout.write('Deploy the private key ONLY via the source secret manager.\n');
  process.stdout.write('Independently verify and pin the public key at the destination.\n');
}

try { main(); } catch (err) {
  process.stderr.write('Portable provisioning refused: ' + err.message + '\n');
  process.exitCode = 1;
}
