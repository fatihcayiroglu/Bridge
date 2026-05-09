// client/js/core/onboarding-tour.js
// Ä°lk kullanÄ±cÄ± deneyimi: interaktif adÄ±m adÄ±m tur
// KiÅŸiselleÅŸtirilmiÅŸ, Bridge'e Ã¶zgÃ¼ onboarding

'use strict';

const BridgeTour = (() => {

  // â”€â”€ ADIMLAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const STEPS = [
    {
      id: 'welcome',
      target: null, // merkezi modal
      title: 'ğŸŒ‰ Bridge\'e HoÅŸ Geldin!',
      content: `
        <p style="margin-bottom:12px;">Bridge'in gÃ¼Ã§lÃ¼ Ã¶zelliklerine hoÅŸ geldin:</p>
        <ul class="tour-feature-list">
          <li>ğŸ”’ <strong>E2E Åifreleme</strong> â€” MesajlarÄ±n gerÃ§ekten gizli</li>
          <li>ğŸ¤– <strong>Native AI</strong> â€” Bot gerektirmez, yerleÅŸik gelir</li>
          <li>ğŸŒ <strong>Self-host</strong> â€” Veriler senin sunucunda</li>
          <li>ğŸ’¸ <strong>Tamamen Ã¼cretsiz</strong> â€” Nitro gerektirmez</li>
        </ul>`,
      button: 'BaÅŸlayalÄ±m â†’',
      position: 'center',
    },
    {
      id: 'server-list',
      target: '#server-list',
      title: 'ğŸ  Sunucu Listesi',
      content: `<p>Sol sÃ¼tunda sunucularÄ±nÄ± gÃ¶rÃ¼rsÃ¼n. <strong>SÄ±nÄ±rsÄ±z sunucu</strong> kurabilirsin, Ã¼cretli plan olmadan.</p>
        <p style="margin-top:8px;color:var(--accent);">ğŸ’¡ <em>ArtÄ± (+) butonuyla yeni sunucu oluÅŸtur veya mevcut birine katÄ±l.</em></p>`,
      button: 'Devam â†’',
      position: 'right',
    },
    {
      id: 'ai-feature',
      target: '[data-tip="ğŸ¤– AI Kanal Ã–zeti"]',
      title: 'ğŸ¤– YerleÅŸik AI',
      content: `<p>Bot kurmana gerek yok. Bridge'in AI'sÄ± doÄŸrudan entegre:</p>
        <ul class="tour-feature-list" style="margin-top:8px;">
          <li>ğŸ“ Kanal Ã¶zetleri</li>
          <li>ğŸŒ Mesaj Ã§evirisi (50+ dil)</li>
          <li>ğŸ” Semantic arama â€” "bu haftaki kararlar?" diyebilirsin</li>
          <li>ğŸ™ï¸ Ses transkripsiyonu</li>
        </ul>`,
      button: 'Harika â†’',
      position: 'bottom',
    },
    {
      id: 'e2e-encryption',
      target: '#btn-e2e',
      title: 'ğŸ”’ UÃ§tan Uca Åifreleme',
      content: `<p>DM'lerin ve kanallarÄ±n <strong>gerÃ§ekten Ã¶zel</strong> olabilir. E2EE aktifleÅŸtirince sadece sen ve karÅŸÄ± taraf okuyabilir â€” sunucu bile gÃ¶remez.</p>
        `,
      button: 'Devam â†’',
      position: 'top',
    },
    {
      id: 'search',
      target: '[data-tip="Search"]',
      title: 'ğŸ” AkÄ±llÄ± Arama',
      content: `<p>SÄ±radan kelime aramasÄ± deÄŸil â€” <strong>semantic arama</strong> ile ÅŸÃ¶yle sorular sorabilirsin:</p>
        <div class="tour-search-examples">
          <span>"geÃ§en haftaki toplantÄ± kararlarÄ±"</span>
          <span>"Ali'nin Ã¶nerdiÄŸi kitaplar"</span>
          <span>"proje deadline ne zamandÄ±?"</span>
        </div>`,
      button: 'Devam â†’',
      position: 'bottom',
    },
    {
      id: 'themes',
      target: '#btn-theme',
      title: 'ğŸ¨ Bridge TemalarÄ±',
      content: `<p>4 farklÄ± tema: <strong>Dark</strong>, <strong>Light</strong>, <strong>AMOLED</strong> ve Bridge'e Ã¶zgÃ¼ <strong>Aurora</strong> temasÄ±. TÃ¼mÃ¼ Ã¼cretsiz â€” Nitro gerektirmez.</p>
        <div class="tour-theme-preview">
          <div class="tour-theme-dot dark" title="Dark"></div>
          <div class="tour-theme-dot light" title="Light"></div>
          <div class="tour-theme-dot amoled" title="AMOLED"></div>
          <div class="tour-theme-dot aurora" title="Aurora"></div>
        </div>`,
      button: 'Devam â†’',
      position: 'top',
    },
    {
      id: 'finish',
      target: null,
      title: 'ğŸ‰ HazÄ±rsÄ±n!',
      content: `<p style="margin-bottom:16px;">Bridge'i keÅŸfetmeye baÅŸlayabilirsin. Ä°puÃ§larÄ±:</p>
        <ul class="tour-feature-list">
          <li>âŒ¨ï¸ <code>/</code> â€” Slash komutlarÄ±</li>
          <li>ğŸ“Œ Uzun bas veya saÄŸ tÄ±kla â€” Mesaj menÃ¼sÃ¼</li>
          <li>ğŸ”— Sunucu AyarlarÄ± â†’ Davet â€” QR veya link</li>
          <li>ğŸ¤– Sunucu AyarlarÄ± â†’ Bot Marketplace</li>
        </ul>
        <p style="margin-top:16px;font-size:12px;color:var(--text-muted);">Bu turu tekrar gÃ¶rmek iÃ§in: Ayarlar â†’ YardÄ±m â†’ Turu Yeniden BaÅŸlat</p>`,
      button: 'ğŸš€ BaÅŸlayalÄ±m!',
      position: 'center',
      isLast: true,
    },
  ];

  // â”€â”€ STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let currentStep = 0;
  let overlay = null;
  let spotlight = null;
  let card = null;
  let isActive = false;

  // â”€â”€ CSS ENJEKSÄ°YONU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function injectStyles() {
    if (document.getElementById('bridge-tour-styles')) return;
    const style = document.createElement('style');
    style.id = 'bridge-tour-styles';
    style.textContent = `
      /* â”€â”€ TOUR OVERLAY â”€â”€ */
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

      /* Spotlight: hedef elementi aydÄ±nlat */
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

      /* â”€â”€ TOUR CARD â”€â”€ */
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

      /* â”€â”€ FOOTER â”€â”€ */
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

  // â”€â”€ DOM OLUÅTUR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function buildDOM() {
    overlay = document.createElement('div');
    overlay.id = 'bridge-tour-overlay';

    const backdrop = document.createElement('div');
    backdrop.id = 'bridge-tour-backdrop';
    backdrop.addEventListener('click', () => {
      // BoÅŸ alana tÄ±kla â†’ sonraki adÄ±m (opsiyonel)
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

  // â”€â”€ SPOTLIGHT KONUMLANDIRMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

  // â”€â”€ CARD KONUMLANDIRMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function positionCard(step, targetEl) {
    const MARGIN = 16;
    const cardW = Math.min(380, window.innerWidth - 40);
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // Ã–nce kartÄ± render et (boyutunu almak iÃ§in)
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

    // Ekran sÄ±nÄ±rlarÄ±nÄ± aÅŸ
    left = Math.max(MARGIN, Math.min(left, vw - cardW - MARGIN));
    top  = Math.max(MARGIN, Math.min(top, vh - cardH - MARGIN));

    card.style.left = `${left + window.scrollX}px`;
    card.style.top  = `${top  + window.scrollY}px`;
  }

  // â”€â”€ KART Ä°Ã‡ERÄ°ÄÄ° RENDER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
        <button class="tour-card-close" id="tour-close-btn" aria-label="Turu kapat">âœ•</button>
      </div>
      <div class="tour-card-body">${step.content}</div>
      <div class="tour-card-footer">
        <div class="tour-progress">${dots}</div>
        <div style="display:flex;align-items:center;gap:8px;">
          ${!isLast ? `<button class="tour-btn-skip" id="tour-skip-btn">GeÃ§</button>` : ''}
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

    // Target'a kaydÄ±r
    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  // â”€â”€ KONTROLLER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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

    // TamamlandÄ± olarak kaydet
    try { localStorage.setItem('bridge_tour_done', '1'); } catch {}

    // Callback
    if (typeof window.onBridgeTourComplete === 'function') {
      window.onBridgeTourComplete();
    }
  }

  // â”€â”€ BAÅLAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function start({ force = false } = {}) {
    // Daha Ã¶nce tamamlandÄ±ysa gÃ¶sterme
    try {
      if (!force && localStorage.getItem('bridge_tour_done') === '1') return;
    } catch {}

    if (isActive) return;
    isActive = true;
    currentStep = 0;

    injectStyles();
    buildDOM();
    renderStep(0);

    // Resize'da yeniden konumlandÄ±r
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

  // â”€â”€ PUBLIC API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return { start, end, next, reset };

})();

// â”€â”€ OTOMATÄ°K BAÅLAT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Uygulama yÃ¼klendikten sonra yeni kullanÄ±cÄ±lar iÃ§in tur baÅŸlat
window.BridgeTour = BridgeTour;

// App tamamen hazÄ±r olunca baÅŸlat (app gÃ¶rÃ¼nÃ¼r olduÄŸunda)
const _tourObserver = new MutationObserver((mutations) => {
  for (const m of mutations) {
    if (m.type === 'attributes' && m.target.id === 'app') {
      const app = document.getElementById('app');
      if (app && app.style.display !== 'none') {
        _tourObserver.disconnect();
        // KÄ±sa delay â€” UI tam render olsun
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

console.log('[BridgeTour] Onboarding turu yÃ¼klendi âœ“');

