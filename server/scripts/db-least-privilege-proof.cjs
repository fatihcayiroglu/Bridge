// server/scripts/db-least-privilege-proof.cjs
//
// EN AZ AYRICALIK KANITI — MIGRASYON KIMLIGI vs UYGULAMA KIMLIGI
//
// ============================================================================
// NEDEN
// ============================================================================
// Bridge calisma-zamani veritabani kullanicisi olculdu:
//     rolsuper = true, rolcreatedb = true, rolcreaterole = true,
//     rolbypassrls = true
//
// Yani SUPERUSER. Ele gecirilmis bir Bridge sureci (SQL enjeksiyonu, RCE veya
// bagimlilik zinciri) TUM kumedeki her veritabanini okuyabilir, rol
// olusturabilir, RLS'i atlayabilir ve `COPY TO PROGRAM` ile veritabani
// sunucusunda KABUK KOMUTU calistirabilir.
//
// Uygulamanin ihtiyaci olan sey bu DEGILDIR: normal CRUD yeterlidir.
//
// ============================================================================
// BU BETIK NE YAPAR
// ============================================================================
// TEK KULLANIMLIK bir veritabaninda iki rol kurar ve GERCEKTEN dogrular:
//
//   bridge_migrate_*  → semayi degistirebilir (DDL)
//   bridge_app_*      → yalnizca CRUD; DDL ve yonetimsel islemler REDDEDILIR
//
// AKTIF veritabanina DOKUNMAZ. Kendi olusturdugu tek kullanimlik veritabanini
// ve rollerini sonunda temizler.

require('dotenv/config');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) { console.error('DATABASE_URL yok'); process.exit(2); }

const SUFFIX     = Date.now().toString(36);
const DB         = `bridge_lp_${SUFFIX}`;
const ROLE_MIG   = `bridge_migrate_${SUFFIX}`;
const ROLE_APP   = `bridge_app_${SUFFIX}`;
const PW         = 'lp_' + Math.random().toString(36).slice(2) + 'Aa1!';

function urlFor(db, user, pw) {
  const u = new URL(ADMIN_URL);
  u.pathname = '/' + db;
  u.username = user;
  u.password = pw;
  return u.toString();
}

/** Beklenen: islem BASARILI olmali. */
async function expectOk(c, sql, label, results) {
  try { await c.query(sql); results.push({ label, beklenen: 'IZIN', sonuc: 'IZIN', ok: true }); }
  catch (e) { results.push({ label, beklenen: 'IZIN', sonuc: 'RED (' + e.code + ')', ok: false }); }
}

