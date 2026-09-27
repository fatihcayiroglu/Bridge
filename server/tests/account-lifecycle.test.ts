// server/tests/account-lifecycle.test.ts
//
// FAZ 5/6 — HESAP SİLME VE KİŞİSEL VERİ DIŞA AKTARMA
//
// ════════════════════════════════════════════════════════════════════════════
// BU DOSYA NEYİ KORUR
// ════════════════════════════════════════════════════════════════════════════
// Canlı şemada kullanıcıya referans veren 53 tablo vardır ama `users`
// tablosuna giden YALNIZCA 3 yabancı anahtar bulunur. Yani veritabanı
// seviyesinde işleyen bir CASCADE YOKTUR: düz bir `DELETE FROM users` 50
// tabloda asılı referans bırakır — yazarı olmayan mesajlar, var olmayan bir
// kimliğe erişim veren üyelikler.
//
// Bu yüzden politika koda gömülüdür (`lib/accountLifecycle.ts`) ve buradaki
// testler onun BÜTÜNLÜĞÜNÜ korur. Yeni bir kullanıcı-referanslı tablo
// eklenip politikaya yazılmazsa test DÜŞER — sessizce unutulamaz.

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

import fs from 'fs';
import path from 'path';
import {
  LIFECYCLE, TOMBSTONE_USER_ID, coveredTables, rulesFor,
} from '../lib/accountLifecycle';

// ════════════════════════════════════════════════════════════════════════════
// POLİTİKA BÜTÜNLÜĞÜ
// ════════════════════════════════════════════════════════════════════════════

describe('yaşam döngüsü politikası — bütünlük', () => {
  it('her kural geçerli bir sınıflandırma taşır', () => {
    const valid = new Set(['DELETE', 'ANONYMIZE', 'RETAIN', 'TRANSFER_REQUIRED']);
    const bad = LIFECYCLE.filter(r => !valid.has(r.disposition)).map(r => r.table);
    expect(bad).toEqual([]);
  });

  it('her kural GEREKÇE taşır — karar koda gömülür', () => {
    // Gerekçesiz bir sınıflandırma, sonradan kimsenin sorgulayamayacağı
    // sessiz bir karardır.
    const missing = LIFECYCLE.filter(r => !r.why || r.why.trim().length < 20)
      .map(r => r.table);
    expect(missing).toEqual([]);
  });

  it('aynı (tablo, sütun) çifti İKİ KEZ sınıflandırılmamış', () => {
    // Çakışan iki kural, hangisinin kazandığına göre veri kaybı ya da
    // asılı referans üretir.
    const seen = new Set<string>();
    const dupes: string[] = [];
    for (const r of LIFECYCLE) {
      for (const c of r.columns) {
        const k = `${r.table}.${c}`;
        if (seen.has(k)) dupes.push(k);
        seen.add(k);
      }
    }
    expect(dupes).toEqual([]);
  });

  it('hiçbir kural sütunsuz değil', () => {
    const empty = LIFECYCLE.filter(r => !r.columns.length).map(r => r.table);
    expect(empty).toEqual([]);
  });

  it('SUNUCU SAHİPLİĞİ insan kararına bırakılmış', () => {
    // En kritik ürün kuralı: sunucu sessizce devredilemez ve öksüz
    // bırakılamaz. `servers` mutlaka TRANSFER_REQUIRED olmalıdır.
    const rule = LIFECYCLE.find(r => r.table === 'servers');
    expect(rule?.disposition).toBe('TRANSFER_REQUIRED');
  });

  it('DENETİM KAYITLARI korunur', () => {
    // Moderasyon izi sunucu güvenliği için tutulur; hesap silinse de
    // yöneticiler kimin ne yaptığını görebilmelidir.
    expect(LIFECYCLE.find(r => r.table === 'audit_logs')?.disposition).toBe('RETAIN');
  });

  it('PAYLAŞILAN sohbet içeriği SİLİNMEZ, anonimleştirilir', () => {
    // Bir sohbet karşılıklıdır. Mesajları silmek KALAN kullanıcıların
    // geçmişini de siler — bu, başkasının verisini yok etmektir.
    for (const t of ['messages', 'dm_messages', 'group_dm_messages', 'thread_messages']) {
      expect({ t, d: LIFECYCLE.find(r => r.table === t)?.disposition })
        .toEqual({ t, d: 'ANONYMIZE' });
    }
  });

  it('ERİŞİM HAKLARI silinir — hayalet yetki kalmaz', () => {
    // Üyelik bir erişim hakkıdır. Anonimleştirmek, var olmayan bir kimliğe
    // sunucu erişimi bırakırdı.
    for (const t of ['members', 'group_dm_members', 'channel_overrides']) {
      expect({ t, d: LIFECYCLE.find(r => r.table === t)?.disposition })
        .toEqual({ t, d: 'DELETE' });
    }
  });

  it('KİMLİK/OTURUM SIRLARI koşulsuz silinir', () => {
    for (const t of ['refresh_tokens', 'oauth_tokens', 'webauthn_credentials',
                     'user_ap_keys', 'push_subscriptions']) {
      expect({ t, d: LIFECYCLE.find(r => r.table === t)?.disposition })
        .toEqual({ t, d: 'DELETE' });
    }
  });

  it('`uploads` ANONİMLEŞTİRİLİR — silinirse temizlik işi dosyayı yok eder', () => {
    // İnce ama gerçek bir bağ: `uploads` kaydı silinirse, dosya hâlâ bir
    // mesajda referanslı olsa bile temizlik işi onu "kayıtsız" görebilir.
    expect(LIFECYCLE.find(r => r.table === 'uploads')?.disposition).toBe('ANONYMIZE');
  });

  it('mezar taşı kimliği gerçek bir kullanıcı adına benzemiyor', () => {
    // Gerçek bir kullanıcı _id'si ile çakışırsa anonimleştirilen satırlar
    // yanlışlıkla o kullanıcıya atfedilir.
    expect(TOMBSTONE_USER_ID).toBe('deleted-user');
    expect(TOMBSTONE_USER_ID).not.toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}/);  // UUID degil
  });
});

