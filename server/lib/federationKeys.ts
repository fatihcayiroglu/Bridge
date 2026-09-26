// server/lib/federationKeys.ts
// ADR-0006 Faz 1+2: Bridge instance RSA-2048 federation key yönetimi
//
// Private key AES-256-GCM ile şifrelenir (apKeyEncryption.ts yeniden kullanımı).
// Public key GET /api/federation/info ve GET /api/federation/key üzerinden yayınlanır.

import crypto from 'crypto';
import db from '../db/loader';
import { encryptApPrivateKey, decryptApPrivateKey } from './apKeyEncryption';
import { parsePersistedNonNegativeInteger } from './persistedInteger';

const INSTANCE_KEY_ID = 'instance';

export interface FederationKeyPair {
  publicKeyPem:  string;
  privateKeyPem: string;
  keyVersion:    number;
}

let _cached: FederationKeyPair | null = null;

export function getInstanceUrl(): string {
  return (process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`).replace(/\/$/, '');
}

export function getFederationKeyId(): string {
  return `${getInstanceUrl()}/api/federation/key`;
}

export function getFederationPublicKeyDoc(keyPair?: FederationKeyPair) {
  const keys = keyPair ?? _cached;
  if (!keys) return null;
  const instanceUrl = getInstanceUrl();
  return {
    id:           getFederationKeyId(),
    owner:        instanceUrl,
    publicKeyPem: keys.publicKeyPem,
  };
}

function _generateKeyPair(): FederationKeyPair {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding:  { type: 'spki',  format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });
  return { publicKeyPem: publicKey, privateKeyPem: privateKey, keyVersion: 1 };
}

function _keysFromStoredRow(row: Record<string, unknown> | null | undefined): FederationKeyPair | null {
  if (!row?.publicKeyPem || !row?.privateKeyEnc) return null;
  const privateKeyPem = decryptApPrivateKey(String(row.privateKeyEnc));
  if (!privateKeyPem) return null;
  const keyVersion = parsePersistedNonNegativeInteger(row.keyVersion, 'persisted federation keyVersion', { defaultWhenMissing: 1, max: 2_147_483_647 });
  if (keyVersion < 1) throw new Error('Invalid persisted federation keyVersion');
  return { publicKeyPem: String(row.publicKeyPem), privateKeyPem, keyVersion };
}

async function _loadFromDb(): Promise<FederationKeyPair | null> {
  return _keysFromStoredRow(await db.serverFederationKeys.findOne({ _id: INSTANCE_KEY_ID }));
}

/**
 * First-writer-wins initialization. PgCollection.insert() returns the row that
 * actually exists after a primary-key conflict, so a node that loses an
 * initialisation race never caches/signs with an unpersisted private key.
 */
async function _insertInitialKey(keys: FederationKeyPair): Promise<FederationKeyPair> {
  const row = await db.serverFederationKeys.insert({
    _id: INSTANCE_KEY_ID,
    publicKeyPem: keys.publicKeyPem,
    privateKeyEnc: encryptApPrivateKey(keys.privateKeyPem),
    keyVersion: keys.keyVersion,
    createdAt: Date.now(),
  });
  const effective = _keysFromStoredRow(row as Record<string, unknown>);
  if (!effective) throw new Error('Persisted federation key row is unreadable');
  return effective;
}

/** Instance RSA key çiftini yükle veya oluştur. */
export async function getOrCreateFederationKeys(): Promise<FederationKeyPair> {
  // Deliberately re-read the canonical DB row rather than trusting an
  // indefinite process-local cache. Key rotation may occur on another node.
  const fromDb = await _loadFromDb();
  if (fromDb) {
    _cached = fromDb;
    return fromDb;
  }

  const effective = await _insertInitialKey(_generateKeyPair());
  _cached = effective;
  return effective;
}

/** ADR-0006: ts + body üzerinde RSA-SHA256 imza üret. */
export function signFederationPayload(privateKeyPem: string, ts: string, body: unknown): string {
  const payload = ts + JSON.stringify(body);
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(payload);
  return signer.sign(privateKeyPem, 'base64');
}

/** RSA imza header değeri: RSA-SHA256 keyId="...",signature="..." */
export function formatBridgeSignatureHeader(keyId: string, signature: string): string {
  return `RSA-SHA256 keyId="${keyId}",signature="${signature}"`;
}

/** X-Bridge-Signature header parse. */
export function parseBridgeSignatureHeader(header: string): { keyId: string; signature: string } | null {
  const keyIdMatch = header.match(/keyId="([^"]+)"/);
  const sigMatch   = header.match(/signature="([^"]+)"/);
  const keyId = keyIdMatch?.[1];
  const signature = sigMatch?.[1];
  if (!keyId || !signature) return null;
  return { keyId, signature };
}

/** ADR-0006 Faz 2: Yeni RSA key çifti üret, DB'ye yaz, cache temizle. */
let _fallbackRotationTail: Promise<void> = Promise.resolve();

async function _rotateFallbackSerialized(): Promise<FederationKeyPair> {
  let release!: () => void;
  const previous = _fallbackRotationTail;
  _fallbackRotationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous;
  try {
    const existing = await _loadFromDb();
    const generated = _generateKeyPair();
    generated.keyVersion = (existing?.keyVersion ?? 0) + 1;
    const now = Date.now();
    if (existing) {
      await db.serverFederationKeys.update(
        { _id: INSTANCE_KEY_ID },
        { $set: {
          publicKeyPem: generated.publicKeyPem,
          privateKeyEnc: encryptApPrivateKey(generated.privateKeyPem),
          keyVersion: generated.keyVersion,
          rotatedAt: now,
        } },
      );
    } else {
      return _insertInitialKey(generated);
    }
    return generated;
  } finally {
    release();
  }
}

async function _rotateAtomic(): Promise<FederationKeyPair> {
  const pool = (db as unknown as { _pool?: import('pg').Pool })._pool;
  if (!pool?.connect) return _rotateFallbackSerialized();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Row locking alone cannot serialize the "row does not exist yet" case.
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['bridge:federation-instance-key']);
    const current = await client.query<{ keyVersion: number | string }>(
      'SELECT "keyVersion" FROM server_federation_keys WHERE _id=$1 FOR UPDATE',
      [INSTANCE_KEY_ID],
    );
    const rawVersion = current.rows[0]?.keyVersion ?? 0;
    const currentVersion = parsePersistedNonNegativeInteger(rawVersion, 'persisted federation keyVersion', { max: 2_147_483_646 });

    const generated = _generateKeyPair();
    generated.keyVersion = currentVersion + 1;
    const privateKeyEnc = encryptApPrivateKey(generated.privateKeyPem);
    const now = Date.now();
    if (current.rows[0]) {
      await client.query(
        `UPDATE server_federation_keys
         SET "publicKeyPem"=$2,"privateKeyEnc"=$3,"keyVersion"=$4,"rotatedAt"=$5
         WHERE _id=$1`,
        [INSTANCE_KEY_ID, generated.publicKeyPem, privateKeyEnc, generated.keyVersion, now],
      );
    } else {
      await client.query(
        `INSERT INTO server_federation_keys (_id,"publicKeyPem","privateKeyEnc","keyVersion","createdAt")
         VALUES ($1,$2,$3,$4,$5)`,
        [INSTANCE_KEY_ID, generated.publicKeyPem, privateKeyEnc, generated.keyVersion, now],
      );
    }
    await client.query('COMMIT');
    return generated;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* preserve original error */ }
    throw err;
  } finally {
    client.release();
  }
}

export async function rotateFederationKeys(): Promise<{
  keyId: string;
  keyVersion: number;
  rotatedAt: number;
  publicKeyPem: string;
}> {
  const rotated = await _rotateAtomic();
  _cached = rotated;
  return {
    keyId: getFederationKeyId(),
    keyVersion: rotated.keyVersion,
    rotatedAt: Date.now(),
    publicKeyPem: rotated.publicKeyPem,
  };
}

/** Test izolasyonu için cache temizle. */
export function _resetFederationKeyCache(): void {
  _cached = null;
}
