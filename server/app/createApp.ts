import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

// Sprint 72: eslint-disable yorumları kaldırıldı — tüm importlar zaten ESM (import syntax).
import { rateLimit } from '../middleware/rateLimit';
import { verifiedAccessTokenSubject } from '../middleware/auth';
import { enforceApiCsrf } from '../middleware/csrf';
import { metricsMiddleware } from '../middleware/metrics';
import { ipBanMiddleware } from '../middleware/ipBan';
import { ipReputationMiddleware } from '../middleware/ipReputation';
import { securityHeaders } from '../lib/security';
import { requestIdMiddleware } from '../middleware/requestId';
import { uploadAuthz } from '../middleware/uploadAuthz';
import { uploadRoot } from '../lib/runtimePaths';
import { envSafeInt } from '../lib/envNumbers';
import { RL_GLOBAL_MAX_DEFAULT } from '../lib/rateLimitDefaults';
import { BRIDGE_VERSION } from '../lib/version';

export interface AppBundle {
  app: Application;
  allowedOrigins: string[];
}

/** NULL bayt (0x00). Kaynakta duz karakter olarak YAZILMAZ. */
const NULL_BYTE = String.fromCharCode(0);

export function createApp(): AppBundle {
  const app = express();
  const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : ['http://localhost:3001'];

  // __dirname kaynaktan çalışırken server/app, derlenmiş halde server/dist/app olur.
  // client/ dizini bu iki durumda farklı derinlikte kalır — ikisini de dene.
  const clientRoot =
    [path.join(__dirname, '../../client'), path.join(__dirname, '../../../client')]
      .find((p) => fs.existsSync(p)) ?? path.join(__dirname, '../../client');

  // (Kaldirildi) Burada `index.html` her acilista SENKRON okunuyor ve sonuc
  // hicbir yerde kullanilmadan atiliyordu; istekte servis edilen HTML zaten
  // asagida `indexPath` uzerinden okunur.

  // ── KORELASYON KİMLİĞİ EN BAŞTA ─────────────────────────────────────────
  // Zincirin ilk halkasıdır: erken dönen bir middleware (hız sınırı, CSRF,
  // IP yasağı) bile kimliği taşıyan bir günlük satırı üretebilsin diye.
  app.use(requestIdMiddleware);

  app.use(securityHeaders);
  app.use((_req: Request, res: Response, next: NextFunction) => {
    res.locals.cspNonce = crypto
      .randomBytes(16)
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
    next();
  });

  app.use(
    cors({
      origin: (origin, cb) =>
        !origin || allowedOrigins.includes(origin)
          ? cb(null, true)
          : cb(new Error('CORS: origin not allowed')),
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      exposedHeaders: ['X-Cache', 'X-Bridge-First-Unread-Id'],
      credentials: true,
    }));

  // CORS reddi KASITLI bir yetkilendirme kararıdır; `cors` paketinin
  // `cb(new Error(...))` çağrısı ise Express'e beklenmedik bir sunucu hatası
  // gibi görünüp 500 ürettiriyordu. Yanlış semantik: istemciye "sunucu bozuk"
  // deniyor, loglara her yabancı origin için yığın izi düşüyordu.
  //
  // Bu işleyici YALNIZCA o hatayı 403'e çevirir. Politika DEĞİŞMEZ:
  //   • istek yine rota katmanına ULAŞMAZ (reddedilmiş kalır),
  //   • Access-Control-Allow-Origin yine VERİLMEZ,
  //   • gövde geneldir, ayrıntı sızdırmaz.
  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof Error && err.message === 'CORS: origin not allowed') {
      res.status(403).json({ error: 'Origin not allowed' });
      return;
    }
    next(err);
  });


  const extraConnect = (process.env.EXTRA_CONNECT_SRC || '').split(',').filter(Boolean);
  const extraImg     = (process.env.EXTRA_IMG_SRC     || '').split(',').filter(Boolean);
  // Sentry CDN — yalnızca DSN tanımlıysa eklenir
  const sentryCdnHosts = process.env.CLIENT_SENTRY_DSN
    ? ['https://browser.sentry-cdn.com']
    : [];
  // Sentry ingest endpoint — hataların gönderileceği host (DSN'den türetilir)
  const sentryIngestHosts: string[] = [];
  if (process.env.CLIENT_SENTRY_DSN) {
    try {
      const dsnUrl = new URL(process.env.CLIENT_SENTRY_DSN);
      sentryIngestHosts.push(`https://${dsnUrl.hostname}`);
    } catch { /* geçersiz DSN — atla */ }
  }

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc:    ["'self'"],
          scriptSrc:     ["'self'", ...sentryCdnHosts, (_req, res) => `'nonce-${(res as Response).locals.cspNonce || ''}'`],
          styleSrc:      ["'self'", (_req, res) => `'nonce-${(res as Response).locals.cspNonce || ''}'`],
          styleSrcElem:  ["'self'", (_req, res) => `'nonce-${(res as Response).locals.cspNonce || ''}'`],
          // Svelte/UI surfaces use bounded dynamic style attributes (position, progress,
          // user-selected colors). Keep that narrow CSP3 exception on attributes only;
          // executable <style> blocks remain nonce/self constrained above.
          styleSrcAttr:  ["'unsafe-inline'"],
          imgSrc:        ["'self'", 'data:', 'blob:', 'https://media.tenor.com', 'https://media1.tenor.com', ...extraImg],
          mediaSrc:      ["'self'", 'blob:'],
          connectSrc:    ["'self'", 'wss:', 'ws:', ...sentryIngestHosts, ...extraConnect],
          fontSrc:       ["'self'", 'https://fonts.gstatic.com'],
          frameSrc:      ["'none'"],
          objectSrc:     ["'none'"],
          baseUri:       ["'self'"],
          formAction:    ["'self'"],
          workerSrc:     ["'self'", 'blob:'],
          scriptSrcElem: ["'self'", ...sentryCdnHosts, (_req, res) => `'nonce-${(res as Response).locals.cspNonce || ''}'`],
        },
      },
      crossOriginEmbedderPolicy: false,
    }));

  app.use(ipBanMiddleware);
  app.use(ipReputationMiddleware);
  app.use(cookieParser());
  // Global /api kotası. Diğer TÜM limitler middleware/rateLimit.ts DEFAULTS
  // üzerinden ortam değişkeniyle ayarlanabilirken bu tek çağrı sabit kodluydu,
  // dolayısıyla RL_GLOBAL_MAX hiçbir etki etmiyordu. Varsayılan davranış aynı
  // (200/dk); yalnızca diğerleriyle aynı şekilde yapılandırılabilir hale geldi.
  // ── ORKESTRATÖR SAĞLIK YOKLAMALARI HIZ SINIRINDAN MUAFTIR ────────────────
  //
  // ÖLÇÜLEN KUSUR (bağımlılık kaos testi, scripts/dependency-chaos.cjs):
  // Redis durdurulduğunda `/api/health/live` 503 döndü. Canlılık rotasının
  // kendisi KOŞULSUZ 200'dür (routes/health.ts); 503 küresel `/api` hız
  // sınırından geliyordu: yapılandırılmış Redis otoritesi erişilemez olunca
  // sınırlayıcı KAPALI BAŞARISIZ olur ve isteği reddeder.
  //
  // Sıradan API trafiği için kapalı başarısız olmak DOĞRUDUR — aksi hâlde
  // saldırgan Redis'i düşürerek tüm kotaları atlatabilirdi. Ama CANLILIK
  // yoklaması için YIKICIDIR:
  //
  //   Redis kesintisi → /health/live 503 → Kubernetes konteyneri ÖLDÜRÜR
  //   → yeniden başlatma Redis'i onarmaz → tüm filoda yeniden başlatma
  //   döngüsü → geçici bir bağımlılık arızası TAM kesintiye dönüşür.
  //
  // Sağlık yoklamaları orkestratörden sabit tempoda gelir; onları hız
  // sınırlamak güvenlik sağlamaz, yalnızca arıza yükseltir. HAZIRLIK
  // (`/health/ready`) yine bağımlılıklara göre 503 döner — bu KASITLIDIR ve
  // kendi mantığından gelir, sınırlayıcıdan değil.
  const globalApiRateLimit = rateLimit(
    envSafeInt('RL_GLOBAL_MAX', RL_GLOBAL_MAX_DEFAULT, { min: 1, max: 1_000_000 }),
    envSafeInt('RL_GLOBAL_WIN', 60_000, { min: 1_000, max: 24 * 60 * 60_000 }),
    'global',
    // Bu sınırlayıcı rotaların kimlik doğrulamasından ÖNCE çalışır. Kimlik
    // olmadan her kimlikli istek IP kovasına düşüyor ve aynı NAT arkasındaki
    // kullanıcılar birbirini banlatıyordu (F21-11-04, ölçüldü).
    { identify: verifiedAccessTokenSubject },
  );
  const HEALTH_PROBE_PATHS = new Set(['/health/live', '/health/ready']);
  app.use('/api', (req: Request, res: Response, next: NextFunction) => {
    // `req.path` bu router içinde `/api` öneki DÜŞÜRÜLMÜŞ hâldedir.
    if (HEALTH_PROBE_PATHS.has(req.path)) return next();
    return globalApiRateLimit(req, res, next);
  });
  app.use('/api', enforceApiCsrf);
  app.use(metricsMiddleware);
  // Federation imza doğrulaması için ham JSON gövdesini parser sırasında al.
  // Ayrı bir data/end dinleyicisi stream'i tükettiği için express.json() sonrası
  // req.body undefined kalıyordu.
  app.use(express.json({
    limit: '2mb',
    verify: (req, _res, buf) => {
      (req as typeof req & { rawBody: string }).rawBody = buf.toString('utf8');
    },
  }));

  // ── NULL BAYT REDDI ──────────────────────────────────────────────────────
  //
  // ════════════════════════════════════════════════════════════════════════
  // KAPATILAN GERCEK KUSUR (FUZZING ILE BULUNDU)
  // ════════════════════════════════════════════════════════════════════════
  // PostgreSQL `text` degerlerinde NULL bayta (0x00) izin VERMEZ ve surucu
  // su hatayi firlatir:
  //
  //     invalid byte sequence for encoding "UTF8": 0x00
  //
  // Bu hata rota icinde yakalanmiyordu; istek islenmemis istisnayla 500
  // donuyordu. Fuzzing iki uctan dogruladi:
  //
  //     POST /api/servers  { name: "\0..." }              -> 500
  //     POST /api/login    { username: "\0..." }          -> 500   (KIMLIKSIZ)
  //
  // `/api/login` kimlik dogrulamasi GEREKTIRMEZ; yani herhangi bir anonim
  // istemci istedigi kadar 500 uretebiliyordu. Sorun bu iki uca ozel de
  // degildi: NULL bayt tasiyan HERHANGI bir metin alani, veritabanina
  // ulastigi anda ayni sonucu verir.
  //
  // ── NEDEN MERKEZI COZUM ─────────────────────────────────────────────────
  // Tek tek rotalara dogrulama eklemek bu sinifi kapatmaz; yarin eklenen bir
  // uc yine acik olur. NULL bayt hicbir mesru kullanici metninde bulunmaz,
  // bu yuzden GIRIS SINIRINDA reddedilir ve istemci net bir 400 alir.
  //
  // Kapsam dar tutuldu: yalnizca 0x00 reddedilir. Diger kontrol karakterleri
  // (satir sonu, sekme, emoji, RTL isaretleri) MESRU olabilir ve DOKUNULMAZ.
  //
  // ── ONEMLI: HAM GOVDE YETMEZ ────────────────────────────────────────────
  // Ilk deneme `rawBody` metnine bakiyordu ve CALISMIYORDU: JSON icinde NULL
  // bayt `` KACIS DIZISI olarak tasinir; ham metinde `\`, `u`, `0`...
  // karakterleri vardir, gercek 0x00 baytı YOKTUR. Bayt ancak `JSON.parse`
  // cozdukten SONRA olusur. Bu yuzden AYRISTIRILMIS govde gezilir.
  app.use('/api', (req, res, next) => {
    const seen = new WeakSet<object>();

    const hasNull = (v: unknown, depth = 0): boolean => {
      if (depth > 12) return false;                  // asiri derin yapiya girme
      if (typeof v === 'string') return v.includes(NULL_BYTE);
      if (v && typeof v === 'object') {
        if (seen.has(v as object)) return false;     // dongusel referans
        seen.add(v as object);
        for (const item of Object.values(v as Record<string, unknown>)) {
          if (hasNull(item, depth + 1)) return true;
        }
      }
      return false;
    };

    const inUrl = typeof req.url === 'string' &&
      (req.url.includes('%00') || req.url.includes(NULL_BYTE));

    if (inUrl || hasNull(req.body)) {
      return void res.status(400).json({ error: 'Null bytes are not allowed' });
    }
    return void next();
  });

  // ÖZEL EK YETKİLENDİRMESİ — statik servisten ÖNCE.
  // `express.static` hiçbir yetki denetimi yapmaz; kök seviyedeki mesaj
  // ekleri bu middleware olmadan URL'yi bilen HERKESE açıktı.
  app.use('/uploads', uploadAuthz());

  app.use(
    '/uploads',
    express.static(uploadRoot(), {
      setHeaders: (res: Response, filePath: string) => {
        const ext = path.extname(filePath).toLowerCase();
        const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.tiff'];
        // Her upload için X-Content-Type-Options: nosniff — MIME sniffing önleme
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Frame-Options', 'DENY');
        // Görüntü ve SVG dışındaki tüm dosyalar attachment olarak indirilir
        if (!imageExts.includes(ext) && ext !== '.svg') {
          res.setHeader('Content-Disposition', 'attachment');
          // Tarayıcı çalıştırma riski olan uzantılar için ek CSP
          if (['.html', '.htm', '.js', '.mjs', '.ts', '.css'].includes(ext)) {
            res.setHeader('Content-Security-Policy', "default-src 'none'");
          }
        }
        if (ext === '.svg') {
          res.setHeader('Content-Type', 'image/svg+xml');
          // sandbox + hiçbir kaynak yok: SVG içindeki script/stil çalışamaz
          res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'none'; sandbox");
        }
      },
    }));

  const clientDist = path.join(clientRoot, 'dist');
  const clientSrc  = clientRoot;
  const staticRoot =
    fs.existsSync(clientDist) && fs.existsSync(path.join(clientDist, 'index.html'))
      ? clientDist
      : clientSrc;

  // Sunucu tarafından client'a inject edilecek konfigürasyon.
  // Yalnızca PUBLIC değerler buraya gelir — gizli anahtarlar asla.
  const _clientSentryDsn     = process.env.CLIENT_SENTRY_DSN     || '';
  const _clientAppVersion    = BRIDGE_VERSION;
  const _clientEnv           = process.env.NODE_ENV              || 'production';

  // client/ kökünden servis ederken ham index.html derlenmemiş js/app.js'i çağırır
  // (client/js altında yalnızca .ts kaynakları var). scripts/build.js bu dosyanın
  // hash'li bundle'a bakan sürümünü index.dist.html olarak üretir — varsa onu kullan.
  const builtIndexInSrc = path.join(clientSrc, 'index.dist.html');
  const indexPath =
    staticRoot === clientSrc && fs.existsSync(builtIndexInSrc)
      ? builtIndexInSrc
      : path.join(staticRoot, 'index.html');

  // `/sso-callback` is a real browser navigation target from external IdPs.
  // Serve the SPA shell explicitly (there is intentionally no catch-all that
  // could hide API 404s) so the one-time session handoff can be consumed.
  // `/reset-password` is the target of the password-reset email (lib/mailer.ts). It used to
  // fall through to the API 404 JSON, so every reset link was dead (Final21 UX U-01).
  app.get(['/', '/index.html', '/sso-callback', '/reset-password'], (req: Request, res: Response) => {
    if (!fs.existsSync(indexPath)) return res.status(404).end();
    let html = fs.readFileSync(indexPath, 'utf-8');
    html = html.replace(/<script(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${res.locals.cspNonce}"$1>`);

    // Sentry DSN ve versiyon bilgisini client'a inject et.
    // DSN boşsa window.BRIDGE_SENTRY_DSN tanımsız kalır → Sentry devre dışı.
    const configLines: string[] = [];
    if (_clientSentryDsn) {
      configLines.push(`window.BRIDGE_SENTRY_DSN=${JSON.stringify(_clientSentryDsn)};`);
    }
    if (_clientAppVersion) {
      configLines.push(`window.BRIDGE_APP_VERSION=${JSON.stringify(_clientAppVersion)};`);
    }
    configLines.push(`window.BRIDGE_ENV=${JSON.stringify(_clientEnv)};`);

    if (configLines.length > 0) {
      html = html.replace(
        '</head>',
        `  <script nonce="${res.locals.cspNonce}">${configLines.join('')}</script>\n</head>`
      );
    }

    if (staticRoot !== clientDist) {
      html = html.replace('<head>', `<head>\n  <script nonce="${res.locals.cspNonce}">window.BRIDGE_DEV = true;</script>`);
    }
    // A navigation document must always be revalidated.  The service worker
    // owns offline caching; HTTP caching an old index can otherwise point a
    // client at asset hashes removed by a subsequent build.
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  // `index.html` ile AYNI gerekce: ham `marketplace.html`, build'in hic
  // uretmedigi hash'siz `js/plugin-marketplace-page.js`e bakar. Canli olcumde
  // `/marketplace` 200 donuyor ama sayfanin TEK script'i 404 aliyordu; yani
  // eklenti pazari hic calismiyordu. Build artik `marketplace.dist.html`
  // uretiyor — varsa o servis edilir.
  const builtMarketplaceInSrc = path.join(clientSrc, 'marketplace.dist.html');
  const marketplacePath =
    staticRoot === clientSrc && fs.existsSync(builtMarketplaceInSrc)
      ? builtMarketplaceInSrc
      : path.join(staticRoot, 'marketplace.html');


  /**
   * Satır içi `<script>` ve `<style>` bloklarına CSP nonce'u enjekte ederek
   * bir HTML belgesini gönderir.
   *
   * ── ÖLÇÜLEN KUSUR (Final20) ───────────────────────────────────────────────
   * `/marketplace` ve `/landing` `res.sendFile()` ile gönderiliyordu; yani
   * nonce ENJEKTE EDİLMİYORDU. Politika ise nonce tabanlıdır
   * (`script-src 'self' 'nonce-…'`, `style-src-elem 'self' 'nonce-…'`), bu
   * yüzden o sayfaların satır içi blokları TARAYICI TARAFINDAN ENGELLENİYORDU.
   *
   * Canlı ölçüm (`/marketplace`, gerçek sunucu):
   *     HTML'de blok VAR  →  `hasThemeMarker: true`
   *     ama uygulanmadı   →  `data-theme: null`, `.btn` kuralı YOK
   *     sonuç             →  bağlantı tarayıcı varsayılanı #0000ee,
   *                          koyu zeminde 1.9:1 kontrast (WCAG 1.4.3 AA = 4.5)
   *
   * Yani pazar yeri sayfası TÜM satır içi düzen CSS'ini kaybediyordu. Sayfa
   * "çalışıyor" görünüyordu çünkü harici `css/style.css` yükleniyordu.
   *
   * `index.html` yolu nonce enjeksiyonunu zaten yapıyordu; eksik olan, aynı
   * işlemin İKİNCİL sayfalara da uygulanmasıydı. Burada tek bir yardımcıda
   * toplanır ki bir sonraki sayfa da unutulmasın.
   */
  function sendHtmlWithNonce(res: Response, filePath: string): void {
    let html = fs.readFileSync(filePath, 'utf-8');
    const nonce = res.locals.cspNonce;
    html = html.replace(/<script(?![^>]*\bnonce=)([^>]*)>/gi, `<script nonce="${nonce}"$1>`);
    html = html.replace(/<style(?![^>]*\bnonce=)([^>]*)>/gi, `<style nonce="${nonce}"$1>`);
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  }

  app.get('/marketplace', (_req: Request, res: Response) => {
    if (!fs.existsSync(marketplacePath)) return res.status(404).end();
    return sendHtmlWithNonce(res, marketplacePath);
  });

  app.get(['/landing', '/about', '/home'], (_req: Request, res: Response) => {
    const landingPath = path.join(staticRoot, 'landing.html');
    if (!fs.existsSync(landingPath)) return res.redirect('/');
    // `landing.html` de satır içi `<script>`/`<style>` taşıyor; aynı sebeple
    // nonce enjeksiyonundan geçmeli.
    return sendHtmlWithNonce(res, landingPath);
  });

  // esbuild's metafile is a BUILD-TIME diagnostic artifact. It contains the
  // module graph and may contain absolute build-machine paths. It is required
  // by the bundle-budget gate, but it is never a browser runtime asset.
  // `staticRoot === clientSrc` makes `/dist/meta.json` reachable unless it is
  // denied explicitly; `staticRoot === clientDist` would expose `/meta.json`.
  app.get(['/dist/meta.json', '/meta.json'], (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    res.status(404).end();
  });

  app.use(
    express.static(staticRoot, {
      maxAge: staticRoot === clientDist ? '7d' : '0',
      etag: true,
      setHeaders: (res: Response, filePath: string) => {
        // The worker script is the cache invalidation authority.  Never cache
        // it at HTTP level, even though its other static siblings may be
        // immutable hashed assets.
        if (path.basename(filePath) === 'sw.js') {
          res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        }
      },
    }));

  return { app, allowedOrigins };
}
