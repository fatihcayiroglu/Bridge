// P7 C4: opt-in, deployer-owned signing identity for READ-ONLY source export.
// No auto-generated keys, client-supplied PEM, implicit TOFU or DNS key lookup.
import { createPrivateKey } from 'node:crypto';
import { isCanonicalPortableSourceOrigin } from './portableSourceAttestation';

export type PortableSourceSigningConfig = {
  sourceOrigin: string;
  signingPrivateKeyPem: string;
};

export class PortableSourceSigningUnavailable extends Error {
  readonly code = 'PORTABLE_SOURCE_SIGNING_UNAVAILABLE';
  constructor() {
    super('Attested source export is not configured');
    this.name = 'PortableSourceSigningUnavailable';
  }
}
function unavailable(): never { throw new PortableSourceSigningUnavailable(); }

/**
 * Call only AFTER authentication, current server owner check and a fresh
 * account.export step-up. The config never depends on request Host/Origin,
 * payload or user-provided public keys. A deployment must opt in explicitly.
 */
export function readPortableSourceSigningConfig(
  env: NodeJS.ProcessEnv = process.env,
): PortableSourceSigningConfig {
  if (env.BRIDGE_PORTABLE_SOURCE_EXPORT_ENABLED !== 'true') unavailable();
  const origin = env.BRIDGE_PORTABLE_SOURCE_ORIGIN;
  const encoded = env.BRIDGE_PORTABLE_SOURCE_ED25519_PRIVATE_KEY_B64;
  if (!isCanonicalPortableSourceOrigin(origin) ||
      typeof encoded !== 'string' || encoded.length < 48 || encoded.length > 4096 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) unavailable();

  try {
    const pem = Buffer.from(encoded, 'base64');
    if (pem.toString('base64') !== encoded || pem.length > 3072) unavailable();
    const signingPrivateKeyPem = pem.toString('utf8');
    const key = createPrivateKey(signingPrivateKeyPem);
    if (key.asymmetricKeyType !== 'ed25519') unavailable();
    // Node/OpenSSL may accept ignored trailing bytes after an otherwise
    // well-formed PEM block. Do NOT accept that as a different signing
    // identity: require the full decoded text to be canonical PKCS#8 PEM.
    const canonicalPem = key.export({ type: 'pkcs8', format: 'pem' }).toString();
    if (signingPrivateKeyPem !== canonicalPem) unavailable();
    return { sourceOrigin: origin, signingPrivateKeyPem };
  } catch { return unavailable(); }
}
