// client/js/core/v42/automod.js
// Modül: AutoMod muafiyet (exemption) + log görüntüleyici
'use strict';
import { getCurrentServer } from '../globals.js';

const _origOpenAutoModPanel = window.openAutoModPanel;
window.openAutoModPanel = async function() {
  if (!getCurrentServer()) return;
  if (typeof _destroyTempModal === 'function') _destroyTempModal();

  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:720px;width:95%;max-height:88vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;flex-wrap:wrap;gap:8px;">
        <h2 style="margin:0;">🛡️ AutoMod Kuralları</h2>
        <div style="display:flex;gap:8px;">
          <button class="btn" onclick="openAutoModSettings()">⚙️ Genel Ayarlar</button>
          <button class="btn" onclick="openAutoModLogs()">📋 Log Görüntüle</button>
          <button class="btn btn-primary" onclick="openAutoModRuleEditor(null)">+ Kural Ekle</button>
        </div>
      </div>
      <div id="automod-rules-list" style="flex:1;overflow-y:auto;">
        <div style="text-align:center;padding:30px;color:var(--text-muted);">Yükleniyor...</div>
      </div>
      <div class="modal-footer"><button class="btn" onclick="_destroyTempModal()">Kapat</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };
  if (typeof refreshAutoModRules === 'function') await refreshAutoModRules();
};

async function openAutoModSettings() {
  let roles = [], channels = [];
  try {
    const [rr, cr] = await Promise.all([
      apiFetch(`${API}/api/servers/${getCurrentServer()._id}/roles`),
      apiFetch(`${API}/api/servers/${getCurrentServer()._id}/channels`),
    ]);
    if (rr.ok) roles = await rr.json();
    if (cr.ok) channels = (await cr.json()).filter(c => c.type === 'text');
  } catch {}

  let globalLogChannel = null, exemptRoles = [];
  try {
    const ar = await apiFetch(`${API}/api/servers/${getCurrentServer()._id}/automod`);
    if (ar.ok) {
      const rules = await ar.json();
      if (rules[0]) { globalLogChannel = rules[0].logChannelId; exemptRoles = rules[0].exemptRoles || []; }
    }
  } catch {}

  if (typeof _destroyTempModal === 'function') _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%;">
      <h2>⚙️ AutoMod Genel Ayarları</h2>
      <div class="form-group">
        <label>Log Kanalı <span style="font-size:11px;color:var(--text-muted);">(AutoMod eylemleri buraya yazılır)</span></label>
        <select id="am-log-channel" class="input-field">
          <option value="">— Log kanalı yok —</option>
          ${channels.map(c => `<option value="${escHtml(c._id)}" ${globalLogChannel === c._id ? 'selected' : ''}>#${escHtml(c.name)}</option>`).join('')}
        </select>
      </div>
      <div class="form-group">
        <label>Muaf Roller <span style="font-size:11px;color:var(--text-muted);">(bu rollerdekiler AutoMod'dan muaf)</span></label>
        <div style="display:flex;flex-direction:column;gap:6px;max-height:160px;overflow-y:auto;padding:4px 0;">
          ${roles.filter(r => r.name !== '@everyone').map(r => `
            <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;">
              <input type="checkbox" value="${escHtml(r._id)}" class="am-exempt-role"
                ${exemptRoles.includes(r._id) ? 'checked' : ''} style="accent-color:var(--brand)">
              <span style="width:12px;height:12px;border-radius:50%;background:${r.color || '#99aab5'};display:inline-block;"></span>
              ${escHtml(r.name)}
            </label>`).join('')}
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-primary" onclick="saveAutoModSettings()">💾 Kaydet</button>
        <button class="btn" onclick="openAutoModPanel()">İptal</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) openAutoModPanel(); };
}

