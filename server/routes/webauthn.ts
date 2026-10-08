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
import { setRefreshCookie } from '../lib/authCookies';
import { setMediaCookie } from '../lib/mediaCookie';
import { mintSignInGrants, requireStepUp } from '../lib/stepUp';

// Crypto & PEM helpers
import {
  b64uEncode, b64uDecode, randomChallenge,
  parseAuthenticatorData, verifyRpIdHash, coseToJwk,
} from '../lib/webauthn-crypto';
import type { WebAuthnUser } from '../lib/webauthn-crypto';
import { jwkToPem, rsaJwkToPem } from '../lib/webauthn-pem';
import { isAllowedWebAuthnOrigin, resolveWebAuthnRpId } from '../lib/webauthn-origin';

export { isAllowedWebAuthnOrigin } from '../lib/webauthn-origin';

const RP_ID = resolveWebAuthnRpId();
const RP_NAME = process.env.WEBAUTHN_RP_NAME || 'Bridge';

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

function parseOptionalUsername(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true };
  if (typeof value !== 'string') return { ok: false };
  const username = value.trim();
  if (!username || username.length > 64) return { ok: false };
  return { ok: true, value: username };
}

function parseCredentialName(value: unknown): { ok: true; value?: string } | { ok: false } {
  if (value === undefined || value === null || value === '') return { ok: true };
  if (typeof value !== 'string') return { ok: false };
  const name = value.trim();
  if (!name || name.length > 64) return { ok: false };
  return { ok: true, value: name };
}

function validCredentialId(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > 2048 || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const decoded = b64uDecode(value);
    return decoded.length > 0 && decoded.length <= 1024 && b64uEncode(decoded) === value;
  } catch { return false; }
}

function parseTransports(value: unknown): string[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) return null;
  const transports: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string' || !item || item.length > 64) return null;
    transports.push(item);
  }
  return transports;
}

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
 */

// ── KAYIT ─────────────────────────────────────────────────────────────────────

