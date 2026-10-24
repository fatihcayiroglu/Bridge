// P7 C4 — owner import logic: parsing, mapping, request shapes, honest outcomes.
import { describe, it, expect } from 'vitest';
import {
  APPLY_CONFIRMATION, APPROVAL_CONFIRMATION, MAX_BUNDLE_BYTES, applyBody, approvalBody, candidates,
  canonicalOrigin, classify, mappingProblem, mappingRowLabels, parseSignedBundle, renames, reviewBody, structureRows, suggestLinks,
  type Links,
} from '../js/core/server-settings/portable-community-import.ts';

const H = (c: string) => c.repeat(64);
function sourceStructure() {
  return {
    format: 'bridge-portable-community-structure', version: 1,
    categories: [{ sourceId: 'sc1', name: 'OPS', position: 0, collapsed: true }],
    roles: [{ sourceId: 'sr1', name: 'Crew', color: '#336699', position: 1, permissions: 256 }],
    channels: [
      { sourceId: 'sch1', name: 'general', type: 'text', order: 1 },
      { sourceId: 'sch2', name: 'lounge', type: 'voice', order: 2 },
    ],
    integrity: { digest: H('a') },
  };
}
function bundleText(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    structure: sourceStructure(),
    permissions: { channels: [], integrity: { digest: H('b') } },
    attestation: {
      sourceOrigin: 'https://source.example', sourceServerId: 'src-1', keyFingerprint: H('c'),
      issuedAt: '2026-10-14T10:00:00.000Z', expiresAt: '2026-10-14T10:05:00.000Z', signature: 'sig',
    },
    writesPerformed: false,
    ...overrides,
  });
}
const target = () => structureRows({
  categories: [{ sourceId: 'tc1', name: 'Old', position: 0 }],
  roles: [{ sourceId: 'tr1', name: 'crew', position: 1, permissions: 256 }, { sourceId: 'tr2', name: 'Other', position: 2, permissions: 0 }],
  channels: [
    { sourceId: 'tch1', name: 'general', type: 'text', order: 1 },
    { sourceId: 'tch2', name: 'general', type: 'voice', order: 2 },
    { sourceId: 'tch3', name: 'chat', type: 'voice', order: 3 },
  ],
  integrity: { digest: H('d') },
})!;

describe('signed bundle parsing', () => {
  it('keeps only the three signed documents and exposes the source claims as claims', () => {
    const b = parseSignedBundle(bundleText({ extra: 'dropped' }))!;
    expect(Object.keys(b).sort()).toEqual(['attestation', 'claimed', 'permissions', 'permissionsDigest', 'rows', 'structure']);
    expect(b.claimed).toEqual({
      origin: 'https://source.example', serverId: 'src-1', keyFingerprint: H('c'),
      issuedAt: '2026-10-14T10:00:00.000Z', expiresAt: '2026-10-14T10:05:00.000Z',
    });
    expect(b.rows.channels.map(c => c.type)).toEqual(['text', 'voice']);
  });

  it('refuses malformed, incomplete, duplicated and oversized files', () => {
    expect(parseSignedBundle('not json')).toBeNull();
    expect(parseSignedBundle(bundleText({ attestation: undefined }))).toBeNull();
    const dup = sourceStructure();
    dup.channels[1]!.sourceId = 'sch1';
    expect(parseSignedBundle(bundleText({ structure: dup }))).toBeNull();
    expect(parseSignedBundle(bundleText({ permissions: { integrity: { digest: 'short' } } }))).toBeNull();
    expect(parseSignedBundle('x'.repeat(MAX_BUNDLE_BYTES + 1))).toBeNull();
  });
});

