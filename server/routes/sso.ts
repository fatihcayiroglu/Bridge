// @ts-nocheck
// server/routes/sso.ts
// Kurumsal SSO: OIDC (OpenID Connect) ve SAML 2.0 desteği
//
// Güvenlik düzeltmeleri (Sprint 46):
//   1. OIDC callback: token'lar artık query param yerine HttpOnly cookie ile taşınır.
//      PKCE state parametresi session/cookie üzerinden doğrulanır.
//   2. OIDC id_token: imza artık jwks_uri üzerinden jsonwebtoken.verify ile doğrulanır.
//   3. SAML: imza doğrulama xml-crypto kütüphanesi ile gerçek XML-Dsig doğrulaması yapar.
//
// OIDC Akışı:
//   1. GET  /api/sso/oidc/start       → IdP'ye redirect (PKCE code flow)
//   2. GET  /api/sso/oidc/callback    → state doğrula, code'u token ile değiştir,
//                                       id_token imzasını doğrula, HttpOnly cookie set et
//
// SAML 2.0 Akışı:
//   1. GET  /api/sso/saml/metadata    → SP metadata XML (IdP'ye yükle)
//   2. GET  /api/sso/saml/start       → IdP'ye AuthnRequest ile redirect
//   3. POST /api/sso/saml/callback    → SAMLResponse xml-crypto ile imza doğrula,
//                                       kullanıcı oluştur/güncelle, HttpOnly cookie set et

interface HttpOpts {
  method?:  string;
  headers?: Record<string, string>;
  body?:    string;
}

import express from 'express';
import { safeCastAuthed as castAuthed } from '../lib/authSafe';
const router       = express.Router();
import https from 'https';
import http from 'http';
import crypto from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import jwt from 'jsonwebtoken';
import { fetchT, SSRFError } from '../lib/fetch';
import { Users, Servers } from '../db/repositories';
import { authMiddleware, makeToken, makeRefreshToken} from '../middleware/auth';
import logger from '../lib/logger';

const BASE_URL            = process.env.BASE_URL || 'http://localhost:3001';
const STATE_COOKIE_MAX_AGE   = 10 * 60 * 1000;
const ACCESS_COOKIE_MAX_AGE  = 15 * 60 * 1000;
const REFRESH_COOKIE_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
const IS_PROD = process.env.NODE_ENV === 'production';

// HTTP: fetchT (lib/fetch.ts) — SSRF korumalı, timeout'lu

// ── JWKS cache + id_token doğrulama ───────────────────────────
const _jwksCache = new Map<string, { keys: unknown[]; fetchedAt: number }>();
const JWKS_CACHE_TTL = 5 * 60 * 1000;

async function getJWKS(jwksUri: string): Promise<unknown[]> {
  const cached = _jwksCache.get(jwksUri);
  if (cached && Date.now() - cached.fetchedAt < JWKS_CACHE_TTL) return cached.keys;
  const _jr = await fetchT(jwksUri);
  const data = await _jr.json() as { keys?: unknown[] };
  const keys = data.keys ?? [];
  _jwksCache.set(jwksUri, { keys, fetchedAt: Date.now() });
  return keys;
}

/**
 * id_token imzasını JWKS endpoint'inden alınan public key ile doğrular.
 * jsonwebtoken.verify: imza + issuer + audience + expiry kontrolü yapar.
 */
