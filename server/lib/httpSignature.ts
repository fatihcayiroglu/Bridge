// server/lib/httpSignature.ts
// federation.js'den ayrıştırılmış HTTP Signature doğrulama modülü
// Daha önce federation.js içinde ~180 satır inline tanımlıydı

import crypto from 'crypto';
import db from '../db/loader';
import { Federation } from '../db/repositories';
import { fetchT } from './fetch';
import {
  getFederationKeyId,
  getOrCreateFederationKeys,
  parseBridgeSignatureHeader,
  signFederationPayload,
  formatBridgeSignatureHeader,
} from './federationKeys';
// RFC draft-cavage-http-signatures implementasyonu.
// Düzeltmeler: per-user keyId, public key cache, replay attack koruması,
//              Digest zorunluluğu, daha dar zaman penceresi (5 dk),
//              algoritma doğrulama, SSRF koruması, (request-target) zorunluluğu.

// ── Tip tanımları ─────────────────────────────────────────────
interface SigVerifyResult {
  ok: boolean;
  keyId?: string;
  reason?: string;
}

interface IncomingReq {
  method: string;
  url: string;
  originalUrl?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
}

// ── İzin verilen algoritmalar ─────────────────────────────────────────────────
// Yalnızca rsa-sha256 ve hs2019 (RFC 9421 transition alias for rsa-sha256)
// kabul edilir. ed25519-sha512 henüz yaygın değil — eklenirse buraya eklenir.
const ALLOWED_ALGORITHMS = new Set(['rsa-sha256', 'hs2019']);

// ── SSRF Koruması: izin verilmeyen key fetch domain'leri ─────────────────────
// Özel adres aralıkları, metadata servisleri, localhost varyantları
const SSRF_BLOCK_PATTERNS = [
  /^localhost$/i,
  /^127\.\d+\.\d+\.\d+$/,
  /^10\.\d+\.\d+\.\d+$/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/,
  /^192\.168\.\d+\.\d+$/,
  /^169\.254\.\d+\.\d+$/, // AWS metadata link-local
  /^::1$/,
  /^fc[0-9a-f]{2}:/i,   // IPv6 ULA
  /^fd[0-9a-f]{2}:/i,   // IPv6 ULA
  /^0\.\d+\.\d+\.\d+$/, // 0.0.0.0/8
  /^metadata\.google\.internal$/i,
  /^169\.254\.169\.254$/,
];

function _isBlockedHost(host: string): boolean {
  return SSRF_BLOCK_PATTERNS.some(p => p.test(host));
}

// ── Public Key Cache ──────────────────────────────────────────────────────────
// Remote key fetch'i cache'ler: TTL 10 dk, maks 500 kayıt
interface KeyCacheEntry { pem: string; expiresAt: number; }
const _keyCache = new Map<string, KeyCacheEntry>();
const KEY_CACHE_TTL_MS  = 10 * 60 * 1000; // 10 dakika
const KEY_CACHE_MAX     = 500;

function _cacheGet(keyId: string): string | null {
  const entry = _keyCache.get(keyId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _keyCache.delete(keyId); return null; }
  return entry.pem;
}

function _cacheSet(keyId: string, pem: string): void {
  if (_keyCache.size >= KEY_CACHE_MAX) {
    const oldest = _keyCache.keys().next().value;
    if (oldest) _keyCache.delete(oldest);
  }
  _keyCache.set(keyId, { pem, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

// ── Replay Attack Koruması ────────────────────────────────────────────────────
const _usedSignatures = new Map<string, number>(); // signature → expiresAt
const SIG_REPLAY_TTL_MS = 5 * 60 * 1000;

function _isReplay(sig: string): boolean {
  const exp = _usedSignatures.get(sig);
  if (!exp) return false;
  if (Date.now() > exp) { _usedSignatures.delete(sig); return false; }
  return true;
}

function _markUsed(sig: string): void {
  if (_usedSignatures.size % 100 === 0) {
    const now = Date.now();
    for (const [k, v] of _usedSignatures) { if (now > v) _usedSignatures.delete(k); }
  }
  _usedSignatures.set(sig, Date.now() + SIG_REPLAY_TTL_MS);
}

function _federationReplayKey(ts: string, signature: string): string {
  return `fed:${ts}:${signature}`;
}

/** Test izolasyonu — replay + public key cache temizle. */
export function _resetSignatureReplayCache(): void {
  _usedSignatures.clear();
  _keyCache.clear();
}

// ── Signature Header Parser ───────────────────────────────────────────────────
function _parseSigHeader(header: string): Record<string, string> {
  const params: Record<string, string> = {};
  const re = /(\w+)="([^"]*)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(header)) !== null) params[m[1]] = m[2];
  return params;
}

