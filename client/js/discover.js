// client/js/discover.js Server Discovery + Federation
// Yerel sunucular + uzak Bridge instance'larından sunucular
// ARIA erişilebilirlik, klavye navigasyonu, kategori filtresi iyileştirmesi

let _discoverResults = [];
let _discoverTab = 'local'; // 'local' | 'remote'
let _discoverSearch = null;

// ── OPEN DISCOVERY PAGE ───────────────────────────────────────
async function openDiscovery() {
  const existing = document.getElementById('discovery-overlay');
  if (existing) { existing.remove(); return; }

  const overlay = document.createElement('div');
  overlay.id = 'discovery-overlay';
  overlay.className = 'discovery-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-label', window.i18n?.t('tip_discover', 'Sunucu Keşfet') ?? 'Sunucu Keşfet');
  overlay.innerHTML = `
    <div class="discovery-page" role="main">
      <div class="discovery-header">
        <div>
          <h1 id="discovery-title" style="margin:0;font-size:28px;">🌐 Sunucu Keşfet</h1>
          <p style="color:var(--text-muted);margin:4px 0 0;">Bridge topluluğunu keşfet</p>
        </div>
        <button class="icon-btn" onclick="document.getElementById('discovery-overlay').remove()"
          aria-label="Kapat" title="Kapat" style="font-size:20px;">✕</button>
      </div>

      <!-- Sekme Başlıkları -->
      <div role="tablist" aria-label="Keşif sekmeleri"
           style="display:flex;gap:8px;margin-bottom:16px;border-bottom:1px solid var(--bg-3);padding-bottom:0;">
        <button id="tab-local" role="tab" aria-selected="true" aria-controls="discover-grid"
          onclick="switchDiscoverTab('local')"
          style="padding:8px 18px;border:none;background:none;color:var(--brand);border-bottom:2px solid var(--brand);font-weight:600;cursor:pointer;font-size:14px;">
          🏠 Bu Sunucu
        </button>
        <button id="tab-remote" role="tab" aria-selected="false" aria-controls="discover-grid"
          onclick="switchDiscoverTab('remote')"
          style="padding:8px 18px;border:none;background:none;color:var(--text-muted);border-bottom:2px solid transparent;cursor:pointer;font-size:14px;">
          🌍 Diğer Bridge Sunucuları
        </button>
      </div>

      <div class="discovery-search-row">
        <div style="position:relative;flex:1;">
          <span style="position:absolute;left:12px;top:50%;transform:translateY(-50%);opacity:.5;" aria-hidden="true">🔍</span>
          <input id="discover-q" class="input" placeholder="Sunucu ara..."
                 aria-label="Sunucu ara"
                 role="searchbox"
                 style="width:100%;padding-left:36px;"
                 oninput="debouncedDiscover()" />
        </div>
        <select id="discover-sort" class="input" style="width:160px;"
                aria-label="Sıralama"
                onchange="runDiscover()">
          <option value="members">👥 Üye Sayısı</option>
          <option value="newest">🆕 En Yeni</option>
          <option value="name">🔤 İsme Göre</option>
        </select>
      </div>

      <div id="discover-tags" class="discover-tags" role="group" aria-label="Etiket filtresi"></div>

      <div id="discover-grid" class="discover-grid"
           role="tabpanel"
           aria-labelledby="tab-local"
           aria-live="polite"
           aria-busy="true">
        <div class="discover-loading" role="status">Yükleniyor...</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.onclick = (e) => { if (e.target === overlay) overlay.remove(); };

  // Klavye: ESC ile kapat, focus trap
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      overlay.remove();
    }
    // Tab trap
    if (e.key === 'Tab') {
      const focusable = overlay.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'
      );
      const first = focusable[0];
      const last  = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault(); last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault(); first.focus();
      }
    }
  });

  // İlk focus: arama kutusu
  setTimeout(() => overlay.querySelector('#discover-q')?.focus(), 50);

  _discoverTab = 'local';
  await runDiscover();
}

function switchDiscoverTab(tab) {
  _discoverTab = tab;
  const localBtn  = document.getElementById('tab-local');
  const remoteBtn = document.getElementById('tab-remote');
  if (localBtn && remoteBtn) {
    localBtn.style.color        = tab === 'local'  ? 'var(--brand)' : 'var(--text-muted)';
    localBtn.style.borderBottom = tab === 'local'  ? '2px solid var(--brand)' : '2px solid transparent';
    remoteBtn.style.color        = tab === 'remote' ? 'var(--brand)' : 'var(--text-muted)';
    remoteBtn.style.borderBottom = tab === 'remote' ? '2px solid var(--brand)' : '2px solid transparent';
    // ARIA: güncel sekmeyi işaretle
    localBtn.setAttribute('aria-selected',  tab === 'local'  ? 'true' : 'false');
    remoteBtn.setAttribute('aria-selected', tab === 'remote' ? 'true' : 'false');
    // tabpanel labelledby güncelle
    const grid = document.getElementById('discover-grid');
    if (grid) grid.setAttribute('aria-labelledby', tab === 'local' ? 'tab-local' : 'tab-remote');
  }
  // Sırala seçeneğini gizle uzaksa
  const sortEl = document.getElementById('discover-sort');
  if (sortEl) sortEl.style.display = tab === 'remote' ? 'none' : '';
  runDiscover();
}

let _discoverTimer = null;
function debouncedDiscover() {
  clearTimeout(_discoverTimer);
  _discoverTimer = setTimeout(runDiscover, 300);
}

async function runDiscover(tag = null) {
  if (_discoverTab === 'remote') { await runFederationDiscover(tag); return; }

  const q    = document.getElementById('discover-q')?.value.trim() || '';
  const sort = document.getElementById('discover-sort')?.value || 'members';
  const grid = document.getElementById('discover-grid');
  if (!grid) return;

  grid.setAttribute('aria-busy', 'true');
  grid.innerHTML = '<div class="discover-loading" role="status">Aranıyor...</div>';

  try {
    const params = new URLSearchParams({ sort });
    if (q)   params.set('q', q);
    if (tag) params.set('tag', tag);

    const r = await apiFetch(`${API}/api/discover?${params}`);
    if (!r.ok) throw new Error('Failed');
    _discoverResults = await r.json();

    const allTags = [...new Set(_discoverResults.flatMap(s => s.tags || []))].sort();
    const tagsEl  = document.getElementById('discover-tags');
    if (tagsEl) {
      tagsEl.innerHTML = allTags.map(t =>
        `<button class="discover-tag-pill ${tag === t ? 'active' : ''}"
                 aria-pressed="${tag === t ? 'true' : 'false'}"
                 onclick="runDiscover('${escHtml(t)}')">#${escHtml(t)}</button>`
      ).join('');
    }

    if (!_discoverResults.length) {
      grid.innerHTML = '<div class="discover-empty" role="status">Sunucu bulunamadı 🔭</div>';
      grid.setAttribute('aria-busy', 'false');
      return;
    }

    grid.innerHTML = _discoverResults.map(s => renderDiscoverCard(s)).join('');
    grid.setAttribute('aria-busy', 'false');
  } catch(e) {
    grid.innerHTML = '<div class="discover-empty" role="alert">Yüklenemedi. Sunucu çalışıyor mu?</div>';
    grid.setAttribute('aria-busy', 'false');
  }
}

