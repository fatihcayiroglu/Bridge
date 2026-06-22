// client/js/core/auth-compat.ts
// HTML'deki legacy auth handler'ları için geçiş katmanı.

import { getAPI } from './globals.ts';
import { createLogger } from './logger.ts';

type AuthTab = 'login' | 'register';

type AuthUser = {
  _id?: string;
  id?: string;
  username?: string;
  displayName?: string;
  avatarColor?: string;
  [key: string]: unknown;
};

type AuthPayload = {
  token?: unknown;
  user?: unknown;
  error?: unknown;
  message?: unknown;
};

const log = createLogger('AuthCompat');

function el<T extends HTMLElement>(id: string): T | null {
  return document.getElementById(id) as T | null;
}

function text(id: string): string {
  return el<HTMLInputElement>(id)?.value.trim() ?? '';
}

function readToken(): string | null {
  try {
    return localStorage.getItem('token') || localStorage.getItem('bridge_token');
  } catch {
    return null;
  }
}

function saveToken(token: string): void {
  try {
    localStorage.setItem('token', token);
    localStorage.setItem('bridge_token', token);
  } catch {
    // Depolama kapalıysa geçerli sayfa oturumu yine çalışabilir.
  }
}

function clearToken(): void {
  try {
    localStorage.removeItem('token');
    localStorage.removeItem('bridge_token');
    localStorage.removeItem('bridge_refresh_token');
  } catch {
    // no-op
  }
}

function errorText(payload: AuthPayload, fallback: string): string {
  if (typeof payload.error === 'string' && payload.error) return payload.error;
  if (typeof payload.message === 'string' && payload.message) return payload.message;
  return fallback;
}

function isUser(value: unknown): value is AuthUser {
  return Boolean(value) && typeof value === 'object';
}

export function showAuthMsg(message: string, type: 'error' | 'success' = 'error'): void {
  const node = el<HTMLElement>('auth-msg');
  if (!node) return;
  node.className = type === 'success' ? 'auth-success' : 'auth-error';
  node.textContent = message;
  node.style.display = '';
}

export function switchAuthTab(tab: AuthTab): void {
  document.querySelectorAll<HTMLElement>('.auth-tab').forEach((node, index) => {
    node.classList.toggle('active', (tab === 'login' && index === 0) || (tab === 'register' && index === 1));
  });
  const loginForm = el<HTMLElement>('login-form');
  const registerForm = el<HTMLElement>('register-form');
  if (loginForm) loginForm.style.display = tab === 'login' ? '' : 'none';
  if (registerForm) registerForm.style.display = tab === 'register' ? '' : 'none';
  const message = el<HTMLElement>('auth-msg');
  if (message) message.style.display = 'none';
}

function setBusy(selector: string, busy: boolean, label: string): void {
  const button = document.querySelector<HTMLButtonElement>(selector);
  if (!button) return;
  button.disabled = busy;
  button.textContent = busy ? (selector.includes('login') ? 'Signing in...' : 'Creating account...') : label;
}

