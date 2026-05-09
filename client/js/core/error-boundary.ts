// client/js/core/error-boundary.ts
// Uncaught hata yakalama + sunucuya raporlama + i18n destekli UI

'use strict';

declare global {
  interface Window {
    showToast?: (msg: string, type: string) => void;
  }
}

interface ErrorPayload {
  type: 'uncaught' | 'unhandledrejection' | 'resource' | 'manual' | 'crash';
  message: string;
  source: string;
  line: number;
  col: number;
  stack: string;
}

type EarlyError = ErrorPayload;

(function (global: Window) {

const isDev = (): boolean =>
  global.location?.hostname === 'localhost' ||
  global.location?.hostname === '127.0.0.1' ||
  /:\d{4,5}/.test(global.location?.host || '');

const _sentHashes = new Map<string, number>();
const DEDUP_WINDOW_MS = 60_000;

function _hash(msg: string, src: string, line: number): string {
  return `${msg}|${src}|${line}`;
}

async function _report(payload: ErrorPayload): Promise<void> {
  const hash = _hash(payload.message, payload.source, payload.line);
  const now  = Date.now();
  const last = _sentHashes.get(hash);
  if (last && now - last < DEDUP_WINDOW_MS) return;
  _sentHashes.set(hash, now);

  for (const [h, t] of _sentHashes) {
    if (now - t > DEDUP_WINDOW_MS * 5) _sentHashes.delete(h);
  }

  const token = (() => {
    try { return (JSON.parse(localStorage.getItem('bridge_session') || '{}') as { token?: string }).token || ''; } catch { return ''; }
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
      keepalive: true,
    });
  } catch { /* Ağ hatası — raporlama başarısız */ }
}

function _showErrorToast(message: string): void {
  try {
    if (typeof global.showToast === 'function') {
      global.showToast(message, 'error');
      return;
    }
    const toast = document.createElement('div');
    toast.textContent = message;
    Object.assign(toast.style, {
      position: 'fixed', bottom: '24px', right: '24px',
      background: '#ed4245', color: '#fff', padding: '10px 18px',
      borderRadius: '8px', fontSize: '13px', zIndex: '99999',
      boxShadow: '0 4px 12px rgba(0,0,0,.3)', maxWidth: '360px', wordBreak: 'break-word',
    });
    document.body?.appendChild(toast);
    setTimeout(() => toast.remove(), 5000);
  } catch { /* DOM hazır değilse atla */ }
}

function _showCrashScreen(detail: string): void {
  try {
    const t = (key: string, fallback: string): string => global.i18n?.t(key, fallback) ?? fallback;
    const overlay = document.createElement('div');
    Object.assign(overlay.style, {
      position: 'fixed', inset: '0', background: '#1a1b1e', color: '#dcddde',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      justifyContent: 'center', zIndex: '999999', fontFamily: 'system-ui, sans-serif',
      padding: '32px', textAlign: 'center',
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
      ${isDev() ? `<pre style="background:#111;padding:12px;border-radius:6px;font-size:11px;max-width:640px;overflow:auto;text-align:left;color:#f9a825">${_escHtml(detail)}</pre>` : ''}
      <button onclick="location.reload()" style="margin-top:20px;padding:10px 28px;background:#5865f2;color:#fff;border:none;border-radius:8px;font-size:14px;cursor:pointer">
        ${t('error_crash_reload', 'Sayfayı Yenile')}
      </button>
    `;
    document.body?.appendChild(overlay);
    setTimeout(() => (overlay.querySelector('button') as HTMLButtonElement | null)?.focus(), 50);
  } catch { /* DOM erişilemez */ }
}

function _escHtml(s: string): string {
  return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

global.addEventListener('error', (event: ErrorEvent) => {
  const { message, filename: source, lineno: line, colno: col, error } = event;
  const stack = (error as Error | null)?.stack || '';
  if (isDev()) {
    console.error('[ErrorBoundary] Uncaught error:', message, `\n  at ${source}:${line}:${col}`, stack);
  }
  void _report({ type: 'uncaught', message, source, line, col, stack });
  const msg = global.i18n?.t('error_generic', 'Beklenmedik bir hata oluştu.') ?? 'Beklenmedik bir hata oluştu.';
  _showErrorToast(msg);
});

global.addEventListener('unhandledrejection', (event: PromiseRejectionEvent) => {
  const reason = event.reason as { message?: string; stack?: string } | string | null;
  const message = (reason as { message?: string })?.message || String(reason) || 'Unhandled promise rejection';
  const stack   = (reason as { stack?: string })?.stack   || '';
  if (isDev()) {
    console.error('[ErrorBoundary] Unhandled rejection:', message, stack);
  }
  if (message.includes('401') || message.includes('403') || message.includes('Unauthorized')) return;
  void _report({ type: 'unhandledrejection', message, source: 'Promise', line: 0, col: 0, stack });
  if (!message.includes('NetworkError') && !message.includes('Failed to fetch')) {
    _showErrorToast('Bir işlem başarısız oldu.');
  }
});

global.addEventListener('error', (event: ErrorEvent) => {
  const target = event.target as HTMLElement | null;
  if (!target || target === (global as unknown as HTMLElement)) return;
  const tag = target.tagName?.toLowerCase();
  if (!['script', 'link', 'img'].includes(tag)) return;
  const src = (target as HTMLScriptElement).src || (target as HTMLLinkElement).href || '(unknown)';
  if (isDev()) console.warn(`[ErrorBoundary] Resource load failed: <${tag}> ${src}`);
  void _report({ type: 'resource', message: `Resource load failed: ${src}`, source: src, line: 0, col: 0, stack: '' });
}, true);

const errorBoundary = {
  report(error: unknown, context = ''): void {
    const e = error as { message?: string; stack?: string } | null;
    const message = e?.message || String(error);
    const stack   = e?.stack   || '';
    if (isDev()) console.error(`[ErrorBoundary] Manual report [${context}]:`, error);
    void _report({ type: 'manual', message, source: context, line: 0, col: 0, stack });
  },

  crash(error: unknown, context = ''): void {
    const e = error as { message?: string; stack?: string } | null;
    const detail = e?.stack || e?.message || String(error);
    if (isDev()) console.error(`[ErrorBoundary] CRASH [${context}]:`, error);
    void _report({ type: 'crash', message: e?.message || String(error), source: context, line: 0, col: 0, stack: detail });
    _showCrashScreen(`${context ? context + '\n' : ''}${detail}`);
  },

  wrap<T extends unknown[], R>(fn: (...args: T) => R, context = ''): (...args: T) => R | undefined {
    return function (this: unknown, ...args: T): R | undefined {
      try {
        const result = fn.apply(this, args);
        if (result && typeof (result as Promise<R>).catch === 'function') {
          (result as Promise<R>).catch((err: unknown) => errorBoundary.report(err, context));
        }
        return result;
      } catch (err) {
        errorBoundary.report(err, context);
        return undefined;
      }
    };
  },
};

global.errorBoundary = errorBoundary;
console.log('[Bridge] Error boundary aktif');

(function drainEarlyErrors() {
  const queue = global.__BRIDGE_EARLY_ERRORS__;
  if (!Array.isArray(queue) || !queue.length) return;
  const count = queue.length;
  queue.forEach((err) => { void _report(err); });
  global.__BRIDGE_EARLY_ERRORS__ = [];
  if (isDev()) {
    console.info(`[ErrorBoundary] Yükleme öncesi ${count} hata işlendi.`);
  }
})();

})(window);

export {};
