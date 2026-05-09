// @ts-nocheck
// server/routes/webauthn.js
// WebAuthn / Passkey desteği (FIDO2 uyumlu)
// Hardware key (YubiKey), Face ID, Touch ID ile giriş
//
// AKIŞ:
//   Kayıt:   POST /api/webauthn/register/begin   → challenge al
//            POST /api/webauthn/register/complete → credential kaydet
//   Giriş:   POST /api/webauthn/login/begin      → challenge al
//            POST /api/webauthn/login/complete    → doğrula + JWT ver
//   Yönetim: GET  /api/webauthn/credentials      → liste
//            DELETE /api/webauthn/credentials/:id → sil

'use strict';

const express      = require('express');
const crypto       = require('crypto');
const { v4: uuidv4 } = require('uuid');
const router       = express.Router();
const { Users, Auth } = require('../db/repositories');
const { authMiddleware, makeToken, makeRefreshToken, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');
const { limits }   = require('../middleware/rateLimit');
const { cache }    = require('../lib/redisAdapter');

// ── Helpers ──────────────────────────────────────────────────────────────────

const RP_ID   = process.env.WEBAUTHN_RP_ID   || 'localhost';
const RP_NAME = process.env.WEBAUTHN_RP_NAME || (process.env.INSTANCE_NAME || 'Bridge');
const ORIGIN  = process.env.WEBAUTHN_ORIGIN  || `https://${RP_ID}`;

// Base64URL encode/decode (WebAuthn kullanır, standart base64 değil)
function b64uEncode(buf) {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

function b64uDecode(str) {
  const pad = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function randomChallenge() {
  return crypto.randomBytes(32);
}

// CBOR kütüphanesi olmadan minimal CBOR decode (authenticator data için)
// Sadece attestedCredentialData parse etmemiz lazım
function parseAuthenticatorData(authDataBuf) {
  if (authDataBuf.length < 37) throw new Error('authenticatorData too short');

  let offset = 0;
  const rpIdHash = authDataBuf.slice(offset, offset + 32); offset += 32;
  const flags    = authDataBuf[offset]; offset += 1;
  const signCount = authDataBuf.readUInt32BE(offset); offset += 4;

  const UP  = !!(flags & 0x01); // User Present
  const UV  = !!(flags & 0x04); // User Verified
  const AT  = !!(flags & 0x40); // Attested credential data included
  const ED  = !!(flags & 0x80); // Extension data included

  let credentialId = null;
  let credentialPublicKey = null;
  let aaguid = null;

  if (AT && authDataBuf.length > offset + 16 + 2) {
    aaguid = authDataBuf.slice(offset, offset + 16); offset += 16;
    const credIdLen = authDataBuf.readUInt16BE(offset); offset += 2;
    credentialId = authDataBuf.slice(offset, offset + credIdLen); offset += credIdLen;
    // CBOR-encoded public key — store raw for now, verify signature separately
    credentialPublicKey = authDataBuf.slice(offset);
  }

  return { rpIdHash, flags, UP, UV, AT, ED, signCount, credentialId, credentialPublicKey, aaguid };
}

// RP ID hash doğrula
function verifyRpIdHash(rpIdHash) {
  const expected = crypto.createHash('sha256').update(RP_ID).digest();
  return expected.equals(rpIdHash);
}

// Minimal COSE key → SubtleCrypto JWK dönüşümü (ES256 = -7, RS256 = -257)
// COSE key map (cbor map keys): 1=kty, 3=alg, -1=crv/n, -2=x/e, -3=y
function coseToJwk(coseBuf) {
  // Basit CBOR map parse — sadece ES256 ve RS256 destekliyoruz
  // CBOR major type 5 = map
  let pos = 0;
  const b = coseBuf;

  function readCbor() {
    const first = b[pos++];
    const major = first >> 5;
    const info  = first & 0x1f;

    let val;
    if (info < 24) val = info;
    else if (info === 24) val = b[pos++];
    else if (info === 25) { val = (b[pos] << 8) | b[pos+1]; pos += 2; }
    else if (info === 26) { val = (b[pos] << 24) | (b[pos+1] << 16) | (b[pos+2] << 8) | b[pos+3]; pos += 4; }

    if (major === 0) return val;                                 // uint
    if (major === 1) return -(val + 1);                          // negint
    if (major === 2) { const v = b.slice(pos, pos+val); pos += val; return v; } // bytes
    if (major === 3) { const v = b.slice(pos, pos+val).toString(); pos += val; return v; } // text
    if (major === 5) {                                           // map
      const map = {};
      for (let i = 0; i < val; i++) {
        const k = readCbor();
        map[k] = readCbor();
      }
      return map;
    }
    throw new Error(`Unsupported CBOR major type: ${major}`);
  }

  const map = readCbor();
  const kty = map[1];
  const alg = map[3];

  if (kty === 2 && alg === -7) {
    // EC2 key (ES256) — P-256
    return {
      kty: 'EC', crv: 'P-256', alg: 'ES256',
      x: b64uEncode(map[-2]),
      y: b64uEncode(map[-3]),
    };
  }
  if (kty === 3) {
    // RSA key (RS256)
    return {
      kty: 'RSA', alg: 'RS256',
      n: b64uEncode(map[-1]),
      e: b64uEncode(map[-2]),
    };
  }
  throw new Error(`Unsupported COSE key type: kty=${kty} alg=${alg}`);
}

// ── KAYIT ─────────────────────────────────────────────────────────────────────

// POST /api/webauthn/register/begin
// Kimlik doğrulanmış kullanıcı için kayıt challenge'ı oluştur
router.post('/register/begin', authMiddleware, limits.twoFactor(), asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user: any = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Mevcut credentialler
  const existing = await Auth.findCredentialsByUser(user._id);

  const challenge = randomChallenge();
  const sessionKey = `webauthn:reg:${user._id}`;
  await cache.set(sessionKey, b64uEncode(challenge), 300); // 5 dakika

  res.json({
    challenge: b64uEncode(challenge),
    rp: { id: RP_ID, name: RP_NAME },
    user: {
      id: b64uEncode(Buffer.from(user._id)),
      name: user.username,
      displayName: user.displayName || user.username,
    },
    pubKeyCredParams: [
      { type: 'public-key', alg: -7  }, // ES256 (ECDSA P-256) — tercih edilen
      { type: 'public-key', alg: -257 }, // RS256 — eski YubiKey uyumluluğu
    ],
    timeout: 60000,
    attestation: 'none', // production'da 'direct' veya 'indirect' kullanılabilir
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred',
      requireResidentKey: false,
    },
    excludeCredentials: existing.map(c => ({
      type: 'public-key',
      id: c.credentialId, // zaten base64url
      transports: c.transports || [],
    })),
  });
}));

