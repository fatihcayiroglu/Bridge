#!/usr/bin/env node
//
// ════════════════════════════════════════════════════════════════════════════
// GERİ ALMA KAPISI — SINIFLANDIRILMIŞ, GERÇEK PostgreSQL ÜZERİNDE
// ════════════════════════════════════════════════════════════════════════════
// Bir `.down.sql` dosyasının VAR OLMASI hiçbir şey kanıtlamaz. Bu betik tek
// kullanımlık bir veritabanı kurar, tam zinciri uygular ve HER migration için
// ayrı ayrı ölçer:
//
//     şema anlık görüntüsü -> <name>.down.sql -> <name>.sql -> anlık görüntü
//
// İki görüntü aynı değilse o down betiği bir indeks, CHECK ya da NOT NULL
// bırakmış demektir. Her `up` `IF NOT EXISTS` kullandığı için böyle bir fark
// SESSİZ kalır — ta ki üretimde beklenmedik bir kısıt tetiklenene kadar.
//
// ── NEDEN TEK TEK, NEDEN TOPTAN DEĞİL ──────────────────────────────────────
// Zinciri toptan geri almak, aynı nesneyi paylaşan migration'ların birbirini
// örtmesine yol açar ve hatayı yanlış dosyaya yazar. Tek tek ölçüm, farkı
// doğru migration'a atfeder. `--ordered` ayrıca TÜM zinciri sırayla geri alıp
// yeniden uygulayarak, tek tek ölçümde "bağımlılık" diye sınıflandırılan
// vakaların gerçekten sıralı akışta çözüldüğünü KANITLAR.
//
// ── KAPI NEDEN KALICI KIRMIZI DEĞİL ────────────────────────────────────────
// Tarihsel borç `rollback-classification.json` içinde TEK TEK, gerekçesiyle
// ilan edilir. Joker yok, sürüm aralığı yok, "legacy" gibi genel gerekçe yok.
// Kapı şunlarda KIRMIZI olur:
//   · ilan edilmemiş bir fark ya da SQL hatası (yeni ACTUAL_FAILURE)
//   · LOSSLESS ilan edilen bir migration'ın bozulması
//   · ilan edilen fark ile ölçülen farkın uyuşmaması
//   · eksik `.down.sql`
//   · artık var olmayan bir migration için allowlist girdisi (çürüme)
//   · non-lossless ilan edilmiş ama artık lossless olan migration
//     (düzeltildiğinde allowlist KÜÇÜLMELİDİR)
//
// Kullanım:
//   PG_ADMIN_URL=postgresql://user:pass@host:port/postgres \
//   node scripts/verify-migration-rollback.js [--ordered] [--json]

const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const STATIC_ONLY = process.argv.includes('--static');
const ADMIN_URL = process.env.PG_ADMIN_URL || process.env.PG_TEST_URL;
let Client = null;
if (!STATIC_ONLY) {
  if (!ADMIN_URL) {
    console.error('PG_ADMIN_URL (veya PG_TEST_URL) gerekli. --static yalnız dosya/manifest bütünlüğünü doğrular.');
    process.exit(1);
  }
  try {
    ({ Client } = require('pg'));
  } catch {
    console.error('pg paketi gerekli. Ağsız source doğrulaması için --static kullanın.');
    process.exit(1);
  }
}

const SERVER_DIR   = path.resolve(__dirname, '..');
const MIGRATIONS   = path.join(SERVER_DIR, 'db', 'migrations_pg');
const ROLLBACK_DIR = path.join(MIGRATIONS, 'rollback');
const ALLOWLIST    = path.join(MIGRATIONS, 'rollback-classification.json');
const DB_NAME      = `bridge_rollback_proof_${Date.now().toString(36)}`;
const WANT_ORDERED = process.argv.includes('--ordered');
const AS_JSON      = process.argv.includes('--json');

// EXPECTED_SHARED_OBJECTS: migration, DAHA ESKI bir migration'in sahibi oldugu
// nesneleri yeniden tanimlar. Down'i o nesneleri DUSURMEZ, onceki sahibin
// tanimini GERI YUKLER; bu yuzden dogru davranis "yapisal fark YOK ama
// nesneler geride kalir"dir. Bu sinif icin fark olcmek BASARISIZLIKTIR.
const VALID_CLASSES = new Set([
  'EXPECTED_IRREVERSIBLE', 'EXPECTED_DEPENDENCY', 'EXPECTED_SHARED_OBJECTS', 'KNOWN_DEBT',
]);
const LEFTOVER_TAG = /^(?:TBL|IDX):[A-Za-z0-9_]+$/;

