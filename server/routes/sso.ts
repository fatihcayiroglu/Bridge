// @ts-nocheck
// server/routes/sso.js
// Kurumsal SSO: OIDC (OpenID Connect) ve SAML 2.0 desteği
//
// Harici bağımlılık YOK — sadece standart node http(s) + jwt + uuid kullanır.
//
// OIDC Akışı:
//   1. GET  /api/sso/oidc/start       → IdP'ye redirect (code flow)
//   2. GET  /api/sso/oidc/callback    → code'u token ile değiştir, kullanıcı oluştur/güncelle
//
// SAML 2.0 Akışı:
//   1. GET  /api/sso/saml/metadata    → SP metadata XML (IdP'ye yükle)
//   2. GET  /api/sso/saml/start       → IdP'ye AuthnRequest ile redirect
//   3. POST /api/sso/saml/callback    → SAMLResponse parse, kullanıcı oluştur/güncelle
//
// Kurulum: server tablosuna ssoConfig JSON kolonu eklendi (v70 migration'da)

'use strict';

interface HttpOpts {
  method?:  string;
  headers?: Record<string, string>;
  body?:    string;
}

const express      = require('express');
const router       = express.Router();
const https        = require('https');
const http         = require('http');
const crypto       = require('crypto');
const { v4: uuidv4 } = require('uuid');
const jwt          = require('jsonwebtoken');
const { Users, Servers, Auth } = require('../db/repositories');

const REFRESH_MS = 30 * 24 * 60 * 60 * 1000;
const { authMiddleware, castAuthed } = require('../middleware/auth');
const asyncHandler = require('../middleware/asyncHandler');

const JWT_SECRET     = process.env.JWT_SECRET     || 'bridge-secret';
const REFRESH_SECRET = process.env.REFRESH_SECRET || 'bridge-refresh';
const BASE_URL       = process.env.BASE_URL        || 'http://localhost:3001';

// ── Yardımcılar ────────────────────────────────────────────────
function fetchJSON(url, opts: HttpOpts = {}) {
  return new Promise((resolve, reject) => {
    const parsed  = new URL(url);
    const lib     = parsed.protocol === 'https:' ? https : http;
    const options = { hostname: parsed.hostname, port: parsed.port, path: parsed.pathname + parsed.search, method: opts.method || 'GET', headers: opts.headers || {} };
    const req = lib.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch { resolve(data); }
      });
    });
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// JWT'den base64url payload parse
function parseJWTPayload(token) {
  const parts = token.split('.');
  if (parts.length < 2) throw new Error('Invalid JWT');
  return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
}

// Kullanıcı bul veya oluştur (SSO)
async function findOrCreateSSOUser(email, displayName, provider, externalId) {
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
      avatarColor:   `#${Math.floor(Math.random()*16777215).toString(16).padStart(6,'0')}`,
      createdAt:     Date.now(),
    });
  } else if (!user.ssoProvider) {
    await Users.update(user._id, { ssoProvider: provider, ssoId: externalId });
  }
  return user;
}

// JWT token çifti üret
function issueTokens(user) {
  const accessToken  = jwt.sign({ id: user._id, email: user.email }, JWT_SECRET, { expiresIn: '15m' });
  const refreshToken = jwt.sign({ id: user._id }, REFRESH_SECRET, { expiresIn: '30d' });
  return { accessToken, refreshToken };
}

// ── SSO Config yardımcıları ────────────────────────────────────
async function getServerSSOConfig(serverId) {
  if (!serverId) return null;
  const server = await Servers.findById(serverId);
  if (!server?.ssoConfig) return null;
  try { return typeof server.ssoConfig === 'string' ? JSON.parse(server.ssoConfig) : server.ssoConfig; } catch { return null; }
}

async function requireServerOwner(req, res, next) {
  const server = await Servers.findById(req.params.serverId);
  if (!server) return res.status(404).json({ error: 'Server not found' });
  if (!req.user?.id) return res.status(401).json({ error: 'Unauthorized' });
  if (server.ownerId !== req.user.id) return res.status(403).json({ error: 'Forbidden' });
  req.server = server;
  next();
}