// POST /api/webauthn/register/complete
router.post('/register/complete', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user: any = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { credential, name: credName } = req.body;
  if (!credential?.response?.clientDataJSON || !credential?.response?.attestationObject) {
    return res.status(400).json({ error: 'Invalid credential response' });
  }

  // Challenge kontrolü
  const sessionKey = `webauthn:reg:${user._id}`;
  const storedChallenge = await cache.get(sessionKey);
  if (!storedChallenge) return res.status(400).json({ error: 'Challenge expired. Please try again.' });
  await cache.del(sessionKey);

  // clientDataJSON parse
  let clientData;
  try {
    clientData = JSON.parse(b64uDecode(credential.response.clientDataJSON).toString());
  } catch {
    return res.status(400).json({ error: 'Invalid clientDataJSON' });
  }

  if (clientData.type !== 'webauthn.create')
    return res.status(400).json({ error: 'Invalid ceremony type' });
  if (clientData.challenge !== storedChallenge)
    return res.status(400).json({ error: 'Challenge mismatch' });
  if (!clientData.origin.startsWith(ORIGIN) && ORIGIN !== 'http://localhost')
    return res.status(400).json({ error: 'Origin mismatch' });

  // attestationObject parse (CBOR)
  // attestationObject = { fmt, attStmt, authData }
  // Minimal CBOR decode — sadece authData'ya ihtiyacımız var
  let authDataBuf;
  try {
    const attObjBuf = b64uDecode(credential.response.attestationObject);
    // "none" formatı için: map { fmt: "none", attStmt: {}, authData: <bytes> }
    // authData her zaman CBOR map'te key "authData" = 3 (bytes type) altında
    // Basit: authData'yı bulmak için CBOR'u parse et
    let pos = 0;
    function readCbor(buf) {
      const first = buf[pos++];
      const major = first >> 5;
      const info  = first & 0x1f;
      let len;
      if (info < 24) len = info;
      else if (info === 24) len = buf[pos++];
      else if (info === 25) { len = (buf[pos] << 8) | buf[pos+1]; pos += 2; }
      else if (info === 26) { len = (buf[pos] << 24) | (buf[pos+1] << 16) | (buf[pos+2] << 8) | buf[pos+3]; pos += 4; }

      if (major === 0) return len;
      if (major === 1) return -(len + 1);
      if (major === 2) { const v = buf.slice(pos, pos+len); pos += len; return v; }
      if (major === 3) { const v = buf.slice(pos, pos+len).toString(); pos += len; return v; }
      if (major === 5) {
        const map = {};
        for (let i = 0; i < len; i++) { const k = readCbor(buf); map[k] = readCbor(buf); }
        return map;
      }
      if (major === 4) {
        const arr: any[] = [];
        for (let i = 0; i < len; i++) arr.push(readCbor(buf));
        return arr;
      }
      throw new Error(`CBOR major ${major} info ${info} not supported`);
    }
    const attObj = readCbor(attObjBuf);
    authDataBuf = attObj.authData;
  } catch (err) {
    return res.status(400).json({ error: `Failed to parse attestation: ${err.message}` });
  }

  // authenticatorData parse
  let parsedAuth;
  try {
    parsedAuth = parseAuthenticatorData(authDataBuf);
  } catch (err) {
    return res.status(400).json({ error: `Failed to parse authenticatorData: ${err.message}` });
  }

  if (!parsedAuth.UP) return res.status(400).json({ error: 'User presence flag not set' });
  if (!verifyRpIdHash(parsedAuth.rpIdHash)) return res.status(400).json({ error: 'RP ID hash mismatch' });
  if (!parsedAuth.credentialId) return res.status(400).json({ error: 'No credential data in response' });

  const credentialIdB64 = b64uEncode(parsedAuth.credentialId);

  // Duplicate check
  const dup = await Auth.findCredential(credentialIdB64);
  if (dup) return res.status(400).json({ error: 'Credential already registered' });

  // Public key JWK
  let publicKeyJwk;
  try {
    publicKeyJwk = coseToJwk(parsedAuth.credentialPublicKey);
  } catch (err) {
    return res.status(400).json({ error: `Unsupported key type: ${err.message}` });
  }

  // AAGUID → device type
  const aaguidHex = parsedAuth.aaguid ? parsedAuth.aaguid.toString('hex') : '0'.repeat(32);
  const KNOWN_AAGUIDS = {
    'cb69481e8ff7403993ec0a2729a154a8': 'YubiKey 5',
    'f8a011f38c0a4d15800617111f9edc7d': 'YubiKey 5 NFC',
    'd8522d9f575b486688a9ba99fa02f35b': 'YubiKey Bio',
    'adce000235bcc60a648b0b25f1f05503': 'Chrome TouchID',
    'b93fd961f2e6462fb1787561011dba26': 'Android Passkey',
  };
  const deviceType = KNOWN_AAGUIDS[aaguidHex] || credential.authenticatorAttachment === 'platform' ? 'Platform Authenticator' : 'Security Key';

  // Kaydet
  const credDoc = {
    _id: uuidv4(),
    userId: user._id,
    credentialId: credentialIdB64,
    publicKey: JSON.stringify(publicKeyJwk),
    signCount: parsedAuth.signCount,
    name: (credName || deviceType).slice(0, 64),
    deviceType,
    transports: credential.response.transports || [],
    createdAt: Date.now(),
    lastUsedAt: null,
    aaguid: aaguidHex,
  };

  if (!Auth.hasWebauthnCollection()) {
    // Koleksiyon yoksa kullanıcı dokümanına göm (basit fallback)
    const existingKeys = user.webauthnCredentials || [];
    existingKeys.push(credDoc);
    await Users.update(user._id, { webauthnCredentials: existingKeys, webauthnEnabled: true });
  } else {
    await Auth.insertCredential(credDoc);
    await Users.update(user._id, { webauthnEnabled: true });
  }

  res.json({ ok: true, credentialId: credentialIdB64, name: credDoc.name, deviceType });
}));

