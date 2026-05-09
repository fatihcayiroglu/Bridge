// core/server-templates-admin.js
// Sunucu ÅablonlarÄ± YÃ¶netim ArayÃ¼zÃ¼
// Admin/moderatÃ¶r tarafÄ±: ÅŸablon listesi, oluÅŸtur, dÃ¼zenle, sil, detay Ã¶nizleme.
//
// BaÄŸÄ±mlÄ±lÄ±klar (global):
//   apiFetch(url, opts?)  â€” auth baÅŸlÄ±klÄ± fetch wrapper (core/api.js)
//   toast(msg, type?)     â€” bildirim (core/ui.js)
//   escHtml(str)          â€” XSS korumasÄ± (core/utils.js)
//   currentServer         â€” aktif sunucu objesi (core/servers.js)
//   API                   â€” base URL sabiti (core/api.js)
//
// HTML baÄŸlantÄ±larÄ±:
//   #server-templates-admin-modal  â€” ana modal
//   #stt-list                      â€” ÅŸablon kart listesi
//   #stt-form-modal                â€” oluÅŸtur/dÃ¼zenle form modal'Ä±
//   #stt-detail-modal              â€” detay Ã¶nizleme modal'Ä±

'use strict';

// â”€â”€ Durum â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
let _sttTemplates   = [];    // sunucudan Ã§ekilen ÅŸablon listesi
let _sttEditId      = null;  // dÃ¼zenleme modunda ÅŸablon ID'si (null = yeni)
let _sttDetailId    = null;  // Ã¶nizlenen ÅŸablon ID'si

// â”€â”€ Modal aÃ§/kapat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Åablon yÃ¶netim modalÄ±nÄ± aÃ§ar ve listeyi yÃ¼kler */
async function openServerTemplatesAdmin() {
  const modal = document.getElementById('server-templates-admin-modal');
  if (!modal) return _injectTemplatesAdminModal();
  modal.style.display = 'flex';
  await _sttLoadList();
}

function closeServerTemplatesAdmin() {
  const modal = document.getElementById('server-templates-admin-modal');
  if (modal) modal.style.display = 'none';
}

// â”€â”€ Liste yÃ¼kleme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function _sttLoadList() {
  const listEl = document.getElementById('stt-list');
  if (!listEl) return;

  listEl.innerHTML = '<div class="stt-loading">YÃ¼kleniyorâ€¦</div>';
  try {
    const r = await apiFetch(`${API}/api/server-templates`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _sttTemplates = await r.json();
    _sttRenderList(listEl);
  } catch (err) {
    listEl.innerHTML = `<div class="stt-error">âš ï¸ Åablonlar yÃ¼klenemedi: ${escHtml(err.message)}</div>`;
  }
}

function _sttRenderList(listEl) {
  if (!_sttTemplates.length) {
    listEl.innerHTML = '<div class="stt-empty">HenÃ¼z ÅŸablon yok. Ä°lk ÅŸablonu oluÅŸturun!</div>';
    return;
  }
  listEl.innerHTML = _sttTemplates.map(t => `
    <div class="stt-card" data-id="${escHtml(t._id || t.id)}">
      <div class="stt-card-icon">${escHtml(t.icon || 'ğŸ“‹')}</div>
      <div class="stt-card-body">
        <div class="stt-card-name">${escHtml(t.name)}</div>
        <div class="stt-card-desc">${escHtml(t.description || '')}</div>
        <div class="stt-card-tags">
          ${(t.tags || []).map(tag =>
            `<span class="stt-tag">${escHtml(tag)}</span>`
          ).join('')}
        </div>
        <div class="stt-card-meta">
          ${t.channelCount !== undefined ? `<span>${t.channelCount} kanal</span>` : ''}
          ${t.createdAt ? `<span>OluÅŸturuldu: ${_sttFmtDate(t.createdAt)}</span>` : ''}
          ${t.isBuiltin  ? '<span class="stt-badge-builtin">YerleÅŸik</span>' : ''}
        </div>
      </div>
      <div class="stt-card-actions">
        <button class="btn-icon" title="Ã–nizle"
          onclick="sttOpenDetail('${escHtml(t._id || t.id)}')">ğŸ‘ï¸</button>
        <button class="btn-icon" title="DÃ¼zenle"
          onclick="sttOpenEdit('${escHtml(t._id || t.id)}')">âœï¸</button>
        <button class="btn-icon stt-btn-delete" title="Sil"
          onclick="sttDelete('${escHtml(t._id || t.id)}','${escHtml(t.name)}')">ğŸ—‘ï¸</button>
      </div>
    </div>
  `).join('');
}

// â”€â”€ OluÅŸtur / DÃ¼zenle Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

