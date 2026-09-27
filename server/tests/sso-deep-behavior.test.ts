process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-padded!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-32-chars-pad!';

const mockFetchT = jest.fn();
class MockSSRFError extends Error {
  hostname: string;
  constructor(message = 'blocked', hostname = 'blocked.test') {
    super(message); this.name = 'SSRFError'; this.hostname = hostname;
  }
}

const mockUsers = {
  findByEmail: jest.fn(), findBySsoIdentity: jest.fn(), findLegacySsoIdentity: jest.fn(),
  claimSsoIdentity: jest.fn(), upgradeLegacySsoIdentity: jest.fn(),
  create: jest.fn(), update: jest.fn(), findById: jest.fn(),
};
const mockServers = { findById: jest.fn(), update: jest.fn() };
const mockMakeToken = jest.fn((_user?: unknown) => 'access-token-that-is-deliberately-long-enough-for-validation');
const mockMakeRefreshToken = jest.fn(async (_user?: unknown) => 'refresh-token');
const mockRevokeRefreshToken = jest.fn(async (_token?: string) => undefined);

jest.mock('../lib/fetch', () => ({
  fetchT: (...args: unknown[]) => mockFetchT(...args),
  SSRFError: MockSSRFError,
}));
jest.mock('../db/repositories', () => ({ Users: mockUsers, Servers: mockServers }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    req.user = { id: String(id), username: String(id) };
    return next();
  },
  makeToken: (user: unknown) => mockMakeToken(user),
  makeRefreshToken: (user: unknown) => mockMakeRefreshToken(user),
  revokeRefreshToken: (token: string) => mockRevokeRefreshToken(token),
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import crypto from 'crypto';
import zlib from 'zlib';
import jwt from 'jsonwebtoken';
import ssoRouter from '../routes/sso';

function app() {
  const a = express();
  a.use(cookieParser());
  a.use(express.urlencoded({ extended: false }));
  a.use(express.json());
  a.use('/api/sso', ssoRouter);
  return a;
}
function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: jest.fn(async () => body) };
}
function responseCookies(response: { headers: Record<string, unknown> }): string[] {
  const raw = response.headers['set-cookie'];
  return Array.isArray(raw) ? raw.map(String) : typeof raw === 'string' ? [raw] : [];
}
function token(kid = 'kid-1') {
  return `${Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url')}.e30.sig`;
}

const samlSigningKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function signedSamlResponse(options: {
  requestId: string;
  method?: string;
  confirmationDataNamespace?: string;
  nestConfirmationData?: boolean;
  email?: string;
}) {
  const { SignedXml } = require('xml-crypto');
  const now = Date.now();
  const assertionId = `_assertion${crypto.randomBytes(10).toString('hex')}`;
  const assertionNs = 'urn:oasis:names:tc:SAML:2.0:assertion';
  const method = options.method ?? 'urn:oasis:names:tc:SAML:2.0:cm:bearer';
  const email = options.email ?? 'saml-user@example.com';
  const directConfirmationData = options.confirmationDataNamespace
    ? `<lookalike:SubjectConfirmationData xmlns:lookalike="${options.confirmationDataNamespace}" Recipient="http://localhost:3001/api/sso/saml/callback" InResponseTo="${options.requestId}" NotOnOrAfter="${new Date(now + 300_000).toISOString()}"/>`
    : `<saml:SubjectConfirmationData Recipient="http://localhost:3001/api/sso/saml/callback" InResponseTo="${options.requestId}" NotOnOrAfter="${new Date(now + 300_000).toISOString()}"/>`;
  const confirmationData = options.nestConfirmationData
    ? `<lookalike:Wrapper xmlns:lookalike="urn:attacker:wrapper">${directConfirmationData}</lookalike:Wrapper>`
    : directConfirmationData;
  const assertion = `<saml:Assertion xmlns:saml="${assertionNs}" ID="${assertionId}" Version="2.0" IssueInstant="${new Date(now).toISOString()}">
    <saml:Issuer>https://saml.example/idp</saml:Issuer>
    <saml:Subject>
      <saml:NameID>${email}</saml:NameID>
      <saml:SubjectConfirmation Method="${method}">
        ${confirmationData}
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${new Date(now - 60_000).toISOString()}" NotOnOrAfter="${new Date(now + 300_000).toISOString()}">
      <saml:AudienceRestriction><saml:Audience>bridge-sp</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>${email}</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="displayName"><saml:AttributeValue>SAML User</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>`;
  const signer = new SignedXml({ privateKey: samlSigningKeys.privateKey });
  signer.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  signer.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signer.computeSignature(assertion);
  return `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_response${crypto.randomBytes(10).toString('hex')}">${signer.getSignedXml()}</samlp:Response>`;
}