async function postAuth(path: string, body: Record<string, string>): Promise<{ response: Response; payload: AuthPayload }> {
  const response = await fetch(`${getAPI()}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    credentials: 'include',
    body: JSON.stringify(body),
  });

  let payload: AuthPayload = {};
  try {
    payload = await response.json() as AuthPayload;
  } catch {
    // Sunucu JSON dışı hata döndürürse genel mesaj kullanılacak.
  }
  return { response, payload };
}

function updateUserPanel(user: AuthUser): void {
  const name = typeof user.displayName === 'string' && user.displayName
    ? user.displayName
    : typeof user.username === 'string' ? user.username : 'Bridge user';

  const avatar = el<HTMLElement>('my-avatar');
  const username = el<HTMLElement>('my-username');

  if (avatar) {
    avatar.textContent = name.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0]?.toUpperCase() ?? '').join('') || 'B';
    if (typeof user.avatarColor === 'string' && user.avatarColor) avatar.style.background = user.avatarColor;
  }
  if (username) username.textContent = name;
}

export async function startApp(token: string, user: AuthUser): Promise<void> {
  if (!token || !isUser(user)) throw new Error('Geçersiz oturum yanıtı.');

  saveToken(token);
  updateUserPanel(user);

  (globalThis as Record<string, unknown>).currentUser = user;
  (globalThis as Record<string, unknown>).me = user;

  const authScreen = el<HTMLElement>('auth-screen');
  const app = el<HTMLElement>('app');
  if (authScreen) authScreen.style.display = 'none';
  if (app) app.style.display = 'flex';

  document.dispatchEvent(new CustomEvent('bridge:auth-success', { detail: user }));
}

export async function login(): Promise<void> {
  const username = text('l-username');
  const password = el<HTMLInputElement>('l-password')?.value ?? '';
  if (!username || !password) {
    showAuthMsg('Please fill in all fields');
    return;
  }

  setBusy('#login-form .btn-primary', true, 'Sign In');
  try {
    const { response, payload } = await postAuth('/api/login', { username, password });
    if (!response.ok) {
      showAuthMsg(errorText(payload, 'Giriş başarısız.'));
      return;
    }
    if (typeof payload.token !== 'string' || !isUser(payload.user)) {
      throw new Error('Sunucu geçerli bir oturum döndürmedi.');
    }
    await startApp(payload.token, payload.user);
  } catch (error) {
    showAuthMsg(error instanceof Error ? error.message : 'Cannot connect to server. Is it running?');
  } finally {
    setBusy('#login-form .btn-primary', false, 'Sign In');
  }
}

export async function register(): Promise<void> {
  const username = text('r-username');
  const displayName = text('r-displayname');
  const password = el<HTMLInputElement>('r-password')?.value ?? '';
  if (!username || !password) {
    showAuthMsg('Please fill in all fields');
    return;
  }

  setBusy('#register-form .btn-primary', true, 'Create Account');
  try {
    const { response, payload } = await postAuth('/api/register', { username, password, displayName });
    if (!response.ok) {
      showAuthMsg(errorText(payload, 'Kayıt oluşturulamadı.'));
      return;
    }
    if (typeof payload.token !== 'string' || !isUser(payload.user)) {
      throw new Error('Sunucu geçerli bir oturum döndürmedi.');
    }
    await startApp(payload.token, payload.user);
  } catch (error) {
    showAuthMsg(error instanceof Error ? error.message : 'Cannot connect to server. Is it running?');
  } finally {
    setBusy('#register-form .btn-primary', false, 'Create Account');
  }
}

export function logout(): void {
  void fetch(`${getAPI()}/api/logout`, { method: 'POST', credentials: 'include' }).catch(() => {});
  clearToken();

  const app = el<HTMLElement>('app');
  const authScreen = el<HTMLElement>('auth-screen');
  if (app) app.style.display = 'none';
  if (authScreen) authScreen.style.display = '';

  switchAuthTab('login');
}

async function restoreSession(): Promise<void> {
  const token = readToken();
  if (!token) return;

  try {
    const response = await fetch(`${getAPI()}/api/me`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      credentials: 'include',
    });

    if (!response.ok) {
      if (response.status === 401 || response.status === 403) clearToken();
      return;
    }

    const payload = await response.json() as unknown;
    const user = isUser(payload) && isUser((payload as { user?: unknown }).user)
      ? (payload as { user: AuthUser }).user
      : payload;

    if (isUser(user)) await startApp(token, user);
  } catch (error) {
    log.warn('Oturum geri yüklenemedi', error);
  }
}

Object.assign(globalThis as Record<string, unknown>, {
  switchAuthTab,
  showAuthMsg,
  login,
  register,
  logout,
  startApp,
});

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { void restoreSession(); }, { once: true });
} else {
  void restoreSession();
}