/** Yeni ÅŸablon formu */
function sttOpenCreate() {
  _sttEditId = null;
  _sttShowFormModal({
    name: '', icon: 'ğŸ“‹', description: '', tags: '',
  });
}

/** Mevcut ÅŸablonu dÃ¼zenlemek iÃ§in form aÃ§ */
function sttOpenEdit(id) {
  const tpl = _sttTemplates.find(t => (t._id || t.id) === id);
  if (!tpl) return toast('Åablon bulunamadÄ±', 'error');
  _sttEditId = id;
  _sttShowFormModal({
    name:        tpl.name        || '',
    icon:        tpl.icon        || 'ğŸ“‹',
    description: tpl.description || '',
    tags:        (tpl.tags || []).join(', '),
  });
}

function _sttShowFormModal(data) {
  let modal = document.getElementById('stt-form-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'stt-form-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }

  const title = _sttEditId ? 'Åablonu DÃ¼zenle' : 'Yeni Åablon';
  modal.innerHTML = `
    <div class="modal" style="max-width:480px;width:92%">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">${title}</h3>
        <button class="modal-close" onclick="sttCloseFormModal()">âœ•</button>
      </div>
      <div class="modal-body" style="padding:20px;display:flex;flex-direction:column;gap:14px">

        <label class="stt-label">
          <span>Ä°kon</span>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="stt-f-icon" type="text" maxlength="4" value="${escHtml(data.icon)}"
              style="width:56px;text-align:center;font-size:24px" class="input-field"
              oninput="document.getElementById('stt-icon-preview').textContent=this.value||'ğŸ“‹'">
            <span id="stt-icon-preview" style="font-size:32px">${data.icon || 'ğŸ“‹'}</span>
          </div>
        </label>

        <label class="stt-label">
          <span>Åablon AdÄ± <span style="color:var(--danger)">*</span></span>
          <input id="stt-f-name" type="text" maxlength="50" value="${escHtml(data.name)}"
            placeholder="Ã–rnek: Oyun TopluluÄŸu" class="input-field">
        </label>

        <label class="stt-label">
          <span>AÃ§Ä±klama</span>
          <textarea id="stt-f-desc" maxlength="200" rows="2"
            placeholder="Bu ÅŸablon ne iÃ§in?" class="input-field"
            style="resize:vertical">${escHtml(data.description)}</textarea>
        </label>

        <label class="stt-label">
          <span>Etiketler <span style="color:var(--text-muted);font-size:11px">(virgÃ¼lle ayÄ±r)</span></span>
          <input id="stt-f-tags" type="text" value="${escHtml(data.tags)}"
            placeholder="oyun, topluluk, eÄŸlence" class="input-field">
        </label>

        <div id="stt-form-error" style="color:var(--danger);font-size:12px;display:none"></div>
      </div>
      <div class="modal-footer" style="padding:14px 20px;display:flex;justify-content:flex-end;gap:8px;
        border-top:1px solid var(--border)">
        <button class="btn-secondary" onclick="sttCloseFormModal()">Ä°ptal</button>
        <button class="btn-primary" id="stt-save-btn" onclick="sttSaveForm()">
          ${_sttEditId ? 'Kaydet' : 'OluÅŸtur'}
        </button>
      </div>
    </div>`;

  modal.style.display = 'flex';
}

function sttCloseFormModal() {
  const modal = document.getElementById('stt-form-modal');
  if (modal) modal.style.display = 'none';
}

async function sttSaveForm() {
  const name  = document.getElementById('stt-f-name')?.value?.trim();
  const icon  = document.getElementById('stt-f-icon')?.value?.trim() || 'ğŸ“‹';
  const desc  = document.getElementById('stt-f-desc')?.value?.trim();
  const tags  = document.getElementById('stt-f-tags')?.value
    ?.split(',').map(t => t.trim()).filter(Boolean) || [];
  const errEl = document.getElementById('stt-form-error');
  const btn   = document.getElementById('stt-save-btn');

  if (!name) {
    errEl.textContent = 'Åablon adÄ± zorunludur.';
    errEl.style.display = '';
    return;
  }
  errEl.style.display = 'none';

  const payload = { name, icon, description: desc, tags };
  const isEdit  = !!_sttEditId;
  const url     = isEdit
    ? `${API}/api/server-templates/${_sttEditId}`
    : `${API}/api/server-templates`;
  const method  = isEdit ? 'PUT' : 'POST';

  btn.disabled = true;
  btn.textContent = isEdit ? 'Kaydediliyorâ€¦' : 'OluÅŸturuluyorâ€¦';

  try {
    const r = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    toast(isEdit ? 'Åablon gÃ¼ncellendi' : 'Åablon oluÅŸturuldu', 'success');
    sttCloseFormModal();
    await _sttLoadList();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = isEdit ? 'Kaydet' : 'OluÅŸtur';
  }
}

