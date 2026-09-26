// server/tests/env-webauthn-origin-list.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// WEBAUTHN_ORIGIN — COK KAYNAKLI YAPILANDIRMA ACILISTA OLMEMELI
// ════════════════════════════════════════════════════════════════════════════
// `routes/webauthn.ts` sozlesmesi ACIKCA "birden cok mesru origin virgulle
// ayrilarak verilebilir" der ve calisma zamaninda tam olarak boyle davranir.
//
// `lib/env.ts` icindeki acilis dogrulayicisi ise tum dizgeyi TEK bir URL sanip
// `new URL(...)` ile ayristiriyordu. Virgul iceren — yani BELGELENEN bicimde
// yazilmis — her yapilandirma "gecerli bir URL degil" hatasi uretiyordu.
// URETIMDE bu bir `process.exit(1)`dir: urun kendi dokumante ettigi
// yapilandirmayla ACILMIYORDU.
//
// Dogrulama GEVSETILMEDI: her giris AYRI AYRI ayristirilir ve HER BIRI
// `WEBAUTHN_RP_ID` ile eslesmek zorundadir. Tek bir yabanci giris tum listeyi
// gecersiz kilar.
const ENV_KEYS = [
  'NODE_ENV', 'JWT_SECRET', 'REFRESH_SECRET', 'DATABASE_URL', 'REDIS_URL',
  'AP_ENCRYPTION_KEY', 'FEDERATION_SECRET', 'METRICS_SECRET', 'TRUSTED_PROXY_COUNT',
  'WEBAUTHN_RP_ID', 'WEBAUTHN_ORIGIN', 'INSTANCE_URL', 'DOMAIN',
];

function productionEnv(values: Record<string, string>): Record<string, string> {
  return {
    NODE_ENV: 'production',
    JWT_SECRET: 'j'.repeat(40),
    REFRESH_SECRET: 'r'.repeat(40),
    DATABASE_URL: 'postgresql://bridge:secret@127.0.0.1:5432/bridge',
    REDIS_URL: 'redis://127.0.0.1:6379',
    AP_ENCRYPTION_KEY: 'a'.repeat(64),
    FEDERATION_SECRET: 'f'.repeat(40),
    METRICS_SECRET: 'm'.repeat(24),
    TRUSTED_PROXY_COUNT: '1',
    ...values,
  };
}

/** Uretim ortaminda `lib/env`i yeniden yukler; cikis denemesini yakalar. */
function bootProduction(values: Record<string, string>): { exited: boolean; messages: string } {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, productionEnv(values));

  const messages: string[] = [];
  const exitSpy = jest.spyOn(process, 'exit').mockImplementation((() => {
    throw new Error('process.exit called');
  }) as never);
  const errorSpy = jest.spyOn(console, 'error')
    .mockImplementation((...args: unknown[]) => { messages.push(args.join(' ')); });
  const warnSpy = jest.spyOn(console, 'warn')
    .mockImplementation((...args: unknown[]) => { messages.push(args.join(' ')); });

  let exited = false;
  try {
    jest.resetModules();
    jest.isolateModules(() => { require('../lib/env'); });
  } catch (err) {
    exited = String((err as Error).message).includes('process.exit called');
    if (!exited) throw err;
  } finally {
    exitSpy.mockRestore(); errorSpy.mockRestore(); warnSpy.mockRestore();
  }
  return { exited, messages: messages.join(' | ') };
}

const ORIGINAL = { ...process.env };

afterEach(() => {
  for (const key of ENV_KEYS) delete process.env[key];
  Object.assign(process.env, ORIGINAL);
  jest.resetModules();
});

describe('WEBAUTHN_ORIGIN accepts the documented comma-separated form', () => {
  test('boots with several origins that all match the RP id', () => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: 'https://bridge.example, https://app.bridge.example:8443',
    });
    expect(exited).toBe(false);
  });

  test('boots with a single origin exactly as before', () => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: 'https://bridge.example',
    });
    expect(exited).toBe(false);
  });

  test('boots with explicit localhost WebAuthn origin while INSTANCE_URL owns 127.0.0.1 federation identity', () => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: 'localhost',
      WEBAUTHN_ORIGIN: 'http://localhost:3000',
      INSTANCE_URL: 'http://127.0.0.1:3000',
    });
    expect(exited).toBe(false);
  });

  test('refuses to boot when ANY entry belongs to a different RP', () => {
    // Tek bir yabanci giris tum listeyi gecersiz kilar; aksi hâlde saldirgan
    // bir kaynak "listede bir tanesi dogru" diye kabul edilirdi.
    const { exited, messages } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: 'https://bridge.example, https://saldirgan.net',
    });
    expect(exited).toBe(true);
    expect(messages).toContain('saldirgan.net');
  });

  test('refuses to boot when any entry is not a URL at all', () => {
    const { exited, messages } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: 'https://bridge.example, bu-bir-url-degil',
    });
    expect(exited).toBe(true);
    expect(messages).toContain('bu-bir-url-degil');
  });

  test('refuses to boot on a list made only of separators', () => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: ' , , ',
    });
    expect(exited).toBe(true);
  });

  test('still refuses a single origin that does not match the RP id', () => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: 'https://saldirgan.net',
    });
    expect(exited).toBe(true);
  });

  test('refuses suffix confusion without a dot-delimited RP boundary', () => {
    const { exited, messages } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: 'https://evilbridge.example',
    });
    expect(exited).toBe(true);
    expect(messages).toContain('evilbridge.example');
  });

  test.each([
    ['remote cleartext scheme', 'http://bridge.example'],
    ['non-WebAuthn scheme', 'ftp://bridge.example'],
    ['wildcard host', 'https://*.bridge.example'],
    ['credentials', 'https://user:pass@bridge.example'],
    ['path', 'https://bridge.example/passkey'],
    ['query', 'https://bridge.example?mode=passkey'],
    ['fragment', 'https://bridge.example#passkey'],
    ['empty list member', 'https://bridge.example,,https://app.bridge.example'],
  ])('refuses malformed or weakened origin configuration: %s', (_label, webauthnOrigin) => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: webauthnOrigin,
    });
    expect(exited).toBe(true);
  });

  test.each([
    'https://bridge.example',
    'bridge.example:443',
    '*.bridge.example',
    'evil_bridge.example',
  ])('refuses malformed/wildcard RP ID: %s', (rpId) => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: rpId,
      WEBAUTHN_ORIGIN: 'https://bridge.example',
    });
    expect(exited).toBe(true);
  });

  test('valid non-default port is preserved and accepted', () => {
    const { exited } = bootProduction({
      WEBAUTHN_RP_ID: 'bridge.example',
      WEBAUTHN_ORIGIN: 'https://app.bridge.example:8443',
    });
    expect(exited).toBe(false);
  });
});

// Bu dosyada ust duzey import/export yoktu; TypeScript onu GLOBAL
// SCRIPT sayiyor ve ust duzey adlari diger ayni durumdaki test
// dosyalariyla CAKISIYORDU (TS2393/TS2451, ve arguman tiplerinin
// baska bir dosyanin bildirimine cozulmesi). Bu satir modul kapsami
// ilan eder; calisma zamaninda hicbir sey degistirmez.
export {};
