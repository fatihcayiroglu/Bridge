// server/lib/permissions.ts — Oturum 15: any cast'leri temizlendi, override tipleri eklendi
// Discord-style permission system

import { Servers, Members, Roles, Channels, Auth, ChannelPermissions } from '../db/repositories';
import { parsePermissionMask, parsePermissionPair, VALID_PERMISSION_BITS } from './permissionMaskInvariant';
import { memoizeInRequest } from './requestContext';

// ── PERMISSION FLAGS ───────────────────────────────────────────
export const PERMS = {
  VIEW_CHANNELS:     1 << 0,
  MANAGE_CHANNELS:   1 << 1,
  MANAGE_ROLES:      1 << 2,
  MANAGE_SERVER:     1 << 3,
  KICK_MEMBERS:      1 << 4,
  BAN_MEMBERS:       1 << 5,
  MANAGE_NICKNAMES:  1 << 6,
  MANAGE_MEMBERS:    1 << 6,
  TIMEOUT_MEMBERS:   1 << 7,
  SEND_MESSAGES:     1 << 8,
  MANAGE_MESSAGES:   1 << 9,
  EMBED_LINKS:       1 << 10,
  ATTACH_FILES:      1 << 11,
  ADD_REACTIONS:     1 << 12,
  USE_SLASH:         1 << 13,
  MENTION_EVERYONE:  1 << 14,
  READ_HISTORY:      1 << 15,
  CONNECT:           1 << 16,
  SPEAK:             1 << 17,
  MUTE_MEMBERS:      1 << 18,
  DEAFEN_MEMBERS:    1 << 19,
  MOVE_MEMBERS:      1 << 20,
  USE_BOT_COMMANDS:  1 << 21,
  ADMINISTRATOR:     1 << 30,
  ADMIN:             1 << 30,
  MANAGE_WEBHOOKS:   1 << 24,
} as const;

export type PermFlag = typeof PERMS[keyof typeof PERMS];

export const DEFAULT_PERMISSIONS: number =
  PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY |
  PERMS.EMBED_LINKS   | PERMS.ATTACH_FILES  | PERMS.ADD_REACTIONS |
  PERMS.CONNECT       | PERMS.SPEAK;

export const VALID_BITS: number = Object.values(PERMS).reduce((acc, bit) => acc | bit, 0);
if (VALID_BITS !== VALID_PERMISSION_BITS) {
  throw new Error('Permission bit definition drift detected');
}

// ── Override tipleri ──────────────────────────────────────────
type OverrideTargetType = 'everyone' | 'role' | 'user';

interface PermissionOverride {
  targetType: OverrideTargetType;
  targetId:   string;
  allow:      number;
  deny:       number;
  position?:  number;
}

interface RoleRow {
  _id:         string;
  serverId:    string;
  permissions: number;
  name?:        string;
  position?:   number;
}

export interface AppliedPermissionOverride {
  scope:      OverrideTargetType;
  targetId:   string;
  targetName: string;
  allow:      number;
  deny:       number;
}

/**
 * Canonical permission result plus the exact inputs that produced it.
 *
 * The masks remain server-internal. Public routes must transform this object
 * through `explainResolvedPermission`, which intentionally exposes labels and
 * states rather than raw bit fields or hidden authorization internals.
 */
export interface PermissionResolution {
  permissions: number;
  subject: 'missing_server' | 'not_member' | 'member' | 'owner' | 'administrator';
  baseSource: 'none' | 'server_default' | 'roles' | 'owner' | 'administrator';
  basePermissions: number;
  roles: RoleRow[];
  overrides: AppliedPermissionOverride[];
  allow: number;
  deny: number;
}

export interface PermissionExplanation {
  allowed: boolean;
  effective: 'allowed' | 'denied';
  reasonCode: 'SERVER_OWNER' | 'ADMINISTRATOR' | 'CHANNEL_OVERRIDE_ALLOW' |
    'CHANNEL_OVERRIDE_DENY' | 'BASE_PERMISSION' | 'MISSING_PERMISSION' | 'NOT_A_MEMBER';
  message: string;
  base: { state: 'allowed' | 'denied'; sources: string[] };
  overrides: Array<{
    scope: 'everyone' | 'role' | 'member';
    label: string;
    state: 'allowed' | 'denied';
  }>;
}

