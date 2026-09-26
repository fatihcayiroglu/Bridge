// server/tests/webauthn-pem-roundtrip.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// lib/webauthn-pem.ts — GERÇEK ANAHTARLARLA GİDİŞ-DÖNÜŞ KANITI
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR: `lib/webauthn-pem.ts` kapsam envanterinde güvenlik
// katmanının EN KÖTÜ dosyasıydı — %0 dal, %12.9 ifade, %0 fonksiyon. Yani
// passkey doğrulamasının DER/PEM kodlaması pratikte HİÇ test edilmiyordu.
//
// Bu modül JWK'yı (WebAuthn attestation'dan gelen açık anahtar) PEM'e çevirir.
// Yanlış kodlama iki yönde de felakettir:
//   · çok katı  → meşru passkey'ler doğrulanamaz (kullanıcı kilitlenir),
//   · çok gevşek→ bozuk/sahte anahtar kabul edilir.
//
// ── TEST STRATEJİSİ: ŞEKİL DEĞİL, KABUL ────────────────────────────────────
// "PEM başlığı var mı" gibi bir iddia hiçbir şey kanıtlamaz. Burada:
//
//   1. Node'un `crypto` modülüyle GERÇEK bir anahtar çifti üretilir,
//   2. anahtar JWK'ya çevrilir,
//   3. JWK bu modülün fonksiyonundan geçirilir,
//   4. sonuç Node'a GERİ verilir (`createPublicKey`) — Node kabul etmezse
//      kodlama yanlıştır,
//   5. üretilen PEM, Node'un KENDİ ürettiği PEM ile BAYT BAYT karşılaştırılır.
//
// Adım 5 kritik: Node'un kabul ettiği ama FARKLI bir anahtarı temsil eden bir
// DER de "geçerli" olurdu. Eşitlik, doğru anahtarın kodlandığını kanıtlar.
//
// Ayrıca gerçek bir imza bu PEM ile doğrulanır — kodlamanın yalnızca
// ayrıştırılabilir değil, KULLANILABİLİR olduğunun kanıtı.

import crypto from 'crypto';
import { jwkToPem, rsaJwkToPem, encodeLength } from '../lib/webauthn-pem';

/** base64url — WebAuthn/JWK gösterimi. */
function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function normalizePem(pem: string): string {
  return pem.replace(/\r/g, '').trim();
}

describe('jwkToPem — EC P-256', () => {
  const { publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string };

  it('Node GERÇEK bir anahtar olarak kabul eder', () => {
    const pem = jwkToPem({ x: jwk.x, y: jwk.y });
    // Node reddederse kodlama yanlıştır — bu tek satır DER'in tamamını sınar.
    const reparsed = crypto.createPublicKey(pem);
    expect(reparsed.asymmetricKeyType).toBe('ec');
  });

  it('Node’un KENDİ PEM çıktısıyla BAYT BAYT aynıdır', () => {
    // En güçlü iddia: yalnızca "geçerli" değil, DOĞRU anahtar kodlanmış.
    const ours = normalizePem(jwkToPem({ x: jwk.x, y: jwk.y }));
    const theirs = normalizePem(publicKey.export({ format: 'pem', type: 'spki' }) as string);
    expect(ours).toBe(theirs);
  });

  it('üretilen PEM ile GERÇEK bir imza doğrulanabilir', () => {
    // Ayrıştırılabilir olmak yetmez; anahtarın KULLANILABİLİR olması gerekir.
    const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const j = pub.export({ format: 'jwk' }) as { x: string; y: string };
    const data = Buffer.from('bridge webauthn assertion');
    const sig = crypto.sign('sha256', data, privateKey);

    const pem = jwkToPem({ x: j.x, y: j.y });
    expect(crypto.verify('sha256', data, pem, sig)).toBe(true);
  });

  it('BAŞKA bir anahtarın imzasını DOĞRULAMAZ (yanlış pozitif kontrolü)', () => {
    // Yukarıdaki iddialar, fonksiyon her zaman "bir" geçerli anahtar üretse de
    // geçerdi. Bu test kodlamanın anahtara ÖZGÜ olduğunu kanıtlar.
    const a = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const b = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
    const jb = b.publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const data = Buffer.from('mismatched');
    const sigFromA = crypto.sign('sha256', data, a.privateKey);

    expect(crypto.verify('sha256', data, jwkToPem({ x: jb.x, y: jb.y }), sigFromA)).toBe(false);
  });

  it('farklı anahtarlar farklı PEM üretir', () => {
    const k1 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    const k2 = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' }) as { x: string; y: string };
    expect(jwkToPem(k1)).not.toBe(jwkToPem(k2));
  });

  it('PEM satırları 64 karakterde sarılır (RFC 7468)', () => {
    const body = jwkToPem({ x: jwk.x, y: jwk.y })
      .split('\n').slice(1, -1);
    expect(body.length).toBeGreaterThan(0);
    for (const line of body) expect(line.length).toBeLessThanOrEqual(64);
  });
});

