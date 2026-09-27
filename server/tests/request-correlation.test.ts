// server/tests/request-correlation.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// KORELASYON KİMLİĞİ — TEK BİR İSTEK UÇTAN UCA İZLENEBİLİR
// ════════════════════════════════════════════════════════════════════════════
// Bir üretim olayında sorulan ilk soru "kullanıcının 500 aldığı O istek ne
// yaptı?" sorusudur. Cevap verebilmek için, HTTP girişinde üretilen kimliğin o
// isteğin tetiklediği HER günlük satırında görünmesi gerekir — derinlerdeki
import type { Request, Response, NextFunction } from 'express';
// bir depo çağrısı ya da `await` sonrası bir Redis hatası dahil.
//
// Bu paket üç şeyi ölçer:
//
// 1. YAYILMA. Kimlik, `await` sınırlarının ve `Promise.all` dallarının
//    ötesine KENDİLİĞİNDEN taşınır. Elle parametre geçirmek yüzlerce imzayı
//    değiştirir ve ilk unutulan yerde zincir sessizce kopar.
// 2. YALITIM. Eş zamanlı iki istek birbirinin kimliğini GÖRMEZ. Sızarsa iki
//    farklı kullanıcının olayları tek kimlikte birleşir ve teşhis imkânsızlaşır.
// 3. GÜVENİLMEZ GİRDİ. Başlık istemciden de gelebilir. Sınırsız uzunluk günlüğü
//    şişirir; kontrol karakteri günlük satırı enjekte eder (CRLF); sabit bir
//    değer tüm kullanıcıları tek kimlikte toplar. Bunlar sessizce yok sayılır
//    ve yeni kimlik üretilir — istek REDDEDİLMEZ, çünkü izlenebilirlik bir
//    güvenlik sınırı değildir ve kötü bir başlık meşru trafiği düşürmemelidir.
process.env.NODE_ENV = 'test';

import { readFileSync } from 'fs';
import type { Server } from 'http';
import { join } from 'path';
import { Writable } from 'stream';

import express from 'express';
import pino from 'pino';
import request from 'supertest';
import { requestIdMiddleware } from '../middleware/requestId';
import {
  adoptRequestId, attachActor, currentRequestContext, currentRequestId,
  newRequestId, requestContextMixin, runWithRequestContext,
} from '../lib/requestContext';

const HEX_128 = /^[0-9a-f]{32}$/;

// -- TEK sunucu, TEK dinleyici ---------------------------------------------
// `supertest(app)` her cagrida kendi kisa omurlu TCP sunucusunu acar ve
// KAPATMAZ. OLCULDU: paket, birikmis `TCPSERVERWRAP` tanitici(lari) yuzunden
// hic bitmiyordu (Jest 600 sn+ askida kaldi; --detectOpenHandles bunu
// dogruladi). Bu yuzden TEK sunucu acilir, testler isleyiciyi degistirir ve
// sunucu sonunda kapatilir.
let server: Server;
let handler: express.RequestHandler = (_req: Request, res: Response) => { res.json({ ok: true }); };

beforeAll(done => {
  const app = express();
  app.use(requestIdMiddleware);
  app.get('/probe', (req: Request, res: Response, next: NextFunction) => handler(req, res, next));
  server = app.listen(0, done);
});

afterAll(done => { server.close(done); });

/** Bu istek icin isleyiciyi belirler ve `GET /probe` cagirir. */
function probe(respond: express.RequestHandler) {
  handler = respond;
  return request(server).get('/probe');
}

describe('a correlation id is issued for every request', () => {
  it('generates one and echoes it back on the response', async () => {
    const seen: Array<string | undefined> = [];
    const res = await probe((_req, response) => {
      seen.push(currentRequestId());
      response.json({ ok: true });
    });

    expect(res.status).toBe(200);
    expect(res.headers['x-request-id']).toMatch(HEX_128);
    // Yanıt başlığındaki değer, işleyicinin gördüğü değerle AYNI olmalıdır;
    // aksi hâlde kullanıcının bildirdiği kimlik günlükte bulunamazdı.
    expect(seen[0]).toBe(res.headers['x-request-id']);
  });

  it('also exposes the id on the request object as an escape hatch', async () => {
    const res = await probe((req, response) => {
      response.json({ onRequest: (req as express.Request & { requestId?: string }).requestId });
    });

    expect(res.body.onRequest).toBe(res.headers['x-request-id']);
  });

  it('issues a different id to every request', async () => {
    const respond: express.RequestHandler = (_req, response) => { response.json({ id: currentRequestId() }); };
    const first = await probe(respond);
    const second = await probe(respond);
    expect(first.body.id).not.toBe(second.body.id);
  });
});