// ── Signing String Builder ────────────────────────────────────────────────────
function _buildSigningString(req: IncomingReq, headerList: string[]): string {
  return headerList.map(h => {
    if (h === '(request-target)') {
      return `(request-target): ${(req.method as string).toLowerCase()} ${req.originalUrl || req.url}`;
    }
    return `${h}: ${req.headers[h.toLowerCase()] ?? ''}`;
  }).join('\n');
}

// ── Public Key Resolver (SSRF korumalı) ──────────────────────────────────────
async function _resolvePublicKey(keyId: string): Promise<string | null> {
  // 1. Cache
  const cached = _cacheGet(keyId);
  if (cached) return cached;

  // 2. Yerel kullanıcı?
  const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
  if (keyId.startsWith(instanceUrl)) {
    const match = keyId.match(/\/users\/([^/#]+)/);
    if (match) {
      const user = await db.users.findOne({ username: match[1] });
      if (user?.apPublicKey) {
        _cacheSet(keyId, user.apPublicKey);
        return user.apPublicKey;
      }
    }
    return null;
  }

  // 3. SSRF koruması: keyId URL'sini parse et ve host'u kontrol et
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(keyId);
  } catch {
    throw new Error(`Key URL parse hatası: ${keyId}`);
  }

  // Yalnızca HTTPS remote key fetch'e izin ver
  if (parsedUrl.protocol !== 'https:') {
    throw new Error(`Key URL yalnızca HTTPS olabilir, alınan: ${parsedUrl.protocol}`);
  }

  if (_isBlockedHost(parsedUrl.hostname)) {
    throw new Error(`Key fetch engellendi: şüpheli host ${parsedUrl.hostname}`);
  }

  // 4. Remote fetch — fetchT (DNS rebinding koruması) + redirect=manual
  const r = await fetchT(keyId, {
    headers: { Accept: 'application/activity+json, application/ld+json, application/json' },
    timeoutMs: 8000,
    redirect: 'manual',
  });

  // 3xx redirect → hata fırlat (farklı bir host'a yönlendirilebilir)
  if (r.status >= 300 && r.status < 400) {
    throw new Error(`Key fetch yönlendirme reddedildi: ${r.status} ${r.headers.get('location')}`);
  }
  if (!r.ok) throw new Error(`Key fetch başarısız: ${r.status} ${r.url}`);

  const doc = await r.json() as Record<string, unknown>;
  const keyDoc = doc?.publicKey as Record<string, unknown> | undefined;
  const pem = (keyDoc?.publicKeyPem ?? doc?.publicKeyPem ?? null) as string | null;
  if (pem) _cacheSet(keyId, pem);
  return pem;
}

// ── Ana Doğrulama Fonksiyonu ──────────────────────────────────────────────────
async function verifyHttpSignature(req: IncomingReq): Promise<SigVerifyResult> {
  try {
    const { createVerify, createHash } = crypto;
    const sigHeader = _reqHeader(req, 'signature');
    if (!sigHeader) return { ok: false, reason: 'No Signature header' };

    const { keyId, algorithm, headers: signedHeaders, signature } = _parseSigHeader(sigHeader);
    if (!keyId || !signedHeaders || !signature) {
      return { ok: false, reason: 'Missing signature params (keyId/headers/signature)' };
    }

    // ── 0. Algoritma doğrulama ─────────────────────────────────────────────────
    // algorithm parametresi opsiyonel (bazı eski impl göndermez) ama
    // gönderilmişse izin listesinde olmalı.
    if (algorithm && !ALLOWED_ALGORITHMS.has(algorithm.toLowerCase())) {
      return { ok: false, reason: `Desteklenmeyen algoritma: ${algorithm}. İzin verilenler: ${[...ALLOWED_ALGORITHMS].join(', ')}` };
    }

    // ── 1. (request-target) zorunluluğu ──────────────────────────────────────
    // (request-target) imzalanmamışsa saldırgan aynı imzayı farklı bir
    // endpoint'e replay edebilir.
    const headerList = signedHeaders.split(' ');
    if (!headerList.includes('(request-target)')) {
      return { ok: false, reason: '(request-target) imzalanmış header listesinde zorunludur' };
    }

    // ── 2. Replay attack kontrolü ──────────────────────────────────────────────
    if (_isReplay(signature)) {
      return { ok: false, reason: 'Replay attack: signature already used' };
    }

    // ── 3. Date header — zaman penceresi ±5 dakika ────────────────────────────
    const dateStr = _reqHeader(req, 'date');
    if (!dateStr) return { ok: false, reason: 'Date header required' };
    const reqTime = new Date(dateStr).getTime();
    if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > 5 * 60 * 1000) {
      return { ok: false, reason: 'Date header too old, too new, or invalid (±5min)' };
    }

    // ── 4. Digest zorunlu (body manipülasyonunu önler) ────────────────────────
    const digestHeader = _reqHeader(req, 'digest');
    if (!digestHeader) return { ok: false, reason: 'Digest header required' };
    const bodyStr  = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
    const expected = 'SHA-256=' + createHash('sha256').update(bodyStr).digest('base64');
    if (digestHeader !== expected) {
      return { ok: false, reason: 'Digest mismatch — body may have been tampered' };
    }

    // ── 5. Signing string ──────────────────────────────────────────────────────
    const signingString = _buildSigningString(req, headerList);

    // ── 6. Public key resolve (SSRF korumalı) ────────────────────────────────
    let publicKeyPem: string | null;
    try {
      publicKeyPem = await _resolvePublicKey(keyId);
    } catch (e) {
      return { ok: false, reason: `Key resolve error: ${(e as Error).message}` };
    }
    if (!publicKeyPem) return { ok: false, reason: 'Public key not found' };

    // ── 7. RSA-SHA256 doğrulama ───────────────────────────────────────────────
    const verify = createVerify('RSA-SHA256');
    verify.update(signingString);
    const valid = verify.verify(publicKeyPem, signature, 'base64');

    if (valid) {
      _markUsed(signature);
      return { ok: true, keyId };
    }
    return { ok: false, reason: 'Signature cryptographically invalid' };

  } catch (e) {
    return { ok: false, reason: `Verify error: ${(e as Error).message}` };
  }
}

// ── Bridge-to-Bridge Federation İmza (ADR-0006 Faz 2) ───────────────────────

function _reqHeader(req: IncomingReq, name: string): string | undefined {
  const lower = name.toLowerCase();
  const direct = req.headers[lower];
  if (Array.isArray(direct)) return direct.join(', ');
  if (direct !== undefined) return direct;
  for (const [k, v] of Object.entries(req.headers)) {
    if (k.toLowerCase() === lower) return Array.isArray(v) ? v.join(', ') : v;
  }
  return undefined;
}

function _getFederationSecret(): string | null {
  const secret = process.env.FEDERATION_SECRET;
  if (secret) return secret;
  if (process.env.NODE_ENV === 'production') return null;
  if (process.env.NODE_ENV === 'test') return 'test-federation-secret';
  return 'bridge-federation-dev-only-NOT-FOR-PRODUCTION';
}

function _verifyFederationHmac(req: IncomingReq): boolean {
  const sig    = _reqHeader(req, 'x-bridge-sig');
  const ts     = _reqHeader(req, 'x-bridge-ts');
  if (!sig || !ts) return false;
  if (Math.abs(Date.now() - parseInt(ts, 10)) > 5 * 60 * 1000) return false;

  const secret = _getFederationSecret();
  if (!secret) return false;

  const replayKey = _federationReplayKey(ts, sig);
  if (_isReplay(replayKey)) return false;

  const payload = ts + JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    const valid = crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
    if (valid) _markUsed(replayKey);
    return valid;
  } catch {
    return false;
  }
}

