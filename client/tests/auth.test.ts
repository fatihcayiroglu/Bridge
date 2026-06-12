// client/tests/auth.test.ts — Bridge v74
// core/auth.js için unit testler
// apiFetch, login flow, register flow, CAPTCHA yardımcıları, lockout geri sayım

'use strict';

// ─── Modül yükleyici ──────────────────────────────────────────────────────────
// ESM kaynak dosyası — babel-jest transform ile CommonJS'e dönüştürülür,
// ardından named export'lar global scope'a yayılır.
function loadAuthModule() {
  const authMod = require('../js/core/auth');
  // Named export'ları global'a yay (showAuthMsg, login, register, vb.)
  Object.entries(authMod).forEach(([k, v]) => { global[k] = v; });
}

// ─── DOM şablonu ──────────────────────────────────────────────────────────────
function buildAuthDOM() {
  document.body.innerHTML = `
    <div id="auth-msg"></div>
    <div id="login-form">
      <input  id="l-username" value="">
      <input  id="l-password" type="password" value="">
      <button class="btn-primary">Sign In</button>
    </div>
    <div id="register-form">
      <input  id="r-displayname" value="">
      <input  id="r-username"    value="">
      <input  id="r-password"    type="password" value="">
      <button class="btn-primary">Create Account</button>
    </div>
    <div id="captcha-widget-wrap" style="display:none">
      <div id="captcha-widget"></div>
    </div>
    <div id="toast-container"></div>
  `;
}

// ─── Setup ────────────────────────────────────────────────────────────────────
beforeAll(() => {
  // Bridge globals
  global.API = 'http://localhost:3000';
  global.token = null;
  global.refreshToken = null;
  global.clientConfig = {};
  global.serverEmojiCache = [];
  global.startApp = jest.fn();   // uygulama başlatıcı stub

  buildAuthDOM();
  loadAuthModule();
});

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch.mockReset();
  // Her test için temiz DOM
  buildAuthDOM();
  // token/refreshToken sıfırla
  global.token = null;
  global.refreshToken = null;
  localStorage.clear();
});

// ══════════════════════════════════════════════════════════════════════════════
// apiFetch
// ══════════════════════════════════════════════════════════════════════════════
describe('apiFetch()', () => {
  test('Authorization header ekler', async () => {
    global.token = 'test-jwt-token';
    global.fetch.mockResolvedValueOnce({ ok: true, status: 200, json: () => ({}) });

    await global.apiFetch(`${global.API}/api/servers`);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: 'Bearer test-jwt-token' }),
      })
    );
  });

  test('401 alınca refresh dener, başarılıysa isteği tekrarlar', async () => {
    global.token = 'expired-token';
    global.refreshToken = 'valid-refresh';
    localStorage.setItem('bridge_refresh_token', 'valid-refresh');

    // İlk istek → 401
    global.fetch
      .mockResolvedValueOnce({ ok: false, status: 401, json: () => ({}) })
      // refresh endpoint → yeni tokenlar
      .mockResolvedValueOnce({
        ok: true, status: 200,
        json: () => Promise.resolve({ token: 'new-token', refreshToken: 'new-refresh' }),
      })
      // retry → başarı
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => ({}) });

    const res = await global.apiFetch(`${global.API}/api/me`);
    expect(res.status).toBe(200);
    // Toplam 3 fetch çağrısı: orijinal + refresh + retry
    expect(global.fetch).toHaveBeenCalledTimes(3);
  });

  test('refresh token yoksa sadece orijinal yanıtı döndürür', async () => {
    global.token = 'expired-token';
    global.refreshToken = null;
    localStorage.removeItem('bridge_refresh_token');

    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: () => ({}) });

    const res = await global.apiFetch(`${global.API}/api/me`);
    expect(res.status).toBe(401);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// showAuthMsg
