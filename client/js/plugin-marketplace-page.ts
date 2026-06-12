import { BridgeRegistry } from './core/bridge-registry.ts';
(function () {
  const API = (window as unknown as Record<string,unknown>).BRIDGE_API || location.origin;
  let cachedBots: Array<Record<string, unknown>> = [];
  let cachedPlugins: Array<Record<string, unknown>> = [];
  let manageableServers: Array<Record<string, unknown>> = [];

  async function api(path: string, opts: RequestInit = {}) {
    const token = localStorage.getItem('token');
    const headers = Object.assign({}, opts.headers || {}) as Record<string, string>;
    if (token) headers.Authorization = `Bearer ${token}`;
    const res = await fetch(`${API}${path}`, { ...opts, headers });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  function card(title, body, meta) {
    return `<article class="card"><div style="font-weight:700;margin-bottom:6px">${title}</div><div class="muted">${body || 'Açıklama yok'}</div><div style="margin-top:8px;font-size:12px;color:var(--text-3)">${meta || ''}</div></article>`;
  }

  function esc(v) {
    return String(v || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  async function loadPlugins(q) {
    const el = document.getElementById('plugins');
    el.innerHTML = '<div class="muted">Yükleniyor...</div>';
    try {
      let list = await api('/api/plugins');
      if (q) list = list.filter(p => `${p.name} ${p.description}`.toLowerCase().includes(q));
      cachedPlugins = list;
      el.innerHTML = list.length
        ? list.map((p, i) => `
          ${card(`ğŸ”Œ ${p.name}`, p.description, `${p.author || 'unknown'} Â· v${p.version || '?'}`)}
          <div class="row" style="margin-top:-8px;margin-bottom:10px">
            <button class="btn" onclick="showPluginDetails(${i})">Detay</button>
          </div>
        `).join('')
        : '<div class="muted">Plugin bulunamadı.</div>';
    } catch {
      el.innerHTML = '<div class="muted">Plugin listesi için giriş yapman gerekiyor.</div>';
    }
  }

  async function loadBots(q) {
    const el = document.getElementById('bots');
    el.innerHTML = '<div class="muted">Yükleniyor...</div>';
    try {
      const data = await api(`/api/bots/marketplace?category=all&limit=60${q ? `&q=${encodeURIComponent(q)}` : ''}`);
      cachedBots = data;
      el.innerHTML = data.length
        ? data.map((b, i) => `
          <article class="card">
            <div style="font-weight:700;margin-bottom:6px">ğŸ¤– ${esc(b.username)}</div>
            <div class="muted">${esc(b.description || 'Açıklama yok')}</div>
            <div class="row">
              <span class="pill">${esc(b.category || 'utility')}</span>
              <span class="pill">🌐 ${b.serverCount || 0} sunucu</span>
              <span class="pill">â­ ${b.rating || 0} (${b.ratingCount || 0})</span>
            </div>
            <div class="row">
              <button class="btn" onclick="showBotDetails(${i})">Detay</button>
              <button class="btn btn-primary" onclick="installBotFlow('${esc(b._id)}')">Kur</button>
            </div>
          </article>
        `).join('')
        : '<div class="muted">Bot bulunamadı.</div>';
    } catch {
      el.innerHTML = '<div class="muted">Bot listesi yüklenemedi.</div>';
    }
  }

  async function loadManageableServers() {
    try {
      const list = await api('/api/servers');
      manageableServers = Array.isArray(list) ? list : [];
    } catch {
      manageableServers = [];
    }
  }

  BridgeRegistry.register('closeMktModal', function closeMktModal() {
    const el = document.getElementById('marketplace-modal');
    if (el) el.style.display = 'none';
  });

  BridgeRegistry.register('showPluginDetails', function showPluginDetails(idx: unknown) {
    const p = cachedPlugins[Number(idx)];
    if (!p) return;
    const box = document.getElementById('mkt-modal-content');
    box.innerHTML = `
      <h2>ğŸ"Œ ${esc(p.name)}</h2>
      <p class="muted">${esc(p.description || 'Açıklama yok')}</p>
      <div class="row">
        <span class="pill">Yazar: ${esc(p.author || 'unknown')}</span>
        <span class="pill">Sürüm: ${esc(p.version || '?')}</span>
        <span class="pill">ID: ${esc(p.id || '-')}</span>
      </div>
      <p class="muted" style="margin-top:12px">Pluginler şu anda sunucu tarafında yüklenmiş bileşenler olarak listelenir. Bu ekran görünürlük ve keşif için hazırlanmıştır.</p>
    `;
    const mktEl = document.getElementById('marketplace-modal');
    if (mktEl) mktEl.style.display = 'flex';
  });

  BridgeRegistry.register('showBotDetails', function showBotDetails(idx: unknown) {
    const b = cachedBots[Number(idx)];
    if (!b) return;
    const box = document.getElementById('mkt-modal-content');
    box.innerHTML = `
      <h2>ğŸ¤– ${esc(b.username)}</h2>
      <p class="muted">${esc(b.description || 'Açıklama yok')}</p>
      <div class="row">
        <span class="pill">Kategori: ${esc(b.category || 'utility')}</span>
        <span class="pill">Komut: ${b.commands || 0}</span>
        <span class="pill">Puan: â­ ${b.rating || 0} (${b.ratingCount || 0})</span>
      </div>
      <div class="row">
        <label style="font-size:13px;width:100%">Puan ver (1-5)</label>
        <input id="mkt-rate-value" class="input-field field" type="number" min="1" max="5" value="5">
        <button class="btn btn-primary" onclick="rateBot('${esc(b._id)}')">Puanla</button>
      </div>
      <div class="row">
        <label style="font-size:13px;width:100%">Kurulum için hedef sunucu</label>
        <select id="mkt-install-server" class="input-field field">
          ${manageableServers.length
            ? manageableServers.map(s => `<option value="${esc(s._id)}">${esc(s.name || s._id)}</option>`).join('')
            : '<option value="">Yonetebildigin sunucu bulunamadi</option>'}
        </select>
        <button class="btn btn-primary" onclick="installBotWithServer('${esc(b._id)}')">Server'a Kur</button>
      </div>
    `;
    const modal = document.getElementById('marketplace-modal') as HTMLElement | null;
    if (modal) modal.style.display = 'flex';
  });

  BridgeRegistry.register('rateBot', async function rateBot(botId: unknown) {
    try {
      const rating = Number(((document.getElementById('mkt-rate-value') as HTMLInputElement | null)?.value ?? '') || 0);
      if (rating < 1 || rating > 5) throw new Error('Puan 1-5 arası olmalı');
      await api(`/api/bots/${botId}/rate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rating }),
      });
      alert('Puanlama kaydedildi.');
      await BridgeRegistry.call('loadMarketplace');
    } catch (e) {
      alert(e.message || 'Puanlama başarısız');
    }
  });

  BridgeRegistry.register('installBotFlow', function installBotFlow(botId: unknown) {
    const sid = prompt('Kurulum için server ID gir');
    if (!sid) return;
    BridgeRegistry.call('installBotWithServer', botId, sid);
  });

  BridgeRegistry.register('installBotWithServer', async function installBotWithServer(botId: unknown, explicitServerId: unknown) {
    try {
      const sid = explicitServerId || document.getElementById('mkt-install-server')?.value?.trim();
      if (!sid) throw new Error('Server ID gerekli');
      await api(`/api/servers/${sid}/bots/${botId}/add`, { method: 'POST' });
      alert('Bot sunucuya eklendi.');
    } catch (e) {
      alert(e.message || 'Kurulum başarısız');
    }
  });

  BridgeRegistry.register('loadMarketplace', async function loadMarketplace() {
    const q = (document.getElementById('q')?.value || '').trim().toLowerCase();
    await Promise.all([loadManageableServers(), loadPlugins(q), loadBots(q)]);
  });

  document.getElementById('q')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') BridgeRegistry.call('loadMarketplace');
  });

  BridgeRegistry.call('loadMarketplace');
})();

