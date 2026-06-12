// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/EmojiPanel.svelte
//              client/js/core/emoji-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
import { escHtml } from './utils.js';
import { getCurrentChannel, getCurrentServer, getAPI } from './globals.js';
// core/emoji.ts
// Server GIF collections + Channel Bridge management + File Archive

// ── Types ─────────────────────────────────────────────────────────────────────

interface GifItem {
  name: string;
  url: string;
}

interface ServerGifEntry {
  server: { name: string; icon?: string };
  gifs: GifItem[];
}

interface BridgeEntry {
  _id: string;
  label?: string;
  sourceChannelId: string;
  targetChannelId: string;
}

 as Record<string, string>)[c]!
  );
}

// ── GIFs ──────────────────────────────────────────────────────────────────────

export async function loadAllServerGifs(): Promise<void> {
  const grid = document.getElementById('server-gif-panel-grid');
  if (!grid) return;
  grid.innerHTML = '<div class="gif-loading">Yükleniyor...</div>';

  try {
    const r       = await apiFetch(`${getAPI()}/api/gifs/all`);
    const grouped: Record<string, ServerGifEntry> = await r.json();
    const entries = Object.entries(grouped);

    if (!entries.length) {
      grid.innerHTML = '<div class="gif-loading">Hiçbir sunucuda GIF yok.</div>';
      return;
    }

    grid.innerHTML = '';
    for (const [, { server, gifs }] of entries) {
      const section  = document.createElement('div');
      section.className = 'server-gif-section';

      const titleDiv = document.createElement('div');
      titleDiv.className   = 'server-gif-section-title';
      titleDiv.textContent = (server.icon ?? '🌐') + ' ' + server.name;

      const gifGrid = document.createElement('div');
      gifGrid.className = 'server-gif-section-grid';

      for (const g of gifs) {
        const img      = document.createElement('img');
        img.src        = (getAPI()) + g.url;
        img.alt        = g.name;
        img.loading    = 'lazy';
        img.className  = 'gif-item';
        img.title      = g.name;
        img.addEventListener('click', () =>
          BridgeRegistry.call('sendServerGif', (getAPI()) + g.url, g.name)
        );
        gifGrid.appendChild(img);
      }

      section.append(titleDiv, gifGrid);
      grid.appendChild(section);
    }
  } catch {
    grid.innerHTML = '<div class="gif-loading">Yükleme başarısız.</div>';
  }
}

// ── Bridge management ─────────────────────────────────────────────────────────

export async function openBridgeModal(): Promise<void> {
  const currentChannel = getCurrentChannel();
  if (!currentChannel) { toast('Önce bir kanal seç', 'error'); return; }
  const modal = document.getElementById('bridge-modal');
  if (modal) modal.style.display = 'flex';
  await loadBridges();
}

export async function loadBridges(): Promise<void> {
  const list           = document.getElementById('bridge-list');
  const currentChannel = getCurrentChannel();
  if (!list || !currentChannel) return;

  list.innerHTML = '<div class="empty-list">Yükleniyor...</div>';
  const r       = await apiFetch(`${getAPI()}/api/bridges?channelId=${(currentChannel as {_id:string})._id}`);
  const bridges: BridgeEntry[] = await r.json();

  if (!bridges.length) {
    list.innerHTML = '<div class="empty-list">Bu kanalda aktif bridge yok.</div>';
    return;
  }

  list.innerHTML = '';
  for (const b of bridges) {
    const item = document.createElement('div');
    item.className = 'bridge-item';

    const span = document.createElement('span');
    const dir  = b.sourceChannelId === currentChannel._id ? '→' : '←';
    span.textContent = `🌉 ${b.label ?? 'Bridge'} ${dir} ${b.targetChannelId.slice(0, 12)}...`;

    const delBtn = document.createElement('button');
    delBtn.className   = 'btn-cancel-scheduled';
    delBtn.textContent = '🗑️';
    const bid = b._id;
    delBtn.addEventListener('click', () => removeBridge(bid));

    item.append(span, delBtn);
    list.appendChild(item);
  }
}

export async function createBridge(): Promise<void> {
  const currentChannel = getCurrentChannel();
  const currentServer  = getCurrentServer();
  if (!currentChannel || !currentServer) return;

  const targetChannelId = (document.getElementById('bridge-target-channel') as HTMLInputElement | null)?.value.trim();
  const targetServerId  = (document.getElementById('bridge-target-server')  as HTMLInputElement | null)?.value.trim();
  const label           = (document.getElementById('bridge-label')          as HTMLInputElement | null)?.value.trim() ?? 'Bridge';

  if (!targetChannelId || !targetServerId) {
    toast('Hedef kanal ve sunucu ID gerekli', 'error');
    return;
  }

  const r = await apiFetch(`${getAPI()}/api/bridges`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      sourceChannelId: currentChannel._id,
      targetChannelId,
      sourceServerId:  currentServer._id,
      targetServerId,
      label,
    }),
  });
  const data = await r.json();
  if (!r.ok) { toast(data.error as string, 'error'); return; }

  toast('Bridge oluşturuldu! 🌉', 'success');
  await loadBridges();
  BridgeRegistry.call('loadBridgeInfo', (currentChannel as {_id:string})._id);
}

export async function removeBridge(bridgeId: string): Promise<void> {
  const r = await apiFetch(`${getAPI()}/api/bridges/${bridgeId}`, { method: 'DELETE' });
  if (!r.ok) { toast('Silinemedi', 'error'); return; }
  toast('Bridge kaldırıldı', 'success');
  await loadBridges();
  BridgeRegistry.call('loadBridgeInfo', getCurrentChannel()?._id);
}

// ── File archive shortcut ─────────────────────────────────────────────────────

export async function openFileArchive(): Promise<void> {
  const currentChannel = getCurrentChannel();
  if (!currentChannel) { toast('Önce bir kanal seç', 'error'); return; }
  const modal = document.getElementById('file-archive-modal');
  if (modal) modal.style.display = 'flex';
  await (BridgeRegistry.get<(id: string) => Promise<void>>('loadChannelFiles') ?? (async () => {}))(currentChannel._id);
}