// POST /api/webauthn/register/begin
// Kimlik doğrulanmış kullanıcı için kayıt challenge'ı oluştur
router.post('/register/begin', authMiddleware, requireStepUp('passkey.add'), limits.webauthn(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  // Mevcut credentialler
  const existing = await Auth.findCredentialsByUser(user._id);

  const challenge = randomChallenge();
  const sessionKey = `webauthn:reg:${user._id}`;
  await cache.setAuthoritative(sessionKey, b64uEncode(challenge), 300); // 5 dakika

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
router.post('/register/complete', authMiddleware, requireStepUp('passkey.add'), limits.webauthn(), async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const { credential, name: rawCredName } = (req.body ?? {}) as { credential?: WebAuthnClientCredential; name?: unknown };
  const parsedName = parseCredentialName(rawCredName);
  if (!parsedName.ok) return res.status(400).json({ error: 'Invalid credential name' });
  const credName = parsedName.value;
  if (!credential?.response?.clientDataJSON || !credential?.response?.attestationObject || !validCredentialId(credential.id)) {
    return res.status(400).json({ error: 'Invalid credential response' });
  }
  const transports = parseTransports(credential.response.transports);
  if (transports === null) return res.status(400).json({ error: 'Invalid authenticator transports' });

  // Challenge kontrolü
  const sessionKey = `webauthn:reg:${user._id}`;
  // Replay-sensitive challenge consumption must be atomic. A separate get()+del()
  // allows two concurrent completion requests to observe the same challenge.
  const storedChallenge = await cache.takeAuthoritative<string>(sessionKey);
  if (!storedChallenge) return res.status(400).json({ error: 'Challenge expired. Please try again.' });

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
  if (!isAllowedWebAuthnOrigin(clientData.origin))
    return res.status(400).json({ error: 'Origin mismatch' });
  if (clientData.crossOrigin === true)
    return res.status(400).json({ error: 'Cross-origin WebAuthn ceremonies are not allowed' });

  // attestationObject parse (CBOR)
  // attestationObject = { fmt, attStmt, authData }
  // Minimal CBOR decode — sadece authData'ya ihtiyacımız var
  let authDataBuf: Buffer | null;
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
      let len: number;
      if (info < 24) len = info;
      else if (info === 24) { const next = buf[pos++]; if (next === undefined) throw new Error('Unexpected end of CBOR data'); len = next; }
      else if (info === 25) {
        if (pos + 2 > buf.length) throw new Error('Unexpected end of CBOR data');
        len = buf.readUInt16BE(pos); pos += 2;
      }
      else if (info === 26) {
        if (pos + 4 > buf.length) throw new Error('Unexpected end of CBOR data');
        len = buf.readUInt32BE(pos); pos += 4;
      } else throw new Error(`Unsupported CBOR additional info ${info}`);

      if (major === 0) return len;
      if (major === 1) return -(len + 1);
      if (!Number.isSafeInteger(len) || len < 0 || pos + len > buf.length) throw new Error('Truncated CBOR value');
      if (major === 2) { const v = buf.slice(pos, pos+len); pos += len; return v; }
      if (major === 3) { const v = buf.slice(pos, pos+len).toString(); pos += len; return v; }
      if (major === 5) {
        // CBOR map keys are attacker-controlled.  A normal object would treat
        // `__proto__` as a prototype mutation, and silently accepting duplicate
        // keys lets different decoders disagree about which ceremony field won.
        // Keep the decoded value data-only and deterministic.
        const map = Object.create(null) as Record<string, unknown>;
        for (let i = 0; i < len; i++) {
          const key = String(readCbor(buf));
          if (Object.prototype.hasOwnProperty.call(map, key)) {
            throw new Error(`Duplicate CBOR map key ${key}`);
          }
          map[key] = readCbor(buf);
        }
        return map;
      }
      if (major === 4) {
        const arr: unknown[] = [];
        for (let i = 0; i < len; i++) arr.push(readCbor(buf));
        return arr;
      }
      throw new Error(`CBOR major ${major} info ${info} not supported`);
    }
    const attObj = readCbor(attObjBuf) as { fmt?: unknown; attStmt?: unknown; authData?: Buffer };
    if (pos !== attObjBuf.length) throw new Error('Trailing CBOR data');
    if (attObj?.fmt !== 'none' || !attObj.attStmt || typeof attObj.attStmt !== 'object' ||
        Array.isArray(attObj.attStmt) || Object.keys(attObj.attStmt as Record<string, unknown>).length !== 0) {
      throw new Error('Only none attestation is accepted');
    }
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
  if (credential.id !== credentialIdB64) {
    return res.status(400).json({ error: 'Credential ID does not match authenticator data' });
  }

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
    transports,
    createdAt: Date.now(),
    lastUsedAt: null,
    aaguid: aaguidHex,
  };

  // Canonical PostgreSQL owner only. `users` has no embedded WebAuthn columns.
  // Keep aliases in the in-memory `credDoc` only for protocol compatibility;
  // persist exactly the columns declared by `webauthn_credentials`.
  await Auth.insertCredential({
    _id:            credDoc._id,
    userId:         credDoc.userId,
    credentialId:   credDoc.credentialId,
    publicKey:      credDoc.publicKey,
    counter:        credDoc.counter,
    deviceType:     credDoc.deviceType,
    transports:     credDoc.transports,
    name:           credDoc.name,
    lastUsedAt:     credDoc.lastUsedAt,
    createdAt:      credDoc.createdAt,
  });

  res.json({ ok: true, credentialId: credentialIdB64, name: credDoc.name, deviceType });
});

// ── GİRİŞ ─────────────────────────────────────────────────────────────────────

