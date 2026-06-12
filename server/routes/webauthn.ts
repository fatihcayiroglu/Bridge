// server/routes/webauthn.ts
// WebAuthn / Passkey desteği (FIDO2 uyumlu)
// Sprint 105: Crypto helpers → server/lib/webauthn-crypto.ts
//             PEM helpers    → server/lib/webauthn-pem.ts
//
// AKIŞ:
//   Kayıt:   POST /api/webauthn/register/begin   → challenge al
//            POST /api/webauthn/register/complete → credential kaydet
//   Giriş:   POST /api/webauthn/login/begin      → challenge al
//            POST /api/webauthn/login/complete    → doğrula + JWT ver
//   Yönetim: GET  /api/webauthn/credentials      → liste
//            PATCH /api/webauthn/credentials/:id → yeniden adlandır
//            DELETE /api/webauthn/credentials/:id → sil

import express from 'express';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
const router = express.Router();
import { Users, Auth } from '../db/repositories';
import { authMiddleware, makeToken, makeRefreshToken, castAuthed } from '../middleware/auth';
import { limits } from '../middleware/rateLimit';
import { cache } from '../lib/redisAdapter';
import logger from '../lib/logger';

// Crypto & PEM helpers
import {
  b64uEncode, b64uDecode, randomChallenge,
  parseAuthenticatorData, verifyRpIdHash, coseToJwk,
} from '../lib/webauthn-crypto';
import type { WebAuthnUser } from '../lib/webauthn-crypto';
import { jwkToPem, rsaJwkToPem } from '../lib/webauthn-pem';

const RP_ID = process.env.WEBAUTHN_RP_ID || process.env.DOMAIN || 'localhost';
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Bridge';
const ORIGIN = process.env.WEBAUTHN_ORIGIN || process.env.INSTANCE_URL || 'http://localhost';

type MaybeAuthedRequest = import('express').Request & { user?: { id?: string; _id?: string; username?: string } };
function getAuthedUser(req: import('express').Request) {
  const authModuleCast = castAuthed as unknown;
  if (typeof authModuleCast === 'function') return (authModuleCast as typeof castAuthed)(req).user;
  const user = (req as MaybeAuthedRequest).user;
  return { id: String(user?.id ?? user?._id ?? ''), username: user?.username };
}

type WebAuthnClientCredential = {
  id: string;
  authenticatorAttachment?: string;
  response: {
    clientDataJSON: string;
    attestationObject?: string;
    authenticatorData?: string;
    signature?: string;
    transports?: string[];
  };
};

type WebAuthnStoredCredential = {
  _id?: string;
  userId: string;
  credentialId: string;
  credId: string;
  publicKey: string;
  signCount?: number;
  counter: number;
  name?: string;
  deviceType?: string;
  transports?: string[];
  lastUsedAt?: number | null;
};


// ── SWAGGER ANNOTATIONS ───────────────────────────────────────────────────────