describe('a proxy-supplied id is adopted, a hostile one is not', () => {
  it('adopts a well-formed upstream id so proxy and app logs join up', async () => {
    const upstream = 'edge-7f3a9c21b4d6e8f0';
    const res = await probe((_req, response) => { response.json({ id: currentRequestId() }); })
      .set('x-request-id', upstream);

    expect(res.body.id).toBe(upstream);
    expect(res.headers['x-request-id']).toBe(upstream);
  });

  it.each([
    ['an over-long value', 'x'.repeat(129)],
    ['a too-short value', 'abc'],
    ['a value with spaces', 'abcdefgh ijklmnop'],
    ['a value with quotes', 'abcdefgh"injected"'],
    ['an empty value', ''],
  ])('refuses %s and issues a fresh id instead', async (_label, hostile) => {
    const res = await probe((_req, response) => { response.json({ id: currentRequestId() }); })
      .set('x-request-id', hostile);

    // İstek REDDEDİLMEZ — yalnızca kimlik güvenilir bir değerle değiştirilir.
    expect(res.status).toBe(200);
    expect(res.body.id).toMatch(HEX_128);
    expect(res.body.id).not.toBe(hostile);
  });

  it('refuses a CRLF log-injection attempt', () => {
    // Bu durum BILEREK HTTP uzerinden degil, dogrudan sinanir: Node'un kendi
    // `setHeader` katmani kontrol karakteri iceren bir basligi daha aga
    // cikmadan reddeder (OLCULDU - supertest `.set()` firlatiyor). Yani ilk
    // savunma tasima katmanindadir; buradaki kontrol IKINCI savunmadir ve
    // baslik baska bir yoldan (ornegin dahili cagri) gelirse devreye girer.
    expect(adoptRequestId('abcdefgh\r\nlevel=fatal')).toMatch(HEX_128);
  });

  it('refuses a repeated header rather than guessing which one is right', () => {
    // Aynı başlığın tekrarı Express'te dizi olarak gelir. Hangisinin doğru
    // olduğu belirsizdir; seçim yapmak sessiz bir tahmin olurdu.
    const adopted = adoptRequestId(['first-value-aaaa', 'second-value-bbbb']);
    expect(adopted).toMatch(HEX_128);
  });
});

describe('the context follows the asynchronous call tree', () => {
  it('survives await boundaries and Promise.all branches', async () => {
    const id = newRequestId();
    const observed: Array<string | undefined> = [];

    await runWithRequestContext({ requestId: id }, async () => {
      observed.push(currentRequestId());
      await new Promise(resolve => setTimeout(resolve, 1));
      observed.push(currentRequestId());

      // Paralel dallar — bir depo katmanının aynı anda birkaç sorgu açması.
      await Promise.all([
        (async () => { await Promise.resolve(); observed.push(currentRequestId()); })(),
        (async () => { await new Promise(r => setTimeout(r, 1)); observed.push(currentRequestId()); })(),
      ]);

      // Zamanlayıcı geri çağrısı — arka plan işi de aynı isteğe aittir.
      await new Promise<void>(resolve => setTimeout(() => {
        observed.push(currentRequestId());
        resolve();
      }, 1));
    });

    expect(observed).toHaveLength(5);
    expect(observed.every(value => value === id)).toBe(true);
  });

  it('keeps concurrent requests strictly isolated', async () => {
    const first = newRequestId();
    const second = newRequestId();

    const [a, b] = await Promise.all([
      runWithRequestContext({ requestId: first }, async () => {
        await new Promise(r => setTimeout(r, 5));
        return currentRequestId();
      }),
      runWithRequestContext({ requestId: second }, async () => {
        await new Promise(r => setTimeout(r, 1));
        return currentRequestId();
      }),
    ]);

    // Sızsaydı iki farklı kullanıcının olayları tek kimlikte birleşirdi.
    expect(a).toBe(first);
    expect(b).toBe(second);
    expect(a).not.toBe(b);
  });

  it('reports no context outside a request, so startup logs stay clean', () => {
    expect(currentRequestId()).toBeUndefined();
    expect(currentRequestContext()).toBeUndefined();
    expect(requestContextMixin()).toEqual({});
  });
});

