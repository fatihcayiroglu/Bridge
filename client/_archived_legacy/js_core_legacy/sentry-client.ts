// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SentryClientPanel.svelte
//              client/js/core/sentry-client-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/sentry-client.ts
// ─────────────────────────────────────────────────────────────
// Sentry Browser SDK entegrasyonu — Bridge client tarafı hata takibi.
//
// Tasarım kararları:
//  1. Sentry SDK, chunk-boot içinde esbuild tarafından bundle edilmez.
//     Bunun yerine Sentry'nin kendi CDN build'i (<script> tag ile) lazy
//     load edilir. Böylece Sentry olmadan da uygulama çalışmaya devam eder.
//  2. DSN sunucu tarafından window.BRIDGE_SENTRY_DSN olarak inject edilir
//     (createApp.ts). DSN yoksa modül sessizce devre dışı kalır.
//  3. Mevcut errorBoundary ile entegrasyon: errorBoundary.report() ve
//     errorBoundary.crash() Sentry'ye de gönderir. Çift raporlama yok —
//     global error event handler'larını Sentry alır, errorBoundary
//     yalnızca manuel çağrılar için Sentry'ye iletir.
//  4. Kullanıcı bağlamı: auth.js login sonrasında setSentryUser() çağırır.
//  5. GDPR: DSN yoksa hiç veri gönderilmez. İleride consent flag eklenebilir.
// ─────────────────────────────────────────────────────────────

'use strict';
import { BridgeRegistry } from './bridge-registry.js';

import { createLogger } from './logger.js';
const log = createLogger('Sentry');


declare global {
  interface Window {
    Sentry?: SentrySDK;
    BRIDGE_SENTRY_DSN?: string;
    BRIDGE_APP_VERSION?: string;
    BRIDGE_ENV?: string;
    errorBoundary?: {
      report(error: unknown, context?: string): void;
      crash(error: unknown, context?: string): void;
      wrap<T extends unknown[], R>(fn: (...args: T) => R, context?: string): (...args: T) => R | undefined;
    };
    __SENTRY_INITIALIZED__?: boolean;
  }
}

// Minimal Sentry SDK tip tanımı (tam @sentry/browser tiplerini import etmeden)
interface SentrySDK {
  init(options: SentryInitOptions): void;
  captureException(error: unknown, hint?: { extra?: Record<string, unknown> }): string;
  captureMessage(message: string, level?: SentryLevel): string;
  setUser(user: SentryUser | null): void;
  setTag(key: string, value: string): void;
  setContext(name: string, context: Record<string, unknown>): void;
  addBreadcrumb(breadcrumb: SentryBreadcrumb): void;
  withScope(callback: (scope: SentryScope) => void): void;
  configureScope(callback: (scope: SentryScope) => void): void;
}

interface SentryScope {
  setExtra(key: string, value: unknown): void;
  setTag(key: string, value: string): void;
  setUser(user: SentryUser | null): void;
}

interface SentryInitOptions {
  dsn: string;
  environment?: string;
  release?: string;
  sampleRate?: number;
  tracesSampleRate?: number;
  integrations?: unknown[];
  beforeSend?: (event: Record<string, unknown>) => Record<string, unknown> | null;
  ignoreErrors?: (string | RegExp)[];
  denyUrls?: (string | RegExp)[];
}

type SentryLevel = 'fatal' | 'error' | 'warning' | 'info' | 'debug';

interface SentryUser {
  id?: string;
  username?: string;
  email?: string;
}

interface SentryBreadcrumb {
  category?: string;
  message?: string;
  level?: SentryLevel;
  data?: Record<string, unknown>;
}

// ── CDN URL (Sentry Browser SDK 8.x) ─────────────────────────
const SENTRY_CDN_URL =
  'https://browser.sentry-cdn.com/8.9.2/bundle.tracing.min.js';
const SENTRY_CDN_INTEGRITY =
  'sha384-uWAFIlQNPHzW7Fqm70N6GBdY3ZiIm/B3nAE3BbQXRyeIxSXFVR7G3+1nt2LfJ0';

// ── Filtrelenen hatalar (gürültüyü azalt) ─────────────────────
const IGNORE_ERRORS: (string | RegExp)[] = [
  // Browser extension'ları
  /extension:\/\//,
  /chrome-extension:\/\//,
  /safari-extension:\/\//,
  // Ağ hataları (geçici bağlantı sorunları)
  'Failed to fetch',
  'NetworkError',
  'Network request failed',
  'Load failed',
  // ResizeObserver (zararsız browser bug)
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications',
  // iOS Safari WKWebView yükleme hataları
  /webkit-masked-url/,
];

// ── Yok sayılan kaynak URL'leri ───────────────────────────────
const DENY_URLS: RegExp[] = [
  /extensions\//i,
  /^chrome:\/\//i,
  /^moz-extension:\/\//i,
];

let _initialized = false;
let _initPromise: Promise<boolean> | null = null;