// ── GİRİŞ ─────────────────────────────────────────────────────────────────────

// POST /api/webauthn/login/begin
// Body: { username } — kullanıcı adıyla başlat, veya boş (discoverable credential)
router.post('/login/begin', asyncHandler(async (req, res) => {
  const { username } = req.body;

  const challenge  = randomChallenge();
  const sessionKey = `webauthn:auth:${b64uEncode(challenge)}`;

  let allowCredentials = [];
  let userId = null;

  if (username) {
    const user = await Users.findByUsername(username);
    if (user) {
      userId = user._id;
      const creds = Auth.hasWebauthnCollection()
        ? await Auth.findCredentialsByUser(user._id)
        : (user.webauthnCredentials || []);

      allowCredentials = creds.map(c => ({
        type: 'public-key',
        id: c.credentialId,
        transports: c.transports || [],
      }));
    }
  }

  await cache.set(sessionKey, {
    challenge: b64uEncode(challenge),
    userId,
    expiresAt: Date.now() + 300_000,
  }, 300);

  res.json({
    challenge: b64uEncode(challenge),
    rpId: RP_ID,
    timeout: 60000,
    userVerification: 'preferred',
    allowCredentials,
  });
}));

// POST /api/webauthn/login/complete
router.post('/login/complete', asyncHandler(async (req, res) => {
  const { credential } = req.body;
  if (!credential?.response?.clientDataJSON || !credential?.response?.authenticatorData) {
    return res.status(400).json({ error: 'Invalid assertion response' });
  }

  // clientDataJSON parse
  let clientData;
  try {
    clientData = JSON.parse(b64uDecode(credential.response.clientDataJSON).toString());
  } catch {
    return res.status(400).json({ error: 'Invalid clientDataJSON' });
  }

  if (clientData.type !== 'webauthn.get')
    return res.status(400).json({ error: 'Invalid ceremony type' });

  const sessionKey = `webauthn:auth:${clientData.challenge}`;
  const session    = await cache.get(sessionKey);
  if (!session) return res.status(400).json({ error: 'Challenge expired or not found' });
  await cache.del(sessionKey);

  if (clientData.challenge !== session.challenge)
    return res.status(400).json({ error: 'Challenge mismatch' });

  // Credential ara
  const credentialId = credential.id;
  let storedCred: any = null;
  let user = null;

  if (Auth.hasWebauthnCollection()) {
    storedCred = await Auth.findCredential(credentialId);
    if (storedCred) {
      user = await Users.findById(storedCred.userId);
    }
  } else {
    // Kullanıcı dokümanında gömülü credential ara
    if (session.userId) {
      user = await Users.findById(session.userId);
      if (user?.webauthnCredentials) {
        storedCred = user.webauthnCredentials.find(c => c.credentialId === credentialId);
      }
    }
  }

  if (!storedCred || !user)
    return res.status(401).json({ error: 'Credential not found' });

  // Authenticator data doğrula
  const authDataBuf = b64uDecode(credential.response.authenticatorData);
  let parsedAuth;
  try {
    parsedAuth = parseAuthenticatorData(authDataBuf);
  } catch (err) {
    return res.status(400).json({ error: `Invalid authenticatorData: ${err.message}` });
  }

  if (!parsedAuth.UP) return res.status(400).json({ error: 'User presence required' });
  if (!verifyRpIdHash(parsedAuth.rpIdHash)) return res.status(400).json({ error: 'RP ID mismatch' });

  // Sign count replay attack koruması
  if (parsedAuth.signCount > 0 && storedCred.signCount > 0) {
    if (parsedAuth.signCount <= storedCred.signCount) {
      console.warn(`[WebAuthn] Possible cloned authenticator for user ${user._id}`);
      return res.status(401).json({ error: 'Sign count replay detected — possible cloned authenticator' });
    }
  }

  // İmza doğrulama (ES256 / RS256)
  const publicKeyJwk = JSON.parse(storedCred.publicKey);

  // Doğrulanacak veri: authData + SHA256(clientDataJSON)
  const clientDataHash = crypto.createHash('sha256')
    .update(b64uDecode(credential.response.clientDataJSON))
    .digest();
  const signedData = Buffer.concat([authDataBuf, clientDataHash]);
  const signature  = b64uDecode(credential.response.signature);

  let verified = false;
  try {
    if (publicKeyJwk.alg === 'ES256') {
      // ECDSA P-256 doğrulama — Node.js crypto ile
      const keyPem = jwkToPem(publicKeyJwk);
      const verify  = crypto.createVerify('SHA256');
      verify.update(signedData);
      verified = verify.verify({ key: keyPem, dsaEncoding: 'der' }, signature);
    } else if (publicKeyJwk.alg === 'RS256') {
      const keyPem = rsaJwkToPem(publicKeyJwk);
      const verify  = crypto.createVerify('SHA256');
      verify.update(signedData);
      verified = verify.verify(keyPem, signature);
    }
  } catch (err) {
    console.error('[WebAuthn] Signature verification error:', err.message);
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  if (!verified) return res.status(401).json({ error: 'Invalid signature' });

  // Sign count güncelle
  const updateData = { lastUsedAt: Date.now(), signCount: parsedAuth.signCount };
  if (Auth.hasWebauthnCollection()) {
    await Auth.updateCredentialByDocId(storedCred._id, updateData);
  } else {
    const updatedCreds = user.webauthnCredentials.map(c =>
      c.credentialId === credentialId ? { ...c, ...updateData } : c
    );
    await Users.update(user._id, { webauthnCredentials: updatedCreds });
  }

  // JWT ver — normal login gibi
  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user._id);

  res.json({
    ok: true,
    token,
    refreshToken,
    user: {
      id:          user._id,
      username:    user.username,
      displayName: user.displayName,
      avatarUrl:   user.avatarUrl,
      avatarColor: user.avatarColor,
    },
  });
}));

