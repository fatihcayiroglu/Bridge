// client/js/core/channel-permissions.js
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CHANNEL PERMISSIONS MODAL â€” Ana koordinatÃ¶r
//
// 1906 satÄ±rlÄ±k dosya 6 modÃ¼le bÃ¶lÃ¼ndÃ¼:
//   channel-perms-data.js        â† PERM_GROUPS, BIT_LABELS, PERM_TEMPLATES
//   channel-perms-matrix.js      â† buildPermMatrix(), buildPermRow()
//   channel-perms-audit.js       â† chpermsLoadAudit() ve filtre fonksiyonlarÄ±
//   channel-perms-sync.js        â† chpermsLoadSyncList(), chpermsBulkSync()
//   channel-perms-inheritance.js â† chpermsShowInheritance() popup
//   channel-permissions.js       â† Modal state, kaydet, socket (bu dosya)
//
// YÃ¼kleme sÄ±rasÄ± (index.html):
//   channel-perms-data.js â†’ channel-perms-matrix.js â†’
//   channel-perms-audit.js â†’ channel-perms-sync.js â†’
//   channel-perms-inheritance.js â†’ channel-permissions.js
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
(function () {

  // â”€â”€ MODAL STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // _channelId dÄ±ÅŸarÄ±dan eriÅŸilebilir olmalÄ± (inheritance modÃ¼lÃ¼ okur)
  window._channelId    = null;
  let _serverPerms     = {};
  let _snapshot        = {};
  let _isDirty         = false;
  let _allRows         = [];
  let _currentChannelId = null; // sekme geÃ§iÅŸinde kullanÄ±lÄ±r

  // â”€â”€ DIRTY TRACKING â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function _markDirty() {
    if (_isDirty) return;
    _isDirty = true;
    const title = document.querySelector('#ch-perms-modal h2');
    if (title && !title.dataset.dirty) {
      title.dataset.dirty = '1';
      title.insertAdjacentHTML('beforeend',
        ' <span id="dirty-badge" style="font-size:11px;background:#f0b132;color:#000;'
        + 'padding:2px 7px;border-radius:10px;vertical-align:middle;font-weight:700">â— Kaydedilmedi</span>');
    }
  }

  function _clearDirty() {
    _isDirty = false;
    document.getElementById('dirty-badge')?.remove();
    const title = document.querySelector('#ch-perms-modal h2');
    if (title) delete title.dataset.dirty;
  }

  function _readRow(tr) {
    let allow = 0, deny = 0;
    tr.querySelectorAll('.perm-toggle').forEach(btn => {
      const bit = parseInt(btn.dataset.bit, 10);
      if (btn.dataset.state === 'allow') allow |= bit;
      if (btn.dataset.state === 'deny')  deny  |= bit;
    });
    return { allow, deny };
  }

  function _rowIsDirty(id, cur) {
    const snap = _snapshot[id];
    if (snap === null) return true;
    const s = snap || { allow: 0, deny: 0 };
    return cur.allow !== s.allow || cur.deny !== s.deny;
  }

  // â”€â”€ OPEN MODAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.openChannelPermsModal = async function (channelId, channelName) {
    if (!currentServer) return;
    document.getElementById('ch-perms-modal')?.remove();

    window._channelId = channelId;
    _currentChannelId = channelId;
    _isDirty          = false;
    _snapshot         = {};
    _serverPerms      = {};
    _allRows          = [];

    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
    if (!r.ok) return toast('Ä°zinler yÃ¼klenemedi', 'error');
    const { overrides, roles } = await r.json();

    const overrideMap = {};
    for (const o of overrides) {
      const key = o.targetType === 'user'
        ? `user:${o.targetId}`
        : o.targetType === 'everyone' ? '__everyone__' : o.targetId;
      overrideMap[key] = o;
    }

    const everyoneOvr  = overrides.find(o => o.targetType === 'everyone') || { allow: 0, deny: 0 };
    const userOverrides = overrides.filter(o => o.targetType === 'user');

    for (const role of roles) _serverPerms[role._id] = role.permissions || 0;

    _snapshot['__everyone__'] = { allow: everyoneOvr.allow || 0, deny: everyoneOvr.deny || 0 };
    for (const role of roles) {
      const ov = overrideMap[role._id] || { allow: 0, deny: 0 };
      _snapshot[role._id] = { allow: ov.allow || 0, deny: ov.deny || 0 };
    }
    for (const uo of userOverrides) {
      _snapshot[`user:${uo.targetId}`] = { allow: uo.allow || 0, deny: uo.deny || 0 };
    }

    _allRows = [
      { _id: '__everyone__', name: '@everyone', color: '#99aab5', isEveryone: true, isUser: false, ov: everyoneOvr },
      ...roles.map(role => ({ ...role, isEveryone: false, isUser: false, ov: overrideMap[role._id] || { allow: 0, deny: 0 } })),
      ...userOverrides.map(uo => ({
        _id: `user:${uo.targetId}`, name: uo.targetName || uo.targetId,
        color: '#5865f2', isEveryone: false, isUser: true,
        userId: uo.targetId, ov: { allow: uo.allow || 0, deny: uo.deny || 0 },
      })),
    ];

    _renderModal(channelId, channelName, roles);
  };

  // â”€â”€ RENDER MODAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function _renderModal(channelId, channelName, roles) {
    const overlay = document.createElement('div');
    overlay.id = 'ch-perms-modal';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'z-index:10000';

    overlay.innerHTML = `
      <div class="modal-card" style="max-width:940px;width:96%;max-height:94vh;
           overflow:hidden;display:flex;flex-direction:column;padding:0">

        <!-- HEADER -->
        <div style="padding:18px 24px 14px;border-bottom:1px solid var(--bg-4);
             display:flex;align-items:center;justify-content:space-between;flex-shrink:0">
          <div>
            <h2 style="font-size:18px;font-weight:800">ğŸ›¡ï¸ #${escHtml(channelName)} â€” Kanal Ä°zinleri</h2>
            <p style="color:var(--text-3);font-size:12px;margin-top:3px">
              Rol ve Ã¼ye bazlÄ± izinleri Ã¶zelleÅŸtir. &nbsp;âœ… Ä°zin ver &nbsp;âŒ Reddet &nbsp;â€” VarsayÄ±lan
            </p>
          </div>
          <button id="chperms-close-btn"
            style="background:none;border:none;cursor:pointer;font-size:20px;color:var(--text-3)">âœ•</button>
        </div>

        <!-- SEKME Ã‡UBUÄU -->
        <div style="display:flex;border-bottom:2px solid var(--bg-4);flex-shrink:0;background:var(--bg-2);padding:0 24px">
          <button class="chperms-tab chperms-tab-active" data-tab="matrix"
            style="padding:10px 18px;border:none;background:none;cursor:pointer;font-size:13px;
                   font-weight:600;color:var(--text-1);border-bottom:2px solid var(--brand);margin-bottom:-2px"
            onclick="chpermsTab('matrix')">âš™ï¸ Ä°zin Matrisi</button>
          <button class="chperms-tab" data-tab="audit"
            style="padding:10px 18px;border:none;background:none;cursor:pointer;font-size:13px;
                   font-weight:600;color:var(--text-3);border-bottom:2px solid transparent;margin-bottom:-2px"
            onclick="chpermsTab('audit')">ğŸ“‹ DeÄŸiÅŸiklik GeÃ§miÅŸi</button>
          <button class="chperms-tab" data-tab="sync"
            style="padding:10px 18px;border:none;background:none;cursor:pointer;font-size:13px;
                   font-weight:600;color:var(--text-3);border-bottom:2px solid transparent;margin-bottom:-2px"
            onclick="chpermsTab('sync')">ğŸ” Kategori Senkronizasyonu</button>
        </div>

        <!-- â•â•â• SEKME: Ä°ZÄ°N MATRÄ°SÄ° â•â•â• -->
        <div id="chperms-pane-matrix" style="display:flex;flex-direction:column;flex:1;overflow:hidden;min-height:0">
          <!-- TOOLBAR -->
          <div style="padding:10px 24px;border-bottom:1px solid var(--bg-4);
            display:flex;align-items:center;gap:8px;flex-wrap:wrap;flex-shrink:0;background:var(--bg-2)">

            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:11px;color:var(--text-3);white-space:nowrap;font-weight:600">ğŸ“ Åablon:</span>
              <select id="chperms-template-select"
                style="padding:5px 10px;border-radius:6px;border:1px solid var(--bg-4);
                       background:var(--bg-3);color:var(--text-1);font-size:12px"
                onchange="chpermsApplyTemplate(this.value)">
                <option value="">â€” SeÃ§ â€”</option>
                ${PERM_TEMPLATES.map(t => `<option value="${t.id}" title="${escHtml(t.desc)}">${t.icon} ${escHtml(t.label)}</option>`).join('')}
              </select>
            </div>

            <div style="width:1px;height:24px;background:var(--bg-4);margin:0 2px"></div>

            <select id="chperms-role-select" onchange="chpermsSelectRole(this.value)"
              style="padding:5px 10px;border-radius:6px;border:1px solid var(--bg-4);
                     background:var(--bg-3);color:var(--text-1);font-size:13px;min-width:150px">
              <option value="">â€” Rol/Ãœye SeÃ§ â€”</option>
              <option value="__everyone__">@everyone</option>
              ${roles.map(r => `<option value="${escHtml(r._id)}">${escHtml(r.name)}</option>`).join('')}
              ${_allRows.filter(r => r.isUser).map(r =>
                `<option value="${escHtml(r._id)}">ğŸ‘¤ ${escHtml(r.name)}</option>`
              ).join('')}
            </select>

            <button class="btn" onclick="chpermsOpenUserSearch()"
              style="font-size:12px;padding:5px 12px" title="Belirli bir Ã¼yeye Ã¶zel kanal izni ver">
              ğŸ‘¤+ Ãœye Ekle
            </button>
            <button class="btn btn-success" id="btn-grant-all" disabled onclick="chpermsGrantAll()"
              style="font-size:12px;padding:5px 12px">âœ… TÃ¼mÃ¼ne Ä°zin Ver</button>
            <button class="btn btn-danger"  id="btn-deny-all"  disabled onclick="chpermsDenyAll()"
              style="font-size:12px;padding:5px 12px">âŒ TÃ¼mÃ¼nÃ¼ Reddet</button>
            <button class="btn"             id="btn-reset-all" disabled onclick="chpermsResetAll()"
              style="font-size:12px;padding:5px 12px">â€” SÄ±fÄ±rla</button>
            <button class="btn"             id="btn-remove-row" disabled onclick="chpermsRemoveRow()"
              style="font-size:12px;padding:5px 12px;color:var(--danger,#ed4245)"
              title="SeÃ§ili rol/Ã¼ye override'Ä±nÄ± kaldÄ±r">ğŸ—‘ï¸ KaldÄ±r</button>
            <button class="btn"             id="btn-sync-server" disabled onclick="chpermsSyncServer()"
              title="Sunucu izinlerini kanal override'larÄ±na yansÄ±t"
              style="font-size:12px;padding:5px 12px;margin-left:auto">ğŸ”„ Sunucu Ä°le Senkronize</button>

            <div style="width:1px;height:24px;background:var(--bg-4);margin:0 2px"></div>

            <button class="btn" onclick="chpermsExport('${channelId}')"
              style="font-size:12px;padding:5px 12px">ğŸ“¤ DÄ±ÅŸa Aktar</button>
            <button class="btn" onclick="chpermsImportClick('${channelId}')"
              style="font-size:12px;padding:5px 12px">ğŸ“¥ Ä°Ã§e Aktar</button>
            <input type="file" id="chperms-import-file" accept=".json"
              style="display:none" onchange="chpermsImportFile('${channelId}', this)">
          </div>

          <!-- MATRIX -->
          <div id="chperms-matrix" style="overflow:auto;flex:1;padding:16px 24px">
            ${buildPermMatrix(_allRows)}
          </div>

          <!-- FOOTER -->
          <div style="padding:12px 24px;border-top:1px solid var(--bg-4);
               display:flex;justify-content:space-between;align-items:center;flex-shrink:0">
            <span id="chperms-save-info" style="font-size:12px;color:var(--text-3)"></span>
            <div style="display:flex;gap:8px">
              <button class="btn" id="chperms-cancel-btn">Kapat</button>
              <button class="btn btn-primary" onclick="saveChannelPerms('${channelId}')">ğŸ’¾ Kaydet</button>
            </div>
          </div>
        </div>

        <!-- â•â•â• SEKME: DEÄÄ°ÅÄ°KLÄ°K GEÃ‡MÄ°ÅÄ° â•â•â• -->
        <div id="chperms-pane-audit" style="display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0">
          <div style="padding:10px 24px;border-bottom:1px solid var(--bg-4);flex-shrink:0;
               background:var(--bg-2);display:flex;align-items:center;gap:10px;flex-wrap:wrap">
            <span style="font-size:11px;font-weight:700;color:var(--text-3)">ğŸ” FÄ°LTRE:</span>
            <select id="chperms-audit-action-filter"
              style="padding:4px 8px;border-radius:6px;border:1px solid var(--bg-4);
                     background:var(--bg-3);color:var(--text-1);font-size:12px"
              onchange="chpermsApplyAuditFilter()">
              <option value="">TÃ¼m Ä°ÅŸlemler</option>
              <option value="PERM_UPDATE">âœï¸ GÃ¼ncelleme</option>
              <option value="PERM_DELETE">ğŸ—‘ï¸ Silme</option>
              <option value="PERM_BULK_SYNC">ğŸ” Toplu Senkronizasyon</option>
            </select>
            <select id="chperms-audit-role-filter"
              style="padding:4px 8px;border-radius:6px;border:1px solid var(--bg-4);
                     background:var(--bg-3);color:var(--text-1);font-size:12px"
              onchange="chpermsApplyAuditFilter()">
              <option value="">TÃ¼m Roller</option>
              <option value="__everyone__">@everyone</option>
            </select>
            <div style="display:flex;align-items:center;gap:6px">
              <label style="font-size:11px;color:var(--text-3)">BaÅŸlangÄ±Ã§:</label>
              <input type="date" id="chperms-audit-since"
                style="padding:3px 7px;border-radius:6px;border:1px solid var(--bg-4);
                       background:var(--bg-3);color:var(--text-1);font-size:12px"
                onchange="chpermsApplyAuditFilter()">
            </div>
            <div style="display:flex;align-items:center;gap:6px">
              <label style="font-size:11px;color:var(--text-3)">BitiÅŸ:</label>
              <input type="date" id="chperms-audit-until"
                style="padding:3px 7px;border-radius:6px;border:1px solid var(--bg-4);
                       background:var(--bg-3);color:var(--text-1);font-size:12px"
                onchange="chpermsApplyAuditFilter()">
            </div>
            <button class="btn" onclick="chpermsResetAuditFilter()"
              style="font-size:11px;padding:3px 10px;margin-left:auto">â†º SÄ±fÄ±rla</button>
            <button class="btn" onclick="chpermsLoadAudit('${channelId}')"
              style="font-size:12px;padding:4px 10px">ğŸ”„ Yenile</button>
          </div>
          <div id="chperms-audit-body" style="flex:1;overflow-y:auto;padding:16px 24px">
            <p style="color:var(--text-3);font-size:13px">GeÃ§miÅŸ yÃ¼kleniyorâ€¦</p>
          </div>
        </div>

        <!-- â•â•â• SEKME: KATEGORÄ° SENKRONÄ°ZASYONU â•â•â• -->
        <div id="chperms-pane-sync" style="display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0">
          <div style="flex:1;overflow-y:auto;padding:20px 24px">
            <div style="background:var(--brand-bg,rgba(88,101,242,.08));border:1px solid var(--brand-border,rgba(88,101,242,.25));
                 border-radius:10px;padding:14px 16px;margin-bottom:18px">
              <p style="font-size:13px;font-weight:700;margin-bottom:4px">ğŸ” Bu KanalÄ±n Ä°zinlerini Kanallara Uygula</p>
              <p style="font-size:12px;color:var(--text-3)">
                Åu anda kaydedilmiÅŸ izinleri seÃ§ili kanallara kopyalar. Hedef kanallarÄ±n mevcut override'larÄ±nÄ±n <strong>Ã¼zerine yazar</strong>.
              </p>
            </div>
            <div style="margin-bottom:16px">
              <label style="font-size:12px;font-weight:700;color:var(--text-2);display:block;margin-bottom:8px">
                ğŸ¯ Hangi Kanallara UygulansÄ±n?
              </label>
              <div id="chperms-sync-channel-list" style="display:flex;flex-direction:column;gap:6px;
                   max-height:280px;overflow-y:auto;padding:10px;background:var(--bg-2);
                   border-radius:8px;border:1px solid var(--bg-4)">
                <p style="color:var(--text-3);font-size:12px">Kanallar yÃ¼kleniyorâ€¦</p>
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">
              <button class="btn" onclick="chpermsSyncSelectAll(true)"
                style="font-size:12px;padding:5px 12px">TÃ¼mÃ¼nÃ¼ SeÃ§</button>
              <button class="btn" onclick="chpermsSyncSelectAll(false)"
                style="font-size:12px;padding:5px 12px">HiÃ§birini SeÃ§me</button>
              <span id="chperms-sync-count" style="font-size:12px;color:var(--text-3)"></span>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
              <button class="btn btn-primary" onclick="chpermsBulkSyncPreview('${channelId}')"
                style="padding:8px 18px;font-weight:700">ğŸ” Ã–nizle ve Uygula</button>
              <span id="chperms-sync-status" style="font-size:12px;color:var(--text-3)"></span>
            </div>
          </div>
        </div>

      </div>`;

    document.body.appendChild(overlay);

    function _tryClose() {
      if (_isDirty) {
        if (!confirm('KaydedilmemiÅŸ deÄŸiÅŸiklikler var. Ã‡Ä±kmak istediÄŸine emin misin?')) return;
      }
      overlay.remove();
    }

    document.getElementById('chperms-close-btn').addEventListener('click', _tryClose);
    document.getElementById('chperms-cancel-btn').addEventListener('click', _tryClose);
    overlay.addEventListener('click', e => { if (e.target === overlay) _tryClose(); });
  }

  // â”€â”€ ÅABLON UYGULA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.chpermsApplyTemplate = function (templateId) {
    if (!templateId) return;
    const tpl = PERM_TEMPLATES.find(t => t.id === templateId);
    if (!tpl) return;
    if (!confirm(`"${tpl.label}" ÅŸablonu uygulanacak:\n\n${tpl.desc}\n\nMevcut tÃ¼m override'lar gÃ¼ncellenir. Devam et?`)) {
      { const _t = document.getElementById('chperms-template-select') as HTMLInputElement | null; if (_t) _t.value = ''; }
      return;
    }
    const applied = tpl.apply(_allRows);
    for (const [id, val] of Object.entries(applied)) {
      const row = _allRows.find(r => r._id === id);
      if (row) row.ov = { allow: val.allow, deny: val.deny };
    }
    document.getElementById('chperms-matrix').innerHTML = buildPermMatrix(_allRows);
    { const _t = document.getElementById('chperms-template-select') as HTMLInputElement | null; if (_t) _t.value = ''; }
    _markDirty();
    _updateSaveInfo();
    toast(`"${tpl.label}" ÅŸablonu uygulandÄ± âœ…`, 'success');
  };

  // â”€â”€ KULLANICI ARAMA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.chpermsOpenUserSearch = function () {
    const existingPanel = document.getElementById('user-search-panel');
    if (existingPanel) { existingPanel.remove(); return; }
    const matrix = document.getElementById('chperms-matrix');
    if (!matrix) return;

    const panel = document.createElement('div');
    panel.id = 'user-search-panel';
    panel.style.cssText = `position:sticky;top:0;z-index:100;background:var(--bg-2);
      border:1px solid var(--brand);border-radius:8px;padding:12px 16px;margin-bottom:16px`;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-weight:700;font-size:13px">ğŸ‘¤ Ãœyeye Ã–zel Ä°zin Ekle</span>
        <button onclick="document.getElementById('user-search-panel')?.remove()"
          style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:16px;margin-left:auto">âœ•</button>
      </div>
      <input id="user-search-input" type="text" placeholder="Ãœye adÄ± ara (en az 2 karakter)..."
        style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;
               border:1px solid var(--bg-4);background:var(--bg-3);color:var(--text-1);font-size:13px"
        oninput="chpermsSearchUser(this.value)">
      <div id="user-search-results" style="margin-top:8px;max-height:200px;overflow:auto"></div>
    `;
    matrix.insertBefore(panel, matrix.firstChild);
    document.getElementById('user-search-input').focus();
  };

  window.chpermsSearchUser = async function (query) {
    const resultsEl = document.getElementById('user-search-results');
    if (!resultsEl) return;
    if (query.trim().length < 2) { resultsEl.innerHTML = ''; return; }
    const existingUserIds = _allRows.filter(r => r.isUser).map(r => r.userId);
    try {
      const r = await apiFetch(`${API}/api/servers/${currentServer._id}/members?search=${encodeURIComponent(query.trim())}&limit=8`);
      if (!r.ok) { resultsEl.innerHTML = '<p style="color:var(--text-3);font-size:12px;padding:4px 8px">Arama baÅŸarÄ±sÄ±z</p>'; return; }
      const members = await r.json();
      if (!members.length) {
        resultsEl.innerHTML = '<p style="color:var(--text-3);font-size:12px;padding:4px 8px">SonuÃ§ bulunamadÄ±</p>';
        return;
      }
      resultsEl.innerHTML = members.map(m => {
        const uid     = m.userId || m._id;
        const name    = m.displayName || m.username || uid;
        const already = existingUserIds.includes(uid);
        const esc_uid  = escHtml(uid);
        const esc_name = escHtml(name).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
        return `<div style="display:flex;align-items:center;gap:10px;padding:7px 10px;border-radius:6px;
            opacity:${already ? 0.5 : 1};cursor:${already ? 'default' : 'pointer'};transition:background .15s"
            ${already ? '' : `onclick="chpermsAddUser('${esc_uid}', '${esc_name}')"
            onmouseenter="this.style.background='var(--bg-3)'"
            onmouseleave="this.style.background=''`}>
          <span style="width:30px;height:30px;border-radius:50%;background:var(--brand,#5865f2);
            display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;color:#fff;flex-shrink:0">${escHtml(initials(name))}</span>
          <span style="font-size:13px;flex:1">${escHtml(name)}</span>
          <span style="font-size:11px;color:${already ? 'var(--text-3)' : 'var(--brand)'}">
            ${already ? 'Zaten eklendi' : '+ Ekle'}
          </span>
        </div>`;
      }).join('');
    } catch {
      resultsEl.innerHTML = '<p style="color:var(--text-3);font-size:12px;padding:4px 8px">Arama hatasÄ±</p>';
    }
  };

  window.chpermsAddUser = function (userId, displayName) {
    const rowId = `user:${userId}`;
    if (_allRows.find(r => r._id === rowId)) { toast('Bu Ã¼ye zaten listede', 'info'); return; }
    const newRow = { _id: rowId, name: displayName, color: '#5865f2', isEveryone: false, isUser: true, userId, ov: { allow: 0, deny: 0 } };
    _allRows.push(newRow);
    _snapshot[rowId] = { allow: 0, deny: 0 };
    const sel = document.getElementById('chperms-role-select');
    if (sel) {
      const opt = document.createElement('option');
      opt.value = rowId;
      opt.textContent = `ğŸ‘¤ ${displayName}`;
      sel.appendChild(opt);
    }
    document.getElementById('chperms-matrix').innerHTML = buildPermMatrix(_allRows);
    document.getElementById('user-search-panel')?.remove();
    chpermsSelectRole(rowId);
    _markDirty(); _updateSaveInfo();
    toast(`${displayName} eklendi â€” izinleri ayarla ve kaydet`, 'success');
  };

  // â”€â”€ CYCLE PERM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.cyclePerm = function (btn) {
    const states = ['neutral', 'allow', 'deny'];
    const icons  = { neutral: 'â€”', allow: 'âœ…', deny: 'âŒ' };
    const classes = { neutral: '', allow: 'allow', deny: 'deny' };
    const next = states[(states.indexOf(btn.dataset.state) + 1) % states.length];
    btn.dataset.state = next;
    btn.textContent   = icons[next];
    btn.className     = 'perm-toggle ' + classes[next];
    _markDirty(); _updateSaveInfo();
  };

  // â”€â”€ SAVE INFO â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  function _updateSaveInfo() {
    const info = document.getElementById('chperms-save-info');
    if (!info) return;
    const rows = document.querySelectorAll('#ch-perms-modal tr[data-role-id]');
    let count = 0;
    const seen = new Set();
    rows.forEach(tr => {
      const id = tr.dataset.roleId;
      if (seen.has(id)) return; seen.add(id);
      if (_rowIsDirty(id, _readRow(tr))) count++;
    });
    Object.values(_snapshot).forEach(v => { if (v === null) count++; });
    info.textContent = count > 0 ? `${count} deÄŸiÅŸiklik â€” sadece bunlar kaydedilecek` : '';
  }

  // â”€â”€ ROL/ÃœYE SEÃ‡Ä°CÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.chpermsSelectRole = function (rowId) {
    const row        = _allRows.find(r => r._id === rowId);
    const isUser     = row?.isUser || false;
    const isEveryone = rowId === '__everyone__';
    const hasRow     = !!rowId;

    ['btn-grant-all', 'btn-deny-all', 'btn-reset-all'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !hasRow;
    });
    const syncBtn   = document.getElementById('btn-sync-server');
    const removeBtn = document.getElementById('btn-remove-row');
    if (syncBtn)   { syncBtn.disabled = !hasRow || isUser || isEveryone; syncBtn.style.display = (isUser || isEveryone) ? 'none' : ''; }
    if (removeBtn) { removeBtn.disabled = !hasRow || isEveryone; }

    const sel = document.getElementById('chperms-role-select');
    if (sel && sel.value !== rowId) sel.value = rowId;

    document.querySelectorAll('#ch-perms-modal tr[data-role-id]').forEach(tr => {
      tr.style.outline      = (tr.dataset.roleId === rowId) ? '2px solid var(--brand)' : '';
      tr.style.borderRadius = '4px';
    });
  };

  function _selectedToggles() {
    const rowId = document.getElementById('chperms-role-select')?.value;
    if (!rowId) return [];
    return [...document.querySelectorAll(`#ch-perms-modal tr[data-role-id="${CSS.escape(rowId)}"] .perm-toggle`)];
  }

  function _applyState(btn, state) {
    const icons  = { neutral: 'â€”', allow: 'âœ…', deny: 'âŒ' };
    const classes = { neutral: '', allow: 'allow', deny: 'deny' };
    btn.dataset.state = state;
    btn.textContent   = icons[state];
    btn.className     = 'perm-toggle ' + classes[state];
  }

  window.chpermsGrantAll = function () { _selectedToggles().forEach(b => _applyState(b, 'allow')); _markDirty(); _updateSaveInfo(); };
  window.chpermsDenyAll  = function () { _selectedToggles().forEach(b => _applyState(b, 'deny'));  _markDirty(); _updateSaveInfo(); };
  window.chpermsResetAll = function () { _selectedToggles().forEach(b => _applyState(b, 'neutral')); _markDirty(); _updateSaveInfo(); };

  window.chpermsRemoveRow = function () {
    const rowId = document.getElementById('chperms-role-select')?.value;
    if (!rowId || rowId === '__everyone__') return;
    const row = _allRows.find(r => r._id === rowId);
    if (!row) return;
    if (!confirm(`"${row.name}" override'Ä± kaldÄ±rÄ±lsÄ±n?`)) return;

    const idx = _allRows.findIndex(r => r._id === rowId);
    if (idx !== -1) _allRows.splice(idx, 1);
    _snapshot[rowId] = null;

    const sel = document.getElementById('chperms-role-select');
    sel?.querySelector(`option[value="${CSS.escape(rowId)}"]`)?.remove();
    if (sel) sel.value = '';
    chpermsSelectRole('');

    document.getElementById('chperms-matrix').innerHTML = buildPermMatrix(_allRows);
    _markDirty(); _updateSaveInfo();
    toast(`"${row.name}" override'Ä± kaldÄ±rÄ±ldÄ± â€” kaydetmeyi unutma`, 'info');
  };

  window.chpermsSyncServer = function () {
    const rowId = document.getElementById('chperms-role-select')?.value;
    if (!rowId || rowId === '__everyone__') return;
    const row = _allRows.find(r => r._id === rowId);
    if (!row || row.isUser) return;
    const serverBits = _serverPerms[rowId] ?? 0;
    _selectedToggles().forEach(btn => {
      const bit = parseInt(btn.dataset.bit, 10);
      _applyState(btn, (serverBits & bit) !== 0 ? 'allow' : 'deny');
    });
    _markDirty(); _updateSaveInfo();
    toast('Sunucu izinleri kanal override\'larÄ±na yansÄ±tÄ±ldÄ± ğŸ”„', 'success');
  };

  // â”€â”€ SEKME GEÃ‡Ä°ÅÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.chpermsTab = function (tab) {
    const activeTab = document.querySelector('.chperms-tab-active')?.dataset?.tab;
    if (activeTab === 'matrix' && tab !== 'matrix' && _isDirty) {
      if (!confirm('KaydedilmemiÅŸ deÄŸiÅŸiklikler var. Sekmeyi deÄŸiÅŸtirmek istiyor musun?')) return;
    }
    ['matrix', 'audit', 'sync'].forEach(p => {
      const el = document.getElementById(`chperms-pane-${p}`);
      if (el) el.style.display = (p === tab) ? 'flex' : 'none';
    });
    document.querySelectorAll('.chperms-tab').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('chperms-tab-active', active);
      btn.style.color        = active ? 'var(--text-1)' : 'var(--text-3)';
      btn.style.borderBottom = active ? '2px solid var(--brand)' : '2px solid transparent';
    });
    if (tab === 'audit' && _currentChannelId) chpermsLoadAudit(_currentChannelId);
    if (tab === 'sync'  && _currentChannelId) chpermsLoadSyncList(_currentChannelId);
  };

  // â”€â”€ EXPORT / IMPORT â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.chpermsExport = async function (channelId) {
    try {
      const res  = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/export`);
      const blob = new Blob([JSON.stringify(res, null, 2)], { type: 'application/json' });
      const url  = URL.createObjectURL(blob);
      const a    = document.createElement('a');
      a.href = url; a.download = `permissions-${channelId}.json`; a.click();
      URL.revokeObjectURL(url);
      toast('Ä°zin yapÄ±sÄ± dÄ±ÅŸa aktarÄ±ldÄ± âœ…', 'success');
    } catch {
      toast('DÄ±ÅŸa aktarma baÅŸarÄ±sÄ±z oldu', 'error');
    }
  };

  window.chpermsImportClick = function () {
    document.getElementById('chperms-import-file')?.click();
  };

  window.chpermsImportFile = async function (channelId, input) {
    const file = input.files?.[0];
    if (!file) return;
    input.value = '';
    let data;
    try { data = JSON.parse(await file.text()); } catch { toast('GeÃ§ersiz JSON dosyasÄ±', 'error'); return; }
    if (!Array.isArray(data.overrides) || data.overrides.length === 0) {
      toast('Dosyada geÃ§erli override bulunamadÄ±', 'error'); return;
    }
    const merge = confirm(
      `"${data.sourceChannel || 'Bilinmiyor'}" kanalÄ±ndan ${data.overrides.length} override iÃ§e aktarÄ±lacak.\n\n` +
      `"Tamam" â†’ Mevcut override'lara ekle/gÃ¼ncelle\n"Ä°ptal" â†’ Sadece yenilerini ekle`
    );
    try {
      const res = await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/import`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides: data.overrides, merge }) }
      );
      toast(`âœ… ${res.imported} override iÃ§e aktarÄ±ldÄ±`, 'success');
      if (res.skippedCount > 0) {
        const names = res.skipped.map(s => s.roleName || s.roleId).join(', ');
        toast(`âš ï¸ ${res.skippedCount} kullanÄ±cÄ± override'Ä± atlandÄ±: ${names}`, 'warning', 8000);
      }
      const ch = currentServer?.channels?.find?.(c => c._id === channelId) || { _id: channelId, name: channelId };
      setTimeout(() => openChannelPermsModal(channelId, ch.name || channelId), 200);
    } catch {
      toast('Ä°Ã§e aktarma baÅŸarÄ±sÄ±z oldu', 'error');
    }
  };

  // â”€â”€ KAYDET â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  window.saveChannelPerms = async function (channelId) {
    const rows      = document.querySelectorAll('#ch-perms-modal tr[data-role-id]');
    const overrides = [];
    const deletes   = [];
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
        overrides.push({ roleId: id, allow: cur.allow, deny: cur.deny, targetType: 'user', targetId: rowData.userId, targetName: rowData.name });
      } else {
        overrides.push({ roleId: id, allow: cur.allow, deny: cur.deny });
      }
    }
    for (const [snapId, val] of Object.entries(_snapshot)) {
      if (val === null) deletes.push(snapId);
    }

    if (overrides.length === 0 && deletes.length === 0) {
      toast('DeÄŸiÅŸiklik yok, kaydedilecek bir ÅŸey bulunamadÄ±.', 'info'); return;
    }

    try {
      await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/batch`,
        { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ overrides, deletes }) }
      );
      rows.forEach(row => {
        const id = row.dataset.roleId;
        if (_snapshot[id] !== null) _snapshot[id] = _readRow(row);
      });
      for (const id of Object.keys(_snapshot)) {
        if (_snapshot[id] === null) delete _snapshot[id];
      }
      _clearDirty(); _updateSaveInfo();
      toast(`${overrides.length + deletes.length} izin deÄŸiÅŸikliÄŸi kaydedildi âœ…`, 'success');
      document.getElementById('ch-perms-modal')?.remove();
    } catch {
      toast('Kaydetme sÄ±rasÄ±nda hata oluÅŸtu', 'error');
    }
  };

  // â”€â”€ SOCKET: gerÃ§ek zamanlÄ± izin gÃ¼ncellemesi â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

  (function _registerPermSocketListener() {
    let _attempts = 0;
    const _try = () => {
      if (typeof socket === 'undefined' || !socket) {
        if (++_attempts < 20) setTimeout(_try, 500);
        return;
      }
      socket.off('permissions:updated', _onPermsUpdated);
      socket.on('permissions:updated', _onPermsUpdated);
    };

    function _onPermsUpdated({ serverId, channelId }) {
      if (!currentServer || currentServer._id !== serverId) return;
      if (typeof loadServerChannels === 'function') {
        loadServerChannels(serverId).catch(() => {});
      } else if (typeof renderChannels === 'function') {
        renderChannels();
      }
      const modal = document.getElementById('ch-perms-modal');
      if (modal && window._channelId === channelId && !_isDirty) {
        toast('âš ï¸ Bu kanalÄ±n izinleri baÅŸka bir admin tarafÄ±ndan gÃ¼ncellendi', 'info');
      }
    }
    _try();
  })();

})();

