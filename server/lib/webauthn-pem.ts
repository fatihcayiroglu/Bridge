// server/lib/webauthn-pem.ts
// Sprint 105: webauthn.ts'den ayrıştırıldı — JWK → PEM dönüşüm yardımcıları
// jwkToPem (EC P-256), rsaJwkToPem, encodeLength

import { b64uDecode } from './webauthn-crypto';

// ── Key helpers (PEM dönüşüm) ─────────────────────────────────────────────────

export function jwkToPem(jwk: { x: string; y: string }): string {
  // EC P-256 public key → uncompressed point → DER SubjectPublicKeyInfo
  const x = b64uDecode(jwk.x);
  const y = b64uDecode(jwk.y);
  // Uncompressed EC point: 04 || x || y
  const point = Buffer.concat([Buffer.from([0x04]), x, y]);

  // SubjectPublicKeyInfo DER for EC P-256 (OID 1.2.840.10045.2.1, 1.2.840.10045.3.1.7)
  const ecOid = Buffer.from('301306072a8648ce3d020106082a8648ce3d030107', 'hex');
  const bitStr = Buffer.concat([Buffer.from([0x00]), point]); // 0x00 = no unused bits
  const bitStrSeq = Buffer.concat([Buffer.from([0x03]), encodeLength(bitStr.length), bitStr]);
  const spki = Buffer.concat([ecOid, bitStrSeq]);
  const seq  = Buffer.concat([Buffer.from([0x30]), encodeLength(spki.length), spki]);

  // .match() teorik olarak null dönemez (base64 çıktısı daima eşleşir),
  // ancak noUncheckedIndexedAccess ile tutarlı olmak için ?? [] guard eklendi.
  return `-----BEGIN PUBLIC KEY-----\n${(seq.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----`;
}

export function rsaJwkToPem(jwk: { n: string; e: string }): string {
  // RSA public key JWK → DER → PEM
  const n = b64uDecode(jwk.n);
  const e = b64uDecode(jwk.e);
  const nInt = Buffer.concat([Buffer.from([0x00]), n]); // positive integer
  const nSeq = Buffer.concat([Buffer.from([0x02]), encodeLength(nInt.length), nInt]);
  const eSeq = Buffer.concat([Buffer.from([0x02]), encodeLength(e.length), e]);
  const keySeq = Buffer.concat([nSeq, eSeq]);
  const seq  = Buffer.concat([Buffer.from([0x30]), encodeLength(keySeq.length), keySeq]);

  // SubjectPublicKeyInfo wrapper (OID 1.2.840.113549.1.1.1 = rsaEncryption)
  const rsaOid = Buffer.from('300d06092a864886f70d0101010500', 'hex');
  const bitStr = Buffer.concat([Buffer.from([0x00]), seq]);
  const bitStrSeq = Buffer.concat([Buffer.from([0x03]), encodeLength(bitStr.length), bitStr]);
  const spki = Buffer.concat([rsaOid, bitStrSeq]);
  const spkiSeq = Buffer.concat([Buffer.from([0x30]), encodeLength(spki.length), spki]);

  return `-----BEGIN PUBLIC KEY-----\n${(spkiSeq.toString('base64').match(/.{1,64}/g) ?? []).join('\n')}\n-----END PUBLIC KEY-----`;
}

export function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  if (len < 0x100) return Buffer.from([0x81, len]);
  return Buffer.from([0x82, len >> 8, len & 0xff]);
}

