// server/tests/webauthn-origin-security.test.ts
// FAZ G15 — WEBAUTHN ORIGIN DOĞRULAMASI.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN İKİ KUSUR
// ════════════════════════════════════════════════════════════════════════════
// Bridge'in WebAuthn uygulaması EL YAZIMIDIR (hazır kütüphane kullanılmaz),
// bu yüzden doğrulama adımlarının her biri ayrı ayrı denetlenmelidir.
//
// 1. KİMLİK DOĞRULAMA TÖRENİNDE (`POST /login/complete`) ORIGIN HİÇ
//    DENETLENMİYORDU. Ölçüm: handler'ın 140 satırında `origin` kelimesi
//    SIFIR kez geçiyordu. Origin denetimi WebAuthn'ın çekirdek gereğidir.
//
// 2. KAYIT TÖRENİNDEKİ denetim iki yönden zayıftı:
//
//        if (!clientData.origin.startsWith(ORIGIN) && ORIGIN !== 'http://localhost')
//
//    a) ÖN EK eşleşmesi: `https://bridge.example.com` beklenirken
//       `https://bridge.example.com.saldirgan.net` de geçerdi.
//    b) `ORIGIN`, `WEBAUTHN_ORIGIN`/`INSTANCE_URL` yoksa `'http://localhost'`
//       varsayılanına düşer — ve koşulun ikinci yarısı tam o durumda denetimi
//       TÜMDEN kapatırdı. Yani yapılandırılmamış bir dağıtımda origin
//       doğrulaması YOKTU.
//
// Yeni sözleşme: TAM origin eşleşmesi (URL olarak normalize), çoklu origin
// desteği, üretimde yapılandırma yoksa FAIL-CLOSED, localhost istisnası
// YALNIZCA `NODE_ENV !== 'production'` iken.

process.env.NODE_ENV = 'test';

import { createMockDb } from './helpers/mockDb';
jest.mock('../db/index', () => createMockDb());
jest.mock('../db/loader', () => require('../db/index'));

import { isAllowedWebAuthnOrigin } from '../routes/webauthn';

/** Ortam değişkenini geçici olarak ayarlayıp geri alır. */
function withEnv(vars: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; }
  try {
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
  }
}

const PROD = 'https://bridge.ornek.test';
const PROD_RP_ID = 'ornek.test';

function configured(values: Record<string, string | undefined> = {}): Record<string, string | undefined> {
  return {
    WEBAUTHN_RP_ID: PROD_RP_ID,
    WEBAUTHN_ORIGIN: PROD,
    INSTANCE_URL: undefined,
    DOMAIN: undefined,
    NODE_ENV: 'production',
    ...values,
  };
}

describe('WebAuthn origin — tam eşleşme', () => {
  it('POZİTİF KONTROL: yapılandırılan origin KABUL edilir', () => {
    withEnv(configured(), () => {
      expect(isAllowedWebAuthnOrigin(PROD)).toBe(true);
    });
  });

  it('ÖN EK atlatması REDDEDİLİR (asıl kusur)', () => {
    // Eski `startsWith` mantığı bunu KABUL ederdi.
    withEnv(configured(), () => {
      expect(isAllowedWebAuthnOrigin('https://bridge.ornek.test.saldirgan.net')).toBe(false);
      expect(isAllowedWebAuthnOrigin('https://bridge.ornek.testXY')).toBe(false);
    });
  });

  it('origin olmayan URL biçimleri normalize edilip kabul edilmez', () => {
    withEnv(configured(), () => {
      for (const malformed of [
        `${PROD}/giris`, `${PROD}?next=/ayarlar`, `${PROD}#bolum`,
        'https://user:pass@bridge.ornek.test', 'bridge.ornek.test',
        ' https://bridge.ornek.test',
      ]) {
        expect(isAllowedWebAuthnOrigin(malformed)).toBe(false);
      }
    });
  });

  it('şema ve port tam origin eşleşmesinin parçasıdır', () => {
    withEnv(configured({ WEBAUTHN_ORIGIN: 'https://bridge.ornek.test:8443' }), () => {
      expect(isAllowedWebAuthnOrigin('https://bridge.ornek.test:8443')).toBe(true);
      expect(isAllowedWebAuthnOrigin('https://bridge.ornek.test')).toBe(false);
      expect(isAllowedWebAuthnOrigin('https://bridge.ornek.test:9443')).toBe(false);
      expect(isAllowedWebAuthnOrigin('http://bridge.ornek.test:8443')).toBe(false);
    });
  });

  it('uzak HTTP, WebAuthn dışı şemalar ve wildcard hiçbir zaman kabul edilmez', () => {
    for (const origin of [
      'http://bridge.ornek.test',
      'ftp://bridge.ornek.test',
      'javascript://bridge.ornek.test',
      'https://*.ornek.test',
    ]) {
      withEnv(configured({ WEBAUTHN_ORIGIN: origin }), () => {
        expect(isAllowedWebAuthnOrigin(origin)).toBe(false);
        expect(isAllowedWebAuthnOrigin(PROD)).toBe(false);
      });
    }
  });

  it('birden çok origin virgülle verilebilir', () => {
    withEnv(configured({ WEBAUTHN_ORIGIN: `${PROD}, https://ikinci.ornek.test` }), () => {
      expect(isAllowedWebAuthnOrigin(PROD)).toBe(true);
      expect(isAllowedWebAuthnOrigin('https://ikinci.ornek.test')).toBe(true);
      expect(isAllowedWebAuthnOrigin('https://ucuncu.test')).toBe(false);
    });
  });
});

