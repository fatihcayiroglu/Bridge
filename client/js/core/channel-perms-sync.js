// client/js/core/channel-perms-sync.js
// ══════════════════════════════════════════════════
// Kategori Senkronizasyonu sekmesi + Bulk Sync önizleme modalı
// ══════════════════════════════════════════════════
'use strict';

let _syncChannels = [];

// ── SYNC KANAL LİSTESİ ───────────────────────────────────────

window.chpermsLoadSyncList = async function (channelId) {
  const listEl = document.getElementById('chperms-sync-channel-list');
  if (!listEl) return;
  listEl.innerHTML = '<p style="color:var(--text-3);font-size:12px">Yükleniyor…</p>';

  try {
    const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels`);
    const allCh = Array.isArray(data) ? data : (data.channels || []);
    _syncChannels = allCh.filter(c =>
      c._id !== channelId &&
      (c.type === 'text' || c.type === 'TEXT' || !c.type || c.type === 'voice' || c.type === 'VOICE')
    );

    if (_syncChannels.length === 0) {
      listEl.innerHTML = '<p style="color:var(--text-3);font-size:12px">Senkronize edilebilecek başka kanal yok.</p>';
      return;
    }

    // Kategoriye göre grupla
    const grouped = {};
    for (const ch of _syncChannels) {
      const cat = ch.categoryId || ch.category || '__none__';
      if (!grouped[cat]) grouped[cat] = [];
      grouped[cat].push(ch);
    }

    let html = '';
    for (const [catId, channels] of Object.entries(grouped)) {
      const catName = catId === '__none__' ? '📁 Kategorisiz' : `📁 ${escHtml(catId)}`;
      html += `
        <div style="margin-bottom:10px">
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
            <span style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase">${catName}</span>
            <button onclick="chpermsSyncSelectCat('${catId}',true)"
              style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid var(--bg-4);
                     background:var(--bg-3);cursor:pointer;color:var(--text-2)">Hepsini Seç</button>
          </div>
          ${channels.map(ch => {
            const icon = (ch.type === 'voice' || ch.type === 'VOICE') ? '🔊' : '#';
            return `<label style="display:flex;align-items:center;gap:8px;padding:5px 8px;
                        border-radius:6px;cursor:pointer"
                        onmouseenter="this.style.background='var(--bg-3)'"
                        onmouseleave="this.style.background=''">
              <input type="checkbox" class="chperms-sync-cb" data-id="${ch._id}" data-cat="${catId}"
                style="width:15px;height:15px;cursor:pointer">
              <span style="font-size:13px">${icon} ${escHtml(ch.name)}</span>
            </label>`;
          }).join('')}
        </div>`;
    }
    listEl.innerHTML = html;
    _updateSyncCount();
    listEl.querySelectorAll('.chperms-sync-cb').forEach(cb =>
      cb.addEventListener('change', _updateSyncCount)
    );
  } catch {
    listEl.innerHTML = '<p style="color:var(--danger,#ed4245);font-size:12px">Kanallar yüklenemedi.</p>';
  }
};

function _updateSyncCount() {
  const cnt = document.querySelectorAll('.chperms-sync-cb:checked').length;
  const el  = document.getElementById('chperms-sync-count');
  if (el) el.textContent = cnt > 0 ? `${cnt} kanal seçili` : '';
}

window.chpermsSyncSelectAll = function (val) {
  document.querySelectorAll('.chperms-sync-cb').forEach(cb => cb.checked = val);
  _updateSyncCount();
};

window.chpermsSyncSelectCat = function (catId, val) {
  document.querySelectorAll(`.chperms-sync-cb[data-cat="${catId}"]`).forEach(cb => cb.checked = val);
  _updateSyncCount();
};

// ── BULK SYNC ÖNİZLEME ───────────────────────────────────────

window.chpermsBulkSyncPreview = async function (channelId) {
  const checkedIds = [...document.querySelectorAll('.chperms-sync-cb:checked')].map(cb => cb.dataset.id);
  if (checkedIds.length === 0) { toast('Hiç kanal seçilmedi', 'error'); return; }

  const statusEl = document.getElementById('chperms-sync-status');
  if (statusEl) statusEl.textContent = 'Önizleme yükleniyor…';

  let overrides = [];
  try {
    const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
    overrides = _extractOverrides(data);
  } catch {
    toast('Kaynak kanal izinleri alınamadı', 'error');
    if (statusEl) statusEl.textContent = '';
    return;
  }

  let preview = null;
  try {
    preview = await apiFetch(
      `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/bulk-sync/preview`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: checkedIds, overrides }) }
    );
  } catch {
    toast('Önizleme yüklenemedi', 'error');
    if (statusEl) statusEl.textContent = '';
    return;
  }
  if (statusEl) statusEl.textContent = '';

  _showSyncPreviewModal(channelId, checkedIds, overrides, preview);
};

function _extractOverrides(data) {
  return (data.overrides || []).map(o => ({
    roleId: o.roleId, allow: o.allow ?? 0, deny: o.deny ?? 0,
    targetType: o.targetType, targetId: o.targetId, targetName: o.targetName,
  }));
}

function _showSyncPreviewModal(channelId, checkedIds, overrides, preview) {
  document.getElementById('chperms-preview-modal')?.remove();

  const { summary, preview: rows } = preview;
  const noChanges = rows.every(r => r.totalChanges === 0);

  const rowsHtml = rows.map(ch => {
    const hasChange = ch.totalChanges > 0;
    const badges = [];
    if (ch.added)   badges.push(`<span style="background:var(--green-bg,rgba(59,165,92,.15));color:var(--online,#3ba55c);
      padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">+${ch.added} ekle</span>`);
    if (ch.updated) badges.push(`<span style="background:rgba(250,166,26,.15);color:#faa61a;
      padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">~${ch.updated} güncelle</span>`);
    if (ch.removed) badges.push(`<span style="background:rgba(237,66,69,.12);color:var(--danger,#ed4245);
      padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">-${ch.removed} sil</span>`);
    if (!hasChange)  badges.push(`<span style="color:var(--text-3);font-size:10px">değişiklik yok</span>`);
    const icon = ch.channelType === 'voice' ? '🔊' : '#';
    return `<tr style="${hasChange ? '' : 'opacity:.5'}">
      <td style="padding:6px 10px;font-size:13px">${icon} ${escHtml(ch.channelName)}</td>
      <td style="padding:6px 10px">${badges.join(' ')}</td>
    </tr>`;
  }).join('');

  const modal = document.createElement('div');
  modal.id = 'chperms-preview-modal';
  modal.style.cssText = 'position:fixed;inset:0;z-index:20000;background:rgba(0,0,0,.7);'
    + 'display:flex;align-items:center;justify-content:center';
  modal.innerHTML = `
    <div style="background:var(--bg-1);border-radius:14px;padding:0;max-width:560px;width:94%;
         max-height:85vh;display:flex;flex-direction:column;box-shadow:var(--shadow-lg)">

      <div style="padding:18px 22px 14px;border-bottom:1px solid var(--bg-4)">
        <h3 style="margin:0;font-size:16px;font-weight:800">🔍 Senkronizasyon Önizlemesi</h3>
        <p style="margin:4px 0 0;font-size:12px;color:var(--text-3)">
          Aşağıdaki değişiklikler uygulanacak — devam etmek istiyor musun?
        </p>
      </div>

      <div style="display:flex;gap:12px;padding:14px 22px;border-bottom:1px solid var(--bg-4);flex-wrap:wrap">
        ${_summaryBox(summary.channelsWithChanges, 'var(--text-1)', 'etkilenen kanal')}
        ${_summaryBox(summary.totalAdded,          'var(--online,#3ba55c)', 'eklenecek')}
        ${_summaryBox(summary.totalUpdated,        '#faa61a',               'güncellenecek')}
        ${_summaryBox(summary.totalRemoved,        'var(--danger,#ed4245)', 'silinecek')}
      </div>

      ${noChanges ? `<div style="padding:16px 22px;font-size:13px;color:var(--text-3)">
        ℹ️ Seçili kanallarda zaten aynı izinler mevcut — uygulanacak değişiklik yok.
      </div>` : ''}

      <div style="flex:1;overflow-y:auto;padding:10px 22px">
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="border-bottom:1px solid var(--bg-4)">
              <th style="text-align:left;padding:5px 10px;font-size:11px;color:var(--text-3);font-weight:600">Kanal</th>
              <th style="text-align:left;padding:5px 10px;font-size:11px;color:var(--text-3);font-weight:600">Yapılacak işlem</th>
            </tr>
          </thead>
          <tbody>${rowsHtml}</tbody>
        </table>
      </div>

      <div style="padding:14px 22px;border-top:1px solid var(--bg-4);display:flex;justify-content:flex-end;gap:10px">
        <button class="btn" id="chperms-preview-cancel">İptal</button>
        <button class="btn btn-primary" id="chperms-preview-confirm"
          ${noChanges ? 'disabled' : ''}
          style="font-weight:700">
          ${noChanges ? '— Değişiklik Yok' : `🔁 ${summary.channelsWithChanges} Kanala Uygula`}
        </button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.querySelector('#chperms-preview-cancel').onclick  = () => modal.remove();
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
  modal.querySelector('#chperms-preview-confirm').onclick = async () => {
    modal.remove();
    await chpermsBulkSync(channelId, checkedIds, overrides);
  };
}

function _summaryBox(value, color, label) {
  return `<div style="text-align:center;flex:1;min-width:80px">
    <div style="font-size:22px;font-weight:800;color:${color}">${value}</div>
    <div style="font-size:11px;color:var(--text-3)">${label}</div>
  </div>`;
}

// ── BULK SYNC UYGULA ─────────────────────────────────────────

window.chpermsBulkSync = async function (channelId, checkedIds, overrides) {
  if (!checkedIds) {
    checkedIds = [...document.querySelectorAll('.chperms-sync-cb:checked')].map(cb => cb.dataset.id);
    if (checkedIds.length === 0) { toast('Hiç kanal seçilmedi', 'error'); return; }
  }

  if (!overrides) {
    try {
      const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
      overrides = _extractOverrides(data);
    } catch {
      toast('Kaynak kanal izinleri alınamadı', 'error');
      return;
    }
  }

  const statusEl = document.getElementById('chperms-sync-status');
  if (statusEl) statusEl.textContent = 'Uygulanıyor…';

  try {
    const res = await apiFetch(
      `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/bulk-sync`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channelIds: checkedIds, overrides }),
      }
    );
    if (statusEl) statusEl.textContent = '';
    toast(`✅ ${res.updated ?? checkedIds.length} kanala uygulandı`, 'success');
    document.querySelectorAll('.chperms-sync-cb').forEach(cb => cb.checked = false);
    _updateSyncCount();
  } catch {
    toast('Toplu senkronizasyon sırasında hata oluştu', 'error');
    if (statusEl) statusEl.textContent = '';
  }
};

export const channel_perms_syncReady = true;
