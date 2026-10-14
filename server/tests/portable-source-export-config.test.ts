import { generateKeyPairSync } from 'node:crypto';
import { readPortableSourceSigningConfig, PortableSourceSigningUnavailable } from '../lib/portableSourceExportConfig';

const ORIGIN = 'https://operator-owned-source.example';
const validPrivate = generateKeyPairSync('ed25519').privateKey
  .export({ type: 'pkcs8', format: 'pem' }).toString();
const secret = Buffer.from(validPrivate, 'utf8').toString('base64');
function env(input: Record<string, string | undefined> = {}) {
  return {
    BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED: 'true',
    BRIDGE_PORTABLE_SOURCE_ORIGIN: ORIGIN,
    BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: secret,
    ...input,
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

describe('P7 C4 signed community export explicit deployer configuration', () => {
  it('rejects default-off and any non-literal opt-in', () => {
    for (const flag of [undefined, '', 'TRUE', '1', 'false', 'yes']) {
      expect(() => readPortableSourceSigningConfig(env({
        BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED: flag,
      }))).toThrow(PortableSourceSigningUnavailable);
    }
    expect(() => readPortableSourceSigningConfig({})).toThrow(PortableSourceSigningUnavailable);
  });

  it('only permits a canonical HTTPS origin and PEM Ed25519 key provisioned out of band', () => {
    expect(readPortableSourceSigningConfig(env())).toEqual({
      sourceOrigin: ORIGIN, signingPrivateKeyPem: validPrivate,
    });
    for (const sourceOrigin of [
      '', 'http://operator-owned-source.example', 'https://operator-owned-source.example/',
      'https://operator-owned-source.example/path', 'https://operator-owned-source.example:443',
      'https://operator-owned-source.example?token=1', 'javascript:evil',
    ]) {
      expect(() => readPortableSourceSigningConfig(env({
        BRIDGE_PORTABLE_SOURCE_ORIGIN: sourceOrigin,
      }))).toThrow(PortableSourceSigningUnavailable);
    }
  });

  it('fails closed for a missing, malformed, noncanonical, oversized or wrong-algorithm key', () => {
    const rsaPem = generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey
      .export({ type: 'pkcs8', format: 'pem' }).toString();
    for (const encoded of [
      undefined, '', '%%%$', Buffer.from('random text').toString('base64'),
      Buffer.from(rsaPem).toString('base64'), 'A'.repeat(5000),
      secret + ' ', secret + '===', secret.replace(/.$/, secret.endsWith('A') ? 'B' : 'A'),
      // OpenSSL can parse a valid PEM while ignoring appended text. Reject it.
      Buffer.from(validPrivate + 'malicious suffix', 'utf8').toString('base64'),
      Buffer.from(validPrivate + validPrivate, 'utf8').toString('base64'),
      Buffer.from(validPrivate.trimEnd(), 'utf8').toString('base64'),
    ]) {
      expect(() => readPortableSourceSigningConfig(env({
        BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: encoded,
      }))).toThrow(PortableSourceSigningUnavailable);
    }
  });

  it('refuses a second base64 spelling of the same private key', () => {
    const twin = base64Twin(secret);
    expect(twin).not.toBe(secret);
    expect(Buffer.from(twin, 'base64').equals(Buffer.from(secret, 'base64'))).toBe(true);
    expect(readPortableSourceSigningConfig(env()).signingPrivateKeyPem).toBe(validPrivate);
    expect(() => readPortableSourceSigningConfig(env({
      BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: twin,
    }))).toThrow(PortableSourceSigningUnavailable);
  });

  it('never embeds actual key material in the exception or serialized metadata', () => {
    try {
      readPortableSourceSigningConfig(env({
        BRIDGE_PORTABLE_SOURCE_ORIGIN: 'http://bad.example',
      }));
      throw new Error('expected to reject');
    } catch (err) {
      expect(err).toBeInstanceOf(PortableSourceSigningUnavailable);
      expect(String(err)).not.toContain(validPrivate);
      expect(JSON.stringify(err)).not.toContain(secret);
    }
  });
});