// ── CORE FUNCTIONS ────────────────────────────────────────────
export function hasPermission(perms: number, flag: number): boolean {
  if ((perms & PERMS.ADMINISTRATOR) !== 0) return true;
  return (perms & flag) !== 0;
}

export function hasAnyPermission(perms: number, ...flags: number[]): boolean {
  return flags.some(f => hasPermission(perms, f));
}

export function hasAllPermissions(perms: number, ...flags: number[]): boolean {
  return flags.every(f => hasPermission(perms, f));
}

/** JSONB returns arrays in PostgreSQL; legacy/in-memory callers may still expose JSON text. */
function normalizeRoleIds(value: unknown): string[] {
  let roles: unknown = value;
  if (typeof roles === 'string') {
    try {
      const parsed: unknown = JSON.parse(roles);
      roles = Array.isArray(parsed) ? parsed : (roles ? [roles] : []);
    } catch {
      roles = roles ? [roles] : [];
    }
  }
  if (!Array.isArray(roles)) return [];
  return [...new Set(roles.filter((role): role is string => typeof role === 'string' && role.length > 0))];
}

// ── PERMISSION RESOLUTION ─────────────────────────────────────
function emptyResolution(subject: PermissionResolution['subject']): PermissionResolution {
  return {
    permissions: 0, subject, baseSource: 'none', basePermissions: 0,
    roles: [], overrides: [], allow: 0, deny: 0,
  };
}

/**
 * Shared canonical resolver for a concrete role set. Both real-member
 * authorization and admin-only role simulation enter through this function,
 * so preview cannot drift into a second permission algorithm.
 */
async function resolveRoleSetPermissionResolution(input: {
  serverId: string;
  channelId: string | null;
  roleIds: string[];
  roles: RoleRow[];
  basePermissions: number;
  baseSource: 'server_default' | 'roles';
  userId?: string;
}): Promise<PermissionResolution> {
  const { serverId, channelId, roleIds, roles, basePermissions, baseSource, userId } = input;

  if ((basePermissions & PERMS.ADMINISTRATOR) !== 0) {
    return {
      ...emptyResolution('administrator'), permissions: 0x7FFFFFFF,
      basePermissions, baseSource: 'administrator', roles,
    };
  }
  if (!channelId) {
    return {
      ...emptyResolution('member'), permissions: basePermissions,
      basePermissions, baseSource, roles,
    };
  }

  const rawOverrides = [...await Channels.findOverridesByChannel(channelId)] as Array<PermissionOverride & { allow?: unknown; deny?: unknown }>;
  const overrides: PermissionOverride[] = rawOverrides.map((override) => {
    if (!override || !['everyone', 'role', 'user'].includes(String(override.targetType)) ||
        typeof override.targetId !== 'string' || !override.targetId) {
      throw new TypeError('Invalid persisted channel override target');
    }
    const { allow, deny } = parsePermissionPair(override.allow ?? 0, override.deny ?? 0, 'persisted channel override');
    return { ...override, allow, deny };
  });
  // `channel_permissions` is the canonical role/everyone owner. A read failure
  // must not be swallowed: doing so would silently discard DENY rows and turn
  // a storage outage into an authorization grant (fail-open).
  const rolePerms = await ChannelPermissions.findByChannel(channelId) as Array<{
    roleId?: string; allow?: number; deny?: number;
  }>;
  for (const rp of rolePerms ?? []) {
    const rid = String(rp.roleId ?? '');
    if (!rid) throw new TypeError('Invalid persisted channel permission role');
    const { allow, deny } = parsePermissionPair(rp.allow ?? 0, rp.deny ?? 0, 'persisted channel permission');
    overrides.push({
      // Bridge routes persist @everyone canonically as `__everyone__`; older
      // rows may use the server id. Both representations resolve identically.
      targetType: rid === serverId || rid === '__everyone__' ? 'everyone' : 'role',
      targetId: rid,
      allow,
      deny,
      position: 0,
    });
  }

  const everyoneOverrides = overrides.filter(o => o.targetType === 'everyone');
  const roleOverrides = overrides
    .filter(o => o.targetType === 'role' && roleIds.includes(o.targetId))
    .sort((a, b) => (a.position || 0) - (b.position || 0));
  const userOverrides = userId
    ? overrides.filter(o => o.targetType === 'user' && o.targetId === userId)
    : [];

  const fold = (items: PermissionOverride[]) => items.reduce(
    (acc, override) => ({
      allow: acc.allow | (override.allow || 0),
      deny: acc.deny | (override.deny || 0),
    }),
    { allow: 0, deny: 0 },
  );

  // Discord-style precedence is LEVELLED, not one global allow/deny pool:
  // base -> @everyone -> aggregate roles -> member. Within each level DENY is
  // applied first and ALLOW second; a later level therefore overrides an
  // earlier one. This is security-sensitive: member DENY must beat role ALLOW.
  let permissions = basePermissions;
  const everyoneBits = fold(everyoneOverrides);
  permissions = (permissions & ~everyoneBits.deny) | everyoneBits.allow;
  const roleBits = fold(roleOverrides);
  permissions = (permissions & ~roleBits.deny) | roleBits.allow;
  const userBits = fold(userOverrides);
  permissions = (permissions & ~userBits.deny) | userBits.allow;

  // Keep aggregate masks for explanation/diagnostics only. They are NOT used
  // to compute the effective permission because doing so destroys precedence.
  const allow = everyoneBits.allow | roleBits.allow | userBits.allow;
  const deny = everyoneBits.deny | roleBits.deny | userBits.deny;

  const roleNames = new Map(roles.map(role => [role._id, role.name || role._id]));
  const applied = [
    ...everyoneOverrides,
    ...roleOverrides,
    ...userOverrides,
  ].map((override): AppliedPermissionOverride => ({
    scope: override.targetType,
    targetId: override.targetId,
    targetName: override.targetType === 'everyone'
      ? '@everyone'
      : override.targetType === 'user'
        ? 'Üyeye özel'
        : roleNames.get(override.targetId) || override.targetId,
    allow: override.allow || 0,
    deny: override.deny || 0,
  }));

  return {
    permissions,
    subject: 'member',
    baseSource,
    basePermissions,
    roles,
    overrides: applied,
    allow,
    deny,
  };
}

