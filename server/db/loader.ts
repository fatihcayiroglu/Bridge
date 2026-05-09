// server/db/loader.js
// PostgreSQL ZORUNLU — SQLite kaldırıldı.
// DATABASE_URL tanımlı değilse sunucu başlamaz.
// Test ortamında (NODE_ENV=test) jest.mock() ile override edilir.

'use strict';
const logger = require('../lib/logger');

// DATABASE_URL varsa her zaman PostgreSQL kullan (test dahil).
// DATABASE_URL yoksa:
//   - test ortamında: jest.mock('../db/loader') ile override edilmemişse SQLite mock'a düş
//   - production: process.exit(1)
if (process.env.DATABASE_URL) {
  logger.info(
    { event: 'db.mode.postgres' },
    `[DB] PostgreSQL -> ${process.env.DATABASE_URL.replace(/:[^@]+@/, ':***@')}`
  );
  module.exports = require('./postgres');
} else if (process.env.NODE_ENV === 'test') {
  // Test ortamında jest.mock('../db/loader') ile override edilmişse bu kod çalışmaz.
  // Override edilmemişse SQLite/mock'a düş — testler kendi mock'unu db/index üzerinden atar.
  module.exports = require('./index');
} else {
  logger.fatal(
    { event: 'db.missing_url' },
    '[DB] HATA: DATABASE_URL tanımlı değil.\n' +
    '     .env dosyasına ekle: DATABASE_URL=postgresql://user:pass@localhost:5432/bridge\n' +
    '     Docker için: docker-compose.yml içinde otomatik ayarlanır.'
  );
  process.exit(1);
}
export {};
