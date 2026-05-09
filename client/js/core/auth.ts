// core/auth.js.3 (CAPTCHA entegreli)

// â”€â”€ CAPTCHA CONFIG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _captchaCfg = null; // { enabled, provider, sitekey }

async function loadCaptchaConfig() {
  try {
    const r = await fetch(`${API}/api/captcha-config`);
    if (r.ok) {
      _captchaCfg = await r.json();
      if (_captchaCfg.enabled) _injectCaptchaScript(_captchaCfg);
    }
  } catch { _captchaCfg = { enabled: false, provider: 'none', sitekey: '' }; }
}

function _injectCaptchaScript(cfg) {
  if (document.getElementById('captcha-script')) return;
  const s = document.createElement('script');
  s.id = 'captcha-script';
  s.async = true;
  if (cfg.provider === 'hcaptcha') {
    s.src = 'https://js.hcaptcha.com/1/api.js';
  } else if (cfg.provider === 'turnstile') {
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  }
  s.onload = () => _renderCaptchaWidget(cfg);
  document.head.appendChild(s);
}

function _renderCaptchaWidget(cfg) {
  const wrap = document.getElementById('captcha-widget-wrap');
  if (!wrap) return;
  wrap.style.display = '';

  if (cfg.provider === 'hcaptcha' && window.hcaptcha) {
    window._hcaptchaWidgetId = window.hcaptcha.render('captcha-widget', {
      sitekey: cfg.sitekey,
      theme:   document.documentElement.classList.contains('light') ? 'light' : 'dark',
    });
  } else if (cfg.provider === 'turnstile' && window.turnstile) {
    window.turnstile.render('#captcha-widget', { sitekey: cfg.sitekey });
  }
}

function _getCaptchaToken() {
  if (!_captchaCfg?.enabled) return null;
  if (_captchaCfg.provider === 'hcaptcha' && window.hcaptcha) {
    return window.hcaptcha.getResponse(window._hcaptchaWidgetId) || null;
  }
  if (_captchaCfg.provider === 'turnstile') {
    return document.querySelector('[name="cf-turnstile-response"]')?.value || null;
  }
  return null;
}

function _resetCaptchaWidget() {
  if (!_captchaCfg?.enabled) return;
  try {
    if (_captchaCfg.provider === 'hcaptcha' && window.hcaptcha)
      window.hcaptcha.reset(window._hcaptchaWidgetId);
    if (_captchaCfg.provider === 'turnstile' && window.turnstile)
      window.turnstile.reset();
  } catch {}
}

// â”€â”€ CLIENT CONFIG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadClientConfig() {
  try {
    const r = await fetch(`${API}/api/config`);
    if (r.ok) clientConfig = await r.json();
  } catch { /* use defaults */ }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// TOKEN REFRESH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AynÄ± anda birden fazla 401 gelirse tek bir refresh isteÄŸi yapÄ±lÄ±r.
// DiÄŸer bekleyen apiFetch Ã§aÄŸrÄ±larÄ± bu promise'e baÄŸlanÄ±r.
let _refreshPromise = null;

