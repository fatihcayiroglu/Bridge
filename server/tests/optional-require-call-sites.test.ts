// server/tests/optional-require-call-sites.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// `tryRequire` ÇAĞRI YERLERİ — SESSİZ ÖLÜ ENTEGRASYON KORUMASI
// ════════════════════════════════════════════════════════════════════════════
// BULUNAN KUSUR (bu incelemede ölçüldü, varsayılmadı):
//
// `lib/_optional-require.ts` içindeki `require`, ÇAĞRILDIĞI KAYNAK DOSYAYA
// bağlıdır — çağıranın dosyasına değil. Yani göreceli her id `server/lib/`
// klasörüne göre çözülüyordu. `middleware/rateLimit.ts` içindeki
// `tryRequire('./ipBan')` çağrısı `server/lib/ipBan` arıyordu ve modül orada
// olmadığı için `catch` bloğu hatayı yutup `null` döndürüyordu.
//
// ── ÖLÇÜLEN ETKİ ───────────────────────────────────────────────────────────
//   · OTOMATİK IP BAN hiç çalışmadı (dosya başlığı "Sprint 41: aktif" diyor)
//   · rate-limit metrikleri ve anomali sayacı hiç artmadı
//   · giden webhook'lar ne REST ne socket mesaj gönderiminde tetiklendi
//   · müzik komutları (`!`) sessizce yok sayıldı
//   · canvas çok düğümlü Redis pub/sub yedeği devre dışı kaldı
//   · eklenti kancaları: `'../../plugins/loader'` YÜKLENİYORDU ama depo
//     kökündeki farklı bir modülü — `hooks` export etmeyen — bu yüzden
//     `?.hooks` `undefined` olup kancalar da sessizce kapandı
//
// Hiçbiri log basmıyordu; hiçbir test göremezdi. Bir `catch` bloğu bir
// ÖZELLİĞİ yutuyordu.
//
// ── BU TEST NEYİ GARANTİ EDER ──────────────────────────────────────────────
// 1. Kaynakta göreceli bir `tryRequire` çağrısı `require` parametresi
//    OLMADAN yazılamaz (statik denetim — çalıştırılması gerekmez).
// 2. Her göreceli id GERÇEKTEN çözülür ve beklenen dışavurumu taşır
//    (runtime denetimi — dosya taşınırsa kırmızıya döner).
//
// (1) olmadan (2) yeni eklenen bir çağrıyı kaçırır; (2) olmadan (1) yanlış
// yazılmış ama sözdizimsel olarak doğru bir yolu kaçırır.

import fs from 'fs';
import path from 'path';

const SERVER = path.resolve(__dirname, '..');
const SCAN_DIRS = ['middleware', 'lib', 'db', 'routes', 'socket', 'app', 'jobs', 'plugins'];

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      walk(full, out);
    } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

