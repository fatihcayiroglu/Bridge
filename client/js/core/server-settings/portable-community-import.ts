// client/js/core/server-settings/portable-community-import.ts
//
// P7 C4 — the owner-facing side of the portable community import. Pure,
// DOM-free logic so the security-relevant decisions are unit tested:
//   · a signed bundle is parsed defensively and its source claims are shown
//     as CLAIMS; trust is decided by the destination's operator-pinned keys,
//     never by this client;
//   · the expected source origin and community are typed by the owner, not
//     copied from the file, so a bundle for another community is refused;
//   · every source row must be mapped one-to-one onto an existing row of the
//     same kind (and channel type) — nothing is created;
//   · request bodies carry exactly the server's allow-listed keys;
//   · the approval token stays in memory, and failures map to honest states
//     (including "outcome unknown" when the connection dropped).

export const MAX_BUNDLE_BYTES = 1024 * 1024;
export const APPROVAL_CONFIRMATION = 'CONFIRM_SIGNED_MAPPING_AND_PERMISSION_CONSEQUENCES';
export const APPLY_CONFIRMATION = 'APPLY_MAPPED_PORTABLE_METADATA_ONLY';

export type Kind = 'categories' | 'roles' | 'channels';
export const KINDS: readonly Kind[] = ['categories', 'roles', 'channels'];

export interface PortableRow {
  sourceId: string;
  name: string;
  type?: string;
  position?: number;
  order?: number;
  permissions?: number;
}
export interface PortableStructure {
  categories: PortableRow[];
  roles: PortableRow[];
  channels: PortableRow[];
  integrity: { digest: string };
}
export interface SignedBundle {
  structure: Record<string, unknown>;
  permissions: Record<string, unknown>;
  attestation: Record<string, unknown>;
  rows: PortableStructure;
  permissionsDigest: string;
  claimed: { origin: string; serverId: string; issuedAt: string; expiresAt: string; keyFingerprint: string };
}
export type Links = Record<Kind, Record<string, string>>;

const HEX64 = /^[0-9a-f]{64}$/;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function text(value: unknown, max = 256): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function rows(value: unknown, kind: Kind): PortableRow[] | null {
  if (!Array.isArray(value) || value.length > (kind === 'channels' ? 500 : 2000)) return null;
  const out: PortableRow[] = [];
  const seen = new Set<string>();
  for (const raw of value) {
    const r = record(raw);
    const sourceId = text(r?.sourceId);
    if (!r || !sourceId || seen.has(sourceId) || typeof r.name !== 'string' || r.name.length > 200) return null;
    seen.add(sourceId);
    const row: PortableRow = { sourceId, name: r.name };
    if (kind === 'channels') {
      if (typeof r.type !== 'string') return null;
      row.type = r.type;
      if (typeof r.order === 'number') row.order = r.order;
    } else if (typeof r.position === 'number') row.position = r.position;
    if (kind === 'roles' && typeof r.permissions === 'number') row.permissions = r.permissions;
    out.push(row);
  }
  return out;
}

/** The three rows lists and digest from a portable structure document, or null. */
export function structureRows(value: unknown): PortableStructure | null {
  const s = record(value);
  const digest = text(record(s?.integrity)?.digest, 64);
  if (!s || !digest || !HEX64.test(digest)) return null;
  const categories = rows(s.categories, 'categories');
  const roles = rows(s.roles, 'roles');
  const channels = rows(s.channels, 'channels');
  if (!categories || !roles || !channels) return null;
  return { categories, roles, channels, integrity: { digest } };
}

/** Parse a downloaded signed source bundle. Its claims are NOT trusted here. */
export function parseSignedBundle(content: string): SignedBundle | null {
  if (typeof content !== 'string' || content.length === 0 || new TextEncoder().encode(content).length > MAX_BUNDLE_BYTES) return null;
  let doc: unknown;
  try { doc = JSON.parse(content); } catch { return null; }
  const d = record(doc);
  const structure = record(d?.structure);
  const permissions = record(d?.permissions);
  const attestation = record(d?.attestation);
  if (!structure || !permissions || !attestation) return null;
  const parsed = structureRows(structure);
  const permissionsDigest = text(record(permissions.integrity)?.digest, 64);
  const origin = text(attestation.sourceOrigin, 512);
  const serverId = text(attestation.sourceServerId);
  const issuedAt = text(attestation.issuedAt, 40);
  const expiresAt = text(attestation.expiresAt, 40);
  const keyFingerprint = text(attestation.keyFingerprint, 64);
  if (!parsed || !permissionsDigest || !HEX64.test(permissionsDigest) || !origin || !serverId ||
      !issuedAt || !expiresAt || !keyFingerprint) return null;
  // Only the three signed documents travel on; anything else in the file is dropped.
  return {
    structure, permissions, attestation, rows: parsed, permissionsDigest,
    claimed: { origin, serverId, issuedAt, expiresAt, keyFingerprint },
  };
}

/** A canonical HTTPS origin, exactly as the server requires it. */
export function canonicalOrigin(value: string): string | null {
  const v = value.trim();
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && u.origin === v && !u.username && !u.password ? v : null;
  } catch { return null; }
}

function mappingNameKey(name: string): string { return name.trim().toLocaleLowerCase(); }

