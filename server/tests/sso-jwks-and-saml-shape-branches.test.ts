// server/tests/sso-jwks-and-saml-shape-branches.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SSO — JWKS SEÇİMİ, HESAP BAĞI VE İMZALANMIŞ SAML BELGE ŞEKLİ
// ════════════════════════════════════════════════════════════════════════════
//
// `tests/sso-deep-behavior.test.ts` mutlu yolu ve klasik saldırıları kapsar.
// Bu tamamlayıcı takım, kimlik doğrulamanın YANLIŞ BİÇİMLİ girdiye verdiği
// tepkiyi ölçer — çünkü gerçek IdP'ler bozuk anahtar, eksik öznitelik ve
// eksik XML niteliği gönderir ve bunların hepsinin FAIL-CLOSED olması gerekir:
//
//   · JWKS SEÇİMİ — bozuk bir anahtar girdisi ne çökme ne de kabul üretir;
//     atlanır ve aynı `kid` altındaki geçerli anahtar kullanılır.
//   · HESAP BAĞI — mevcut bir SSO hesabı yalnız (sağlayıcı, issuer, subject)
//     ÜÇLÜSÜ birebir eşleşirse açılır. Eksik alan "eşleşti" saymaz.
//   · SAML BELGE ŞEKLİ — imzalanmış referansta EKSİK bir XML niteliği asla
//     "kontrol geçildi" anlamına gelmemelidir; her eksik nitelik reddedilir.
//
// Her testin iddiası davranışsaldır: HTTP sonucu, çağrılan/çağrılmayan
// bağımlılık ya da yazılan kullanıcı satırı.

process.env.NODE_ENV = 'test';
process.env.JWT_SECRET = 'test-jwt-secret-32-chars-padded!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-32-chars-pad!';

const mockFetchB = jest.fn();
class BranchSSRFError extends Error {
  hostname: string;
  constructor(message = 'blocked', hostname = 'blocked.test') {
    super(message); this.name = 'SSRFError'; this.hostname = hostname;
  }
}

const branchUsers = {
  findByEmail: jest.fn(), findBySsoIdentity: jest.fn(), findLegacySsoIdentity: jest.fn(),
  claimSsoIdentity: jest.fn(), upgradeLegacySsoIdentity: jest.fn(),
  create: jest.fn(), update: jest.fn(), findById: jest.fn(),
};
const branchServers = { findById: jest.fn(), update: jest.fn() };

jest.mock('../lib/fetch', () => ({
  fetchT: (...args: unknown[]) => mockFetchB(...args),
  SSRFError: BranchSSRFError,
}));
jest.mock('../db/repositories', () => ({ Users: branchUsers, Servers: branchServers }));
jest.mock('../middleware/auth', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    const id = req.headers['x-test-user'];
    if (!id) return res.status(401).json({ error: 'Unauthorized' });
    // A deliberately identity-less pass-through: proves the ownership guard
    // fails closed instead of trusting that some earlier middleware ran.
    if (id !== 'no-identity') req.user = { id: String(id), username: String(id) };
    return next();
  },
  makeToken: () => 'access-token-that-is-deliberately-long-enough-for-validation',
  makeRefreshToken: async () => 'refresh-token',
  revokeRefreshToken: async () => undefined,
}));

import express from 'express';
import cookieParser from 'cookie-parser';
import request from 'supertest';
import crypto from 'crypto';
import zlib from 'zlib';
import jwt from 'jsonwebtoken';
import ssoRouter from '../routes/sso';

const ACS = 'http://localhost:3001/api/sso/saml/callback';
const IDP_ISSUER = 'https://saml.example/idp';
const SP_ISSUER = 'bridge-sp';

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

function idTokenWithKid(kid = 'kid-1') {
  return `${Buffer.from(JSON.stringify({ alg: 'RS256', kid })).toString('base64url')}.e30.sig`;
}

const samlKeys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

