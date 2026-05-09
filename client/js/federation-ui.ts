// client/js/federation-ui.js
// Federation Discovery UI â€” Admin whitelist/blacklist yÃ¶netimi eklendi
// Sekmeler: Uzak Sunucular | BaÄŸlÄ± Peerlar | Peer Ekle | Whitelist/Blacklist (admin)

'use strict';
export {};

async function openFederationUI() {
  const isAdmin = window.__currentUser?.isAdmin || false;
  const modal = document.createElement('div');
  modal.id = 'federation-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:660px;width:95%;max-height:85vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <h2 style="margin:0;">ğŸŒ Federasyon AÄŸÄ±</h2>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted);">FarklÄ± Bridge sunucularÄ±nÄ± keÅŸfet ve baÄŸlan</p>
        </div>
        <button class="icon-btn" onclick="document.getElementById('federation-modal').remove()">âœ•</button>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-3);border-radius:8px;padding:4px;flex-wrap:wrap;">
        <button id="fed-tab-discover" class="btn btn-primary" style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('discover')">ğŸŒ KeÅŸfet</button>
        <button id="fed-tab-peers"    class="btn"             style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('peers')">ğŸ”— Peerlar</button>
        <button id="fed-tab-add"      class="btn"             style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('add')">â• Ekle</button>
        ${isAdmin ? `<button id="fed-tab-acl" class="btn" style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('acl')">ğŸ›¡ï¸ ACL</button>` : ''}
      </div>
      <div id="fed-content" style="flex:1;overflow-y:auto;"></div>
    </div>`;
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  switchFedTab('discover');
}

let _fedTab = 'discover';

function switchFedTab(tab) {
  _fedTab = tab;
  ['discover','peers','add','acl'].forEach(t => {
    const btn = document.getElementById(`fed-tab-${t}`);
    if (!btn) return;
    btn.className = t === tab ? 'btn btn-primary' : 'btn';
    btn.style.flex = '1'; btn.style.justifyContent = 'center'; btn.style.fontSize = '12px';
  });
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  if (tab === 'discover')  loadFedDiscover();
  else if (tab === 'peers') loadFedPeers();
  else if (tab === 'add')   renderFedAdd();
  else if (tab === 'acl')   loadFedACL();
}

// â”€â”€ Uzak sunucularÄ± keÅŸfet â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadFedDiscover() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <input id="fed-peer-url-search" type="text" class="input" placeholder="bridge.example.com" style="flex:1;">
      <button class="btn btn-primary" onclick="fetchRemoteServers()">KeÅŸfet</button>
    </div>
    <div id="fed-remote-results">
      <div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">ğŸŒ</div>
        <p>Bir Bridge sunucu URL'si girerek uzak sunucularÄ± keÅŸfedin.</p>
      </div>
    </div>`;
}

