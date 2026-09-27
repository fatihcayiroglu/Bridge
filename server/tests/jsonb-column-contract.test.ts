// server/tests/jsonb-column-contract.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// SEMADAKI HER JSONB KOLONU SERIALIZE EDILMELI
// ════════════════════════════════════════════════════════════════════════════
// `pgCollection` yazmadan once yalnizca `JSONB_COLS` icindeki alanlari
// `JSON.stringify` eder. Bir kolon semada JSONB olup bu kumede DEGILSE, ona
// yazilan bir dizi/nesne PostgreSQL'e Postgres dizi soz dizimiyle gider ve
// sorgu `invalid input syntax for type json` ile duser — yani ozellik
// PostgreSQL uzerinde TAMAMEN calismaz.
//
// ── BU TESTIN DOGDUGU GERCEK KUSUR ──────────────────────────────────────────
// `webauthn_credentials.transports` semada JSONB'dir (migrations.ts:395) ama
// `JSONB_COLS` icinde YOKTU. Sonuc: passkey KAYDI gercek PostgreSQL uzerinde
// her seferinde 500 veriyordu. Sunucu paketinin tamami (4000+ test) geciyordu
// cunku birim testleri SAHTE veritabani kullanir ve sahte DB kolon TURU
// dogrulamasi YAPMAZ. Kusur ancak gercek tarayici + gercek Postgres ile
// uctan uca denendiginde ortaya cikti.
//
// Elle bakimli kolon listeleri ayni tuzagi tekrar uretir; bu yuzden test
// KANONIK SEMAYI OKUR ve kendini gunceller. Yeni bir JSONB kolonu eklenip
// kumeye yazilmazsa bu test duser.
//
// Kanonik sema kaynagi: db/postgres/migrations.ts (bkz. proje kurallari).

import fs from 'fs';
import path from 'path';

const SRV = path.join(__dirname, '..');
const MIGRATIONS = fs.readFileSync(path.join(SRV, 'db/postgres/migrations.ts'), 'utf8');
// `schema.ts` de kanonik bir sema kaynagidir (proje kurallari). Yalnizca
// `migrations.ts` okumak, orada tanimlanan JSONB kolonlarini gozden kacirirdi
// — ornegin `users."twoFactorBackup"`.
const SCHEMA = (() => {
  try { return fs.readFileSync(path.join(SRV, 'db/postgres/schema.ts'), 'utf8'); }
  catch { return ''; }
})();
const PGCOLLECTION = fs.readFileSync(path.join(SRV, 'db/postgres/pgCollection.ts'), 'utf8');

/**
 * TUM kanonik kaynaklardan JSONB kolonlarini toplar.
 *
 * ── ILK SURUMUN KOR NOKTASI ────────────────────────────────────────────────
 * Yalnizca `migrations.ts` icindeki `CREATE TABLE` bloklari taraniyordu. Oysa
 * JSONB kolonlari UC ayri sekilde tanimlanabiliyor:
 *   1. `CREATE TABLE ... ( "x" JSONB )`          (migrations.ts)
 *   2. `ALTER TABLE ... ADD COLUMN x JSONB`      (migrations.ts)
 *   3. `schema.ts` icindeki tablo tanimlari
 * Ikinci ve ucuncu grup tamamen gozden kaciyordu; `users."twoFactorBackup"`
 * ve `ADD COLUMN ... embeds JSONB` gibi kolonlar hic kontrol edilmiyordu.
 */
