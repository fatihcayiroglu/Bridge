// @ts-nocheck
// server/lib/federationKeys.ts
// ADR-0006 Faz 1+2: Bridge instance RSA-2048 federation key yönetimi
//
// Private key AES-256-GCM ile şifrelenir (apKeyEncryption.ts yeniden kullanımı).
// Public key GET /api/federation/info ve GET /api/federation/key üzerinden yayınlanır.

import crypto from 'crypto';
import db from '../db/loader';
import { encryptApPrivateKey, decryptApPrivateKey } from './apKeyEncryption';

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

async function _loadFromDb(): Promise<FederationKeyPair | null> {
  const row = await db.serverFederationKeys?.findOne({ _id: INSTANCE_KEY_ID });
  if (!row?.publicKeyPem || !row?.privateKeyEnc) return null;

  const privateKeyPem = decryptApPrivateKey(row.privateKeyEnc);
  if (!privateKeyPem) return null;

  return {
    publicKeyPem:  row.publicKeyPem as string,
    privateKeyPem,
    keyVersion:    (row.keyVersion as number) ?? 1,
  };
}

async function _persistToDb(keys: FederationKeyPair): Promise<void> {
  if (!db.serverFederationKeys) return;
  const now = Date.now();
  const privateKeyEnc = encryptApPrivateKey(keys.privateKeyPem);
  const existing = await db.serverFederationKeys.findOne({ _id: INSTANCE_KEY_ID });
  if (existing) {
    await db.serverFederationKeys.update(
      { _id: INSTANCE_KEY_ID },
      { $set: { publicKeyPem: keys.publicKeyPem, privateKeyEnc, keyVersion: keys.keyVersion, rotatedAt: now } },
    );
  } else {
    await db.serverFederationKeys.insert({
      _id: INSTANCE_KEY_ID,
      publicKeyPem: keys.publicKeyPem,
      privateKeyEnc,
      keyVersion: keys.keyVersion,
      createdAt: now,
    });
  }
}

/** Instance RSA key çiftini yükle veya oluştur. */
export async function getOrCreateFederationKeys(): Promise<FederationKeyPair> {
  if (_cached) return _cached;

  const fromDb = await _loadFromDb();
  if (fromDb) {
    _cached = fromDb;
    return fromDb;
  }

  const generated = _generateKeyPair();
  await _persistToDb(generated);
  _cached = generated;
  return generated;
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
  if (!keyIdMatch || !sigMatch) return null;
  return { keyId: keyIdMatch[1], signature: sigMatch[1] };
}

/** ADR-0006 Faz 2: Yeni RSA key çifti üret, DB'ye yaz, cache temizle. */
export async function rotateFederationKeys(): Promise<{
  keyId: string;
  keyVersion: number;
  rotatedAt: number;
  publicKeyPem: string;
}> {
  const existing = await _loadFromDb();
  const nextVersion = existing ? existing.keyVersion + 1 : 1;
  const generated   = _generateKeyPair();
  generated.keyVersion = nextVersion;

  await _persistToDb(generated);
  _cached = generated;

  return {
    keyId:        getFederationKeyId(),
    keyVersion:   nextVersion,
    rotatedAt:    Date.now(),
    publicKeyPem: generated.publicKeyPem,
  };
}

/** Test izolasyonu için cache temizle. */
export function _resetFederationKeyCache(): void {
  _cached = null;
}
