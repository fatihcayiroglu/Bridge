// client/js/core/channel-perms/modal-sync.js
// Kategori senkronizasyonu, dÄ±ÅŸa/iÃ§e aktarma, kalÄ±tÄ±m, kaydetme, socket listener
(function () {
  /* globals currentServer, apiFetch, API, escHtml, openChannelPermsModal, chpermsLoadAudit, toast */
  // â”€â”€ KATEGORÄ° SENKRONÄ°ZASYONU â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _syncChannels = []; // sunucudaki tÃ¼m kanallar

  window.chpermsLoadSyncList = async function (channelId) {
    const listEl = document.getElementById('chperms-sync-channel-list');
    if (!listEl) return;
    listEl.innerHTML = '<p style="color:var(--text-3);font-size:12px">YÃ¼kleniyorâ€¦</p>';

    try {
      // Sunucu kanallarÄ±nÄ± al
      const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels`);
      const allCh = Array.isArray(data) ? data : (data.channels || []);
      _syncChannels = allCh.filter(c => c._id !== channelId && (c.type === 'text' || c.type === 'TEXT' || !c.type || c.type === 'voice' || c.type === 'VOICE'));

      if (_syncChannels.length === 0) {
        listEl.innerHTML = '<p style="color:var(--text-3);font-size:12px">Senkronize edilebilecek baÅŸka kanal yok.</p>';
        return;
      }

      // Kategoriye gÃ¶re grupla
      const grouped = {};
      for (const ch of _syncChannels) {
        const cat = ch.categoryId || ch.category || '__none__';
        if (!grouped[cat]) grouped[cat] = [];
        grouped[cat].push(ch);
      }

      let html = '';
      for (const [catId, channels] of Object.entries(grouped)) {
        const catName = catId === '__none__' ? 'ğŸ“ Kategorisiz' : `ğŸ“ ${escHtml(catId)}`;
        html += `
          <div style="margin-bottom:10px">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px">
              <span style="font-size:11px;font-weight:700;color:var(--text-3);text-transform:uppercase">${catName}</span>
              <button onclick="chpermsSyncSelectCat('${catId}',true)"
                style="font-size:10px;padding:2px 6px;border-radius:4px;border:1px solid var(--bg-4);
                       background:var(--bg-3);cursor:pointer;color:var(--text-2)">Hepsini SeÃ§</button>
            </div>
            ${channels.map(ch => {
              const icon = (ch.type === 'voice' || ch.type === 'VOICE') ? 'ğŸ”Š' : '#';
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
      listEl.innerHTML = '<p style="color:var(--danger,#ed4245);font-size:12px">Kanallar yÃ¼klenemedi.</p>';
    }
  };

  function _updateSyncCount() {
    const cnt = document.querySelectorAll('.chperms-sync-cb:checked').length;
    const el  = document.getElementById('chperms-sync-count');
    if (el) el.textContent = cnt > 0 ? `${cnt} kanal seÃ§ili` : '';
  }

  window.chpermsSyncSelectAll = function (val) {
    document.querySelectorAll('.chperms-sync-cb').forEach(cb => cb.checked = val);
    _updateSyncCount();
  };

  window.chpermsSyncSelectCat = function (catId, val) {
    document.querySelectorAll(`.chperms-sync-cb[data-cat="${catId}"]`).forEach(cb => cb.checked = val);
    _updateSyncCount();
  };

  // â”€â”€ BULK SYNC Ã–NÄ°ZLEME (#10) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Uygula butonuna basÄ±nca Ã¶nce diff modalÄ± aÃ§ar, onaylanÄ±nca asÄ±l sync'i Ã§alÄ±ÅŸtÄ±rÄ±r
  window.chpermsBulkSyncPreview = async function (channelId) {
    const checkedIds = [...document.querySelectorAll('.chperms-sync-cb:checked')].map(cb => cb.dataset.id);
    if (checkedIds.length === 0) { toast('HiÃ§ kanal seÃ§ilmedi', 'error'); return; }

    const statusEl = document.getElementById('chperms-sync-status');
    if (statusEl) statusEl.textContent = 'Ã–nizleme yÃ¼kleniyorâ€¦';

    // Kaynak kanalÄ±n override'larÄ±nÄ± al
    let overrides = [];
    try {
      const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
      overrides = (data.overrides || []).map(o => ({
        roleId: o.roleId, allow: o.allow ?? 0, deny: o.deny ?? 0,
        targetType: o.targetType, targetId: o.targetId, targetName: o.targetName,
      }));
    } catch {
      toast('Kaynak kanal izinleri alÄ±namadÄ±', 'error');
      if (statusEl) statusEl.textContent = '';
      return;
    }

    // Preview endpoint'ini Ã§aÄŸÄ±r
    let preview = null;
    try {
      preview = await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/bulk-sync/preview`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channelIds: checkedIds, overrides }) }
      );
    } catch {
      toast('Ã–nizleme yÃ¼klenemedi', 'error');
      if (statusEl) statusEl.textContent = '';
      return;
    }
    if (statusEl) statusEl.textContent = '';

    // Diff modalÄ±nÄ± gÃ¶ster
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
        padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">~${ch.updated} gÃ¼ncelle</span>`);
      if (ch.removed) badges.push(`<span style="background:rgba(237,66,69,.12);color:var(--danger,#ed4245);
        padding:1px 6px;border-radius:8px;font-size:10px;font-weight:700">-${ch.removed} sil</span>`);
      if (!hasChange)  badges.push(`<span style="color:var(--text-3);font-size:10px">deÄŸiÅŸiklik yok</span>`);
      const icon = ch.channelType === 'voice' ? 'ğŸ”Š' : '#';
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

        <!-- BaÅŸlÄ±k -->
        <div style="padding:18px 22px 14px;border-bottom:1px solid var(--bg-4)">
          <h3 style="margin:0;font-size:16px;font-weight:800">ğŸ” Senkronizasyon Ã–nizlemesi</h3>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-3)">
            AÅŸaÄŸÄ±daki deÄŸiÅŸiklikler uygulanacak â€” devam etmek istiyor musun?
          </p>
        </div>

        <!-- Ã–zet istatistikler -->
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
            <div style="font-size:11px;color:var(--text-3)">gÃ¼ncellenecek</div>
          </div>
          <div style="text-align:center;flex:1;min-width:80px">
            <div style="font-size:22px;font-weight:800;color:var(--danger,#ed4245)">${summary.totalRemoved}</div>
            <div style="font-size:11px;color:var(--text-3)">silinecek</div>
          </div>
        </div>

        ${noChanges ? `<div style="padding:16px 22px;font-size:13px;color:var(--text-3)">
          â„¹ï¸ SeÃ§ili kanallarda zaten aynÄ± izinler mevcut â€” uygulanacak deÄŸiÅŸiklik yok.
        </div>` : ''}

        <!-- Kanal listesi -->
        <div style="flex:1;overflow-y:auto;padding:10px 22px">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:1px solid var(--bg-4)">
                <th style="text-align:left;padding:5px 10px;font-size:11px;color:var(--text-3);font-weight:600">Kanal</th>
                <th style="text-align:left;padding:5px 10px;font-size:11px;color:var(--text-3);font-weight:600">YapÄ±lacak iÅŸlem</th>
              </tr>
            </thead>
            <tbody>${rowsHtml}</tbody>
          </table>
        </div>

        <!-- Butonlar -->
        <div style="padding:14px 22px;border-top:1px solid var(--bg-4);display:flex;justify-content:flex-end;gap:10px">
          <button class="btn" id="chperms-preview-cancel">Ä°ptal</button>
          <button class="btn btn-primary" id="chperms-preview-confirm"
            ${noChanges ? 'disabled' : ''}
            style="font-weight:700">
            ${noChanges ? 'â€” DeÄŸiÅŸiklik Yok' : `ğŸ” ${summary.channelsWithChanges} Kanala Uygula`}
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

  // â”€â”€ BULK SYNC UYGULA (preview'dan Ã§aÄŸrÄ±lÄ±r) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.chpermsBulkSync = async function (channelId, checkedIds, overrides) {
    // checkedIds ve overrides preview'dan geliyorsa kullan, yoksa formdan oku
    if (!checkedIds) {
      checkedIds = [...document.querySelectorAll('.chperms-sync-cb:checked')].map(cb => cb.dataset.id);
      if (checkedIds.length === 0) { toast('HiÃ§ kanal seÃ§ilmedi', 'error'); return; }
    }
    if (!overrides) {
      const statusEl = document.getElementById('chperms-sync-status');
      if (statusEl) statusEl.textContent = 'UygulanÄ±yorâ€¦';
      try {
        const data = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
        overrides = (data.overrides || []).map(o => ({
          roleId: o.roleId, allow: o.allow ?? 0, deny: o.deny ?? 0,
          targetType: o.targetType, targetId: o.targetId, targetName: o.targetName,
        }));
      } catch {
        toast('Kaynak kanal izinleri alÄ±namadÄ±', 'error');
        if (statusEl) statusEl.textContent = '';
        return;
      }
    }

    const statusEl = document.getElementById('chperms-sync-status');
    if (statusEl) statusEl.textContent = 'UygulanÄ±yorâ€¦';

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
      toast(`âœ… ${res.updated ?? checkedIds.length} kanala uygulandÄ±`, 'success');

      // Checkbox'larÄ± sÄ±fÄ±rla
      document.querySelectorAll('.chperms-sync-cb').forEach(cb => cb.checked = false);
      _updateSyncCount();
    } catch {
      toast('Toplu senkronizasyon sÄ±rasÄ±nda hata oluÅŸtu', 'error');
      if (statusEl) statusEl.textContent = '';
    }
  };

  // â”€â”€ FIX #13: Ä°ZÄ°N YAPISINI DIÅA/Ä°Ã‡E AKTAR â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  // KanalÄ±n izin yapÄ±sÄ±nÄ± JSON olarak indir
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
      toast('Ä°zin yapÄ±sÄ± dÄ±ÅŸa aktarÄ±ldÄ± âœ…', 'success');
    } catch {
      toast('DÄ±ÅŸa aktarma baÅŸarÄ±sÄ±z oldu', 'error');
    }
  };

  // Dosya seÃ§ici aÃ§
  window.chpermsImportClick = function (channelId) {
    const inp = document.getElementById('chperms-import-file');
    if (inp) inp.click();
  };

  // SeÃ§ilen JSON dosyasÄ±nÄ± oku ve sunucuya gÃ¶nder
  window.chpermsImportFile = async function (channelId, input) {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';   // aynÄ± dosya tekrar seÃ§ilebilsin

    let data;
    try {
      const text = await file.text();
      data = JSON.parse(text);
    } catch {
      toast('GeÃ§ersiz JSON dosyasÄ±', 'error');
      return;
    }

    if (!Array.isArray(data.overrides) || data.overrides.length === 0) {
      toast('Dosyada geÃ§erli override bulunamadÄ±', 'error');
      return;
    }

    // BirleÅŸtir mi yoksa deÄŸiÅŸtir mi?
    const merge = confirm(
      `"${data.sourceChannel || 'Bilinmiyor'}" kanalÄ±ndan ${data.overrides.length} override iÃ§e aktarÄ±lacak.\n\n` +
      `"Tamam" â†’ Mevcut override'lara ekle/gÃ¼ncelle (birleÅŸtir)\n` +
      `"Ä°ptal" â†’ Mevcut override'larÄ± sil, sadece yenilerini ekle`
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
      toast(`âœ… ${res.imported} override iÃ§e aktarÄ±ldÄ±`, 'success');

      // Fix #3: Atlanan user override'larÄ± varsa kullanÄ±cÄ±yÄ± uyar
      if (res.skippedCount > 0) {
        const names = res.skipped.map(s => s.roleName || s.roleId).join(', ');
        toast(
          `âš ï¸ ${res.skippedCount} kullanÄ±cÄ± override'Ä± atlandÄ±: ${names}. KullanÄ±cÄ± izinleri sunucular arasÄ± taÅŸÄ±namaz.`,
          'warning',
          8000   // daha uzun sÃ¼re gÃ¶ster
        );
      }

      // Kanal adÄ±nÄ± bul ve modalÄ± yeniden aÃ§ (matrisi yenile)
      const ch = currentServer?.channels?.find?.(c => c._id === channelId)
                 || { _id: channelId, name: channelId };
      setTimeout(() => openChannelPermsModal(channelId, ch.name || channelId), 200);
    } catch {
      toast('Ä°Ã§e aktarma baÅŸarÄ±sÄ±z oldu', 'error');
    }
  };

  // â”€â”€ Ä°ZÄ°N KALITIMI GÃ–RSELLEÅTÄ°RMESÄ° (#12) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // â„¹ butonuna tÄ±klanÄ±nca aÃ§Ä±lan "Bu izin nereden geliyor?" pop-up'Ä±
  window.chpermsShowInheritance = async function (btn) {
    const bit    = parseInt(btn.dataset.bit, 10);
    const roleId = btn.dataset.roleId;

    // Konumu hesapla
    const rect = btn.getBoundingClientRect();

    // YÃ¼klenirken yer tutucu
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
    popup.innerHTML = `<div style="color:var(--text-3)">YÃ¼kleniyorâ€¦</div>`;
    document.body.appendChild(popup);

    // DÄ±ÅŸarÄ± tÄ±klayÄ±nca kapat
    const _close = e => { if (!popup.contains(e.target) && e.target !== btn) { popup.remove(); document.removeEventListener('mousedown', _close); } };
    setTimeout(() => document.addEventListener('mousedown', _close), 50);

    try {
      const data = await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${_channelId}/permissions/inheritance/${encodeURIComponent(roleId)}`
      );

      // Ä°zin adÄ±nÄ± bul
      let permLabel = `Bit 0x${bit.toString(16)}`;
      for (const g of PERM_GROUPS) {
        const p = g.perms.find(p => p.bit === bit);
        if (p) { permLabel = p.label; break; }
      }

      const src = data.bitSources?.[bit];
      const SOURCE_ICONS = {
        channel_override: 'ğŸ“Œ',
        role:             'ğŸ·ï¸',
        server_default:   'ğŸŒ',
        none:             'ğŸš«',
      };
      const icon  = SOURCE_ICONS[src?.source] || 'â“';
      const state = src?.state === 'allow' ? 'âœ… Ä°zin Veriliyor' : 'âŒ Reddediliyor';
      const stateColor = src?.state === 'allow' ? 'var(--online,#3ba55c)' : 'var(--danger,#ed4245)';

      popup.innerHTML = `
        <div style="font-weight:800;font-size:13px;margin-bottom:10px;color:var(--text-1)">
          ${icon} ${escHtml(permLabel)}
        </div>

        <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
          <span style="font-size:18px">${src?.state === 'allow' ? 'âœ…' : 'âŒ'}</span>
          <span style="font-weight:700;color:${stateColor}">${state}</span>
        </div>

        <div style="background:var(--bg-2);border-radius:7px;padding:8px 10px;margin-bottom:8px">
          <div style="font-size:11px;color:var(--text-3);margin-bottom:2px">KAYNAK</div>
          <div style="font-size:12px;color:var(--text-1);font-weight:600">${icon} ${escHtml(src?.label || 'Bilinmiyor')}</div>
        </div>

        <!-- Ä°zin zinciri gÃ¶rselleÅŸtirmesi -->
        <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;font-weight:600">Ä°ZÄ°N ZÄ°NCÄ°RÄ°</div>
        <div style="display:flex;flex-direction:column;gap:3px">
          ${_inheritanceChain(data, bit)}
        </div>

        <div style="margin-top:10px;padding-top:8px;border-top:1px solid var(--bg-4);
             font-size:10px;color:var(--text-3)">
          Rol: <strong>${escHtml(data.roleName)}</strong>
          ${data.hasOverride ? ' Â· <span style="color:var(--brand)">Kanal override var</span>' : ''}
        </div>`;
    } catch {
      popup.innerHTML = `<div style="color:var(--danger,#ed4245);font-size:12px">KalÄ±tÄ±m bilgisi yÃ¼klenemedi</div>`;
    }
  };

  // Ä°zin zinciri satÄ±rlarÄ±nÄ± oluÅŸturur (en dÃ¼ÅŸÃ¼k Ã¶ncelik â†’ en yÃ¼ksek)
  function _inheritanceChain(data, bit) {
    const rows = [];
    const b = bit;

    // 1. Sunucu varsayÄ±lanÄ±
    const fromDefault = (data.serverDefault & b) !== 0;
    rows.push(_chainRow('ğŸŒ Sunucu VarsayÄ±lanÄ±',
      fromDefault ? 'allow' : 'none',
      data.bitSources?.[b]?.source === 'server_default'));

    // 2. Rol izni
    if (!data.isUser && data.rolePermissions !== undefined) {
      const fromRole = (data.rolePermissions & b) !== 0;
      rows.push(_chainRow(`ğŸ·ï¸ Rol: ${escHtml(data.roleName)}`,
        fromRole ? 'allow' : 'none',
        data.bitSources?.[b]?.source === 'role'));
    }

    // 3. Kanal override
    if (data.hasOverride && data.override) {
      const ovrAllow = (data.override.allow & b) !== 0;
      const ovrDeny  = (data.override.deny  & b) !== 0;
      const state    = ovrAllow ? 'allow' : ovrDeny ? 'deny' : 'neutral';
      rows.push(_chainRow('ğŸ“Œ Kanal Override', state,
        data.bitSources?.[b]?.source === 'channel_override'));
    }

    return rows.join('');
  }

  function _chainRow(label, state, isActive) {
    const icon  = state === 'allow' ? 'âœ…' : state === 'deny' ? 'âŒ' : 'â€”';
    const color = isActive ? 'var(--brand)' : 'var(--text-3)';
    const weight = isActive ? '700' : '400';
    return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;
      padding:3px 6px;border-radius:5px;${isActive ? 'background:var(--brand-bg,rgba(88,101,242,.08))' : ''}">
      <span>${icon}</span>
      <span style="color:${color};font-weight:${weight};flex:1">${label}</span>
      ${isActive ? '<span style="font-size:9px;color:var(--brand);font-weight:800">â—€ ETKÄ°N</span>' : ''}
    </div>`;
  }

  // Not: _channelId ve _currentChannelId openChannelPermsModal'da set edilir
  window.saveChannelPerms = async function (channelId) {
    const rows    = document.querySelectorAll('#ch-perms-modal tr[data-role-id]');
    const overrides = [];  // gÃ¼ncellenecek / eklenecek
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

    // KaldÄ±rÄ±lan override'lar (snapshot null = sil)
    for (const [snapId, val] of Object.entries(_snapshot)) {
      if (val !== null) continue;
      deletes.push(snapId);
    }

    if (overrides.length === 0 && deletes.length === 0) {
      toast('DeÄŸiÅŸiklik yok, kaydedilecek bir ÅŸey bulunamadÄ±.', 'info');
      return;
    }

    try {
      // Tek HTTP isteÄŸiyle gÃ¶nder
      await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/batch`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ overrides, deletes }),
        }
      );

      // Snapshot gÃ¼ncelle
      rows.forEach(row => {
        const id = row.dataset.roleId;
        if (_snapshot[id] !== null) _snapshot[id] = _readRow(row);
      });
      for (const id of Object.keys(_snapshot)) {
        if (_snapshot[id] === null) delete _snapshot[id];
      }

      _clearDirty();
      _updateSaveInfo();
      toast(`${overrides.length + deletes.length} izin deÄŸiÅŸikliÄŸi kaydedildi âœ…`, 'success');
      document.getElementById('ch-perms-modal')?.remove();
    } catch {
      toast('Kaydetme sÄ±rasÄ±nda hata oluÅŸtu', 'error');
    }
  };

  // â”€â”€ FIX #6: permissions:updated socket event dinleyici â”€â”€â”€â”€â”€â”€â”€â”€
  // Admin izin kaydettiÄŸinde sunucu Ã¼yelerine realtime bildirim gelir.
  // Etkilen kanal o anda aÃ§Ä±ksa kanal listesi yeniden yÃ¼klenir.
  (function _registerPermSocketListener() {
    // Socket hazÄ±r olmayabilir â€” kÄ±sa polling ile bekle
    let _attempts = 0;
    const _try = () => {
      if (typeof socket === 'undefined' || !socket) {
        if (++_attempts < 20) setTimeout(_try, 500);
        return;
      }
      // MÃ¼kerrer listener engelle
      socket.off('permissions:updated', _onPermsUpdated);
      socket.on('permissions:updated', _onPermsUpdated);
    };

    function _onPermsUpdated({ serverId, channelId }) {
      // Sadece mevcut sunucuyla ilgili eventleri iÅŸle
      if (!currentServer || currentServer._id !== serverId) return;

      // Kanal listesini yenile (VIEW_CHANNELS izni deÄŸiÅŸmiÅŸ olabilir)
      if (typeof loadServerChannels === 'function') {
        loadServerChannels(serverId).catch(() => {});
      } else if (typeof renderChannels === 'function') {
        renderChannels();
      }

      // KullanÄ±cÄ± izin modalÄ±nÄ± aÃ§Ä±kken baÅŸkasÄ± deÄŸiÅŸiklik yaptÄ±ysa uyar
      const modal = document.getElementById('ch-perms-modal');
      if (modal && _channelId === channelId && !_isDirty) {
        toast('âš ï¸ Bu kanalÄ±n izinleri baÅŸka bir admin tarafÄ±ndan gÃ¼ncellendi', 'info');
      }
    }

    _try();
  })();

})();

