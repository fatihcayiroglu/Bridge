// server/scripts/verify-sticker-persistence.ts
// GERÇEK PostgreSQL kalıcılık/atomiklik kanıtı (migrations_pg/021).
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU BETİK VAR
// ════════════════════════════════════════════════════════════════════════════
// Jest paketi `db/loader`'ı mock'lar; mockDb ROLLBACK uygulamaz ve süreç
// yeniden başlatmasını taklit edemez. Atomiklik ve dayanıklılık için YETKİLİ
// kanıt budur: gerçek pool, gerçek transaction, gerçek tablolar.
//
// Kullanım (server/ dizininden):
//   DATABASE_URL=... npx ts-node --project tsconfig.json scripts/verify-sticker-persistence.ts write
//   DATABASE_URL=... npx ts-node --project tsconfig.json scripts/verify-sticker-persistence.ts verify <serverId>
//   DATABASE_URL=... npx ts-node --project tsconfig.json scripts/verify-sticker-persistence.ts cleanup <serverId>
//
// `write` ve `verify` AYRI süreçlerde çalıştırılır: yazan süreç ölür, okuyan
// süreç sıfırdan bağlanır. Bu, "yeniden başlatmadan sonra veri duruyor mu"
// sorusunun gerçek cevabıdır.
//
// GÜVENLİK: yalnız `__sticker_persistence_probe_` ile başlayan benzersiz
// işaretli kayıtlara dokunur. Hiçbir zaman toplu DELETE/TRUNCATE yapmaz.

import { v4 as uuidv4 } from 'uuid';
import { ServerAssets } from '../db/repositories';
import { pool } from '../db/postgres/pool';

const MARKER = '__sticker_persistence_probe_';

function ok(msg: string): void { process.stdout.write(`  ✅ ${msg}\n`); }

/**
 * Hata fırlatır — `process.exit()` KULLANMAZ: Windows'ta boru hattına yazarken
 * exit() bekleyen stdout yazımlarını kesebiliyor ve başarısızlık sebebi
 * görünmeden kayboluyordu. Fırlatılan hata main() içinde yakalanıp basılır.
 */
function fail(msg: string): never {
  process.stdout.write(`  ❌ ${msg}\n`);
  throw new Error(msg);
}

function assert(cond: unknown, msg: string): void {
  if (cond) ok(msg); else fail(msg);
}

/**
 * Silme yapan her komutun kapısı: kapsam BENZERSİZ probe işareti taşımalı.
 * Gerçek bir sunucu kimliği verilirse betik hiçbir şey yapmadan durur.
 */
function requireProbeScope(serverId: string): void {
  if (!serverId.startsWith(MARKER)) {
    fail(`GÜVENLİK: kapsam "${MARKER}" ile başlamalı — "${serverId}" reddedildi`);
  }
}

