// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/AuthPanel.svelte
//              client/js/core/auth-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/auth.ts
// Sprint 43: JS→TS geçişi
// Kimlik doğrulama — login, register, logout, captcha yönetimi

import { apiFetch, refreshAccessToken,
  setToken as _apiFetchSetToken,
  setRefreshToken as _apiFetchSetRefreshToken } from './api-fetch.js';
import { getAPI } from './globals.js';
import {
  setSocket, setRtc, setMe, setToken, setRefreshToken,
  setCurrentServer, setCurrentChannel, setClientConfig,
} from './globals.js';

const _br = (): { call: (name: string, ...args: unknown[]) => unknown; get: (name: string) => unknown } | null =>
  typeof BridgeRegistry !== 'undefined' ? BridgeRegistry : ((globalThis as unknown as { BridgeRegistry?: typeof BridgeRegistry }).BridgeRegistry ?? null);

// ── CAPTCHA SDK ────────────────────────────────────────────────────────────────
interface CaptchaSDK {
  hcaptcha: { render(c: string | HTMLElement, p: Record<string, unknown>): string; getResponse(id?: string): string; reset(id?: string): void } | null;
  turnstile: { render(c: string | HTMLElement, p: Record<string, unknown>): string; reset(): void } | null;
}

function _captchaSDK(): CaptchaSDK {
  return {
    hcaptcha:  (window as Window & { hcaptcha?: CaptchaSDK['hcaptcha'] }).hcaptcha  ?? null,
    turnstile: (window as Window & { turnstile?: CaptchaSDK['turnstile'] }).turnstile ?? null,
  };
}

// ── CAPTCHA CONFIG ─────────────────────────────────────────────────────────────
interface CaptchaConfig {
  enabled: boolean;
  provider: 'hcaptcha' | 'turnstile' | 'none';
  sitekey: string;
}

let _captchaCfg: CaptchaConfig | null = null;
let _regWidgetId: string | null = null;
let _loginCaptchaWidgetId: string | null = null;

export async function loadCaptchaConfig(): Promise<void> {
  try {
    const r = await fetch(`${getAPI()}/api/captcha-config`);
    if (r.ok) {
      _captchaCfg = await r.json();
      if (_captchaCfg?.enabled) _injectCaptchaScript(_captchaCfg);
    }
  } catch { _captchaCfg = { enabled: false, provider: 'none', sitekey: '' }; }
}

function _injectCaptchaScript(cfg: CaptchaConfig): void {
  if (document.getElementById('captcha-script')) return;
  const s = document.createElement('script');
  s.id = 'captcha-script';
  s.async = true;
  if (cfg.provider === 'hcaptcha') s.src = 'https://js.hcaptcha.com/1/api.js';
  else if (cfg.provider === 'turnstile') s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js';
  s.onload = () => _renderCaptchaWidget(cfg);
  document.head.appendChild(s);
}

function _renderCaptchaWidget(cfg: CaptchaConfig): void {
  const wrap = document.getElementById('captcha-widget-wrap');
  if (!wrap) return;
  wrap.style.display = '';
  const { hcaptcha, turnstile } = _captchaSDK();
  const isDark = !document.documentElement.classList.contains('light');
  if (cfg.provider === 'hcaptcha' && hcaptcha) {
    _regWidgetId = hcaptcha.render('captcha-widget', { sitekey: cfg.sitekey, theme: isDark ? 'dark' : 'light' });
  } else if (cfg.provider === 'turnstile' && turnstile) {
    turnstile.render('#captcha-widget', { sitekey: cfg.sitekey });
  }
}

function _getCaptchaToken(): string | null {
  if (!_captchaCfg?.enabled) return null;
  const { hcaptcha } = _captchaSDK();
  if (_captchaCfg.provider === 'hcaptcha' && hcaptcha) return hcaptcha.getResponse(_regWidgetId ?? undefined) || null;
  if (_captchaCfg.provider === 'turnstile') {
    return (document.querySelector<HTMLInputElement>('[name="cf-turnstile-response"]'))?.value || null;
  }
  return null;
}

