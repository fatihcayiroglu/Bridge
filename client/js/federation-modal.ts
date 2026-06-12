import { BridgeRegistry } from './core/bridge-registry.ts';
// client/js/federation-ui.ts
// Federation Discovery UI — Admin whitelist/blacklist yönetimi eklendi
// Sekmeler: Uzak Sunucular | Bağlı Peerlar | Peer Ekle | Whitelist/Blacklist (admin)

'use strict';
export {};

async function openFederationUI() {
  const isAdmin = (BridgeRegistry.get('getCurrentUser') as (() => { isAdmin?: boolean } | null) | null)?.()?.isAdmin || false;
  const modal = document.createElement('div');
  modal.id = 'federation-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:660px;width:95%;max-height:85vh;display:flex;flex-direction:column;">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
        <div>
          <h2 style="margin:0;">🌐 Federasyon Ağı</h2>
          <p style="margin:4px 0 0;font-size:12px;color:var(--text-muted);">Farklı Bridge sunucularını keşfet ve bağlan</p>
        </div>
        <button class="icon-btn" onclick="document.getElementById('federation-modal').remove()">✕</button>
      </div>
      <div style="display:flex;gap:4px;margin-bottom:16px;background:var(--bg-3);border-radius:8px;padding:4px;flex-wrap:wrap;">
        <button id="fed-tab-discover" class="btn btn-primary" style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('discover')">ğŸŒ Keşfet</button>
        <button id="fed-tab-peers"    class="btn"             style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('peers')">ğŸ”— Peerlar</button>
        <button id="fed-tab-add"      class="btn"             style="flex:1;justify-content:center;font-size:12px;" onclick="switchFedTab('add')">➢ Ekle</button>
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

// ── Uzak sunucuları keşfet ─────────────────────────────────────
async function loadFedDiscover() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = `
    <div style="display:flex;gap:8px;margin-bottom:12px;">
      <input id="fed-peer-url-search" type="text" class="input" placeholder="bridge.example.com" style="flex:1;">
      <button class="btn btn-primary" onclick="fetchRemoteServers()">Keşfet</button>
    </div>
    <div id="fed-remote-results">
      <div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">🌐</div>
        <p>Bir Bridge sunucu URL'si girerek uzak sunucuları keşfedin.</p>
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
  res.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>Keşfediliyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/federation/fetch-remote?url=${encodeURIComponent(url)}`);
    if (!r.ok) throw new Error('Uzak sunucuya ulaşılamadı');
    const data    = await r.json();
    const servers = data.servers || [];
    if (!servers.length) {
      res.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted);">Bu sunucuda keşfedilebilir sunucu yok.</div>';
      return;
    }
    res.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">
        🌐 <strong>${escHtml(data.instance || url)}</strong> — ${servers.length} sunucu
      </div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${servers.map(s => `
          <div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;display:flex;gap:12px;align-items:flex-start;">
            <div style="width:40px;height:40px;border-radius:50%;background:var(--brand);display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;">
              ${s.icon || s.name?.[0] || '🌐'}
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
            <a href="${escHtml(s.inviteUrl||'#')}" target="_blank" class="btn btn-primary" style="font-size:12px;flex-shrink:0;">Katıl →</a>
          </div>`).join('')}
      </div>`;
  } catch (err) {
    res.innerHTML = `<div style="color:var(--red);padding:16px;">Hata: ${escHtml(err.message)}</div>`;
  }
}

// ── Kayıtlı peerlar ────────────────────────────────────────────
async function loadFedPeers() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>Yükleniyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/federation/peers`);
    const peers = await r.json();
    if (!peers.length) {
      cont.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted);">
        <div style="font-size:32px;margin-bottom:8px;">ğŸ”—</div>
        <p>Henüz bağlı peer yok.</p></div>`;
      return;
    }
    cont.innerHTML = `
      <div style="font-size:12px;color:var(--text-muted);margin-bottom:10px;">${peers.length} kayıtlı peer</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        ${peers.map(p => {
          const lastSeen = p.lastSeen ? new Date(p.lastSeen).toLocaleString('tr-TR') : 'Bilinmiyor';
          const online   = p.lastSeen && (Date.now() - p.lastSeen) < 10 * 60 * 1000;
          return `<div style="background:var(--bg-3);border-radius:8px;padding:12px 14px;display:flex;gap:10px;align-items:center;">
            <div style="width:10px;height:10px;border-radius:50%;background:${online ? 'var(--green,#3ba55d)' : 'var(--text-muted)'};flex-shrink:0;"></div>
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;font-size:13px;">${escHtml(p.name||p.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">${escHtml(p.url)}</div>
              <div style="font-size:11px;color:var(--text-muted);">Son görülme: ${lastSeen}</div>
            </div>
            ${p.verified ? '<span style="font-size:18px;" title="Doğrulanmış">✅</span>' : ''}
          </div>`;
        }).join('')}
      </div>`;
  } catch (err) {
    cont.innerHTML = `<div style="color:var(--red);padding:16px">Hata: ${escHtml(err.message)}</div>`;
  }
}

// ── Peer ekle ─────────────────────────────────────────────────
function renderFedAdd() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = `
    <div style="max-width:420px;">
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">Başka bir Bridge sunucusunu federasyon ağına ekle.</p>
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
    toast('✅ Peer eklendi!', 'success');
    switchFedTab('peers');
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  }
}

