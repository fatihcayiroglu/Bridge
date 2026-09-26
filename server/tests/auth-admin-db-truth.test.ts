// server/tests/auth-admin-db-truth.test.ts
// FAZ G1 — YÖNETİCİ YETKİSİ TOKEN'DAN DEĞİL DB'DEN OKUNUR.
//
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR
// ════════════════════════════════════════════════════════════════════════════
// `middleware/auth.ts::requireAdmin` yetki kararını TAMAMEN JWT içeriğinden
// veriyordu:
import type { JwtPayload } from '../middleware/auth';
import { makeJwtUser } from './helpers/userDoubles';
import type { Request, Response, NextFunction } from 'express';
//
//     if (!user?.isAdmin && user?.role !== 'admin' && !user?.flags?.includes('admin'))
//
// Bu, "yetkiyle ilgili iddiayı token'dan okuma" kusurudur. `authMiddleware`
// `tokenVersion` denetimi yapar ama o yalnızca OTURUM İPTALİNİ kapsar; rol
// değişikliğini kapsamaz. Sonuç: yöneticiliği ALINMIŞ bir kullanıcı, elindeki
// token'ın süresi dolana kadar yönetici kalırdı.
//
// DÜRÜSTLÜK NOTU: ölçüm, bu fonksiyonun GERÇEK çağıranı olmadığını gösterdi
// (`routes/webpush.ts` yalnızca import ediyordu, hiçbir rotaya bağlamıyordu).
// Yani SEVK EDİLEN bir açık değildi — doğru görünen, yanlış çalışan bir
// tuzaktı. Kanonik sahip `routes/admin/middleware.ts::adminOnly`dir ve zaten
// DB'den okur; bu test iki uygulamanın da aynı sözleşmede kalmasını zorlar.

process.env.JWT_SECRET = 'test-jwt-secret-long-enough-32chars!!';
process.env.NODE_ENV   = 'test';

import { createMockDb } from './helpers/mockDb';
const mockDb = createMockDb();

jest.mock('../db/index', () => mockDb);
jest.mock('../db/loader', () => require('../db/index'));

import request from 'supertest';
import express from 'express';
import { requireAdmin } from '../middleware/auth';

const GERCEK_ADMIN = 'admin-gercek';
const SAHTE_ADMIN  = 'admin-sahte';   // token'da admin, DB'de DEĞİL

/**
 * `authMiddleware`i taklit eder: `req.user`ı DOĞRUDAN token iddiasından
 * doldurur. Saldırganın elindeki bayat/yükseltilmiş token tam olarak böyle
 * görünür — bu yüzden testte de böyle modellenir.
 */
// Iddia BICIMSEL olarak gecerli bir JWT yukudur; YALAN `isAdmin`/`role`
// alanlarindadir. Testin modelledigi saldiri tam olarak budur.
function fakeAuth(claim: Partial<JwtPayload> & { id: string }) {
  return (req: Request, _res: Response, next: NextFunction) => { req.user = makeJwtUser(claim.id, claim); next(); };
}

function makeApp(claim: Partial<JwtPayload> & { id: string }) {
  const app = express();
  app.use(express.json());
  app.get('/korumali', fakeAuth(claim), requireAdmin, (_req: Request, res: Response) => res.json({ ok: true }));
  return app;
}

beforeAll(async () => {
  await mockDb.users.insert({ _id: GERCEK_ADMIN, username: 'a', displayName: 'A', isAdmin: true });
  await mockDb.users.insert({ _id: SAHTE_ADMIN,  username: 'b', displayName: 'B', isAdmin: false });
});

// ════════════════════════════════════════════════════════════════════════════
describe('requireAdmin — DB gerçeği', () => {
  it('POZİTİF KONTROL: DB\'de gerçekten admin olan GEÇER', async () => {
    // Bu kontrol olmadan aşağıdaki redler, middleware herkesi reddetse de geçerdi.
    const app = makeApp({ id: GERCEK_ADMIN, isAdmin: true });

    const res = await request(app).get('/korumali');

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('token isAdmin:true diyor ama DB HAYIR diyorsa REDDEDİLİR', async () => {
    // Asıl kusur buydu: yöneticiliği alınmış kullanıcının bayat token'ı.
    const app = makeApp({ id: SAHTE_ADMIN, isAdmin: true });

    const res = await request(app).get('/korumali');

    expect(res.status).toBe(403);
  });

  it('token role:"admin" iddiası da yetki VERMEZ', async () => {
    const app = makeApp({ id: SAHTE_ADMIN, role: 'admin' });

    const res = await request(app).get('/korumali');

    expect(res.status).toBe(403);
  });

  it('token flags:["admin"] iddiası da yetki VERMEZ', async () => {
    const app = makeApp({ id: SAHTE_ADMIN, flags: ['admin'] });

    const res = await request(app).get('/korumali');

    expect(res.status).toBe(403);
  });

  it('DB\'de OLMAYAN kullanıcı reddedilir (fail-closed)', async () => {
    const app = makeApp({ id: 'hic-olmayan-kullanici', isAdmin: true });

    const res = await request(app).get('/korumali');

    expect(res.status).toBe(403);
  });

  it('kimlik yoksa 401 döner (403 ile karıştırılmaz)', async () => {
    const app = express();
    app.use(express.json());
    app.get('/korumali', (req: Request, _res: Response, next: NextFunction) => { next(); }, requireAdmin, (_q, res) => res.json({ ok: true }));

    const res = await request(app).get('/korumali');

    expect(res.status).toBe(401);
  });
});
