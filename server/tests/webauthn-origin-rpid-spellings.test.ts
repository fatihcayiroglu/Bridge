// server/tests/webauthn-origin-rpid-spellings.test.ts
//
// lib/webauthn-origin.ts is the single owner of "which browser origin may run
// a passkey ceremony for this server". webauthn-origin-security.test.ts pins
// exact matching, prefix attacks and the production fail-closed default. This
// suite pins the spellings it did not reach:
//   - alternative spellings of an RP ID are refused, not normalised into a
//     different identity: shortened IPv4 (127.1), hex/octal IPv4, Unicode
//     host names not given in their ASCII (punycode) form, non-string input;
//   - an IP RP ID matches only that exact IP: `evil.127.0.0.1` is a DNS name,
//     not a "subdomain" of the address;
//   - bracketed IPv6 loopback origins are recognised as loopback (so plain
//     HTTP is allowed in development) while a non-loopback IPv6 over HTTP is
//     refused;
//   - a repeated origin in WEBAUTHN_ORIGIN is listed once;
//   - with no explicit environment the validator reads process.env.
import {
  isAllowedWebAuthnOrigin,
  isExplicitWebAuthnLoopback,
  normalizeWebAuthnRpId,
  parseWebAuthnOrigin,
  validateWebAuthnOriginConfiguration,
  webAuthnHostMatchesRpId,
} from '../lib/webauthn-origin';

describe('RP ID spellings are refused, not normalised into another identity', () => {
  it('accepts canonical DNS names and dotted-quad IPs as given', () => {
    expect(normalizeWebAuthnRpId('bridge.example.com')).toBe('bridge.example.com');
    expect(normalizeWebAuthnRpId('  Bridge.Example.COM ')).toBe('bridge.example.com');
    expect(normalizeWebAuthnRpId('127.0.0.1')).toBe('127.0.0.1');
    expect(normalizeWebAuthnRpId('xn--bcher-kva.example')).toBe('xn--bcher-kva.example');
  });

  it('refuses shortened, hex and octal IPv4 spellings that a URL parser would rewrite', () => {
    for (const spelling of ['127.1', '0x7f.0.0.1', '0177.0.0.1', '2130706433']) {
      expect([spelling, normalizeWebAuthnRpId(spelling)]).toEqual([spelling, null]);
    }
  });

  it('refuses a Unicode host name that is not given in its ASCII form', () => {
    expect(normalizeWebAuthnRpId('bücher.example')).toBeNull();
  });

  it('refuses non-string input', () => {
    for (const value of [undefined, null, 42, ['bridge.example.com'], { host: 'bridge.example.com' }]) {
      expect(normalizeWebAuthnRpId(value)).toBeNull();
    }
  });

  it('a startup configuration with such an RP ID is invalid and no ceremony is allowed', () => {
    const env = { NODE_ENV: 'production', WEBAUTHN_RP_ID: '127.1', WEBAUTHN_ORIGIN: 'https://127.0.0.1' };
    expect(validateWebAuthnOriginConfiguration(env)).toMatchObject({ ok: false, field: 'WEBAUTHN_RP_ID', origins: [] });
    expect(isAllowedWebAuthnOrigin('https://127.0.0.1', env)).toBe(false);
  });
});

describe('an IP RP ID matches only that exact IP', () => {
  it('a DNS name ending in the IP is not a subdomain of it', () => {
    expect(webAuthnHostMatchesRpId('127.0.0.1', '127.0.0.1')).toBe(true);
    expect(webAuthnHostMatchesRpId('evil.127.0.0.1', '127.0.0.1')).toBe(false);
    expect(webAuthnHostMatchesRpId('a.b.10.0.0.5', '10.0.0.5')).toBe(false);
    // A DNS RP ID still admits its real subdomains.
    expect(webAuthnHostMatchesRpId('app.bridge.example.com', 'bridge.example.com')).toBe(true);
  });

  it('the startup validator refuses an origin on such a look-alike host', () => {
    const env = { WEBAUTHN_RP_ID: '10.0.0.5', WEBAUTHN_ORIGIN: 'https://evil.10.0.0.5' };
    expect(validateWebAuthnOriginConfiguration(env)).toMatchObject({ ok: false, field: 'WEBAUTHN_ORIGIN' });
    expect(isAllowedWebAuthnOrigin('https://evil.10.0.0.5', env)).toBe(false);
  });
});

describe('IPv6 origins', () => {
  it('bracketed ::1 is loopback, so plain HTTP is a valid development origin', () => {
    expect(isExplicitWebAuthnLoopback('[::1]')).toBe(true);
    expect(parseWebAuthnOrigin('http://[::1]:3000')).toEqual({ origin: 'http://[::1]:3000', hostname: '::1' });
  });

  it('a non-loopback IPv6 host over HTTP is refused; over HTTPS it parses', () => {
    expect(isExplicitWebAuthnLoopback('[2001:db8::1]')).toBe(false);
    expect(parseWebAuthnOrigin('http://[2001:db8::1]')).toBeNull();
    expect(parseWebAuthnOrigin('https://[2001:db8::1]')).toEqual({ origin: 'https://[2001:db8::1]', hostname: '2001:db8::1' });
  });
});

describe('origin list hygiene', () => {
  it('a repeated origin in WEBAUTHN_ORIGIN is listed once, and still allowed', () => {
    const env = {
      NODE_ENV: 'production',
      WEBAUTHN_RP_ID: 'bridge.example.com',
      WEBAUTHN_ORIGIN: 'https://bridge.example.com, https://BRIDGE.example.com ,https://app.bridge.example.com',
    };
    expect(validateWebAuthnOriginConfiguration(env)).toEqual({
      ok: true,
      rpId: 'bridge.example.com',
      origins: ['https://bridge.example.com', 'https://app.bridge.example.com'],
      source: 'WEBAUTHN_ORIGIN',
    });
    expect(isAllowedWebAuthnOrigin('https://bridge.example.com', env)).toBe(true);
    expect(isAllowedWebAuthnOrigin('https://other.bridge.example.com', env)).toBe(false);
  });

  it('with no explicit environment the validator reads the process environment', () => {
    const saved = { rp: process.env.WEBAUTHN_RP_ID, origin: process.env.WEBAUTHN_ORIGIN };
    try {
      process.env.WEBAUTHN_RP_ID = 'process-env.example';
      process.env.WEBAUTHN_ORIGIN = 'https://process-env.example';
      expect(validateWebAuthnOriginConfiguration()).toMatchObject({
        ok: true, rpId: 'process-env.example', origins: ['https://process-env.example'],
      });
    } finally {
      if (saved.rp === undefined) delete process.env.WEBAUTHN_RP_ID; else process.env.WEBAUTHN_RP_ID = saved.rp;
      if (saved.origin === undefined) delete process.env.WEBAUTHN_ORIGIN; else process.env.WEBAUTHN_ORIGIN = saved.origin;
    }
  });
});
