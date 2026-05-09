// client/js/core/ai.js İstemci AI Özellikleri
// Konuşma özeti, çeviri, yanıt önerisi, AI keşif UI

'use strict';

// ── DURUM ─────────────────────────────────────────────────────
let _aiStatus = null;

// ── AI DURUMUNU KONTROL ET ────────────────────────────────────
async function checkAIStatus() {
  try {
    const r = await apiFetch(`${API}/api/ai/status`);
    _aiStatus = await r.json();
    return _aiStatus;
  } catch {
    _aiStatus = { enabled: false };
    return _aiStatus;
  }
}

// ─────────────────────────────────────────────────────────────
// KANAL ÖZETİ
// ─────────────────────────────────────────────────────────────
async function openChannelSummary() {
  if (!currentChannel) return toast('Önce bir kanal seç', 'error');

  // Loading modal
  const modal = document.createElement('div');
  modal.id = 'ai-summary-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:520px;width:95%;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <h2 style="margin:0;">🤖 Kanal Özeti</h2>
        <button class="icon-btn" onclick="document.getElementById('ai-summary-modal').remove()">✕</button>
      </div>
      <div id="ai-summary-content" style="color:var(--text-muted);text-align:center;padding:32px 0;">
        <div class="spinner" style="margin:0 auto 12px;"></div>
        <p>Konuşma analiz ediliyor...</p>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);

  try {
    const r = await apiFetch(`${API}/api/ai/summarize/${currentChannel._id}?limit=50`);
    const data = await r.json();

    if (!r.ok) {
      if (r.status === 503) {
        document.getElementById('ai-summary-content').innerHTML = `
          <div style="text-align:center;padding:20px;">
            <div style="font-size:40px;margin-bottom:12px;">🔌</div>
            <p style="font-weight:600;margin-bottom:8px;">AI Özelliği Aktif Değil</p>
            <p style="color:var(--text-muted);font-size:13px;">.env dosyasına <code>GROQ_API_KEY</code> (ücretsiz: groq.com) veya <code>GEMINI_API_KEY</code> (ücretsiz: aistudio.google.com) ekleyin.</p>
          </div>`;
      } else {
        document.getElementById('ai-summary-content').innerHTML = `<p style="color:var(--red);">Hata: ${escHtml(data.error)}</p>`;
      }
      return;
    }

    const fromDate = new Date(data.from).toLocaleString('tr-TR');
    const toDate   = new Date(data.to).toLocaleString('tr-TR');

    document.getElementById('ai-summary-content').innerHTML = `
      <div style="background:var(--bg-3);border-radius:8px;padding:16px;margin-bottom:16px;text-align:left;">
        <div style="display:flex;gap:16px;margin-bottom:12px;font-size:12px;color:var(--text-muted);">
          <span>📝 ${data.messageCount} mesaj</span>
          <span>👥 ${data.participants} katılımcı</span>
          <span>📅 ${fromDate}</span>
        </div>
        <div style="line-height:1.7;white-space:pre-wrap;font-size:14px;">${escHtml(data.summary)}</div>
      </div>
      ${data.cached ? '<p style="font-size:11px;color:var(--text-muted);text-align:right;">⚡ Önbellekten</p>' : ''}`;
  } catch (err) {
    document.getElementById('ai-summary-content').innerHTML = `<p style="color:var(--red);">Bağlantı hatası: ${escHtml(err.message)}</p>`;
  }
}

