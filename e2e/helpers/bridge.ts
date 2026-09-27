// e2e/helpers/bridge.ts — Sprint 14: TypeScript dönüşümü (.js → .ts)
// e2e/helpers/bridge.js — Bridge'e özgü Playwright yardımcıları
// Page Object Model yaklaşımı

import path from 'path';
import { getCsrf } from './csrf';
import fs from 'fs';

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

type E2EUser = {
  username: string;
  email: string;
  password: string;
  displayName?: string;
};

type E2ETokens = {
  alice: string;
  bob: string;
  carol: string;
  /** Medya paketine ozel — hiz butcesini alice/bob ile paylasmaz. */
  media1: string;
  media2: string;
  users: {
    alice: E2EUser;
    bob: E2EUser;
    carol: E2EUser;
    media1: E2EUser;
    media2: E2EUser;
  };
};

/**
 * Kaydedilmiş token'ları oku
 */
function getTokens(): E2ETokens {
  const p = path.join(FIXTURES_DIR, 'tokens.json');
  if (!fs.existsSync(p)) throw new Error('tokens.json bulunamadı — önce setup çalıştır');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * Bearer + (gerekliyse) CSRF başlıklarını üret.
 */
async function authHeaders(
  request: import('@playwright/test').APIRequestContext,
  bearer: string,
  method = 'POST',
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    'Content-Type': 'application/json',
  };
  if (!SAFE_METHODS.has(method.toUpperCase())) {
    const t = await getCsrf(request, bearer);
    if (t) headers['X-CSRF-Token'] = t;
  }
  return headers;
}

/**
 * API isteği — authenticated
 */
async function apiRequest(request: import('@playwright/test').APIRequestContext, method: string, url: string, body?: unknown, token?: string) {
  const tokens = token ? null : getTokens();
  const t = token || tokens.alice;

  const options: { headers: Record<string, string>; data?: string } = {
    headers: await authHeaders(request, t, method),
  };
  if (body) options.data = JSON.stringify(body);

  const res = await request[method.toLowerCase()](url, options);
  return res;
}

/**
 * Bridge sayfa nesne modeli
 */
class BridgePage {
  readonly page: import('@playwright/test').Page;
  readonly baseURL: string;

  constructor(page: import('@playwright/test').Page) {
    this.page = page;
    this.baseURL = process.env.BASE_URL || 'http://127.0.0.1:3000';
  }

  // ── Selectors ───────────────────────────────────────────
  get messageInput() {
    return this.page.locator('[data-testid="message-input"], #message-input, .message-input, [placeholder*="Message"], [placeholder*="Mesaj"]').first();
  }

  get sendButton() {
    return this.page.locator('[data-testid="send-btn"], #send-btn, .send-btn, button[type="submit"]').first();
  }

  get channelList() {
    return this.page.locator('.channel-list, #channel-list, [data-testid="channel-list"]');
  }

  get serverList() {
    return this.page.locator('.server-list, #server-list, [data-testid="server-list"]');
  }

  get messageContainer() {
    return this.page.locator('.messages-container, #messages, [data-testid="messages"]');
  }

  // ── Actions ─────────────────────────────────────────────

  async goto(path = '') {
    await this.page.goto(`${this.baseURL}${path}`);
  }

  /**
   * UI'dan login (form üzerinden)
   */
  async loginViaUI(email, password) {
    await this.goto('/login');
    await this.page.locator('input[type="email"], input[name="email"], #email').fill(email);
    await this.page.locator('input[type="password"], input[name="password"], #password').fill(password);
    await this.page.locator('button[type="submit"], .login-btn, #login-btn').click();
    // Login sonrası ana sayfaya yönlendirme bekle
    await this.page.waitForURL(/\/$|\/app|\/channels/, { timeout: 10_000 });
  }

  /**
   * Token inject ederek hızlı giriş (UI testi değil)
   */
  async loginViaToken(token) {
    await this.goto('/');
    await this.page.evaluate((t) => {
      localStorage.setItem('token', t);
      localStorage.setItem('bridge_token', t);
    }, token);
    await this.page.reload();
    await this.page.waitForTimeout(500);
  }

  /**
   * Mesaj gönder
   */
  async sendMessage(text) {
    await this.messageInput.waitFor({ state: 'visible', timeout: 8_000 });
    await this.messageInput.click();
    await this.messageInput.fill(text);
    // Enter veya send button
    await this.page.keyboard.press('Enter');
    // Mesajın görünmesini bekle
    await this.page.locator(`.message, .msg, [data-testid="message"]`).last().waitFor({ timeout: 5_000 }).catch(() => {});
  }

  /**
   * Mesajın ekranda göründüğünü doğrula
   */
  async expectMessageVisible(text) {
    await this.page.locator(`text=${text}`).waitFor({ state: 'visible', timeout: 8_000 });
  }

  /**
   * Kanala tıkla
   */
  async clickChannel(channelName) {
    await this.page.locator(`text=${channelName}`).first().click();
    await this.page.waitForTimeout(500);
  }

  /**
   * Sunucuya tıkla (sol sidebar)
   */
  async clickServer(serverName) {
    await this.page.locator(`[title="${serverName}"], [alt="${serverName}"]`).first().click();
    await this.page.waitForTimeout(500);
  }
}

/**
 * API üzerinden sunucu oluştur
 */
async function createTestServer(request: import('@playwright/test').APIRequestContext, token: string, name: string) {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  const res = await request.post(`${BASE}/api/servers`, {
    headers: await authHeaders(request, token),
    data: JSON.stringify({ name, description: 'E2E test server' }),
  });
  if (!res.ok()) {
    console.error(`[e2e] createTestServer ${res.status()}: ${(await res.text()).slice(0, 200)}`);
    return null;
  }
  const data = await res.json();
  return data.server || data;
}

/**
 * API üzerinden kanal oluştur
 */
async function createTestChannel(request: import('@playwright/test').APIRequestContext, token: string, serverId: string, name: string, type = 'text') {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  const res = await request.post(`${BASE}/api/servers/${serverId}/channels`, {
    headers: await authHeaders(request, token),
    data: JSON.stringify({ name, type }),
  });
  if (!res.ok()) return null;
  return await res.json();
}

/**
 * API üzerinden mesaj gönder
 */
async function sendApiMessage(request: import('@playwright/test').APIRequestContext, token: string, channelId: string, content: string) {
  const res = await request.post(`/api/channels/${channelId}/messages`, {
    headers: await authHeaders(request, token),
    data: JSON.stringify({ content }),
  });
  return await res.json();
}

export { BridgePage };
export { getTokens };
export { apiRequest };
export { createTestServer };
export { createTestChannel };
export { sendApiMessage };

/**
 * API üzerinden sunucuya üye ol (davet kodu ile)
 */
async function joinServerViaInvite(request: import('@playwright/test').APIRequestContext, token: string, inviteCode: string) {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  // FAZ 17: burasi `/api/invite/:code` cagiriyordu — BOYLE BIR ROTA YOK (404).
  // Kanonik uc: POST /api/servers/invites/:code/use
  return request.post(`${BASE}/api/servers/invites/${inviteCode}/use`, {
    headers: await authHeaders(request, token),
  });
}

/**
 * API üzerinden davet kodu oluştur
 */
async function createInvite(request: import('@playwright/test').APIRequestContext, token: string, serverId: string, opts: Record<string, unknown> = {}) {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  // FAZ 17: `/api/servers/:id/invites` de yok; sunucu kimligi GOVDEDE gider.
  const res = await request.post(`${BASE}/api/servers/invites`, {
    headers: await authHeaders(request, token),
    data: JSON.stringify({ serverId, ...opts }),
  });
  if (!res.ok()) return null;
  const data = await res.json();
  return data.code || data.invite?.code || data._id || null;
}

/**
 * API üzerinden mesaja reaksiyon ekle
 */
async function addReaction(request: import('@playwright/test').APIRequestContext, token: string, channelId: string, messageId: string, emoji: string) {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  return request.post(
    `${BASE}/api/channels/${channelId}/messages/${messageId}/react`,
    {
      headers: await authHeaders(request, token),
      data: JSON.stringify({ emoji }),
    }
  );
}

/**
 * Kullanıcı profilini güncelle
 */
