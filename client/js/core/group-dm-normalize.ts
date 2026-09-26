// Canonical normalization boundary for untrusted Group DM API/socket payloads.
// Keeping this pure lets the Svelte owner focus on lifecycle and interaction.

export interface GdmMember {
  _id?: string;
  id?: string;
  displayName: string;
  avatarColor: string;
  username?: string;
}

export interface GdmGroup {
  _id: string;
  name: string;
  icon?: string;
  ownerId?: string;
  memberCount?: number;
  members?: GdmMember[];
  lastMessage?: { content?: string };
  unreadCount?: number;
}

export interface GdmMessage {
  _key: string;
  _id?: string;
  groupId?: string;
  userId?: string;
  displayName: string;
  avatarColor: string;
  content: string;
  createdAt: string | number;
  type?: string;
  clientNonce?: string;
  pending?: boolean;
  failed?: boolean;
  lastError?: string;
}

export type ColorNormalizer = (value: string) => string;

export function normalizedText(value: unknown, maxLength: number, fallback = ''): string {
  if (typeof value !== 'string') return fallback;
  return value.trim().slice(0, maxLength) || fallback;
}

export function normalizedCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? Math.min(value, 2_147_483_647)
    : 0;
}

export function normalizeGdmMember(value: unknown, color: ColorNormalizer): GdmMember | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const rawId = normalizedText(raw._id, 128);
  const legacyId = normalizedText(raw.id, 128);
  const id = rawId || legacyId;
  if (!id) return null;
  return {
    _id: rawId || undefined,
    id: legacyId || undefined,
    displayName: normalizedText(raw.displayName, 120, normalizedText(raw.username, 80, 'Bridge user')),
    username: normalizedText(raw.username, 80) || undefined,
    avatarColor: color(normalizedText(raw.avatarColor, 32)),
  };
}

export function normalizeGdmGroup(value: unknown, color: ColorNormalizer): GdmGroup | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const id = normalizedText(raw._id, 128);
  if (!id) return null;
  // TEKİLLEŞTİRMEDE İLK KAYIT KAZANIR.
  // `new Map(entries)` aynı anahtar için SON değeri tutar; bu yüzden aynı
  // kullanıcıyı ikinci kez taşıyan eksik bir kayıt (`{ id: 'u1' }`) ilkinin
  // dolu alanlarını (`_id`, `displayName`, renk) EZİYORDU — sonuçta
  // `_id: undefined` olan bir üye üretiliyordu. Kardeş fonksiyon
  // `normalizeGdmGroups` zaten ilk kaydı koruyor; iki tekilleştirme aynı
  // kuralı izlemelidir.
  const members = Array.isArray(raw.members)
    ? (() => {
      const unique = new Map<string, GdmMember>();
      for (const candidate of raw.members) {
        const member = normalizeGdmMember(candidate, color);
        if (!member) continue;
        const key = member._id ?? member.id!;
        if (!unique.has(key)) unique.set(key, member);
      }
      return [...unique.values()];
    })()
    : undefined;
  const lastMessage = raw.lastMessage && typeof raw.lastMessage === 'object' && !Array.isArray(raw.lastMessage)
    ? { content: normalizedText((raw.lastMessage as Record<string, unknown>).content, 2_000) || undefined }
    : undefined;
  return {
    _id: id,
    name: normalizedText(raw.name, 64, 'Group DM'),
    icon: normalizedText(raw.icon, 8) || undefined,
    ownerId: normalizedText(raw.ownerId, 128) || undefined,
    memberCount: typeof raw.memberCount === 'number' ? normalizedCount(raw.memberCount) : undefined,
    members,
    lastMessage,
    unreadCount: typeof raw.unreadCount === 'number' ? normalizedCount(raw.unreadCount) : undefined,
  };
}

export function normalizeGdmGroups(value: unknown, color: ColorNormalizer): GdmGroup[] {
  if (!Array.isArray(value)) return [];
  const unique = new Map<string, GdmGroup>();
  for (const candidate of value) {
    const group = normalizeGdmGroup(candidate, color);
    if (group && !unique.has(group._id)) unique.set(group._id, group);
  }
  return [...unique.values()];
}

export function normalizeGdmMessages(value: unknown, groupId: string, color: ColorNormalizer): GdmMessage[] {
  if (!Array.isArray(value)) return [];
  const result: GdmMessage[] = [];
  const ids = new Set<string>();
  value.forEach((candidate, index) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return;
    const raw = candidate as Record<string, unknown>;
    if (typeof raw.content !== 'string') return;
    const id = normalizedText(raw._id, 128);
    if (id && ids.has(id)) return;
    if (id) ids.add(id);
    const createdAt = typeof raw.createdAt === 'string' || typeof raw.createdAt === 'number' ? raw.createdAt : 0;
    result.push({
      _key: id || `history:${groupId}:${index}`,
      _id: id || undefined,
      groupId: normalizedText(raw.groupId, 128, groupId),
      userId: normalizedText(raw.userId, 128) || undefined,
      displayName: normalizedText(raw.displayName, 120, 'Bridge user'),
      avatarColor: color(normalizedText(raw.avatarColor, 32)),
      content: raw.content.slice(0, 2_000),
      createdAt,
      type: raw.type === 'system' ? 'system' : undefined,
      clientNonce: normalizedText(raw.clientNonce, 64) || undefined,
      pending: raw.pending === true,
      failed: raw.failed === true,
      lastError: normalizedText(raw.lastError, 240) || undefined,
    });
  });
  return result;
}