function semadakiJsonbKolonlari(): Array<{ tablo: string; kolon: string }> {
  const bulunan: Array<{ tablo: string; kolon: string }> = [];

  const createBloklari = (src: string) => {
    const tabloRe = /CREATE TABLE (?:IF NOT EXISTS )?"?([A-Za-z_][\w]*)"?\s*\(([\s\S]*?)\)\s*[`;]/g;
    let m: RegExpExecArray | null;
    while ((m = tabloRe.exec(src)) !== null) {
      const tablo = m[1] as string;
      for (const satir of (m[2] as string).split('\n')) {
        const k = satir.match(/^\s*"?([A-Za-z_][\w]*)"?\s+JSONB\b/i);
        if (k) bulunan.push({ tablo, kolon: k[1] as string });
      }
    }
  };
  createBloklari(MIGRATIONS);
  createBloklari(SCHEMA);

  // ALTER TABLE <tablo> ADD COLUMN [IF NOT EXISTS] <kolon> JSONB
  const alterRe = /ALTER TABLE\s+"?([A-Za-z_][\w]*)"?\s+ADD COLUMN(?:\s+IF NOT EXISTS)?\s+"?([A-Za-z_][\w]*)"?\s+JSONB\b/gi;
  let a: RegExpExecArray | null;
  while ((a = alterRe.exec(MIGRATIONS)) !== null) {
    bulunan.push({ tablo: a[1] as string, kolon: a[2] as string });
  }

  // Ayni kolon birden cok kaynakta gecebilir; tekillestir.
  const gorulen = new Set<string>();
  return bulunan.filter((c) => {
    const anahtar = `${c.tablo}.${c.kolon}`;
    if (gorulen.has(anahtar)) return false;
    gorulen.add(anahtar);
    return true;
  });
}

/** `JSONB_COLS = new Set([...])` literalindeki adlari cikarir. */
function serializeEdilenKolonlar(): Set<string> {
  // SIRA KRITIK: once YORUMLAR elenir, SONRA parantezler aranir.
  //
  // Ilk yazimda ters sirayla yapildi ve bu dosyadaki aciklama metninin
  // icindeki `'[]'` ifadesinin `]` karakteri, kume literalinin kapanisi
  // sanilarak dilim erken kesildi; sonucta kume BOS gorunup test yanlis yere
  // "kolon eksik" dedi. Kusur olcumdeydi, uründe degil.
  const kodSatirlari = PGCOLLECTION
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'));
    })
    .join('\n');

  const bas = kodSatirlari.indexOf('JSONB_COLS');
  expect(bas).toBeGreaterThan(-1);
  const acilis = kodSatirlari.indexOf('[', bas);
  const kapanis = kodSatirlari.indexOf(']', acilis);
  expect(kapanis).toBeGreaterThan(acilis);
  const govde = kodSatirlari.slice(acilis, kapanis);
  return new Set([...govde.matchAll(/'([^']+)'/g)].map((x) => x[1] as string));
}

describe('JSONB kolon sozlesmesi', () => {
  const semadakiler = semadakiJsonbKolonlari();
  const serialize = serializeEdilenKolonlar();

  it('POZITIF KONTROL: sema ayristirilabildi', () => {
    // Ayristirma sessizce bosa duserse test hicbir sey olcmeden gecerdi —
    // bu programda daha once tam olarak bu tuzaga dusuldu.
    expect(semadakiler.length).toBeGreaterThan(0);
    expect(serialize.size).toBeGreaterThan(5);
  });

  it('POZITIF KONTROL: bilinen JSONB kolonu kumede', () => {
    expect(serialize.has('readAt')).toBe(true);
  });

  // ── HAM SQL ILE YAZILAN TABLOLAR ──────────────────────────────────────────
  // `pgCollection` yalnizca KOLEKSIYON olarak erisilen tablolari serialize
  // eder. Ham `pool.query(...)` ile yazilan bir tablo kendi serializasyonunu
  // yapar; onu JSONB_COLS'a eklemek gereksizdir.
  //
  // Muafiyet KANITA dayanmalidir — yoksa bu liste, gercek kusurlari susturmak
  // icin kullanilan bir kacis kapisina donusur.
  const HAM_SQL_MUAF = new Map<string, string>([
    ['link_preview_cache.data',
     'lib/linkPreview.ts:97 — ham INSERT, deger acikca JSON.stringify(value) ile yazilir'],
  ]);

  it('muafiyetlerin her biri gerekcelidir', () => {
    for (const [, gerekce] of HAM_SQL_MUAF) {
      expect(gerekce.length).toBeGreaterThan(20);
    }
  });

  it('semadaki HER JSONB kolonu JSONB_COLS icinde olmali', () => {
    const eksik = semadakiler
      .filter((c) => !HAM_SQL_MUAF.has(`${c.tablo}.${c.kolon}`))
      .filter((c) => !serialize.has(c.kolon));
    // NOT: Jest'in `expect`i ikinci bir mesaj argumani ALMAZ (o Vitest'tir).
    // Bu yuzden aciklama, basarisizlikta gorunmesi icin DEGERIN ICINE konur.
    const rapor = eksik.map(
      (c) => `${c.tablo}.${c.kolon} — semada JSONB ama JSONB_COLS'da yok; ` +
             'buraya yazilan dizi/nesne PostgreSQL uzerinde 500 uretir',
    );
    expect(rapor).toEqual([]);
  });

  it('REGRESYON: webauthn_credentials.transports serialize edilir', () => {
    // Passkey kaydini PostgreSQL uzerinde tamamen kiran somut kusur.
    expect(semadakiler.some((c) => c.tablo === 'webauthn_credentials' && c.kolon === 'transports'))
      .toBe(true);
    expect(serialize.has('transports')).toBe(true);
  });
});