describe('WebAuthn origin — yapılandırma yokluğu', () => {
  it('ÜRETİMDE yapılandırma yoksa FAIL-CLOSED (her şey reddedilir)', () => {
    // Asıl kusur buydu: yapılandırılmamış dağıtımda denetim tümden kapalıydı.
    withEnv(configured({ WEBAUTHN_ORIGIN: undefined, INSTANCE_URL: undefined }), () => {
      expect(isAllowedWebAuthnOrigin('http://localhost')).toBe(false);
      expect(isAllowedWebAuthnOrigin('https://her-neyse.test')).toBe(false);
    });
  });

  it('GELİŞTİRMEDE yalnız RP ID ile uyumlu localhost kabul edilir', () => {
    withEnv(configured({
      WEBAUTHN_RP_ID: 'localhost', WEBAUTHN_ORIGIN: undefined,
      INSTANCE_URL: undefined, NODE_ENV: 'test',
    }), () => {
      expect(isAllowedWebAuthnOrigin('http://localhost')).toBe(true);
      expect(isAllowedWebAuthnOrigin('http://localhost:5173')).toBe(true);
      // CORS'ta aynı makine olsa da WebAuthn kimliğinde farklı RP'dir.
      expect(isAllowedWebAuthnOrigin('http://127.0.0.1:5173')).toBe(false);
      // Uzak bir origin geliştirmede de kabul EDİLMEZ.
      expect(isAllowedWebAuthnOrigin('https://saldirgan.test')).toBe(false);
    });
  });

  it('127.0.0.1 yalnız kendi RP ID/origin çifti açıkça yapılandırılırsa kabul edilir', () => {
    withEnv(configured({
      WEBAUTHN_RP_ID: '127.0.0.1',
      WEBAUTHN_ORIGIN: 'http://127.0.0.1:5173',
      NODE_ENV: 'test',
    }), () => {
      expect(isAllowedWebAuthnOrigin('http://127.0.0.1:5173')).toBe(true);
      expect(isAllowedWebAuthnOrigin('http://localhost:5173')).toBe(false);
    });
  });

  it('INSTANCE_URL de yapılandırma kaynağı olarak kullanılır', () => {
    withEnv(configured({ WEBAUTHN_ORIGIN: undefined, INSTANCE_URL: PROD }), () => {
      expect(isAllowedWebAuthnOrigin(PROD)).toBe(true);
      expect(isAllowedWebAuthnOrigin('http://localhost')).toBe(false);
    });
  });

  it('INSTANCE_URL RP ID ile uyuşmuyorsa çalışma zamanı fail-closed kalır', () => {
    withEnv(configured({
      WEBAUTHN_RP_ID: 'bridge.ornek.test',
      WEBAUTHN_ORIGIN: undefined,
      INSTANCE_URL: 'https://evilbridge.ornek.test',
    }), () => {
      expect(isAllowedWebAuthnOrigin('https://evilbridge.ornek.test')).toBe(false);
      expect(isAllowedWebAuthnOrigin(PROD)).toBe(false);
    });
  });
});

describe('WebAuthn origin — bozuk girdi fail-closed', () => {
  it('boş / tip uyumsuz / ayrıştırılamayan değerler REDDEDİLİR', () => {
    withEnv(configured(), () => {
      expect(isAllowedWebAuthnOrigin('')).toBe(false);
      expect(isAllowedWebAuthnOrigin(undefined)).toBe(false);
      expect(isAllowedWebAuthnOrigin(null)).toBe(false);
      expect(isAllowedWebAuthnOrigin(42)).toBe(false);
      expect(isAllowedWebAuthnOrigin({ origin: PROD })).toBe(false);
      expect(isAllowedWebAuthnOrigin('bu-bir-url-degil')).toBe(false);
    });
  });

  it('her iki TÖREN de aynı doğrulayıcıyı kullanır (kaynak sözleşmesi)', async () => {
    // Jest CommonJS ortami: `import.meta` YOKTUR; __dirname kullanilir.
    const fs   = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '../routes/webauthn.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

    // Kayıt VE giriş törenlerinin ikisinde de çağrılmalı.
    const calls = (src.match(/isAllowedWebAuthnOrigin\(clientData\.origin\)/g) ?? []).length;
    expect(calls).toBe(2);
    // Eski ön-ek mantığı geri gelmemeli.
    expect(src).not.toMatch(/origin\.startsWith\(/);
  });
});