// ════════════════════════════════════════════════════════════════════════════
// ŞEMA KAPSAMI — SESSİZ BOŞLUK BIRAKILAMAZ
// ════════════════════════════════════════════════════════════════════════════

describe('politika kanonik şemayı KAPSIYOR', () => {
  // Kanonik kaynaklar: schema.ts + migrations.ts (+ migrations_pg).
  function canonicalSql(): string {
    const base = path.join(__dirname, '..', 'db', 'postgres');
    let sql = '';
    for (const f of ['schema.ts', 'migrations.ts']) {
      const p = path.join(base, f);
      if (fs.existsSync(p)) sql += fs.readFileSync(p, 'utf8') + '\n';
    }
    const dir = path.join(__dirname, '..', 'db', 'migrations_pg');
    if (fs.existsSync(dir)) {
      for (const f of fs.readdirSync(dir)) {
        if (f.endsWith('.sql') || f.endsWith('.ts')) {
          sql += fs.readFileSync(path.join(dir, f), 'utf8') + '\n';
        }
      }
    }
    return sql;
  }

  /** CREATE TABLE bloklarından kullanıcı-referanslı tabloları çıkarır. */
  function userReferencingTables(sql: string): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const re = /CREATE TABLE (?:IF NOT EXISTS )?"?(\w+)"?\s*\(([\s\S]*?)\n\s*\)\s*;/g;
    const USERCOL = /^\s*"?(\w*(?:[Uu]serId|user_id|ownerId|authorId|actorId|createdBy|uploadedBy|blockerId|blockedId|friendId)\w*)"?\s+\w+/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(sql)) !== null) {
      const [, table, body] = m;
      const cols = new Set<string>();
      let c: RegExpExecArray | null;
      USERCOL.lastIndex = 0;
      while ((c = USERCOL.exec(body)) !== null) cols.add(c[1]);
      if (cols.size) out.set(table, [...cols]);
    }
    return out;
  }

  it('kullanıcı referansı olan HER kanonik tablo sınıflandırılmış', () => {
    // Yeni bir tablo eklenip politikaya yazılmazsa hesap silme onu ATLAR ve
    // kişisel veri sessizce geride kalır. Bu test tam olarak onu yakalar.
    const found = userReferencingTables(canonicalSql());
    expect(found.size).toBeGreaterThan(10);        // ayrıştırma çalışıyor mu

    const covered = coveredTables();
    const uncovered = [...found.keys()].filter(t => !covered.has(t)).sort();
    expect({ uncovered }).toEqual({ uncovered: [] });
  });
});