// Sistem geneli SSO config (.env tabanlı)
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
      enabled:     process.env.SAML_ENABLED === 'true',
      entryPoint:  process.env.SAML_ENTRY_POINT,
      issuer:      process.env.SAML_ISSUER || `${BASE_URL}/api/sso/saml/metadata`,
      cert:        process.env.SAML_CERT,
    },
  };
}

// ── OIDC ───────────────────────────────────────────────────────

// GET /api/sso/oidc/start?state=...
router.get('/oidc/start', asyncHandler(async (req, res) => {
  const cfg = getSystemSSOConfig().oidc;
  if (!cfg.enabled || !cfg.issuer || !cfg.clientId) {
    return res.status(503).json({ error: 'OIDC SSO is not configured' });
  }

  // OIDC discovery endpoint
  let discovery;
  try {
    discovery = await fetchJSON(`${cfg.issuer}/.well-known/openid-configuration`);
  } catch {
    return res.status(503).json({ error: 'OIDC discovery failed' });
  }

  const state = String(req.query.state ?? '') || uuidv4();
  const nonce = uuidv4();
  const params = new URLSearchParams({
    response_type: 'code',
    client_id:     cfg.clientId ?? "",
    redirect_uri:  cfg.redirectUri,
    scope:         cfg.scopes.join(' '),
    state,
    nonce,
  });

  res.redirect(`${discovery.authorization_endpoint}?${params}`);
}));

// GET /api/sso/oidc/callback?code=...&state=...
router.get('/oidc/callback', asyncHandler(async (req, res) => {
  const cfg = getSystemSSOConfig().oidc;
  if (!cfg.enabled) return res.status(503).json({ error: 'OIDC is disabled' });

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'Missing authorization code' });

  let discovery;
  try {
    discovery = await fetchJSON(`${cfg.issuer}/.well-known/openid-configuration`);
  } catch {
    return res.status(503).json({ error: 'OIDC discovery failed' });
  }

  // Code → Token exchange
  const body = new URLSearchParams({
    grant_type:   'authorization_code',
    code,
    redirect_uri:  cfg.redirectUri,
    client_id:     cfg.clientId ?? "",
    client_secret: cfg.clientSecret ?? "",
  }).toString();

  let tokenResp;
  try {
    tokenResp = await fetchJSON(discovery.token_endpoint, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
  } catch {
    return res.status(502).json({ error: 'Token endpoint is unreachable' });
  }

  if (!tokenResp.id_token) {
    return res.status(401).json({ error: 'id_token was not returned', detail: tokenResp });
  }

  // id_token parse (imza doğrulama production'da jwks_uri ile yapılmalı)
  let claims;
  try { claims = parseJWTPayload(tokenResp.id_token); } catch {
    return res.status(401).json({ error: 'id_token is invalid' });
  }

  const email       = claims.email;
  const displayName = claims.name || claims.preferred_username || email;
  const externalId  = claims.sub;

  if (!email) return res.status(400).json({ error: 'Email claim is missing' });

  const user   = await findOrCreateSSOUser(email, displayName, 'oidc', externalId);
  const tokens = issueTokens(user);

  // Refresh token kaydet
  await Auth.insertRefreshToken(user._id, tokens.refreshToken, Date.now() + REFRESH_MS);

  // Client'a redirect — token query param ile (production'da cookie kullanılmalı)
  res.redirect(`${BASE_URL}/sso-callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`);
}));

// ── SAML 2.0 ──────────────────────────────────────────────────

