// client/js/core/channel-perms-modal.js.1
// Kanal izin modalÄ± UI.
// BaÄŸÄ±mlÄ±lÄ±klar: channel-perms-data.js (PERM_GROUPS, ALL_PERMS, PERM_TEMPLATES global)
// YÃ¼kleme sÄ±rasÄ±: channel-perms-data.js â†’ channel-perms-modal.js

(function () {
  // Veri modÃ¼lÃ¼nden global'leri al
  /* globals PERM_GROUPS, ALL_PERMS, PERM_TEMPLATES */
  const TEMPLATES = window.PERM_TEMPLATES;


  // â”€â”€ MODAL STATE â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  let _channelId    = null;
  let _serverPerms  = {};
  let _snapshot     = {};
  let _isDirty      = false;
  let _allRows      = [];

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
    if (snap === null) return true; // silinecek satÄ±r
    const s = snap || { allow: 0, deny: 0 };
    return cur.allow !== s.allow || cur.deny !== s.deny;
  }

  // â”€â”€ OPEN MODAL â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.openChannelPermsModal = async function (channelId, channelName) {
    if (!currentServer) return;
    document.getElementById('ch-perms-modal')?.remove();
    _channelId        = channelId; // inheritance popup iÃ§in
    _currentChannelId = channelId; // audit & sync sekmesi iÃ§in
    _isDirty     = false;
    _snapshot    = {};
    _serverPerms = {};
    _allRows     = [];

    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions`);
    if (!r.ok) return toast('Ä°zinler yÃ¼klenemedi', 'error');
    const { overrides, roles } = await r.json();

    const overrideMap = {};
    for (const o of overrides) {
      const key = o.targetType === 'user'
        ? `user:${o.targetId}`
        : o.targetType === 'everyone'
          ? '__everyone__'
          : o.targetId;
      overrideMap[key] = o;
    }

    const everyoneOvr = overrides.find(o => o.targetType === 'everyone') || { allow: 0, deny: 0 };
    for (const role of roles) _serverPerms[role._id] = role.permissions || 0;

    const userOverrides = overrides.filter(o => o.targetType === 'user');

    _snapshot['__everyone__'] = { allow: everyoneOvr.allow || 0, deny: everyoneOvr.deny || 0 };
    for (const role of roles) {
      const ov = overrideMap[role._id] || { allow: 0, deny: 0 };
      _snapshot[role._id] = { allow: ov.allow || 0, deny: ov.deny || 0 };
    }
    for (const uo of userOverrides) {
      _snapshot[`user:${uo.targetId}`] = { allow: uo.allow || 0, deny: uo.deny || 0 };
    }

    _allRows = [
      { _id: '__everyone__', name: '@everyone', color: '#99aab5', isEveryone: true, isUser: false,
        ov: everyoneOvr },
      ...roles.map(role => ({
        ...role, isEveryone: false, isUser: false,
        ov: overrideMap[role._id] || { allow: 0, deny: 0 }
      })),
      ...userOverrides.map(uo => ({
        _id: `user:${uo.targetId}`, name: uo.targetName || uo.targetId,
        color: '#5865f2', isEveryone: false, isUser: true,
        userId: uo.targetId,
        ov: { allow: uo.allow || 0, deny: uo.deny || 0 }
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
              Rol ve Ã¼ye bazlÄ± izinleri Ã¶zelleÅŸtir. &nbsp;âœ… Ä°zin ver &nbsp;âŒ Reddet &nbsp;â€” VarsayÄ±lan (sunucu izni geÃ§erli) &nbsp;Â·&nbsp; <em>ÃœstÃ¼ne gel â†’ aÃ§Ä±klama gÃ¶rÃ¼r</em>
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

            <!-- Åablon -->
            <div style="display:flex;align-items:center;gap:6px">
              <span style="font-size:11px;color:var(--text-3);white-space:nowrap;font-weight:600">ğŸ“ Åablon:</span>
              <select id="chperms-template-select"
                style="padding:5px 10px;border-radius:6px;border:1px solid var(--bg-4);
                       background:var(--bg-3);color:var(--text-1);font-size:12px"
                onchange="chpermsApplyTemplate(this.value)">
                <option value="">â€” SeÃ§ â€”</option>
                ${TEMPLATES.map(t => `<option value="${t.id}" title="${escHtml(t.desc)}">${t.icon} ${escHtml(t.label)}</option>`).join('')}
              </select>
            </div>

            <div style="width:1px;height:24px;background:var(--bg-4);margin:0 2px"></div>

            <!-- Rol/Ãœye SeÃ§ici -->
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
              style="font-size:12px;padding:5px 12px"
              title="Belirli bir Ã¼yeye Ã¶zel kanal izni ver">
              ğŸ‘¤+ Ãœye Ekle
            </button>

            <button class="btn btn-success" id="btn-grant-all" disabled onclick="chpermsGrantAll()"
              style="font-size:12px;padding:5px 12px">âœ… TÃ¼mÃ¼ne Ä°zin Ver</button>

            <button class="btn btn-danger" id="btn-deny-all" disabled onclick="chpermsDenyAll()"
              style="font-size:12px;padding:5px 12px">âŒ TÃ¼mÃ¼nÃ¼ Reddet</button>

            <button class="btn" id="btn-reset-all" disabled onclick="chpermsResetAll()"
              style="font-size:12px;padding:5px 12px">â€” SÄ±fÄ±rla</button>

            <button class="btn" id="btn-remove-row" disabled onclick="chpermsRemoveRow()"
              style="font-size:12px;padding:5px 12px;color:var(--danger,#ed4245)"
              title="SeÃ§ili rol/Ã¼ye override'Ä±nÄ± kaldÄ±r">ğŸ—‘ï¸ KaldÄ±r</button>

            <button class="btn" id="btn-sync-server" disabled onclick="chpermsSyncServer()"
              title="Bu rolÃ¼n sunucu genelindeki izinlerini kanal override'larÄ±na yansÄ±t"
              style="font-size:12px;padding:5px 12px;margin-left:auto">
              ğŸ”„ Sunucu Ä°le Senkronize</button>

            <div style="width:1px;height:24px;background:var(--bg-4);margin:0 2px"></div>

            <!-- FIX #13: Export / Import -->
            <button class="btn" onclick="chpermsExport('${channelId}')"
              title="Bu kanalÄ±n izin yapÄ±sÄ±nÄ± JSON olarak indir"
              style="font-size:12px;padding:5px 12px">
              ğŸ“¤ DÄ±ÅŸa Aktar</button>

            <button class="btn" onclick="chpermsImportClick('${channelId}')"
              title="BaÅŸka bir kanaldan export edilmiÅŸ JSON'Ä± bu kanala uygula"
              style="font-size:12px;padding:5px 12px">
              ğŸ“¥ Ä°Ã§e Aktar</button>
            <input type="file" id="chperms-import-file" accept=".json"
              style="display:none" onchange="chpermsImportFile('${channelId}', this)">
          </div>

          <!-- MATRIX -->
          <div id="chperms-matrix" style="overflow:auto;flex:1;padding:16px 24px">
            ${_buildMatrix()}
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

        <!-- â•â•â• SEKME: DEÄÄ°ÅÄ°KLÄ°K GEÃ‡MÄ°ÅÄ° (AUDIT LOG) â•â•â• -->
        <div id="chperms-pane-audit" style="display:none;flex:1;flex-direction:column;overflow:hidden;min-height:0">
          <!-- FÄ°LTRE Ã‡UBUÄU (#11) -->
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
                style="padding:8px 18px;font-weight:700">
                ğŸ” Ã–nizle ve Uygula
              </button>
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

  // â”€â”€ BUILD MATRIX â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  function _buildMatrix() {
    if (_allRows.length === 0) return '<p style="color:var(--text-3);padding:20px">HenÃ¼z override yok.</p>';

    // â„¹ butonunu td hover'Ä±nda gÃ¶ster (#12)
    const hoverStyle = `<style>
      #chperms-matrix td:hover .perm-inherit-btn { opacity: 1 !important; }
      #chperms-matrix td { position: relative; }
    </style>`;

    let html = '';
    const userRows  = _allRows.filter(r => r.isUser);
    const otherRows = _allRows.filter(r => !r.isUser);

    // KullanÄ±cÄ± override'larÄ± varsa bilgi satÄ±rÄ±
    let userSectionNote = '';
    if (userRows.length > 0) {
      userSectionNote = `<div style="font-size:11px;color:var(--brand);margin-bottom:8px;padding:6px 10px;
        background:var(--brand-bg,rgba(88,101,242,.08));border-radius:6px;border-left:3px solid var(--brand)">
        ğŸ‘¤ Ãœye bazlÄ± override'lar sunucudaki en yÃ¼ksek Ã¶nceliÄŸe sahiptir â€” rol izinlerini geÃ§ersiz kÄ±lar.
      </div>`;
    }

    for (const group of PERM_GROUPS) {
      html += `
        <div style="margin-bottom:24px">
          <div style="font-size:11px;font-weight:700;text-transform:uppercase;
               letter-spacing:.07em;color:var(--text-3);margin-bottom:10px;
               display:flex;align-items:center;gap:8px">
            ${group.label}
            <div style="flex:1;height:1px;background:var(--bg-4)"></div>
          </div>
          ${userSectionNote}
          <table class="perm-matrix" style="width:100%;border-collapse:collapse">
            <thead>
              <tr>
                <th style="min-width:145px;text-align:left;padding:6px 8px;
                     font-size:11px;color:var(--text-3);font-weight:600">Rol / Ãœye</th>
                ${group.perms.map(p => `
                  <th style="min-width:76px;padding:4px 2px;font-size:10px;
                      color:var(--text-3);font-weight:600;text-align:center;line-height:1.2">
                    <span title="${escHtml(p.desc)}" style="cursor:help;
                      border-bottom:1px dotted var(--text-3);display:inline-block">
                      ${escHtml(p.label)}
                    </span>
                  </th>
                `).join('')}
              </tr>
            </thead>
            <tbody>
              ${[...otherRows, ...userRows].map(row => _buildRow(row, group.perms)).join('')}
            </tbody>
          </table>
        </div>`;
      userSectionNote = ''; // sadece ilk grupta gÃ¶ster
    }
    return hoverStyle + html;
  }

  function _buildRow(row, perms) {
    const ov     = row.ov || { allow: 0, deny: 0 };
    const isUser = row.isUser;
    const isEv   = row.isEveryone;

    let cells = `<td style="padding:6px 8px">
      <span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;
        ${isEv ? 'font-weight:700;color:var(--brand)' : ''}${isUser ? 'font-style:italic' : ''}">
        <span style="width:10px;height:10px;border-radius:${isUser ? '3px' : '50%'};
          background:${row.color || '#99aab5'};flex-shrink:0"></span>
        ${isUser ? 'ğŸ‘¤ ' : ''}${escHtml(row.name)}
      </span>
    </td>`;

    for (const perm of perms) {
      const allowed = ((ov.allow || 0) & perm.bit) !== 0;
      const denied  = ((ov.deny  || 0) & perm.bit) !== 0;
      const state   = allowed ? 'allow' : denied ? 'deny' : 'neutral';
      cells += `<td style="text-align:center;padding:3px;position:relative">
        <button class="perm-toggle ${allowed ? 'allow' : denied ? 'deny' : ''}"
          data-bit="${perm.bit}" data-state="${state}"
          data-role-id="${escHtml(row._id)}"
          onclick="cyclePerm(this)"
          title="${escHtml(perm.desc)}">
          ${allowed ? 'âœ…' : denied ? 'âŒ' : 'â€”'}
        </button>
        <button class="perm-inherit-btn"
          data-bit="${perm.bit}"
          data-role-id="${escHtml(row._id)}"
          onclick="chpermsShowInheritance(this)"
          title="Bu iznin kaynaÄŸÄ±nÄ± gÃ¶ster"
          style="position:absolute;top:1px;right:1px;background:none;border:none;
                 cursor:pointer;font-size:9px;color:var(--text-3);opacity:0;
                 transition:opacity .15s;padding:1px 3px;border-radius:3px;
                 line-height:1">â„¹</button>
      </td>`;
    }

    return `<tr data-role-id="${escHtml(row._id)}"
      style="${isEv
        ? 'background:var(--brand-bg-low,rgba(88,101,242,.07));border-bottom:2px solid var(--bg-4)'
        : isUser
          ? 'background:var(--brand-bg-xlow,rgba(88,101,242,.04));border-left:3px solid var(--brand,#5865f2)'
          : ''}">
      ${cells}</tr>`;
  }

  // â”€â”€ ÅABLON UYGULA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.chpermsApplyTemplate = function (templateId) {
    if (!templateId) return;
    const tpl = TEMPLATES.find(t => t.id === templateId);
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

    document.getElementById('chperms-matrix').innerHTML = _buildMatrix();
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
    panel.style.cssText = `
      position:sticky;top:0;z-index:100;background:var(--bg-2);
      border:1px solid var(--brand);border-radius:8px;
      padding:12px 16px;margin-bottom:16px;
    `;
    panel.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px">
        <span style="font-weight:700;font-size:13px">ğŸ‘¤ Ãœyeye Ã–zel Ä°zin Ekle</span>
        <span style="font-size:11px;color:var(--text-3)">â€” rol izinlerini geÃ§ersiz kÄ±lar, en yÃ¼ksek Ã¶ncelik</span>
        <button onclick="document.getElementById('user-search-panel')?.remove()"
          style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:16px;margin-left:auto">âœ•</button>
      </div>
      <input id="user-search-input" type="text" placeholder="Ãœye adÄ± ara (en az 2 karakter)..."
        style="width:100%;box-sizing:border-box;padding:8px 12px;border-radius:6px;
               border:1px solid var(--bg-4);background:var(--bg-3);
               color:var(--text-1);font-size:13px"
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
        return `
          <div style="display:flex;align-items:center;gap:10px;padding:7px 10px;
            border-radius:6px;opacity:${already ? 0.5 : 1};
            cursor:${already ? 'default' : 'pointer'};
            transition:background .15s"
            ${already ? '' : `onclick="chpermsAddUser('${esc_uid}', '${esc_name}')"
            onmouseenter="this.style.background='var(--bg-3)'"
            onmouseleave="this.style.background=''"` }>
            <span style="width:30px;height:30px;border-radius:50%;background:var(--brand,#5865f2);
              display:flex;align-items:center;justify-content:center;
              font-size:12px;font-weight:700;color:#fff;flex-shrink:0">${escHtml(initials(name))}</span>
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
    if (_allRows.find(r => r._id === rowId)) {
      toast('Bu Ã¼ye zaten listede', 'info');
      return;
    }

    const newRow = {
      _id: rowId, name: displayName, color: '#5865f2',
      isEveryone: false, isUser: true, userId,
      ov: { allow: 0, deny: 0 },
    };
    _allRows.push(newRow);
    _snapshot[rowId] = { allow: 0, deny: 0 };

    const sel = document.getElementById('chperms-role-select');
    if (sel) {
      const opt = document.createElement('option');
      opt.value = rowId;
      opt.textContent = `ğŸ‘¤ ${displayName}`;
      sel.appendChild(opt);
    }

    document.getElementById('chperms-matrix').innerHTML = _buildMatrix();
    document.getElementById('user-search-panel')?.remove();
    chpermsSelectRole(rowId);
    _markDirty();
    _updateSaveInfo();
    toast(`${displayName} eklendi â€” izinleri ayarla ve kaydet`, 'success');
  };

  // â”€â”€ CYCLE PERM â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.cyclePerm = function (btn) {
    const states  = ['neutral', 'allow', 'deny'];
    const icons   = { neutral: 'â€”', allow: 'âœ…', deny: 'âŒ' };
    const classes = { neutral: '', allow: 'allow', deny: 'deny' };
    const next = states[(states.indexOf(btn.dataset.state) + 1) % states.length];
    btn.dataset.state = next;
    btn.textContent   = icons[next];
    btn.className     = 'perm-toggle ' + classes[next];
    _markDirty();
    _updateSaveInfo();
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
    // KaldÄ±rÄ±lan satÄ±rlar
    Object.values(_snapshot).forEach(v => { if (v === null) count++; });
    info.textContent = count > 0
      ? `${count} deÄŸiÅŸiklik â€” sadece bunlar kaydedilecek`
      : '';
  }

  // â”€â”€ ROL/ÃœYE SEÃ‡Ä°CÄ° â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  window.chpermsSelectRole = function (rowId) {
    const hasRow     = !!rowId;
    const row        = _allRows.find(r => r._id === rowId);
    const isUser     = row?.isUser || false;
    const isEveryone = rowId === '__everyone__';

    ['btn-grant-all','btn-deny-all','btn-reset-all'].forEach(id => {
      const el = document.getElementById(id);
      if (el) el.disabled = !hasRow;
    });

    const syncBtn   = document.getElementById('btn-sync-server');
    const removeBtn = document.getElementById('btn-remove-row');
    if (syncBtn)   { syncBtn.disabled   = !hasRow || isUser || isEveryone; syncBtn.style.display = (isUser || isEveryone) ? 'none' : ''; }
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
    return [...document.querySelectorAll(
      `#ch-perms-modal tr[data-role-id="${CSS.escape(rowId)}"] .perm-toggle`
    )];
  }

  function _applyState(btn, state) {
    const icons   = { neutral: 'â€”', allow: 'âœ…', deny: 'âŒ' };
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
    if (!confirm(`"${row.name}" override'Ä± kaldÄ±rÄ±lsÄ±n? Bu deÄŸiÅŸiklik kaydedildiÄŸinde silinecek.`)) return;

    const idx = _allRows.findIndex(r => r._id === rowId);
    if (idx !== -1) _allRows.splice(idx, 1);
    _snapshot[rowId] = null; // null = DELETE isteÄŸi gÃ¶nder

    const sel = document.getElementById('chperms-role-select');
    sel?.querySelector(`option[value="${CSS.escape(rowId)}"]`)?.remove();
    if (sel) sel.value = '';
    chpermsSelectRole('');

    document.getElementById('chperms-matrix').innerHTML = _buildMatrix();
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
  let _currentChannelId = null; // modal aÃ§Ä±kken mevcut kanalId

  window.chpermsTab = function (tab) {
    // FIX #8: Matrix sekmesinden ayrÄ±lÄ±rken kaydedilmemiÅŸ deÄŸiÅŸiklik uyarÄ±sÄ±
    const activeTab = document.querySelector('.chperms-tab-active')?.dataset?.tab;
    if (activeTab === 'matrix' && tab !== 'matrix' && _isDirty) {
      if (!confirm('KaydedilmemiÅŸ deÄŸiÅŸiklikler var. Sekmeyi deÄŸiÅŸtirmek istiyor musun?\n(DeÄŸiÅŸiklikler kaybolmaz â€” geri dÃ¶nÃ¼p kaydedebilirsin.)')) {
        return;
      }
    }

    const panes = ['matrix', 'audit', 'sync'];
    for (const p of panes) {
      const el = document.getElementById(`chperms-pane-${p}`);
      if (el) el.style.display = (p === tab) ? 'flex' : 'none';
    }
    document.querySelectorAll('.chperms-tab').forEach(btn => {
      const active = btn.dataset.tab === tab;
      btn.classList.toggle('chperms-tab-active', active);
      btn.style.color       = active ? 'var(--text-1)' : 'var(--text-3)';
      btn.style.borderBottom = active ? '2px solid var(--brand)' : '2px solid transparent';
    });

    if (tab === 'audit' && _currentChannelId) chpermsLoadAudit(_currentChannelId);
    if (tab === 'sync'  && _currentChannelId) chpermsLoadSyncList(_currentChannelId);
  };

  // â”€â”€ AUDIT LOG â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
  // Ä°zin biti â†’ label haritasÄ± (audit + inheritance ortak kullanÄ±r)
  const BIT_LABELS = {};
  for (const g of PERM_GROUPS) for (const p of g.perms) BIT_LABELS[p.bit] = p.label;

  const ACTION_LABELS = {
    PERM_UPDATE:    { icon: 'âœï¸', label: 'Ä°zin GÃ¼ncellendi' },
    PERM_DELETE:    { icon: 'ğŸ—‘ï¸', label: 'Override Silindi' },
    PERM_BULK_SYNC: { icon: 'ğŸ”', label: 'Toplu Senkronize' },
  };

  function _diffBits(oldV, newV) {
    if (!oldV || !newV) return '';
    const changes = [];
    for (const [bit, lbl] of Object.entries(BIT_LABELS)) {
      const b = parseInt(bit);
      const wasAllow = (oldV.allow & b) !== 0, nowAllow = (newV.allow & b) !== 0;
      const wasDeny  = (oldV.deny  & b) !== 0, nowDeny  = (newV.deny  & b) !== 0;
      if (wasAllow !== nowAllow || wasDeny !== nowDeny) {
        const before = wasAllow ? 'âœ…' : (wasDeny ? 'âŒ' : 'â€”');
        const after  = nowAllow ? 'âœ…' : (nowDeny ? 'âŒ' : 'â€”');
        changes.push(`<span style="font-size:11px">${lbl}: ${before}â†’${after}</span>`);
      }
    }
    return changes.length
      ? changes.join(' &nbsp; ')
      : '<span style="font-size:11px;color:var(--text-3)">deÄŸiÅŸiklik detayÄ± yok</span>';
  }

  // Filtre state'i
  let _auditChannelId = null;

  window.chpermsLoadAudit = async function (channelId) {
    _auditChannelId = channelId;
    const body = document.getElementById('chperms-audit-body');
    if (!body) return;
    body.innerHTML = '<p style="color:var(--text-3);font-size:13px">YÃ¼kleniyorâ€¦</p>';

    // Query params oluÅŸtur
    const params = new URLSearchParams();
    const action   = document.getElementById('chperms-audit-action-filter')?.value;
    const targetId = document.getElementById('chperms-audit-role-filter')?.value;
    const since    = document.getElementById('chperms-audit-since')?.value;
    const until    = document.getElementById('chperms-audit-until')?.value;
    if (action)   params.set('action',   action);
    if (targetId) params.set('targetId', targetId);
    if (since)    params.set('since',    new Date(since).getTime());
    if (until)    params.set('until',    new Date(until + 'T23:59:59').getTime());

    try {
      const qs   = params.toString() ? '?' + params.toString() : '';
      const data = await apiFetch(
        `${API}/api/servers/${currentServer._id}/channels/${channelId}/permissions/audit-log${qs}`
      );
      const logs = data.logs || [];

      // Rol dropdown'Ä±nÄ± doldur (ilk yÃ¼klemede bir kez)
      const roleFilter = document.getElementById('chperms-audit-role-filter');
      if (roleFilter && roleFilter.options.length <= 2 && logs.length > 0) {
        const seenTargets = new Map();
        for (const l of logs) {
          if (l.targetId && l.targetId !== '__everyone__' && !seenTargets.has(l.targetId)) {
            seenTargets.set(l.targetId, l.targetName || l.targetId);
          }
        }
        for (const [id, name] of seenTargets) {
          const opt = document.createElement('option');
          opt.value = id;
          opt.textContent = name;
          roleFilter.appendChild(opt);
        }
      }

      if (logs.length === 0) {
        body.innerHTML = `<p style="color:var(--text-3);font-size:13px;padding:20px 0">
          ${params.toString() ? 'ğŸ” Bu filtreyle eÅŸleÅŸen kayÄ±t yok.' : 'HenÃ¼z kayÄ±tlÄ± deÄŸiÅŸiklik yok.'}
        </p>`;
        return;
      }

      body.innerHTML = `
        <div style="font-size:11px;color:var(--text-3);margin-bottom:10px;padding:6px 0">
          ${logs.length} kayÄ±t gÃ¶steriliyor
          ${params.toString() ? ' <span style="color:var(--brand)">(filtrelenmiÅŸ)</span>' : ''}
        </div>
        <table style="width:100%;border-collapse:collapse;font-size:12px">
          <thead>
            <tr style="border-bottom:2px solid var(--bg-4)">
              <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:130px">Tarih</th>
              <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:110px">Yapan</th>
              <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:90px">Ä°ÅŸlem</th>
              <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px;width:110px">Hedef</th>
              <th style="text-align:left;padding:6px 8px;color:var(--text-3);font-size:11px">DeÄŸiÅŸiklikler</th>
            </tr>
          </thead>
          <tbody>
            ${logs.map((l, i) => {
              const al    = ACTION_LABELS[l.action] || { icon: 'ğŸ“', label: l.action };
              const ts    = new Date(l.createdAt).toLocaleString('tr-TR', {
                day: '2-digit', month: '2-digit', year: 'numeric',
                hour: '2-digit', minute: '2-digit'
              });
              const rowBg = i % 2 === 0 ? 'background:var(--bg-2)' : '';
              return `<tr style="${rowBg}">
                <td style="padding:7px 8px;color:var(--text-3)">${ts}</td>
                <td style="padding:7px 8px;font-weight:600">${escHtml(l.actorName || '?')}</td>
                <td style="padding:7px 8px">${al.icon} ${escHtml(al.label)}</td>
                <td style="padding:7px 8px;color:var(--brand)">${escHtml(l.targetName || l.targetId || 'â€”')}</td>
                <td style="padding:7px 8px">${_diffBits(l.old, l.new)}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>`;
    } catch {
      body.innerHTML = '<p style="color:var(--danger,#ed4245);font-size:13px">GeÃ§miÅŸ yÃ¼klenemedi.</p>';
    }
  };

  // Filtre deÄŸiÅŸince yeniden yÃ¼kle
  window.chpermsApplyAuditFilter = function () {
    if (_auditChannelId) chpermsLoadAudit(_auditChannelId);
  };

  // Filtreleri sÄ±fÄ±rla
  window.chpermsResetAuditFilter = function () {
    const els = ['chperms-audit-action-filter', 'chperms-audit-role-filter',
                 'chperms-audit-since', 'chperms-audit-until'];
    els.forEach(id => {
      const el = document.getElementById(id);
      if (el) el.value = '';
    });
    if (_auditChannelId) chpermsLoadAudit(_auditChannelId);
  };

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

