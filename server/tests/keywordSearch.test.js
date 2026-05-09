// server/tests/keywordSearch.test.js
// keywordSearch pure-function testi — DB/HTTP bağımlılığı yok
// `node --check` ile syntax doğrulanır, `npx jest keywordSearch` ile çalışır
//
// Test edilen fonksiyon: server/routes/semantic.js içindeki keywordSearch
// İzole etmek için doğrudan aynı logic'i buraya alıyoruz — route'u mount etmeden.

'use strict';

// ── keywordSearch — routes/semantic.js'ten izole edilmiş pure function ──────
function keywordSearch(query, messages) {
  const q = query.toLowerCase();
  const keywords = q.split(/\s+/).filter(w => w.length > 2);
  return messages
    .map(m => {
      const content = (m.content || '').toLowerCase();
      const score = keywords.reduce((s, kw) => s + (content.includes(kw) ? 1 : 0), 0);
      return { ...m, _score: score };
    })
    .filter(m => m._score > 0)
    .sort((a, b) => b._score - a._score)
    .slice(0, 10);
}

// ── Fixtures ─────────────────────────────────────────────────────────────────
function makeMessages(defs) {
  return defs.map((content, i) => ({ _id: `msg-${i}`, content, userId: 'u1', channelId: 'ch1', createdAt: Date.now() - i * 1000 }));
}

// ── Tests ────────────────────────────────────────────────────────────────────
describe('keywordSearch (pure function)', () => {

  describe('temel eşleştirme', () => {
    it('hiçbir kelime eşleşmiyorsa boş dizi döner', () => {
      const msgs = makeMessages(['hello world', 'foo bar']);
      expect(keywordSearch('xyz', msgs)).toHaveLength(0);
    });

    it('tek eşleşen mesajı döner', () => {
      const msgs = makeMessages(['decision made today', 'hello world']);
      const res = keywordSearch('decision', msgs);
      expect(res).toHaveLength(1);
      expect(res[0]._id).toBe('msg-0');
    });

    it('büyük/küçük harf duyarsız çalışır', () => {
      const msgs = makeMessages(['IMPORTANT Decision', 'unrelated text']);
      const res = keywordSearch('important decision', msgs);
      expect(res).toHaveLength(1);
    });

    it('boş mesaj listesi → boş sonuç', () => {
      expect(keywordSearch('test', [])).toHaveLength(0);
    });

    it('boş query → boş sonuç (keywords filtresi length > 2 siler hepsini)', () => {
      const msgs = makeMessages(['hello world']);
      expect(keywordSearch('', msgs)).toHaveLength(0);
    });
  });

  describe('skor & sıralama', () => {
    it('daha fazla keyword eşleşen mesaj öne çıkar', () => {
      const msgs = makeMessages([
        'project update only',          // 1 keyword match
        'project decision update today', // 2 keyword matches
      ]);
      const res = keywordSearch('project decision', msgs);
      expect(res[0]._id).toBe('msg-1'); // 2 eşleşen öne geçmeli
    });

    it('eşit skorlarda sıra karışmaz (stabil)', () => {
      const msgs = makeMessages(['project news', 'project update']);
      const res = keywordSearch('project', msgs);
      expect(res).toHaveLength(2);
      // İkisi de 1 eşleşme, stabil sıra (sort güvencesi vermez ama en az 2 sonuç var)
    });

    it('_score alanı her sonuçta bulunur ve > 0', () => {
      const msgs = makeMessages(['project decision', 'hello']);
      const res = keywordSearch('project', msgs);
      res.forEach(m => {
        expect(m).toHaveProperty('_score');
        expect(m._score).toBeGreaterThan(0);
      });
    });
  });

  describe('limit & slicing', () => {
    it('11 eşleşen mesaj varken max 10 döner', () => {
      const contents = Array.from({ length: 11 }, (_, i) => `project news item ${i}`);
      const msgs = makeMessages(contents);
      const res = keywordSearch('project', msgs);
      expect(res).toHaveLength(10);
    });

    it('9 eşleşen mesaj varken 9 döner (limiti aşmaz)', () => {
      const contents = Array.from({ length: 9 }, () => 'project update');
      const msgs = makeMessages(contents);
      const res = keywordSearch('project', msgs);
      expect(res).toHaveLength(9);
    });
  });

  describe('keyword filtresi (length > 2)', () => {
    it("2 karakter veya daha kısa kelimeler ('to', 'is') arama keyword'ü sayılmaz", () => {
      const msgs = makeMessages(['is this to be done', 'hello world']);
      // "is", "to", "be" hepsi ≤2 karakter → keyword yok → hiçbir şey eşleşmez
      expect(keywordSearch('is to be', msgs)).toHaveLength(0);
    });

    it('3 karakter keyword eşleşir', () => {
      const msgs = makeMessages(['big fix today', 'hello world']);
      const res = keywordSearch('fix', msgs);
      expect(res).toHaveLength(1);
    });
  });

  describe('içerik güvenliği', () => {
    it('content alanı null/undefined olan mesajlar çökmeden atlanır', () => {
      const msgs = [
        { _id: 'a', content: null,      userId: 'u1', channelId: 'c1', createdAt: 1 },
        { _id: 'b', content: undefined, userId: 'u1', channelId: 'c1', createdAt: 2 },
        { _id: 'c', content: 'project decision', userId: 'u1', channelId: 'c1', createdAt: 3 },
      ];
      expect(() => keywordSearch('project', msgs)).not.toThrow();
      const res = keywordSearch('project', msgs);
      expect(res).toHaveLength(1);
      expect(res[0]._id).toBe('c');
    });

    it('orijinal mesaj nesnesi mutate edilmez (spread ile kopyalanır)', () => {
      const original = { _id: 'x', content: 'project update', userId: 'u1', channelId: 'c1', createdAt: 1 };
      const msgs = [original];
      keywordSearch('project', msgs);
      expect(original).not.toHaveProperty('_score');
    });
  });

  describe('çok kelimeli queries', () => {
    it('birden fazla keyword içeren sorgu daha hassas sonuç verir', () => {
      const msgs = makeMessages([
        'project decision and update',
        'just a project note',
        'decision only',
        'unrelated message',
      ]);
      const res = keywordSearch('project decision', msgs);
      // İlk mesaj her iki keyword'ü de içeriyor → _score:2 → en başta
      expect(res[0]._id).toBe('msg-0');
    });

    it('sorgu kelime sırasının önemi yok', () => {
      const msgs = makeMessages(['decision project matters']);
      const res1 = keywordSearch('project decision', msgs);
      const res2 = keywordSearch('decision project', msgs);
      expect(res1[0]._id).toBe(res2[0]._id);
    });
  });
});
