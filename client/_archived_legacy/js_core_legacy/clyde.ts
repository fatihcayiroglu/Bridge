// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ClydePanel.svelte
//              client/js/core/clyde-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/clyde.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Clyde AI Asistanı — @Clyde mention, SSE streaming, multi-turn sohbet

import { BridgeRegistry }                      from './bridge-registry.js';
import { getAPI, getCurrentChannel }           from './globals.js';

declare function toast(msg: string, type?: string): void;

// ── Tip tanımları ─────────────────────────────────────────────

interface HistoryEntry { role: 'user' | 'assistant'; content: string; }
interface ShowMsgOpts  { isIntro?: boolean; }

// ═════════════════════════════════════════════════════════════
// CLYDE CORE
// ═════════════════════════════════════════════════════════════

class BridgeClyde {
  enabled     = true;
  typing      = false;
  private _history:    Map<string, HistoryEntry[]> = new Map();
  private _maxHistory  = 10;
  private _abortCtrl:  AbortController | null = null;

  constructor() {
    this._injectStyles();
    this._patchMessageSend();
  }

  // ── @Clyde MENTION ──────────────────────────────────────────

  private _patchMessageSend(): void {
    const originalSend = BridgeRegistry.get('sendMessage') as ((content: string, opts?: unknown) => void) | null;
    if (originalSend) {
      BridgeRegistry.register('sendMessage', (content: string, opts?: unknown) =>
        this._interceptSend(content, opts, originalSend));
    }

    document.addEventListener('bridge:message-send', (e: Event) => {
      const ce = e as CustomEvent<{ content?: string; channelId?: string }>;
      if (ce.detail?.content) {
        const { content, channelId } = ce.detail;
        if (this._isClydeCall(content)) {
          e.preventDefault();
          void this.ask(this._extractQuery(content), channelId);
        }
      }
    });

    document.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.shiftKey) return;
      const input = document.getElementById('msg-input') as HTMLInputElement | null;
      if (!input || document.activeElement !== input) return;
      const content = input.value.trim();
      if (!this._isClydeCall(content)) return;
      e.preventDefault(); e.stopPropagation();
      input.value = ''; input.style.height = '';
      void this.ask(this._extractQuery(content), getCurrentChannel()?._id);
    }, true);
  }

  private _interceptSend(content: string, opts: unknown, originalSend: (c: string, o?: unknown) => void): void {
    if (!this.enabled || !this._isClydeCall(content)) { originalSend(content, opts); return; }
    void this.ask(this._extractQuery(content), getCurrentChannel()?._id);
  }

  private _isClydeCall(content: string): boolean { return /^@[Cc]lyde\b/i.test(content.trim()); }
  private _extractQuery(content: string): string  { return content.replace(/^@[Cc]lyde\s*/i, '').trim(); }

  // ── ANA SORGULAMA ────────────────────────────────────────────

  async ask(query: string, channelId?: string | null): Promise<void> {
    if (!query) {
      this._showClydeMessage(channelId, 'Merhaba! 👋 Ben Clyde. Bana bir şey sormak için `@Clyde [sorunuz]` yazabilirsiniz.', { isIntro: true });
      return;
    }

    this._abortCtrl?.abort();
    this._abortCtrl = new AbortController();

    this._addToHistory(channelId, 'user', query);
    const typingId = this._showTyping(channelId);
    const { el: msgEl, contentEl } = this._createClydeMessage(channelId);
    let fullText = '';

    try {
      const url = new URL(`${getAPI() ?? ''}/api/ai/clyde/stream`);
      url.searchParams.set('q', query);
      if (channelId) url.searchParams.set('channelId', channelId);
      const history = this._getHistory(channelId);
      if (history.length) url.searchParams.set('history', JSON.stringify(history.slice(-this._maxHistory)));

      const token = localStorage.getItem('bridge-token') ?? (BridgeRegistry.get('_authToken') as string | null) ?? '';
      const resp  = await fetch(url.toString(), { headers: { Authorization: `Bearer ${token}` }, signal: this._abortCtrl.signal });

      this._removeTyping(typingId);

      if (!resp.ok) {
        const data = await resp.json().catch(() => ({}) as { error?: string });
        this._setMessageContent(contentEl,
          resp.status === 503
            ? '⚠️ AI özelliği aktif değil. `.env` dosyasına `GROQ_API_KEY` veya `GEMINI_API_KEY` ekleyin.'
            : `❌ Hata: ${(data as { error?: string }).error ?? 'Bilinmeyen hata'}`);
        msgEl.classList.add('clyde-msg--error');
        return;
      }

      // SSE streaming
      const reader  = resp.body!.getReader();
      const decoder = new TextDecoder();
      let buffer    = '';

      // eslint-disable-next-line no-constant-condition
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const raw = line.slice(6).trim();
          if (!raw) continue;
          try {
            const event = JSON.parse(raw) as { token?: string; done?: boolean; error?: string };
            if (event.token) { fullText += event.token; this._setMessageContent(contentEl, fullText, true); }
            else if (event.done) { this._setMessageContent(contentEl, fullText, false); this._addToHistory(channelId, 'assistant', fullText); msgEl.classList.add('clyde-msg--complete'); break; }
            else if (event.error) { this._setMessageContent(contentEl, `❌ ${event.error}`); msgEl.classList.add('clyde-msg--error'); }
          } catch { /* parse hatası — devam et */ }
        }
      }

      if (!fullText) this._setMessageContent(contentEl, '(Yanıt boş geldi)');
    } catch (err) {
      this._removeTyping(typingId);
      if ((err as Error).name === 'AbortError') { msgEl.remove(); return; }
      this._setMessageContent(contentEl, `❌ Bağlantı hatası: ${(err as Error).message}`);
      msgEl.classList.add('clyde-msg--error');
    }
  }

  // ── GEÇMİŞ ──────────────────────────────────────────────────

  private _addToHistory(channelId: string | null | undefined, role: 'user' | 'assistant', content: string): void {
    const key = channelId ?? '_dm';
    if (!this._history.has(key)) this._history.set(key, []);
    const hist = this._history.get(key)!;
    hist.push({ role, content });
    while (hist.length > this._maxHistory * 2) hist.splice(0, 2);
  }

  private _getHistory(channelId: string | null | undefined): HistoryEntry[] {
    return this._history.get(channelId ?? '_dm') ?? [];
  }

  clearHistory(channelId?: string | null): void {
    this._history.delete(channelId ?? '_dm');
    if (typeof toast === 'function') toast('🤖 Clyde sohbet geçmişi temizlendi', 'info');
  }

  // ── UI ───────────────────────────────────────────────────────

  private _showTyping(channelId?: string | null): string {
    const id = `clyde-typing-${Date.now()}`;
    const container = this._getMessageContainer();
    if (!container) return id;
    const el = document.createElement('div');
    el.id = id; el.className = 'clyde-typing-indicator';
    el.innerHTML = `<div class="clyde-avatar" aria-hidden="true"><span class="clyde-avatar-icon">🤖</span></div><div class="clyde-typing-dots" aria-label="Clyde yazıyor..."><span></span><span></span><span></span></div>`;
    container.appendChild(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    return id;
  }

  private _removeTyping(id: string): void { document.getElementById(id)?.remove(); }

  private _createClydeMessage(channelId?: string | null): { el: HTMLElement; contentEl: HTMLElement } {
    const container = this._getMessageContainer();
    const el = document.createElement('div');
    el.className = 'clyde-msg';
    el.setAttribute('role', 'article');
    el.setAttribute('aria-label', 'Clyde yanıtı');
    const now = new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    el.innerHTML = `
      <div class="clyde-msg__avatar" aria-hidden="true"><span class="clyde-avatar-icon">🤖</span></div>
      <div class="clyde-msg__body">
        <div class="clyde-msg__header">
          <span class="clyde-msg__name">Clyde</span>
          <span class="clyde-msg__badge">AI</span>
          <span class="clyde-msg__time">${now}</span>
        </div>
        <div class="clyde-msg__content" aria-live="polite"></div>
        <div class="clyde-msg__actions">
          <button class="clyde-action-btn" data-bridge-action="BridgeClyde:clearHistory" data-bridge-arg="${channelId ?? ''}">🗑️ Geçmişi Temizle</button>
          <button class="clyde-action-btn" data-bridge-action="BridgeClyde:copyLastResponse">📋 Kopyala</button>
        </div>
      </div>`;
    if (container) { container.appendChild(el); setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50); }
    return { el, contentEl: el.querySelector('.clyde-msg__content') as HTMLElement };
  }

  private _setMessageContent(contentEl: HTMLElement, text: string, streaming = false): void {
    contentEl.innerHTML = this._renderMarkdownLite(text, streaming);
    if (streaming) {
      if (!contentEl.querySelector('.clyde-cursor')) {
        const cursor = document.createElement('span');
        cursor.className = 'clyde-cursor'; cursor.setAttribute('aria-hidden', 'true');
        contentEl.appendChild(cursor);
      }
    } else { contentEl.querySelector('.clyde-cursor')?.remove(); }
    contentEl.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  private _renderMarkdownLite(text: string, _streaming = false): string {
    if (!text) return '';
    let s = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    s = s.replace(/```([\s\S]*?)```/g, (_, code: string) => `<pre class="clyde-code-block"><code>${code.trim()}</code></pre>`);
    s = s.replace(/`([^`]+)`/g, '<code class="clyde-code-inline">$1</code>');
    s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    s = s.replace(/\n/g, '<br>');
    return s;
  }

  private _showClydeMessage(channelId: string | null | undefined, text: string, opts: ShowMsgOpts = {}): void {
    const { el, contentEl } = this._createClydeMessage(channelId);
    this._setMessageContent(contentEl, text, false);
    if (opts.isIntro) el.classList.add('clyde-msg--intro');
    el.classList.add('clyde-msg--complete');
  }

  _copyLastResponse(btn: HTMLElement): void {
    const msgEl = btn.closest('.clyde-msg');
    const text = msgEl?.querySelector('.clyde-msg__content')?.textContent ?? '';
    void navigator.clipboard.writeText(text).then(() => {
      const orig = btn.textContent ?? '';
      btn.textContent = '✅ Kopyalandı!';
      setTimeout(() => { btn.textContent = orig; }, 2000);
    });
  }

  private _getMessageContainer(): HTMLElement | null {
    return document.getElementById('messages') ?? document.querySelector('.messages-list') ?? document.querySelector('.msg-list');
  }

  // ── CSS ──────────────────────────────────────────────────────

  private _injectStyles(): void {
    if (document.getElementById('clyde-styles')) return;
    const style = document.createElement('style');
    style.id = 'clyde-styles';
    style.textContent = `
      .clyde-msg{display:flex;gap:12px;padding:8px 16px 4px;margin:4px 0;animation:clydeSlideIn .2s ease;position:relative;}
      @keyframes clydeSlideIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      .clyde-msg:hover{background:var(--bg-3,rgba(255,255,255,.03));border-radius:8px;}
      .clyde-msg--error .clyde-msg__content{color:var(--red,#ed4245);}
      .clyde-msg__avatar{width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#2d9cdb,#eb459e);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:20px;}
      .clyde-msg__body{flex:1;min-width:0;}
      .clyde-msg__header{display:flex;align-items:baseline;gap:8px;margin-bottom:4px;}
      .clyde-msg__name{font-size:14px;font-weight:700;color:#eb459e;}
      .clyde-msg__badge{font-size:9px;font-weight:700;background:var(--brand,#2d9cdb);color:#fff;border-radius:4px;padding:1px 5px;text-transform:uppercase;letter-spacing:.04em;}
      .clyde-msg__time{font-size:11px;color:var(--text-muted,#72767d);}
      .clyde-msg__content{font-size:14px;line-height:1.6;color:var(--text-primary,#dcddde);word-break:break-word;white-space:pre-wrap;}
      .clyde-msg__content .clyde-code-block{background:var(--bg-1,#18191c);border:1px solid var(--border,#202225);border-radius:6px;padding:10px 14px;overflow-x:auto;font-family:'Courier New',monospace;font-size:12px;margin:8px 0;white-space:pre;}
      .clyde-msg__content .clyde-code-inline{background:var(--bg-1,#18191c);border-radius:3px;padding:1px 5px;font-family:'Courier New',monospace;font-size:12px;}
      .clyde-msg__actions{display:flex;gap:6px;margin-top:6px;opacity:0;transition:opacity .15s;}
      .clyde-msg:hover .clyde-msg__actions{opacity:1;}
      .clyde-action-btn{background:none;border:1px solid var(--border,#40444b);border-radius:4px;color:var(--text-muted,#72767d);cursor:pointer;font-size:11px;padding:3px 8px;transition:.12s;}
      .clyde-action-btn:hover{background:var(--bg-3);color:var(--text-primary);}
      .clyde-typing-indicator{display:flex;align-items:center;gap:10px;padding:8px 16px;animation:clydeSlideIn .2s ease;}
      .clyde-typing-dots{display:flex;gap:4px;align-items:center;background:var(--bg-3,#40444b);border-radius:12px;padding:10px 14px;}
      .clyde-typing-dots span{width:8px;height:8px;border-radius:50%;background:var(--text-muted,#72767d);animation:clydeTypingBounce 1.4s ease-in-out infinite;}
      .clyde-typing-dots span:nth-child(2){animation-delay:.2s;}
      .clyde-typing-dots span:nth-child(3){animation-delay:.4s;}
      @keyframes clydeTypingBounce{0%,60%,100%{transform:translateY(0)}30%{transform:translateY(-6px)}}
      .clyde-cursor{display:inline-block;width:2px;height:1em;background:var(--text-primary,#dcddde);vertical-align:text-bottom;margin-left:2px;animation:clydeCursorBlink .7s step-end infinite;}
      @keyframes clydeCursorBlink{0%,100%{opacity:1}50%{opacity:0}}`;
    document.head.appendChild(style);
  }
}

// ── Singleton ─────────────────────────────────────────────────

const bridgeClydeInstance = new BridgeClyde();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
BridgeRegistry.register('BridgeClyde', bridgeClydeInstance as unknown);
BridgeRegistry.register('BridgeClyde:clearHistory',       (ch: string)           => bridgeClydeInstance.clearHistory(ch));
BridgeRegistry.register('BridgeClyde:copyLastResponse',   (el: HTMLElement)      => bridgeClydeInstance._copyLastResponse(el));

document.addEventListener('DOMContentLoaded', () => BridgeRegistry.call('BridgeUI:initTooltips'));

export const getBridgeClyde = (): BridgeClyde | null => BridgeRegistry.get('BridgeClyde') as BridgeClyde | null;
