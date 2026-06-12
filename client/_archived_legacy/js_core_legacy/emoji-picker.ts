// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/EmojiPickerPanel.svelte
//              client/js/core/emoji-picker-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/emoji-picker.ts
// Sprint 50: JS → TypeScript tam dönüşümü
// Emoji + GIF picker sistemi

declare function apiFetch(url: string): Promise<Response>;
declare function sendMessage(): void;
declare const API: string;

// ── Tip tanımları ─────────────────────────────────────────────

interface GifMediaFormat { url: string; }
interface GifItem {
  title?: string;
  media_formats?: {
    gif?: GifMediaFormat;
    tinygif?: GifMediaFormat;
  };
}

// ── Sabitler ─────────────────────────────────────────────────

const EMOJI_CATEGORIES: Record<string, string[]> = {
  '😊 Yüzler':    ['😀','😃','😄','😁','😆','😅','🤣','😂','🙂','🙃','😉','😊','😇','🥰','😍','🤩','😘','😋','😛','😝','😜','🤪','🤨','🧐','🤓','😎','😏','😒','😞','😔','😟','😕','🙁','☹️','😣','😖','😫','😩','🥺','😢','😭','😤','😠','😡','🤬','🤯','😳','🥵','🥶','😱','😨','😰','😥','😓','🤗','🤔','🤭','🤫','🤥','😶','😐','😑','😬','🙄','😯','😦','😧','😮','😲','🥱','😴','😵','🤐','🥴','🤢','🤮','🤧','😷','🤒','🤕','🤑','😈','👿','💀','☠️','💩','🤡','👹','👺','👻','👽','👾','🤖'],
  '👋 Eller':     ['👋','🤚','🖐️','✋','🖖','👌','🤌','🤏','✌️','🤞','🤟','🤘','🤙','👈','👉','👆','👇','☝️','👍','👎','✊','👊','🤛','🤜','👏','🙌','👐','🤲','🤝','🙏','💅','💪'],
  '❤️ Kalpler':   ['❤️','🧡','💛','💚','💙','💜','🖤','🤍','🤎','💔','❣️','💕','💞','💓','💗','💖','💘','💝','💟'],
  '🎉 Kutlama':   ['🎉','🎊','🎈','🎀','🎁','🎆','🎇','🧨','✨','🎤','🎧','🎼','🎵','🎶','🎹','🥁','🎷','🎺','🎸','🎻','🎲','🎯','🎱','🎳','🎰','🎮'],
  '🔥 Popüler':   ['🔥','💯','✅','❌','⭐','🌟','💫','⚡','🌈','☀️','🌙','❄️','🌊','🍀','🌸','🌺','🌻','🌹','💐','🦋','🐝'],
  '🐶 Hayvanlar': ['🐶','🐱','🐭','🐹','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🙈','🙉','🙊','🐔','🐧','🐦','🦆','🦅','🦉','🦇','🐺','🐴','🦄','🦋','🐢','🐍','🦎','🐙','🐳','🦈'],
  '🍕 Yemek':     ['🍕','🍔','🍟','🌭','🌮','🌯','🥙','🥚','🍳','🥘','🍲','🥞','🧇','🥓','🥩','🍗','🍖','🌽','🥕','🍞','🥐','🧀','🍣','🍤','🥟','🍦','🍧','🍩','🍪','🎂','🍰','🧁','🍫','🍬','🍭'],
  '🚀 Nesneler':  ['🚀','💡','🔑','🗝️','🔒','🔓','🔨','🔧','🔩','⚙️','💻','🖥️','📱','📞','📺','📷','📸','📹','🔦','🕯️','💡','🔎','🔍','📡','🏆','🥇','🥈','🥉'],
};

let currentPickerTab = 'emoji';
let gifSearchTimer: ReturnType<typeof setTimeout> | null = null;

// ── Emoji ─────────────────────────────────────────────────────

