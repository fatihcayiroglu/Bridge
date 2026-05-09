// client/js/core/channel-perms-inheritance.js
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// Ä°zin KalÄ±tÄ±mÄ± GÃ¶rselleÅŸtirmesi â€” "Bu izin nereden geliyor?" popup
// BaÄŸÄ±mlÄ±lÄ±klar: channel-perms-data.js (PERM_GROUPS)
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
'use strict';

const SOURCE_ICONS = {
  channel_override: 'ğŸ“Œ',
  role:             'ğŸ·ï¸',
  server_default:   'ğŸŒ',
  none:             'ğŸš«',
};

/**
 * â„¹ butonuna tÄ±klanÄ±nca izin kaynaÄŸÄ±nÄ± gÃ¶steren popup aÃ§ar.
 * _channelId dÄ±ÅŸ scope'tan (channel-permissions.js) okunur.
 */
window.chpermsShowInheritance = async function (btn) {
  const bit    = parseInt(btn.dataset.bit, 10);
  const roleId = btn.dataset.roleId;
  const rect   = btn.getBoundingClientRect();

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

  const _close = e => {
    if (!popup.contains(e.target) && e.target !== btn) {
      popup.remove();
      document.removeEventListener('mousedown', _close);
    }
  };
  setTimeout(() => document.addEventListener('mousedown', _close), 50);

  try {
    // _channelId, channel-permissions.js ana modÃ¼lÃ¼nden saÄŸlanÄ±r
    const data = await apiFetch(
      `${API}/api/servers/${currentServer._id}/channels/${_channelId}/permissions/inheritance/${encodeURIComponent(roleId)}`
    );

    let permLabel = `Bit 0x${bit.toString(16)}`;
    for (const g of PERM_GROUPS) {
      const p = g.perms.find(p => p.bit === bit);
      if (p) { permLabel = p.label; break; }
    }

    const src        = data.bitSources?.[bit];
    const icon       = SOURCE_ICONS[src?.source] || 'â“';
    const isAllow    = src?.state === 'allow';
    const stateLabel = isAllow ? 'âœ… Ä°zin Veriliyor' : 'âŒ Reddediliyor';
    const stateColor = isAllow ? 'var(--online,#3ba55c)' : 'var(--danger,#ed4245)';

    popup.innerHTML = `
      <div style="font-weight:800;font-size:13px;margin-bottom:10px;color:var(--text-1)">
        ${icon} ${escHtml(permLabel)}
      </div>

      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="font-size:18px">${isAllow ? 'âœ…' : 'âŒ'}</span>
        <span style="font-weight:700;color:${stateColor}">${stateLabel}</span>
      </div>

      <div style="background:var(--bg-2);border-radius:7px;padding:8px 10px;margin-bottom:8px">
        <div style="font-size:11px;color:var(--text-3);margin-bottom:2px">KAYNAK</div>
        <div style="font-size:12px;color:var(--text-1);font-weight:600">${icon} ${escHtml(src?.label || 'Bilinmiyor')}</div>
      </div>

      <div style="font-size:11px;color:var(--text-3);margin-bottom:6px;font-weight:600">Ä°ZÄ°N ZÄ°NCÄ°RÄ°</div>
      <div style="display:flex;flex-direction:column;gap:3px">
        ${_buildInheritanceChain(data, bit)}
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

function _buildInheritanceChain(data, bit) {
  const rows = [];

  // 1. Sunucu varsayÄ±lanÄ±
  const fromDefault = (data.serverDefault & bit) !== 0;
  rows.push(_chainRow('ğŸŒ Sunucu VarsayÄ±lanÄ±',
    fromDefault ? 'allow' : 'none',
    data.bitSources?.[bit]?.source === 'server_default'));

  // 2. Rol izni
  if (!data.isUser && data.rolePermissions !== undefined) {
    const fromRole = (data.rolePermissions & bit) !== 0;
    rows.push(_chainRow(`ğŸ·ï¸ Rol: ${escHtml(data.roleName)}`,
      fromRole ? 'allow' : 'none',
      data.bitSources?.[bit]?.source === 'role'));
  }

  // 3. Kanal override
  if (data.hasOverride && data.override) {
    const ovrAllow = (data.override.allow & bit) !== 0;
    const ovrDeny  = (data.override.deny  & bit) !== 0;
    const state    = ovrAllow ? 'allow' : ovrDeny ? 'deny' : 'neutral';
    rows.push(_chainRow('ğŸ“Œ Kanal Override', state,
      data.bitSources?.[bit]?.source === 'channel_override'));
  }

  return rows.join('');
}

function _chainRow(label, state, isActive) {
  const icon   = state === 'allow' ? 'âœ…' : state === 'deny' ? 'âŒ' : 'â€”';
  const color  = isActive ? 'var(--brand)' : 'var(--text-3)';
  const weight = isActive ? '700' : '400';
  return `<div style="display:flex;align-items:center;gap:6px;font-size:11px;
    padding:3px 6px;border-radius:5px;${isActive ? 'background:var(--brand-bg,rgba(88,101,242,.08))' : ''}">
    <span>${icon}</span>
    <span style="color:${color};font-weight:${weight};flex:1">${label}</span>
    ${isActive ? '<span style="font-size:9px;color:var(--brand);font-weight:800">â—€ ETKÄ°N</span>' : ''}
  </div>`;
}

