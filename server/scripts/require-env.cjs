#!/usr/bin/env node
// server/scripts/require-env.cjs
//
// OPT-IN CANLI ENTEGRASYON KOMUTLARI SESSİZCE YEŞİL OLAMAZ (Final21 Faz 19)
//
// `test:pg` ve `test:search-it` yalnızca gerçek bir veritabanına karşı anlamlıdır. Süitler bağlantı
// adresi yoksa `describe.skip` ile atlanır (varsayılan `npm test` hermetik kalsın diye). Ancak
// bu komutların KENDİSİ adres olmadan çağrıldığında da çıkış kodu 0'dı: "16 skipped, 0 passed"
// yeşil bir koşu gibi görünüyordu. Ölçüldü: sertifikasyon kapısı yanlış değişken adı
// (`PG_TEST_URL`) ile `test:search-it`i koşturdu ve kapı GEÇTİ diye kaydedildi.
//
// Kullanım: node scripts/require-env.cjs NAME [NAME...] && <komut>
// Boş ya da yalnızca boşluktan oluşan değer EKSİK sayılır.

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error('require-env: en az bir ortam değişkeni adı verilmeli.');
  process.exit(2);
}
const missing = names.filter((name) => !String(process.env[name] ?? '').trim());
if (missing.length > 0) {
  console.error(`✖ Gerekli ortam değişkeni eksik: ${missing.join(', ')}`);
  console.error('  Bu komut canlı bir hizmete karşı koşar; adres olmadan tüm süitler ATLANIR ve');
  console.error('  koşu yanlışlıkla başarılı görünürdü. Tek kullanımlık bir veritabanı adresi verin');
  console.error('  (bkz. CONTRIBUTING.md › Gerçek PostgreSQL testleri).');
  process.exit(1);
}