async function refreshAccessToken() {
  // EÄŸer zaten devam eden bir refresh varsa ona baÄŸlan
  if (_refreshPromise) return _refreshPromise;

  _refreshPromise = (async () => {
    try {
      // httpOnly cookie otomatik gÃ¶nderilir â€” body'de refreshToken artÄ±k yok.
      // credentials: 'include' ile /api/refresh cookie'yi okur.
      const r = await fetch(`${API}/api/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({}),
      });
      if (!r.ok) return false;
      const d = await r.json();
      token = d.token;
      // refreshToken artÄ±k sadece httpOnly cookie â€” localStorage'da tutmaya gerek yok
      localStorage.removeItem('bridge_refresh_token');
      return true;
    } catch { return false; }
    finally { _refreshPromise = null; }
  })();

  return _refreshPromise;
}

async function apiFetch(url, opts = {}) {
  opts.headers = { ...(opts.headers || {}), Authorization: `Bearer ${token}` };
  opts.credentials = opts.credentials || 'include';
  let r = await fetch(url, opts);
  if (r.status === 401 && refreshToken) {
    const ok = await refreshAccessToken();
    if (ok) { opts.headers.Authorization = `Bearer ${token}`; r = await fetch(url, opts); }
  }
  return r;
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// AUTH
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) =>
    t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'))
  );
  document.getElementById('login-form').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('register-form').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('auth-msg').style.display = 'none';
  // Register tab aÃ§Ä±lÄ±nca CAPTCHA widget hazÄ±rla
  if (tab === 'register' && _captchaCfg?.enabled) _renderCaptchaWidget(_captchaCfg);
}

function showAuthMsg(msg, type = 'error') {
  const el = document.getElementById('auth-msg');
  el.className = type === 'error' ? 'auth-error' : 'auth-success';
  el.textContent = msg; el.style.display = '';
}

async function login() {
  const username = (document.getElementById('l-username') as HTMLInputElement | null)?.value ?? ''.trim();
  const password = (document.getElementById('l-password') as HTMLInputElement | null)?.value ?? '';
  if (!username || !password) return showAuthMsg('Please fill in all fields');
  const btn = document.querySelector('#login-form .btn-primary');
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const body = { username, password };
    // Progressive CAPTCHA â€” login CAPTCHA alanÄ± gÃ¶sterildiyse token ekle
    const loginCaptchaToken = _getLoginCaptchaToken();
    if (loginCaptchaToken) body.captchaToken = loginCaptchaToken;

    const r = await fetch(`${API}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      // IP kilitli â€” geri sayÄ±m baÅŸlat
      if (d.locked && d.retryAfter) {
        _startLockoutCountdown(d.retryAfter);
        return;
      }
      // Progressive CAPTCHA gerekli â€” widget gÃ¶ster
      if (d.requireCaptcha) {
        _showLoginCaptchaWidget();
        showAuthMsg('ğŸ¤– LÃ¼tfen CAPTCHA doÄŸrulamasÄ±nÄ± tamamlayÄ±n', 'error');
        return;
      }
      showAuthMsg(d.error || 'GiriÅŸ baÅŸarÄ±sÄ±z');
      return;
    }
    _clearLockoutCountdown();
    startApp(d.token, d.user, null);
  } catch { showAuthMsg('Cannot connect to server. Is it running?'); }
  finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}

// â”€â”€ LOGIN CAPTCHA (Progressive) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _loginCaptchaWidgetId = null;

function _getLoginCaptchaToken() {
  if (!_captchaCfg?.enabled) return null;
  const wrap = document.getElementById('login-captcha-wrap');
  if (!wrap || wrap.style.display === 'none') return null;
  if (_captchaCfg.provider === 'hcaptcha' && window.hcaptcha)
    return window.hcaptcha.getResponse(_loginCaptchaWidgetId) || null;
  if (_captchaCfg.provider === 'turnstile')
    return document.querySelector('#login-captcha-widget [name="cf-turnstile-response"]')?.value || null;
  return null;
}

function _showLoginCaptchaWidget() {
  if (!_captchaCfg?.enabled) return;
  let wrap = document.getElementById('login-captcha-wrap');
  if (!wrap) {
    // Dinamik olarak login form'una ekle
    wrap = document.createElement('div');
    wrap.id = 'login-captcha-wrap';
    wrap.style.margin = '8px 0';
    const inner = document.createElement('div');
    inner.id = 'login-captcha-widget';
    wrap.appendChild(inner);
    const form = document.getElementById('login-form');
    const btn  = form?.querySelector('.btn-primary');
    if (btn) form.insertBefore(wrap, btn);
    else form?.appendChild(wrap);
  }
  wrap.style.display = '';
  if (_loginCaptchaWidgetId !== null) return; // zaten render edildi
  const isDark = !document.documentElement.classList.contains('light');
  if (_captchaCfg.provider === 'hcaptcha' && window.hcaptcha) {
    _loginCaptchaWidgetId = window.hcaptcha.render('login-captcha-widget', {
      sitekey: _captchaCfg.sitekey,
      theme:   isDark ? 'dark' : 'light',
    });
  } else if (_captchaCfg.provider === 'turnstile' && window.turnstile) {
    window.turnstile.render('#login-captcha-widget', { sitekey: _captchaCfg.sitekey });
  }
}

// â”€â”€ KÄ°LÄ°T GERÄ° SAYIM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _lockoutTimer = null;

function _startLockoutCountdown(seconds) {
  _clearLockoutCountdown();
  let remaining = seconds;
  const el = document.getElementById('auth-msg') || document.createElement('div');

  function _tick() {
    const min = Math.floor(remaining / 60);
    const sec = String(remaining % 60).padStart(2, '0');
    el.className = 'auth-error';
    el.style.display = '';
    el.textContent = `ğŸ”’ Hesap kilitli â€” ${min}:${sec} iÃ§inde tekrar deneyin`;
    if (remaining <= 0) { _clearLockoutCountdown(); return; }
    remaining--;
    _lockoutTimer = setTimeout(_tick, 1000);
  }
  _tick();
}

function _clearLockoutCountdown() {
  if (_lockoutTimer) { clearTimeout(_lockoutTimer); _lockoutTimer = null; }
}

async function register() {
  const displayName = (document.getElementById('r-displayname') as HTMLInputElement | null)?.value ?? ''.trim();
  const username    = (document.getElementById('r-username') as HTMLInputElement | null)?.value ?? ''.trim();
  const password    = (document.getElementById('r-password') as HTMLInputElement | null)?.value ?? '';
  if (!username || !password) return showAuthMsg('Please fill in all fields');

  // CAPTCHA kontrolÃ¼
  if (_captchaCfg?.enabled) {
    const captchaToken = _getCaptchaToken();
    if (!captchaToken) {
      return showAuthMsg('LÃ¼tfen CAPTCHA doÄŸrulamasÄ±nÄ± tamamlayÄ±n ğŸ¤–');
    }
  }

  const btn = document.querySelector('#register-form .btn-primary');
  btn.disabled = true; btn.textContent = 'Creating account...';
  try {
    const body = { username, password, displayName };
    if (_captchaCfg?.enabled) body.captchaToken = _getCaptchaToken();

    const r = await fetch(`${API}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      _resetCaptchaWidget();
      showAuthMsg(d.error);
      return;
    }
    startApp(d.token, d.user, null);
  } catch { showAuthMsg('Cannot connect to server. Is it running?'); }
  finally { btn.disabled = false; btn.textContent = 'Create Account'; }
}

function logout() {
  // Sunucuya httpOnly cookie temizleme isteÄŸi gÃ¶nder
  fetch(`${API}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
  token = null; me = null; refreshToken = null;
  currentServer = null; currentChannel = null; currentDm = null;
  localStorage.removeItem('bridge_token'); localStorage.removeItem('bridge_refresh_token');
  socket?.disconnect(); socket = null; rtc = null;
  document.getElementById('app').style.display = 'none';
  document.getElementById('auth-screen').style.display = '';
  closeModal('settings-modal');
  ['l-username','l-password','r-username','r-password','r-displayname'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  _resetCaptchaWidget();
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// APP INIT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

