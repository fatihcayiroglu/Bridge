// server/tests/route-mount-params-contract.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// HER ROTA, HANDLER'LARININ OKUDUĞU PARAMETREYİ YOLUNDA TAŞIMALI (Final21 Faz 19)
// ════════════════════════════════════════════════════════════════════════════
// Aynı kusur sınıfı BEŞ kez ayrı ayrı bulundu: `mergeParams: true` bir router
// handler'da `req.params.serverId` okur ama üretimde `/servers` altına, yani
// `:serverId` segmenti OLMADAN bağlanır. Belgelenen `/api/servers/{serverId}/...`
// uçları 404 döner; handler'ın birim testi router'ı KENDİ kurduğu doğru yola bağladığı
// için hiçbir şey kırmızıya dönmez. Önceki dört örnek (moderation, categories, GIF'ler,
// kanal webhook'ları) router başına kapatıldı (`moderation-mount-contract.test.ts`);
// beşincisi — sunucu üye profili, Faz 19 — o testin kapsamı dışında kalmıştı.
//
// Bu dosya sınıfı GENEL olarak kapatır: gerçek `setupRoutes()` çalıştırılır, üretim
// bileşimindeki HER rota gezilir (iç içe router'lar dahil) ve her handler'ın kaynak
// kodunda okuduğu `req.params.<ad>` için yolun o parametreyi taşıdığı doğrulanır.
// Yeni bir router yanlış bağlanırsa bu test onu adıyla ve yoluyla gösterir.

process.env.JWT_SECRET     = 'test-jwt-secret-long-enough-32chars!!';
process.env.REFRESH_SECRET = 'test-refresh-secret-long-enough-32!!';
process.env.NODE_ENV       = 'test';

jest.mock('sharp', () => ({ __esModule: true, default: jest.fn() }));
jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import type { Application } from 'express';

// ── İç içe mount yollarını kaydet ───────────────────────────────────────────
// Express 5'in `router` katmanı `router.use('/:sid/channels', sub)` yolunu saklamaz
// (eşleşmeden önce `layer.path` tanımsızdır). Router'lar oluşturulmadan ÖNCE `use`
// sarılır ve her yeni katmana bağlandığı yol işlenir. Bu yüzden rota modülleri
// `import` ile değil, yama SONRASI `require` ile yüklenir.
type Layer = {
  route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: (...a: unknown[]) => unknown }> };
  handle?: ((...a: unknown[]) => unknown) & { stack?: Layer[] };
  __mountPath?: string;
};
type RouterLike = { stack: Layer[] };

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RouterProto = require('router').prototype as { use: (...args: unknown[]) => unknown; stack: Layer[] };
const originalUse = RouterProto.use;
RouterProto.use = function patchedUse(this: RouterLike, ...args: unknown[]) {
  const before = this.stack.length;
  const out = originalUse.apply(this, args);
  const mountPath = typeof args[0] === 'string' ? args[0] : '/';
  for (let i = before; i < this.stack.length; i++) this.stack[i].__mountPath = mountPath;
  return out;
};

afterAll(() => { RouterProto.use = originalUse; });

interface Finding { route: string; handler: string; missing: string[] }

const paramsIn = (p: string): Set<string> => new Set([...p.matchAll(/:(\w+)/g)].map(m => m[1]));
const join = (a: string, b: string | undefined): string => (!b || b === '/' ? a : a + b);

