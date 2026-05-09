// core/theme.js
// Tema yönetimi: tüm temalar tek yerden yönetilir.
// Aurora, Sunset, Forest eklendi; // window.THEMES expose edildi;
//      theme-opt butonları setTheme'den otomatik aktif/pasif güncellenir.

// Temel 4 tema tokens.css'te, Sunset+Forest v43/themes.js'te tanımlı.
// Aurora tokens.css'te zaten var.
window.THEMES = ['dark', 'light', 'amoled', 'midnight', 'aurora', 'sunset', 'forest'];

window.THEME_ICONS = {
  dark:     '🌙',
  light:    '☀️',
  amoled:   '🌑',
  midnight: '🌌',
  aurora:   '🌌',   // geçici — aşağıda SVG ile override edilir
  sunset:   '🌅',
  forest:   '🌲',
};

window.THEME_LABELS = {
  dark:     'Koyu',
  light:    'Açık',
  amoled:   'AMOLED',
  midnight: 'Gece Yarısı',
  aurora:   'Aurora',
  sunset:   'Günbatımı',
  forest:   'Orman',
};

// Aurora için özel emoji (unicode aurora borealis yok, kandil simgesi güzel durur)
window.THEME_ICONS.aurora = '🌠';

function setTheme(theme) {
  document.body.setAttribute('data-theme', theme);
  document.body.classList.toggle('theme-light', theme === 'light');
  localStorage.setItem('bridge_theme', theme);

  // Toolbar hızlı geçiş butonu
  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.textContent = window.THEME_ICONS[theme] || '🌙';
    btn.title = window.THEME_LABELS[theme] || theme;
  }

  // Ayarlar UI — tüm .theme-opt butonlarını senkronize et
  document.querySelectorAll('.theme-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.t === theme);
  });
}

function toggleTheme() {
  const current = document.body.getAttribute('data-theme') || 'dark';
  const idx = window.THEMES.indexOf(current);
  const next = window.THEMES[(idx + 1) % window.THEMES.length];
  setTheme(next);
}

async function loadTheme() {
  const saved = localStorage.getItem('bridge_theme') || 'dark';
  setTheme(saved);
  const hue = localStorage.getItem('bridge_brand_hue');
  const sat = localStorage.getItem('bridge_brand_sat');
  if (hue) document.body.style.setProperty('--brand-h', hue);
  if (sat) document.body.style.setProperty('--brand-s', sat);
  // Sohbet arka planını geri yükle — async (IDB okuyabilir)
  await loadChatBackground();
}

function setBrandColor(hue, saturation) {
  const h = Math.max(0, Math.min(360, parseInt(hue)));
  const s = Math.max(30, Math.min(100, parseInt(saturation)));
  document.body.style.setProperty('--brand-h', h);
  document.body.style.setProperty('--brand-s', s + '%');
  localStorage.setItem('bridge_brand_hue', h);
  localStorage.setItem('bridge_brand_sat', s + '%');
}

// ══════════════════════════════════════════════════
// SOHBET ARKA PLANI
// ══════════════════════════════════════════════════

window.CHAT_BG_PRESETS = [
  { id: 'none',     label: 'Varsayılan', value: null },
  { id: 'waves',    label: 'Dalgalar',   value: 'linear-gradient(135deg,#1a1a2e 0%,#16213e 40%,#0f3460 100%)' },
  { id: 'sunset',   label: 'Günbatımı',  value: 'linear-gradient(160deg,#2d1b69 0%,#c0392b 50%,#e67e22 100%)' },
  { id: 'forest',   label: 'Orman',      value: 'linear-gradient(160deg,#0a2e1a 0%,#1a4a2e 50%,#2e7d32 100%)' },
  { id: 'aurora',   label: 'Aurora',     value: 'linear-gradient(135deg,#0d1b2a 0%,#1b4332 35%,#5e60ce 70%,#48cae4 100%)' },
  { id: 'midnight', label: 'Gece',       value: 'linear-gradient(160deg,#0d0d1a 0%,#1a1a3e 60%,#2d2d5e 100%)' },
  { id: 'rose',     label: 'Gül',        value: 'linear-gradient(135deg,#1a0a0a 0%,#3d1a1a 50%,#5c2a2a 100%)' },
];

// ── IndexedDB yardımcıları — büyük resim/GIF için localStorage yerine IDB ──
const _IDB_NAME    = 'bridge-bg-store';
const _IDB_VERSION = 1;
const _IDB_STORE   = 'bg';

function _openBgDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = e => e.target.result.createObjectStore(_IDB_STORE);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = () => reject(req.error);
  });
}

async function _saveBgToIDB(key, value) {
  try {
    const db  = await _openBgDB();
    const tx  = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).put(value, key);
    return new Promise((res, rej) => { tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); });
  } catch { return false; }
}