async function updateProfile(request: import('@playwright/test').APIRequestContext, token: string, fields: Record<string, unknown>) {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  return request.patch(`${BASE}/api/me`, {
    headers: await authHeaders(request, token),
    data: JSON.stringify(fields),
  });
}

/**
 * Link preview al
 */
async function getLinkPreview(request: import('@playwright/test').APIRequestContext, token: string, url: string) {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  return request.get(
    `${BASE}/api/link-preview?url=${encodeURIComponent(url)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

/**
 * Sunucu kanallarını listele
 */
async function getChannels(request: import('@playwright/test').APIRequestContext, token: string, serverId: string) {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  const res = await request.get(`${BASE}/api/servers/${serverId}/channels`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok()) return [];
  const data = await res.json();
  return data.channels || data;
}

/**
 * Mock VAPID abonelik payload'ı (test amaçlı)
 */
function mockPushSubscription(suffix = ''): { endpoint: string; keys: { p256dh: string; auth: string } } {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/e2e-mock-${suffix}-${Date.now()}`,
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtFBuCCSTBnJJ-A7EPMgWCn4yXqXbcyq5fSMlTGHKMUkqIWBiEUmgQrWp4Xj8Y',
      auth:   'tBHItJI5svbpez7KI4CCXg',
    },
  };
}

// ── Eski module.exports'u genişlet ───────────────────────────
export { joinServerViaInvite };
export { createInvite };
export { addReaction };
export { updateProfile };
export { getLinkPreview };
export { getChannels };
export { mockPushSubscription };

/**
 * Kullanıcıyı sunucuya davet koduyla ekler (kanonik üretim akışı).
 * `channel:join` sunucu üyeliği + kanal görünürlüğü şart koşar; yayın
 * testleri için ikinci kullanıcının GERÇEKTEN üye olması gerekir.
 */
async function joinServer(
  request: import('@playwright/test').APIRequestContext,
  ownerToken: string,
  memberToken: string,
  serverId: string,
): Promise<boolean> {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  const created = await request.post(`${BASE}/api/servers/invites`, {
    headers: await authHeaders(request, ownerToken),
    data: JSON.stringify({ serverId }),
  });
  if (!created.ok()) return false;
  const { code } = await created.json() as { code?: string };
  if (!code) return false;
  const used = await request.post(`${BASE}/api/servers/invites/${code}/use`, {
    headers: await authHeaders(request, memberToken),
    data: JSON.stringify({}),
  });
  return used.ok();
}

export { joinServer };

/**
 * KANONİK tarayıcı girişi.
 *
 * Eski yardımcılar `/login` adresine gidip `input[type="email"]` arıyordu.
 * Bridge tek sayfa uygulamasıdır: giriş formu KÖK adreste (`/`) render edilir
 * ve alan KULLANICI ADIDIR, e-posta değil. Bu yüzden `page.fill` 10 sn timeout
 * ile düşüyordu.
 *
 * Seçiciler erişilebilirlik sözleşmesine bağlanır (rol + erişilebilir ad);
 * üretilmiş sınıf adlarına DEĞİL — client/index.html'de `aria-label` ve kalıcı
 * `#l-username` / `#l-password` kimlikleri mevcuttur.
 */
async function loginViaUI(
  page: import('@playwright/test').Page,
  username: string,
  password: string,
): Promise<void> {
  const base = process.env.BASE_URL || 'http://127.0.0.1:3000';
  await page.goto(base, { waitUntil: 'domcontentloaded' });

  const user = page.locator('#l-username');
  await user.waitFor({ state: 'visible', timeout: 15_000 });
  await user.fill(username);
  await page.locator('#l-password').fill(password);
  // #login-form içine kapsamla ve TAM ad eşleşmesi kullan: 'Passkey ile Giriş
  // Yap' butonu da alt dize olarak eşleşiyor ve strict-mode ihlali veriyordu.
  // Faz 18: buton artık çevrilmiş görünür metinden adını alır (sabit Türkçe aria-label
  // kaldırıldı; Almanca okuyana da "Giriş yap" okunuyordu). Dilden bağımsız kanca kullanılır.
  await page.locator('#login-form [data-auth-action="login"]').click();

  // Giriş sonrası uygulama kabuğu görünür olur; login formu kaybolur.
  await page.locator('#login-form').waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => { /* zaten gizli olabilir */ });
}

