# PostgreSQL Migrations

Bridge'in aktif migration sistemi. Tüm yeni migration'lar buraya eklenir.

## Çalıştırma

```bash
# Tüm migration'ları uygula
npm run db:migrate:pg

# Belirli bir migration'a kadar
DATABASE_URL=postgresql://... node -r ts-node/register db/migrate-postgres.ts up

# Rollback (tek adım)
DATABASE_URL=postgresql://... node -r ts-node/register db/migrate-postgres.ts down
```

## Migration Listesi

| # | Dosya | Açıklama |
|---|-------|----------|
| 001 | client_error_events | Client hata olayları tablosu |
| 002 | refresh_token_reuse_detection | Token tekrar kullanım tespiti |
| 003 | session8_features | DM readAt + Canvas depolama |
| 004 | session9_features | DM messages readAt |
| 005 | session10_social_discover | Rozetler + Keşif güçlendirmesi |
| 006 | move_ap_private_key | AP private key ayrı tabloya taşındı |
| 007 | user_badges | user_badges tablosu |
| 008 | encrypt_ap_private_keys | AP key'leri AES-256-GCM ile şifrele |
| 009 | drop_ap_private_key_plaintext | Düz metin AP key kolonu kaldırıldı |
| 010 | bot_marketplace | Bot marketplace katalog tabloları |
| 011 | sprint93_boost_vanity_oauth | Boost, vanity URL, OAuth bağlantıları |
| 012 | sprint94_channel_follows | Kanal takip sistemi |
| 013 | sprint95_server_events | Sunucu etkinlikleri tablosu |
| 014 | federation_peer_public_key | `federation_peers.publicKey` sütunu eklendi (ADR-0006 Faz 1) |
| 015 | server_federation_keys | Instance RSA key çifti tablosu (ADR-0006 Faz 1+2) |

## `_inline.ts` Dosyaları

Bazı migration'lar yanında bir `_inline.ts` dosyasına sahiptir (örn. `010_bot_marketplace_inline.ts`).
Bu dosyalar **bağımsız bir migration numarası değildir**; aynı numarayı paylaştıkları `.sql`
dosyasıyla birlikte aynı özellik setine aitler.

`_inline.ts` dosyaları şu amaçla kullanılır:
- `server/db/postgres/migrations.ts` içindeki `EXTRA_TABLES` dizisine spread edilecek TypeScript
  sabitleri tanımlar
- Uygulama startup'ında `runInlineMigrations()` tarafından çalıştırılır
- CLI migration araçlarıyla değil, Node.js `import` mekanizmasıyla yüklenir

**Ne zaman kullanılır:** Yeni bir tablo hem pgMigrate CLI'ı hem de uygulama startup'ı üzerinden
oluşturulabilecekse. Çoğu durumda yalnızca `.sql` yeterlidir.

## Rollback

Her migration için `rollback/` klasöründe `.down.sql` dosyası mevcuttur.

## Yeni Migration Ekleme

1. `NNN_aciklayici_isim.sql` dosyası oluştur (sıradaki numara)
2. `rollback/NNN_aciklayici_isim.down.sql` rollback dosyası yaz
3. Gerekiyorsa `NNN_aciklayici_isim_inline.ts` TypeScript sabitleri ekle ve `migrations.ts`
   **başına** import et
4. `db/postgres/schema.sql`'i güncelle
5. Bu README'deki Migration Listesi tablosunu güncelle
6. PR açmadan önce test DB'de çalıştır
