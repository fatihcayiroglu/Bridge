// server/tests/swagger-resolveRef.test.ts
// Sprint 80 — resolveRef edge case testleri
// Kapsam: ref chain, circular ref, geçersiz format, boş components, cross-tip ref

'use strict';

process.env.NODE_ENV = 'test';

import { resolveRef, OpenApiSpec } from '../../server/lib/swagger';

// ── Minimal geçerli spec fabrikası ──────────────────────────────────────────
function makeSpec(overrides: Partial<OpenApiSpec> = {}): OpenApiSpec {
  return {
    openapi: '3.0.3',
    info: { title: 'Test', version: '1.0.0' },
    paths: {},
    components: {
      schemas: {
        Error: {
          type: 'object',
          properties: { error: { type: 'string' } },
        },
        User: {
          type: 'object',
          properties: {
            _id:  { type: 'string' },
            name: { type: 'string' },
          },
        },
        UserRef: {
          // Başka bir şemaya $ref — chain senaryosu
          $ref: '#/components/schemas/User',
        },
      },
      responses: {
        Forbidden: {
          description: 'Yetki hatası',
          content: {
            'application/json': {
              schema: { $ref: '#/components/schemas/Error' },
            },
          },
        },
      },
      parameters: {
        ServerId: {
          name: 'id',
          in: 'path',
          required: true,
          schema: { type: 'string' },
        },
      },
    },
    ...overrides,
  };
}

// ── [1] Temel başarılı çözümleme ────────────────────────────────────────────
describe('resolveRef — temel başarılı çözümleme', () => {
  const spec = makeSpec();

  it('components/schemas altındaki bir şemayı çözümler', () => {
    const result = resolveRef(spec, '#/components/schemas/Error');
    expect(result).toBeDefined();
    expect((result as { type?: string }).type).toBe('object');
  });

  it('components/responses altındaki bir yanıtı çözümler', () => {
    const result = resolveRef(spec, '#/components/responses/Forbidden');
    expect(result).toBeDefined();
    expect((result as { description?: string }).description).toBe('Yetki hatası');
  });

  it('components/parameters altındaki bir parametreyi çözümler', () => {
    const result = resolveRef(spec, '#/components/parameters/ServerId');
    expect(result).toBeDefined();
    expect((result as { name?: string }).name).toBe('id');
  });
});

// ── [2] Bilinmeyen / var olmayan ref ────────────────────────────────────────
describe('resolveRef — var olmayan ref', () => {
  const spec = makeSpec();

  it('var olmayan schema ref için undefined döner', () => {
    expect(resolveRef(spec, '#/components/schemas/NonExistent')).toBeUndefined();
  });

  it('var olmayan response ref için undefined döner', () => {
    expect(resolveRef(spec, '#/components/responses/NonExistent')).toBeUndefined();
  });

  it('var olmayan parameters ref için undefined döner', () => {
    expect(resolveRef(spec, '#/components/parameters/NonExistent')).toBeUndefined();
  });

  it('tamamen bilinmeyen alan yolu için undefined döner', () => {
    expect(resolveRef(spec, '#/nonexistent/path/foo')).toBeUndefined();
  });
});

// ── [3] Geçersiz ref formatı ────────────────────────────────────────────────
describe('resolveRef — geçersiz ref formatı', () => {
  const spec = makeSpec();

  it('# ile başlamayan ref için undefined döner', () => {
    expect(resolveRef(spec, 'components/schemas/Error')).toBeUndefined();
  });

  it('http ile başlayan harici ref için undefined döner', () => {
    expect(resolveRef(spec, 'https://example.com/schemas/Error')).toBeUndefined();
  });

  it('boş string için undefined döner', () => {
    expect(resolveRef(spec, '')).toBeUndefined();
  });

  it('yalnızca # olan ref için undefined döner (hata fırlatmaz)', () => {
    // '#' → ref.slice(2) = '' → parts = [''] → spec[''] = undefined
    const result = resolveRef(spec, '#');
    expect(() => resolveRef(spec, '#')).not.toThrow();
    expect(result).toBeUndefined();
  });

  it('sadece #/ olan ref için hata fırlatmaz ve undefined döner', () => {
    // '#/' → ref.slice(2) = '' → parts = [''] → spec[''] = undefined
    const result = resolveRef(spec, '#/');
    expect(() => resolveRef(spec, '#/')).not.toThrow();
    expect(result).toBeUndefined();
  });
});

