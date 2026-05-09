// client/js/core/semantic-search.js
// Semantic Arama UI — Bridge'in en güçlü arama özelliği
// "Bu haftaki proje kararları?" gibi doğal dil sorguları

'use strict';
import { getAPI, getCurrentChannel } from './globals.js';

const BridgeSemanticSearch = (() => {

  // ── ÖRNEK ÖNERİLER ───────────────────────────────────────
  const EXAMPLE_QUERIES = [
    { icon: '📋', text: 'Bu haftaki kararlar' },
    { icon: '🐛', text: 'Çözülen buglar' },
    { icon: '📅', text: 'Yaklaşan deadlineler' },
    { icon: '💡', text: 'Önerilen fikirler' },
    { icon: '🔗', text: 'Paylaşılan linkler' },
    { icon: '📊', text: 'Proje güncellemeleri' },
  ];

  // ── STATE ─────────────────────────────────────────────────
  let modal = null;
  let searchInput = null;
  let resultsEl = null;
  let currentMode = 'semantic'; // 'semantic' | 'keyword'
  let searchTimeout = null;
  let isOpen = false;

  // ── MODAL AÇ ─────────────────────────────────────────────
  function open() {
    if (isOpen) return;
    isOpen = true;

    modal = document.createElement('div');
    modal.id = 'bridge-search-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-label', 'Gelişmiş Arama');
    modal.setAttribute('aria-modal', 'true');

    modal.innerHTML = `
      <div id="bridge-search-panel">

        <!-- HEADER / INPUT -->
        <div id="bridge-search-header">
          <span class="bridge-search-icon">🔍</span>
          <input
            id="bridge-search-input"
            type="text"
            placeholder="Doğal dille ara: 'geçen haftaki proje kararları'..."
            autocomplete="off"
            spellcheck="false"
          >
          <div class="bridge-search-mode-toggle">
            <button class="bsm-btn active" id="bsm-semantic" title="AI destekli semantic arama">🤖 AI</button>
            <button class="bsm-btn" id="bsm-keyword" title="Klasik kelime araması">🔤 Kelime</button>
          </div>
        </div>

        <!-- ÖNERİLER -->
        <div id="bridge-search-suggestions">
          <div class="bss-label">✨ Örnek sorgular</div>
          <div class="bss-chips" id="bss-chips"></div>
        </div>

        <!-- SONUÇLAR -->
        <div id="bridge-search-results">
          <div class="bsr-empty">
            <div class="bsr-empty-icon">🔍</div>
            <div class="bsr-empty-title">Aramaya başla</div>
            <div class="bsr-empty-sub">
              AI semantic arama ile doğal dilde sorgula.<br>
              Bridge'e özel bir özellik 🎉
            </div>
          </div>
        </div>

        <!-- FOOTER -->
        <div id="bridge-search-footer">
          <div class="bsf-hints">
            <div class="bsf-hint"><span class="bsf-key">↑↓</span> <span>Gezin</span></div>
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

    // Chip'leri oluştur
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

    // Klavye kısayolları
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

  // ── MODE DEĞİŞTİR ────────────────────────────────────────
  function setMode(mode) {
    currentMode = mode;
    document.getElementById('bsm-semantic').classList.toggle('active', mode === 'semantic');
    document.getElementById('bsm-keyword').classList.toggle('active', mode === 'keyword');

    const badge = document.getElementById('bsf-ai-badge');
    if (badge) {
      badge.style.opacity = mode === 'semantic' ? '1' : '0.4';
      badge.title = mode === 'semantic' ? 'Semantic AI aktif' : 'Klasik kelime araması';
    }

    // Varsa mevcut aramayı yenile
    const q = searchInput?.value.trim();
    if (q) doSearch(q);
  }

  // ── ARAMA ────────────────────────────────────────────────
  async function doSearch(query) {
    if (!resultsEl) return;

    showLoading(query);

    // Gerçek API çağrısı
    try {
      const channelId = getCurrentChannel()?._id;
      const endpoint = currentMode === 'semantic'
        ? `/api/ai/search?q=${encodeURIComponent(query)}${channelId ? `&channel=${channelId}` : ''}`
        : `/api/messages/search?q=${encodeURIComponent(query)}${channelId ? `&channel=${channelId}` : ''}`;

      const token = localStorage.getItem('token');
      const API = getAPI() || '';
      const res = await fetch(`${API}${endpoint}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      // Sunucu AI olmadan keyword fallback döndürdüyse kullanıcıya bildir
      if (data.aiDisabled && currentMode === 'semantic') {
        showAiDisabledNotice();
      }

      const results = data.results || data.messages || [];
      renderResults(results, query);
    } catch {
      // API erişilemez — keyword moduna düş ve bildir
      if (currentMode === 'semantic') {
        showAiDisabledNotice();
      }
      resultsEl.innerHTML = `
        <div class="bsr-empty">
          <div class="bsr-empty-icon">⚠️</div>
          <div class="bsr-empty-title">Arama erişilemiyor</div>
          <div class="bsr-empty-sub">Sunucu bağlantısı kurulamadı. Lütfen tekrar dene.</div>
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
    notice.innerHTML = '⚠️ AI semantic arama aktif değil — anahtar kelime araması kullanılıyor. AI etkinleştirmek için <code>GROQ_API_KEY</code> veya başka bir sağlayıcı ekle.';
    if (resultsEl) resultsEl.insertAdjacentElement('beforebegin', notice);
  }

  // ── MOCK SONUÇLAR (API yokken demo) ──────────────────────
  function getMockResults(query) {
    const lq = query.toLowerCase();
    return [
      {
        id: '1',
        author: { username: 'ali_dev', displayName: 'Ali' },
        content: `${query} hakkında konuştuk, sonuçlara karar verdik.`,
        channel: { name: 'genel', _id: '1' },
        createdAt: new Date(Date.now() - 3600000).toISOString(),
        score: 0.94,
      },
      {
        id: '2',
        author: { username: 'zeynep', displayName: 'Zeynep' },
        content: `Bunla ilgili: ${query}. Takip edeceğiz.`,
        channel: { name: 'proje', _id: '2' },
        createdAt: new Date(Date.now() - 86400000).toISOString(),
        score: 0.87,
      },
    ];
  }

  // ── RENDER HELPERS ────────────────────────────────────────
  function showLoading(query) {
    if (!resultsEl) return;
    const modeText = currentMode === 'semantic' ? '🤖 AI semantic' : '🔤 Kelime';
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
        <div class="bsr-empty-icon">🔍</div>
        <div class="bsr-empty-title">Aramaya başla</div>
        <div class="bsr-empty-sub">
          AI semantic arama ile doğal dilde sorgula.<br>
          Bridge'e özel bir özellik 🎉
        </div>
      </div>
    `;
  }

  function renderResults(results, query) {
    if (!resultsEl) return;
    if (!results || results.length === 0) {
      resultsEl.innerHTML = `
        <div class="bsr-empty">
          <div class="bsr-empty-icon">😶</div>
          <div class="bsr-empty-title">Sonuç bulunamadı</div>
          <div class="bsr-empty-sub">Farklı bir sorgu dene veya arama modunu değiştir.</div>
        </div>
      `;
      return;
    }

    const modeLabel = currentMode === 'semantic' ? '🤖 AI Semantic Sonuçlar' : '🔤 Kelime Araması Sonuçları';

    resultsEl.innerHTML = `
      <div class="bsr-group-label">${modeLabel} — ${results.length} sonuç</div>
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
          ${score !== null ? `<span class="bsr-result-score">${score}% eşleşme</span>` : ''}
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

  // ── YARDIMCILAR ──────────────────────────────────────────
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
    if (diff < 60000) return 'Az önce';
    if (diff < 3600000) return `${Math.floor(diff / 60000)} dk önce`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} sa önce`;
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

  // ── FAB (Floating Action Button) ─────────────────────────
  function createFAB() {
    if (document.getElementById('bridge-search-fab')) return;

    const fab = document.createElement('button');
    fab.id = 'bridge-search-fab';
    fab.setAttribute('aria-label', 'Akıllı Arama');
    fab.setAttribute('title', 'AI Semantic Arama');
    fab.innerHTML = `
      🔍
      <span class="fab-tooltip">🤖 AI Arama</span>
    `;
    fab.addEventListener('click', open);
    document.body.appendChild(fab);
  }

  // ── GLOBAL SHORTCUT ───────────────────────────────────────
  document.addEventListener('keydown', (e) => {
    // Ctrl+K veya Cmd+K
    if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
      e.preventDefault();
      if (isOpen) close();
      else open();
    }
//     "/" kısayolu — input odakta değilse arama aç
    if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const tag = document.activeElement?.tagName?.toLowerCase();
      if (tag === 'input' || tag === 'textarea' || document.activeElement?.isContentEditable) return;
      e.preventDefault();
      if (!isOpen) open();
    }
  });

  // ── PUBLIC API ────────────────────────────────────────────
  return { open, close, createFAB };

})();

// App yüklenince FAB oluştur

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

console.log('[SemanticSearch] Gelişmiş arama yüklendi ✓ (Ctrl+K)');

export const getBridgeSemanticSearch = () => window.BridgeSemanticSearch;