export async function resolvePermissionResolution(
  userId: string,
  serverId: string,
  channelId: string | null = null,
): Promise<PermissionResolution> {
  // ── İSTEK KAPSAMLI MEMO (v1.124) ────────────────────────────────────────
  // Aşağıdaki üç okuma `(userId, serverId)` için DEĞİŞMEZDİR; kanala göre
  // değişmez. Kanal başına yeniden okumak ölçülebilir bir maliyetti:
  //
  //   OLCULDU (v1.123) `/api/notification-prefs/unread`, 100 kanal: 110 ms,
  //   kanal başına ~0.90 ms — ve bu yol 200 kanala kadar döngü kurar.
  //
  // Kanala ÖZGÜ kısım (kanal geçersiz kılmaları) memoize EDİLMEZ; yalnızca
  // sunucu satırı, üyelik ve rol kümesi paylaşılır.
  //
  // GÜVENLİK: önbellek istek bağlamında yaşar ve istekle birlikte ölür.
  // İstekler arasında bayat yetki OLUŞMAZ; rol değişikliği bir sonraki
  // istekte hemen görünür. Bağlam yoksa hiçbir şey önbelleğe alınmaz.
  const server = await memoizeInRequest(
    `perm:server:${serverId}`,
    () => Servers.findById(serverId),
  );
  if (!server) return emptyResolution('missing_server');

  if ((server as { ownerId: string }).ownerId === userId) {
    return {
      ...emptyResolution('owner'), permissions: 0x7FFFFFFF,
      basePermissions: 0x7FFFFFFF, baseSource: 'owner',
    };
  }

  const membership = await memoizeInRequest(
    `perm:member:${userId}:${serverId}`,
    () => Members.findOne(userId, serverId),
  );
  if (!membership) return emptyResolution('not_member');

  const roleIds = normalizeRoleIds((membership as { roles?: unknown }).roles);
  let basePermissions = DEFAULT_PERMISSIONS;
  let roles: RoleRow[] = [];
  if (roleIds.length) {
    const persistedRoles = await memoizeInRequest(
      `perm:roles:${serverId}:${roleIds.join(',')}`,
      () => Roles.findByIdsInServer(roleIds, serverId) as Promise<Array<RoleRow & { permissions: unknown }>>,
    );
    roles = persistedRoles.map((role) => ({
      ...role,
      permissions: parsePermissionMask(role.permissions, 'persisted role permissions'),
    }));
    basePermissions = roles.reduce((permissions, role) => permissions | role.permissions, 0);
  }

  return resolveRoleSetPermissionResolution({
    serverId,
    channelId,
    roleIds,
    roles,
    basePermissions,
    baseSource: roleIds.length ? 'roles' : 'server_default',
    userId,
  });
}

