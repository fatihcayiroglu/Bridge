// client/js/core/error-boundary.js
// Uncaught hata yakalama + sunucuya raporlama + i18n destekli UI
// Özellikler:
//   1. window.onerror + unhandledrejection → tüm JS hatalarını yakalar
//   2. Aynı hatayı 60s içinde bir kez gönderir (spam önleme)
//   3. Hata raporu: stack, route, userAgent, timestamp
//   4. Production'da toast gösterir; dev modunda console.error yeterli
//   5. Kritik hatalarda sayfayı tekleme öncesi temiz hata ekranı açar

'use strict';

(function (global) {

const isDev = () =>
  global.location?.hostname === 'localhost' ||
  global.location?.hostname === '127.0.0.1' ||
  /:\d{4,5}/.test(global.location?.host || '');

// ── Hata raporu gönderme (throttled) ───────────────────────────
const _sentHashes = new Map(); // hash → timestamp
const DEDUP_WINDOW_MS = 60_000;

function _hash(msg, src, line) {
  return `${msg}|${src}|${line}`;
}

async function _report(payload) {
  const hash = _hash(payload.message, payload.source, payload.line);
  const now  = Date.now();
  const last = _sentHashes.get(hash);
  if (last && now - last < DEDUP_WINDOW_MS) return; // aynı hata tekrar geldi
  _sentHashes.set(hash, now);

  // Eski hash'leri temizle
  for (const [h, t] of _sentHashes) {
    if (now - t > DEDUP_WINDOW_MS * 5) _sentHashes.delete(h);
  }

  const token = (() => {
    try { return JSON.parse(localStorage.getItem('bridge_session') || '{}').token || ''; } catch { return ''; }
  })();

  try {
    await fetch('/api/client-error', {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({
        ...payload,
        url:       global.location?.href,
        userAgent: navigator.userAgent,
        timestamp: now,
        lang:      global.i18n?.lang?.() || navigator.language,
      }),
      keepalive: true, // sayfa kapanırken bile gönder
    });
  } catch {
    // Ağ hatası — raporlama başarısız, sessizce geç
  }
}

// ── Toast bildirimi ─────────────────────────────────────────────
function _showErrorToast(message) {
  try {
    if (typeof global.showToast === 'function') {
      global.showToast(message, 'error');
      return;
    }
    // Fallback: basit DOM toast
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position:     'fixed',
      bottom:       '24px',
      right:        '24px',
      background:   '#ed4245',
      color:        '#fff',
      padding:      '10px 18px',
      borderRadius: '8px',
      fontSize:     '13px',
      zIndex:       '99999',
      boxShadow:    '0 4px 12px rgba(0,0,0,.3)',
      maxWidth:     '360px',
      wordBreak:    'break-word',
    });
    document.body?.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  } catch { /* DOM hazır değilse atla */ }
}

// ── Kritik hata ekranı ──────────────────────────────────────────
function _showCrashScreen(detail) {
  try {
    const t = (key, fallback) => global.i18n?.t(key, fallback) ?? fallback;
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position:       'fixed', inset: '0',
      background:     '#1a1b1e',
      color:          '#dcddde',
      display:        'flex',
      flexDirection:  'column',
      alignItems:     'center',
      justifyContent: 'center',
      zIndex:         '999999',
      fontFamily:     'system-ui, sans-serif',
      padding:        '32px',
      textAlign:      'center',
    });
    overlay.setAttribute('role', 'alertdialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'bridge-crash-title');
    overlay.setAttribute('aria-describedby', 'bridge-crash-desc');
    overlay.innerHTML = `
      <div style="font-size:48px;margin-bottom:16px" aria-hidden="true">⚠️</div>
      <h2 id="bridge-crash-title" style="margin:0 0 8px;font-size:22px;color:#fff">
        ${t('error_crash_title', 'Bir şeyler ters gitti')}
      </h2>
      <p id="bridge-crash-desc" style="margin:0 0 24px;color:#a3a6aa;max-width:480px;line-height:1.5">
        ${t('error_crash_desc', 'Uygulama beklenmedik bir hatayla karşılaştı. Sayfayı yenileyerek tekrar dene.')}
      </p>
      ${isDev() ? `<pre role="region" aria-label="Hata detayı" style="background:#111;padding:12px;border-radius:6px;font-size:11px;max-width:640px;overflow:auto;text-align:left;color:#f9a825">${_escHtml(detail)}</pre>` : ''}
      <button onclick="location.reload()" style="
        margin-top:20px;padding:10px 28px;background:#5865f2;color:#fff;
        border:none;border-radius:8px;font-size:14px;cursor:pointer"
        aria-label="${t('error_crash_reload', 'Sayfayı yenile')}">
        ${t('error_crash_reload', 'Sayfayı Yenile')}
      </button>
    `;
    document.body?.appendChild(overlay);
    // Focus yönetimi: reload butonuna otomatik odaklan
    setTimeout(() => overlay.querySelector('button')?.focus(), 50);
  } catch { /* DOM erişilemez */ }
}

