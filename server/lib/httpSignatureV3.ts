// server/lib/httpSignatureV3.ts
// ADR-0006 Faz 3 — Federation: HMAC fallback tamamen kaldırıldı.
//
// Faz 2 (Sprint 108): RSA öncelikli + HMAC fallback (geçiş dönemi)
// Faz 3 (Sprint 113): HMAC fallback yok. Her peer RSA anahtarına sahip OLMALI.
//
// Doğrulama mantığı:
//   1. Peer için DB'de publicKey varsa → RSA doğrula. Başarısız → 401.
//   2. publicKey yoksa → 401 (HMAC artık kabul edilmez).
//   3. Timestamp > 5 dakika ise → 401 (replay koruması).
//
// Migrate: verifyFederationRequest (v2) → verifyFederationRequestV3 (bu dosya)
// federationAuth.ts bu modülü kullanacak şekilde güncellendi.
//
// Sprint 113

import crypto  from 'crypto';
import db      from '../db/loader';
import { Federation } from '../db/repositories';
import logger  from './logger';

// ── Tipler ────────────────────────────────────────────────────────────────

export interface PeerVerifyResult {
  ok:       boolean;
  method?:  'rsa';          // Faz 3'te yalnızca 'rsa' döner
  peerId?:  string | number;
  reason?:  string;
}

interface BridgeSigHeaders {
  'x-bridge-rsa-sig'?: string;
  'x-bridge-ts'?:      string;
  'x-bridge-keyid'?:   string;
  // x-bridge-sig (HMAC) artık kabul edilmiyor — varlığı yok sayılır
}

// ── Sabitler ─────────────────────────────────────────────────────────────

const MAX_AGE_MS = 5 * 60 * 1000; // 5 dakika — replay koruması

// ── Zaman damgası ─────────────────────────────────────────────────────────

function _checkTimestamp(ts: string | undefined): boolean {
  if (!ts) return false;
  const t = parseInt(ts, 10);
  if (isNaN(t)) return false;
  return Math.abs(Date.now() - t) <= MAX_AGE_MS;
}

// ── RSA doğrulama ─────────────────────────────────────────────────────────

function _verifyRsa(
  payload:       string,
  signatureB64:  string,
  publicKeyPem:  string,
): boolean {
  try {
    const verify = crypto.createVerify('sha256');
    verify.update(payload);
    return verify.verify(publicKeyPem, signatureB64, 'base64');
  } catch (err) {
    logger.warn({ detail: err }, '[httpSignatureV3] RSA doğrulama hatası:');
    return false;
  }
}

// ── Peer kaydı yükleme ────────────────────────────────────────────────────

async function _loadPeer(url: string): Promise<import('../db/repositories/types/entities').FederationPeer | null> {
  try {
    if (db.federationPeers) {
      const peer = await db.federationPeers.findOne({ url });
      if (peer) return peer;
    }
    return (await Federation?.getPeerByUrl?.(url)) ?? null;
  } catch {
    return null;
  }
}

function _extractPem(raw: string): string | null {
  try {
    const doc = JSON.parse(raw);
    return doc?.publicKeyPem ?? null;
  } catch {
    return raw.includes('BEGIN PUBLIC KEY') ? raw : null;
  }
}

// ── Ana doğrulama fonksiyonu ──────────────────────────────────────────────

/**
 * Gelen federation isteğini RSA-only olarak doğrular.
 * HMAC artık kabul edilmez (ADR-0006 Faz 3).
 *
 * Hata mesajları:
 *   - 'Timestamp missing or expired'
 *   - 'Unknown peer: <url>'
 *   - 'RSA public key not registered for this peer'  ← yeni: HMAC yok artık
 *   - 'RSA signature header missing'
 *   - 'RSA signature invalid'
 */
export async function verifyFederationRequestV3(
  peerUrl: string,
  payload: string,
  headers: BridgeSigHeaders,
): Promise<PeerVerifyResult> {
  // 1. Timestamp kontrolü
  if (!_checkTimestamp(headers['x-bridge-ts'])) {
    return { ok: false, reason: 'Timestamp missing or expired' };
  }

  // 2. Peer kaydı
  const peer = await _loadPeer(peerUrl);
  if (!peer) {
    return { ok: false, reason: `Unknown peer: ${peerUrl}` };
  }

  const peerId = (peer._id ?? peer.id) as string | number;

  // 3. RSA public key zorunlu (HMAC fallback YOK)
  const rawPublicKey = (peer.publicKey as string) ?? null;
  if (!rawPublicKey) {
    logger.warn(
      `[httpSignatureV3] ❌ peer=${peerUrl} — publicKey kayıtlı değil. HMAC kabul edilmiyor (ADR-0006 Faz 3).`,
    );
    return {
      ok:     false,
      peerId,
      reason: 'RSA public key not registered for this peer. Exchange keys first.',
    };
  }

  const pem = _extractPem(rawPublicKey);
  if (!pem) {
    logger.warn(`[httpSignatureV3] ❌ peer=${peerUrl} — publicKey PEM formatı geçersiz.`);
    return { ok: false, peerId, reason: 'Invalid RSA public key format' };
  }

  // 4. RSA imza başlığı kontrolü
  const rsaSig = headers['x-bridge-rsa-sig'];
  if (!rsaSig) {
    logger.warn(`[httpSignatureV3] ❌ peer=${peerUrl} — x-bridge-rsa-sig başlığı eksik.`);
    return { ok: false, peerId, reason: 'RSA signature header missing (x-bridge-rsa-sig)' };
  }

  // 5. RSA doğrulama
  const ok = _verifyRsa(payload, rsaSig, pem);
  if (!ok) {
    logger.warn(`[httpSignatureV3] ❌ RSA imza geçersiz peer=${peerUrl}`);
    return { ok: false, peerId, reason: 'RSA signature invalid' };
  }

  logger.info(`[httpSignatureV3] ✅ RSA doğrulama başarılı peer=${peerUrl} id=${peerId}`);
  return { ok: true, method: 'rsa', peerId };
}

// ── Giden istek header üretimi (RSA-only) ─────────────────────────────────

/**
 * Giden federation isteği için RSA-only header'lar üretir.
 * x-bridge-sig (HMAC) artık dahil edilmez.
 *
 * @param payload       - JSON.stringify(body)
 * @param privateKeyPem - instance'ın özel anahtarı
 * @param keyId         - anahtar kimliği
 */
export function buildFederationHeadersV3(
  payload:       string,
  privateKeyPem: string,
  keyId:         string,
): Record<string, string> {
  const ts = String(Date.now());

  let rsaSig = '';
  try {
    const sign = crypto.createSign('sha256');
    sign.update(payload);
    rsaSig = sign.sign(privateKeyPem, 'base64');
  } catch (err) {
    logger.error({ detail: err }, '[httpSignatureV3] RSA imzalama hatası:');
    throw new Error('[httpSignatureV3] RSA imzalama başarısız.');
  }

  return {
    'x-bridge-ts':      ts,
    'x-bridge-keyid':   keyId,
    'x-bridge-rsa-sig': rsaSig,
    // 'x-bridge-sig' (HMAC) kasıtlı olarak eklenmedi — ADR-0006 Faz 3
    'Content-Type':     'application/json',
  };
}

export default { verifyFederationRequestV3, buildFederationHeadersV3 };