function signedSamlProfile(options: {
  requestId: string;
  signResponse?: boolean;
  otherRoot?: boolean;
  mutateAssertion?: (xml: string) => string;
  mutateResponse?: (xml: string) => string;
  signatureAlgorithm?: string;
  digestAlgorithm?: string;
}) {
  const now = Date.now();
  const assertionId = `_assertion${crypto.randomBytes(10).toString('hex')}`;
  const assertionNs = 'urn:oasis:names:tc:SAML:2.0:assertion';
  const protocolNs = 'urn:oasis:names:tc:SAML:2.0:protocol';
  const acs = 'http://localhost:3001/api/sso/saml/callback';
  let assertion = `<saml:Assertion xmlns:saml="${assertionNs}" ID="${assertionId}" Version="2.0" IssueInstant="${new Date(now).toISOString()}">
    <saml:Issuer>https://saml.example/idp</saml:Issuer>
    <saml:Subject>
      <saml:NameID>profile-user@example.com</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData Recipient="${acs}" InResponseTo="${options.requestId}" NotOnOrAfter="${new Date(now + 300_000).toISOString()}"/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${new Date(now - 60_000).toISOString()}" NotOnOrAfter="${new Date(now + 300_000).toISOString()}">
      <saml:AudienceRestriction><saml:Audience>bridge-sp</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AttributeStatement>
      <saml:Attribute Name="email"><saml:AttributeValue>profile-user@example.com</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="displayName"><saml:AttributeValue>Profile User</saml:AttributeValue></saml:Attribute>
    </saml:AttributeStatement>
  </saml:Assertion>`;
  assertion = options.mutateAssertion?.(assertion) ?? assertion;

  let document = options.otherRoot
    ? `<other:Thing xmlns:other="urn:other" ID="_other${crypto.randomBytes(10).toString('hex')}">${assertion}</other:Thing>`
    : options.signResponse
      ? `<samlp:Response xmlns:samlp="${protocolNs}" xmlns:saml="${assertionNs}" ID="_response${crypto.randomBytes(10).toString('hex')}" Version="2.0" Destination="${acs}" InResponseTo="${options.requestId}">
          <saml:Issuer>https://saml.example/idp</saml:Issuer>
          <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
          ${assertion}
        </samlp:Response>`
      : assertion;
  document = options.mutateResponse?.(document) ?? document;

  const { SignedXml } = require('xml-crypto');
  const signer = new SignedXml({ privateKey: samlSigningKeys.privateKey });
  signer.signatureAlgorithm = options.signatureAlgorithm ?? 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  const target = options.otherRoot ? 'Thing' : options.signResponse ? 'Response' : 'Assertion';
  signer.addReference({
    xpath: `//*[local-name(.)='${target}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: options.digestAlgorithm ?? 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signer.computeSignature(document);
  return signer.getSignedXml();
}

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ['OIDC_ENABLED','OIDC_ISSUER','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET','OIDC_SCOPES',
    'OIDC_REQUIRE_EMAIL_VERIFIED','OIDC_LEGACY_ISSUER','SAML_ENABLED','SAML_ENTRY_POINT','SAML_ISSUER',
    'SAML_IDP_CERT','SAML_IDP_ENTITY_ID','SAML_LEGACY_IDP_ENTITY_ID']) delete process.env[k];
  mockUsers.findByEmail.mockResolvedValue(null);
  mockUsers.findBySsoIdentity.mockResolvedValue(null);
  mockUsers.findLegacySsoIdentity.mockResolvedValue(null);
  mockUsers.claimSsoIdentity.mockResolvedValue(true);
  mockUsers.upgradeLegacySsoIdentity.mockResolvedValue(true);
  mockUsers.create.mockImplementation(async (u: any) => u);
  mockUsers.update.mockResolvedValue(true);
  mockUsers.findById.mockResolvedValue(null);
  mockServers.findById.mockResolvedValue(null);
  mockServers.update.mockResolvedValue(true);
});

function enableOidc(issuer = 'https://issuer.example') {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = 'client-1';
  process.env.OIDC_CLIENT_SECRET = 'secret-1';
}

function oidcDiscovery(issuer: string) {
  return {
    issuer,
    authorization_endpoint: 'https://idp.example/auth',
    token_endpoint: 'https://token.example/token',
    jwks_uri: `https://jwks-${Math.random().toString(36).slice(2)}.example/keys`,
  };
}

describe('OIDC start — deterministic network contract', () => {
  it('configured discovery redirects with authoritative opaque state and PKCE', async () => {
    enableOidc();
    mockFetchT.mockResolvedValueOnce(jsonResponse(oidcDiscovery(process.env.OIDC_ISSUER!)));
    const r = await request(app()).get('/api/sso/oidc/start').expect(302);
    const target = new URL(r.headers.location);
    expect(target.origin + target.pathname).toBe('https://idp.example/auth');
    expect(target.searchParams.get('client_id')).toBe('client-1');
    expect(target.searchParams.get('scope')).toBe('openid email profile');
    expect(target.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(target.searchParams.get('code_challenge_method')).toBe('S256');
    expect(r.headers['set-cookie']).toEqual([
      expect.stringMatching(/^bridge_sso_oidc_[A-Za-z0-9_-]{32}=[A-Za-z0-9_-]{43};.*Path=\/api\/sso\/oidc\/callback;.*HttpOnly; SameSite=Lax$/),
    ]);
  });

  it('custom scopes are forwarded', async () => {
    enableOidc(); process.env.OIDC_SCOPES = 'openid email groups';
    mockFetchT.mockResolvedValueOnce(jsonResponse(oidcDiscovery(process.env.OIDC_ISSUER!)));
    const r = await request(app()).get('/api/sso/oidc/start').expect(302);
    expect(r.headers.location).toContain('scope=openid+email+groups');
  });

  it('SSRF discovery is a 400, ordinary discovery failure is 503', async () => {
    enableOidc();
    mockFetchT.mockRejectedValueOnce(new MockSSRFError());
    await request(app()).get('/api/sso/oidc/start').expect(400);
    mockFetchT.mockRejectedValueOnce(new Error('network'));
    await request(app()).get('/api/sso/oidc/start').expect(503);
  });
});

describe('OIDC callback — state/token/JWKS/user lifecycle', () => {
  it('requires code and state before touching discovery', async () => {
    enableOidc();
    await request(app()).get('/api/sso/oidc/callback').expect(400);
    await request(app()).get('/api/sso/oidc/callback?code=c').expect(400);
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  it('malformed state fails before network access', async () => {
    enableOidc();
    await request(app()).get('/api/sso/oidc/callback?code=c&state=x').expect(400);
    expect(mockFetchT).not.toHaveBeenCalled();
  });

  async function beginFlow() {
    const issuer = 'https://issuer-' + Math.random().toString(36).slice(2) + '.example';
    enableOidc(issuer);
    const discovery = oidcDiscovery(issuer);
    const agent = request.agent(app());
    mockFetchT.mockResolvedValueOnce(jsonResponse(discovery));
    const start = await agent.get('/api/sso/oidc/start').expect(302);
    const target = new URL(start.headers.location);
    return {
      agent,
      issuer,
      discovery,
      state: target.searchParams.get('state')!,
      nonce: target.searchParams.get('nonce')!,
    };
  }

  function installVerifiedOidcClaims(flow: Awaited<ReturnType<typeof beginFlow>>, claims: Record<string, unknown>) {
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', n: 'x', e: 'AQAB' }] }));
    const keySpy = jest.spyOn(crypto, 'createPublicKey').mockReturnValue({ export: () => 'PUBLIC KEY' } as any);
    const now = Math.floor(Date.now() / 1000);
    const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({
      email: 'user@example.com', email_verified: true, sub: 'subject-1', nonce: flow.nonce,
      aud: 'client-1', iat: now, exp: now + 300, ...claims,
    } as any);
    return () => { keySpy.mockRestore(); verifySpy.mockRestore(); };
  }

  it('binds state to the initiating browser without letting a cross-agent callback consume it', async () => {
    const flow = await beginFlow();
    const attacker = request.agent(app());
    const callsAfterStart = mockFetchT.mock.calls.length;
    const rejected = await attacker.get(`/api/sso/oidc/callback?code=attacker&state=${flow.state}`).expect(400);
    expect(rejected.body.error).toMatch(/browser flow binding/i);
    expect(mockFetchT).toHaveBeenCalledTimes(callsAfterStart);

    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ access_token: 'no-id-token' }));
    const legitimate = await flow.agent.get(`/api/sso/oidc/callback?code=legitimate&state=${flow.state}`).expect(401);
    expect(legitimate.body.error).toMatch(/id_token/);
    expect(responseCookies(legitimate).join(';')).toContain(`bridge_sso_oidc_${flow.state}=;`);
  });

  it('forbids token-endpoint redirects so a 307 cannot forward the code, verifier, or client secret', async () => {
    const flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery));
    mockFetchT.mockImplementationOnce(async (_url: string, options: RequestInit) => {
      expect(options.redirect).toBe('error');
      throw new TypeError('redirect mode blocked 307');
    });
    await flow.agent.get(`/api/sso/oidc/callback?code=secret-code&state=${flow.state}`).expect(502);
    const [, tokenOptions] = mockFetchT.mock.calls[2];
    expect(String(tokenOptions.body)).toContain('code=secret-code');
    expect(String(tokenOptions.body)).toContain('client_secret=secret-1');
    expect(mockFetchT).toHaveBeenCalledTimes(3);
  });

  it('discovery error after valid state is 503', async () => {
    const flow = await beginFlow();
    mockFetchT.mockRejectedValueOnce(new Error('discovery'));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(503);
  });

  it('token endpoint SSRF is 400; network failure is 502', async () => {
    let flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockRejectedValueOnce(new MockSSRFError());
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(400);
    mockFetchT.mockReset();
    flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockRejectedValueOnce(new Error('offline'));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(502);
  });

  it('missing id_token and missing jwks_uri fail explicitly', async () => {
    let flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({ access_token: 'x' }));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
    mockFetchT.mockReset();
    flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse({ ...flow.discovery, jwks_uri: undefined }));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(503);
  });

  it('empty JWKS and unknown kid fail verification', async () => {
    let flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockResolvedValueOnce(jsonResponse({ keys: [] }));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);

    mockFetchT.mockReset(); flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'other', kty: 'RSA' }] }));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
  });

  it('valid signed-claim path creates an SSO user and exposes the access token through one one-time handoff', async () => {
    const flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({ id_token: token() }));
    mockFetchT.mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', n: 'x', e: 'AQAB' }] }));
    const keySpy = jest.spyOn(crypto, 'createPublicKey').mockReturnValue({ export: () => 'PUBLIC KEY' } as any);
    const now = Math.floor(Date.now() / 1000);
    const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({
      email: 'USER@Example.COM', email_verified: true, name: 'Alice', sub: 'ext-1',
      nonce: flow.nonce, aud: 'client-1', iat: now, exp: now + 300,
    } as any);
    try {
      const r = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302);
      expect(mockUsers.create).toHaveBeenCalledWith(expect.objectContaining({
        email: 'user@example.com', displayName: 'Alice', ssoProvider: 'oidc',
        ssoIssuer: flow.issuer, ssoId: 'ext-1', emailVerified: true,
      }));
      expect(mockMakeToken).toHaveBeenCalled(); expect(mockMakeRefreshToken).toHaveBeenCalled();
      const cookies = responseCookies(r).join(';');
      expect(cookies).toMatch(/bridge_refresh=refresh-token.*Path=\/api\/refresh.*HttpOnly/i);
      expect(cookies).toMatch(/bridge_sso_handoff=.*Path=\/api\/sso\/session.*HttpOnly/i);
      expect(cookies).not.toMatch(/access_token=/i);
      expect(r.headers.location).toBe('http://localhost:3001/sso-callback');
      expect(r.headers.location).not.toContain('token=');
      expect(verifySpy).toHaveBeenCalledWith(expect.any(String), 'PUBLIC KEY', expect.objectContaining({ issuer: process.env.OIDC_ISSUER, audience: 'client-1' }));
      const handoff = await flow.agent.post('/api/sso/session').expect(200);
      expect(handoff.headers['cache-control']).toBe('no-store');
      expect(handoff.body).toEqual({ token: mockMakeToken() });
      await flow.agent.post('/api/sso/session').expect(401);
    } finally { keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it('revokes the persisted refresh row when Redis cannot persist the browser handoff', async () => {
    const flow = await beginFlow();
    const cleanup = installVerifiedOidcClaims(flow, {});
    const cache = require('../lib/redisAdapter').cache as any;
    cache.setAuthoritative.mockRejectedValueOnce(new Error('handoff Redis down'));
    try {
      const rejected = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(503);
      expect(rejected.body.error).toMatch(/handoff/i);
      expect(mockMakeRefreshToken).toHaveBeenCalledTimes(1);
      expect(mockRevokeRefreshToken).toHaveBeenCalledWith('refresh-token');
      const cookies = responseCookies(rejected).join(';');
      expect(cookies).not.toMatch(/bridge_refresh=/i);
      expect(cookies).not.toMatch(/bridge_sso_handoff=/i);
    } finally { cleanup(); }
  });

  it('existing non-SSO user is linked instead of duplicated and email fallback names work', async () => {
    const flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({ id_token: token() }));
    mockFetchT.mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', n: 'x', e: 'AQAB' }] }));
    const existing = { _id: 'u1', email: 'x@example.com', username: 'x', ssoProvider: null };
    mockUsers.findByEmail.mockResolvedValue(existing);
    const keySpy = jest.spyOn(crypto, 'createPublicKey').mockReturnValue({ export: () => 'PUBLIC KEY' } as any);
    const now = Math.floor(Date.now() / 1000);
    const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({ email: 'x@example.com', email_verified: true, preferred_username: 'X User', sub: 'ext-x', nonce: flow.nonce, aud: 'client-1', iat: now, exp: now + 300 } as any);
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302);
      expect(mockUsers.create).not.toHaveBeenCalled();
      expect(mockUsers.claimSsoIdentity).toHaveBeenCalledWith('u1', 'oidc', flow.issuer, 'ext-x');
    } finally { keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it('never auto-links a preexisting victim account from an unverified email claim', async () => {
    process.env.OIDC_REQUIRE_EMAIL_VERIFIED = 'false';
    const flow = await beginFlow();
    const cleanup = installVerifiedOidcClaims(flow, { email: 'victim@example.com', email_verified: false, sub: 'attacker-subject' });
    mockUsers.findByEmail.mockResolvedValue({
      _id: 'victim', email: 'victim@example.com', username: 'victim',
      ssoProvider: null, ssoIssuer: null, ssoId: null,
    });
    try {
      const rejected = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(403);
      expect(rejected.body.error).toMatch(/identity/i);
      expect(mockUsers.claimSsoIdentity).not.toHaveBeenCalled();
      expect(mockMakeToken).not.toHaveBeenCalled();
      expect(mockMakeRefreshToken).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('rechecks ownership and rejects the loser of a concurrent account-link race', async () => {
    const flow = await beginFlow();
    const cleanup = installVerifiedOidcClaims(flow, { email: 'race@example.com', sub: 'candidate-subject' });
    mockUsers.findByEmail.mockResolvedValue({
      _id: 'shared-local', email: 'race@example.com', username: 'shared',
      ssoProvider: null, ssoIssuer: null, ssoId: null,
    });
    mockUsers.claimSsoIdentity.mockResolvedValue(false);
    mockUsers.findById.mockResolvedValue({
      _id: 'shared-local', email: 'race@example.com', username: 'shared',
      ssoProvider: 'oidc', ssoIssuer: flow.issuer, ssoId: 'winning-subject',
    });
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(403);
      expect(mockUsers.claimSsoIdentity).toHaveBeenCalledWith(
        'shared-local', 'oidc', flow.issuer, 'candidate-subject',
      );
      expect(mockUsers.findById).toHaveBeenCalledWith('shared-local');
      expect(mockMakeToken).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('does not collapse identical subjects from different OIDC issuers onto a victim binding', async () => {
    const flow = await beginFlow();
    const cleanup = installVerifiedOidcClaims(flow, { email: 'victim@example.com', sub: 'shared-subject' });
    mockUsers.findByEmail.mockResolvedValue({
      _id: 'victim', email: 'victim@example.com', username: 'victim', ssoProvider: 'oidc',
      ssoIssuer: 'https://old-issuer.example', ssoId: 'shared-subject',
    });
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(403);
      expect(mockUsers.findBySsoIdentity).toHaveBeenCalledWith('oidc', flow.issuer, 'shared-subject');
      expect(mockMakeToken).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('upgrades a quarantined legacy binding only for the explicitly approved issuer', async () => {
    const flow = await beginFlow();
    process.env.OIDC_LEGACY_ISSUER = flow.issuer;
    const cleanup = installVerifiedOidcClaims(flow, { sub: 'legacy-subject' });
    mockUsers.findLegacySsoIdentity.mockResolvedValue({
      _id: 'legacy-user', email: 'old@example.com', username: 'old',
      ssoProvider: 'oidc', ssoIssuer: 'legacy:oidc', ssoId: 'legacy-subject',
    });
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302);
      expect(mockUsers.upgradeLegacySsoIdentity).toHaveBeenCalledWith(
        'legacy-user', 'oidc', flow.issuer, 'legacy-subject',
      );
      expect(mockUsers.findByEmail).not.toHaveBeenCalled();
    } finally { cleanup(); }
  });

  it('provider subject lookup survives an upstream email change', async () => {
    const flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({ id_token: token() }));
    mockFetchT.mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', n: 'x', e: 'AQAB' }] }));
    mockUsers.findBySsoIdentity.mockResolvedValue({
      _id: 'bound', username: 'bound', email: 'old@example.com',
      ssoProvider: 'oidc', ssoIssuer: flow.issuer, ssoId: 'stable-sub',
    });
    const keySpy = jest.spyOn(crypto, 'createPublicKey').mockReturnValue({ export: () => 'PUBLIC KEY' } as any);
    const now = Math.floor(Date.now() / 1000);
    const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({ email: 'new@example.com', email_verified: true, sub: 'stable-sub', nonce: flow.nonce, aud: 'client-1', iat: now, exp: now + 300 } as any);
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302);
      expect(mockUsers.findByEmail).not.toHaveBeenCalled();
      expect(mockUsers.create).not.toHaveBeenCalled();
    } finally { keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it('consumes state before token exchange so callback replay cannot reach the provider twice', async () => {
    const flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({ access_token: 'no-id-token' }));
    const callback = `/api/sso/oidc/callback?code=c&state=${flow.state}`;
    await flow.agent.get(callback).expect(401);
    const callsAfterFirst = mockFetchT.mock.calls.length;
    await flow.agent.get(callback).expect(400);
    expect(mockFetchT).toHaveBeenCalledTimes(callsAfterFirst);
  });


  it('rejects malformed token headers, unsupported algorithms, and malformed kid values before accepting claims', async () => {
    const variants = [
      'short',
      `${Buffer.from('{bad').toString('base64url')}.e30.signature-that-makes-the-token-long-enough`,
      `${Buffer.from(JSON.stringify({alg:'HS256',kid:'kid-1'})).toString('base64url')}.e30.signature-that-makes-token-long-enough`,
      `${Buffer.from(JSON.stringify({alg:'RS256',kid:''})).toString('base64url')}.e30.signature-that-makes-token-long-enough`,
      `${Buffer.from(JSON.stringify({alg:'RS256',kid:'x'.repeat(257)})).toString('base64url')}.e30.signature-that-makes-token-long-enough`,
    ];
    for (const idToken of variants) {
      mockFetchT.mockReset();
      const flow = await beginFlow();
      mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({ id_token:idToken }));
      const r=await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
      expect(r.body.detail).toMatch(/Malformed|Unsupported/i);
    }
  });

  it('rejects a non-success JWKS endpoint without attempting key conversion', async () => {
    const flow=await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({id_token:token()})).mockResolvedValueOnce(jsonResponse({},503));
    const keySpy=jest.spyOn(crypto,'createPublicKey');
    try { const r=await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401); expect(r.body.detail).toMatch(/JWKS endpoint failed/); expect(keySpy).not.toHaveBeenCalled(); }
    finally { keySpy.mockRestore(); }
  });

  it('refreshes JWKS exactly once on key rotation and succeeds with the fresh signing key', async () => {
    const flow=await beginFlow(); const now=Math.floor(Date.now()/1000);
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({id_token:token()}))
      .mockResolvedValueOnce(jsonResponse({keys:[{kid:'kid-1',kty:'RSA',use:'sig',alg:'RS256',n:'old',e:'AQAB'}]}))
      .mockResolvedValueOnce(jsonResponse({keys:[{kid:'kid-1',kty:'RSA',use:'sig',alg:'RS256',n:'new',e:'AQAB'}]}));
    const keySpy=jest.spyOn(crypto,'createPublicKey').mockImplementation(({key}:any)=>({export:()=>key.n==='old'?'OLD':'NEW'} as any));
    const verifySpy=jest.spyOn(jwt,'verify').mockImplementation((_t:any,pem:any)=>{
      if(pem==='OLD') throw new Error('old signature');
      return {email:'x@example.com',email_verified:true,sub:'sub',nonce:flow.nonce,aud:'client-1',iat:now,exp:now+300} as any;
    });
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302); expect(verifySpy).toHaveBeenCalledTimes(2); }
    finally { keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it('skips JWKS keys declared for encryption/wrong algorithms and can verify a token without kid against a later signing key', async () => {
    const flow=await beginFlow(); const now=Math.floor(Date.now()/1000);
    const noKid=`${Buffer.from(JSON.stringify({alg:'RS256'})).toString('base64url')}.e30.signature-that-is-long-enough-for-id-token`;
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({id_token:noKid})).mockResolvedValueOnce(jsonResponse({keys:[
      {kty:'RSA',use:'enc',alg:'RS256',n:'enc',e:'AQAB'},
      {kty:'RSA',use:'sig',alg:'ES256',n:'wrong-alg',e:'AQAB'},
      {kty:'RSA',use:'sig',alg:'RS256',n:'good',e:'AQAB'},
    ]}));
    const keySpy=jest.spyOn(crypto,'createPublicKey').mockImplementation(({key}:any)=>({export:()=>String(key.n)} as any));
    const verifySpy=jest.spyOn(jwt,'verify').mockReturnValue({email:'x@example.com',email_verified:true,sub:'s',nonce:flow.nonce,aud:'client-1',iat:now,exp:now+300} as any);
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302); expect(keySpy).toHaveBeenCalledTimes(1); expect(verifySpy).toHaveBeenCalledWith(noKid,'good',expect.any(Object)); }
    finally { keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it.each([
    ['missing exp',{exp:undefined},/canonical exp and iat/],
    ['fractional exp',{exp:1.5},/canonical exp and iat/],
    ['missing iat',{iat:undefined},/canonical exp and iat/],
    ['expired',{exp:1},/expired/],
    ['future iat',{iat:Math.floor(Date.now()/1000)+3600},/future/],
    ['empty sub',{sub:''},/invalid sub/],
    ['oversize sub',{sub:'x'.repeat(1025)},/invalid sub/],
    ['bad audience type',{aud:123},/audience mismatch/],
    ['wrong audience',{aud:'other'},/audience mismatch/],
    ['multi audience without azp',{aud:['client-1','other'],azp:undefined},/authorized party/],
    ['wrong azp',{aud:'client-1',azp:'other'},/authorized party/],
  ])('fails closed on OIDC claim invariant: %s', async (_label, patch:any, expected:RegExp) => {
    mockFetchT.mockReset(); const flow=await beginFlow(); const now=Math.floor(Date.now()/1000);
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({id_token:token()})).mockResolvedValueOnce(jsonResponse({keys:[{kid:'kid-1',kty:'RSA',n:'x',e:'AQAB'}]}));
    const keySpy=jest.spyOn(crypto,'createPublicKey').mockReturnValue({export:()=> 'PUBLIC KEY'} as any);
    const claims:any={email:'x@example.com',email_verified:true,sub:'s',nonce:flow.nonce,aud:'client-1',iat:now,exp:now+300,...patch};
    if(patch.exp===undefined && Object.prototype.hasOwnProperty.call(patch,'exp')) delete claims.exp;
    if(patch.iat===undefined && Object.prototype.hasOwnProperty.call(patch,'iat')) delete claims.iat;
    if(patch.azp===undefined && Object.prototype.hasOwnProperty.call(patch,'azp')) delete claims.azp;
    const verifySpy=jest.spyOn(jwt,'verify').mockReturnValue(claims);
    try { const r=await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401); expect(r.body.detail).toMatch(expected); }
    finally { keySpy.mockRestore();verifySpy.mockRestore(); }
  });

  it('requires exact nonce, required identity claims and verified email by default', async () => {
    const cases=[
      [{nonce:'wrong'},401,/nonce/],
      [{email:''},400,/Required OIDC claims/],
      [{sub:''},401,/invalid sub/],
      [{email_verified:false},403,/not verified/],
    ] as const;
    for(const [patch,status,expected] of cases){
      mockFetchT.mockReset(); const flow=await beginFlow(); const now=Math.floor(Date.now()/1000);
      mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({id_token:token()})).mockResolvedValueOnce(jsonResponse({keys:[{kid:'kid-1',kty:'RSA',n:'x',e:'AQAB'}]}));
      const ks=jest.spyOn(crypto,'createPublicKey').mockReturnValue({export:()=> 'PUBLIC KEY'} as any);
      const vs=jest.spyOn(jwt,'verify').mockReturnValue({email:'x@example.com',email_verified:true,sub:'s',nonce:flow.nonce,aud:'client-1',iat:now,exp:now+300,...patch} as any);
      try { const r=await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(status); expect(JSON.stringify(r.body)).toMatch(expected); }
      finally {ks.mockRestore();vs.mockRestore();}
    }
  });

  it('permits an explicitly configured unverified-email provider while still binding subject and normalizing fallback display name', async () => {
    process.env.OIDC_REQUIRE_EMAIL_VERIFIED='false';
    const flow=await beginFlow(); const now=Math.floor(Date.now()/1000);
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery)).mockResolvedValueOnce(jsonResponse({id_token:token()})).mockResolvedValueOnce(jsonResponse({keys:[{kid:'kid-1',kty:'RSA',n:'x',e:'AQAB'}]}));
    const ks=jest.spyOn(crypto,'createPublicKey').mockReturnValue({export:()=> 'PUBLIC KEY'} as any);
    const vs=jest.spyOn(jwt,'verify').mockReturnValue({email:'Fallback@Example.com',email_verified:false,sub:'s',nonce:flow.nonce,aud:'client-1',iat:now,exp:now+300} as any);
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302); expect(mockUsers.create).toHaveBeenCalledWith(expect.objectContaining({email:'fallback@example.com',displayName:'Fallback@Example.com',emailVerified:false,ssoIssuer:flow.issuer})); }
    finally { delete process.env.OIDC_REQUIRE_EMAIL_VERIFIED; ks.mockRestore();vs.mockRestore(); }
  });

  it('rejects malformed discovery documents and non-success discovery/token responses before issuing credentials', async () => {
    const issuer = 'https://discovery-errors.example';
    const invalidStartDocuments: Array<[unknown, number]> = [
      [oidcDiscovery('https://different-issuer.example'), 200],
      [{ ...oidcDiscovery(issuer), authorization_endpoint: 'not a URL' }, 200],
      [{ ...oidcDiscovery(issuer), authorization_endpoint: 'ftp://idp.example/auth' }, 200],
      [{ ...oidcDiscovery(issuer), authorization_endpoint: 'https://user:pass@idp.example/auth' }, 200],
      [oidcDiscovery(issuer), 503],
    ];
    for (const [document, status] of invalidStartDocuments) {
      mockFetchT.mockReset(); enableOidc(issuer);
      mockFetchT.mockResolvedValueOnce(jsonResponse(document, status));
      await request(app()).get('/api/sso/oidc/start').expect(503);
    }

    let flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery, 502));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(503);

    mockFetchT.mockReset(); flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400));
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(502);
    expect(mockMakeToken).not.toHaveBeenCalled();
  });

  it('fails closed when authoritative OIDC state writes/claims fail or stored flow fields are corrupted', async () => {
    const cache = require('../lib/redisAdapter').cache as any;
    enableOidc();
    mockFetchT.mockResolvedValueOnce(jsonResponse(oidcDiscovery(process.env.OIDC_ISSUER!)));
    cache.setAuthoritative.mockRejectedValueOnce('state store unavailable');
    await request(app()).get('/api/sso/oidc/start').expect(503);

    mockFetchT.mockReset();
    let flow = await beginFlow();
    cache.takeAuthoritative.mockRejectedValueOnce('state claim unavailable');
    await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(503);

    const invalidFlow = (kind: number, currentIssuer: string) => [
      null,
      { issuer: 'https://wrong.example', clientId: 'client-1', nonce: 'n'.repeat(32), codeVerifier: 'v'.repeat(43) },
      { issuer: currentIssuer, clientId: 'wrong', nonce: 'n'.repeat(32), codeVerifier: 'v'.repeat(43) },
      { issuer: currentIssuer, clientId: 'client-1', nonce: 1, codeVerifier: 'v'.repeat(43) },
      { issuer: currentIssuer, clientId: 'client-1', nonce: 'bad', codeVerifier: 'v'.repeat(43) },
      { issuer: currentIssuer, clientId: 'client-1', nonce: 'n'.repeat(32), codeVerifier: 1 },
      { issuer: currentIssuer, clientId: 'client-1', nonce: 'n'.repeat(32), codeVerifier: 'short' },
    ][kind];
    for (let kind = 0; kind < 7; kind += 1) {
      mockFetchT.mockReset(); flow = await beginFlow();
      cache.takeAuthoritative.mockResolvedValueOnce(invalidFlow(kind, flow.issuer));
      await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(400);
    }
  });

  it('validates the authorization code only after consuming a well-formed one-time state', async () => {
    let flow = await beginFlow();
    await flow.agent.get(`/api/sso/oidc/callback?state=${flow.state}`).expect(400);
    mockFetchT.mockReset(); flow = await beginFlow();
    await flow.agent.get(`/api/sso/oidc/callback?code=${'x'.repeat(4097)}&state=${flow.state}`).expect(400);
    mockFetchT.mockReset(); flow = await beginFlow();
    await flow.agent.get(`/api/sso/oidc/callback?code=a&code=b&state=${flow.state}`).expect(400);
  });

  it('uses a bounded JWKS cache, reuses a fresh key set, and refreshes an expired entry', async () => {
    const issuer = `https://jwks-cache-${Math.random().toString(36).slice(2)}.example`;
    const discovery = { ...oidcDiscovery(issuer), jwks_uri: `https://keys-${Math.random().toString(36).slice(2)}.example/jwks` };
    const baseNow = Date.now();
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(baseNow);
    const keySpy = jest.spyOn(crypto, 'createPublicKey').mockReturnValue({ export: () => 'PUBLIC KEY' } as any);
    let expectedNonce = '';
    const verifySpy = jest.spyOn(jwt, 'verify').mockImplementation(() => ({
      email: 'cache@example.com', email_verified: true, sub: 'cache-subject', nonce: expectedNonce,
      aud: 'client-1', iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300,
    }) as any);
    const login = async (includeJwks: boolean) => {
      enableOidc(issuer); mockFetchT.mockReset();
      const agent = request.agent(app());
      mockFetchT.mockResolvedValueOnce(jsonResponse(discovery));
      const start = await agent.get('/api/sso/oidc/start').expect(302);
      const target = new URL(start.headers.location); expectedNonce = target.searchParams.get('nonce')!;
      mockFetchT.mockResolvedValueOnce(jsonResponse(discovery))
        .mockResolvedValueOnce(jsonResponse({ id_token: token('stable-cache-kid') }));
      if (includeJwks) mockFetchT.mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'stable-cache-kid', kty: 'RSA', n: 'x', e: 'AQAB' }] }));
      await agent.get(`/api/sso/oidc/callback?code=c&state=${target.searchParams.get('state')}`).expect(302);
    };
    try {
      await login(true);
      await login(false);
      nowSpy.mockReturnValue(baseNow + 60_001);
      await login(true);
      expect(keySpy).toHaveBeenCalledTimes(3);
    } finally { nowSpy.mockRestore(); keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it('rejects structurally empty token headers and JWKS sets that contain no usable signing key', async () => {
    let flow = await beginFlow();
    const missingHeader = `.payload.${'s'.repeat(40)}`;
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: missingHeader }));
    let rejected = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
    expect(rejected.body.detail).toMatch(/missing header/i);

    mockFetchT.mockReset(); flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockResolvedValueOnce(jsonResponse({ keys: { kid: 'not-an-array' } }))
      .mockResolvedValueOnce(jsonResponse({ keys: null }));
    rejected = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
    expect(rejected.body.detail).toMatch(/no keys/i);

    mockFetchT.mockReset(); flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', use: 'enc', alg: 'RS256' }] }))
      .mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', use: 'sig', alg: 'ES256' }] }));
    rejected = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
    expect(rejected.body.detail).toMatch(/verification failed/i);
  });

  it('preserves the first signature failure after one bounded JWKS rotation refresh', async () => {
    const flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', n: 'old', e: 'AQAB' }] }))
      .mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', n: 'new', e: 'AQAB' }] }));
    const keySpy = jest.spyOn(crypto, 'createPublicKey').mockImplementation(({ key }: any) => ({ export: () => key.n } as any));
    const verifySpy = jest.spyOn(jwt, 'verify').mockImplementation((_token, pem) => { throw new Error(`bad signature: ${pem}`); });
    try {
      const rejected = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
      expect(rejected.body.detail).toContain('bad signature: old');
      expect(verifySpy).toHaveBeenCalledTimes(2);
    } finally { keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it('handles non-Error provider/cache failures without leaking credentials and validates handoff payload bounds', async () => {
    const cache = require('../lib/redisAdapter').cache as any;
    let flow = await beginFlow();
    mockFetchT.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockRejectedValueOnce('jwks offline');
    let rejected = await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(401);
    expect(rejected.body.detail).toBe('jwks offline');

    mockFetchT.mockReset(); flow = await beginFlow();
    const cleanup = installVerifiedOidcClaims(flow, {});
    mockUsers.findBySsoIdentity.mockRejectedValueOnce('identity backend offline');
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(403); }
    finally { cleanup(); }

    await request(app()).post('/api/sso/session').expect(401);
    for (const claimed of [null, {}, { accessToken: 'short' }, { accessToken: 'x'.repeat(32_769) }]) {
      cache.takeAuthoritative.mockResolvedValueOnce(claimed);
      await request(app()).post('/api/sso/session')
        .set('Cookie', `bridge_sso_handoff=${'h'.repeat(43)}`).expect(401);
    }
    cache.takeAuthoritative.mockRejectedValueOnce('handoff backend offline');
    await request(app()).post('/api/sso/session')
      .set('Cookie', `bridge_sso_handoff=${'h'.repeat(43)}`).expect(503);
  });

  it('contains refresh-token cleanup failures when the one-time handoff cannot be persisted', async () => {
    const flow = await beginFlow();
    const cleanup = installVerifiedOidcClaims(flow, {});
    const cache = require('../lib/redisAdapter').cache as any;
    cache.setAuthoritative.mockRejectedValueOnce('handoff backend offline');
    mockRevokeRefreshToken.mockRejectedValueOnce('refresh cleanup offline');
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(503);
      expect(mockRevokeRefreshToken).toHaveBeenCalledWith('refresh-token');
    } finally { cleanup(); }
  });

  it('resolves identity-claim races only for the exact issuer-scoped winner', async () => {
    let flow = await beginFlow();
    let cleanup = installVerifiedOidcClaims(flow, { email: 'legacy-race@example.com', sub: 'legacy-race' });
    process.env.OIDC_LEGACY_ISSUER = flow.issuer;
    mockUsers.findLegacySsoIdentity.mockResolvedValue({ _id: 'legacy', ssoProvider: 'oidc', ssoId: 'legacy-race' });
    mockUsers.upgradeLegacySsoIdentity.mockResolvedValue(false);
    mockUsers.findById.mockResolvedValue({ _id: 'legacy', ssoProvider: 'oidc', ssoIssuer: flow.issuer, ssoId: 'legacy-race' });
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302); }
    finally { cleanup(); }

    mockFetchT.mockReset(); flow = await beginFlow(); cleanup = installVerifiedOidcClaims(flow, { email: 'create-race@example.com', sub: 'create-race' });
    mockUsers.create.mockRejectedValueOnce(new Error('unique identity race'));
    mockUsers.findBySsoIdentity.mockResolvedValueOnce(null).mockResolvedValueOnce({
      _id: 'winner', ssoProvider: 'oidc', ssoIssuer: flow.issuer, ssoId: 'create-race',
    });
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302); }
    finally { cleanup(); }

    mockFetchT.mockReset(); flow = await beginFlow(); cleanup = installVerifiedOidcClaims(flow, { email: 'link-race@example.com', sub: 'link-race' });
    mockUsers.findByEmail.mockResolvedValue({ _id: 'local', ssoProvider: null, ssoIssuer: null, ssoId: null });
    mockUsers.claimSsoIdentity.mockResolvedValue(false);
    mockUsers.findById.mockResolvedValue({ _id: 'local', ssoProvider: 'oidc', ssoIssuer: flow.issuer, ssoId: 'link-race' });
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(302); }
    finally { cleanup(); }
  });

  it('rejects legacy-upgrade and first-create races when no exact issuer-scoped identity wins', async () => {
    let flow = await beginFlow();
    let cleanup = installVerifiedOidcClaims(flow, { email: 'legacy-loser@example.com', sub: 'legacy-loser' });
    process.env.OIDC_LEGACY_ISSUER = flow.issuer;
    mockUsers.findLegacySsoIdentity.mockResolvedValue({ _id: 'legacy', ssoProvider: 'oidc', ssoId: 'legacy-loser' });
    mockUsers.upgradeLegacySsoIdentity.mockResolvedValue(false);
    mockUsers.findById.mockResolvedValue({ _id: 'legacy', ssoProvider: 'oidc', ssoIssuer: 'https://other.example', ssoId: 'legacy-loser' });
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(403); }
    finally { cleanup(); }

    mockFetchT.mockReset(); flow = await beginFlow();
    cleanup = installVerifiedOidcClaims(flow, { email: 'create-loser@example.com', sub: 'create-loser' });
    delete process.env.OIDC_LEGACY_ISSUER;
    mockUsers.findLegacySsoIdentity.mockResolvedValue(null);
    mockUsers.create.mockRejectedValueOnce(new Error('unique race lost'));
    mockUsers.findBySsoIdentity.mockResolvedValue(null);
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(403); }
    finally { cleanup(); }
  });

  it('rejects provider namespaces reserved for quarantined legacy identities', async () => {
    const issuer = 'legacy:oidc';
    enableOidc(issuer);
    const discovery = oidcDiscovery(issuer);
    const agent = request.agent(app());
    mockFetchT.mockResolvedValueOnce(jsonResponse(discovery));
    const start = await agent.get('/api/sso/oidc/start').expect(302);
    const target = new URL(start.headers.location);
    mockFetchT.mockResolvedValueOnce(jsonResponse(discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: token() }))
      .mockResolvedValueOnce(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', n: 'x', e: 'AQAB' }] }));
    const keySpy = jest.spyOn(crypto, 'createPublicKey').mockReturnValue({ export: () => 'PUBLIC KEY' } as any);
    const now = Math.floor(Date.now() / 1000);
    const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({
      email: 'legacy@example.com', email_verified: true, sub: 'subject', nonce: target.searchParams.get('nonce'),
      aud: 'client-1', iat: now, exp: now + 300,
    } as any);
    try {
      await agent.get(`/api/sso/oidc/callback?code=c&state=${target.searchParams.get('state')}`).expect(403);
    } finally { keySpy.mockRestore(); verifySpy.mockRestore(); }
  });

  it.each(['not-an-email', `${'a'.repeat(313)}@example.com`])('rejects invalid SSO email identity %s', async (email) => {
    const flow = await beginFlow();
    const cleanup = installVerifiedOidcClaims(flow, { email });
    try { await flow.agent.get(`/api/sso/oidc/callback?code=c&state=${flow.state}`).expect(403); }
    finally { cleanup(); }
  });

});

