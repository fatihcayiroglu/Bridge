
/**
 * Bridge — Repository katmani TypeScript tip bildirimleri
 * server/db/repositories/types/repositories.d.ts
 *
 * Her repository sinifinin metod imzalarini tanimlar.
 * Bu dosya mevcut .js dosyalarini değiştirmez; sadece tip kontrolu ekler.
 *
 * IDE'de otomatik tamamlama ve derleme zamani hata yakalama sağlar.
 *
 * TS Geciş Stratejisi:
 *   Faz 1 (şimdi) : Bu .d.ts dosyasi → JS koduna dokunulmadan tip bilgisi
 *   Faz 2 (sprint) : Kritik repo'lar .ts'ye cevrilir (UserRepository, MessageRepository)
 *   Faz 3 (uzun vade): Tum katman TS'e taşinir
 */

import type {
  User, Server, Member, Channel, ChannelCategory, ChannelOverride,
  Message, DmConversation, DmMessage, GroupDm, GroupDmMessage,
  Role, Invite, Thread, ThreadMessage, Bot, AutomodRule, ReactionRole,
  ScheduledMessage, NativeToken, NotificationPref, Friendship, Block,
  UserConnection, CustomEmoji, ServerGif, SoundboardSound, SoundboardUserStat,
  RefreshToken, WebAuthnCredential, OutgoingWebhook, ChannelWebhook,
  Poll, FederationActivity, FederationPeer, Bridge, Podcast,
  VoiceMessage, ChannelPermission,
  UUID, Timestamp,
} from './entities';

// ─────────────────────────────────────────────────────────────
// Ortak yardimci tipler
// ─────────────────────────────────────────────────────────────

export interface PaginationOptions {
  skip?: number;
  limit?: number;
}

export interface CursorOptions {
  limit?: number;
  before?: Timestamp;
  after?: Timestamp;
}

export interface MessageSearchOptions extends CursorOptions {
  search?: string;
}

// ─────────────────────────────────────────────────────────────
// UserRepository
// ─────────────────────────────────────────────────────────────

export declare class UserRepository {
  findById(id: UUID): Promise<User | null>;
  findByUsername(username: string): Promise<User | null>;
  findByEmail(email: string): Promise<User | null>;
  findByEmailToken(token: string): Promise<User | null>;
  create(data: Partial<User>): Promise<User>;
  update(id: UUID, fields: Partial<User>): Promise<void>;
  updateWhere(filter: Partial<User>, modifier: object): Promise<void>;
  setStatus(id: UUID, status: User['status']): Promise<void>;
  incrementTokenVersion(id: UUID): Promise<void>;
  findByIds(ids: UUID[]): Promise<User[]>;
  findByUsernames(usernames: string[]): Promise<User[]>;
  count(query?: Partial<User>): Promise<number>;
  delete(id: UUID): Promise<void>;
  deleteGraphAtomic(id: UUID, expectedOwnerId?: UUID): Promise<'deleted' | 'not_found' | 'owner_mismatch'>;
  searchPaginated(query: Partial<User>, opts?: PaginationOptions): Promise<User[]>;
  findWhere(query: Partial<User>): Promise<User[]>;
}

// ─────────────────────────────────────────────────────────────
// ServerRepository
// ─────────────────────────────────────────────────────────────

export declare class ServerRepository {
  findById(id: UUID): Promise<Server | null>;
  findByOwner(ownerId: UUID): Promise<Server[]>;
  findJoinedByUser(userId: UUID): Promise<Server[]>;
  find(query: Partial<Server>): Promise<Server[]>;
  findOne(query: Partial<Server>): Promise<Server | null>;
  create(data: Partial<Server>): Promise<Server>;
  update(id: UUID, fields: Partial<Server>): Promise<void>;
  delete(id: UUID): Promise<void>;
  getMember(userId: UUID, serverId: UUID): Promise<Member | null>;
  addMember(userId: UUID, serverId: UUID, roles?: string[]): Promise<Member>;
  removeMember(userId: UUID, serverId: UUID): Promise<void>;
  getMembers(serverId: UUID): Promise<Member[]>;
  count(query?: Partial<Server>): Promise<number>;
  findRecentSorted(limit?: number): Promise<Server[]>;
}

