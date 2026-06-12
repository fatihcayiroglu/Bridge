// client/tests/outgoing-webhooks.test.ts — Sprint 52
// outgoing-webhooks.ts için unit testler
// Kapsam: openOutgoingWebhookManager modal oluşturma, form validasyonu, liste render

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/api-fetch', () => ({
  apiFetch: jest.fn(),
}), { virtual: true });

jest.mock('../js/core/globals', () => ({
  getAPI: jest.fn(() => 'http://localhost:3000'),
}), { virtual: true });

jest.mock('../js/core/utils', () => ({
  escHtml: (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}), { virtual: true });

import { apiFetch } from '../js/core/api-fetch';

// ── Helpers ────────────────────────────────────────────────────────────────────

function buildDOM() {
  document.body.innerHTML = '';
}

function setServer(srv = { _id: 'srv1' }) {
  global.currentServer = srv;
}

function loadModule() {
  jest.resetModules();
  return require('../js/core/outgoing-webhooks');
}

const sampleWebhooks = [
  { _id: 'wh1', name: 'Test Hook', url: 'https://example.com/wh', enabled: true, events: ['message:new'] },
  { _id: 'wh2', name: 'Second',    url: 'https://other.com/wh',   enabled: false },
];

// ── Tests ──────────────────────────────────────────────────────────────────────

describe('openOutgoingWebhookManager()', () => {
  beforeEach(() => {
    buildDOM();
    setServer();
    apiFetch.mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(sampleWebhooks),
    });
    global.toast.mockClear();
  });

  test('server yoksa modal açmaz', async () => {
    global.currentServer = null;
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(document.getElementById('outgoing-wh-modal')).toBeNull();
  });

  test('modal oluşturur', async () => {
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(document.getElementById('outgoing-wh-modal')).not.toBeNull();
  });

  test('modal başlığı içerir', async () => {
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(document.body.innerHTML).toContain('Giden Webhook');
  });

  test('webhook listesi API\'den yüklenir', async () => {
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(apiFetch).toHaveBeenCalledWith(expect.stringContaining('/api/webhooks/outgoing'));
  });

  test('webhook adları escHtml ile güvenli render edilir', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve([
        { _id: 'wh1', name: '<script>xss</script>', url: 'http://x.com', enabled: true },
      ]),
    });
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(document.body.innerHTML).not.toContain('<script>xss</script>');
    expect(document.body.innerHTML).toContain('&lt;script&gt;');
  });

  test('desteklenen event\'ler listesi modali içinde gösterilir', async () => {
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(document.body.innerHTML).toContain('message:new');
  });

  test('API başarısız olunca error toast gösterir', async () => {
    apiFetch.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ error: 'Yetkisiz' }),
    });
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(global.toast).toHaveBeenCalledWith(expect.any(String), 'error');
  });

  test('API exception olunca error toast gösterir', async () => {
    apiFetch.mockRejectedValueOnce(new Error('Network'));
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(global.toast).toHaveBeenCalledWith(expect.any(String), 'error');
  });
});

describe('Form alanları', () => {
  beforeEach(async () => {
    buildDOM();
    setServer();
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
  });

  test('ad input alanı mevcut', () => {
    expect(document.getElementById('ogwh-name')).not.toBeNull();
  });

  test('URL input alanı mevcut', () => {
    expect(document.getElementById('ogwh-url')).not.toBeNull();
  });

  test('secret input alanı mevcut', () => {
    expect(document.getElementById('ogwh-secret')).not.toBeNull();
  });
});

describe('Webhook listesi boş durum', () => {
  test('webhook yokken boş durum mesajı gösterilir', async () => {
    buildDOM();
    setServer();
    apiFetch.mockResolvedValue({ ok: true, json: () => Promise.resolve([]) });
    const { openOutgoingWebhookManager } = loadModule();
    await openOutgoingWebhookManager();
    expect(document.body.innerHTML).toMatch(/Henüz|webhook yok|boş|Kayıtlı/i);
  });
});