/**
 * @openapi
 * /webauthn/register/begin:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey kayıt challenge'ı başlat
 *     description: Kimlik doğrulanmış kullanıcı için FIDO2 kayıt challenge'ı oluşturur (YubiKey, Face ID, Touch ID)
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: WebAuthn kayıt seçenekleri
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 challenge:         { type: string, description: 'Base64URL encoded challenge' }
 *                 rp:                { type: object, properties: { id: { type: string }, name: { type: string } } }
 *                 user:              { type: object, properties: { id: { type: string }, name: { type: string }, displayName: { type: string } } }
 *                 pubKeyCredParams:  { type: array, items: { type: object } }
 *                 timeout:           { type: integer, example: 60000 }
 *                 excludeCredentials: { type: array, items: { type: object } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /webauthn/register/complete:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey kaydını tamamla
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [credential]
 *             properties:
 *               credential: { type: object, description: 'PublicKeyCredential response' }
 *               name:       { type: string, example: 'YubiKey 5', description: 'Cihaz adı (opsiyonel)' }
 *     responses:
 *       200:
 *         description: Kayıt başarılı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok:           { type: boolean }
 *                 credentialId: { type: string }
 *                 name:         { type: string }
 *                 deviceType:   { type: string, enum: [singleDevice, multiDevice] }
 *       400: { description: 'Geçersiz credential' }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /webauthn/login/begin:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey ile giriş challenge'ı başlat
 *     security: []
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string, description: 'Kullanıcı adı (boş bırakılırsa discoverable credential akışı)' }
 *     responses:
 *       200:
 *         description: WebAuthn authentication seçenekleri
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 challenge:        { type: string }
 *                 rpId:             { type: string }
 *                 timeout:          { type: integer }
 *                 userVerification: { type: string }
 *                 allowCredentials: { type: array, items: { type: object } }
 *
 * /webauthn/login/complete:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey doğrulamasını tamamla ve JWT al
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [credential]
 *             properties:
 *               credential: { type: object, description: 'AuthenticatorAssertionResponse' }
 *     responses:
 *       200:
 *         description: Giriş başarılı
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:        { type: string, description: 'JWT access token' }
 *                 refreshToken: { type: string }
 *                 user:         { $ref: '#/components/schemas/User' }
 *       400: { description: 'Geçersiz assertion' }
 *       401: { description: 'Challenge bulunamadı veya süresi dolmuş' }
 *
 * /webauthn/credentials:
 *   get:
 *     tags: [WebAuthn]
 *     summary: Kullanıcının kayıtlı passkey listesi
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Credential listesi
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   id:         { type: string }
 *                   name:       { type: string }
 *                   deviceType: { type: string }
 *                   createdAt:  { type: integer }
 *                   lastUsedAt: { type: integer }
 *                   transports: { type: array, items: { type: string } }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *
 * /webauthn/credentials/{id}:
 *   patch:
 *     tags: [WebAuthn]
 *     summary: Passkey adını güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 64 }
 *     responses:
 *       200:
 *         description: Güncellendi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }
 *   delete:
 *     tags: [WebAuthn]
 *     summary: Passkey sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 ok: { type: boolean }
 *       401: { $ref: '#/components/responses/Unauthorized' }
 *       404: { $ref: '#/components/responses/NotFound' }

 *
 * /webauthn/register/begin:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey kayıt sürecini başlat
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: PublicKeyCredentialCreationOptions
 *
 * /webauthn/register/complete:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey kayıt sürecini tamamla
 *     security: [{ bearerAuth: [] }]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               credential: { type: object }
 *               name:       { type: string, maxLength: 64 }
 *     responses:
 *       200:
 *         description: Passkey kaydedildi
 *
 * /webauthn/login/begin:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey giriş sürecini başlat
 *     security: []
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               username: { type: string }
 *     responses:
 *       200:
 *         description: PublicKeyCredentialRequestOptions
 *
 * /webauthn/login/complete:
 *   post:
 *     tags: [WebAuthn]
 *     summary: Passkey giriş sürecini tamamla
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               credential: { type: object }
 *     responses:
 *       200:
 *         description: Giriş başarılı, JWT döner
 *
 * /webauthn/credentials:
 *   get:
 *     tags: [WebAuthn]
 *     summary: Kayıtlı passkey'leri listele
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200:
 *         description: Passkey listesi
 *
 * /webauthn/credentials/{id}:
 *   patch:
 *     tags: [WebAuthn]
 *     summary: Passkey adını güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [name]
 *             properties:
 *               name: { type: string, maxLength: 64 }
 *     responses:
 *       200:
 *         description: Güncellendi
 *   delete:
 *     tags: [WebAuthn]
 *     summary: Passkey'i sil
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Silindi
 */

// ── KAYIT ─────────────────────────────────────────────────────────────────────

// POST /api/webauthn/register/begin
// Kimlik doğrulanmış kullanıcı için kayıt challenge'ı oluştur
router.post('/register/begin', authMiddleware, limits.twoFactor(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
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
});

