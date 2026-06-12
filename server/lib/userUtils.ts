// server/lib/userUtils.ts

export interface SafeUser {
  _id: string;
  id: string;
  username: string;
  displayName?: string;
  avatarColor?: string;
  avatarUrl: string | null;
  status?: string;
  statusText?: string;
  statusEmoji?: string;
  createdAt?: number;
  bio: string;
  website: string;
  location: string;
  pronouns: string;
  bannerColor: string;
  bannerUrl: string | null;
  badge?: string;
  isAdmin?: true;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function asOptionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function sanitizeUser(u: null | undefined): null;
export function sanitizeUser(u: object): SafeUser;
export function sanitizeUser(u: object | null | undefined): SafeUser | null {
  if (!u) return null;
  const row = u as Record<string, unknown>;
  return {
    _id:         asString(row._id),
    id:          asString(row._id),
    username:    asString(row.username),
    displayName: asOptionalString(row.displayName) ?? asString(row.username),
    avatarColor: asOptionalString(row.avatarColor),
    avatarUrl:   asNullableString(row.avatarUrl),
    status:      asOptionalString(row.status),
    statusText:   asOptionalString(row.statusText),
    statusEmoji:  asOptionalString(row.statusEmoji),
    createdAt:    typeof row.createdAt === 'number' ? row.createdAt : undefined,
    bio:         asString(row.bio),
    website:     asString(row.website),
    location:    asString(row.location),
    pronouns:    asString(row.pronouns),
    bannerColor: asString(row.bannerColor),
    bannerUrl:   asNullableString(row.bannerUrl),
    badge:       asOptionalString(row.badge),
    isAdmin:     row.isAdmin ? true : undefined,
  };
}