function _resetCaptchaWidget(): void {
  if (!_captchaCfg?.enabled) return;
  const { hcaptcha, turnstile } = _captchaSDK();
  try {
    if (_captchaCfg.provider === 'hcaptcha' && hcaptcha) hcaptcha.reset(_regWidgetId ?? undefined);
    if (_captchaCfg.provider === 'turnstile' && turnstile) turnstile.reset();
  } catch {}
}

// ── CLIENT CONFIG ──────────────────────────────────────────────────────────────
export async function loadClientConfig(): Promise<void> {
  try {
    const r = await fetch(`${getAPI()}/api/config`);
    if (r.ok) setClientConfig(await r.json());
  } catch { /* use defaults */ }
}

// ── AUTH UI ────────────────────────────────────────────────────────────────────
export function switchAuthTab(tab: 'login' | 'register'): void {
  document.querySelectorAll<HTMLElement>('.auth-tab').forEach((t, i) =>
    t.classList.toggle('active', (i === 0 && tab === 'login') || (i === 1 && tab === 'register'))
  );
  const loginForm    = document.getElementById('login-form');
  const registerForm = document.getElementById('register-form');
  const authMsg      = document.getElementById('auth-msg');
  if (loginForm)    loginForm.style.display    = tab === 'login'    ? '' : 'none';
  if (registerForm) registerForm.style.display = tab === 'register' ? '' : 'none';
  if (authMsg)      authMsg.style.display = 'none';
  if (tab === 'register' && _captchaCfg?.enabled) _renderCaptchaWidget(_captchaCfg);
}

export function showAuthMsg(msg: string, type: 'error' | 'success' = 'error'): void {
  const el = document.getElementById('auth-msg');
  if (!el) return;
  el.className = type === 'error' ? 'auth-error' : 'auth-success';
  el.textContent = msg;
  el.style.display = '';
}

interface LoginResponse {
  token?: string;
  user?: unknown;
  locked?: boolean;
  retryAfter?: number;
  requireCaptcha?: boolean;
  error?: string;
}

