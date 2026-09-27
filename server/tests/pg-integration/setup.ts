// server/tests/pg-integration/setup.ts
//
// ════════════════════════════════════════════════════════════════════════════
// GERÇEK PostgreSQL — MOCK'UN KANITLAYAMADIĞI ŞEYLER
// ════════════════════════════════════════════════════════════════════════════
// Birim süiti bellek-içi bir mock üzerinde çalışır. Mock'lanmış bir
// `SELECT ... FOR UPDATE` testi SQL'i ve kontrol akışını doğrulayabilir;
// PostgreSQL'in KİLİTLEME ve YARIŞ davranışını KANITLAYAMAZ.
//
// Bu dizindeki süitler gerçek bir PostgreSQL örneğine bağlanır ve GERÇEKTEN
// eşzamanlı çağrılar yapar. Yalnızca `PG_TEST_URL` verildiğinde çalışırlar.
//
// ── NEDEN NODE_ENV=production ──────────────────────────────────────────────
// `db/loader.ts:121` NODE_ENV=test altında KOŞULSUZ olarak mock'a düşer.
// Gerçek veritabanı yolunu yürütmek için üretim dalına girmek gerekir.
// (`tests/atomic-repository-contracts.test.ts` de aynı tekniği kullanır.)
//
// GÜVENLİK: buradaki hiçbir şey kullanıcının kendi veritabanına dokunmaz —
// bağlantı yalnızca `PG_TEST_URL` ile AÇIKÇA verilen tek kullanımlık örneğe
// yapılır ve şemayı asla DROP etmez; her süit kendi satırlarını temizler.

process.env.NODE_ENV = 'production';
process.env.DATABASE_URL = process.env.PG_TEST_URL ?? '';
// Üretim dalında auth secret doğrulaması `process.exit(1)` yapar; testin
// kendisini düşürmemek için geçerli uzunlukta değerler verilir.
process.env.JWT_SECRET = process.env.JWT_SECRET ?? 'pg-integration-jwt-secret-'.padEnd(64, 'x');
process.env.REFRESH_SECRET = process.env.REFRESH_SECRET ?? 'pg-integration-refresh-secret-'.padEnd(64, 'y');
process.env.REDIS_URL = process.env.REDIS_URL ?? '';

export {};
