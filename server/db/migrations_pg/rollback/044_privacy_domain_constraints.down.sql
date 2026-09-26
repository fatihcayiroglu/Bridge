-- rollback/044_privacy_domain_constraints.down.sql
--
-- Alan kısıtlarını geri al.
--
-- VERİ KAYBI YOK: yalnızca kısıtlar düşürülür, hiçbir satır değişmez.
-- Geri alma sonrası sütunlar yeniden alan dışı değer kabul eder — yani
-- `044` öncesi duruma dönülür. Uygulama katmanındaki kanonik
-- normalleştirici (`lib/userUtils.ts`) etkilenmez ve okuma tarafı korunmaya
-- devam eder.
--
-- NOT: `db/postgres/schema.ts` artık kısıtları TAZE KURULUMDA satır içi
-- tanımlıyor. Bu geri alma mevcut bir veritabanındaki kısıtları düşürür;
-- sıfırdan kurulan yeni bir veritabanı kısıtları yine taşır. Bu kasıtlıdır:
-- geri alma `044`ün yaptığını geri alır, şemanın kanonik tanımını değil.

BEGIN;

ALTER TABLE users DROP CONSTRAINT IF EXISTS "users_dmPrivacy_check";
ALTER TABLE users DROP CONSTRAINT IF EXISTS "users_presenceVisibility_check";

COMMIT;
