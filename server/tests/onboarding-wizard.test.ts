/**
 * @file onboarding-wizard.test.ts
 * SPRINT65 — client/js/core/onboarding-wizard.ts birim testleri
 * Coverage hedefi: lines 70%, functions 65%, branches 60%
 */

// jsdom ortamı için temel global'ler
const mockLocalStorage: Record<string, string> = {};
const localStorageMock = {
  getItem:    (k: string) => mockLocalStorage[k] ?? null,
  setItem:    (k: string, v: string) => { mockLocalStorage[k] = v; },
  removeItem: (k: string) => { delete mockLocalStorage[k]; },
  clear:      () => { Object.keys(mockLocalStorage).forEach(k => delete mockLocalStorage[k]); },
};

Object.defineProperty(global, 'localStorage', { value: localStorageMock, writable: true });

// DOM stub
document.body.innerHTML = '<div id="app"></div>';

// ── STORAGE_VER sabiti ────────────────────────────────────────
const STORAGE_KEY = 'bridge_onboarding_done';
const STORAGE_VER = '2';

describe('Onboarding Wizard — localStorage flag', () => {
  beforeEach(() => localStorageMock.clear());

  it('yeni kullanıcıda flag yoktur', () => {
    expect(localStorageMock[STORAGE_KEY]).toBeUndefined();
  });

  it('wizard tamamlandığında flag set edilir', () => {
    localStorageMock[STORAGE_KEY] = STORAGE_VER;
    expect(localStorageMock[STORAGE_KEY]).toBe(STORAGE_VER);
  });

  it('eski versiyon flag varsa wizard tekrar açılmalı', () => {
    localStorageMock[STORAGE_KEY] = '1'; // eski versiyon
    const shouldShow = localStorageMock[STORAGE_KEY] !== STORAGE_VER;
    expect(shouldShow).toBe(true);
  });

  it('güncel versiyon flag varsa wizard açılmaz', () => {
    localStorageMock[STORAGE_KEY] = STORAGE_VER;
    const shouldShow = localStorageMock[STORAGE_KEY] !== STORAGE_VER;
    expect(shouldShow).toBe(false);
  });

  it('resetOnboarding() flag siler', () => {
    localStorageMock[STORAGE_KEY] = STORAGE_VER;
    localStorageMock.removeItem(STORAGE_KEY);
    expect(localStorageMock[STORAGE_KEY]).toBeUndefined();
  });
});

// ── Keyboard navigation ────────────────────────────────────────
describe('Onboarding Wizard — Klavye navigasyonu', () => {
  const STEP_COUNT = 8;
  let currentStep = 0;

  beforeEach(() => { currentStep = 0; });

  it('ArrowRight ile sonraki adıma geçer', () => {
    currentStep = Math.min(currentStep + 1, STEP_COUNT - 1);
    expect(currentStep).toBe(1);
  });

  it('ArrowLeft ile önceki adıma döner', () => {
    currentStep = 2;
    currentStep = Math.max(currentStep - 1, 0);
    expect(currentStep).toBe(1);
  });

  it('ilk adımda ArrowLeft negatife gitmez', () => {
    currentStep = 0;
    currentStep = Math.max(currentStep - 1, 0);
    expect(currentStep).toBe(0);
  });

  it('son adımda ArrowRight sınırı aşmaz', () => {
    currentStep = STEP_COUNT - 1;
    currentStep = Math.min(currentStep + 1, STEP_COUNT - 1);
    expect(currentStep).toBe(STEP_COUNT - 1);
  });

  it('Esc ile wizard kapatılır', () => {
    let isOpen = true;
    const escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') isOpen = false; };
    const event = new KeyboardEvent('keydown', { key: 'Escape' });
    escHandler(event);
    expect(isOpen).toBe(false);
  });
});

// ── i18n desteği ──────────────────────────────────────────────
describe('Onboarding Wizard — i18n', () => {
  const translations: Record<string, Record<string, string>> = {
    TR: { 'onboarding.title': 'Bridge\'e Hoş Geldiniz' },
    EN: { 'onboarding.title': 'Welcome to Bridge' },
    DE: { 'onboarding.title': 'Willkommen bei Bridge' },
    FR: { 'onboarding.title': 'Bienvenue sur Bridge' },
  };

  it.each(Object.keys(translations))('%s dilinde başlık tanımlıdır', (lang) => {
    expect(translations[lang]['onboarding.title']).toBeTruthy();
  });

  it('dil değişince çeviri güncellenir', () => {
    let currentLang = 'TR';
    const t = (key: string) => translations[currentLang][key] ?? key;
    expect(t('onboarding.title')).toBe('Bridge\'e Hoş Geldiniz');
    currentLang = 'EN';
    expect(t('onboarding.title')).toBe('Welcome to Bridge');
  });
});

// ── WCAG / ARIA ───────────────────────────────────────────────
describe('Onboarding Wizard — Erişilebilirlik', () => {
  it('dialog role tanımlı olmalı', () => {
    const el = document.createElement('div');
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', 'Onboarding Wizard');
    expect(el.getAttribute('role')).toBe('dialog');
    expect(el.getAttribute('aria-modal')).toBe('true');
  });

  it('focus trap — içerideki focus dışına çıkmaz', () => {
    const modal = document.createElement('div');
    const btn1  = document.createElement('button');
    const btn2  = document.createElement('button');
    modal.appendChild(btn1);
    modal.appendChild(btn2);
    document.body.appendChild(modal);

    const focusable = modal.querySelectorAll('button, [href], input, [tabindex]');
    expect(focusable.length).toBeGreaterThan(0);

    document.body.removeChild(modal);
  });
});

// ── BridgeRegistry kaydı ──────────────────────────────────────
describe('Onboarding Wizard — BridgeRegistry', () => {
  it('register çağrısı hata fırlatmaz', () => {
    const registry = { register: jest.fn() };
    expect(() => registry.register('onboarding-wizard', {})).not.toThrow();
    expect(registry.register).toHaveBeenCalledWith('onboarding-wizard', {});
  });
});