// ─────────────────────────────────────────────────────────────
// MemberRepository
// ─────────────────────────────────────────────────────────────

export declare class MemberRepository {
  findOne(userId: UUID, serverId: UUID): Promise<Member | null>;
  findByServer(serverId: UUID): Promise<Member[]>;
  findByUser(userId: UUID): Promise<Member[]>;
  countByServer(serverId: UUID): Promise<number>;
  insert(userId: UUID, serverId: UUID, extra?: Partial<Member>): Promise<Member>;
  update(userId: UUID, serverId: UUID, fields: Partial<Member>): Promise<void>;
  remove(userId: UUID, serverId: UUID): Promise<void>;
  removeAllFromServer(serverId: UUID): Promise<void>;
  removeAllForUser(userId: UUID): Promise<void>;
  findByServerIds(serverIds: UUID[], projection?: object): Promise<Member[]>;
  findWhere(query: Partial<Member>): Promise<Member[]>;
  countWhere(query?: Partial<Member>): Promise<number>;
  isTimedOut(userId: UUID, serverId: UUID): Promise<boolean>;
  setRoles(userId: UUID, serverId: UUID, roles: string[]): Promise<void>;
  addRole(userId: UUID, serverId: UUID, roleId: string): Promise<string[] | null>;
  removeRole(userId: UUID, serverId: UUID, roleId: string): Promise<string[] | null>;
}

// ─────────────────────────────────────────────────────────────
// ChannelRepository
// ─────────────────────────────────────────────────────────────

export declare class ChannelRepository {
  findById(id: UUID): Promise<Channel | null>;
  findByServer(serverId: UUID): Promise<Channel[]>;
  findByIdAndServer(id: UUID, serverId: UUID): Promise<Channel | null>;
  insert(data: Partial<Channel>): Promise<Channel>;
  update(id: UUID, fields: Partial<Channel>): Promise<void>;
  updateByIdAndServer(id: UUID, serverId: UUID, fields: Partial<Channel>): Promise<void>;
  delete(id: UUID): Promise<void>;
  deleteByServer(serverId: UUID): Promise<void>;
  count(serverId: UUID): Promise<number>;
  findWhere(query: Partial<Channel>): Promise<Channel[]>;
  findOneWhere(query: Partial<Channel>): Promise<Channel | null>;
  findIdsByServer(serverId: UUID): Promise<UUID[]>;
  // Categories
  findCategoryById(id: UUID): Promise<ChannelCategory | null>;
  findCategoriesByServer(serverId: UUID): Promise<ChannelCategory[]>;
  findCategoryByIdAndServer(id: UUID, serverId: UUID): Promise<ChannelCategory | null>;
  countCategories(serverId: UUID): Promise<number>;
  insertCategory(data: Partial<ChannelCategory>): Promise<ChannelCategory>;
  updateCategory(id: UUID, serverId: UUID, fields: Partial<ChannelCategory>): Promise<void>;
  deleteCategory(id: UUID, serverId: UUID): Promise<void>;
  deleteCategoryAtomic(id: UUID, serverId: UUID): Promise<boolean>;
  reorderCategoriesAtomic(serverId: UUID, order: Array<{ id: UUID; position: number }>): Promise<boolean>;
  unlinkCategory(catId: UUID, serverId: UUID): Promise<void>;
  findOverridesByChannel(channelId: UUID): Promise<ChannelOverride[]>;
}

// ─────────────────────────────────────────────────────────────
// MessageRepository
// ─────────────────────────────────────────────────────────────

