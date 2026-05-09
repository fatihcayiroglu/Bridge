// server/lib/userUtils.ts
'use strict';

export interface SafeUser {
  id: string;
  username: string;
  displayName?: string;
  avatarColor?: string;
  avatarUrl: string | null;
  status?: string;
  bio: string;
  website: string;
  location: string;
  pronouns: string;
  bannerColor: string;
  bannerUrl: string | null;
  badge: string;
  isAdmin?: true;
}

export function sanitizeUser(u: any): SafeUser | null {
  if (!u) return null;
  return {
    id:          u._id,
    username:    u.username,
    displayName: u.displayName,
    avatarColor: u.avatarColor,
    avatarUrl:   u.avatarUrl    || null,
    status:      u.status,
    bio:         u.bio          || '',
    website:     u.website      || '',
    location:    u.location     || '',
    pronouns:    u.pronouns     || '',
    bannerColor: u.bannerColor  || '',
    bannerUrl:   u.bannerUrl    || null,
    badge:       u.badge        || '',
    isAdmin:     u.isAdmin      ? true : undefined,
  };
}

module.exports = { sanitizeUser };
