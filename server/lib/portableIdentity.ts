// P7 C1: a deliberately small, portable identity snapshot, NOT a complete
// personal-data archive and NOT an import/restore implementation.
//
// Every field is positively listed. Newly introduced database secrets must
// never silently appear here. An unkeyed digest detects accidental corruption,
// but does not authenticate the exporting server.
import { createHash } from 'node:crypto';

export interface PortableIdentityCore {
  format: 'bridge-portable-identity';
  version: 1;
  exportedAt: string;
  identity: {
    sourceUserId: string;
    username: string;
    displayName: string;
    bio: string;
    website: string;
    pronouns: string;
    avatarColor: string;
    bannerColor: string;
  };
}

export interface PortableIdentityExport extends PortableIdentityCore {
  integrity: {
    algorithm: 'sha256';
    encoding: 'utf8';
    canonicalization: 'ordered-json-v1';
    digest: string;
  };
  portability: {
    importSupported: false;
    included: string[];
    excluded: string[];
    limitations: string[];
  };
}

const str = (value: unknown): string => typeof value === 'string' ? value : '';

/** Reconstruct the exact v1 integrity scope in fixed key order. */
export function portableIdentityCore(input: PortableIdentityCore): PortableIdentityCore {
  return {
    format: 'bridge-portable-identity',
    version: 1,
    exportedAt: input.exportedAt,
    identity: {
      sourceUserId: input.identity.sourceUserId,
      username: input.identity.username,
      displayName: input.identity.displayName,
      bio: input.identity.bio,
      website: input.identity.website,
      pronouns: input.identity.pronouns,
      avatarColor: input.identity.avatarColor,
      bannerColor: input.identity.bannerColor,
    },
  };
}

export function portableIdentityDigest(core: PortableIdentityCore): string {
  return createHash('sha256')
    .update(JSON.stringify(portableIdentityCore(core)), 'utf8')
    .digest('hex');
}

export function buildPortableIdentityExport(
  authenticatedUserId: string,
  user: Record<string, unknown>,
  exportedAt = new Date().toISOString(),
): PortableIdentityExport {
  const username = str(user.username);
  const core: PortableIdentityCore = {
    format: 'bridge-portable-identity',
    version: 1,
    exportedAt,
    identity: {
      sourceUserId: authenticatedUserId, // never accept a user-supplied subject
      username,
      displayName: str(user.displayName) || username,
      bio: str(user.bio),
      website: str(user.website),
      pronouns: str(user.pronouns),
      avatarColor: str(user.avatarColor),
      bannerColor: str(user.bannerColor),
    },
  };
  return {
    ...core,
    integrity: {
      algorithm: 'sha256',
      encoding: 'utf8',
      canonicalization: 'ordered-json-v1',
      digest: portableIdentityDigest(core),
    },
    portability: {
      importSupported: false,
      included: ['portable profile text and appearance', 'original Bridge account ID for mapping only'],
      excluded: [
        'password and password hashes', '2FA secrets and backup codes',
        'access/refresh/OAuth tokens', 'passkeys and private keys',
        'email address and verification state', 'location and presence',
        'messages, contacts, memberships and block lists',
        'server-local avatar/banner URLs', 'uploaded files',
      ],
      limitations: [
        'This file is a portable profile snapshot; it is not a complete personal-data export.',
        'sourceUserId must never be reused as a target instance database ID.',
        'SHA-256 detects accidental modifications; it is not a digital signature.',
        'Import, community topology transfer and credential migration are not yet supported.',
      ],
    },
  };
}