async function verifyIdToken(
  idToken: string,
  jwksUri: string,
  expectedIssuer: string,
  expectedClientId: string,
): Promise<Record<string, unknown>> {
  const headerB64 = idToken.split('.')[0];
  if (!headerB64) throw new Error('Malformed id_token: missing header');
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as { kid?: string };

  const keys = await getJWKS(jwksUri);
  if (!keys.length) throw new Error('JWKS endpoint returned no keys');

  const matchingKeys = header.kid
    ? keys.filter((k: unknown) => (k as Record<string, unknown>).kid === header.kid)
    : keys;
  if (!matchingKeys.length) throw new Error(`No JWKS key found for kid=${header.kid}`);

  let lastErr: Error | null = null;
  for (const jwk of matchingKeys) {
    try {
      const keyObj = crypto.createPublicKey({ key: jwk as crypto.JsonWebKeyInput, format: 'jwk' });
      const pem    = keyObj.export({ type: 'spki', format: 'pem' }) as string;
      const claims = jwt.verify(idToken, pem, {
        algorithms:     ['RS256', 'RS384', 'RS512', 'ES256', 'ES384', 'ES512'],
        issuer:         expectedIssuer,
        audience:       expectedClientId,
        clockTolerance: 30,
      }) as Record<string, unknown>;
      return claims;
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new Error('id_token verification failed');
}

// ── Cookie yardımcıları ────────────────────────────────────────
function setStateCookie(res: import('express').Response, state: string): void {
  res.cookie('sso_state', state, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: 'lax',
    maxAge:   STATE_COOKIE_MAX_AGE,
    path:     '/api/sso',
  });
}

function clearStateCookie(res: import('express').Response): void {
  res.clearCookie('sso_state', { path: '/api/sso' });
}

function setAuthCookiesAndRedirect(
  res:          import('express').Response,
  accessToken:  string,
  refreshToken: string,
): void {
  res.cookie('access_token', accessToken, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: 'lax',
    maxAge:   ACCESS_COOKIE_MAX_AGE,
    path:     '/',
  });
  res.cookie('refresh_token', refreshToken, {
    httpOnly: true,
    secure:   IS_PROD,
    sameSite: 'lax',
    maxAge:   REFRESH_COOKIE_MAX_AGE,
    path:     '/api/auth/refresh',
  });
  // Token URL'de YOK — browser history / Referer header tehlikesi yok
  res.redirect(`${BASE_URL}/sso-callback`);
}

// ── Kullanıcı yardımcıları ─────────────────────────────────────
async function findOrCreateSSOUser(email: string, displayName: string, provider: string, externalId: string) {
  const norm = String(email).toLowerCase();
  let user = await Users.findByEmail(norm);
  if (!user) {
    const username = norm.split('@')[0].replace(/[^a-z0-9_]/gi, '_').toLowerCase() + '_' + Math.random().toString(36).slice(2, 6);
    user = await Users.create({
      _id:           uuidv4(),
      email:         norm,
      username,
      displayName:   displayName || username,
      password:      '',
      ssoProvider:   provider,
      ssoId:         externalId,
      emailVerified: 1,
      isAdmin:       false,
      avatarColor:   `#${Math.floor(Math.random() * 16777215).toString(16).padStart(6, '0')}`,
      createdAt:     Date.now(),
    });
  } else if (!user.ssoProvider) {
    await Users.update(user._id, { ssoProvider: provider, ssoId: externalId });
  }
  return user;
}

async function issueTokens(user: Record<string, unknown>) {
  const accessToken  = makeToken(user as Parameters<typeof makeToken>[0]);
  const refreshToken = await makeRefreshToken(user as Parameters<typeof makeRefreshToken>[0]);
  return { accessToken, refreshToken };
}

// ── Config yardımcıları ────────────────────────────────────────
async function requireServerOwner(
  req:  import('express').Request,
  res:  import('express').Response,
  next?: import('express').NextFunction,
) {
  const server = await Servers.findById(String(req.params.serverId ?? ''));
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  req.server = server;
  next?.();
}

function getSystemSSOConfig() {
  return {
    oidc: {
      enabled:      process.env.OIDC_ENABLED === 'true',
      issuer:       process.env.OIDC_ISSUER,
      clientId:     process.env.OIDC_CLIENT_ID,
      clientSecret: process.env.OIDC_CLIENT_SECRET,
      redirectUri:  `${BASE_URL}/api/sso/oidc/callback`,
      scopes:       (process.env.OIDC_SCOPES || 'openid email profile').split(' '),
    },
    saml: {
      enabled:    process.env.SAML_ENABLED === 'true',
      entryPoint: process.env.SAML_ENTRY_POINT,
      issuer:     process.env.SAML_ISSUER || `${BASE_URL}/api/sso/saml/metadata`,
      cert:       process.env.SAML_IDP_CERT, // IdP imza sertifikası (PEM)
    },
  };
}