// ── SDK Yükleme ───────────────────────────────────────────────
function _loadSentrySDK(): Promise<boolean> {
  if (_initPromise) return _initPromise;

  _initPromise = new Promise<boolean>((resolve) => {
    if (window.Sentry) { resolve(true); return; }

    const script = document.createElement('script');
    script.src = SENTRY_CDN_URL;
    // integrity check opsiyonel — CDN sürümü değişirse güncelle
    // script.integrity = SENTRY_CDN_INTEGRITY;
    // script.crossOrigin = 'anonymous';
    script.async = true;

    script.onload = () => {
      if (window.Sentry) {
        resolve(true);
      } else {
        log.warn('[Sentry] SDK yüklendi ama window.Sentry tanımsız');
        resolve(false);
      }
    };

    script.onerror = () => {
      log.warn('[Sentry] SDK CDN yüklemesi başarısız — hata takibi devre dışı');
      resolve(false);
    };

    document.head.appendChild(script);
  });

  return _initPromise;
}

// ── Sentry init ───────────────────────────────────────────────
async function _initSentry(dsn: string): Promise<void> {
  if (_initialized || window.__SENTRY_INITIALIZED__) return;

  const loaded = await _loadSentrySDK();
  if (!loaded || !window.Sentry) return;

  const isDev =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    /:\d{4,5}/.test(window.location.host);

  window.Sentry.init({
    dsn,
    environment:      window.BRIDGE_ENV || (isDev ? 'development' : 'production'),
    release:          window.BRIDGE_APP_VERSION,
    // Production'da tüm hataları yakala; dev'de %10 (Sentry event limiti)
    sampleRate:       isDev ? 0.1 : 1.0,
    // Performans tracing — isteğe bağlı, şimdilik kapalı
    tracesSampleRate: 0,
    ignoreErrors:     IGNORE_ERRORS,
    denyUrls:         DENY_URLS,

    beforeSend(event) {
      // Auth token içeren breadcrumb'ları temizle
      if (event['breadcrumbs']) {
        const crumbs = event['breadcrumbs'] as { values?: Array<{ data?: Record<string, unknown> }> };
        if (Array.isArray(crumbs.values)) {
          crumbs.values = crumbs.values.map((b) => {
            if (b.data?.['Authorization']) {
              return { ...b, data: { ...b.data, Authorization: '[Filtered]' } };
            }
            return b;
          });
        }
      }
      return event;
    },
  });

  _initialized = true;
  window.__SENTRY_INITIALIZED__ = true;

  // Uygulama bağlamını ekle
  window.Sentry.setTag('platform', _getPlatform());

  if (isDev) {
    log.info('[Bridge] Sentry aktif (dev — %10 sample rate)');
  }
}

// ── Platform tespiti ──────────────────────────────────────────
function _getPlatform(): string {
  if (navigator.userAgent.includes('Electron')) return 'electron';
  if (window.matchMedia('(display-mode: standalone)').matches) return 'pwa';
  return 'web';
}

// ── Public API ────────────────────────────────────────────────
// auth.js login sonrasında çağırır
function setSentryUser(user: { id: string; username?: string } | null): void {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.setUser(user ? { id: user.id, username: user.username } : null);
}

// errorBoundary ile entegrasyon noktası
function captureException(error: unknown, context?: string): void {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.withScope((scope) => {
    if (context) scope.setExtra('context', context);
    window.Sentry!.captureException(error);
  });
}

function captureMessage(message: string, level: SentryLevel = 'error'): void {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.captureMessage(message, level);
}

function addBreadcrumb(category: string, message: string, data?: Record<string, unknown>): void {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.addBreadcrumb({ category, message, level: 'info', data });
}

// ── errorBoundary entegrasyonu ────────────────────────────────
// errorBoundary yüklendikten sonra (chunk-boot sırası: error-boundary → sentry-client)
// manuel report/crash çağrılarını Sentry'ye de iletmek için monkey-patch.
function _patchErrorBoundary(): void {
  const eb = BridgeRegistry.get('errorBoundary') as ((e: Error) => void) | undefined;
  if (!eb) return;

  const origReport = eb.report.bind(eb);
  const origCrash  = eb.crash.bind(eb);

  eb.report = function (error: unknown, context = ''): void {
    origReport(error, context);
    captureException(error, context);
  };

  eb.crash = function (error: unknown, context = ''): void {
    origCrash(error, context);
    captureException(error, `CRASH:${context}`);
  };
}

// ── Bootstrap ─────────────────────────────────────────────────
(function bootstrap(): void {
  const dsn = window.BRIDGE_SENTRY_DSN;
  if (!dsn) {
    // DSN yok — hiçbir şey yapma, Sentry devre dışı
    return;
  }

  // DOM hazır olunca SDK'yı yükle (script inject için document.head gerekli)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      void _initSentry(dsn).then(_patchErrorBoundary);
    });
  } else {
    void _initSentry(dsn).then(_patchErrorBoundary);
  }
})();

// ── Global erişim ─────────────────────────────────────────────
const sentryClient = { setSentryUser, captureException, captureMessage, addBreadcrumb };
(window as Window & { sentryClient?: typeof sentryClient }).sentryClient = sentryClient;
BridgeRegistry.register('sentryClient', sentryClient as unknown as (...a: unknown[]) => unknown);

export {};
