// server/lib/httpSignatureV2.ts
// ADR-0006 Faz 2 — Per-peer RSA-2048 imza doğrulaması
//
// Strateji:
//   1. Peer için DB'de publicKey varsa → RSA doğrulaması yap (non-repudiation).
//   2. publicKey yoksa → HMAC shared-secret fallback (geriye dönük uyumluluk).
//   3. Her iki yöntemle de başarısız olursa → 401.
//
// Bu modül httpSignature.ts'e ek bir katman olarak eklenir;
// mevcut `verifyBridgeSignature` fonksiyonu değiştirilmez.
//
// Sprint 108 — ADR-0006 Faz 2 tamamlama

import crypto from 'crypto';
import db from '../db/loader';
import { Federation } from '../db/repositories';
import logger from './logger';

// ── Tipler ────────────────────────────────────────────────────────────────────

export interface PeerVerifyResult {
  ok:        boolean;
  method?:   'rsa' | 'hmac';
  peerId?:   string | number;
  reason?:   string;
}

interface BridgeSigHeaders {
  'x-bridge-sig'?:       string;
  'x-bridge-ts'?:        string;
  'x-bridge-keyid'?:     string;
  'x-bridge-rsa-sig'?:   string;
}

// ── Sabitler ──────────────────────────────────────────────────────────────────

/** Replay saldırısına karşı maksimum istek yaşı (ms) */
const MAX_AGE_MS = 5 * 60 * 1000; // 5 dakika

// ── Zaman damgası doğrulama ───────────────────────────────────────────────────

function _checkTimestamp(ts: string | undefined): boolean {
  if (!ts) return false;
  const t = parseInt(ts, 10);
  if (isNaN(t)) return false;
  const age = Math.abs(Date.now() - t);
  return age <= MAX_AGE_MS;
}

// ── RSA imza doğrulama ────────────────────────────────────────────────────────

function _verifyRsa(
  payload: string,
  signatureB64: string,
  publicKeyPem: string,
): boolean {
  try {
    const verify = crypto.createVerify('sha256');
    verify.update(payload);
    return verify.verify(publicKeyPem, signatureB64, 'base64');
  } catch (err) {
    logger.warn({ detail: err }, '[httpSignatureV2] RSA doğrulama hatası:');
    return false;
  }
}

// ── HMAC imza doğrulama ───────────────────────────────────────────────────────

function _verifyHmac(
  payload: string,
  signature: string,
  secret: string,
): boolean {
  try {
    const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
    return crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expected, 'hex'));
  } catch {
    return false;
  }
}

// ── Peer kaydını yükle ────────────────────────────────────────────────────────

async function _loadPeer(url: string): Promise<import('../db/repositories/types/entities').FederationPeer | null> {
  try {
    if (db.federationPeers) {
      const peer = await db.federationPeers.findOne({ url });
      if (peer) return peer;
    }
    const peers = await Federation?.getPeerByUrl?.(url);
    return peers ?? null;
  } catch {
    return null;
  }
}

// ── Ana doğrulama fonksiyonu ──────────────────────────────────────────────────

/**
 * Gelen federation isteğini doğrular.
 * Per-peer RSA public key varsa RSA kullanır; yoksa HMAC fallback.
 *
 * @param peerUrl   - İsteği gönderen peer'ın INSTANCE_URL değeri
 * @param payload   - İmzalanan payload (genellikle JSON.stringify(req.body))
 * @param headers   - x-bridge-sig, x-bridge-ts, x-bridge-rsa-sig başlıkları
 */
export async function verifyFederationRequest(
  peerUrl: string,
  payload: string,
  headers: BridgeSigHeaders,
): Promise<PeerVerifyResult> {
  // 1. Zaman damgası kontrolü — her iki yöntemde de zorunlu
  if (!_checkTimestamp(headers['x-bridge-ts'])) {
    return { ok: false, reason: 'Timestamp missing or expired' };
  }

  const peer = await _loadPeer(peerUrl);
  if (!peer) {
    return { ok: false, reason: `Unknown peer: ${peerUrl}` };
  }

  const peerId = peer._id ?? peer.id;

  // 2. Per-peer RSA doğrulaması (ADR-0006 Faz 2)
  const peerPublicKey = (peer.publicKey as string) ?? null;
  const rsaSig        = headers['x-bridge-rsa-sig'];

  if (peerPublicKey && rsaSig) {
    // publicKey sütununda raw PEM veya JSON doc olabilir
    let pem: string | null = null;
    try {
      const doc = JSON.parse(peerPublicKey);
      pem = doc?.publicKeyPem ?? null;
    } catch {
      pem = peerPublicKey; // raw PEM ise doğrudan kullan
    }

    if (pem?.includes('BEGIN PUBLIC KEY')) {
      const ok = _verifyRsa(payload, rsaSig, pem);
      if (ok) {
        logger.info(`[httpSignatureV2] RSA doğrulama ✅ peer=${peerUrl} id=${peerId}`);
        return { ok: true, method: 'rsa', peerId: peerId as string | number };
      }
      logger.warn(`[httpSignatureV2] RSA doğrulama başarısız peer=${peerUrl}`);
      return { ok: false, reason: 'RSA signature invalid', peerId: peerId as string | number };
    }
  }

  // 3. HMAC fallback (per-peer secret → global secret)
  const peerSecret  = (peer.secret as string) ?? null;
  const globalSecret = process.env.FEDERATION_SECRET ?? '';
  const secret = peerSecret || globalSecret;

  if (!secret) {
    return { ok: false, reason: 'No shared secret configured' };
  }

  const hmacSig = headers['x-bridge-sig'];
  if (!hmacSig) {
    return { ok: false, reason: 'No HMAC signature header' };
  }

  const ok = _verifyHmac(payload, hmacSig, secret);
  if (ok) {
    logger.info(`[httpSignatureV2] HMAC doğrulama ✅ peer=${peerUrl} id=${peerId} (RSA anahtarı henüz yok)`);
    return { ok: true, method: 'hmac', peerId: peerId as string | number };
  }

  logger.warn(`[httpSignatureV2] HMAC doğrulama başarısız peer=${peerUrl}`);
  return { ok: false, reason: 'HMAC signature invalid' };
}

// ── Outgoing imza üretimi (RSA + HMAC) ───────────────────────────────────────

/**
 * Giden federation isteği için RSA + HMAC header'larını üretir.
 * Karşı peer RSA anahtarımızı biliyorsa RSA doğrular;
 * bilmiyorsa HMAC ile devam eder (geçiş dönemi).
 */
export async function buildFederationHeaders(
  payload: string,
  privateKeyPem: string,
  keyId: string,
  hmacSecret: string,
): Promise<Record<string, string>> {
  const ts = String(Date.now());

  // RSA imzası
  let rsaSig = '';
  try {
    const sign = crypto.createSign('sha256');
    sign.update(payload);
    rsaSig = sign.sign(privateKeyPem, 'base64');
  } catch (err) {
    logger.error({ detail: err }, '[httpSignatureV2] RSA imzalama hatası:');
  }

  // HMAC imzası (fallback / çift doğrulama desteği için tutulur)
  const hmacSig = crypto.createHmac('sha256', hmacSecret).update(payload).digest('hex');

  return {
    'x-bridge-ts':      ts,
    'x-bridge-keyid':   keyId,
    'x-bridge-rsa-sig': rsaSig,
    'x-bridge-sig':     hmacSig,          // geriye dönük uyumluluk
    'Content-Type':     'application/json',
  };
}