/**
 * Resolves a role-only simulation without creating a user session, membership,
 * or token. It shares the real authorization resolver above.
 */
export async function resolveRolePermissionResolution(
  roleId: string,
  serverId: string,
  channelId: string | null = null,
): Promise<PermissionResolution | null> {
  if (roleId === '__everyone__') {
    return resolveRoleSetPermissionResolution({
      serverId,
      channelId,
      roleIds: [],
      roles: [],
      basePermissions: DEFAULT_PERMISSIONS,
      baseSource: 'server_default',
    });
  }

  const role = await Roles.findByIdAndServer(roleId, serverId) as RoleRow | null;
  if (!role) return null;
  return resolveRoleSetPermissionResolution({
    serverId,
    channelId,
    roleIds: [role._id],
    roles: [role],
    basePermissions: role.permissions || 0,
    baseSource: 'roles',
  });
}

export async function resolvePermissions(
  userId: string,
  serverId: string,
  channelId: string | null = null,
): Promise<number> {
  return (await resolvePermissionResolution(userId, serverId, channelId)).permissions;
}

/**
 * Converts a canonical resolution into safe, human-readable reasoning for one
 * permission. No caller has to (or is allowed to) recalculate precedence.
 */
export function explainResolvedPermission(
  resolution: PermissionResolution,
  flag: number,
  deniedMessage = 'Bu işlem için kanal izniniz yok.',
): PermissionExplanation {
  const allowed = hasPermission(resolution.permissions, flag);
  const roleSources = resolution.roles
    .filter(role => ((role.permissions || 0) & flag) !== 0)
    .map(role => `Rol: ${role.name || role._id}`);
  const baseAllowed = (resolution.basePermissions & flag) !== 0
    || resolution.subject === 'owner'
    || resolution.subject === 'administrator';
  const baseSources = resolution.subject === 'owner'
    ? ['Sunucu sahibi']
    : resolution.subject === 'administrator'
      ? ['Administrator rolü']
      : resolution.baseSource === 'server_default'
        ? ['Sunucu varsayılanı']
        : roleSources.length
          ? roleSources
          : ['Atanmış roller bu izni vermiyor'];

  const overrideEffects = resolution.overrides.flatMap(override => {
    const grants = (override.allow & flag) !== 0;
    const denies = (override.deny & flag) !== 0;
    if (!grants && !denies) return [];
    return [{
      scope: override.scope === 'user' ? 'member' as const : override.scope,
      label: override.targetName,
      state: grants ? 'allowed' as const : 'denied' as const,
    }];
  });

  let reasonCode: PermissionExplanation['reasonCode'];
  let message: string;
  if (resolution.subject === 'owner') {
    reasonCode = 'SERVER_OWNER';
    message = 'Sunucu sahibi bu izne sahiptir.';
  } else if (resolution.subject === 'administrator') {
    reasonCode = 'ADMINISTRATOR';
    message = 'Administrator rolü bu izni kapsar.';
  } else if (allowed && (resolution.allow & flag) !== 0) {
    reasonCode = 'CHANNEL_OVERRIDE_ALLOW';
    message = 'Bir kanal izni bu eyleme açıkça izin veriyor.';
  } else if (!allowed && (resolution.deny & flag) !== 0) {
    reasonCode = 'CHANNEL_OVERRIDE_DENY';
    message = `${deniedMessage} Bu kanal sunucu rol izinleriyle kısıtlanmış.`;
  } else if (allowed) {
    reasonCode = 'BASE_PERMISSION';
    message = 'Bu izin sunucu rollerinden geliyor.';
  } else if (resolution.subject === 'not_member' || resolution.subject === 'missing_server') {
    reasonCode = 'NOT_A_MEMBER';
    message = 'Bu sunucuda bu eylemi gerçekleştiremezsiniz.';
  } else {
    reasonCode = 'MISSING_PERMISSION';
    message = deniedMessage;
  }

  return {
    allowed,
    effective: allowed ? 'allowed' : 'denied',
    reasonCode,
    message,
    base: { state: baseAllowed ? 'allowed' : 'denied', sources: baseSources },
    overrides: overrideEffects,
  };
}