// ── FEDERATION TAB ────────────────────────────────────────────
async function runFederationDiscover(tag = null) {
  const q    = document.getElementById('discover-q')?.value.trim() || '';
  const grid = document.getElementById('discover-grid');
  const tagsEl = document.getElementById('discover-tags');
  if (!grid) return;

  grid.innerHTML = '<div class="discover-loading">Diğer Bridge sunucularına bağlanılıyor...</div>';
  if (tagsEl) tagsEl.innerHTML = '';

  try {
    const params = new URLSearchParams();
    if (q)   params.set('q', q);
    if (tag) params.set('tag', tag);

    const r = await apiFetch(`${API}/api/federation/discover?${params}`);
    if (!r.ok) throw new Error('Failed');
    const data = await r.json();
    const servers = data.servers || [];

    if (!servers.length) {
      grid.innerHTML = `
        <div class="discover-empty">
          <div style="font-size:48px;margin-bottom:12px;">🌍</div>
          <div style="font-weight:600;margin-bottom:8px;">Henüz bağlı sunucu yok</div>
          <div style="color:var(--text-muted);font-size:13px;max-width:300px;margin:0 auto;">
            Admin, Ayarlar > Federation bölümünden başka Bridge instance'larını ekleyebilir.
          </div>
        </div>`;
      return;
    }

    // Unique tag'ler
    const allTags = [...new Set(servers.flatMap(s => s.tags || []))].sort();
    if (tagsEl) {
      tagsEl.innerHTML = allTags.map(t =>
        `<button class="discover-tag-pill ${tag === t ? 'active' : ''}"
                 onclick="runFederationDiscover('${escHtml(t)}')">#${escHtml(t)}</button>`
      ).join('');
    }

    grid.innerHTML = `
      <div style="color:var(--text-muted);font-size:12px;margin-bottom:12px;padding:0 4px;">
        ${servers.length} sunucu bulundu (${[...new Set(servers.map(s=>s._instanceName))].length} farklı instance)
      </div>
      ${servers.map(s => renderRemoteCard(s)).join('')}`;
  } catch(e) {
    grid.innerHTML = '<div class="discover-empty">Federation sorgusu başarısız. Peer\'lar erişilebilir mi?</div>';
  }
}

