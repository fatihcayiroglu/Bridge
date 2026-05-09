// client/js/core/scheduled-ui.js
// Zamanlı Mesaj UI — Schedule picker, list, cancel
// Backend: GET/POST/DELETE /api/scheduled (zaten mevcut)

'use strict';

(function () {
  const api = window.BridgeAPI || window.api;

  // ── State ─────────────────────────────────────────────────────
  let _currentChannelId = null;
  let _currentServerId  = null;

  // ── Modal HTML ────────────────────────────────────────────────
  function ensureModal() {
    if (document.getElementById('schedule-modal')) return;
    const m = document.createElement('div');
    m.id = 'schedule-modal';
    m.className = 'modal-overlay hidden';
    m.innerHTML = `
      <div class="modal-card">
        <div class="modal-header">
          <span>⏰ Zamanlı Mesaj</span>
          <button class="modal-close" id="schedule-close">✕</button>
        </div>
        <div class="modal-body">
          <div class="schedule-form">
            <textarea id="schedule-content" placeholder="Mesaj içeriği…" maxlength="2000"></textarea>
            <label class="schedule-label">Gönderim zamanı</label>
            <input type="datetime-local" id="schedule-at" />
            <div class="schedule-row">
              <button class="btn btn-primary" id="schedule-submit">Planla</button>
              <span id="schedule-error" class="schedule-error"></span>
            </div>
          </div>
          <div class="schedule-pending-header">Bekleyen mesajlar</div>
          <div class="scheduled-list" id="scheduled-list">
            <div class="empty-list">Yükleniyor…</div>
          </div>
        </div>
      </div>`;
    document.body.appendChild(m);

    document.getElementById('schedule-close').addEventListener('click', closeModal);
    m.addEventListener('click', e => { if (e.target === m) closeModal(); });
    document.getElementById('schedule-submit').addEventListener('click', submitScheduled);
  }

  function openModal(channelId, serverId) {
    _currentChannelId = channelId;
    _currentServerId  = serverId;
    ensureModal();
    // Set min datetime to now+2min
    const minDt = new Date(Date.now() + 2 * 60 * 1000);
    document.getElementById('schedule-at').min = minDt.toISOString().slice(0, 16);
    document.getElementById('schedule-content').value = '';
    document.getElementById('schedule-error').textContent = '';
    document.getElementById('schedule-modal').classList.remove('hidden');
    loadPending();
  }

  function closeModal() {
    document.getElementById('schedule-modal')?.classList.add('hidden');
  }

  async function loadPending() {
    const list = document.getElementById('scheduled-list');
    try {
      const msgs = await api.get('/api/scheduled');
      if (!msgs.length) {
        list.innerHTML = '<div class="empty-list">Bekleyen mesaj yok</div>';
        return;
      }
      list.innerHTML = msgs.map(m => `
        <div class="scheduled-item" data-id="${m._id}">
          <div class="scheduled-item-info">
            <div class="scheduled-item-content">${escHtml(m.content)}</div>
            <div class="scheduled-item-time">${fmtDt(m.sendAt)}</div>
          </div>
          <button class="btn-cancel-scheduled" data-id="${m._id}" title="İptal et">✕</button>
        </div>`).join('');

      list.querySelectorAll('.btn-cancel-scheduled').forEach(btn => {
        btn.addEventListener('click', () => cancelScheduled(btn.dataset.id));
      });
    } catch (e) {
      list.innerHTML = '<div class="empty-list">Yüklenemedi</div>';
    }
  }

  async function submitScheduled() {
    const content = document.getElementById('schedule-content').value.trim();
    const sendAt  = document.getElementById('schedule-at').value;
    const errEl   = document.getElementById('schedule-error');
    errEl.textContent = '';

    if (!content) { errEl.textContent = 'Mesaj boş olamaz.'; return; }
    if (!sendAt)  { errEl.textContent = 'Lütfen zaman seç.'; return; }

    const ts = new Date(sendAt).getTime();
    if (ts <= Date.now()) { errEl.textContent = 'Gelecekte bir zaman seçmelisiniz.'; return; }

    try {
      const btn = document.getElementById('schedule-submit');
      btn.disabled = true;
      btn.textContent = 'Planlanıyor…';
      await api.post('/api/scheduled', {
        channelId: _currentChannelId,
        serverId:  _currentServerId,
        content,
        sendAt:    new Date(sendAt).toISOString(),
      });
      document.getElementById('schedule-content').value = '';
      document.getElementById('schedule-at').value = '';
      loadPending();
      showToast('⏰ Mesaj planlandı!');
    } catch (e) {
      errEl.textContent = e.message || 'Hata oluştu.';
    } finally {
      const btn = document.getElementById('schedule-submit');
      if (btn) { btn.disabled = false; btn.textContent = 'Planla'; }
    }
  }

  async function cancelScheduled(id) {
    try {
      await api.delete(`/api/scheduled/${id}`);
      document.querySelector(`.scheduled-item[data-id="${id}"]`)?.remove();
      const list = document.getElementById('scheduled-list');
      if (list && !list.querySelector('.scheduled-item')) {
        list.innerHTML = '<div class="empty-list">Bekleyen mesaj yok</div>';
      }
    } catch (e) {
      showToast('İptal edilemedi: ' + (e.message || ''));
    }
  }

  // ── Helpers ───────────────────────────────────────────────────
  function escHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function fmtDt(ts) {
    return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function showToast(msg) {
    if (window.showToast) { window.showToast(msg); return; }
    const t = document.createElement('div');
    t.className = 'bridge-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Message badge — zamanlı olarak gönderilmiş mesajlara rozet ─
  // messages renderer hook: message.scheduledId varsa rozet ekle
  function patchMessageRenderer() {
    const origRender = window.renderMessageContent;
    if (!origRender) return; // renderer henüz yüklenmemiş, app.js'ten çağrılır
    window.renderMessageContent = function(msg, el) {
      origRender(msg, el);
      if (msg.scheduledId) {
        const badge = document.createElement('span');
        badge.className = 'scheduled-badge';
        badge.title = 'Zamanlı mesaj';
        badge.textContent = '⏰';
        el.querySelector('.msg-content')?.appendChild(badge);
      }
    };
  }

  // ── Public API ────────────────────────────────────────────────
  window.ScheduledUI = { open: openModal, close: closeModal, patchRenderer: patchMessageRenderer };

  // Button hook: #btn-schedule varsa dinle
  document.addEventListener('click', e => {
    const btn = e.target.closest('#btn-schedule');
    if (!btn) return;
    const channelId = window.currentChannelId || window.bridgeApp?.currentChannelId;
    const serverId  = window.currentServerId  || window.bridgeApp?.currentServerId;
    if (channelId && serverId) openModal(channelId, serverId);
  });
})();

export const getScheduledUI = () => window.ScheduledUI;
