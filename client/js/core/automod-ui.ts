// client/js/core/automod-ui.js
// AutoMod kural yÃ¶netim paneli

'use strict';

const AUTOMOD_TYPES = {
  blocked_words:   { label: 'ğŸš« YasaklÄ± Kelimeler', desc: 'Belirli kelimeleri iÃ§eren mesajlarÄ± engelle' },
  spam_messages:   { label: 'âš¡ Spam KorumasÄ±',      desc: 'KÄ±sa sÃ¼rede Ã§ok mesaj gÃ¶nderilmesini engelle' },
  caps_lock:       { label: 'ğŸ”  BÃ¼yÃ¼k Harf Spam',    desc: 'AÅŸÄ±rÄ± bÃ¼yÃ¼k harf kullanÄ±mÄ±nÄ± engelle' },
  link_filter:     { label: 'ğŸ”— Link Filtresi',       desc: 'Ä°zinsiz link paylaÅŸÄ±mÄ±nÄ± engelle' },
  invite_filter:   { label: 'ğŸ’Œ Davet Linki Filtresi',desc: 'Bridge davet linklerini engelle' },
  mention_spam:    { label: 'ğŸ“¢ Mention Spam',         desc: 'Toplu mention engelleyici' },
  repeated_chars:  { label: 'ğŸ” Tekrar Karakter',     desc: 'Aaaaaaa gibi tekrar eden karakterleri engelle' },
};

async function openAutoModPanel() {
  if (!currentServer) return;
  _destroyTempModal();

  const modal = document.createElement('div');
  modal.id = 'temp-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:680px;width:95%;max-height:85vh;display:flex;flex-direction:column">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px">
        <h2 style="margin:0">ğŸ›¡ï¸ AutoMod KurallarÄ±</h2>
        <button class="btn btn-primary" onclick="openAutoModRuleEditor(null)">+ Kural Ekle</button>
      </div>
      <div id="automod-rules-list" style="flex:1;overflow-y:auto">
        <div style="text-align:center;padding:30px;color:var(--text-muted)">YÃ¼kleniyor...</div>
      </div>
      <div class="modal-footer"><button class="btn" onclick="_destroyTempModal()">Kapat</button></div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) _destroyTempModal(); };

  await refreshAutoModRules();
}

async function refreshAutoModRules() {
  const list = document.getElementById('automod-rules-list');
  if (!list || !currentServer) return;

  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/automod`);
  const rules = r.ok ? await r.json() : [];

  if (!rules.length) {
    list.innerHTML = `
      <div style="text-align:center;padding:40px;color:var(--text-muted)">
        <div style="font-size:40px;margin-bottom:12px">ğŸ›¡ï¸</div>
        <div style="font-size:15px;font-weight:600;margin-bottom:6px">HenÃ¼z kural yok</div>
        <div style="font-size:13px">Sunucunu korumak iÃ§in AutoMod kurallarÄ± ekle.</div>
      </div>`;
    return;
  }

  list.innerHTML = '';
  for (const rule of rules) {
    const meta = AUTOMOD_TYPES[rule.type] || { label: rule.type, desc: '' };
    const card = document.createElement('div');
    card.style.cssText = 'border:1px solid var(--border);border-radius:8px;padding:12px 14px;margin-bottom:8px;display:flex;gap:12px;align-items:center';
    card.innerHTML = `
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;margin-bottom:3px">
          <span style="font-weight:600;font-size:14px">${meta.label}</span>
          <span style="font-size:11px;padding:2px 6px;border-radius:3px;background:${rule.enabled ? 'var(--green)' : 'var(--bg-3)'};color:${rule.enabled ? '#fff' : 'var(--text-muted)'}">
            ${rule.enabled ? 'Aktif' : 'KapalÄ±'}
          </span>
        </div>
        <div style="font-size:12px;color:var(--text-muted)">${_automodConfigSummary(rule)}</div>
      </div>
      <div style="display:flex;gap:6px;flex-shrink:0">
        <button class="btn btn-sm" onclick="toggleAutoModRule('${rule._id}',${!rule.enabled})" title="${rule.enabled ? 'Kapat' : 'AÃ§'}">
          ${rule.enabled ? 'â¸' : 'â–¶ï¸'}
        </button>
        <button class="btn btn-sm" onclick="openAutoModRuleEditor('${rule._id}')" title="DÃ¼zenle">âœï¸</button>
        <button class="btn btn-sm" style="color:var(--danger)" onclick="deleteAutoModRule('${rule._id}')" title="Sil">ğŸ—‘ï¸</button>
      </div>`;
    list.appendChild(card);
  }
}

function _automodConfigSummary(rule) {
  const c = rule.config || {};
  const parts = [];
  if (rule.type === 'blocked_words' && c.words?.length) parts.push(`${c.words.length} kelime`);
  if (rule.type === 'spam_messages') parts.push(`${c.maxMessages || 5} mesaj / ${c.windowSecs || 5}sn`);
  if (rule.type === 'caps_lock')    parts.push(`min ${c.minLength || 8} karakter`);
  if (rule.type === 'mention_spam') parts.push(`max ${c.maxMentions || 5} mention`);
  if (c.action)       parts.push(`Eylem: ${c.action === 'delete' ? 'Sil' : c.action === 'timeout' ? 'Sustur' : 'Sil + Sustur'}`);
  if (c.logChannelId) parts.push('Log: aktif');
  return parts.join(' Â· ') || 'VarsayÄ±lan ayarlar';
}

async function toggleAutoModRule(ruleId, enabled) {
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/automod/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) return toast('GÃ¼ncellenemedi', 'error');
  toast(enabled ? 'Kural aktifleÅŸtirildi' : 'Kural kapatÄ±ldÄ±', 'success');
  await refreshAutoModRules();
}

async function deleteAutoModRule(ruleId) {
  if (!confirm('Bu kuralÄ± silmek istediÄŸinizden emin misiniz?')) return;
  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/automod/${ruleId}`, { method: 'DELETE' });
  if (!r.ok) return toast('Silinemedi', 'error');
  toast('Kural silindi', 'success');
  await refreshAutoModRules();
}