// ── YÖNETİM ──────────────────────────────────────────────────────────────────

// GET /api/webauthn/credentials — kullanıcının credential listesi
router.get('/credentials', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user: any = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  let creds;
  if (Auth.hasWebauthnCollection()) {
    creds = await Auth.findCredentialsByUser(_u.id);
  } else {
    creds = user.webauthnCredentials || [];
  }

  res.json(creds.map(c => ({
    id:         c._id,
    name:       c.name,
    deviceType: c.deviceType,
    createdAt:  c.createdAt,
    lastUsedAt: c.lastUsedAt,
    transports: c.transports,
    // publicKey ve credentialId frontend'e gönderilmez
  })));
}));

// PATCH /api/webauthn/credentials/:id — isim güncelle
router.patch('/credentials/:id', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const { name } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  const user: any = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (Auth.hasWebauthnCollection()) {
    const cred = await Auth.findCredentialsByUser(_u.id).then(list => list.find(c => c._id === req.params.id));
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    await Auth.updateCredentialByDocId(req.params.id, { name: name.slice(0, 64) });
  } else {
    const creds = user.webauthnCredentials || [];
    const idx   = creds.findIndex(c => c._id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'Credential not found' });
    creds[idx].name = name.slice(0, 64);
    await Users.update(user._id, { webauthnCredentials: creds });
  }

  res.json({ ok: true });
}));