// ── ACL: Whitelist / Blacklist Yönetimi (Admin) ────────────────
async function loadFedACL() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;padding:24px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>ACL yükleniyor...</div>';

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
            <h3 style="margin:0;font-size:14px;">✅ Whitelist <span style="font-weight:400;color:var(--text-muted);">(${whitelist.length})</span></h3>
            <button class="btn btn-primary" style="font-size:11px;padding:4px 8px;" onclick="fedACLAdd('whitelist')">+ Ekle</button>
          </div>
          <p style="font-size:11px;color:var(--text-muted);margin:0 0 8px;">Yalnızca bu listeden gelen ActivityPub etkinlikleri kabul edilir. Boşsa herkese açık.</p>
          <div id="fed-whitelist-list" style="display:flex;flex-direction:column;gap:6px;">
            ${whitelist.length
              ? whitelist.map(entry => renderACLEntry(entry, 'whitelist')).join('')
              : '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Boş — tüm sunucular kabul ediliyor</div>'}
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
              : '<div style="color:var(--text-muted);font-size:12px;padding:8px 0;">Boş — engelli sunucu yok</div>'}
          </div>
        </div>

      </div>

      <!-- Ekle Modal (inline) -->
      <div id="fed-acl-add-form" style="display:none;margin-top:16px;background:var(--bg-3);border-radius:8px;padding:14px;">
        <h4 style="margin:0 0 10px;" id="fed-acl-add-title">Sunucu Ekle</h4>
        <div style="display:flex;gap:8px;margin-bottom:8px;">
          <input id="fed-acl-domain" type="text" class="input" placeholder="example.com veya *.example.com" style="flex:1;">
          <button class="btn btn-primary" onclick="fedACLSubmit()">Kaydet</button>
          <button class="btn" onclick="document.getElementById('fed-acl-add-form').style.display='none'">İptal</button>
        </div>
        <input id="fed-acl-reason" type="text" class="input" placeholder="Gerekçe (opsiyonel)" style="width:100%;">
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
      <span style="font-size:16px;">${isWl ? '✅' : 'ğŸš«'}</span>
      <div style="flex:1;min-width:0;">
        <div style="font-size:12px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(entry.domain)}</div>
        ${entry.reason ? `<div style="font-size:10px;color:var(--text-muted);">${escHtml(entry.reason)}</div>` : ''}
        ${addedAt ? `<div style="font-size:10px;color:var(--text-muted);">Eklendi: ${addedAt}</div>` : ''}
      </div>
      <button class="icon-btn" title="Kaldır" onclick="fedACLRemove('${type}','${escHtml(entry.domain)}')" style="font-size:12px;color:var(--red,#ed4245);">✕</button>
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
  title.textContent  = type === 'whitelist' ? '✅ Whitelist\'e Ekle' : 'ğŸš« Blacklist\'e Ekle';
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
    return toast('Geçersiz domain formatı (örn: example.com)', 'error');
  }
  try {
    const r = await apiFetch(`${API}/api/admin/federation/${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ domain, reason }),
    });
    const d = await r.json();
    if (!r.ok) return toast(d.error || 'Hata', 'error');
    toast(`✅ ${domain} ${type === 'whitelist' ? 'whitelist' : 'blacklist'}'e eklendi`, 'success');
    loadFedACL(); // yenile
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  }
}

async function fedACLRemove(type, domain) {
  if (!confirm(`${domain} adresini ${type === 'whitelist' ? 'whitelist' : 'blacklist'}'ten kaldır?`)) return;
  try {
    const r = await apiFetch(`${API}/api/admin/federation/${type}/${encodeURIComponent(domain)}`, {
      method: 'DELETE',
    });
    if (!r.ok) { const d = await r.json(); return toast(d.error || 'Hata', 'error'); }
    toast(`Kaldırıldı: ${domain}`, 'success');
    loadFedACL();
  } catch (err) {
    toast('Hata: ' + err.message, 'error');
  }
}