export declare class MessageRepository {
  hasFtsSearch(): boolean;
  ftsSearch(searchTerm: string, serverIds: UUID[], limit: number): Promise<Message[]>;
  hasUnifiedSearch(): boolean;
  /** Kanal + DM + grup DM + thread; her satır `_source` taşır. */
  unifiedSearch(
    searchTerm: string,
    scope: { userId: UUID; serverIds: UUID[]; sources?: readonly string[] },
    limit?: number,
  ): Promise<(Record<string, unknown> & { _source: string; _score: number })[]>;
  findByChannel(channelId: UUID, opts?: MessageSearchOptions): Promise<Message[]>;
  findById(id: UUID): Promise<Message | null>;
  create(data: Partial<Message>): Promise<Message>;
  update(id: UUID, fields: Partial<Message>): Promise<void>;
  delete(id: UUID): Promise<void>;
  deleteByChannel(channelId: UUID): Promise<void>;
  count(query?: Partial<Message>): Promise<number>;
  removeByUser(userId: UUID): Promise<void>;
  removeByServer(serverId: UUID): Promise<void>;
  findProjected(query: Partial<Message>, options?: object): Promise<Message[]>;
  findWhere(query: Partial<Message>): Promise<Message[]>;
  messagesFind(query: Partial<Message>): object; // chaining icin
  findPinsInChannel(channelId: UUID, limit?: number): Promise<Message[]>;
  clearThreadFromParent(parentMessageId: UUID): Promise<void>;
  countByChannel(channelId: UUID): Promise<number>;
  findPinned(channelId: UUID): Promise<Message[]>;
  findLastTimestamps(channelIds: UUID[]): Promise<Array<{ channelId: UUID; lastAt: Timestamp }>>;
}

// ─────────────────────────────────────────────────────────────
// DmRepository
// ─────────────────────────────────────────────────────────────

export declare class DmRepository {
  findConversation(id: UUID): Promise<DmConversation | null>;
  static buildDmId(a: UUID, b: UUID): string;
  findConversationsByUser(userId: UUID): Promise<DmConversation[]>;
  markReadWithReceipt(dmId: string, userId: UUID): Promise<{ participants: UUID[]; readAt: Timestamp } | null>;
  markRead(dmId: string, userId: UUID): Promise<boolean>;
  findOrCreateConversation(userId: UUID, toUserId: UUID): Promise<{ conv: DmConversation; dmId: string }>;
  touchConversation(id: string): Promise<void>;
  findMessages(dmId: string, opts?: CursorOptions): Promise<DmMessage[]>;
  findMessage(id: UUID, dmId: string): Promise<DmMessage | null>;
  insertMessage(data: Partial<DmMessage>): Promise<DmMessage>;
  updateMessage(id: UUID, fields: Partial<DmMessage>): Promise<void>;
  countMessages(): Promise<number>;
  findMessagesWhere(query: Partial<DmMessage>): Promise<DmMessage[]>;
}

// ─────────────────────────────────────────────────────────────
// GroupDmRepository
// ─────────────────────────────────────────────────────────────

