-- rollback/023_message_ack_idempotency.down.sql
-- Mesaj gönderim idempotency anahtarını geri al.
--
-- NOT: bu geri alma, çift gönderim korumasını KALDIRIR. Uygulama katmanı
-- `ackId` yazmaya devam ederse sütun olmadığı için yazma hata verir; bu
-- yüzden geri alma yalnızca kod da geri alınıyorsa uygulanmalıdır.

BEGIN;

DROP INDEX IF EXISTS idx_messages_user_ack;
ALTER TABLE messages DROP COLUMN IF EXISTS "ackId";

COMMIT;
