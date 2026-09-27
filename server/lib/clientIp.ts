// server/lib/clientIp.ts
//
// KANONİK İSTEMCİ IP ÇÖZÜMLEYİCİSİ
//
// ════════════════════════════════════════════════════════════════════════════
// NEDEN BU DOSYA VAR — KAPATILAN GERÇEK AÇIK (P1)
// ════════════════════════════════════════════════════════════════════════════
// Bridge'te İKİ AYRI `getClientIp` uygulaması vardı ve AYNI girdide FARKLI
// yanıt veriyorlardı:
//
//   middleware/rateLimit.ts :  idx = hops.length - N
//   middleware/ipBan.ts     :  idx = hops.length - N - 1     ← BİR EKSİK
//
// TRUSTED_PROXY_COUNT=1 ve saldırganın kendi `X-Forwarded-For` başlığını
// göndermesi durumunda (proxy gerçek IP'yi SONA ekler):
//
//   X-Forwarded-For: 1.2.3.4, 203.0.113.9      (1.2.3.4 = saldırgan uydurdu)
//     rateLimit → 203.0.113.9   (DOĞRU, gerçek istemci)
//     ipBan     → 1.2.3.4       (SALDIRGAN KONTROLÜNDE)
//
// ── ÜÇ SOMUT SONUÇ ──────────────────────────────────────────────────────────
// 1. YASAK ATLATMA. Otomatik ban `rateLimit.ts:350` içinde DOĞRU IP ile
//    KAYDEDİLİYOR, ama `ipBan.ts:183` SAHTELENEBİLİR IP ile KONTROL ediyordu.
//    Yasaklı istemci herhangi bir XFF başlığı göndererek yasağı atlıyordu:
//    arama farklı bir anahtara bakıyor.
// 2. İTİBAR ZEHİRLENMESİ. `ipReputation.ts:233` aynı sahtelenebilir değeri
//    kullanıyordu; saldırgan başka bir IP'nin itibarını bozabilirdi.
// 3. SAHTE DENETİM KAYDI. Üç admin rotası yönetici IP'sini buradan alıyordu,
//    yani denetim kaydındaki aktör IP'si UYDURULABİLİRDİ.
//
// ── GÜVEN MODELİ (AÇIK VE TEK) ──────────────────────────────────────────────
// `X-Forwarded-For` İSTEMCİ TARAFINDAN YAZILABİLİR bir başlıktır. Yalnızca
// SON N girdinin bizim kontrolümüzdeki proxy'ler tarafından eklendiğini
// biliyorsak güvenilebilir. Bunu bilen tek şey OPERATÖRDÜR; bu yüzden tek
// otorite açık yapılandırmadır:
//
//   TRUSTED_PROXY_COUNT = 0  → önümüzde proxy YOK. XFF'e ASLA güvenme.
//   TRUSTED_PROXY_COUNT = N  → tam olarak N güvenilen proxy var.
//
// VARSAYILAN 0'DIR — KAPALI DEVRE. Eski varsayılan 1 idi: doğrudan internete
// açık bir kurulumda bu, herkesin kendi IP'sini uydurabilmesi demekti.
//
// Eski kod bunun yerine "req.ip loopback mi?" sezgisini kullanıyordu. Bu iki
// yönden de yanlıştı: proxy ayrı bir kapsayıcıda/hostta ise (Docker Compose'da
// olağan durum) req.ip proxy'nin IP'sidir, loopback DEĞİLDİR — o zaman XFF hiç
// okunmaz ve TÜM istemciler tek bir IP'ye çöker (tek kullanıcının kötüye
// kullanımı herkesi yasaklatır).

import type { IncomingHttpHeaders } from 'http';

export interface IpRequestLike {
  ip?: string;
  headers: IncomingHttpHeaders;
  socket?: { remoteAddress?: string };
}

/** IPv4-mapped IPv6 önekini soyar: `::ffff:1.2.3.4` → `1.2.3.4`. */
function normalize(ip: string): string {
  return ip.replace(/^::ffff:/i, '').trim();
}

/**
 * Güvenilen proxy sayısı. Her çağrıda okunur (test edilebilirlik için);
 * geçersiz/negatif değerler 0 sayılır — yani KAPALI DEVRE.
 */
export function trustedProxyCount(): number {
  const raw = process.env.TRUSTED_PROXY_COUNT;
  if (raw === undefined || raw === '') return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Soket düzeyindeki gerçek uzak adres — sahtelenemez. */
function socketIp(req: IpRequestLike): string {
  return normalize(req.socket?.remoteAddress ?? req.ip ?? 'unknown');
}

/**
 * İstemcinin gerçek IP'sini döndürür.
 *
 * Proxy güvenilmiyorsa (varsayılan) soket adresi kullanılır. Güveniliyorsa
 * XFF zincirinde SON N girdi bizim proxy'lerimize aittir ve gerçek istemci
 * onların hemen öncesindedir: `hops[hops.length - N]`.
 */
export function getClientIp(req: IpRequestLike): string {
  const trusted = trustedProxyCount();
  if (trusted === 0) return socketIp(req);

  const raw = req.headers['x-forwarded-for'];
  const xff = Array.isArray(raw) ? raw.join(',') : raw;
  if (!xff) return socketIp(req);

  const hops = String(xff).split(',').map(s => s.trim()).filter(Boolean);
  const idx = hops.length - trusted;

  // BEKLENENDEN AZ HOP: zincir beklediğimiz proxy'leri içermiyor. Eski kod
  // burada `hops[0]`a düşüyordu — yani TAM OLARAK saldırganın yazdığı değere.
  // Doğrusu, güvenilmeyen bir başlığa düşmek yerine soket adresini kullanmaktır.
  if (idx < 0) return socketIp(req);

  const ip = hops[idx];
  return ip ? normalize(ip) : socketIp(req);
}

/**
 * Üretim yapılandırması güvenli mi? Başlangıç doğrulaması için.
 * Döndürülen uyarılar operatöre gösterilir.
 */
export function auditProxyConfig(env: NodeJS.ProcessEnv = process.env): string[] {
  const uyarilar: string[] = [];
  const raw = env.TRUSTED_PROXY_COUNT;

  if (env.NODE_ENV === 'production' && (raw === undefined || raw === '')) {
    uyarilar.push(
      'TRUSTED_PROXY_COUNT tanımlı değil. Bridge, X-Forwarded-For başlığına ' +
      'GÜVENMEYECEK (kapalı devre). Ters proxy ARKASINDA çalışıyorsanız bunu ' +
      'proxy sayısına ayarlayın, aksi halde tüm istemciler tek IP olarak ' +
      'görünür ve hız sınırı/IP yasağı herkesi birlikte etkiler.',
    );
  }
  if (raw !== undefined && raw !== '') {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0) {
      uyarilar.push(`TRUSTED_PROXY_COUNT geçersiz ("${raw}") — 0 kabul edildi (XFF'e güvenilmiyor).`);
    } else if (n > 4) {
      uyarilar.push(
        `TRUSTED_PROXY_COUNT=${n} olağandışı yüksek. Her fazladan güvenilen hop, ` +
        'saldırganın zincire kendi değerini sokmasına izin verir.',
      );
    }
  }
  return uyarilar;
}
