// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ScheduledUiPanel.svelte
//              client/js/core/scheduled-ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/scheduled-ui.ts
// Zamanlı Mesaj UI — Schedule picker, list, cancel
// Backend: GET/POST/DELETE /api/scheduled

import { BridgeRegistry } from './bridge-registry.js';
import { escHtml } from './utils.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScheduledMessage {
  _id: string;
  content: string;
  sendAt: string | number;
}

interface BridgeAPI {
  get(path: string): Promise<ScheduledMessage[]>;
  post(path: string, body: object): Promise<void>;
  delete(path: string): Promise<void>;
}

// ── Module (IIFE to preserve original scope isolation) ────────────────────────

(function () {
  const api: BridgeAPI =
    BridgeRegistry.get('BridgeAPI') ?? BridgeRegistry.get('api');

  // ── State ──────────────────────────────────────────────────────────────────
  let _currentChannelId: string | null = null;
  let _currentServerId:  string | null = null;

  // ── Helpers ────────────────────────────────────────────────────────────────
 as Record<string, string>)[c]!
    );
  }

  function fmtDt(ts: string | number): string {
    return new Date(ts).toLocaleString('tr-TR', { dateStyle: 'medium', timeStyle: 'short' });
  }

  function showToast(msg: string): void {
    if (BridgeRegistry.has('showToast')) { BridgeRegistry.call('showToast', msg); return; }
    const t = document.createElement('div');
    t.className = 'bridge-toast';
    t.textContent = msg;
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 3000);
  }

  // ── Modal HTML ─────────────────────────────────────────────────────────────
  function ensureModal(): void {
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

    document.getElementById('schedule-close')!.addEventListener('click', closeModal);
    m.addEventListener('click', (e: MouseEvent) => { if (e.target === m) closeModal(); });
    document.getElementById('schedule-submit')!.addEventListener('click', submitScheduled);
  }

  function openModal(channelId: string, serverId: string): void {
    _currentChannelId = channelId;
    _currentServerId  = serverId;
    ensureModal();

    const minDt = new Date(Date.now() + 2 * 60 * 1000);
    const atEl  = document.getElementById('schedule-at') as HTMLInputElement | null;
    if (atEl) atEl.min = minDt.toISOString().slice(0, 16);

    const contentEl = document.getElementById('schedule-content') as HTMLTextAreaElement | null;
    if (contentEl) contentEl.value = '';
    const errEl = document.getElementById('schedule-error');
    if (errEl) errEl.textContent = '';

    document.getElementById('schedule-modal')!.classList.remove('hidden');
    loadPending();
  }

  function closeModal(): void {
    document.getElementById('schedule-modal')?.classList.add('hidden');
  }

  async function loadPending(): Promise<void> {
    const list = document.getElementById('scheduled-list');
    if (!list) return;
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

      list.querySelectorAll<HTMLButtonElement>('.btn-cancel-scheduled').forEach(btn => {
        btn.addEventListener('click', () => cancelScheduled(btn.dataset.id!));
      });
    } catch {
      list.innerHTML = '<div class="empty-list">Yüklenemedi</div>';
    }
  }

  async function submitScheduled(): Promise<void> {
    const content = (document.getElementById('schedule-content') as HTMLTextAreaElement | null)?.value.trim();
    const sendAt  = (document.getElementById('schedule-at') as HTMLInputElement | null)?.value;
    const errEl   = document.getElementById('schedule-error');
    if (errEl) errEl.textContent = '';

    if (!content) { if (errEl) errEl.textContent = 'Mesaj boş olamaz.'; return; }
    if (!sendAt)  { if (errEl) errEl.textContent = 'Lütfen zaman seç.'; return; }
    if (new Date(sendAt).getTime() <= Date.now()) {
      if (errEl) errEl.textContent = 'Gelecekte bir zaman seçmelisiniz.'; return;
    }

    const btn = document.getElementById('schedule-submit') as HTMLButtonElement | null;
    try {
      if (btn) { btn.disabled = true; btn.textContent = 'Planlanıyor…'; }
      await api.post('/api/scheduled', {
        channelId: _currentChannelId,
        serverId:  _currentServerId,
        content,
        sendAt:    new Date(sendAt).toISOString(),
      });
      const contentEl = document.getElementById('schedule-content') as HTMLTextAreaElement | null;
      const atEl      = document.getElementById('schedule-at') as HTMLInputElement | null;
      if (contentEl) contentEl.value = '';
      if (atEl)      atEl.value      = '';
      loadPending();
      showToast('⏰ Mesaj planlandı!');
    } catch (e: unknown) {
      if (errEl) errEl.textContent = e.message ?? 'Hata oluştu.';
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = 'Planla'; }
    }
  }

  async function cancelScheduled(id: string): Promise<void> {
    try {
      await api.delete(`/api/scheduled/${id}`);
      document.querySelector(`.scheduled-item[data-id="${id}"]`)?.remove();
      const list = document.getElementById('scheduled-list');
      if (list && !list.querySelector('.scheduled-item')) {
        list.innerHTML = '<div class="empty-list">Bekleyen mesaj yok</div>';
      }
    } catch (e: unknown) {
      showToast('İptal edilemedi: ' + (e.message ?? ''));
    }
  }

  // ── Message badge patch ────────────────────────────────────────────────────
  function patchMessageRenderer(): void {
    const origRender: Function | undefined = BridgeRegistry.get('renderMessageContent');
    if (!origRender) return;
    BridgeRegistry.register('renderMessageContent', function (msg: Record<string,unknown>, el: HTMLElement) {
      origRender(msg, el);
      if (msg.scheduledId) {
        const badge = document.createElement('span');
        badge.className = 'scheduled-badge';
        badge.title = 'Zamanlı mesaj';
        badge.textContent = '⏰';
        el.querySelector('.msg-content')?.appendChild(badge);
      }
    });
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  BridgeRegistry.register('ScheduledUI', { open: openModal, close: closeModal, patchRenderer: patchMessageRenderer });

  // Button hook
  document.addEventListener('click', (e: MouseEvent) => {
    const btn = (e.target as HTMLElement).closest('#btn-schedule');
    if (!btn) return;
    const channelId: string | undefined = BridgeRegistry.get('currentChannelId');
    const serverId:  string | undefined = BridgeRegistry.get('currentServerId');
    if (channelId && serverId) openModal(channelId, serverId);
  });
})();

export const getScheduledUI = (): unknown => BridgeRegistry.get('ScheduledUI');