// ══════════════════════════════════════════════════════════════════════════════
describe('showAuthMsg()', () => {
  test('hata mesajını auth-error class ile gösterir', () => {
    global.showAuthMsg('Invalid credentials');
    const el = document.getElementById('auth-msg');
    expect(el.className).toBe('auth-error');
    expect(el.textContent).toBe('Invalid credentials');
    expect(el.style.display).not.toBe('none');
  });

  test('başarı mesajını auth-success class ile gösterir', () => {
    global.showAuthMsg('Account created!', 'success');
    const el = document.getElementById('auth-msg');
    expect(el.className).toBe('auth-success');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// switchAuthTab
// ══════════════════════════════════════════════════════════════════════════════
describe('switchAuthTab()', () => {
  beforeEach(() => {
    // Tab butonlarını DOM'a ekle
    document.body.insertAdjacentHTML('beforeend', `
      <button class="auth-tab">Giriş</button>
      <button class="auth-tab">Kayıt</button>
    `);
  });

  test('"login" sekmesi login-form\'u gösterir', () => {
    global.switchAuthTab('login');
    expect(document.getElementById('login-form').style.display).not.toBe('none');
    expect(document.getElementById('register-form').style.display).toBe('none');
  });

  test('"register" sekmesi register-form\'u gösterir', () => {
    global.switchAuthTab('register');
    expect(document.getElementById('register-form').style.display).not.toBe('none');
    expect(document.getElementById('login-form').style.display).toBe('none');
  });

  test('sekme değişince auth-msg gizlenir', () => {
    const msg = document.getElementById('auth-msg');
    msg.style.display = 'block';
    global.switchAuthTab('login');
    expect(msg.style.display).toBe('none');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// login()
// ══════════════════════════════════════════════════════════════════════════════
describe('login()', () => {
  test('alanlar boşken hata mesajı gösterir, fetch çağırmaz', async () => {
    document.getElementById('l-username').value = '';
    document.getElementById('l-password').value = '';
    await global.login();
    expect(global.fetch).not.toHaveBeenCalled();
    expect(document.getElementById('auth-msg').textContent).toMatch(/fill in all fields/i);
  });

  test('başarılı girişte startApp çağrılır', async () => {
    document.getElementById('l-username').value = 'fatih';
    document.getElementById('l-password').value = 'pass123';

    global.fetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ token: 'tok', refreshToken: 'ref', user: { id: '1', username: 'fatih' } }),
    });

    await global.login();
    expect(global.startApp).toHaveBeenCalledWith('tok', { id: '1', username: 'fatih' }, 'ref');
  });

  test('hatalı kimlik bilgilerinde hata mesajı gösterir', async () => {
    document.getElementById('l-username').value = 'fatih';
    document.getElementById('l-password').value = 'wrong';

    global.fetch.mockResolvedValueOnce({
      ok: false, status: 401,
      json: () => Promise.resolve({ error: 'Invalid credentials' }),
    });

    await global.login();
    expect(document.getElementById('auth-msg').textContent).toBe('Invalid credentials');
    expect(global.startApp).not.toHaveBeenCalled();
  });

  test('lockout yanıtı (locked + retryAfter) gelince geri sayım başlar', async () => {
    jest.useFakeTimers();
    document.getElementById('l-username').value = 'fatih';
    document.getElementById('l-password').value = 'wrong';

    global.fetch.mockResolvedValueOnce({
      ok: false, status: 429,
      json: () => Promise.resolve({ locked: true, retryAfter: 60 }),
    });

    await global.login();
    const el = document.getElementById('auth-msg');
    expect(el.textContent).toMatch(/kilitli/i);
    jest.useRealTimers();
  });

  test('ağ hatası "Cannot connect" mesajını gösterir', async () => {
    document.getElementById('l-username').value = 'fatih';
    document.getElementById('l-password').value = 'pass';
    global.fetch.mockRejectedValueOnce(new Error('Network error'));

    await global.login();
    expect(document.getElementById('auth-msg').textContent).toMatch(/cannot connect/i);
  });

  test('login sonrası buton enabled/text sıfırlanır', async () => {
    document.getElementById('l-username').value = 'fatih';
    document.getElementById('l-password').value = 'pass';
    const btn = document.querySelector('#login-form .btn-primary');

    global.fetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ token: 'tok', refreshToken: 'ref', user: {} }),
    });

    await global.login();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Sign In');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// register()
// ══════════════════════════════════════════════════════════════════════════════
describe('register()', () => {
  test('alanlar boşken hata mesajı gösterir', async () => {
    document.getElementById('r-username').value = '';
    document.getElementById('r-password').value = '';
    await global.register();
    expect(global.fetch).not.toHaveBeenCalled();
  });

  test('başarılı kayıtta startApp çağrılır', async () => {
    document.getElementById('r-displayname').value = 'Fatih';
    document.getElementById('r-username').value    = 'fatih42';
    document.getElementById('r-password').value    = 'secure123';

    global.fetch.mockResolvedValueOnce({
      ok: true, status: 201,
      json: () => Promise.resolve({ token: 'tok', refreshToken: 'ref', user: { id: '2' } }),
    });

    await global.register();
    expect(global.startApp).toHaveBeenCalledWith('tok', { id: '2' }, 'ref');
  });

  test('kullanıcı adı alındıysa sunucu hatasını gösterir', async () => {
    document.getElementById('r-username').value = 'existing';
    document.getElementById('r-password').value = 'pass';

    global.fetch.mockResolvedValueOnce({
      ok: false, status: 409,
      json: () => Promise.resolve({ error: 'Username already taken' }),
    });

    await global.register();
    expect(document.getElementById('auth-msg').textContent).toBe('Username already taken');
  });

  test('kayıt sonrası buton sıfırlanır', async () => {
    document.getElementById('r-username').value = 'newuser';
    document.getElementById('r-password').value = 'pass';
    const btn = document.querySelector('#register-form .btn-primary');

    global.fetch.mockResolvedValueOnce({
      ok: true, status: 201,
      json: () => Promise.resolve({ token: 't', refreshToken: 'r', user: {} }),
    });

    await global.register();
    expect(btn.disabled).toBe(false);
    expect(btn.textContent).toBe('Create Account');
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// refreshAccessToken()
// ══════════════════════════════════════════════════════════════════════════════
describe('refreshAccessToken()', () => {
  test('refresh token yoksa false döner', async () => {
    localStorage.removeItem('bridge_refresh_token');
    const result = await global.refreshAccessToken();
    expect(result).toBe(false);
  });

  test('başarılı refresh sonrası token güncellenir ve true döner', async () => {
    localStorage.setItem('bridge_refresh_token', 'refresh-xyz');
    global.fetch.mockResolvedValueOnce({
      ok: true, status: 200,
      json: () => Promise.resolve({ token: 'new-tok', refreshToken: 'new-ref' }),
    });

    const result = await global.refreshAccessToken();
    expect(result).toBe(true);
    expect(localStorage.getItem('bridge_token')).toBe('new-tok');
    expect(localStorage.getItem('bridge_refresh_token')).toBe('new-ref');
  });

  test('sunucu hatasında false döner', async () => {
    localStorage.setItem('bridge_refresh_token', 'bad-refresh');
    global.fetch.mockResolvedValueOnce({ ok: false, status: 401, json: () => ({}) });

    const result = await global.refreshAccessToken();
    expect(result).toBe(false);
  });
});