export declare class GroupDmRepository {
  findById(id: UUID): Promise<GroupDm | null>;
  findByUser(userId: UUID): Promise<GroupDm[]>;
  insert(data: Partial<GroupDm>): Promise<GroupDm>;
  update(id: UUID, fields: Partial<GroupDm>): Promise<void>;
  delete(id: UUID): Promise<void>;
  addMember(id: UUID, userId: UUID): Promise<void>;
  removeMember(id: UUID, userId: UUID): Promise<void>;
  transferOwnership(id: UUID, newOwnerId: UUID): Promise<void>;
  findMessages(groupId: UUID, opts?: CursorOptions): Promise<GroupDmMessage[]>;
  insertMessage(data: Partial<GroupDmMessage>): Promise<GroupDmMessage>;
  updateMessage(id: UUID, fields: Partial<GroupDmMessage>): Promise<void>;
  deleteGroup(id: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// RoleRepository
// ─────────────────────────────────────────────────────────────

export declare class RoleRepository {
  findById(id: UUID): Promise<Role | null>;
  findByIdAndServer(id: UUID, serverId: UUID): Promise<Role | null>;
  findByServer(serverId: UUID): Promise<Role[]>;
  insert(data: Partial<Role>): Promise<Role>;
  update(id: UUID, serverId: UUID, fields: Partial<Role>): Promise<void>;
  delete(id: UUID, serverId: UUID): Promise<void>;
  deleteByServer(serverId: UUID): Promise<void>;
  findWhere(query: Partial<Role>): Promise<Role[]>;
  findByIdsInServer(roleIds: UUID[], serverId: UUID): Promise<Role[]>;
}

// ─────────────────────────────────────────────────────────────
// InviteRepository
// ─────────────────────────────────────────────────────────────

export declare class InviteRepository {
  findByCode(code: string): Promise<Invite | null>;
  findByServer(serverId: UUID): Promise<Invite[]>;
  create(opts: { serverId: UUID; createdBy: UUID; maxUses?: number; ttlMs?: number }): Promise<{ code: string; expiresAt: Timestamp; maxUses: number }>;
  incrementUses(id: UUID): Promise<void>;
  removeByServer(serverId: UUID): Promise<void>;
  isValid(invite: Invite | null): string | null;
}

// ─────────────────────────────────────────────────────────────
// ThreadRepository
// ─────────────────────────────────────────────────────────────

export declare class ThreadRepository {
  findById(id: UUID): Promise<Thread | null>;
  findByParentMessage(parentMessageId: UUID): Promise<Thread | null>;
  findByChannel(channelId: UUID): Promise<Thread[]>;
  insert(data: Partial<Thread>): Promise<Thread>;
  update(id: UUID, fields: Partial<Thread>): Promise<void>;
  delete(id: UUID): Promise<void>;
  setPinned(id: UUID, pinned: boolean): Promise<void>;
  setLocked(id: UUID, locked: boolean): Promise<void>;
  findMessages(threadId: UUID, opts?: CursorOptions): Promise<ThreadMessage[]>;
  insertMessage(data: Partial<ThreadMessage>): Promise<ThreadMessage>;
  removeMessages(threadId: UUID): Promise<void>;
  listAllMessages(threadId: UUID): Promise<ThreadMessage[]>;
  recordReply(threadId: UUID, parentMessageId: UUID | null): Promise<void>;
  deleteThread(id: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// BotRepository
// ─────────────────────────────────────────────────────────────

export declare class BotRepository {
  findById(id: UUID): Promise<Bot | null>;
  findByIdAndServer(id: UUID, serverId: UUID): Promise<Bot | null>;
  findByIdAndToken(id: UUID, serverId: UUID, tokenHash: string): Promise<Bot | null>;
  findByTokenHash(tokenHash: string): Promise<Bot | null>;
  findByServer(serverId: UUID): Promise<Bot[]>;
  findPublic(query?: Record<string, unknown>): Promise<Bot[]>;
  findByIds(ids: UUID[]): Promise<(Bot | null)[]>;
  insert(data: Partial<Bot>): Promise<Bot>;
  create(data: Partial<Bot>): Promise<Bot>;
  update(id: UUID, fields: Partial<Bot>): Promise<void>;
  updateByIdAndServer(id: UUID, serverId: UUID, fields: Partial<Bot>): Promise<void>;
  deactivate(id: UUID, serverId: UUID): Promise<void>;
  delete(id: UUID, serverId?: UUID): Promise<void>;
  updateToken(id: UUID, serverIdOrTokenHash: string, maybeTokenHash?: string): Promise<void>;
  findServerBot(botId: UUID, serverId: UUID): Promise<Record<string, unknown> | null>;
  findServerBots(serverId: UUID): Promise<Record<string, unknown>[]>;
  findInstalledForServer(serverId: UUID): Promise<Record<string, unknown>[]>;
  countServerInstalls(botId: UUID): Promise<number>;
  addToServer(botId: UUID, serverId: UUID, addedBy: UUID): Promise<Record<string, unknown>>;
  findRating(botId: UUID, userId: UUID): Promise<Record<string, unknown> | null>;
  findAllRatings(botId: UUID): Promise<Record<string, unknown>[]>;
  insertRating(botId: UUID, userId: UUID, rating: number): Promise<Record<string, unknown>>;
  updateRating(id: UUID, rating: number): Promise<void>;
  findIncomingWebhook(id: UUID): Promise<Record<string, unknown> | null>;
  findWhere(query: Record<string, unknown>): Promise<Bot[]>;
}

// ─────────────────────────────────────────────────────────────
// AutomodRepository
// ─────────────────────────────────────────────────────────────

export declare class AutomodRepository {
  findByServer(serverId: UUID): Promise<AutomodRule[]>;
  findById(id: UUID): Promise<AutomodRule | null>;
  findByIdAndServer(id: UUID, serverId: UUID): Promise<AutomodRule | null>;
  insert(data: Partial<AutomodRule>): Promise<AutomodRule>;
  update(id: UUID, serverId: UUID, fields: Partial<AutomodRule>): Promise<void>;
  delete(id: UUID, serverId: UUID): Promise<void>;
  count(serverId: UUID): Promise<number>;
}

// ─────────────────────────────────────────────────────────────
// ReactionRoleRepository
// ─────────────────────────────────────────────────────────────

export declare class ReactionRoleRepository {
  findByServer(serverId: UUID): Promise<ReactionRole[]>;
  findByMessageAndEmoji(messageId: UUID, emoji: string): Promise<ReactionRole | null>;
  findDuplicate(serverId: UUID, messageId: UUID, emoji: string, roleId: UUID): Promise<ReactionRole | null>;
  insert(data: Partial<ReactionRole>): Promise<ReactionRole>;
  delete(id: UUID, serverId: UUID): Promise<void>;
  deleteByServer(serverId: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// ScheduledMessageRepository
// ─────────────────────────────────────────────────────────────

export declare class ScheduledMessageRepository {
  findPending(userId: UUID): Promise<ScheduledMessage[]>;
  findById(id: UUID, userId: UUID): Promise<ScheduledMessage | null>;
  insert(data: Partial<ScheduledMessage>): Promise<ScheduledMessage>;
  delete(id: UUID): Promise<void>;
  deleteByServer(serverId: UUID): Promise<void>;
  claimDueBefore(timestamp: number, claimOwner: string, leaseMs?: number, limit?: number): Promise<ScheduledMessage[]>;
  finalizeSent(id: UUID, claimOwner: string, sentAt?: number): Promise<boolean>;
  releaseClaim(id: UUID, claimOwner: string, error: string, retryAt: number): Promise<boolean>;
  markFailed(id: UUID, claimOwner: string, reason: string, failedAt?: number): Promise<boolean>;
  markSent(id: UUID, sentAt?: number): Promise<void>;
  findDueBefore(timestamp: number): Promise<ScheduledMessage[]>;
}

// ─────────────────────────────────────────────────────────────
// NotificationRepository
// ─────────────────────────────────────────────────────────────

export declare class NotificationRepository {
  upsertNativeToken(userId: UUID, token: string, platform: NativeToken['platform']): Promise<void>;
  removeNativeToken(token: string): Promise<void>;
  findNativeTokensByUser(userId: UUID): Promise<NativeToken[]>;
  findAllNativeTokens(): Promise<NativeToken[]>;
  upsertPref(userId: UUID, data: Partial<NotificationPref>): Promise<void>;
  findPref(userId: UUID, channelId?: UUID): Promise<NotificationPref | null>;
  findPrefsByUser(userId: UUID): Promise<NotificationPref[]>;
}

// ─────────────────────────────────────────────────────────────
// SocialRepository
// ─────────────────────────────────────────────────────────────

export declare class SocialRepository {
  findFriendship(userId: UUID, otherId: UUID): Promise<Friendship | null>;
  findFriendshipById(friendshipId: UUID): Promise<Friendship | null>;
  findFriendships(userId: UUID): Promise<Friendship[]>;
  insertFriendship(userId: UUID, friendId: UUID, status?: Friendship['status']): Promise<Friendship>;
  createFriendship(userId: UUID, friendId: UUID): Promise<Friendship>;
  updateFriendship(id: UUID, fields: Partial<Friendship>): Promise<void>;
  removeFriendship(id: UUID): Promise<void>;
  findBlock(blockerId: UUID, blockedId: UUID): Promise<Block | null>;
  findBlocksByUser(blockerId: UUID): Promise<Block[]>;
  findBlocksInvolvingUser(userId: UUID): Promise<Block[]>;
  insertBlock(blockerId: UUID, blockedId: UUID): Promise<Block>;
  removeBlock(blockerId: UUID, blockedId: UUID): Promise<void>;
  findConnection(userId: UUID, platform: string): Promise<UserConnection | null>;
  findConnectionsByUser(userId: UUID): Promise<UserConnection[]>;
  insertConnection(data: Partial<UserConnection>): Promise<UserConnection>;
  upsertConnectionWithinLimit(
    userId: UUID, platform: string,
    fields: { username: string; url: string; verified?: boolean | number },
    maxConnections?: number,
  ): Promise<{ status: 'ok'; connection: UserConnection } | { status: 'limit' }>;
  removeConnection(userId: UUID, platform: string): Promise<void>;
  updateConnection(filter: Partial<UserConnection>, modifier: object): Promise<void>;
  countConnections(query: Partial<UserConnection>): Promise<number>;
}

// ─────────────────────────────────────────────────────────────
// ServerAssetRepository
// ─────────────────────────────────────────────────────────────

export declare class ServerAssetRepository {
  findEmojisByServer(serverId: UUID): Promise<CustomEmoji[]>;
  findEmojiById(id: UUID): Promise<CustomEmoji | null>;
  insertEmoji(data: Partial<CustomEmoji>): Promise<CustomEmoji>;
  updateEmoji(id: UUID, serverId: UUID, fields: Partial<CustomEmoji>): Promise<void>;
  deleteEmoji(id: UUID, serverId: UUID): Promise<void>;
  findGifsByServer(serverId: UUID): Promise<ServerGif[]>;
  insertGif(data: Partial<ServerGif>): Promise<ServerGif>;
  deleteGif(id: UUID, serverId: UUID): Promise<void>;
  findSounds(serverId: UUID, limit?: number): Promise<SoundboardSound[]>;
  findSoundsSorted(serverId: UUID, limit?: number): Promise<SoundboardSound[]>;
  findSoundByIdAndServer(id: UUID, serverId: UUID): Promise<SoundboardSound | null>;
  insertSound(data: Partial<SoundboardSound>): Promise<SoundboardSound>;
  updateSound(id: UUID, serverId: UUID, fields: Partial<SoundboardSound>): Promise<SoundboardSound | null>;
  setSoundFavorite(soundId: UUID, userId: UUID, serverId: UUID | null, favorite: boolean): Promise<SoundboardUserStat | null | Record<string, unknown>>;
  recordSoundPlay(soundId: UUID, userId: UUID, serverId: UUID | null): Promise<SoundboardUserStat | null | Record<string, unknown>>;
  deleteSound(id: UUID, serverId: UUID): Promise<{ deleted: number | null }>;
  upsertOnboarding(serverId: UUID, data: object): Promise<void>;
  markOnboardingComplete(serverId: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// AuthRepository
// ─────────────────────────────────────────────────────────────

export declare class AuthRepository {
  findRefreshToken(token: string): Promise<RefreshToken | null>;
  insertRefreshToken(userId: UUID, token: string, expiresAt: Timestamp, tokenVersion: number): Promise<RefreshToken>;
  revokeRefreshToken(token: string): Promise<void>;
  revokeAllForUser(userId: UUID): Promise<void>;
  /** Token ailesi bazli toplu iptal — reuse attack tespitinde cağrilir. */
  revokeByFamily(family: string): Promise<void>;
  findByFamily(family: string): Promise<RefreshToken[]>;
  updateRefreshTokenWhere(filter: Partial<RefreshToken>, modifier: object): Promise<void>;
  removeRefreshTokensWhere(filter: Partial<RefreshToken>): Promise<void>;
  insertRefreshTokenRow(row: Partial<RefreshToken>): Promise<RefreshToken>;
  hasWebauthnCollection(): boolean;
  findCredential(credentialId: string): Promise<WebAuthnCredential | null>;
  findCredentialByDocId(id: UUID, userId?: UUID): Promise<WebAuthnCredential | null>;
  findCredentialsByUser(userId: UUID): Promise<WebAuthnCredential[]>;
  insertCredential(data: Partial<WebAuthnCredential>): Promise<WebAuthnCredential>;
  updateCredential(credentialId: string, fields: Partial<WebAuthnCredential>): Promise<void>;
  updateCredentialByDocId(id: UUID, fields: Partial<WebAuthnCredential>): Promise<void>;
  deleteCredential(id: UUID, userId: UUID): Promise<void>;
  insertAdminLog(data: object): Promise<void>;
  findAdminLogs(query?: object, limit?: number): Promise<object[]>;
  insertAuditLog(data: object): Promise<void>;
  findAuditLogs(serverId: UUID, limit?: number): Promise<object[]>;
  findAuditLogsWhere(query: object): Promise<object[]>;
  auditLogsFind(query: object): object; // chaining icin
}

// ─────────────────────────────────────────────────────────────
// OutgoingWebhookRepository
// ─────────────────────────────────────────────────────────────

export declare class OutgoingWebhookRepository {
  findByServer(serverId: UUID): Promise<OutgoingWebhook[]>;
  findActive(serverId: UUID): Promise<OutgoingWebhook[]>;
  findById(id: UUID): Promise<OutgoingWebhook | null>;
  insert(data: Partial<OutgoingWebhook>): Promise<OutgoingWebhook>;
  update(id: UUID, serverId: UUID, fields: Partial<OutgoingWebhook>): Promise<void>;
  delete(id: UUID, serverId: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// PollRepository
// ─────────────────────────────────────────────────────────────

export declare class PollRepository {
  findByChannel(channelId: UUID): Promise<Poll[]>;
  findById(id: UUID): Promise<Poll | null>;
  insert(data: Partial<Poll>): Promise<Poll>;
  update(id: UUID, fields: Partial<Poll>): Promise<void>;
  delete(id: UUID): Promise<void>;
  close(id: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// FederationRepository
// ─────────────────────────────────────────────────────────────

export declare class FederationRepository {
  insertActivity(data: Partial<FederationActivity>): Promise<FederationActivity>;
  updateActivity(filter: Query, modifier: UpdateModifier): Promise<unknown>;
  claimInboundActivity(input: {
    id: UUID; targetUserId: UUID; actorUrl: string; activityId: string; type: string;
    activity: Record<string, unknown>; claimOwner: string; claimUntil: Timestamp; createdAt: Timestamp;
  }): Promise<{ status: 'claimed' | 'processed' | 'busy'; id: UUID }>;
  completeInboundActivity(id: UUID, claimOwner: string, processedAt?: Timestamp): Promise<void>;
  failInboundActivity(id: UUID, claimOwner: string, error: string): Promise<void>;
  countActivities(query?: Partial<FederationActivity>): Promise<number>;
  findActivities(query?: Partial<FederationActivity>, limit?: number): Promise<FederationActivity[]>;
  findPeer(domain: string): Promise<FederationPeer | null>;
  upsertPeer(domain: string, data: Partial<FederationPeer>): Promise<void>;
  findTrustedPeers(): Promise<FederationPeer[]>;
}

// ─────────────────────────────────────────────────────────────
// BridgeRepository
// ─────────────────────────────────────────────────────────────

export declare class BridgeRepository {
  findByChannel(channelId: UUID): Promise<Bridge[]>;
  insert(data: Partial<Bridge>): Promise<Bridge>;
  delete(id: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// WebhookRepository (ChannelWebhooks)
// ─────────────────────────────────────────────────────────────

export declare class WebhookRepository {
  findByChannel(channelId: UUID): Promise<ChannelWebhook[]>;
  findById(id: UUID): Promise<ChannelWebhook | null>;
  insert(data: Partial<ChannelWebhook>): Promise<ChannelWebhook>;
  delete(id: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// ChannelPermissionRepository
// ─────────────────────────────────────────────────────────────

export declare class ChannelPermissionRepository {
  findByChannel(channelId: UUID): Promise<ChannelPermission[]>;
  findOne(query: Partial<ChannelPermission>): Promise<ChannelPermission | null>;
  find(query: Partial<ChannelPermission>): Promise<ChannelPermission[]>;
  insert(doc: Partial<ChannelPermission>): Promise<ChannelPermission>;
  update(filter: Partial<ChannelPermission>, modifier: object): Promise<void>;
  remove(query: Partial<ChannelPermission>): Promise<void>;
  removeByChannel(channelId: UUID): Promise<void>;
  replaceManyChannelsAtomic(serverId: UUID, channelIds: UUID[], overrides: Array<{ roleId: string; allow: number; deny: number }>): Promise<boolean>;
  applyChannelBatchAtomic(serverId: UUID, channelId: UUID, upserts: Array<{ roleId: string; allow: number; deny: number }>, deletes: string[]): Promise<boolean>;
}

// ─────────────────────────────────────────────────────────────
// PodcastRepository
// ─────────────────────────────────────────────────────────────

export declare class PodcastRepository {
  findByServer(serverId: UUID): Promise<Podcast[]>;
  findById(id: UUID): Promise<Podcast | null>;
  insert(data: Partial<Podcast>): Promise<Podcast>;
  update(id: UUID, fields: Partial<Podcast>): Promise<void>;
  delete(id: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// VoiceRepository
// ─────────────────────────────────────────────────────────────

export declare class VoiceRepository {
  findByChannel(channelId: UUID): Promise<VoiceMessage[]>;
  findById(id: UUID): Promise<VoiceMessage | null>;
  insert(data: Partial<VoiceMessage>): Promise<VoiceMessage>;
  delete(id: UUID): Promise<void>;
}

// ─────────────────────────────────────────────────────────────
// Index export — require('../db/repositories') donuş tipi
// ─────────────────────────────────────────────────────────────

export declare const Users: UserRepository;
export declare const Servers: ServerRepository;
export declare const Messages: MessageRepository;
export declare const Channels: ChannelRepository;
export declare const Members: MemberRepository;
export declare const Invites: InviteRepository;
export declare const Roles: RoleRepository;
export declare const Dms: DmRepository;
export declare const GroupDms: GroupDmRepository;
export declare const Bots: BotRepository;
export declare const Threads: ThreadRepository;
export declare const Automod: AutomodRepository;
export declare const ReactionRoles: ReactionRoleRepository;
export declare const ScheduledMessages: ScheduledMessageRepository;
export declare const Notifications: NotificationRepository;
export declare const Social: SocialRepository;
export declare const ServerAssets: ServerAssetRepository;
export declare const Auth: AuthRepository;
export declare const OutgoingWebhooks: OutgoingWebhookRepository;
export declare const Polls: PollRepository;
export declare const Federation: FederationRepository;
export declare const Bridges: BridgeRepository;
export declare const ChannelWebhooks: WebhookRepository;
export declare const ChannelPermissions: ChannelPermissionRepository;
export declare const Podcasts: PodcastRepository;
export declare const VoiceMessages: VoiceRepository;
