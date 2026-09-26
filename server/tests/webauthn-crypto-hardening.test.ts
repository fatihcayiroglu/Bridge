import crypto from 'crypto';
import { b64uDecode, coseToJwk, parseAuthenticatorData, resolveWebAuthnRpId, verifyRpIdHash } from '../lib/webauthn-crypto';

function baseAuth(flags = 0): Buffer {
  return Buffer.concat([Buffer.alloc(32), Buffer.from([flags]), Buffer.alloc(4)]);
}

describe('WebAuthn crypto parser hardening', () => {
  it('rejects AT flag when attested credential structure is truncated', () => {
    expect(() => parseAuthenticatorData(baseAuth(0x41))).toThrow(/attested credential data truncated/i);
  });

  it('rejects credential id whose declared length exceeds remaining bytes', () => {
    const header = baseAuth(0x41);
    const aaguid = Buffer.alloc(16);
    const len = Buffer.from([0x00, 0x20]);
    expect(() => parseAuthenticatorData(Buffer.concat([header, aaguid, len, Buffer.alloc(4)])))
      .toThrow(/credentialId truncated/i);
  });

  it('rejects missing credential public key after a complete credential id', () => {
    const header = baseAuth(0x41);
    const aaguid = Buffer.alloc(16);
    const len = Buffer.from([0x00, 0x01]);
    expect(() => parseAuthenticatorData(Buffer.concat([header, aaguid, len, Buffer.from([1])])))
      .toThrow(/public key missing/i);
  });

  it('rejects truncated CBOR byte strings instead of accepting Buffer.slice truncation', () => {
    // map(1) { -2: bytes(32) <only one byte present> }
    const malformed = Buffer.from([0xa1, 0x21, 0x58, 0x20, 0x01]);
    expect(() => coseToJwk(malformed)).toThrow(/truncated byte string/i);
  });

  it('rejects non-32-byte ES256 coordinates', () => {
    // {1:2, 3:-7, -2:h'01', -3:h'02'}
    const malformed = Buffer.from([0xa4, 0x01, 0x02, 0x03, 0x26, 0x21, 0x41, 0x01, 0x22, 0x41, 0x02]);
    expect(() => coseToJwk(malformed)).toThrow(/32-byte/i);
  });

  it.each(['a=', 'a+b', 'a/b', 'a b', 'abcde'])(
    'rejects non-canonical base64url input %p instead of relying on permissive Buffer decoding',
    (value) => expect(() => b64uDecode(value)).toThrow(/Invalid base64url/),
  );

  it('decodes canonical unpadded base64url', () => {
    expect(b64uDecode('SGVsbG8td29ybGQ_').toString()).toBe('Hello-world?');
  });

  it('rejects trailing CBOR after an otherwise valid COSE map', () => {
    // empty map followed by an extra uint
    expect(() => coseToJwk(Buffer.from([0xa0, 0x00]))).toThrow(/trailing CBOR/i);
  });

  it('requires the declared RSA algorithm to be RS256, not merely RSA key type', () => {
    // {1:3, 3:-7, -1:h'01', -2:h'03'} — RSA kty with ES256 alg
    const mismatch = Buffer.from([0xa4, 0x01, 0x03, 0x03, 0x26, 0x20, 0x41, 0x01, 0x21, 0x41, 0x03]);
    expect(() => coseToJwk(mismatch)).toThrow(/Unsupported COSE key type/);
  });

  it('rejects empty RSA modulus or exponent', () => {
    // {1:3, 3:-257, -1:h'', -2:h'03'}
    const emptyN = Buffer.from([0xa4, 0x01, 0x03, 0x03, 0x39, 0x01, 0x00, 0x20, 0x40, 0x21, 0x41, 0x03]);
    expect(() => coseToJwk(emptyN)).toThrow(/must not be empty/);
  });

  it('does not sign-wrap CBOR uint32 additional-info values', () => {
    // top-level uint 0xffffffff is not a COSE map, but should parse as an
    // unsigned value before the map-shape rejection. The old signed bitwise
    // assembly turned this into -1.
    expect(() => coseToJwk(Buffer.from([0x1a, 0xff, 0xff, 0xff, 0xff])))
      .toThrow(/COSE key must be a CBOR map/);
  });
  it('uses DOMAIN as the canonical RP-ID fallback and hashes the same value', () => {
    const prevRp = process.env.WEBAUTHN_RP_ID;
    const prevDomain = process.env.DOMAIN;
    try {
      delete process.env.WEBAUTHN_RP_ID;
      process.env.DOMAIN = 'Bridge.Example.COM';
      expect(resolveWebAuthnRpId()).toBe('bridge.example.com');
      const hash = crypto.createHash('sha256').update('bridge.example.com').digest();
      expect(verifyRpIdHash(hash)).toBe(true);
    } finally {
      if (prevRp === undefined) delete process.env.WEBAUTHN_RP_ID; else process.env.WEBAUTHN_RP_ID = prevRp;
      if (prevDomain === undefined) delete process.env.DOMAIN; else process.env.DOMAIN = prevDomain;
    }
  });

  it('explicit WEBAUTHN_RP_ID overrides DOMAIN consistently', () => {
    const prevRp = process.env.WEBAUTHN_RP_ID;
    const prevDomain = process.env.DOMAIN;
    try {
      process.env.WEBAUTHN_RP_ID = 'passkeys.example.com';
      process.env.DOMAIN = 'bridge.example.com';
      expect(resolveWebAuthnRpId()).toBe('passkeys.example.com');
      expect(verifyRpIdHash(crypto.createHash('sha256').update('passkeys.example.com').digest())).toBe(true);
      expect(verifyRpIdHash(crypto.createHash('sha256').update('bridge.example.com').digest())).toBe(false);
    } finally {
      if (prevRp === undefined) delete process.env.WEBAUTHN_RP_ID; else process.env.WEBAUTHN_RP_ID = prevRp;
      if (prevDomain === undefined) delete process.env.DOMAIN; else process.env.DOMAIN = prevDomain;
    }
  });

});