// `tryRequire<...>('./x')` — ikinci parametresi olmayan GÖRECELİ çağrılar.
const RELATIVE_CALL = /tryRequire\s*(?:<[\s\S]*?>)?\s*\(\s*(['"])(\.{1,2}\/[^'"]+)\1\s*(,\s*require\s*)?\)/g;

describe('statik denetim: göreceli tryRequire çağrıları', () => {
  it('her göreceli çağrı KENDİ `require`’ını geçirir', () => {
    const offenders: string[] = [];

    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(SERVER, dir))) {
        if (file.endsWith('_optional-require.ts')) continue;
        const src = fs.readFileSync(file, 'utf8');
        for (const m of src.matchAll(RELATIVE_CALL)) {
          if (!m[3]) {
            offenders.push(`${path.relative(SERVER, file).replace(/\\/g, '/')}  →  '${m[2]}'`);
          }
        }
      }
    }

    // Hata mesajı NEDENİ anlatır; yalnız "false !== true" demez.
    expect(offenders).toEqual([]);
  });

  it('denetim gerçekten çağrı buluyor (kendi kendini doğrulama)', () => {
    // Regex sessizce hiçbir şey eşleştirmezse yukarıdaki test SONSUZA DEK
    // yeşil kalırdı ve hiçbir şey korumazdı.
    let found = 0;
    for (const dir of SCAN_DIRS) {
      for (const file of walk(path.join(SERVER, dir))) {
        if (file.endsWith('_optional-require.ts')) continue;
        found += [...fs.readFileSync(file, 'utf8').matchAll(RELATIVE_CALL)].length;
      }
    }
    expect(found).toBeGreaterThanOrEqual(10);
  });

  it('regex, parametresi EKSİK bir çağrıyı gerçekten yakalar (negatif kontrol)', () => {
    const bad = `const m = tryRequire<Foo>('./ipBan');`;
    const good = `const m = tryRequire<Foo>('./ipBan', require);`;
    const pkg = `const m = tryRequire<Foo>('redis');`;

    expect([...bad.matchAll(RELATIVE_CALL)][0]?.[3]).toBeUndefined();   // ihlal
    expect([...good.matchAll(RELATIVE_CALL)][0]?.[3]).toBeDefined();    // uygun
    expect([...pkg.matchAll(RELATIVE_CALL)]).toHaveLength(0);           // paket adı: konu dışı
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('runtime denetimi: opsiyonel entegrasyonlar GERÇEKTEN çözülüyor', () => {
  // Bu tablonun her satırı, sessizce ölmüş bir ÜRÜN ÖZELLİĞİDİR.
  const CASES: Array<{ feature: string; from: string; id: string; expectExport: string }> = [
    { feature: 'otomatik IP ban',        from: 'middleware/rateLimit.ts',           id: './ipBan',                        expectExport: 'banIp' },
    { feature: 'rate-limit metrikleri',  from: 'middleware/rateLimit.ts',           id: './metrics',                      expectExport: 'trackRateLimitHit' },
    { feature: 'giden webhook (REST)',   from: 'routes/servers/core.ts',            id: '../outgoingWebhooks',            expectExport: 'dispatchEvent' },
    { feature: 'giden webhook (socket)', from: 'socket/handlers/messages-send.ts',  id: '../../routes/outgoingWebhooks',  expectExport: 'dispatchEvent' },
    { feature: 'eklenti kancaları',      from: 'socket/handlers/messages-send.ts',  id: '../../plugins/loader',           expectExport: 'hooks' },
    { feature: 'canvas çok düğüm',       from: 'socket/handlers/canvas.ts',         id: '../../lib/redisAdapter',         expectExport: 'cache' },
    { feature: 'metrics → socket',       from: 'middleware/metrics.ts',             id: '../socket',                      expectExport: 'socketUsers' },
  ];

  it.each(CASES)('$feature: $from → $id çözülür ve `$expectExport` taşır', ({ from, id, expectExport }) => {
    // Çağıranın KENDİ dizininden çöz — üretimdeki `require` bağlamıyla aynı.
    const callerDir = path.dirname(path.join(SERVER, from));
    const target = path.resolve(callerDir, id);
    // Node üretimde dizin require'ını `index.js`e çözer. Jest'in TS resolver'ı
    // mutlak bir dizini bazen dizinin KENDİSİ olarak döndürüyor (EISDIR).
    // Dizinse kanonik index kaynağını açıkça çözerek aynı export sözleşmesini ölç.
    const resolvable = fs.existsSync(target) && fs.statSync(target).isDirectory()
      ? path.join(target, 'index.ts')
      : target;
    const resolved = require.resolve(resolvable);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require(resolved) as Record<string, unknown>;
    expect(mod).toBeTruthy();
    expect(Object.keys(mod)).toContain(expectExport);
  });

  it('DEPO KÖKÜNDEKİ plugins/loader `hooks` EXPORT ETMEZ (kusurun kanıtı)', () => {
    // Eski kod bu modülü yüklüyordu. Yüklenmesi "çalışıyor" demek DEĞİLDİ:
    // `?.hooks` `undefined` olduğu için kancalar sessizce kapanıyordu.
    // Bu iddia, düzeltmenin neden yalnızca "modül bulundu" ile ölçülemeyeceğini
    // sabitler.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rootLoader = require(path.resolve(SERVER, '../plugins/loader')) as Record<string, unknown>;
    expect(Object.keys(rootLoader)).not.toContain('hooks');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('tryRequire sözleşmesi', () => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tryRequire } = require('../lib/_optional-require') as typeof import('../lib/_optional-require');

  it('PAKET adı çözümleyicisiz çalışır (mevcut davranış korunur)', () => {
    expect(tryRequire('path')).toBeTruthy();
  });

  it('OLMAYAN paket null döner, fırlatmaz', () => {
    expect(tryRequire('bu-paket-yok-12345')).toBeNull();
  });

  it('GÖRECELİ id çözümleyicisiz null döner VE GÜRÜLTÜ ÇIKARIR', () => {
    // Sessiz null bu kusurun üretime çıkma sebebiydi. Artık her zaman loglanır.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(tryRequire('./ipBan')).toBeNull();
      expect(spy).toHaveBeenCalled();
      expect(String(spy.mock.calls[0][0])).toMatch(/göreceli|tryRequire/i);
    } finally {
      spy.mockRestore();
    }
  });

  it('GÖRECELİ id çözümleyiciyle DOĞRU modülü bulur', () => {
    const mod = tryRequire<Record<string, unknown>>('./_optional-require', require);
    expect(mod).toBeNull();   // testin kendi dizininde yok → doğru çözümlendi

    const real = tryRequire<Record<string, unknown>>('../lib/_optional-require', require);
    expect(real && 'tryRequire' in real).toBe(true);
  });
});
