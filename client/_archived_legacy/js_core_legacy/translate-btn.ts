// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/TranslateBtnPanel.svelte
//              client/js/core/translate-btn-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/translate-btn.ts
// Mesaj Çeviri Butonu — sessionStorage cache + BridgeRegistry message menu patch

import { BridgeRegistry } from './bridge-registry.js';
import { escHtml } from './utils.js';

(function () {
  const api         = BridgeRegistry.get('BridgeAPI') ?? BridgeRegistry.get('api');
  const TARGET_LANG = () => navigator.language?.split('-')[0] ?? 'tr';

  // ── Cache helpers (sessionStorage) ────────────────────────────────────────

  const CACHE_PREFIX = 'bridge:translate:';

  interface CacheEntry { text: string; lang: string; provider: string; }

  function cacheGet(msgId: string, lang: string): CacheEntry | null {
    try {
      const raw = sessionStorage.getItem(`${CACHE_PREFIX}${msgId}:${lang}`);
      return raw ? JSON.parse(raw) as CacheEntry : null;
    } catch { return null; }
  }

  function cacheSet(msgId: string, lang: string, entry: CacheEntry): void {
    const key = `${CACHE_PREFIX}${msgId}:${lang}`;
    const val = JSON.stringify(entry);
    try {
      sessionStorage.setItem(key, val);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        _pruneCache();
        try { sessionStorage.setItem(key, val); } catch {}
      }
    }
  }

  function _pruneCache(): void {
    const toDelete: string[] = [];
    for (let i = 0; i < sessionStorage.length; i++) {
      const k = sessionStorage.key(i);
      if (k?.startsWith(CACHE_PREFIX)) toDelete.push(k);
    }
    toDelete.forEach(k => sessionStorage.removeItem(k));
  }

  // ── Button ────────────────────────────────────────────────────────────────

  function addTranslateButton(
    msgMenuEl: HTMLElement,
    msgId: string,
    content: string,
    targetEl: HTMLElement
  ): void {
    if (msgMenuEl.querySelector('.btn-translate')) return;

    const btn = document.createElement('button');
    btn.className   = 'msg-action-btn btn-translate';
    btn.dataset.id  = msgId;
    btn.textContent = '🌐 Çevir';
    btn.title       = 'Mesajı çevir';

    btn.addEventListener('click', async (e: MouseEvent) => {
      e.stopPropagation();

      const existingEl = targetEl.querySelector('.translated-text');
      if (existingEl) { existingEl.remove(); btn.textContent = '🌐 Çevir'; return; }

      const lang = TARGET_LANG();
      const hit  = cacheGet(msgId, lang);
      if (hit) { showTranslation(targetEl, hit); btn.textContent = '🌐 Gizle'; return; }

      btn.textContent = '⏳ Çevriliyor…';
      btn.disabled    = true;

      try {
        const res   = await (api as { post(url: string, body: unknown): Promise<Response> }).post('/api/ai/translate', { text: content, targetLang: lang });
        const entry: CacheEntry = {
          text:     res.translated ?? res.text ?? '?',
          lang,
          provider: res.provider ?? '',
        };
        cacheSet(msgId, lang, entry);
        showTranslation(targetEl, entry);
        btn.textContent = '🌐 Gizle';
      } catch (err: unknown) {
        btn.textContent = '🌐 Çevir';
        showError(targetEl, err.message ?? 'Çeviri başarısız');
      } finally {
        btn.disabled = false;
      }
    });

    msgMenuEl.appendChild(btn);
  }

  // ── Render helpers ────────────────────────────────────────────────────────

  function showTranslation(targetEl: HTMLElement, { text, lang, provider }: CacheEntry): void {
    const el = document.createElement('div');
    el.className = 'translated-text';
    el.innerHTML = `<span class="translated-label">🌐 ${lang?.toUpperCase() ?? 'TR'}</span>${escHtml(text)}`;
    if (provider) el.title = `Çeviri: ${provider}`;
    targetEl.appendChild(el);
  }

  function showError(targetEl: HTMLElement, msg: string): void {
    const el = document.createElement('div');
    el.className   = 'translated-text translated-error';
    el.textContent = '⚠️ ' + msg;
    targetEl.appendChild(el);
    setTimeout(() => el.remove(), 4000);
  }

   as Record<string, string>)[c]!
    );
  }

  // ── Auto-hook: patch renderMessageMenu ────────────────────────────────────

  function patchMessageMenu(): void {
    const orig: Function | undefined = BridgeRegistry.get('renderMessageMenu');
    if (!orig) return;
    BridgeRegistry.register('renderMessageMenu', function (msgEl: HTMLElement, msg: Record<string,unknown>) {
      orig.call(this, msgEl, msg);
      const menu =
        msgEl.querySelector<HTMLElement>('.msg-actions') ??
        msgEl.querySelector<HTMLElement>('.msg-menu');
      if (menu && msg.content) {
        addTranslateButton(menu, msg._id ?? msg.id, msg.content, msgEl);
      }
    });
  }

  BridgeRegistry.register('TranslateBtn', { addTranslateButton, patchMessageMenu, _pruneCache } as unknown);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', patchMessageMenu);
  } else {
    patchMessageMenu();
  }
})();

export const getTranslateBtn = () => BridgeRegistry.get('TranslateBtn');
