// client/tests/onboarding-wizard.test.ts — Sprint 64
// onboarding-wizard.ts için unit testler
//
// Kapsam:
//   - isDone / markDone / resetOnboarding (localStorage persistence)
//   - maybeShowOnboarding: ilk girişte gösterir, tekrar çağrıda atlar
//   - force=true ile her zaman gösterir
//   - DOM yapısı: overlay, card, dots, butonlar, ARIA attribute'ları
//   - render(): icon, title, body, tip doğru yansır
//   - Navigasyon: Devam / Geri / dot click / ArrowLeft ArrowRight
//   - Son adımda "Başla" butonu görünür, dismiss + markDone çalışır
//   - Esc ile kapatma
//   - Backdrop click ile kapatma
//   - Atla (skip) ile kapatma
//   - Focus trap: Tab / Shift+Tab sınır davranışı
//   - BridgeRegistry kaydı

'use strict';

// ── Mocks ──────────────────────────────────────────────────────────────────────

jest.mock('../js/core/bridge-registry', () => ({
  BridgeRegistry: {
    register: jest.fn(),
    get:      jest.fn(),
    call:     jest.fn(),
    has:      jest.fn(() => false),
  },
}), { virtual: true });

jest.mock('../js/core/i18n', () => ({
  t: (key: string, fallback?: string) => fallback ?? key,
}), { virtual: true });

// ── Yardımcılar ───────────────────────────────────────────────────────────────

const OVERLAY_ID   = 'onboarding-wizard-overlay';
const STORAGE_KEY  = 'bridge_onboarding_done';
const STORAGE_VER  = '2';

/** localStorage'ı temizle ve modülü taze import et */
async function freshImport() {
  jest.resetModules();

  // i18n mock'unu resetModules sonrası yeniden kaydet
  jest.mock('../js/core/i18n', () => ({
    t: (key: string, fallback?: string) => fallback ?? key,
  }), { virtual: true });

  jest.mock('../js/core/bridge-registry', () => ({
    BridgeRegistry: {
      register: jest.fn(),
      get:      jest.fn(),
      call:     jest.fn(),
      has:      jest.fn(() => false),
    },
  }), { virtual: true });

  const mod = await import('../js/core/onboarding-wizard');
  return mod;
}

function getOverlay() {
  return document.getElementById(OVERLAY_ID);
}

function fireKey(el: Element | Document, key: string, extra: Partial<KeyboardEventInit> = {}) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...extra }));
}

// ── beforeEach ────────────────────────────────────────────────────────────────

beforeEach(() => {
  document.body.innerHTML = '';
  // onb-styles varsa temizle
  document.getElementById('onb-styles')?.remove();
  // localStorage temizle
  localStorage.clear();
  // requestAnimationFrame stub
  jest.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => { cb(0); return 0; });
});

afterEach(() => {
  jest.restoreAllMocks();
});

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('onboarding-wizard — persistence', () => {
  test('isDone: localStorage boşken false döner', async () => {
    const { resetOnboarding } = await freshImport();
    resetOnboarding();                   // key yok — clear
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    expect(getOverlay()).not.toBeNull(); // gösterilmeli
  });

  test('markDone: wizard kapandığında localStorage set edilir', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    // Atla butonuna tıkla → dismiss → markDone
    const overlay = getOverlay()!;
    (overlay.querySelector('.onb-skip') as HTMLButtonElement).click();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(STORAGE_VER);
  });

  test('isDone: localStorage doğru versiyonda ise wizard gösterilmez', async () => {
    localStorage.setItem(STORAGE_KEY, STORAGE_VER);
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    expect(getOverlay()).toBeNull();
  });

  test('resetOnboarding: localStorage key\'ini siler', async () => {
    localStorage.setItem(STORAGE_KEY, STORAGE_VER);
    const { resetOnboarding, maybeShowOnboarding } = await freshImport();
    resetOnboarding();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    maybeShowOnboarding();
    expect(getOverlay()).not.toBeNull();
  });

  test('eski versiyon: farklı STORAGE_VER varsa yeniden gösterilir', async () => {
    localStorage.setItem(STORAGE_KEY, '1'); // eski versiyon
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    expect(getOverlay()).not.toBeNull();
  });
});

