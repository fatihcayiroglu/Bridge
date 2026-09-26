
/**
 * Bridge — Temel varlik tipleri
 * server/db/repositories/types/entities.d.ts
 *
 * Tum repository'lerde ortak olarak kullanilan entity şemalari.
 * Derleme zamani tip guvencesi sağlar — runtime davranişi değişmez.
 *
 * Kullanim:
 *   import type { User, Server, Message } from './types/entities';
 */

// ─────────────────────────────────────────────────────────────
// Yardimci tipler
// ─────────────────────────────────────────────────────────────

/** Unix ms timestamp */
export type Timestamp = number;

/** UUID v4 string */
export type UUID = string;

/** Kullanici cevrimici durumu */
export type UserStatus = 'online' | 'idle' | 'dnd' | 'offline';

/** Arkadaşlik isteği durumu */
export type FriendshipStatus = 'pending' | 'accepted' | 'declined';

/** Hata raporu turu */
export type ClientErrorType = 'uncaught' | 'unhandledrejection' | 'resource' | 'manual' | 'crash';

// ─────────────────────────────────────────────────────────────
// Kullanici
// ─────────────────────────────────────────────────────────────

export interface User {
  _id: UUID;
  id: UUID;
  username: string;
  displayName: string;
  email?: string;
  passwordHash?: string;
  emailToken?: string;
  emailVerified?: boolean;
  avatarUrl?: string | null;
  avatarColor: string;
  bannerColor?: string;
  bannerUrl?: string | null;
  statusText?: string;
  statusEmoji?: string;
  status?: UserStatus;
  presenceVisibility?: 'visible' | 'hidden';
  activity?: Record<string, unknown> | string | null;
  activityUpdatedAt?: Timestamp | null;
  ssoProvider?: string | null;
  ssoIssuer?: string | null;
  ssoId?: string | null;
  password?: string;
  apUrl?: string | null;
  bio?: string;
  website?: string;
  location?: string;
  pronouns?: string;
  /**
   * Sema: `users."isAdmin" BOOLEAN NOT NULL DEFAULT FALSE`; `pg` surucusu
   * GERCEK boolean dondurur.
   *
   * Tip bir zamanlar `0 | 1` idi (okuma yollari `=== true` yaptigi icin
   * typecheck kirmiziydi), sonra gecici olarak `boolean | 0 | 1` birlesimi
   * oldu. Yazma yollari da gercek boolean'a gecirildikten sonra birlesim
   * GEREKSIZ hale geldi ve kaldirildi: auth/yonetici kodunda tip belirsizligi
   * birakmak, `Users.count({ isAdmin: ... })` gibi YETKI KAPILARINDA sessiz
   * uyumsuzluk riski demektir.
   */
  isAdmin?: boolean;
  tokenVersion?: number;
  emailTokenExp?: Timestamp;
  twoFactorEnabled?: boolean | 0 | 1;
  twoFactorSecret?: string | null;
  twoFactorBackup?: string | string[] | null;
  /**
   * TOTP tekrar-kullanim korumasi: en son kabul edilen zaman adimi.
   *
   * Sema (`schema.ts:65`), gecis (`migrations.ts:225`), sanitize izin
   * listesi (`pgCollection.ts:77`) ve `UserRepository.markTwoFactorStep`
   * bu alani KULLANIYORDU; yalnizca varlik tipinde eksikti.
   */
  twoFactorLastUsedStep?: number | null;
  webauthnCredentials?: WebAuthnCredential[] | null;
  webauthnEnabled?: boolean | 0 | 1;
  timeoutUntil?: Timestamp | null;
  e2ePublicKey?: string | null;
  e2eKeyVersion?: number;
  e2eAlgorithm?: string;
  e2eKeyUpdatedAt?: Timestamp | null;
  x3dhIdentityKey?: string | null;
  x3dhSignedPreKey?: { keyId: number; publicKey: string; signature: string } | null;
  x3dhOneTimePreKeys?: Array<{ keyId: number; publicKey: string }> | null;
  x3dhUpdatedAt?: Timestamp | null;
  apPublicKey?: string | null;
  apPrivateKey?: string | null;
  dmPrivacy?: string;
  badge?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Sunucu (Guild)
// ─────────────────────────────────────────────────────────────

export interface Server {
  _id: UUID;
  name?: string;
  ownerId: UUID;
  icon?: string | null;
  banner?: string | null;
  iconUrl?: string | null;
  bannerUrl?: string | null;
  description?: string;
  /**
   * Vanity/profil kısa adı. VERİTABANI KOLON ADI BUDUR.
   * Bu tip önceden var olmayan bir `slug` alanı ilan ediyordu; kod da ona
   * göre sorgu kuruyor ve PostgreSQL "Unknown column: slug" ile 500
   * döndürüyordu. API sözleşmesinde alan adı hâlâ `slug`tur — yalnız
   * depolama adı `vanityUrl`dir.
   */
  vanityUrl?: string;
  featured?: boolean;
  featuredAt?: Timestamp | null;
  ssoConfig?: Record<string, unknown> | string | null;
  isPublic?: boolean;
  color?: string;
  mfaLevel?: number;
  discoverable?: boolean | 0 | 1;
  general?: UUID | null;
  logChannelId?: UUID | null;
  region?: string;
  tags?: string | string[];
  createdAt: Timestamp;
}

export interface Member {
  _id?: UUID;
  userId: UUID;
  /** Client-generated idempotency key, unique only within this user. */
  ackId?: string | null;
  serverId: UUID;
  /** JSON string: string[] */
  roles?: string | string[];
  nickname?: string;
  joinedAt: Timestamp;
  timeoutUntil?: Timestamp | null;
  deaf?: boolean;
  mute?: boolean;
  permissions?: Record<string, boolean> | string | null;
  isOwner?: boolean;
  displayName?: string;
  avatarUrl?: string | null;
  banned?: boolean;
  serverProfile?: Record<string, unknown> | null;
}

// ─────────────────────────────────────────────────────────────
// Kanal
// ─────────────────────────────────────────────────────────────

export type ChannelType =
  | 'text'
  | 'voice'
  | 'announcement'
  | 'stage'
  | 'forum'
  | 'dm'
  | 'gdm';

export interface Channel {
  _id: UUID;
  serverId: UUID;
  name: string;
  type?: ChannelType;
  topic?: string;
  categoryId?: UUID | null;
  order?: number;
  isNsfw?: boolean;
  slowmode?: number;
  tags?: string | string[];
  forumTags?: Array<{ id?: string; name?: string; color?: string }> | string;
  modOnly?: boolean;
  createdAt: Timestamp;
}

export interface ChannelCategory {
  _id: UUID;
  serverId: UUID;
  name: string;
  position?: number;
  createdAt: Timestamp;
}

export interface ChannelOverride {
  channelId: UUID;
  /** Rol ID'si veya kullanici ID'si */
  targetId: UUID;
  targetType: 'role' | 'user';
  allow?: number;
  deny?: number;
}

// ─────────────────────────────────────────────────────────────
// Mesaj
// ─────────────────────────────────────────────────────────────

export interface Message {
  _id: UUID;
  channelId: UUID;
  serverId: UUID;
  userId: UUID;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  content?: string;
  /** 0/absent = LEGACY (sanitized, entity-encoded), 1 = RAW typed text. Final21 Phase 16, lib/storedText.ts. */
  contentFormat?: 0 | 1;
  attachments?: string; // JSON string: Attachment[]
  embeds?: string | null;      // JSON string: Embed[]
  pinned?: 0 | 1;
  edited?: boolean;
  editHistory?: string | Record<string, unknown>[];
  type?: string;
  sticker?: { id: string; packId: string; name: string; url: string; width: number; height: number } | null;
  threadId?: UUID | null;
  threadCount?: number;
  transcript?: string | null;
  webhookId?: UUID | null;
  isWebhook?: boolean;
  flaggedMsgId?: UUID | null;
  reactions?: string;   // JSON string: Reaction[]
  superReactions?: Record<string, number>; // JSONB emoji → burst count
  /**
   * Yanıt anlık görüntüsü (JSONB kolon). Gönderim anında kopyalanır;
   * `deleted` orijinal mesaj silindiğinde işaretlenir (lib/deleteMessageCascade.ts).
   */
  replyTo?: { _id?: UUID; displayName?: string; content?: string; contentFormat?: 0 | 1; deleted?: boolean } | null;
  createdAt: Timestamp;
  editedAt?: Timestamp | null;
  deletedAt?: Timestamp | null;
}

export interface Attachment {
  url: string;
  name?: string;
  size?: number;
  type?: string;
  width?: number | null;
  height?: number | null;
}

// ─────────────────────────────────────────────────────────────
// DM
// ─────────────────────────────────────────────────────────────

export interface DmConversation {
  _id: UUID;
  participants: UUID[];
  lastMessageAt: Timestamp;
  readAt?: Record<string, Timestamp>;
  createdAt: Timestamp;
}

export interface DmMessage {
  _id: UUID;
  dmId: UUID;
  userId: UUID;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  content?: string;
  attachments?: string;
  edited?: boolean;
  reactions?: Record<string, unknown> | string;
  senderId?: UUID;
  apId?: string;
  clientNonce?: string;
  e2e?: boolean;
  type?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Grup DM
// ─────────────────────────────────────────────────────────────

export interface GroupDm {
  _id: UUID;
  /** API display alias; canonical DB column is `username`. */
  name?: string;
  ownerId: UUID;
  participants?: UUID[];
  icon?: string | null;
  lastMessageAt?: Timestamp;
  createdAt: Timestamp;
}

export interface GroupDmMessage {
  _id: UUID;
  groupId: UUID;
  userId: UUID;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  content?: string;
  attachments?: string;
  edited?: boolean;
  clientNonce?: string;
  type?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Rol
// ─────────────────────────────────────────────────────────────

export interface Role {
  _id: UUID;
  serverId: UUID;
  name: string;
  color?: string;
  position?: number;
  permissions?: number;
  hoist?: boolean;
  /** Presentation only; never participates in permission resolution. */
  displayOnProfile?: boolean;
  mentionable?: boolean;
  icon?: string | null;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Davet
// ─────────────────────────────────────────────────────────────

export interface Invite {
  _id: UUID;
  code: string;
  serverId: UUID;
  createdBy: UUID;
  expiresAt: Timestamp;
  maxUses: number;
  uses: number;
}

// ─────────────────────────────────────────────────────────────
// Thread
// ─────────────────────────────────────────────────────────────

export interface Thread {
  _id: UUID;
  serverId: UUID;
  channelId: UUID;
  parentMessageId?: UUID | null;
  name: string;
  ownerId?: UUID;
  createdBy?: UUID;
  firstMessage?: string;
  tags?: string | string[];
  participantCount?: number;
  messageCount: number;
  lastMessageAt?: Timestamp;
  pinned?: 0 | 1;
  locked?: 0 | 1;
  createdAt: Timestamp;
}

export interface ThreadMessage {
  _id: UUID;
  threadId: UUID;
  channelId?: UUID;
  serverId?: UUID;
  userId: UUID;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  content?: string;
  attachments?: string;
  edited?: boolean;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Bot
// ─────────────────────────────────────────────────────────────

export interface Bot {
  _id: UUID;
  /** API display alias; canonical DB column is `username`. */
  name?: string;
  ownerId: UUID;
  token?: string;
  tokenHash?: string;
  serverId?: UUID;
  username?: string;
  avatarUrl?: string | null;
  description?: string;
  slug?: string;
  isPublic?: boolean;
  color?: string;
  mfaLevel?: number;
  /** Hangi sunucularda yuklu — JSON string: UUID[] */
  servers?: string | string[];
  rating?: number;
  ratingCount?: number;
  public?: boolean;
  active?: boolean;
  channelId?: UUID;
  contextCommands?: unknown[] | string;
  slashCommands?: unknown[] | string;
  webhookUrl?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Automod
// ─────────────────────────────────────────────────────────────

export interface AutomodRule {
  _id: UUID;
  serverId: UUID;
  type: string;
  enabled: boolean;
  /** PostgreSQL JSONB object; string is retained only for legacy/mock compatibility. */
  config: Record<string, unknown> | string;
  createdBy: UUID;
  createdAt: Timestamp;
  updatedAt?: Timestamp | null;
}

// ─────────────────────────────────────────────────────────────
// Reaction Role
// ─────────────────────────────────────────────────────────────

export interface ReactionRole {
  _id: UUID;
  serverId: UUID;
  channelId: UUID;
  messageId: UUID;
  emoji: string;
  roleId: UUID;
  count?: number;
  /**
   * Kurali OLUSTURAN kullanici. Sema'da `reaction_roles."createdBy" TEXT NOT
   * NULL` olarak VARDI ama bu arayuzde EKSIKTI.
   *
   * `socket/handlers/messages-edit.ts` calisma aninda kural sahibinin rol
   * hiyerarsisini YENIDEN dogrulamak icin bu alani okur (sonradan yetkisi
   * alinmis bir moderatorun kurali rol dagitmaya devam etmesin diye). Alan
   * tipte olmadigi icin dosya derlenmiyordu; `npm run typecheck` boylece
   * KIRMIZI kaliyor ve gercek hatalari (bkz. `joinGeneration`) gizliyordu.
   *
   * Eski satirlar icin opsiyonel: `?? ''` ile fail-closed degerlendirilir.
   */
  createdBy?: UUID;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Zamanlanmiş Mesaj
// ─────────────────────────────────────────────────────────────

export interface ScheduledMessage {
  _id: UUID;
  channelId: UUID;
  serverId: UUID;
  userId: UUID;
  content: string;
  sendAt: Timestamp;
  sent?: boolean;
  sentAt?: Timestamp;
  claimOwner?: string | null;
  claimUntil?: Timestamp | null;
  dispatchAttempts?: number;
  lastError?: string | null;
  failedAt?: Timestamp | null;
  failureReason?: string | null;
  cancelledAt?: Timestamp | null;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  transcript?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Bildirim
// ─────────────────────────────────────────────────────────────

export interface NativeToken {
  _id: UUID;
  userId: UUID;
  token?: string;
  tokenHash?: string;
  serverId?: UUID;
  username?: string;
  platform: 'ios' | 'android';
  createdAt: Timestamp;
}

export interface NotificationPref {
  _id?: UUID;
  userId: UUID;
  channelId?: UUID;
  serverId?: UUID;
  muted?: boolean;
  mentions?: boolean;
  level?: string;
  muteUntil?: Timestamp | null;
  updatedAt?: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Sosyal (Arkadaşlik, Blok)
// ─────────────────────────────────────────────────────────────

export interface Friendship {
  _id: UUID;
  userId: UUID;
  friendId: UUID;
  status: FriendshipStatus;
  createdAt: Timestamp;
}

export interface Block {
  _id: UUID;
  blockerId: UUID;
  blockedId: UUID;
  createdAt: Timestamp;
}

export interface UserConnection {
  _id: UUID;
  userId: UUID;
  platform: string;
  platformId?: string;
  username?: string;
  url?: string;
  accessToken?: string;
  refreshToken?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Sunucu Varliklari (Emoji, GIF, Ses)
// ─────────────────────────────────────────────────────────────

export interface CustomEmoji {
  _id: UUID;
  serverId: UUID;
  name: string;
  url: string;
  animated?: boolean;
  createdBy?: UUID;
  createdAt: Timestamp;
}

export interface ServerGif {
  _id: UUID;
  serverId: UUID;
  url: string;
  name?: string;
  tags?: string | string[];
  createdAt: Timestamp;
}

/**
 * Kalıcı sticker paketi satırı (migrations_pg/021).
 *
 * `seq` DAHİLİdir: belirlenimci ekleme sırası sağlar ve API'ye SIZDIRILMAZ.
 * PostgreSQL BIGINT'i string olarak döndürdüğü için tipi `string | number`.
 */
export interface StickerPackRecord {
  _id: UUID;
  serverId: UUID;
  name: string;
  description: string;
  authorId: UUID;
  createdAt: Timestamp;
  seq?: string | number;
}

/**
 * Kalıcı sticker öğesi satırı (migrations_pg/021).
 *
 * `position` DAHİLİdir: yükleme sırasını korur, API'ye SIZDIRILMAZ.
 * Genel API bu satırı `{ id, packId, name, url, tags, width, height }`
 * olarak yayınlar — `_id` DEĞİL `id`.
 */
export interface StickerPackItemRecord {
  _id: UUID;
  packId: UUID;
  name: string;
  url: string;
  tags: string[];
  width: number;
  height: number;
  position: number;
  createdAt: Timestamp;
}

export interface SoundboardSound {
  _id: UUID;
  serverId: UUID;
  name: string;
  url: string;
  emoji?: string;
  category?: string;
  volume?: number;
  uploadedBy?: UUID;
  durationSeconds?: number;
  mimeType?: string;
  fileSize?: number;
  updatedAt?: Timestamp;
  createdAt: Timestamp;
}

export interface SoundboardUserStat {
  soundId: UUID;
  userId: UUID;
  serverId?: UUID | null;
  favorite: boolean;
  favoritedAt?: Timestamp | null;
  playCount: number;
  lastPlayedAt?: Timestamp | null;
}

// ─────────────────────────────────────────────────────────────
// Auth (Refresh Token, WebAuthn)
// ─────────────────────────────────────────────────────────────

export interface RefreshToken {
  _id: UUID;
  userId: UUID;
  token?: string;
  tokenHash?: string;
  serverId?: UUID;
  username?: string;
  expiresAt: Timestamp;
  used?: boolean;
  /** Token rotation family ID */
  family?: UUID;
  /** User tokenVersion at issuance; stale refresh tokens must never mint fresh access tokens. */
  tokenVersion: number;
  createdAt: Timestamp;
}

export interface WebAuthnCredential {
  _id: UUID;
  userId: UUID;
  credentialId: string;
  credId?: string;
  publicKey: string;
  counter?: number;
  signCount?: number;
  name?: string;
  deviceType?: string;
  transports?: string[];
  lastUsedAt?: Timestamp | null;
  aaguid?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Webhook
// ─────────────────────────────────────────────────────────────

export interface OutgoingWebhook {
  _id: UUID;
  serverId: UUID;
  channelId?: UUID;
  url: string;
  name?: string;
  secret?: string;
  lastFiredAt?: Timestamp | null;
  lastStatus?: number | string | null;
  consecutiveFailures?: number;
  lastFailedAt?: Timestamp | null;
  events?: string | string[]; // JSON string veya string[]
  active?: boolean;
  enabled?: boolean;
  label?: string;
  lastError?: string | null;
  createdAt: Timestamp;
}

export interface ChannelWebhook {
  _id: UUID;
  channelId: UUID;
  serverId: UUID;
  name?: string;
  avatarUrl?: string | null;
  token?: string;
  secret?: string | null;
  createdBy?: UUID | null;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Poll
// ─────────────────────────────────────────────────────────────

export interface Poll {
  _id: UUID;
  channelId: UUID;
  serverId: UUID;
  createdBy: UUID;
  question: string;
  options: PollOption[]; // normalize edilmiş seçenekler
  expiresAt?: Timestamp | string | null;
  closed?: boolean;
  multiSelect?: boolean;
  allowVoteChange?: boolean;
  createdAt: Timestamp;
}

export interface PollOption {
  id: string;
  text: string;
  votes: string[];
}

// ─────────────────────────────────────────────────────────────
// Federation (ActivityPub)
// ─────────────────────────────────────────────────────────────

export interface FederationActivity {
  _id: UUID;
  name?: string;
  summary?: string;
  sensitive?: boolean;
  inReplyTo?: string | null;
  tag?: unknown[];
  context?: string;
  type: string;
  actor?: string;
  object?: string;
  serverId?: UUID;
  raw?: string; // JSON string
  activity?: Record<string, unknown> | string;
  activityId?: string | null;
  targetUserId?: UUID | null;
  actorUserId?: UUID | null;
  actorUrl?: string | null;
  processed?: boolean;
  processedAt?: Timestamp | null;
  claimOwner?: string | null;
  claimUntil?: Timestamp | null;
  attempts?: number;
  lastError?: string | null;
  noteId?: string | null;
  activityUpdatedAt?: Timestamp;
  publishedAt?: Timestamp;
  published?: Timestamp | string;
  createdAt: Timestamp;
}

export interface FederationPeer {
  _id: UUID;
  id?: UUID;
  secret?: string;
  domain: string;
  name?: string;
  addedAt?: Timestamp;
  url?: string;
  inboxUrl?: string;
  publicKey?: string;
  verified?: boolean;
  lastSeen?: Timestamp;
  trusted?: boolean;
  blocked?: boolean;
  notes?: string;
  targetActorUrl?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Bridge (Cross-server bağlanti)
// ─────────────────────────────────────────────────────────────

export interface Bridge {
  _id: UUID;
  sourceChannelId: UUID;
  targetChannelId: UUID;
  sourceServerId: UUID;
  targetServerId: UUID;
  active?: boolean;
  enabled?: boolean;
  label?: string;
  lastError?: string | null;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Podcast
// ─────────────────────────────────────────────────────────────

export interface Podcast {
  _id: UUID;
  serverId?: UUID;
  channelId?: UUID;
  title?: string | null;
  description?: string | null;
  feedUrl?: string;
  coverUrl?: string | null;
  author?: string | null;
  imageUrl?: string | null;
  language?: string;
  category?: string;
  explicit?: boolean;
  createdAt: Timestamp;
}

export interface PodcastEpisode {
  _id: UUID;
  channelId: UUID;
  // `podcast_episodes."serverId" TEXT` — NULL OLABILIR (sema:562-565).
  serverId?: UUID | null;
  title: string;
  description?: string | null;
  filename?: string | null;
  audioUrl?: string | null;
  mimeType?: string;
  fileSize?: number;
  durationSeconds?: number | null;
  season?: number | null;
  episode?: number | null;
  published?: boolean;
  publishedAt?: Timestamp | null;
  createdBy?: UUID;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Voice Mesaj
// ─────────────────────────────────────────────────────────────

export interface VoiceMessage {
  _id: UUID;
  channelId: UUID;
  serverId: UUID;
  userId: UUID;
  url: string;
  duration?: number; // saniye
  waveform?: string; // JSON string: number[]
  transcript?: string | null;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Kanal Izinleri
// ─────────────────────────────────────────────────────────────

export interface ChannelPermission {
  _id: UUID;
  roleId?: UUID;
  channelId: UUID;
  targetId: UUID;
  targetType: 'role' | 'user';
  allow?: number;
  deny?: number;
  createdAt: Timestamp;
}
