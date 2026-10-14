// P7 C4: the operator registry CLI and the server must agree. The registry the
// CLI writes is decoded by the SERVER's own reader and used by the server's
// own verifier through add -> rotate (overlap) -> revoke, and the boot-time
// trust summary never carries private material.
process.env.NODE_ENV = 'test';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { createHash, generateKeyPairSync, sign, type KeyObject } from 'node:crypto';
import logger from '../lib/logger';
import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPermissionManifest } from '../lib/portableCommunityPermissions';
import { portableSourceAttestationSigningBytes, type PortableSourceAttestation } from '../lib/portableSourceAttestation';
import { readDestinationPinnedSourceRegistry } from '../lib/portableDestinationTrustConfig';
import { verifyAttestationAgainstPinnedRegistry } from '../lib/portableSourceKeyring';
import { reportPortableTrust, summarizePortableTrust } from '../lib/portableTrustReport';

const CLI = resolve(__dirname, '../../scripts/portable-trust-registry.mjs');
const ORIGIN = 'https://source.example';
const SOURCE = 'source-community';
const iso = (ms: number) => new Date(ms).toISOString();

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bridge-trust-contract-'));
  chmodSync(dir, 0o700);
  jest.clearAllMocks();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function key(name: string) {
  const pair = generateKeyPairSync('ed25519');
  const file = join(dir, name + '.pub.pem');
  writeFileSync(file, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const fingerprint = createHash('sha256')
    .update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex');
  return { ...pair, file, fingerprint };
}
function cli(...args: string[]) {
  const out = spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 15000 });
  if (out.status !== 0) throw new Error('CLI refused: ' + out.stderr);
  return out.stdout;
}
function envFromCli(registry: string): NodeJS.ProcessEnv {
  const line = cli('env', '--registry', registry).trim();
  return {
    BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED: 'true',
    BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: line.slice(line.indexOf('=') + 1),
  };
}
function signedBundle(privateKey: KeyObject, fingerprint: string) {
  const at = iso(Date.now());
  const server = { _id: SOURCE, name: 'Source' };
  const roles = [{ _id: 'r', serverId: SOURCE, name: 'Readers', color: '#99aab5', position: 0, permissions: 1 }];
  const channels = [{ _id: 'c', serverId: SOURCE, name: 'welcome', type: 'text', order: 0 }];
  const structure = buildPortableCommunityStructure(server, [], channels, roles, at);
  const permissions = buildPortableCommunityPermissionManifest(server, channels, roles,
    [{ channelId: 'c', legacy: [], canonical: [] }], at);
  const fields: Omit<PortableSourceAttestation, 'signature'> = {
    format: 'bridge-portable-community-source-attestation', version: 1,
    sourceOrigin: ORIGIN, sourceServerId: SOURCE, snapshotId: 'contract-snapshot-0123456789',
    structureDigest: structure.integrity.digest, permissionsDigest: permissions.integrity.digest,
    issuedAt: at, expiresAt: iso(Date.now() + 120_000), keyFingerprint: fingerprint,
  };
  const attestation = { ...fields,
    signature: sign(null, portableSourceAttestationSigningBytes(fields), privateKey).toString('base64url') };
  return { structure, permissions, attestation };
}
function verifies(env: NodeJS.ProcessEnv, bundle: ReturnType<typeof signedBundle>): boolean {
  try {
    verifyAttestationAgainstPinnedRegistry({
      ...bundle, expectedSourceOrigin: ORIGIN, expectedSourceServerId: SOURCE,
      operatorRegistryJson: readDestinationPinnedSourceRegistry(env),
    });
    return true;
  } catch { return false; }
}