// ─────────────────────────────────────────────────────────────
// MESAJ ÇEVİRİ
// ─────────────────────────────────────────────────────────────
async function translateMessage(msgId, targetLang = null) {
  const msgEl = document.getElementById(`msg-${msgId}`);
  if (!msgEl) return;

  const textEl = msgEl.querySelector('.msg-text');
  if (!textEl) return;

  const originalText = textEl.dataset.original || textEl.textContent;

  // Dil seçimi
  if (!targetLang) {
    const langs = [
      { code: 'tr', flag: '🇹🇷', name: 'Türkçe' },
      { code: 'en', flag: '🇬🇧', name: 'İngilizce' },
      { code: 'de', flag: '🇩🇪', name: 'Almanca' },
      { code: 'fr', flag: '🇫🇷', name: 'Fransızca' },
      { code: 'es', flag: '🇪🇸', name: 'İspanyolca' },
      { code: 'ar', flag: '🇸🇦', name: 'Arapça' },
      { code: 'zh', flag: '🇨🇳', name: 'Çince' },
      { code: 'ja', flag: '🇯🇵', name: 'Japonca' },
      { code: 'ru', flag: '🇷🇺', name: 'Rusça' },
    ];

    const picker = document.createElement('div');
    picker.className = 'context-menu';
    picker.style.cssText = `position:fixed;z-index:9999;min-width:150px;`;
    picker.innerHTML = langs.map(l =>
      `<div class="ctx-item" onclick="translateMessage('${msgId}','${l.code}');this.closest('.context-menu').remove()">
        ${l.flag} ${l.name}
      </div>`
    ).join('');

    const rect = msgEl.getBoundingClientRect();
    picker.style.left = rect.left + 'px';
    picker.style.top  = (rect.bottom + 4) + 'px';
    document.body.appendChild(picker);
    setTimeout(() => picker.remove(), 5000);
    document.addEventListener('click', () => picker.remove(), { once: true });
    return;
  }

  // Çeviri yükle
  const existingTranslation = msgEl.querySelector('.msg-translation');
  if (existingTranslation) { existingTranslation.remove(); return; } // Toggle

  const loadEl = document.createElement('div');
  loadEl.className = 'msg-translation';
  loadEl.style.cssText = 'color:var(--text-muted);font-size:12px;margin-top:4px;';
  loadEl.textContent = '⏳ Çeviriliyor...';
  textEl.after(loadEl);

  try {
    const r = await apiFetch(`${API}/api/ai/translate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: originalText.slice(0, 1000), targetLang }),
    });
    const data = await r.json();

    if (!r.ok) {
      loadEl.textContent = `❌ ${data.error || 'Çeviri başarısız'}`;
      return;
    }

    loadEl.innerHTML = `
      <span style="opacity:0.6;font-size:11px;">🌐 Çeviri (${data.provider}):</span>
      <span style="color:var(--text-normal);margin-left:6px;">${escHtml(data.translated)}</span>
      <button onclick="this.parentElement.remove()" style="background:none;border:none;cursor:pointer;color:var(--text-muted);margin-left:6px;font-size:11px;">✕</button>`;
  } catch {
    loadEl.textContent = '❌ Çeviri başarısız';
  }
}

// ─────────────────────────────────────────────────────────────
// YANIT ÖNERİSİ
// ─────────────────────────────────────────────────────────────
let _suggestionsVisible = false;

async function showReplySuggestions() {
  if (!currentChannel) return;

  const bar = document.getElementById('reply-suggestions-bar');
  if (bar) { bar.remove(); _suggestionsVisible = false; return; } // Toggle

  _suggestionsVisible = true;

  const container = document.getElementById('chat-input-area') || document.getElementById('msg-input')?.parentElement;
  if (!container) return;

  const sugBar = document.createElement('div');
  sugBar.id = 'reply-suggestions-bar';
  sugBar.style.cssText = 'display:flex;gap:6px;padding:8px 12px;flex-wrap:wrap;background:var(--bg-2);border-top:1px solid var(--border);';
  sugBar.innerHTML = '<span style="color:var(--text-muted);font-size:12px;align-self:center;">⏳</span>';
  container.before(sugBar);

  try {
    const r = await apiFetch(`${API}/api/ai/suggest-reply/${currentChannel._id}`);
    const data = await r.json();

    if (!r.ok || !data.suggestions?.length) {
      sugBar.remove();
      _suggestionsVisible = false;
      return;
    }

    sugBar.innerHTML = data.suggestions.map(s =>
      `<button class="suggestion-pill" onclick="useSuggestion(this)">${escHtml(s)}</button>`
    ).join('') +
    `<button onclick="document.getElementById('reply-suggestions-bar').remove()" 
             style="background:none;border:none;cursor:pointer;color:var(--text-muted);margin-left:auto;font-size:11px;">✕</button>`;
  } catch {
    sugBar.remove();
    _suggestionsVisible = false;
  }
}

function useSuggestion(btn) {
  const msgInput = document.getElementById('msg-input');
  if (msgInput) {
    msgInput.value = btn.textContent;
    msgInput.focus();
    document.getElementById('reply-suggestions-bar')?.remove();
    _suggestionsVisible = false;
  }
}

// ─────────────────────────────────────────────────────────────
// AI MODERELEMESİ UI (moderatörler için)
// ─────────────────────────────────────────────────────────────
async function checkMessageSafety(msgId) {
  const btn = document.getElementById(`ai-check-${msgId}`);
  if (btn) btn.textContent = '⏳';

  try {
    const r = await apiFetch(`${API}/api/ai/moderate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: msgId }),
    });
    const data = await r.json();

    const msgEl = document.getElementById(`msg-${msgId}`);
    if (!msgEl) return;

    const existing = msgEl.querySelector('.ai-safety-badge');
    if (existing) existing.remove();

    const badge = document.createElement('div');
    badge.className = 'ai-safety-badge';
    badge.style.cssText = `
      font-size:11px;padding:3px 8px;border-radius:4px;margin-top:4px;display:inline-flex;gap:4px;align-items:center;
      background:${data.safe ? 'var(--green-bg)' : 'var(--red-bg)'};
      color:${data.safe ? 'var(--green)' : 'var(--red)'};
    `;
    badge.innerHTML = `${data.safe ? '✅' : '⚠️'} Güvenlik: ${data.score}/100 — ${escHtml(data.reason)}`;
    msgEl.querySelector('.msg-text')?.after(badge);

    if (btn) btn.textContent = data.safe ? '✅' : '⚠️';
  } catch {
    if (btn) btn.textContent = '❌';
  }
}

