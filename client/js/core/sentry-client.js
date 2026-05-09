// client/js/core/sentry-client.js
// Sentry Browser SDK entegrasyonu — Bridge client tarafı hata takibi.
//
// Tasarım:
//  - DSN, sunucu tarafından window.BRIDGE_SENTRY_DSN olarak inject edilir.
//  - DSN yoksa modül sessizce devre dışı kalır (hiç veri gönderilmez).
//  - Sentry SDK CDN'den lazy yüklenir (bundle'ı şişirmez).
//  - errorBoundary.report() / crash() Sentry'ye de gönderir.
//  - auth.js login sonrasında sentryClient.setSentryUser() çağırır.

'use strict';

const SENTRY_CDN_URL =
  'https://browser.sentry-cdn.com/8.9.2/bundle.min.js';

const IGNORE_ERRORS = [
  /extension:\/\//,
  /chrome-extension:\/\//,
  /safari-extension:\/\//,
  'Failed to fetch',
  'NetworkError',
  'Network request failed',
  'Load failed',
  'ResizeObserver loop limit exceeded',
  'ResizeObserver loop completed with undelivered notifications',
  /webkit-masked-url/,
];

const DENY_URLS = [
  /extensions\//i,
  /^chrome:\/\//i,
  /^moz-extension:\/\//i,
];

let _initialized = false;
let _initPromise  = null;

function _loadSentrySDK() {
  if (_initPromise) return _initPromise;

  _initPromise = new Promise((resolve) => {
    if (window.Sentry) { resolve(true); return; }

    const script  = document.createElement('script');
    script.src    = SENTRY_CDN_URL;
    script.async  = true;

    script.onload = () => {
      if (window.Sentry) {
        resolve(true);
      } else {
        console.warn('[Sentry] SDK yüklendi ama window.Sentry tanımsız');
        resolve(false);
      }
    };

    script.onerror = () => {
      console.warn('[Sentry] CDN yüklemesi başarısız — hata takibi devre dışı');
      resolve(false);
    };

    document.head.appendChild(script);
  });

  return _initPromise;
}

function _getPlatform() {
  if (typeof navigator !== 'undefined' && navigator.userAgent.includes('Electron')) return 'electron';
  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) return 'pwa';
  return 'web';
}

async function _initSentry(dsn) {
  if (_initialized || window.__SENTRY_INITIALIZED__) return;

  const loaded = await _loadSentrySDK();
  if (!loaded || !window.Sentry) return;

  const isDev =
    window.location.hostname === 'localhost' ||
    window.location.hostname === '127.0.0.1' ||
    /:\d{4,5}/.test(window.location.host);

  window.Sentry.init({
    dsn,
    environment:      window.BRIDGE_ENV  || (isDev ? 'development' : 'production'),
    release:          window.BRIDGE_APP_VERSION,
    sampleRate:       isDev ? 0.1 : 1.0,
    tracesSampleRate: 0,
    ignoreErrors:     IGNORE_ERRORS,
    denyUrls:         DENY_URLS,

    beforeSend(event) {
      // Authorization header içeren breadcrumb'ları filtrele
      const bc = event.breadcrumbs;
      if (bc && Array.isArray(bc.values)) {
        bc.values = bc.values.map((b) => {
          if (b.data && b.data['Authorization']) {
            return { ...b, data: { ...b.data, Authorization: '[Filtered]' } };
          }
          return b;
        });
      }
      return event;
    },
  });

  _initialized                = true;
  window.Sentry.setTag('platform', _getPlatform());

  if (isDev) console.info('[Bridge] Sentry aktif (dev — %10 sample rate)');
}

// ── Public API ────────────────────────────────────────────────

function setSentryUser(user) {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.setUser(user ? { id: String(user.id), username: user.username } : null);
}

function captureException(error, context) {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.withScope((scope) => {
    if (context) scope.setExtra('context', context);
    window.Sentry.captureException(error);
  });
}

function captureMessage(message, level) {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.captureMessage(message, level || 'error');
}

function addBreadcrumb(category, message, data) {
  if (!_initialized || !window.Sentry) return;
  window.Sentry.addBreadcrumb({ category, message, level: 'info', data });
}

// ── errorBoundary monkey-patch ────────────────────────────────

// errorBoundary bu noktada hazır — wrap edebiliriz.
function _patchErrorBoundary() {
  const eb = window.errorBoundary;
  if (!eb) return;

  const origReport = eb.report.bind(eb);
  const origCrash  = eb.crash.bind(eb);

  eb.report = function (error, context) {
    origReport(error, context);
    captureException(error, context);
  };

  eb.crash = function (error, context) {
    origCrash(error, context);
    captureException(error, 'CRASH:' + (context || ''));
  };
}

// ── Bootstrap ─────────────────────────────────────────────────
(function bootstrap() {
  const dsn = window.BRIDGE_SENTRY_DSN;
  if (!dsn) return; // DSN yok → tamamen devre dışı

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      _initSentry(dsn).then(_patchErrorBoundary);
    });
  } else {
    _initSentry(dsn).then(_patchErrorBoundary);
  }
})();

// ── Global erişim ─────────────────────────────────────────────
window.sentryClient = { setSentryUser, captureException, captureMessage, addBreadcrumb };

console.log('[Bridge] Sentry client modülü yüklendi');

export {
  addBreadcrumb,
  captureException,
  captureMessage,
  setSentryUser,
};