function renderRemoteCard(s) {
  const tags = (s.tags || []).map(t => `<span class="discover-tag-pill" style="cursor:default;">#${escHtml(t)}</span>`).join('');
  return `<div class="discover-card" onclick="joinRemoteServer('${escHtml(s.inviteUrl || '')}', '${escHtml(s.name)}')">
    <div style="background:linear-gradient(135deg,#2d7dd2 0%,#1a4f8a 100%);height:80px;border-radius:8px 8px 0 0;position:relative;">
      <span style="position:absolute;bottom:8px;right:10px;background:rgba(0,0,0,.4);border-radius:4px;font-size:11px;padding:2px 6px;color:#fff;">
        🌍 ${escHtml(s._instanceName || s._instanceUrl || 'Uzak Sunucu')}
      </span>
    </div>
    <div style="padding:12px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="width:48px;height:48px;border-radius:50%;background:var(--bg-3);display:flex;align-items:center;justify-content:center;font-size:24px;margin-top:-24px;border:3px solid var(--bg-2);">
          ${s.icon ? escHtml(s.icon) : '🌐'}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(s.name)}</div>
          <div style="color:var(--text-muted);font-size:12px;">${s.memberCount || 0} üye • ${s.channelCount || 0} kanal</div>
        </div>
      </div>
      ${s.description ? `<p style="font-size:13px;color:var(--text-muted);margin:0 0 8px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escHtml(s.description)}</p>` : ''}
      ${tags ? `<div style="display:flex;flex-wrap:wrap;gap:4px;">${tags}</div>` : ''}
    </div>
    <div class="discover-join-btn" style="background:var(--bg-3);color:var(--text-muted);">Siteye Git →</div>
  </div>`;
}

async function joinRemoteServer(inviteUrl, serverName) {
  if (!inviteUrl) return toast('Bu sunucunun davet linki yok', 'error');
  // Uzak sunucuya yönlendirme — yeni sekmede aç
  if (confirm(`"${serverName}" farklı bir Bridge sunucusunda. Oraya yönlendirileceksiniz. Devam edilsin mi?`)) {
    window.open(inviteUrl, '_blank', 'noopener');
  }
}

function renderDiscoverCard(s) {
  const iconHtml = s.iconUrl
    ? `<img src="${escHtml(API + s.iconUrl)}" alt="" style="width:48px;height:48px;border-radius:50%;object-fit:cover;">`
    : `<div style="width:48px;height:48px;border-radius:50%;background:linear-gradient(135deg,var(--brand),#7289da);display:flex;align-items:center;justify-content:center;font-size:24px;">${escHtml(s.icon || '🌐')}</div>`;

  const bannerStyle = s.bannerUrl
    ? `background:url(${escHtml(API + s.bannerUrl)}) center/cover;height:80px;border-radius:8px 8px 0 0;`
    : `background:linear-gradient(135deg,var(--brand) 0%,#7289da 100%);height:80px;border-radius:8px 8px 0 0;`;

  const tags = (s.tags || []).slice(0, 4).map(t => `<span class="discover-tag-pill" style="cursor:default;">#${escHtml(t)}</span>`).join('');

//   Activity indicator (üye sayısına göre tahmini)
  const activityLevel = s.memberCount > 500 ? 'Çok Aktif' : s.memberCount > 100 ? 'Aktif' : s.memberCount > 10 ? 'Normal' : 'Yeni';
  const activityColor = s.memberCount > 500 ? '#3ba55c' : s.memberCount > 100 ? '#4f8ef7' : s.memberCount > 10 ? '#faa61a' : '#747f8d';
  const activityDot = `<span style="width:8px;height:8px;border-radius:50%;background:${activityColor};display:inline-block;margin-right:4px;flex-shrink:0;"></span>`;

  return `<div class="discover-card" role="article" aria-label="${escHtml(s.name)} sunucusu"
       tabindex="0"
       style="transition:transform 120ms,box-shadow 120ms;"
       onmouseenter="this.style.transform='translateY(-2px)';this.style.boxShadow='0 4px 16px rgba(0,0,0,0.25)'"
       onmouseleave="this.style.transform='';this.style.boxShadow=''"
       onclick="showServerPreview(${JSON.stringify(s).replace(/"/g, '&quot;')})"
       onkeydown="if(event.key==='Enter'||event.key===' ')showServerPreview(${JSON.stringify(s).replace(/"/g, '&quot;')})">
    <div style="${bannerStyle}" aria-hidden="true"></div>
    <div style="padding:12px;">
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div style="margin-top:-24px;border:3px solid var(--bg-2);border-radius:50%;">${iconHtml}</div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:700;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escHtml(s.name)}</div>
          <div style="color:var(--text-muted);font-size:12px;display:flex;align-items:center;" aria-label="${s.memberCount} üye">
            ${activityDot}<span>${s.memberCount} üye</span>
            <span style="margin:0 5px;opacity:.4;">·</span>
            <span style="color:${activityColor};font-weight:600;">${activityLevel}</span>
          </div>
        </div>
      </div>
      ${s.description ? `<p style="font-size:13px;color:var(--text-muted);margin:0 0 8px;overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;">${escHtml(s.description)}</p>` : ''}
      ${tags ? `<div style="display:flex;flex-wrap:wrap;gap:4px;" aria-label="Etiketler">${tags}</div>` : ''}
    </div>
    <div class="discover-join-btn" aria-hidden="true">Önizle →</div>
  </div>`;
}

// Server preview modal — katılmadan önce bilgi göster
window.showServerPreview = function(s) {
  document.getElementById('server-preview-modal')?.remove();

  const iconHtml = s.iconUrl
    ? `<img src="${API + escHtml(s.iconUrl)}" alt="" style="width:72px;height:72px;border-radius:50%;object-fit:cover;border:4px solid var(--bg-3);">`
    : `<div style="width:72px;height:72px;border-radius:50%;background:linear-gradient(135deg,var(--brand),#7289da);display:flex;align-items:center;justify-content:center;font-size:36px;border:4px solid var(--bg-3);">${escHtml(s.icon || '🌐')}</div>`;

  const bannerStyle = s.bannerUrl
    ? `background:url(${API + escHtml(s.bannerUrl)}) center/cover;`
    : `background:linear-gradient(135deg,var(--brand) 0%,#7289da 100%);`;

  const tagHtml = (s.tags || []).map(t => `<span class="discover-tag-pill">#${escHtml(t)}</span>`).join('');

  const modal = document.createElement('div');
  modal.id = 'server-preview-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:440px;width:95%;padding:0;overflow:hidden;">
      <div style="height:120px;${bannerStyle}position:relative;">
        <button onclick="document.getElementById('server-preview-modal').remove()"
          style="position:absolute;top:10px;right:10px;background:rgba(0,0,0,.5);border:none;width:28px;height:28px;border-radius:50%;color:#fff;font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;">✕</button>
      </div>
      <div style="padding:0 24px 24px;">
        <div style="margin-top:-36px;margin-bottom:12px;">${iconHtml}</div>
        <h2 style="font-size:22px;font-weight:800;margin:0 0 4px;">${escHtml(s.name)}</h2>
        <div style="color:var(--text-muted);font-size:13px;margin-bottom:12px;">
          👥 ${s.memberCount} üye &nbsp;·&nbsp; #️⃣ ${s.channelCount} kanal
        </div>
        ${s.description ? `<p style="font-size:14px;color:var(--text-2);line-height:1.6;margin-bottom:12px;">${escHtml(s.description)}</p>` : ''}
        ${tagHtml ? `<div style="display:flex;flex-wrap:wrap;gap:5px;margin-bottom:16px;">${tagHtml}</div>` : ''}
        <div style="display:flex;gap:8px;">
          <button onclick="joinFromDiscover('${escHtml(s._id)}');document.getElementById('server-preview-modal').remove();"
            style="flex:1;padding:11px;border:none;border-radius:var(--r-md);background:var(--brand);color:#fff;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;">
            Sunucuya Katıl →
          </button>
          <button onclick="document.getElementById('server-preview-modal').remove()"
            style="padding:11px 16px;border:1px solid var(--border);border-radius:var(--r-md);background:transparent;color:var(--text-2);font-size:14px;font-family:inherit;cursor:pointer;">
            Kapat
          </button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(modal);
  modal.onclick = e => { if (e.target === modal) modal.remove(); };
};

async function joinFromDiscover(serverId) {
  const alreadyMember = window.joinedServers?.some(s => s._id === serverId);
  if (alreadyMember) {
    document.getElementById('discovery-overlay')?.remove();
    if (window.selectServer) window.selectServer(serverId);
    return;
  }

  try {
    const r = await apiFetch(`${API}/api/servers/${serverId}/invites`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ maxUses: 0, expiresIn: 86400 }),
    });
    if (r.ok) {
      const inv = await r.json();
      const code = inv.code || inv._id;
      document.getElementById('discovery-overlay')?.remove();
      if (window.showJoinModal) {
        window.showJoinModal(code);
      }
    } else {
      toast('Bu sunucuya katılamıyorsun (davet gerekebilir)', 'error');
    }
  } catch(e) {
    toast('Bağlantı hatası', 'error');
  }
}