/** Name collisions need a visible identity; these labels never authorize a mapping. */
export function mappingRowLabels(structure: PortableStructure): Record<Kind, Map<string, string>> {
  const labels = { categories: new Map<string, string>(), roles: new Map<string, string>(), channels: new Map<string, string>() };
  for (const kind of KINDS) {
    const counts = new Map<string, number>();
    for (const row of structure[kind]) {
      const key = mappingNameKey(row.name);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const row of structure[kind]) {
      labels[kind].set(row.sourceId, (counts.get(mappingNameKey(row.name)) ?? 0) > 1
        ? `${row.name} · ${row.sourceId}` : row.name);
    }
  }
  return labels;
}

/**
 * Pre-select a target only where the choice is unambiguous: exactly one
 * destination row of the same kind (and channel type) with the same name.
 * Everything else is left for the owner to choose.
 */
export function suggestLinks(source: PortableStructure, target: PortableStructure): Links {
  const links: Links = { categories: {}, roles: {}, channels: {} };
  for (const kind of KINDS) {
    const used = new Set<string>();
    for (const row of source[kind]) {
      const matches = target[kind].filter(t =>
        mappingNameKey(t.name) === mappingNameKey(row.name) && (kind !== 'channels' || t.type === row.type));
      if (matches.length === 1 && !used.has(matches[0]!.sourceId)) {
        links[kind][row.sourceId] = matches[0]!.sourceId;
        used.add(matches[0]!.sourceId);
      }
    }
  }
  return links;
}

/** Destination rows the owner may pick for one source row. */
export function candidates(kind: Kind, row: PortableRow, target: PortableStructure): PortableRow[] {
  return target[kind].filter(t => kind !== 'channels' || t.type === row.type);
}

/** Why the mapping cannot be reviewed yet, or null when it is complete. */
export function mappingProblem(source: PortableStructure, target: PortableStructure, links: Links):
  'unmapped' | 'duplicate' | 'type' | null {
  for (const kind of KINDS) {
    const chosen = new Set<string>();
    for (const row of source[kind]) {
      const id = links[kind][row.sourceId];
      if (!id) return 'unmapped';
      if (chosen.has(id)) return 'duplicate';
      chosen.add(id);
      const t = target[kind].find(x => x.sourceId === id);
      if (!t || (kind === 'channels' && t.type !== row.type)) return 'type';
    }
  }
  return null;
}

export interface ReviewInput {
  bundle: SignedBundle;
  expectedOrigin: string;
  expectedServerId: string;
  targetServerId: string;
  targetDigest: string;
  links: Links;
}

/** The exact seven-key mapping object the server reviews and binds. */
export function mappingBody(input: ReviewInput) {
  const list = (kind: Kind) => input.bundle.rows[kind].map(r => ({ sourceId: r.sourceId, targetId: input.links[kind][r.sourceId]! }));
  return {
    targetServerId: input.targetServerId,
    structureDigest: input.bundle.rows.integrity.digest,
    permissionsDigest: input.bundle.permissionsDigest,
    expectedTargetDigest: input.targetDigest,
    categories: list('categories'),
    roles: list('roles'),
    channels: list('channels'),
  };
}

export function reviewBody(input: ReviewInput) {
  return {
    structure: input.bundle.structure,
    permissions: input.bundle.permissions,
    attestation: input.bundle.attestation,
    expectedSourceOrigin: input.expectedOrigin,
    expectedSourceServerId: input.expectedServerId,
    targetServerId: input.targetServerId,
    mapping: mappingBody(input),
  };
}

export function approvalBody(input: ReviewInput, reviewFingerprint: string) {
  return { ...reviewBody(input), confirmedReviewFingerprint: reviewFingerprint, confirmation: APPROVAL_CONFIRMATION };
}

export function applyBody(input: ReviewInput, reviewFingerprint: string, approvalToken: string) {
  return { ...reviewBody(input), confirmedReviewFingerprint: reviewFingerprint, confirmation: APPLY_CONFIRMATION, approvalToken };
}

export interface ChangeRow { kind: Kind; from: string; to: string }

/** Labels the apply would rename; every other mapped row keeps its name. */
export function renames(source: PortableStructure, target: PortableStructure, links: Links): ChangeRow[] {
  const out: ChangeRow[] = [];
  for (const kind of KINDS) {
    for (const row of source[kind]) {
      const t = target[kind].find(x => x.sourceId === links[kind][row.sourceId]);
      if (t && t.name !== row.name) out.push({ kind, from: t.name, to: row.name });
    }
  }
  return out;
}

export type Phase = 'export' | 'target' | 'review' | 'approve' | 'apply';
export type Outcome =
  | 'disabled' | 'not_owner' | 'proof_needed' | 'unverified' | 'refused'
  | 'invalid' | 'unknown' | 'error';

/**
 * Map an HTTP result to an honest state. `status` 0 means no response
 * arrived: for apply that is "outcome unknown", never "failed".
 */
export function classify(phase: Phase, status: number, code: unknown): Outcome {
  if (status === 0) return phase === 'apply' ? 'unknown' : 'error';
  // The server intentionally uses one opaque error for rollback and unknown
  // COMMIT acknowledgement. This answer cannot prove that nothing was applied.
  if (phase === 'apply' && status === 422 && code === 'PORTABLE_MAPPED_APPLY_UNAVAILABLE') return 'unknown';
  if (status === 503) return 'disabled';
  if (status === 403) return code === 'STEP_UP_REQUIRED' ? 'proof_needed' : 'not_owner';
  if (status === 400) return 'invalid';
  if (status === 422) return phase === 'review' ? 'unverified' : 'refused';
  return 'error';
}
