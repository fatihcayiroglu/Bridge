// server/jest.pg.config.js
//
// GERÇEK PostgreSQL entegrasyon süiti — varsayılan `npm test` koşusundan
// AYRI tutulur, çünkü çalışan bir veritabanı gerektirir.
//
//   PG_TEST_URL=postgresql://user:pass@host:port/db \
//     npx jest --config jest.pg.config.js --runInBand
//
// Bu süit YEŞİL olmadan "PostgreSQL eşzamanlılığı kanıtlandı" DENMEZ.
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['**/tests/pg-integration/**/*.pgtest.ts'],
  transform: {
    '^.+\\.(ts|tsx)$': ['ts-jest', { tsconfig: 'tsconfig.jest.json', diagnostics: false }],
  },
  setupFiles: ['./tests/pg-integration/setup.ts'],
  // ── DİKKAT: BUNLAR JS DİZGELERİDİR, REGEX LİTERALİ DEĞİL ──────────────
  // Tek ters bölü dizge ayrıştırıcısı tarafından yutulur ve regex motoruna
  // yalnızca `.` — yani "HERHANGİ bir karakter" — olarak ulaşır.
  //
  // ÖLÇÜLEN DEĞER (düzeltmeden önce, config require edilerek):
  //     moduleNameMapper anahtarı  ->  "^(.{1,2}/.*).js$"
  //     transform anahtarı         ->  "^.+.(ts|tsx)$"
  //
  // Yani eşleyici GÖRECELİ olmayan `ab/x.js` gibi belirteçlerle de
  // eşleşiyordu; amaç yalnızca `./` ve `../` idi. package.json'daki kardeş
  // yapılandırma doğru biçimi (çift ters bölü) zaten kullanıyor.
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/$1',
    '^(\\.{1,2}/.*)\\.js$': '$1',
    '^uuid$': '<rootDir>/tests/shims/uuid.cjs',
  },
  testTimeout: 60000,
  maxWorkers: 1,
  // Gerçek PostgreSQL/Redis istemcileri açık handle bırakabilir; süitler kendi
  // bağlantılarını kapatır ama tek bir kaçak handle koşuyu asılı bırakır.
  forceExit: true,
  detectOpenHandles: false,
};
