// server/lib/dbPrivilegeCheck.ts
//
// ÇALIŞMA-ZAMANI VERİTABANI AYRICALIĞI DENETİMİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR — ÖLÇÜLEN DURUM
// ════════════════════════════════════════════════════════════════════════════
// Bridge'in çalışma-zamanı PostgreSQL kullanıcısı bu programda ölçüldü:
//
//     rolsuper = true   rolcreatedb = true
//     rolcreaterole = true   rolbypassrls = true
//
// Yani SUPERUSER. Uygulamanın ihtiyacı olan şey bu DEĞİLDİR: normal CRUD
// yeterlidir. Ele geçirilmiş bir Bridge süreci (SQL enjeksiyonu, RCE veya
// bağımlılık zinciri) bu yetkilerle:
//
//   • kümedeki HER veritabanını okuyabilir/değiştirebilir
//   • rol oluşturup kalıcı erişim bırakabilir
//   • satır düzeyi güvenliği (RLS) atlayabilir
//   • `COPY TO PROGRAM` ile veritabanı sunucusunda KABUK KOMUTU çalıştırabilir
//   • `pg_read_file` ile sunucu dosyalarını okuyabilir
//
// ── EN AZ AYRICALIK MODELİ KANITLANDI ───────────────────────────────────────
// `scripts/db-least-privilege-proof.cjs` tek kullanımlık bir veritabanında
// 15/15 doğrulamayla gösterdi ki iki rollü model ÇALIŞIYOR:
//
//   MIGRASYON ROLÜ  → CREATE/ALTER/INDEX (şema sahibi)
//   UYGULAMA ROLÜ   → yalnızca SELECT/INSERT/UPDATE/DELETE
//                     CREATE TABLE, DROP, ALTER, CREATE ROLE,
//                     CREATE DATABASE, COPY TO PROGRAM, pg_read_file
//                     hepsi 42501 (yetersiz yetki) ile REDDEDİLDİ
//
// ── NEDEN BAŞLANGIÇTA ÖLDÜRMÜYORUZ ──────────────────────────────────────────
// Bu bir sertleştirme açığıdır, anlık bir bozulma değil. Sürecin başlamasını
// engellemek, hâlihazırda çalışan bir dağıtımı ANINDA kesintiye uğratırdı —
// açığın kendisinden daha yıkıcı olurdu. Bu yüzden uyarı GÜRÜLTÜLÜDÜR ama
// ölümcül değildir. Operatörün göreceği tek şey bu satırlardır.

import logger from './logger';

export interface RolePrivileges {
  rolsuper?: boolean;
  rolcreatedb?: boolean;
  rolcreaterole?: boolean;
  rolbypassrls?: boolean;
}

/** Fazladan taşınan yönetimsel bayrakların listesi. */
export function excessivePrivileges(role: RolePrivileges | null | undefined): string[] {
  if (!role) return [];
  const bayraklar: Array<[keyof RolePrivileges, string]> = [
    ['rolsuper',      'SUPERUSER'],
    ['rolcreatedb',   'CREATEDB'],
    ['rolcreaterole', 'CREATEROLE'],
    ['rolbypassrls',  'BYPASSRLS'],
  ];
  return bayraklar.filter(([k]) => role[k] === true).map(([, ad]) => ad);
}

/** Operatöre gösterilecek uyarı satırları (boş = sorun yok). */
export function privilegeWarnings(
  role: RolePrivileges | null | undefined,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const fazla = excessivePrivileges(role);
  if (fazla.length === 0) return [];

  const uretim = env.NODE_ENV === 'production';
  return [
    `Veritabanı kullanıcısı GEREKSİZ YÖNETİMSEL YETKİ taşıyor: ${fazla.join(', ')}.`,
    'Bridge çalışma zamanında yalnızca SELECT/INSERT/UPDATE/DELETE gerektirir.',
    'Ele geçirilmiş bir süreç bu yetkilerle tüm kümeyi okuyabilir, rol oluşturabilir' +
      (fazla.includes('SUPERUSER') ? ' ve COPY TO PROGRAM ile sunucuda komut çalıştırabilir.' : '.'),
    'Kanıtlanmış model: migrasyon rolü DDL yapar, uygulama rolü yalnızca CRUD.',
    'Doğrulama: node scripts/db-least-privilege-proof.cjs',
    uretim
      ? 'ÜRETİM ORTAMI — bu yapılandırma düzeltilmelidir.'
      : 'Geliştirme ortamı — üretimde ayrı bir uygulama rolü kullanın.',
  ];
}

/**
 * Çalışma-zamanı rolünü sorgular ve gerekiyorsa uyarır.
 * Sorgu başarısız olursa SESSİZCE geçer — bu bir teşhis aracıdır, önyüklemeyi
 * bozmamalıdır.
 */
export async function checkDbPrivileges(
  query: (sql: string) => Promise<{ rows: RolePrivileges[] }>,
): Promise<string[]> {
  // NOT: baslangic degeri ATANMAZ — her iki dal da kesin olarak atar ve
  // gereksiz atama lint hatasi uretiyordu (no-useless-assignment).
  let role: RolePrivileges | null;
  try {
    const r = await query(
      'SELECT rolsuper, rolcreatedb, rolcreaterole, rolbypassrls ' +
      'FROM pg_roles WHERE rolname = current_user',
    );
    role = r?.rows?.[0] ?? null;
  } catch {
    return [];   // teşhis aracı önyüklemeyi bozmaz
  }

  const uyarilar = privilegeWarnings(role);
  if (uyarilar.length) {
    logger.warn(
      { event: 'db.privilege.excessive', privileges: excessivePrivileges(role) },
      '[DB] ' + uyarilar.join(' '),
    );
  }
  return uyarilar;
}
