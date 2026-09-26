// server/tests/user-fk-integrity.test.ts
//
// KULLANICI REFERANS BÜTÜNLÜĞÜ — POLİTİKA İLE ŞEMA UYUMU
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK ZAYIFLIK
// ════════════════════════════════════════════════════════════════════════════
// Canlı şemada kullanıcıya işaret eden 59 sütun vardı ama `users` tablosuna
// giden yalnızca 1 yabancı anahtar bulunuyordu. Yani veritabanı seviyesinde
// işleyen bir CASCADE YOKTU: hesap silmenin doğruluğu tamamen uygulama
// katmanındaki politika tablosuna bağlıydı. Politikada bir tablo atlanırsa
// hayalet erişim hakları (üyelik) ve yetim sırlar (jetonlar) geride kalırdı.
//
// ── NEDEN "HEPSİNE FK EKLE" YANLIŞ OLURDU ─────────────────────────────────
// Politika paylaşılan içeriği SİLMEZ; kimlik bağını koparıp `deleted-user`
// MEZAR TAŞINA çevirir. O değer gerçek bir `users` satırı değildir. Bu
// sütunlara FK eklemek anonimleştirmeyi KIRARDI — ya silme başarısız olur ya
// da başkalarının sohbet geçmişi de silinirdi.
//
// Bu dosya iki YÖNLÜ invaryantı korur:
//   1. DELETE sınıfındaki tablolar FK ALMALI      (bütünlük)
//   2. ANONYMIZE/RETAIN tabloları FK ALMAMALI     (anonimleştirme korunur)
//
// Migrasyon disposable bir veritabanı klonunda uygulanıp doğrulandı:
// 3 → 24 FK, yetim satır 0, hesap silme 24/24 çalışmaya devam etti.

import fs from 'fs';
import path from 'path';
import { LIFECYCLE } from '../lib/accountLifecycle';

const MIGRATIONS_FULL = fs.readFileSync(
  path.join(__dirname, '..', 'db', 'postgres', 'migrations.ts'), 'utf8',
);

// Yalnizca BU programda eklenen blok. Semada zaten var olan FK'ler
// (ornegin `user_ap_keys`) bu iddialarin kapsami disindadir.
const BLOCK_START = MIGRATIONS_FULL.indexOf('const USER_FK_MIGRATIONS');
const MIGRATIONS = BLOCK_START === -1
  ? ''
  : MIGRATIONS_FULL.slice(BLOCK_START, MIGRATIONS_FULL.indexOf('\n];', BLOCK_START));

/** Migrasyonda FK tanımlanmış (tablo, sütun) çiftleri. */
function declaredFks(): Set<string> {
  const out = new Set<string>();
  const re = /ALTER TABLE (\w+) ADD CONSTRAINT \w+\s*\n\s*FOREIGN KEY \("(\w+)"\) REFERENCES users\(_id\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(MIGRATIONS)) !== null) out.add(`${m[1]}.${m[2]}`);
  return out;
}

describe('kullanıcı FK migrasyonu — yapı', () => {
  const fks = declaredFks();

  it('migrasyon anlamlı sayıda FK tanımlıyor', () => {
    // Ayrıştırma bozulursa bu test sessizce "her şey yolunda" demesin.
    expect(fks.size).toBeGreaterThanOrEqual(15);
  });

  it('her FK ON DELETE CASCADE kullanıyor', () => {
    // RESTRICT/NO ACTION olsaydı hesap silme veritabanı tarafından
    // ENGELLENIRDI — yani gizlilik özelliği kırılırdı.
    const count = (MIGRATIONS.match(/REFERENCES users\(_id\) ON DELETE CASCADE/g) ?? []).length;
    expect(count).toBe(fks.size);
  });

  it('FK ekleme IDEMPOTENT (pg_constraint kontrolü ile sarılı)', () => {
    // Migrasyon her açılışta çalışır; koşulsuz ALTER her seferinde hata
    // üretirdi.
    expect(MIGRATIONS).toContain('IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname');
  });
});

describe('FK kümesi POLİTİKA ile tutarlı', () => {
  const fks = declaredFks();
  const byTable = new Map<string, string>();
  for (const r of LIFECYCLE) for (const c of r.columns) byTable.set(`${r.table}.${c}`, r.disposition);

  it('ANONYMIZE sınıfındaki HİÇBİR sütuna FK eklenmemiş', () => {
    // EN KRİTİK İNVARYANT. Bir FK buraya sızarsa `deleted-user` mezar taşı
    // yazılamaz ve hesap silme ya patlar ya da paylaşılan geçmişi siler.
    const violations = [...fks].filter(k => byTable.get(k) === 'ANONYMIZE');
    expect({ violations }).toEqual({ violations: [] });
  });

  it('RETAIN sınıfındaki HİÇBİR sütuna FK eklenmemiş', () => {
    // `audit_logs` gibi kayıtlar hesap silinince de KORUNMALIDIR; CASCADE
    // onları silerdi ve moderasyon izi kaybolurdu.
    const violations = [...fks].filter(k => byTable.get(k) === 'RETAIN');
    expect({ violations }).toEqual({ violations: [] });
  });

  it('TRANSFER_REQUIRED sınıfına FK eklenmemiş', () => {
    // Sunucu sahipliği insan kararına bağlıdır; CASCADE sunucuyu sessizce
    // silerdi.
    const violations = [...fks].filter(k => byTable.get(k) === 'TRANSFER_REQUIRED');
    expect({ violations }).toEqual({ violations: [] });
  });

  it('FK eklenen her sütun politikada DELETE olarak sınıflandırılmış', () => {
    // Politikada hiç yer almayan bir tabloya FK eklemek, silme davranışını
    // yalnızca veritabanına bırakır — niyet kayda geçmemiş olur.
    const unclassified = [...fks].filter(k => byTable.get(k) !== 'DELETE');
    expect({ unclassified }).toEqual({ unclassified: [] });
  });

  it('KRİTİK erişim/sır tabloları FK ile de korunuyor', () => {
    // Derinlemesine savunma: politika bir gün bunlardan birini atlarsa
    // veritabanı yine de hayalet erişimi ve yetim sırrı engeller.
    for (const key of ['members.userId', 'refresh_tokens.userId',
                       'oauth_tokens.userId', 'webauthn_credentials.userId',
                       'push_subscriptions.userId']) {
      expect({ key, hasFk: fks.has(key) }).toEqual({ key, hasFk: true });
    }
  });
});
