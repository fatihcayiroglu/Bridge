// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/MessagesPanel.svelte
//              client/js/core/messages-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/messages.ts
// Mesaj hover actions: emoji tepki, thread aç, düzenle, sil, pin
// Sprint 92: Thread butonu eklendi — openThread BridgeRegistry'den çağrılıyor

import { BridgeRegistry } from './bridge-registry.js';
import { escHtml, toast } from './utils.js';

(function () {

  // ── HOVER ACTION BAR ──────────────────────────────────────────
  // Her .msg-group ve .msg-continue'ya hover action bar inject eder.
  // CSS zaten `.msg-group:hover .msg-actions { opacity:1 }` kuralına sahip.

  function buildActionBar(msgEl: HTMLElement): HTMLDivElement {
    const msgId   = msgEl.dataset.msgId || msgEl.id?.replace('msg-', '');
    const content = msgEl.querySelector<HTMLElement>('.msg-text')?.innerText?.trim() || '';
    const isOwn   = msgEl.dataset.own === '1' ||
                    msgEl.dataset.userId === String((BridgeRegistry.call('getCurrentUserId') as unknown));

    const bar = document.createElement('div');
    bar.className = 'msg-actions';
    bar.setAttribute('role', 'toolbar');
    bar.setAttribute('aria-label', 'Mesaj işlemleri');

    // ── Emoji Tepki ──
    const btnReact = document.createElement('button');
    btnReact.className   = 'msg-action-btn';
    btnReact.title       = 'Tepki ekle';
    btnReact.textContent = '😊';
    btnReact.setAttribute('aria-label', 'Tepki ekle');
    btnReact.addEventListener('click', e => {
      e.stopPropagation();
      BridgeRegistry.call('openEmojiPicker', msgId, btnReact);
    });

    // ── Thread Aç (KRİTİK — bu eksikti) ──
    const btnThread = document.createElement('button');
    btnThread.className   = 'msg-action-btn thread-btn';
    btnThread.title       = 'Thread aç';
    btnThread.textContent = '🧵';
    btnThread.setAttribute('aria-label', 'Thread aç');
    btnThread.addEventListener('click', e => {
      e.stopPropagation();
      if (!msgId) return;
      const preview = content.slice(0, 80) || 'Thread';
      BridgeRegistry.call('openThread', msgId, preview);
    });

    // ── Düzenle (sadece kendi mesajı) ──
    const btnEdit = document.createElement('button');
    btnEdit.className   = 'msg-action-btn';
    btnEdit.title       = 'Düzenle';
    btnEdit.textContent = '✏️';
    btnEdit.setAttribute('aria-label', 'Düzenle');
    btnEdit.style.display = isOwn ? '' : 'none';
    btnEdit.addEventListener('click', e => {
      e.stopPropagation();
      BridgeRegistry.call('startEditMessage', msgId);
    });

    // ── Sil (kendi mesajı veya mod) ──
    const isMod = (BridgeRegistry.call('getMe') as { role?: string } | null)?.role === 'admin' ||
                  ((BridgeRegistry.call('getCurrentMember') as { permissions?: number } | null)?.permissions ?? 0) > 0;
    const btnDel = document.createElement('button');
    btnDel.className   = 'msg-action-btn delete';
    btnDel.title       = 'Sil';
    btnDel.textContent = '🗑️';
    btnDel.setAttribute('aria-label', 'Mesajı sil');
    btnDel.style.display = (isOwn || isMod) ? '' : 'none';
    btnDel.addEventListener('click', e => {
      e.stopPropagation();
      BridgeRegistry.call('deleteMessage', msgId);
    });

    bar.appendChild(btnReact);
    bar.appendChild(btnThread);
    bar.appendChild(btnEdit);
    bar.appendChild(btnDel);

    return bar;
  }

  // ── INJECT ACTION BARS ────────────────────────────────────────
  // MutationObserver ile dinamik mesajları da yakala

  function injectActionBar(msgEl: HTMLElement): void {
    if (msgEl.querySelector('.msg-actions')) return; // zaten var
    const msgId = msgEl.dataset.msgId || msgEl.id?.replace('msg-', '');
    if (!msgId) return;
    msgEl.style.position = 'relative';
    msgEl.appendChild(buildActionBar(msgEl));
  }

  function injectAll(): void {
    document.querySelectorAll<HTMLElement>('.msg-group, .msg-continue').forEach(injectActionBar);
  }

  // DOM hazır olduğunda tara
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', injectAll);
  } else {
    injectAll();
  }

  // Yeni mesajlar için gözlemci
  const _observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.classList.contains('msg-group') || node.classList.contains('msg-continue')) {
          injectActionBar(node);
        }
        // İçindeki msg-group'ları da tara (batch append durumu)
        node.querySelectorAll<HTMLElement>('.msg-group, .msg-continue').forEach(injectActionBar);
      }
    }
  });

  const area = document.getElementById('messages-area') || document.getElementById('chat-messages');
  if (area) {
    _observer.observe(area, { childList: true, subtree: true });
  } else {
    // Area henüz yok — bridge:channel-loaded'u bekle
    document.addEventListener('bridge:channel-loaded', () => {
      const a = document.getElementById('messages-area') || document.getElementById('chat-messages');
      if (a) _observer.observe(a, { childList: true, subtree: true });
      injectAll();
    });
  }

  // Kanal değişiminde yeniden tara
  document.addEventListener('bridge:channel-loaded', injectAll);

  BridgeRegistry.register('reinjectMessageActions', injectAll);

})();