// â”€â”€ Silme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sttDelete(id, name) {
  if (!confirm(`"${name}" ÅŸablonunu silmek istediÄŸine emin misin? Bu iÅŸlem geri alÄ±namaz.`)) return;
  try {
    const r = await apiFetch(`${API}/api/server-templates/${id}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    toast('Åablon silindi', 'success');
    await _sttLoadList();
  } catch (err) {
    toast(`Silinemedi: ${err.message}`, 'error');
  }
}

// â”€â”€ Detay Ã–nizleme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

async function sttOpenDetail(id) {
  _sttDetailId = id;
  let modal = document.getElementById('stt-detail-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'stt-detail-modal';
    modal.className = 'modal-overlay';
    document.body.appendChild(modal);
  }

  modal.innerHTML = `
    <div class="modal" style="max-width:520px;width:92%;max-height:85vh">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">Åablon Ã–nizleme</h3>
        <button class="modal-close" onclick="sttCloseDetail()">âœ•</button>
      </div>
      <div class="modal-body" id="stt-detail-body"
        style="padding:20px;overflow-y:auto;max-height:60vh">
        <div class="stt-loading">YÃ¼kleniyorâ€¦</div>
      </div>
    </div>`;
  modal.style.display = 'flex';

  try {
    const r = await apiFetch(`${API}/api/server-templates/${id}`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const tpl = await r.json();
    _sttRenderDetail(document.getElementById('stt-detail-body'), tpl);
  } catch (err) {
    document.getElementById('stt-detail-body').innerHTML =
      `<div class="stt-error">âš ï¸ Detay yÃ¼klenemedi: ${escHtml(err.message)}</div>`;
  }
}

function sttCloseDetail() {
  const modal = document.getElementById('stt-detail-modal');
  if (modal) modal.style.display = 'none';
  _sttDetailId = null;
}

function _sttRenderDetail(container, tpl) {
  const cats = tpl.categories || [];
  const totalChannels = cats.reduce((s, c) => s + (c.channels?.length || 0), 0);

  container.innerHTML = `
    <div style="display:flex;align-items:center;gap:16px;margin-bottom:20px">
      <span style="font-size:3rem">${escHtml(tpl.icon || 'ğŸ“‹')}</span>
      <div>
        <div style="font-weight:700;font-size:18px;color:var(--text-1)">${escHtml(tpl.name)}</div>
        <div style="font-size:13px;color:var(--text-muted);margin-top:4px">${escHtml(tpl.description || '')}</div>
        <div style="display:flex;gap:5px;flex-wrap:wrap;margin-top:8px">
          ${(tpl.tags || []).map(tag => `<span class="stt-tag">${escHtml(tag)}</span>`).join('')}
        </div>
      </div>
    </div>

    <div style="display:flex;gap:16px;margin-bottom:16px">
      <div class="stt-stat"><span class="stt-stat-n">${cats.length}</span><span>kategori</span></div>
      <div class="stt-stat"><span class="stt-stat-n">${totalChannels}</span><span>kanal</span></div>
    </div>

    <div style="font-weight:600;font-size:13px;color:var(--text-2);margin-bottom:10px">Kanal YapÄ±sÄ±</div>
    ${cats.map(cat => `
      <div class="stt-cat-group">
        <div class="stt-cat-name"># ${escHtml(cat.name)}</div>
        ${(cat.channels || []).map(ch => `
          <div class="stt-ch-item">
            <span class="stt-ch-icon">${
              ch.type === 'voice' ? 'ğŸ”Š'
              : ch.type === 'stage' ? 'ğŸ­'
              : ch.type === 'forum' ? 'ğŸ’¬'
              : '#'
            }</span>
            <span class="stt-ch-name">${escHtml(ch.name)}</span>
            ${ch.topic ? `<span class="stt-ch-topic">${escHtml(ch.topic)}</span>` : ''}
          </div>`).join('')}
      </div>`).join('')}

    <div style="display:flex;justify-content:flex-end;gap:8px;margin-top:20px;
      padding-top:16px;border-top:1px solid var(--border)">
      <button class="btn-secondary" onclick="sttCloseDetail()">Kapat</button>
      <button class="btn-primary" onclick="sttCloseDetail();sttOpenEdit('${escHtml(tpl._id || tpl.id)}')">
        âœï¸ DÃ¼zenle
      </button>
    </div>`;
}

// â”€â”€ Ana Modal (dinamik injection) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _injectTemplatesAdminModal() {
  const modal = document.createElement('div');
  modal.id = 'server-templates-admin-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:680px;width:96%;max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">ğŸ“‹ Sunucu ÅablonlarÄ±</h3>
        <button class="modal-close" onclick="closeServerTemplatesAdmin()">âœ•</button>
      </div>
      <div style="padding:12px 20px;border-bottom:1px solid var(--border);
        display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--text-muted)">
          TÃ¼m ÅŸablonlarÄ± buradan yÃ¶net. YerleÅŸik ÅŸablonlar kÄ±smen dÃ¼zenlenebilir.
        </span>
        <button class="btn-primary" onclick="sttOpenCreate()" style="white-space:nowrap">
          + Yeni Åablon
        </button>
      </div>
      <div id="stt-list" style="padding:16px;overflow-y:auto;flex:1;display:flex;
        flex-direction:column;gap:10px">
        <div class="stt-loading">YÃ¼kleniyorâ€¦</div>
      </div>
      <div class="modal-footer" style="padding:12px 20px;border-top:1px solid var(--border);
        display:flex;justify-content:flex-end">
        <button class="btn-secondary" onclick="closeServerTemplatesAdmin()">Kapat</button>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.style.display = 'flex';
  _sttLoadList();
}

// â”€â”€ CSS Injection â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

(function _injectSttStyles() {
  if (document.getElementById('stt-admin-styles')) return;
  const s = document.createElement('style');
  s.id = 'stt-admin-styles';
  s.textContent = `
    .stt-card {
      display: flex; align-items: flex-start; gap: 14px;
      padding: 14px; background: var(--bg-3); border-radius: 10px;
      border: 2px solid transparent; transition: border-color .15s;
    }
    .stt-card:hover { border-color: var(--brand-light, rgba(88,101,242,.35)); }
    .stt-card-icon  { font-size: 2.2rem; flex-shrink: 0; line-height: 1; }
    .stt-card-body  { flex: 1; min-width: 0; }
    .stt-card-name  { font-weight: 700; font-size: 14px; color: var(--text-1); }
    .stt-card-desc  {
      font-size: 12px; color: var(--text-muted); margin-top: 3px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .stt-card-tags  { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
    .stt-card-meta  {
      display: flex; gap: 10px; flex-wrap: wrap;
      font-size: 11px; color: var(--text-muted); margin-top: 6px;
    }
    .stt-tag {
      background: var(--bg-2); border-radius: 999px;
      padding: 2px 8px; font-size: 10px; color: var(--text-muted);
    }
    .stt-badge-builtin {
      background: var(--brand); color: #fff;
      border-radius: 999px; padding: 1px 7px; font-size: 10px;
    }
    .stt-card-actions {
      display: flex; flex-direction: column; gap: 6px; flex-shrink: 0;
    }
    .stt-btn-delete:hover { color: var(--danger) !important; }
    .stt-loading { color: var(--text-muted); text-align: center; padding: 30px; }
    .stt-empty   { color: var(--text-muted); text-align: center; padding: 40px; }
    .stt-error   { color: var(--danger); text-align: center; padding: 20px; }
    .stt-label   {
      display: flex; flex-direction: column; gap: 5px;
      font-size: 12px; font-weight: 600; color: var(--text-2);
    }
    .stt-stat {
      background: var(--bg-3); border-radius: 8px; padding: 10px 16px;
      text-align: center; display: flex; flex-direction: column; gap: 2px;
      font-size: 11px; color: var(--text-muted); flex: 1;
    }
    .stt-stat-n { font-size: 20px; font-weight: 700; color: var(--text-1); }
    .stt-cat-group { margin-bottom: 12px; }
    .stt-cat-name  {
      font-size: 11px; font-weight: 700; color: var(--text-muted);
      text-transform: uppercase; letter-spacing: .5px; margin-bottom: 4px;
    }
    .stt-ch-item {
      display: flex; align-items: center; gap: 8px;
      padding: 4px 8px; border-radius: 5px; font-size: 13px;
    }
    .stt-ch-item:hover { background: var(--bg-3); }
    .stt-ch-icon  { flex-shrink: 0; width: 18px; text-align: center; }
    .stt-ch-name  { font-weight: 500; color: var(--text-1); }
    .stt-ch-topic {
      color: var(--text-muted); font-size: 11px;
      overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
      flex: 1;
    }
  `;
  document.head.appendChild(s);
})();

// â”€â”€ YardÄ±mcÄ±lar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

function _sttFmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

// â”€â”€ Public API â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// TÃ¼m fonksiyonlar window'a atanarak HTML onclick ile eriÅŸilebilir yapÄ±lÄ±r.
// ModÃ¼l sistemi yoksa global scope zaten yeterli; modÃ¼l sistemi varsa export ekle.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    openServerTemplatesAdmin,
    closeServerTemplatesAdmin,
    sttOpenCreate,
    sttOpenEdit,
    sttDelete,
    sttOpenDetail,
    sttCloseDetail,
    sttSaveForm,
    sttCloseFormModal,
  };
}