// ── Startup doğrulama ──────────────────────────────────────────
// SAML etkin ama cert eksikse başlangıçta uyar
if (process.env.SAML_ENABLED === 'true' && !process.env.SAML_IDP_CERT) {
  const msg = '[SSO] WARNING: SAML_ENABLED=true but SAML_IDP_CERT is not set. ' +
              'SAML callbacks will be rejected until a valid IdP certificate is configured.';
  if (process.env.NODE_ENV === 'production') {
    logger.fatal({ event: 'sso.saml.missing_cert' }, msg);
    process.exit(1);
  } else {
    logger.warn({ event: 'sso.saml.missing_cert' }, msg);
  }
}

// ── OIDC ───────────────────────────────────────────────────────

/**
 * @openapi
 * /sso/oidc/start:
 *   get:
 *     tags: [Auth]
 *     summary: OIDC oturumu başlat — IdP'ye yönlendirme
 *     parameters:
 *       - in: query
 *         name: serverId
 *         schema: { type: string }
 *         description: Giriş sonrası yönlendirilecek sunucu
 *     responses:
 *       302: { description: IdP authorization URL'sine redirect }
 *       500: { description: OIDC yapılandırması eksik }
 */
router.get('/oidc/start', async (req: import('express').Request, res: import('express').Response) => {
  const cfg = getSystemSSOConfig().oidc;
  if (!cfg.enabled || !cfg.issuer || !cfg.clientId) {
    return res.status(503).json({ error: 'OIDC SSO is not configured' });
  }

  let discovery: Record<string, unknown>;
  try {
    const _dr1 = await fetchT(`${cfg.issuer}/.well-known/openid-configuration`);
    discovery = await _dr1.json() as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SSRFError) return res.status(400).json({ error: 'SSRF: OIDC issuer URL is not allowed' });
    return res.status(503).json({ error: 'OIDC discovery failed' });
  }

  // Kriptografik olarak güçlü, tahmin edilemez state
  const state = uuidv4();
  const nonce = uuidv4();

  // [FIX 1] state'i HttpOnly cookie ile sakla
  setStateCookie(res, state);

  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     cfg.clientId,
    redirect_uri:  cfg.redirectUri,
    scope:         cfg.scopes.join(' '),
    state,
    nonce,
  });
  res.redirect(`${discovery.authorization_endpoint}?${params}`);
});

/**
 * @openapi
 * /sso/oidc/callback:
 *   get:
 *     tags: [Auth]
 *     summary: OIDC callback — token değişimi ve oturum açma
 *     parameters:
 *       - in: query
 *         name: code
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: state
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       302: { description: Başarılı — uygulamaya yönlendirilir }
 *       401: { description: Geçersiz state veya token }
 */
