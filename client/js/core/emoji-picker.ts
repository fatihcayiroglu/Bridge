// core/emoji-picker.js
// Emoji + GIF picker sistemi

const EMOJI_CATEGORIES = {
  'ğŸ˜Š YÃ¼zler': ['ğŸ˜€','ğŸ˜ƒ','ğŸ˜„','ğŸ˜','ğŸ˜†','ğŸ˜…','ğŸ¤£','ğŸ˜‚','ğŸ™‚','ğŸ™ƒ','ğŸ˜‰','ğŸ˜Š','ğŸ˜‡','ğŸ¥°','ğŸ˜','ğŸ¤©','ğŸ˜˜','ğŸ˜‹','ğŸ˜›','ğŸ˜','ğŸ˜œ','ğŸ¤ª','ğŸ¤¨','ğŸ§','ğŸ¤“','ğŸ˜','ğŸ˜','ğŸ˜’','ğŸ˜','ğŸ˜”','ğŸ˜Ÿ','ğŸ˜•','ğŸ™','â˜¹ï¸','ğŸ˜£','ğŸ˜–','ğŸ˜«','ğŸ˜©','ğŸ¥º','ğŸ˜¢','ğŸ˜­','ğŸ˜¤','ğŸ˜ ','ğŸ˜¡','ğŸ¤¬','ğŸ¤¯','ğŸ˜³','ğŸ¥µ','ğŸ¥¶','ğŸ˜±','ğŸ˜¨','ğŸ˜°','ğŸ˜¥','ğŸ˜“','ğŸ¤—','ğŸ¤”','ğŸ¤­','ğŸ¤«','ğŸ¤¥','ğŸ˜¶','ğŸ˜','ğŸ˜‘','ğŸ˜¬','ğŸ™„','ğŸ˜¯','ğŸ˜¦','ğŸ˜§','ğŸ˜®','ğŸ˜²','ğŸ¥±','ğŸ˜´','ğŸ˜µ','ğŸ¤','ğŸ¥´','ğŸ¤¢','ğŸ¤®','ğŸ¤§','ğŸ˜·','ğŸ¤’','ğŸ¤•','ğŸ¤‘','ğŸ˜ˆ','ğŸ‘¿','ğŸ’€','â˜ ï¸','ğŸ’©','ğŸ¤¡','ğŸ‘¹','ğŸ‘º','ğŸ‘»','ğŸ‘½','ğŸ‘¾','ğŸ¤–'],
  'ğŸ‘‹ Eller': ['ğŸ‘‹','ğŸ¤š','ğŸ–ï¸','âœ‹','ğŸ––','ğŸ‘Œ','ğŸ¤Œ','ğŸ¤','âœŒï¸','ğŸ¤','ğŸ¤Ÿ','ğŸ¤˜','ğŸ¤™','ğŸ‘ˆ','ğŸ‘‰','ğŸ‘†','ğŸ‘‡','â˜ï¸','ğŸ‘','ğŸ‘','âœŠ','ğŸ‘Š','ğŸ¤›','ğŸ¤œ','ğŸ‘','ğŸ™Œ','ğŸ‘','ğŸ¤²','ğŸ¤','ğŸ™','ğŸ’…','ğŸ’ª'],
  'â¤ï¸ Kalpler': ['â¤ï¸','ğŸ§¡','ğŸ’›','ğŸ’š','ğŸ’™','ğŸ’œ','ğŸ–¤','ğŸ¤','ğŸ¤','ğŸ’”','â£ï¸','ğŸ’•','ğŸ’','ğŸ’“','ğŸ’—','ğŸ’–','ğŸ’˜','ğŸ’','ğŸ’Ÿ'],
  'ğŸ‰ Kutlama': ['ğŸ‰','ğŸŠ','ğŸˆ','ğŸ€','ğŸ','ğŸ†','ğŸ‡','ğŸ§¨','âœ¨','ğŸ¤','ğŸ§','ğŸ¼','ğŸµ','ğŸ¶','ğŸ¹','ğŸ¥','ğŸ·','ğŸº','ğŸ¸','ğŸ»','ğŸ²','ğŸ¯','ğŸ±','ğŸ³','ğŸ°','ğŸ®'],
  'ğŸ”¥ PopÃ¼ler': ['ğŸ”¥','ğŸ’¯','âœ…','âŒ','â­','ğŸŒŸ','ğŸ’«','âš¡','ğŸŒˆ','â˜€ï¸','ğŸŒ™','â„ï¸','ğŸŒŠ','ğŸ€','ğŸŒ¸','ğŸŒº','ğŸŒ»','ğŸŒ¹','ğŸ’','ğŸ¦‹','ğŸ'],
  'ğŸ¶ Hayvanlar': ['ğŸ¶','ğŸ±','ğŸ­','ğŸ¹','ğŸ°','ğŸ¦Š','ğŸ»','ğŸ¼','ğŸ¨','ğŸ¯','ğŸ¦','ğŸ®','ğŸ·','ğŸ¸','ğŸµ','ğŸ™ˆ','ğŸ™‰','ğŸ™Š','ğŸ”','ğŸ§','ğŸ¦','ğŸ¦†','ğŸ¦…','ğŸ¦‰','ğŸ¦‡','ğŸº','ğŸ´','ğŸ¦„','ğŸ¦‹','ğŸ¢','ğŸ','ğŸ¦','ğŸ™','ğŸ³','ğŸ¦ˆ'],
  'ğŸ• Yemek': ['ğŸ•','ğŸ”','ğŸŸ','ğŸŒ­','ğŸŒ®','ğŸŒ¯','ğŸ¥™','ğŸ¥š','ğŸ³','ğŸ¥˜','ğŸ²','ğŸ¥','ğŸ§‡','ğŸ¥“','ğŸ¥©','ğŸ—','ğŸ–','ğŸŒ½','ğŸ¥•','ğŸ','ğŸ¥','ğŸ§€','ğŸ£','ğŸ¤','ğŸ¥Ÿ','ğŸ¦','ğŸ§','ğŸ©','ğŸª','ğŸ‚','ğŸ°','ğŸ§','ğŸ«','ğŸ¬','ğŸ­'],
  'ğŸš€ Nesneler': ['ğŸš€','ğŸ’¡','ğŸ”‘','ğŸ—ï¸','ğŸ”’','ğŸ”“','ğŸ”¨','ğŸ”§','ğŸ”©','âš™ï¸','ğŸ’»','ğŸ–¥ï¸','ğŸ“±','ğŸ“','ğŸ“º','ğŸ“·','ğŸ“¸','ğŸ“¹','ğŸ”¦','ğŸ•¯ï¸','ğŸ’¡','ğŸ”','ğŸ”','ğŸ“¡','ğŸ†','ğŸ¥‡','ğŸ¥ˆ','ğŸ¥‰'],
};