// GET /api/sso/saml/metadata — SP metadata XML
router.get('/saml/metadata', (req, res) => {
  const cfg     = getSystemSSOConfig().saml;
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

// GET /api/sso/saml/start — IdP'ye redirect
router.get('/saml/start', asyncHandler(async (req, res) => {
  const cfg = getSystemSSOConfig().saml;
  if (!cfg.enabled || !cfg.entryPoint) {
    return res.status(503).json({ error: 'SAML SSO is not configured' });
  }

  const spIssuer = cfg.issuer;
  const acsUrl   = `${BASE_URL}/api/sso/saml/callback`;
  const id       = '_' + uuidv4().replace(/-/g, '');
  const now      = new Date().toISOString();

  // Base64 AuthnRequest
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

  const encoded = Buffer.from(authnReq).toString('base64');
  const relayState = String(req.query.relayState ?? '') || '';
  const params = new URLSearchParams({ SAMLRequest: encoded });
  if (relayState) params.set('RelayState', relayState);

  res.redirect(`${cfg.entryPoint}?${params}`);
}));

// POST /api/sso/saml/callback — SAMLResponse işle
router.post('/saml/callback', express.urlencoded({ extended: false }), asyncHandler(async (req, res) => {
  const { SAMLResponse } = req.body;
  if (!SAMLResponse) return res.status(400).json({ error: 'Missing SAMLResponse' });

  let xml;
  try {
    xml = Buffer.from(SAMLResponse, 'base64').toString('utf8');
  } catch {
    return res.status(400).json({ error: 'SAMLResponse is not valid base64' });
  }

  // Basit XML parse — production'da xmldom + xml-crypto kullanın
  const emailMatch = xml.match(/<(?:[^:>]+:)?Attribute[^>]+Name="(?:email|Email|emailAddress|mail)"[^>]*>[\s\S]*?<(?:[^:>]+:)?AttributeValue[^>]*>(.*?)<\/(?:[^:>]+:)?AttributeValue>/i)
                  || xml.match(/<(?:[^:>]+:)?NameID[^>]*>(.*?)<\/(?:[^:>]+:)?NameID>/i);

  const nameMatch = xml.match(/<(?:[^:>]+:)?Attribute[^>]+Name="(?:displayName|name|cn|fullName)"[^>]*>[\s\S]*?<(?:[^:>]+:)?AttributeValue[^>]*>(.*?)<\/(?:[^:>]+:)?AttributeValue>/i);
  const idMatch   = xml.match(/SubjectConfirmationData[^>]+InResponseTo="([^"]+)"/i)
                 || xml.match(/<(?:[^:>]+:)?NameID[^>]*>(.*?)<\/(?:[^:>]+:)?NameID>/i);

  if (!emailMatch?.[1]) {
    return res.status(400).json({ error: 'Email attribute not found in SAML response' });
  }

  const email       = emailMatch[1].trim();
  const displayName = nameMatch?.[1]?.trim() || email.split('@')[0];
  const externalId  = idMatch?.[1]?.trim() || email;

  const user   = await findOrCreateSSOUser(email, displayName, 'saml', externalId);
  const tokens = issueTokens(user);

  await Auth.insertRefreshToken(user._id, tokens.refreshToken, Date.now() + REFRESH_MS);

  res.redirect(`${BASE_URL}/sso-callback?accessToken=${tokens.accessToken}&refreshToken=${tokens.refreshToken}`);
}));

// ── Admin: SSO Config endpoints ────────────────────────────────

// GET /api/sso/config — sistem SSO durumunu göster (admin)
router.get('/config', authMiddleware, asyncHandler(async (req, res) => {
  const _u = castAuthed(req).user;
  const user = await Users.findById(_u.id);
  if (!user?.isAdmin) return res.status(403).json({ error: 'Admin only' });

  const cfg = getSystemSSOConfig();
  res.json({
    oidc: { enabled: cfg.oidc.enabled, issuer: cfg.oidc.issuer, clientId: cfg.oidc.clientId },
    saml: { enabled: cfg.saml.enabled, entryPoint: cfg.saml.entryPoint, issuer: cfg.saml.issuer },
    metadataUrl: `${BASE_URL}/api/sso/saml/metadata`,
    oidcStartUrl: `${BASE_URL}/api/sso/oidc/start`,
    samlStartUrl: `${BASE_URL}/api/sso/saml/start`,
  });
}));

// PUT /api/sso/servers/:serverId/config — sunucuya özel SSO config (gelecek)
router.put('/servers/:serverId/config', authMiddleware, requireServerOwner, asyncHandler(async (req, res) => {
  const { ssoConfig } = req.body;
  await Servers.update(req.params.serverId, { ssoConfig: JSON.stringify(ssoConfig) });
  res.json({ ok: true });
}));

module.exports = router;
export {};