// ══════════════════════════════════════════════════════════════════
// FEDERATION GÖRÜNÜRLÜK — Sunucu listesi, profil popup, sidebar widget
// ══════════════════════════════════════════════════════════════════


// ── ActivityPub Sosyal Eylemler ────────────────────────────────
// Uzak aktörü takip et / beğen / boost

async function openFedProfileModal(actorUrl) {
  const cont = document.createElement('div');
  cont.id = 'fed-profile-modal';
  cont.className = 'modal-overlay';
  cont.innerHTML = `
    <div class="modal-card" style="max-width:480px;width:95%;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
        <h3 style="margin:0;">🌐 Uzak Profil</h3>
        <button class="icon-btn" onclick="document.getElementById('fed-profile-modal').remove()">✕</button>
      </div>
      <div id="fed-profile-content">
        <div style="text-align:center;padding:24px;color:var(--text-muted)">
          <div class="spinner" style="margin:0 auto 12px"></div>Yükleniyor…
        </div>
      </div>
    </div>`;
  cont.onclick = e => { if (e.target === cont) cont.remove(); };
  document.body.appendChild(cont);

  try {
    const r = await apiFetch(`${API}/api/federation/profile?actorUrl=${encodeURIComponent(actorUrl)}`);
    const actor = await r.json();
    if (!r.ok) throw new Error(actor.error || 'Profil alınamadı');

    const body = document.getElementById('fed-profile-content');
    if (!body) return;

    const avatarUrl = actor.icon?.url || actor.icon;
    body.innerHTML = `
      <div style="display:flex;gap:14px;margin-bottom:16px;align-items:flex-start;">
        ${avatarUrl ? `<img src="${avatarUrl}" style="width:56px;height:56px;border-radius:50%;object-fit:cover;" onerror="this.style.display='none'">` : ''}
        <div style="flex:1;">
          <div style="font-weight:700;font-size:16px">${escHtml(actor.name || actor.preferredUsername || '?')}</div>
          <div style="font-size:12px;color:var(--text-muted)">@${escHtml(actor.preferredUsername || '')}@${escHtml(new URL(actor.id || 'http://?').hostname)}</div>
          ${actor.summary ? `<div style="font-size:13px;color:var(--text-2);margin-top:6px;">${actor.summary.replace(/<[^>]*>/g,'').slice(0,200)}</div>` : ''}
        </div>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="fed-follow-btn" onclick="toggleFedFollow('${escHtml(actor.id)}', this)"
          class="btn ${actor.isFollowing ? '' : 'btn-primary'}"
          style="flex:1;"
        >${actor.isFollowing ? '✓ Takip Ediliyor' : '+ Takip Et'}</button>
        ${actor.url ? `<a href="${escHtml(actor.url)}" target="_blank" class="btn" style="flex:1;text-align:center;">Profili Görüntüle â†—</a>` : ''}
      </div>
      ${actor.isFollower ? '<p style="font-size:12px;color:var(--text-muted);margin-top:8px;text-align:center;">Bu kişi sizi takip ediyor</p>' : ''}`;
  } catch (err) {
    const body = document.getElementById('fed-profile-content');
    if (body) body.innerHTML = `<p style="color:var(--danger,#ed4245)">${escHtml(err.message)}</p>`;
  }
}

async function toggleFedFollow(actorUrl, btn) {
  const isFollowing = btn.textContent.includes('Takip Ediliyor');
  btn.disabled = true;
  try {
    const method = isFollowing ? 'DELETE' : 'POST';
    const r = await apiFetch(`${API}/api/federation/follow`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ actorUrl }),
    });
    const d = await r.json();
    if (!r.ok) { toast(d.error || 'Hata', 'error'); return; }
    if (isFollowing) {
      btn.textContent = '+ Takip Et';
      btn.classList.add('btn-primary');
      toast('Takipten çıkıldı', 'info');
    } else {
      btn.textContent = '✓ Takip Ediliyor';
      btn.classList.remove('btn-primary');
      toast('Takip isteği gönderildi', 'success');
    }
  } finally {
    btn.disabled = false;
  }
}

async function fedLikeNote(objectUrl) {
  try {
    const r = await apiFetch(`${API}/api/federation/like`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectUrl }),
    });
    if (!r.ok) { const d = await r.json(); toast(d.error || 'Beğeni gönderilemedi', 'error'); return; }
    toast('â¤ï¸ Beğenildi', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

async function fedAnnounceNote(objectUrl) {
  try {
    const r = await apiFetch(`${API}/api/federation/announce`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ objectUrl }),
    });
    if (!r.ok) { const d = await r.json(); toast(d.error || 'Boost gönderilemedi', 'error'); return; }
    toast('ğŸ” Boost edildi', 'success');
  } catch (err) { toast(err.message, 'error'); }
}

