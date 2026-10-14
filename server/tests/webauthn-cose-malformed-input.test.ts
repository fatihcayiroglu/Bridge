// server/tests/webauthn-cose-malformed-input.test.ts
//
// `coseToJwk` parses the credential public key out of attacker-supplied
// attestation data during passkey registration. Every malformed shape must be
// refused with a parse error; nothing may be coerced into key material.
process.env.NODE_ENV = 'test';
import { coseToJwk } from '../lib/webauthn-crypto';

// Minimal CBOR encoder for the shapes under test (definite lengths only).
const head = (major: number, n: number): Buffer =>
  n < 24 ? Buffer.from([(major << 5) | n])
    : n < 256 ? Buffer.from([(major << 5) | 24, n])
      : Buffer.from([(major << 5) | 25, n >> 8, n & 0xff]);
const uint = (n: number) => head(0, n);
const neg = (n: number) => head(1, -1 - n);
const bytes = (b: Buffer) => Buffer.concat([head(2, b.length), b]);
const text = (s: string) => Buffer.concat([head(3, Buffer.byteLength(s)), Buffer.from(s)]);
const map = (entries: Array<[Buffer, Buffer]>) => Buffer.concat([head(5, entries.length), ...entries.flat()]);

const P256 = Buffer.alloc(32, 7);

describe('coseToJwk refuses malformed CBOR', () => {
  it('an empty buffer and a map that ends early are truncated input', () => {
    expect(() => coseToJwk(Buffer.alloc(0))).toThrow('unexpected end of buffer');
    expect(() => coseToJwk(Buffer.from([0xa1, 0x01]))).toThrow('unexpected end of buffer');
  });

  it('64-bit and indefinite-length encodings are not accepted', () => {
    expect(() => coseToJwk(Buffer.from([0x1b, 0, 0, 0, 0, 0, 0, 0, 1]))).toThrow('Unsupported CBOR additional info: 27');
    expect(() => coseToJwk(Buffer.from([0xbf, 0xff]))).toThrow('Unsupported CBOR additional info: 31');
  });

  it('a text string longer than the remaining bytes is truncated input', () => {
    expect(() => coseToJwk(Buffer.from([0xa1, 0x63, 0x61]))).toThrow('truncated text string');
  });

  it('map keys must be integers or text, never byte strings or nested maps', () => {
    expect(() => coseToJwk(map([[bytes(Buffer.from([1])), uint(2)]]))).toThrow('CBOR map key must be number or string');
    expect(() => coseToJwk(map([[map([]), uint(2)]]))).toThrow('CBOR map key must be number or string');
  });

  it('a top-level value that is not a map is not a COSE key', () => {
    expect(() => coseToJwk(uint(1))).toThrow('COSE key must be a CBOR map');
    expect(() => coseToJwk(text('kty'))).toThrow('COSE key must be a CBOR map');
  });

  it('text keys parse but never stand in for the integer COSE labels', () => {
    const named = map([[text('kty'), uint(2)], [text('alg'), neg(-7)], [text('x'), bytes(P256)], [text('y'), bytes(P256)]]);
    expect(() => coseToJwk(named)).toThrow('Unsupported COSE key type: kty=undefined alg=undefined');
  });
});

describe('coseToJwk refuses key components of the wrong type', () => {
  it('ES256 coordinates must be byte strings', () => {
    const ec = (x: Buffer, y: Buffer) => map([[uint(1), uint(2)], [uint(3), neg(-7)], [neg(-2), x], [neg(-3), y]]);
    expect(() => coseToJwk(ec(uint(5), bytes(P256)))).toThrow('ES256: x/y must be bytes');
    expect(() => coseToJwk(ec(bytes(P256), text('y')))).toThrow('ES256: x/y must be bytes');
    // Positive control: the same shape with byte strings is a valid P-256 key.
    expect(coseToJwk(ec(bytes(P256), bytes(P256)))).toMatchObject({ kty: 'EC', crv: 'P-256', alg: 'ES256' });
  });

  it('RS256 modulus and exponent must be non-empty byte strings', () => {
    const rsa = (n: Buffer, e: Buffer) => map([[uint(1), uint(3)], [uint(3), neg(-257)], [neg(-1), n], [neg(-2), e]]);
    expect(() => coseToJwk(rsa(text('n'), bytes(Buffer.from([1, 0, 1]))))).toThrow('RS256: n/e must be bytes');
    expect(() => coseToJwk(rsa(bytes(Buffer.alloc(256, 1)), bytes(Buffer.alloc(0))))).toThrow('RS256: n/e must not be empty');
    expect(coseToJwk(rsa(bytes(Buffer.alloc(256, 1)), bytes(Buffer.from([1, 0, 1]))))).toMatchObject({ kty: 'RSA', alg: 'RS256', e: 'AQAB' });
  });
});