// POST /api/webauthn/register/complete
router.post('/register/complete', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { credential, name: credName } = req.body as { credential?: WebAuthnClientCredential; name?: string };
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
  let authDataBuf: Buffer | null = null;
  try {
    const attObjBuf = b64uDecode(credential.response.attestationObject);
    // "none" formatı için: map { fmt: "none", attStmt: {}, authData: <bytes> }
    // authData her zaman CBOR map'te key "authData" = 3 (bytes type) altında
    // Basit: authData'yı bulmak için CBOR'u parse et
    let pos = 0;
    function readCbor(buf: Buffer): unknown {
      const first = buf[pos++];
      if (first === undefined) throw new Error('Unexpected end of CBOR data');
      const major = first >> 5;
      const info  = first & 0x1f;
      let len = 0;
      if (info < 24) len = info;
      else if (info === 24) { const next = buf[pos++]; if (next === undefined) throw new Error('Unexpected end of CBOR data'); len = next; }
      else if (info === 25) { len = (buf[pos] << 8) | buf[pos+1]; pos += 2; }
      else if (info === 26) { len = (buf[pos] << 24) | (buf[pos+1] << 16) | (buf[pos+2] << 8) | buf[pos+3]; pos += 4; }

      if (major === 0) return len;
      if (major === 1) return -(len + 1);
      if (major === 2) { const v = buf.slice(pos, pos+len); pos += len; return v; }
      if (major === 3) { const v = buf.slice(pos, pos+len).toString(); pos += len; return v; }
      if (major === 5) {
        const map: Record<string, unknown> = {};
        for (let i = 0; i < len; i++) { const k = readCbor(buf); map[String(k)] = readCbor(buf); }
        return map;
      }
      if (major === 4) {
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) arr.push(readCbor(buf));
        return arr;
      }
      throw new Error(`CBOR major ${major} info ${info} not supported`);
    }
    const attObj = readCbor(attObjBuf) as { authData?: Buffer };
    authDataBuf = attObj.authData ?? null;
  } catch (_err) { const err = _err as Error;
    return res.status(400).json({ error: `Failed to parse attestation: ${err.message}` });
  }

  // authenticatorData parse
  let parsedAuth: ReturnType<typeof parseAuthenticatorData>;
  try {
    if (!authDataBuf) throw new Error('Missing authData');
    parsedAuth = parseAuthenticatorData(authDataBuf);
  } catch (_err) { const err = _err as Error;
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
    if (!parsedAuth.credentialPublicKey) throw new Error('Missing credential public key');
    publicKeyJwk = coseToJwk(parsedAuth.credentialPublicKey);
  } catch (_err) { const err = _err as Error;
    return res.status(400).json({ error: `Unsupported key type: ${err.message}` });
  }

  // AAGUID → device type
  const aaguidHex = parsedAuth.aaguid ? parsedAuth.aaguid.toString('hex') : '0'.repeat(32);
  const KNOWN_AAGUIDS: Record<string, string> = {
    'cb69481e8ff7403993ec0a2729a154a8': 'YubiKey 5',
    'f8a011f38c0a4d15800617111f9edc7d': 'YubiKey 5 NFC',
    'd8522d9f575b486688a9ba99fa02f35b': 'YubiKey Bio',
    'adce000235bcc60a648b0b25f1f05503': 'Chrome TouchID',
    'b93fd961f2e6462fb1787561011dba26': 'Android Passkey',
  };
  const deviceType = KNOWN_AAGUIDS[aaguidHex] ?? (credential.authenticatorAttachment === 'platform' ? 'Platform Authenticator' : 'Security Key');

  // Kaydet
  const credDoc: WebAuthnStoredCredential & { aaguid?: string; createdAt?: number; lastUsedAt?: number | null } = {
    _id: uuidv4(),
    userId: user._id,
    credentialId: credentialIdB64,
    credId: credentialIdB64,
    publicKey: JSON.stringify(publicKeyJwk),
    signCount: parsedAuth.signCount,
    counter: parsedAuth.signCount,
    name: (credName || deviceType).slice(0, 64),
    deviceType,
    transports: credential.response.transports || [],
    createdAt: Date.now(),
    lastUsedAt: null,
    aaguid: aaguidHex,
  };

  if (!Auth.hasWebauthnCollection()) {
    // Koleksiyon yoksa kullanıcı dokümanına göm (basit fallback)
    const existingKeys = [...(user.webauthnCredentials ?? [])];
    existingKeys.push(credDoc as unknown as typeof existingKeys[number]);
    await Users.update(user._id, { webauthnCredentials: existingKeys, webauthnEnabled: true });
  } else {
    await Auth.insertCredential(credDoc);
    await Users.update(user._id, { webauthnEnabled: true });
  }

  res.json({ ok: true, credentialId: credentialIdB64, name: credDoc.name, deviceType });
});

// ── GİRİŞ ─────────────────────────────────────────────────────────────────────

// POST /api/webauthn/login/begin
// Body: { username } — kullanıcı adıyla başlat, veya boş (discoverable credential)
router.post('/login/begin', async (req: import("express").Request, res: import("express").Response) => {
  const { username } = req.body as Record<string, string>;

  const challenge  = randomChallenge();
  const sessionKey = `webauthn:auth:${b64uEncode(challenge)}`;

  let allowCredentials: Array<{ type: 'public-key'; id: string; transports: string[] }> = [];
  let userId: string | null = null;

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
});

