// client/tests/helpers/setup.js — Bridge v74
// Jest jsdom ortamı için global stub'lar
// Vanilla JS modülleri window.* global'larını kullanır — bunları simüle et

'use strict';

// ── DOM Globals ───────────────────────────────────────────────
if (typeof localStorage === 'undefined') {
  const store = {};
  global.localStorage = {
    getItem:    (k) => store[k] ?? null,
    setItem:    (k, v) => { store[k] = String(v); },
    removeItem: (k) => { delete store[k]; },
    clear:      () => Object.keys(store).forEach(k => delete store[k]),
  };
}

// ── Socket.io stub ────────────────────────────────────────────
global.io = jest.fn(() => {
  const handlers = {};
  return {
    on:        jest.fn((event, fn) => { handlers[event] = fn; }),
    off:       jest.fn(),
    emit:      jest.fn(),
    connected: true,
    _trigger:  (event, ...args) => handlers[event]?.(...args),
  };
});

// ── fetch stub ────────────────────────────────────────────────
global.fetch = jest.fn(() =>
  Promise.resolve({
    ok: true, json: () => Promise.resolve({}),
    text: () => Promise.resolve(''), status: 200,
  })
);

// ── Notification API stub ─────────────────────────────────────
global.Notification = {
  permission: 'granted',
  requestPermission: jest.fn(() => Promise.resolve('granted')),
};

// ── window globals Bridge modülleri kullanır ──────────────────
global.API            = 'http://localhost:3000';
global.currentUser    = null;
global.currentServer  = null;
global.currentChannel = null;
global.token          = null;
global.refreshToken   = null;
global.clientConfig   = {};
global.me             = null;
global.socket = { emit: jest.fn(), on: jest.fn(), off: jest.fn(), connected: true };

// ── Bridge cache / feature globals ────────────────────────────
global.serverEmojiCache    = [];
global._blockedUserIds     = new Set();
global.bridgeOfflineCache  = null;
global.collapsedCategories = new Set();
global._channelScrollPos   = {};

// ── Utility stubs ─────────────────────────────────────────────
global.toast = jest.fn();

global.escHtml = (s) => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

global.safeFileUrl = (url) => {
  if (typeof url !== 'string') return '';
  if (url.startsWith('/uploads/') || url.startsWith('data:image/')) return url;
  return '';
};

global.cssColor = (v) => {
  if (typeof v === 'string' && /^#([0-9a-fA-F]{3,8})$/.test(v)) return v;
  return '#808080';
};

global.apiFetch = jest.fn(() =>
  Promise.resolve({ ok: true, json: () => Promise.resolve({}), status: 200 })
);

// ── Auth domain stubs ─────────────────────────────────────────
global.startApp           = jest.fn();
global.refreshAccessToken = jest.fn().mockResolvedValue(false);

// ── Channel-list domain stubs ─────────────────────────────────
global.loadCategories  = jest.fn().mockResolvedValue([]);
global.loadMessages    = jest.fn().mockResolvedValue(undefined);
global.selectChannel   = jest.fn();
global.createChannel   = jest.fn();
global.openChannelMenu = jest.fn();

// ── Messages domain stubs ─────────────────────────────────────
global.scrollToMsg     = jest.fn();
global.openImageViewer = jest.fn();
global.showEditHistory = jest.fn();

// ── CAPTCHA stubs — gerçek script yüklenmez ───────────────────
global.hcaptcha  = undefined;
global.turnstile = undefined;

// ── Console suppression ───────────────────────────────────────
const originalWarn = console.warn;
console.warn = (...args) => {
  if (args[0]?.includes?.('act(')) return;
  originalWarn(...args);
};
