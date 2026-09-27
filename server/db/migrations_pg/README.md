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
| 024 | unified_inbox | Kalıcı mention/reply kimlikleri + GDM okundu imleci |
| 025 | saved_followup | Kullanıcıya özel, yalnız kimlik saklayan Saved / Follow-up kayıtları |
| 026 | presence_visibility | Presence visibility persistence |
| 027 | search_index_alignment | Search index/schema alignment |
| 028 | group_dm_search | Group DM search support |
| 029 | member_ban_column | Member ban persistence |
| 030 | poll_vote_change | Poll vote-change persistence |
| 031 | member_server_profile | Server-scoped member profile JSONB |
| 032 | podcast_channel_schema | Podcast runtime schema channel scope alignment |
| 033 | announcement_crosspost_persistence | Durable/idempotent announcement crosspost log |
| 034 | runtime_schema_contract_closure | Production-reachable runtime/schema contract closure |
| 035 | scheduled_dispatch_durability | Multi-node scheduled-message lease + idempotency |
| 036 | automod_alert_idempotency | AutoMod duplicate alert prevention |
| 037 | server_events_canonical_closure | Server-event clean/install schema closure |
| 038 | federation_delivery_claims | Multi-node ActivityPub retry lease ownership |
| 039 | message_super_reactions | Message super-reaction persistence contract |
| 040 | outgoing_webhook_schema_closure | Outgoing webhook runtime/BOOLEAN schema closure |
| 041 | scheduled_cancel_claim_safety | Scheduled cancel-vs-dispatch race safety |
| 042 | outgoing_webhook_durable_delivery | Bounded multi-node outgoing webhook retry queue |
| 057 | authentication_security_state | TOTP replay step, uint32 WebAuthn counter, token-version and SSO subject invariants |
| 058 | sso_issuer_binding | Issuer-scoped OIDC/SAML identities with quarantined legacy bindings |
| 059 | soundboard_library | Persistent server soundboard library and per-user state |
| 060 | message_and_member_cursor_indexes | Composite keyset indexes for deterministic message/member pagination |
| 061 | dm_delivery_idempotency | Durable client nonce deduplication for DM/GDM optimistic sends |
| 062 | thread_message_delivery_idempotency | Durable thread reply nonce deduplication |
| 063 | message_reports | Durable user reporting and moderator review lifecycle |
| 064 | saved_message_reminders | Durable saved-message reminder delivery |
| 065 | channel_read_positions | Monotonic user × channel read cursor |
| 066 | notification_watch_words | Server-scoped watch-word preferences |
| 067 | inbox_watch_attention | Distinct durable watch-word Inbox attention |
| 068 | user_presence_status | Persistent presence preference separate from live connectivity |
| 069 | message_stickers | Server-verified durable sticker message snapshots |
| 070 | marketplace_executable_bot | Admin-bound executable marketplace bot identity and install ownership |
| 071 | delete_cascade_fk_indexes | Referencing-column indexes so cascade deletes do not scan per deleted row (measured) |
| 072 | bot_install_granted_scopes | Consented scopes of marketplace bot installs; existing installs keep the base scope only |
| 073 | marketplace_seed_truthfulness | Built-in example listings declare only enforced bot scopes; unimplementable examples withdrawn |
| 074 | message_content_format | Channel message text stored as typed (RAW=1); existing rows stay LEGACY=0 and are decoded on read |
| 075 | user_locale | The language a person reads, so server-written push copy is not Turkish-only |

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
4. Clean-install sahibi `db/postgres/schema.ts` ve startup upgrade sahibi `db/postgres/migrations.ts` ile hizala
5. `db/postgres/schema.sql` dosyasını canonical owner yapma; yalnız gerekiyorsa legacy/reference uyumu için güncelle
6. Bu README'deki Migration Listesi tablosunu güncelle
7. PR açmadan önce disposable PostgreSQL üzerinde migration/rollback doğrulaması çalıştır