async function saveAutoModSettings() {
  const logChannelId = document.getElementById('am-log-channel')?.value || null;
  const exemptRoles  = [...document.querySelectorAll('.am-exempt-role:checked')].map(c => c.value);

  try {
    const ar = await apiFetch(`${API}/api/servers/${getCurrentServer()._id}/automod`);
    if (ar.ok) {
      const rules = await ar.json();
      await Promise.all(rules.map(rule =>
        apiFetch(`${API}/api/servers/${getCurrentServer()._id}/automod/${rule._id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: { ...rule.config, logChannelId, exemptRoles } }),
        })
      ));
    }
  } catch {}

  toast('AutoMod ayarları kaydedildi ✅', 'success');
  openAutoModPanel();
}

async function openAutoModLogs() {
  if (typeof _destroyTempModal === 'function') _destroyTempModal();
  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:620px;width:95%;max-height:80vh;display:flex;flex-direction:column;">
      <h2>📋 AutoMod Log</h2>
      <div id="automod-log-list" style="flex:1;overflow-y:auto;font-size:13px;">
        <div style="text-align:center;padding:30px;color:var(--text-muted);">Yükleniyor...</div>
      </div>
      <div class="modal-footer"><button class="btn" onclick="openAutoModPanel()">← Geri</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) openAutoModPanel(); };

  try {
    const ar = await apiFetch(`${API}/api/servers/${getCurrentServer()._id}/automod`);
    const rules = ar.ok ? await ar.json() : [];
    const logCh = rules.find(r => r.config?.logChannelId)?.config?.logChannelId || null;

    const listEl = document.getElementById('automod-log-list');
    if (!logCh) {
      listEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">📭</div>
        Log kanalı ayarlanmamış. AutoMod ayarlarından bir log kanalı seç.
      </div>`;
      return;
    }

    const mr = await apiFetch(`${API}/api/channels/${logCh}/messages?limit=50`);
    const messages = mr.ok ? await mr.json() : [];
    const amLogs = messages.filter(m => m.userId === 'automod' || m.type === 'automod' || m.displayName?.includes('AutoMod'));

    if (!amLogs.length) {
      listEl.innerHTML = `<div style="text-align:center;padding:40px;color:var(--text-muted);">Henüz AutoMod logu yok.</div>`;
      return;
    }

    listEl.innerHTML = amLogs.map(m => {
//       Risk skoru ve AI/kural kaynağını parse et
      const scoreMatch = m.content?.match(/Risk skoru:\s*(\d+)\/100/);
      const score = scoreMatch ? parseInt(scoreMatch[1]) : null;
      const isAI   = m.content?.includes('source: ai') || m.content?.includes('[AI]');
      const reasonMatch = m.content?.match(/Sebep:\s*(.+)/);
      const reason = reasonMatch ? reasonMatch[1].trim() : null;
      const userMatch  = m.content?.match(/Kullanıcı:\s*(.+)/);
      const userName   = userMatch ? userMatch[1].trim() : null;
      const msgMatch   = m.content?.match(/Mesaj:\s*`(.+?)`/);
      const msgPreview = msgMatch ? msgMatch[1] : null;

      const scoreColor = score === null ? 'var(--text-muted)' :
        score >= 80 ? '#ed4245' : score >= 50 ? '#faa61a' : '#3ba55c';
      const riskLabel = score === null ? '' : score >= 80 ? 'Yüksek Risk' : score >= 50 ? 'Orta Risk' : 'Düşük Risk';
      const scoreHtml = score !== null ? `
        <div style="display:flex;align-items:center;gap:6px;margin-top:4px;">
          <div style="height:4px;border-radius:2px;background:var(--bg-4);width:80px;overflow:hidden;">
            <div style="height:100%;width:${score}%;background:${scoreColor};border-radius:2px;transition:width .3s;"></div>
          </div>
          <span style="font-size:11px;font-weight:700;color:${scoreColor};">${score}/100 · ${riskLabel}</span>
          ${isAI ? '<span style="font-size:10px;background:rgba(167,139,250,0.15);color:#a78bfa;padding:1px 5px;border-radius:3px;font-weight:600;">🤖 AI</span>' : '<span style="font-size:10px;background:rgba(250,166,26,0.15);color:#faa61a;padding:1px 5px;border-radius:3px;font-weight:600;">📏 Kural</span>'}
        </div>` : '';

      return `
      <div style="padding:10px 12px;border-bottom:1px solid var(--border);border-left:3px solid ${scoreColor};background:${score !== null && score >= 80 ? 'rgba(237,66,69,0.04)' : 'transparent'};margin-bottom:2px;border-radius:0 4px 4px 0;">
        <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">
          <div style="flex:1;min-width:0;">
            <div style="font-size:11px;color:var(--text-muted);margin-bottom:2px;">${new Date(m.createdAt).toLocaleString('tr-TR')}</div>
            ${userName ? `<div style="font-size:13px;font-weight:600;color:var(--text-1);">👤 ${escHtml(userName)}</div>` : ''}
            ${msgPreview ? `<div style="font-size:12px;color:var(--text-muted);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:380px;font-style:italic;margin-top:2px;">"${escHtml(msgPreview)}"</div>` : ''}
            ${reason ? `<div style="font-size:12px;color:var(--text-2);margin-top:2px;">📝 ${escHtml(reason)}</div>` : ''}
            ${scoreHtml}
          </div>
        </div>
      </div>`;
    }).join('');
  } catch {
    document.getElementById('automod-log-list').innerHTML = `<div style="color:var(--danger);text-align:center;padding:20px;">Loglar yüklenemedi.</div>`;
  }
}

// Expose globals
