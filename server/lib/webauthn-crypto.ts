// server/lib/webauthn-crypto.ts
// Sprint 105: webauthn.ts'den ayrıştırıldı — FIDO2 crypto yardımcıları
// Interfaces, encoding, challenge üretimi, authenticator data parse, COSE key dönüşümü

import crypto from 'crypto';

// verifyRpIdHash için RP_ID — webauthn.ts ile aynı env var
const RP_ID = process.env.WEBAUTHN_RP_ID || 'localhost';

export interface WebAuthnUser {
  _id: string;
  username: string;
  webauthnCredentials?: Array<{
    credId: string;
    publicKey: string;
    counter: number;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export function b64uEncode(buf: Buffer | Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function b64uDecode(str: string): Buffer {
  const pad = str.length % 4;
  const padded = pad ? str + '='.repeat(4 - pad) : str;
  return Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function randomChallenge(): Buffer {
  return crypto.randomBytes(32);
}

// CBOR kütüphanesi olmadan minimal CBOR decode (authenticator data için)
// Sadece attestedCredentialData parse etmemiz lazım
export function parseAuthenticatorData(authDataBuf: Buffer): {
  rpIdHash: Buffer;
  flags: number;
  UP: boolean;
  UV: boolean;
  AT: boolean;
  ED: boolean;
  signCount: number;
  credentialId: Buffer | null;
  credentialPublicKey: Buffer | null;
  aaguid: Buffer | null;
} {
  if (authDataBuf.length < 37) throw new Error('authenticatorData too short');

  let offset = 0;
  const rpIdHash = authDataBuf.slice(offset, offset + 32); offset += 32;
  const flags    = authDataBuf[offset]; offset += 1;
  const signCount = authDataBuf.readUInt32BE(offset); offset += 4;

  const UP  = !!(flags & 0x01); // User Present
  const UV  = !!(flags & 0x04); // User Verified
  const AT  = !!(flags & 0x40); // Attested credential data included
  const ED  = !!(flags & 0x80); // Extension data included

  let credentialId = null;
  let credentialPublicKey = null;
  let aaguid = null;

  if (AT && authDataBuf.length > offset + 16 + 2) {
    aaguid = authDataBuf.slice(offset, offset + 16); offset += 16;
    const credIdLen = authDataBuf.readUInt16BE(offset); offset += 2;
    credentialId = authDataBuf.slice(offset, offset + credIdLen); offset += credIdLen;
    // CBOR-encoded public key — store raw for now, verify signature separately
    credentialPublicKey = authDataBuf.slice(offset);
  }

  return { rpIdHash, flags, UP, UV, AT, ED, signCount, credentialId, credentialPublicKey, aaguid };
}

// RP ID hash doğrula
export function verifyRpIdHash(rpIdHash: Buffer): boolean {
  const expected = crypto.createHash('sha256').update(RP_ID).digest();
  return expected.equals(rpIdHash);
}

// Minimal COSE key → SubtleCrypto JWK dönüşümü (ES256 = -7, RS256 = -257)
// COSE key map (cbor map keys): 1=kty, 3=alg, -1=crv/n, -2=x/e, -3=y
export function coseToJwk(coseBuf: Buffer): Record<string, unknown> {
  // Basit CBOR map parse — sadece ES256 ve RS256 destekliyoruz
  // CBOR major type 5 = map
  let pos = 0;
  const b = coseBuf;

  // readByte: buffer erişimini güvenli hale getirir — noUncheckedIndexedAccess uyumlu
  function readByte(): number {
    const byte = b[pos++];
    if (byte === undefined) throw new Error('CBOR parse error: unexpected end of buffer');
    return byte;
  }

  function readCbor(): unknown {
    const first = readByte();
    const major = first >> 5;
    const info  = first & 0x1f;

    // val: CBOR ek uzunluk/değer bilgisi — tüm dallar atanır veya fırlatır
    let val: number;
    if (info < 24) {
      val = info;
    } else if (info === 24) {
      val = readByte();
    } else if (info === 25) {
      const hi = readByte(); const lo = readByte();
      val = (hi << 8) | lo; pos += 0; // readByte pos'u zaten ilerletiyor
    } else if (info === 26) {
      const b3 = readByte(); const b2 = readByte();
      const b1 = readByte(); const b0 = readByte();
      val = (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
    } else {
      throw new Error(`Unsupported CBOR additional info: ${info}`);
    }

    if (major === 0) return val;                                        // uint
    if (major === 1) return -(val + 1);                                 // negint
    if (major === 2) { const v = b.slice(pos, pos + val); pos += val; return v; } // bytes
    if (major === 3) { const v = b.slice(pos, pos + val).toString(); pos += val; return v; } // text
    if (major === 5) {                                                  // map
      const map: Record<number | string, unknown> = {};
      for (let i = 0; i < val; i++) {
        const k = readCbor();
        if (typeof k !== 'number' && typeof k !== 'string') {
          throw new Error('CBOR map key must be number or string');
        }
        map[k] = readCbor();
      }
      return map;
    }
    throw new Error(`Unsupported CBOR major type: ${major}`);
  }

  const raw = readCbor();
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('COSE key must be a CBOR map');
  }
  const map = raw as Record<number | string, unknown>;
  const kty = map[1];
  const alg = map[3];

  if (kty === 2 && alg === -7) {
    // EC2 key (ES256) — P-256
    const x = map[-2]; const y = map[-3];
    if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y)) throw new Error('ES256: x/y must be bytes');
    return { kty: 'EC', crv: 'P-256', alg: 'ES256', x: b64uEncode(x), y: b64uEncode(y) };
  }
  if (kty === 3) {
    // RSA key (RS256)
    const n = map[-1]; const e = map[-2];
    if (!Buffer.isBuffer(n) || !Buffer.isBuffer(e)) throw new Error('RS256: n/e must be bytes');
    return { kty: 'RSA', alg: 'RS256', n: b64uEncode(n), e: b64uEncode(e) };
  }
  throw new Error(`Unsupported COSE key type: kty=${kty} alg=${alg}`);
}