describe('P7 C4 operator trust registry CLI <-> server contract', () => {
  it('add -> rotate (overlap) -> revoke drives exactly the keys the server verifier accepts', () => {
    const reg = join(dir, 'registry.json');
    const oldKey = key('old'), newKey = key('new'), rogue = key('rogue');
    cli('add', '--registry', reg, '--origin', ORIGIN, '--public-key', oldKey.file,
      '--expect-fingerprint', oldKey.fingerprint, '--active-from', iso(Date.now() - 3600_000),
      '--active-until', iso(Date.now() + 90 * 86400_000), '--operator', 'op', '--reason', 'pin');
    const oldBundle = signedBundle(oldKey.privateKey, oldKey.fingerprint);
    // Signed by the next key BEFORE the destination pinned it.
    const prePinBundle = signedBundle(newKey.privateKey, newKey.fingerprint);
    expect(verifies(envFromCli(reg), oldBundle)).toBe(true);
    expect(verifies(envFromCli(reg), prePinBundle)).toBe(false);
    // A key never pinned is refused even when it claims its own fingerprint.
    expect(verifies(envFromCli(reg), signedBundle(rogue.privateKey, rogue.fingerprint))).toBe(false);

    cli('rotate', '--registry', reg, '--origin', ORIGIN, '--retire-fingerprint', oldKey.fingerprint,
      '--public-key', newKey.file, '--expect-fingerprint', newKey.fingerprint,
      '--overlap-until', iso(Date.now() + 7 * 86400_000), '--active-until', iso(Date.now() + 180 * 86400_000),
      '--operator', 'op', '--reason', 'rotation');
    // Overlap: both signers verify, so no in-flight export is stranded. A
    // signature dated before the new pin's activeFrom is still refused.
    const newBundle = signedBundle(newKey.privateKey, newKey.fingerprint);
    expect(verifies(envFromCli(reg), oldBundle)).toBe(true);
    expect(verifies(envFromCli(reg), newBundle)).toBe(true);
    expect(verifies(envFromCli(reg), prePinBundle)).toBe(false);

    cli('revoke', '--registry', reg, '--fingerprint', oldKey.fingerprint,
      '--operator', 'op', '--reason', 'compromise drill');
    expect(verifies(envFromCli(reg), oldBundle)).toBe(false);
    expect(verifies(envFromCli(reg), newBundle)).toBe(true);

    const summary = summarizePortableTrust(envFromCli(reg));
    expect(summary.destination.keys.map(k => [k.fingerprint, k.state])).toEqual([
      [oldKey.fingerprint, 'revoked'], [newKey.fingerprint, 'active'],
    ]);
    expect(summary.destination.activeKeys).toBe(1);
  });

  it('summarizes source signing by PUBLIC fingerprint only and never logs private material', () => {
    const pair = generateKeyPairSync('ed25519');
    const pem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
    const b64 = Buffer.from(pem).toString('base64');
    const env = {
      BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED: 'true',
      BRIDGE_PORTABLE_SOURCE_ORIGIN: ORIGIN,
      BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: b64,
    };
    const summary = summarizePortableTrust(env);
    expect(summary.source).toEqual({
      enabled: true, valid: true, sourceOrigin: ORIGIN,
      keyFingerprint: createHash('sha256').update(pair.publicKey.export({ type: 'spki', format: 'der' })).digest('hex'),
    });
    reportPortableTrust(env);
    const logged = JSON.stringify((logger.info as jest.Mock).mock.calls);
    expect(logged).toContain('portable.trust.effective');
    for (const secret of [pem, b64, 'PRIVATE KEY']) expect(logged).not.toContain(secret);
  });

  it('flags half-configured or failing trust instead of staying silent', () => {
    expect(summarizePortableTrust({
      BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED: 'true', BRIDGE_PORTABLE_SOURCE_ORIGIN: ORIGIN,
      BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: 'not-a-key',
    }).warnings).toEqual(['SOURCE_SIGNING_CONFIG_INVALID']);
    expect(summarizePortableTrust({
      BRIDGE_PORTABLE_MAPPED_APPLY_ENABLED: 'true',
    }).warnings).toEqual([
      'IMPORT_STAGES_ENABLED_WITHOUT_VALID_TRUST_REGISTRY', 'MAPPED_APPLY_ENABLED_WITHOUT_OWNER_APPROVAL',
    ]);

    const reg = join(dir, 'registry.json');
    const k = key('soon');
    cli('add', '--registry', reg, '--origin', ORIGIN, '--public-key', k.file,
      '--expect-fingerprint', k.fingerprint, '--active-from', iso(Date.now() - 3600_000),
      '--active-until', iso(Date.now() + 3 * 86400_000), '--operator', 'op', '--reason', 'short');
    const soon = summarizePortableTrust(envFromCli(reg));
    expect(soon.warnings).toEqual(['PINNED_SOURCE_KEY_EXPIRES_WITHIN_14_DAYS']);
    cli('revoke', '--registry', reg, '--fingerprint', k.fingerprint, '--operator', 'op', '--reason', 'drill');
    expect(summarizePortableTrust(envFromCli(reg)).warnings).toEqual(['NO_ACTIVE_PINNED_SOURCE_KEY']);

    reportPortableTrust({});
    expect(logger.info).not.toHaveBeenCalled();
  });
});