function _escHtml(s) {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Global hata dinleyicileri ───────────────────────────────────

// 1. Sync JS hataları (ReferenceError, TypeError vb.)
global.addEventListener('error', (event) => {
  const { message, filename: source, lineno: line, colno: col, error } = event;
  const stack = error?.stack || '';

  if (isDev()) {
    console.error('[ErrorBoundary] Uncaught error:', message, `\n  at ${source}:${line}:${col}`, stack);
  }

  _report({ type: 'uncaught', message, source, line, col, stack });
  const msg = global.i18n?.t('error_generic', 'Beklenmedik bir hata oluştu.') ?? 'Beklenmedik bir hata oluştu.';
  _showErrorToast(msg);
});

// 2. Async / Promise hataları
global.addEventListener('unhandledrejection', (event) => {
  const reason = event.reason;
  const message = reason?.message || String(reason) || 'Unhandled promise rejection';
  const stack   = reason?.stack   || '';

  if (isDev()) {
    console.error('[ErrorBoundary] Unhandled rejection:', message, stack);
  }

  // 401/403 → sessizce geç (auth sorunları normal akışta yönetiliyor)
  if (message.includes('401') || message.includes('403') || message.includes('Unauthorized')) return;

  _report({ type: 'unhandledrejection', message, source: 'Promise', line: 0, col: 0, stack });

  // Sadece gerçek uygulama hataları için toast göster
  if (!message.includes('NetworkError') && !message.includes('Failed to fetch')) {
    _showErrorToast('Bir işlem başarısız oldu.');
  }
});

// 3. Resource yükleme hataları (script, img, link vb.)
global.addEventListener('error', (event) => {
  const target = event.target;
  if (!target || target === global) return; // global hatalar yukarıda yakalandı
  const tag = target.tagName?.toLowerCase();
  if (!['script', 'link', 'img'].includes(tag)) return;
  const src = target.src || target.href || '(unknown)';
  if (isDev()) console.warn(`[ErrorBoundary] Resource load failed: <${tag}> ${src}`);
  _report({ type: 'resource', message: `Resource load failed: ${src}`, source: src, line: 0, col: 0, stack: '' });
}, true /* capture phase */);

// ── Public API ──────────────────────────────────────────────────
// Manuel hata raporlama — try/catch bloklarından çağrılabilir
const errorBoundary = {
  report(error, context = '') {
    const message = error?.message || String(error);
    const stack   = error?.stack   || '';
    if (isDev()) console.error(`[ErrorBoundary] Manual report [${context}]:`, error);
    _report({ type: 'manual', message, source: context, line: 0, col: 0, stack });
  },

  // Kritik: crash screen göster (WSOD önleme)
  crash(error, context = '') {
    const detail = error?.stack || error?.message || String(error);
    if (isDev()) console.error(`[ErrorBoundary] CRASH [${context}]:`, error);
    _report({ type: 'crash', message: error?.message || String(error), source: context, line: 0, col: 0, stack: detail });
    _showCrashScreen(`${context ? context + '\n' : ''}${detail}`);
  },

  // Try-catch sarmalayıcı
  wrap(fn, context = '') {
    return function (...args) {
      try {
        const result = fn.apply(this, args);
        if (result && typeof result.catch === 'function') {
          result.catch(err => errorBoundary.report(err, context));
        }
        return result;
      } catch (err) {
        errorBoundary.report(err, context);
      }
    };
  },
};

global.errorBoundary = errorBoundary;
console.log('[Bridge] Error boundary aktif');

// ── Early error queue boşalt ─────────────────────────────────
// index.html <head> içindeki minimal bootstrap, uygulama yüklenmeden
// önce oluşan hataları __BRIDGE_EARLY_ERRORS__ kuyruğuna aldı.
// Şimdi onları işle ve kuyruğu temizle.
(function drainEarlyErrors() {
  var queue = global.__BRIDGE_EARLY_ERRORS__;
  if (!Array.isArray(queue) || !queue.length) return;
  var count = queue.length;
  queue.forEach(function(err) {
    _report(err);
  });
  // Kuyruğu temizle — çift işlemeyi önle
  global.__BRIDGE_EARLY_ERRORS__ = [];
  if (isDev()) {
    console.info('[ErrorBoundary] Yükleme öncesi ' + count + ' hata işlendi.');
  }
})();

})(window);

export const errorBoundary    = window.errorBoundary;
export const getErrorBoundary = () => window.errorBoundary;
