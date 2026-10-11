// P7 C1: a deliberately small, portable identity snapshot, NOT a complete
// personal-data archive and NOT an import/restore implementation.
//
// Every field is positively listed. Newly introduced database secrets must
// never silently appear here. An unkeyed digest detects accidental corruption,
// but does not authenticate the exporting server.
import { createHash, timingSafeEqual } from 'node:crypto';
import { sanitizeDisplayName } from './displayName';

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


/**
 * P7 C3 phase 1: verify a v1 document and preview a mapping.
 * This deliberately has NO import/write side effects.
 */
export class PortableIdentityValidationError extends Error {
  readonly code = 'PORTABLE_IDENTITY_INVALID';
  constructor(reason: string) {
    super(reason);
    this.name = 'PortableIdentityValidationError';
  }
}

const MAX_PORTABLE_BYTES = 16 * 1024;
export const PORTABLE_IDENTITY_MAX_BYTES = MAX_PORTABLE_BYTES;

const requireObject = (input: unknown, label: string): Record<string, unknown> => {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new PortableIdentityValidationError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
};

const exactKeys = (value: Record<string, unknown>, keys: readonly string[], label: string): void => {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw new PortableIdentityValidationError(`${label} fields do not match the supported v1 schema`);
  }
};

const safeString = (value: unknown, limit: number, label: string, required = false): string => {
  if (typeof value !== 'string' || value.length > limit || (required && !value.trim())) {
    throw new PortableIdentityValidationError(`${label} must be a valid string`);
  }
  return value;
};

const stringList = (value: unknown, label: string): void => {
  if (!Array.isArray(value) || value.length > 24 ||
    value.some((x) => typeof x !== 'string' || x.length > 256)) {
    throw new PortableIdentityValidationError(`${label} must be a bounded string list`);
  }
};

/** Reject extra properties, unsupported versions, corrupt checksums and overlarge files. */
export function validatePortableIdentityV1(input: unknown): PortableIdentityExport {
  const file = requireObject(input, 'document');
  if (Buffer.byteLength(JSON.stringify(file), 'utf8') > MAX_PORTABLE_BYTES) {
    throw new PortableIdentityValidationError('document exceeds 16 KiB');
  }
  exactKeys(file, ['format', 'version', 'exportedAt', 'identity', 'integrity', 'portability'], 'document');
  if (file.format !== 'bridge-portable-identity' || file.version !== 1) {
    throw new PortableIdentityValidationError('unsupported identity format or version');
  }
  const exportedAt = safeString(file.exportedAt, 40, 'exportedAt', true);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(exportedAt) ||
      !Number.isFinite(Date.parse(exportedAt)) ||
      new Date(exportedAt).toISOString() !== exportedAt) {
    throw new PortableIdentityValidationError('invalid exportedAt timestamp');
  }
  const identity = requireObject(file.identity, 'identity');
  exactKeys(identity, [
    'sourceUserId', 'username', 'displayName', 'bio',
    'website', 'pronouns', 'avatarColor', 'bannerColor',
  ], 'identity');
  const core: PortableIdentityCore = {
    format: 'bridge-portable-identity',
    version: 1,
    exportedAt,
    identity: {
      sourceUserId: safeString(identity.sourceUserId, 128, 'sourceUserId', true),
      username: safeString(identity.username, 80, 'username', true),
      displayName: safeString(identity.displayName, 160, 'displayName'),
      bio: safeString(identity.bio, 4096, 'bio'),
      website: safeString(identity.website, 1024, 'website'),
      pronouns: safeString(identity.pronouns, 160, 'pronouns'),
      avatarColor: safeString(identity.avatarColor, 64, 'avatarColor'),
      bannerColor: safeString(identity.bannerColor, 64, 'bannerColor'),
    },
  };
  const integrity = requireObject(file.integrity, 'integrity');
  exactKeys(integrity, ['algorithm', 'encoding', 'canonicalization', 'digest'], 'integrity');
  if (integrity.algorithm !== 'sha256' || integrity.encoding !== 'utf8' ||
      integrity.canonicalization !== 'ordered-json-v1' ||
      typeof integrity.digest !== 'string' || !/^[0-9a-f]{64}$/.test(integrity.digest)) {
    throw new PortableIdentityValidationError('unsupported checksum format');
  }
  const actual = Buffer.from(integrity.digest, 'hex');
  const expected = Buffer.from(portableIdentityDigest(core), 'hex');
  // A checksum is not an authentication signature; timing-safe comparison
  // avoids revealing the expected digest by a trivial comparison timing leak.
  if (!timingSafeEqual(actual, expected)) {
    throw new PortableIdentityValidationError('profile checksum does not match');
  }
  const portability = requireObject(file.portability, 'portability');
  exactKeys(portability, ['importSupported', 'included', 'excluded', 'limitations'], 'portability');
  if (portability.importSupported !== false) {
    throw new PortableIdentityValidationError('unsupported import capability declaration');
  }
  stringList(portability.included, 'included');
  stringList(portability.excluded, 'excluded');
  stringList(portability.limitations, 'limitations');
  // A checksum-valid snapshot can still contain legacy/out-of-contract profile
  // values. Never preview them as importable if normal profile editing would
  // silently trim, truncate, sanitize or refuse those same values.
  validatePortableImportEligibility(core.identity);
  return file as unknown as PortableIdentityExport;
}

