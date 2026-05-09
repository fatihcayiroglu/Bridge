// @ts-nocheck
// server/lib/permissions.ts
// Discord-style permission system:
//   - Bitmask tabanlı rol izinleri
//   - Role hierarchy (position bazlı)
//   - Kanal bazlı override (allow / deny)
//   - ADMINISTRATOR baypası

import { Servers, Members, Roles, Channels, Auth } from '../db/repositories';

// ── PERMISSION FLAGS ───────────────────────────────────────────
export const PERMS = {
  // Genel
  VIEW_CHANNELS:     1 << 0,
  MANAGE_CHANNELS:   1 << 1,
  MANAGE_ROLES:      1 << 2,
  MANAGE_SERVER:     1 << 3,
  // Üyeler
  KICK_MEMBERS:      1 << 4,
  BAN_MEMBERS:       1 << 5,
  MANAGE_NICKNAMES:  1 << 6,
  TIMEOUT_MEMBERS:   1 << 7,
  // Mesajlar
  SEND_MESSAGES:     1 << 8,
  MANAGE_MESSAGES:   1 << 9,
  EMBED_LINKS:       1 << 10,
  ATTACH_FILES:      1 << 11,
  ADD_REACTIONS:     1 << 12,
  USE_SLASH:         1 << 13,
  MENTION_EVERYONE:  1 << 14,
  READ_HISTORY:      1 << 15,
  // Ses
  CONNECT:           1 << 16,
  SPEAK:             1 << 17,
  MUTE_MEMBERS:      1 << 18,
  DEAFEN_MEMBERS:    1 << 19,
  MOVE_MEMBERS:      1 << 20,
  // Moderasyon
  USE_BOT_COMMANDS:  1 << 21,
  // Admin
  ADMINISTRATOR:     1 << 30,
} as const;

export type PermFlag = typeof PERMS[keyof typeof PERMS];

export const DEFAULT_PERMISSIONS: number =
  PERMS.VIEW_CHANNELS | PERMS.SEND_MESSAGES | PERMS.READ_HISTORY |
  PERMS.EMBED_LINKS   | PERMS.ATTACH_FILES  | PERMS.ADD_REACTIONS |
  PERMS.CONNECT       | PERMS.SPEAK;

export const VALID_BITS: number = Object.values(PERMS).reduce((acc, bit) => acc | bit, 0);

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

// ── PERMISSION RESOLUTION ─────────────────────────────────────
export async function resolvePermissions(
  userId: string,
  serverId: string,
  channelId: string | null = null,
): Promise<number> {
  const server = await Servers.findById(serverId);
  if (!server) return 0;

  if (server.ownerId === userId) return 0x7FFFFFFF;

  const membership = await Members.findOne(userId, serverId);
  if (!membership) return 0;

  const roleIds: string[] = membership.roles || [];
  let basePerms = DEFAULT_PERMISSIONS;

  if (roleIds.length > 0) {
    const roles = await Roles.findByIdsInServer(roleIds, serverId);
    basePerms = roles.reduce((acc, r) => acc | (r.permissions || 0), 0);
  }

  if ((basePerms & PERMS.ADMINISTRATOR) !== 0) return 0x7FFFFFFF;
  if (!channelId) return basePerms;

  const overrides = await Channels.findOverridesByChannel(channelId);
  let allow = 0;
  let deny  = 0;

  const everyoneOvr = overrides.find((o: any) => o.targetType === 'everyone');
  if (everyoneOvr) { allow |= everyoneOvr.allow || 0; deny |= everyoneOvr.deny || 0; }

  const roleOverrides = overrides.filter((o: any) => o.targetType === 'role' && roleIds.includes(o.targetId));
  roleOverrides.sort((a: any, b: any) => (a.position || 0) - (b.position || 0));
  for (const ovr of roleOverrides) { allow |= (ovr.allow || 0); deny |= (ovr.deny || 0); }

  const userOvr = overrides.find((o: any) => o.targetType === 'user' && o.targetId === userId);
  if (userOvr) { allow |= (userOvr.allow || 0); deny |= (userOvr.deny || 0); }

  return (basePerms & ~deny) | allow;
}

// ── ROLE HIERARCHY CHECK ──────────────────────────────────────
export async function canActOn(actorId: string, targetId: string, serverId: string): Promise<boolean> {
  const server = await Servers.findById(serverId);
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
    const roles = await Roles.findWhere({ _id: { $in: roleIds }, serverId } as any);
    return Math.max(0, ...roles.map((r: any) => r.position || 0));
  };

  const [actorTop, targetTop] = await Promise.all([
    getTopPosition(actorMem.roles as string[] || []),
    getTopPosition(targetMem.roles as string[] || []),
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

export function validateBitmask(allow: number, deny: number): BitmaskResult {
  if (typeof allow !== 'number' || !Number.isInteger(allow) || allow < 0)
    return { ok: false, error: 'allow geçerli bir tam sayı olmalı (>= 0)' };
  if (typeof deny !== 'number' || !Number.isInteger(deny) || deny < 0)
    return { ok: false, error: 'deny geçerli bir tam sayı olmalı (>= 0)' };
  if ((allow & ~VALID_BITS) !== 0)
    return { ok: false, error: `allow geçersiz bit içeriyor: 0x${(allow & ~VALID_BITS).toString(16)}` };
  if ((deny & ~VALID_BITS) !== 0)
    return { ok: false, error: `deny geçersiz bit içeriyor: 0x${(deny & ~VALID_BITS).toString(16)}` };
  if ((allow & deny) !== 0)
    return { ok: false, error: 'allow ve deny aynı anda aynı biti içeremez' };
  return { ok: true };
}

// CommonJS compat (eski require('./permissions') çağrıları için)
module.exports = {
  PERMS, VALID_BITS, DEFAULT_PERMISSIONS,
  hasPermission, hasAnyPermission, hasAllPermissions,
  resolvePermissions, canActOn, logAudit, validateBitmask,
};