// ════════════════════════════════════════════════════════════════════════════
// DIŞA AKTARMA — SIR SIZDIRMAZ
// ════════════════════════════════════════════════════════════════════════════

describe('kişisel veri dışa aktarma — gizlilik sözleşmesi', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'account.ts'), 'utf8');

  it('profil alan listesi POZİTİF (kara liste değil)', () => {
    // Negatif bir kara liste, şemaya yeni bir sır sütunu eklendiğinde
    // SESSİZCE sızdırır. Pozitif liste güvenli tarafta kalır.
    expect(src).toContain('const PROFILE_FIELDS');
  });

  it('SIR alanları dışa aktarma listesinde YOK', () => {
    const start = src.indexOf('const PROFILE_FIELDS');
    const block = src.slice(start, src.indexOf('] as const', start));
    for (const secret of ['password', 'twoFactorSecret', 'twoFactorBackup',
                          'emailToken', 'emailTokenExp']) {
      expect({ secret, leaked: block.includes(`'${secret}'`) })
        .toEqual({ secret, leaked: false });
    }
  });

  it('sır tutan tablolar dışa aktarma kaynaklarında YOK', () => {
    const start = src.indexOf('const EXPORT_SOURCES');
    const block = src.slice(start, src.indexOf('];', start));
    for (const t of ['refresh_tokens', 'oauth_tokens', 'webauthn_credentials',
                     'user_ap_keys', 'push_subscriptions', 'native_push_tokens',
                     'outgoing_webhooks', 'bots']) {
      expect({ t, leaked: block.includes(`'${t}'`) }).toEqual({ t, leaked: false });
    }
  });

  it('her dışa aktarma sorgusu ÇAĞIRANIN kimliğiyle daraltılmış', () => {
    // Kapsamsız bir SELECT tüm kullanıcıların verisini döndürürdü.
    const start = src.indexOf('router.get(\'/export\'');
    const end = src.indexOf('router.get(\'/deletion-preflight\'');
    const body = src.slice(start, end);
    const selects = [...body.matchAll(/SELECT \* FROM[^`]*/g)].map(m => m[0]);
    expect(selects.length).toBeGreaterThan(0);
    const unscoped = selects.filter(s => !s.includes('WHERE'));
    expect({ unscoped }).toEqual({ unscoped: [] });
  });

  it('BAŞKASININ kurduğu engeller dışa aktarılmıyor', () => {
    // Kimin bu kullanıcıyı engellediği BAŞKA kullanıcıların verisidir.
    expect(src).toContain('blocks WHERE "blockerId"=$1');
    expect(src).not.toContain('blocks WHERE "blockedId"=$1');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SİLME — KORUMA SÖZLEŞMESİ
// ════════════════════════════════════════════════════════════════════════════

describe('hesap silme — koruma sözleşmesi', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'routes', 'account.ts'), 'utf8');
  // Politikanın TEK uygulayıcısı (Final21 Faz 19): kişinin kendi silmesi ve yönetici silmesi
  // aynı kodu çağırır.
  const core = fs.readFileSync(path.join(__dirname, '..', 'lib', 'accountDeletion.ts'), 'utf8');
  const admin = fs.readFileSync(path.join(__dirname, '..', 'routes', 'admin', 'users.ts'), 'utf8');
  const adminDelete = admin.slice(admin.indexOf("usersRouter.delete('/users/:id'"), admin.indexOf("usersRouter.get('/servers'"));

  it('AÇIK onay isteniyor', () => {
    // Yanlışlıkla tetiklenen bir DELETE geri alınamaz.
    expect(src).toContain("confirm !== 'DELETE'");
  });

  it('PAROLA ile yeniden doğrulama isteniyor', () => {
    // Çalınmış bir oturum hesabı silmeye yetmemelidir.
    expect(src).toContain('bcrypt.compare(password');
  });

  it('SAHİPLİK ENGELİ silmeden önce kontrol ediliyor', () => {
    const body = src.slice(src.indexOf("router.delete('/'"));
    const blockerIdx = body.indexOf('ownershipBlockers');
    const eraseIdx = body.indexOf('eraseAccountData(');
    expect(blockerIdx).toBeGreaterThan(-1);
    expect(blockerIdx).toBeLessThan(eraseIdx);    // once kontrol, SONRA silme
  });

  it('sessiz DEVİR yok — 409 ile açık engel', () => {
    expect(src).toContain('Ownership transfer required before deletion');
    // Sahipligi baskasina yazan bir UPDATE OLMAMALI.
    for (const text of [src, core, admin]) expect(text).not.toMatch(/UPDATE\s+servers\s+SET\s+"ownerId"/i);
  });

  it('silme TEK İŞLEMDE (transaction) yapılıyor', () => {
    // Yarıda kalan bir silme, yarısı silinmiş bir hesap bırakırdı.
    expect(src).toContain('_transaction');
    expect(core).toContain('await transaction(async (client: Queryable) => {');
    expect(core).toContain('DELETE FROM users WHERE _id = $1');
  });

  it('jeton/oturum yetkisi iptal ediliyor', () => {
    expect(src).toContain('revokeAllForUser');
  });

  it('RETAIN sınıfı silme döngüsünde ATLANIYOR', () => {
    expect(core).toContain("rule.disposition === 'RETAIN'");
  });

  it('tablo/sütun adları politikadan gelir, İSTEKTEN değil', () => {
    // SQL enjeksiyonu riski: tablo adı parametrelenemez. Bu yüzden yalnızca
    // koddaki sabit politikadan gelmelidir — asla `req.body`den.
    const body = src.slice(src.indexOf("router.delete('/'"));
    expect(core).toContain('for (const rule of LIFECYCLE)');
    expect(body).not.toMatch(/req\.body[^;]*table/i);
    expect(core).not.toMatch(/\breq\./);          // çekirdek istek nesnesi görmez
  });

  it('YÖNETİCİ silmesi aynı politikayı uygular — ikinci, eksik bir uygulama yok', () => {
    // Faz 19'a kadar yönetici ucu yalnızca kanal mesajlarını ve üyelikleri siliyordu.
    expect(adminDelete).toContain('eraseAccountData(');
    expect(adminDelete).not.toMatch(/Messages\.removeByUser|Members\.removeAllForUser|Users\.delete\(/);
    const blockerIdx = adminDelete.indexOf('ownershipBlockers(');
    expect(blockerIdx).toBeGreaterThan(-1);
    expect(blockerIdx).toBeLessThan(adminDelete.indexOf('eraseAccountData('));
    expect(adminDelete).toContain('Ownership transfer required before deletion');
    expect(adminDelete).toContain('revokeAllForUser');
    expect(adminDelete).toContain('releaseAfterErasure(');
  });
});

describe('politika dağılımı — beklenen büyüklükte', () => {
  it('her sınıftan makul sayıda kural var', () => {
    // Tek bir sınıfa yığılmış politika, düşünülmemiş demektir.
    const counts = {
      DELETE: rulesFor('DELETE').length,
      ANONYMIZE: rulesFor('ANONYMIZE').length,
      RETAIN: rulesFor('RETAIN').length,
      TRANSFER_REQUIRED: rulesFor('TRANSFER_REQUIRED').length,
    };
    expect(counts.DELETE).toBeGreaterThan(10);
    expect(counts.ANONYMIZE).toBeGreaterThan(10);
    expect(counts.RETAIN).toBeGreaterThanOrEqual(1);
    expect(counts.TRANSFER_REQUIRED).toBeGreaterThanOrEqual(3);
  });
});
