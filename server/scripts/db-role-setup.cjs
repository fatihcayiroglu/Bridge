// server/scripts/db-role-setup.cjs
//
// EN AZ AYRICALIK — OPERATOR YOLU
//
// ============================================================================
// DURUM
// ============================================================================
// Bridge'in calisma-zamani PostgreSQL kullanicisi bu kurulumda SUPERUSER
// olarak olculdu (rolsuper/rolcreatedb/rolcreaterole/rolbypassrls hepsi true).
// Iki rollu model TEK KULLANIMLIK bir veritabaninda 15/15 dogrulamayla
// KANITLANDI (scripts/db-least-privilege-proof.cjs).
//
// Geriye kalan is MIMARI degil, BENIMSEME'dir: mevcut dagitimda kimlik hala
// ayricalikli. Bu betik o gecisi guvenli hale getirir.
//
// ============================================================================
// BU BETIK AKTIF VERITABANINI DEGISTIRMEZ
// ============================================================================
// Varsayilan mod yalnizca DENETLER ve SQL URETIR. Hicbir sey calistirmaz,
// hicbir parola icermez. Uretilen SQL'i operator gozden gecirip kendisi
// uygular.
//
// KULLANIM
//   node scripts/db-role-setup.cjs              # denetle + SQL uret
//   node scripts/db-role-setup.cjs --verify     # yalnizca mevcut yetkileri denetle
//   node scripts/db-role-setup.cjs --sql        # yalnizca SQL yaz

require('dotenv/config');
const { Client } = require('pg');

const ARGS = process.argv.slice(2);
const YALNIZ_SQL    = ARGS.includes('--sql');
const YALNIZ_DENETIM = ARGS.includes('--verify');

const MIG_ROL = process.env.BRIDGE_MIGRATION_ROLE || 'bridge_migrate';
const APP_ROL = process.env.BRIDGE_APP_ROLE       || 'bridge_app';

function dbAdi() {
  try { return new URL(process.env.DATABASE_URL).pathname.replace(/^\//, '') || 'bridge'; }
  catch { return 'bridge'; }
}

// ── SQL uretimi ─────────────────────────────────────────────────────────────
function sqlUret(db) {
  return `
-- ============================================================================
-- BRIDGE EN AZ AYRICALIK ROL KURULUMU
-- ============================================================================
-- Bu SQL'i GOZDEN GECIRIN ve superuser bir baglantiyla calistirin.
-- PAROLALARI KENDINIZ belirleyin; bu dosya parola ICERMEZ.
--
-- Model (15/15 dogrulamayla kanitlandi):
--   ${MIG_ROL}  -> sema degisiklikleri (DDL). Migrasyonlar bu kimlikle kosar.
--   ${APP_ROL}  -> yalnizca SELECT/INSERT/UPDATE/DELETE. Uygulama bunu kullanir.

-- 1) Roller (parolalari DEGISTIRIN)
CREATE ROLE ${MIG_ROL} LOGIN PASSWORD 'DEGISTIRIN_migration_parolasi';
CREATE ROLE ${APP_ROL} LOGIN PASSWORD 'DEGISTIRIN_uygulama_parolasi';

-- 2) Sema sahipligi migrasyon rolune gecer
ALTER DATABASE "${db}" OWNER TO ${MIG_ROL};
ALTER SCHEMA public OWNER TO ${MIG_ROL};

-- 3) Uygulama rolune YALNIZCA CRUD
GRANT CONNECT ON DATABASE "${db}" TO ${APP_ROL};
GRANT USAGE ON SCHEMA public TO ${APP_ROL};
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${APP_ROL};
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${APP_ROL};

-- 4) GELECEKTE olusacak tablolar icin de ayni yetkiler
--    (bu satir olmadan her yeni migrasyon sonrasi GRANT tekrar gerekir)
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIG_ROL} IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${APP_ROL};
ALTER DEFAULT PRIVILEGES FOR ROLE ${MIG_ROL} IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO ${APP_ROL};

-- 5) Uygulama rolunun YONETIMSEL yetkisi OLMADIGINI dogrula
--    (hepsinin 'f' donmesi beklenir)
SELECT rolname, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
  FROM pg_roles WHERE rolname IN ('${MIG_ROL}', '${APP_ROL}');
`.trimStart();
}

// ── Ortam degiskeni yonergesi ───────────────────────────────────────────────
function envYonerge() {
  return `
# ============================================================================
# DAGITIM AYARI
# ============================================================================
# Migrasyonlar MIGRASYON kimligiyle, uygulama UYGULAMA kimligiyle kosmalidir.
#
#   # migrasyon adimi (CI / deploy oncesi):
#   DATABASE_URL=postgresql://${MIG_ROL}:<parola>@<host>:<port>/${dbAdi()}  npm run migrate
#
#   # calisma zamani:
#   DATABASE_URL=postgresql://${APP_ROL}:<parola>@<host>:<port>/${dbAdi()}
#
# GERI ALMA: yeni kimlik yanlis yapilandirilirsa Bridge onyuklemede
# baglanamaz ve HIZLI hata verir (db/loader process.exit). Eski superuser
# DATABASE_URL'e geri donmek tek adimdir; veri DEGISMEZ.
#
# DOGRULAMA:
#   node scripts/db-role-setup.cjs --verify
`.trimStart();
}

(async () => {
  const db = dbAdi();

  if (!YALNIZ_SQL) {
    // ── Mevcut kimligi DENETLE (salt okuma) ────────────────────────────────
    const c = new Client({ connectionString: process.env.DATABASE_URL });
    await c.connect();
    const r = await c.query(
      `SELECT current_user AS kullanici, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls
         FROM pg_roles WHERE rolname = current_user`);
    await c.end();

    const row = r.rows[0] || {};
    const fazla = ['rolsuper', 'rolcreatedb', 'rolcreaterole', 'rolbypassrls']
      .filter(k => row[k] === true);

    console.log('== MEVCUT CALISMA-ZAMANI KIMLIGI ==');
    console.log('  veritabani :', db);
    console.log('  kullanici  :', row.kullanici);
    console.log('  superuser  :', row.rolsuper);
    console.log('  createdb   :', row.rolcreatedb);
    console.log('  createrole :', row.rolcreaterole);
    console.log('  bypassrls  :', row.rolbypassrls);
    console.log();

    if (fazla.length === 0) {
      console.log('DURUM: EN AZ AYRICALIK — fazladan yonetimsel yetki YOK.');
      if (YALNIZ_DENETIM) process.exit(0);
    } else {
      console.log('DURUM: FAZLA AYRICALIK —', fazla.join(', '));
      console.log('  Ele gecirilmis bir Bridge sureci bu yetkilerle kumedeki her');
      console.log('  veritabanini okuyabilir, rol olusturabilir' +
        (row.rolsuper ? ' ve COPY TO PROGRAM ile sunucuda komut calistirabilir.' : '.'));
      if (YALNIZ_DENETIM) process.exit(1);
    }
    console.log();
  }

  console.log(sqlUret(db));
  console.log(envYonerge());
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
