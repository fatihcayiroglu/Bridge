// client/js/core/onboarding-tour.js
// İlk kullanıcı deneyimi: interaktif adım adım tur
// Kişiselleştirilmiş, Bridge'e özgü onboarding

'use strict';

const BridgeTour = (() => {

  // ── ADIMLAR ──────────────────────────────────────────────
  const STEPS = [
    {
      id: 'welcome',
      target: null, // merkezi modal
      title: '🌉 Bridge\'e Hoş Geldin!',
      content: `
        <p style="margin-bottom:12px;">Bridge'in güçlü özelliklerine hoş geldin:</p>
        <ul class="tour-feature-list">
          <li>🔒 <strong>E2E Şifreleme</strong> — Mesajların gerçekten gizli</li>
          <li>🤖 <strong>Native AI</strong> — Bot gerektirmez, yerleşik gelir</li>
          <li>🌐 <strong>Self-host</strong> — Veriler senin sunucunda</li>
          <li>💸 <strong>Tamamen ücretsiz</strong> — Nitro gerektirmez</li>
        </ul>`,
      button: 'Başlayalım →',
      position: 'center',
    },
    {
      id: 'server-list',
      target: '#server-list',
      title: '🏠 Sunucu Listesi',
      content: `<p>Sol sütunda sunucularını görürsün. <strong>Sınırsız sunucu</strong> kurabilirsin, ücretli plan olmadan.</p>
        <p style="margin-top:8px;color:var(--accent);">💡 <em>Artı (+) butonuyla yeni sunucu oluştur veya mevcut birine katıl.</em></p>`,
      button: 'Devam →',
      position: 'right',
    },
    {
      id: 'ai-feature',
      target: '[data-tip="🤖 AI Kanal Özeti"]',
      title: '🤖 Yerleşik AI',
      content: `<p>Bot kurmana gerek yok. Bridge'in AI'sı doğrudan entegre:</p>
        <ul class="tour-feature-list" style="margin-top:8px;">
          <li>📝 Kanal özetleri</li>
          <li>🌍 Mesaj çevirisi (50+ dil)</li>
          <li>🔍 Semantic arama — "bu haftaki kararlar?" diyebilirsin</li>
          <li>🎙️ Ses transkripsiyonu</li>
        </ul>`,
      button: 'Harika →',
      position: 'bottom',
    },
    {
      id: 'e2e-encryption',
      target: '#btn-e2e',
      title: '🔒 Uçtan Uca Şifreleme',
      content: `<p>DM'lerin ve kanalların <strong>gerçekten özel</strong> olabilir. E2EE aktifleştirince sadece sen ve karşı taraf okuyabilir — sunucu bile göremez.</p>
        `,
      button: 'Devam →',
      position: 'top',
    },
    {
      id: 'search',
      target: '[data-tip="Search"]',
      title: '🔍 Akıllı Arama',
      content: `<p>Sıradan kelime araması değil — <strong>semantic arama</strong> ile şöyle sorular sorabilirsin:</p>
        <div class="tour-search-examples">
          <span>"geçen haftaki toplantı kararları"</span>
          <span>"Ali'nin önerdiği kitaplar"</span>
          <span>"proje deadline ne zamandı?"</span>
        </div>`,
      button: 'Devam →',
      position: 'bottom',
    },
    {
      id: 'themes',
      target: '#btn-theme',
      title: '🎨 Bridge Temaları',
      content: `<p>4 farklı tema: <strong>Dark</strong>, <strong>Light</strong>, <strong>AMOLED</strong> ve Bridge'e özgü <strong>Aurora</strong> teması. Tümü ücretsiz — Nitro gerektirmez.</p>
        <div class="tour-theme-preview">
          <div class="tour-theme-dot dark" title="Dark"></div>
          <div class="tour-theme-dot light" title="Light"></div>
          <div class="tour-theme-dot amoled" title="AMOLED"></div>
          <div class="tour-theme-dot aurora" title="Aurora"></div>
        </div>`,
      button: 'Devam →',
      position: 'top',
    },
    {
      id: 'finish',
      target: null,
      title: '🎉 Hazırsın!',
      content: `<p style="margin-bottom:16px;">Bridge'i keşfetmeye başlayabilirsin. İpuçları:</p>
        <ul class="tour-feature-list">
          <li>⌨️ <code>/</code> — Slash komutları</li>
          <li>📌 Uzun bas veya sağ tıkla — Mesaj menüsü</li>
          <li>🔗 Sunucu Ayarları → Davet — QR veya link</li>
          <li>🤖 Sunucu Ayarları → Bot Marketplace</li>
        </ul>
        <p style="margin-top:16px;font-size:12px;color:var(--text-muted);">Bu turu tekrar görmek için: Ayarlar → Yardım → Turu Yeniden Başlat</p>`,
      button: '🚀 Başlayalım!',
      position: 'center',
      isLast: true,
    },
  ];

  // ── STATE ─────────────────────────────────────────────────
  let currentStep = 0;
  let overlay = null;
  let spotlight = null;
  let card = null;
  let isActive = false;

  // ── CSS ENJEKSİYONU ───────────────────────────────────────
  function injectStyles() {
    if (document.getElementById('bridge-tour-styles')) return;
    const style = document.createElement('style');
    style.id = 'bridge-tour-styles';
    style.textContent = `
      /* ── TOUR OVERLAY ── */
      #bridge-tour-overlay {
        position: fixed; inset: 0;
        z-index: var(--z-onboard, 600);
        pointer-events: none;
      }

      #bridge-tour-backdrop {
        position: absolute; inset: 0;
        background: rgba(0,0,0,0.72);
        backdrop-filter: blur(2px);
        transition: opacity 0.3s;
      }

      /* Spotlight: hedef elementi aydınlat */
      #bridge-tour-spotlight {
        position: absolute;
        border-radius: var(--r-lg, 14px);
        box-shadow:
          0 0 0 4px var(--brand),
          0 0 0 9999px rgba(0,0,0,0.72);
        transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
        pointer-events: none;
        animation: tourSpotPulse 2s ease-in-out infinite;
      }
      @keyframes tourSpotPulse {
        0%, 100% { box-shadow: 0 0 0 4px var(--brand), 0 0 0 9999px rgba(0,0,0,0.72); }
        50% { box-shadow: 0 0 0 6px var(--brand), 0 0 0 9999px rgba(0,0,0,0.72), 0 0 24px var(--brand-glow); }
      }

      /* ── TOUR CARD ── */
      #bridge-tour-card {
        position: absolute;
        background: var(--bg-3, #232636);
        border: 1px solid var(--border-strong, rgba(255,255,255,0.14));
        border-radius: var(--r-xl, 20px);
        box-shadow: var(--shadow-xl, 0 16px 56px rgba(0,0,0,0.52));
        padding: 28px;
        width: min(380px, calc(100vw - 40px));
        pointer-events: all;
        animation: tourCardIn 0.32s cubic-bezier(0.34, 1.56, 0.64, 1);
        z-index: 2;
      }
      @keyframes tourCardIn {
        from { opacity: 0; transform: scale(0.88) translateY(16px); }
        to   { opacity: 1; transform: scale(1) translateY(0); }
      }

      .tour-card-header {
        display: flex;
        align-items: flex-start;
        justify-content: space-between;
        margin-bottom: 14px;
        gap: 12px;
      }

      .tour-card-title {
        font-size: 18px;
        font-weight: 700;
        color: var(--text-primary);
        line-height: 1.3;
        flex: 1;
      }

      .tour-card-close {
        background: none;
        border: none;
        color: var(--text-muted);
        cursor: pointer;
        font-size: 18px;
        padding: 0;
        line-height: 1;
        transition: color 0.15s;
        flex-shrink: 0;
      }
      .tour-card-close:hover { color: var(--text-primary); }

      .tour-card-body {
        color: var(--text-2, #b8bdd4);
        font-size: 14px;
        line-height: 1.65;
        margin-bottom: 20px;
      }

      .tour-card-body p { margin-bottom: 6px; }
      .tour-card-body strong { color: var(--text-primary); }
      .tour-card-body code {
        background: var(--bg-5);
        padding: 2px 6px;
        border-radius: 4px;
        font-family: var(--font-mono);
        font-size: 12px;
        color: var(--brand);
      }

      /* Feature list */
      .tour-feature-list {
        list-style: none;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 7px;
      }
      .tour-feature-list li {
        padding: 8px 12px;
        background: var(--bg-4);
        border-radius: var(--r-md);
        font-size: 13px;
        border-left: 3px solid var(--brand);
      }

      /* Search examples */
      .tour-search-examples {
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 10px;
      }
      .tour-search-examples span {
        padding: 7px 12px;
        background: var(--bg-4);
        border-radius: var(--r-md);
        font-size: 12px;
        font-style: italic;
        color: var(--accent);
        border: 1px solid var(--border);
      }

      /* Theme dots */
      .tour-theme-preview {
        display: flex;
        gap: 10px;
        margin-top: 12px;
      }
      .tour-theme-dot {
        width: 32px; height: 32px;
        border-radius: 50%;
        border: 3px solid var(--border-strong);
        cursor: default;
        transition: transform 0.15s;
      }
      .tour-theme-dot:hover { transform: scale(1.15); }
      .tour-theme-dot.dark   { background: #1c1f2e; }
      .tour-theme-dot.light  { background: #f0f2f9; border-color: #d0d4e8; }
      .tour-theme-dot.amoled { background: #000; }
      .tour-theme-dot.aurora { background: linear-gradient(135deg, #0a1a16, #2ecc9a40); }

      /* ── FOOTER ── */
      .tour-card-footer {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .tour-progress {
        display: flex;
        gap: 5px;
        align-items: center;
      }
      .tour-dot {
        width: 6px; height: 6px;
        border-radius: 50%;
        background: var(--bg-5);
        transition: all 0.2s;
      }
      .tour-dot.active {
        background: var(--brand);
        width: 18px;
        border-radius: 3px;
      }
      .tour-dot.done {
        background: var(--brand-subtle);
        border: 1px solid var(--brand);
      }

      .tour-btn-next {
        background: var(--brand);
        color: #fff;
        border: none;
        border-radius: var(--r-full);
        padding: 10px 22px;
        font-size: 14px;
        font-weight: 600;
        cursor: pointer;
        font-family: var(--font-sans);
        transition: background 0.15s, transform 0.1s;
        white-space: nowrap;
      }
      .tour-btn-next:hover { background: var(--brand-hover); }
      .tour-btn-next:active { transform: scale(0.97); }
      .tour-btn-next.last {
        background: linear-gradient(135deg, var(--brand), var(--accent));
        box-shadow: var(--shadow-brand);
      }

      .tour-btn-skip {
        background: none;
        border: none;
        color: var(--text-muted);
        font-size: 12px;
        cursor: pointer;
        font-family: var(--font-sans);
        padding: 4px 8px;
        border-radius: var(--r-sm);
        transition: color 0.15s, background 0.15s;
      }
      .tour-btn-skip:hover {
        color: var(--text-primary);
        background: var(--bg-4);
      }

      /* Arrow pointer */
      .tour-arrow {
        position: absolute;
        width: 12px; height: 12px;
        background: var(--bg-3);
        border: 1px solid var(--border-strong);
        transform: rotate(45deg);
        z-index: 1;
      }
      .tour-arrow.arrow-top    { top: -7px; }
      .tour-arrow.arrow-bottom { bottom: -7px; }
      .tour-arrow.arrow-left   { left: -7px; }
      .tour-arrow.arrow-right  { right: -7px; }

      /* Responsive */
      @media (max-width: 480px) {
        #bridge-tour-card {
          width: calc(100vw - 24px);
          padding: 20px;
          border-radius: var(--r-lg);
        }
      }
    `;
    document.head.appendChild(style);
  }

  // ── DOM OLUŞTUR ───────────────────────────────────────────
  function buildDOM() {
    overlay = document.createElement('div');
    overlay.id = 'bridge-tour-overlay';

    const backdrop = document.createElement('div');
    backdrop.id = 'bridge-tour-backdrop';
    backdrop.addEventListener('click', () => {
      // Boş alana tıkla → sonraki adım (opsiyonel)
    });

    spotlight = document.createElement('div');
    spotlight.id = 'bridge-tour-spotlight';

    card = document.createElement('div');
    card.id = 'bridge-tour-card';

    overlay.appendChild(backdrop);
    overlay.appendChild(spotlight);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  // ── SPOTLIGHT KONUMLANDIRMA ───────────────────────────────
  function positionSpotlight(targetEl) {
    if (!targetEl) {
      spotlight.style.display = 'none';
      return;
    }
    spotlight.style.display = 'block';
    const rect = targetEl.getBoundingClientRect();
    const padding = 8;
    spotlight.style.cssText = `
      display: block;
      left: ${rect.left - padding + window.scrollX}px;
      top:  ${rect.top  - padding + window.scrollY}px;
      width:  ${rect.width  + padding * 2}px;
      height: ${rect.height + padding * 2}px;
      border-radius: var(--r-lg, 14px);
      box-shadow: 0 0 0 4px var(--brand), 0 0 0 9999px rgba(0,0,0,0.72);
      transition: all 0.35s cubic-bezier(0.16, 1, 0.3, 1);
      pointer-events: none;
      animation: tourSpotPulse 2s ease-in-out infinite;
    `;
  }

  // ── CARD KONUMLANDIRMA ────────────────────────────────────
  function positionCard(step, targetEl) {
    const MARGIN = 16;
    const cardW = Math.min(380, window.innerWidth - 40);
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Önce kartı render et (boyutunu almak için)
    card.style.cssText = `width:${cardW}px;`;

    if (!targetEl || step.position === 'center') {
      // Merkezi konum
      card.style.left = `${(vw - cardW) / 2}px`;
      card.style.top  = `${(vh - 420) / 2}px`;
      return;
    }

    const rect = targetEl.getBoundingClientRect();
    const cardH = card.offsetHeight || 300;
    let left, top;
    const arrowEl = card.querySelector('.tour-arrow');
    if (arrowEl) arrowEl.remove();

    const pos = step.position;

    if (pos === 'right') {
      left = rect.right + MARGIN + 8;
      top  = rect.top + rect.height / 2 - cardH / 2;
    } else if (pos === 'left') {
      left = rect.left - cardW - MARGIN - 8;
      top  = rect.top + rect.height / 2 - cardH / 2;
    } else if (pos === 'bottom') {
      left = rect.left + rect.width / 2 - cardW / 2;
      top  = rect.bottom + MARGIN + 8;
    } else { // top
      left = rect.left + rect.width / 2 - cardW / 2;
      top  = rect.top - cardH - MARGIN - 8;
    }

    // Ekran sınırlarını aş
    left = Math.max(MARGIN, Math.min(left, vw - cardW - MARGIN));
    top  = Math.max(MARGIN, Math.min(top, vh - cardH - MARGIN));

    card.style.left = `${left + window.scrollX}px`;
    card.style.top  = `${top  + window.scrollY}px`;
  }

  // ── KART İÇERİĞİ RENDER ──────────────────────────────────
  function renderStep(index) {
    const step = STEPS[index];
    const targetEl = step.target ? document.querySelector(step.target) : null;
    const isLast = !!step.isLast;

    // Progress dots
    const dots = STEPS.map((_, i) => {
      let cls = 'tour-dot';
      if (i < index) cls += ' done';
      if (i === index) cls += ' active';
      return `<div class="${cls}"></div>`;
    }).join('');

    card.innerHTML = `
      <div class="tour-card-header">
        <div class="tour-card-title">${step.title}</div>
        <button class="tour-card-close" id="tour-close-btn" aria-label="Turu kapat">✕</button>
      </div>
      <div class="tour-card-body">${step.content}</div>
      <div class="tour-card-footer">
        <div class="tour-progress">${dots}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${!isLast ? `<button class="tour-btn-skip" id="tour-skip-btn">Geç</button>` : ''}
          <button class="tour-btn-next ${isLast ? 'last' : ''}" id="tour-next-btn">${step.button}</button>
        </div>
      </div>
    `;

    // Event listeners
    document.getElementById('tour-close-btn').addEventListener('click', end);
    const skipBtn = document.getElementById('tour-skip-btn');
    if (skipBtn) skipBtn.addEventListener('click', end);
    document.getElementById('tour-next-btn').addEventListener('click', () => {
      if (isLast) end();
      else next();
    });

    // Pozisyonla
    positionSpotlight(targetEl);
    positionCard(step, targetEl);

    // Target'a kaydır
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // ── KONTROLLER ────────────────────────────────────────────
  function next() {
    if (currentStep < STEPS.length - 1) {
      currentStep++;
      // Kart animasyonu
      card.style.animation = 'none';
      card.offsetHeight; // reflow
      card.style.animation = 'tourCardIn 0.28s cubic-bezier(0.34, 1.56, 0.64, 1)';
      renderStep(currentStep);
    }
  }

  function end() {
    if (!isActive) return;
    isActive = false;

    // Fade out
    if (overlay) {
      overlay.style.transition = 'opacity 0.25s';
      overlay.style.opacity = '0';
      setTimeout(() => overlay?.remove(), 260);
    }

    // Tamamlandı olarak kaydet
    try { localStorage.setItem('bridge_tour_done', '1'); } catch {}

    // Callback
    if (typeof window.onBridgeTourComplete === 'function') {
      window.onBridgeTourComplete();
    }
  }

  // ── BAŞLAT ────────────────────────────────────────────────
  function start({ force = false } = {}) {
    // Daha önce tamamlandıysa gösterme
    try {
      if (!force && localStorage.getItem('bridge_tour_done') === '1') return;
    } catch {}

    if (isActive) return;
    isActive = true;
    currentStep = 0;

    injectStyles();
    buildDOM();
    renderStep(0);

    // Resize'da yeniden konumlandır
    window.addEventListener('resize', onResize);
  }

  function onResize() {
    if (!isActive) return;
    const step = STEPS[currentStep];
    const targetEl = step.target ? document.querySelector(step.target) : null;
    positionSpotlight(targetEl);
    positionCard(step, targetEl);
  }

  function reset() {
    try { localStorage.removeItem('bridge_tour_done'); } catch {}
  }

  // ── PUBLIC API ────────────────────────────────────────────
  return { start, end, next, reset };

})();

// ── OTOMATİK BAŞLAT ───────────────────────────────────────
// Uygulama yüklendikten sonra yeni kullanıcılar için tur başlat
window.BridgeTour = BridgeTour;

// App tamamen hazır olunca başlat (app görünür olduğunda)
const _tourObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.target.id === 'app') {
      const app = document.getElementById('app');
      if (app && app.style.display !== 'none') {
        _tourObserver.disconnect();
        // Kısa delay — UI tam render olsun
        setTimeout(() => BridgeTour.start(), 800);
      }
    }
  }
});

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  if (app) {
    _tourObserver.observe(app, { attributes: true, attributeFilter: ['style'] });
  }
});

console.log('[BridgeTour] Onboarding turu yüklendi ✓');

export const getBridgeTour = () => window.BridgeTour;
