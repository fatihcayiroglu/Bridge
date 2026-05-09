// @ts-nocheck
// server/lib/httpSignature.js
// federation.js'den ayrıştırılmış HTTP Signature doğrulama modülü
// Daha önce federation.js içinde ~180 satır inline tanımlıydı
'use strict';

const crypto = require('crypto');
const db = require('../db/loader');

// ── HTTP Signature Modülü ───────────────────────────────────────
// RFC draft-cavage-http-signatures implementasyonu.
// Düzeltmeler: per-user keyId, public key cache, replay attack koruması,
//              Digest zorunluluğu, daha dar zaman penceresi (5 dk).

// ── Public Key Cache ──────────────────────────────────────────────────────────
// Remote key fetch'i cache'ler: TTL 10 dk, maks 500 kayıt
const _keyCache = new Map(); // keyId → { pem, expiresAt }
const KEY_CACHE_TTL_MS  = 10 * 60 * 1000; // 10 dakika
const KEY_CACHE_MAX     = 500;

function _cacheGet(keyId) {
  const entry = _keyCache.get(keyId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _keyCache.delete(keyId); return null; }
  return entry.pem;
}

function _cacheSet(keyId, pem) {
  if (_keyCache.size >= KEY_CACHE_MAX) {
    // En eski girişi sil
    const oldest = _keyCache.keys().next().value;
    _keyCache.delete(oldest);
  }
  _keyCache.set(keyId, { pem, expiresAt: Date.now() + KEY_CACHE_TTL_MS });
}

// ── Replay Attack Koruması ────────────────────────────────────────────────────
// Kullanılmış imzaları 5 dk boyunca saklar
const _usedSignatures = new Map(); // signature → expiresAt
const SIG_REPLAY_TTL_MS = 5 * 60 * 1000; // 5 dakika

function _isReplay(sig) {
  const exp = _usedSignatures.get(sig);
  if (!exp) return false;
  if (Date.now() > exp) { _usedSignatures.delete(sig); return false; }
  return true;
}

function _markUsed(sig) {
  // Süresi dolmuş girişleri temizle (her 100 kayıtta bir)
  if (_usedSignatures.size % 100 === 0) {
    const now = Date.now();
    for (const [k, v] of _usedSignatures) { if (now > v) _usedSignatures.delete(k); }
  }
  _usedSignatures.set(sig, Date.now() + SIG_REPLAY_TTL_MS);
}

// ── Signature Header Parser ───────────────────────────────────────────────────
function _parseSigHeader(header) {
  const params = {};
  // Mastodon format: keyId="...",algorithm="...",headers="...",signature="..."
  // Bazı sunucular boşluk bırakır; regex her ikisini de yakalar
  const re = /(\w+)="([^"]*)"/g;
  let m;
  while ((m = re.exec(header)) !== null) params[m[1]] = m[2];
  return params;
}

// ── Signing String Builder ────────────────────────────────────────────────────
function _buildSigningString(req, headerList) {
  return headerList.map(h => {
    if (h === '(request-target)') {
      return `(request-target): ${req.method.toLowerCase()} ${req.originalUrl || req.url}`;
    }
    return `${h}: ${req.headers[h.toLowerCase()] ?? ''}`;
  }).join('\n');
}

// ── Public Key Resolver ───────────────────────────────────────────────────────
async function _resolvePublicKey(keyId) {
  // 1. Cache'e bak
  const cached = _cacheGet(keyId);
  if (cached) return cached;

  // 2. Yerel kullanıcı mı?
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
    return null; // Yerel ama bulunamadı
  }

  // 3. Remote fetch — keyId doğrudan actor URL veya key URL olabilir
  const fetchFn = globalThis.fetch;
  const r = await fetchFn(keyId, {
    headers: { 'Accept': 'application/activity+json, application/ld+json, application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok) throw new Error(`Key fetch failed: ${r.status} ${r.url}`);
  const doc = await r.json();

  // Actor objesinin publicKey.publicKeyPem'i al
  const pem = doc?.publicKey?.publicKeyPem ?? doc?.publicKeyPem ?? null;
  if (pem) _cacheSet(keyId, pem);
  return pem;
}

// ── Ana Doğrulama Fonksiyonu ──────────────────────────────────────────────────
async function verifyHttpSignature(req) {
  try {
    const { createVerify, createHash } = require('crypto');
    const sigHeader = req.headers['signature'];
    if (!sigHeader) return { ok: false, reason: 'No Signature header' };

    const { keyId, headers: signedHeaders, signature } = _parseSigHeader(sigHeader);
    if (!keyId || !signedHeaders || !signature) {
      return { ok: false, reason: 'Missing signature params (keyId/headers/signature)' };
    }

    // ── 1. Replay attack kontrolü ─────────────────────────────────────────────
    if (_isReplay(signature)) {
      return { ok: false, reason: 'Replay attack: signature already used' };
    }

    // ── 2. Date header — zaman penceresi ±5 dakika (30 yerine daha sıkı) ──────
    const dateStr = req.headers['date'];
    if (!dateStr) return { ok: false, reason: 'Date header required' };
    const reqTime = new Date(dateStr).getTime();
    if (isNaN(reqTime) || Math.abs(Date.now() - reqTime) > 5 * 60 * 1000) {
      return { ok: false, reason: 'Date header too old, too new, or invalid (±5min)' };
    }

    // ── 3. Digest zorunlu (body manipülasyonunu önler) ────────────────────────
    const digestHeader = req.headers['digest'];
    if (!digestHeader) return { ok: false, reason: 'Digest header required' };
    const bodyStr  = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? '');
    const expected = 'SHA-256=' + createHash('sha256').update(bodyStr).digest('base64');
    if (digestHeader !== expected) {
      return { ok: false, reason: 'Digest mismatch — body may have been tampered' };
    }

    // ── 4. Signing string ─────────────────────────────────────────────────────
    const headerList    = signedHeaders.split(' ');
    const signingString = _buildSigningString(req, headerList);

    // ── 5. Public key resolve ─────────────────────────────────────────────────
    let publicKeyPem;
    try {
      publicKeyPem = await _resolvePublicKey(keyId);
    } catch (e) {
      return { ok: false, reason: `Key resolve error: ${e.message}` };
    }
    if (!publicKeyPem) return { ok: false, reason: 'Public key not found' };

    // ── 6. RSA-SHA256 doğrulama ───────────────────────────────────────────────
    const verify = createVerify('RSA-SHA256');
    verify.update(signingString);
    const valid = verify.verify(publicKeyPem, signature, 'base64');

    if (valid) {
      _markUsed(signature); // Replay için işaretle
      return { ok: true, keyId };
    }
    return { ok: false, reason: 'Signature cryptographically invalid' };

  } catch (e) {
    return { ok: false, reason: `Verify error: ${e.message}` };
  }
}

// ── YARDIMCI: Uzak sunucu isteklerini doğrula ──────────────────
function verifyFederationRequest(req) {
  const sig    = req.headers['x-bridge-sig'];
  const ts     = req.headers['x-bridge-ts'];
  if (!sig || !ts) return false;
  // Zaman damgası 5 dakikadan eski mi?
  if (Math.abs(Date.now() - parseInt(ts)) > 5 * 60 * 1000) return false;
  const payload = ts + JSON.stringify(req.body);
  const secret  = process.env.FEDERATION_SECRET || 'bridge-federation-default';
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
}


module.exports = { verifyHttpSignature, verifyFederationRequest };
export {};