export async function login(): Promise<void> {
  const username = (document.getElementById('l-username') as HTMLInputElement)?.value.trim();
  const password = (document.getElementById('l-password') as HTMLInputElement)?.value;
  if (!username || !password) return showAuthMsg('Please fill in all fields');
  const btn = document.querySelector<HTMLButtonElement>('#login-form .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Signing in...'; }
  try {
    const body: Record<string, unknown> = { username, password };
    const loginCaptchaToken = _getLoginCaptchaToken();
    if (loginCaptchaToken) body['captchaToken'] = loginCaptchaToken;

    const r = await fetch(`${getAPI()}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d: LoginResponse = await r.json();
    if (!r.ok) {
      if (d.locked && d.retryAfter) { _startLockoutCountdown(d.retryAfter); return; }
      if (d.requireCaptcha) {
        _showLoginCaptchaWidget();
        showAuthMsg('🤖 Lütfen CAPTCHA doğrulamasını tamamlayın', 'error');
        return;
      }
      showAuthMsg(d.error ?? 'Giriş başarısız');
      return;
    }
    _clearLockoutCountdown();
    _br()?.call('startApp', d.token, d.user, null);
  } catch { showAuthMsg('Cannot connect to server. Is it running?'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; } }
}

function _getLoginCaptchaToken(): string | null {
  if (!_captchaCfg?.enabled) return null;
  const wrap = document.getElementById('login-captcha-wrap');
  if (!wrap || wrap.style.display === 'none') return null;
  const { hcaptcha } = _captchaSDK();
  if (_captchaCfg.provider === 'hcaptcha' && hcaptcha) return hcaptcha.getResponse(_loginCaptchaWidgetId ?? undefined) || null;
  if (_captchaCfg.provider === 'turnstile') {
    return document.querySelector<HTMLInputElement>('#login-captcha-widget [name="cf-turnstile-response"]')?.value || null;
  }
  return null;
}

function _showLoginCaptchaWidget(): void {
  if (!_captchaCfg?.enabled) return;
  let wrap = document.getElementById('login-captcha-wrap');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.id = 'login-captcha-wrap';
    wrap.style.margin = '8px 0';
    const inner = document.createElement('div');
    inner.id = 'login-captcha-widget';
    wrap.appendChild(inner);
    const form = document.getElementById('login-form');
    const btn  = form?.querySelector<HTMLElement>('.btn-primary');
    if (btn) form!.insertBefore(wrap, btn);
    else form?.appendChild(wrap);
  }
  wrap.style.display = '';
  if (_loginCaptchaWidgetId !== null) return;
  const isDark = !document.documentElement.classList.contains('light');
  const { hcaptcha, turnstile } = _captchaSDK();
  if (_captchaCfg.provider === 'hcaptcha' && hcaptcha) {
    _loginCaptchaWidgetId = hcaptcha.render('login-captcha-widget', { sitekey: _captchaCfg.sitekey, theme: isDark ? 'dark' : 'light' });
  } else if (_captchaCfg.provider === 'turnstile' && turnstile) {
    turnstile.render('#login-captcha-widget', { sitekey: _captchaCfg.sitekey });
  }
}

let _lockoutTimer: ReturnType<typeof setTimeout> | null = null;

function _startLockoutCountdown(seconds: number): void {
  _clearLockoutCountdown();
  let remaining = seconds;
  const el = document.getElementById('auth-msg') ?? document.createElement('div');
  function _tick(): void {
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

function _clearLockoutCountdown(): void {
  if (_lockoutTimer) { clearTimeout(_lockoutTimer); _lockoutTimer = null; }
}

interface RegisterResponse {
  error?: string;
  token?: string;
  user?: unknown;
}

export async function register(): Promise<void> {
  const displayName = (document.getElementById('r-displayname') as HTMLInputElement)?.value.trim();
  const username    = (document.getElementById('r-username') as HTMLInputElement)?.value.trim();
  const password    = (document.getElementById('r-password') as HTMLInputElement)?.value;
  if (!username || !password) return showAuthMsg('Please fill in all fields');

  if (_captchaCfg?.enabled) {
    const captchaToken = _getCaptchaToken();
    if (!captchaToken) return showAuthMsg('Lütfen CAPTCHA doğrulamasını tamamlayın 🤖');
  }

  const btn = document.querySelector<HTMLButtonElement>('#register-form .btn-primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Creating account...'; }
  try {
    const body: Record<string, unknown> = { username, password, displayName };
    if (_captchaCfg?.enabled) body['captchaToken'] = _getCaptchaToken();
    const r = await fetch(`${getAPI()}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const d: RegisterResponse = await r.json();
    if (!r.ok) { _resetCaptchaWidget(); showAuthMsg(d.error ?? 'Kayıt başarısız'); return; }
    _br()?.call('startApp', d.token, d.user, null);
  } catch { showAuthMsg('Cannot connect to server. Is it running?'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = 'Create Account'; } }
}

export async function logout(): Promise<void> {
  const sentryClient = _br()?.get('sentryClient') as { setSentryUser?: (u: null) => void } | null;
  if (sentryClient?.setSentryUser) sentryClient.setSentryUser(null);

  fetch(`${getAPI()}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});

  setToken(null);
  _apiFetchSetToken(null);
  setMe(null);
  setRefreshToken(null);
  _apiFetchSetRefreshToken(null);
  setCurrentServer(null);
  setCurrentChannel(null);
  _br()?.call('setCurrentDm', null);

  const socket = _br()?.call('getSocket') as { disconnect?: () => void } | null;
  socket?.disconnect?.();
  setSocket(null);
  setRtc(null);

  localStorage.removeItem('bridge_token');
  localStorage.removeItem('bridge_refresh_token');

  const app = document.getElementById('app');
  const authScreen = document.getElementById('auth-screen');
  if (app) app.style.display = 'none';
  if (authScreen) authScreen.style.display = '';

  const { closeModal } = await import('./utils.js');
  closeModal('settings-modal');

  for (const id of ['l-username','l-password','r-username','r-password','r-displayname']) {
    const el = document.getElementById(id) as HTMLInputElement | null;
    if (el) el.value = '';
  }
  _resetCaptchaWidget();
}

// Re-exports
export { apiFetch, refreshAccessToken } from './api-fetch.js';
