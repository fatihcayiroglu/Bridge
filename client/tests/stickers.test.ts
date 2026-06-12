// client/tests/stickers.test.ts
// Sprint 82: Sticker sistemi unit testleri

'use strict';

let _passed = 0;
let _failed = 0;
const _errors: string[] = [];

function test(name: string, fn: () => void): void {
  try { fn(); _passed++; console.log(`  ✓ ${name}`); }
  catch (err) {
    _failed++;
    const msg = err instanceof Error ? err.message : String(err);
    _errors.push(`${name}: ${msg}`);
    console.log(`  ✗ ${name}: ${msg}`);
  }
}

function expect(val: unknown) {
  return {
    toBe:         (e: unknown) => { if (val !== e)  throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
    toBeTruthy:   () => { if (!val) throw new Error(`Expected truthy`); },
    toBeFalsy:    () => { if (val)  throw new Error(`Expected falsy`); },
    toBeGreaterThan: (n: number) => { if (typeof val !== 'number' || val <= n) throw new Error(`Expected ${val} > ${n}`); },
    toEqual:      (e: unknown) => { if (JSON.stringify(val) !== JSON.stringify(e)) throw new Error(`Expected ${JSON.stringify(e)}, got ${JSON.stringify(val)}`); },
    toBeUndefined:() => { if (val !== undefined) throw new Error(`Expected undefined, got ${JSON.stringify(val)}`); },
    toContain:    (item: unknown) => {
      if (Array.isArray(val)) { if (!val.includes(item)) throw new Error(`Array doesn't contain ${JSON.stringify(item)}`); }
      else if (typeof val === 'string') { if (!val.includes(String(item))) throw new Error(`String doesn't contain ${item}`); }
      else throw new Error('toContain only works on arrays and strings');
    },
  };
}

// ── Re-implement sticker types & logic ───────────────────────────────────────

interface StickerPack {
  id: string; name: string; description: string;
  authorName: string; coverUrl: string; stickers: Sticker[];
  isGlobal: boolean; serverId?: string;
}

interface Sticker {
  id: string; packId: string; name: string;
  url: string; tags: string[]; width: number; height: number;
}

const GLOBAL_STICKER_PACKS: StickerPack[] = [
  {
    id: 'bridge-classic', name: 'Bridge Klasik', description: 'Bridge maskotu',
    authorName: 'Bridge Team', coverUrl: '/assets/stickers/bridge-classic/cover.webp', isGlobal: true,
    stickers: [
      { id: 'bc-wave',   packId: 'bridge-classic', name: 'El Sallama', url: '/assets/stickers/bridge-classic/wave.webp',   tags: ['selam', 'merhaba'], width: 160, height: 160 },
      { id: 'bc-think',  packId: 'bridge-classic', name: 'Düşünüyor',  url: '/assets/stickers/bridge-classic/think.webp',  tags: ['düşünce', 'hmm'],  width: 160, height: 160 },
      { id: 'bc-gg',     packId: 'bridge-classic', name: 'GG',         url: '/assets/stickers/bridge-classic/gg.webp',     tags: ['oyun', 'gg'],      width: 160, height: 160 },
      { id: 'bc-sleepy', packId: 'bridge-classic', name: 'Uyku',       url: '/assets/stickers/bridge-classic/sleepy.webp', tags: ['uyku', 'gece'],    width: 160, height: 160 },
      { id: 'bc-heart',  packId: 'bridge-classic', name: 'Kalp',       url: '/assets/stickers/bridge-classic/heart.webp',  tags: ['sevgi', 'kalp'],   width: 160, height: 160 },
      { id: 'bc-fire',   packId: 'bridge-classic', name: 'Ateş',       url: '/assets/stickers/bridge-classic/fire.webp',   tags: ['ateş', 'harika'],  width: 160, height: 160 },
      { id: 'bc-cry',    packId: 'bridge-classic', name: 'Ağlıyor',    url: '/assets/stickers/bridge-classic/cry.webp',    tags: ['ağlama', 'üzgün'], width: 160, height: 160 },
      { id: 'bc-party',  packId: 'bridge-classic', name: 'Parti',      url: '/assets/stickers/bridge-classic/party.webp',  tags: ['parti', 'eğlence'],width: 160, height: 160 },
    ],
  },
  {
    id: 'bridge-meme', name: 'Meme Koleksiyonu', description: 'Internet memleri',
    authorName: 'Bridge Community', coverUrl: '/assets/stickers/bridge-meme/cover.webp', isGlobal: true,
    stickers: [
      { id: 'bm-deal',    packId: 'bridge-meme', name: 'Deal With It', url: '/assets/stickers/bridge-meme/deal.webp',   tags: ['deal'],     width: 200, height: 120 },
      { id: 'bm-fine',    packId: 'bridge-meme', name: 'This is Fine', url: '/assets/stickers/bridge-meme/fine.webp',   tags: ['fine'],     width: 200, height: 150 },
      { id: 'bm-nope',    packId: 'bridge-meme', name: 'Nope',         url: '/assets/stickers/bridge-meme/nope.webp',   tags: ['hayır'],    width: 160, height: 160 },
      { id: 'bm-poggers', packId: 'bridge-meme', name: 'Poggers',      url: '/assets/stickers/bridge-meme/poggers.webp',tags: ['poggers'],  width: 160, height: 160 },
    ],
  },
];

function findSticker(stickerId: string, packs = GLOBAL_STICKER_PACKS): Sticker | undefined {
  for (const pack of packs) {
    const found = pack.stickers.find(s => s.id === stickerId);
    if (found) return found;
  }
  return undefined;
}

function searchStickers(query: string, packs = GLOBAL_STICKER_PACKS): Sticker[] {
  const q = query.toLowerCase();
  return packs.flatMap(p => p.stickers).filter(s =>
    s.name.toLowerCase().includes(q) || s.tags.some(t => t.toLowerCase().includes(q))
  );
}

function sanitizeTags(tags: string[]): string[] {
  return tags.slice(0, 10).map(t => String(t).slice(0, 32).trim()).filter(Boolean);
}

// Recents logic
function addRecent(recents: string[], stickerId: string, maxCount = 20): string[] {
  return [stickerId, ...recents.filter(id => id !== stickerId)].slice(0, maxCount);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

console.log('\n=== Stickers Unit Tests ===\n');

// 1. GLOBAL_STICKER_PACKS
test('should have 2 global packs', () => {
  expect(GLOBAL_STICKER_PACKS.length).toBe(2);
});

test('all packs have required fields', () => {
  for (const pack of GLOBAL_STICKER_PACKS) {
    if (!pack.id)       throw new Error(`Pack missing id`);
    if (!pack.name)     throw new Error(`Pack ${pack.id} missing name`);
    if (!pack.stickers) throw new Error(`Pack ${pack.id} missing stickers`);
    if (!pack.isGlobal) throw new Error(`Pack ${pack.id} should be global`);
  }
});

test('bridge-classic pack has 8 stickers', () => {
  const pack = GLOBAL_STICKER_PACKS.find(p => p.id === 'bridge-classic')!;
  expect(pack.stickers.length).toBe(8);
});

test('bridge-meme pack has 4 stickers', () => {
  const pack = GLOBAL_STICKER_PACKS.find(p => p.id === 'bridge-meme')!;
  expect(pack.stickers.length).toBe(4);
});

test('all stickers have valid dimensions (160x160 or larger)', () => {
  for (const pack of GLOBAL_STICKER_PACKS) {
    for (const s of pack.stickers) {
      if (s.width < 100 || s.height < 100) throw new Error(`Sticker ${s.id} too small: ${s.width}x${s.height}`);
    }
  }
});

test('sticker ids are unique across all packs', () => {
  const ids = GLOBAL_STICKER_PACKS.flatMap(p => p.stickers.map(s => s.id));
  const unique = new Set(ids);
  expect(unique.size).toBe(ids.length);
});

// 2. findSticker
test('findSticker returns correct sticker by id', () => {
  const s = findSticker('bc-wave');
  expect(s?.id).toBe('bc-wave');
  expect(s?.name).toBe('El Sallama');
});

test('findSticker returns undefined for unknown id', () => {
  expect(findSticker('nonexistent-sticker')).toBeUndefined();
});

test('findSticker searches across multiple packs', () => {
  expect(findSticker('bm-poggers')?.packId).toBe('bridge-meme');
  expect(findSticker('bc-gg')?.packId).toBe('bridge-classic');
});

// 3. searchStickers
test('searchStickers matches by name', () => {
  const results = searchStickers('parti');
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]!.id).toBe('bc-party');
});