async function fetchRemoteServers() {
  const urlInput = document.getElementById('fed-peer-url-search');
  const res      = document.getElementById('fed-remote-results');
  if (!urlInput || !res) return;
  let url = urlInput.value.trim();
  if (!url) return;
  if (!url.startsWith('http')) url = `https://${url}`;
  if (!url.includes('/api/federation')) url = url.replace(/\/$/, '') + '/api/federation/servers';
  res.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>KeÅŸfediliyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/federation/fetch-remote?url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error('Uzak sunucuya ulaÅŸÄ±lamadÄ±');
    const data    = await r.json();
    const servers = data.servers || [];
    if (!servers.length) {
      res.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">Bu sunucuda keÅŸfedilebilir sunucu yok.</div>';
      return;
    }
    res.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
        ğŸŒ <strong>${escHtml(data.instance || url)}</strong> â€” ${servers.length} sunucu
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${servers.map(s => `
          <div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start;">
            <div style="width:40px;height:40px;border-radius:50%;background:var(--brand);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
              ${s.icon || s.name?.[0] || 'ğŸŒ'}
            </div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:700;font-size:14px;">${escHtml(s.name)}</div>
              ${s.description ? `<div style="font-size:12px;color:var(--text-muted);margin-top:2px;">${escHtml(s.description.slice(0,120))}</div>` : ''}
              <div style="display:flex;gap:10px;margin-top:4px;font-size:11px;color:var(--text-muted);">
                <span>ğŸ‘¥ ${s.memberCount}</span>
                <span>ğŸ’¬ ${s.channelCount} kanal</span>
                ${(s.tags||[]).slice(0,3).map(t => `<span style="background:var(--bg-2);padding:1px 6px;border-radius:10px;">${escHtml(t)}</span>`).join('')}
              </div>
            </div>
            <a href="${escHtml(s.inviteUrl||'#')}" target="_blank" class="btn btn-primary" style="font-size:12px;flex-shrink:0;">KatÄ±l â†’</a>
          </div>`).join('')}
      </div>`;
  } catch (err) {
    res.innerHTML = `<div style="color:var(--red);padding:16px;">Hata: ${escHtml(err.message)}</div>`;
  }
}

// â”€â”€ KayÄ±tlÄ± peerlar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadFedPeers() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>YÃ¼kleniyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/federation/peers`);
    const peers = await r.json();
    if (!peers.length) {
      cont.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">ğŸ”—</div>
        <p>HenÃ¼z baÄŸlÄ± peer yok.</p></div>`;
      return;
    }
    cont.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${peers.length} kayÄ±tlÄ± peer</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${peers.map(p => {
          const lastSeen = p.lastSeen ? new Date(p.lastSeen).toLocaleString('tr-TR') : 'Bilinmiyor';
          const online   = p.lastSeen && (Date.now() - p.lastSeen) < 10 * 60 * 1000;
          return `<div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;display:flex;gap:10px;align-items:center;">
            <div style="width:10px;height:10px;border-radius:50%;background:${online ? 'var(--green,#3ba55d)' : 'var(--text-muted)'};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:13px;">${escHtml(p.name||p.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(p.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">Son gÃ¶rÃ¼lme: ${lastSeen}</div>
            </div>
            ${p.verified ? '<span style="font-size:18px;" title="DoÄŸrulanmÄ±ÅŸ">âœ…</span>' : ''}
          </div>`;
        }).join('')}
      </div>`;
  } catch (err) {
    cont.innerHTML = `<div style="color:var(--red);padding:16px">Hata: ${escHtml(err.message)}</div>`;
  }
}

// â”€â”€ Peer ekle â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function renderFedAdd() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = `
    <div style="max-width:420px;">
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">BaÅŸka bir Bridge sunucusunu federasyon aÄŸÄ±na ekle.</p>
      <div class="form-group" style="margin-bottom:12px;">
        <label>Sunucu URL</label>
        <input id="fed-add-url" type="text" class="input" placeholder="https://bridge.example.com" style="width:100%;margin-top:4px;">
      </div>
      <button class="btn btn-primary" onclick="submitFedPeer()" style="width:100%;justify-content:center;">ğŸ”— Peer Ekle</button>
    </div>`;
}

async function submitFedPeer() {
  const url = document.getElementById('fed-add-url')?.value?.trim();
  if (!url) return toast('URL gerekli', 'error');
  try {
    const r = await apiFetch(`${API}/api/federation/peers`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const d = await r.json();
    if (!r.ok) return toast(d.error || 'Hata', 'error');
    toast('âœ… Peer eklendi!', 'success');
    switchFedTab('peers');
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  }
}

// â”€â”€ ACL: Whitelist / Blacklist YÃ¶netimi (Admin) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadFedACL() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>ACL yÃ¼kleniyor...</div>';

  try {
    const [wlRes, blRes] = await Promise.all([
      apiFetch(`${API}/api/admin/federation/whitelist`),
      apiFetch(`${API}/api/admin/federation/blacklist`),
    ]);
    const { whitelist = [] } = await wlRes.json().catch(() => ({ whitelist: [] }));
    const { blacklist = [] } = await blRes.json().catch(() => ({ blacklist: [] }));

    cont.innerHTML = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;">

        <!-- WHITELIST -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="margin:0;font-size:14px;">âœ… Whitelist <span style="font-weight:400;color:var(--text-muted);">(${whitelist.length})</span></h3>
            <button class="btn btn-primary" style="font-size:11px;padding:4px 8px;" onclick="fedACLAdd('whitelist')">+ Ekle</button>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px;">YalnÄ±zca bu listeden gelen ActivityPub etkinlikleri kabul edilir. BoÅŸsa herkese aÃ§Ä±k.</p>
          <div id="fed-whitelist-list" style="display:flex;flex-direction:column;gap:6px;">
            ${whitelist.length
              ? whitelist.map(entry => renderACLEntry(entry, 'whitelist')).join('')
              : '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">BoÅŸ â€” tÃ¼m sunucular kabul ediliyor</div>'}
          </div>
        </div>

        <!-- BLACKLIST -->
        <div>
          <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">
            <h3 style="margin:0;font-size:14px;">ğŸš« Blacklist <span style="font-weight:400;color:var(--text-muted);">(${blacklist.length})</span></h3>
            <button class="btn" style="font-size:11px;padding:4px 8px;background:var(--red,#ed4245);color:#fff;border:none;" onclick="fedACLAdd('blacklist')">+ Ekle</button>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px;">Bu listeden gelen ActivityPub etkinlikleri otomatik reddedilir.</p>
          <div id="fed-blacklist-list" style="display:flex;flex-direction:column;gap:6px;">
            ${blacklist.length
              ? blacklist.map(entry => renderACLEntry(entry, 'blacklist')).join('')
              : '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">BoÅŸ â€” engelli sunucu yok</div>'}
          </div>
        </div>

      </div>

      <!-- Ekle Modal (inline) -->
      <div id="fed-acl-add-form" style="display:none;margin-top:16px;background:var(--bg-3);border-radius:8px;padding:14px;">
        <h4 style="margin:0 0 10px;" id="fed-acl-add-title">Sunucu Ekle</h4>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input id="fed-acl-domain" type="text" class="input" placeholder="example.com veya *.example.com" style="flex:1;">
          <button class="btn btn-primary" onclick="fedACLSubmit()">Kaydet</button>
          <button class="btn" onclick="document.getElementById('fed-acl-add-form').style.display='none'">Ä°ptal</button>
        </div>
        <input id="fed-acl-reason" type="text" class="input" placeholder="GerekÃ§e (opsiyonel)" style="width:100%;">
        <input type="hidden" id="fed-acl-type">
      </div>`;
  } catch (err) {
    cont.innerHTML = `<div style="color:var(--red);padding:16px">Hata: ${escHtml(err.message)}</div>`;
  }
}