/**
 * P7 C3 applicability contract. Match the *effective* destination profile
 * setter, not only the wider transport-envelope limits above.
 *
 * Rejection is deliberate: a preview must never promise to apply values that
 * the normal /api/me PATCH would silently trim/sanitize/truncate. Existing
 * legacy exports remain downloadable; an unsupported legacy value must be
 * corrected at the source before import can be considered.
 */
export function validatePortableImportEligibility(identity: PortableIdentityCore['identity']): void {
  const fail = (field: string): never => {
    throw new PortableIdentityValidationError(`${field} cannot be applied losslessly to this Bridge profile`);
  };
  // server/routes/auth.ts calls this same canonical sanitizer for displayName.
  if (!identity.displayName || sanitizeDisplayName(identity.displayName) !== identity.displayName) fail('displayName');
  for (const [field, maxLength] of [
    ['bio', 180], ['website', 120], ['pronouns', 40],
  ] as const) {
    const value = identity[field];
    if (value.length > maxLength || value.trim() !== value) fail(field);
  }
  // Appearance travels as colors only; never turn a portable manifest into
  // arbitrary CSS, image references, usernames or mutable server-owned URLs.
  const hexColor = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
  for (const field of ['avatarColor', 'bannerColor'] as const) {
    if (identity[field] !== '' && !hexColor.test(identity[field])) fail(field);
  }
}

const PREVIEW_PROFILE_FIELDS = [
  'displayName', 'bio', 'website', 'pronouns', 'avatarColor', 'bannerColor',
] as const;

/** This is a READ-ONLY mapping plan. The source ID and username are never assigned. */
export function previewPortableIdentity(
  file: PortableIdentityExport,
  authenticatedUserId: string,
  target: Record<string, unknown>,
) {
  const fields = PREVIEW_PROFILE_FIELDS.map((field) => {
    const current = typeof target[field] === 'string' ? target[field] as string : '';
    const proposed = file.identity[field];
    return { field, current, proposed, changed: current !== proposed };
  });
  return {
    ok: true as const,
    dryRun: true as const,
    applied: false as const,
    format: file.format,
    version: file.version,
    checksumVerified: true as const,
    mapping: {
      sourceUserId: file.identity.sourceUserId,
      targetUserId: authenticatedUserId,
      strategy: 'map-to-authenticated-account' as const,
    },
    fields,
    unsupportedFields: [
      'username: existing destination username is preserved',
      'sourceUserId: never reused as a destination primary key',
      'email, credentials, contacts, media and community data are not imported',
    ],
  };
}
