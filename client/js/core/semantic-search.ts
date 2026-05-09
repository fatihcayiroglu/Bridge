// client/js/core/semantic-search.js
// Semantic Arama UI â€” Bridge'in en gÃ¼Ã§lÃ¼ arama Ã¶zelliÄŸi
// "Bu haftaki proje kararlarÄ±?" gibi doÄŸal dil sorgularÄ±

'use strict';

const BridgeSemanticSearch = (() => {


  // â”€â”€ Ã–RNEK Ã–NERÄ°LER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  const EXAMPLE_QUERIES = [
    { icon: 'ğŸ“‹', text: 'Bu haftaki kararlar' },
    { icon: 'ğŸ›', text: 'Ã‡Ã¶zÃ¼len buglar' },
    { icon: 'ğŸ“…', text: 'YaklaÅŸan deadlineler' },
    { icon: 'ğŸ’¡', text: 'Ã–nerilen fikirler' },
    { icon: 'ğŸ”—', text: 'PaylaÅŸÄ±lan linkler' },
    { icon: 'ğŸ“Š', text: 'Proje gÃ¼ncellemeleri' },
  ];

  // â”€â”€ STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let modal = null;
  let searchInput = null;
  let resultsEl = null;
  let currentMode = 'semantic'; // 'semantic' | 'keyword'
  let searchTimeout = null;
  let isOpen = false;

  // â”€â”€ MODAL AÃ‡ â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function open() {
    if (isOpen) return;
    isOpen = true;


    modal = document.createElement('div');
    modal.id = 'bridge-search-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'GeliÅŸmiÅŸ Arama');
    modal.setAttribute('aria-modal', 'true');

    modal.innerHTML = `
      <div id="bridge-search-panel">

        <!-- HEADER / INPUT -->
        <div id="bridge-search-header">
          <span class="bridge-search-icon">ğŸ”</span>
          <input
            id="bridge-search-input"
            type="text"
            placeholder="DoÄŸal dille ara: 'geÃ§en haftaki proje kararlarÄ±'..."
            autocomplete="off"
            spellcheck="false"
          >
          <div class="bridge-search-mode-toggle">
            <button class="bsm-btn active" id="bsm-semantic" title="AI destekli semantic arama">ğŸ¤– AI</button>
            <button class="bsm-btn" id="bsm-keyword" title="Klasik kelime aramasÄ±">ğŸ”¤ Kelime</button>
          </div>
        </div>

        <!-- Ã–NERÄ°LER -->
        <div id="bridge-search-suggestions">
          <div class="bss-label">âœ¨ Ã–rnek sorgular</div>
          <div class="bss-chips" id="bss-chips"></div>
        </div>

        <!-- SONUÃ‡LAR -->
        <div id="bridge-search-results">
          <div class="bsr-empty">
            <div class="bsr-empty-icon">ğŸ”</div>
            <div class="bsr-empty-title">Aramaya baÅŸla</div>
            <div class="bsr-empty-sub">
              AI semantic arama ile doÄŸal dilde sorgula.<br>
              Bridge'e Ã¶zel bir Ã¶zellik ğŸ‰
            </div>
          </div>
        </div>

        <!-- FOOTER -->
        <div id="bridge-search-footer">
          <div class="bsf-hints">
            <div class="bsf-hint"><span class="bsf-key">â†‘â†“</span> <span>Gezin</span></div>
            <div class="bsf-hint"><span class="bsf-key">Enter</span> <span>Mesaja git</span></div>
            <div class="bsf-hint"><span class="bsf-key">Esc</span> <span>Kapat</span></div>
          </div>
          <div class="bsf-ai-badge" id="bsf-ai-badge">
            <div class="bsf-ai-dot"></div>
            Semantic AI Aktif
          </div>
        </div>

      </div>
    `;

    document.body.appendChild(modal);

    searchInput = document.getElementById('bridge-search-input');
    resultsEl   = document.getElementById('bridge-search-results');

    // Chip'leri oluÅŸtur
    const chipsEl = document.getElementById('bss-chips');
    EXAMPLE_QUERIES.forEach(q => {
      const chip = document.createElement('button');
      chip.className = 'bss-chip';
      chip.innerHTML = `<span class="chip-icon">${q.icon}</span>${q.text}`;
      chip.addEventListener('click', () => {
        searchInput.value = q.text;
        doSearch(q.text);
      });
      chipsEl.appendChild(chip);
    });

    // Mode toggle
    document.getElementById('bsm-semantic').addEventListener('click', () => setMode('semantic'));
    document.getElementById('bsm-keyword').addEventListener('click', () => setMode('keyword'));

    // Arama input
    searchInput.addEventListener('input', () => {
      clearTimeout(searchTimeout);
      const q = searchInput.value.trim();
      if (!q) {
        showEmpty();
        return;
      }
      searchTimeout = setTimeout(() => doSearch(q), 420);
    });

    // Klavye kÄ±sayollarÄ±
    searchInput.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'Enter') {
        clearTimeout(searchTimeout);
        const q = searchInput.value.trim();
        if (q) doSearch(q);
      }
      if (e.key === 'ArrowDown') navigateResults(1);
      if (e.key === 'ArrowUp')   navigateResults(-1);
    });

    // Backdrop kapat
    modal.addEventListener('click', (e) => {
      if (e.target === modal) close();
    });

    // Focus
    setTimeout(() => searchInput?.focus(), 50);

    // Global ESC
    document.addEventListener('keydown', onGlobalKey);
  }

  function onGlobalKey(e) {
    if (e.key === 'Escape' && isOpen) close();
  }

  function close() {
    if (!isOpen) return;
    isOpen = false;
    document.removeEventListener('keydown', onGlobalKey);
    if (modal) {
      modal.style.animation = 'searchFadeIn 0.15s ease reverse';
      setTimeout(() => modal?.remove(), 150);
      modal = null;
    }
  }

  // â”€â”€ MODE DEÄÄ°ÅTÄ°R â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function setMode(mode) {
    currentMode = mode;
    document.getElementById('bsm-semantic').classList.toggle('active', mode === 'semantic');
    document.getElementById('bsm-keyword').classList.toggle('active', mode === 'keyword');

    const badge = document.getElementById('bsf-ai-badge');
    if (badge) {
      badge.style.opacity = mode === 'semantic' ? '1' : '0.4';
      badge.title = mode === 'semantic' ? 'Semantic AI aktif' : 'Klasik kelime aramasÄ±';
    }

    // Varsa mevcut aramayÄ± yenile
    const q = searchInput?.value.trim();
    if (q) doSearch(q);
  }

  // â”€â”€ ARAMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function doSearch(query) {
    if (!resultsEl) return;

    showLoading(query);

    // GerÃ§ek API Ã§aÄŸrÄ±sÄ±
    try {
      const channelId = window.currentChannel?._id;
      const endpoint = currentMode === 'semantic'
        ? `/api/ai/search?q=${encodeURIComponent(query)}${channelId ? `&channel=${channelId}` : ''}`
        : `/api/messages/search?q=${encodeURIComponent(query)}${channelId ? `&channel=${channelId}` : ''}`;

      const token = localStorage.getItem('token');
      const API = window.API || '';
      const res = await fetch(`${API}${endpoint}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Sunucu AI olmadan keyword fallback dÃ¶ndÃ¼rdÃ¼yse kullanÄ±cÄ±ya bildir
      if (data.aiDisabled && currentMode === 'semantic') {
        showAiDisabledNotice();
      }

      const results = data.results || data.messages || [];
      renderResults(results, query);
    } catch {
      // API eriÅŸilemez â€” keyword moduna dÃ¼ÅŸ ve bildir
      if (currentMode === 'semantic') {
        showAiDisabledNotice();
      }
      resultsEl.innerHTML = `
        <div class="bsr-empty">
          <div class="bsr-empty-icon">âš ï¸</div>
          <div class="bsr-empty-title">Arama eriÅŸilemiyor</div>
          <div class="bsr-empty-sub">Sunucu baÄŸlantÄ±sÄ± kurulamadÄ±. LÃ¼tfen tekrar dene.</div>
        </div>
      `;
    }
  }

  function showAiDisabledNotice() {
    const existing = document.getElementById('bridge-ai-disabled-notice');
    if (existing) return;
    const notice = document.createElement('div');
    notice.id = 'bridge-ai-disabled-notice';
    notice.style.cssText = 'padding:6px 12px;background:var(--bg-secondary);border-left:3px solid var(--yellow,#faa61a);font-size:12px;color:var(--text-muted);margin:0 0 4px;';
    notice.innerHTML = 'âš ï¸ AI semantic arama aktif deÄŸil â€” anahtar kelime aramasÄ± kullanÄ±lÄ±yor. AI etkinleÅŸtirmek iÃ§in <code>GROQ_API_KEY</code> veya baÅŸka bir saÄŸlayÄ±cÄ± ekle.';
    if (resultsEl) resultsEl.insertAdjacentElement('beforebegin', notice);
  }

  // â”€â”€ MOCK SONUÃ‡LAR (API yokken demo) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function getMockResults(query) {
    const lq = query.toLowerCase();
    return [
      {
        id: '1',
        author: { username: 'ali_dev', displayName: 'Ali' },
        content: `${query} hakkÄ±nda konuÅŸtuk, sonuÃ§lara karar verdik.`,
        channel: { name: 'genel', _id: '1' },
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        score: 0.94,
      },
      {
        id: '2',
        author: { username: 'zeynep', displayName: 'Zeynep' },
        content: `Bunla ilgili: ${query}. Takip edeceÄŸiz.`,
        channel: { name: 'proje', _id: '2' },
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        score: 0.87,
      },
    ];
  }

  // â”€â”€ RENDER HELPERS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function showLoading(query) {
    if (!resultsEl) return;
    const modeText = currentMode === 'semantic' ? 'ğŸ¤– AI semantic' : 'ğŸ”¤ Kelime';
    resultsEl.innerHTML = `
      <div class="bsr-loading">
        <div class="bsr-spinner"></div>
        <span>${modeText} arama: "<strong>${escHtml(query)}</strong>"</span>
      </div>
    `;
  }

  function showEmpty() {
    if (!resultsEl) return;
    resultsEl.innerHTML = `
      <div class="bsr-empty">
        <div class="bsr-empty-icon">ğŸ”</div>
        <div class="bsr-empty-title">Aramaya baÅŸla</div>
        <div class="bsr-empty-sub">
          AI semantic arama ile doÄŸal dilde sorgula.<br>
          Bridge'e Ã¶zel bir Ã¶zellik ğŸ‰
        </div>
      </div>
    `;
  }

  function renderResults(results, query) {
    if (!resultsEl) return;
    if (!results || results.length === 0) {
      resultsEl.innerHTML = `
        <div class="bsr-empty">
          <div class="bsr-empty-icon">ğŸ˜¶</div>
          <div class="bsr-empty-title">SonuÃ§ bulunamadÄ±</div>
          <div class="bsr-empty-sub">FarklÄ± bir sorgu dene veya arama modunu deÄŸiÅŸtir.</div>
        </div>
      `;
      return;
    }

    const modeLabel = currentMode === 'semantic' ? 'ğŸ¤– AI Semantic SonuÃ§lar' : 'ğŸ”¤ Kelime AramasÄ± SonuÃ§larÄ±';

    resultsEl.innerHTML = `
      <div class="bsr-group-label">${modeLabel} â€” ${results.length} sonuÃ§</div>
    `;

    results.forEach(msg => {
      const div = document.createElement('div');
      div.className = 'bsr-result';
      div.setAttribute('tabindex', '0');
      div.setAttribute('role', 'option');

      const content = msg.content || '';
      const highlighted = highlightQuery(escHtml(content), query);
      const time = msg.createdAt ? formatTime(new Date(msg.createdAt)) : '';
      const channelName = msg.channel?.name || msg.channelName || '?';
      const author = msg.author?.displayName || msg.author?.username || msg.username || '?';
      const score = msg.score ? Math.round(msg.score * 100) : null;

      div.innerHTML = `
        <div class="bsr-result-meta">
          <span class="bsr-result-author">${escHtml(author)}</span>
          <span class="bsr-result-channel">#${escHtml(channelName)}</span>
          <span class="bsr-result-time">${time}</span>
          ${score !== null ? `<span class="bsr-result-score">${score}% eÅŸleÅŸme</span>` : ''}
        </div>
        <div class="bsr-result-content">${highlighted}</div>
      `;

      div.addEventListener('click', () => {
        // Mesaja git
        if (msg.channel?._id && typeof loadChannel === 'function') {
          loadChannel(msg.channel._id);
        }
        if (msg._id || msg.id) {
          setTimeout(() => {
            const el = document.getElementById(`msg-${msg._id || msg.id}`);
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'center' });
              el.style.background = 'var(--brand-bg)';
              setTimeout(() => { el.style.background = ''; }, 2000);
            }
          }, 300);
        }
        close();
      });

      resultsEl.appendChild(div);
    });
  }

  // â”€â”€ YARDIMCILAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function highlightQuery(content, query) {
    if (!query) return content;
    const words = query.split(/\s+/).filter(w => w.length > 2);
    let result = content;
    words.forEach(word => {
      const re = new RegExp(`(${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
      result = result.replace(re, '<mark>$1</mark>');
    });
    return result;
  }

  function formatTime(date) {
    if (isNaN(date)) return '';
    const now = new Date();
    const diff = now - date;
    if (diff < 60000) return 'Az Ã¶nce';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} dk Ã¶nce`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} sa Ã¶nce`;
    return date.toLocaleDateString('tr-TR');
  }

  function navigateResults(dir) {
    if (!resultsEl) return;
    const items = [...resultsEl.querySelectorAll('.bsr-result')];
    if (!items.length) return;
    const focused = document.activeElement;
    const idx = items.indexOf(focused);
    let next = idx + dir;
    if (next < 0) next = items.length - 1;
    if (next >= items.length) next = 0;
    items[next]?.focus();
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // â”€â”€ FAB (Floating Action Button) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function createFAB() {
    if (document.getElementById('bridge-search-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'bridge-search-fab';
    fab.setAttribute('aria-label', 'AkÄ±llÄ± Arama');
    fab.setAttribute('title', 'AI Semantic Arama');
    fab.innerHTML = `
      ğŸ”
      <span class="fab-tooltip">ğŸ¤– AI Arama</span>
    `;
    fab.addEventListener('click', open);
    document.body.appendChild(fab);
  }

  // â”€â”€ GLOBAL SHORTCUT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  document.addEventListener('keydown', (e) => {
    // Ctrl+K veya Cmd+K
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (isOpen) close();
      else open();
    }
//     "/" kÄ±sayolu â€” input odakta deÄŸilse arama aÃ§
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      if (!isOpen) open();
    }
  });

  // â”€â”€ PUBLIC API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  return { open, close, createFAB };

})();

// App yÃ¼klenince FAB oluÅŸtur
window.BridgeSemanticSearch = BridgeSemanticSearch;

document.addEventListener('DOMContentLoaded', () => {
  const app = document.getElementById('app');
  if (app) {
    const obs = new MutationObserver(() => {
      if (app.style.display !== 'none') {
        obs.disconnect();
        BridgeSemanticSearch.createFAB();
      }
    });
    obs.observe(app, { attributes: true, attributeFilter: ['style'] });
  }
});

console.log('[SemanticSearch] GeliÅŸmiÅŸ arama yÃ¼klendi âœ“ (Ctrl+K)');