const raw = JSON.parse(fs.readFileSync(ALLOWLIST, 'utf8'));
const allow = {};
for (const [k, v] of Object.entries(raw)) {
  if (k.startsWith('$')) continue;
  allow[k] = v;
}


// Allowlist girdi butunlugu. Static mod ve gercek-DB modu AYNI kurallari
// uygulamak zorunda: kurallar iki yere kopyalandiginda biri sessizce geride
// kaliyordu.
function validateAllowlistEntries(idSet, sink) {
  for (const [id, entry] of Object.entries(allow)) {
    if (!idSet.has(id)) sink.push(`allowlist artık var olmayan migration içeriyor: ${id}`);
    const cls = entry.classification;
    if (!VALID_CLASSES.has(cls)) sink.push(`${id}: geçersiz sınıflandırma "${cls}"`);
    for (const field of ['expectedDifference', 'rationale']) {
      const v = entry[field];
      if (typeof v !== 'string' || v.trim().length < 30) sink.push(`${id}: "${field}" eksik ya da fazla genel`);
    }
    if (/\*|legacy migration|eski migration/i.test(String(entry.rationale))) {
      sink.push(`${id}: gerekçe joker/genel ifade içeriyor`);
    }
    const leftovers = entry.expectedLeftovers;
    if (leftovers !== undefined) {
      if (!Array.isArray(leftovers) || leftovers.length === 0) {
        sink.push(`${id}: "expectedLeftovers" boş ya da dizi değil`);
      } else {
        for (const tag of leftovers) {
          if (!LEFTOVER_TAG.test(String(tag))) {
            // Yanlis yazilmis bir etiket asla eslesmez ve denetimi SESSIZCE
            // devre disi birakirdi.
            sink.push(`${id}: geçersiz expectedLeftovers etiketi "${tag}" (TBL:ad ya da IDX:ad olmalı)`);
          }
        }
      }
    } else if (cls === 'EXPECTED_SHARED_OBJECTS') {
      sink.push(`${id}: EXPECTED_SHARED_OBJECTS "expectedLeftovers" ilan etmek ZORUNDA`);
    }
  }
}

function staticValidate() {
  const migrations = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
  const ids = migrations.map(f => f.replace(/\.sql$/, ''));
  const idSet = new Set(ids);
  const rollbackFiles = fs.readdirSync(ROLLBACK_DIR).filter(f => f.endsWith('.down.sql')).sort();
  const rollbackIds = rollbackFiles.map(f => f.replace(/\.down\.sql$/, ''));
  const staticProblems = [];

  for (const id of ids) {
    const upPath = path.join(MIGRATIONS, `${id}.sql`);
    const downPath = path.join(ROLLBACK_DIR, `${id}.down.sql`);
    if (!fs.existsSync(downPath)) staticProblems.push(`${id}: .down.sql YOK`);
    if (!fs.readFileSync(upPath, 'utf8').trim()) staticProblems.push(`${id}: up SQL BOŞ`);
    if (fs.existsSync(downPath) && !fs.readFileSync(downPath, 'utf8').trim()) staticProblems.push(`${id}: down SQL BOŞ`);
  }
  for (const id of rollbackIds) {
    if (!idSet.has(id)) staticProblems.push(`${id}: orphan rollback (up migration yok)`);
  }
  validateAllowlistEntries(idSet, staticProblems);

  const result = {
    mode: 'static',
    migrations: ids.length,
    rollbacks: rollbackIds.length,
    classified: Object.keys(allow).length,
    problems: staticProblems,
  };
  if (AS_JSON) console.log(JSON.stringify(result, null, 2));
  else {
    console.log(`migration : ${result.migrations}`);
    console.log(`rollback  : ${result.rollbacks}`);
    console.log(`classified: ${result.classified}`);
  }
  if (staticProblems.length) {
    console.error(`\n❌ Static rollback kapısı BAŞARISIZ (${staticProblems.length}):`);
    for (const problem of staticProblems) console.error(`   · ${problem}`);
    process.exit(1);
  }
  console.log('\n✅ Static rollback bütünlüğü geçti. Gerçek lossless/ordered kanıt için PostgreSQL DB modu ayrıca zorunludur.');
  process.exit(0);
}

