// e2e/helpers/bridge.js — Bridge'e özgü Playwright yardımcıları
// Page Object Model yaklaşımı

const path = require('path');
const fs = require('fs');

const FIXTURES_DIR = path.join(__dirname, '..', 'fixtures');

/**
 * Kaydedilmiş token'ları oku
 */
function getTokens() {
  const p = path.join(FIXTURES_DIR, 'tokens.json');
  if (!fs.existsSync(p)) throw new Error('tokens.json bulunamadı — önce setup çalıştır');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/**
 * API isteği — authenticated
 */
async function apiRequest(request, method, url, body, token) {
  const tokens = token ? null : getTokens();
  const t = token || tokens.alice;

  const options = {
    headers: {
      Authorization: `Bearer ${t}`,
      'Content-Type': 'application/json',
    },
  };
  if (body) options.data = JSON.stringify(body);

  const res = await request[method.toLowerCase()](url, options);
  return res;
}

/**
 * Bridge sayfa nesne modeli
 */
class BridgePage {
  constructor(page) {
    this.page = page;
    this.baseURL = process.env.BASE_URL || 'http://localhost:3000';
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
async function createTestServer(request, token, name) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
  const res = await request.post(`${BASE}/api/servers`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: JSON.stringify({ name, description: 'E2E test server' }),
  });
  if (!res.ok()) return null;
  const data = await res.json();
  return data.server || data;
}

/**
 * API üzerinden kanal oluştur
 */
async function createTestChannel(request, token, serverId, name) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
  const res = await request.post(`${BASE}/api/servers/${serverId}/channels`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: JSON.stringify({ name, type: 'text' }),
  });
  if (!res.ok()) return null;
  return await res.json();
}

/**
 * API üzerinden mesaj gönder
 */
async function sendApiMessage(request, token, channelId, content) {
  const res = await request.post(`/api/channels/${channelId}/messages`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: JSON.stringify({ content }),
  });
  return await res.json();
}

module.exports = {
  BridgePage,
  getTokens,
  apiRequest,
  createTestServer,
  createTestChannel,
  sendApiMessage,
};

/**
 * API üzerinden sunucuya üye ol (davet kodu ile)
 */
async function joinServerViaInvite(request, token, inviteCode) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
  return request.post(`${BASE}/api/invite/${inviteCode}`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
}

/**
 * API üzerinden davet kodu oluştur
 */
async function createInvite(request, token, serverId, opts = {}) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
  const res = await request.post(`${BASE}/api/servers/${serverId}/invites`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: JSON.stringify(opts),
  });
  if (!res.ok()) return null;
  const data = await res.json();
  return data.code || data.invite?.code || data._id || null;
}

/**
 * API üzerinden mesaja reaksiyon ekle
 */
async function addReaction(request, token, channelId, messageId, emoji) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
  return request.post(
    `${BASE}/api/channels/${channelId}/messages/${messageId}/react`,
    {
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      data: JSON.stringify({ emoji }),
    }
  );
}

/**
 * Kullanıcı profilini güncelle
 */
async function updateProfile(request, token, fields) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
  return request.patch(`${BASE}/api/me`, {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: JSON.stringify(fields),
  });
}

/**
 * Link preview al
 */
async function getLinkPreview(request, token, url) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
  return request.get(
    `${BASE}/api/link-preview?url=${encodeURIComponent(url)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
}

/**
 * Sunucu kanallarını listele
 */
async function getChannels(request, token, serverId) {
  const BASE = process.env.BASE_URL || 'http://localhost:3000';
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
function mockPushSubscription(suffix = '') {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/e2e-mock-${suffix}-${Date.now()}`,
    keys: {
      p256dh: 'BNcRdreALRFXTkOOUHK1EtK2wtFBuCCSTBnJJ-A7EPMgWCn4yXqXbcyq5fSMlTGHKMUkqIWBiEUmgQrWp4Xj8Y',
      auth:   'tBHItJI5svbpez7KI4CCXg',
    },
  };
}

// ── Eski module.exports'u genişlet ───────────────────────────
Object.assign(module.exports, {
  joinServerViaInvite,
  createInvite,
  addReaction,
  updateProfile,
  getLinkPreview,
  getChannels,
  mockPushSubscription,
});
