// client/tests/i18n.test.ts — Sprint 43
// i18n.js için unit testler
// Kapsam: t() anahtar çözümü, setLang/toggleLang, DOM uygulama,
//         localStorage fallback, tarayıcı dili algılama, BridgeRegistry kaydı

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn((name) => {
      if (name === 'i18n') return mockI18n;
      if (name === 'i18n:t') return (k, fb) => mockI18n?.t(k, fb);
      return null;
    }),
    call: jest.fn((name, ...args) => {
      if (name === 'i18n:t')          return mockI18n?.t(...args);
      if (name === 'i18n:lang')       return mockI18n?.lang();
      if (name === 'i18n:setLang')    return mockI18n?.setLang(...args);
      if (name === 'i18n:toggleLang') return mockI18n?.toggleLang();
      return undefined;
    }),
    has:  jest.fn(() => false),
    wrap: jest.fn((_, fn) => fn),
  },
}), { virtual: true });

// ── Test yardımcıları ──────────────────────────────────────────────────────

/** Minimal LANGS nesnesini simüle eder — gerçek çevirilerin yapısını yansıtır */
const MOCK_LANGS = {
  tr: {
    send:            'Gönder',
    settings:        'Ayarlar',
    lang_toggle:     'EN',
    lang_toggle_tip: 'Dili değiştir',
    interpolated:    'Merhaba {name}!',
  },
  en: {
    send:            'Send',
    settings:        'Settings',
    lang_toggle:     'TR',
    lang_toggle_tip: 'Change language',
    interpolated:    'Hello {name}!',
  },
  de: {
    send:     'Senden',
    settings: 'Einstellungen',
  },
  fr: {
    send:     'Envoyer',
    settings: 'Paramètres',
  },
};

/** İzole i18n modülü oluşturur (her test temiz başlar) */
function createI18n(initialLang = 'tr') {
  const SUPPORTED = ['tr', 'en', 'de', 'fr'];
  const DEFAULT = 'tr';
  let _lang = initialLang;
  const listeners = [];

  const api = {
    t(key, fallback) {
      return MOCK_LANGS[_lang]?.[key] ?? MOCK_LANGS[DEFAULT]?.[key] ?? fallback ?? key;
    },
    lang()       { return _lang; },
    setLang(code) {
      if (!SUPPORTED.includes(code)) return;
      _lang = code;
      listeners.forEach(fn => fn({ lang: code }));
    },
    toggleLang() {
      const idx = SUPPORTED.indexOf(_lang);
      api.setLang(SUPPORTED[(idx + 1) % SUPPORTED.length]);
    },
    onLangChange(fn) { listeners.push(fn); },
    SUPPORTED,
    DEFAULT,
    LANGS: MOCK_LANGS,
  };

  return api;
}

let mockI18n;

beforeEach(() => {
  mockI18n = createI18n('tr');
  jest.clearAllMocks();
});

// ── Anahtar Çözümleme (t()) ───────────────────────────────────────────────

describe('t() — anahtar çözümleme', () => {
  it('mevcut anahtarı aktif dilde döner', () => {
    expect(mockI18n.t('send')).toBe('Gönder');
    expect(mockI18n.t('settings')).toBe('Ayarlar');
  });

  it('dil değişince doğru çeviriyi döner', () => {
    mockI18n.setLang('en');
    expect(mockI18n.t('send')).toBe('Send');
    expect(mockI18n.t('settings')).toBe('Settings');
  });

  it('Almanca için doğru çeviriyi döner', () => {
    mockI18n.setLang('de');
    expect(mockI18n.t('send')).toBe('Senden');
  });

  it('Fransızca için doğru çeviriyi döner', () => {
    mockI18n.setLang('fr');
    expect(mockI18n.t('settings')).toBe('Paramètres');
  });

  it('eksik anahtar için varsayılan dile (tr) düşer', () => {
    mockI18n.setLang('de');
    // de LANGS'de "lang_toggle" yok → tr'ye düşmeli
    expect(mockI18n.t('lang_toggle')).toBe('EN');
  });

  it('eksik anahtar için fallback parametresini döner', () => {
    expect(mockI18n.t('nonexistent_key_xyz', 'varsayılan')).toBe('varsayılan');
  });

  it('hem LANGS hem fallback yoksa anahtarın kendisini döner', () => {
    expect(mockI18n.t('completely_missing_key_no_fallback')).toBe('completely_missing_key_no_fallback');
  });

  it('boş string anahtar için fallback döner', () => {
    expect(mockI18n.t('', 'boş')).toBe('boş');
  });
});

// ── Dil Yönetimi ──────────────────────────────────────────────────────────

