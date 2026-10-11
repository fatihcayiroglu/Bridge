// P7 C3: the ONLY six writable fields of the v1 portable PROFILE (not a
// full-account/community importer). Keep in sync with the server allowlist.
// Never persist the imported document, preview or credentials in web storage.
export const PORTABLE_PROFILE_FIELDS = [
  'displayName', 'bio', 'website', 'pronouns', 'avatarColor', 'bannerColor',
] as const;

export type PortableProfileField = typeof PORTABLE_PROFILE_FIELDS[number];
export type PortableExpected = Record<PortableProfileField, string>;

export interface PortablePreviewField {
  field: PortableProfileField;
  current: string;
  proposed: string;
  changed: boolean;
}

export interface PortableProfilePreview {
  dryRun: true;
  applied: false;
  checksumVerified: true;
  mapping: { targetUserId: string; sourceUserId: string; strategy: 'map-to-authenticated-account' };
  fields: PortablePreviewField[];
}

export function portableAccountId(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const owner = value as { _id?: unknown; id?: unknown };
  const id = typeof owner._id === 'string' ? owner._id : owner.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
}

export function verifiedPortablePreview(input: unknown, authenticatedId: string): PortableProfilePreview | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const preview = input as Record<string, unknown>;
  if (preview.dryRun !== true || preview.applied !== false || preview.checksumVerified !== true) return null;
  const mapping = preview.mapping;
  if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) return null;
  const m = mapping as Record<string, unknown>;
  if (m.targetUserId !== authenticatedId || typeof m.sourceUserId !== 'string' ||
      !m.sourceUserId || m.strategy !== 'map-to-authenticated-account') return null;
  if (!Array.isArray(preview.fields) || preview.fields.length !== PORTABLE_PROFILE_FIELDS.length) return null;
  const seen = new Set<string>();
  for (const inputField of preview.fields) {
    if (!inputField || typeof inputField !== 'object' || Array.isArray(inputField)) return null;
    const f = inputField as Record<string, unknown>;
    if (typeof f.field !== 'string' || !PORTABLE_PROFILE_FIELDS.some(name => name === f.field) ||
        seen.has(f.field) || typeof f.current !== 'string' || typeof f.proposed !== 'string' ||
        typeof f.changed !== 'boolean' || f.changed !== (f.current !== f.proposed)) return null;
    seen.add(f.field);
  }
  return preview as unknown as PortableProfilePreview;
}

/** Positive-list the exact preview state; never trust user-editable form data. */
export function expectedFromPortablePreview(preview: PortableProfilePreview): PortableExpected {
  const expected = {} as PortableExpected;
  for (const name of PORTABLE_PROFILE_FIELDS) {
    expected[name] = preview.fields.find(field => field.field === name)!.current;
  }
  return expected;
}
