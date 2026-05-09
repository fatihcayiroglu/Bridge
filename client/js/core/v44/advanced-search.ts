// client/js/core/v44/advanced-search.js
// ModÃ¼l: GeliÅŸmiÅŸ Arama UI â€” from: before: after: has:file filtreleri + sayfalama
'use strict';

(function patchGlobalSearch() {
  function injectSearchFilters() {
    const modal = document.getElementById('global-search-modal');
    if (!modal || modal.dataset.v44) return;
    modal.dataset.v44 = '1';

    const inputWrap = modal.querySelector('.gs-input-wrap') || modal.querySelector('input')?.parentNode;
    if (!inputWrap) return;

    const filterBar = document.createElement('div');
    filterBar.id = 'gs-filter-bar';
    filterBar.innerHTML = `
      <div class="gs-filter-row">
        <span class="gs-filter-label">Filtreler:</span>
        <label class="gs-chip">
          <span>ğŸ‘¤ Kim:</span>
          <input id="gsf-from" type="text" placeholder="kullanÄ±cÄ± adÄ±" class="gs-chip-input">
        </label>
        <label class="gs-chip">
          <span>ğŸ“… Ã–nce:</span>
          <input id="gsf-before" type="date" class="gs-chip-input">
        </label>
        <label class="gs-chip">
          <span>ğŸ“… Sonra:</span>
          <input id="gsf-after" type="date" class="gs-chip-input">
        </label>
        <label class="gs-chip">
          <span>ğŸ“ Sadece:</span>
          <select id="gsf-has" class="gs-chip-input">
            <option value="">TÃ¼mÃ¼</option>
            <option value="file">Dosyalar</option>
            <option value="image">Resimler</option>
          </select>
        </label>
        <label class="gs-chip">
          <span>#ï¸âƒ£ Kanal:</span>
          <input id="gsf-in" type="text" placeholder="kanal-adÄ±" class="gs-chip-input">
        </label>
        <button class="gs-clear-filters" onclick="clearGsFilters()">âœ• Temizle</button>
      </div>
      <div id="gs-filter-hint" style="font-size:11px;color:var(--text-muted);margin-top:4px;padding-left:4px">
        ğŸ’¡ Ä°pucu: Sorguda <code>from:ahmet</code>, <code>before:2024-01-01</code>, <code>has:file</code> yazabilirsiniz
      </div>
    `;
    inputWrap.after(filterBar);

    filterBar.querySelectorAll('input,select').forEach(el => {
      el.addEventListener('change', () => {
        const q = document.getElementById('gs-input')?.value;
        if (q) doGlobalSearch(q);
      });
    });
  }

  const _origDo = window.doGlobalSearch;
  window.doGlobalSearch = async function(q) {
    injectSearchFilters();

    const from   = document.getElementById('gsf-from')?.value.trim();
    const before = document.getElementById('gsf-before')?.value;
    const after  = document.getElementById('gsf-after')?.value;
    const has    = document.getElementById('gsf-has')?.value;
    const inChan = document.getElementById('gsf-in')?.value.trim();

    let fullQ = q;
    if (from)   fullQ += ` from:${from}`;
    if (before) fullQ += ` before:${before}`;
    if (after)  fullQ += ` after:${after}`;
    if (has)    fullQ += ` has:${has}`;
    if (inChan) fullQ += ` in:${inChan.replace(/^#/, '')}`;

    if (!currentServer) return;
    const res = document.getElementById('gs-results');
    if (!res) return;
    res.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted)">AranÄ±yor...</div>';

    try {
      const params = new URLSearchParams({ q: fullQ, serverId: currentServer._id, type: gsTab });
      const r    = await apiFetch(`${API}/api/search?${params}`);
      const data = await r.json();
      if (!r.ok) {
        res.innerHTML = `<div style="color:var(--red);padding:16px">${data.error || 'Arama baÅŸarÄ±sÄ±z'}</div>`;
        return;
      }
      renderGsResults(data, q);

      if (data.messagesHasMore) {
        const btn = document.createElement('button');
        btn.className = 'gs-load-more';
        btn.textContent = `â¬‡ï¸ Daha fazla (${data.messagesTotalCount} sonuÃ§)`;
        btn.onclick = () => loadMoreSearchResults(fullQ, 25);
        res.appendChild(btn);
      }
    } catch {
      res.innerHTML = '<div style="color:var(--red);padding:16px">Arama baÅŸarÄ±sÄ±z</div>';
    }
  };

  window.clearGsFilters = function() {
    ['gsf-from','gsf-before','gsf-after','gsf-in'].forEach(id => {
      const el = document.getElementById(id); if (el) el.value = '';
    });
    const sel = document.getElementById('gsf-has'); if (sel) sel.value = '';
    const q = document.getElementById('gs-input')?.value;
    if (q) doGlobalSearch(q);
  };

  window.loadMoreSearchResults = async function(fullQ, offset) {
    const res = document.getElementById('gs-results');
    if (!res || !currentServer) return;
    const params = new URLSearchParams({ q: fullQ, serverId: currentServer._id, type: 'messages', offset });
    const r = await apiFetch(`${API}/api/search?${params}`);
    const data = await r.json();
    res.querySelector('.gs-load-more')?.remove();
    renderGsResults({ messages: data.messages || [] }, fullQ.split(' ')[0], true);
    if (data.messagesHasMore) {
      const btn = document.createElement('button');
      btn.className = 'gs-load-more';
      btn.textContent = 'â¬‡ï¸ Daha fazla';
      btn.onclick = () => loadMoreSearchResults(fullQ, offset + 25);
      res.appendChild(btn);
    }
  };

  const _origRender = window.renderGsResults;
  window.renderGsResults = function(data, q, append = false) {
    const res = document.getElementById('gs-results');
    if (!res) return;
    if (!append) {
      if (_origRender) return _origRender(data, q);
    } else {
      const msgs = data.messages || [];
      for (const msg of msgs) {
        const div = document.createElement('div');
        div.className = 'gs-result-item';
        div.innerHTML = `
          <div class="gs-result-meta">
            <strong>${msg.displayName || msg.username}</strong>
            <span class="gs-result-time">${new Date(msg.createdAt).toLocaleDateString('tr-TR')}</span>
            <span class="gs-result-chan">#${msg.channelId?.slice(0,6) || '?'}</span>
          </div>
          <div class="gs-result-text">${msg.content?.slice(0,200) || '[dosya]'}</div>
        `;
        div.onclick = () => { jumpToMessage(msg._id, msg.channelId); closeGlobalSearch(); };
        res.appendChild(div);
      }
    }
  };
})();

