// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/OnboardingWizardPanel.svelte
//              client/js/core/onboarding-wizard-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/onboarding-wizard.ts
// Sprint 64: Yeni kullanıcı onboarding wizard'ı
//
// Yalnızca ilk girişte gösterilir (localStorage flag).
// Keşfedilemez özellikleri tanıtır: E2E, Federation, Bot Marketi,
// Sesli Mesaj, Ekran Paylaşma, Arama, Kısayollar.
//
// Kullanım:
//   import { maybeShowOnboarding } from './onboarding-wizard.js';
//   maybeShowOnboarding();  // app.ts'de login sonrası çağrılır

import { t } from './i18n.js';
import { BridgeRegistry } from './bridge-registry.js';

// ── Sabitler ─────────────────────────────────────────────────────────────────

const STORAGE_KEY    = 'bridge_onboarding_done';
const STORAGE_VER    = '2';          // artırınca wizard yeniden gösterilir
const OVERLAY_ID     = 'onboarding-wizard-overlay';

// ── Adım tanımları ───────────────────────────────────────────────────────────

interface WizardStep {
  icon:    string;
  title:   string;
  body:    string;
  tip?:    string;
}

function getSteps(): WizardStep[] {
  return [
    {
      icon:  '👋',
      title: t('welcome_to_bridge'),
      body:  t('onboarding_step1_body',
               'Bridge; güvenli, açık kaynaklı ve federasyon destekli bir sohbet platformudur. Bu kısa tur seni birkaç dakikada temel özelliklere alıştıracak.'),
      tip:   t('onboarding_step1_tip', 'Dilediğinde Esc veya "Atla" ile çıkabilirsin.'),
    },
    {
      icon:  '🔒',
      title: t('onboarding_step2_title', 'Uçtan Uca Şifreleme'),
      body:  t('onboarding_step2_body',
               'E2E modunda mesajların yalnızca sen ve karşı tarafça okunabilir. DM penceresinde kilit simgesine tıklayarak etkinleştirebilirsin.'),
      tip:   t('tip_e2e'),
    },
    {
      icon:  '🌐',
      title: t('onboarding_step3_title', 'Federasyon — Uzak Sunuculara Bağlan'),
      body:  t('onboarding_step3_body',
               'Bridge; Mastodon ve diğer ActivityPub sunucularıyla konuşabilir. Sol çubukta yer küre simgesine tıklayarak uzak kullanıcıları takip edebilirsin.'),
      tip:   t('tip_federation'),
    },
    {
      icon:  '🤖',
      title: t('onboarding_step4_title', 'Bot Marketi'),
      body:  t('onboarding_step4_body',
               'Sunucuna müzik, anket, moderasyon ve daha fazlası için botlar ekleyebilirsin. Sunucu ayarlarından Bot Marketi'ni aç.'),
      tip:   t('tip_bots', 'Bot Marketi'),
    },
    {
      icon:  '🎙️',
      title: t('onboarding_step5_title', 'Sesli Mesaj & Ekran Paylaşımı'),
      body:  t('onboarding_step5_body',
               'Mesaj kutusunun yanındaki mikrofon simgesiyle sesli mesaj kaydedebilir, ses/video kanallarında ekranını paylaşabilirsin.'),
      tip:   t('tip_voice_msg', 'Sesli Mesaj'),
    },
    {
      icon:  '🔍',
      title: t('onboarding_step6_title', 'Gelişmiş Arama & AI Özet'),
      body:  t('onboarding_step6_body',
               'Ctrl+K ile anlık arama, kanal başlığındaki büyüteç ile mesaj araması yapabilirsin. AI kanal özetini kanal başlığındaki robot simgesinden açabilirsin.'),
      tip:   t('tip_ai_summary', '🤖 AI Kanal Özeti'),
    },
    {
      icon:  '⌨️',
      title: t('onboarding_step7_title', 'Klavye Kısayolları'),
      body:  t('onboarding_step7_body',
               'Ctrl+K — arama  •  Ctrl+Shift+M — mikrofonu kapat  •  Ctrl+Shift+D — sesi kapat  •  Esc — modalı kapat'),
      tip:   undefined,
    },
    {
      icon:  '🎉',
      title: t('onboarding_step8_title', 'Hazırsın!'),
      body:  t('onboarding_step8_body',
               'Bridge'i keşfetmeye başlayabilirsin. Herhangi bir konuda yardıma ihtiyaç duyarsan Ayarlar → Yardım'dan dökümanlara ulaşabilirsin.'),
      tip:   undefined,
    },
  ];
}

// ── Durum ────────────────────────────────────────────────────────────────────

let _currentStep = 0;
const _steps: WizardStep[] = [];

// ── DOM oluşturma ─────────────────────────────────────────────────────────────

function buildOverlay(): HTMLElement {
  const overlay = document.createElement('div');
  overlay.id = OVERLAY_ID;
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', t('welcome_to_bridge'));
  overlay.innerHTML = `
    <div class="onb-backdrop" aria-hidden="true"></div>
    <div class="onb-card" role="document">
      <button class="onb-close" aria-label="${t('close')}" tabindex="0">✕</button>

      <div class="onb-icon" aria-hidden="true"></div>
      <h2 class="onb-title"></h2>
      <p  class="onb-body"></p>
      <p  class="onb-tip" hidden></p>

      <div class="onb-dots" role="tablist" aria-label="Adımlar"></div>

      <div class="onb-actions">
        <button class="onb-skip btn-ghost">${t('cancel', 'Atla')}</button>
        <button class="onb-prev btn-secondary" hidden>${t('back', 'Geri')}</button>
        <button class="onb-next btn-primary">${t('continue', 'Devam')}</button>
      </div>
    </div>
  `;
  return overlay;
}

function injectStyles(): void {
  if (document.getElementById('onb-styles')) return;
  const style = document.createElement('style');
  style.id = 'onb-styles';
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed; inset: 0; z-index: 9999;
      display: flex; align-items: center; justify-content: center;
    }
    .onb-backdrop {
      position: absolute; inset: 0;
      background: rgba(0,0,0,.65); backdrop-filter: blur(4px);
    }
    .onb-card {
      position: relative; z-index: 1;
      background: var(--bg-primary, #1e1f22);
      border: 1px solid var(--border-color, #3f4147);
      border-radius: 16px;
      padding: 2.5rem 2rem 1.75rem;
      max-width: 480px; width: 90%;
      box-shadow: 0 24px 64px rgba(0,0,0,.45);
      display: flex; flex-direction: column; gap: .75rem;
      animation: onb-in .25s ease;
    }
    @keyframes onb-in {
      from { opacity: 0; transform: translateY(24px) scale(.97); }
      to   { opacity: 1; transform: none; }
    }
    .onb-close {
      position: absolute; top: 1rem; right: 1rem;
      background: none; border: none; color: var(--text-muted, #949ba4);
      font-size: 1.1rem; cursor: pointer; padding: .25rem .4rem; border-radius: 4px;
    }
    .onb-close:hover { background: var(--bg-modifier-hover, #35373c); color: var(--text-primary, #dbdee1); }
    .onb-icon  { font-size: 3rem; text-align: center; line-height: 1; }
    .onb-title { font-size: 1.3rem; font-weight: 700; color: var(--text-primary, #dbdee1); text-align: center; margin: 0; }
    .onb-body  { color: var(--text-secondary, #b5bac1); line-height: 1.6; text-align: center; margin: 0; font-size: .95rem; }
    .onb-tip {
      background: var(--bg-secondary, #2b2d31); border-left: 3px solid var(--brand, #2d9cdb);
      border-radius: 0 6px 6px 0; padding: .5rem .75rem;
      color: var(--text-muted, #949ba4); font-size: .85rem;
    }
    .onb-dots  { display: flex; justify-content: center; gap: .4rem; padding: .25rem 0; }
    .onb-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: var(--bg-modifier-hover, #35373c);
      border: none; cursor: pointer; padding: 0; transition: background .2s, transform .2s;
    }
    .onb-dot[aria-selected="true"], .onb-dot.active {
      background: var(--brand, #2d9cdb); transform: scale(1.3);
    }
    .onb-actions { display: flex; align-items: center; gap: .5rem; margin-top: .25rem; }
    .onb-skip    { margin-right: auto; color: var(--text-muted, #949ba4); background: none; border: none; cursor: pointer; font-size: .9rem; padding: .4rem .6rem; border-radius: 4px; }
    .onb-skip:hover { background: var(--bg-modifier-hover, #35373c); }
    .btn-secondary { background: var(--bg-modifier-hover, #35373c); color: var(--text-primary, #dbdee1); border: none; border-radius: 6px; padding: .5rem 1.1rem; cursor: pointer; font-size: .9rem; }
    .btn-secondary:hover { background: var(--bg-modifier-active, #43444b); }
    .btn-primary { background: var(--brand, #2d9cdb); color: #fff; border: none; border-radius: 6px; padding: .5rem 1.25rem; cursor: pointer; font-size: .9rem; font-weight: 600; margin-left: auto; }
    .btn-primary:hover { background: var(--brand-hover, #1a6b8a); }
  `;
  document.head.appendChild(style);
}

// ── Render ────────────────────────────────────────────────────────────────────

function render(overlay: HTMLElement): void {
  const step = _steps[_currentStep];
  const total = _steps.length;
  const isLast = _currentStep === total - 1;

  (overlay.querySelector('.onb-icon')  as HTMLElement).textContent = step.icon;
  (overlay.querySelector('.onb-title') as HTMLElement).textContent = step.title;
  (overlay.querySelector('.onb-body')  as HTMLElement).textContent = step.body;

  const tipEl = overlay.querySelector('.onb-tip') as HTMLElement;
  if (step.tip) {
    tipEl.textContent = `💡 ${step.tip}`;
    tipEl.hidden = false;
  } else {
    tipEl.hidden = true;
  }

  // Dots
  const dotsContainer = overlay.querySelector('.onb-dots') as HTMLElement;
  dotsContainer.innerHTML = '';
  for (let i = 0; i < total; i++) {
    const dot = document.createElement('button');
    dot.className = 'onb-dot' + (i === _currentStep ? ' active' : '');
    dot.setAttribute('role', 'tab');
    dot.setAttribute('aria-selected', String(i === _currentStep));
    dot.setAttribute('aria-label', `Adım ${i + 1}`);
    dot.dataset.step = String(i);
    dotsContainer.appendChild(dot);
  }

  // Buttons
  const prevBtn = overlay.querySelector('.onb-prev') as HTMLButtonElement;
  const nextBtn = overlay.querySelector('.onb-next') as HTMLButtonElement;
  prevBtn.hidden = _currentStep === 0;
  nextBtn.textContent = isLast
    ? t('finish', 'Başla')
    : t('continue', 'Devam');
}

// ── Event bağlama ─────────────────────────────────────────────────────────────

function bindEvents(overlay: HTMLElement): void {
  const dismiss = (): void => {
    overlay.remove();
    markDone();
  };

  overlay.querySelector('.onb-close')!.addEventListener('click', dismiss);
  overlay.querySelector('.onb-skip')!.addEventListener('click',  dismiss);

  overlay.querySelector('.onb-backdrop')!.addEventListener('click', dismiss);

  overlay.querySelector('.onb-prev')!.addEventListener('click', () => {
    if (_currentStep > 0) { _currentStep--; render(overlay); }
  });

  overlay.querySelector('.onb-next')!.addEventListener('click', () => {
    if (_currentStep < _steps.length - 1) {
      _currentStep++;
      render(overlay);
    } else {
      dismiss();
    }
  });

  overlay.querySelector('.onb-dots')!.addEventListener('click', (e) => {
    const dot = (e.target as HTMLElement).closest('.onb-dot') as HTMLElement | null;
    if (!dot) return;
    const step = parseInt(dot.dataset.step || '0', 10);
    if (!isNaN(step)) { _currentStep = step; render(overlay); }
  });

  // Keyboard navigation
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape')     { dismiss(); return; }
    if (e.key === 'ArrowRight') { if (_currentStep < _steps.length - 1) { _currentStep++; render(overlay); } }
    if (e.key === 'ArrowLeft')  { if (_currentStep > 0) { _currentStep--; render(overlay); } }
  });

  // Trap focus inside card
  overlay.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const focusable = Array.from(overlay.querySelectorAll<HTMLElement>(
      'button:not([hidden]):not([disabled]), [tabindex="0"]'
    ));
    if (!focusable.length) return;
    const first = focusable[0];
    const last  = focusable[focusable.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { last.focus(); e.preventDefault(); }
    } else {
      if (document.activeElement === last)  { first.focus(); e.preventDefault(); }
    }
  });
}

// ── Persistence ───────────────────────────────────────────────────────────────

function isDone(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) === STORAGE_VER; } catch { return false; }
}

function markDone(): void {
  try { localStorage.setItem(STORAGE_KEY, STORAGE_VER); } catch { /* */ }
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Yalnızca ilk girişte çalıştırılır. force=true ile her zaman gösterilir. */
export function maybeShowOnboarding(force = false): void {
  if (!force && isDone()) return;
  if (document.getElementById(OVERLAY_ID)) return;   // zaten açık

  _steps.length = 0;
  _steps.push(...getSteps());
  _currentStep = 0;

  injectStyles();
  const overlay = buildOverlay();
  document.body.appendChild(overlay);
  render(overlay);
  bindEvents(overlay);

  // Focus ilk etkileşilebilir elemente
  requestAnimationFrame(() => {
    (overlay.querySelector('.onb-next') as HTMLButtonElement | null)?.focus();
  });
}

/** Wizard'ı programatik olarak sıfırla (debug / test). */
export function resetOnboarding(): void {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* */ }
}

// BridgeRegistry'e kaydet
BridgeRegistry.register('onboardingWizard', { maybeShowOnboarding, resetOnboarding });
