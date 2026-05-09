// client/js/marketplace.js â€” Bot Marketplace UI
(function () {
  let currentCategory = 'all';
  let searchDebounce = null;

  window.openMarketplacePage = function () {
    window.location.href = '/marketplace';
  };

  window.openBotMarketplace = async function () {
    document.getElementById('temp-modal')?.remove();
    const overlay = document.createElement('div');
    overlay.id = 'marketplace-modal';
    overlay.className = 'modal-overlay';
    overlay.style.cssText = 'z-index:10000;';
    overlay.innerHTML = `
      <div class="modal-card" style="max-width:800px;width:96%;max-height:88vh;overflow:hidden;display:flex;flex-direction:column;padding:0">
        <div style="padding:20px 24px 12px;border-bottom:1px solid var(--bg-4);display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap">
          <div>
            <h2 style="font-size:20px;font-weight:800">ğŸ¤– Bot Marketplace</h2>
            <p style="color:var(--text-3);font-size:13px;margin-top:2px">Bridge iÃ§in botlarÄ± keÅŸfet ve sunucuna ekle</p>
          </div>
          <button onclick="document.getElementById('marketplace-modal').remove()" style="background:none;border:none;cursor:pointer;font-size:22px;color:var(--text-3);padding:4px 8px">âœ•</button>
        </div>
        <div style="padding:12px 24px;border-bottom:1px solid var(--bg-4);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <input id="mkt-search" type="text" class="input-field" placeholder="ğŸ” Bot ara..." style="flex:1;min-width:160px;padding:8px 12px;font-size:13px" oninput="debounceMktSearch(this.value)">
        </div>
        <div id="mkt-cats" style="padding:10px 24px;border-bottom:1px solid var(--bg-4);display:flex;gap:6px;flex-wrap:wrap;overflow-x:auto"></div>
        <div id="mkt-grid" style="overflow-y:auto;flex:1;padding:16px 24px" class="marketplace-grid">
          <div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-3)">YÃ¼kleniyor...</div>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

    await loadMarketplaceCategories();
    await loadMarketplaceBots();
  };

  async function loadMarketplaceCategories() {
    const r = await apiFetch(`${API}/api/bots/marketplace/categories`);
    const cats = r.ok ? await r.json() : [];
    const container = document.getElementById('mkt-cats');
    if (!container) return;
    container.innerHTML = cats.map(c => `
      <button class="filter-chip ${c.id === currentCategory ? 'active' : ''}"
        onclick="setMktCategory('${c.id}')" data-cat="${c.id}">
        ${c.icon} ${escHtml(c.label)}
      </button>`).join('');
  }

  window.setMktCategory = async function (cat) {
    currentCategory = cat;
    document.querySelectorAll('#mkt-cats .filter-chip').forEach(b =>
      b.classList.toggle('active', b.dataset.cat === cat));
    await loadMarketplaceBots();
  };

  window.debounceMktSearch = function (val) {
    clearTimeout(searchDebounce);
    searchDebounce = setTimeout(() => loadMarketplaceBots(val), 320);
  };

  async function loadMarketplaceBots(q = '') {
    const grid = document.getElementById('mkt-grid');
    if (!grid) return;
    grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:32px;color:var(--text-3)">YÃ¼kleniyor...</div>';

    const params = new URLSearchParams({ category: currentCategory, limit: 60 });
    if (q) params.set('q', q);
    const r = await apiFetch(`${API}/api/bots/marketplace?${params}`);
    const bots = r.ok ? await r.json() : [];

    if (!bots.length) {
      grid.innerHTML = '<div style="grid-column:1/-1;text-align:center;padding:40px;color:var(--text-3)"><div style="font-size:40px;margin-bottom:8px">ğŸ¤–</div><div>Bu kategoride bot bulunamadÄ±</div></div>';
      return;
    }

    grid.innerHTML = '';
    for (const bot of bots) {
      const card = document.createElement('div');
      card.className = 'bot-card';
      const stars = 'â­'.repeat(Math.round(bot.rating || 0));
      card.innerHTML = `
        <div class="bot-card-header">
          <div class="bot-avatar">${bot.icon ? `<img src="${escHtml(bot.icon)}" width="44" height="44" style="border-radius:50%">` : 'ğŸ¤–'}</div>
          <div>
            <div class="bot-name">${escHtml(bot.username)} ${bot.verified ? '<span class="bot-verified-badge">âœ“ DoÄŸrulandÄ±</span>' : ''}</div>
            <div class="bot-category">${escHtml(bot.category)}</div>
          </div>
        </div>
        <div class="bot-desc">${escHtml(bot.description || 'AÃ§Ä±klama yok.')}</div>
        <div class="bot-stats">
          <span title="Sunucu sayÄ±sÄ±">ğŸŒ ${bot.serverCount} sunucu</span>
          <span title="Komut sayÄ±sÄ±">âš¡ ${bot.commands} komut</span>
          ${bot.rating ? `<span title="Puan">${stars} ${bot.rating}</span>` : ''}
        </div>
        <button class="bot-add-btn" onclick="addBotToServer('${bot._id}','${escHtml(bot.username)}')">+ Sunucuya Ekle</button>`;
      grid.appendChild(card);
    }
  }

  window.addBotToServer = async function (botId, botName) {
    if (!currentServer) return toast('Ã–nce bir sunucu seÃ§', 'error');
    const r = await apiFetch(`${API}/api/servers/${currentServer._id}/bots/${botId}/add`, { method: 'POST' });
    const data = await r.json();
    if (!r.ok) return toast(data.error || 'Eklenemedi', 'error');
    toast(`${botName} sunucuya eklendi! ğŸ¤–`, 'success');
  };
})();

// â”€â”€ Marketplace aÃ§ma butonu iÃ§in filtre chip CSS â”€â”€
const _mktStyle = document.createElement('style');
_mktStyle.textContent = `
  .filter-chip { background: var(--bg-3); border: 1px solid var(--bg-4); border-radius: 20px; padding: 5px 12px; font-size: 13px; font-weight: 600; color: var(--text-2); cursor: pointer; transition: all .15s; white-space: nowrap; }
  .filter-chip:hover { border-color: var(--brand); color: var(--text-1); }
  .filter-chip.active { background: var(--brand); border-color: var(--brand); color: #fff; }
`;
document.head.appendChild(_mktStyle);

