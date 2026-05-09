// core/ui.js (split from app.js)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
let scheduledMessages = [];

async function loadScheduledBadge() {
  try {
    const r = await apiFetch(`${API}/api/scheduled`);
    if (!r.ok) return;
    scheduledMessages = await r.json();
    updateScheduledBadge();
  } catch { /* ignore */ }
}

function updateScheduledBadge() {
  const pending = scheduledMessages.filter(m => !m.sent).length;
  let badge = document.getElementById('scheduled-badge');
  if (pending > 0) {
    if (!badge) {
      badge = document.createElement('span'); badge.id = 'scheduled-badge'; badge.className = 'scheduled-count-badge';
      document.getElementById('btn-schedule')?.appendChild(badge);
    }
    badge.textContent = pending;
  } else { badge?.remove(); }
}

function openScheduleModal() {
  const modal = document.getElementById('schedule-modal');
  modal.style.display = 'flex';
  renderScheduledList();
  // Set default time to 1 hour from now
  const dt = document.getElementById('schedule-datetime');
  if (dt) {
    const d = new Date(Date.now() + 60 * 60 * 1000);
    const pad = n => String(n).padStart(2, '0');
    dt.value = `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }
  // Pre-fill content from input
  const msgInput = document.getElementById('msg-input');
  const scheduleContent = document.getElementById('schedule-content');
  if (msgInput.value.trim() && scheduleContent) scheduleContent.value = msgInput.value.trim();
}

function renderScheduledList() {
  const list = document.getElementById('scheduled-list');
  if (!list) return;
  if (!scheduledMessages.length) { list.innerHTML = '<div class="empty-list">HenÃ¼z zamanlanmÄ±ÅŸ mesaj yok.</div>'; return; }
  list.innerHTML = '';
  for (const m of scheduledMessages) {
    const d = new Date(m.sendAt);
    const item = document.createElement('div');
    item.className = 'scheduled-item';
    const info = document.createElement('div');
    info.className = 'scheduled-item-info';
    const contentDiv = document.createElement('div');
    contentDiv.className = 'scheduled-item-content';
    contentDiv.textContent = m.content.slice(0, 80) + (m.content.length > 80 ? '...' : '');
    const timeDiv = document.createElement('div');
    timeDiv.className = 'scheduled-item-time';
    timeDiv.textContent = 'ğŸ• ' + d.toLocaleString('tr-TR');
    info.appendChild(contentDiv);
    info.appendChild(timeDiv);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'btn-cancel-scheduled';
    cancelBtn.textContent = 'âœ•';
    const mid = m._id;
    cancelBtn.addEventListener('click', () => cancelScheduled(mid));
    item.appendChild(info);
    item.appendChild(cancelBtn);
    list.appendChild(item);
  }
}

async function scheduleMessage() {
  if (!currentChannel || !currentServer) return toast('Ã–nce bir kanal seÃ§', 'error');
  const content = document.getElementById('schedule-content')?.value?.trim();
  const datetime = document.getElementById('schedule-datetime')?.value;
  if (!content) return toast('Mesaj iÃ§eriÄŸi gerekli', 'error');
  if (!datetime) return toast('Tarih/saat seÃ§in', 'error');
  const sendAt = new Date(datetime).toISOString();
  const r = await apiFetch(`${API}/api/scheduled`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channelId: currentChannel._id, serverId: currentServer._id, content, sendAt }) });
  const data = await r.json();
  if (!r.ok) return toast(data.error, 'error');
  scheduledMessages.push(data);
  updateScheduledBadge();
  renderScheduledList();
  toast('Mesaj zamanlandÄ±! ğŸ•', 'success');
  { const _t = document.getElementById('schedule-content') as HTMLInputElement | null; if (_t) _t.value = ''; }
}

async function cancelScheduled(id) {
  const r = await apiFetch(`${API}/api/scheduled/${id}`, { method: 'DELETE' });
  if (!r.ok) return toast('Ä°ptal baÅŸarÄ±sÄ±z', 'error');
  scheduledMessages = scheduledMessages.filter(m => m._id !== id);
  updateScheduledBadge();
  renderScheduledList();
  toast('ZamanlanmÄ±ÅŸ mesaj iptal edildi', 'success');
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// SERVER GIF COLLECTIONS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

