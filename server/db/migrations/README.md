# SQLite Migrations (Legacy)

Bu klasör SQLite veritabanı için eski migration dosyalarını içerir.

> **DİKKAT:** Bridge artık PostgreSQL kullanıyor.  
> Yeni migration'lar için → `../migrations_pg/` klasörünü kullanın.

## Neden bu klasör hâlâ var?

- Eski SQLite kurulumlardan geçiş yapan kullanıcılar için korunuyor.
- `db/migrate.ts` (SQLite) bu klasörü okur.
- `db/migrate-postgres.ts` (PostgreSQL) → `migrations_pg/` klasörünü okur.

## Geçiş Durumu

| Migration | Durum | PostgreSQL karşılığı |
|-----------|-------|----------------------|
| 001_schema_migrations_bootstrap.sql | ✅ Baseline | — |
| 002_client_error_events.sql | ✅ Tamamlandı | migrations_pg/001 |
| 003_refresh_token_reuse_detection.sql | ✅ Tamamlandı | migrations_pg/002 |

Yeni kurulumlar için doğrudan `server/db/postgres/schema.sql` kullanılması önerilir.
