// client/tests/helpers/setup.ts — Bridge v74
// Jest jsdom ortamı için global stub'lar
// Vanilla JS modülleri window.* global'larını kullanır — bunları simüle et
// Sprint 57: setup.js → setup.ts migrate edildi

// ── Global tip genişletmeleri ─────────────────────────────────
declare global {
  // eslint-disable-next-line no-var
  var localStorage: Storage;
  // eslint-disable-next-line no-var
  var io: jest.Mock<{
    on: jest.Mock;
    off: jest.Mock;
    emit: jest.Mock;
    connected: boolean;
    _trigger: (event: string, ...args: unknown[]) => void;
  }>;
  // eslint-disable-next-line no-var
  var fetch: jest.Mock;
  // eslint-disable-next-line no-var
  var Notification: { permission: string; requestPermission: jest.Mock };
  // eslint-disable-next-line no-var
  var API: string;
  // eslint-disable-next-line no-var
  var currentUser: unknown;
  // eslint-disable-next-line no-var
  var currentServer: unknown;
  // eslint-disable-next-line no-var
  var currentChannel: unknown;
  // eslint-disable-next-line no-var
  var token: string | null;
  // eslint-disable-next-line no-var
  var refreshToken: string | null;
  // eslint-disable-next-line no-var
  var clientConfig: Record<string, unknown>;
  // eslint-disable-next-line no-var
  var me: unknown;
  // eslint-disable-next-line no-var
  var socket: { emit: jest.Mock; on: jest.Mock; off: jest.Mock; connected: boolean };
  // eslint-disable-next-line no-var
  var serverEmojiCache: unknown[];
  // eslint-disable-next-line no-var
  var _blockedUserIds: Set<string>;
  // eslint-disable-next-line no-var
  var bridgeOfflineCache: unknown;
  // eslint-disable-next-line no-var
  var collapsedCategories: Set<string>;
  // eslint-disable-next-line no-var
  var _channelScrollPos: Record<string, number>;
  // eslint-disable-next-line no-var
  var toast: jest.Mock;
  // eslint-disable-next-line no-var
  var escHtml: (s: string) => string;
  // eslint-disable-next-line no-var
  var safeFileUrl: (url: unknown) => string;
  // eslint-disable-next-line no-var
  var cssColor: (v: unknown) => string;
  // eslint-disable-next-line no-var
  var apiFetch: jest.Mock;
  // eslint-disable-next-line no-var
  var startApp: jest.Mock;
  // eslint-disable-next-line no-var
  var refreshAccessToken: jest.Mock;
  // eslint-disable-next-line no-var
  var loadCategories: jest.Mock;
  // eslint-disable-next-line no-var
  var loadMessages: jest.Mock;
  // eslint-disable-next-line no-var
  var selectChannel: jest.Mock;
  // eslint-disable-next-line no-var
  var createChannel: jest.Mock;
  // eslint-disable-next-line no-var
  var openChannelMenu: jest.Mock;
  // eslint-disable-next-line no-var
  var scrollToMsg: jest.Mock;
  // eslint-disable-next-line no-var
  var openImageViewer: jest.Mock;
  // eslint-disable-next-line no-var
  var showEditHistory: jest.Mock;
  // eslint-disable-next-line no-var
  var hcaptcha: undefined;
  // eslint-disable-next-line no-var
  var turnstile: undefined;
}

// ── DOM Globals ───────────────────────────────────────────────
if (typeof localStorage === 'undefined') {
  const store: Record<string, string> = {};
  global.localStorage = {
    getItem:    (k: string) => store[k] ?? null,
    setItem:    (k: string, v: string) => { store[k] = String(v); },
    removeItem: (k: string) => { delete store[k]; },
    clear:      () => Object.keys(store).forEach(k => delete store[k]),
  } as unknown as Storage;
}

// ── Socket.io stub ────────────────────────────────────────────
global.io = jest.fn(() => {
  const handlers: Record<string, (...args: unknown[]) => void> = {};
  return {
    on:        jest.fn((event: string, fn: (...args: unknown[]) => void) => { handlers[event] = fn; }),
    off:       jest.fn(),
    emit:      jest.fn(),
    connected: true,
    _trigger:  (event: string, ...args: unknown[]) => handlers[event]?.(...args),
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

global.escHtml = (s: string): string => String(s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

global.safeFileUrl = (url: unknown): string => {
  if (typeof url !== 'string') return '';
  if (url.startsWith('/uploads/') || url.startsWith('data:image/')) return url;
  return '';
};

global.cssColor = (v: unknown): string => {
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
const originalWarn = console.warn.bind(console);
console.warn = (...args: unknown[]): void => {
  if (typeof args[0] === 'string' && args[0].includes('act(')) return;
  originalWarn(...args);
};

export {};