async function _resolvePeerPublicKey(senderUrl: string, keyId?: string): Promise<string | null> {
  if (senderUrl) {
    const peer = await Federation.findPeerByUrl(senderUrl.replace(/\/$/, ''));
    if (peer?.publicKey) return peer.publicKey as string;
  }

  if (keyId) {
    const cached = _cacheGet(keyId);
    if (cached) return cached;

    const instanceUrl = process.env.INSTANCE_URL || `http://localhost:${process.env.PORT || 3001}`;
    if (keyId.startsWith(instanceUrl.replace(/\/$/, ''))) {
      const keys = await getOrCreateFederationKeys();
      _cacheSet(keyId, keys.publicKeyPem);
      return keys.publicKeyPem;
    }

    try {
      const parsed = new URL(keyId);
      if (parsed.protocol !== 'https:' && process.env.NODE_ENV === 'production') return null;
      if (_isBlockedHost(parsed.hostname)) return null;

      const resp = await fetchT(keyId, {
        headers: { Accept: 'application/json' },
        timeoutMs: 8000,
        redirect: 'manual',
      });
      if (!resp.ok) return null;
      const doc = await resp.json() as Record<string, unknown>;
      const keyDoc = doc?.publicKey as Record<string, unknown> | undefined;
      const pem = (keyDoc?.publicKeyPem ?? doc?.publicKeyPem ?? null) as string | null;
      if (pem) _cacheSet(keyId, pem);
      return pem;
    } catch {
      return null;
    }
  }

  return null;
}

