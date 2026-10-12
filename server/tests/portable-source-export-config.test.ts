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
      secret + ' ', secret + '===', secret.replace(/.$/, 'A'),
    ]) {
      expect(() => readPortableSourceSigningConfig(env({
        BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64: encoded,
      }))).toThrow(PortableSourceSigningUnavailable);
    }
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