describe('structure validation', () => {
  const valid = () => sourceStructure();

  it('refuses a structure whose lists or digest are not what the server signs', () => {
    expect(structureRows(null)).toBeNull();
    expect(structureRows([])).toBeNull();
    expect(structureRows({ ...valid(), integrity: { digest: 'A'.repeat(64) } })).toBeNull();   // not lowercase hex
    expect(structureRows({ ...valid(), integrity: { digest: H('a') + 'a' } })).toBeNull();     // too long
    expect(structureRows({ ...valid(), roles: { sr1: 'Crew' } })).toBeNull();                  // not a list
    const tooMany = Array.from({ length: 501 }, (_, i) => ({ sourceId: `c${i}`, name: 'x', type: 'text' }));
    expect(structureRows({ ...valid(), channels: tooMany })).toBeNull();
    expect(structureRows({ ...valid(), channels: tooMany.slice(0, 500) })?.channels).toHaveLength(500);
  });

  it('refuses rows without a usable identity, name or channel type', () => {
    const withChannel = (channel: unknown) => structureRows({ ...valid(), channels: [channel] });
    expect(withChannel({ sourceId: '', name: 'general', type: 'text' })).toBeNull();
    expect(withChannel({ sourceId: 'x'.repeat(257), name: 'general', type: 'text' })).toBeNull();
    expect(withChannel({ sourceId: 'sch1', name: 7, type: 'text' })).toBeNull();
    expect(withChannel({ sourceId: 'sch1', name: 'n'.repeat(201), type: 'text' })).toBeNull();
    expect(withChannel({ sourceId: 'sch1', name: 'general' })).toBeNull();
    expect(withChannel('general')).toBeNull();
  });

  it('keeps optional ordering and permission fields only when they are numbers', () => {
    const rows = structureRows({
      ...valid(),
      categories: [{ sourceId: 'sc1', name: 'OPS', position: '0' }],
      roles: [{ sourceId: 'sr1', name: 'Crew', position: 1, permissions: '256' }],
      channels: [{ sourceId: 'sch1', name: 'general', type: 'text', order: 'first' }],
    })!;
    expect(rows.categories[0]).toEqual({ sourceId: 'sc1', name: 'OPS' });
    expect(rows.roles[0]).toEqual({ sourceId: 'sr1', name: 'Crew', position: 1 });
    expect(rows.channels[0]).toEqual({ sourceId: 'sch1', name: 'general', type: 'text' });
  });
});

describe('owner-entered expectations and mapping', () => {
  it('accepts only canonical https origins', () => {
    expect(canonicalOrigin('https://source.example')).toBe('https://source.example');
    expect(canonicalOrigin('https://source.example:8443')).toBe('https://source.example:8443');
    for (const bad of ['http://source.example', 'https://source.example/', 'https://source.example/x', 'https://u:p@source.example', 'source.example']) {
      expect(canonicalOrigin(bad)).toBeNull();
    }
  });

  it('pre-selects only unambiguous same-kind, same-type name matches', () => {
    const b = parseSignedBundle(bundleText())!;
    const links = suggestLinks(b.rows, target());
    expect(links.roles).toEqual({ sr1: 'tr1' });           // case-insensitive unique match
    expect(links.channels).toEqual({ sch1: 'tch1' });      // "general" voice does not match a text channel
    expect(links.categories).toEqual({});                  // no name match: the owner decides
    expect(candidates('channels', b.rows.channels[1]!, target()).map(r => r.sourceId)).toEqual(['tch2', 'tch3']);
  });

  it('labels colliding names with exact opaque IDs without mutating the signed rows', () => {
    const rows = structureRows({ ...sourceStructure(), roles: [
      { sourceId: '__proto__', name: 'Crew', position: 1 },
      { sourceId: 'other-role', name: ' crew ', position: 2 },
      { sourceId: 'unique-role', name: 'Readers', position: 3 },
    ] })!;
    const original = JSON.stringify(rows);
    const labels = mappingRowLabels(rows);
    expect(labels.roles.get('__proto__')).toContain('__proto__');
    expect(labels.roles.get('other-role')).toContain('other-role');
    expect(labels.roles.get('unique-role')).toBe('Readers');
    expect(JSON.stringify(rows)).toBe(original);
  });

  it('maps opaque source IDs that collide with Object.prototype instead of reading inherited keys', () => {
    const source = structureRows({
      ...sourceStructure(),
      categories: [{ sourceId: 'constructor', name: 'OPS', position: 0 }],
      roles: [{ sourceId: '__proto__', name: 'Crew', position: 1 }],
      channels: [{ sourceId: 'toString', name: 'general', type: 'text', order: 1 }],
    })!;
    const destination = structureRows({
      ...target(),
      categories: [{ sourceId: 'tc1', name: 'OPS' }],
      roles: [{ sourceId: 'tr1', name: 'Crew' }],
      channels: [{ sourceId: 'tch1', name: 'general', type: 'text' }],
    })!;
    const selected = suggestLinks(source, destination);
    expect(Object.prototype.hasOwnProperty.call(selected.categories, 'constructor')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(selected.roles, '__proto__')).toBe(true);
    expect(Object.prototype.hasOwnProperty.call(selected.channels, 'toString')).toBe(true);
    expect(selected.categories['constructor']).toBe('tc1');
    expect(selected.roles['__proto__']).toBe('tr1');
    expect(selected.channels['toString']).toBe('tch1');
    expect(mappingProblem(source, destination, selected)).toBeNull();
    expect(reviewBody({
      bundle: { ...parseSignedBundle(bundleText())!, rows: source },
      expectedOrigin: 'https://source.example', expectedServerId: 'src-1',
      targetServerId: 'dst-1', targetDigest: H('d'), links: selected,
    }).mapping).toMatchObject({
      categories: [{ sourceId: 'constructor', targetId: 'tc1' }],
      roles: [{ sourceId: '__proto__', targetId: 'tr1' }],
      channels: [{ sourceId: 'toString', targetId: 'tch1' }],
    });
    // The default Object.prototype is not a source of implicit selections.
    const empty: Links = { categories: {}, roles: {}, channels: {} };
    expect(mappingProblem(source, destination, empty)).toBe('unmapped');
  });

  it('requires every source row mapped once onto a row of the same type', () => {
    const b = parseSignedBundle(bundleText())!;
    const t = target();
    const links: Links = { categories: { sc1: 'tc1' }, roles: { sr1: 'tr1' }, channels: { sch1: 'tch1' } };
    expect(mappingProblem(b.rows, t, links)).toBe('unmapped');
    expect(mappingProblem(b.rows, t, { ...links, channels: { sch1: 'tch1', sch2: 'tch1' } })).toBe('duplicate');
    expect(mappingProblem(b.rows, t, { ...links, channels: { sch1: 'tch2', sch2: 'tch3' } })).toBe('type');
    expect(mappingProblem(b.rows, t, { ...links, channels: { sch1: 'tch1', sch2: 'tch3' } })).toBeNull();
  });
});