beforeEach(() => {
  jest.clearAllMocks();
  for (const k of ['OIDC_ENABLED', 'OIDC_ISSUER', 'OIDC_CLIENT_ID', 'OIDC_CLIENT_SECRET', 'OIDC_SCOPES',
    'OIDC_REQUIRE_EMAIL_VERIFIED', 'OIDC_LEGACY_ISSUER', 'SAML_ENABLED', 'SAML_ENTRY_POINT', 'SAML_ISSUER',
    'SAML_IDP_CERT', 'SAML_IDP_ENTITY_ID', 'SAML_LEGACY_IDP_ENTITY_ID']) delete process.env[k];
  branchUsers.findByEmail.mockResolvedValue(null);
  branchUsers.findBySsoIdentity.mockResolvedValue(null);
  branchUsers.findLegacySsoIdentity.mockResolvedValue(null);
  branchUsers.claimSsoIdentity.mockResolvedValue(true);
  branchUsers.upgradeLegacySsoIdentity.mockResolvedValue(true);
  branchUsers.create.mockImplementation(async (u: any) => u);
  branchUsers.update.mockResolvedValue(true);
  branchUsers.findById.mockResolvedValue(null);
  branchServers.findById.mockResolvedValue(null);
  branchServers.update.mockResolvedValue(true);
});

// ─────────────────────────────────────────────────────────────────────────────
// OIDC yardımcıları
// ─────────────────────────────────────────────────────────────────────────────

function enableOidc(issuer: string) {
  process.env.OIDC_ENABLED = 'true';
  process.env.OIDC_ISSUER = issuer;
  process.env.OIDC_CLIENT_ID = 'client-1';
  process.env.OIDC_CLIENT_SECRET = 'secret-1';
}

function discoveryFor(issuer: string) {
  return {
    issuer,
    authorization_endpoint: 'https://idp.example/auth',
    token_endpoint: 'https://token.example/token',
    // Fresh JWKS URI per flow: the router caches JWKS by URI for 60s and a
    // shared URI would let one test's key list answer another test's lookup.
    jwks_uri: `https://jwks-${crypto.randomBytes(6).toString('hex')}.example/keys`,
  };
}

async function beginOidcFlow(options: { publicClient?: boolean } = {}) {
  const issuer = `https://issuer-${crypto.randomBytes(5).toString('hex')}.example`;
  enableOidc(issuer);
  if (options.publicClient) delete process.env.OIDC_CLIENT_SECRET;
  const discovery = discoveryFor(issuer);
  const agent = request.agent(app());
  mockFetchB.mockResolvedValueOnce(jsonResponse(discovery));
  const start = await agent.get('/api/sso/oidc/start').expect(302);
  const target = new URL(start.headers.location);
  return {
    agent, issuer, discovery,
    state: target.searchParams.get('state')!,
    nonce: target.searchParams.get('nonce')!,
  };
}

type OidcFlow = Awaited<ReturnType<typeof beginOidcFlow>>;

/** Queues discovery + token + JWKS and pins verified claims. Returns a restore fn. */
function primeCallback(flow: OidcFlow, jwks: unknown[], claims: Record<string, unknown>) {
  mockFetchB.mockResolvedValueOnce(jsonResponse(flow.discovery))
    .mockResolvedValueOnce(jsonResponse({ id_token: idTokenWithKid() }))
    .mockResolvedValueOnce(jsonResponse({ keys: jwks }));
  const keySpy = jest.spyOn(crypto, 'createPublicKey')
    .mockReturnValue({ export: () => 'PUBLIC KEY' } as never);
  const now = Math.floor(Date.now() / 1000);
  const verifySpy = jest.spyOn(jwt, 'verify').mockReturnValue({
    email: 'branch-user@example.com', email_verified: true, sub: 'subject-1',
    nonce: flow.nonce, aud: 'client-1', iat: now, exp: now + 300, ...claims,
  } as never);
  return { keySpy, restore: () => { keySpy.mockRestore(); verifySpy.mockRestore(); } };
}

const GOOD_JWK = { kid: 'kid-1', kty: 'RSA', n: 'the-only-usable-modulus', e: 'AQAB' };

