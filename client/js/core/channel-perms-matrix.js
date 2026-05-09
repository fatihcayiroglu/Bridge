// client/js/core/channel-perms-matrix.js
// ══════════════════════════════════════════════════
// İzin matrisi HTML oluşturma
// Bağımlılıklar: channel-perms-data.js (PERM_GROUPS)
// ══════════════════════════════════════════════════
'use strict';

/**
 * Tüm satırlar için izin matrisi HTML'i oluşturur.
 * @param {Array} allRows  - _allRows state array
 * @returns {string} HTML
 */
function buildPermMatrix(allRows) {
  if (allRows.length === 0) {
    return '<p style="color:var(--text-3);padding:20px">Henüz override yok.</p>';
  }

  const hoverStyle = `<style>
    #chperms-matrix td:hover .perm-inherit-btn { opacity: 1 !important; }
    #chperms-matrix td { position: relative; }
  </style>`;

  const userRows  = allRows.filter(r => r.isUser);
  const otherRows = allRows.filter(r => !r.isUser);

  let userSectionNote = '';
  if (userRows.length > 0) {
    userSectionNote = `<div style="font-size:11px;color:var(--brand);margin-bottom:8px;padding:6px 10px;
      background:var(--brand-bg,rgba(88,101,242,.08));border-radius:6px;border-left:3px solid var(--brand)">
      👤 Üye bazlı override'lar sunucudaki en yüksek önceliğe sahiptir — rol izinlerini geçersiz kılar.
    </div>`;
  }

  let html = '';
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
                   font-size:11px;color:var(--text-3);font-weight:600">Rol / Üye</th>
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
            ${[...otherRows, ...userRows].map(row => buildPermRow(row, group.perms)).join('')}
          </tbody>
        </table>
      </div>`;
    userSectionNote = ''; // sadece ilk grupta göster
  }

  return hoverStyle + html;
}

/**
 * Tek bir satır için HTML oluşturur.
 */
function buildPermRow(row, perms) {
  const ov     = row.ov || { allow: 0, deny: 0 };
  const isUser = row.isUser;
  const isEv   = row.isEveryone;

  let cells = `<td style="padding:6px 8px">
    <span style="display:inline-flex;align-items:center;gap:6px;font-size:13px;
      ${isEv ? 'font-weight:700;color:var(--brand)' : ''}${isUser ? 'font-style:italic' : ''}">
      <span style="width:10px;height:10px;border-radius:${isUser ? '3px' : '50%'};
        background:${row.color || '#99aab5'};flex-shrink:0"></span>
      ${isUser ? '👤 ' : ''}${escHtml(row.name)}
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
        ${allowed ? '✅' : denied ? '❌' : '—'}
      </button>
      <button class="perm-inherit-btn"
        data-bit="${perm.bit}"
        data-role-id="${escHtml(row._id)}"
        onclick="chpermsShowInheritance(this)"
        title="Bu iznin kaynağını göster"
        style="position:absolute;top:1px;right:1px;background:none;border:none;
               cursor:pointer;font-size:9px;color:var(--text-3);opacity:0;
               transition:opacity .15s;padding:1px 3px;border-radius:3px;
               line-height:1">ℹ</button>
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

export {
  buildPermMatrix,
  buildPermRow,
};

