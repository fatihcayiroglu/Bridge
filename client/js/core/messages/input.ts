export {};
// core/messages/input.js
// Mesaj gÃ¶nderme, dÃ¼zenleme, typing, text formatÄ±

// â”€â”€ FORMAT TEXT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function formatText(text) {
  if (!text) return '';

  const codeBlocks = [];
  let safe = escHtml(text);

  safe = safe.replace(/```([\s\S]+?)```/g, (_, code) => {
    codeBlocks.push('<pre><code>' + code + '</code></pre>');
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });
  safe = safe.replace(/`([^`]+)`/g, (_, code) => {
    codeBlocks.push('<code>' + code + '</code>');
    return '\x00CODE' + (codeBlocks.length - 1) + '\x00';
  });

  safe = safe
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g,     '<strong>$1</strong>')
    .replace(/\*([^*\n]+?)\*/g,    '<em>$1</em>')
    .replace(/__(.+?)__/g,         '<strong>$1</strong>')
    .replace(/_([^_\n]+?)_/g,      '<em>$1</em>')
    .replace(/~~(.+?)~~/g,         '<del>$1</del>')
    .replace(/__([^_]+)__/g,       '<u>$1</u>');

  safe = safe.replace(/@(\w+)/g, '<span class="mention">@$1</span>');
  safe = safe.replace(/\n/g, '<br>');
  safe = safe.replace(/\x00CODE(\d+)\x00/g, (_, i) => codeBlocks[+i]);

  let html = safe;
  if (serverEmojiCache.length) {
    if (!window._emojiMap || window._emojiMapSize !== serverEmojiCache.length) {
      window._emojiMap     = new Map(serverEmojiCache.map(e => [e.name, e]));
      window._emojiMapSize = serverEmojiCache.length;
    }
    html = html.replace(/:([\\w.-]+):/g, (match, name) => {
      const emoji = window._emojiMap.get(name);
      if (!emoji) return match;
      const safeUrl  = encodeURI(API + emoji.url);
      const safeName = escHtml(emoji.name);
      return `<img src="${safeUrl}" alt=":${safeName}:" title=":${safeName}:" class="server-emoji">`;
    });
  }
  return html;
}

// â”€â”€ SEND â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !currentChannel || currentChannel.type !== 'text') return;
  if (content.length > 2000) return toast('Message too long (max 2000 characters)', 'error');

  if (content.startsWith('/') && typeof executeSlashCommand === 'function') {
    if (executeSlashCommand(content)) {
      input.value = ''; input.style.height = 'auto';
      socket.emit('typing:stop', { channelId: currentChannel._id });
      return;
    }
  }

  if (replyingTo) {
    socket.emit('message:reply', { channelId: currentChannel._id, content, serverId: currentServer._id, replyToId: replyingTo });
    cancelReply();
  } else {
    socket.emit('message:send', { channelId: currentChannel._id, content, serverId: currentServer._id });
  }
  input.value = ''; input.style.height = 'auto';
  const sendBtn = document.querySelector('.msg-input-btn.send');
  if (sendBtn) {
    sendBtn.classList.remove('send-pop');
    void sendBtn.offsetWidth;
    sendBtn.classList.add('send-pop');
  }
  socket.emit('typing:stop', { channelId: currentChannel._id });
}

function handleMsgKey(e) {
  if (typeof handleSlashKey === 'function' && handleSlashKey(e)) return;
  if (typeof handleMentionKey === 'function') {
    const textarea = document.getElementById('msg-input');
    if (handleMentionKey(e, textarea)) return;
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
}

function handleTypingInput(el) {
  el.style.height = 'auto'; el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  const sendBtn = document.querySelector('.msg-input-btn.send');
  if (sendBtn) sendBtn.classList.toggle('send-has-content', el.value.trim().length > 0);
  if (!currentChannel) return;
  socket.emit('typing:start', { channelId: currentChannel._id });
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => socket.emit('typing:stop', { channelId: currentChannel._id }), 2000);
  if (typeof handleSlashInput === 'function') handleSlashInput(el.value);
  if (typeof handleMentionAutocomplete === 'function') handleMentionAutocomplete(el);
  if (typeof saveDraft === 'function' && currentChannel) saveDraft(currentChannel._id, el.value);
}

// â”€â”€ EDIT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function startEditMessage(msgId, btn) {
  if (editingMessageId) cancelEdit();
  editingMessageId = msgId;
  const textEl = document.getElementById(`msgtext-${msgId}`) || document.getElementById(`msg-${msgId}`)?.querySelector('.msg-text');
  if (!textEl) return;
  const original = textEl.dataset.raw || textEl.textContent.replace(' (edited)', '').trim();
  textEl.dataset.raw = original;
  textEl.innerHTML = `<div class="edit-wrap"><textarea class="edit-input" id="edit-input-${msgId}">${escHtml(original)}</textarea><div class="edit-hint"><span>Press <kbd>Enter</kbd> to save, <kbd>Esc</kbd> to cancel</span><div><button class="btn-edit-cancel" onclick="cancelEdit()">Cancel</button><button class="btn-edit-save" onclick="saveEdit('${msgId}')">Save</button></div></div></div>`;
  const input = document.getElementById(`edit-input-${msgId}`); input.focus(); input.setSelectionRange(input.value.length, input.value.length);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); saveEdit(msgId); } if (e.key === 'Escape') cancelEdit(); });
}

async function saveEdit(msgId) {
  const input = document.getElementById(`edit-input-${msgId}`); if (!input) return;
  const content = input.value.trim(); if (!content) return;
  socket.emit('message:edit', { messageId: msgId, channelId: currentChannel._id, content });
  editingMessageId = null;
}

function cancelEdit() {
  if (!editingMessageId) return;
  const textEl = document.getElementById(`msgtext-${editingMessageId}`) || document.getElementById(`msg-${editingMessageId}`)?.querySelector('.msg-text');
  if (textEl && textEl.dataset.raw) textEl.innerHTML = formatText(textEl.dataset.raw);
  editingMessageId = null;
}

function showDeleteMessageModal(msgId, channelId) {
  showConfirmModal({ title: 'Delete Message', message: 'This message will be permanently deleted.', confirmText: 'Delete', danger: true, onConfirm: () => socket.emit('message:delete', { messageId: msgId, channelId }) });
}

// â”€â”€ SEARCH â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function searchMessages() {
  const q = document.getElementById('search-input')?.value?.trim();
  if (!q || !currentChannel) return;
  const r = await apiFetch(`${API}/api/channels/${currentChannel._id}/messages?q=${encodeURIComponent(q)}&limit=50`);
  const messages = await r.json();
  const area = document.getElementById('messages-area');
  const headerDiv = document.createElement('div'); headerDiv.className = 'day-sep'; headerDiv.textContent = `Search: "${q}" (${messages.length})`; area.appendChild(headerDiv);
  if (!messages.length) { const e = document.createElement('div'); e.style.cssText = 'padding:20px;color:var(--text-muted)'; e.textContent = 'No messages found.'; area.appendChild(e); return; }
  let lastUserId = null;
  for (const msg of messages) { renderMessage(msg, lastUserId === msg.userId); lastUserId = msg.userId; }
  scrollToBottom(false);
}

// â”€â”€ TRANSLATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function translateMessage(msgId) {
  const textEl = document.getElementById(`msgtext-${msgId}`) || document.querySelector(`#msg-${msgId} .msg-text`);
  if (!textEl) return;
  const raw = textEl.dataset.raw || textEl.textContent.replace(' (edited)', '').trim();
  if (!raw) return;

  const existing = textEl.querySelector('.msg-translation');
  if (existing) { existing.remove(); return; }

  const btn = document.querySelector(`#msg-${msgId} .translate-btn`);
  if (btn) { btn.textContent = 'â³'; btn.disabled = true; }

  try {
    let translatedText = null;

    if (clientConfig.translateEnabled) {
      const r = await apiFetch(`${API}/api/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: raw, target: 'tr' }),
      });
      if (r.ok) {
        const data = await r.json();
        translatedText = data.translatedText || null;
      }
    }

    if (!translatedText) {
      const r = await apiFetch(`${API}/api/ai/translate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: raw, targetLanguage: 'Turkish' }),
      });
      if (r.ok) {
        const data = await r.json();
        translatedText = data.translation || data.translatedText || null;
      }
    }

    if (!translatedText) { toast('Ã‡eviri yapÄ±lamadÄ± â€” AI API key gerekli', 'error'); return; }

    const div = document.createElement('div');
    div.className = 'msg-translation';
    div.innerHTML = `<span class="translation-label">ğŸŒ TÃ¼rkÃ§e:</span> ${escHtml(translatedText)}`;
    textEl.appendChild(div);
  } catch { toast('Ã‡eviri hatasÄ±', 'error'); }
  finally { if (btn) { btn.textContent = 'ğŸŒ'; btn.disabled = false; } }
}