describe('OIDC — JWKS entry selection tolerates a malformed key set', () => {
  it('skips structurally invalid entries and authenticates with the usable key', async () => {
    const flow = await beginOidcFlow();
    // Every row advertises the same kid, so only the structural checks can
    // separate them. A crash here would be an outage; an accept would be a
    // signature bypass.
    const primed = primeCallback(flow, [
      { kid: 'kid-1', kty: 42 },                                  // kty is not a string
      { kid: 'kid-1', kty: '' },                                  // kty is empty
      { kid: 'kid-1', kty: 'RSA', e: 'AQAB' },                    // RSA without modulus
      { kid: 'kid-1', kty: 'RSA', n: 'x' },                       // RSA without exponent
      { kid: 'kid-1', kty: 'EC', x: 'a', y: 'b' },                // EC without curve
      { kid: 'kid-1', kty: 'EC', crv: 'P-256', y: 'b' },          // EC without x
      { kid: 'kid-1', kty: 'EC', crv: 'P-256', x: 'a' },          // EC without y
      GOOD_JWK,
    ], {});
    try {
      const r = await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(302);
      expect(r.headers.location).toContain('/sso-callback');
      // Only the well-formed row ever reached key import.
      expect(primed.keySpy).toHaveBeenCalledTimes(1);
      expect(primed.keySpy.mock.calls[0]![0]).toMatchObject({ key: GOOD_JWK, format: 'jwk' });
    } finally { primed.restore(); }
  });

  it('a key set that is entirely malformed fails closed instead of importing junk', async () => {
    const flow = await beginOidcFlow();
    // Discovery + token + JWKS, then a forced refresh re-reads the JWKS once.
    mockFetchB.mockResolvedValueOnce(jsonResponse(flow.discovery))
      .mockResolvedValueOnce(jsonResponse({ id_token: idTokenWithKid() }))
      .mockResolvedValue(jsonResponse({ keys: [{ kid: 'kid-1', kty: 'RSA', e: 'AQAB' }] }));
    const keySpy = jest.spyOn(crypto, 'createPublicKey');
    try {
      const r = await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(401);
      expect(r.body.error).toBe('id_token verification failed');
      expect(keySpy).not.toHaveBeenCalled();
    } finally { keySpy.mockRestore(); }
  });
});

describe('OIDC — token request and claim shape', () => {
  it('a public client sends no client_secret at all', async () => {
    const flow = await beginOidcFlow({ publicClient: true });
    const primed = primeCallback(flow, [GOOD_JWK], {});
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(302);
      const tokenCall = mockFetchB.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
      expect(tokenCall).toBeDefined();
      const body = new URLSearchParams(String((tokenCall as any[])[1].body));
      expect(body.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
      expect(body.has('client_secret')).toBe(false);
    } finally { primed.restore(); }
  });

  it('a confidential client still authenticates with its secret', async () => {
    const flow = await beginOidcFlow();
    const primed = primeCallback(flow, [GOOD_JWK], {});
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(302);
      const tokenCall = mockFetchB.mock.calls.find(([, init]: any[]) => init?.method === 'POST');
      const body = new URLSearchParams(String((tokenCall as any[])[1].body));
      expect(body.get('client_secret')).toBe('secret-1');
    } finally { primed.restore(); }
  });

  it('a verified id_token without an email claim cannot create an account', async () => {
    const flow = await beginOidcFlow();
    const primed = primeCallback(flow, [GOOD_JWK], { email: undefined });
    try {
      const r = await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(400);
      expect(r.body.error).toBe('Required OIDC claims are missing');
      expect(branchUsers.create).not.toHaveBeenCalled();
    } finally { primed.restore(); }
  });

  it('a blank name claim falls back to the generated username, never to an empty display name', async () => {
    const flow = await beginOidcFlow();
    const primed = primeCallback(flow, [GOOD_JWK], { name: '', email: 'Blank.Name@Example.COM' });
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(302);
      const created = branchUsers.create.mock.calls[0]![0] as Record<string, unknown>;
      expect(created.email).toBe('blank.name@example.com');
      expect(created.username).toMatch(/^blank_name_[0-9a-f]{6}$/);
      expect(created.displayName).toBe(created.username);
    } finally { primed.restore(); }
  });
});

describe('OIDC — existing account binding requires the full identity triple', () => {
  const cases: Array<{ name: string; row: Record<string, unknown> }> = [
    { name: 'different provider', row: { ssoProvider: 'saml', ssoIssuer: 'x', ssoId: 'subject-1' } },
    { name: 'absent issuer', row: { ssoProvider: 'oidc', ssoId: 'subject-1' } },
    { name: 'absent subject', row: { ssoProvider: 'oidc', ssoIssuer: 'MATCH' } },
    { name: 'null subject', row: { ssoProvider: 'oidc', ssoIssuer: 'MATCH', ssoId: null } },
    { name: 'different subject', row: { ssoProvider: 'oidc', ssoIssuer: 'MATCH', ssoId: 'someone-else' } },
  ];

  for (const { name, row } of cases) {
    it(`refuses to open an account bound with a ${name}`, async () => {
      const flow = await beginOidcFlow();
      branchUsers.findByEmail.mockResolvedValue({
        _id: 'existing', email: 'branch-user@example.com',
        ...row, ...(row.ssoIssuer === 'MATCH' ? { ssoIssuer: flow.issuer } : {}),
      });
      const primed = primeCallback(flow, [GOOD_JWK], {});
      try {
        const r = await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(403);
        expect(r.body.error).toBe('SSO identity does not match this account');
        // A rejected binding must never mutate the account it failed to match.
        expect(branchUsers.claimSsoIdentity).not.toHaveBeenCalled();
        expect(branchUsers.update).not.toHaveBeenCalled();
      } finally { primed.restore(); }
    });
  }

  it('opens the account when provider, issuer and subject all match exactly', async () => {
    const flow = await beginOidcFlow();
    branchUsers.findByEmail.mockResolvedValue({
      _id: 'existing', email: 'branch-user@example.com',
      ssoProvider: 'oidc', ssoIssuer: flow.issuer, ssoId: 'subject-1',
    });
    const primed = primeCallback(flow, [GOOD_JWK], {});
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(302);
      expect(branchUsers.create).not.toHaveBeenCalled();
      expect(branchUsers.claimSsoIdentity).not.toHaveBeenCalled();
    } finally { primed.restore(); }
  });

  it('an approved legacy issuer with no legacy row still provisions a normal account', async () => {
    const flow = await beginOidcFlow();
    process.env.OIDC_LEGACY_ISSUER = flow.issuer;
    branchUsers.findLegacySsoIdentity.mockResolvedValue(null);
    const primed = primeCallback(flow, [GOOD_JWK], {});
    try {
      await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(302);
      expect(branchUsers.findLegacySsoIdentity).toHaveBeenCalledWith('oidc', 'subject-1');
      expect(branchUsers.upgradeLegacySsoIdentity).not.toHaveBeenCalled();
      expect(branchUsers.create).toHaveBeenCalledTimes(1);
      expect(branchUsers.create.mock.calls[0]![0]).toMatchObject({ ssoIssuer: flow.issuer });
    } finally { primed.restore(); }
  });
});

describe('OIDC/handoff — non-Error store failures are reported, not swallowed', () => {
  function cacheMock() {
    return require('../lib/redisAdapter').cache as Record<string, jest.Mock>;
  }

  it('a rejected authorization-state write is a 503 and never redirects to the IdP', async () => {
    enableOidc('https://issuer-store.example');
    mockFetchB.mockResolvedValueOnce(jsonResponse(discoveryFor('https://issuer-store.example')));
    cacheMock().setAuthoritative!.mockRejectedValueOnce('oidc state backend offline');
    const r = await request(app()).get('/api/sso/oidc/start').expect(503);
    expect(r.body.error).toBe('OIDC login state is temporarily unavailable');
    expect(r.headers.location).toBeUndefined();
  });

  it('a rejected authorization-state claim is a 503 and never exchanges the code', async () => {
    const flow = await beginOidcFlow();
    const callsBefore = mockFetchB.mock.calls.length;
    cacheMock().takeAuthoritative!.mockRejectedValueOnce('oidc state claim offline');
    const r = await flow.agent.get(`/api/sso/oidc/callback?code=abc&state=${flow.state}`).expect(503);
    expect(r.body.error).toBe('OIDC login state is temporarily unavailable');
    expect(mockFetchB).toHaveBeenCalledTimes(callsBefore);
  });

  it('a rejected handoff claim is a 503 and still clears the one-time cookie', async () => {
    const handoff = crypto.randomBytes(32).toString('base64url');
    cacheMock().takeAuthoritative!.mockRejectedValueOnce('handoff backend offline');
    const r = await request(app()).post('/api/sso/session')
      .set('Cookie', `bridge_sso_handoff=${handoff}`).expect(503);
    expect(r.body.error).toBe('SSO session handoff is temporarily unavailable');
    expect(r.body.token).toBeUndefined();
    expect(String(r.headers['set-cookie'])).toContain('bridge_sso_handoff=;');
  });
});

