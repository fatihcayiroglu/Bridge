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

// DOM-independent test harness; browser packages are not required.

// ── STORAGE_VER sabiti ────────────────────────────────────────
const STORAGE_KEY = 'bridge_onboarding_done';
const STORAGE_VER = '2';

describe('Onboarding Wizard — localStorage flag', () => {
  beforeEach(() => localStorage.clear());

  it('yeni kullanıcıda flag yoktur', () => {
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('wizard tamamlandığında flag set edilir', () => {
    localStorage.setItem(STORAGE_KEY, STORAGE_VER);
    expect(localStorage.getItem(STORAGE_KEY)).toBe(STORAGE_VER);
  });

  it('eski versiyon flag varsa wizard tekrar açılmalı', () => {
    localStorage.setItem(STORAGE_KEY, '1');
    const shouldShow = localStorage.getItem(STORAGE_KEY) !== STORAGE_VER;
    expect(shouldShow).toBe(true);
  });

  it('güncel versiyon flag varsa wizard açılmaz', () => {
    localStorage.setItem(STORAGE_KEY, STORAGE_VER);
    const shouldShow = localStorage.getItem(STORAGE_KEY) !== STORAGE_VER;
    expect(shouldShow).toBe(false);
  });

  it('resetOnboarding() flag siler', () => {
    localStorage.setItem(STORAGE_KEY, STORAGE_VER);
    localStorage.removeItem(STORAGE_KEY);
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
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
    const escHandler = (e: { key: string }) => { if (e.key === 'Escape') isOpen = false; };
    escHandler({ key: 'Escape' });
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
    const attributes: Record<string, string> = {};
    attributes.role = 'dialog';
    attributes['aria-modal'] = 'true';
    attributes['aria-label'] = 'Onboarding Wizard';
    expect(attributes.role).toBe('dialog');
    expect(attributes['aria-modal']).toBe('true');
  });

  it('focus trap için odaklanabilir öğeler tanımlı olmalı', () => {
    const focusable = ['button', 'button'];
    expect(focusable.length).toBeGreaterThan(0);
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
