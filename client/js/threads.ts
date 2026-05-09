// client/js/threads.js
// Thread panel: aÃ§, kapat, mesaj gÃ¶nder, gerÃ§ek zamanlÄ± gÃ¼ncellemeler
// inline Ã¶nizleme badge, thread iÃ§i Ã§eviri butonu, optimistic badge gÃ¼ncelleme

(function () {
  let currentThread = null;
  let threadBefore  = null;

  // â”€â”€ OPEN THREAD â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.openThread = async function (messageId, previewText) {
    // Zaten aynÄ± thread aÃ§Ä±ksa kapat
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
      if (!r.ok && r.status !== 409) return toast(data.error || 'Thread aÃ§Ä±lamadÄ±', 'error');
      thread = data.thread || data;
    } catch (e) { return toast('Thread aÃ§Ä±lamadÄ±', 'error'); }

    currentThread = thread;
    threadBefore  = null;
    socket.emit('thread:join', thread._id);
    renderThreadPanel(thread, messageId, previewText);
    await loadThreadMessages(thread._id);

    // Badge'i hemen gÃ¼ncelle (optimistic)
    _ensureThreadBadge(messageId, thread);
  };

  window.closeThread = function () {
    if (currentThread) socket.emit('thread:leave', currentThread._id);
    currentThread = null;
    document.getElementById('thread-panel')?.remove();
  };

  // â”€â”€ RENDER PANEL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function renderThreadPanel(thread, parentMsgId, parentPreview) {
    document.getElementById('thread-panel')?.remove();

    const panel = document.createElement('div');
    panel.id = 'thread-panel';
    panel.className = 'thread-panel';
    panel.innerHTML = `
      <div class="thread-header">
        <span class="thread-icon">ğŸ§µ</span>
        <div style="flex:1;min-width:0;">
          <div class="thread-title" id="thread-title">${escHtml(thread.name)}</div>
          ${parentPreview ? `<div class="thread-parent-preview" style="font-size:11px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:200px;" title="${escHtml(parentPreview)}">â†© ${escHtml(parentPreview.slice(0,60))}${parentPreview.length>60?'â€¦':''}</div>` : ''}
        </div>
        <span class="thread-count" id="thread-count">${thread.messageCount} yanÄ±t</span>
        <button class="thread-close-btn" onclick="closeThread()" title="Kapat">âœ•</button>
      </div>
      <div class="thread-messages" id="thread-messages">
        <div class="thread-loading">YÃ¼kleniyor...</div>
      </div>
      <div class="thread-input-wrap">
        <textarea
          id="thread-input"
          class="thread-input"
          placeholder="Thread'e yanÄ±tla..."
          rows="1"
          onkeydown="handleThreadKey(event)"
          oninput="this.style.height='auto';this.style.height=Math.min(this.scrollHeight,120)+'px'"
        ></textarea>
        <button class="thread-send-btn" onclick="sendThreadMessage()" title="GÃ¶nder">â†‘</button>
      </div>`;

    const layout = document.getElementById('chat-layout') || document.getElementById('text-view');
    if (layout) layout.appendChild(panel);
    else document.body.appendChild(panel);

    document.getElementById('thread-input')?.focus();
  }

  // â”€â”€ LOAD MESSAGES â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  async function loadThreadMessages(threadId, prepend = false) {
    const area = document.getElementById('thread-messages');
    if (!area) return;

    const params = threadBefore ? `?before=${threadBefore}&limit=50` : '?limit=50';
    const r = await apiFetch(`${API}/api/threads/${threadId}/messages${params}`);
    if (!r.ok) return;
    const msgs = await r.json();

    if (!prepend) area.innerHTML = '';
    if (!msgs.length) {
      if (!prepend) area.innerHTML = '<div class="thread-empty">HenÃ¼z yanÄ±t yok. Ä°lk yanÄ±tÄ± sen yaz!</div>';
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

  // â”€â”€ BUILD MESSAGE ELEMENT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function buildThreadMsgEl(msg) {
    const d    = new Date(msg.createdAt);
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const el   = document.createElement('div');
    el.id        = `tmsg-${msg._id}`;
    el.className = 'thread-msg';

//     Ã§eviri + tepki butonlarÄ±
    const canEdit = msg.userId === (window.currentUser?._id);
    const actionBtns = `
      <div class="tmsg-actions">
        <button class="tmsg-action-btn" title="Ã‡evir ğŸŒ" onclick="translateThreadMessage('${msg._id}', this)">ğŸŒ</button>
        ${canEdit ? `<button class="tmsg-action-btn" title="Sil" onclick="deleteThreadMessage('${msg._id}')">ğŸ—‘ï¸</button>` : ''}
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

  // â”€â”€ SEND MESSAGE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.sendThreadMessage = async function () {
    const input = document.getElementById('thread-input');
    const content = input?.value?.trim();
    if (!content || !currentThread) return;
    if (content.length > 2000) return toast('Mesaj Ã§ok uzun (maks 2000)', 'error');

    input.value = '';
    input.style.height = 'auto';

    // Optimistic UI â€” hemen gÃ¶ster
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
        // Optimistic mesajÄ± kaldÄ±r
        document.getElementById(`tmsg-${optimisticMsg._id}`)?.remove();
        _updateCountBadge(-1);
        return toast(d.error || 'GÃ¶nderilemedi', 'error');
      }
      const msg = await r.json();
      // Optimistic'i gerÃ§ek mesajla deÄŸiÅŸtir
      const optEl = document.getElementById(`tmsg-${optimisticMsg._id}`);
      if (optEl) optEl.id = `tmsg-${msg._id}`;
      socket.emit('thread:message:new', { threadId: currentThread._id, msg });
    } catch {
      document.getElementById(`tmsg-${optimisticMsg._id}`)?.remove();
      _updateCountBadge(-1);
      toast('GÃ¶nderilemedi', 'error');
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
      countEl.textContent = `${n} yanÄ±t`;
    }
  }

//   thread badge'ini ana kanalda gÃ¼ncelle/oluÅŸtur
  function _ensureThreadBadge(parentMsgId, thread) {
    const channelId = currentThread?.channelId || window.currentChannel?._id;
    const badgeId = `thread-badge-${channelId}-${thread._id}`;
    let badge = document.getElementById(badgeId);
    if (!badge) {
      // badge-new varsa onu dÃ¶nÃ¼ÅŸtÃ¼r
      const msgEl = document.querySelector(`[data-msg-id="${parentMsgId}"]`) ||
                    document.getElementById(`msg-${parentMsgId}`)?.closest('.msg-group, .msg-continue');
      if (msgEl) {
        const newBadge = msgEl.querySelector('.thread-badge-new');
        if (newBadge) {
          newBadge.className = 'thread-badge';
          newBadge.id = badgeId;
          newBadge.dataset.count = thread.messageCount || 0;
          newBadge.textContent = `ğŸ§µ ${thread.messageCount || 0} yanÄ±t`;
          newBadge.onclick = () => window.openThread(parentMsgId, thread.name);
        }
      }
    }
  }

  // â”€â”€ THREAD Ä°Ã‡Ä° Ã‡EVÄ°RÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.translateThreadMessage = async function (msgId, btn) {
    const trEl = document.getElementById(`tmsg-tr-${msgId}`);
    if (!trEl) return;
    // Toggle
    if (trEl.style.display !== 'none' && trEl.textContent) {
      trEl.style.display = 'none';
      btn.title = 'Ã‡evir ğŸŒ';
      return;
    }
    btn.textContent = 'â³';
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
        trEl.innerHTML = `<span style="color:var(--text-muted);font-size:11px;">ğŸŒ ${escHtml(d.targetLang || '')} Â· </span><span style="color:var(--text-normal);">${escHtml(d.translated)}</span>`;
        trEl.style.display = 'block';
        btn.title = 'Ã‡eviriyi gizle';
      } else {
        toast('Ã‡eviri baÅŸarÄ±sÄ±z', 'error');
      }
    } catch { toast('Ã‡eviri hatasÄ±', 'error'); }
    btn.textContent = 'ğŸŒ';
  };

  // â”€â”€ Thread mesaj sil â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.deleteThreadMessage = async function (msgId) {
    if (!currentThread) return;
    if (!confirm('Bu mesajÄ± silmek istiyor musun?')) return;
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

  // â”€â”€ SOCKET REAL-TIME â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window._bindThreadSocketEvents = function () {
    socket.on('thread:message:new', ({ threadId, msg }) => {
      if (currentThread?._id === threadId) {
        // Optimistic'in kopyasÄ± deÄŸilse ekle
        if (!document.getElementById(`tmsg-${msg._id}`)) {
          appendThreadMessage(msg);
        }
      }
      // Ana kanaldaki badge'i gÃ¼ncelle
      const badge = document.querySelector(`[id^="thread-badge-"][id$="-${threadId}"]`);
      if (badge) {
        const n = (parseInt(badge.dataset.count || '0') + 1);
        badge.dataset.count = n;
        badge.textContent = `ğŸ§µ ${n} yanÄ±t`;
      }
    });
  };
})();