describe('server SSO config ownership guard', () => {
  it('fails closed with 401 when the request reaches the guard without an identity', async () => {
    branchServers.findById.mockResolvedValue({ _id: 's1', ownerId: 'u1' });
    const r = await request(app()).put('/api/sso/servers/s1/config')
      .set('x-test-user', 'no-identity').send({ ssoConfig: { required: true } }).expect(401);
    expect(r.body.error).toBe('Unauthorized');
    expect(branchServers.update).not.toHaveBeenCalled();
  });

  it('a missing server is a 404 before ownership is even considered', async () => {
    branchServers.findById.mockResolvedValue(null);
    await request(app()).put('/api/sso/servers/ghost/config')
      .set('x-test-user', 'u1').send({ ssoConfig: {} }).expect(404);
    expect(branchServers.update).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// SAML — imzalanmış belge şekli
// ─────────────────────────────────────────────────────────────────────────────

interface AssertionSpec {
  requestId: string;
  version?: string | null;
  idAttribute?: 'ID' | 'Id' | null;
  issuer?: string;
  notBefore?: string | null;
  notOnOrAfter?: string | null;
  audience?: string;
  confirmationMethod?: string | null;
  recipient?: string | null;
  inResponseTo?: string | null;
  confirmationExpiry?: string | null;
  confirmationNotBefore?: string | null;
  attributes?: string;
  extraChild?: string;
}

function attr(name: string, value: string | null | undefined): string {
  return value === null || value === undefined ? '' : ` ${name}="${value}"`;
}

function buildAssertion(spec: AssertionSpec): { xml: string; id: string } {
  const now = Date.now();
  const id = `_assertion${crypto.randomBytes(10).toString('hex')}`;
  const idAttrName = spec.idAttribute === undefined ? 'ID' : spec.idAttribute;
  const version = spec.version === undefined ? '2.0' : spec.version;
  const notBefore = spec.notBefore === undefined ? new Date(now - 60_000).toISOString() : spec.notBefore;
  const notOnOrAfter = spec.notOnOrAfter === undefined ? new Date(now + 300_000).toISOString() : spec.notOnOrAfter;
  const method = spec.confirmationMethod === undefined ? 'urn:oasis:names:tc:SAML:2.0:cm:bearer' : spec.confirmationMethod;
  const recipient = spec.recipient === undefined ? ACS : spec.recipient;
  const inResponseTo = spec.inResponseTo === undefined ? spec.requestId : spec.inResponseTo;
  const expiry = spec.confirmationExpiry === undefined ? new Date(now + 300_000).toISOString() : spec.confirmationExpiry;
  const attributes = spec.attributes ?? `
      <saml:Attribute Name="email"><saml:AttributeValue>shape-user@example.com</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="displayName"><saml:AttributeValue>Shape User</saml:AttributeValue></saml:Attribute>`;

  const xml = `<saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"${
    idAttrName === null ? '' : attr(idAttrName, id)
  }${attr('Version', version)} IssueInstant="${new Date(now).toISOString()}">
    <saml:Issuer>${spec.issuer ?? IDP_ISSUER}</saml:Issuer>
    ${spec.extraChild ?? ''}
    <saml:Subject>
      <saml:NameID>shape-user@example.com</saml:NameID>
      <saml:SubjectConfirmation${attr('Method', method)}>
        <saml:SubjectConfirmationData${attr('Recipient', recipient)}${attr('InResponseTo', inResponseTo)}${
          attr('NotOnOrAfter', expiry)}${attr('NotBefore', spec.confirmationNotBefore)}/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions${attr('NotBefore', notBefore)}${attr('NotOnOrAfter', notOnOrAfter)}>
      <saml:AudienceRestriction><saml:Audience>${spec.audience ?? SP_ISSUER}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AttributeStatement>${attributes}
    </saml:AttributeStatement>
  </saml:Assertion>`;
  return { xml, id };
}

interface ResponseSpec {
  version?: string | null;
  destination?: string | null;
  inResponseTo?: string | null;
  statusValue?: string | null;
  issuer?: string;
}

function signXml(document: string, targetLocalName: string): string {
  const { SignedXml } = require('xml-crypto');
  const signer = new SignedXml({ privateKey: samlKeys.privateKey });
  signer.signatureAlgorithm = 'http://www.w3.org/2001/04/xmldsig-more#rsa-sha256';
  signer.canonicalizationAlgorithm = 'http://www.w3.org/2001/10/xml-exc-c14n#';
  signer.addReference({
    xpath: `//*[local-name(.)='${targetLocalName}']`,
    transforms: [
      'http://www.w3.org/2000/09/xmldsig#enveloped-signature',
      'http://www.w3.org/2001/10/xml-exc-c14n#',
    ],
    digestAlgorithm: 'http://www.w3.org/2001/04/xmlenc#sha256',
  });
  signer.computeSignature(document);
  return signer.getSignedXml();
}

/** Signs the Assertion itself; the router then sees an Assertion-rooted reference. */
function signedAssertion(spec: AssertionSpec): string {
  return signXml(buildAssertion(spec).xml, 'Assertion');
}

/** Signs the whole Response; the router then also enforces the protocol envelope. */
function signedResponse(assertionSpec: AssertionSpec, responseSpec: ResponseSpec = {}): string {
  const assertion = buildAssertion(assertionSpec);
  const version = responseSpec.version === undefined ? '2.0' : responseSpec.version;
  const destination = responseSpec.destination === undefined ? ACS : responseSpec.destination;
  const inResponseTo = responseSpec.inResponseTo === undefined ? assertionSpec.requestId : responseSpec.inResponseTo;
  const statusValue = responseSpec.statusValue === undefined
    ? 'urn:oasis:names:tc:SAML:2.0:status:Success' : responseSpec.statusValue;
  const document = `<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response${
    crypto.randomBytes(10).toString('hex')}"${attr('Version', version)}${attr('Destination', destination)}${
    attr('InResponseTo', inResponseTo)}>
      <saml:Issuer>${responseSpec.issuer ?? IDP_ISSUER}</saml:Issuer>
      <samlp:Status><samlp:StatusCode${attr('Value', statusValue)}/></samlp:Status>
      ${assertion.xml}
    </samlp:Response>`;
  return signXml(document, 'Response');
}

async function beginSamlFlow() {
  process.env.SAML_ENABLED = 'true';
  process.env.SAML_ENTRY_POINT = 'https://saml.example/login';
  process.env.SAML_ISSUER = SP_ISSUER;
  process.env.SAML_IDP_CERT = samlKeys.publicKey;
  process.env.SAML_IDP_ENTITY_ID = IDP_ISSUER;
  const agent = request.agent(app());
  const start = await agent.get('/api/sso/saml/start').expect(302);
  const target = new URL(start.headers.location);
  const relayState = target.searchParams.get('RelayState')!;
  const requestXml = zlib.inflateRawSync(
    Buffer.from(target.searchParams.get('SAMLRequest')!, 'base64'),
  ).toString('utf8');
  const requestId = requestXml.match(/\bID="([^"]+)"/)?.[1];
  if (!requestId) throw new Error('test AuthnRequest did not contain an ID');
  return { agent, relayState, requestId };
}

async function postSaml(flow: Awaited<ReturnType<typeof beginSamlFlow>>, xml: string) {
  return flow.agent.post('/api/sso/saml/callback').type('form').send({
    RelayState: flow.relayState,
    SAMLResponse: Buffer.from(xml, 'utf8').toString('base64'),
  });
}

describe('SAML — a missing XML attribute is a rejection, never a passed check', () => {
  const assertionCases: Array<{ name: string; spec: (requestId: string) => AssertionSpec; detail: RegExp }> = [
    {
      name: 'Assertion without a Version attribute',
      spec: (requestId) => ({ requestId, version: null }),
      detail: /Assertion version must be 2\.0/i,
    },
    {
      name: 'Assertion without any ID attribute',
      spec: (requestId) => ({ requestId, idAttribute: null }),
      detail: /Invalid signed Assertion ID/i,
    },
    {
      name: 'Conditions without NotBefore',
      spec: (requestId) => ({ requestId, notBefore: null }),
      detail: /Conditions must be bounded/i,
    },
    {
      name: 'Conditions without NotOnOrAfter',
      spec: (requestId) => ({ requestId, notOnOrAfter: null }),
      detail: /Conditions must be bounded/i,
    },
    {
      name: 'SubjectConfirmation without a Method attribute',
      spec: (requestId) => ({ requestId, confirmationMethod: null }),
      detail: /bearer confirmation does not bind/i,
    },
    {
      name: 'SubjectConfirmationData without a Recipient',
      spec: (requestId) => ({ requestId, recipient: null }),
      detail: /bearer confirmation does not bind/i,
    },
    {
      name: 'SubjectConfirmationData without an InResponseTo',
      spec: (requestId) => ({ requestId, inResponseTo: null }),
      detail: /bearer confirmation does not bind/i,
    },
    {
      name: 'SubjectConfirmationData without a NotOnOrAfter',
      spec: (requestId) => ({ requestId, confirmationExpiry: null }),
      detail: /bearer confirmation does not bind/i,
    },
    {
      name: 'SubjectConfirmationData that is not valid yet',
      spec: (requestId) => ({
        requestId,
        confirmationNotBefore: new Date(Date.now() + 3_600_000).toISOString(),
      }),
      detail: /bearer confirmation does not bind/i,
    },
    {
      name: 'an audience that is not this service provider',
      spec: (requestId) => ({ requestId, audience: 'someone-else-sp' }),
      detail: /audience mismatch/i,
    },
  ];

  for (const { name, spec, detail } of assertionCases) {
    it(`rejects ${name}`, async () => {
      const flow = await beginSamlFlow();
      const r = await postSaml(flow, signedResponse(spec(flow.requestId)));
      expect(r.status).toBe(401);
      expect(r.body.error).toBe('SAML assertion verification failed');
      expect(r.body.detail).toMatch(detail);
      expect(branchUsers.create).not.toHaveBeenCalled();
    });
  }

  it('rejects a lower-case Id attribute: SAML 2.0 mandates the upper-case ID', async () => {
    // Measured with @xmldom 0.8: getAttribute() returns '' rather than null for
    // an absent attribute, so the `?? getAttribute('Id')` fallback in the
    // router never fires. That leaves the stricter, spec-conformant reading in
    // force -- saml-core-2.0-os 2.3.3 requires `ID` -- and a non-conformant IdP
    // is refused instead of silently accepted under a looser ID rule than the
    // one the signature reference was resolved with.
    const flow = await beginSamlFlow();
    const r = await postSaml(flow, signedResponse({ requestId: flow.requestId, idAttribute: 'Id' }));
    expect(r.status).toBe(401);
    expect(r.body.detail).toMatch(/Invalid signed Assertion ID/i);
    expect(branchUsers.create).not.toHaveBeenCalled();
  });

  it('a namespace-less element inside the Assertion is ignored, not mistaken for SAML', async () => {
    const flow = await beginSamlFlow();
    // `<Conditions/>` without the SAML namespace must not satisfy the
    // Conditions requirement, and must not break the real one either.
    const r = await postSaml(flow, signedResponse({
      requestId: flow.requestId,
      extraChild: '<Conditions NotBefore="1999-01-01T00:00:00Z" NotOnOrAfter="1999-01-02T00:00:00Z"/>',
    }));
    expect(r.status).toBe(302);
    expect(branchUsers.create).toHaveBeenCalledTimes(1);
  });
});

describe('SAML — the protocol envelope must bind this exact login request', () => {
  const responseCases: Array<{ name: string; spec: ResponseSpec; detail: RegExp }> = [
    { name: 'no Version attribute', spec: { version: null }, detail: /does not bind this login request/i },
    { name: 'no Destination attribute', spec: { destination: null }, detail: /does not bind this login request/i },
    { name: 'a Destination for another service', spec: { destination: 'https://evil.test/acs' }, detail: /does not bind this login request/i },
    { name: 'no InResponseTo attribute', spec: { inResponseTo: null }, detail: /does not bind this login request/i },
    { name: 'an InResponseTo for another request', spec: { inResponseTo: '_someotherrequestid0123456789' }, detail: /does not bind this login request/i },
    { name: 'a StatusCode without a Value', spec: { statusValue: null }, detail: /status is not Success/i },
    { name: 'a non-success StatusCode', spec: { statusValue: 'urn:oasis:names:tc:SAML:2.0:status:Requester' }, detail: /status is not Success/i },
    { name: 'an Issuer from another IdP', spec: { issuer: 'https://other.example/idp' }, detail: /response issuer mismatch/i },
  ];

  for (const { name, spec, detail } of responseCases) {
    it(`rejects a signed Response with ${name}`, async () => {
      const flow = await beginSamlFlow();
      const r = await postSaml(flow, signedResponse({ requestId: flow.requestId }, spec));
      expect(r.status).toBe(401);
      expect(r.body.detail).toMatch(detail);
      expect(branchUsers.create).not.toHaveBeenCalled();
    });
  }

  it('a bare signed Assertion skips envelope checks but still binds the request', async () => {
    const flow = await beginSamlFlow();
    const ok = await postSaml(flow, signedAssertion({ requestId: flow.requestId }));
    expect(ok.status).toBe(302);

    const other = await beginSamlFlow();
    const rejected = await postSaml(other, signedAssertion({ requestId: '_notthisrequest0123456789' }));
    expect(rejected.status).toBe(401);
    expect(rejected.body.detail).toMatch(/bearer confirmation does not bind/i);
  });
});

describe('SAML — attribute statement parsing', () => {
  it('an Attribute without a Name is skipped rather than treated as the identity', async () => {
    const flow = await beginSamlFlow();
    const r = await postSaml(flow, signedResponse({
      requestId: flow.requestId,
      attributes: `
      <saml:Attribute><saml:AttributeValue>attacker@evil.test</saml:AttributeValue></saml:Attribute>
      <saml:Attribute Name="email"><saml:AttributeValue>named@example.com</saml:AttributeValue></saml:Attribute>`,
    }));
    expect(r.status).toBe(302);
    expect(branchUsers.create.mock.calls[0]![0]).toMatchObject({ email: 'named@example.com' });
  });

  it('an empty email Attribute does not blank the identity; a later alias supplies it', async () => {
    const flow = await beginSamlFlow();
    const r = await postSaml(flow, signedResponse({
      requestId: flow.requestId,
      attributes: `
      <saml:Attribute Name="email"/>
      <saml:Attribute Name="mail"><saml:AttributeValue>alias@example.com</saml:AttributeValue></saml:Attribute>`,
    }));
    expect(r.status).toBe(302);
    expect(branchUsers.create.mock.calls[0]![0]).toMatchObject({ email: 'alias@example.com' });
  });

  it('with no display-name attribute the local part of the email is used', async () => {
    const flow = await beginSamlFlow();
    const r = await postSaml(flow, signedResponse({
      requestId: flow.requestId,
      attributes: '\n      <saml:Attribute Name="email"><saml:AttributeValue>only.email@example.com</saml:AttributeValue></saml:Attribute>',
    }));
    expect(r.status).toBe(302);
    expect(branchUsers.create.mock.calls[0]![0]).toMatchObject({
      email: 'only.email@example.com',
      displayName: 'only.email',
    });
  });

  it('an IdP certificate supplied without PEM armour is wrapped and still fails closed when it is not a certificate', async () => {
    const flow = await beginSamlFlow();
    // Same key material, PEM armour stripped: the router re-wraps it as a
    // CERTIFICATE, which it is not — the signature must not verify.
    process.env.SAML_IDP_CERT = samlKeys.publicKey
      .replace(/-----(BEGIN|END) PUBLIC KEY-----/g, '').replace(/\s+/g, '');
    const r = await postSaml(flow, signedResponse({ requestId: flow.requestId }));
    expect(r.status).toBe(400);
    // The flow was bound to the certificate digest recorded at /saml/start, so
    // swapping the verification key mid-ceremony is refused before parsing.
    expect(r.body.error).toMatch(/configuration changed during the flow/i);
  });
});