if (STATIC_ONLY) staticValidate();

function urlFor(dbName) { const u = new URL(ADMIN_URL); u.pathname = `/${dbName}`; return u.toString(); }

const SNAPSHOT_SQL = `
SELECT coalesce(string_agg(line, E'\\n' ORDER BY line), '') AS snap FROM (
  SELECT format('COL %s.%s %s null=%s default=%s',
                table_name, column_name, data_type, is_nullable,
                coalesce(column_default, '-')) AS line
    FROM information_schema.columns WHERE table_schema = 'public'
  UNION ALL
  SELECT format('IDX %s', indexdef) FROM pg_indexes WHERE schemaname = 'public'
  UNION ALL
  SELECT format('CON %s.%s %s', rel.relname, con.conname, pg_get_constraintdef(con.oid))
    FROM pg_constraint con
    JOIN pg_class rel     ON rel.oid = con.conrelid
    JOIN pg_namespace ns  ON ns.oid  = rel.relnamespace
   WHERE ns.nspname = 'public'
) t;`;

// ts-node CLI is run with the current Node binary. `npx` needed `shell: true` on
// Windows, and Node 24 flags an args array passed through a shell (DEP0190: the
// arguments are concatenated, not escaped).
// Resolved lazily: `--static` must keep working without dev dependencies.
function runTs(script, args, dbUrl) {
  const tsNodeBin = require.resolve('ts-node/dist/bin', { paths: [SERVER_DIR] });
  return execFileSync(process.execPath, [tsNodeBin, '--project', 'tsconfig.json', script, ...args], {
    cwd: SERVER_DIR,
    env: { ...process.env, DATABASE_URL: dbUrl, PG_TEST_URL: dbUrl, NODE_ENV: 'test' },
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const snapshot = async (c) => (await c.query(SNAPSHOT_SQL)).rows[0].snap || '';

/**
 * Bir `up` betiğinin OLUŞTURDUĞU adlandırılmış nesneleri çıkarır.
 *
 * ── NEDEN GEREKLİ ──────────────────────────────────────────────────────────
 * Yalnızca "önce/sonra" karşılaştırması, GERİDE NESNE BIRAKAN bir down
 * betiğini GÖREMEZ: `up` zaten `CREATE ... IF NOT EXISTS` kullandığı için
 * nesneyi yeniden oluşturur ve iki görüntü aynı çıkar.
 *
 * Negatif kontrolle ölçüldü: `010_bot_marketplace` down betiğinden
 * `DROP INDEX idx_bmp_category` satırı KASITLI olarak silindiğinde kapı yine
 * YEŞİL kalıyordu. Kapının o hâli, tam olarak yakalamayı iddia ettiği sınıfı
 * kaçırıyordu.
 *
 * Artık down'dan SONRAKİ görüntüde bu adların YOK olması da denetlenir.
 */
function objectsCreatedBy(sql) {
  const names = new Set();
  const stripped = sql.replace(/^\s*--.*$/gm, '');
  const idx = /CREATE\s+(?:UNIQUE\s+)?INDEX\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
  const tbl = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?"?([A-Za-z0-9_]+)"?/gi;
  let m;
  while ((m = idx.exec(stripped))) names.add(`IDX:${m[1]}`);
  while ((m = tbl.exec(stripped))) names.add(`TBL:${m[1]}`);
  return names;
}

function diffLines(before, after) {
  const b = new Set(before.split('\n'));
  const a = new Set(after.split('\n'));
  return {
    lost:  [...b].filter(x => x && !a.has(x)),
    extra: [...a].filter(x => x && !b.has(x)),
  };
}

const problems = [];
const results  = [];

async function main() {
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${DB_NAME}`);
  await admin.end();
  const dbUrl = urlFor(DB_NAME);

  try {
    if (!AS_JSON) console.log(`şablon veritabanı : ${DB_NAME}\n`);
    runTs('db/postgres/index.ts', [], dbUrl);
    runTs('db/migrate-postgres.ts', ['up'], dbUrl);

    // ── ÖLÇÜM İZOLASYONU ──────────────────────────────────────────────────
    // Bu döngü eskiden TEK ve PAYLAŞILAN bir veritabanını yerinde
    // değiştiriyordu. Bir tablo OLUŞTURAN migration'ın izole down/up çevrimi
    // o tabloyu düşürüp SONRAKİ migration'ların ona eklediği sütun/kısıt/
    // indeksleri de silince, `up` tabloyu o eklemeler OLMADAN yeniden
    // yaratıyordu. Veritabanı o andan itibaren BOZUKTU ve kalan her ölçüm
    // yanlış temele göre yapılıyordu:
    //
    //   010_bot_marketplace  down/up  →  070'in "executableBotId" sütunu,
    //                                    FK'si ve tekil indeksi YOK OLUR
    //   ... sonra 070'e gelindiğinde  →  "0 kayıp / 3 fazla" olarak,
    //                                    yani 070'in KENDİ kusuru gibi raporlanır
    //
    // Aynı yanlış atıf 025→064 (saved_messages) ve 024→067 (notifications
    // inbox indeksleri) çiftlerinde de üretiliyordu. Dosya başlığının vaat
    // ettiği "farkı DOĞRU migration'a atfetme" özelliği bu yüzden geçerli
    // değildi ve `--ordered` zincir kanıtı da bozulmuş bir temelden
    // ölçülüyordu.
    //
    // ÇÖZÜM: tam göç edilmiş şema bir ŞABLON olarak tutulur; her migration
    // kendi tek kullanımlık kopyasında ölçülür. `CREATE DATABASE ... TEMPLATE`
    // dosya düzeyinde kopyalama yaptığı için bu ucuzdur, ama şablona bağlı
    // oturum KALMAMALIDIR — bu yüzden ölçüm istemcileri hep çocuk veritabanına
    // bağlanır ve çevrim bitince kapatılır.
    const childDbs = [];
    const withChildDb = async (label, fn) => {
      const childName = `${DB_NAME}_${label}`.slice(0, 60).replace(/[^a-z0-9_]/gi, '_').toLowerCase();
      const adminC = new Client({ connectionString: ADMIN_URL });
      await adminC.connect();
      await adminC.query(`DROP DATABASE IF EXISTS ${childName} WITH (FORCE)`);
      await adminC.query(`CREATE DATABASE ${childName} TEMPLATE ${DB_NAME}`);
      await adminC.end();
      childDbs.push(childName);
      const childUrl = urlFor(childName);
      const c = new Client({ connectionString: childUrl });
      await c.connect();
      try {
        return await fn(c, childUrl);
      } finally {
        await c.end().catch(() => {});
        const dropC = new Client({ connectionString: ADMIN_URL });
        await dropC.connect();
        await dropC.query(`DROP DATABASE IF EXISTS ${childName} WITH (FORCE)`);
        await dropC.end();
        childDbs.pop();
      }
    };

    const migrations = fs.readdirSync(MIGRATIONS).filter(f => f.endsWith('.sql')).sort();
    const ids = migrations.map(f => f.replace(/\.sql$/, ''));

    // ── Allowlist bütünlüğü: çürümüş girdi = kırmızı ────────────────────────
    validateAllowlistEntries(new Set(ids), problems);

    if (!AS_JSON) {
      console.log(`${migrations.length} migration bulundu.\n`);
      console.log(`${'migration'.padEnd(44)} ${'ölçülen'.padEnd(14)} sınıf`);
      console.log('-'.repeat(84));
    }

    for (const file of migrations) {
      const name = file.replace(/\.sql$/, '');
      const downPath = path.join(ROLLBACK_DIR, `${name}.down.sql`);

      if (!fs.existsSync(downPath)) {
        results.push({ name, measured: 'NO_DOWN' });
        problems.push(`${name}: .down.sql YOK`);
        if (!AS_JSON) console.log(`${name.padEnd(44)} ${'DOWN YOK'.padEnd(14)} ACTUAL_FAILURE`);
        continue;
      }

      // Her migration KENDI kopyasinda olculur: onceki bir migration'in
      // izole down/up cevrimi bu olcumun temelini artik bozamaz.
      const cycle = await withChildDb(name, async (client) => {
        const before = await snapshot(client);
        let measured = 'LOSSLESS', detail = '', diff = { lost: [], extra: [] };

        try {
          await client.query(fs.readFileSync(downPath, 'utf8'));
        } catch (err) {
          measured = 'DOWN_FAILED'; detail = err.message.split('\n')[0];
          await client.query('ROLLBACK').catch(() => {});
        }

        // ── DOWN TAMLIĞI: geride nesne bırakıldı mı? ──────────────────────────
        // Bu denetim, `up`'ın nesneyi yeniden oluşturmasıyla ÖRTÜLEN bir eksik
        // DROP'u yakalar. Önce/sonra karşılaştırması bunu göremez.
        const leftovers = [];
        const staleLeftovers = [];
        const upSql = fs.readFileSync(path.join(MIGRATIONS, file), 'utf8');
        if (measured === 'LOSSLESS') {
          // Katalogdan DOĞRUDAN sorulur. Anlık görüntü metnini regex'lemek
          // belirsizdi; `pg_indexes`/`information_schema` kesin cevap verir.
          const declaredLeftovers = new Set(allow[name]?.expectedLeftovers || []);
          // Ilan edilen artik nesneler de SORGULANIR. Eskiden yalnizca
          // `continue` ediliyorlardi; boylece down duzeltilip nesneyi gercekten
          // dusurmeye baslasa bile ilan sonsuza kadar gecerli gorunuyor ve
          // ileride ayni nesne yeniden geride kalirsa kapiyi SESSIZCE aciyordu.
          for (const tagged of new Set([...objectsCreatedBy(upSql), ...declaredLeftovers])) {
            const [kind, objName] = tagged.split(':');
            const q = kind === 'IDX'
              ? await client.query(
                  "SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname=$1", [objName])
              : await client.query(
                  "SELECT 1 FROM information_schema.tables WHERE table_schema='public' AND table_name=$1", [objName]);
            const present = q.rowCount > 0;
            if (declaredLeftovers.has(tagged)) {
              if (!present) staleLeftovers.push(tagged);
            } else if (present) {
              leftovers.push(tagged);
            }
          }
        }

        if (measured === 'LOSSLESS') {
          try {
            await client.query(upSql);
          } catch (err) {
            measured = 'REUP_FAILED'; detail = err.message.split('\n')[0];
            await client.query('ROLLBACK').catch(() => {});
          }
        }

        if (measured === 'LOSSLESS' && leftovers.length) {
          measured = 'DOWN_INCOMPLETE';
          detail = `down geride bıraktı: ${leftovers.join(', ')}`;
        }

        if (measured === 'LOSSLESS') {
          const after = await snapshot(client);
          if (after !== before) {
            measured = 'DRIFT';
            diff = diffLines(before, after);
            detail = `${diff.lost.length} kayıp / ${diff.extra.length} fazla`;
          }
        }

        return { measured, detail, diff, leftovers, staleLeftovers };
      });
      const { measured, detail, diff } = cycle;

      // ── Ölçüm ile İLAN karşılaştırılır ───────────────────────────────────
      const declared = allow[name];
      if (cycle.staleLeftovers.length) {
        problems.push(
          `${name}: ilan edilen artık nesneler aslında geride BIRAKILMIYOR: ` +
          `${cycle.staleLeftovers.join(', ')}. expectedLeftovers güncellenmeli.`);
      }
      let verdict;
      if (measured === 'LOSSLESS') {
        if (declared && declared.classification === 'EXPECTED_SHARED_OBJECTS') {
          // Bu sinif icin KAYIPSIZ olmak BEKLENEN sonuctur: migration baskasinin
          // nesnesini yeniden tanimlar, down onceki tanimi geri yukler.
          verdict = 'EXPECTED_SHARED_OBJECTS';
        } else {
          verdict = 'LOSSLESS_PASS';
          if (declared) {
            problems.push(
              `${name}: allowlist "${declared.classification}" diyor ama artık KAYIPSIZ. ` +
              'Düzeltildiyse allowlist girdisi KALDIRILMALI.');
          }
        }
      } else if (!declared) {
        verdict = 'ACTUAL_FAILURE';
        problems.push(`${name}: sınıflandırılmamış ${measured} — ${detail}`);
      } else if (declared.classification === 'EXPECTED_SHARED_OBJECTS') {
        // Ilan YAPISAL FARK VAAT ETMEZ; olculen fark gercek bir kusurdur.
        verdict = 'ACTUAL_FAILURE';
        problems.push(
          `${name}: EXPECTED_SHARED_OBJECTS yapısal fark vaat etmez ama ${measured} ölçüldü — ${detail}`);
      } else {
        verdict = declared.classification;
        // İlan edilen fark, ölçülenle bağdaşmalı: DOWN/REUP hatası ilan
        // edilmişse metin eşleşmeli; yapısal farksa fark BOŞ OLMAMALI.
        const expects = String(declared.expectedDifference);
        if (measured === 'DOWN_FAILED' || measured === 'REUP_FAILED') {
          const key = detail.slice(0, 40);
          if (!expects.includes(key.split(':')[0].trim().slice(0, 20))) {
            problems.push(
              `${name}: ilan edilen fark ölçülenle uyuşmuyor.\n` +
              `      ilan   : ${expects}\n` +
              `      ölçülen: ${measured}: ${detail}`);
          }
        } else if (measured === 'DRIFT') {
          // ── ALLOWLIST BAĞLAYICI OLMALI ─────────────────────────────────
          // Yalnızca "bir girdi var" demek yeterli değildi: farkın ŞEKLİ
          // değişse bile kapı yeşil kalırdı. Farktan etkilenen HER NESNE
          // adı, ilan metninde geçmek ZORUNDA. Yeni bir nesne sürüklenmeye
          // başlarsa kapı kırmızıya döner ve ilan güncellenmek zorunda kalır.
          const objects = new Set();
          for (const line of [...diff.lost, ...diff.extra]) {
            let m;
            if ((m = line.match(/^COL (\S+)/)))              objects.add(m[1]);
            else if ((m = line.match(/^CON \S+\.(\S+)/)))    objects.add(m[1]);
            else if ((m = line.match(/INDEX "?([A-Za-z0-9_]+)"?/))) objects.add(m[1]);
          }
          const lower = expects.toLowerCase();
          const undeclared = [...objects].filter(o => {
            const bare = o.includes('.') ? o.split('.').pop() : o;
            return !lower.includes(o.toLowerCase()) && !lower.includes(String(bare).toLowerCase());
          });
          if (undeclared.length) {
            problems.push(
              `${name}: ilan edilmeyen nesneler sürükleniyor: ${undeclared.join(', ')}\n` +
              `      ilan: ${expects}`);
          }
        }
      }

      results.push({ name, measured, detail, verdict, diff, declared: !!declared });
      if (!AS_JSON) {
        const mark = verdict === 'LOSSLESS_PASS' ? '✅' : verdict === 'ACTUAL_FAILURE' ? '❌' : '⚠ ';
        console.log(`${name.padEnd(44)} ${(measured + (detail ? ` (${detail})` : '')).slice(0, 13).padEnd(14)} ${mark} ${verdict}`);
      }
    }

    // Sablona bagli uzun omurlu oturum yok: her cevrim kendi cocuk
    // veritabanina baglanir ve kapanir.

    // ── İsteğe bağlı: SIRALI zincir kanıtı ──────────────────────────────────
    if (WANT_ORDERED) {
      if (!AS_JSON) console.log('\n── SIRALI zincir geri alma (bağımlılık vakalarının kanıtı) ──');
      const c2 = new Client({ connectionString: dbUrl });
      await c2.connect();
      const beforeChain = await snapshot(c2);
      await c2.end();

      let orderedOk = true, orderedDetail = '';
      try {
        runTs('db/migrate-postgres.ts', ['rollback', String(migrations.length)], dbUrl);
        runTs('db/migrate-postgres.ts', ['up'], dbUrl);
      } catch (err) {
        orderedOk = false;
        // Son satırı almak YANILTICIYDI: koşucu hata satırını bastıktan sonra
        // da ilerleme satırları basabiliyor. Hata satırı açıkça ARANIR.
        const out = String(err.stdout || '') + String(err.stderr || '') + String(err.message || '');
        const lines = out.split('\n').map(l => l.trim()).filter(Boolean);
        const idx = lines.findIndex(l => l.includes('❌') || /başarısız|basarisiz/i.test(l));
        orderedDetail = idx >= 0 ? lines.slice(idx, idx + 2).join(' | ') : lines.slice(-3).join(' | ');
      }

      const c3 = new Client({ connectionString: dbUrl });
      await c3.connect();
      const afterChain = await snapshot(c3);
      await c3.end();

      const d = diffLines(beforeChain, afterChain);
      if (!orderedOk) {
        problems.push(`sıralı zincir geri alma HATA verdi: ${orderedDetail}`);
      }
      // ── ZİNCİR FARKI ARTIK BAĞLAYICI ────────────────────────────────────
      // Bu fark eskiden yalnızca EKRANA BASILIYORDU: tam bir geri alma +
      // yeniden uygulama şemayı değiştirse bile kapı yeşil kalıyordu. Oysa
      // aranan değişmez tam olarak budur — temiz kurulum (schema.ts) ile
      // migration zinciri aynı şemayı üretmek ZORUNDA. İki gerçek ayrışma
      // (user_ap_keys."keyVersion" DEFAULT'u ve server_events CHECK adı)
      // tam olarak bu sessizlik yüzünden gözden kaçmıştı.
      if (d.lost.length || d.extra.length) {
        const sample = [
          ...d.lost.map(x => `KAYIP ${x}`),
          ...d.extra.map(x => `FAZLA ${x}`),
        ].slice(0, 8).join('\n        ');
        problems.push(
          `sıralı zincir geri alma + yeniden uygulama şemayı DEĞİŞTİRDİ ` +
          `(${d.lost.length} kayıp / ${d.extra.length} fazla):\n        ${sample}`);
      }
      if (!AS_JSON) {
        console.log(`   tüm zincir geri alındı ve yeniden uygulandı : ${orderedOk ? 'OK' : 'HATA'}`);
        console.log(`   şema farkı                                  : ${d.lost.length} kayıp / ${d.extra.length} fazla`);
        for (const l of d.lost.slice(0, 10))  console.log(`      KAYIP : ${l}`);
        for (const e of d.extra.slice(0, 10)) console.log(`      FAZLA : ${e}`);
      }
      results.push({ ordered: { ok: orderedOk, lost: d.lost, extra: d.extra } });
    }
  } catch (err) {
    problems.push(`HATA: ${err.stdout ? String(err.stdout).slice(-1500) : err.message}`);
  } finally {
    const cleanup = new Client({ connectionString: ADMIN_URL });
    await cleanup.connect();
    await cleanup.query(`DROP DATABASE IF EXISTS ${DB_NAME} WITH (FORCE)`);
    await cleanup.end();
  }

  const counts = results.reduce((acc, r) => {
    if (r.verdict) acc[r.verdict] = (acc[r.verdict] || 0) + 1;
    return acc;
  }, {});

  if (AS_JSON) {
    console.log(JSON.stringify({ counts, problems, results }, null, 2));
  } else {
    console.log('\n' + '='.repeat(84));
    for (const k of ['LOSSLESS_PASS', 'EXPECTED_IRREVERSIBLE', 'EXPECTED_DEPENDENCY',
                     'EXPECTED_SHARED_OBJECTS', 'KNOWN_DEBT', 'ACTUAL_FAILURE']) {
      console.log(`${k.padEnd(24)} : ${counts[k] || 0}`);
    }
    for (const r of results.filter(x => x.verdict && x.verdict !== 'LOSSLESS_PASS')) {
      console.log(`\n── ${r.name}  [${r.verdict}]`);
      if (r.detail) console.log(`   ölçülen: ${r.measured}: ${r.detail}`);
      for (const l of (r.diff?.lost  || []).slice(0, 6)) console.log(`   KAYIP : ${l}`);
      for (const e of (r.diff?.extra || []).slice(0, 6)) console.log(`   FAZLA : ${e}`);
    }
  }

  if (problems.length) {
    console.error(`\n❌ Kapı BAŞARISIZ (${problems.length}):`);
    for (const p of problems) console.error(`   · ${p}`);
    process.exit(1);
  }
  console.log('\n✅ Her migration ya kayıpsız ya da tek tek gerekçelendirilmiş.');
  process.exit(0);
}

main().catch(err => { console.error(err); process.exit(1); });
