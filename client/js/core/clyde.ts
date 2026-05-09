// client/js/core/clyde.js
// Clyde AI AsistanÄ± â€” Bridge'in yapay zeka asistanÄ±
// @Clyde ile Ã§aÄŸrÄ±lÄ±r, SSE streaming ile yanÄ±t verir
//
// Ã–zellikler:
//  â€¢ @Clyde mention algÄ±lama (mesaj gÃ¶nderim Ã¶ncesi intercept)
//  â€¢ Kanal baÄŸlamÄ± ile sorgu gÃ¶nderimi
//  â€¢ Token-by-token streaming yanÄ±t (SSE)
//  â€¢ Sohbet geÃ§miÅŸi desteÄŸi (multi-turn)
//  â€¢ YazÄ±yor... animasyonu
//  â€¢ Hata yÃ¶netimi + AI kapalÄ±ysa bilgilendirme
//  â€¢ Sistem mesajÄ± olarak Ã¶zel gÃ¶rÃ¼nÃ¼m (Clyde baloncuÄŸu)
//  â€¢ Kanal bazlÄ± geÃ§miÅŸ temizleme

'use strict';

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   CLYDE CORE
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */
class BridgeClyde {
  // ── Property declarations ──────────────────────────────────────────────
  enabled:      boolean;
  typing:       boolean;
  _history:     Map<string, Array<{ role: string; content: string }>>;
  _maxHistory:  number;
  _abortCtrl:   AbortController | null;

  constructor() {
    this.enabled      = true;
    this.typing       = false;
    this._history     = new Map(); // channelId â†’ [{role, content}]
    this._maxHistory  = 10;        // kanal baÅŸÄ±na kaÃ§ tur saklanÄ±r
    this._abortCtrl   = null;

    this._injectStyles();
    this._patchMessageSend();
    console.log('[Clyde] AI AsistanÄ± hazÄ±r âœ“ â€” @Clyde ile Ã§aÄŸÄ±rÄ±n');
  }

