// client/js/core/channel-perms/modal-sync.js
// Kategori senkronizasyonu, dışa/içe aktarma, kalıtım, kaydetme, socket listener
(function () {
  /* globals currentServer, apiFetch, API, escHtml, openChannelPermsModal, chpermsLoadAudit, toast */
  // ── KATEGORİ SENKRONİZASYONU ──────────────────────────────────
  let _syncChannels = []; // sunucudaki tüm kanallar

  window.chpermsLoadSyncList = async function (channelId) {
    const listEl = document.getElementById('chperms-sync-channel-list');
    if (!listEl) return;
    listEl.innerHTML = '<p style="color:var(--text-3);font-size:12px">Yükleniyor…</p>';

    try {
      // Sunucu kanallarını al
      const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels`);
      const allCh = Array.isArray(data) ? data : (data.channels || []);
      _syncChannels = allCh.filter(c => c._id !== channelId && (c.type === 'text' || c.type === 'TEXT' || !c.type || c.type === 'voice' || c.type === 'VOICE'));

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
                          border-radius:6px;cursor:pointer;hover:background:var(--bg-3)"
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

  // ── BULK SYNC ÖNİZLEME (#10) ─────────────────────────────────
  // Uygula butonuna basınca önce diff modalı açar, onaylanınca asıl sync'i çalıştırır
  window.chpermsBulkSyncPreview = async function (channelId) {
    const checkedIds = [...document.querySelectorAll('.chperms-sync-cb:checked')].map(cb => cb.dataset.id);
    if (checkedIds.length === 0) { toast('Hiç kanal seçilmedi', 'error'); return; }

    const statusEl = document.getElementById('chperms-sync-status');
    if (statusEl) statusEl.textContent = 'Önizleme yükleniyor…';

    // Kaynak kanalın override'larını al
    let overrides = [];
    try {
      const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
      overrides = (data.overrides || []).map(o => ({
        roleId: o.roleId, allow: o.allow ?? 0, deny: o.deny ?? 0,
        targetType: o.targetType, targetId: o.targetId, targetName: o.targetName,
      }));
    } catch {
      toast('Kaynak kanal izinleri alınamadı', 'error');
      if (statusEl) statusEl.textContent = '';
      return;
    }

    // Preview endpoint'ini çağır
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

    // Diff modalını göster
    _showSyncPreviewModal(channelId, checkedIds, overrides, preview);
  };

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

        <!-- Başlık -->
        <div style="padding:18px 22px 14px;border-bottom:1px solid var(--bg-4)">
          <h3 style="margin:0;font-size:16px;font-weight:800">🔍 Senkronizasyon Önizlemesi</h3>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-3)">
            Aşağıdaki değişiklikler uygulanacak — devam etmek istiyor musun?
          </p>
        </div>

        <!-- Özet istatistikler -->
        <div style="display:flex;gap:12px;padding:14px 22px;border-bottom:1px solid var(--bg-4);flex-wrap:wrap">
          <div style="text-align:center;flex:1;min-width:80px">
            <div style="font-size:22px;font-weight:800;color:var(--text-1)">${summary.channelsWithChanges}</div>
            <div style="font-size:11px;color:var(--text-3)">etkilenen kanal</div>
          </div>
          <div style="text-align:center;flex:1;min-width:80px">
            <div style="font-size:22px;font-weight:800;color:var(--online,#3ba55c)">${summary.totalAdded}</div>
            <div style="font-size:11px;color:var(--text-3)">eklenecek</div>
          </div>
          <div style="text-align:center;flex:1;min-width:80px">
            <div style="font-size:22px;font-weight:800;color:#faa61a">${summary.totalUpdated}</div>
            <div style="font-size:11px;color:var(--text-3)">güncellenecek</div>
          </div>
          <div style="text-align:center;flex:1;min-width:80px">
            <div style="font-size:22px;font-weight:800;color:var(--danger,#ed4245)">${summary.totalRemoved}</div>
            <div style="font-size:11px;color:var(--text-3)">silinecek</div>
          </div>
        </div>

        ${noChanges ? `<div style="padding:16px 22px;font-size:13px;color:var(--text-3)">
          ℹ️ Seçili kanallarda zaten aynı izinler mevcut — uygulanacak değişiklik yok.
        </div>` : ''}

        <!-- Kanal listesi -->
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

        <!-- Butonlar -->
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

  // ── BULK SYNC UYGULA (preview'dan çağrılır) ──────────────────
  window.chpermsBulkSync = async function (channelId, checkedIds, overrides) {
    // checkedIds ve overrides preview'dan geliyorsa kullan, yoksa formdan oku
    if (!checkedIds) {
      checkedIds = [...document.querySelectorAll('.chperms-sync-cb:checked')].map(cb => cb.dataset.id);
      if (checkedIds.length === 0) { toast('Hiç kanal seçilmedi', 'error'); return; }
    }
    if (!overrides) {
      const statusEl = document.getElementById('chperms-sync-status');
      if (statusEl) statusEl.textContent = 'Uygulanıyor…';
      try {
        const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
        overrides = (data.overrides || []).map(o => ({
          roleId: o.roleId, allow: o.allow ?? 0, deny: o.deny ?? 0,
          targetType: o.targetType, targetId: o.targetId, targetName: o.targetName,
        }));
      } catch {
        toast('Kaynak kanal izinleri alınamadı', 'error');
        if (statusEl) statusEl.textContent = '';
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

      // Checkbox'ları sıfırla
      document.querySelectorAll('.chperms-sync-cb').forEach(cb => cb.checked = false);
      _updateSyncCount();
    } catch {
      toast('Toplu senkronizasyon sırasında hata oluştu', 'error');
      if (statusEl) statusEl.textContent = '';
    }
  };

  // ── FIX #13: İZİN YAPISINI DIŞA/İÇE AKTAR ───────────────────

  // Kanalın izin yapısını JSON olarak indir
  window.chpermsExport = async function (channelId) {
    try {
      const res = await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/export`
      );
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href     = url;
      a.download = `permissions-${channelId}.json`;
      a.click();
      URL.revokeObjectURL(url);
      toast('İzin yapısı dışa aktarıldı ✅', 'success');
    } catch {
      toast('Dışa aktarma başarısız oldu', 'error');
    }
  };

  // Dosya seçici aç
  window.chpermsImportClick = function (channelId) {
    const inp = document.getElementById('chperms-import-file');
    if (inp) inp.click();
  };

  // Seçilen JSON dosyasını oku ve sunucuya gönder
  window.chpermsImportFile = async function (channelId, input) {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';   // aynı dosya tekrar seçilebilsin

    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
    } catch {
      toast('Geçersiz JSON dosyası', 'error');
      return;
    }

    if (!Array.isArray(data.overrides) || data.overrides.length === 0) {
      toast('Dosyada geçerli override bulunamadı', 'error');
      return;
    }

    // Birleştir mi yoksa değiştir mi?
    const merge = confirm(
      `"${data.sourceChannel || 'Bilinmiyor'}" kanalından ${data.overrides.length} override içe aktarılacak.\n\n` +
      `"Tamam" → Mevcut override'lara ekle/güncelle (birleştir)\n` +
      `"İptal" → Mevcut override'ları sil, sadece yenilerini ekle`
    );

    try {
      const res = await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/import`,
        {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ overrides: data.overrides, merge }),
        }
      );
      toast(`✅ ${res.imported} override içe aktarıldı`, 'success');

      // Fix #3: Atlanan user override'ları varsa kullanıcıyı uyar
      if (res.skippedCount > 0) {
        const names = res.skipped.map(s => s.roleName || s.roleId).join(', ');
        toast(
          `⚠️ ${res.skippedCount} kullanıcı override'ı atlandı: ${names}. Kullanıcı izinleri sunucular arası taşınamaz.`,
          'warning',
          8000   // daha uzun süre göster
        );
      }

      // Kanal adını bul ve modalı yeniden aç (matrisi yenile)
      const ch = currentServer?.channels?.find?.(c => c._id === channelId)
                 || { _id: channelId, name: channelId };
      setTimeout(() => openChannelPermsModal(channelId, ch.name || channelId), 200);
    } catch {
      toast('İçe aktarma başarısız oldu', 'error');
    }
  };

  // ── İZİN KALITIMI GÖRSELLEŞTİRMESİ (#12) ────────────────────
  // ℹ butonuna tıklanınca açılan "Bu izin nereden geliyor?" pop-up'ı
  window.chpermsShowInheritance = async function (btn) {
    const bit    = parseInt(btn.dataset.bit, 10);
    const roleId = btn.dataset.roleId;

    // Konumu hesapla
    const rect = btn.getBoundingClientRect();

    // Yüklenirken yer tutucu
    document.getElementById('chperms-inherit-popup')?.remove();
    const popup = document.createElement('div');
    popup.id = 'chperms-inherit-popup';
    popup.style.cssText = [
      'position:fixed',
      `top:${Math.min(rect.bottom + 4, window.innerHeight - 260)}px`,
      `left:${Math.max(rect.left - 180, 8)}px`,
      'z-index:30000',
      'background:var(--bg-1)',
      'border:1px solid var(--bg-4)',
      'border-radius:10px',
      'padding:14px 16px',
      'min-width:260px',
      'max-width:320px',
      'box-shadow:var(--shadow-lg)',
      'font-size:12px',
    ].join(';');
    popup.innerHTML = `<div style="color:var(--text-3)">Yükleniyor…</div>`;
    document.body.appendChild(popup);

    // Dışarı tıklayınca kapat
    const _close = e => { if (!popup.contains(e.target) && e.target !== btn) { popup.remove(); document.removeEventListener('mousedown', _close); } };
    setTimeout(() => document.addEventListener('mousedown', _close), 50);

    try {
      const data = await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${_channelId}/permissions/inheritance/${encodeURIComponent(roleId)}`
      );

      // İzin adını bul
      let permLabel = `Bit 0x${bit.toString(16)}`;
      for (const g of PERM_GROUPS) {
        const p = g.perms.find(p => p.bit === bit);
        if (p) { permLabel = p.label; break; }
      }

      const src = data.bitSources?.[bit];
      const SOURCE_ICONS = {
        channel_override: '📌',
        role:             '🏷️',
        server_default:   '🌐',
        none:             '🚫',
      };
      const icon  = SOURCE_ICONS[src?.source] || '❓';
      const state = src?.state === 'allow' ? '✅ İzin Veriliyor' : '❌ Reddediliyor';
      const stateColor = src?.state === 'allow' ? 'var(--online,#3ba55c)' : 'var(--danger,#ed4245)';

      popup.innerHTML = `
        <div style="font-weight:800;font-size:13px;margin-bottom:10px;color:var(--text-1)">
          ${icon} ${escHtml(permLabel)}
        </div>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:18px">${src?.state === 'allow' ? '✅' : '❌'}</span>
          <span style="font-weight:700;color:${stateColor}">${state}</span>
        </div>

        <div style="background:var(--bg-2);border-radius:7px;padding:8px 10px;margin-bottom:8px">
          <div style="font-size:11px;color:var(--text-3);margin-bottom:2px">KAYNAK</div>
          <div style="font-size:12px;color:var(--text-1);font-weight:600">${icon} ${escHtml(src?.label || 'Bilinmiyor')}</div>
        </div>

        <!-- İzin zinciri görselleştirmesi -->
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;font-weight:600">İZİN ZİNCİRİ</div>
        <div style="display:flex;flex-direction:column;gap:3px">
          ${_inheritanceChain(data, bit)}
        </div>

        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--bg-4);
             font-size:10px;color:var(--text-3)">
          Rol: <strong>${escHtml(data.roleName)}</strong>
          ${data.hasOverride ? ' · <span style="color:var(--brand)">Kanal override var</span>' : ''}
        </div>`;
    } catch {
      popup.innerHTML = `<div style="color:var(--danger,#ed4245);font-size:12px">Kalıtım bilgisi yüklenemedi</div>`;
    }
  };

  // İzin zinciri satırlarını oluşturur (en düşük öncelik → en yüksek)
  function _inheritanceChain(data, bit) {
    const rows = [];
    const b = bit;

    // 1. Sunucu varsayılanı
    const fromDefault = (data.serverDefault & b) !== 0;
    rows.push(_chainRow('🌐 Sunucu Varsayılanı',
      fromDefault ? 'allow' : 'none',
      data.bitSources?.[b]?.source === 'server_default'));

    // 2. Rol izni
    if (!data.isUser && data.rolePermissions !== undefined) {
      const fromRole = (data.rolePermissions & b) !== 0;
      rows.push(_chainRow(`🏷️ Rol: ${escHtml(data.roleName)}`,
        fromRole ? 'allow' : 'none',
        data.bitSources?.[b]?.source === 'role'));
    }

    // 3. Kanal override
    if (data.hasOverride && data.override) {
      const ovrAllow = (data.override.allow & b) !== 0;
      const ovrDeny  = (data.override.deny  & b) !== 0;
      const state    = ovrAllow ? 'allow' : ovrDeny ? 'deny' : 'neutral';
      rows.push(_chainRow('📌 Kanal Override', state,
        data.bitSources?.[b]?.source === 'channel_override'));
    }

    return rows.join('');
  }

  function _chainRow(label, state, isActive) {
    const icon  = state === 'allow' ? '✅' : state === 'deny' ? '❌' : '—';
    const color = isActive ? 'var(--brand)' : 'var(--text-3)';
    const weight = isActive ? '700' : '400';
    return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;
      padding:3px 6px;border-radius:5px;${isActive ? 'background:var(--brand-bg,rgba(88,101,242,.08))' : ''}">
      <span>${icon}</span>
      <span style="color:${color};font-weight:${weight};flex:1">${label}</span>
      ${isActive ? '<span style="font-size:9px;color:var(--brand);font-weight:800">◀ ETKİN</span>' : ''}
    </div>`;
  }

  // Not: _channelId ve _currentChannelId openChannelPermsModal'da set edilir
  window.saveChannelPerms = async function (channelId) {
    const rows    = document.querySelectorAll('#ch-perms-modal tr[data-role-id]');
    const overrides = [];  // güncellenecek / eklenecek
    const deletes   = [];  // silinecek roleId'ler
    const seen      = new Set();

    for (const row of rows) {
      const id = row.dataset.roleId;
      if (seen.has(id)) continue; seen.add(id);
      const cur     = _readRow(row);
      if (!_rowIsDirty(id, cur)) continue;
      const rowData = _allRows.find(r => r._id === id);

      if (id === '__everyone__') {
        overrides.push({ roleId: '__everyone__', allow: cur.allow, deny: cur.deny, targetType: 'everyone' });
      } else if (rowData?.isUser) {
        overrides.push({
          roleId: id, allow: cur.allow, deny: cur.deny,
          targetType: 'user', targetId: rowData.userId, targetName: rowData.name,
        });
      } else {
        overrides.push({ roleId: id, allow: cur.allow, deny: cur.deny });
      }
    }

    // Kaldırılan override'lar (snapshot null = sil)
    for (const [snapId, val] of Object.entries(_snapshot)) {
      if (val !== null) continue;
      deletes.push(snapId);
    }

    if (overrides.length === 0 && deletes.length === 0) {
      toast('Değişiklik yok, kaydedilecek bir şey bulunamadı.', 'info');
      return;
    }

    try {
      // Tek HTTP isteğiyle gönder
      await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/batch`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overrides, deletes }),
        }
      );

      // Snapshot güncelle
      rows.forEach(row => {
        const id = row.dataset.roleId;
        if (_snapshot[id] !== null) _snapshot[id] = _readRow(row);
      });
      for (const id of Object.keys(_snapshot)) {
        if (_snapshot[id] === null) delete _snapshot[id];
      }

      _clearDirty();
      _updateSaveInfo();
      toast(`${overrides.length + deletes.length} izin değişikliği kaydedildi ✅`, 'success');
      document.getElementById('ch-perms-modal')?.remove();
    } catch {
      toast('Kaydetme sırasında hata oluştu', 'error');
    }
  };

  // ── FIX #6: permissions:updated socket event dinleyici ────────
  // Admin izin kaydettiğinde sunucu üyelerine realtime bildirim gelir.
  // Etkilen kanal o anda açıksa kanal listesi yeniden yüklenir.
  (function _registerPermSocketListener() {
    // Socket hazır olmayabilir — kısa polling ile bekle
    let _attempts = 0;
    const _try = () => {
      if (typeof socket === 'undefined' || !socket) {
        if (++_attempts < 20) setTimeout(_try, 500);
        return;
      }
      // Mükerrer listener engelle
      socket.off('permissions:updated', _onPermsUpdated);
      socket.on('permissions:updated', _onPermsUpdated);
    };

    function _onPermsUpdated({ serverId, channelId }) {
      // Sadece mevcut sunucuyla ilgili eventleri işle
      if (!currentServer || currentServer._id !== serverId) return;

      // Kanal listesini yenile (VIEW_CHANNELS izni değişmiş olabilir)
      if (typeof loadServerChannels === 'function') {
        loadServerChannels(serverId).catch(() => {});
      } else if (typeof renderChannels === 'function') {
        renderChannels();
      }

      // Kullanıcı izin modalını açıkken başkası değişiklik yaptıysa uyar
      const modal = document.getElementById('ch-perms-modal');
      if (modal && _channelId === channelId && !_isDirty) {
        toast('⚠️ Bu kanalın izinleri başka bir admin tarafından güncellendi', 'info');
      }
    }

    _try();
  })();

})();

export const channelPermsReady = true;
