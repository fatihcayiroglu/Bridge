// PKCE (RFC 7636, S256) and sign-in state for the native browser flow.
// Crypto is injected: expo-crypto on device, node:crypto in tests. Nothing here
// stores, logs or reuses an attempt; each sign-in gets fresh values.
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

/** Unpadded base64url of a byte array (no Buffer/btoa dependency for React Native). */
export function base64Url(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes');
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63] + ALPHABET[n & 63];
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i] << 16;
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63];
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8);
    out += ALPHABET[n >> 18 & 63] + ALPHABET[n >> 12 & 63] + ALPHABET[n >> 6 & 63];
  }
  return out;
}

/**
 * @param randomBytes (n) => Uint8Array from a cryptographically secure source
 * @param sha256 (ascii: string) => Promise<Uint8Array> (32 bytes)
 */
export async function createPkceAttempt({ randomBytes, sha256 }) {
  if (typeof randomBytes !== 'function' || typeof sha256 !== 'function') throw new TypeError('crypto');
  const verifierBytes = randomBytes(32);
  const stateBytes = randomBytes(16);
  if (!(verifierBytes instanceof Uint8Array) || verifierBytes.length !== 32 ||
      !(stateBytes instanceof Uint8Array) || stateBytes.length !== 16) {
    throw new TypeError('randomBytes');
  }
  const verifier = base64Url(verifierBytes);     // 43 chars
  const digest = await sha256(verifier);
  if (!(digest instanceof Uint8Array) || digest.length !== 32) throw new TypeError('sha256');
  return Object.freeze({ verifier, challenge: base64Url(digest), state: base64Url(stateBytes) });
}