// ── DISCOVERY SETTINGS (server owner) ────────────────────────
function openDiscoverySettings() {
  if (!currentServer) return toast('Sunucu seçilmedi', 'error');

  const existing = document.getElementById('discovery-settings-modal');
  if (existing) existing.remove();

  const srv = currentServer;
  const modal = document.createElement('div');
  modal.id = 'discovery-settings-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:460px;width:95%;">
      <h2 style="margin-bottom:4px;">🌐 Sunucu Keşif Ayarları</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:20px;">
        Sunucunu keşif sayfasında göster ve yeni üyeler çek.
      </p>

      <label style="display:flex;align-items:center;gap:10px;margin-bottom:16px;cursor:pointer;">
        <input type="checkbox" id="disc-discoverable" style="width:18px;height:18px;accent-color:var(--brand);"
               ${srv.discoverable ? 'checked' : ''}>
        <div>
          <div style="font-weight:600;">Keşif Listesine Ekle</div>
          <div style="color:var(--text-muted);font-size:13px;">Diğer kullanıcılar sunucunu bulabilir</div>
        </div>
      </label>

      <label class="settings-label">Açıklama</label>
      <textarea id="disc-description" class="input" maxlength="500" rows="3"
                style="width:100%;resize:vertical;margin-bottom:12px;"
                placeholder="Sunucunuz hakkında kısa bir açıklama...">${escHtml(srv.description || '')}</textarea>

      <label class="settings-label">Etiketler <span style="color:var(--text-muted);font-size:12px;">(virgülle ayır, max 10)</span></label>
      <input id="disc-tags" class="input" placeholder="oyun, müzik, teknoloji"
             style="width:100%;margin-bottom:16px;"
             value="${escHtml((srv.tags || []).join(', '))}" />

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('discovery-settings-modal').remove()">İptal</button>
        <button class="btn" onclick="saveDiscoverySettings()">💾 Kaydet</button>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

async function saveDiscoverySettings() {
  const discoverable = document.getElementById('disc-discoverable')?.checked;
  const description  = document.getElementById('disc-description')?.value.trim();
  const tagsRaw      = document.getElementById('disc-tags')?.value;
  const tags = tagsRaw
    ? tagsRaw.split(',').map(t => t.trim().toLowerCase()).filter(Boolean).slice(0, 10)
    : [];

  try {
    const r = await apiFetch(`${API}/api/discover/settings`, {
      method:  'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ serverId: currentServer._id, discoverable, description, tags }),
    });
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Kaydedilemedi', 'error'); }
    document.getElementById('discovery-settings-modal')?.remove();
    toast('Keşif ayarları güncellendi! 🌐', 'success');
    if (window.currentServer) {
      currentServer.discoverable = discoverable;
      currentServer.description  = description;
      currentServer.tags         = tags;
    }
  } catch(e) {
    toast('Bağlantı hatası', 'error');
  }
}

// ── FEDERATION ADMIN PANELİ ───────────────────────────────────
async function openFederationAdmin() {
  const existing = document.getElementById('federation-modal');
  if (existing) { existing.remove(); return; }

  const modal = document.createElement('div');
  modal.id = 'federation-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:560px;width:95%;">
      <h2 style="margin-bottom:4px;">🌍 Federation Yönetimi</h2>
      <p style="color:var(--text-muted);font-size:13px;margin-bottom:16px;">
        Diğer Bridge instance'larına bağlan. Bağlı instance'lardan sunucular keşif sayfasında görünür.
      </p>

      <div style="display:flex;gap:8px;margin-bottom:16px;">
        <input id="fed-url" class="input" placeholder="https://bridge.example.com" style="flex:1;" />
        <button class="btn" onclick="addFederationPeer()">+ Ekle</button>
      </div>

      <div id="fed-peer-list" style="min-height:60px;">
        <div style="color:var(--text-muted);font-size:13px;">Yükleniyor...</div>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('federation-modal').remove()">Kapat</button>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
  loadFederationPeers();
}

async function loadFederationPeers() {
  const list = document.getElementById('fed-peer-list');
  if (!list) return;
  try {
    const r = await apiFetch(`${API}/api/federation/peers`);
    if (!r.ok) throw new Error();
    const peers = await r.json();
    if (!peers.length) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;">Henüz bağlı instance yok.</div>';
      return;
    }
    list.innerHTML = peers.map(p => `
      <div style="display:flex;align-items:center;gap:10px;padding:10px;background:var(--bg-3);border-radius:8px;margin-bottom:8px;">
        <div style="flex:1;">
          <div style="font-weight:600;">${escHtml(p.name)}</div>
          <div style="color:var(--text-muted);font-size:12px;">${escHtml(p.url)}</div>
        </div>
        <span style="font-size:11px;color:var(--green,#57f287);">✓ Bağlı</span>
        <button class="btn btn-secondary" style="padding:4px 10px;font-size:12px;" onclick="removeFederationPeer('${p.id}')">Kaldır</button>
      </div>`).join('');
  } catch {
    list.innerHTML = '<div style="color:var(--text-muted);">Yüklenemedi.</div>';
  }
}