  /* â”€â”€ @Clyde MENTION ALGILAMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  _patchMessageSend() {
    // Bridge mesaj gÃ¶nderimi socket.emit('message:send') ile yapÄ±lÄ±r
    // Ä°nterceptor: mesaj @Clyde iÃ§eriyorsa Ã¶nce Clyde'a ilet
    const originalSend = window.sendMessage?.bind(window);
    if (originalSend) {
      window.sendMessage = (content, opts) => this._interceptSend(content, opts, originalSend);
    }

    // Alternatif: input formu submit hook
    document.addEventListener('bridge:message-send', (e) => {
      if (e.detail?.content) {
        const { content, channelId } = e.detail;
        if (this._isClydeCall(content)) {
          e.preventDefault();
          const query = this._extractQuery(content);
          this.ask(query, channelId);
        }
      }
    });

    // msg-send-btn veya Enter keydown intercept
    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const input = document.getElementById('msg-input');
      if (!input || document.activeElement !== input) return;
      const content = input.value.trim();
      if (!this._isClydeCall(content)) return;
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      input.style.height = '';
      const query = this._extractQuery(content);
      this.ask(query, window.currentChannel?._id);
    }, true); // capture phase â€” normal gÃ¶nderimden Ã¶nce yakala
  }

  _interceptSend(content, opts, originalSend) {
    if (!this.enabled || !this._isClydeCall(content)) {
      return originalSend(content, opts);
    }
    const query = this._extractQuery(content);
    this.ask(query, window.currentChannel?._id);
  }

  _isClydeCall(content) {
    return /^@[Cc]lyde\b/i.test(content.trim());
  }

  _extractQuery(content) {
    return content.replace(/^@[Cc]lyde\s*/i, '').trim();
  }

  /* â”€â”€ ANA SORGULAMA FONKSÄ°YONU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  async ask(query, channelId) {
    if (!query) {
      this._showClydeMessage(
        channelId,
        'Merhaba! ğŸ‘‹ Ben Clyde. Bana bir ÅŸey sormak iÃ§in `@Clyde [sorunuz]` yazabilirsiniz.',
        { isIntro: true }
      );
      return;
    }

    // Ã–nceki isteÄŸi iptal et
    this._abortCtrl?.abort();
    this._abortCtrl = new AbortController();

    // KonuÅŸma geÃ§miÅŸine kullanÄ±cÄ± mesajÄ±nÄ± ekle
    this._addToHistory(channelId, 'user', query);

    // Typing gÃ¶ster
    const typingId = this._showTyping(channelId);

    // YanÄ±t baloncuÄŸu oluÅŸtur (streaming iÃ§in hazÄ±r)
    const { el: msgEl, contentEl } = this._createClydeMessage(channelId);
    let fullText = '';

    try {
      const url = new URL(`${window.API || ''}/api/ai/clyde/stream`);
      url.searchParams.set('q', query);
      if (channelId) url.searchParams.set('channelId', channelId);

      // KonuÅŸma geÃ§miÅŸini gÃ¶nder
      const history = this._getHistory(channelId);
      if (history.length) url.searchParams.set('history', JSON.stringify(history.slice(-this._maxHistory)));

      const token = localStorage.getItem('bridge-token') || window._authToken || '';

      const resp = await fetch(url.toString(), {
        headers: { 'Authorization': `Bearer ${token}` },
        signal: this._abortCtrl.signal,
      });

      this._removeTyping(typingId);

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}));
        if (resp.status === 503) {
          this._setMessageContent(contentEl, `âš ï¸ AI Ã¶zelliÄŸi aktif deÄŸil. \`.env\` dosyasÄ±na \`GROQ_API_KEY\` veya \`GEMINI_API_KEY\` ekleyin.`);
        } else {
          this._setMessageContent(contentEl, `âŒ Hata: ${data.error || 'Bilinmeyen hata'}`);
        }
        msgEl.classList.add('clyde-msg--error');
        return;
      }

      // SSE streaming oku
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (raw === '') continue;
          try {
            const event = JSON.parse(raw);
            if (event.token) {
              fullText += event.token;
              this._setMessageContent(contentEl, fullText, true);
            } else if (event.done) {
              this._setMessageContent(contentEl, fullText, false);
              this._addToHistory(channelId, 'assistant', fullText);
              msgEl.classList.add('clyde-msg--complete');
              break;
            } else if (event.error) {
              this._setMessageContent(contentEl, `âŒ ${event.error}`);
              msgEl.classList.add('clyde-msg--error');
            }
          } catch {
            // parse hatasÄ± â€” devam et
          }
        }
      }

      if (!fullText) {
        this._setMessageContent(contentEl, '(YanÄ±t boÅŸ geldi)');
      }
    } catch (err) {
      this._removeTyping(typingId);
      if (err.name === 'AbortError') {
        msgEl.remove();
        return;
      }
      this._setMessageContent(contentEl, `âŒ BaÄŸlantÄ± hatasÄ±: ${err.message}`);
      msgEl.classList.add('clyde-msg--error');
    }
  }

  /* â”€â”€ KONUÅMA GEÃ‡MÄ°ÅÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  _addToHistory(channelId, role, content) {
    const key = channelId || '_dm';
    if (!this._history.has(key)) this._history.set(key, []);
    const hist = this._history.get(key);
    hist.push({ role, content });
    // SÄ±nÄ±rÄ± aÅŸ â†’ en eskiyi sil (Ã§ift â€” user+assistant)
    while (hist.length > this._maxHistory * 2) hist.splice(0, 2);
  }

  _getHistory(channelId) {
    return this._history.get(channelId || '_dm') || [];
  }

  clearHistory(channelId) {
    this._history.delete(channelId || '_dm');
    if (typeof toast === 'function') toast('ğŸ¤– Clyde sohbet geÃ§miÅŸi temizlendi', 'info');
  }

  /* â”€â”€ UI YARDIMCILARI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  _showTyping(channelId) {
    const id = `clyde-typing-${Date.now()}`;
    const container = this._getMessageContainer();
    if (!container) return id;

    const el = document.createElement('div');
    el.id = id;
    el.className = 'clyde-typing-indicator';
    el.innerHTML = `
      <div class="clyde-avatar" aria-hidden="true">
        <span class="clyde-avatar-icon">ğŸ¤–</span>
      </div>
      <div class="clyde-typing-dots" aria-label="Clyde yazÄ±yor...">
        <span></span><span></span><span></span>
      </div>`;
    container.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return id;
  }

  _removeTyping(id) {
    document.getElementById(id)?.remove();
  }

  _createClydeMessage(channelId) {
    const container = this._getMessageContainer();
    const el = document.createElement('div');
    el.className = 'clyde-msg';
    el.setAttribute('role', 'article');
    el.setAttribute('aria-label', 'Clyde yanÄ±tÄ±');

    const now = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

    el.innerHTML = `
      <div class="clyde-msg__avatar" aria-hidden="true">
        <span class="clyde-avatar-icon">ğŸ¤–</span>
      </div>
      <div class="clyde-msg__body">
        <div class="clyde-msg__header">
          <span class="clyde-msg__name">Clyde</span>
          <span class="clyde-msg__badge">AI</span>
          <span class="clyde-msg__time">${now}</span>
        </div>
        <div class="clyde-msg__content" aria-live="polite"></div>
        <div class="clyde-msg__actions">
          <button class="clyde-action-btn" data-tooltip="GeÃ§miÅŸi temizle" onclick="window.BridgeClyde?.clearHistory('${channelId || ''}')">
            ğŸ—‘ï¸ GeÃ§miÅŸi Temizle
          </button>
          <button class="clyde-action-btn" data-tooltip="YanÄ±tÄ± kopyala" onclick="window.BridgeClyde?._copyLastResponse(this)">
            ğŸ“‹ Kopyala
          </button>
        </div>
      </div>`;

    if (container) {
      container.appendChild(el);
      setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);
    }

    const contentEl = el.querySelector('.clyde-msg__content');
    return { el, contentEl };
  }

  _setMessageContent(contentEl, text, streaming = false) {
    // Basit markdown-lite: **bold**, `code`, newline â†’ <br>
    const html = this._renderMarkdownLite(text, streaming);
    contentEl.innerHTML = html;
    if (streaming) {
      // ImleÃ§ gÃ¶ster
      if (!contentEl.querySelector('.clyde-cursor')) {
        const cursor = document.createElement('span');
        cursor.className = 'clyde-cursor';
        cursor.setAttribute('aria-hidden', 'true');
        contentEl.appendChild(cursor);
      }
    } else {
      contentEl.querySelector('.clyde-cursor')?.remove();
    }
    contentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  _renderMarkdownLite(text, streaming = false) {
    if (!text) return '';
    let s = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Kod bloklarÄ± (```...```) â€” Ã§ok satÄ±rlÄ±
    s = s.replace(/```([\s\S]*?)```/g, (_, code) =>
      `<pre class="clyde-code-block"><code>${code.trim()}</code></pre>`);

    // SatÄ±r iÃ§i kod `...`
    s = s.replace(/`([^`]+)`/g, '<code class="clyde-code-inline">$1</code>');

    // **bold**
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // *italic*
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Yeni satÄ±r â†’ <br> (kod bloÄŸu dÄ±ÅŸÄ±nda)
    s = s.replace(/\n/g, '<br>');

    return s;
  }

  _showClydeMessage(channelId, text, opts = {}) {
    const { el, contentEl } = this._createClydeMessage(channelId);
    this._setMessageContent(contentEl, text, false);
    if (opts.isIntro) el.classList.add('clyde-msg--intro');
    el.classList.add('clyde-msg--complete');
  }

  _copyLastResponse(btn) {
    const msgEl = btn.closest('.clyde-msg');
    const text = msgEl?.querySelector('.clyde-msg__content')?.textContent || '';
    navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent;
      btn.textContent = 'âœ… KopyalandÄ±!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  }

  _getMessageContainer() {
    return document.getElementById('messages') ||
           document.querySelector('.messages-list') ||
           document.querySelector('.msg-list');
  }

  /* â”€â”€ CSS ENJEKSÄ°YONU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
  _injectStyles() {
    if (document.getElementById('clyde-styles')) return;
    const style = document.createElement('style');
    style.id = 'clyde-styles';
    style.textContent = `
      /* â”€â”€ Clyde mesaj baloncuÄŸu â”€â”€ */
      .clyde-msg {
        display: flex; gap: 12px; padding: 8px 16px 4px;
        margin: 4px 0; animation: clydeSlideIn .2s ease;
        position: relative;
      }
      @keyframes clydeSlideIn {
        from { opacity:0; transform: translateY(8px); }
        to   { opacity:1; transform: translateY(0); }
      }
      .clyde-msg:hover { background: var(--bg-3, rgba(255,255,255,.03)); border-radius: 8px; }
      .clyde-msg--error .clyde-msg__content { color: var(--red, #ed4245); }
      .clyde-msg--intro { }

      .clyde-msg__avatar {
        width: 40px; height: 40px; border-radius: 50%;
        background: linear-gradient(135deg, #5865f2, #eb459e);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; font-size: 20px;
      }
      .clyde-msg__body { flex: 1; min-width: 0; }
      .clyde-msg__header { display: flex; align-items: baseline; gap: 8px; margin-bottom: 4px; }
      .clyde-msg__name { font-size: 14px; font-weight: 700; color: #eb459e; }
      .clyde-msg__badge {
        font-size: 9px; font-weight: 700; background: var(--brand, #5865f2);
        color: #fff; border-radius: 4px; padding: 1px 5px; vertical-align: middle;
        text-transform: uppercase; letter-spacing: .04em;
      }
      .clyde-msg__time { font-size: 11px; color: var(--text-muted, #72767d); }
      .clyde-msg__content {
        font-size: 14px; line-height: 1.6; color: var(--text-primary, #dcddde);
        word-break: break-word; white-space: pre-wrap;
      }
      .clyde-msg__content .clyde-code-block {
        background: var(--bg-1, #18191c); border: 1px solid var(--border, #202225);
        border-radius: 6px; padding: 10px 14px; overflow-x: auto;
        font-family: 'Courier New', monospace; font-size: 12px;
        margin: 8px 0; white-space: pre;
      }
      .clyde-msg__content .clyde-code-inline {
        background: var(--bg-1, #18191c); border-radius: 3px;
        padding: 1px 5px; font-family: 'Courier New', monospace; font-size: 12px;
      }
      .clyde-msg__actions {
        display: flex; gap: 6px; margin-top: 6px; opacity: 0; transition: opacity .15s;
      }
      .clyde-msg:hover .clyde-msg__actions { opacity: 1; }
      .clyde-action-btn {
        background: none; border: 1px solid var(--border, #40444b);
        border-radius: 4px; color: var(--text-muted, #72767d);
        cursor: pointer; font-size: 11px; padding: 3px 8px; transition: .12s;
      }
      .clyde-action-btn:hover { background: var(--bg-3); color: var(--text-primary); }

      /* â”€â”€ YazÄ±yor animasyonu â”€â”€ */
      .clyde-typing-indicator {
        display: flex; align-items: center; gap: 10px;
        padding: 8px 16px; animation: clydeSlideIn .2s ease;
      }
      .clyde-typing-dots {
        display: flex; gap: 4px; align-items: center;
        background: var(--bg-3, #40444b); border-radius: 12px;
        padding: 10px 14px;
      }
      .clyde-typing-dots span {
        width: 8px; height: 8px; border-radius: 50%;
        background: var(--text-muted, #72767d);
        animation: clydeTypingBounce 1.4s ease-in-out infinite;
      }
      .clyde-typing-dots span:nth-child(2) { animation-delay: .2s; }
      .clyde-typing-dots span:nth-child(3) { animation-delay: .4s; }
      @keyframes clydeTypingBounce {
        0%, 60%, 100% { transform: translateY(0); }
        30% { transform: translateY(-6px); }
      }

      /* â”€â”€ Streaming imleci â”€â”€ */
      .clyde-cursor {
        display: inline-block; width: 2px; height: 1em;
        background: var(--text-primary, #dcddde); vertical-align: text-bottom;
        margin-left: 2px; animation: clydeCursorBlink .7s step-end infinite;
      }
      @keyframes clydeCursorBlink { 0%,100%{opacity:1} 50%{opacity:0} }
    `;
    document.head.appendChild(style);
  }
}

/* â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
   SERVER ROUTE EKLENTÄ°SÄ° â€” server/routes/ai.js'e klyde route'u
   Bunun Ã§alÄ±ÅŸmasÄ± iÃ§in server/routes/ai.js'e aÅŸaÄŸÄ±daki patch gerekir
   (bkz: clyde-server-patch.js)
â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• */

/* â”€â”€ SINGLETON â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
window.BridgeClyde = new BridgeClyde();

// Tooltip'leri gÃ¼ncelle
document.addEventListener('DOMContentLoaded', () => {
  window.BridgeUI?.initTooltips();
});

console.log('[Clyde] AI AsistanÄ± aktif âœ“ â€” KullanÄ±m: @Clyde [sorunuz]');

