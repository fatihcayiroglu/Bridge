// server/db/postgres/migrations.ts
// Inline migration runner — schema kurulduktan sonra çalışır.
// Her migration IF NOT EXISTS / ADD COLUMN IF NOT EXISTS ile idempotent.
// Üretim DB'lere eski sürümlerden gelen eksik sütunları güvenle ekler.
//
// YENİ MIGRATION EKLEMEK:
//   1. SQL'i COLUMN_MIGRATIONS veya EXTRA_TABLES dizisine ekle.
//   2. Her zaman idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS) yaz.
//   3. Yapısal değişiklik için migrations_pg/ altına numaralı dosya aç.
//   4. Ek TypeScript sabitleri gerekiyorsa migrations_pg/NNN_..._inline.ts yaz
//      ve import'u bu dosyanın BAŞINA ekle (diğer import'larla birlikte).

import { Pool } from 'pg';
import logger from '../../lib/logger';
import { BOT_MARKETPLACE_TABLES } from '../migrations_pg/010_bot_marketplace_inline';
import {
  TWO_FACTOR_SECURITY_FUNCTIONS,
  X3DH_SECURITY_INVARIANTS,
} from '../migrations_pg/057_authentication_security_state_inline';

// ── KOLON / INDEX MIGRASYONLARI ─────────────────────────────
// Mevcut production DB'lere eksik sütunları ekler.
const COLUMN_MIGRATIONS: string[] = [
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "apPublicKey" TEXT`,

  // Migration 068 — durable preferred presence must exist on normal startup
  // upgrades too. Backfill ONLY when the column is first introduced; running
  // this inline migration on every boot must never overwrite a user's saved
  // presence preference.
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'users'
          AND column_name = 'presenceStatus'
     ) THEN
       ALTER TABLE users ADD COLUMN "presenceStatus" TEXT NOT NULL DEFAULT 'online';
       UPDATE users
          SET "presenceStatus" = CASE
            WHEN status IN ('online', 'idle', 'dnd', 'offline') THEN status
            ELSE 'online'
          END;
     END IF;
     IF NOT EXISTS (
       SELECT 1 FROM pg_constraint
        WHERE conrelid = 'users'::regclass
          AND conname = 'users_presenceStatus_check'
     ) THEN
       ALTER TABLE users ADD CONSTRAINT "users_presenceStatus_check"
         CHECK ("presenceStatus" IN ('online', 'idle', 'dnd', 'offline'));
     END IF;
   END $$`,


  // Migration 055 — E2EE/X3DH key material was present in routes and the
  // documentation schema but missing from the canonical runtime schema owner.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2ePublicKey" TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eKeyVersion" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eAlgorithm" TEXT NOT NULL DEFAULT 'X25519'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "e2eKeyUpdatedAt" BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhIdentityKey" TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhSignedPreKey" JSONB`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhOneTimePreKeys" JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "x3dhUpdatedAt" BIGINT`,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM users
        WHERE "e2eKeyVersion" IS NULL OR "e2eKeyVersion" < 1
           OR "e2eAlgorithm" IS NULL OR "e2eAlgorithm" NOT IN ('X25519', 'P-256')
           OR "x3dhOneTimePreKeys" IS NULL
           OR jsonb_typeof("x3dhOneTimePreKeys") <> 'array'
     ) THEN
       RAISE EXCEPTION '055: invalid persisted E2EE/X3DH key state; repair explicitly before migration';
     END IF;
   END $$`,
  `ALTER TABLE users ALTER COLUMN "e2eKeyVersion" SET DEFAULT 1`,
  `ALTER TABLE users ALTER COLUMN "e2eKeyVersion" SET NOT NULL`,
  `ALTER TABLE users ALTER COLUMN "e2eAlgorithm" SET DEFAULT 'X25519'`,
  `ALTER TABLE users ALTER COLUMN "e2eAlgorithm" SET NOT NULL`,
  `ALTER TABLE users ALTER COLUMN "x3dhOneTimePreKeys" SET DEFAULT '[]'::jsonb`,
  `ALTER TABLE users ALTER COLUMN "x3dhOneTimePreKeys" SET NOT NULL`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_e2e_key_version_check') THEN
       ALTER TABLE users ADD CONSTRAINT users_e2e_key_version_check CHECK ("e2eKeyVersion" >= 1);
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_e2e_algorithm_check') THEN
       ALTER TABLE users ADD CONSTRAINT users_e2e_algorithm_check CHECK ("e2eAlgorithm" IN ('X25519', 'P-256'));
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_x3dh_otpks_array_check') THEN
       ALTER TABLE users ADD CONSTRAINT users_x3dh_otpks_array_check CHECK (jsonb_typeof("x3dhOneTimePreKeys") = 'array');
     END IF;
   END $$`,
  ...X3DH_SECURITY_INVARIANTS,

  // Migration 053 — every membership entry path enforces the same bounded MFA
  // domain. Unknown persisted values previously became NaN and silently
  // disabled the `>= 1` gate; repair them to the strongest supported level.
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS "mfaLevel" INTEGER NOT NULL DEFAULT 0`,
  `UPDATE servers SET "mfaLevel" = 2 WHERE "mfaLevel" IS NULL OR "mfaLevel" NOT IN (0, 1, 2)`,
  `ALTER TABLE servers ALTER COLUMN "mfaLevel" SET DEFAULT 0`,
  `ALTER TABLE servers ALTER COLUMN "mfaLevel" SET NOT NULL`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'servers_mfa_level_check') THEN
       ALTER TABLE servers ADD CONSTRAINT servers_mfa_level_check
         CHECK ("mfaLevel" IN (0, 1, 2));
     END IF;
   END $$`,

  // Migration 054 — a directional channel pair is one durable bridge. Keep
  // the newest historical duplicate before adding the concurrency constraint.
  `WITH ranked AS (
     SELECT _id,
            row_number() OVER (
              PARTITION BY "sourceChannelId", "targetChannelId"
              ORDER BY "createdAt" DESC NULLS LAST, _id DESC
            ) AS duplicate_rank
       FROM channel_bridges
   )
   DELETE FROM channel_bridges bridge
    USING ranked
    WHERE bridge._id = ranked._id AND ranked.duplicate_rank > 1`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_channel_bridges_pair_unique
     ON channel_bridges("sourceChannelId", "targetChannelId")`,

  // Migration 052 — bind refresh sessions to the user tokenVersion that
  // existed when the session was issued. Historical rows cannot be safely
  // backfilled because a previous password/logout-all revocation may have
  // failed after tokenVersion advanced; treating such rows as current would
  // resurrect revoked sessions. Force one re-login instead.
  `ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS "tokenVersion" INTEGER`,
  `DELETE FROM refresh_tokens WHERE "tokenVersion" IS NULL`,
  `ALTER TABLE refresh_tokens ALTER COLUMN "tokenVersion" SET NOT NULL`,
  `ALTER TABLE refresh_tokens DROP CONSTRAINT IF EXISTS refresh_tokens_token_version_nonnegative`,
  `ALTER TABLE refresh_tokens ADD CONSTRAINT refresh_tokens_token_version_nonnegative CHECK ("tokenVersion" >= 0)`,
  // Extension'lar
  `CREATE EXTENSION IF NOT EXISTS unaccent`,
  `CREATE EXTENSION IF NOT EXISTS pg_trgm`,

  // FTS: idx_messages_fts was superseded by migration 027's
  // idx_messages_fts_unaccent (the only expression fts.ts can use). Recreating
  // it here on every boot re-added an unreachable GIN index that 027 dropped
  // (P5 SH-04; migration 076 removes it where earlier boots recreated it).
  `CREATE INDEX IF NOT EXISTS idx_messages_trgm ON messages USING GIN(content gin_trgm_ops)`,

  // dm_messages — reactions, e2e alanları
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS reactions JSONB NOT NULL DEFAULT '{}'`,
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS e2e BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "clientNonce" TEXT`,
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "isEncrypted" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE dm_messages ADD COLUMN IF NOT EXISTS "e2eData" JSONB`,

  // push_subscriptions — subscription JSONB → endpoint + keys ayrı sütunlar
  `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS endpoint TEXT`,
  `ALTER TABLE push_subscriptions ADD COLUMN IF NOT EXISTS keys JSONB DEFAULT '{}'`,
  `UPDATE push_subscriptions SET endpoint = subscription->>'endpoint', keys = subscription->'keys' WHERE endpoint IS NULL AND subscription IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_push_endpoint ON push_subscriptions(endpoint)`,
  `CREATE INDEX IF NOT EXISTS idx_nativepush_user ON native_push_tokens("userId")`,
  `CREATE INDEX IF NOT EXISTS idx_dm_messages_ts ON dm_messages("dmId", "createdAt" DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_dm_messages_client_nonce ON dm_messages("userId", "clientNonce") WHERE "clientNonce" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_dm_messages_file_url_authz ON dm_messages("fileUrl") WHERE "fileUrl" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_messages_file_url_authz ON messages("fileUrl") WHERE "fileUrl" IS NOT NULL`,

  // audit_logs ek kolonlar
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "channelId" TEXT`,

  // ── MODERASYON: BAN VE DENETIM GUNLUGU SUTUNLARI ─────────────────────────
  // `POST /api/servers/:sid/bans` HER DURUMDA 500 donuyordu (dogrudan olculdu):
  //
  //   sebepsiz ban → [pgCollection] Unknown column name: "actorName"
  //   sebepli ban  → [pgCollection] Unknown column name: "banReason"
  //
  // Yani BAN OZELLIGI TUMUYLE CALISMIYORDU — cekirdek bir moderasyon islevi.
  // Kod su alanlari yaziyor ama kanonik tablolar bunlari tanimlamiyordu:
  //   MemberRepository.banMember → members.banReason
  //   writeAudit                 → audit_logs.actorName / targetId / targetName
  //
  // NEDEN SUTUN EKLENIYOR (kaldirilmiyor): veri GERI OKUNUYOR ve anlamli.
  // Yalnizca kimlik iceren bir denetim gunlugu ("kim kimi banladi") okunaksiz
  // olurdu; ban sebebi de moderatorler icin islevin ta kendisidir.
  //
  // NOT: `db/postgres/schema.sql` bu sutunlarin BIR KISMINI zaten iceriyordu,
  // ancak o dosya KANONIK DEGILDIR. Kanonik tanim burasidir; ikisi ayrismisti.
  `ALTER TABLE members    ADD COLUMN IF NOT EXISTS "banReason"  TEXT`,
  // Migration 031 — serverMemberProfile route writes this structured object.
  `ALTER TABLE members    ADD COLUMN IF NOT EXISTS "serverProfile" JSONB NOT NULL DEFAULT '{}'`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "actorName"  TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "targetId"   TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "targetName" TEXT`,

  // Migration 034 — runtime repository/route schema contract closure.
  // These columns are all production-reachable and were previously present only
  // in route/repository expectations or numbered historical migrations, causing
  // clean installs and normal startup upgrades to diverge.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS activity JSONB`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "activityUpdatedAt" BIGINT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "ssoProvider" TEXT`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "ssoId" TEXT`,
  // Migration 058 — bind external subjects inside their verified issuer/entity
  // namespace. Existing provider/subject rows are quarantined until an operator
  // explicitly approves their one-time legacy-authority upgrade.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "ssoIssuer" TEXT`,
  `UPDATE users
      SET "ssoIssuer" = 'legacy:' || "ssoProvider"
    WHERE "ssoProvider" IS NOT NULL AND "ssoId" IS NOT NULL AND "ssoIssuer" IS NULL`,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM users
        WHERE (("ssoProvider" IS NULL) <> ("ssoIssuer" IS NULL))
           OR (("ssoProvider" IS NULL) <> ("ssoId" IS NULL))
           OR ("ssoProvider" IS NOT NULL AND "ssoProvider" NOT IN ('oidc', 'saml'))
           OR ("ssoIssuer" IS NOT NULL AND char_length("ssoIssuer") NOT BETWEEN 1 AND 2048)
           OR ("ssoId" IS NOT NULL AND char_length("ssoId") NOT BETWEEN 1 AND 1024)
     ) THEN
       RAISE EXCEPTION '058: incomplete or invalid issuer-scoped SSO identity; repair explicitly before migration';
     END IF;
     IF EXISTS (
       SELECT 1 FROM users
        WHERE "ssoProvider" IS NOT NULL
        GROUP BY "ssoProvider", "ssoIssuer", "ssoId"
       HAVING count(*) > 1
     ) THEN
       RAISE EXCEPTION '058: duplicate issuer-scoped SSO identity; repair explicitly before migration';
     END IF;
   END $$`,
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS "twoFactorLastUsedStep" BIGINT`,
  ...TWO_FACTOR_SECURITY_FUNCTIONS,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM users
        WHERE "tokenVersion" IS NULL OR "tokenVersion" < 0
           OR "twoFactorEnabled" IS NULL OR "twoFactorBackup" IS NULL
           OR bridge_valid_two_factor_backup("twoFactorBackup") IS NOT TRUE
           OR ("twoFactorEnabled" AND bridge_valid_totp_secret("twoFactorSecret") IS NOT TRUE)
           OR "twoFactorLastUsedStep" < 0
     ) THEN
       RAISE EXCEPTION '057: invalid persisted user authentication state; repair explicitly before migration';
     END IF;
   END $$`,
  `ALTER TABLE users ALTER COLUMN "tokenVersion" SET DEFAULT 0`,
  `ALTER TABLE users ALTER COLUMN "tokenVersion" SET NOT NULL`,
  `ALTER TABLE users ALTER COLUMN "twoFactorEnabled" SET DEFAULT FALSE`,
  `ALTER TABLE users ALTER COLUMN "twoFactorEnabled" SET NOT NULL`,
  `ALTER TABLE users ALTER COLUMN "twoFactorBackup" SET DEFAULT '[]'::jsonb`,
  `ALTER TABLE users ALTER COLUMN "twoFactorBackup" SET NOT NULL`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_token_version_nonnegative`,
  `ALTER TABLE users ADD CONSTRAINT users_token_version_nonnegative CHECK ("tokenVersion" >= 0)`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_two_factor_state_valid`,
  `ALTER TABLE users ADD CONSTRAINT users_two_factor_state_valid CHECK (
    ("twoFactorLastUsedStep" IS NULL OR "twoFactorLastUsedStep" >= 0)
    AND bridge_valid_two_factor_backup("twoFactorBackup") IS TRUE
    AND (NOT "twoFactorEnabled" OR bridge_valid_totp_secret("twoFactorSecret") IS TRUE)
  )`,
  `ALTER TABLE users DROP CONSTRAINT IF EXISTS users_sso_binding_valid`,
  `ALTER TABLE users ADD CONSTRAINT users_sso_binding_valid CHECK (
    (("ssoProvider" IS NULL) = ("ssoIssuer" IS NULL))
    AND (("ssoProvider" IS NULL) = ("ssoId" IS NULL))
    AND ("ssoProvider" IS NULL OR "ssoProvider" IN ('oidc', 'saml'))
    AND ("ssoIssuer" IS NULL OR char_length("ssoIssuer") BETWEEN 1 AND 2048)
    AND ("ssoId" IS NULL OR char_length("ssoId") BETWEEN 1 AND 1024)
  )`,
  `DO $$ BEGIN
     DROP INDEX IF EXISTS idx_users_sso_provider_subject_unique;
     IF EXISTS (
       SELECT 1 FROM pg_indexes
        WHERE schemaname = current_schema()
          AND indexname = 'idx_users_sso_identity_unique'
          AND indexdef NOT LIKE '%"ssoIssuer"%'
     ) THEN
       DROP INDEX idx_users_sso_identity_unique;
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_users_sso_identity_unique
     ON users("ssoProvider", "ssoIssuer", "ssoId") WHERE "ssoProvider" IS NOT NULL`,
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS featured BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS "featuredAt" BIGINT`,
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS "vanityUrl" TEXT`,
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS "ssoConfig" JSONB`,
  `ALTER TABLE members ADD COLUMN IF NOT EXISTS nickname TEXT`,
  `ALTER TABLE channels ADD COLUMN IF NOT EXISTS "modOnly" BOOLEAN NOT NULL DEFAULT FALSE`,
  // Migration 050 — live channel settings used by slowmode/forum UI.
  `ALTER TABLE channels ADD COLUMN IF NOT EXISTS slowmode INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE channels ADD COLUMN IF NOT EXISTS "forumTags" JSONB NOT NULL DEFAULT '[]'::jsonb`,
  `UPDATE channels SET slowmode = 0 WHERE slowmode NOT IN (0,5,10,15,30,60,120,300,600,900,1800,3600,7200,21600)`,
  `ALTER TABLE channels DROP CONSTRAINT IF EXISTS channels_slowmode_check`,
  `ALTER TABLE channels ADD CONSTRAINT channels_slowmode_check CHECK (slowmode IN (0,5,10,15,30,60,120,300,600,900,1800,3600,7200,21600))`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS "firstMessage" TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS "participantCount" INTEGER NOT NULL DEFAULT 1`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE threads ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE`,
  // Forum konusu KANAL koklidir: ust mesaji yoktur. Kolon NOT NULL kaldigi
  // surece routes/threads.ts'in forum dali (channelId + name) her cagrida
  // 500 veriyordu -- OLCULDU (v1.123): POST /api/threads ->
  // 'null value in column "parentMessageId" violates not-null constraint'.
  // Kisit gevsetilir; mesaj kokli konular parentMessageId'yi yazmaya devam
  // eder ve idx_threads_parent UNIQUE olmadigi icin coklu NULL sorunsuzdur.
  `ALTER TABLE threads ALTER COLUMN "parentMessageId" DROP NOT NULL`,
  `ALTER TABLE voice_messages ADD COLUMN IF NOT EXISTS transcript TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS transcript TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "webhookId" TEXT`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "isWebhook" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "flaggedMsgId" TEXT`,
  // Migration 069 — canonical sticker-message snapshot.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS sticker JSONB`,
  `ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS token TEXT`,
  `ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS "avatarUrl" TEXT`,
  `ALTER TABLE webhooks ADD COLUMN IF NOT EXISTS "createdBy" TEXT`,
  `ALTER TABLE webhooks ALTER COLUMN secret DROP NOT NULL`,
  `UPDATE webhooks SET token = secret WHERE token IS NULL AND secret IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_webhooks_token ON webhooks(token) WHERE token IS NOT NULL`,

  // Migration 045 — notification preference runtime/schema closure.
  `ALTER TABLE notification_prefs ADD COLUMN IF NOT EXISTS "muteUntil" BIGINT`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1 FROM pg_class WHERE relkind = 'i' AND relname = 'idx_notification_prefs_user_channel_unique'
     ) THEN
       DELETE FROM notification_prefs older
        USING notification_prefs newer
        WHERE older."userId" = newer."userId"
          AND older."channelId" = newer."channelId"
          AND (older."updatedAt" < newer."updatedAt"
            OR (older."updatedAt" = newer."updatedAt" AND older._id < newer._id));
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notification_prefs_user_channel_unique
     ON notification_prefs("userId", "channelId")`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'notification_prefs_level_check') THEN
       ALTER TABLE notification_prefs ADD CONSTRAINT notification_prefs_level_check
         CHECK (level IN ('all', 'mentions', 'mute', 'default')) NOT VALID;
     END IF;
   END $$`,

  // Migration 038 — Super Reactions belong to the message aggregate, not reaction_roles.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "superReactions" JSONB NOT NULL DEFAULT '{}'`,

  // Migration 035 — durable, multi-node-safe scheduled-message dispatch.
  `ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "claimOwner" TEXT`,
  `ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "claimUntil" BIGINT`,
  `ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "dispatchAttempts" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "lastError" TEXT`,
  `ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "failedAt" BIGINT`,
  `ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "failureReason" TEXT`,
  `ALTER TABLE scheduled_msgs ADD COLUMN IF NOT EXISTS "cancelledAt" BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_sched_dispatch_due
     ON scheduled_msgs(sent, "sendAt", "claimUntil") WHERE sent = FALSE AND "failedAt" IS NULL AND "cancelledAt" IS NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_scheduled_id
     ON messages("scheduledId") WHERE "scheduledId" IS NOT NULL`,

  // Migration 036 — AutoMod alert idempotency across overlapping scans/nodes.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_automod_alert_flagged_msg
     ON messages("flaggedMsgId")
     WHERE "autoModAlert" = TRUE AND "flaggedMsgId" IS NOT NULL`,

  // Migration 032 — PodcastRepository ve route kanal-scoped canonical sözleşme.
  // Eski inline tablolar server-scoped olduğu için PostgreSQL ile runtime drift etmişti.
  `ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS "channelId" TEXT`,
  `ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS author TEXT`,
  `ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS "imageUrl" TEXT`,
  `ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'tr'`,
  `ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Technology'`,
  `ALTER TABLE podcast_settings ADD COLUMN IF NOT EXISTS explicit BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE podcast_settings ALTER COLUMN "serverId" DROP NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_settings_channel ON podcast_settings("channelId") WHERE "channelId" IS NOT NULL`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "channelId" TEXT`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS filename TEXT`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "mimeType" TEXT NOT NULL DEFAULT 'audio/mpeg'`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "fileSize" BIGINT NOT NULL DEFAULT 0`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "durationSeconds" INTEGER`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS season INTEGER`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS episode INTEGER`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS published BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE podcast_episodes ADD COLUMN IF NOT EXISTS "createdBy" TEXT`,
  `ALTER TABLE podcast_episodes ALTER COLUMN "serverId" DROP NOT NULL`,
  `ALTER TABLE podcast_episodes ALTER COLUMN "audioUrl" DROP NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_podcast_episodes_channel ON podcast_episodes("channelId", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published ON podcast_episodes("channelId", published, "publishedAt" DESC)`,

  // ── GIDEN WEBHOOK TESLIMAT DURUMU ────────────────────────────────────────
  // `routes/outgoingWebhooks.ts` teslimat sonucunu kaydederken bu sutunlari
  // YAZIYORDU ama tablo tanimi onlari HIC ICERMIYORDU. Sonuc, her teslimat
  // denemesinde 500 idi (dogrudan olculdu):
  //
  //   [pgCollection] Unknown column name: "consecutiveFailures"
  //     at PgCollection.update → OutgoingWebhookRepository.update
  //     at fireOutgoingWebhook  (HEM basari HEM hata dalinda)
  //
  // ETKISI yalnizca gurultu degildi:
  //   · `lastFiredAt` / `lastStatus` hic kalici olmuyordu → durum arayuzu bayat
  //   · 10 ardisik hatadan sonra OTOMATIK DEVRE DISI birakma HIC calismiyordu
  //   · hata yakalama dalinin kendisi cokuyordu → 500 yukari sizip rotayi kiriyordu
  //
  // Sutunlar EKLENIR (kaldirilmaz): veri GERI OKUNUYOR (auto-disable mantigi ve
  // listeleme yaniti). Kanonik sema sahipligi korunur — ayni dosyadaki
  // yerlesik `ADD COLUMN IF NOT EXISTS` kalibi kullanilir.
  `ALTER TABLE outgoing_webhooks ADD COLUMN IF NOT EXISTS "consecutiveFailures" INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE outgoing_webhooks ADD COLUMN IF NOT EXISTS "lastFailedAt" BIGINT`,
  `ALTER TABLE outgoing_webhooks ADD COLUMN IF NOT EXISTS "lastError" TEXT`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "old" JSONB`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS "new" JSONB`,
  `ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'`,
  `CREATE INDEX IF NOT EXISTS idx_audit_server_channel ON audit_logs("serverId", "channelId")`,

  // messages ek kolonlar
  // Poll vote-change semantics are persisted; without this column PATCH/insert drifted from schema.
  `ALTER TABLE polls ADD COLUMN IF NOT EXISTS "allowVoteChange" BOOLEAN NOT NULL DEFAULT TRUE`,

  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS embeds JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS components JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "botId" TEXT`,
  // Reliable Outbox: normal startup must also upgrade an existing database.
  // The numbered migration remains the auditable deployment source of truth.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "ackId" TEXT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_user_ack
    ON messages("userId", "ackId") WHERE "ackId" IS NOT NULL`,

  // bots ek kolonlar
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS "isPublic" BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS description TEXT`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'utility'`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS icon TEXT`,
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS "contextCommands" JSONB NOT NULL DEFAULT '[]'`,
  // Migration 051 — bot SDK command metadata / discovery contract.
  `ALTER TABLE bots ADD COLUMN IF NOT EXISTS "slashCommands" JSONB NOT NULL DEFAULT '[]'`,

  // ap_follows ek kolonlar
  `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS accepted BOOLEAN NOT NULL DEFAULT TRUE`,
  `ALTER TABLE ap_follows ADD COLUMN IF NOT EXISTS "actorInbox" TEXT`,

  // ap_messages ek kolonlar
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "targetUserId" TEXT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS visibility TEXT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS summary TEXT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS sensitive BOOLEAN NOT NULL DEFAULT FALSE`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "inReplyTo" TEXT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS attachments JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS published BIGINT`,
  `ALTER TABLE ap_messages ADD COLUMN IF NOT EXISTS "updatedAt" BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_actor ON ap_messages("actorUrl")`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_published ON ap_messages(published DESC NULLS LAST)`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_visibility_actor ON ap_messages(visibility, "actorUrl", published DESC NULLS LAST)`,

  // ap_activities ek kolonlar. Inbound targetUserId ve outbound actorUserId
  // alternatif kimliklerdir; C2S kaydı targetUserId taşımaz.
  `ALTER TABLE ap_activities ALTER COLUMN "targetUserId" DROP NOT NULL`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "actorUserId" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS type TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "activityId" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "noteId" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "publishedAt" BIGINT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "actorUrl" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "processedAt" BIGINT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "claimOwner" TEXT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "claimUntil" BIGINT`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE ap_activities ADD COLUMN IF NOT EXISTS "lastError" TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON ap_activities("actorUserId")`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_target ON ap_activities("targetUserId", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(type)`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_activity_id ON ap_activities("activityId") WHERE "activityId" IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_activities_inbound_unique
     ON ap_activities("targetUserId", "actorUrl", "activityId")
     WHERE "targetUserId" IS NOT NULL AND "actorUrl" IS NOT NULL AND "activityId" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_claim
     ON ap_activities(processed, "claimUntil") WHERE processed = FALSE`,
];

