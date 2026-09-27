process.env.NODE_ENV = 'test';
import fs from 'fs';
import path from 'path';

const source = fs.readFileSync(path.join(__dirname, '../routes/sso.ts'), 'utf8');

describe('SSO production security contract', () => {
  test('OIDC uses real RFC7636 PKCE and binds nonce to the verified id_token', () => {
    expect(source).toContain("code_challenge: codeChallenge");
    expect(source).toContain("code_challenge_method: 'S256'");
    expect(source).toContain('code_verifier: codeVerifier');
    expect(source).toContain("claims.nonce !== 'string'");
    expect(source).toContain("id_token nonce mismatch");
    expect(source).toContain("claims.email_verified !== true");
  });

  test('authorization state is browser-bound and token secrets cannot cross redirects', () => {
    expect(source).toContain('flowBindingCookieName');
    expect(source).toContain("sameSite: kind === 'saml' && IS_PROD ? 'none' as const : 'lax' as const");
    expect(source).toContain("flowKey('oidc', `${state}.${browserBinding}`)");
    expect(source).toContain("flowKey('saml', `${relayState}.${browserBinding}`)");
    expect(source).toContain('SAML login configuration changed during the flow');
    expect(source).toContain("redirect: 'error'");
  });

  test('existing SSO accounts require provider and external subject binding, not email alone', () => {
    expect(source).toContain("String(user.ssoProvider ?? '') === provider");
    expect(source).toContain("String(user.ssoIssuer ?? '') === issuer");
    expect(source).toContain("String(user.ssoId ?? '') === externalId");
    expect(source).toContain('Users.claimSsoIdentity');
    expect(source).toContain('SSO identity does not match the existing account binding');
    expect(source).toContain('Verified email is required to link an existing account');
    expect(source).toContain('OIDC_LEGACY_ISSUER');
    expect(source).toContain('SAML_LEGACY_IDP_ENTITY_ID');
    expect(source).toContain('issuer === `legacy:${provider}`');
  });

  test('SAML identity is parsed only from the cryptographically signed reference', () => {
    expect(source).toContain('sig.getSignedReferences()');
    // verifySAMLSignature() now returns the single signed reference itself, so
    // no caller can index past the "exactly one bound reference" invariant.
    expect(source).toContain('const signedReference = await verifySAMLSignature(xml, idpCert)');
    expect(source).toContain('validateSignedSamlReference(signedReference,');
    expect(source).not.toContain('parseSAMLAttributes(xml)');
    expect(source).toContain('Exactly one XML Signature is required');
  });

  test('SAML assertion is request-bound, time-bound, audience-bound and replay protected', () => {
    expect(source).toContain('SAML bearer confirmation does not bind this login request');
    expect(source).toContain('SAML audience mismatch');
    expect(source).toContain('SAML assertion expired');
    expect(source).toContain('SAML issuer mismatch');
    expect(source).toContain('setIfAbsentAuthoritative(`saml:assertion:');
    expect(source).toContain('SAML assertion replay detected');
    expect(source).toContain('SAML_BEARER_METHOD');
    expect(source).toContain('samlDirectChildren');
  });

  test('failed one-time handoff revokes the already-persisted refresh token', () => {
    expect(source).toContain('await revokeRefreshToken(refreshToken)');
    expect(source).toContain("event: 'sso.refresh_cleanup_failed'");
  });

  test('production SAML startup refuses incomplete verification runtime/configuration', () => {
    expect(source).toContain("problems.push('SAML_IDP_CERT is missing')");
    expect(source).toContain("problems.push('SAML_IDP_ENTITY_ID is missing')");
    expect(source).toContain("problems.push('xml-crypto/@xmldom runtime is unavailable')");
    expect(source).toContain("event: 'sso.saml.invalid_runtime'");
  });
});