function openAutoModRuleEditor(ruleId) {
  // Fetch existing rule if editing
  const doOpen = (existing) => {
    const isEdit = !!existing;
    const c = existing?.config || {};
    const type = existing?.type || '';

    _destroyTempModal();
    const modal = document.createElement('div');
    modal.id = 'temp-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%">
        <h2>${isEdit ? 'âœï¸ KuralÄ± DÃ¼zenle' : '+ Yeni Kural'}</h2>
        ${!isEdit ? `
        <div class="form-group">
          <label>Kural TÃ¼rÃ¼</label>
          <select id="am-type" class="input-field" onchange="renderAutoModConfigFields()">
            <option value="">â€” SeÃ§ â€”</option>
            ${Object.entries(AUTOMOD_TYPES).map(([k,v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
        </div>` : `<p style="color:var(--text-muted);font-size:13px;margin-bottom:12px">${AUTOMOD_TYPES[type]?.label || type}</p><input type="hidden" id="am-type" value="${type}">`}
        <div id="am-config-fields"></div>
        <div class="form-group">
          <label>Eylem</label>
          <select id="am-action" class="input-field">
            <option value="delete" ${c.action === 'delete' ? 'selected' : ''}>MesajÄ± Sil</option>
            <option value="timeout" ${c.action === 'timeout' ? 'selected' : ''}>KullanÄ±cÄ±yÄ± Sustur</option>
            <option value="delete_and_timeout" ${c.action === 'delete_and_timeout' ? 'selected' : ''}>Sil + Sustur</option>
          </select>
        </div>
        <div class="form-group" id="am-timeout-group" style="${c.action?.includes('timeout') ? '' : 'display:none'}">
          <label>Susturma SÃ¼resi (dakika)</label>
          <input type="number" id="am-timeout-min" class="input-field" value="${Math.round((c.timeoutMs||60000)/60000)}" min="1" max="10080" style="width:120px">
        </div>
        <div class="modal-footer">
          <button class="btn btn-primary" onclick="${isEdit ? `saveAutoModRule('${ruleId}')` : 'createAutoModRule()'}">
            ${isEdit ? 'Kaydet' : 'OluÅŸtur'}
          </button>
          <button class="btn" onclick="openAutoModPanel()">Ä°ptal</button>
        </div>
      </div>`;
    document.body.appendChild(modal);
    modal.onclick = e => { if (e.target === modal) openAutoModPanel(); };

    document.getElementById('am-action').onchange = () => {
      const g = document.getElementById('am-timeout-group');
      if (g) g.style.display = (document.getElementById('am-action') as HTMLInputElement | null)?.value ?? ''.includes('timeout') ? '' : 'none';
    };

    if (isEdit) renderAutoModConfigFields(c);
    else renderAutoModConfigFields();
  };

  if (ruleId) {
    apiFetch(`${API}/api/servers/${currentServer._id}/automod`).then(async r => {
      const rules = r.ok ? await r.json() : [];
      doOpen(rules.find(x => x._id === ruleId));
    });
  } else {
    doOpen(null);
  }
}

function renderAutoModConfigFields(existingConfig) {
  const type = document.getElementById('am-type')?.value;
  const c = existingConfig || {};
  const container = document.getElementById('am-config-fields');
  if (!container) return;

  container.innerHTML = '';
  if (!type) return;

  if (type === 'blocked_words') {
    container.innerHTML = `
      <div class="form-group">
        <label>YasaklÄ± Kelimeler (virgÃ¼lle ayÄ±r)</label>
        <textarea id="am-words" class="input-field" rows="3" placeholder="kelime1, kelime2, ...">${(c.words||[]).join(', ')}</textarea>
        <div style="font-size:11px;color:var(--text-muted);margin-top:4px">Max 100 kelime</div>
      </div>`;
  } else if (type === 'spam_messages') {
    container.innerHTML = `
      <div style="display:flex;gap:12px">
        <div class="form-group" style="flex:1"><label>Mesaj Limiti</label><input type="number" id="am-maxmsg" class="input-field" value="${c.maxMessages||5}" min="2" max="20"></div>
        <div class="form-group" style="flex:1"><label>SÃ¼re (saniye)</label><input type="number" id="am-window" class="input-field" value="${c.windowSecs||5}" min="1" max="60"></div>
      </div>`;
  } else if (type === 'caps_lock') {
    container.innerHTML = `<div class="form-group"><label>Min Karakter UzunluÄŸu</label><input type="number" id="am-minlen" class="input-field" value="${c.minLength||8}" min="4" max="50" style="width:100px"></div>`;
  } else if (type === 'mention_spam') {
    container.innerHTML = `<div class="form-group"><label>Mention Limiti</label><input type="number" id="am-maxmention" class="input-field" value="${c.maxMentions||5}" min="2" max="20" style="width:100px"></div>`;
  } else if (type === 'repeated_chars') {
    container.innerHTML = `<div class="form-group"><label>Min Tekrar SayÄ±sÄ±</label><input type="number" id="am-minrepeat" class="input-field" value="${c.minRepeat||10}" min="5" max="30" style="width:100px"></div>`;
  }
  // link_filter and invite_filter need no extra config
}

function _collectAutoModConfig() {
  const type   = document.getElementById('am-type')?.value;
  const action = document.getElementById('am-action')?.value || 'delete';
  const timeoutMs = parseInt(document.getElementById('am-timeout-min')?.value || '1') * 60000;
  const config = { action, timeoutMs };

  if (type === 'blocked_words') {
    const raw = document.getElementById('am-words')?.value || '';
    config.words = raw.split(',').map(w => w.trim().toLowerCase()).filter(Boolean).slice(0, 100);
    if (!config.words.length) { toast('En az bir kelime girin', 'error'); return null; }
  }
  if (type === 'spam_messages') {
    config.maxMessages = parseInt(document.getElementById('am-maxmsg')?.value) || 5;
    config.windowSecs  = parseInt(document.getElementById('am-window')?.value) || 5;
  }
  if (type === 'caps_lock')    config.minLength   = parseInt(document.getElementById('am-minlen')?.value) || 8;
  if (type === 'mention_spam') config.maxMentions = parseInt(document.getElementById('am-maxmention')?.value) || 5;
  if (type === 'repeated_chars') config.minRepeat = parseInt(document.getElementById('am-minrepeat')?.value) || 10;

  return config;
}

async function createAutoModRule() {
  const type = document.getElementById('am-type')?.value;
  if (!type) return toast('Kural tÃ¼rÃ¼ seÃ§in', 'error');
  const config = _collectAutoModConfig();
  if (!config) return;

  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/automod`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type, config, enabled: true }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'OluÅŸturulamadÄ±', 'error');
  toast('Kural oluÅŸturuldu! ğŸ›¡ï¸', 'success');
  openAutoModPanel();
}

async function saveAutoModRule(ruleId) {
  const config = _collectAutoModConfig();
  if (!config) return;

  const r = await apiFetch(`${API}/api/servers/${currentServer._id}/automod/${ruleId}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ config }),
  });
  const data = await r.json();
  if (!r.ok) return toast(data.error || 'Kaydedilemedi', 'error');
  toast('Kural gÃ¼ncellendi', 'success');
  openAutoModPanel();
}