describe('SAML start and server-owner config', () => {
  async function beginSignedSamlFlow() {
    process.env.SAML_ENABLED = 'true';
    process.env.SAML_ENTRY_POINT = 'https://saml.example/login';
    process.env.SAML_ISSUER = 'bridge-sp';
    process.env.SAML_IDP_CERT = samlSigningKeys.publicKey;
    process.env.SAML_IDP_ENTITY_ID = 'https://saml.example/idp';
    const agent = request.agent(app());
    const start = await agent.get('/api/sso/saml/start').expect(302);
    const target = new URL(start.headers.location);
    const relayState = target.searchParams.get('RelayState')!;
    const requestXml = zlib.inflateRawSync(Buffer.from(target.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    const requestId = requestXml.match(/\bID="([^"]+)"/)?.[1];
    if (!requestId) throw new Error('test AuthnRequest did not contain an ID');
    return { agent, relayState, requestId };
  }

  it('enabled SAML start emits a raw-DEFLATE AuthnRequest and an authoritative relay state', async () => {
    process.env.SAML_ENABLED = 'true'; process.env.SAML_ENTRY_POINT = 'https://saml.example/login'; process.env.SAML_ISSUER = 'bridge-sp';
    const r = await request(app()).get('/api/sso/saml/start?relayState=abc').expect(302);
    const u = new URL(r.headers.location);
    expect(u.origin + u.pathname).toBe('https://saml.example/login');
    expect(u.searchParams.get('RelayState')).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(u.searchParams.get('RelayState')).not.toBe('abc');
    const xml = zlib.inflateRawSync(Buffer.from(u.searchParams.get('SAMLRequest')!, 'base64')).toString('utf8');
    expect(xml).toContain('bridge-sp'); expect(xml).toContain('AuthnRequest');
    expect(r.headers['set-cookie']).toEqual([
      expect.stringMatching(/^bridge_sso_saml_[A-Za-z0-9_-]{32}=[A-Za-z0-9_-]{43};.*Path=\/api\/sso\/saml\/callback;.*HttpOnly; SameSite=Lax$/),
    ]);
  });

  it('binds SAML RelayState to the initiating browser and preserves it after a cross-agent attempt', async () => {
    process.env.SAML_ENABLED = 'true'; process.env.SAML_ENTRY_POINT = 'https://saml.example/login'; process.env.SAML_ISSUER = 'bridge-sp';
    const cache = require('../lib/redisAdapter').cache as any;
    const legitimate = request.agent(app());
    const start = await legitimate.get('/api/sso/saml/start').expect(302);
    const relay = new URL(start.headers.location).searchParams.get('RelayState')!;
    const payload = Buffer.from('<x/>').toString('base64');

    const attacker = request.agent(app());
    await attacker.post('/api/sso/saml/callback').type('form').send({ RelayState: relay, SAMLResponse: payload }).expect(400);
    expect(cache.takeAuthoritative).not.toHaveBeenCalled();

    const response = await legitimate.post('/api/sso/saml/callback').type('form')
      .send({ RelayState: relay, SAMLResponse: payload }).expect(503);
    expect(cache.takeAuthoritative).toHaveBeenCalledTimes(1);
    expect(responseCookies(response).join(';')).toContain(`bridge_sso_saml_${relay}=;`);
  });

  it('rejects a flow if the SAML issuer or signing authority changes after initiation', async () => {
    process.env.SAML_ENABLED = 'true'; process.env.SAML_ENTRY_POINT = 'https://saml.example/login'; process.env.SAML_ISSUER = 'bridge-sp';
    process.env.SAML_IDP_CERT = samlSigningKeys.publicKey;
    process.env.SAML_IDP_ENTITY_ID = 'https://saml.example/original-idp';
    const agent = request.agent(app());
    const start = await agent.get('/api/sso/saml/start').expect(302);
    const relay = new URL(start.headers.location).searchParams.get('RelayState')!;
    process.env.SAML_IDP_ENTITY_ID = 'https://saml.example/replacement-idp';
    const rejected = await agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: relay,
      SAMLResponse: Buffer.from('<x/>').toString('base64'),
    }).expect(400);
    expect(rejected.body.error).toMatch(/configuration changed/i);
  });

  it('loads the XML signature runtime and rejects duplicate-ID wrapping before certificate parsing', async () => {
    process.env.SAML_ENABLED = 'true';
    process.env.SAML_ENTRY_POINT = 'https://saml.example/login';
    process.env.SAML_ISSUER = 'bridge-sp';
    process.env.SAML_IDP_CERT = 'not-a-real-certificate';
    process.env.SAML_IDP_ENTITY_ID = 'https://saml.example/idp';
    expect(typeof require('xml-crypto').SignedXml).toBe('function');

    const agent = request.agent(app());
    const start = await agent.get('/api/sso/saml/start').expect(302);
    const relayState = new URL(start.headers.location).searchParams.get('RelayState');
    const wrapped = [
      '<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" ID="_duplicate">',
      '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_duplicate"/>',
      '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/>',
      '</samlp:Response>',
    ].join('');
    const rejected = await agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: relayState,
      SAMLResponse: Buffer.from(wrapped).toString('base64'),
    }).expect(401);
    expect(rejected.body.detail).toContain('Duplicate SAML XML ID detected');
  });

  it('accepts a real RSA-signed bearer assertion and rejects HoK or wrong-namespace lookalikes', async () => {
    let flow = await beginSignedSamlFlow();
    let xml = signedSamlResponse({ requestId: flow.requestId });
    const accepted = await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState,
      SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(302);
    expect(accepted.headers.location).toBe('http://localhost:3001/sso-callback');
    expect(mockUsers.create).toHaveBeenCalledWith(expect.objectContaining({
      email: 'saml-user@example.com', ssoProvider: 'saml',
      ssoIssuer: 'https://saml.example/idp', ssoId: 'saml-user@example.com',
    }));

    flow = await beginSignedSamlFlow();
    xml = signedSamlResponse({
      requestId: flow.requestId,
      method: 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key',
      email: 'hok@example.com',
    });
    const hok = await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState,
      SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(401);
    expect(hok.body.detail).toMatch(/bearer confirmation/i);

    flow = await beginSignedSamlFlow();
    xml = signedSamlResponse({
      requestId: flow.requestId,
      confirmationDataNamespace: 'urn:attacker:lookalike',
      email: 'namespace@example.com',
    });
    const wrongNamespace = await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState,
      SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(401);
    expect(wrongNamespace.body.detail).toMatch(/bearer confirmation/i);

    flow = await beginSignedSamlFlow();
    xml = signedSamlResponse({ requestId: flow.requestId, nestConfirmationData: true, email: 'nested@example.com' });
    const nestedLookalike = await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState,
      SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(401);
    expect(nestedLookalike.body.detail).toMatch(/bearer confirmation/i);
  });

  it('accepts a fully request-bound signed SAML Response profile', async () => {
    const flow = await beginSignedSamlFlow();
    const xml = signedSamlProfile({ requestId: flow.requestId, signResponse: true });
    const accepted = await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState,
      SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(302);
    expect(accepted.headers.location).toBe('http://localhost:3001/sso-callback');
    expect(mockUsers.create).toHaveBeenCalledWith(expect.objectContaining({
      email: 'profile-user@example.com', ssoProvider: 'saml', ssoId: 'profile-user@example.com',
    }));
  });

  it('rejects signed Response profiles that are not uniquely request-, issuer-, and success-bound', async () => {
    const cases: Array<[string, (xml: string) => string, RegExp]> = [
      ['response version', (x) => x.replace('Version="2.0"', 'Version="1.1"'), /bind this login request/i],
      ['destination', (x) => x.replace('Destination="http://localhost:3001/api/sso/saml/callback"', 'Destination="https://attacker.example/callback"'), /bind this login request/i],
      ['in-response-to', (x) => x.replace(/InResponseTo="_[A-Za-z0-9]+"/, 'InResponseTo="_differentrequest1234"'), /bind this login request/i],
      ['response issuer', (x) => x.replace('<saml:Issuer>https://saml.example/idp</saml:Issuer>', '<saml:Issuer>https://attacker.example/idp</saml:Issuer>'), /response issuer mismatch/i],
      ['duplicate response issuer', (x) => x.replace('</saml:Issuer>', '</saml:Issuer><saml:Issuer>https://saml.example/idp</saml:Issuer>'), /response issuer mismatch/i],
      ['missing status', (x) => x.replace(/\s*<samlp:Status>[\s\S]*?<\/samlp:Status>/, ''), /status is not Success/i],
      ['duplicate status', (x) => x.replace('</samlp:Status>', '</samlp:Status><samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'), /status is not Success/i],
      ['missing status code', (x) => x.replace(/<samlp:StatusCode[^>]+\/>/, ''), /status is not Success/i],
      ['failure status code', (x) => x.replace('urn:oasis:names:tc:SAML:2.0:status:Success', 'urn:oasis:names:tc:SAML:2.0:status:Responder'), /status is not Success/i],
      ['duplicate status code', (x) => x.replace('</samlp:Status>', '<samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>'), /status is not Success/i],
      ['no direct assertion', (x) => x.replace(/\s*<saml:Assertion[\s\S]*?<\/saml:Assertion>/, ''), /one direct Assertion/i],
      ['nested-only assertion', (x) => x.replace(/(<saml:Assertion[\s\S]*?<\/saml:Assertion>)/, '<samlp:Extensions>$1</samlp:Extensions>'), /one direct Assertion/i],
      ['additional nested assertion', (x) => x.replace('</saml:Subject>', '</saml:Subject><saml:Assertion ID="_nested" Version="2.0"/>'), /exactly one Assertion/i],
    ];
    for (const [_label, mutateResponse, expected] of cases) {
      const flow = await beginSignedSamlFlow();
      const xml = signedSamlProfile({ requestId: flow.requestId, signResponse: true, mutateResponse });
      const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
      }).expect(401);
      expect(rejected.body.detail).toMatch(expected);
    }
  });

  it('rejects signed Assertion profiles with ambiguous identity, authority, time, audience, or subject bindings', async () => {
    const future = new Date(Date.now() + 600_000).toISOString();
    const past = new Date(Date.now() - 600_000).toISOString();
    const cases: Array<[string, (xml: string) => string, RegExp]> = [
      ['assertion version', (x) => x.replace('Version="2.0"', 'Version="1.1"'), /version must be 2.0/i],
      ['missing assertion id', (x) => x.replace(/ ID="_[^"]+"/, ''), /Invalid signed Assertion ID/i],
      ['missing assertion issuer', (x) => x.replace(/\s*<saml:Issuer>[\s\S]*?<\/saml:Issuer>/, ''), /issuer mismatch/i],
      ['wrong assertion issuer', (x) => x.replace('https://saml.example/idp', 'https://attacker.example/idp'), /issuer mismatch/i],
      ['duplicate assertion issuer', (x) => x.replace('</saml:Issuer>', '</saml:Issuer><saml:Issuer>https://saml.example/idp</saml:Issuer>'), /issuer mismatch/i],
      ['missing conditions', (x) => x.replace(/\s*<saml:Conditions[\s\S]*?<\/saml:Conditions>/, ''), /Conditions are required/i],
      ['duplicate conditions', (x) => x.replace(/(<saml:Conditions[\s\S]*?<\/saml:Conditions>)/, '$1$1'), /Conditions are required/i],
      ['unbounded conditions', (x) => x.replace(/ NotBefore="[^"]+"/, ''), /Conditions must be bounded/i],
      ['invalid not-before', (x) => x.replace(/NotBefore="[^"]+"/, 'NotBefore="not-a-time"'), /Invalid SAML NotBefore/i],
      ['future not-before', (x) => x.replace(/NotBefore="[^"]+"/, `NotBefore="${future}"`), /not active yet/i],
      ['expired conditions', (x) => x.replace(/(<saml:Conditions[^>]*NotOnOrAfter=")[^"]+/, `$1${past}`), /assertion expired/i],
      ['missing audience restriction', (x) => x.replace(/\s*<saml:AudienceRestriction>[\s\S]*?<\/saml:AudienceRestriction>/, ''), /audience mismatch/i],
      ['wrong audience', (x) => x.replace('<saml:Audience>bridge-sp</saml:Audience>', '<saml:Audience>another-sp</saml:Audience>'), /audience mismatch/i],
      ['missing subject', (x) => x.replace(/\s*<saml:Subject>[\s\S]*?<\/saml:Subject>/, ''), /one direct Subject/i],
      ['duplicate subject', (x) => x.replace(/(<saml:Subject>[\s\S]*?<\/saml:Subject>)/, '$1$1'), /one direct Subject/i],
      ['wrong confirmation method', (x) => x.replace('urn:oasis:names:tc:SAML:2.0:cm:bearer', 'urn:oasis:names:tc:SAML:2.0:cm:holder-of-key'), /bearer confirmation/i],
      ['missing confirmation data', (x) => x.replace(/\s*<saml:SubjectConfirmationData[^>]+\/>/, ''), /bearer confirmation/i],
      ['duplicate confirmation data', (x) => x.replace(/(<saml:SubjectConfirmationData[^>]+\/>)/, '$1$1'), /bearer confirmation/i],
      ['wrong recipient', (x) => x.replace('Recipient="http://localhost:3001/api/sso/saml/callback"', 'Recipient="https://attacker.example/callback"'), /bearer confirmation/i],
      ['wrong confirmation request', (x) => x.replace(/InResponseTo="_[A-Za-z0-9]+"/, 'InResponseTo="_differentrequest1234"'), /bearer confirmation/i],
      ['missing confirmation expiry', (x) => x.replace(/ NotOnOrAfter="[^"]+"\/>/, '/>'), /bearer confirmation/i],
      ['future confirmation not-before', (x) => x.replace('<saml:SubjectConfirmationData ', `<saml:SubjectConfirmationData NotBefore="${future}" `), /bearer confirmation/i],
      ['invalid confirmation expiry', (x) => x.replace(/NotOnOrAfter="[^"]+"\/>/, 'NotOnOrAfter="not-a-time"/>'), /bearer confirmation/i],
      ['missing name id', (x) => x.replace(/\s*<saml:NameID>[\s\S]*?<\/saml:NameID>/, ''), /exactly one NameID/i],
      ['duplicate name id', (x) => x.replace('</saml:NameID>', '</saml:NameID><saml:NameID>other@example.com</saml:NameID>'), /exactly one NameID/i],
    ];
    for (const [_label, mutateAssertion, expected] of cases) {
      const flow = await beginSignedSamlFlow();
      const xml = signedSamlProfile({ requestId: flow.requestId, mutateAssertion });
      const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
      }).expect(401);
      expect(rejected.body.detail).toMatch(expected);
    }
  });

  it('uses NameID-derived fallbacks when optional SAML attributes are absent', async () => {
    const flow = await beginSignedSamlFlow();
    const xml = signedSamlProfile({
      requestId: flow.requestId,
      mutateAssertion: (x) => x.replace(/\s*<saml:AttributeStatement>[\s\S]*?<\/saml:AttributeStatement>/, ''),
    });
    await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(302);
    expect(mockUsers.create).toHaveBeenCalledWith(expect.objectContaining({
      email: 'profile-user@example.com', displayName: 'profile-user',
    }));
  });

  it('rejects malformed signature envelopes, unsafe XML, external references, weak algorithms, and tampering', async () => {
    const cases: Array<[string, (requestId: string) => string, RegExp]> = [
      ['DTD', (requestId) => `<!DOCTYPE saml [<!ENTITY xxe "blocked">]>${signedSamlProfile({ requestId })}`, /DTD\/entity/i],
      ['ambiguous ID attributes', (requestId) => signedSamlProfile({
        requestId, mutateAssertion: (x) => x.replace(/(ID="_[^"]+")/, '$1 Id="_second-id"'),
      }), /ambiguous ID/i],
      ['missing signature', () => '<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_unsigned" Version="2.0"/>', /Exactly one XML Signature/i],
      ['multiple signatures', (requestId) => signedSamlProfile({ requestId }).replace(
        '</saml:Assertion>', '<ds:Signature xmlns:ds="http://www.w3.org/2000/09/xmldsig#"/></saml:Assertion>',
      ), /Exactly one XML Signature/i],
      ['external reference', (requestId) => signedSamlProfile({ requestId }).replace(/URI="#[^"]+"/, 'URI="https://attacker.example/assertion"'), /direct same-document reference/i],
      ['missing referenced node', (requestId) => signedSamlProfile({ requestId }).replace(/URI="#[^"]+"/, 'URI="#_missing-reference"'), /does not resolve uniquely/i],
      ['SHA-1 signature', (requestId) => signedSamlProfile({
        requestId,
        signatureAlgorithm: 'http://www.w3.org/2000/09/xmldsig#rsa-sha1',
        digestAlgorithm: 'http://www.w3.org/2000/09/xmldsig#sha1',
      }), /disallowed cryptographic algorithm/i],
      ['tampered signed identity', (requestId) => signedSamlProfile({ requestId }).replace('profile-user@example.com', 'tampered-user@example.com'), /signature validation failed/i],
      ['unrecognized signed root', (requestId) => signedSamlProfile({ requestId, otherRoot: true }), /protocol Response or assertion Assertion/i],
    ];
    for (const [_label, build, expected] of cases) {
      const flow = await beginSignedSamlFlow();
      const xml = build(flow.requestId);
      const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
      }).expect(401);
      expect(rejected.body.detail).toMatch(expected);
    }
  });

  it('fails closed when the XML verifier cannot expose exactly one signed reference', async () => {
    const { SignedXml } = require('xml-crypto');

    let flow = await beginSignedSamlFlow();
    let xml = signedSamlProfile({ requestId: flow.requestId });
    const original = SignedXml.prototype.getSignedReferences;
    SignedXml.prototype.getSignedReferences = undefined;
    try {
      const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
      }).expect(401);
      expect(rejected.body.detail).toMatch(/cannot expose signed references/i);
    } finally { SignedXml.prototype.getSignedReferences = original; }

    flow = await beginSignedSamlFlow();
    xml = signedSamlProfile({ requestId: flow.requestId });
    const refsSpy = jest.spyOn(SignedXml.prototype, 'getSignedReferences').mockReturnValue([]);
    try {
      const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
      }).expect(401);
      expect(rejected.body.detail).toMatch(/bind exactly one XML reference/i);
    } finally { refsSpy.mockRestore(); }

    flow = await beginSignedSamlFlow();
    xml = signedSamlProfile({ requestId: flow.requestId });
    const referencesSpy = jest.spyOn(SignedXml.prototype, 'getReferences').mockReturnValue([]);
    try {
      const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
      }).expect(401);
      expect(rejected.body.detail).toMatch(/direct same-document reference/i);
    } finally { referencesSpy.mockRestore(); }
  });

  it('rejects assertion replay even when a second browser ceremony is otherwise bound to the original request', async () => {
    const first = await beginSignedSamlFlow();
    const xml = signedSamlProfile({ requestId: first.requestId });
    await first.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: first.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(302);

    const second = await beginSignedSamlFlow();
    const cache = require('../lib/redisAdapter').cache as any;
    cache.takeAuthoritative.mockResolvedValueOnce({
      requestId: first.requestId,
      spIssuer: 'bridge-sp',
      idpIssuer: 'https://saml.example/idp',
      certDigest: crypto.createHash('sha256').update(samlSigningKeys.publicKey.trim(), 'utf8').digest('hex'),
    });
    const rejected = await second.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: second.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(401);
    expect(rejected.body.detail).toMatch(/replay detected/i);
  });

  it('consumes RelayState before validating bounded base64 and rejects expired/corrupt authoritative flows', async () => {
    const cache = require('../lib/redisAdapter').cache as any;
    for (const flowValue of [null, {}, { requestId: 123 }, { requestId: '_short' }]) {
      const flow = await beginSignedSamlFlow();
      cache.takeAuthoritative.mockResolvedValueOnce(flowValue);
      await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from('<x/>').toString('base64'),
      }).expect(400);
    }

    for (const payload of ['', '****', 'abc']) {
      const flow = await beginSignedSamlFlow();
      await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: payload,
      }).expect(400);
    }
  });

  it('fails closed across SAML state outages and every mutable verification-config boundary', async () => {
    const cache = require('../lib/redisAdapter').cache as any;
    process.env.SAML_ENABLED = 'true';
    process.env.SAML_ENTRY_POINT = 'https://saml.example/login';
    process.env.SAML_ISSUER = 'bridge-sp';
    cache.setAuthoritative.mockRejectedValueOnce('state backend offline');
    await request(app()).get('/api/sso/saml/start').expect(503);

    let flow = await beginSignedSamlFlow();
    cache.takeAuthoritative.mockRejectedValueOnce('state claim offline');
    await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState, SAMLResponse: Buffer.from('<x/>').toString('base64'),
    }).expect(503);

    const mutations: Array<() => void> = [
      () => { process.env.SAML_ENABLED = 'false'; },
      () => { delete process.env.SAML_IDP_CERT; },
      () => { delete process.env.SAML_IDP_ENTITY_ID; },
      () => { process.env.SAML_ISSUER = 'replacement-sp'; },
      () => { process.env.SAML_IDP_CERT = `${samlSigningKeys.publicKey}\nchanged`; },
    ];
    for (const mutate of mutations) {
      flow = await beginSignedSamlFlow();
      mutate();
      const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
        RelayState: flow.relayState, SAMLResponse: Buffer.from('<x/>').toString('base64'),
      });
      expect([400, 503]).toContain(rejected.status);
    }
  });

  it('contains SAML identity and one-time handoff backend failures without exposing credentials', async () => {
    let flow = await beginSignedSamlFlow();
    let xml = signedSamlProfile({ requestId: flow.requestId });
    mockUsers.findBySsoIdentity.mockRejectedValueOnce('identity backend offline');
    await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(403);
    expect(mockMakeToken).not.toHaveBeenCalled();

    flow = await beginSignedSamlFlow(); xml = signedSamlProfile({ requestId: flow.requestId });
    const cache = require('../lib/redisAdapter').cache as any;
    cache.setAuthoritative.mockRejectedValueOnce('handoff backend offline');
    const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(503);
    expect(responseCookies(rejected).join(';')).not.toMatch(/bridge_sso_handoff=/i);

    flow = await beginSignedSamlFlow(); xml = signedSamlProfile({ requestId: flow.requestId });
    mockUsers.findBySsoIdentity.mockRejectedValueOnce(new Error('identity backend failed'));
    await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(403);

    flow = await beginSignedSamlFlow(); xml = signedSamlProfile({ requestId: flow.requestId });
    cache.setAuthoritative.mockRejectedValueOnce(new Error('handoff backend failed'));
    await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(503);
  });

  it('surfaces non-Error replay-store failures only as generic SAML verification rejection', async () => {
    const flow = await beginSignedSamlFlow();
    const xml = signedSamlProfile({ requestId: flow.requestId });
    const cache = require('../lib/redisAdapter').cache as any;
    cache.setIfAbsentAuthoritative.mockRejectedValueOnce('replay backend offline');
    const rejected = await flow.agent.post('/api/sso/saml/callback').type('form').send({
      RelayState: flow.relayState, SAMLResponse: Buffer.from(xml).toString('base64'),
    }).expect(401);
    expect(rejected.body).toEqual({ error: 'SAML assertion verification failed', detail: 'replay backend offline' });
  });

  it('fails closed when authoritative SAML state storage is unavailable and rejects unsafe IdP entry points', async () => {
    const cache = require('../lib/redisAdapter').cache as any;
    process.env.SAML_ENABLED = 'true'; process.env.SAML_ISSUER = 'bridge-sp';
    process.env.SAML_ENTRY_POINT = 'https://saml.example/login';
    cache.setAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    await request(app()).get('/api/sso/saml/start').expect(503);

    const stateWritesBeforeInvalidConfig = cache.setAuthoritative.mock.calls.length;
    for (const entry of ['not a url', 'ftp://saml.example/login', 'https://u:p@saml.example/login']) {
      process.env.SAML_ENTRY_POINT = entry;
      await request(app()).get('/api/sso/saml/start').expect(503);
    }
    expect(cache.setAuthoritative).toHaveBeenCalledTimes(stateWritesBeforeInvalidConfig);
  });

  it('escapes SAML metadata identifiers rather than reflecting XML metacharacters', async () => {
    process.env.SAML_ENABLED = 'true';
    process.env.SAML_ENTRY_POINT = 'https://saml.example/login';
    process.env.SAML_ISSUER = `bridge&\"<issuer>'`;
    const r = await request(app()).get('/api/sso/saml/metadata').expect(200);
    expect(r.headers['content-type']).toMatch(/xml/);
    expect(r.text).toContain('bridge&amp;&quot;&lt;issuer&gt;&apos;');
    expect(r.text).not.toContain(`entityID="bridge&\"<issuer>'"`);
  });

  it('rejects malformed/consumed SAML callbacks before signature work and contains authoritative-state outages', async () => {
    const cache = require('../lib/redisAdapter').cache as any;
    await request(app()).post('/api/sso/saml/callback').type('form').send({ SAMLResponse: '***', RelayState: 'x'.repeat(32) }).expect(400);
    await request(app()).post('/api/sso/saml/callback').type('form').send({ SAMLResponse: Buffer.from('<x/>').toString('base64'), RelayState: 'bad' }).expect(400);

    process.env.SAML_ENABLED = 'true'; process.env.SAML_ENTRY_POINT = 'https://saml.example/login'; process.env.SAML_ISSUER = 'bridge-sp';
    const agent = request.agent(app());
    const start = await agent.get('/api/sso/saml/start').expect(302);
    const relay = new URL(start.headers.location).searchParams.get('RelayState')!;
    cache.takeAuthoritative.mockRejectedValueOnce(new Error('redis down'));
    await agent.post('/api/sso/saml/callback').type('form').send({ RelayState: relay, SAMLResponse: Buffer.from('<x/>').toString('base64') }).expect(503);

    await request(app()).post('/api/sso/saml/callback').type('form').send({ RelayState: 'a'.repeat(32), SAMLResponse: Buffer.from('<x/>').toString('base64') }).expect(400);
  });

  it('rejects non-XML callback bodies and incomplete verification configuration after consuming a valid relay state', async () => {
    process.env.SAML_ENABLED = 'true'; process.env.SAML_ENTRY_POINT = 'https://saml.example/login'; process.env.SAML_ISSUER = 'bridge-sp';
    let agent = request.agent(app());
    let start = await agent.get('/api/sso/saml/start').expect(302);
    let relay = new URL(start.headers.location).searchParams.get('RelayState')!;
    await agent.post('/api/sso/saml/callback').type('form').send({ RelayState: relay, SAMLResponse: Buffer.from('not xml').toString('base64') }).expect(400);

    agent = request.agent(app()); start = await agent.get('/api/sso/saml/start').expect(302); relay = new URL(start.headers.location).searchParams.get('RelayState')!;
    await agent.post('/api/sso/saml/callback').type('form').send({ RelayState: relay, SAMLResponse: Buffer.from('<Response/>').toString('base64') }).expect(503);
  });

  it('server config requires auth, existing server and owner', async () => {
    await request(app()).put('/api/sso/servers/s1/config').send({ ssoConfig: {} }).expect(401);
    mockServers.findById.mockResolvedValue(null);
    await request(app()).put('/api/sso/servers/s1/config').set('x-test-user','u1').send({ ssoConfig: {} }).expect(404);
    mockServers.findById.mockResolvedValue({ _id: 's1', ownerId: 'other' });
    await request(app()).put('/api/sso/servers/s1/config').set('x-test-user','u1').send({ ssoConfig: {} }).expect(403);
  });

  it('owner can persist server SSO config', async () => {
    mockServers.findById.mockResolvedValue({ _id: 's1', ownerId: 'u1' });
    await request(app()).put('/api/sso/servers/s1/config').set('x-test-user','u1').send({ ssoConfig: { required: true } }).expect(200);
    expect(mockServers.update).toHaveBeenCalledWith('s1', { ssoConfig: JSON.stringify({ required: true }) });
  });
});