// ── ROLE HIERARCHY CHECK ──────────────────────────────────────
/**
 * FAZ F/G — TEK KANAL GORUNURLUK DENETIMI (fail-closed).
 *
 * NEDEN VAR: bircok rota "sunucu uyesi mi?" diye sorup duruyordu. Sunucu
 * uyeligi kanal gorunurlugu DEGILDIR: ozel bir kanal, ayni sunucunun uyesine
 * de kapali olabilir. Ayni kusur Faz D'de `search.ts` icinde bulunup
 * duzeltilmisti; `viewableChannelIds` orada COKLU kanal icin ayni islemi yapar.
 *
 * Hata durumunda `false` doner (fail-closed): izin cozumlemesi patlarsa kanal
 * GORUNMEZ sayilir — aksi halde bir altyapi hatasi yetki acilmasina donusurdu.
 */
export async function canViewChannel(
  userId: string,
  serverId: string,
  channelId: string,
): Promise<boolean> {
  if (!userId || !serverId || !channelId) return false;
  const perms = await resolvePermissions(userId, serverId, channelId).catch(() => 0);
  return hasPermission(perms, PERMS.VIEW_CHANNELS);
}

/**
 * FAZ F/G — COKLU KANAL GORUNURLUK KUMESI (fail-closed).
 *
 * `canViewChannel`in toplu hali. Ayni kanal birden cok kez sorulmaz (distinct
 * cozumleme), boylece 200 mesajlik bir kume icin izin cozumlemesi kanal sayisi
 * kadar calisir.
 *
 * NEDEN: Faz D'de `search.ts` sertlestirildi, ancak AYNI VERI baska rotalardan
 * da okunabiliyordu (`/api/semantic/search`, `/api/semantic/digest`). Tek bir
 * ucu sertlestirmek yetmiyor; ayni veriye giden HER yol ayni denetimi
 * uygulamak zorundadir.
 */
export async function viewableChannelIds(
  userId: string,
  serverId: string,
  channelIds: ReadonlyArray<string>,
): Promise<Set<string>> {
  const viewable = new Set<string>();
  for (const channelId of new Set(channelIds.map(String))) {
    if (await canViewChannel(userId, serverId, channelId)) viewable.add(channelId);
  }
  return viewable;
}

/**
 * Bir aktorun hedef rolun hiyerarsisinde ustunde olup olmadigini denetler.
 *
 * MANAGE_ROLES / ADMINISTRATOR bitleri tek basina hiyerarsiyi bypass etmez:
 * sunucu sahibi haric herkes yalnizca kendi en yuksek rolunden DAHA ASAGIDAKI
 * rolleri yonetebilir. Bu kural rol atama/kaldirma, duzenleme ve reaction-role
 * gibi tum kardes yollarda ayni owner tarafindan kullanilmalidir.
 */
export async function canManageRole(
  actorId: string,
  roleId: string,
  serverId: string,
): Promise<boolean> {
  if (!actorId || !roleId || !serverId) return false;
  const server = await Servers.findById(serverId) as { ownerId: string } | null;
  if (!server) return false;
  if (server.ownerId === actorId) return true;

  const [actorMem, targetRole] = await Promise.all([
    Members.findOne(actorId, serverId),
    Roles.findByIdAndServer(roleId, serverId),
  ]);
  if (!actorMem || !targetRole) return false;

  const roleIds = normalizeRoleIds((actorMem as { roles?: unknown }).roles);

  const actorRoles = roleIds.length
    ? await Roles.findWhere({ _id: { $in: roleIds }, serverId }) as RoleRow[]
    : [];
  const actorTop = Math.max(0, ...actorRoles.map(r => Number(r.position || 0)));
  const targetPosition = Number((targetRole as RoleRow).position || 0);
  return actorTop > targetPosition;
}

/**
 * Bir aktorun sunucudaki HIYERARSI KONUMU (sahip oldugu rollerin en yukseki).
 *
 * ── NEDEN DISARI ACILDI ─────────────────────────────────────────────────────
 * Rol olusturma, yeni rolun konumunu AKTORE GORE belirlemek zorundadir. Konum
 * bilgisi olmadan olusturulan her rol ayni duzeye (0) duser ve `canManageRole`
 * / `canActOn` karsilastirmalari (kesin ustunluk) HICBIR ZAMAN saglanamaz.
 *
 * Sonuc, olculmus bir urun kusuruydu: MANAGE_ROLES / KICK_MEMBERS gibi
 * DEVREDILEBILIR yetkiler yalnizca sunucu SAHIBI icin calisiyordu.
 *
 * Sahip icin `Infinity` doner: sahiplik konuma degil, sahiplige dayanir.
 */
