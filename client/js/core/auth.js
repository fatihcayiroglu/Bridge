// core/auth.js — Faz 2
// Login / register / logout UI mantığı.
// Token yönetimi ve apiFetch → api-fetch.js'e taşındı.

import { apiFetch, refreshAccessToken } from './api-fetch.js';
import { getAPI }                        from './globals.js';

// ── CAPTCHA CONFIG ────────────────────────────────────────────
let _captchaCfg = null; // { enabled, provider, sitekey }

async function loadCaptchaConfig() {
  try {
    const r = await fetch(`${getAPI()}/api/captcha-config`);
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

// ── CLIENT CONFIG ────────────────────────────────────────────
async function loadClientConfig() {
  try {
    const r = await fetch(`${getAPI()}/api/config`);
    if (r.ok) clientConfig = await r.json();
  } catch { /* use defaults */ }
}

// ══════════════════════════════════════════════════
// TOKEN REFRESH → api-fetch.js'e taşındı (döngü kırma)
// apiFetch ve refreshAccessToken artık import ile geliyor.

// ══════════════════════════════════════════════════
// AUTH
// ══════════════════════════════════════════════════
function switchAuthTab(tab) {
  document.querySelectorAll('.auth-tab').forEach((t, i) =>
    t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'))
  );
  document.getElementById('login-form').style.display    = tab === 'login'    ? '' : 'none';
  document.getElementById('register-form').style.display = tab === 'register' ? '' : 'none';
  document.getElementById('auth-msg').style.display = 'none';
  // Register tab açılınca CAPTCHA widget hazırla
  if (tab === 'register' && _captchaCfg?.enabled) _renderCaptchaWidget(_captchaCfg);
}

function showAuthMsg(msg, type = 'error') {
  const el = document.getElementById('auth-msg');
  el.className = type === 'error' ? 'auth-error' : 'auth-success';
  el.textContent = msg; el.style.display = '';
}

async function login() {
  const username = document.getElementById('l-username').value.trim();
  const password = document.getElementById('l-password').value;
  if (!username || !password) return showAuthMsg('Please fill in all fields');
  const btn = document.querySelector('#login-form .btn-primary');
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    const body = { username, password };
    // Progressive CAPTCHA — login CAPTCHA alanı gösterildiyse token ekle
    const loginCaptchaToken = _getLoginCaptchaToken();
    if (loginCaptchaToken) body.captchaToken = loginCaptchaToken;

    const r = await fetch(`${getAPI()}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d = await r.json();
    if (!r.ok) {
      // IP kilitli — geri sayım başlat
      if (d.locked && d.retryAfter) {
        _startLockoutCountdown(d.retryAfter);
        return;
      }
      // Progressive CAPTCHA gerekli — widget göster
      if (d.requireCaptcha) {
        _showLoginCaptchaWidget();
        showAuthMsg('🤖 Lütfen CAPTCHA doğrulamasını tamamlayın', 'error');
        return;
      }
      showAuthMsg(d.error || 'Giriş başarısız');
      return;
    }
    _clearLockoutCountdown();
    startApp(d.token, d.user, null);
  } catch { showAuthMsg('Cannot connect to server. Is it running?'); }
  finally { btn.disabled = false; btn.textContent = 'Sign In'; }
}

// ── LOGIN CAPTCHA (Progressive) ───────────────────────────────
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

// ── KİLİT GERİ SAYIM ─────────────────────────────────────────
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
    el.textContent = `🔒 Hesap kilitli — ${min}:${sec} içinde tekrar deneyin`;
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
  const displayName = document.getElementById('r-displayname').value.trim();
  const username    = document.getElementById('r-username').value.trim();
  const password    = document.getElementById('r-password').value;
  if (!username || !password) return showAuthMsg('Please fill in all fields');

  // CAPTCHA kontrolü
  if (_captchaCfg?.enabled) {
    const captchaToken = _getCaptchaToken();
    if (!captchaToken) {
      return showAuthMsg('Lütfen CAPTCHA doğrulamasını tamamlayın 🤖');
    }
  }

  const btn = document.querySelector('#register-form .btn-primary');
  btn.disabled = true; btn.textContent = 'Creating account...';
  try {
    const body = { username, password, displayName };
    if (_captchaCfg?.enabled) body.captchaToken = _getCaptchaToken();

    const r = await fetch(`${getAPI()}/api/register`, {
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
  // Sentry kullanıcı bağlamını temizle
  if (window.sentryClient) window.sentryClient.setSentryUser(null);
  // Sunucuya httpOnly cookie temizleme isteği gönder
  fetch(`${getAPI()}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
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

// ══════════════════════════════════════════════════
// APP INIT
// ══════════════════════════════════════════════════

// ─────────────────────────────────────────────────────────────
// FAZ 2: ESM Export + Compat Shim
// apiFetch/refreshAccessToken → api-fetch.js'den re-export
// ─────────────────────────────────────────────────────────────
export { apiFetch, refreshAccessToken } from './api-fetch.js';

export {
  login,
  register,
  logout,
  switchAuthTab,
  showAuthMsg,
  loadCaptchaConfig,
  loadClientConfig,
};