// DELETE /api/webauthn/credentials/:id
router.delete('/credentials/:id', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user: any = await Users.findById(_u.id);
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (Auth.hasWebauthnCollection()) {
    const credList = await Auth.findCredentialsByUser(_u.id);
    const cred = credList.find(c => c._id === req.params.id);
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    await Auth.deleteCredential(req.params.id, _u.id);

    // Son credential silindiyse webauthnEnabled = false
    const remaining = await Auth.findCredentialsByUser(_u.id);
    if (!remaining.length) {
      await Users.update(user._id, { webauthnEnabled: false });
    }
  } else {
    const creds = (user.webauthnCredentials || []).filter(c => c._id !== req.params.id);
    await Users.update(user._id, {
      webauthnCredentials: creds,
      webauthnEnabled: creds.length > 0,
    });
  }

  res.json({ ok: true });
}));

// ── Key helpers (PEM dönüşüm) ─────────────────────────────────────────────────

function jwkToPem(jwk) {
  // EC P-256 public key → uncompressed point → DER SubjectPublicKeyInfo
  const x = b64uDecode(jwk.x);
  const y = b64uDecode(jwk.y);
  // Uncompressed EC point: 04 || x || y
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);

  // SubjectPublicKeyInfo DER for EC P-256 (OID 1.2.840.10045.2.1, 1.2.840.10045.3.1.7)
  const ecOid = Buffer.from('301306072a8648ce3d020106082a8648ce3d030107', 'hex');
  const bitStr = Buffer.concat([Buffer.from([0x00]), point]); // 0x00 = no unused bits
  const bitStrSeq = Buffer.concat([Buffer.from([0x03]), encodeLength(bitStr.length), bitStr]);
  const spki = Buffer.concat([ecOid, bitStrSeq]);
  const seq  = Buffer.concat([Buffer.from([0x30]), encodeLength(spki.length), spki]);

  return `-----BEGIN PUBLIC KEY-----\n${seq.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
}

function rsaJwkToPem(jwk) {
  // RSA public key JWK → DER → PEM
  const n = b64uDecode(jwk.n);
  const e = b64uDecode(jwk.e);
  const nInt = Buffer.concat([Buffer.from([0x00]), n]); // positive integer
  const nSeq = Buffer.concat([Buffer.from([0x02]), encodeLength(nInt.length), nInt]);
  const eSeq = Buffer.concat([Buffer.from([0x02]), encodeLength(e.length), e]);
  const keySeq = Buffer.concat([nSeq, eSeq]);
  const seq  = Buffer.concat([Buffer.from([0x30]), encodeLength(keySeq.length), keySeq]);

  // SubjectPublicKeyInfo wrapper (OID 1.2.840.113549.1.1.1 = rsaEncryption)
  const rsaOid = Buffer.from('300d06092a864886f70d0101010500', 'hex');
  const bitStr = Buffer.concat([Buffer.from([0x00]), seq]);
  const bitStrSeq = Buffer.concat([Buffer.from([0x03]), encodeLength(bitStr.length), bitStr]);
  const spki = Buffer.concat([rsaOid, bitStrSeq]);
  const spkiSeq = Buffer.concat([Buffer.from([0x30]), encodeLength(spki.length), spki]);

  return `-----BEGIN PUBLIC KEY-----\n${spkiSeq.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END PUBLIC KEY-----`;
}

function encodeLength(len) {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, len >> 8, len & 0xff]);
}

module.exports = router;
export {};
