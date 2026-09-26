// server/lib/_optional-require.ts
// Runtime'da yüklü olmayabilecek opsiyonel bağımlılıklar için güvenli require wrapper.
//
// Kullanım:
//   const mod = tryRequire<{ createClient: ... }>('redis');          // paket adı
//   const mod = tryRequire<Ban>('./ipBan', require);                 // GÖRECELİ yol
//
// Neden require() ve import() değil:
//   - Koşullu yükleme: modül yoksa crash yerine null döner
//   - Erken başlatma (telemetry) için senkron kalması gerekiyor
//   - OTel/Redis/Sentry production'da opsiyonel; eksikse uygulama çalışmaya devam eder
//
// ════════════════════════════════════════════════════════════════════════════
// GÖRECELİ YOLLAR NEDEN İKİNCİ PARAMETRE İSTER
// ════════════════════════════════════════════════════════════════════════════
// `require`, ÇAĞRILDIĞI KAYNAK DOSYAYA bağlıdır — çağıranın dosyasına değil.
// Buradaki `require` her zaman `server/lib/` klasörüne göre çözer. Yani
// `middleware/rateLimit.ts` içinden `tryRequire('./ipBan')` çağrısı
// `server/lib/ipBan` arar, `server/middleware/ipBan` DEĞİL.
//
// ── ÖLÇÜLEN SONUÇ (bu incelemede kanıtlandı) ───────────────────────────────
// Aşağıdaki entegrasyonların HEPSİ sessizce ÖLÜYDÜ: modül bulunamıyordu,
// `catch` bloğu hatayı yutuyordu, çağıran `if (!mod) return` ile devam
// ediyordu. Hiçbir log, hiçbir test, hiçbir uyarı yoktu.
//
//   · middleware/rateLimit.ts → './ipBan'    → OTOMATİK IP BAN hiç çalışmadı
//   · middleware/rateLimit.ts → './metrics'  → rate-limit metrikleri yok
//   · routes/servers/*.ts     → '../outgoingWebhooks'                → webhook yok
//   · socket/…/messages-send.ts → '../../routes/outgoingWebhooks'    → webhook yok
//   · socket/…/messages-send.ts → './music'                          → müzik komutu yok
//   · socket/…/canvas.ts      → '../../lib/redisAdapter'             → çok düğüm yok
//
// Ayrıca `'../../plugins/loader'` YÜKLENİYORDU ama YANLIŞ modülü: depo
// kökündeki `plugins/loader.ts` (`hooks` EXPORT ETMEZ) yükleniyordu,
// amaçlanan `server/plugins/loader.ts` değil. `mod?.hooks` bu yüzden
// `undefined` olup eklenti kancaları da sessizce devre dışı kalıyordu.
//
// ÇÖZÜM: göreceli id'lerde çağıran KENDİ `require`'ını verir; çözümleme
// çağıranın dosyasına göre yapılır. Parametre unutulursa artık SESSİZ
// DEĞİLDİR — açık bir hata loglanır (aşağıdaki guard) ve
// `tests/optional-require-call-sites.test.ts` her göreceli çağrı yerini
// statik olarak denetler.

/** `require` benzeri çözümleyici. Çağıranın modül bağlamını taşır. */
export type RequireFn = (id: string) => unknown;

export function tryRequire<T>(moduleId: string, resolveFrom?: RequireFn): T | null {
  const isRelative = moduleId.startsWith('./') || moduleId.startsWith('../');

  if (isRelative && !resolveFrom) {
    // Sessizce null DÖNDÜRMEK bu kusurun üretime çıkmasının sebebiydi.
    // Burada her zaman gürültü çıkar: yanlış çözümlenen bir yol, kaybolmuş
    // bir özellik demektir.
    console.error(
      `[tryRequire] '${moduleId}' göreceli bir yol ve çözümleyici verilmedi. ` +
      'Çözümleme server/lib/ klasörüne göre yapılır; büyük olasılıkla YANLIŞ ' +
      'modülü bulur ya da hiç bulamaz. Çağıran dosyada `tryRequire(id, require)` kullanın.'
    );
    return null;
  }

  try {
    // require() burada kasıtlı: opsiyonel runtime bağımlılığı
    const req: RequireFn = resolveFrom ?? require;
    return req(moduleId) as T;
  } catch (err) {
    if (process.env.NODE_ENV === 'e2e' || process.env.DEBUG_OPTIONAL_REQUIRE === '1') {
      console.error(`[tryRequire] failed to load ${moduleId}`, err);
    }
    return null;
  }
}
