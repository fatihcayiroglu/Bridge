// client/js/core/v44/slow-mode.js
// ModÃ¼l: Slow Mode UI â€” Kanal yÃ¶neticisi cooldown ayarÄ±
'use strict';

const BridgeSlowMode = (() => {
  function renderSlowModeBadge(channel) {
    const existing = document.getElementById('slow-mode-badge');
    existing?.remove();
    if (!channel?.slowmode || channel.slowmode < 1) return;

    const secs = channel.slowmode;
    const label = secs < 60 ? `${secs}s` : secs < 3600 ? `${Math.floor(secs/60)}dk` : `${Math.floor(secs/3600)}sa`;
    const badge = document.createElement('span');
    badge.id = 'slow-mode-badge';
    badge.className = 'slow-mode-badge';
    badge.title = `YavaÅŸ mod: ${label} bekleme`;
    badge.textContent = `ğŸ¢ ${label}`;
    document.getElementById('channel-topic')?.after(badge);
  }

  let _cooldownTimer = null;
  function startCooldown(seconds) {
    if (_cooldownTimer) return;
    const input = document.getElementById('msg-input');
    const btn   = document.getElementById('send-btn');
    if (!input || !btn) return;
    input.disabled = true;
    btn.disabled   = true;

    let left = seconds;
    const badge = document.getElementById('slow-mode-badge');
    const orig  = badge?.textContent || '';

    const tick = () => {
      if (badge) badge.textContent = `ğŸ¢ ${left}s bekleniyor...`;
      left--;
      if (left < 0) {
        input.disabled = false;
        btn.disabled   = false;
        if (badge) badge.textContent = orig;
        clearInterval(_cooldownTimer);
        _cooldownTimer = null;
      }
    };
    tick();
    _cooldownTimer = setInterval(tick, 1000);
  }

  async function saveSlowMode(channelId, serverId, seconds) {
    await apiFetch(`${API}/api/servers/${serverId}/channels/${channelId}`, {
      method: 'PATCH',
      body: JSON.stringify({ slowmode: parseInt(seconds) || 0 }),
    });
    toast(seconds > 0 ? `ğŸ¢ YavaÅŸ mod ${seconds}s olarak ayarlandÄ±` : 'âœ… YavaÅŸ mod kapatÄ±ldÄ±', 'success');
  }

  return { renderSlowModeBadge, startCooldown, saveSlowMode };
})();

// Kanal deÄŸiÅŸtiÄŸinde slow mode badge'ini gÃ¼ncelle
const _origSwitchChannel = window.switchChannel;
if (typeof _origSwitchChannel === 'function') {
  window.switchChannel = async function(channelId) {
    const result = await _origSwitchChannel.apply(this, arguments);
    if (window.currentChannel) BridgeSlowMode.renderSlowModeBadge(window.currentChannel);
    return result;
  };
}

// Mesaj gÃ¶nderilince slow mode cooldown baÅŸlat
const _origSendMsg = window.sendMessage;
if (typeof _origSendMsg === 'function') {
  window.sendMessage = async function() {
    const result = await _origSendMsg.apply(this, arguments);
    const sm = window.currentChannel?.slowmode;
    if (sm > 0) BridgeSlowMode.startCooldown(sm);
    return result;
  };
}

// Expose globals
window.BridgeSlowMode = BridgeSlowMode;

