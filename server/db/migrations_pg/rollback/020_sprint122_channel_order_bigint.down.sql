-- rollback/020_sprint122_channel_order_bigint.down.sql
-- Sprint 122: channels."order" BIGINT -> INTEGER daraltmasını geri al.
--
-- DİKKAT: bu bir DARALTMADIR. INTEGER aralığının (±2,147,483,647) dışında bir
-- değer varsa PostgreSQL `integer out of range` hatası verir ve işlem geri
-- sarılır. Bu KASITLIDIR — veriyi kırpmak ya da satır atmak sessiz veri
-- kaybı olurdu. Geri alma yalnızca veri eski tipe GERÇEKTEN sığıyorsa geçer.

BEGIN;

ALTER TABLE channels ALTER COLUMN "order" TYPE INTEGER;

COMMIT;
