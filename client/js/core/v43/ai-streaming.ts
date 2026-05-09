// client/js/core/v43/ai-streaming.js
// ModÃ¼l: AI Streaming â€” SSE ile token token yanÄ±t
'use strict';

window.askAIStreaming = function(question, channelId, onToken, onDone, onError) {
  if (!question?.trim()) return;
  const params = new URLSearchParams({ q: question });
  if (channelId) params.set('channelId', channelId);
  const token = localStorage.getItem('bridge_token');
  const url   = `${window.API || ''}/api/ai/ask/stream?${params}`;

  const ctrl = new AbortController();
  fetch(url, {
    headers: { 'Authorization': `Bearer ${token}` },
    signal: ctrl.signal,
  }).then(async res => {
    if (!res.ok) { onError?.('AI yanÄ±t vermedi'); return; }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (line.startsWith('event: token')) continue;
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.token !== undefined) onToken?.(d.token);
            if ('done' in d || d.type === 'done') { onDone?.(); return; }
            if (d.message) { onError?.(d.message); return; }
          } catch {}
        }
        if (line === 'event: done') { onDone?.(); return; }
      }
    }
    onDone?.();
  }).catch(err => {
    if (err.name !== 'AbortError') onError?.(err.message);
  });
  return ctrl;
};

// AI panelinde streaming kullan â€” sendAIMessage mevcut deÄŸilse DOMContentLoaded'a ertele
function _patchSendAIMessage() {
  if (typeof window.sendAIMessage !== 'function') return false;
  const _aiInputSend = window.sendAIMessage;
  window.sendAIMessage = function() {
    const input   = document.getElementById('ai-input');
    const output  = document.getElementById('ai-output');
    const q       = input?.value?.trim();
    if (!q || !output) return _aiInputSend.apply(this, arguments);

    input.value = '';
    const msgEl = document.createElement('div');
    msgEl.className = 'ai-response';
    msgEl.innerHTML = `<span class="ai-label">ğŸ¤–</span><span class="ai-text"></span>`;
    output.appendChild(msgEl);
    output.scrollTop = output.scrollHeight;
    const textEl = msgEl.querySelector('.ai-text');

    window.askAIStreaming(
      q,
      window.currentChannel?._id,
      (token) => { textEl.textContent += token; output.scrollTop = output.scrollHeight; },
      () => { /* done */ },
      (err) => { textEl.textContent = `Hata: ${err}`; }
    );
  };
  return true;
}

if (!_patchSendAIMessage()) {
  // sendAIMessage henÃ¼z yÃ¼klenmemiÅŸ â€” DOM hazÄ±r olunca tekrar dene
  document.addEventListener('DOMContentLoaded', _patchSendAIMessage);
  // Veya window.onload'dan sonra da bir deneme yap
  window.addEventListener('load', _patchSendAIMessage);
}

