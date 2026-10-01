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
// ── P5: one signed form, sent AND verified ──────────────────────────────────
// Measured in the two-instance lab (P5 FED-03): no Bridge code ever sent what
// this verifier checked. The heartbeat signed `ts + body` into
// `X-Bridge-Signature` (+ an HMAC the verifier ignores), the verifier expected
// `x-bridge-rsa-sig` over the body alone — so every peer ping was 401 and a
// rotated key was never announced. The body-only form also bound neither the
// timestamp nor the endpoint, the sender or the receiver, and nothing stopped
// the same signed request being accepted twice.
//
// The signature now covers (see peerSigningString):
//   version, timestamp, METHOD, path, sender base URL, receiver base URL, body
// and a verified signature is claimed once in the shared replay store.

import crypto  from 'crypto';
import db      from '../db/loader';
import { Federation } from '../db/repositories';
import logger  from './logger';
import { claimSignatureReplay } from './httpSignature';
import { getOrCreateFederationKeys, getFederationKeyId, getInstanceUrl } from './federationKeys';

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

/** What the request is, as both sides see it. */
export interface PeerRequestContext {
  method: string;  // HTTP method
  path:   string;  // path + query as sent/received, e.g. /api/federation/ping
  target: string;  // receiving installation's base URL
}

// ── Sabitler ─────────────────────────────────────────────────────────────

const MAX_AGE_MS = 5 * 60 * 1000; // 5 dakika — replay koruması
export const PEER_SIGNATURE_VERSION = 'bridge-peer-sig/1';

// ── Kimlik normalizasyonu ─────────────────────────────────────────────────

/** Canonical base URL of an installation: scheme://host[:port][/path], no trailing slash. */
export function normalizePeerBaseUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    url.hash = '';
    url.search = '';
    url.pathname = url.pathname.replace(/\/+$/, '') || '/';
    return url.toString().replace(/\/$/, '');
  } catch {
    return null;
  }
}

/** The exact bytes signed by the sender and re-built by the receiver. */
export function peerSigningString(
  ts: string,
  ctx: PeerRequestContext & { sender: string },
  payload: string,
): string {
  return [
    PEER_SIGNATURE_VERSION,
    ts,
    ctx.method.toUpperCase(),
    ctx.path,
    normalizePeerBaseUrl(ctx.sender) ?? '',
    normalizePeerBaseUrl(ctx.target) ?? '',
    payload,
  ].join('\n');
}

// ── Zaman damgası ─────────────────────────────────────────────────────────

function _checkTimestamp(ts: string | undefined): boolean {
  if (!ts || !/^\d{1,16}$/.test(ts)) return false;
  const t = Number(ts);
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
 *   - 'Replay: signature already used'
 */
export async function verifyFederationRequestV3(
  peerUrl: string,
  payload: string,
  headers: BridgeSigHeaders,
  ctx: PeerRequestContext,
): Promise<PeerVerifyResult> {
  // 1. Timestamp kontrolü
  const ts = headers['x-bridge-ts'];
  if (!_checkTimestamp(ts)) {
    return { ok: false, reason: 'Timestamp missing or expired' };
  }

  // 2. Peer kaydı (kayıtlı biçimiyle ya da kanonik biçimiyle)
  const canonical = normalizePeerBaseUrl(peerUrl);
  const peer = (canonical ? await _loadPeer(canonical) : null)
    ?? (canonical !== peerUrl ? await _loadPeer(peerUrl) : null);
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

  // 5. RSA doğrulama — the signer is the REGISTERED peer, so the sender in the
  // signed string is the registered URL, never what the request claims.
  const sender = String(peer.url ?? canonical ?? peerUrl);
  const ok = _verifyRsa(peerSigningString(ts as string, { ...ctx, sender }, payload), rsaSig, pem);
  if (!ok) {
    logger.warn(`[httpSignatureV3] ❌ RSA imza geçersiz peer=${peerUrl}`);
    return { ok: false, peerId, reason: 'RSA signature invalid' };
  }

  // 6. Single use, cluster-wide, fail closed.
  if (!(await claimSignatureReplay(`peer:${rsaSig}`))) {
    logger.warn(`[httpSignatureV3] ❌ replay peer=${peerUrl}`);
    return { ok: false, peerId, reason: 'Replay: signature already used' };
  }

  logger.info(`[httpSignatureV3] ✅ RSA doğrulama başarılı peer=${peerUrl} id=${peerId}`);
  return { ok: true, method: 'rsa', peerId };
}

// ── Giden istek header üretimi (RSA-only) ─────────────────────────────────

/**
 * Giden federation isteği için RSA-only header'lar üretir.
 * x-bridge-sig (HMAC) artık dahil edilmez.
 *
 * @param payload       - the exact request body bytes (JSON.stringify(body))
 * @param privateKeyPem - instance'ın özel anahtarı
 * @param keyId         - anahtar kimliği
 * @param ctx           - method, path, receiver and this installation's base URL
 */
export function buildFederationHeadersV3(
  payload:       string,
  privateKeyPem: string,
  keyId:         string,
  ctx:           PeerRequestContext & { sender: string },
): Record<string, string> {
  const ts = String(Date.now());

  const rsaSig = (() => {
  try {
    const sign = crypto.createSign('sha256');
    sign.update(peerSigningString(ts, ctx, payload));
    return sign.sign(privateKeyPem, 'base64');
  } catch (err) {
    logger.error({ detail: err }, '[httpSignatureV3] RSA imzalama hatası:');
    throw new Error(
      '[httpSignatureV3] RSA imzalama başarısız.',
      { cause: err },
    );
  }
})();
return {
    'x-bridge-ts':           ts,
    'x-bridge-keyid':        keyId,
    'x-bridge-rsa-sig':      rsaSig,
    'x-bridge-instance-url': normalizePeerBaseUrl(ctx.sender) ?? ctx.sender,
    // 'x-bridge-sig' (HMAC) kasıtlı olarak eklenmedi — ADR-0006 Faz 3
    'Content-Type':          'application/json',
  };
}

/**
 * Headers for a request from THIS installation to a registered peer, signed
 * with the current instance key (or `privateKeyPem` when given — the previous
 * key, for a rotation announcement the peer can still verify).
 */
export async function signPeerRequest(
  ctx: PeerRequestContext,
  payload: string,
  privateKeyPem?: string,
): Promise<Record<string, string>> {
  const key = privateKeyPem ?? (await getOrCreateFederationKeys()).privateKeyPem;
  return buildFederationHeadersV3(payload, key, getFederationKeyId(), { ...ctx, sender: getInstanceUrl() });
}

export default { verifyFederationRequestV3, buildFederationHeadersV3, signPeerRequest };