// ── [4] Boş / eksik components ──────────────────────────────────────────────
describe('resolveRef — boş veya eksik components', () => {
  it('components tanımsızsa undefined döner', () => {
    const spec = makeSpec({ components: undefined });
    expect(resolveRef(spec, '#/components/schemas/Error')).toBeUndefined();
  });

  it('components.schemas yoksa undefined döner', () => {
    const spec = makeSpec({ components: {} });
    expect(resolveRef(spec, '#/components/schemas/Error')).toBeUndefined();
  });

  it('components.responses yoksa undefined döner', () => {
    const spec = makeSpec({ components: { schemas: {} } });
    expect(resolveRef(spec, '#/components/responses/Forbidden')).toBeUndefined();
  });
});

// ── [5] $ref chain — resolveRef zincirleme yapmaz (tasarım gereği) ──────────
describe('resolveRef — $ref chain davranışı', () => {
  const spec = makeSpec();

  it('UserRef şeması $ref içeriyor — resolveRef yalnızca $ref nesnesini döner, otomatik çözmez', () => {
    // resolveRef tek adım yapar: spec.components.schemas.UserRef = { $ref: '...' }
    // Bu nesneyi olduğu gibi döner; User şemasına otomatik geçmez.
    const result = resolveRef(spec, '#/components/schemas/UserRef') as { $ref?: string } | undefined;
    expect(result).toBeDefined();
    expect((result as { $ref?: string }).$ref).toBe('#/components/schemas/User');
    // type: 'object' OLMAMALI — henüz User'a inilmedi
    expect((result as { type?: string }).type).toBeUndefined();
  });

  it('iki adımlı manuel chain — UserRef → User çalışır', () => {
    const step1 = resolveRef(spec, '#/components/schemas/UserRef') as { $ref?: string } | undefined;
    expect(step1).toBeDefined();
    const ref2 = (step1 as { $ref?: string }).$ref!;
    expect(ref2).toBe('#/components/schemas/User');

    const step2 = resolveRef(spec, ref2);
    expect(step2).toBeDefined();
    expect((step2 as { type?: string }).type).toBe('object');
  });
});

// ── [6] Circular ref — sonsuz döngüye girmemeli ─────────────────────────────
describe('resolveRef — circular ref güvenliği', () => {
  it('spec üzerinde circular $ref olsa bile hata fırlatmaz (veya undefined döner)', () => {
    const spec = makeSpec({
      components: {
        schemas: {
          // A → B → A (circular)
          CircA: { $ref: '#/components/schemas/CircB' },
          CircB: { $ref: '#/components/schemas/CircA' },
        },
      },
    });

    // resolveRef tek adım yaptığı için doğrudan circular'a düşmez.
    // CircA'yı çözersek CircB'nin $ref nesnesini almalıyız — döngü yok.
    expect(() => resolveRef(spec, '#/components/schemas/CircA')).not.toThrow();
    expect(() => resolveRef(spec, '#/components/schemas/CircB')).not.toThrow();
  });
});

// ── [7] Derin path çözümleme ─────────────────────────────────────────────────
describe('resolveRef — derin path navigasyonu', () => {
  const spec = makeSpec();

  it('#/info/title değerini çözümler', () => {
    const result = resolveRef(spec, '#/info/title');
    expect(result).toBe('Test');
  });

  it('#/info/version değerini çözümler', () => {
    const result = resolveRef(spec, '#/info/version');
    expect(result).toBe('1.0.0');
  });

  it('#/openapi değerini çözümler', () => {
    const result = resolveRef(spec, '#/openapi');
    expect(result).toBe('3.0.3');
  });
});

// ── [8] Yan etki yok — spec mutasyonu yapılmıyor ────────────────────────────
describe('resolveRef — immutability', () => {
  it('spec nesnesini değiştirmiyor', () => {
    const spec = makeSpec();
    const before = JSON.stringify(spec);
    resolveRef(spec, '#/components/schemas/Error');
    resolveRef(spec, '#/components/schemas/NonExistent');
    resolveRef(spec, 'invalid-ref');
    expect(JSON.stringify(spec)).toBe(before);
  });
});