async function _loadBgFromIDB(key) {
  try {
    const db  = await _openBgDB();
    const tx  = db.transaction(_IDB_STORE, 'readonly');
    const req = tx.objectStore(_IDB_STORE).get(key);
    return new Promise((res, rej) => { req.onsuccess = () => res(req.result ?? null); req.onerror = () => rej(req.error); });
  } catch { return null; }
}

async function _deleteBgFromIDB(key) {
  try {
    const db = await _openBgDB();
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).delete(key);
  } catch { /* sessizce geç */ }
}

// ── Arka plan uygulama (CSS) — storage'a dokunmaz ─────────────
function _applyBgCSS(value, presetId) {
  const area = document.getElementById('messages-area');
  if (!area) return;
  if (!value) {
    area.style.backgroundImage = area.style.backgroundColor = area.style.backgroundSize = area.style.backgroundPosition = '';
    area.classList.remove('chat-bg-active');
  } else {
    if (value.startsWith('url(') || value.startsWith('linear-gradient') || value.startsWith('radial-gradient')) {
      area.style.backgroundImage = value;
      area.style.backgroundColor = '';
    } else {
      area.style.backgroundImage = '';
      area.style.backgroundColor = value;
    }
    area.style.backgroundSize       = 'cover';
    area.style.backgroundPosition   = 'center';
    area.style.backgroundAttachment = 'local';
    area.classList.add('chat-bg-active');
  }
  document.querySelectorAll('.chat-bg-opt').forEach(b => {
    b.classList.toggle('active', b.dataset.bg === (presetId || 'none'));
  });
}

// ── Public API ────────────────────────────────────────────────
// Gradient / düz renk → localStorage (küçük, hızlı)
// Dosya (url(data:…)) → IndexedDB (büyük, QuotaExceeded yok)
function setChatBackground(value, presetId) {
  _applyBgCSS(value, presetId);
  if (!value) {
    localStorage.removeItem('bridge_chat_bg');
    localStorage.removeItem('bridge_chat_bg_preset');
    _deleteBgFromIDB('custom_file');
  } else if (value.startsWith('url(data:')) {
    // Büyük base64 → IDB'ye yaz, localStorage'a sadece sentinel
    _saveBgToIDB('custom_file', value);
    localStorage.setItem('bridge_chat_bg', '__idb__');
    localStorage.setItem('bridge_chat_bg_preset', presetId || 'custom');
  } else {
    localStorage.setItem('bridge_chat_bg', value);
    localStorage.setItem('bridge_chat_bg_preset', presetId || 'custom');
  }
}

function loadChatBgFromFile(input) {
  const file = input.files && input.files[0];
  if (!file) return;

  // MIME kontrolü — accept attribute tarayıcıda atlatılabilir
  const ALLOWED_MIME = ['image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/avif'];
  if (!ALLOWED_MIME.includes(file.type)) {
    if (typeof toast === 'function') toast('Desteklenmeyen dosya türü. JPEG, PNG, GIF, WebP veya AVIF yükleyin.', 'error');
    input.value = '';
    return;
  }

  if (file.size > 15 * 1024 * 1024) {
    if (typeof toast === 'function') toast('Dosya max 15 MB olabilir', 'error');
    input.value = '';
    return;
  }
  // ObjectURL kullan — base64 encode yükü yok, GIF animasyonu korunur
  const objUrl = URL.createObjectURL(file);
  setChatBackground('url(' + objUrl + ')', 'custom');
  // IDB'ye de kaydet (kalıcılık için blob olarak sakla)
  _saveBgToIDB('custom_file', objUrl);
  // localStorage sentinel
  localStorage.setItem('bridge_chat_bg', '__idb__');
  localStorage.setItem('bridge_chat_bg_preset', 'custom');
  if (typeof toast === 'function') toast('Arka plan güncellendi ✓', 'success');
  // input'u sıfırla — aynı dosyayı tekrar seçebilsin
  input.value = '';
}

function applyChatBgColor(hex) {
  if (hex) setChatBackground(hex, 'custom');
}

async function loadChatBackground() {
  const saved  = localStorage.getItem('bridge_chat_bg');
  const preset = localStorage.getItem('bridge_chat_bg_preset') || 'custom';
  if (!saved) return;
  if (saved === '__idb__') {
    // Büyük dosya IDB'de
    const val = await _loadBgFromIDB('custom_file');
    if (val) _applyBgCSS('url(' + val + ')', preset);
  } else {
    _applyBgCSS(saved, preset);
  }
}

export {
  setTheme,
  toggleTheme,
  loadTheme,
  setBrandColor,
  setChatBackground,
  loadChatBgFromFile,
  applyChatBgColor,
  loadChatBackground,
};

// THEMES / THEME_ICONS / THEME_LABELS / CHAT_BG_PRESETS zaten
// window.* üzerine atanmış (dosyanın üstünde). Shim gerekmez.
// Fonksiyonlar için shim:
