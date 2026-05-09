// client/js/threads.js
// Thread panel: aç, kapat, mesaj gönder, gerçek zamanlı güncellemeler
// inline önizleme badge, thread içi çeviri butonu, optimistic badge güncelleme

(function () {
  let currentThread = null;
  let threadBefore  = null;

  // ── OPEN THREAD ──────────────────────────────────────────────
  window.openThread = async function (messageId, previewText) {
    // Zaten aynı thread açıksa kapat
    if (currentThread && currentThread.parentMessageId === messageId) {
      return window.closeThread();
    }

    let thread;
    try {
      const r = await apiFetch(`${API}/api/threads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ parentMessageId: messageId, name: previewText }),
      });
      const data = await r.json();
      if (!r.ok && r.status !== 409) return toast(data.error || 'Thread açılamadı', 'error');
      thread = data.thread || data;
    } catch (e) { return toast('Thread açılamadı', 'error'); }

    currentThread = thread;
    threadBefore  = null;
    socket.emit('thread:join', thread._id);
    renderThreadPanel(thread, messageId, previewText);
    await loadThreadMessages(thread._id);

    // Badge'i hemen güncelle (optimistic)
    _ensureThreadBadge(messageId, thread);
  };

  window.closeThread = function () {
    if (currentThread) socket.emit('thread:leave', currentThread._id);
    currentThread = null;
    document.getElementById('thread-panel')?.remove();
  };

  // ── RENDER PANEL ─────────────────────────────────────────────
  function renderThreadPanel(thread, parentMsgId, parentPreview) {
    document.getElementById('thread-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'thread-panel';
    panel.className = 'thread-panel';
    panel.innerHTML = `
      <div class="thread-header">
        <span class="thread-icon">🧵</span>
        <div style="flex:1;min-width:0;">
          <div class="thread-title" id="thread-title">${escHtml(thread.name)}</div>
          ${parentPreview ? `<div class="thread-parent-preview" style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;" title="${escHtml(parentPreview)}">↩ ${escHtml(parentPreview.slice(0,60))}${parentPreview.length>60?'…':''}</div>` : ''}
        </div>
        <span class="thread-count" id="thread-count">${thread.messageCount} yanıt</span>
        <button class="thread-close-btn" onclick="closeThread()" title="Kapat">✕</button>
      </div>
      <div class="thread-messages" id="thread-messages">
        <div class="thread-loading">Yükleniyor...</div>
      </div>
      <div class="thread-input-wrap">
        <textarea
          id="thread-input"
          class="thread-input"
          placeholder="Thread'e yanıtla..."
          rows="1"
          onkeydown="handleThreadKey(event)"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"
        ></textarea>
        <button class="thread-send-btn" onclick="sendThreadMessage()" title="Gönder">↑</button>
      </div>`;

    const layout = document.getElementById('chat-layout') || document.getElementById('text-view');
    if (layout) layout.appendChild(panel);
    else document.body.appendChild(panel);

    document.getElementById('thread-input')?.focus();
  }

  // ── LOAD MESSAGES ────────────────────────────────────────────
  async function loadThreadMessages(threadId, prepend = false) {
    const area = document.getElementById('thread-messages');
    if (!area) return;

    const params = threadBefore ? `?before=${threadBefore}&limit=50` : '?limit=50';
    const r = await apiFetch(`${API}/api/threads/${threadId}/messages${params}`);
    if (!r.ok) return;
    const msgs = await r.json();

    if (!prepend) area.innerHTML = '';
    if (!msgs.length) {
      if (!prepend) area.innerHTML = '<div class="thread-empty">Henüz yanıt yok. İlk yanıtı sen yaz!</div>';
      return;
    }

    threadBefore = msgs[0]?.createdAt;

    const frag = document.createDocumentFragment();
    for (const msg of msgs) {
      frag.appendChild(buildThreadMsgEl(msg));
    }

    if (prepend && area.firstChild) area.insertBefore(frag, area.firstChild);
    else area.appendChild(frag);

    if (!prepend) area.scrollTop = area.scrollHeight;
  }

  // ── BUILD MESSAGE ELEMENT ────────────────────────────────────
  function buildThreadMsgEl(msg) {
    const d    = new Date(msg.createdAt);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const el   = document.createElement('div');
    el.id        = `tmsg-${msg._id}`;
    el.className = 'thread-msg';

//     çeviri + tepki butonları
    const canEdit = msg.userId === (window.currentUser?._id);
    const actionBtns = `
      <div class="tmsg-actions">
        <button class="tmsg-action-btn" title="Çevir 🌐" onclick="translateThreadMessage('${msg._id}', this)">🌐</button>
        ${canEdit ? `<button class="tmsg-action-btn" title="Sil" onclick="deleteThreadMessage('${msg._id}')">🗑️</button>` : ''}
      </div>`;

    el.innerHTML = `
      <div class="tmsg-avatar" style="background:${cssColor(msg.avatarColor)}">${initials(msg.displayName)}</div>
      <div class="tmsg-body">
        <div class="tmsg-header">
          <span class="tmsg-author" style="color:${cssColor(msg.avatarColor)}">${escHtml(msg.displayName)}</span>
          <span class="tmsg-time">${time}</span>
          ${msg.editedAt ? '<span class="msg-edited">(edited)</span>' : ''}
        </div>
        <div class="tmsg-text" id="tmsg-text-${msg._id}">${formatText(msg.content)}</div>
        <div class="tmsg-translation" id="tmsg-tr-${msg._id}" style="display:none;"></div>
      </div>
      ${actionBtns}`;
    return el;
  }

  // ── SEND MESSAGE ─────────────────────────────────────────────
  window.sendThreadMessage = async function () {
    const input = document.getElementById('thread-input');
    const content = input?.value?.trim();
    if (!content || !currentThread) return;
    if (content.length > 2000) return toast('Mesaj çok uzun (maks 2000)', 'error');

    input.value = '';
    input.style.height = 'auto';

    // Optimistic UI — hemen göster
    const optimisticMsg = {
      _id: `opt-${Date.now()}`,
      userId: window.currentUser?._id,
      displayName: window.currentUser?.displayName || 'Sen',
      avatarColor: window.currentUser?.avatarColor || '#5865f2',
      content,
      createdAt: Date.now(),
    };
    appendThreadMessage(optimisticMsg);
    _updateCountBadge(+1);

    try {
      const r = await apiFetch(`${API}/api/threads/${currentThread._id}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      if (!r.ok) {
        const d = await r.json();
        // Optimistic mesajı kaldır
        document.getElementById(`tmsg-${optimisticMsg._id}`)?.remove();
        _updateCountBadge(-1);
        return toast(d.error || 'Gönderilemedi', 'error');
      }
      const msg = await r.json();
      // Optimistic'i gerçek mesajla değiştir
      const optEl = document.getElementById(`tmsg-${optimisticMsg._id}`);
      if (optEl) optEl.id = `tmsg-${msg._id}`;
      socket.emit('thread:message:new', { threadId: currentThread._id, msg });
    } catch {
      document.getElementById(`tmsg-${optimisticMsg._id}`)?.remove();
      _updateCountBadge(-1);
      toast('Gönderilemedi', 'error');
    }
  };

  function appendThreadMessage(msg) {
    const area = document.getElementById('thread-messages');
    if (!area) return;
    area.querySelector('.thread-empty')?.remove();
    const el = buildThreadMsgEl(msg);
    area.appendChild(el);
    area.scrollTop = area.scrollHeight;
  }

  function _updateCountBadge(delta) {
    const countEl = document.getElementById('thread-count');
    if (countEl) {
      const n = Math.max(0, parseInt(countEl.textContent) + delta);
      countEl.textContent = `${n} yanıt`;
    }
  }

//   thread badge'ini ana kanalda güncelle/oluştur
  function _ensureThreadBadge(parentMsgId, thread) {
    const channelId = currentThread?.channelId || window.currentChannel?._id;
    const badgeId = `thread-badge-${channelId}-${thread._id}`;
    let badge = document.getElementById(badgeId);
    if (!badge) {
      // badge-new varsa onu dönüştür
      const msgEl = document.querySelector(`[data-msg-id="${parentMsgId}"]`) ||
                    document.getElementById(`msg-${parentMsgId}`)?.closest('.msg-group, .msg-continue');
      if (msgEl) {
        const newBadge = msgEl.querySelector('.thread-badge-new');
        if (newBadge) {
          newBadge.className = 'thread-badge';
          newBadge.id = badgeId;
          newBadge.dataset.count = thread.messageCount || 0;
          newBadge.textContent = `🧵 ${thread.messageCount || 0} yanıt`;
          newBadge.onclick = () => window.openThread(parentMsgId, thread.name);
        }
      }
    }
  }

  // ── THREAD İÇİ ÇEVİRİ ───────────────────────────────────────
  window.translateThreadMessage = async function (msgId, btn) {
    const trEl = document.getElementById(`tmsg-tr-${msgId}`);
    if (!trEl) return;
    // Toggle
    if (trEl.style.display !== 'none' && trEl.textContent) {
      trEl.style.display = 'none';
      btn.title = 'Çevir 🌐';
      return;
    }
    btn.textContent = '⏳';
    const textEl = document.getElementById(`tmsg-text-${msgId}`);
    const text = textEl?.innerText || '';
    try {
      const r = await apiFetch(`${API}/api/ai/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, targetLang: navigator.language?.split('-')[0] || 'tr', msgId }),
      });
      if (r.ok) {
        const d = await r.json();
        trEl.innerHTML = `<span style="color:var(--text-muted);font-size:11px;">🌐 ${escHtml(d.targetLang || '')} · </span><span style="color:var(--text-normal);">${escHtml(d.translated)}</span>`;
        trEl.style.display = 'block';
        btn.title = 'Çeviriyi gizle';
      } else {
        toast('Çeviri başarısız', 'error');
      }
    } catch { toast('Çeviri hatası', 'error'); }
    btn.textContent = '🌐';
  };

  // ── Thread mesaj sil ─────────────────────────────────────────
  window.deleteThreadMessage = async function (msgId) {
    if (!currentThread) return;
    if (!confirm('Bu mesajı silmek istiyor musun?')) return;
    try {
      const r = await apiFetch(`${API}/api/threads/${currentThread._id}/messages/${msgId}`, { method: 'DELETE' });
      if (r.ok) {
        document.getElementById(`tmsg-${msgId}`)?.remove();
        _updateCountBadge(-1);
      }
    } catch { toast('Silinemedi', 'error'); }
  };

  window.handleThreadKey = function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendThreadMessage(); }
  };

  // ── SOCKET REAL-TIME ─────────────────────────────────────────
  window._bindThreadSocketEvents = function () {
    socket.on('thread:message:new', ({ threadId, msg }) => {
      if (currentThread?._id === threadId) {
        // Optimistic'in kopyası değilse ekle
        if (!document.getElementById(`tmsg-${msg._id}`)) {
          appendThreadMessage(msg);
        }
      }
      // Ana kanaldaki badge'i güncelle
      const badge = document.querySelector(`[id^="thread-badge-"][id$="-${threadId}"]`);
      if (badge) {
        const n = (parseInt(badge.dataset.count || '0') + 1);
        badge.dataset.count = n;
        badge.textContent = `🧵 ${n} yanıt`;
      }
    });
  };
})();

export const threadsReady = true;