// Federated timeline sekmesi — federation modal içinde kullanılır
async function loadFedTimeline() {
  const cont = document.getElementById('fed-content');
  if (!cont) return;
  cont.innerHTML = '<div style="text-align:center;padding:32px;color:var(--text-muted)"><div class="spinner" style="margin:0 auto 12px"></div>Yükleniyor…</div>';
  try {
    const r = await apiFetch(`${API}/api/federation/timeline?limit=20`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Hata');
    const items = data.items || [];
    if (!items.length) {
      cont.innerHTML = `<div style="text-align:center;padding:32px;color:var(--text-muted)">
        <div style="font-size:32px;margin-bottom:8px;">ğŸ“¡</div>
        <p>Federated timeline boş. Birini takip et!</p>
        <button class="btn btn-primary" onclick="switchFedTab('discover')">Sunucuları Keşfet</button>
      </div>`;
      return;
    }
    cont.innerHTML = items.map(msg => {
      const actorHandle = '@' + (msg.actorUrl || '?').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
      const date = msg.published ? new Date(msg.published).toLocaleString('tr-TR') : '';
      const content = (msg.content || '').replace(/<[^>]*>/g, '').slice(0, 500);
      return `<div style="border-bottom:1px solid var(--bg-4);padding:12px 0;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;">
          <span style="font-size:12px;color:var(--brand);cursor:pointer;font-weight:600;"
            onclick="openFedProfileModal('${escHtml(msg.actorUrl)}')">${escHtml(actorHandle)}</span>
          <span style="font-size:11px;color:var(--text-muted)">${escHtml(date)}</span>
        </div>
        <p style="font-size:13px;margin:0 0 8px;color:var(--text-1);">${escHtml(content)}</p>
        ${msg.sensitive ? '<span style="font-size:10px;background:var(--bg-4);padding:2px 6px;border-radius:4px;">CW</span>' : ''}
        <div style="display:flex;gap:8px;margin-top:6px;">
          ${msg.apId ? `
            <button onclick="fedLikeNote('${escHtml(msg.apId)}')" class="btn" style="font-size:11px;padding:3px 8px;">â¤ï¸</button>
            <button onclick="fedAnnounceNote('${escHtml(msg.apId)}')" class="btn" style="font-size:11px;padding:3px 8px;">ğŸ”</button>
          ` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    cont.innerHTML = `<p style="color:var(--danger,#ed4245);padding:16px;">${escHtml(err.message)}</p>`;
  }
}

// openFederationUI'ye Timeline sekmesi de ekle
const _origOpenFedUI = BridgeRegistry.get('openFederationUI') ?? (() => {});
BridgeRegistry.register('openFederationUI', function() {
  _origOpenFedUI?.();
  // Timeline sekmesini tab bar'a ekle
  setTimeout(() => {
    const tabBar = document.querySelector('#federation-modal .btn[onclick*="switchFedTab"]')?.parentElement;
    if (tabBar && !document.getElementById('fed-tab-timeline')) {
      const tlBtn = document.createElement('button');
      tlBtn.id = 'fed-tab-timeline';
      tlBtn.className = 'btn';
      tlBtn.style.cssText = 'flex:1;justify-content:center;font-size:12px;';
      tlBtn.textContent = 'ğŸ“¡ Timeline';
      tlBtn.onclick = () => switchFedTab('timeline');
      tabBar.appendChild(tlBtn);
    }
    const _origSwitch = BridgeRegistry.get('switchFedTab') ?? (() => {});
    if (_origSwitch && !_origSwitch._patched) {
      BridgeRegistry.register('switchFedTab', function(tab) {
        if (tab === 'timeline') {
          const btn = document.getElementById('fed-tab-timeline');
          if (btn) { btn.className = 'btn btn-primary'; btn.style.flex='1'; btn.style.justifyContent='center'; btn.style.fontSize='12px'; }
          ['discover','peers','add','acl'].forEach(t => {
            const b = document.getElementById(`fed-tab-${t}`);
            if (b) { b.className = 'btn'; b.style.flex='1'; }
          });
          loadFedTimeline();
        } else {
          const tlBtn = document.getElementById('fed-tab-timeline');
          if (tlBtn) { tlBtn.className = 'btn'; }
          _origSwitch(tab);
        }
      });
      // _patched flag artık gerekmez — BridgeRegistry.register idempotent
    }
  }, 100);
});

