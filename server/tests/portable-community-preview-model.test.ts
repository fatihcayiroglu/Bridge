import { buildPortableCommunityStructure } from '../lib/portableCommunity';
import { buildPortableCommunityPreview } from '../lib/portableCommunityPreview';

const target = {
  serverId: 'target-1', name: 'Destination',
  categories: [] as Array<Record<string, unknown>>,
  channels: [] as Array<Record<string, unknown>>,
  roles: [] as Array<Record<string, unknown>>,
};
const snapshot = (categories: Array<{ _id: string; name: string; position: number }> = []) =>
  buildPortableCommunityStructure(
    { _id: 'source-1', name: 'Source' }, categories, [], [],
    '2026-10-11T12:00:00.000Z',
  );

describe('P7 C3 collision report completeness and nonclaims', () => {
  it('reports normalized name collisions without assuming IDs are interchangeable', () => {
    const doc = snapshot([{ _id: 'source-cat', name: 'Ｗｅｌｃｏｍｅ', position: 0 }]);
    const preview = buildPortableCommunityPreview(doc, {
      ...target, categories: [{ _id: 'existing-id', name: 'welcome' }],
    });
    expect(preview.conflicts).toMatchObject({
      total: 1, truncated: false,
      items: [{ kind: 'category', sourceId: 'source-cat', targetIds: ['existing-id'], reason: 'TARGET_NAME_EXISTS' }],
    });
    expect(preview.importSupported).toBe(false);
    expect(preview.writesPerformed).toBe(false);
  });

  it('caps the displayed details but preserves the true total and truncation marker', () => {
    const categories = Array.from({ length: 60 }, (_, i) => ({
      _id: `source-${i}`, name: 'Same name', position: i,
    }));
    const preview = buildPortableCommunityPreview(snapshot(categories), target);
    expect(preview.conflicts.total).toBe(60);
    expect(preview.conflicts.truncated).toBe(true);
    expect(preview.conflicts.items).toHaveLength(50);
    expect(preview.blockers).toContain('IMPORT_NOT_IMPLEMENTED');
  });

  it('never interprets zero collisions as approval to migrate', () => {
    const preview = buildPortableCommunityPreview(snapshot(), target);
    expect(preview.conflicts.total).toBe(0);
    expect(preview.importSupported).toBe(false);
    expect(preview.blockers).toContain('SOURCE_AUTHENTICITY_NOT_VERIFIED');
  });

  it('fails closed on incomplete/malformed target topology rather than suggesting safe import', () => {
    expect(() => buildPortableCommunityPreview(snapshot(), {
      ...target, channels: [{ _id: 'broken' }],
    })).toThrow('Invalid destination topology');
    expect(() => buildPortableCommunityPreview(snapshot(), {
      ...target, categories: Array.from({ length: 5001 }, (_, i) => ({ _id: `id-${i}`, name: 'x' })),
    })).toThrow('Unsupported target topology size');
  });
});
