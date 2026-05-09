// core/server-templates-admin.js
// Sunucu Şablonları Yönetim Arayüzü
// Admin/moderatör tarafı: şablon listesi, oluştur, düzenle, sil, detay önizleme.
//
// Bağımlılıklar (global):
//   apiFetch(url, opts?)  — auth başlıklı fetch wrapper (core/api.js)
//   toast(msg, type?)     — bildirim (core/ui.js)
//   escHtml(str)          — XSS koruması (core/utils.js)
//   currentServer         — aktif sunucu objesi (core/servers.js)
//   API                   — base URL sabiti (core/api.js)
//
// HTML bağlantıları:
//   #server-templates-admin-modal  — ana modal
//   #stt-list                      — şablon kart listesi
//   #stt-form-modal                — oluştur/düzenle form modal'ı
//   #stt-detail-modal              — detay önizleme modal'ı

'use strict';

// ── Durum ─────────────────────────────────────────────────────
let _sttTemplates   = [];    // sunucudan çekilen şablon listesi
let _sttEditId      = null;  // düzenleme modunda şablon ID'si (null = yeni)
let _sttDetailId    = null;  // önizlenen şablon ID'si

// ── Modal aç/kapat ────────────────────────────────────────────

/** Şablon yönetim modalını açar ve listeyi yükler */
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

// ── Liste yükleme ─────────────────────────────────────────────

