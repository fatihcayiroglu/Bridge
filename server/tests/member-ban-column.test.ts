// server/tests/member-ban-column.test.ts
//
// YASAKLAMA — SÜTUN HİÇ YOKTU
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `MemberRepository` üç yerde `banned` alanını kullanıyordu:
//     findBans   → db.members.find({ serverId, banned: true })
//     insertBan  → db.members.insert({ ..., banned: true })
//     removeBan  → db.members.remove({ ..., banned: true })
//
// Ama `members` tablosunda böyle bir sütun YOKTU. Canlı veritabanındaki
// gerçek sütunlar: joinedAt, roles, serverId, timeoutUntil, userId, verified.
//
// ÖLÇÜLEN ETKİ: `GET /api/servers/:sid/bans` → 500, ve moderasyon sekmesi
// "Ban listesi yüklenemedi (500)." gösteriyordu (ekran görüntüsüyle
// doğrulandı). Arayüzde "Yasakla" düğmesi vardı ama veri katmanı yoktu —
// yasaklama KALICI DEĞİLDİ.
//
// pgCollection'ın sütun beyaz listesi hatayı DOĞRU yakalıyordu (SQL enjeksiyon
// koruması); eksik olan sütunun kendisiydi. Bu yüzden düzeltme beyaz listeyi
// gevşetmek DEĞİL, sütunu eklemekti (migrations_pg/029).

process.env.NODE_ENV = 'test';

import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SERVER = join(__dirname, '..');

describe('members.banned — şema ve beyaz liste tutarlı', () => {
  it('kanonik şema `banned` sütununu tanımlar', () => {
    const schema = readFileSync(join(SERVER, 'db', 'postgres', 'schema.ts'), 'utf8');
    const members = schema.slice(schema.indexOf('CREATE TABLE IF NOT EXISTS members'));
    const body = members.slice(0, members.indexOf(');'));
    expect(body).toMatch(/banned\s+BOOLEAN/i);
  });

  it('bir GEÇİŞ dosyası sütunu mevcut kurulumlara ekler', () => {
    // Yalnızca şemayı güncellemek YETMEZ: çalışan veritabanları geçiş ister.
    const dir = join(SERVER, 'db', 'migrations_pg');
    const found = readdirSync(dir).some((f) => {
      if (!f.endsWith('.sql')) return false;
      const sql = readFileSync(join(dir, f), 'utf8');
      return /ALTER TABLE members[\s\S]*ADD COLUMN[\s\S]*banned/i.test(sql);
    });
    // Jest tek argüman alır (Vitest gibi mesaj kabul etmez).
    expect(found).toBe(true);
  });

  it('sütun beyaz listesi `banned` içerir', () => {
    // Beyaz liste bir GÜVENLİK kontrolüdür (SQL enjeksiyonu). Kusur onun
    // katı olması değil, sütunun eksik olmasıydı.
    const pg = readFileSync(join(SERVER, 'db', 'postgres', 'pgCollection.ts'), 'utf8');
    const allow = pg.slice(pg.indexOf('ALLOWED_COLUMNS'), pg.indexOf('ALLOWED_COLUMNS') + 2000);
    expect(allow).toContain("'banned'");
  });

  it('repository ile şema AYNI alan adını kullanır', () => {
    // İsim kayması tam olarak bu kusuru üretmişti.
    const repo = readFileSync(join(SERVER, 'db', 'repositories', 'MemberRepository.ts'), 'utf8');
    expect(repo).toMatch(/banned:\s*true/);
  });
});