// ─────────────────────────────────────────────────────────────
// AI DISCOVER ÖNERİLERİ
// ─────────────────────────────────────────────────────────────
async function loadAIDiscoverRecommendations() {
  const container = document.getElementById('discover-ai-recommendations');
  if (!container) return;

  container.innerHTML = '<div class="discover-loading">🤖 İlgi alanlarınıza göre öneriler hazırlanıyor...</div>';

  try {
    const r = await apiFetch(`${API}/api/ai/discover-match`);
    const data = await r.json();

    if (!r.ok || !data.recommendations?.length) {
      container.innerHTML = '<div class="discover-empty">Öneri bulunamadı</div>';
      return;
    }

    container.innerHTML = `
      <h3 style="margin:0 0 12px;font-size:14px;color:var(--text-muted);">🤖 Senin İçin Öneriler</h3>
      <div class="discover-grid">
        ${data.recommendations.map(s => `
          <div class="discover-card" onclick="joinFromDiscover('${s.id}')">
            <div style="background:linear-gradient(135deg,var(--brand) 0%,#7289da 100%);height:60px;border-radius:8px 8px 0 0;"></div>
            <div style="padding:12px;">
              <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
                <div style="width:36px;height:36px;border-radius:50%;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:18px;margin-top:-18px;border:2px solid var(--bg-2);">${s.icon || '🌐'}</div>
                <div>
                  <div style="font-weight:700;font-size:14px;">${escHtml(s.name)}</div>
                  <div style="color:var(--text-muted);font-size:11px;">${s.memberCount} üye</div>
                </div>
              </div>
              <div style="font-size:12px;color:var(--brand);background:var(--brand-subtle);padding:4px 8px;border-radius:4px;">
                🤖 ${escHtml(s.reason)}
              </div>
            </div>
            <div class="discover-join-btn">Katıl →</div>
          </div>
        `).join('')}
      </div>`;
  } catch {
    container.innerHTML = '';
  }
}

// ─────────────────────────────────────────────────────────────
// TOOLBAR BUTONU: Mesaj sağ tık menüsüne AI seçenekleri ekle
// ─────────────────────────────────────────────────────────────
function addAIContextMenuItems(msgId, menuEl) {
  const divider = document.createElement('div');
  divider.style.cssText = 'height:1px;background:var(--border);margin:4px 0;';
  menuEl.appendChild(divider);

  const translateBtn = document.createElement('div');
  translateBtn.className = 'ctx-item';
  translateBtn.innerHTML = '🌐 Mesajı Çevir';
  translateBtn.onclick = () => { menuEl.remove(); translateMessage(msgId); };
  menuEl.appendChild(translateBtn);

  if (window._isModOrAdmin) {
    const safetyBtn = document.createElement('div');
    safetyBtn.className = 'ctx-item';
    safetyBtn.innerHTML = '🛡️ AI Güvenlik Kontrolü';
    safetyBtn.onclick = () => { menuEl.remove(); checkMessageSafety(msgId); };
    menuEl.appendChild(safetyBtn);
  }
}

// CSS: suggestion pills
const style = document.createElement('style');
style.textContent = `
  .suggestion-pill {
    background: var(--bg-3);
    border: 1px solid var(--border);
    border-radius: 16px;
    padding: 4px 12px;
    font-size: 13px;
    cursor: pointer;
    color: var(--text-normal);
    transition: all 0.15s;
    white-space: nowrap;
  }
  .suggestion-pill:hover {
    background: var(--brand-subtle);
    border-color: var(--brand);
    color: var(--brand);
  }
  .msg-translation {
    font-size: 13px;
    margin-top: 4px;
    padding: 6px 8px;
    background: var(--bg-3);
    border-radius: 6px;
    border-left: 2px solid var(--brand);
  }
`;
document.head.appendChild(style);

export {
  addAIContextMenuItems,
  checkAIStatus,
  checkMessageSafety,
  loadAIDiscoverRecommendations,
  openChannelSummary,
  showReplySuggestions,
  translateMessage,
  useSuggestion,
};