describe('onboarding-wizard — maybeShowOnboarding', () => {
  test('DOM\'a overlay ekler', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    expect(getOverlay()).not.toBeNull();
  });

  test('zaten açıksa ikinci kez overlay eklemez', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    maybeShowOnboarding();
    expect(document.querySelectorAll(`#${OVERLAY_ID}`)).toHaveLength(1);
  });

  test('force=true ile markDone sonrasında da gösterir', async () => {
    localStorage.setItem(STORAGE_KEY, STORAGE_VER);
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding(true);
    expect(getOverlay()).not.toBeNull();
  });

  test('injectStyles: onb-styles style elemanını ekler', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    expect(document.getElementById('onb-styles')).not.toBeNull();
  });

  test('injectStyles: iki kez çağrılsa tek style elemanı kalır', async () => {
    const { maybeShowOnboarding, resetOnboarding } = await freshImport();
    maybeShowOnboarding();
    (getOverlay()!.querySelector('.onb-skip') as HTMLButtonElement).click(); // kapat
    resetOnboarding();
    maybeShowOnboarding();
    expect(document.querySelectorAll('#onb-styles')).toHaveLength(1);
  });
});

describe('onboarding-wizard — DOM yapısı', () => {
  test('overlay role=dialog ve aria-modal=true', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    expect(overlay.getAttribute('role')).toBe('dialog');
    expect(overlay.getAttribute('aria-modal')).toBe('true');
  });

  test('backdrop mevcut ve aria-hidden', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const backdrop = getOverlay()!.querySelector('.onb-backdrop');
    expect(backdrop).not.toBeNull();
    expect(backdrop!.getAttribute('aria-hidden')).toBe('true');
  });

  test('dots sayısı adım sayısına eşit (8)', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const dots = getOverlay()!.querySelectorAll('.onb-dot');
    expect(dots).toHaveLength(8);
  });

  test('ilk dot active, diğerleri değil', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const dots = Array.from(getOverlay()!.querySelectorAll('.onb-dot'));
    expect(dots[0].classList.contains('active')).toBe(true);
    expect(dots[1].classList.contains('active')).toBe(false);
  });

  test('dots role=tab ve aria-selected', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const dots = Array.from(getOverlay()!.querySelectorAll('.onb-dot'));
    expect(dots[0].getAttribute('role')).toBe('tab');
    expect(dots[0].getAttribute('aria-selected')).toBe('true');
    expect(dots[1].getAttribute('aria-selected')).toBe('false');
  });

  test('ilk adımda Geri butonu gizli', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const prevBtn = getOverlay()!.querySelector('.onb-prev') as HTMLButtonElement;
    expect(prevBtn.hidden).toBe(true);
  });

  test('close butonu aria-label taşır', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const closeBtn = getOverlay()!.querySelector('.onb-close');
    expect(closeBtn!.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('onboarding-wizard — render', () => {
  test('ilk adım: icon, title, body render edilir', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    expect((overlay.querySelector('.onb-icon') as HTMLElement).textContent).toBe('👋');
    expect((overlay.querySelector('.onb-title') as HTMLElement).textContent).toBeTruthy();
    expect((overlay.querySelector('.onb-body') as HTMLElement).textContent).toBeTruthy();
  });

  test('ilk adım: tip mevcut ve görünür', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const tipEl = getOverlay()!.querySelector('.onb-tip') as HTMLElement;
    expect(tipEl.hidden).toBe(false);
    expect(tipEl.textContent).toContain('💡');
  });

  test('son adımda next buton "Başla" metni gösterir', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const nextBtn = overlay.querySelector('.onb-next') as HTMLButtonElement;
    // 7. adıma ilerle (0-indexed, son = 7)
    for (let i = 0; i < 7; i++) nextBtn.click();
    expect(nextBtn.textContent).toBe('Başla');
  });
});

