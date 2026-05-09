// core/messages/loader.js
// Mesaj yÃ¼kleme â€” cursor-based pagination

async function loadMessages(channelId) {
  noMoreMessages = false; oldestMessageTimestamp = null;
  window._msgPrevCursor = null;
  window._msgNextCursor = null;

  const area = document.getElementById('messages-area'); area.innerHTML = '';
  let messages = [];
  let loadedFromCache = false;
  try {
    const r = await apiFetch(`${API}/api/channels/${channelId}/messages?limit=50`);
    const data = await r.json();
    if (data && Array.isArray(data.messages)) {
      messages = data.messages;
      window._msgPrevCursor = data.prevCursor || null;
      window._msgNextCursor = data.nextCursor || null;
      noMoreMessages = !data.hasMore;
    } else if (Array.isArray(data)) {
      messages = data;
    }
    if (Array.isArray(messages) && window.bridgeOfflineCache) {
      window.bridgeOfflineCache.setChannelMessages(channelId, messages).catch(() => {});
    }
  } catch {
    if (window.bridgeOfflineCache) {
      messages = await window.bridgeOfflineCache.getChannelMessages(channelId).catch(() => []);
      loadedFromCache = Array.isArray(messages) && messages.length > 0;
    }
  }
  if (messages.length === 0) {
    area.innerHTML = `<div class="channel-welcome"><div class="welcome-icon">#</div><h2>Welcome to #${escHtml(currentChannel.name)}</h2><p>${escHtml(currentChannel.topic || 'Start the conversation!')}</p></div>`;
    return;
  }
  area.innerHTML = `<div class="day-sep">${loadedFromCache ? 'ğŸ“¦ Ã–nbellek gÃ¶steriliyor â€” baÄŸlantÄ± bekleniyor' : 'â†‘ Scroll to load older messages'}</div>`;
  if (loadedFromCache) window.dispatchEvent(new CustomEvent('bridge:messages-from-cache'));
  let lastUserId = null;
  for (const msg of messages) { renderMessage(msg, lastUserId === msg.userId); lastUserId = msg.userId; }
  oldestMessageTimestamp = messages[0].createdAt;
  const savedPos = _channelScrollPos.get(channelId);
  if (savedPos !== undefined && savedPos !== 'bottom') {
    area.scrollTop = savedPos;
  } else {
    scrollToBottom(false);
  }
}

async function loadOlderMessages(channelId) {
  const cursorParam = window._msgPrevCursor
    ? `cursor=${encodeURIComponent(window._msgPrevCursor)}`
    : oldestMessageTimestamp
      ? `before=${oldestMessageTimestamp}`
      : null;
  if (!cursorParam) return;

  const r    = await apiFetch(`${API}/api/channels/${channelId}/messages?${cursorParam}&limit=50`);
  const data = await r.json();
  let messages;
  if (data && Array.isArray(data.messages)) {
    messages = data.messages;
    window._msgPrevCursor = data.prevCursor || null;
    if (!data.hasMore) noMoreMessages = true;
  } else if (Array.isArray(data)) {
    messages = data;
  } else {
    messages = [];
  }

  if (!messages.length) { noMoreMessages = true; return; }
  const area = document.getElementById('messages-area');
  const frag = document.createDocumentFragment();
  let lastUserId = null;
  for (const msg of messages) {
    const el = document.createElement('div'); el.id = `msg-${msg._id}`;
    _populateMsgEl(el, msg, lastUserId === msg.userId);
    frag.appendChild(el); lastUserId = msg.userId;
  }
  area.insertBefore(frag, area.firstChild);
  oldestMessageTimestamp = messages[0].createdAt;
}

// Cache messages-area reference to avoid repeated DOM queries
let _msgAreaCache = null;
function _getMsgArea() {
  if (!_msgAreaCache || !_msgAreaCache.isConnected) {
    _msgAreaCache = document.getElementById('messages-area');
  }
  return _msgAreaCache;
}

