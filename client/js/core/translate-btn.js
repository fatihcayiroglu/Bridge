// client/js/core/translate-btn.js
// Mesaj Çeviri Butonu — her mesajın "..." menüsüne eklenir
// Backend: POST /api/ai/translate (zaten mevcut)
//
// Cache değişikliği (Session 9):
//   Eski : const CACHE = new Map()  → sayfa yenilemede sıfırlanıyor
//   Yeni : sessionStorage tabanlı, key = "translate:<msgId>:<lang>"
//          Aynı oturumda aynı mesaj + dil isteği ağa gitmiyor.
//          Tab/sekme kapatılınca temizlenir (sessionStorage garantisi).
//          localStorage değil — çeviri içerikleri biriken veriye dönüşmemeli.

'use strict';

(function () {
  const api         = window.BridgeAPI || window.api;
  const TARGET_LANG = () => navigator.language?.split('-')[0] || 'tr';

  // ── Cache yardımcıları ─────────────────────────────────────
  const CACHE_PREFIX = 'bridge:translate:';

  /**
   * sessionStorage'dan çeviri kaydını okur.
   * @returns {{ text: string, lang: string, provider: string } | null}
   */
  function cacheGet(msgId, lang) {
    try {
      const raw = sessionStorage.getItem(`${CACHE_PREFIX}${msgId}:${lang}`);
      return raw ? JSON.parse(raw) : null;
    } catch {
      // sessionStorage erişimi kısıtlıysa (örn. private mode izni reddedildi) sessizce geç
      return null;
    }
  }

  /**
   * Çeviri kaydını sessionStorage'a yazar.
   * Depolama doluysa (QuotaExceededError) eski kayıtları temizleyip tekrar dener.
   */
  function cacheSet(msgId, lang, entry) {
    const key = `${CACHE_PREFIX}${msgId}:${lang}`;
    const val = JSON.stringify(entry);
    try {
      sessionStorage.setItem(key, val);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        _pruneCache();
        try { sessionStorage.setItem(key, val); } catch { /* kapasitesi gerçekten dolmuş, sessiz geç */ }
      }
    }
  }

  /** Tüm bridge:translate: önekli kayıtları siler (kota dolunca çağrılır). */
  function _pruneCache() {
    const toDelete = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k && k.startsWith(CACHE_PREFIX)) toDelete.push(k);
    }
    toDelete.forEach(k => sessionStorage.removeItem(k));
  }

  // ── Buton ekleme ───────────────────────────────────────────

  /**
   * Mesaj context menu'ye çeviri butonu ekle.
   * @param {HTMLElement} msgMenuEl  Mesajın "..." buton menüsü
   * @param {string}      msgId      Mesaj ID'si (cache anahtarı)
   * @param {string}      content    Orijinal mesaj metni
   * @param {HTMLElement} targetEl   Çeviriyi göstereceğimiz element
   */
  function addTranslateButton(msgMenuEl, msgId, content, targetEl) {
    if (msgMenuEl.querySelector('.btn-translate')) return;

    const btn = document.createElement('button');
    btn.className   = 'msg-action-btn btn-translate';
    btn.dataset.id  = msgId;
    btn.textContent = '🌐 Çevir';
    btn.title       = 'Mesajı çevir';

    btn.addEventListener('click', async (e) => {
      e.stopPropagation();

      // Toggle — zaten çevirilmişse geri al
      const existingEl = targetEl.querySelector('.translated-text');
      if (existingEl) {
        existingEl.remove();
        btn.textContent = '🌐 Çevir';
        return;
      }

      const lang  = TARGET_LANG();
      const hit   = cacheGet(msgId, lang);

      // sessionStorage cache hit — ağa gitme
      if (hit) {
        showTranslation(targetEl, hit);
        btn.textContent = '🌐 Gizle';
        return;
      }

      btn.textContent = '⏳ Çevriliyor…';
      btn.disabled    = true;

      try {
        const res     = await api.post('/api/ai/translate', { text: content, targetLang: lang });
        const entry   = {
          text:     res.translated || res.text || '?',
          lang,
          provider: res.provider || '',
        };
        cacheSet(msgId, lang, entry);
        showTranslation(targetEl, entry);
        btn.textContent = '🌐 Gizle';
      } catch (err) {
        btn.textContent = '🌐 Çevir';
        showError(targetEl, err.message || 'Çeviri başarısız');
      } finally {
        btn.disabled = false;
      }
    });

    msgMenuEl.appendChild(btn);
  }

  // ── Render yardımcıları ────────────────────────────────────

  function showTranslation(targetEl, { text, lang, provider }) {
    const el = document.createElement('div');
    el.className = 'translated-text';
    el.innerHTML = `<span class="translated-label">🌐 ${lang?.toUpperCase() || 'TR'}</span>${escHtml(text)}`;
    if (provider) el.title = `Çeviri: ${provider}`;
    targetEl.appendChild(el);
  }

  function showError(targetEl, msg) {
    const el = document.createElement('div');
    el.className = 'translated-text translated-error';
    el.textContent = '⚠️ ' + msg;
    targetEl.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // ── Auto-hook ──────────────────────────────────────────────
  // messages.js renderMessageMenu fonksiyonunu patch eder

  function patchMessageMenu() {
    const orig = window.renderMessageMenu;
    if (!orig) return;
    window.renderMessageMenu = function (msgEl, msg) {
      orig.call(this, msgEl, msg);
      const menu = msgEl.querySelector('.msg-actions') || msgEl.querySelector('.msg-menu');
      if (menu && msg.content) {
        addTranslateButton(menu, msg._id || msg.id, msg.content, msgEl);
      }
    };
  }

  // ── Public API ────────────────────────────────────────────
  // _pruneCache test ortamında doğrudan çağrılabilir
  window.TranslateBtn = { addTranslateButton, patchMessageMenu, _pruneCache };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchMessageMenu);
  } else {
    patchMessageMenu();
  }
})();

export const getTranslateBtn = () => window.TranslateBtn;
