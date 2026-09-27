// server/scripts/backup-code-race-probe.cjs
//
// 2FA YEDEK KODU — TEK KULLANIMLIK GARANTISI ES ZAMANLILIK ALTINDA
//
// ============================================================================
// SORU
// ============================================================================
// `/api/2fa/check` su deseni kullanir:
//
//     const backups = readBackupCodes(user.twoFactorBackup);   // OKU
//     const idx = backups.findIndex(...);                      // KONTROL
//     backups.splice(idx, 1);                                  // DEGISTIR
//     await Users.update(user._id, { twoFactorBackup: ... });  // YAZ
//
// Bu klasik bir TOCTOU'dur. Mock veritabaninda tek kullanimlik korunuyor
// gorundu — ama mock, gercek PostgreSQL'in AYRI BAGLANTILARLA sundugu
// es zamanliligi TEMSIL ETMEYEBILIR.
//
// Bu betik AYNI deseni GERCEK PostgreSQL uzerinde IKI AYRI BAGLANTIYLA
// calistirir ve kodun iki kez kullanilip kullanilamadigini olcer.
//
// AKTIF veritabanina DOKUNULMAZ: tek kullanimlik bir veritabani olusturulur.

require('dotenv/config');
const { Client } = require('pg');

const ADMIN_URL = process.env.DATABASE_URL;
if (!ADMIN_URL) { console.error('DATABASE_URL yok'); process.exit(2); }

const DB = `bridge_race_${Date.now().toString(36)}`;
const urlFor = (db) => { const u = new URL(ADMIN_URL); u.pathname = '/' + db; return u.toString(); };

const KOD_OZET = 'a'.repeat(64);

/** Rotanin yaptigi ISIN AYNISI: oku → kontrol et → degistir → yaz. */
async function tuket(c, userId, label, gecikmeMs) {
  await c.query('BEGIN');
  const r = await c.query('SELECT "twoFactorBackup" AS b FROM users WHERE id = $1', [userId]);
  const kodlar = r.rows[0].b;                       // JSONB -> dizi
  const idx = kodlar.indexOf(KOD_OZET);
  if (idx === -1) { await c.query('COMMIT'); return { label, basarili: false, sebep: 'kod yok' }; }

  // Iki islemin OKUMA pencerelerini ust uste bindir — gercek es zamanlilik.
  await new Promise(res => setTimeout(res, gecikmeMs));

  kodlar.splice(idx, 1);
  await c.query('UPDATE users SET "twoFactorBackup" = $2::jsonb WHERE id = $1',
    [userId, JSON.stringify(kodlar)]);
  await c.query('COMMIT');
  return { label, basarili: true };
}

(async () => {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB}`);
  console.log('Tek kullanimlik veritabani:', DB, '\n');

  const setup = new Client({ connectionString: urlFor(DB) });
  await setup.connect();
  await setup.query(`CREATE TABLE users (id text primary key, "twoFactorBackup" jsonb)`);
  const userId = 'u1';
  await setup.query(`INSERT INTO users (id, "twoFactorBackup") VALUES ($1, $2::jsonb)`,
    [userId, JSON.stringify([KOD_OZET])]);
  await setup.end();

  // IKI AYRI BAGLANTI — gercek es zamanlilik.
  const a = new Client({ connectionString: urlFor(DB) });
  const b = new Client({ connectionString: urlFor(DB) });
  await a.connect(); await b.connect();

  // ── ESKI DESEN: oku -> kontrol et -> degistir -> yaz ────────────────────
  const [ra, rb] = await Promise.all([
    tuket(a, userId, 'A', 250),
    tuket(b, userId, 'B', 250),
  ]);
  const son = await a.query('SELECT "twoFactorBackup" AS b FROM users WHERE id = $1', [userId]);

  // ── YENI DESEN: tek kosullu UPDATE (uretimdeki hâli) ────────────────────
  await a.query(`UPDATE users SET "twoFactorBackup" = $2::jsonb WHERE id = $1`,
    [userId, JSON.stringify([KOD_OZET])]);

  const atomik = (c, label) => c.query(
    `UPDATE users
        SET "twoFactorBackup" = "twoFactorBackup" - $2
      WHERE id = $1 AND "twoFactorBackup" @> $3::jsonb`,
    [userId, KOD_OZET, JSON.stringify([KOD_OZET])],
  ).then(r => ({ label, basarili: (r.rowCount ?? 0) > 0 }));

  const [aa, ab] = await Promise.all([atomik(a, 'A'), atomik(b, 'B')]);
  const atomikBasarili = [aa, ab].filter(x => x.basarili).length;

  await a.end(); await b.end();
  await admin.query(`DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`);
  await admin.end();

  const basariliSayisi = [ra, rb].filter(x => x.basarili).length;
  console.log('A:', JSON.stringify(ra));
  console.log('B:', JSON.stringify(rb));
  console.log('son durum:', JSON.stringify(son.rows[0].b));
  console.log();
  console.log('ESKI DESEN  (oku-degistir-yaz)     :', basariliSayisi, '/ 2',
    basariliSayisi > 1 ? ' <-- IHLAL' : '');
  console.log('YENI DESEN  (atomik kosullu UPDATE) :', atomikBasarili, '/ 2',
    atomikBasarili > 1 ? ' <-- IHLAL' : ' <-- KORUNDU');
  console.log('temizlendi:', DB);
  // Uretim kodu ARTIK atomik deseni kullanir; gecer olcut odur.
  process.exit(atomikBasarili > 1 ? 1 : 0);
})().catch(e => { console.error('HATA', e.message); process.exit(2); });