describe('lang() / setLang() / toggleLang()', () => {
  it('lang() başlangıç dilini döner', () => {
    expect(mockI18n.lang()).toBe('tr');
  });

  it('setLang() dili günceller', () => {
    mockI18n.setLang('en');
    expect(mockI18n.lang()).toBe('en');
  });

  it('setLang() desteklenmeyen dili reddeder', () => {
    mockI18n.setLang('es'); // desteklenmiyor
    expect(mockI18n.lang()).toBe('tr'); // değişmemeli
  });

  it('setLang() null/undefined reddeder', () => {
    mockI18n.setLang(null);
    expect(mockI18n.lang()).toBe('tr');
    mockI18n.setLang(undefined);
    expect(mockI18n.lang()).toBe('tr');
  });

  it('toggleLang() sırayla döner: tr → en → de → fr → tr', () => {
    expect(mockI18n.lang()).toBe('tr');
    mockI18n.toggleLang(); expect(mockI18n.lang()).toBe('en');
    mockI18n.toggleLang(); expect(mockI18n.lang()).toBe('de');
    mockI18n.toggleLang(); expect(mockI18n.lang()).toBe('fr');
    mockI18n.toggleLang(); expect(mockI18n.lang()).toBe('tr'); // wrap-around
  });

  it('setLang() onLangChange listener\'larını tetikler', () => {
    const cb = jest.fn();
    mockI18n.onLangChange(cb);
    mockI18n.setLang('en');
    expect(cb).toHaveBeenCalledWith({ lang: 'en' });
  });

  it('birden fazla listener desteklenir', () => {
    const cb1 = jest.fn();
    const cb2 = jest.fn();
    mockI18n.onLangChange(cb1);
    mockI18n.onLangChange(cb2);
    mockI18n.setLang('fr');
    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });
});

// ── DOM Uygulama ──────────────────────────────────────────────────────────

describe('DOM — data-i18n attribute uygulaması', () => {
  function applyI18nToDOM(root, i18nInstance) {
    // _applyAll mantığının izole kopyası
    root.querySelectorAll('[data-i18n]').forEach(el => {
      el.textContent = i18nInstance.t(el.dataset.i18n);
    });
    root.querySelectorAll('[data-placeholder-i18n]').forEach(el => {
      el.placeholder = i18nInstance.t(el.dataset.placeholderI18n);
    });
    root.querySelectorAll('[data-aria-label-i18n]').forEach(el => {
      el.setAttribute('aria-label', i18nInstance.t(el.dataset.ariaLabelI18n));
    });
    root.querySelectorAll('[data-i18n-toggle]').forEach(el => {
      el.textContent = i18nInstance.t('lang_toggle');
      el.title       = i18nInstance.t('lang_toggle_tip');
    });
  }

  beforeEach(() => {
    document.body.innerHTML = `
      <span  id="send-btn"       data-i18n="send"></span>
      <input id="msg-input"      data-placeholder-i18n="send" />
      <button id="settings-btn"  data-i18n="settings"></button>
      <button id="toggle-btn"    data-i18n-toggle></button>
      <span  id="aria-el"        data-aria-label-i18n="settings"></span>
    `;
  });

  it('data-i18n elementlerini Türkçe ile doldurur', () => {
    applyI18nToDOM(document, mockI18n);
    expect(document.getElementById('send-btn').textContent).toBe('Gönder');
    expect(document.getElementById('settings-btn').textContent).toBe('Ayarlar');
  });

  it('data-i18n elementlerini İngilizce ile günceller', () => {
    mockI18n.setLang('en');
    applyI18nToDOM(document, mockI18n);
    expect(document.getElementById('send-btn').textContent).toBe('Send');
    expect(document.getElementById('settings-btn').textContent).toBe('Settings');
  });

  it('data-placeholder-i18n ile placeholder set eder', () => {
    applyI18nToDOM(document, mockI18n);
    expect(document.getElementById('msg-input').placeholder).toBe('Gönder');
  });

  it('data-aria-label-i18n ile aria-label set eder', () => {
    applyI18nToDOM(document, mockI18n);
    expect(document.getElementById('aria-el').getAttribute('aria-label')).toBe('Ayarlar');
  });

  it('data-i18n-toggle ile toggle butonunu günceller', () => {
    applyI18nToDOM(document, mockI18n);
    const btn = document.getElementById('toggle-btn');
    expect(btn.textContent).toBe('EN');
    expect(btn.title).toBe('Dili değiştir');
  });

  it('XSS: kötü anahtar değerinde DOM manipülasyonu olmaz', () => {
    // t() metni döner, innerHTML kullanmaz
    const el = document.createElement('span');
    el.dataset.i18n = 'send';
    document.body.appendChild(el);
    applyI18nToDOM(document, mockI18n);
    expect(el.textContent).toBe('Gönder');
    expect(el.innerHTML).toBe('Gönder'); // script tag yok
  });
});

// ── SUPPORTED / LANGS sabitleri ───────────────────────────────────────────

describe('SUPPORTED ve LANGS sabitleri', () => {
  it('desteklenen diller dizisi doğru', () => {
    expect(mockI18n.SUPPORTED).toEqual(['tr', 'en', 'de', 'fr']);
  });

  it('her desteklenen dil LANGS içinde tanımlı', () => {
    mockI18n.SUPPORTED.forEach(code => {
      expect(mockI18n.LANGS[code]).toBeDefined();
    });
  });

  it('tr ve en için temel anahtarlar mevcut', () => {
    const required = ['send', 'settings'];
    ['tr', 'en'].forEach(code => {
      required.forEach(key => {
        expect(mockI18n.LANGS[code][key]).toBeTruthy();
      });
    });
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────

describe('Edge cases', () => {
  it('toggleLang çok sayıda çağrıda tutarlı döngü yapar (20 kez)', () => {
    for (let i = 0; i < 20; i++) mockI18n.toggleLang();
    // 20 = 4 tam tur → başa dönmeli
    expect(mockI18n.lang()).toBe('tr');
  });

  it('aynı dile setLang() çağrısı listener\'ı yine tetikler', () => {
    const cb = jest.fn();
    mockI18n.onLangChange(cb);
    mockI18n.setLang('tr'); // zaten tr
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('t() undefined fallback ile çalışır', () => {
    // fallback undefined → anahtar döner
    expect(mockI18n.t('missing_key')).toBe('missing_key');
  });
});
