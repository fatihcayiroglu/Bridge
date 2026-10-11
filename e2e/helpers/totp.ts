// e2e/helpers/totp.ts — TOTP codes computed with the product's own algorithm
// (server/routes/twoFactor.ts): base32 secret + HMAC-SHA1 + 30 s step + 6 digits.
// No new dependency.

import crypto from 'crypto';

const STEP_MS = 30_000;

function base32Decode(str: string): Buffer {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const idx = alphabet.indexOf(ch);
    if (idx === -1) continue;
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

function hotp(secret: string, counter: number): string {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  let c = BigInt(counter);
  for (let i = 7; i >= 0; i--) { buf[i] = Number(c & 0xffn); c >>= 8n; }
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16)
             | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return String(code % 1_000_000).padStart(6, '0');
}

/** The code an authenticator app shows now. */
export function totpCode(secret: string): string {
  return hotp(secret, Math.floor(Date.now() / STEP_MS));
}

/**
 * Distinct codes the server cannot accept for `secret` during the next minute: it
 * accepts the current step ±1, so every code of the steps −2…+2 is excluded.
 */
export function wrongTotpCodes(secret: string, count: number): string[] {
  const now = Math.floor(Date.now() / STEP_MS);
  const valid = new Set([-2, -1, 0, 1, 2].map((d) => hotp(secret, now + d)));
  const out: string[] = [];
  for (let n = 0; out.length < count; n++) {
    const code = String(n).padStart(6, '0');
    if (!valid.has(code)) out.push(code);
  }
  return out;
}