/** Beklenen: islem REDDEDILMELI. */
async function expectDenied(c, sql, label, results) {
  try { await c.query(sql); results.push({ label, beklenen: 'RED', sonuc: 'IZIN', ok: false }); }
  catch (e) { results.push({ label, beklenen: 'RED', sonuc: 'RED (' + e.code + ')', ok: true }); }
}

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();

  console.log('Tek kullanimlik veritabani :', DB);
  console.log('Migrasyon rolu             :', ROLE_MIG);
  console.log('Uygulama rolu              :', ROLE_APP);
  console.log();

  // ── Kurulum ───────────────────────────────────────────────────────────────
  await admin.query(`CREATE ROLE ${ROLE_MIG} LOGIN PASSWORD '${PW}'`);
  await admin.query(`CREATE ROLE ${ROLE_APP} LOGIN PASSWORD '${PW}'`);
  await admin.query(`CREATE DATABASE ${DB} OWNER ${ROLE_MIG}`);

  const results = [];

  // ── 1) MIGRASYON KIMLIGI: sema degisiklikleri CALISMALI ──────────────────
  const mig = new Client({ connectionString: urlFor(DB, ROLE_MIG, PW) });
  await mig.connect();
  await expectOk(mig, 'CREATE TABLE ornek (id int primary key, ad text)', 'migrasyon: CREATE TABLE', results);
  await expectOk(mig, 'CREATE INDEX ornek_ad_idx ON ornek(ad)', 'migrasyon: CREATE INDEX', results);
  await expectOk(mig, 'ALTER TABLE ornek ADD COLUMN eklendi int', 'migrasyon: ALTER TABLE', results);

  // Uygulama rolune YALNIZCA CRUD ver.
  await mig.query(`GRANT CONNECT ON DATABASE ${DB} TO ${ROLE_APP}`);
  await mig.query(`GRANT USAGE ON SCHEMA public TO ${ROLE_APP}`);
  await mig.query(`GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO ${ROLE_APP}`);
  await mig.query(`GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${ROLE_APP}`);
  await mig.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO ${ROLE_APP}`);
  await mig.end();

  // ── 2) UYGULAMA KIMLIGI: CRUD calismali, DDL REDDEDILMELI ────────────────
  const app = new Client({ connectionString: urlFor(DB, ROLE_APP, PW) });
  await app.connect();

  // Pozitif kontrol — uygulama gercekten calisabilmeli.
  await expectOk(app, "INSERT INTO ornek (id, ad) VALUES (1, 'a')", 'uygulama: INSERT', results);
  await expectOk(app, 'SELECT * FROM ornek', 'uygulama: SELECT', results);
  await expectOk(app, "UPDATE ornek SET ad = 'b' WHERE id = 1", 'uygulama: UPDATE', results);
  await expectOk(app, 'DELETE FROM ornek WHERE id = 1', 'uygulama: DELETE', results);

  // Negatif kontrol — yonetimsel yetkiler REDDEDILMELI.
  await expectDenied(app, 'CREATE TABLE kotu (id int)', 'uygulama: CREATE TABLE', results);
  await expectDenied(app, 'DROP TABLE ornek', 'uygulama: DROP TABLE', results);
  await expectDenied(app, 'ALTER TABLE ornek ADD COLUMN x int', 'uygulama: ALTER TABLE', results);
  await expectDenied(app, `CREATE ROLE yeni_rol_${SUFFIX} LOGIN`, 'uygulama: CREATE ROLE', results);
  await expectDenied(app, `CREATE DATABASE db_${SUFFIX}`, 'uygulama: CREATE DATABASE', results);
  // COPY TO PROGRAM yalnizca superuser/pg_execute_server_program icindir —
  // ele gecirilmis bir uygulama icin KABUK ERISIMI demektir.
  await expectDenied(app, "COPY (SELECT 1) TO PROGRAM 'echo test'", 'uygulama: COPY TO PROGRAM (kabuk)', results);
  await expectDenied(app, "SELECT pg_read_file('postgresql.conf')", 'uygulama: pg_read_file', results);
  await app.end();

  // ── 3) Uygulama rolu superuser DEGIL ─────────────────────────────────────
  const roleCheck = await admin.query(
    `SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = $1`, [ROLE_APP]);
  const r = roleCheck.rows[0];
  const temiz = !r.rolsuper && !r.rolcreatedb && !r.rolcreaterole && !r.rolbypassrls;
  results.push({ label: 'uygulama rolu yonetimsel bayrak TASIMIYOR', beklenen: 'temiz', sonuc: JSON.stringify(r), ok: temiz });

  // ── Rapor ─────────────────────────────────────────────────────────────────
  console.log('sonuc | islem'.padEnd(46) + '| beklenen -> gercek');
  console.log('-'.repeat(96));
  for (const x of results) {
    console.log((x.ok ? 'OK   ' : 'HATA ') + '| ' + x.label.padEnd(38) + '| ' + x.beklenen + ' -> ' + x.sonuc);
  }
  const basarisiz = results.filter(x => !x.ok);
  console.log('\n' + (results.length - basarisiz.length) + '/' + results.length + ' beklendigi gibi');

  // ── Temizlik ──────────────────────────────────────────────────────────────
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE_APP}`);
  await admin.query(`DROP ROLE IF EXISTS ${ROLE_MIG}`);
  await admin.end();
  console.log('temizlendi:', DB, ROLE_MIG, ROLE_APP);

  process.exit(basarisiz.length ? 1 : 0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