async function _sttLoadList() {
  const listEl = document.getElementById('stt-list');
  if (!listEl) return;

  listEl.innerHTML = '<div class="stt-loading">Yükleniyor…</div>';
  try {
    const r = await apiFetch(`${API}/api/server-templates`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    _sttTemplates = await r.json();
    _sttRenderList(listEl);
  } catch (err) {
    listEl.innerHTML = `<div class="stt-error">⚠️ Şablonlar yüklenemedi: ${escHtml(err.message)}</div>`;
  }
}

function _sttRenderList(listEl) {
  if (!_sttTemplates.length) {
    listEl.innerHTML = '<div class="stt-empty">Henüz şablon yok. İlk şablonu oluşturun!</div>';
    return;
  }
  listEl.innerHTML = _sttTemplates.map(t => `
    <div class="stt-card" data-id="${escHtml(t._id || t.id)}">
      <div class="stt-card-icon">${escHtml(t.icon || '📋')}</div>
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
          ${t.createdAt ? `<span>Oluşturuldu: ${_sttFmtDate(t.createdAt)}</span>` : ''}
          ${t.isBuiltin  ? '<span class="stt-badge-builtin">Yerleşik</span>' : ''}
        </div>
      </div>
      <div class="stt-card-actions">
        <button class="btn-icon" title="Önizle"
          onclick="sttOpenDetail('${escHtml(t._id || t.id)}')">👁️</button>
        <button class="btn-icon" title="Düzenle"
          onclick="sttOpenEdit('${escHtml(t._id || t.id)}')">✏️</button>
        <button class="btn-icon stt-btn-delete" title="Sil"
          onclick="sttDelete('${escHtml(t._id || t.id)}','${escHtml(t.name)}')">🗑️</button>
      </div>
    </div>
  `).join('');
}

// ── Oluştur / Düzenle Modal ───────────────────────────────────

/** Yeni şablon formu */
function sttOpenCreate() {
  _sttEditId = null;
  _sttShowFormModal({
    name: '', icon: '📋', description: '', tags: '',
  });
}

/** Mevcut şablonu düzenlemek için form aç */
function sttOpenEdit(id) {
  const tpl = _sttTemplates.find(t => (t._id || t.id) === id);
  if (!tpl) return toast('Şablon bulunamadı', 'error');
  _sttEditId = id;
  _sttShowFormModal({
    name:        tpl.name        || '',
    icon:        tpl.icon        || '📋',
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

  const title = _sttEditId ? 'Şablonu Düzenle' : 'Yeni Şablon';
  modal.innerHTML = `
    <div class="modal" style="max-width:480px;width:92%">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">${title}</h3>
        <button class="modal-close" onclick="sttCloseFormModal()">✕</button>
      </div>
      <div class="modal-body" style="padding:20px;display:flex;flex-direction:column;gap:14px">

        <label class="stt-label">
          <span>İkon</span>
          <div style="display:flex;gap:8px;align-items:center">
            <input id="stt-f-icon" type="text" maxlength="4" value="${escHtml(data.icon)}"
              style="width:56px;text-align:center;font-size:24px" class="input-field"
              oninput="document.getElementById('stt-icon-preview').textContent=this.value||'📋'">
            <span id="stt-icon-preview" style="font-size:32px">${data.icon || '📋'}</span>
          </div>
        </label>

        <label class="stt-label">
          <span>Şablon Adı <span style="color:var(--danger)">*</span></span>
          <input id="stt-f-name" type="text" maxlength="50" value="${escHtml(data.name)}"
            placeholder="Örnek: Oyun Topluluğu" class="input-field">
        </label>

        <label class="stt-label">
          <span>Açıklama</span>
          <textarea id="stt-f-desc" maxlength="200" rows="2"
            placeholder="Bu şablon ne için?" class="input-field"
            style="resize:vertical">${escHtml(data.description)}</textarea>
        </label>

        <label class="stt-label">
          <span>Etiketler <span style="color:var(--text-muted);font-size:11px">(virgülle ayır)</span></span>
          <input id="stt-f-tags" type="text" value="${escHtml(data.tags)}"
            placeholder="oyun, topluluk, eğlence" class="input-field">
        </label>

        <div id="stt-form-error" style="color:var(--danger);font-size:12px;display:none"></div>
      </div>
      <div class="modal-footer" style="padding:14px 20px;display:flex;justify-content:flex-end;gap:8px;
        border-top:1px solid var(--border)">
        <button class="btn-secondary" onclick="sttCloseFormModal()">İptal</button>
        <button class="btn-primary" id="stt-save-btn" onclick="sttSaveForm()">
          ${_sttEditId ? 'Kaydet' : 'Oluştur'}
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
  const icon  = document.getElementById('stt-f-icon')?.value?.trim() || '📋';
  const desc  = document.getElementById('stt-f-desc')?.value?.trim();
  const tags  = document.getElementById('stt-f-tags')?.value
    ?.split(',').map(t => t.trim()).filter(Boolean) || [];
  const errEl = document.getElementById('stt-form-error');
  const btn   = document.getElementById('stt-save-btn');

  if (!name) {
    errEl.textContent = 'Şablon adı zorunludur.';
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
  btn.textContent = isEdit ? 'Kaydediliyor…' : 'Oluşturuluyor…';

  try {
    const r = await apiFetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);

    toast(isEdit ? 'Şablon güncellendi' : 'Şablon oluşturuldu', 'success');
    sttCloseFormModal();
    await _sttLoadList();
  } catch (err) {
    errEl.textContent = err.message;
    errEl.style.display = '';
    btn.disabled = false;
    btn.textContent = isEdit ? 'Kaydet' : 'Oluştur';
  }
}

// ── Silme ─────────────────────────────────────────────────────

async function sttDelete(id, name) {
  if (!confirm(`"${name}" şablonunu silmek istediğine emin misin? Bu işlem geri alınamaz.`)) return;
  try {
    const r = await apiFetch(`${API}/api/server-templates/${id}`, { method: 'DELETE' });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
    toast('Şablon silindi', 'success');
    await _sttLoadList();
  } catch (err) {
    toast(`Silinemedi: ${err.message}`, 'error');
  }
}

// ── Detay Önizleme ────────────────────────────────────────────

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
        <h3 style="margin:0;font-size:16px">Şablon Önizleme</h3>
        <button class="modal-close" onclick="sttCloseDetail()">✕</button>
      </div>
      <div class="modal-body" id="stt-detail-body"
        style="padding:20px;overflow-y:auto;max-height:60vh">
        <div class="stt-loading">Yükleniyor…</div>
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
      `<div class="stt-error">⚠️ Detay yüklenemedi: ${escHtml(err.message)}</div>`;
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
      <span style="font-size:3rem">${escHtml(tpl.icon || '📋')}</span>
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

    <div style="font-weight:600;font-size:13px;color:var(--text-2);margin-bottom:10px">Kanal Yapısı</div>
    ${cats.map(cat => `
      <div class="stt-cat-group">
        <div class="stt-cat-name"># ${escHtml(cat.name)}</div>
        ${(cat.channels || []).map(ch => `
          <div class="stt-ch-item">
            <span class="stt-ch-icon">${
              ch.type === 'voice' ? '🔊'
              : ch.type === 'stage' ? '🎭'
              : ch.type === 'forum' ? '💬'
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
        ✏️ Düzenle
      </button>
    </div>`;
}

// ── Ana Modal (dinamik injection) ─────────────────────────────

function _injectTemplatesAdminModal() {
  const modal = document.createElement('div');
  modal.id = 'server-templates-admin-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal" style="max-width:680px;width:96%;max-height:90vh;display:flex;flex-direction:column">
      <div class="modal-header">
        <h3 style="margin:0;font-size:16px">📋 Sunucu Şablonları</h3>
        <button class="modal-close" onclick="closeServerTemplatesAdmin()">✕</button>
      </div>
      <div style="padding:12px 20px;border-bottom:1px solid var(--border);
        display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:13px;color:var(--text-muted)">
          Tüm şablonları buradan yönet. Yerleşik şablonlar kısmen düzenlenebilir.
        </span>
        <button class="btn-primary" onclick="sttOpenCreate()" style="white-space:nowrap">
          + Yeni Şablon
        </button>
      </div>
      <div id="stt-list" style="padding:16px;overflow-y:auto;flex:1;display:flex;
        flex-direction:column;gap:10px">
        <div class="stt-loading">Yükleniyor…</div>
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

// ── CSS Injection ─────────────────────────────────────────────

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

// ── Yardımcılar ───────────────────────────────────────────────

function _sttFmtDate(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleDateString('tr-TR', { day: '2-digit', month: 'short', year: 'numeric' });
}

// ── Public API ────────────────────────────────────────────────
// Tüm fonksiyonlar window'a atanarak HTML onclick ile erişilebilir yapılır.
// Modül sistemi yoksa global scope zaten yeterli; modül sistemi varsa export ekle.
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

export {
  closeServerTemplatesAdmin,
  openServerTemplatesAdmin,
  sttCloseDetail,
  sttCloseFormModal,
  sttDelete,
  sttOpenCreate,
  sttOpenDetail,
  sttOpenEdit,
  sttSaveForm,
};

