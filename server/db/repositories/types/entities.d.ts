
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
  activity?: Record<string, unknown> | string | null;
  activityUpdatedAt?: Timestamp | null;
  password?: string;
  apUrl?: string | null;
  bio?: string;
  website?: string;
  location?: string;
  pronouns?: string;
  isAdmin?: 0 | 1;
  tokenVersion?: number;
  emailTokenExp?: Timestamp;
  twoFactorEnabled?: boolean | 0 | 1;
  twoFactorSecret?: string | null;
  twoFactorBackup?: string | string[] | null;
  webauthnCredentials?: WebAuthnCredential[] | null;
  webauthnEnabled?: boolean | 0 | 1;
  timeoutUntil?: Timestamp | null;
  e2ePublicKey?: string | null;
  e2eKeyVersion?: number;
  e2eAlgorithm?: string;
  e2eKeyUpdatedAt?: Timestamp | null;
  x3dhIdentityKey?: string | null;
  x3dhSignedPreKey?: string | null;
  x3dhOneTimePreKeys?: string | string[] | null;
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
  name: string;
  ownerId: UUID;
  icon?: string | null;
  banner?: string | null;
  iconUrl?: string | null;
  bannerUrl?: string | null;
  description?: string;
  slug?: string;
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
  forumTags?: string | string[];
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
  attachments?: string; // JSON string: Attachment[]
  embeds?: string | null;      // JSON string: Embed[]
  pinned?: 0 | 1;
  edited?: boolean;
  editHistory?: string | Record<string, unknown>[];
  type?: string;
  threadId?: UUID | null;
  threadCount?: number;
  reactions?: string;   // JSON string: Reaction[]
  createdAt: Timestamp;
  editedAt?: Timestamp | null;
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
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Grup DM
// ─────────────────────────────────────────────────────────────

export interface GroupDm {
  _id: UUID;
  name: string;
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
  name: string;
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
  webhookId?: string;
  channelId?: UUID;
  contextCommands?: unknown[] | string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Automod
// ─────────────────────────────────────────────────────────────

export interface AutomodRule {
  _id: UUID;
  serverId: UUID;
  type: string;
  trigger?: string;
  action: string;
  enabled?: boolean;
  config?: Record<string, unknown> | string;
  createdAt: Timestamp;
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
  userId: UUID;
  channelId?: UUID;
  serverId?: UUID;
  muted?: boolean;
  mentions?: boolean;
  level?: string;
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

export interface SoundboardSound {
  _id: UUID;
  serverId: UUID;
  name: string;
  url: string;
  emoji?: string;
  volume?: number;
  createdAt: Timestamp;
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
  token?: string;
  createdAt: Timestamp;
}

// ─────────────────────────────────────────────────────────────
// Poll
// ─────────────────────────────────────────────────────────────

export interface Poll {
  _id: UUID;
  createdBy?: UUID;
  channelId: UUID;
  serverId: UUID;
  userId: UUID;
  question: string;
  options: PollOption[]; // normalize edilmiş seçenekler
  votes?: Record<string, string[]> | string;
  expiresAt?: Timestamp | null;
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
  serverId?: UUID;
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
  publishedAt: Timestamp;
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

