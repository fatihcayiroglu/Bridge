// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/UiPanel.svelte
//              client/js/core/ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { apiFetch } from './api-fetch.js';
import { getAPI, getCurrentChannel, getCurrentServer } from './globals.js';
import { toast } from './utils.js';
// core/ui.ts
// Zamanlanmış mesaj badge + modal + server GIF placeHolder

// ── Types ─────────────────────────────────────────────────────────────────────

interface ScheduledMessage {
  _id: string;
  content: string;
  sendAt: string | number;
  sent?: boolean;
}

// ── State ─────────────────────────────────────────────────────────────────────

let scheduledMessages: ScheduledMessage[] = [];

// ── Helpers ───────────────────────────────────────────────────────────────────

function pad(n: number): string { return String(n).padStart(2, '0'); }

// ── Badge ─────────────────────────────────────────────────────────────────────

export async function loadScheduledBadge(): Promise<void> {
  try {
    const r = await apiFetch(`${getAPI()}/api/scheduled`);
    if (!r.ok) return;
    scheduledMessages = await r.json();
    updateScheduledBadge();
  } catch {}
}

export function updateScheduledBadge(): void {
  const pending = scheduledMessages.filter(m => !m.sent).length;
  let badge = document.getElementById('scheduled-badge');
  if (pending > 0) {
    if (!badge) {
      badge = document.createElement('span');
      badge.id        = 'scheduled-badge';
      badge.className = 'scheduled-count-badge';
      document.getElementById('btn-schedule')?.appendChild(badge);
    }
    badge.textContent = String(pending);
  } else {
    badge?.remove();
  }
}

// ── Modal ─────────────────────────────────────────────────────────────────────

export function openScheduleModal(): void {
  const modal = document.getElementById('schedule-modal') as HTMLElement | null;
  if (modal) modal.style.display = 'flex';
  renderScheduledList();

  const dt = document.getElementById('schedule-datetime') as HTMLInputElement | null;
  if (dt) {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    dt.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  const msgInput       = document.getElementById('msg-input') as HTMLTextAreaElement | null;
  const scheduleContent = document.getElementById('schedule-content') as HTMLTextAreaElement | null;
  if (msgInput?.value.trim() && scheduleContent) scheduleContent.value = msgInput.value.trim();
}

export function renderScheduledList(): void {
  const list = document.getElementById('scheduled-list');
  if (!list) return;

  if (!scheduledMessages.length) {
    list.innerHTML = '<div class="empty-list">Henüz zamanlanmış mesaj yok.</div>';
    return;
  }

  list.innerHTML = '';
  for (const m of scheduledMessages) {
    const d    = new Date(m.sendAt);
    const item = document.createElement('div');
    item.className = 'scheduled-item';

    const info       = document.createElement('div');
    info.className   = 'scheduled-item-info';

    const contentDiv = document.createElement('div');
    contentDiv.className   = 'scheduled-item-content';
    contentDiv.textContent = m.content.slice(0, 80) + (m.content.length > 80 ? '...' : '');

    const timeDiv       = document.createElement('div');
    timeDiv.className   = 'scheduled-item-time';
    timeDiv.textContent = '🕐 ' + d.toLocaleString('tr-TR');

    info.append(contentDiv, timeDiv);

    const cancelBtn       = document.createElement('button');
    cancelBtn.className   = 'btn-cancel-scheduled';
    cancelBtn.textContent = '✕';
    const mid = m._id;
    cancelBtn.addEventListener('click', () => cancelScheduled(mid));

    item.append(info, cancelBtn);
    list.appendChild(item);
  }
}

export async function scheduleMessage(): Promise<void> {
  const currentChannel = getCurrentChannel() as { _id: string } | null | undefined;
  const currentServer  = getCurrentServer()  as { _id: string } | null | undefined;
  if (!currentChannel || !currentServer) {
    toast('Önce bir kanal seç', 'error');
    return;
  }

  const content  = (document.getElementById('schedule-content')  as HTMLTextAreaElement | null)?.value.trim();
  const datetime = (document.getElementById('schedule-datetime') as HTMLInputElement | null)?.value;

  if (!content)  { toast('Mesaj içeriği gerekli', 'error'); return; }
  if (!datetime) { toast('Tarih/saat seçin', 'error'); return; }

  const sendAt = new Date(datetime).toISOString();
  const r      = await apiFetch(`${getAPI()}/api/scheduled`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ channelId: currentChannel._id, serverId: currentServer._id, content, sendAt }),
  });
  const data = await r.json();
  if (!r.ok) { toast(data.error as string, 'error'); return; }

  scheduledMessages.push(data);
  updateScheduledBadge();
  renderScheduledList();
  toast('Mesaj zamanlandı! 🕐', 'success');

  const scheduleContent = document.getElementById('schedule-content') as HTMLTextAreaElement | null;
  if (scheduleContent) scheduleContent.value = '';
}

export async function cancelScheduled(id: string): Promise<void> {
  const r = await apiFetch(`${getAPI()}/api/scheduled/${id}`, { method: 'DELETE' });
  if (!r.ok) { toast('İptal başarısız', 'error'); return; }
  scheduledMessages = scheduledMessages.filter(m => m._id !== id);
  updateScheduledBadge();
  renderScheduledList();
  toast('Zamanlanmış mesaj iptal edildi', 'success');
}
