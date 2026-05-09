export {};
// â”€â”€ 1. Sunucu listesinde federe badge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// renderServerList'ten sonra Ã§aÄŸrÄ±lÄ±r; federe sunuculara kÃ¼Ã§Ã¼k ğŸŒ
// rozeti ve tooltip ekler.

window._federationStats = null; // cache

async function _getFedStats() {
  if (window._federationStats) return window._federationStats;
  try {
    const r = await fetch(`${window.API || ''}/api/federation/stats`);
    if (!r.ok) return null;
    window._federationStats = await r.json();
    return window._federationStats;
  } catch { return null; }
}

/**
 * Sunucu listesindeki federe sunuculara gÃ¶rsel rozet ekler.
 * renderServerList() sonrasÄ±nda otomatik Ã§aÄŸrÄ±lÄ±r.
 * @param {Array} servers â€” /api/servers response
 */
function applyFederationBadges(servers) {
  if (!Array.isArray(servers)) return;
  servers.forEach(s => {
    if (!s.federated && !s.isFederated && !s.peerUrl && !s.remoteUrl) return;
    const el = document.querySelector(`.server-icon[data-id="${s._id}"]`);
    if (!el || el.querySelector('.fed-badge')) return;

    const badge = document.createElement('div');
    badge.className = 'fed-badge';
    badge.title = `Federe sunucu${s.peerUrl ? ` â€” ${s.peerUrl}` : ''}`;
    badge.style.cssText = `
      position:absolute; bottom:-2px; right:-2px;
      width:14px; height:14px; border-radius:50%;
      background:var(--brand,#5865f2);
      border:2px solid var(--bg-1,#1e1f22);
      display:flex; align-items:center; justify-content:center;
      font-size:7px; line-height:1; z-index:5;
    `;
    badge.textContent = 'ğŸŒ';
    el.style.position = 'relative';
    el.appendChild(badge);
  });
}

// renderServerList'i wrap et â€” badge'leri otomatik uygula
(function _patchRenderServerList() {
  const _orig = window.renderServerList;
  if (typeof _orig !== 'function') {
    // Fonksiyon henÃ¼z yÃ¼klenmediyse, load sonrasÄ± dene
    window.addEventListener('load', _patchRenderServerList, { once: true });
    return;
  }
  window.renderServerList = function(servers) {
    _orig.call(this, servers);
    applyFederationBadges(servers);
  };
})();

// â”€â”€ 2. Profil popup'Ä±na @user@sunucu federe kimlik ekle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// showMemberProfile'Ä± wrap et; kullanÄ±cÄ±nÄ±n username'ini alÄ±p
// @username@sunucu formatÄ±nda gÃ¶ster.

(function _patchShowMemberProfile() {
  const _orig = window.showMemberProfile;
  if (typeof _orig !== 'function') {
    window.addEventListener('load', _patchShowMemberProfile, { once: true });
    return;
  }
  window.showMemberProfile = async function(e, userId, displayName, avatarColor, bio, badge) {
    _orig.call(this, e, userId, displayName, avatarColor, bio, badge);

    // Popup oluÅŸturulduktan sonra federe kimliÄŸi ekle
    const popup = document.querySelector('.member-profile-popup');
    if (!popup) return;

    // KullanÄ±cÄ± detayÄ±nÄ± Ã§ek (username iÃ§in)
    try {
      const r = await fetch(`${window.API || ''}/api/users/${userId}/profile`);
      if (!r.ok) return;
      const user = await r.json();
      const stats = await _getFedStats();

      const username = user.username || userId;
      const instance = stats?.instance
        ? new URL(stats.instance).hostname
        : (window.location.hostname || 'bridge.local');

      const handle = `@${username}@${instance}`;

      // Mevcut badge/bio bloÄŸundan sonra handle ekle
      const nameEl = popup.querySelector('.profile-name');
      if (!nameEl || popup.querySelector('.fed-handle')) return;

      const handleEl = document.createElement('div');
      handleEl.className = 'fed-handle';
      handleEl.style.cssText = `
        font-size:11px; color:var(--text-muted,#72767d);
        margin-top:3px; font-family:monospace;
        display:flex; align-items:center; gap:5px; cursor:pointer;
        user-select:all;
      `;
      handleEl.innerHTML = `<span style="color:var(--brand,#5865f2)">ğŸŒ</span>${handle}`;
      handleEl.title = 'Federe kimlik â€” kopyalamak iÃ§in tÄ±kla';
      handleEl.onclick = () => {
        navigator.clipboard?.writeText(handle).then(() => {
          handleEl.textContent = 'âœ“ KopyalandÄ±!';
          setTimeout(() => {
            handleEl.innerHTML = `<span style="color:var(--brand,#5865f2)">ğŸŒ</span>${handle}`;
          }, 1500);
        });
      };

      nameEl.insertAdjacentElement('afterend', handleEl);
    } catch { /* sessizce geÃ§ */ }
  };
})();