describe('the authenticated actor joins the context after verification', () => {
  it('adds the user id without opening a new context', async () => {
    const id = newRequestId();
    const stages: Array<Record<string, string>> = [];

    await runWithRequestContext({ requestId: id }, async () => {
      stages.push(requestContextMixin());          // kimlik doğrulanmadan önce
      attachActor('user-42');
      await new Promise(r => setTimeout(r, 1));
      stages.push(requestContextMixin());          // doğrulandıktan sonra
    });

    expect(stages[0]).toEqual({ requestId: id });
    expect(stages[1]).toEqual({ requestId: id, userId: 'user-42' });
  });

  it('records a socket id for realtime work', async () => {
    const id = newRequestId();
    let fields: Record<string, string> = {};
    await runWithRequestContext({ requestId: id }, async () => {
      attachActor('user-9', 'socket-abc');
      fields = requestContextMixin();
    });
    expect(fields).toEqual({ requestId: id, userId: 'user-9', socketId: 'socket-abc' });
  });

  it('is a no-op outside a request instead of throwing', () => {
    expect(() => attachActor('user-1')).not.toThrow();
  });

  it('ignores an empty actor rather than logging a blank owner', async () => {
    const id = newRequestId();
    let fields: Record<string, string> = {};
    await runWithRequestContext({ requestId: id }, () => {
      attachActor(undefined);
      fields = requestContextMixin();
    });
    expect(fields).toEqual({ requestId: id });
  });
});

describe('the id reaches log records through the shared logger', () => {
  // NOT: burada `process.stdout.write` CASUSLANMAZ. Denendi ve Jest'in kendi
  // raporlayicisi da ayni akisa yazdigi icin tum test ciktisi yutuluyordu --
  // paket "ciktisiz" gorunuyordu. Bunun yerine pino'nun KENDI akisi bellege
  // yonlendirilir; global akisa hic dokunulmaz.
  it('stamps every line emitted inside the request', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of String(chunk).split('\n')) {
          if (!line.trim()) continue;
          try { lines.push(JSON.parse(line) as Record<string, unknown>); } catch { /* pino disi */ }
        }
        callback();
      },
    });

    // Uretimdeki `mixin` ile AYNI fonksiyon baglanir; kanit bu yuzden
    // gercek yapilandirmayi olcer, testin kendi kopyasini degil.
    const logger = pino({ base: { service: 'bridge-server' }, mixin: requestContextMixin }, sink);
    const id = newRequestId();

    await runWithRequestContext({ requestId: id }, async () => {
      logger.warn({ event: 'probe.before_auth' }, 'ilk');
      attachActor('user-77');
      await new Promise(r => setTimeout(r, 1));
      logger.warn({ event: 'probe.after_auth' }, 'ikinci');
    });

    const before = lines.find(l => l.event === 'probe.before_auth');
    const after = lines.find(l => l.event === 'probe.after_auth');

    expect(before).toBeDefined();
    expect(before!.requestId).toBe(id);
    // `await` sonrasi satir da AYNI kimligi ve artik sahibi tasir.
    expect(after).toBeDefined();
    expect(after!.requestId).toBe(id);
    expect(after!.userId).toBe('user-77');
  });

  it('adds no correlation fields outside a request', async () => {
    const lines: Array<Record<string, unknown>> = [];
    const sink = new Writable({
      write(chunk, _encoding, callback) {
        for (const line of String(chunk).split('\n')) {
          if (line.trim()) { try { lines.push(JSON.parse(line)); } catch { /* yoksay */ } }
        }
        callback();
      },
    });
    const logger = pino({ mixin: requestContextMixin }, sink);

    // Acilis / zamanlanmis is gunlukleri bos alanlarla kirlenmemelidir.
    logger.warn({ event: 'startup.probe' }, 'acilis');

    const record = lines.find(l => l.event === 'startup.probe');
    expect(record).toBeDefined();
    expect(record).not.toHaveProperty('requestId');
    expect(record).not.toHaveProperty('userId');
  });

  it('wires the mixin into the real shared logger configuration', async () => {
    // Yukaridaki testler mixin'i dogrudan baglar. Bu test, URUN
    // yapilandirmasinin da onu gercekten kullandigini dogrular; aksi hâlde
    // mixin calisir ama uygulama gunlugunde hicbir sey degismezdi.
    const source = readFileSync(join(__dirname, '..', 'lib', 'logger.ts'), 'utf8');
    expect(source).toContain('mixin: requestContextMixin');
  });
});
