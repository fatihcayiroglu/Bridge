export {};
// core/emoji.js (split from app.js)
async function loadAllServerGifs() {
  const grid = document.getElementById('server-gif-panel-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="gif-loading">YÃ¼kleniyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/gifs/all`);
    const grouped = await r.json();
    const entries = Object.entries(grouped);
    if (!entries.length) { grid.innerHTML = '<div class="gif-loading">HiÃ§bir sunucuda GIF yok.</div>'; return; }
    grid.innerHTML = '';
    for (const [serverId, { server, gifs }] of entries) {
      const section = document.createElement('div');
      section.className = 'server-gif-section';
      const titleDiv = document.createElement('div');
      titleDiv.className = 'server-gif-section-title';
      titleDiv.textContent = (server.icon || 'ğŸŒ') + ' ' + server.name;
      const gifGrid = document.createElement('div');
      gifGrid.className = 'server-gif-section-grid';
      for (const g of gifs) {
        const img = document.createElement('img');
        img.src = API + g.url;
        img.alt = g.name;
        img.loading = 'lazy';
        img.className = 'gif-item';
        img.title = g.name;
        img.addEventListener('click', () => sendServerGif(API + g.url, g.name));
        gifGrid.appendChild(img);
      }
      section.appendChild(titleDiv);
      section.appendChild(gifGrid);
      grid.appendChild(section);
    }
  } catch { grid.innerHTML = '<div class="gif-loading">YÃ¼kleme baÅŸarÄ±sÄ±z.</div>'; }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CHANNEL BRIDGE MANAGEMENT
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function openBridgeModal() {
  if (!currentChannel) return toast('Ã–nce bir kanal seÃ§', 'error');
  const modal = document.getElementById('bridge-modal');
  modal.style.display = 'flex';
  await loadBridges();
}

async function loadBridges() {
  const list = document.getElementById('bridge-list');
  if (!list || !currentChannel) return;
  list.innerHTML = '<div class="empty-list">YÃ¼kleniyor...</div>';
  const r = await apiFetch(`${API}/api/bridges?channelId=${currentChannel._id}`);
  const bridges = await r.json();
  if (!bridges.length) { list.innerHTML = '<div class="empty-list">Bu kanalda aktif bridge yok.</div>'; return; }
  list.innerHTML = '';
  for (const b of bridges) {
    const item = document.createElement('div');
    item.className = 'bridge-item';
    const span = document.createElement('span');
    span.textContent = 'ğŸŒ‰ ' + (b.label || 'Bridge') + ' ' + (b.sourceChannelId === currentChannel._id ? 'â†’' : 'â†') + ' ' + b.targetChannelId.slice(0, 12) + '...';
    const delBtn = document.createElement('button');
    delBtn.className = 'btn-cancel-scheduled';
    delBtn.textContent = 'ğŸ—‘ï¸';
    const bid = b._id;
    delBtn.addEventListener('click', () => removeBridge(bid));
    item.appendChild(span);
    item.appendChild(delBtn);
    list.appendChild(item);
  }
}

async function createBridge() {
  if (!currentChannel || !currentServer) return;
  const targetChannelId = document.getElementById('bridge-target-channel')?.value?.trim();
  const targetServerId = document.getElementById('bridge-target-server')?.value?.trim();
  const label = document.getElementById('bridge-label')?.value?.trim() || 'Bridge';
  if (!targetChannelId || !targetServerId) return toast('Hedef kanal ve sunucu ID gerekli', 'error');
  const r = await apiFetch(`${API}/api/bridges`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceChannelId: currentChannel._id, targetChannelId, sourceServerId: currentServer._id, targetServerId, label }) });
  const data = await r.json();
  if (!r.ok) return toast(data.error, 'error');
  toast('Bridge oluÅŸturuldu! ğŸŒ‰', 'success');
  await loadBridges();
  loadBridgeInfo(currentChannel._id);
}

async function removeBridge(bridgeId) {
  const r = await apiFetch(`${API}/api/bridges/${bridgeId}`, { method: 'DELETE' });
  if (!r.ok) return toast('Silinemedi', 'error');
  toast('Bridge kaldÄ±rÄ±ldÄ±', 'success');
  await loadBridges();
  loadBridgeInfo(currentChannel._id);
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// CHANNEL FILE ARCHIVE
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
async function openFileArchive() {
  if (!currentChannel) return toast('Ã–nce bir kanal seÃ§', 'error');
  const modal = document.getElementById('file-archive-modal');
  if (modal) modal.style.display = 'flex';
  if (typeof loadChannelFiles === 'function') {
    await loadChannelFiles(currentChannel._id);
  }
}