export { loginViaUI };

/**
 * TALEP UZERINE TAZE TEST KULLANICISI.
 *
 * ══════════════════════════════════════════════════════════════════════════
 * NEDEN GEREKLI
 * ══════════════════════════════════════════════════════════════════════════
 * `server/socket/socketRateLimit.ts` KULLANICI BASINA genel bir sinir uygular
 * (`'*': { max: 200, windowMs: 60_000 }`). Paket sabit birkac kimligi (alice /
 * bob) paylastigi ve `workers: 2` ile projeler es zamanli kostugu icin, agir
 * bir spec bir kimligin dakikalik butcesini tuketip ILGISIZ testlerin
 * `message:send` cagrilarinin reddedilmesine yol aciyordu. Belirti: mesaj
 * `pending` → `failed`.
 *
 * Sinir ZAYIFLATILMAZ: dakikada 200 olay (~3.3/sn surekli) gercek bir
 * kullanicinin ulasamayacagi makul bir kotuye kullanim korumasidir. Dogru
 * cozum, agir spec'e KENDI kimligini vermektir.
 */
async function registerFreshUser(
  request: import('@playwright/test').APIRequestContext,
  label: string,
): Promise<{ token: string; username: string }> {
  const BASE = process.env.BASE_URL || 'http://127.0.0.1:3000';
  const password = 'E2eTestPass987!';

  // KIMLIK KARARLIDIR: `label` + kalici RUN_ID. Ilk kosumda olusturulur,
  // sonrakilerde LOGIN ile yeniden kullanilir.
  //
  // Eskiden her cagri RASTGELE bir hesap aciyordu. Sunucunun kotuye kullanim
  // korumasi IP basina saatte `MAX_REG_PER_HOUR` (varsayilan 3) hesapla
  // sinirlidir; birkac kosum sonra `/api/register` 429 donuyor ve TUM paket
  // global setup'ta 401 ile duruyordu. Koruma dogru; harcayan testlerdi.
  let runId = '';
  try {
    runId = fs.readFileSync(path.join(FIXTURES_DIR, 'run-id.txt'), 'utf8').trim();
  } catch { runId = 'local'; }
  const username = `e2e_${label}_${runId}`.slice(0, 30);

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
      + '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json, text/plain, */*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Sec-Fetch-Site': 'same-origin',
    'Sec-Fetch-Mode': 'cors',
  };

  const reg = await request.post(`${BASE}/api/register`, {
    headers,
    data: { username, email: `${username}@bridge-e2e.test`, password, displayName: `${label} E2E` },
  });
  if (reg.ok()) {
    const d = await reg.json() as { token?: string; accessToken?: string };
    const t = d.token ?? d.accessToken;
    if (t) return { token: t, username };
  }

  // Zaten var (ya da kota) → GIRIS yap.
  const login = await request.post(`${BASE}/api/login`, {
    headers, data: { username, password },
  });
  if (!login.ok()) {
    // HAVUZA GERI DUSME DENENDI VE GERI ALINDI.
    //
    // Etiketleri dort saglanmis kimlige eslemek, ~26 guvenlik testini ayni
    // kimlikler uzerine yigdi: kullanici basina soket/API siniri
    // (`'*': 200/dk`) tukendi ve paylasilan durum kirlendi.
    //
    // OLCULDU (ayni kodla iki kez, birebir ayni sonuc):
    //   havuz ONCESI : 196 gecti / 67 dustu  (8.5 dk)
    //   havuz SONRASI:  84 gecti / 147 dustu (15.2 ve 15.5 dk)
    //
    // Dogru model KARARLI, ETIKETE OZEL kimliklerdir: ilk kosumda bir kez
    // olusturulur, sonra login ile yeniden kullanilir. Kota (3/saat) yalnizca
    // YENI etiket eklendiginde harcanir.
    throw new Error(`kimlik hazirlanamadi (${label}): register=${reg.status()} login=${login.status()}`);  }
  const d = await login.json() as { token?: string; accessToken?: string };
  const t = d.token ?? d.accessToken;
  if (!t) throw new Error(`giris yaniti token icermedi (${label})`);
  return { token: t, username };
}

export { registerFreshUser };
