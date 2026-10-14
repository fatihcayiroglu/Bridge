import { generateKeyPairSync } from 'node:crypto';
import {
  readDestinationPinnedSourceRegistry,
  PortableDestinationTrustUnavailable,
} from '../lib/portableDestinationTrustConfig';

const pub = generateKeyPairSync('ed25519').publicKey
  .export({ type: 'spki', format: 'pem' }).toString();
const policy = JSON.stringify({
  format: 'bridge-portable-source-trust-registry',
  version: 1,
  keys: [{
    sourceOrigin: 'https://trusted-source.example',
    publicKeyPem: pub,
    activeFrom: '2026-10-01T00:00:00.000Z',
    activeUntil: '2027-10-01T00:00:00.000Z',
    revoked: false,
  }],
});
const token = Buffer.from(policy, 'utf8').toString('base64');
function env(change: Record<string, string | undefined> = {}) {
  return {
    BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED: 'true',
    BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: token,
    ...change,
  } as NodeJS.ProcessEnv;
}

/** A second base64 spelling of the same bytes: flips an unused low bit before the padding. */
function base64Twin(b64: string): string {
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  if (!pad) throw new Error('fixture must be padded to have unused bits');
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  const i = b64.length - pad - 1;
  return b64.slice(0, i) + alphabet[alphabet.indexOf(b64[i]!) ^ 1] + b64.slice(i + 1);
}

describe('P7 destination source registry must come from operator provisioning', () => {
  it('accepts only explicit opt-in and canonical base64 of pinned valid public keys', () => {
    expect(readDestinationPinnedSourceRegistry(env())).toBe(policy);
    for (const enabled of [undefined, '', 'yes', 'TRUE', '1', 'false']) {
      expect(() => readDestinationPinnedSourceRegistry(env({
        BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED: enabled,
      }))).toThrow(PortableDestinationTrustUnavailable);
    }
    expect(() => readDestinationPinnedSourceRegistry({})).toThrow(PortableDestinationTrustUnavailable);
  });

  it('rejects untrusted keys, malformed/oversized or noncanonical encodings', () => {
    const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 }).publicKey
      .export({ type: 'spki', format: 'pem' }).toString();
    const modified = JSON.stringify({
      ...JSON.parse(policy),
      keys: [{ ...JSON.parse(policy).keys[0], publicKeyPem: rsa }],
    });
    const bad = [
      undefined, '', '%%%!', token + '=', token + '\n', 'A'.repeat(120000),
      Buffer.from(modified).toString('base64'),
      Buffer.from(JSON.stringify({
        ...JSON.parse(policy), keys: [{
          ...JSON.parse(policy).keys[0], sourceOrigin: 'http://untrusted-source.example',
        }],
      })).toString('base64'),
    ];
    for (const encoded of bad) {
      expect(() => readDestinationPinnedSourceRegistry(env({
        BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: encoded,
      }))).toThrow(PortableDestinationTrustUnavailable);
    }
  });

  it('refuses a second base64 spelling of the same registry', () => {
    // Pad the JSON with insignificant whitespace until its base64 has padding.
    let padded = policy;
    while (Buffer.byteLength(padded) % 3 === 0) padded += ' ';
    const canonical = Buffer.from(padded, 'utf8').toString('base64');
    const twin = base64Twin(canonical);
    expect(Buffer.from(twin, 'base64').equals(Buffer.from(canonical, 'base64'))).toBe(true);
    expect(readDestinationPinnedSourceRegistry(env({ BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: canonical }))).toBe(padded);
    expect(() => readDestinationPinnedSourceRegistry(env({
      BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: twin,
    }))).toThrow(PortableDestinationTrustUnavailable);
  });

  it('never reveals policy content in errors', () => {
    try {
      readDestinationPinnedSourceRegistry(env({
        BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64: 'tampered',
      }));
      throw new Error('expected rejection');
    } catch (err) {
      expect(err).toBeInstanceOf(PortableDestinationTrustUnavailable);
      expect(JSON.stringify(err)).not.toContain(pub);
      expect(String(err)).not.toContain('trusted-source.example');
    }
  });
});