// ── EK TABLOLAR (v40-v78+ arasında eklenenler) ──────────────
const EXTRA_TABLES: string[] = [
  // Migration 066 — durable literal watch words for server notification policy.
  `CREATE TABLE IF NOT EXISTS notification_keywords (
     "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
     "serverId" TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
     keyword TEXT NOT NULL,
     "createdAt" BIGINT NOT NULL,
     PRIMARY KEY ("userId", "serverId", keyword),
     CONSTRAINT notification_keywords_length CHECK (char_length(keyword) BETWEEN 2 AND 32)
   )`,
  `CREATE INDEX IF NOT EXISTS idx_notification_keywords_match
     ON notification_keywords("serverId", keyword)`,
  // Migration 059 — effectively-unlimited soundboard library with bounded
  // keyset reads and durable user state.
  `ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS category TEXT NOT NULL DEFAULT 'Server'`,
  `ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "durationSeconds" DOUBLE PRECISION`,
  `ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "mimeType" TEXT`,
  `ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "fileSize" BIGINT`,
  `ALTER TABLE soundboard ADD COLUMN IF NOT EXISTS "updatedAt" BIGINT`,
  // Upgrade constraints are added NOT VALID so dirty legacy rows cannot abort
  // rollout, then validation is attempted in a narrow exception block. Clean
  // upgrades converge to the validated fresh schema; only the relevant data
  // violation leaves a legacy constraint NOT VALID.
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_name_length' AND conrelid = 'soundboard'::regclass) THEN
       ALTER TABLE soundboard ADD CONSTRAINT soundboard_name_length CHECK (char_length(name) BETWEEN 1 AND 32) NOT VALID;
     END IF;
     BEGIN
       ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_name_length;
     EXCEPTION WHEN check_violation THEN NULL;
     END;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_emoji_length' AND conrelid = 'soundboard'::regclass) THEN
       ALTER TABLE soundboard ADD CONSTRAINT soundboard_emoji_length CHECK (char_length(emoji) BETWEEN 1 AND 32) NOT VALID;
     END IF;
     BEGIN
       ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_emoji_length;
     EXCEPTION WHEN check_violation THEN NULL;
     END;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_category_length' AND conrelid = 'soundboard'::regclass) THEN
       ALTER TABLE soundboard ADD CONSTRAINT soundboard_category_length CHECK (char_length(category) BETWEEN 1 AND 32) NOT VALID;
     END IF;
     BEGIN
       ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_category_length;
     EXCEPTION WHEN check_violation THEN NULL;
     END;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_duration_bounds' AND conrelid = 'soundboard'::regclass) THEN
       ALTER TABLE soundboard ADD CONSTRAINT soundboard_duration_bounds CHECK ("durationSeconds" > 0 AND "durationSeconds" <= 5) NOT VALID;
     END IF;
     BEGIN
       ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_duration_bounds;
     EXCEPTION WHEN check_violation THEN NULL;
     END;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'soundboard_file_size_bounds' AND conrelid = 'soundboard'::regclass) THEN
       ALTER TABLE soundboard ADD CONSTRAINT soundboard_file_size_bounds CHECK ("fileSize" IS NULL OR ("fileSize" > 0 AND "fileSize" <= 5242880)) NOT VALID;
     END IF;
     BEGIN
       ALTER TABLE soundboard VALIDATE CONSTRAINT soundboard_file_size_bounds;
     EXCEPTION WHEN check_violation THEN NULL;
     END;
   END $$`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_soundboard_server' AND conrelid = 'soundboard'::regclass) THEN
       ALTER TABLE soundboard ADD CONSTRAINT fk_soundboard_server FOREIGN KEY ("serverId") REFERENCES servers(_id) ON DELETE CASCADE NOT VALID;
     END IF;
     BEGIN
       ALTER TABLE soundboard VALIDATE CONSTRAINT fk_soundboard_server;
     EXCEPTION WHEN foreign_key_violation THEN NULL;
     END;
   END $$`,
  `CREATE INDEX IF NOT EXISTS idx_soundboard_server_page ON soundboard("serverId", "createdAt" DESC, _id DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_soundboard_server_name ON soundboard("serverId", lower(name))`,
  `CREATE TABLE IF NOT EXISTS soundboard_user_stats (
    "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
    "soundId" TEXT NOT NULL,
    "serverId" TEXT REFERENCES servers(_id) ON DELETE CASCADE,
    favorite BOOLEAN NOT NULL DEFAULT FALSE,
    "favoritedAt" BIGINT,
    "playCount" BIGINT NOT NULL DEFAULT 0 CHECK ("playCount" >= 0),
    "lastPlayedAt" BIGINT,
    PRIMARY KEY ("userId", "soundId"),
    CONSTRAINT soundboard_stats_favorite_time CHECK (favorite = ("favoritedAt" IS NOT NULL)),
    CONSTRAINT soundboard_stats_play_time CHECK (("playCount" = 0) = ("lastPlayedAt" IS NULL)),
    CONSTRAINT soundboard_stats_scope CHECK (("serverId" IS NULL AND "soundId" LIKE 'global:%') OR ("serverId" IS NOT NULL AND "soundId" NOT LIKE 'global:%'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_soundboard_stats_favorites
     ON soundboard_user_stats("userId", "favoritedAt" DESC, "soundId" DESC) WHERE favorite = TRUE`,
  `CREATE INDEX IF NOT EXISTS idx_soundboard_stats_recent
     ON soundboard_user_stats("userId", "lastPlayedAt" DESC, "soundId" DESC) WHERE "playCount" > 0`,
  `CREATE INDEX IF NOT EXISTS idx_soundboard_stats_frequent
     ON soundboard_user_stats("userId", "playCount" DESC, "lastPlayedAt" DESC, "soundId" DESC) WHERE "playCount" > 0`,
  // Migration 036 — server events existed only in numbered migration 013.
  // Keep normal startup upgrades aligned with clean-install schema.ts.
  `CREATE TABLE IF NOT EXISTS server_events (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    server_id TEXT NOT NULL REFERENCES servers(_id) ON DELETE CASCADE,
    creator_id TEXT REFERENCES users(_id) ON DELETE SET NULL,
    title TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 100),
    description TEXT CHECK (char_length(description) <= 1000),
    location TEXT CHECK (char_length(location) <= 200),
    channel_id TEXT REFERENCES channels(_id) ON DELETE CASCADE,
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled','active','ended','cancelled')),
    cover_image TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT server_events_ends_after_starts CHECK (ends_at IS NULL OR ends_at > starts_at)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_server_events_server_id ON server_events(server_id)`,
  `CREATE INDEX IF NOT EXISTS idx_server_events_starts_at ON server_events(starts_at)`,
  `CREATE INDEX IF NOT EXISTS idx_server_events_status ON server_events(status)`,
  `CREATE TABLE IF NOT EXISTS server_event_rsvp (
    event_id TEXT NOT NULL REFERENCES server_events(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
    status TEXT NOT NULL CHECK (status IN ('interested','going','not_going')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY(event_id, user_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_event ON server_event_rsvp(event_id)`,
  `CREATE INDEX IF NOT EXISTS idx_server_event_rsvp_user ON server_event_rsvp(user_id)`,
  // Migration 065 — durable chronological read position (separate from unread attention counters).
  `CREATE TABLE IF NOT EXISTS channel_read_positions (
    "userId" TEXT NOT NULL REFERENCES users(_id) ON DELETE CASCADE,
    "channelId" TEXT NOT NULL REFERENCES channels(_id) ON DELETE CASCADE,
    "lastReadAt" BIGINT NOT NULL,
    "lastReadMessageId" TEXT NOT NULL,
    "updatedAt" BIGINT NOT NULL,
    PRIMARY KEY ("userId", "channelId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_channel_read_positions_user
     ON channel_read_positions("userId", "updatedAt" DESC)`,
  `ALTER TABLE server_events DROP CONSTRAINT IF EXISTS server_events_channel_id_fkey`,
  `ALTER TABLE server_events ADD CONSTRAINT server_events_channel_id_fkey
     FOREIGN KEY (channel_id) REFERENCES channels(_id) ON DELETE CASCADE`,

  `CREATE TABLE IF NOT EXISTS user_ap_keys (
    "userId" TEXT PRIMARY KEY REFERENCES users(_id) ON DELETE CASCADE,
    "apPrivateKeyEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS channel_permissions (
    _id TEXT PRIMARY KEY,
    "channelId" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    allow INTEGER NOT NULL DEFAULT 0,
    deny INTEGER NOT NULL DEFAULT 0,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT,
    UNIQUE("channelId", "roleId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_chperms_channel ON channel_permissions("channelId")`,
  `DO $$ BEGIN
     IF EXISTS (
       SELECT 1 FROM roles
        WHERE permissions IS NULL OR permissions < 0 OR permissions > 1094713343
           OR (permissions::bigint & 1094713343::bigint) <> permissions::bigint
     ) OR EXISTS (
       SELECT 1 FROM channel_overrides
        WHERE allow IS NULL OR deny IS NULL OR allow < 0 OR deny < 0
           OR allow > 1094713343 OR deny > 1094713343
           OR (allow::bigint & 1094713343::bigint) <> allow::bigint
           OR (deny::bigint & 1094713343::bigint) <> deny::bigint
           OR (allow::bigint & deny::bigint) <> 0
     ) OR EXISTS (
       SELECT 1 FROM channel_permissions
        WHERE allow IS NULL OR deny IS NULL OR allow < 0 OR deny < 0
           OR allow > 1094713343 OR deny > 1094713343
           OR (allow::bigint & 1094713343::bigint) <> allow::bigint
           OR (deny::bigint & 1094713343::bigint) <> deny::bigint
           OR (allow::bigint & deny::bigint) <> 0
     ) THEN
       RAISE EXCEPTION '056: invalid persisted authorization bitmask; repair explicitly before migration';
     END IF;
   END $$`,
  `ALTER TABLE roles ALTER COLUMN permissions SET DEFAULT 16`,
  `ALTER TABLE roles ALTER COLUMN permissions SET NOT NULL`,
  `ALTER TABLE channel_overrides ALTER COLUMN allow SET DEFAULT 0`,
  `ALTER TABLE channel_overrides ALTER COLUMN allow SET NOT NULL`,
  `ALTER TABLE channel_overrides ALTER COLUMN deny SET DEFAULT 0`,
  `ALTER TABLE channel_overrides ALTER COLUMN deny SET NOT NULL`,
  `ALTER TABLE channel_permissions ALTER COLUMN allow SET DEFAULT 0`,
  `ALTER TABLE channel_permissions ALTER COLUMN allow SET NOT NULL`,
  `ALTER TABLE channel_permissions ALTER COLUMN deny SET DEFAULT 0`,
  `ALTER TABLE channel_permissions ALTER COLUMN deny SET NOT NULL`,
  `ALTER TABLE roles DROP CONSTRAINT IF EXISTS roles_permissions_valid`,
  `ALTER TABLE roles ADD CONSTRAINT roles_permissions_valid CHECK (permissions >= 0 AND permissions <= 1094713343 AND (permissions::bigint & 1094713343::bigint) = permissions::bigint)`,
  `ALTER TABLE channel_overrides DROP CONSTRAINT IF EXISTS channel_overrides_masks_valid`,
  `ALTER TABLE channel_overrides ADD CONSTRAINT channel_overrides_masks_valid CHECK (allow >= 0 AND deny >= 0 AND allow <= 1094713343 AND deny <= 1094713343 AND (allow::bigint & 1094713343::bigint) = allow::bigint AND (deny::bigint & 1094713343::bigint) = deny::bigint AND (allow::bigint & deny::bigint) = 0)`,
  `ALTER TABLE channel_permissions DROP CONSTRAINT IF EXISTS channel_permissions_masks_valid`,
  `ALTER TABLE channel_permissions ADD CONSTRAINT channel_permissions_masks_valid CHECK (allow >= 0 AND deny >= 0 AND allow <= 1094713343 AND deny <= 1094713343 AND (allow::bigint & 1094713343::bigint) = allow::bigint AND (deny::bigint & 1094713343::bigint) = deny::bigint AND (allow::bigint & deny::bigint) = 0)`,

  `CREATE TABLE IF NOT EXISTS group_dm_conversations (
    _id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    "ownerId" TEXT NOT NULL,
    icon TEXT,
    "createdAt" BIGINT NOT NULL,
    "lastMessageAt" BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS group_dm_members (
    _id TEXT PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "joinedAt" BIGINT NOT NULL,
    "readAt" BIGINT,
    UNIQUE("groupId", "userId")
  )`,
  `ALTER TABLE group_dm_members ADD COLUMN IF NOT EXISTS "readAt" BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_gdm_members_unread_cursor ON group_dm_members("userId", "groupId", "readAt")`,
  `CREATE TABLE IF NOT EXISTS group_dm_messages (
    _id TEXT PRIMARY KEY,
    "groupId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "avatarColor" TEXT NOT NULL DEFAULT '#2d9cdb',
    content TEXT NOT NULL DEFAULT '',
    type TEXT NOT NULL DEFAULT 'normal',
    "fileUrl" TEXT,
    "fileName" TEXT,
    reactions JSONB NOT NULL DEFAULT '{}',
    "clientNonce" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `ALTER TABLE group_dm_messages ADD COLUMN IF NOT EXISTS "clientNonce" TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_gdm_messages_group ON group_dm_messages("groupId", "createdAt" DESC)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_gdm_messages_client_nonce ON group_dm_messages("userId", "clientNonce") WHERE "clientNonce" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_gdm_messages_file_url_authz ON group_dm_messages("fileUrl") WHERE "fileUrl" IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS reaction_roles (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    emoji TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    UNIQUE("messageId", emoji, "roleId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rr_message ON reaction_roles("messageId")`,

  `CREATE TABLE IF NOT EXISTS blocks (
    _id TEXT PRIMARY KEY,
    "blockerId" TEXT NOT NULL,
    "blockedId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    UNIQUE("blockerId", "blockedId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_blocks_blocker ON blocks("blockerId")`,

  `CREATE TABLE IF NOT EXISTS user_connections (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    platform TEXT NOT NULL,
    username TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    verified BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL,
    UNIQUE("userId", platform)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_connections_user ON user_connections("userId")`,

  `CREATE TABLE IF NOT EXISTS fcm_tokens (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    token TEXT UNIQUE NOT NULL,
    platform TEXT NOT NULL DEFAULT 'android',
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_fcmtokens_user ON fcm_tokens("userId")`,

  `CREATE TABLE IF NOT EXISTS bot_ratings (
    _id TEXT PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    rating INTEGER NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT,
    UNIQUE("botId", "userId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_botratings_bot ON bot_ratings("botId")`,

  `CREATE TABLE IF NOT EXISTS server_bots (
    _id TEXT PRIMARY KEY,
    "botId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "addedBy" TEXT NOT NULL,
    "addedAt" BIGINT NOT NULL,
    UNIQUE("botId", "serverId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_serverbots_server ON server_bots("serverId")`,
  // Migration 072 — consented scopes of a marketplace install (fail closed: base scope only).
  `ALTER TABLE server_bots ADD COLUMN IF NOT EXISTS "grantedScopes" JSONB NOT NULL DEFAULT '["commands"]'::jsonb`,
  // Migration 075 — the language a person reads; NULL until the client reports it.
  `ALTER TABLE users ADD COLUMN IF NOT EXISTS locale TEXT`,
  // Migration 074 — storage format of channel message text (0 legacy sanitized, 1 raw).
  // Mirrored here so a booting instance never writes `contentFormat` into a table without it.
  `ALTER TABLE messages ADD COLUMN IF NOT EXISTS "contentFormat" SMALLINT NOT NULL DEFAULT 0`,
  // Migration 078 (P6) — per-server AI opt-out; TRUE preserves behaviour, the owner opts out.
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS "aiEnabled" BOOLEAN NOT NULL DEFAULT TRUE`,

  // Migration 080 (P7 B1) — bounded, explainable anti-raid configuration.
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS "raidMitigationLevel" TEXT NOT NULL DEFAULT 'balanced'`,
  `UPDATE servers SET "raidMitigationLevel" = 'strict'
      WHERE "raidMitigationLevel" IS NULL
         OR "raidMitigationLevel" NOT IN ('off', 'balanced', 'strict')`,
  `ALTER TABLE servers ALTER COLUMN "raidMitigationLevel" SET DEFAULT 'balanced'`,
  `ALTER TABLE servers ALTER COLUMN "raidMitigationLevel" SET NOT NULL`,
  `ALTER TABLE servers ADD COLUMN IF NOT EXISTS "raidLockdownUntil" BIGINT`,
  `DO $ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'servers_raid_mitigation_level_check') THEN
       ALTER TABLE servers ADD CONSTRAINT servers_raid_mitigation_level_check
         CHECK ("raidMitigationLevel" IN ('off', 'balanced', 'strict'));
     END IF;
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'servers_raid_lockdown_until_nonnegative') THEN
       ALTER TABLE servers ADD CONSTRAINT servers_raid_lockdown_until_nonnegative
         CHECK ("raidLockdownUntil" IS NULL OR "raidLockdownUntil" >= 0);
     END IF;
   END $`,

  `CREATE TABLE IF NOT EXISTS outgoing_webhooks (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    events JSONB NOT NULL DEFAULT '["message:new"]',
    secret TEXT,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "lastFiredAt" BIGINT,
    "lastStatus" INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ogwh_server ON outgoing_webhooks("serverId")`,
  `CREATE TABLE IF NOT EXISTS outgoing_webhook_deliveries (
    _id TEXT PRIMARY KEY,
    "webhookId" TEXT NOT NULL,
    "serverId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0,
    "nextAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "claimOwner" TEXT,
    "claimUntil" BIGINT,
    "lastError" TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ogwh_delivery_due ON outgoing_webhook_deliveries("nextAt", "claimUntil")`,
  `CREATE INDEX IF NOT EXISTS idx_ogwh_delivery_webhook ON outgoing_webhook_deliveries("webhookId", "createdAt")`,

  `CREATE TABLE IF NOT EXISTS server_onboarding (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    "rulesChannelId" TEXT,
    "welcomeChannelId" TEXT,
    "welcomeMessage" TEXT NOT NULL DEFAULT 'Sunucuya hoş geldin, {user}! 👋',
    "verificationLevel" INTEGER NOT NULL DEFAULT 0,
    "defaultRoles" JSONB NOT NULL DEFAULT '[]',
    questions JSONB NOT NULL DEFAULT '[]',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS onboarding_completions (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "completedAt" BIGINT NOT NULL,
    answers JSONB NOT NULL DEFAULT '{}',
    UNIQUE("serverId", "userId")
  )`,

  `CREATE TABLE IF NOT EXISTS automod_rules (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    type TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    config JSONB NOT NULL DEFAULT '{}',
    "createdBy" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_automod_server ON automod_rules("serverId")`,

  `CREATE TABLE IF NOT EXISTS server_federation_keys (
    _id TEXT PRIMARY KEY DEFAULT 'instance',
    "publicKeyPem" TEXT NOT NULL,
    "privateKeyEnc" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" BIGINT NOT NULL,
    "rotatedAt" BIGINT
  )`,

  `CREATE TABLE IF NOT EXISTS user_badges (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    badge TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    icon TEXT NOT NULL DEFAULT '',
    "awardedAt" BIGINT NOT NULL,
    "awardedBy" TEXT,
    UNIQUE ("userId", badge)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges("userId")`,

  `CREATE TABLE IF NOT EXISTS ap_follows (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT NOT NULL,
    "targetUserId" TEXT NOT NULL,
    "activityId" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_apfollows_target ON ap_follows("targetUserId")`,

  `CREATE TABLE IF NOT EXISTS ap_activities (
    _id TEXT PRIMARY KEY,
    "targetUserId" TEXT,
    "actorUserId" TEXT,
    "actorUrl" TEXT,
    type TEXT,
    "activityId" TEXT,
    "noteId" TEXT,
    activity JSONB NOT NULL DEFAULT '{}',
    processed BOOLEAN NOT NULL DEFAULT FALSE,
    "processedAt" BIGINT,
    "claimOwner" TEXT,
    "claimUntil" BIGINT,
    attempts INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "publishedAt" BIGINT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_actor ON ap_activities("actorUserId")`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_target ON ap_activities("targetUserId", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_type ON ap_activities(type)`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_activity_id ON ap_activities("activityId") WHERE "activityId" IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_activities_inbound_unique
     ON ap_activities("targetUserId", "actorUrl", "activityId")
     WHERE "targetUserId" IS NOT NULL AND "actorUrl" IS NOT NULL AND "activityId" IS NOT NULL`,
  `CREATE INDEX IF NOT EXISTS idx_ap_activities_claim
     ON ap_activities(processed, "claimUntil") WHERE processed = FALSE`,

  `CREATE TABLE IF NOT EXISTS ap_messages (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT NOT NULL,
    "channelId" TEXT,
    content TEXT NOT NULL DEFAULT '',
    "apId" TEXT UNIQUE,
    "targetUserId" TEXT,
    summary TEXT,
    sensitive BOOLEAN NOT NULL DEFAULT FALSE,
    "inReplyTo" TEXT,
    attachments JSONB NOT NULL DEFAULT '[]',
    tags JSONB NOT NULL DEFAULT '[]',
    published BIGINT,
    "updatedAt" BIGINT,
    visibility TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_actor ON ap_messages("actorUrl")`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_published ON ap_messages(published DESC NULLS LAST)`,
  `CREATE INDEX IF NOT EXISTS idx_ap_messages_visibility_actor ON ap_messages(visibility, "actorUrl", published DESC NULLS LAST)`,

  `CREATE TABLE IF NOT EXISTS ap_outgoing_follows (
    _id TEXT PRIMARY KEY,
    "fromUserId" TEXT NOT NULL,
    "targetActorUrl" TEXT NOT NULL,
    "activityId" TEXT,
    accepted BOOLEAN NOT NULL DEFAULT FALSE,
    "acceptedAt" BIGINT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_outfollows_user ON ap_outgoing_follows("fromUserId")`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_ap_outfollows_unique ON ap_outgoing_follows("fromUserId", "targetActorUrl")`,

  `CREATE TABLE IF NOT EXISTS ap_likes (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT,
    "fromUserId" TEXT,
    "activityId" TEXT,
    "objectUrl" TEXT NOT NULL,
    "targetUserId" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_likes_object ON ap_likes("objectUrl")`,
  `ALTER TABLE ap_likes ADD COLUMN IF NOT EXISTS "activityId" TEXT`,
  `DROP INDEX IF EXISTS idx_ap_likes_activity_id`,
  `CREATE INDEX IF NOT EXISTS idx_ap_likes_activity_actor_target ON ap_likes("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS ap_announces (
    _id TEXT PRIMARY KEY,
    "actorUrl" TEXT,
    "fromUserId" TEXT,
    "activityId" TEXT,
    "objectUrl" TEXT NOT NULL,
    "targetUserId" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ap_announces_object ON ap_announces("objectUrl")`,
  `ALTER TABLE ap_announces ADD COLUMN IF NOT EXISTS "activityId" TEXT`,
  `DROP INDEX IF EXISTS idx_ap_announces_activity_id`,
  `CREATE INDEX IF NOT EXISTS idx_ap_announces_activity_actor_target ON ap_announces("actorUrl", "activityId", "targetUserId") WHERE "activityId" IS NOT NULL`,

  `CREATE TABLE IF NOT EXISTS notifications (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    type TEXT NOT NULL,
    "actorUrl" TEXT,
    "activityId" TEXT,
    "noteId" TEXT,
    "noteUrl" TEXT,
    "dmId" TEXT,
    "serverId" TEXT,
    "channelId" TEXT,
    "messageId" TEXT,
    "actorId" TEXT,
    read BOOLEAN NOT NULL DEFAULT FALSE,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications("userId", "createdAt" DESC)`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "serverId" TEXT`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "channelId" TEXT`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "messageId" TEXT`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "actorId" TEXT`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "activityId" TEXT`,
  `ALTER TABLE notifications ADD COLUMN IF NOT EXISTS "dmId" TEXT`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_activity ON notifications("activityId") WHERE "activityId" IS NOT NULL`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_inbox_message ON notifications("userId", "messageId") WHERE "messageId" IS NOT NULL AND type IN ('mention', 'reply', 'watch')`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_inbox_unread ON notifications("userId", read, "createdAt" DESC) WHERE type IN ('mention', 'reply', 'watch')`,
  `CREATE INDEX IF NOT EXISTS idx_notifications_inbox_channel ON notifications("userId", "channelId", read) WHERE "channelId" IS NOT NULL AND type IN ('mention', 'reply', 'watch')`,

  `CREATE TABLE IF NOT EXISTS webauthn_credentials (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL UNIQUE,
    "publicKey" TEXT NOT NULL,
    counter BIGINT NOT NULL DEFAULT 0 CONSTRAINT webauthn_counter_uint32 CHECK (counter BETWEEN 0 AND 4294967295),
    "deviceType" TEXT NOT NULL DEFAULT 'unknown',
    transports JSONB NOT NULL DEFAULT '[]',
    name TEXT NOT NULL DEFAULT 'Passkey',
    "lastUsedAt" BIGINT,
    "createdAt" BIGINT NOT NULL
  )`,
  `DO $$ BEGIN
     IF EXISTS (SELECT 1 FROM webauthn_credentials WHERE counter IS NULL OR counter < 0 OR counter > 4294967295) THEN
       RAISE EXCEPTION '057: invalid persisted WebAuthn counter; repair explicitly before migration';
     END IF;
   END $$`,
  `ALTER TABLE webauthn_credentials ALTER COLUMN counter TYPE BIGINT USING counter::bigint`,
  `ALTER TABLE webauthn_credentials ALTER COLUMN counter SET DEFAULT 0`,
  `ALTER TABLE webauthn_credentials ALTER COLUMN counter SET NOT NULL`,
  `ALTER TABLE webauthn_credentials DROP CONSTRAINT IF EXISTS webauthn_counter_uint32`,
  `ALTER TABLE webauthn_credentials ADD CONSTRAINT webauthn_counter_uint32 CHECK (counter BETWEEN 0 AND 4294967295)`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_user ON webauthn_credentials("userId")`,
  `CREATE INDEX IF NOT EXISTS idx_webauthn_cred ON webauthn_credentials("credentialId")`,

  `CREATE TABLE IF NOT EXISTS link_preview_cache (
    url TEXT PRIMARY KEY,
    data JSONB NOT NULL,
    "fetchedAt" BIGINT NOT NULL,
    "expiresAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_lpcache_expires ON link_preview_cache("expiresAt")`,

  `CREATE TABLE IF NOT EXISTS federation_whitelist (
    _id TEXT PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS federation_blacklist (
    _id TEXT PRIMARY KEY,
    domain TEXT UNIQUE NOT NULL,
    reason TEXT NOT NULL DEFAULT '',
    "createdAt" BIGINT NOT NULL
  )`,

  `CREATE TABLE IF NOT EXISTS ap_delivery_queue (
    _id TEXT PRIMARY KEY,
    payload JSONB NOT NULL DEFAULT '{}',
    attempts INTEGER NOT NULL DEFAULT 0,
    "nextAt" BIGINT NOT NULL,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_apqueue_nextat ON ap_delivery_queue("nextAt")`,
  `ALTER TABLE ap_delivery_queue ADD COLUMN IF NOT EXISTS "claimOwner" TEXT`,
  `ALTER TABLE ap_delivery_queue ADD COLUMN IF NOT EXISTS "claimUntil" BIGINT`,
  `CREATE INDEX IF NOT EXISTS idx_apqueue_claim_due ON ap_delivery_queue("nextAt", "claimUntil")`,

  // Announcement follows + durable/idempotent crosspost persistence.
  `CREATE TABLE IF NOT EXISTS channel_follows (
    _id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "sourceChannelId" TEXT NOT NULL,
    "sourceServerId" TEXT NOT NULL,
    "targetChannelId" TEXT NOT NULL,
    "targetServerId" TEXT NOT NULL,
    "followedAt" BIGINT NOT NULL DEFAULT EXTRACT(EPOCH FROM NOW())::BIGINT * 1000,
    "followedByUserId" TEXT NOT NULL,
    UNIQUE("sourceChannelId","targetChannelId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_channel_follows_source ON channel_follows("sourceChannelId")`,
  `CREATE INDEX IF NOT EXISTS idx_channel_follows_target ON channel_follows("targetChannelId")`,
  `CREATE TABLE IF NOT EXISTS crosspost_log (
    _id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    "messageId" TEXT NOT NULL,
    "sourceChannelId" TEXT NOT NULL,
    "sourceServerId" TEXT NOT NULL,
    "targetChannelId" TEXT NOT NULL,
    "targetServerId" TEXT NOT NULL,
    "bridgeMessageId" TEXT NOT NULL UNIQUE,
    "crosspostedAt" BIGINT NOT NULL,
    UNIQUE("messageId","targetChannelId")
  )`,
  `CREATE INDEX IF NOT EXISTS idx_crosspost_log_source ON crosspost_log("messageId","sourceChannelId")`,
  `CREATE INDEX IF NOT EXISTS idx_crosspost_log_target ON crosspost_log("targetChannelId","crosspostedAt" DESC)`,

  `CREATE TABLE IF NOT EXISTS podcast_settings (
    _id TEXT PRIMARY KEY,
    "channelId" TEXT,
    "serverId" TEXT,
    title TEXT,
    description TEXT,
    author TEXT,
    "imageUrl" TEXT,
    "coverUrl" TEXT,
    language TEXT NOT NULL DEFAULT 'tr',
    category TEXT NOT NULL DEFAULT 'Technology',
    explicit BOOLEAN NOT NULL DEFAULT FALSE,
    enabled BOOLEAN NOT NULL DEFAULT TRUE,
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  `CREATE TABLE IF NOT EXISTS podcast_episodes (
    _id TEXT PRIMARY KEY,
    "channelId" TEXT,
    "serverId" TEXT,
    title TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '',
    filename TEXT,
    "audioUrl" TEXT,
    "mimeType" TEXT NOT NULL DEFAULT 'audio/mpeg',
    "fileSize" BIGINT NOT NULL DEFAULT 0,
    "durationSeconds" INTEGER,
    season INTEGER,
    episode INTEGER,
    published BOOLEAN NOT NULL DEFAULT TRUE,
    "publishedAt" BIGINT,
    "createdBy" TEXT,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_podcast_episodes_channel ON podcast_episodes("channelId", "createdAt" DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_podcast_episodes_published ON podcast_episodes("channelId", published, "publishedAt" DESC)`,

  `CREATE TABLE IF NOT EXISTS server_templates (
    _id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "isBuiltin" BOOLEAN NOT NULL DEFAULT FALSE,
    config JSONB NOT NULL DEFAULT '{}',
    "createdAt" BIGINT NOT NULL,
    "updatedAt" BIGINT
  )`,
  // Sprint 83: Bot Marketplace tabloları
  ...BOT_MARKETPLACE_TABLES,
  `ALTER TABLE bot_marketplace ADD COLUMN IF NOT EXISTS "executableBotId" TEXT`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'bot_marketplace_executable_bot_fk') THEN
       ALTER TABLE bot_marketplace ADD CONSTRAINT bot_marketplace_executable_bot_fk
         FOREIGN KEY ("executableBotId") REFERENCES bots(_id) ON DELETE SET NULL;
     END IF;
   END $$`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_bot_marketplace_executable ON bot_marketplace("executableBotId") WHERE "executableBotId" IS NOT NULL`,

  // ── Sticker paketleri (migrations_pg/021 ve schema.ts ile aynı) ──────────
  // Mevcut üretim DB'lerine yükseltme yolu. schema.ts taze kurulumu, bu blok
  // yükseltmeyi, 021 ise yapısal kaydı sağlar — üçü senkron kalmalıdır.
  `CREATE TABLE IF NOT EXISTS sticker_packs (
    _id TEXT PRIMARY KEY,
    "serverId" TEXT NOT NULL,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    "authorId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL,
    seq BIGSERIAL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sticker_packs_server ON sticker_packs("serverId", seq)`,

  `CREATE TABLE IF NOT EXISTS sticker_pack_items (
    _id TEXT PRIMARY KEY,
    "packId" TEXT NOT NULL REFERENCES sticker_packs(_id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    tags JSONB NOT NULL DEFAULT '[]',
    width INTEGER NOT NULL DEFAULT 160,
    height INTEGER NOT NULL DEFAULT 160,
    position INTEGER NOT NULL DEFAULT 0,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sticker_items_pack ON sticker_pack_items("packId", position)`,

  // Personal Saved / Follow-up. Identifiers only; API re-authorizes metadata.
  `CREATE TABLE IF NOT EXISTS saved_messages (
    _id TEXT PRIMARY KEY,
    "userId" TEXT NOT NULL,
    "destinationType" TEXT NOT NULL CHECK ("destinationType" IN ('channel', 'dm', 'gdm')),
    "destinationId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "createdAt" BIGINT NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_messages_owner_target ON saved_messages("userId", "destinationType", "messageId")`,
  `CREATE INDEX IF NOT EXISTS idx_saved_messages_owner_created ON saved_messages("userId", "createdAt" DESC, _id DESC)`,
];


// ════════════════════════════════════════════════════════════════════════════
// KULLANICI REFERANS BUTUNLUGU — YALNIZCA "SILINIR" SINIFI
// ════════════════════════════════════════════════════════════════════════════
// Olculdu: canli semada kullaniciya isaret eden 59 sutun var ama `users`
// tablosuna giden yalnizca 1 yabanci anahtar vardi. Yani veritabani
// seviyesinde isleyen bir CASCADE yoktu ve hesap silmenin dogrulugu tamamen
// uygulama katmanindaki politika tablosuna (lib/accountLifecycle.ts)
// bagliydi.
//
// ── NEDEN 59'UN TAMAMINA FK EKLENMEDI ──────────────────────────────────────
// Politika, paylasilan icerigi (mesajlar, DM'ler, sunucu varliklari) SILMEZ;
// kimlik bagini koparip `deleted-user` MEZAR TASINA cevirir. O deger gercek
// bir `users` satiri DEGILDIR. Bu sutunlara FK eklemek anonimlestirmeyi
// KIRARDI: ya silme basarisiz olur ya da paylasilan sohbet gecmisi
// baskalarinin gozunden de silinirdi.
//
// Ayni sekilde `audit_logs` KORUNUR (moderasyon izi), yani CASCADE yanlis
// olurdu.
//
// ── EKLENEN KUME ───────────────────────────────────────────────────────────
// Yalnizca politikada "DELETE" olarak siniflandirilmis, yani "kullanici
// varken var olan" satirlar. Bunlarda `ON DELETE CASCADE` hem semantik
// olarak dogrudur hem de politika bir tabloyu atlarsa DERINLEMESINE SAVUNMA
// saglar: hayalet erisim haklari ve yetim sirlar veritabani seviyesinde de
// engellenir.
//
// GUVENLIK: uygulanmadan once yetim satir sayisi olculdu — hepsi 0. Yine de
// her ifade `runMigrationList` tarafindan tek tek ve hata toleransli
// calistirilir; yetim veri bulunan bir kurulumda ilgili FK sessizce atlanir
// ve digerleri uygulanir.
const USER_FK_MIGRATIONS: string[] = [
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_refresh_tokens_user') THEN
       ALTER TABLE refresh_tokens ADD CONSTRAINT fk_refresh_tokens_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_oauth_tokens_user') THEN
       ALTER TABLE oauth_tokens ADD CONSTRAINT fk_oauth_tokens_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_webauthn_credentials_user') THEN
       ALTER TABLE webauthn_credentials ADD CONSTRAINT fk_webauthn_credentials_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_push_subscriptions_user') THEN
       ALTER TABLE push_subscriptions ADD CONSTRAINT fk_push_subscriptions_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_native_push_tokens_user') THEN
       ALTER TABLE native_push_tokens ADD CONSTRAINT fk_native_push_tokens_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_fcm_tokens_user') THEN
       ALTER TABLE fcm_tokens ADD CONSTRAINT fk_fcm_tokens_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_notification_prefs_user') THEN
       ALTER TABLE notification_prefs ADD CONSTRAINT fk_notification_prefs_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_unread_counts_user') THEN
       ALTER TABLE unread_counts ADD CONSTRAINT fk_unread_counts_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_saved_messages_user') THEN
       ALTER TABLE saved_messages ADD CONSTRAINT fk_saved_messages_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_onboarding_completions_user') THEN
       ALTER TABLE onboarding_completions ADD CONSTRAINT fk_onboarding_completions_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (
       SELECT 1
         FROM pg_constraint con
         JOIN pg_class rel ON rel.oid = con.conrelid
         JOIN pg_class ref ON ref.oid = con.confrelid
        WHERE con.contype = 'f'
          AND rel.relname = 'user_badges'
          AND ref.relname = 'users'
          AND pg_get_constraintdef(con.oid) LIKE 'FOREIGN KEY ("userId")%'
     ) THEN
       ALTER TABLE user_badges ADD CONSTRAINT fk_user_badges_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_user_connections_user') THEN
       ALTER TABLE user_connections ADD CONSTRAINT fk_user_connections_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_members_user') THEN
       ALTER TABLE members ADD CONSTRAINT fk_members_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_group_dm_members_user') THEN
       ALTER TABLE group_dm_members ADD CONSTRAINT fk_group_dm_members_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_friendships_user') THEN
       ALTER TABLE friendships ADD CONSTRAINT fk_friendships_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_friendships_friend') THEN
       ALTER TABLE friendships ADD CONSTRAINT fk_friendships_friend
         FOREIGN KEY ("friendId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blocks_blocker') THEN
       ALTER TABLE blocks ADD CONSTRAINT fk_blocks_blocker
         FOREIGN KEY ("blockerId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_blocks_blocked') THEN
       ALTER TABLE blocks ADD CONSTRAINT fk_blocks_blocked
         FOREIGN KEY ("blockedId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_server_boosts_user') THEN
       ALTER TABLE server_boosts ADD CONSTRAINT fk_server_boosts_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_bot_ratings_user') THEN
       ALTER TABLE bot_ratings ADD CONSTRAINT fk_bot_ratings_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
  `DO $$ BEGIN
     IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_scheduled_msgs_user') THEN
       ALTER TABLE scheduled_msgs ADD CONSTRAINT fk_scheduled_msgs_user
         FOREIGN KEY ("userId") REFERENCES users(_id) ON DELETE CASCADE;
     END IF;
   END $$;`,
];

// ── RUNNER ───────────────────────────────────────────────────
/**
 * ════════════════════════════════════════════════════════════════════════════
 * HATA BASTIRMA DAR OLMALIDIR — GENİŞ BASTIRMA P0 SAKLAR
 * ════════════════════════════════════════════════════════════════════════════
 * Bu fonksiyon eskiden mesajı `'already exists'` VEYA `'does not exist'` içeren
 * HER hatayı SESSİZCE yutuyordu. İlk kalıp meşru: bu liste idempotent DDL
 * içerir (`ADD COLUMN IF NOT EXISTS` vb.) ve "zaten var" beklenen durumdur.
 *
 * İkinci kalıp ise ÇOK GENİŞTİ. `does not exist` şunların HEPSİYLE eşleşir:
 *
 *   column "subscription" does not exist          ← beklenen (legacy backfill)
 *   relation "x" does not exist                   ← GERÇEK kusur
 *   type "vector" does not exist                  ← eksik uzantı
 *   function jsonb_object_length(jsonb) does not exist   ← GERÇEK kusur
 *
 * Son satır kurgusal değil: 2026-08-28 incelemesinde tam olarak bu imzaya sahip
 * bir P0 bulundu (`MessageRepository.toggleReactionAtomic`, var olmayan
 * fonksiyon). Başlangıç migrasyon listesine benzer bir ifade eklenseydi
 * TAMAMEN SESSİZ kalırdı — ne log, ne uyarı, ne başarısızlık.
 *
 * Yeni sınıflandırma:
 *   · `already exists`                → sessiz (idempotent, beklenen)
 *   · eksik KOLON/TABLO               → info + SQL (taze kurulumda legacy
 *                                        backfill'ler için normaldir, ama
 *                                        GÖRÜNÜR olmalıdır)
 *   · eksik FONKSİYON/TİP veya diğer  → error + SQL (bu asla beklenmez)
 */
function classifyMigrationError(msg: string): 'expected' | 'legacy' | 'defect' {
  if (msg.includes('already exists')) return 'expected';
  // Eksik fonksiyon/tip bir KODLAMA hatasıdır; şema durumuna bağlı değildir.
  if (/function .* does not exist/i.test(msg)) return 'defect';
  if (/type .* does not exist/i.test(msg)) return 'defect';
  // Eksik kolon/tablo taze kurulumda legacy dönüşümler için beklenebilir.
  if (/(column|relation) .* does not exist/i.test(msg)) return 'legacy';
  return 'defect';
}

async function runMigrationList(pool: Pool, sqls: string[], label: string): Promise<void> {
  for (const sql of sqls) {
    try {
      await pool.query(sql);
    } catch (e) {
      const msg = (e as Error).message;
      const kind = classifyMigrationError(msg);
      if (kind === 'expected') continue;

      const statement = sql.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (kind === 'legacy') {
        logger.info(
          { event: 'db.migration.skipped_legacy', label, statement },
          `[DB] ${label}: legacy dönüşüm atlandı — ${msg.slice(0, 160)}`,
        );
      } else {
        logger.error(
          { event: 'db.migration.failed', label, statement },
          `[DB] ${label} BAŞARISIZ — ${msg.slice(0, 160)}`,
        );
        // A coding/schema defect must abort startup. Continuing would let the
        // process announce `Schema hazır` while production queries target a
        // partially-migrated database. Only explicitly-classified legacy
        // column/relation drift remains best-effort above.
        throw e;
      }
    }
  }
}

export async function runInlineMigrations(pool: Pool): Promise<void> {
  await runMigrationList(pool, COLUMN_MIGRATIONS, 'column-migration');
  await runMigrationList(pool, EXTRA_TABLES, 'extra-table');
  // P5 FED-01: COLUMN_MIGRATIONS also alters tables that EXTRA_TABLES creates
  // (ap_follows "accepted"/"actorInbox", the messages FTS index). On a fresh
  // database those statements ran before the tables existed, were skipped as
  // "legacy", and the first boot served without them: every inbound
  // ActivityPub Follow failed with 500 until the process happened to restart.
  // The list is idempotent (IF NOT EXISTS), so a second pass makes the first
  // boot's schema identical to every later boot's.
  await runMigrationList(pool, COLUMN_MIGRATIONS, 'column-migration');
  // FK'ler EN SON: hedef tablolarin var oldugundan emin olunur.
  await runMigrationList(pool, USER_FK_MIGRATIONS, 'user-fk');
}
