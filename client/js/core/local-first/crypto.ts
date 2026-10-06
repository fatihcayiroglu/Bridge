// P7 W1 — local-first encryption envelope.
//
// This module owns only encryption/decryption. It deliberately knows nothing
// about IndexedDB/SQLite, users, messages or sync so the same envelope can be
// used by the browser and native storage adapters.
//
// Security boundary:
// - AES-256-GCM with a fresh 96-bit IV for every write.
// - keys generated here are non-extractable.
// - caller-supplied AAD binds ciphertext to its logical record/scope; moving an
//   encrypted value to another account/conversation must fail authentication.
// - no key or plaintext is written to localStorage by this module.

export const LOCAL_FIRST_CRYPTO_VERSION = 1;
export const LOCAL_FIRST_ALGORITHM = 'AES-GCM' as const;
export const LOCAL_FIRST_MAX_CIPHERTEXT_BYTES = 4 * 1024 * 1024;
const IV_BYTES = 12;
const TAG_LENGTH = 128;
const MAX_AAD_BYTES = 1024;

export interface LocalFirstEnvelope {
  v: typeof LOCAL_FIRST_CRYPTO_VERSION;
  alg: typeof LOCAL_FIRST_ALGORITHM;
  iv: string;
  ct: string;
}

function webCrypto(): Crypto {
  const value = globalThis.crypto;
  if (!value?.subtle || typeof value.getRandomValues !== 'function') {
    throw new Error('Web Crypto is unavailable');
  }
  return value;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += CHUNK) {
    const chunk = bytes.subarray(offset, Math.min(offset + CHUNK, bytes.length));
    for (let index = 0; index < chunk.length; index += 1) {
      binary += String.fromCharCode(chunk[index]);
    }
  }
  return globalThis.btoa(binary);
}

function decodeBase64(value: string, maxBytes = LOCAL_FIRST_MAX_CIPHERTEXT_BYTES): Uint8Array {
  if (typeof value !== 'string' || value.length === 0 || value.length % 4 !== 0) {
    throw new Error('Invalid local-first base64');
  }
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error('Invalid local-first base64');
  }

  let binary: string;
  try {
    binary = globalThis.atob(value);
  } catch {
    throw new Error('Invalid local-first base64');
  }
  if (binary.length > maxBytes) throw new Error('Local-first ciphertext is too large');

  const result = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) result[index] = binary.charCodeAt(index);
  return result;
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  // TS 6 models Uint8Array as potentially SharedArrayBuffer-backed. WebCrypto's
  // BufferSource contract is stricter, so cross the boundary with an owned
  // ArrayBuffer instead of a type assertion.
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function encodeAad(scope: string): ArrayBuffer {
  if (typeof scope !== 'string' || scope.length === 0) throw new Error('Local-first scope is required');
  const encoded = new TextEncoder().encode(`bridge-local-first:v${LOCAL_FIRST_CRYPTO_VERSION}:${scope}`);
  if (encoded.byteLength > MAX_AAD_BYTES) throw new Error('Local-first scope is too large');
  return toArrayBuffer(encoded);
}

function validateEnvelope(value: unknown): asserts value is LocalFirstEnvelope {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid local-first envelope');
  }
  const envelope = value as Partial<LocalFirstEnvelope>;
  if (
    envelope.v !== LOCAL_FIRST_CRYPTO_VERSION
    || envelope.alg !== LOCAL_FIRST_ALGORITHM
    || typeof envelope.iv !== 'string'
    || typeof envelope.ct !== 'string'
  ) {
    throw new Error('Invalid local-first envelope');
  }
}

/** Create an AES-256-GCM key that JavaScript cannot export as raw key bytes. */
export async function generateLocalFirstKey(): Promise<CryptoKey> {
  return webCrypto().subtle.generateKey(
    { name: LOCAL_FIRST_ALGORITHM, length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/**
 * Encrypt bytes and authenticate the logical storage scope.
 *
 * `scope` should include stable account + record identity, for example:
 * `user:<uid>:draft:channel:<channelId>`.
 */
export async function encryptLocalBytes(
  key: CryptoKey,
  plaintext: Uint8Array,
  scope: string,
): Promise<LocalFirstEnvelope> {
  if (!(plaintext instanceof Uint8Array)) throw new Error('Local-first plaintext must be bytes');
  if (plaintext.byteLength > LOCAL_FIRST_MAX_CIPHERTEXT_BYTES) {
    throw new Error('Local-first plaintext is too large');
  }

  const crypto = webCrypto();
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: LOCAL_FIRST_ALGORITHM,
      iv: toArrayBuffer(iv),
      additionalData: encodeAad(scope),
      tagLength: TAG_LENGTH,
    },
    key,
    toArrayBuffer(plaintext),
  );

  return {
    v: LOCAL_FIRST_CRYPTO_VERSION,
    alg: LOCAL_FIRST_ALGORITHM,
    iv: encodeBase64(iv),
    ct: encodeBase64(new Uint8Array(ciphertext)),
  };
}

/** Decrypt bytes; wrong key/scope/tampered ciphertext rejects instead of returning garbage. */
export async function decryptLocalBytes(
  key: CryptoKey,
  value: unknown,
  scope: string,
): Promise<Uint8Array> {
  validateEnvelope(value);
  const iv = decodeBase64(value.iv, IV_BYTES);
  if (iv.byteLength !== IV_BYTES) throw new Error('Invalid local-first IV');
  const ciphertext = decodeBase64(value.ct);

  const plaintext = await webCrypto().subtle.decrypt(
    {
      name: LOCAL_FIRST_ALGORITHM,
      iv: toArrayBuffer(iv),
      additionalData: encodeAad(scope),
      tagLength: TAG_LENGTH,
    },
    key,
    toArrayBuffer(ciphertext),
  );
  return new Uint8Array(plaintext);
}

export async function encryptLocalJson<T>(
  key: CryptoKey,
  value: T,
  scope: string,
): Promise<LocalFirstEnvelope> {
  const encoded = new TextEncoder().encode(JSON.stringify(value));
  return encryptLocalBytes(key, encoded, scope);
}

export async function decryptLocalJson<T>(
  key: CryptoKey,
  value: unknown,
  scope: string,
): Promise<T> {
  const plaintext = await decryptLocalBytes(key, value, scope);
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}