export async function actorRolePosition(actorId: string, serverId: string): Promise<number> {
  if (!actorId || !serverId) return 0;
  const server = await Servers.findById(serverId) as { ownerId: string } | null;
  if (!server) return 0;
  if (server.ownerId === actorId) return Number.POSITIVE_INFINITY;

  const membership = await Members.findOne(actorId, serverId);
  if (!membership) return 0;
  const roleIds = normalizeRoleIds((membership as { roles?: unknown }).roles);
  if (!roleIds.length) return 0;
  const roles = await Roles.findWhere({ _id: { $in: roleIds }, serverId }) as RoleRow[];
  return Math.max(0, ...roles.map(r => Number(r.position || 0)));
}

export async function canActOn(
  actorId: string,
  targetId: string,
  serverId: string,
): Promise<boolean> {
  const server = await Servers.findById(serverId) as { ownerId: string } | null;
  if (!server) return false;
  if (server.ownerId === actorId) return true;
  if (server.ownerId === targetId) return false;

  const [actorMem, targetMem] = await Promise.all([
    Members.findOne(actorId, serverId),
    Members.findOne(targetId, serverId),
  ]);
  if (!actorMem || !targetMem) return false;

  const getTopPosition = async (roleIds: string[]): Promise<number> => {
    if (!roleIds?.length) return 0;
    const roles = await Roles.findWhere({
      _id: { $in: roleIds },
      serverId,
    }) as RoleRow[];
    return Math.max(0, ...roles.map(r => r.position || 0));
  };

  const actorRoles = normalizeRoleIds((actorMem as { roles?: unknown }).roles);
  const targetRoles = normalizeRoleIds((targetMem as { roles?: unknown }).roles);

  const [actorTop, targetTop] = await Promise.all([
    getTopPosition(actorRoles),
    getTopPosition(targetRoles),
  ]);

  return actorTop > targetTop;
}

// ── AUDIT LOG ────────────────────────────────────────────────
export async function logAudit(
  serverId: string,
  actorId: string,
  action: string,
  target: string,
  extra: Record<string, unknown> = {},
): Promise<void> {
  try {
    await Auth.insertAuditLog({ serverId, actorId, action, target, extra });
  } catch { /* audit log hatası kritik değil */ }
}

// ── Bitmask Validation ─────────────────────────────────────────
export type BitmaskResult = { ok: true } | { ok: false; error: string };

/**
 * Izin bitmask'ini DOGRULAR.
 *
 * Parametreler `unknown`tur — bu bir gevsetme DEGIL, fonksiyonun ISININ
 * yazilmasidir: girdi istemciden gelir ve ilk iki satir zaten
 * `typeof !== 'number'` kontrolu yapar. Imza `number` dedigi surece o
 * kontroller 'olu kod' gibi gorunuyor, testler ise onlari olcmek icin
 * cast yazmak zorunda kaliyordu.
 */
export function validateBitmask(allow: unknown, deny: unknown): BitmaskResult {
  if (typeof allow !== 'number' || !Number.isSafeInteger(allow) || allow < 0 || allow > VALID_BITS)
    return { ok: false, error: 'allow geçerli bir tam sayı olmalı (>= 0)' };
  if (typeof deny !== 'number' || !Number.isSafeInteger(deny) || deny < 0 || deny > VALID_BITS)
    return { ok: false, error: 'deny geçerli bir tam sayı olmalı (>= 0)' };
  if ((allow & ~VALID_BITS) !== 0)
    return { ok: false, error: `allow geçersiz bit içeriyor: 0x${(allow & ~VALID_BITS).toString(16)}` };
  if ((deny & ~VALID_BITS) !== 0)
    return { ok: false, error: `deny geçersiz bit içeriyor: 0x${(deny & ~VALID_BITS).toString(16)}` };
  if ((allow & deny) !== 0)
    return { ok: false, error: 'allow ve deny aynı anda aynı biti içeremez' };
  return { ok: true };
}