async function addFederationPeer() {
  const url = document.getElementById('fed-url')?.value.trim();
  if (!url) return toast('URL gir', 'error');
  const btn = document.querySelector('#federation-modal .btn');
  if (btn) btn.disabled = true;
  try {
    const r = await apiFetch(`${API}/api/federation/peers`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ url }),
    });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Eklenemedi', 'error');
    toast(`${data.peer.name} eklendi! 🌍`, 'success');
    document.getElementById('fed-url').value = '';
    loadFederationPeers();
  } catch {
    toast('Bağlantı hatası', 'error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function removeFederationPeer(id) {
  if (!confirm('Bu instance kaldırılsın mı?')) return;
  try {
    await apiFetch(`${API}/api/federation/peers/${id}`, { method: 'DELETE' });
    toast('Kaldırıldı', 'success');
    loadFederationPeers();
  } catch {
    toast('Kaldırılamadı', 'error');
  }
}

export {
  addFederationPeer,
  debouncedDiscover,
  joinFromDiscover,
  joinRemoteServer,
  loadFederationPeers,
  openDiscovery,
  openDiscoverySettings,
  openFederationAdmin,
  removeFederationPeer,
  renderDiscoverCard,
  renderRemoteCard,
  runDiscover,
  runFederationDiscover,
  saveDiscoverySettings,
  switchDiscoverTab,
};
