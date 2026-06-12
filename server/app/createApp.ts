import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

// Sprint 72: eslint-disable yorumları kaldırıldı — tüm importlar zaten ESM (import syntax).
import { rateLimit } from '../middleware/rateLimit';
import { enforceApiCsrf } from '../middleware/csrf';
import { metricsMiddleware } from '../middleware/metrics';
import { ipBanMiddleware } from '../middleware/ipBan';
import { ipReputationMiddleware } from '../middleware/ipReputation';
import { securityHeaders } from '../lib/security';

export interface AppBundle {
  app: Application;
  allowedOrigins: string[];
}

export function createApp(): AppBundle {
  const app = express();
  const allowedOrigins: string[] = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map((s) => s.trim())
    : ['http://localhost:3001'];

  const clientIndexPath = path.join(__dirname, '../../client/index.html');
  let clientIndex = '';
  try { clientIndex = fs.readFileSync(clientIndexPath, 'utf-8'); } catch { /* optional */ }

  const sha256Source = (val: string): string =>
    `'sha256-${crypto.createHash('sha256').update(val, 'utf8').digest('base64')}'`;

  const onHashes: string[] = (() => {
    const hashes = new Set<string>();
    const re = /\son[a-zA-Z]+\s*=\s*"([^"]*)"/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(clientIndex))) hashes.add(sha256Source(m[1]!));
    return [...hashes];
  })();

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
      credentials: true,
    }));


  const extraConnect = (process.env.EXTRA_CONNECT_SRC || '').split(',').filter(Boolean);
  const extraImg     = (process.env.EXTRA_IMG_SRC     || '').split(',').filter(Boolean);
  const cdnHosts     = ['https://cdn.jsdelivr.net'];
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
          scriptSrc:     ["'self'", ...cdnHosts, ...sentryCdnHosts, "'wasm-unsafe-eval'", "'unsafe-hashes'", ...onHashes, (_req, res) => `'nonce-${(res as Response).locals.cspNonce || ''}'`],
          styleSrc:      ["'self'", "'unsafe-inline'"],
          imgSrc:        ["'self'", 'data:', 'blob:', 'https://media.tenor.com', 'https://media1.tenor.com', ...extraImg],
          mediaSrc:      ["'self'", 'blob:'],
          connectSrc:    ["'self'", 'wss:', 'ws:', ...cdnHosts, ...sentryIngestHosts, ...extraConnect],
          fontSrc:       ["'self'", 'https://fonts.gstatic.com'],
          frameSrc:      ["'none'"],
          objectSrc:     ["'none'"],
          baseUri:       ["'self'"],
          formAction:    ["'self'"],
          workerSrc:     ["'self'", 'blob:'],
          scriptSrcElem: ["'self'", ...cdnHosts, ...sentryCdnHosts, "'wasm-unsafe-eval'", (_req, res) => `'nonce-${(res as Response).locals.cspNonce || ''}'`],
        },
      },
      crossOriginEmbedderPolicy: false,
    }));

  app.use(ipBanMiddleware);
  app.use(ipReputationMiddleware);
  app.use(cookieParser());
  app.use('/api', rateLimit(200, 60_000, 'global'));
  app.use('/api', enforceApiCsrf);
  app.use(metricsMiddleware);
  // ── rawBody capture — federation imza doğrulaması için zorunlu ──────────
  // federationAuth.ts: req.rawBody üzerinden RSA imza doğrular.
  // express.json() body'yi parse etmeden ÖNCE ham veriyi yakalamalıyız;
  // aksi hâlde JSON.stringify(req.body) fallback'i imza uyuşmazlığına yol açar.
  //
  // ÖNEMLİ: multipart/form-data isteklerini ATLA — multer kendi stream
  // okuyucusunu kullanır; rawBody bu isteklerde stream'i tüketip multer'ı kırar.
  app.use((req, _res, next) => {
    const ct = (req.headers['content-type'] ?? '') as string;
    if (ct.startsWith('multipart/form-data')) return next();
    let raw = '';
    req.on('data', (chunk: Buffer | string) => { raw += chunk.toString(); });
    req.on('end', () => {
      (req as typeof req & { rawBody: string }).rawBody = raw;
      next();
    });
    // Stream hatası durumunda next() asla çağrılmazsa request askıda kalır
    req.on('error', () => {
      (req as typeof req & { rawBody: string }).rawBody = raw;
      next();
    });
  });

  app.use(express.json({ limit: '2mb' }));

  app.use(
    '/uploads',
    express.static(path.join(__dirname, '../uploads'), {
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

  const clientDist = path.join(__dirname, '../../client/dist');
  const clientSrc  = path.join(__dirname, '../../client');
  const staticRoot =
    fs.existsSync(clientDist) && fs.existsSync(path.join(clientDist, 'index.html'))
      ? clientDist
      : clientSrc;

  // Sunucu tarafından client'a inject edilecek konfigürasyon.
  // Yalnızca PUBLIC değerler buraya gelir — gizli anahtarlar asla.
  const _clientSentryDsn     = process.env.CLIENT_SENTRY_DSN     || '';
  const _clientAppVersion    = process.env.npm_package_version    || '';
  const _clientEnv           = process.env.NODE_ENV              || 'production';

  app.get(['/', '/index.html'], (req: Request, res: Response) => {
    const indexPath = path.join(staticRoot, 'index.html');
    if (!fs.existsSync(indexPath)) return res.status(404).end();
    let html = fs.readFileSync(indexPath, 'utf-8');
    html = html.replace('<script>', `<script nonce="${res.locals.cspNonce}">`);

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
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  });

  app.get('/marketplace', (_req: Request, res: Response) => {
    res.sendFile(path.join(staticRoot, 'marketplace.html'));
  });

  app.get(['/landing', '/about', '/home'], (_req: Request, res: Response) => {
    const landingPath = path.join(staticRoot, 'landing.html');
    if (!fs.existsSync(landingPath)) return res.redirect('/');
    res.sendFile(landingPath);
  });

  app.use(
    express.static(staticRoot, {
      maxAge: staticRoot === clientDist ? '7d' : '0',
      etag: true,
    }));

  return { app, allowedOrigins };
}
