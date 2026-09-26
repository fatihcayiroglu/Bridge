// server/tests/schema-doc-authority.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// ŞEMA BELGESİ DOĞRU DOSYAYI GÖSTERMELİ
// ════════════════════════════════════════════════════════════════════════════
//
// ÖLÇÜLEN KUSUR (Final20): `db/postgres/schema.sql` kendi başlığında
// "ÇALIŞTIRILMIYOR — SOURCE OF TRUTH DEĞİLDİR" diyordu, ama
// `docs/DATABASE_SCHEMA.md` onu ŞEMA DOSYASI olarak tanıtıyor ve "yeni tablo
// eklerken 1. adım: schema.sql güncelle" diyordu.
//
// Bu yalnızca bir belge tutarsızlığı değil, bir OPERASYON TUZAĞIDIR: belgeyi
// izleyip aynadan veritabanı kuran bir operatör, uygulamanın YAZAMAYACAĞI bir
// şema elde eder. Ölçüldü — `threads` tablosunda çalışan şema `name`,
// `parentMessageId`, `lastMessageAt`, `messageCount` kullanırken ayna bunları
// hiç tanımlamıyor ve varsayılansız `title NOT NULL` istiyor.
//
// Bu test, belgenin bir daha aynayı otorite gibi göstermesini engeller.

import fs from 'fs';
import path from 'path';

const root = path.join(__dirname, '..', '..');
const doc = fs.readFileSync(path.join(root, 'docs', 'DATABASE_SCHEMA.md'), 'utf8');
const mirror = fs.readFileSync(path.join(root, 'server', 'db', 'postgres', 'schema.sql'), 'utf8');

describe('şema belgesi otoriteyi doğru gösterir', () => {
  it('çalıştırılan DDL sahibini (schema.ts) adlandırır', () => {
    expect(doc).toContain('server/db/postgres/schema.ts');
    expect(doc).toContain('server/db/migrations_pg/');
  });

  it('aynanın (schema.sql) otorite OLMADIĞINI açıkça söyler', () => {
    // Belge aynadan söz edebilir — ama yalnızca "kaynak değil" diyerek.
    const mentionsMirror = doc.includes('schema.sql');
    if (mentionsMirror) {
      expect(doc).toMatch(/schema\.sql[^\n]{0,80}(ÇALIŞTIRILMAZ|kaynak DEĞİLDİR|DEĞİL)/);
    }
  });

  it('yeni tablo rehberinin ilk adımı aynayı GÖSTERMEZ', () => {
    const guide = doc.slice(doc.indexOf('## Yeni Tablo Ekleme Rehberi'));
    const firstStep = guide.split('\n').find((line) => line.trim().startsWith('1.')) ?? '';
    expect(firstStep).toContain('schema.ts');
    expect(firstStep).not.toMatch(/schema\.sql\s*güncelle/);
  });

  it('aynanın kendi uyarı başlığı yerinde durur', () => {
    // Uyarı silinirse dosya yeniden otorite gibi görünür.
    expect(mirror.slice(0, 600)).toMatch(/SOURCE OF TRUTH DEĞİLDİR/);
  });
});