// POST /api/webauthn/login/complete
router.post('/login/complete', async (req: import("express").Request, res: import("express").Response) => {
  const { credential } = req.body as { credential?: WebAuthnClientCredential };
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
  const session    = await cache.get(sessionKey) as { challenge?: string; userId?: string | null; expiresAt?: number } | null;
  if (!session) return res.status(400).json({ error: 'Challenge expired or not found' });
  await cache.del(sessionKey);

  if (clientData.challenge !== session.challenge)
    return res.status(400).json({ error: 'Challenge mismatch' });

  // Credential ara
  const credentialId = credential.id;
  let storedCred: WebAuthnStoredCredential | null = null;
  let user: WebAuthnUser | null = null;

  if (Auth.hasWebauthnCollection()) {
    storedCred = await Auth.findCredential(credentialId) as WebAuthnStoredCredential | null;
    if (storedCred) {
      user = await Users.findById(storedCred.userId) as WebAuthnUser | null;
    }
  } else {
    // Kullanıcı dokümanında gömülü credential ara
    if (session.userId) {
      user = await Users.findById(String(session.userId)) as WebAuthnUser | null;
      if (user?.webauthnCredentials) {
        const embedded = user.webauthnCredentials.find(c => c.credId === credentialId || String(c.credentialId ?? '') === credentialId);
        storedCred = embedded ? {
          ...embedded,
          userId: user._id,
          credentialId: String(embedded.credentialId ?? embedded.credId),
          credId: String(embedded.credId ?? embedded.credentialId),
          publicKey: String(embedded.publicKey),
          counter: Number(embedded.counter ?? embedded.signCount ?? 0),
        } as WebAuthnStoredCredential : null;
      }
    }
  }

  if (!storedCred || !user)
    return res.status(401).json({ error: 'Credential not found' });

  // Authenticator data doğrula
  const authDataBuf = b64uDecode(credential.response.authenticatorData);
  let parsedAuth: ReturnType<typeof parseAuthenticatorData>;
  try {
    if (!authDataBuf) throw new Error('Missing authData');
    parsedAuth = parseAuthenticatorData(authDataBuf);
  } catch (_err) { const err = _err as Error;
    return res.status(400).json({ error: `Invalid authenticatorData: ${err.message}` });
  }

  if (!parsedAuth.UP) return res.status(400).json({ error: 'User presence required' });
  if (!verifyRpIdHash(parsedAuth.rpIdHash)) return res.status(400).json({ error: 'RP ID mismatch' });

  // Sign count replay attack koruması
  const storedSignCount = storedCred.signCount ?? storedCred.counter ?? 0;
  if (parsedAuth.signCount > 0 && storedSignCount > 0) {
    if (parsedAuth.signCount <= storedSignCount) {
      logger.warn({ userId: user._id, event: 'webauthn.cloned_authenticator' }, '[WebAuthn] Possible cloned authenticator');
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
  if (!credential.response.signature) return res.status(400).json({ error: 'Missing signature' });
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
  } catch (_err) { const err = _err as Error;
    logger.error({ err, event: 'webauthn.signature_error' }, '[WebAuthn] Signature verification error');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  if (!verified) return res.status(401).json({ error: 'Invalid signature' });

  // Sign count güncelle
  const updateData = { lastUsedAt: Date.now(), signCount: parsedAuth.signCount };
  if (Auth.hasWebauthnCollection()) {
    if (storedCred._id) await Auth.updateCredentialByDocId(storedCred._id, updateData);
  } else {
    const updatedCreds = (user.webauthnCredentials ?? []).map(c =>
      c.credentialId === credentialId ? { ...c, ...updateData } : c
    );
    await Users.update(user._id, { webauthnCredentials: updatedCreds });
  }

  // JWT ver — normal login gibi
  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user);

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
});

// ── YÖNETİM ──────────────────────────────────────────────────────────────────

// GET /api/webauthn/credentials — kullanıcının credential listesi
router.get('/credentials', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
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
});

// PATCH /api/webauthn/credentials/:id — isim güncelle
router.patch('/credentials/:id', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const { name } = req.body as Record<string, string>;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });

  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (Auth.hasWebauthnCollection()) {
    const cred = await Auth.findCredentialByDocId(String(req.params.id ?? ''), _u.id);
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    await Auth.updateCredentialByDocId(String(req.params.id ?? ''), { name: name.slice(0, 64) });
  } else {
    const creds = user.webauthnCredentials ?? [];
    const idx   = creds.findIndex(c => c._id === String(req.params.id ?? ''));
    if (idx === -1) return res.status(404).json({ error: 'Credential not found' });
    creds[idx].name = name.slice(0, 64);
    await Users.update(user._id, { webauthnCredentials: creds });
  }

  res.json({ ok: true });
});

// DELETE /api/webauthn/credentials/:id
router.delete('/credentials/:id', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  if (Auth.hasWebauthnCollection()) {
    const cred = await Auth.findCredentialByDocId(String(req.params.id ?? ''), _u.id);
    if (!cred) return res.status(404).json({ error: 'Credential not found' });
    await Auth.deleteCredential(String(req.params.id ?? ''), _u.id);

    // Son credential silindiyse webauthnEnabled = false
    const remaining = await Auth.findCredentialsByUser(_u.id);
    if (!remaining.length) {
      await Users.update(user._id, { webauthnEnabled: false });
    }
  } else {
    const creds = (user.webauthnCredentials || []).filter(c => c._id !== String(req.params.id ?? ''));
    await Users.update(user._id, {
      webauthnCredentials: creds,
      webauthnEnabled: creds.length > 0,
    });
  }

  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