describe('rsaJwkToPem — RSA', () => {
  const { publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };

  it('Node GERÇEK bir anahtar olarak kabul eder', () => {
    const reparsed = crypto.createPublicKey(rsaJwkToPem({ n: jwk.n, e: jwk.e }));
    expect(reparsed.asymmetricKeyType).toBe('rsa');
  });

  it('Node’un KENDİ PEM çıktısıyla BAYT BAYT aynıdır', () => {
    const ours = normalizePem(rsaJwkToPem({ n: jwk.n, e: jwk.e }));
    const theirs = normalizePem(publicKey.export({ format: 'pem', type: 'spki' }) as string);
    expect(ours).toBe(theirs);
  });

  it('üretilen PEM ile GERÇEK bir imza doğrulanabilir', () => {
    const { privateKey, publicKey: pub } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const j = pub.export({ format: 'jwk' }) as { n: string; e: string };
    const data = Buffer.from('bridge webauthn rsa assertion');
    const sig = crypto.sign('sha256', data, privateKey);

    expect(crypto.verify('sha256', data, rsaJwkToPem({ n: j.n, e: j.e }), sig)).toBe(true);
  });

  it('4096 bit anahtarda da doğru kodlar (uzun DER uzunluğu dalı)', () => {
    // 4096 bit modül > 0xFF bayt olduğu için `encodeLength` 0x82 (iki baytlık)
    // dalına girer. Kısa anahtarlarla bu dal HİÇ çalışmazdı.
    const { publicKey: pub4096 } = crypto.generateKeyPairSync('rsa', { modulusLength: 4096 });
    const j = pub4096.export({ format: 'jwk' }) as { n: string; e: string };

    const ours = normalizePem(rsaJwkToPem({ n: j.n, e: j.e }));
    const theirs = normalizePem(pub4096.export({ format: 'pem', type: 'spki' }) as string);
    expect(ours).toBe(theirs);
    expect(crypto.createPublicKey(ours).asymmetricKeyType).toBe('rsa');
  });
});

describe('encodeLength — DER uzunluk kodlaması', () => {
  // DER (X.690 §8.1.3): <128 kısa biçim; aksi hâlde 0x8N + N bayt uzunluk.
  it('kısa biçim: 0..127 tek bayt', () => {
    expect(encodeLength(0)).toEqual(Buffer.from([0x00]));
    expect(encodeLength(1)).toEqual(Buffer.from([0x01]));
    expect(encodeLength(127)).toEqual(Buffer.from([0x7f]));
  });

  it('uzun biçim (1 bayt): 128..255 → 0x81 NN', () => {
    expect(encodeLength(128)).toEqual(Buffer.from([0x81, 0x80]));
    expect(encodeLength(200)).toEqual(Buffer.from([0x81, 0xc8]));
    expect(encodeLength(255)).toEqual(Buffer.from([0x81, 0xff]));
  });

  it('uzun biçim (2 bayt): >=256 → 0x82 HH LL', () => {
    expect(encodeLength(256)).toEqual(Buffer.from([0x82, 0x01, 0x00]));
    expect(encodeLength(4096)).toEqual(Buffer.from([0x82, 0x10, 0x00]));
    expect(encodeLength(65535)).toEqual(Buffer.from([0x82, 0xff, 0xff]));
  });

  it('sınır değerleri doğru dala girer', () => {
    // 127/128 ve 255/256 sınırları DER'de biçim değiştirir; yanlış tarafa
    // düşen bir uzunluk ayrıştırıcıyı bozar.
    expect(encodeLength(127).length).toBe(1);
    expect(encodeLength(128).length).toBe(2);
    expect(encodeLength(255).length).toBe(2);
    expect(encodeLength(256).length).toBe(3);
  });
});

describe('bozuk girdi karşısında davranış', () => {
  it('geçersiz base64url koordinat GEÇERLİ bir anahtar üretmez', () => {
    // Fonksiyon savunmacı değildir (çağıran attestation'ı doğrular), ama
    // çöp girdinin SESSİZCE geçerli bir anahtara dönüşmediği kanıtlanmalı.
    expect(() => jwkToPem({ x: 'not-valid-base64url!!', y: 'also-bogus!!' })).toThrow(/base64url/i);
  });

  it('yanlış uzunlukta koordinat GEÇERLİ bir anahtar üretmez', () => {
    // P-256 koordinatları 32 bayttır; 16 bayt vermek DER'i bozmalıdır.
    const short = b64u(Buffer.alloc(16, 1));
    expect(() => crypto.createPublicKey(jwkToPem({ x: short, y: short }))).toThrow();
  });
});
