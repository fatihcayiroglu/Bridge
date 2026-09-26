// e2e/_sharedip.cjs
//
// FAZ 8 — PAYLAŞILAN IP: GERÇEK YIĞIN ÜZERİNDE AMPİRİK DOĞRULAMA
//
// ════════════════════════════════════════════════════════════════════════════
// BİRİM TESTİNİN KANITLAYAMADIĞI ŞEY
// ════════════════════════════════════════════════════════════════════════════
// `tests/shared-ip-rate-limit.test.ts` katmanlı tavanı doğrular, ama Redis
// YOKKEN — yani BELLEK İÇİ yedek sayaç yolunu. Üretimde sayaçlar REDIS'te
// tutulur (`middleware/rateLimit.ts` → `hitRedis`) ve bu TAMAMEN AYRI bir kod
// yoludur. Bu betik düzeltmeyi GERÇEK sunucu + GERÇEK Redis üzerinde ölçer.
//
// SENARYO (ofis/yurt/üniversite NAT'i):
//   Aynı IP'den iki FARKLI kimlik doğrulanmış kullanıcı.
//   Kullanıcı A kendi kotasını tüketir → 429 almalı.
//   Kullanıcı B ETKİLENMEMELİ → 200 almalı.
//
// Düzeltmeden önce `combined` modu `Math.max(ipCount, userCount)` değerini TEK
// bir `max` ile kıyaslıyordu; A'nın trafiği B'yi de kilitliyordu.
//
// Sunucu bu test için DÜŞÜK bir eşikle başlatılır (E2E_RL_CSRF_MAX=5) —
// üretim yapılandırması DEĞİŞTİRİLMEZ, yalnızca ölçüm hızlanır.

const fs = require('fs');
const T = JSON.parse(fs.readFileSync(__dirname + '/fixtures/tokens.json', 'utf8'));
const BASE = process.env.BASE || 'http://127.0.0.1:3020';
const UA = 'Mozilla/5.0 Chrome/120';
const LIMIT = parseInt(process.env.LIMIT || '5', 10);

/** `/api/csrf-token` `combined` modda çalışır — paylaşılan IP sınıfının temsilcisi. */
async function hit(token) {
  const r = await fetch(BASE + '/api/csrf-token', {
    headers: { Authorization: 'Bearer ' + token, Accept: 'application/json', 'User-Agent': UA },
  });
  return r.status;
}

(async () => {
  // A kendi kotasını AŞSIN — tavana kadar değil, tavanın ÜSTÜNE.
  const aCodes = [];
  for (let i = 0; i < LIMIT + 3; i++) aCodes.push(await hit(T.alice));

  const aBlocked = aCodes.filter(c => c === 429).length;
  console.log(`A (alice)  : ${aCodes.join(',')}`);
  console.log(`A engellenen = ${aBlocked}`);

  // B AYNI IP'den gelir — komşu olarak ETKİLENMEMELİ.
  //
  // ÖNEMLİ: B, KENDİ kotasının ALTINDA kalacak kadar istek atar. Tam kotası
  // kadar atsaydı son istek kendi bütçesini tükettiği için 429 olurdu ve bu
  // "komşu kilitlendi" ile KARIŞIRDI. Ölçülen şey B'nin kendi limiti değil,
  // A'nın trafiğinden ETKİLENİP ETKİLENMEDİĞİDİR.
  //
  // Ayrım nettir: eski hatada IP kovası A tarafından zaten patlatılmış
  // olduğu için B'nin İLK isteği bile 429 dönerdi.
  const bCodes = [];
  for (let i = 0; i < Math.max(1, LIMIT - 2); i++) bCodes.push(await hit(T.bob));
  const bBlocked = bCodes.filter(c => c === 429).length;
  console.log(`B (bob)    : ${bCodes.join(',')}`);
  console.log(`B engellenen = ${bBlocked}`);

  console.log('\n── SONUC ──');
  if (aBlocked === 0) {
    console.log('BELIRSIZ: A hic engellenmedi — esik cok yuksek, olcum gecersiz.');
    process.exit(2);
  }
  if (bCodes[0] === 429) {
    console.log('DUSTU: KOMSU KILITLENDI — B nin ILK istegi bile 429 (IP kovasi paylasiliyor).');
    process.exit(1);
  }
  if (bBlocked > 0) {
    console.log('DUSTU: B kendi butcesinin altinda kalmasina ragmen engellendi.');
    process.exit(1);
  }
  console.log('GECTI: A kendi kotasini tuketti, B etkilenmedi (Redis sayac yolu).');
  process.exit(0);
})().catch(e => { console.error('HATA', e); process.exit(3); });