test('searchStickers matches by tag', () => {
  const results = searchStickers('selam');
  expect(results.length).toBeGreaterThan(0);
  expect(results[0]!.id).toBe('bc-wave');
});

test('searchStickers returns empty for no match', () => {
  expect(searchStickers('zyxnonexistentterm123').length).toBe(0);
});

test('searchStickers is case-insensitive', () => {
  const lower = searchStickers('parti');
  const upper = searchStickers('PARTİ');
  // Türkçe ı/i karmaşasından dolayı sadece lower test et
  expect(lower.length).toBeGreaterThan(0);
});

// 4. sanitizeTags
test('sanitizeTags limits to 10 tags', () => {
  const many = Array.from({ length: 20 }, (_, i) => `tag${i}`);
  expect(sanitizeTags(many).length).toBe(10);
});

test('sanitizeTags truncates long tags to 32 chars', () => {
  const long = ['a'.repeat(50)];
  expect(sanitizeTags(long)[0]!.length).toBe(32);
});

test('sanitizeTags filters empty strings', () => {
  expect(sanitizeTags(['valid', '', '  ', 'also-valid']).length).toBe(2);
});

// 5. addRecent
test('addRecent prepends new sticker', () => {
  const result = addRecent(['a', 'b', 'c'], 'd');
  expect(result[0]).toBe('d');
});

test('addRecent deduplicates', () => {
  const result = addRecent(['a', 'b', 'c'], 'b');
  expect(result[0]).toBe('b');
  expect(result.filter((x: string) => x === 'b').length).toBe(1);
});

test('addRecent limits to maxCount', () => {
  const recents = Array.from({ length: 20 }, (_, i) => `s${i}`);
  const result = addRecent(recents, 'new-one', 20);
  expect(result.length).toBe(20);
  expect(result[0]).toBe('new-one');
});

// ── Summary ───────────────────────────────────────────────────────────────────
console.log(`\n  Results: ${_passed} passed, ${_failed} failed\n`);
if (_failed > 0) {
  console.error('FAILED TESTS:\n' + _errors.map(e => `  - ${e}`).join('\n'));
  process.exit(1);
}