describe('request shapes', () => {
  const b = parseSignedBundle(bundleText({ extra: 'never sent' }))!;
  const input = {
    bundle: b, expectedOrigin: 'https://source.example', expectedServerId: 'src-1',
    targetServerId: 'dst-1', targetDigest: H('e'),
    links: { categories: { sc1: 'tc1' }, roles: { sr1: 'tr1' }, channels: { sch1: 'tch1', sch2: 'tch3' } },
  };

  it('review, approval and apply bodies carry exactly the server allow-listed keys', () => {
    const review = reviewBody(input);
    expect(Object.keys(review).sort()).toEqual(['attestation', 'expectedSourceOrigin', 'expectedSourceServerId', 'mapping', 'permissions', 'structure', 'targetServerId']);
    expect(Object.keys(review.mapping).sort()).toEqual(['categories', 'channels', 'expectedTargetDigest', 'permissionsDigest', 'roles', 'structureDigest', 'targetServerId']);
    expect(review.mapping).toMatchObject({
      targetServerId: 'dst-1', structureDigest: H('a'), permissionsDigest: H('b'), expectedTargetDigest: H('e'),
      channels: [{ sourceId: 'sch1', targetId: 'tch1' }, { sourceId: 'sch2', targetId: 'tch3' }],
    });
    expect(JSON.stringify(review)).not.toContain('never sent');
    const approval = approvalBody(input, H('f'));
    expect(approval).toMatchObject({ confirmedReviewFingerprint: H('f'), confirmation: APPROVAL_CONFIRMATION });
    expect(approval).not.toHaveProperty('approvalToken');
    const apply = applyBody(input, H('f'), 'T'.repeat(43));
    expect(apply).toMatchObject({ confirmation: APPLY_CONFIRMATION, approvalToken: 'T'.repeat(43) });
    expect(Object.keys(apply)).toHaveLength(10);
  });

  it('lists the labels that would be renamed', () => {
    expect(renames(b.rows, target(), input.links)).toEqual([
      { kind: 'categories', from: 'Old', to: 'OPS' },
      { kind: 'roles', from: 'crew', to: 'Crew' },
      { kind: 'channels', from: 'chat', to: 'lounge' },
    ]);
  });
});

describe('honest outcomes', () => {
  it('never infers rollback from the opaque apply error used for unknown COMMIT acknowledgement', () => {
    expect(classify('apply', 422, 'PORTABLE_MAPPED_APPLY_UNAVAILABLE')).toBe('unknown');
    expect(classify('review', 422, 'PORTABLE_MAPPED_APPLY_UNAVAILABLE')).toBe('unverified');
    expect(classify('approve', 422, 'PORTABLE_MAPPED_APPLY_UNAVAILABLE')).toBe('refused');
  });

  it('maps statuses without ever reporting an unknown apply as a failure', () => {
    expect(classify('apply', 0, undefined)).toBe('unknown');
    expect(classify('approve', 0, undefined)).toBe('error');
    expect(classify('review', 503, 'X')).toBe('disabled');
    expect(classify('approve', 403, 'STEP_UP_REQUIRED')).toBe('proof_needed');
    expect(classify('approve', 403, 'Only owner')).toBe('not_owner');
    expect(classify('review', 422, 'X')).toBe('unverified');
    expect(classify('apply', 422, 'X')).toBe('refused');
    expect(classify('apply', 400, 'X')).toBe('invalid');
    expect(classify('apply', 500, 'X')).toBe('error');
  });
});
