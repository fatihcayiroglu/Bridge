// server/tests/helpers/userDoubles.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KULLANICI İKİZLERİ — `SafeUser` FABRİKASI
// ════════════════════════════════════════════════════════════════════════════
//
// Testlerin büyük bölümü kullanıcıyı `{ _id: 'u1' }` gibi İKİ alanlı bir nesne
// olarak kuruyor. Ürün tarafında dolaşan tip ise `SafeUser`dır ve on yedi alanı
// vardır (`id`, `username`, `avatarUrl`, `bio`, `bannerColor`, ...).
//
// Bunun iki somut bedeli var:
//
//   1. TİP — ikizi ürün imzasına veren her yer ya eksik alan hatası alır ya da
//      `Map<any, any>` çıkarımına düşerek DENETİMİ TAMAMEN KAYBEDER. İkincisi
//      daha sinsidir: hata görünmez ama tip güvencesi de yoktur.
//   2. GERÇEKLİK — ürün kodu bazı yerlerde `u._id || u.id` yazar. İkiz `id`
//      taşımıyorsa test, ürünün gerçekten izlediği yolu ölçmez.
//
// Bu fabrika TAM bir `SafeUser` üretir; testler yalnızca ilgilendikleri alanı
// geçer. Böylece ikiz hem tipe uyar hem de ürünün gördüğü nesneye benzer.
//
// NOT: `Partial<SafeUser>` üzerinden ezme BİLEREK serbesttir — bir testin
// `avatarUrl: null` ya da `isAdmin: true` gibi bir kenar durumu kurması meşru.

import type { SafeUser } from '../../lib/userUtils';

/**
 * Tam bir `SafeUser` üretir.
 *
 * @param id        Kullanıcı kimliği; `_id` ve `id` alanlarının İKİSİNE de
 *                  yazılır — ürün kodu her ikisini de okuyabiliyor.
 * @param overrides Senaryoya özgü alanlar.
 */
export function makeSafeUser(id = 'u-test', overrides: Partial<SafeUser> = {}): SafeUser {
  return {
    _id: id,
    id,
    username: id,
    displayName: 'Test User',
    // Urunun kendi varsayilan avatar rengi (sema: messages."avatarColor").
    // Final21 Faz 1'de buraya Discord marka rengi yazilmisti ve
    // release-integrity "Discord paleti urun kaynaginda olmaz" sozlesmesini
    // bozuyordu (Faz 10'da tam paket kosulunca yakalandi).
    avatarColor: '#2d9cdb',
    avatarUrl: null,
    status: 'online',
    bio: '',
    website: '',
    location: '',
    pronouns: '',
    bannerColor: '#1e1f22',
    bannerUrl: null,
    ...overrides,
  };
}

// ── JWT YÜKÜ ───────────────────────────────────────────────────────────────
//
// `req.user` Express augmentation'ı üzerinden `JwtPayload`tır ve ÜÇ alanı
// zorunludur: `id`, `username`, `v`. Testlerin çoğu `{ id: 'u1' }` yazıp
// eksik bırakıyor, sonra tipi susturmak için `as never` / dar bir `as`
// kullanıyordu. `v` (token sürümü) zorla-çıkış mekanizmasının kalbidir;
// ikizde yok saymak, o yolu HİÇ ölçmemek demekti.

import type { JwtPayload } from '../../middleware/auth';

/** TAM bir `JwtPayload` üretir. */
export function makeJwtUser(id = 'u1', overrides: Partial<JwtPayload> = {}): JwtPayload {
  return {
    id,
    _id: id,
    username: id,
    v: 0,
    ...overrides,
  };
}
