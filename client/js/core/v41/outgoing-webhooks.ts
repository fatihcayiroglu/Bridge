// client/js/core/v41/outgoing-webhooks.js
// ModÃ¼l: Outgoing Webhook YÃ¶netimi (Giden)
'use strict';

const SUPPORTED_EVENTS = [
  { id: 'message:new',    label: 'ğŸ’¬ Yeni Mesaj' },
  { id: 'message:delete', label: 'ğŸ—‘ï¸ Mesaj Silindi' },
  { id: 'member:join',    label: 'ğŸ‘‹ Ãœye KatÄ±ldÄ±' },
  { id: 'member:leave',   label: 'ğŸšª Ãœye AyrÄ±ldÄ±' },
  { id: 'channel:created',label: 'ğŸ“¢ Kanal OluÅŸturuldu' },
  { id: 'channel:deleted',label: 'ğŸ”‡ Kanal Silindi' },
];

async function openOutgoingWebhookManager() {
  if (!currentServer) return;

  const modal = document.createElement('div');
  modal.id = 'outgoing-wh-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1100;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;width:95%;max-height:88vh;overflow-y:auto;">
      <h2 style="margin-bottom:4px;">ğŸ“¤ Giden Webhook YÃ¶netimi</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">
        Bridge'de bir olay gerÃ§ekleÅŸtiÄŸinde belirlediÄŸin URL'e otomatik POST gÃ¶nderilir.
      </p>

      <div style="background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:12px;font-size:14px;">â• Yeni Giden Webhook</div>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="font-size:12px;">Webhook AdÄ±</label>
          <input type="text" id="ogwh-name" class="input-field" placeholder="Ã¶rn: GitHub Bildirimleri" maxlength="80">
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="font-size:12px;">Hedef URL</label>
          <input type="url" id="ogwh-url" class="input-field" placeholder="https://your-server.com/webhook">
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="font-size:12px;">Gizli Anahtar (opsiyonel â€” X-Bridge-Signature header'Ä± iÃ§in)</label>
          <input type="text" id="ogwh-secret" class="input-field" placeholder="BoÅŸ bÄ±rakabilirsin">
        </div>
        <div class="form-group" style="margin-bottom:12px;">
          <label style="font-size:12px;">Olaylar</label>
          <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px;">
            ${SUPPORTED_EVENTS.map(e => `
              <label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;
                background:var(--bg-primary);padding:5px 10px;border-radius:6px;border:1px solid var(--border);">
                <input type="checkbox" value="${e.id}" class="ogwh-event-check" checked>
                ${e.label}
              </label>`).join('')}
          </div>
        </div>
        <button class="btn btn-primary" onclick="createOutgoingWebhook()" style="width:100%;justify-content:center;">
          â• OluÅŸtur
        </button>
      </div>

      <div id="ogwh-list">
        <div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">â³ YÃ¼kleniyorâ€¦</div>
      </div>

      <div class="modal-footer" style="margin-top:16px;">
        <button class="btn" onclick="document.getElementById('outgoing-wh-modal').remove()">Kapat</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  await loadOutgoingWebhooks();
}

async function loadOutgoingWebhooks() {
  const listEl = document.getElementById('ogwh-list');
  if (!listEl || !currentServer) return;

  try {
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks`);
    const data = r.ok ? await r.json() : [];

    if (!data.length) {
      listEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px;">HenÃ¼z giden webhook yok.</div>`;
      return;
    }

    listEl.innerHTML = data.map(w => `
      <div class="webhook-item" style="background:var(--bg-secondary);border-radius:10px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="min-width:0;">
            <div style="font-weight:600;font-size:14px;">ğŸ“¤ ${escHtml(w.name)}</div>
            <div style="font-size:11px;color:var(--text-muted);margin-top:2px;word-break:break-all;">${escHtml(w.url)}</div>
            <div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">
              ${(w.events||[]).map(ev => {
                const found = SUPPORTED_EVENTS.find(e => e.id === ev);
                return `<span style="font-size:10px;background:var(--bg-primary);border:1px solid var(--border);border-radius:4px;padding:2px 6px;">${found ? found.label : ev}</span>`;
              }).join('')}
            </div>
          </div>
          <div style="display:flex;flex-direction:column;gap:6px;flex-shrink:0;">
            <span style="font-size:11px;padding:3px 8px;border-radius:12px;text-align:center;
              background:${w.enabled ? 'rgba(59,165,92,.2)' : 'rgba(128,128,128,.2)'};
              color:${w.enabled ? 'var(--success)' : 'var(--text-muted)'};">
              ${w.enabled ? 'ğŸŸ¢ Aktif' : 'âš« Pasif'}
            </span>
            ${w.lastStatus ? `<span style="font-size:10px;color:${w.lastStatus >= 200 && w.lastStatus < 300 ? 'var(--success)' : 'var(--danger)'};text-align:center;">Son: HTTP ${w.lastStatus}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
          <button class="btn" style="font-size:11px;padding:4px 10px;" onclick="testOutgoingWebhook('${escHtml(w._id)}')">ğŸ”” Test</button>
          <button class="btn" style="font-size:11px;padding:4px 10px;" onclick="toggleOutgoingWebhook('${escHtml(w._id)}', ${!w.enabled})">
            ${w.enabled ? 'â¸ï¸ Devre DÄ±ÅŸÄ±' : 'â–¶ï¸ EtkinleÅŸtir'}
          </button>
          <button class="btn" style="font-size:11px;padding:4px 10px;color:var(--danger);" onclick="deleteOutgoingWebhook('${escHtml(w._id)}')">ğŸ—‘ï¸ Sil</button>
        </div>
      </div>`).join('');
  } catch {
    listEl.innerHTML = `<div style="color:var(--danger);font-size:13px;text-align:center;padding:16px;">YÃ¼klenemedi.</div>`;
  }
}

async function createOutgoingWebhook() {
  if (!currentServer) return;
  const name   = document.getElementById('ogwh-name')?.value.trim();
  const url    = document.getElementById('ogwh-url')?.value.trim();
  const secret = document.getElementById('ogwh-secret')?.value.trim();
  const events = [...document.querySelectorAll('.ogwh-event-check:checked')].map(c => c.value);

  if (!name) return toast('Webhook adÄ± gerekli', 'error');
  if (!url)  return toast('Hedef URL gerekli', 'error');
  if (!events.length) return toast('En az bir olay seÃ§melisin', 'error');

  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, events, secret: secret || undefined }),
  });
  const d = await r.json();
  if (!r.ok) return toast(d.error || 'Hata', 'error');

  { const _t = document.getElementById('ogwh-name') as HTMLInputElement | null; if (_t) _t.value = ''; }
  { const _t = document.getElementById('ogwh-url') as HTMLInputElement | null; if (_t) _t.value = ''; }
  { const _t = document.getElementById('ogwh-secret') as HTMLInputElement | null; if (_t) _t.value = ''; }
  toast('Giden webhook oluÅŸturuldu! âœ…', 'success');
  await loadOutgoingWebhooks();
}

async function testOutgoingWebhook(id) {
  if (!currentServer) return;
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = 'â³ GÃ¶nderiliyorâ€¦'; }
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks/${id}/test`, { method: 'POST' });
  const d = await r.json();
  if (btn) { btn.disabled = false; btn.textContent = 'ğŸ”” Test'; }
  if (d.ok) toast(`Test baÅŸarÄ±lÄ±! HTTP ${d.status} âœ…`, 'success');
  else toast(`Test baÅŸarÄ±sÄ±z: HTTP ${d.status || 'timeout'} âŒ`, 'error');
}

async function toggleOutgoingWebhook(id, enabled) {
  if (!currentServer) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) return toast('GÃ¼ncellenemedi', 'error');
  toast(enabled ? 'Webhook etkinleÅŸtirildi' : 'Webhook devre dÄ±ÅŸÄ± bÄ±rakÄ±ldÄ±', 'success');
  await loadOutgoingWebhooks();
}

async function deleteOutgoingWebhook(id) {
  if (!currentServer || !confirm('Bu giden webhook\'u silmek istediÄŸinizden emin misiniz?')) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks/${id}`, { method: 'DELETE' });
  if (!r.ok) return toast('Silinemedi', 'error');
  toast('Giden webhook silindi', 'success');
  await loadOutgoingWebhooks();
}

// Expose globals
window.openOutgoingWebhookManager = openOutgoingWebhookManager;
window.createOutgoingWebhook      = createOutgoingWebhook;
window.testOutgoingWebhook        = testOutgoingWebhook;
window.toggleOutgoingWebhook      = toggleOutgoingWebhook;
window.deleteOutgoingWebhook      = deleteOutgoingWebhook;