// â”€â”€ 3. Kanal header'Ä±na "Federe Sunucu" rozeti â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// selectServer Ã§aÄŸrÄ±ldÄ±ÄŸÄ±nda federe sunucular iÃ§in baÅŸlÄ±k altÄ±na
// kÃ¼Ã§Ã¼k bir bilgi bandÄ± ekler.

(function _patchSelectServer() {
  const _orig = window.selectServer;
  if (typeof _orig !== 'function') {
    window.addEventListener('load', _patchSelectServer, { once: true });
    return;
  }
  window.selectServer = async function(server) {
    await _orig.call(this, server);

    // Ã–nceki federation bannerÄ±nÄ± kaldÄ±r
    document.getElementById('fed-server-banner')?.remove();

    const isFed = server.federated || server.isFederated || server.peerUrl || server.remoteUrl;
    if (!isFed) return;

    const nameEl = document.getElementById('sidebar-server-name');
    if (!nameEl) return;

    const banner = document.createElement('div');
    banner.id = 'fed-server-banner';
    banner.style.cssText = `
      display:flex; align-items:center; gap:6px;
      padding:4px 12px; background:rgba(88,101,242,0.1);
      border-bottom:1px solid rgba(88,101,242,0.2);
      font-size:11px; color:var(--brand,#5865f2);
    `;
    const remoteHost = server.peerUrl
      ? (() => { try { return new URL(server.peerUrl).hostname; } catch { return server.peerUrl; } })()
      : 'federe aÄŸ';
    banner.innerHTML = `ğŸŒ <span style="opacity:.7">Bu sunucu</span> <strong>${remoteHost}</strong> <span style="opacity:.7">Ã¼zerinde federe</span>`;

    nameEl.parentElement?.insertAdjacentElement('afterend', banner);
  };
})();

// â”€â”€ 4. Sidebar federation widget â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Sol alt kÃ¶ÅŸede kaÃ§ peer'a baÄŸlÄ± olduÄŸunu gÃ¶steren canlÄ± widget.
// KullanÄ±cÄ± tÄ±klayÄ±nca openFederationUI() aÃ§Ä±lÄ±r.

async function initFederationWidget() {
  // Zaten varsa Ã§Ä±kma
  if (document.getElementById('fed-sidebar-widget')) return;

  const stats = await _getFedStats();
  if (!stats) return;

  const container = document.querySelector('.u-actions, #user-area, .user-panel');
  if (!container) return;

  const widget = document.createElement('div');
  widget.id = 'fed-sidebar-widget';
  widget.style.cssText = `
    display:flex; align-items:center; gap:8px;
    padding:8px 12px; margin:4px 8px;
    background:rgba(88,101,242,0.08);
    border:1px solid rgba(88,101,242,0.15);
    border-radius:8px; cursor:pointer;
    font-size:12px; color:var(--text-2,#b5bac1);
    transition:background .15s, border-color .15s;
  `;
  widget.innerHTML = `
    <span style="font-size:16px">ğŸŒ</span>
    <div style="flex:1;min-width:0">
      <div style="font-weight:600;color:var(--text-1,#f2f3f5);font-size:11px;white-space:nowrap">Federasyon</div>
      <div id="fed-widget-count" style="font-size:10px;color:var(--text-muted,#72767d)">
        ${stats.peerCount} peer baÄŸlÄ±
      </div>
    </div>
    <span style="font-size:10px;opacity:.4">â€º</span>
  `;
  widget.title = 'Federasyon aÄŸÄ±nÄ± gÃ¶rÃ¼ntÃ¼le';
  widget.onmouseenter = () => {
    widget.style.background = 'rgba(88,101,242,0.15)';
    widget.style.borderColor = 'rgba(88,101,242,0.3)';
  };
  widget.onmouseleave = () => {
    widget.style.background = 'rgba(88,101,242,0.08)';
    widget.style.borderColor = 'rgba(88,101,242,0.15)';
  };
  widget.onclick = () => {
    if (typeof openFederationUI === 'function') openFederationUI();
  };

  container.insertBefore(widget, container.firstChild);

  // CanlÄ± gÃ¼ncelleme â€” 60 saniyede bir peer sayÄ±sÄ±nÄ± yenile
  setInterval(async () => {
    const s = await _getFedStats();
    const countEl = document.getElementById('fed-widget-count');
    if (countEl && s) {
      window._federationStats = s; // cache gÃ¼ncelle
      countEl.textContent = `${s.peerCount} peer baÄŸlÄ±`;
    }
  }, 60_000);
}

// App yÃ¼klenince widget'Ä± baÅŸlat
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initFederationWidget);
} else {
  // Biraz bekle â€” user panel render edilmiÅŸ olsun
  setTimeout(initFederationWidget, 800);
}