describe('production-loaded SSO security boundaries', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  afterEach(() => {
    process.env.NODE_ENV = originalNodeEnv;
    for (const key of ['OIDC_ENABLED','OIDC_ISSUER','OIDC_CLIENT_ID','OIDC_CLIENT_SECRET',
      'SAML_ENABLED','SAML_ENTRY_POINT','SAML_ISSUER','SAML_IDP_CERT','SAML_IDP_ENTITY_ID']) delete process.env[key];
    jest.resetModules();
  });

  function loadIsolatedRouter(): any {
    let isolatedRouter: any;
    jest.isolateModules(() => { isolatedRouter = require('../routes/sso'); });
    return isolatedRouter.default ?? isolatedRouter;
  }

  function isolatedApp(isolatedRouter: any) {
    const isolated = express();
    isolated.use(cookieParser());
    isolated.use(express.urlencoded({ extended: false }));
    isolated.use(express.json());
    isolated.use('/api/sso', isolatedRouter);
    return isolated;
  }

  it('fails production startup loudly when enabled SAML lacks verification authority', () => {
    process.env.NODE_ENV = 'production';
    process.env.SAML_ENABLED = 'true';
    delete process.env.SAML_IDP_CERT;
    delete process.env.SAML_IDP_ENTITY_ID;
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    try {
      loadIsolatedRouter();
      expect(exitSpy).toHaveBeenCalledWith(1);
    } finally { exitSpy.mockRestore(); }
  });

  it('warns in non-production for incomplete enabled SAML without terminating the process', () => {
    process.env.NODE_ENV = 'test';
    process.env.SAML_ENABLED = 'true';
    delete process.env.SAML_IDP_CERT;
    delete process.env.SAML_IDP_ENTITY_ID;
    const exitSpy = jest.spyOn(process, 'exit');
    loadIsolatedRouter();
    expect(exitSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
  });

  it('enforces HTTPS endpoints and cross-site secure SAML binding cookies in production', async () => {
    process.env.NODE_ENV = 'production';
    process.env.SAML_ENABLED = 'true';
    process.env.SAML_ENTRY_POINT = 'https://saml.example/login';
    process.env.SAML_ISSUER = 'bridge-sp';
    process.env.SAML_IDP_CERT = samlSigningKeys.publicKey;
    process.env.SAML_IDP_ENTITY_ID = 'https://saml.example/idp';
    process.env.OIDC_ENABLED = 'true';
    process.env.OIDC_ISSUER = 'https://issuer.example';
    process.env.OIDC_CLIENT_ID = 'client-1';
    const isolatedRouter = loadIsolatedRouter();
    const isolated = isolatedApp(isolatedRouter);

    const samlStart = await request(isolated).get('/api/sso/saml/start').expect(302);
    expect(responseCookies(samlStart).join(';')).toMatch(/Secure;.*SameSite=None/i);

    process.env.SAML_ENTRY_POINT = 'http://saml.example/login';
    await request(isolated).get('/api/sso/saml/start').expect(503);

    mockFetchT.mockReset();
    mockFetchT.mockResolvedValueOnce(jsonResponse({
      issuer: 'https://issuer.example',
      authorization_endpoint: 'http://idp.example/auth',
      token_endpoint: 'https://idp.example/token',
      jwks_uri: 'https://idp.example/jwks',
    }));
    await request(isolated).get('/api/sso/oidc/start').expect(503);
  });
});