async function _verifyFederationRsa(req: IncomingReq): Promise<boolean> {
  const sigHeader = _reqHeader(req, 'x-bridge-signature');
  const ts        = _reqHeader(req, 'x-bridge-ts');
  if (!sigHeader || !ts) return false;
  if (Math.abs(Date.now() - parseInt(ts, 10)) > 5 * 60 * 1000) return false;

  const parsed = parseBridgeSignatureHeader(sigHeader);
  if (!parsed) return false;

  const replayKey = _federationReplayKey(ts, parsed.signature);
  if (_isReplay(replayKey)) return false;

  const body = req.body as { url?: string } | undefined;
  const publicKeyPem = await _resolvePeerPublicKey(body?.url ?? '', parsed.keyId);
  if (!publicKeyPem) return false;

  const payload = ts + JSON.stringify(req.body ?? {});
  const verify  = crypto.createVerify('RSA-SHA256');
  verify.update(payload);
  const valid = verify.verify(publicKeyPem, parsed.signature, 'base64');
  if (valid) _markUsed(replayKey);
  return valid;
}

/** Outgoing federation isteği için HMAC + RSA imza header'ları üret. */
export async function signFederationRequest(body: unknown): Promise<{
  ts: string;
  hmacSig: string;
  rsaSignature: string;
  keyId: string;
}> {
  const ts      = String(Date.now());
  const payload = ts + JSON.stringify(body);
  const secret  = _getFederationSecret();
  if (!secret) throw new Error('FEDERATION_SECRET is not configured');
  const hmacSig = crypto.createHmac('sha256', secret).update(payload).digest('hex');

  const keys = await getOrCreateFederationKeys();
  const keyId = getFederationKeyId();
  const rsaSignature = signFederationPayload(keys.privateKeyPem, ts, body);

  return { ts, hmacSig, rsaSignature, keyId };
}

/** Federation istek header'larını oluştur (geriye dönük HMAC + RSA). */
export async function buildFederationAuthHeaders(body: unknown): Promise<Record<string, string>> {
  const { ts, hmacSig, rsaSignature, keyId } = await signFederationRequest(body);
  return {
    'x-bridge-ts':         ts,
    'x-bridge-sig':        hmacSig,
    'X-Bridge-Signature':  formatBridgeSignatureHeader(keyId, rsaSignature),
  };
}

// ── YARDIMCI: Uzak sunucu isteklerini doğrula ──────────────────
async function verifyFederationRequest(req: IncomingReq): Promise<boolean> {
  if (_reqHeader(req, 'x-bridge-signature')) {
    if (await _verifyFederationRsa(req)) return true;
  }
  return _verifyFederationHmac(req);
}


export { verifyHttpSignature, verifyFederationRequest };