// POST /api/webauthn/login/begin
// Body: { username } — kullanıcı adıyla başlat, veya boş (discoverable credential)
router.post('/login/begin', limits.webauthn(), async (req: import("express").Request, res: import("express").Response) => {
  const parsedUsername = parseOptionalUsername((req.body as Record<string, unknown> | undefined)?.username);
  if (!parsedUsername.ok) return res.status(400).json({ error: 'Invalid username' });
  const username = parsedUsername.value;

  const challenge  = randomChallenge();
  const sessionKey = `webauthn:auth:${b64uEncode(challenge)}`;

  let allowCredentials: Array<{ type: 'public-key'; id: string; transports: string[] }> = [];
  let userId: string | null = null;

  if (username) {
    const user = await Users.findByUsername(username);
    if (user) {
      userId = user._id;
      const creds = await Auth.findCredentialsByUser(user._id);

      allowCredentials = creds.map(c => ({
        type: 'public-key',
        id: c.credentialId,
        transports: c.transports || [],
      }));
    }
  }

  await cache.setAuthoritative(sessionKey, {
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
router.post('/login/complete', limits.webauthn(), async (req: import("express").Request, res: import("express").Response) => {
  const { credential } = (req.body ?? {}) as { credential?: WebAuthnClientCredential };
  if (!credential?.response?.clientDataJSON || !credential?.response?.authenticatorData || !validCredentialId(credential.id)) {
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

  // FAZ G15 — ORIGIN DENETIMI (onceden TAMAMEN YOKTU).
  if (!isAllowedWebAuthnOrigin(clientData.origin))
    return res.status(400).json({ error: 'Origin mismatch' });
  if (clientData.crossOrigin === true)
    return res.status(400).json({ error: 'Cross-origin WebAuthn ceremonies are not allowed' });

  if (typeof clientData.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(clientData.challenge)) {
    return res.status(400).json({ error: 'Invalid challenge encoding' });
  }

  const sessionKey = `webauthn:auth:${clientData.challenge}`;
  // Single-use login challenge: consume atomically to make concurrent assertion
  // replay impossible across both one process and Redis-backed multi-node deployments.
  const session = await cache.takeAuthoritative<{ challenge?: string; userId?: string | null; expiresAt?: number }>(sessionKey);
  if (!session) return res.status(400).json({ error: 'Challenge expired or not found' });
  if (!Number.isSafeInteger(session.expiresAt) || Number(session.expiresAt) <= Date.now())
    return res.status(400).json({ error: 'Challenge expired or not found' });

  if (clientData.challenge !== session.challenge)
    return res.status(400).json({ error: 'Challenge mismatch' });

  // Credential ara
  const credentialId = credential.id;
  const storedCred = await Auth.findCredential(credentialId) as WebAuthnStoredCredential | null;
  const user = storedCred
    ? await Users.findById(storedCred.userId) as WebAuthnUser | null
    : null;

  if (!storedCred || !user)
    return res.status(401).json({ error: 'Credential not found' });

  // If the ceremony was explicitly started for a username, bind completion to
  // that account. Discoverable (username-less / unknown-user anti-enumeration)
  // ceremonies intentionally keep userId=null and may resolve by credential.
  if (session.userId && storedCred.userId !== session.userId) {
    return res.status(401).json({ error: 'Credential does not belong to requested account' });
  }

  // Authenticator data doğrula
  let authDataBuf: Buffer;
  let parsedAuth: ReturnType<typeof parseAuthenticatorData>;
  try {
    authDataBuf = b64uDecode(credential.response.authenticatorData);
    if (!authDataBuf.length) throw new Error('Missing authData');
    parsedAuth = parseAuthenticatorData(authDataBuf);
  } catch (_err) { const err = _err as Error;
    return res.status(400).json({ error: `Invalid authenticatorData: ${err.message}` });
  }

  if (!parsedAuth.UP) return res.status(400).json({ error: 'User presence required' });
  if (!verifyRpIdHash(parsedAuth.rpIdHash)) return res.status(400).json({ error: 'RP ID mismatch' });

  // Sign count replay attack koruması
  const storedSignCount = storedCred.signCount ?? storedCred.counter ?? 0;
  if ((parsedAuth.signCount !== 0 || storedSignCount !== 0) && parsedAuth.signCount <= storedSignCount) {
    logger.warn({ userId: user._id, event: 'webauthn.cloned_authenticator' }, '[WebAuthn] Possible cloned authenticator');
    return res.status(401).json({ error: 'Sign count replay detected — possible cloned authenticator' });
  }

  // İmza doğrulama (ES256 / RS256)
  let publicKeyJwk: Record<string, unknown>;
  try { publicKeyJwk = JSON.parse(storedCred.publicKey) as Record<string, unknown>; }
  catch { return res.status(401).json({ error: 'Stored credential is invalid' }); }

  // Doğrulanacak veri: authData + SHA256(clientDataJSON)
  const clientDataHash = crypto.createHash('sha256')
    .update(b64uDecode(credential.response.clientDataJSON))
    .digest();
  const signedData = Buffer.concat([authDataBuf, clientDataHash]);
  if (!credential.response.signature) return res.status(400).json({ error: 'Missing signature' });
  let signature: Buffer;
  try { signature = b64uDecode(credential.response.signature); }
  catch { return res.status(400).json({ error: 'Invalid signature encoding' }); }

  let verified = false;
  try {
    if (publicKeyJwk.alg === 'ES256') {
      // ECDSA P-256 doğrulama — Node.js crypto ile
      if (publicKeyJwk.kty !== 'EC' || publicKeyJwk.crv !== 'P-256' ||
          typeof publicKeyJwk.x !== 'string' || typeof publicKeyJwk.y !== 'string') {
        return res.status(401).json({ error: 'Stored credential is invalid' });
      }
      const keyPem = jwkToPem({ x: publicKeyJwk.x, y: publicKeyJwk.y });
      const verify  = crypto.createVerify('SHA256');
      verify.update(signedData);
      verified = verify.verify({ key: keyPem, dsaEncoding: 'der' }, signature);
    } else if (publicKeyJwk.alg === 'RS256') {
      if (publicKeyJwk.kty !== 'RSA' || typeof publicKeyJwk.n !== 'string' || typeof publicKeyJwk.e !== 'string') {
        return res.status(401).json({ error: 'Stored credential is invalid' });
      }
      const keyPem = rsaJwkToPem({ n: publicKeyJwk.n, e: publicKeyJwk.e });
      const verify  = crypto.createVerify('SHA256');
      verify.update(signedData);
      verified = verify.verify(keyPem, signature);
    }
  } catch (_err) { const err = _err as Error;
    logger.error({ err, event: 'webauthn.signature_error' }, '[WebAuthn] Signature verification error');
    return res.status(401).json({ error: 'Signature verification failed' });
  }

  if (!verified) return res.status(401).json({ error: 'Invalid signature' });

  // ── Sign count güncelle ───────────────────────────────────────────────────
  // AYNI KUSUR SINIFI, IKINCI YOL: burada da `signCount` yaziliyordu ama
  // `webauthn_credentials` tablosundaki kolonun adi `counter`. Yani her
  // basarili passkey girisinde sayac yazma denemesi PostgreSQL uzerinde
  // BASARISIZ oluyordu.
  //
  // Bu yalnizca bir yazma hatasi degil: WebAuthn sayaci KLON/TEKRAR
  // tespiti icindir. Hic kalici olmadigi icin o koruma etkisizdi.
  //
  // Tablo yolu kolon adini kullanir; gomulu (JSONB) yol eski `signCount`
  // adini KORUR cunku okuma tarafi (satir 717) `counter ?? signCount`
  // seklinde ikisine de bakar ve mevcut kayitlar eski adi tasiyor.
  if (!storedCred._id) return res.status(401).json({ error: 'Credential identity missing' });
  const counterAdvanced = await Auth.advanceCredentialCounterByDocId(storedCred._id, parsedAuth.signCount, Date.now());
  if (!counterAdvanced) {
    logger.warn({ userId: user._id, event: 'webauthn.counter_race_rejected' }, '[WebAuthn] Counter no longer monotonic');
    return res.status(401).json({ error: 'Sign count replay detected — concurrent or cloned authenticator' });
  }

  // JWT ver — normal login gibi
  const token        = makeToken(user);
  const refreshToken = await makeRefreshToken(user);
  setRefreshCookie(res, refreshToken);
  setMediaCookie(res, user);

  res.json({
    ok: true,
    token,
    user: {
      id:          user._id,
      username:    user.username,
      displayName: user.displayName,
      avatarUrl:   user.avatarUrl,
      avatarColor: user.avatarColor,
    },
    // A verified passkey assertion is a level-2 proof: step-up grants (P7 B2).
    stepUp: mintSignInGrants(user, 'passkey'),
  });
});

// ── YÖNETİM ──────────────────────────────────────────────────────────────────

// GET /api/webauthn/credentials — kullanıcının credential listesi
router.get('/credentials', authMiddleware, async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const creds = await Auth.findCredentialsByUser(_u.id);

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
  const parsedName = parseCredentialName((req.body as Record<string, unknown> | undefined)?.name);
  if (!parsedName.ok || !parsedName.value) return res.status(400).json({ error: 'name required' });
  const name = parsedName.value;

  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cred = await Auth.findCredentialByDocId(String(req.params.id ?? ''), _u.id);
  if (!cred) return res.status(404).json({ error: 'Credential not found' });
  await Auth.updateCredentialByDocId(String(req.params.id ?? ''), { name });

  res.json({ ok: true });
});

// DELETE /api/webauthn/credentials/:id
router.delete('/credentials/:id', authMiddleware, requireStepUp('passkey.remove'), async (req: import("express").Request, res: import("express").Response) => {
  const _u = getAuthedUser(req);
  const user = await Users.findById(_u.id) as WebAuthnUser | null;
  if (!user) return res.status(404).json({ error: 'User not found' });

  const cred = await Auth.findCredentialByDocId(String(req.params.id ?? ''), _u.id);
  if (!cred) return res.status(404).json({ error: 'Credential not found' });
  await Auth.deleteCredential(String(req.params.id ?? ''), _u.id);
  // No denormalized `webauthnEnabled` flag is persisted; enabled state is
  // derived from whether this canonical table contains credentials.

  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
// FAZ G15 — `module.exports = router` ATAMASI adlandirilmis ES export'larini
// EZER. Origin dogrulayicisi guvenlik testlerinden erisilebilir kalmalidir,
// bu yuzden router nesnesine ACIKCA yeniden baglanir.
module.exports.isAllowedWebAuthnOrigin = isAllowedWebAuthnOrigin;
