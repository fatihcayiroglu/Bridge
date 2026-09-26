// server/tests/moderation-mount-contract.test.ts
// C3 — moderationRouter'ın ÜRETİMDEKİ mount yolu sözleşmesi.
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN VAR — VE NEDEN MEVCUT TESTLER BUNU YAKALAYAMADI
// ════════════════════════════════════════════════════════════════════════════
// `routes/moderation.ts` `express.Router({ mergeParams: true })` kullanır ve
// altı handler'ın TAMAMI `req.params.serverId` okur. Ancak `setupRoutes.ts`
// router'ı `/servers` altına mount ediyordu — yolda `:serverId` segmenti YOKTU.
// Gerçek uçlar `/api/servers/audit-log`, `/api/servers/bans` hâline geliyor,
// `serverId` her zaman '' kalıyordu; belgelenen ve istemcinin çağırdığı
// `/api/servers/:serverId/...` uçları ise 404 dönüyordu.
//
// KÖR NOKTA: `tests/moderation.test.ts` router'ı KENDİ kurduğu app'e
// `/api/servers/:serverId` ile mount eder — yani testler DOĞRU sözleşmeyi
// varsayıyordu, üretim ise YANLIŞ mount ediyordu. Handler davranışını test
// etmek bu yüzden hatayı hiç göremezdi.
//
// Bu dosya handler'ları değil, ÜRETİM MOUNT'UNU doğrular: gerçek
// `setupRoutes()` çalıştırılır ve kayıt yapan sahte bir `app` ile hangi
// router'ın hangi yola bağlandığı gözlenir.

process.env.JWT_SECRET     = 'test-jwt-secret-abcdefghijklmnop';
process.env.REFRESH_SECRET = 'test-refresh-secret-abcdefghijkl';
process.env.NODE_ENV       = 'test';

// Bu suite görüntü işleme davranışını test etmiyor. ZIP Windows `sharp` native
// binary'si taşıdığı için Linux doğrulamasında yalnız import sınırını izole et.
jest.mock('sharp', () => ({ __esModule: true, default: jest.fn() }));

jest.mock('../db/loader', () => require('./helpers/mockDb').createMockDb());

import type { Application, Router } from 'express';
import moderationRouter from '../routes/moderation';
import { setupRoutes } from '../app/setupRoutes';

interface Mount { path: string; router: unknown }

/** `app.use(...)` çağrılarını kaydeden minimal sahte uygulama. */
function recordMounts(): { app: Application; mounts: Mount[] } {
  const mounts: Mount[] = [];
  const app = {
    use: (...args: unknown[]) => {
      if (typeof args[0] === 'string') {
        // app.use(path, ...handlers) — son argüman router olabilir
        for (const h of args.slice(1)) mounts.push({ path: args[0] as string, router: h });
      }
      return app;
    },
    get:    () => app,
    post:   () => app,
    set:    () => app,
    all:    () => app,
    locals: {},
  } as unknown as Application;
  return { app, mounts: mounts as Mount[] };
}

let mounts: Mount[];

beforeAll(() => {
  const rec = recordMounts();
  setupRoutes(rec.app);
  mounts = rec.mounts;
});

/** moderationRouter'ın bağlandığı tüm yollar. */
function moderationPaths(): string[] {
  return mounts
    .filter(m => m.router === (moderationRouter as unknown as Router))
    .map(m => m.path);
}