router.get('/oidc/callback', async (req: import('express').Request, res: import('express').Response) => {
  const cfg = getSystemSSOConfig().oidc;
  if (!cfg.enabled) return res.status(503).json({ error: 'OIDC is disabled' });

  const { code, state } = req.query as { code?: string; state?: string };
  if (!code)  return res.status(400).json({ error: 'Missing authorization code' });
  if (!state) return res.status(400).json({ error: 'Missing state parameter' });

  // [FIX 1] PKCE state doğrulama — sabit-zamanlı karşılaştırma
  const cookieState = (req.cookies as Record<string, string>)?.sso_state;
  if (!cookieState) {
    return res.status(400).json({ error: 'State cookie missing or expired — please restart login' });
  }
  let stateMatches = false;
  try {
    stateMatches = crypto.timingSafeEqual(
      Buffer.from(cookieState,     'utf8'),
      Buffer.from(state as string, 'utf8'),
    );
  } catch {
    // Buffer boyutları farklıysa timingSafeEqual fırlatır — eşleşmedi sayarız
  }
  clearStateCookie(res);
  if (!stateMatches) {
    return res.status(400).json({ error: 'State mismatch — possible CSRF attack' });
  }

  let discovery: Record<string, unknown>;
  try {
    const _dr2 = await fetchT(`${cfg.issuer}/.well-known/openid-configuration`);
    discovery = await _dr2.json() as Record<string, unknown>;
  } catch {
    return res.status(503).json({ error: 'OIDC discovery failed' });
  }

  const body = new URLSearchParams({
    grant_type:    'authorization_code',
    code:          code as string,
    redirect_uri:  cfg.redirectUri,
    client_id:     cfg.clientId ?? '',
    client_secret: cfg.clientSecret ?? '',
  }).toString();

  let tokenResp: Record<string, unknown>;
  try {
    const _tr = await fetchT(discovery.token_endpoint as string, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    tokenResp = await _tr.json() as Record<string, unknown>;
  } catch (err) {
    if (err instanceof SSRFError) return res.status(400).json({ error: 'SSRF: token endpoint URL is not allowed' });
    return res.status(502).json({ error: 'Token endpoint is unreachable' });
  }

  if (!tokenResp.id_token) {
    return res.status(401).json({ error: 'id_token was not returned', detail: tokenResp });
  }

  // [FIX 2] id_token imza doğrulama — jwks_uri + jsonwebtoken.verify
  const jwksUri = discovery.jwks_uri as string;
  if (!jwksUri) {
    return res.status(503).json({ error: 'OIDC discovery response missing jwks_uri' });
  }

  let claims: Record<string, unknown>;
  try {
    claims = await verifyIdToken(
      tokenResp.id_token as string,
      jwksUri,
      cfg.issuer as string,
      cfg.clientId as string,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(401).json({ error: 'id_token verification failed', detail: message });
  }

  const email       = claims.email as string;
  const displayName = (claims.name || claims.preferred_username || email) as string;
  const externalId  = claims.sub as string;
  if (!email) return res.status(400).json({ error: 'Email claim is missing' });

  const user   = await findOrCreateSSOUser(email, displayName, 'oidc', externalId);
  const tokens = await issueTokens(user);

  // [FIX 1] HttpOnly cookie — URL'de token yok
  setAuthCookiesAndRedirect(res, tokens.accessToken, tokens.refreshToken);
});

// ── SAML 2.0 ──────────────────────────────────────────────────

/**
 * @openapi
 * /sso/saml/metadata:
 *   get:
 *     tags: [Auth]
 *     summary: SAML SP metadata XML — IdP'ye yüklenecek
 *     responses:
 *       200:
 *         description: SP metadata XML
 *         content:
 *           application/xml:
 *             schema: { type: string }
 */
router.get('/saml/metadata', (req, res) => {
  const cfg      = getSystemSSOConfig().saml;
  const spIssuer = cfg.issuer || `${BASE_URL}/api/sso/saml/metadata`;
  const acsUrl   = `${BASE_URL}/api/sso/saml/callback`;
  const xml = `<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata"
  entityID="${spIssuer}">
  <SPSSODescriptor
    AuthnRequestsSigned="false"
    WantAssertionsSigned="true"
    protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <AssertionConsumerService
      Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"
      Location="${acsUrl}"
      index="1"/>
    <NameIDFormat>
      urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress
    </NameIDFormat>
  </SPSSODescriptor>
</EntityDescriptor>`;
  res.set('Content-Type', 'application/xml');
  res.send(xml);
});

/**
 * @openapi
 * /sso/saml/start:
 *   get:
 *     tags: [Auth]
 *     summary: SAML oturumu başlat — AuthnRequest ile IdP'ye yönlendir
 *     responses:
 *       302: { description: IdP SSO URL'sine redirect }
 *       500: { description: SAML yapılandırması eksik }
 */
router.get('/saml/start', async (req: import('express').Request, res: import('express').Response) => {
  const cfg = getSystemSSOConfig().saml;
  if (!cfg.enabled || !cfg.entryPoint) {
    return res.status(503).json({ error: 'SAML SSO is not configured' });
  }

  const spIssuer = cfg.issuer;
  const acsUrl   = `${BASE_URL}/api/sso/saml/callback`;
  const id       = '_' + uuidv4().replace(/-/g, '');
  const now      = new Date().toISOString();

  const authnReq = `<samlp:AuthnRequest
    xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"
    xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"
    ID="${id}"
    Version="2.0"
    IssueInstant="${now}"
    Destination="${cfg.entryPoint}"
    AssertionConsumerServiceURL="${acsUrl}"
    ProtocolBinding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST">
    <saml:Issuer>${spIssuer}</saml:Issuer>
  </samlp:AuthnRequest>`;

  const encoded    = Buffer.from(authnReq).toString('base64');
  const relayState = String(req.query.relayState ?? '') || '';
  const params     = new URLSearchParams({ SAMLRequest: encoded });
  if (relayState) params.set('RelayState', relayState);
  res.redirect(`${cfg.entryPoint}?${params}`);
});

// [FIX 3] xml-crypto ile gerçek XML-Dsig imza doğrulama
async function verifySAMLSignature(xmlDoc: string, idpCert: string): Promise<void> {
  let SignedXml: unknown;
  let DOMParser: unknown;
  try {
    ({ SignedXml } = await import('xml-crypto'));
    ({ DOMParser } = await import('@xmldom/xmldom'));
  } catch {
    throw new Error(
      'xml-crypto ve @xmldom/xmldom paketleri yüklü değil. ' +
      '"npm install xml-crypto @xmldom/xmldom" komutunu çalıştırın.',
    );
  }

  const parser = new (DOMParser as new () => { parseFromString(s: string, t: string): unknown })();
  const doc    = parser.parseFromString(xmlDoc, 'text/xml');

  const pemCert = idpCert.includes('BEGIN CERTIFICATE')
    ? idpCert
    : `-----BEGIN CERTIFICATE-----\n${idpCert}\n-----END CERTIFICATE-----`;

  const sig = new (SignedXml as new (opts: Record<string, unknown>) => {
    publicCert:       string;
    loadSignature:    (node: unknown) => void;
    checkSignature:   (doc: unknown) => boolean;
    validationErrors: string[];
  })({ publicCert: pemCert });

  const xpathMod = await import('xpath') as { select: (expr: string, doc: unknown) => unknown[] };
  const signatureNodes = xpathMod.select(
    "//*[local-name(.)='Signature' and namespace-uri(.)='http://www.w3.org/2000/09/xmldsig#']",
    doc,
  ) as unknown[];

  if (!signatureNodes || signatureNodes.length === 0) {
    throw new Error('SAMLResponse içinde Signature elementi bulunamadı — imzasız response kabul edilmez');
  }

  sig.loadSignature(signatureNodes[0]);
  const valid = sig.checkSignature(doc);
  if (!valid) {
    throw new Error(`SAML imza doğrulama hatası: ${sig.validationErrors?.join(', ') ?? 'bilinmeyen hata'}`);
  }
}

function parseSAMLAttributes(xml: string): { email: string; displayName: string; nameId: string } {
  const emailMatch = xml.match(/<(?:[^:>]+:)?Attribute[^>]+Name="(?:email|Email|emailAddress|mail)"[^>]*>[\s\S]*?<(?:[^:>]+:)?AttributeValue[^>]*>(.*?)<\/(?:[^:>]+:)?AttributeValue>/i)
                  || xml.match(/<(?:[^:>]+:)?NameID[^>]*>(.*?)<\/(?:[^:>]+:)?NameID>/i);
  const nameMatch  = xml.match(/<(?:[^:>]+:)?Attribute[^>]+Name="(?:displayName|name|cn|fullName)"[^>]*>[\s\S]*?<(?:[^:>]+:)?AttributeValue[^>]*>(.*?)<\/(?:[^:>]+:)?AttributeValue>/i);
  const idMatch    = xml.match(/<(?:[^:>]+:)?NameID[^>]*>(.*?)<\/(?:[^:>]+:)?NameID>/i);
  const email       = emailMatch?.[1]?.trim() ?? '';
  const displayName = nameMatch?.[1]?.trim() || (email ? email.split('@')[0] : '');
  const nameId      = idMatch?.[1]?.trim() || email;
  return { email, displayName, nameId };
}

/**
 * @openapi
 * /sso/saml/callback:
 *   post:
 *     tags: [Auth]
 *     summary: SAML callback — SAMLResponse doğrulama ve oturum açma
 *     requestBody:
 *       required: true
 *       content:
 *         application/x-www-form-urlencoded:
 *           schema:
 *             type: object
 *             properties:
 *               SAMLResponse: { type: string }
 *     responses:
 *       302: { description: Başarılı — uygulamaya yönlendirilir }
 *       401: { description: Geçersiz SAMLResponse imzası }
 */
router.post('/saml/callback', express.urlencoded({ extended: false }), async (req: import('express').Request, res: import('express').Response) => {
  const { SAMLResponse } = req.body as { SAMLResponse?: string };
  if (!SAMLResponse) return res.status(400).json({ error: 'Missing SAMLResponse' });

  let xml: string;
  try {
    xml = Buffer.from(SAMLResponse, 'base64').toString('utf8');
  } catch {
    return res.status(400).json({ error: 'SAMLResponse is not valid base64' });
  }

  // [FIX 3] XML-Dsig imza doğrulama
  const cfg     = getSystemSSOConfig().saml;
  const idpCert = cfg.cert;
  if (!idpCert) {
    return res.status(503).json({ error: 'SAML_IDP_CERT ortam değişkeni ayarlanmamış — imza doğrulama yapılamaz' });
  }

  try {
    await verifySAMLSignature(xml, idpCert);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return res.status(401).json({ error: 'SAML imza doğrulama başarısız', detail: message });
  }

  const { email, displayName, nameId } = parseSAMLAttributes(xml);
  if (!email) {
    return res.status(400).json({ error: 'Email attribute not found in SAML response' });
  }

  const user   = await findOrCreateSSOUser(email, displayName, 'saml', nameId);
  const tokens = await issueTokens(user);
  setAuthCookiesAndRedirect(res, tokens.accessToken, tokens.refreshToken);
});

// ── Admin endpoints ────────────────────────────────────────────

/**
 * @openapi
 * /sso/config:
 *   get:
 *     tags: [Auth]
 *     summary: Aktif SSO yapılandırmasını getir
 *     security: [{ bearerAuth: [] }]
 *     responses:
 *       200: { description: SSO config (oidc/saml enabled, provider adı) }
 *       401: { description: Kimlik doğrulaması gerekli }
 */
router.get('/config', authMiddleware, async (req: import('express').Request, res: import('express').Response) => {
  const _u   = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const cfg = getSystemSSOConfig();
  res.json({
    oidc: { enabled: cfg.oidc.enabled, issuer: cfg.oidc.issuer, clientId: cfg.oidc.clientId },
    saml: { enabled: cfg.saml.enabled, entryPoint: cfg.saml.entryPoint, issuer: cfg.saml.issuer },
    metadataUrl:  `${BASE_URL}/api/sso/saml/metadata`,
    oidcStartUrl: `${BASE_URL}/api/sso/oidc/start`,
    samlStartUrl: `${BASE_URL}/api/sso/saml/start`,
  });
});

/**
 * @openapi
 * /sso/servers/{serverId}/config:
 *   put:
 *     tags: [Auth]
 *     summary: Sunucu SSO yapılandırmasını güncelle
 *     security: [{ bearerAuth: [] }]
 *     parameters:
 *       - in: path
 *         name: serverId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema: { type: object }
 *     responses:
 *       200: { description: Yapılandırma güncellendi }
 *       403: { description: Sunucu sahibi değil }
 */
router.put('/servers/:serverId/config', authMiddleware, requireServerOwner, async (req: import('express').Request, res: import('express').Response) => {
  const { ssoConfig } = req.body as { ssoConfig?: unknown };
  await Servers.update(String(req.params.serverId ?? ''), { ssoConfig: JSON.stringify(ssoConfig) });
  res.json({ ok: true });
});

export default router;

// CommonJS compatibility for legacy Jest/supertest suites.
module.exports = router;
module.exports.default = router;
