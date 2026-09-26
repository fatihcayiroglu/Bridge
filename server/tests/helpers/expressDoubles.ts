// server/tests/helpers/expressDoubles.ts
//
// ════════════════════════════════════════════════════════════════════════════
// EXPRESS TEST İKİZLERİ — TEK KANONİK, TİPLİ SAHİP
// ════════════════════════════════════════════════════════════════════════════
//
// Middleware testleri şu kalıbı tekrar tekrar yazıyordu:
//
//     let req, res, next;
//     beforeEach(() => {
//       req  = { ip: '8.8.8.8', path: '/api/messages', headers: {} };
//       res  = { status: jest.fn().mockReturnThis(), json: jest.fn().mockReturnThis() };
//       next = jest.fn();
//     });
//
// Bildirimde tip olmadığı için `req`/`res`/`next` ÖRTÜK `any` olur ve HER
// kullanım yeri ayrı bir strict hatası üretir. Ölçüldü: `ipReputation.test.ts`
// içinde TEK bir `let req, res, next;` satırı **57** hata doğuruyordu.
//
// Çözüm, 57 kullanım yerini tek tek yamalamak değil, İKİZİN KENDİSİNE tip
// vermektir. Buradaki fabrikalar gerçek `Request`/`Response` yüzeyinin
// testlerde kullanılan ALT KÜMESİNİ tanımlar:
//
//   · Açıkça yazılan üyeler (`ip`, `path`, `status`, `json`, ...) TAM tiplidir;
//     yanlış kullanım derleme zamanında yakalanır.
//   · İndeks imzası, testlerin senaryoya özgü alan eklemesine izin verir
//     (`req.user`, `req.socket`, ...) — ama değerleri `unknown`tır, yani
//     sessizce `any`e düşmez.
//
// `as any` ya da `@ts-ignore` KULLANILMAZ: bunlar tipi kaybettirir; buradaki
// amaç tam tersidir.

/** Testlerin dokunduğu istek yüzeyi. Bilinmeyen alanlar `unknown` kalır. */
export interface ReqDouble {
  ip?: string;
  path?: string;
  method?: string;
  originalUrl?: string;
  url?: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: Record<string, unknown>;
  params?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Testlerin dokunduğu yanıt yüzeyi.
 *
 * `status`/`json`/`send` zincirlenebilir olmalıdır (`mockReturnThis`), çünkü
 * üretim kodu `res.status(403).json(...)` yazar; zincir kopuk olursa test
 * ÜRÜN HATASI değil, ikizin kusuru yüzünden düşer.
 */
export interface ResDouble {
  status: jest.Mock;
  json: jest.Mock;
  send: jest.Mock;
  end: jest.Mock;
  set: jest.Mock;
  setHeader: jest.Mock;
  locals: Record<string, unknown>;
  [key: string]: unknown;
}

export type NextDouble = jest.Mock;

export function makeReqDouble(overrides: Partial<ReqDouble> = {}): ReqDouble {
  return {
    ip: '203.0.113.10',
    path: '/api/test',
    method: 'GET',
    headers: {},
    query: {},
    params: {},
    ...overrides,
  };
}

export function makeResDouble(overrides: Partial<ResDouble> = {}): ResDouble {
  return {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
    send: jest.fn().mockReturnThis(),
    end: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    setHeader: jest.fn().mockReturnThis(),
    locals: {},
    ...overrides,
  };
}

export function makeNextDouble(): NextDouble {
  return jest.fn();
}

/** Üçünü birlikte kuran kısayol — en yaygın middleware test düzeni. */
export function makeMiddlewareDoubles(reqOverrides: Partial<ReqDouble> = {}): {
  req: ReqDouble; res: ResDouble; next: NextDouble;
} {
  return {
    req: makeReqDouble(reqOverrides),
    res: makeResDouble(),
    next: makeNextDouble(),
  };
}

// ── HATA ENJEKSİYONU ───────────────────────────────────────────────────────
//
// Bazı middleware testleri BİLEREK geçersiz bir istek üretir: amaç, üretim
// kodunun fail-closed davrandığını kanıtlamaktır. Express'in kendi tipleri bu
// durumu ifade edemez (`headers` her zaman vardır der), ama çalışma zamanı
// üretebilir — bozuk protokol yükseltmesi, araya giren vekil sunucu, elle
// oluşturulmuş istek nesnesi.
//
// Bu tür kasıtlı geçersizlik test dosyalarına dağılmış `as any` ile DEĞİL,
// TEK ve ADI KONMUŞ bir dikişten geçirilir: niyet okunur kalır, denetlenebilir
// olur ve tip sistemi başka hiçbir yerde gevşetilmez.

/**
 * İsteğin başlık torbasını tamamen kaldırır (kasıtlı bozuk girdi).
 *
 * `ReqDouble.headers` bilerek nullable DEĞİLDİR — normal testlerin `headers`
 * okurken null denetimi yapmak zorunda kalmaması için. Bozukluk yalnızca bu
 * fonksiyondan geçer.
 */
export function injectMissingHeaderBag(req: ReqDouble): void {
  const bag: { headers?: unknown } = req;
  bag.headers = null;
}