/** Verilen kapsamdaki paket/öğe sayısı (yalnız probe kapsamlarıyla çağrılır). */
async function countProbe(serverId: string): Promise<{ packs: number; items: number }> {
  const p = await pool.query('SELECT COUNT(*)::int AS n FROM sticker_packs WHERE "serverId" = $1', [serverId]);
  const i = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sticker_pack_items it
       JOIN sticker_packs pk ON pk._id = it."packId"
      WHERE pk."serverId" = $1`,
    [serverId],
  );
  return { packs: p.rows[0].n, items: i.rows[0].n };
}

// ── write ───────────────────────────────────────────────────────────────────
async function cmdWrite(): Promise<void> {
  const serverId = `${MARKER}${uuidv4()}`;
  process.stdout.write(`\nYAZMA SÜRECİ — serverId=${serverId}\n`);

  // Aynı milisaniyede iki paket: sıralamanın createdAt'e DEĞİL seq'e
  // dayandığını kanıtlar.
  const sharedTs = Date.now();
  const firstId  = uuidv4();
  const secondId = uuidv4();

  await ServerAssets.createStickerPack({
    packId: firstId, serverId, name: 'Birinci', description: 'ilk',
    authorId: `${MARKER}author`, createdAt: sharedTs,
    items: [
      { id: uuidv4(), name: 'bir',  url: '/uploads/stickers/bir.png',  tags: ['a'], width: 160, height: 160 },
      { id: uuidv4(), name: 'iki',  url: '/uploads/stickers/iki.png',  tags: [],    width: 160, height: 160 },
      { id: uuidv4(), name: 'uc',   url: '/uploads/stickers/uc.png',   tags: [],    width: 160, height: 160 },
    ],
  });
  await ServerAssets.createStickerPack({
    packId: secondId, serverId, name: 'Ikinci', description: '',
    authorId: `${MARKER}author`, createdAt: sharedTs,
    items: [{ id: uuidv4(), name: 'dort', url: '/uploads/stickers/dort.png', tags: [], width: 160, height: 160 }],
  });

  const counts = await countProbe(serverId);
  assert(counts.packs === 2, `2 paket yazıldı (${counts.packs})`);
  assert(counts.items === 4, `4 öğe yazıldı (${counts.items})`);

  // ── ATOMİKLİK: ikinci öğe INSERT'i patlar → HİÇBİR ŞEY kalıcı olmamalı ──
  process.stdout.write('\nATOMİKLİK DENEYİ (kasıtlı hata)\n');
  const doomedPackId = uuidv4();
  let threw = false;
  try {
    await ServerAssets.createStickerPack({
      packId: doomedPackId, serverId, name: 'Yarim-Kalacak', description: '',
      authorId: `${MARKER}author`, createdAt: Date.now(),
      items: [
        { id: uuidv4(), name: 'saglam', url: '/uploads/stickers/s.png', tags: [], width: 160, height: 160 },
        // width tamsayı sütunu — geçersiz değer INSERT'i patlatır.
        { id: uuidv4(), name: 'bozuk',  url: '/uploads/stickers/b.png', tags: [],
          width: 'PATLA' as unknown as number, height: 160 },
      ],
    });
  } catch {
    threw = true;
  }
  assert(threw, 'oluşturma hata fırlattı');

  const afterFail = await countProbe(serverId);
  assert(afterFail.packs === 2, `paket sayısı DEĞİŞMEDİ — yarım paket yok (${afterFail.packs})`);
  assert(afterFail.items === 4, `öğe sayısı DEĞİŞMEDİ — yetim öğe yok (${afterFail.items})`);

  const orphan = await pool.query('SELECT 1 FROM sticker_packs WHERE _id = $1', [doomedPackId]);
  assert(orphan.rowCount === 0, 'başarısız paketin satırı ROLLBACK edildi');

  process.stdout.write(`\nSERVER_ID=${serverId}\n`);
}

// ── verify (AYRI SÜREÇ = yeniden başlatma) ──────────────────────────────────
async function cmdVerify(serverId: string): Promise<void> {
  // GÜVENLİK KAPISI: bu komut cascade'i kanıtlamak için BİR paketi siler.
  // İşaret kontrolü olmadan `verify <gercekSunucuId>` çağrısı gerçek bir
  // paketi silebilirdi. Silme yapan HER komut aynı kapıdan geçmelidir.
  requireProbeScope(serverId);
  process.stdout.write(`\nDOĞRULAMA SÜRECİ (taze bağlantı) — serverId=${serverId}\n`);

  const packs = await ServerAssets.findStickerPacksByServer(serverId);
  assert(packs.length === 2, `yeniden başlatmadan SONRA 2 paket duruyor (${packs.length})`);

  // Sıralama: seq'e göre ekleme sırası (createdAt ikisinde de AYNI).
  assert(packs[0]!.name === 'Birinci' && packs[1]!.name === 'Ikinci',
    'paket sırası ekleme sırasını koruyor (seq)');
  assert(Number(packs[0]!.createdAt) === Number(packs[1]!.createdAt),
    'iki paketin createdAt değeri gerçekten AYNI — sıra createdAt ile gelmiyor');

  const items = await ServerAssets.findStickerItemsByPackIds(packs.map(p => p._id));
  assert(items.length === 4, `4 öğe duruyor (${items.length})`);

  const firstItems = items.filter(i => i.packId === packs[0]!._id);
  assert(firstItems.map(i => i.name).join(',') === 'bir,iki,uc',
    'öğe sırası yükleme sırasını koruyor (position)');

  // tags JSONB doğru tipte geri geliyor mu?
  assert(Array.isArray(firstItems[0]!.tags) && firstItems[0]!.tags[0] === 'a',
    'tags JSONB dizisi olarak geri okundu');

  // createdAt BIGINT'tir — node-postgres onu STRING döndürür (global tip
  // ayrıştırıcı yok). Route bunu Number() ile sayıya çevirir.
  const raw = packs[0]!.createdAt;
  process.stdout.write(`  ℹ  ham createdAt tipi: ${typeof raw} → Number(): ${typeof Number(raw)}\n`);
  assert(Number.isFinite(Number(raw)), 'createdAt sayıya güvenle çevrilebiliyor');

  // ── CASCADE: paket silinince öğeleri de gitmeli ──
  const victim = packs[1]!._id;
  await pool.query('DELETE FROM sticker_packs WHERE _id = $1', [victim]);
  const left = await pool.query('SELECT COUNT(*)::int AS n FROM sticker_pack_items WHERE "packId" = $1', [victim]);
  assert(left.rows[0].n === 0, 'FK ON DELETE CASCADE öğeleri düşürdü');

  // ── Sunucular arası yalıtım: başka serverId ile görünmemeli ──
  const foreign = await ServerAssets.findStickerPackByIdAndServer(
    packs[0]!._id, `${MARKER}baska-sunucu`,
  );
  assert(!foreign, 'paket BAŞKA sunucu kapsamında bulunamıyor');
}

// ── cleanup ─────────────────────────────────────────────────────────────────
async function cmdCleanup(serverId: string): Promise<void> {
  requireProbeScope(serverId);
  // Öğeler FK cascade ile gider; yine de açık sayım yapalım.
  const before = await countProbe(serverId);
  const res = await pool.query('DELETE FROM sticker_packs WHERE "serverId" = $1', [serverId]);
  const after = await countProbe(serverId);
  process.stdout.write(`\nTEMİZLİK — silinen paket: ${res.rowCount} (önce ${before.packs}/${before.items})\n`);
  assert(after.packs === 0 && after.items === 0, 'işaretli tüm kayıtlar silindi');

  const leftover = await pool.query(
    `SELECT COUNT(*)::int AS n FROM sticker_packs WHERE "serverId" LIKE $1`, [`${MARKER}%`],
  );
  assert(leftover.rows[0].n === 0, 'geriye HİÇ probe kaydı kalmadı');
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  try {
    if (cmd === 'write')        await cmdWrite();
    else if (cmd === 'verify')  await cmdVerify(String(arg));
    else if (cmd === 'cleanup') await cmdCleanup(String(arg));
    else fail('kullanım: write | verify <serverId> | cleanup <serverId>');
    process.stdout.write('\nSONUC: TAMAM\n');
  } catch (err) {
    process.stdout.write(`\nSONUC: BASARISIZ — ${(err as Error).message}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

void main();