let currentPickerTab = 'emoji';
let gifSearchTimer = null;

function initEmojiPicker() {
  const catBar = document.getElementById('emoji-categories');
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

function renderEmojiGrid(list) {
  const grid = document.getElementById('emoji-grid');
  grid.innerHTML = '';
  for (const e of list) {
    const btn = document.createElement('div');
    btn.className = 'emoji-btn';
    btn.textContent = e;
    btn.onclick = () => insertEmoji(e);
    grid.appendChild(btn);
  }
}

function filterEmojis(query) {
  if (!query.trim()) { initEmojiPicker(); return; }
  const q = query.toLowerCase();
  const all = Object.values(EMOJI_CATEGORIES).flat();
  renderEmojiGrid(all.filter(e => e.includes(q)));
}

function switchPickerTab(tab) {
  currentPickerTab = tab;
  document.getElementById('panel-emoji').style.display = tab === 'emoji' ? '' : 'none';
  document.getElementById('panel-gif').style.display = tab === 'gif' ? '' : 'none';
  document.getElementById('panel-server-gif').style.display = tab === 'server-gif' ? '' : 'none';
  ['tab-emoji', 'tab-gif', 'tab-server-gif'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('active', id === `tab-${tab}`);
  });
  if (tab === 'gif') loadTrendingGifs();
  if (tab === 'server-gif') loadAllServerGifs();
}

function toggleEmojiPicker() {
  const p = document.getElementById('emoji-picker');
  const isHidden = p.style.display === 'none' || p.style.display === '';
  p.style.display = isHidden ? 'block' : 'none';
}

function insertEmoji(e) {
  const inp = document.getElementById('msg-input');
  const pos = inp.selectionStart || inp.value.length;
  inp.value = inp.value.slice(0, pos) + e + inp.value.slice(pos);
  inp.focus();
  document.getElementById('emoji-picker').style.display = 'none';
}

// â”€â”€ GIF (Tenor proxy) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function loadTrendingGifs() {
  document.getElementById('gif-label').textContent = 'ğŸ”¥ Trend GIFler';
  document.getElementById('gif-grid').innerHTML = '<div class="gif-loading">YÃ¼kleniyor...</div>';
  try {
    const r = await apiFetch(`${API}/api/gif/trending`);
    if (!r.ok) throw new Error('unavailable');
    const d = await r.json();
    renderGifs(d.results || []);
  } catch {
    document.getElementById('gif-grid').innerHTML = '<div class="gif-loading">GIF Ã¶zelliÄŸi yapÄ±landÄ±rÄ±lmamÄ±ÅŸ.</div>';
  }
}

async function searchGifs(q) {
  if (!q.trim()) { loadTrendingGifs(); return; }
  document.getElementById('gif-label').textContent = `ğŸ” "${q}" sonuÃ§larÄ±`;
  document.getElementById('gif-grid').innerHTML = '<div class="gif-loading">AranÄ±yor...</div>';
  try {
    const r = await apiFetch(`${API}/api/gif/search?q=${encodeURIComponent(q)}`);
    if (!r.ok) throw new Error('unavailable');
    const d = await r.json();
    renderGifs(d.results || []);
  } catch {
    document.getElementById('gif-grid').innerHTML = '<div class="gif-loading">Arama baÅŸarÄ±sÄ±z.</div>';
  }
}

function renderGifs(results) {
  const grid = document.getElementById('gif-grid');
  grid.innerHTML = '';
  if (!results.length) { grid.innerHTML = '<div class="gif-loading">SonuÃ§ bulunamadÄ±.</div>'; return; }
  for (const item of results) {
    const url = item.media_formats?.gif?.url || item.media_formats?.tinygif?.url;
    const preview = item.media_formats?.tinygif?.url || url;
    if (!url) continue;
    const img = document.createElement('img');
    img.className = 'gif-item';
    img.src = preview;
    img.loading = 'lazy';
    img.title = item.title || 'GIF';
    img.onclick = () => sendGif(url);
    grid.appendChild(img);
  }
}

function sendGif(url) {
  document.getElementById('emoji-picker').style.display = 'none';
  const inp = document.getElementById('msg-input');
  inp.value = url;
  sendMessage();
}

function onGifSearch(val) {
  clearTimeout(gifSearchTimer);
  gifSearchTimer = setTimeout(() => searchGifs(val), 400);
}

// Picker dÄ±ÅŸÄ±na tÄ±klanÄ±nca kapat
document.addEventListener('click', (e) => {
  if (!e.target.closest('#emoji-picker') && !e.target.closest('.msg-input-btn')) {
    const p = document.getElementById('emoji-picker');
    if (p) p.style.display = 'none';
  }
});

