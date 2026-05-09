// client/js/core/v41/outgoing-webhooks.js
// Modül: Outgoing Webhook Yönetimi (Giden)
'use strict';

const SUPPORTED_EVENTS = [
  { id: 'message:new',    label: '💬 Yeni Mesaj' },
  { id: 'message:delete', label: '🗑️ Mesaj Silindi' },
  { id: 'member:join',    label: '👋 Üye Katıldı' },
  { id: 'member:leave',   label: '🚪 Üye Ayrıldı' },
  { id: 'channel:created',label: '📢 Kanal Oluşturuldu' },
  { id: 'channel:deleted',label: '🔇 Kanal Silindi' },
];

async function openOutgoingWebhookManager() {
  if (!currentServer) return;

  const modal = document.createElement('div');
  modal.id = 'outgoing-wh-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'display:flex;z-index:1100;';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;width:95%;max-height:88vh;overflow-y:auto;">
      <h2 style="margin-bottom:4px;">📤 Giden Webhook Yönetimi</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">
        Bridge'de bir olay gerçekleştiğinde belirlediğin URL'e otomatik POST gönderilir.
      </p>

      <div style="background:var(--bg-secondary);border-radius:10px;padding:16px;margin-bottom:16px;">
        <div style="font-weight:600;margin-bottom:12px;font-size:14px;">➕ Yeni Giden Webhook</div>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="font-size:12px;">Webhook Adı</label>
          <input type="text" id="ogwh-name" class="input-field" placeholder="örn: GitHub Bildirimleri" maxlength="80">
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="font-size:12px;">Hedef URL</label>
          <input type="url" id="ogwh-url" class="input-field" placeholder="https://your-server.com/webhook">
        </div>
        <div class="form-group" style="margin-bottom:10px;">
          <label style="font-size:12px;">Gizli Anahtar (opsiyonel — X-Bridge-Signature header'ı için)</label>
          <input type="text" id="ogwh-secret" class="input-field" placeholder="Boş bırakabilirsin">
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
          ➕ Oluştur
        </button>
      </div>

      <div id="ogwh-list">
        <div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">⏳ Yükleniyor…</div>
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
      listEl.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:16px;">Henüz giden webhook yok.</div>`;
      return;
    }

    listEl.innerHTML = data.map(w => `
      <div class="webhook-item" style="background:var(--bg-secondary);border-radius:10px;padding:14px;margin-bottom:10px;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="min-width:0;">
            <div style="font-weight:600;font-size:14px;">📤 ${escHtml(w.name)}</div>
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
              ${w.enabled ? '🟢 Aktif' : '⚫ Pasif'}
            </span>
            ${w.lastStatus ? `<span style="font-size:10px;color:${w.lastStatus >= 200 && w.lastStatus < 300 ? 'var(--success)' : 'var(--danger)'};text-align:center;">Son: HTTP ${w.lastStatus}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;gap:6px;margin-top:10px;flex-wrap:wrap;">
          <button class="btn" style="font-size:11px;padding:4px 10px;" onclick="testOutgoingWebhook('${escHtml(w._id)}')">🔔 Test</button>
          <button class="btn" style="font-size:11px;padding:4px 10px;" onclick="toggleOutgoingWebhook('${escHtml(w._id)}', ${!w.enabled})">
            ${w.enabled ? '⏸️ Devre Dışı' : '▶️ Etkinleştir'}
          </button>
          <button class="btn" style="font-size:11px;padding:4px 10px;color:var(--danger);" onclick="deleteOutgoingWebhook('${escHtml(w._id)}')">🗑️ Sil</button>
        </div>
      </div>`).join('');
  } catch {
    listEl.innerHTML = `<div style="color:var(--danger);font-size:13px;text-align:center;padding:16px;">Yüklenemedi.</div>`;
  }
}

async function createOutgoingWebhook() {
  if (!currentServer) return;
  const name   = document.getElementById('ogwh-name')?.value.trim();
  const url    = document.getElementById('ogwh-url')?.value.trim();
  const secret = document.getElementById('ogwh-secret')?.value.trim();
  const events = [...document.querySelectorAll('.ogwh-event-check:checked')].map(c => c.value);

  if (!name) return toast('Webhook adı gerekli', 'error');
  if (!url)  return toast('Hedef URL gerekli', 'error');
  if (!events.length) return toast('En az bir olay seçmelisin', 'error');

  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, url, events, secret: secret || undefined }),
  });
  const d = await r.json();
  if (!r.ok) return toast(d.error || 'Hata', 'error');

  document.getElementById('ogwh-name').value   = '';
  document.getElementById('ogwh-url').value    = '';
  document.getElementById('ogwh-secret').value = '';
  toast('Giden webhook oluşturuldu! ✅', 'success');
  await loadOutgoingWebhooks();
}

async function testOutgoingWebhook(id) {
  if (!currentServer) return;
  const btn = event?.target;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Gönderiliyor…'; }
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks/${id}/test`, { method: 'POST' });
  const d = await r.json();
  if (btn) { btn.disabled = false; btn.textContent = '🔔 Test'; }
  if (d.ok) toast(`Test başarılı! HTTP ${d.status} ✅`, 'success');
  else toast(`Test başarısız: HTTP ${d.status || 'timeout'} ❌`, 'error');
}

async function toggleOutgoingWebhook(id, enabled) {
  if (!currentServer) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks/${id}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) return toast('Güncellenemedi', 'error');
  toast(enabled ? 'Webhook etkinleştirildi' : 'Webhook devre dışı bırakıldı', 'success');
  await loadOutgoingWebhooks();
}

async function deleteOutgoingWebhook(id) {
  if (!currentServer || !confirm('Bu giden webhook\'u silmek istediğinizden emin misiniz?')) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/outgoing-webhooks/${id}`, { method: 'DELETE' });
  if (!r.ok) return toast('Silinemedi', 'error');
  toast('Giden webhook silindi', 'success');
  await loadOutgoingWebhooks();
}

// Expose globals