/** Handler kaynağında okunan rota parametreleri. */
function paramsRead(fn: (...a: unknown[]) => unknown): Set<string> {
  const src = fn.toString();
  const out = new Set<string>();
  for (const m of src.matchAll(/req\.params\.(\w+)/g)) out.add(m[1]);
  for (const m of src.matchAll(/req\.params\[['"](\w+)['"]\]/g)) out.add(m[1]);
  for (const m of src.matchAll(/(?:const|let|var)\s+\{([^}]*)\}\s*=\s*req\.params\b/g)) {
    for (const part of m[1].split(',')) {
      const name = part.trim().split(/[:\s=]/)[0];
      if (name) out.add(name);
    }
  }
  return out;
}

/** Bir router ağacını gezer; yolunda bulunmayan bir parametreyi okuyan her handler'ı raporlar. */
function audit(router: RouterLike, prefix: string, findings: Finding[], counter: { routes: number }): void {
  for (const layer of router.stack ?? []) {
    if (layer.route) {
      counter.routes++;
      const full = join(prefix, layer.route.path);
      const available = paramsIn(full);
      for (const h of layer.route.stack) {
        const missing = [...paramsRead(h.handle)].filter(p => !available.has(p));
        if (missing.length) {
          findings.push({ route: `${Object.keys(layer.route.methods).join(',').toUpperCase()} ${full}`, handler: h.handle.name || '<anonim>', missing });
        }
      }
    } else if (layer.handle && Array.isArray(layer.handle.stack)) {
      audit(layer.handle as unknown as RouterLike, join(prefix, layer.__mountPath), findings, counter);
    } else if (typeof layer.handle === 'function') {
      // Router düzeyindeki ara katman (`router.use(fn)`): okuduğu parametre mount'tan gelmeli.
      const here = join(prefix, layer.__mountPath);
      const missing = [...paramsRead(layer.handle)].filter(p => !paramsIn(here).has(p));
      if (missing.length) findings.push({ route: `USE ${here}`, handler: layer.handle.name || '<anonim>', missing });
    }
  }
}

interface Mount { path: string; router: unknown }
let mounts: Mount[] = [];

beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { setupRoutes } = require('../app/setupRoutes') as { setupRoutes: (app: Application) => void };
  const recorded: Mount[] = [];
  const app = {
    use: (...args: unknown[]) => {
      if (typeof args[0] === 'string') for (const h of args.slice(1)) recorded.push({ path: args[0] as string, router: h });
      return app;
    },
    get: () => app, post: () => app, set: () => app, all: () => app, locals: {},
  } as unknown as Application;
  setupRoutes(app);
  mounts = recorded;
});

function auditProduction(): { findings: Finding[]; routes: number } {
  const findings: Finding[] = [];
  const counter = { routes: 0 };
  for (const m of mounts) {
    const r = m.router as RouterLike | undefined;
    if (r && Array.isArray(r.stack) && m.path.startsWith('/api/')) audit(r, m.path, findings, counter);
  }
  return { findings, routes: counter.routes };
}

describe('üretim bileşimi — rota parametre sözleşmesi', () => {
  it('denetim gerçekten üretim rotalarını geziyor (boş geçmez)', () => {
    // Gezinti kırılırsa "bulgu yok" anlamsızdır: rota sayısı ölçülür.
    expect(auditProduction().routes).toBeGreaterThan(400);
  });

  it('HİÇBİR handler yolunda bulunmayan bir parametreyi okumuyor', () => {
    expect(auditProduction().findings).toEqual([]);
  });

  it('sunucu üye profili belgelenen `/api/servers/:serverId` yoluna bağlı (Faz 19)', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const profileRouter = require('../routes/serverMemberProfile').default;
    const paths = mounts.filter(m => m.router === profileRouter).map(m => m.path);
    expect(paths).toContain('/api/servers/:serverId');
    expect(paths).toContain('/api/v1/servers/:serverId');
    expect(paths).not.toContain('/api/servers');
  });
});

describe('denetimin kendisi — NEGATİF ve POZİTİF kontrol', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const express = require('express') as typeof import('express');
  const makeRouter = () => {
    const r = express.Router({ mergeParams: true });
    r.get('/members/me', (req, res) => { const { serverId } = req.params as { serverId: string }; res.json({ serverId }); });
    // The fixture deliberately reads a param its path does not declare (the defect itself); the cast
    // is erased at compile time, so the handler source still reads `req.params.serverId`.
    r.post('/items/:itemId', (req, res) => { res.json({ id: req.params.itemId, s: (req.params as Record<string, string | undefined>).serverId }); });
    return r as unknown as RouterLike;
  };

  it('NEGATİF: parametresiz mount edilen router YAKALANIR (kusurun kendisi)', () => {
    const findings: Finding[] = [];
    audit(makeRouter(), '/api/servers', findings, { routes: 0 });
    expect(findings.map(f => f.route)).toEqual(['GET /api/servers/members/me', 'POST /api/servers/items/:itemId']);
    expect(findings.every(f => f.missing.join() === 'serverId')).toBe(true);
  });

  it('POZİTİF: doğru mount temiz geçer', () => {
    const findings: Finding[] = [];
    audit(makeRouter(), '/api/servers/:serverId', findings, { routes: 0 });
    expect(findings).toEqual([]);
  });

  it('iç içe router yolundaki parametre de SAĞLANMIŞ sayılır', () => {
    const outer = express.Router();
    const inner = express.Router({ mergeParams: true });
    inner.get('/', (req, res) => { res.json({ sid: (req.params as Record<string, string | undefined>).sid }); });
    outer.use('/:sid/channels', inner);
    const ok: Finding[] = [];
    audit(outer as unknown as RouterLike, '/api/servers', ok, { routes: 0 });
    expect(ok).toEqual([]);

    const brokenOuter = express.Router();
    brokenOuter.use('/channels', inner);
    const bad: Finding[] = [];
    audit(brokenOuter as unknown as RouterLike, '/api/servers', bad, { routes: 0 });
    expect(bad).toEqual([{ route: 'GET /api/servers/channels', handler: '<anonim>', missing: ['sid'] }]);
  });
});
