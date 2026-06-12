// mobile/tests/__mocks__/@capacitor/core.js
//
// @capacitor/core native bridge simülasyonu — Jest için
//
// Capacitor'ın gerçek native köprüsü (iOS WKWebView / Android WebView) olmadan
// plugin çağrılarını simüle eder. Jasmine/Jest hybrid gerekmez; standart Jest
// ile çalışır. Conflict çözümü: mobile/tests için AYRI jest config kullanılır
// (jest.mobile.config.js), mevcut server ve client Jest config'leri dokunulmaz.

'use strict';

// ── Temel Capacitor Plugin Factory ──────────────────────────────────────────
// Tüm plugin'ler aynı EventEmitter + registerPlugin patternini kullanır.

const _pluginInstances = {};

function registerPlugin(name, { web } = {}) {
  if (_pluginInstances[name]) return _pluginInstances[name];
  const impl = web ? new web() : {};
  _pluginInstances[name] = impl;
  return impl;
}

// ── Capacitor çekirdek API ───────────────────────────────────────────────────

const Capacitor = {
  getPlatform  : jest.fn().mockReturnValue('web'), // 'ios' | 'android' | 'web'
  isNativePlatform: jest.fn().mockReturnValue(false),
  isPluginAvailable: jest.fn().mockReturnValue(true),
  convertFileSrc : jest.fn((path) => path),

  // Native bridge simülasyonu
  nativeCallback: jest.fn(),
  nativePromise : jest.fn().mockResolvedValue({}),
  toNative      : jest.fn(),
  fromNative    : jest.fn(),

  // Test yardımcısı: platform değiştirme
  _setPlatform(platform) {
    this.getPlatform.mockReturnValue(platform);
    this.isNativePlatform.mockReturnValue(platform !== 'web');
  },
};

// ── WebPlugin base ──────────────────────────────────────────────────────────
class WebPlugin {
  constructor() {
    this._listeners = {};
  }
  addListener(eventName, listenerFunc) {
    (this._listeners[eventName] = this._listeners[eventName] || []).push(listenerFunc);
    const handle = {
      remove: jest.fn(() => {
        this._listeners[eventName] = (this._listeners[eventName] || []).filter(l => l !== listenerFunc);
      }),
    };
    return Promise.resolve(handle);
  }
  removeAllListeners() {
    this._listeners = {};
    return Promise.resolve();
  }
  // Test yardımcısı: native event simüle et
  _emit(eventName, data) {
    (this._listeners[eventName] || []).forEach(l => l(data));
  }
}

module.exports = {
  Capacitor,
  WebPlugin,
  registerPlugin,
  _getPlugin: (name) => _pluginInstances[name],
  _resetPlugins: () => Object.keys(_pluginInstances).forEach(k => delete _pluginInstances[k]),
};
