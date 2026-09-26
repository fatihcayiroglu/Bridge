// server/tests/db-privilege-check.test.ts
//
// ÇALIŞMA-ZAMANI VERİTABANI AYRICALIĞI — EN AZ AYRICALIK DENETİMİ
//
// ════════════════════════════════════════════════════════════════════════════
// ÖLÇÜLEN DURUM
// ════════════════════════════════════════════════════════════════════════════
// Bridge'in çalışma-zamanı PostgreSQL kullanıcısı gerçek veritabanına karşı
// sorgulandı:
//
//     rolsuper = true   rolcreatedb = true
//     rolcreaterole = true   rolbypassrls = true
//
// Yani SUPERUSER. Uygulamanın ihtiyacı yalnızca CRUD'dur. Bu yetkilerle ele
// geçirilmiş bir süreç kümedeki her veritabanını okuyabilir, rol
// oluşturabilir, RLS'i atlayabilir ve `COPY TO PROGRAM` ile veritabanı
// sunucusunda KABUK KOMUTU çalıştırabilir.
//
// ── EN AZ AYRICALIK MODELİ KANITLANDI ───────────────────────────────────────
// `scripts/db-least-privilege-proof.cjs` TEK KULLANIMLIK bir veritabanında
// 15/15 doğrulamayla iki rollü modelin çalıştığını gösterdi:
//   migrasyon rolü → DDL çalışır
//   uygulama rolü  → CRUD çalışır; CREATE/DROP/ALTER TABLE, CREATE ROLE,
//                    CREATE DATABASE, COPY TO PROGRAM, pg_read_file
//                    hepsi 42501 ile REDDEDİLDİ
//
// Bu dosya, denetimin kendisinin doğru davrandığını kilitler.

import { excessivePrivileges, privilegeWarnings, checkDbPrivileges } from '../lib/dbPrivilegeCheck';

jest.mock('../lib/logger', () => ({
  __esModule: true,
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const TEMIZ = { rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false };

// ════════════════════════════════════════════════════════════════════════════
// TESPİT
// ════════════════════════════════════════════════════════════════════════════
describe('excessivePrivileges', () => {
  it('SUPERUSER tespit edilir', () => {
    expect(excessivePrivileges({ ...TEMIZ, rolsuper: true })).toEqual(['SUPERUSER']);
  });

  it('gerçek ölçülen durum: DÖRT bayrağın hepsi bildirilir', () => {
    // Bu, bu kurulumda GERCEKTEN olculen roldur.
    expect(excessivePrivileges({
      rolsuper: true, rolcreatedb: true, rolcreaterole: true, rolbypassrls: true,
    })).toEqual(['SUPERUSER', 'CREATEDB', 'CREATEROLE', 'BYPASSRLS']);
  });

  it('her bayrak TEK BAŞINA tespit edilir', () => {
    expect({
      createdb:   excessivePrivileges({ ...TEMIZ, rolcreatedb: true }),
      createrole: excessivePrivileges({ ...TEMIZ, rolcreaterole: true }),
      bypassrls:  excessivePrivileges({ ...TEMIZ, rolbypassrls: true }),
    }).toEqual({ createdb: ['CREATEDB'], createrole: ['CREATEROLE'], bypassrls: ['BYPASSRLS'] });
  });

  // ── POZİTİF KONTROL ───────────────────────────────────────────────────────
  it('EN AZ AYRICALIKLI rol uyarı ÜRETMEZ', () => {
    // Bu olmadan tum testler "her zaman uyar" gibi bozuk bir uygulamada da
    // yesil kalirdi — ve uyari gurultuye donusup anlamsizlasirdi.
    expect(excessivePrivileges(TEMIZ)).toEqual([]);
  });

  it('null / undefined güvenle boş döner', () => {
    expect({ n: excessivePrivileges(null), u: excessivePrivileges(undefined) })
      .toEqual({ n: [], u: [] });
  });

  it('eksik alanlar yetki SAYILMAZ (yalnızca açık true)', () => {
    // `undefined` bir bayragi "var" saymak yanlis pozitif uretirdi.
    expect(excessivePrivileges({})).toEqual([]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// UYARI METNİ
// ════════════════════════════════════════════════════════════════════════════
describe('privilegeWarnings', () => {
  it('temiz rolde uyarı YOK', () => {
    expect(privilegeWarnings(TEMIZ)).toEqual([]);
  });

  it('SUPERUSER uyarısı KABUK riskini açıkça söyler', () => {
    // Operator neden onemsemesi gerektigini gormeli.
    const u = privilegeWarnings({ ...TEMIZ, rolsuper: true }).join(' ');
    expect(u).toContain('COPY TO PROGRAM');
  });

  it('SUPERUSER olmayan fazlalıkta kabuk iddiası YAPILMAZ', () => {
    // Abartili uyari guveni azaltir; CREATEDB kabuk erisimi vermez.
    const u = privilegeWarnings({ ...TEMIZ, rolcreatedb: true }).join(' ');
    expect(u.includes('COPY TO PROGRAM')).toBe(false);
  });

  it('ÜRETİM ortamı ayrıca işaretlenir', () => {
    const u = privilegeWarnings({ ...TEMIZ, rolsuper: true },
      { NODE_ENV: 'production' } as NodeJS.ProcessEnv).join(' ');
    expect(u).toContain('ÜRETİM');
  });

  it('uyarı DOĞRULAMA komutunu içerir', () => {
    // Operatore "kanitla" demek yetmez; komutu vermeliyiz.
    expect(privilegeWarnings({ ...TEMIZ, rolsuper: true }).join(' '))
      .toContain('db-least-privilege-proof');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// SORGU YOLU
// ════════════════════════════════════════════════════════════════════════════
describe('checkDbPrivileges', () => {
  it('rolü sorgular ve uyarı döndürür', async () => {
    const q = jest.fn().mockResolvedValue({ rows: [{ ...TEMIZ, rolsuper: true }] });
    const u = await checkDbPrivileges(q);
    expect(u.length).toBeGreaterThan(0);
    expect(String(q.mock.calls[0][0])).toContain('pg_roles');
  });

  it('current_user sorgulanır — sabit bir ad DEĞİL', () => {
    const q = jest.fn().mockResolvedValue({ rows: [TEMIZ] });
    return checkDbPrivileges(q).then(() => {
      expect(String(q.mock.calls[0][0])).toContain('current_user');
    });
  });

  it('temiz rolde boş döner', async () => {
    expect(await checkDbPrivileges(jest.fn().mockResolvedValue({ rows: [TEMIZ] }))).toEqual([]);
  });

  it('sorgu HATA verirse ÖNYÜKLEMEYİ BOZMAZ', async () => {
    // Bu bir teshis aracidir. Kendi hatasi yuzunden sunucuyu dusuremez.
    const q = jest.fn().mockRejectedValue(new Error('baglanti yok'));
    await expect(checkDbPrivileges(q)).resolves.toEqual([]);
  });

  it('boş sonuç kümesi güvenle işlenir', async () => {
    await expect(checkDbPrivileges(jest.fn().mockResolvedValue({ rows: [] }))).resolves.toEqual([]);
  });
});