export function initEmojiPicker(): void {
  const catBar = document.getElementById('emoji-categories');
  if (!catBar) return;
  catBar.innerHTML = '';
  let first = true;
  for (const cat of Object.keys(EMOJI_CATEGORIES)) {
    const btn = document.createElement('button');
    btn.className = 'ep-cat-btn' + (first ? ' active' : '');
    btn.textContent = cat.split(' ')[0];
    btn.title = cat;
    btn.onclick = () => {
      document.querySelectorAll('.ep-cat-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      renderEmojiGrid(EMOJI_CATEGORIES[cat]);
    };
    catBar.appendChild(btn);
    first = false;
  }
  renderEmojiGrid(Object.values(EMOJI_CATEGORIES)[0]);
}

export function renderEmojiGrid(list: string[]): void {
  const grid = document.getElementById('emoji-grid');
  if (!grid) return;
  grid.innerHTML = '';
  for (const e of list) {
    const btn = document.createElement('div');
    btn.className = 'emoji-btn';
    btn.textContent = e;
    btn.onclick = () => insertEmoji(e);
    grid.appendChild(btn);
  }
}

export function filterEmojis(query: string): void {
  if (!query.trim()) { initEmojiPicker(); return; }
  const all = Object.values(EMOJI_CATEGORIES).flat();
  renderEmojiGrid(all.filter(e => e.includes(query.toLowerCase())));
}

export function toggleEmojiPicker(): void {
  const p = document.getElementById('emoji-picker');
  if (!p) return;
  const isHidden = p.style.display === 'none' || p.style.display === '';
  p.style.display = isHidden ? 'block' : 'none';
}

export function insertEmoji(e: string): void {
  const inp = document.getElementById('msg-input') as HTMLInputElement | null;
  if (!inp) return;
  const pos = inp.selectionStart ?? inp.value.length;
  inp.value = inp.value.slice(0, pos) + e + inp.value.slice(pos);
  inp.focus();
  const picker = document.getElementById('emoji-picker');
  if (picker) picker.style.display = 'none';
}

// ── Tab switching ─────────────────────────────────────────────

export function switchPickerTab(tab: string): void {
  currentPickerTab = tab;
  (['emoji', 'gif', 'server-gif'] as const).forEach(t => {
    const panel = document.getElementById(`panel-${t}`);
    if (panel) panel.style.display = t === tab ? '' : 'none';
    const tabEl = document.getElementById(`tab-${t}`);
    if (tabEl) tabEl.classList.toggle('active', `tab-${t}` === `tab-${tab}`);
  });
  if (tab === 'gif') void loadTrendingGifs();
  if (tab === 'server-gif') BridgeRegistry && (BridgeRegistry as { call?: (n: string) => void }).call?.('loadAllServerGifs');
}

// ── GIF ───────────────────────────────────────────────────────

export async function loadTrendingGifs(): Promise<void> {
  const label = document.getElementById('gif-label');
  const grid  = document.getElementById('gif-grid');
  if (label) label.textContent = '🔥 Trend GIFler';
  if (grid)  grid.innerHTML = '<div class="gif-loading">Yükleniyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/gif/trending`);
    if (!r.ok) throw new Error('unavailable');
    const d = await r.json() as { results?: GifItem[] };
    renderGifs(d.results ?? []);
  } catch {
    if (grid) grid.innerHTML = '<div class="gif-loading">GIF özelliği yapılandırılmamış.</div>';
  }
}

export async function searchGifs(q: string): Promise<void> {
  if (!q.trim()) { void loadTrendingGifs(); return; }
  const label = document.getElementById('gif-label');
  const grid  = document.getElementById('gif-grid');
  if (label) label.textContent = `🔍 "${q}" sonuçları`;
  if (grid)  grid.innerHTML = '<div class="gif-loading">Aranıyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/gif/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error('unavailable');
    const d = await r.json() as { results?: GifItem[] };
    renderGifs(d.results ?? []);
  } catch {
    if (grid) grid.innerHTML = '<div class="gif-loading">Arama başarısız.</div>';
  }
}

export function renderGifs(results: GifItem[]): void {
  const grid = document.getElementById('gif-grid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!results.length) { grid.innerHTML = '<div class="gif-loading">Sonuç bulunamadı.</div>'; return; }
  for (const item of results) {
    const url     = item.media_formats?.gif?.url ?? item.media_formats?.tinygif?.url;
    const preview = item.media_formats?.tinygif?.url ?? url;
    if (!url) continue;
    const img = document.createElement('img');
    img.className = 'gif-item';
    img.src = preview!;
    img.loading = 'lazy';
    img.title = item.title ?? 'GIF';
    img.onclick = () => sendGif(url);
    grid.appendChild(img);
  }
}

export function sendGif(url: string): void {
  const picker = document.getElementById('emoji-picker');
  if (picker) picker.style.display = 'none';
  const inp = document.getElementById('msg-input') as HTMLInputElement | null;
  if (inp) inp.value = url;
  sendMessage();
}

export function onGifSearch(val: string): void {
  if (gifSearchTimer) clearTimeout(gifSearchTimer);
  gifSearchTimer = setTimeout(() => void searchGifs(val), 400);
}

// ── Dışarı tıklanınca kapat ───────────────────────────────────

document.addEventListener('click', (e: MouseEvent) => {
  if (!(e.target as HTMLElement).closest('#emoji-picker') && !(e.target as HTMLElement).closest('.msg-input-btn')) {
    const p = document.getElementById('emoji-picker');
    if (p) p.style.display = 'none';
  }
});

// Lazy import to avoid circular dep
declare const BridgeRegistry: { call(name: string, ...args: unknown[]): unknown } | undefined;