describe('C3 — moderation mount sözleşmesi', () => {
  it('moderationRouter ÜRETİMDE gerçekten mount edilir', () => {
    expect(moderationPaths().length).toBeGreaterThan(0);
  });

  it('M1: mount yolu `:serverId` parametresini SAĞLAR', () => {
    // Bu olmadan `req.params.serverId` handler'larda hiçbir zaman dolmaz.
    for (const p of moderationPaths()) {
      expect(p).toContain(':serverId');
    }
  });

  it('M1b: belgelenen genel yol `/api/servers/:serverId` altındadır', () => {
    const paths = moderationPaths();
    expect(paths).toContain('/api/servers/:serverId');
    // Sürümlü kanonik yol da aynı sözleşmeyi taşımalı.
    expect(paths).toContain('/api/v1/servers/:serverId');
  });

  it('M3: BOZUK `/api/servers` mount’u ARTIK kullanılmaz', () => {
    // Eski hâlde `/api/servers` altına bağlanıyordu ve serverId hiç dolmuyordu.
    expect(moderationPaths()).not.toContain('/api/servers');
    expect(moderationPaths()).not.toContain('/api/v1/servers');
  });

  it('sunucu-kapsamlı komşularla aynı deseni izler', () => {
    // Aynı aileden kanıtlanmış örnekler: sticker paketleri ve emoji.
    const scoped = mounts.map(m => m.path)
      .filter(p => p.startsWith('/api/servers/:'));
    expect(scoped.length).toBeGreaterThan(0);
    expect(moderationPaths().some(p => p.startsWith('/api/servers/:'))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// AYNI SINIF — ebeveyn parametresi eksik mount hataları (kategoriler, GIF'ler,
// kanal webhook'ları). Üçü de moderation ile BİREBİR aynı desendi:
// `mergeParams: true` + handler'da `req.params.<parentId>` + mount yolunda o
// segmentin OLMAMASI. Üçünün de birim testleri DOĞRU yolu kullanıyordu, yani
// hata yalnızca ÜRETİM mount'unda yaşıyordu ve hiçbir handler testi göremezdi.
// ════════════════════════════════════════════════════════════════════════════

import categoriesRouter from '../routes/categories';
import serverGifsRouter from '../routes/serverGifs';
import webhooksRouter   from '../routes/webhooks';

function pathsOf(router: unknown): string[] {
  return mounts.filter(m => m.router === router).map(m => m.path);
}

describe('C3 sınıfı — kategoriler mount sözleşmesi', () => {
  it('CAT1: belgelenen sunucu-kapsamlı yola mount edilir', () => {
    const p = pathsOf(categoriesRouter);
    expect(p).toContain('/api/servers/:serverId/categories');
    expect(p).toContain('/api/v1/servers/:serverId/categories');
  });

  it('CAT2: mount `:serverId` ebeveyn parametresini SAĞLAR', () => {
    const p = pathsOf(categoriesRouter);
    expect(p.length).toBeGreaterThan(0);
    for (const x of p) expect(x).toContain(':serverId');
  });

  it('CAT3: BOZUK çıplak `/api/servers` mount’u YOK', () => {
    expect(pathsOf(categoriesRouter)).not.toContain('/api/servers');
    expect(pathsOf(categoriesRouter)).not.toContain('/api/v1/servers');
  });
});

describe('C3 sınıfı — sunucu GIF mount sözleşmesi', () => {
  it('GIF1: sunucu-kapsamlı yola mount edilir', () => {
    const p = pathsOf(serverGifsRouter);
    expect(p).toContain('/api/servers/:id/gifs');
    expect(p).toContain('/api/v1/servers/:id/gifs');
  });

  it('GIF2: handler’ın okuduğu parametre ADI korunur (`:id`, serverId DEĞİL)', () => {
    // routes/serverGifs.ts `req.params.id` okur. Mount başka bir ad kullansaydı
    // (ör. :serverId) parametre yine boş kalırdı — hata sessizce sürerdi.
    for (const x of pathsOf(serverGifsRouter)) {
      expect(x).toContain(':id');
      expect(x).not.toContain(':serverId');
    }
  });

  it('GIF3: BOZUK çıplak `/api/servers` mount’u YOK', () => {
    expect(pathsOf(serverGifsRouter)).not.toContain('/api/servers');
    expect(pathsOf(serverGifsRouter)).not.toContain('/api/v1/servers');
  });
});

describe('C3 sınıfı — kanal webhook mount sözleşmesi', () => {
  it('WH1/WH2: istemcinin çağırdığı yola her iki önekle mount edilir', () => {
    const p = pathsOf(webhooksRouter);
    expect(p).toContain('/api/channels/:channelId/webhooks');
    expect(p).toContain('/api/v1/channels/:channelId/webhooks');
  });

  it('WH3: mount `:channelId` ebeveyn parametresini SAĞLAR', () => {
    const p = pathsOf(webhooksRouter);
    expect(p.length).toBeGreaterThan(0);
    for (const x of p) expect(x).toContain(':channelId');
  });

  it('WH4: BOZUK çıplak `/api/channels` mount’u YOK', () => {
    expect(pathsOf(webhooksRouter)).not.toContain('/api/channels');
    expect(pathsOf(webhooksRouter)).not.toContain('/api/v1/channels');
  });

  it('WH5: üretim mount’u CANLI istemci yoluyla birebir uyuşur', () => {
    // WebhookTab.svelte: `${API}/api/channels/${ch._id}/webhooks`
    const clientPath = '/api/channels/:channelId/webhooks';
    expect(pathsOf(webhooksRouter)).toContain(clientPath);
  });
});

describe('C3 sınıfı — ebeveyn parametreli aileler çakışmaz', () => {
  it('her aile KENDİ ayrı ad alanına sahiptir', () => {
    const cat = pathsOf(categoriesRouter);
    const gif = pathsOf(serverGifsRouter);
    const wh  = pathsOf(webhooksRouter);
    // Kesişim olmamalı — aynı yola iki farklı router bağlanmamalı.
    for (const c of cat) { expect(gif).not.toContain(c); expect(wh).not.toContain(c); }
    for (const g of gif) { expect(wh).not.toContain(g); }
  });
});
