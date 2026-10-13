// P7 C4: destination operator's out-of-band pinned public-key registry.
// Read-only configuration; no TOFU, URL key discovery or client-submitted keys.
import { parsePinnedPortableSourceRegistry } from './portableSourceKeyring';

const MAX_REGISTRY_BYTES = 64 * 1024;
export class PortableDestinationTrustUnavailable extends Error {
  readonly code = 'PORTABLE_DESTINATION_TRUST_UNAVAILABLE';
  constructor() {
    super('Operator-pinned source trust configuration is unavailable');
    this.name = 'PortableDestinationTrustUnavailable';
  }
}
function unavailable(): never { throw new PortableDestinationTrustUnavailable(); }

/**
 * Requires deliberate deployment opt-in and a canonical base64 registry JSON.
 * Caller must also enforce authenticated DESTINATION OWNER + fresh account.import
 * step-up before obtaining this config. Never derive it from a request.
 */
export function readDestinationPinnedSourceRegistry(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BRIDGE_PORTABLE_DESTINATION_SOURCE_VERIFY_ENABLED !== 'true') unavailable();
  const encoded = env.BRIDGE_PORTABLE_DESTINATION_SOURCE_REGISTRY_B64;
  if (typeof encoded !== 'string' || encoded.length < 48 ||
      encoded.length > Math.ceil(MAX_REGISTRY_BYTES / 3) * 4 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) unavailable();
  try {
    const buf = Buffer.from(encoded, 'base64');
    if (buf.length > MAX_REGISTRY_BYTES || buf.toString('base64') !== encoded) unavailable();
    const json = buf.toString('utf8');
    // Strict parser checks allowed fields, source HTTPS origins, canonical
    // public-key encoding, key expiration, revocation and registry bounds.
    // Invalid config cannot silently fall back to trusting the artifact.
    parsePinnedPortableSourceRegistry(json);
    return json;
  } catch {
    return unavailable();
  }
}