function renderACLEntry(entry, type) {
  const isWl = type === 'whitelist';
  const addedAt = entry.addedAt ? new Date(entry.addedAt).toLocaleDateString('tr-TR') : '';
  return `
    <div style="background:var(--bg-2);border-radius:6px;padding:8px 10px;display:flex;align-items:center;gap:8px;">
      <span style="font-size:16px;">${isWl ? 'âœ…' : 'ğŸš«'}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(entry.domain)}</div>
        ${entry.reason ? `<div style="font-size:10px;color:var(--text-muted);">${escHtml(entry.reason)}</div>` : ''}
        ${addedAt ? `<div style="font-size:10px;color:var(--text-muted);">Eklendi: ${addedAt}</div>` : ''}
      </div>
      <button class="icon-btn" title="KaldÄ±r" onclick="fedACLRemove('${type}','${escHtml(entry.domain)}')" style="font-size:12px;color:var(--red,#ed4245);">âœ•</button>
    </div>`;
}

let _fedACLType = 'whitelist';
function fedACLAdd(type) {
  _fedACLType = type;
  const form = document.getElementById('fed-acl-add-form');
  const title = document.getElementById('fed-acl-add-title');
  const typeInput = document.getElementById('fed-acl-type');
  const domainInput = document.getElementById('fed-acl-domain');
  const reasonInput = document.getElementById('fed-acl-reason');
  if (!form) return;
  title.textContent  = type === 'whitelist' ? 'âœ… Whitelist\'e Ekle' : 'ğŸš« Blacklist\'e Ekle';
  typeInput.value    = type;
  domainInput.value  = '';
  reasonInput.value  = '';
  form.style.display = 'block';
  domainInput.focus();
}

async function fedACLSubmit() {
  const domain = document.getElementById('fed-acl-domain')?.value?.trim();
  const reason = document.getElementById('fed-acl-reason')?.value?.trim();
  const type   = document.getElementById('fed-acl-type')?.value;
  if (!domain) return toast('Domain gerekli', 'error');
  // Basit domain validasyonu
  if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(domain)) {
    return toast('GeÃ§ersiz domain formatÄ± (Ã¶rn: example.com)', 'error');
  }
  try {
    const r = await apiFetch(`${API}/api/admin/federation/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, reason }),
    });
    const d = await r.json();
    if (!r.ok) return toast(d.error || 'Hata', 'error');
    toast(`âœ… ${domain} ${type === 'whitelist' ? 'whitelist' : 'blacklist'}'e eklendi`, 'success');
    loadFedACL(); // yenile
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  }
}

async function fedACLRemove(type, domain) {
  if (!confirm(`${domain} adresini ${type === 'whitelist' ? 'whitelist' : 'blacklist'}'ten kaldÄ±r?`)) return;
  try {
    const r = await apiFetch(`${API}/api/admin/federation/${type}/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    });
    if (!r.ok) { const d = await r.json(); return toast(d.error || 'Hata', 'error'); }
    toast(`KaldÄ±rÄ±ldÄ±: ${domain}`, 'success');
    loadFedACL();
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// FEDERATION GÃ–RÃœNÃœRLÃœK â€” Sunucu listesi, profil popup, sidebar widget
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

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