describe('onboarding-wizard — navigasyon', () => {
  test('Devam ile sonraki adıma geçilir', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const nextBtn = overlay.querySelector('.onb-next') as HTMLButtonElement;
    const icon1 = (overlay.querySelector('.onb-icon') as HTMLElement).textContent;
    nextBtn.click();
    const icon2 = (overlay.querySelector('.onb-icon') as HTMLElement).textContent;
    expect(icon2).not.toBe(icon1);
  });

  test('Geri ile önceki adıma dönülür', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const nextBtn = overlay.querySelector('.onb-next') as HTMLButtonElement;
    const prevBtn = overlay.querySelector('.onb-prev') as HTMLButtonElement;
    const icon0 = (overlay.querySelector('.onb-icon') as HTMLElement).textContent;
    nextBtn.click();
    prevBtn.click();
    expect((overlay.querySelector('.onb-icon') as HTMLElement).textContent).toBe(icon0);
  });

  test('Geri: ilk adımda hidden kalır', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const prevBtn = overlay.querySelector('.onb-prev') as HTMLButtonElement;
    expect(prevBtn.hidden).toBe(true);
    (overlay.querySelector('.onb-next') as HTMLButtonElement).click();
    expect(prevBtn.hidden).toBe(false);
    prevBtn.click();
    expect(prevBtn.hidden).toBe(true);
  });

  test('dot click: ilgili adıma atlar', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const dot4 = overlay.querySelectorAll('.onb-dot')[4] as HTMLButtonElement;
    dot4.click();
    expect(dot4.classList.contains('active')).toBe(true);
    expect(dot4.getAttribute('aria-selected')).toBe('true');
  });

  test('ArrowRight: sonraki adıma geçer', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const icon0 = (overlay.querySelector('.onb-icon') as HTMLElement).textContent;
    fireKey(overlay, 'ArrowRight');
    expect((overlay.querySelector('.onb-icon') as HTMLElement).textContent).not.toBe(icon0);
  });

  test('ArrowLeft: önceki adıma döner', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    (overlay.querySelector('.onb-next') as HTMLButtonElement).click();
    const icon1 = (overlay.querySelector('.onb-icon') as HTMLElement).textContent;
    fireKey(overlay, 'ArrowLeft');
    const icon0 = (overlay.querySelector('.onb-icon') as HTMLElement).textContent;
    expect(icon0).not.toBe(icon1);
  });

  test('ArrowRight: son adımda sınır aşılmaz', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    // Son adıma git
    for (let i = 0; i < 7; i++) fireKey(overlay, 'ArrowRight');
    const dotsAfter = overlay.querySelectorAll('.onb-dot.active');
    expect(dotsAfter).toHaveLength(1);
    // Bir kez daha — overlay hâlâ açık olmalı
    fireKey(overlay, 'ArrowRight');
    expect(getOverlay()).not.toBeNull();
  });

  test('ArrowLeft: ilk adımda sınır aşılmaz', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    fireKey(overlay, 'ArrowLeft'); // 0. adımda → değişmemeli
    expect((overlay.querySelector('.onb-dot.active') as HTMLElement)
      .dataset.step).toBe('0');
  });
});

describe('onboarding-wizard — kapatma', () => {
  test('Esc overlay\'i kapatır', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    fireKey(overlay, 'Escape');
    expect(getOverlay()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(STORAGE_VER);
  });

  test('Atla (skip) overlay\'i kapatır', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    (getOverlay()!.querySelector('.onb-skip') as HTMLButtonElement).click();
    expect(getOverlay()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(STORAGE_VER);
  });

  test('close (✕) butonu overlay\'i kapatır', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    (getOverlay()!.querySelector('.onb-close') as HTMLButtonElement).click();
    expect(getOverlay()).toBeNull();
  });

  test('backdrop click overlay\'i kapatır', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    (getOverlay()!.querySelector('.onb-backdrop') as HTMLElement).click();
    expect(getOverlay()).toBeNull();
  });

  test('son adımda "Başla" / next click overlay\'i kapatır', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const nextBtn = overlay.querySelector('.onb-next') as HTMLButtonElement;
    for (let i = 0; i < 7; i++) nextBtn.click();
    nextBtn.click(); // dismiss
    expect(getOverlay()).toBeNull();
    expect(localStorage.getItem(STORAGE_KEY)).toBe(STORAGE_VER);
  });
});

describe('onboarding-wizard — focus trap', () => {
  test('Tab: son fokuslanabilir elemandan ilkine döner', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>('button:not([hidden]):not([disabled]), [tabindex="0"]')
    );
    const last = focusable[focusable.length - 1];
    last.focus();
    const prevented = jest.fn();
    const tabEvent = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    Object.defineProperty(tabEvent, 'preventDefault', { value: prevented });
    overlay.dispatchEvent(tabEvent);
    expect(prevented).toHaveBeenCalled();
  });

  test('Shift+Tab: ilk fokuslanabilir elemandan sonuncuya döner', async () => {
    const { maybeShowOnboarding } = await freshImport();
    maybeShowOnboarding();
    const overlay = getOverlay()!;
    const focusable = Array.from(
      overlay.querySelectorAll<HTMLElement>('button:not([hidden]):not([disabled]), [tabindex="0"]')
    );
    focusable[0].focus();
    const prevented = jest.fn();
    const shiftTab = new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
    Object.defineProperty(shiftTab, 'preventDefault', { value: prevented });
    overlay.dispatchEvent(shiftTab);
    expect(prevented).toHaveBeenCalled();
  });
});

describe('onboarding-wizard — BridgeRegistry', () => {
  test('BridgeRegistry.register çağrılır', async () => {
    jest.resetModules();
    const mockRegister = jest.fn();
    jest.mock('../js/core/bridge-registry', () => ({
      BridgeRegistry: { register: mockRegister, get: jest.fn(), call: jest.fn(), has: jest.fn() },
    }), { virtual: true });
    jest.mock('../js/core/i18n', () => ({
      t: (key: string, fallback?: string) => fallback ?? key,
    }), { virtual: true });
    await import('../js/core/onboarding-wizard');
    expect(mockRegister).toHaveBeenCalledWith('onboardingWizard', expect.objectContaining({
      maybeShowOnboarding: expect.any(Function),
      resetOnboarding:     expect.any(Function),
    }));
  });
});
