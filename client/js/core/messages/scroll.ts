// core/messages/scroll.js
// Kanal scroll pozisyonu hafÄ±zasÄ± + infinite scroll

const _channelScrollPos = new Map();

function _saveChannelScroll(channelId) {
  const area = document.getElementById('messages-area');
  if (area && channelId) {
    const atBottom = area.scrollHeight - area.scrollTop - area.clientHeight < 60;
    _channelScrollPos.set(channelId, atBottom ? 'bottom' : area.scrollTop);
  }
}

function _restoreChannelScroll(channelId) {
  const area = document.getElementById('messages-area');
  if (!area || !channelId) return;
  const saved = _channelScrollPos.get(channelId);
  if (saved === undefined || saved === 'bottom') {
    area.scrollTop = area.scrollHeight;
  } else {
    area.scrollTop = saved;
  }
}

function scrollToBottom(smooth = true) {
  const area = document.getElementById('messages-area');
  area.scrollTo({ top: area.scrollHeight, behavior: smooth ? 'smooth' : 'instant' });
}

function initInfiniteScroll() {
  const area = document.getElementById('messages-area');
  if (!area) return;
  area.addEventListener('scroll', async () => {
    if (area.scrollTop < 80 && !loadingMoreMessages && !noMoreMessages && oldestMessageTimestamp) {
      loadingMoreMessages = true;
      const prevHeight = area.scrollHeight;
      await loadOlderMessages(currentChannel._id);
      area.scrollTop = area.scrollHeight - prevHeight;
      loadingMoreMessages = false;
    }
  });
}

window._saveChannelScroll    = _saveChannelScroll;
window._restoreChannelScroll = _restoreChannelScroll;

