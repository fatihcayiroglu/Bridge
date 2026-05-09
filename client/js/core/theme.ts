// core/theme.ts
// Tema yönetimi: tüm temalar tek yerden yönetilir.

type ThemeId = 'dark' | 'light' | 'amoled' | 'midnight' | 'aurora' | 'sunset' | 'forest';

interface ChatBgPreset {
  id: string;
  label: string;
  value: string | null;
}

// THEMES/THEME_ICONS/THEME_LABELS/CHAT_BG_PRESETS window tanımları globals.d.ts'de mevcut.
// Burada tekrar declare global yapılmaz — TS2717/TS2687 çakışmasını önler.

window.THEMES = ['dark', 'light', 'amoled', 'midnight', 'aurora', 'sunset', 'forest'];

window.THEME_ICONS = {
  dark:     '🌙',
  light:    '☀️',
  amoled:   '🌑',
  midnight: '🌌',
  aurora:   '🌌',
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

window.THEME_ICONS.aurora = '🌠';

function setTheme(theme: ThemeId): void {
  document.body.setAttribute('data-theme', theme);
  document.body.classList.toggle('theme-light', theme === 'light');
  localStorage.setItem('bridge_theme', theme);

  const btn = document.getElementById('btn-theme');
  if (btn) {
    btn.textContent = window.THEME_ICONS[theme] || '🌙';
    btn.title = window.THEME_LABELS[theme] || theme;
  }

  document.querySelectorAll<HTMLElement>('.theme-opt').forEach(b => {
    b.classList.toggle('active', b.dataset['t'] === theme);
  });
}

function toggleTheme(): void {
  const current = (document.body.getAttribute('data-theme') || 'dark') as ThemeId;
  const idx = window.THEMES.indexOf(current);
  const next = window.THEMES[(idx + 1) % window.THEMES.length];
  setTheme(next);
}

async function loadTheme(): Promise<void> {
  const saved = (localStorage.getItem('bridge_theme') || 'dark') as ThemeId;
  setTheme(saved);
  const hue = localStorage.getItem('bridge_brand_hue');
  const sat = localStorage.getItem('bridge_brand_sat');
  if (hue) document.body.style.setProperty('--brand-h', hue);
  if (sat) document.body.style.setProperty('--brand-s', sat);
  await loadChatBackground();
}

function setBrandColor(hue: number | string, saturation: number | string): void {
  const h = Math.max(0, Math.min(360, parseInt(String(hue))));
  const s = Math.max(30, Math.min(100, parseInt(String(saturation))));
  document.body.style.setProperty('--brand-h', String(h));
  document.body.style.setProperty('--brand-s', s + '%');
  localStorage.setItem('bridge_brand_hue', String(h));
  localStorage.setItem('bridge_brand_sat', s + '%');
}

// ── SOHBET ARKA PLANI ────────────────────────────────────────────────────────

window.CHAT_BG_PRESETS = [
  { id: 'none',     label: 'Varsayılan', value: null },
  { id: 'waves',    label: 'Dalgalar',   value: 'linear-gradient(135deg,#1a1a2e 0%,#16213e 40%,#0f3460 100%)' },
  { id: 'sunset',   label: 'Günbatımı',  value: 'linear-gradient(160deg,#2d1b69 0%,#c0392b 50%,#e67e22 100%)' },
  { id: 'forest',   label: 'Orman',      value: 'linear-gradient(160deg,#0a2e1a 0%,#1a4a2e 50%,#2e7d32 100%)' },
  { id: 'aurora',   label: 'Aurora',     value: 'linear-gradient(135deg,#0d1b2a 0%,#1b4332 35%,#5e60ce 70%,#48cae4 100%)' },
  { id: 'midnight', label: 'Gece',       value: 'linear-gradient(160deg,#0d0d1a 0%,#1a1a3e 60%,#2d2d5e 100%)' },
  { id: 'rose',     label: 'Gül',        value: 'linear-gradient(135deg,#1a0a0a 0%,#3d1a1a 50%,#5c2a2a 100%)' },
];

// ── IndexedDB yardımcıları ────────────────────────────────────────────────────
const _IDB_NAME    = 'bridge-bg-store';
const _IDB_VERSION = 1;
const _IDB_STORE   = 'bg';

function _openBgDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_IDB_NAME, _IDB_VERSION);
    req.onupgradeneeded = (e: IDBVersionChangeEvent) => {
      (e.target as IDBOpenDBRequest).result.createObjectStore(_IDB_STORE);
    };
    req.onsuccess = (e: Event) => resolve((e.target as IDBOpenDBRequest).result);
    req.onerror   = () => reject(req.error);
  });
}

async function _saveBgToIDB(key: string, value: string): Promise<boolean> {
  try {
    const db  = await _openBgDB();
    const tx  = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).put(value, key);
    return new Promise((res, rej) => { tx.oncomplete = () => res(true); tx.onerror = () => rej(tx.error); });
  } catch { return false; }
}

async function _loadBgFromIDB(key: string): Promise<string | null> {
  try {
    const db  = await _openBgDB();
    const tx  = db.transaction(_IDB_STORE, 'readonly');
    const req = tx.objectStore(_IDB_STORE).get(key);
    return new Promise((res, rej) => {
      req.onsuccess = () => res((req.result as string | undefined) ?? null);
      req.onerror   = () => rej(req.error);
    });
  } catch { return null; }
}

async function _deleteBgFromIDB(key: string): Promise<void> {
  try {
    const db = await _openBgDB();
    const tx = db.transaction(_IDB_STORE, 'readwrite');
    tx.objectStore(_IDB_STORE).delete(key);
  } catch { /* sessizce geç */ }
}

function _applyBgCSS(value: string | null, presetId: string): void {
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
  document.querySelectorAll<HTMLElement>('.chat-bg-opt').forEach(b => {
    b.classList.toggle('active', b.dataset['bg'] === (presetId || 'none'));
  });
}

function setChatBackground(value: string | null, presetId: string): void {
  _applyBgCSS(value, presetId);
  if (!value) {
    localStorage.removeItem('bridge_chat_bg');
    localStorage.removeItem('bridge_chat_bg_preset');
    void _deleteBgFromIDB('custom_file');
  } else if (value.startsWith('url(data:')) {
    void _saveBgToIDB('custom_file', value);
    localStorage.setItem('bridge_chat_bg', '__idb__');
    localStorage.setItem('bridge_chat_bg_preset', presetId || 'custom');
  } else {
    localStorage.setItem('bridge_chat_bg', value);
    localStorage.setItem('bridge_chat_bg_preset', presetId || 'custom');
  }
}

function loadChatBgFromFile(input: HTMLInputElement): void {
  const file = input.files && input.files[0];
  if (!file) return;

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
  const objUrl = URL.createObjectURL(file);
  setChatBackground('url(' + objUrl + ')', 'custom');
  void _saveBgToIDB('custom_file', objUrl);
  localStorage.setItem('bridge_chat_bg', '__idb__');
  localStorage.setItem('bridge_chat_bg_preset', 'custom');
  if (typeof toast === 'function') toast('Arka plan güncellendi ✓', 'success');
  input.value = '';
}

function applyChatBgColor(hex: string): void {
  if (hex) setChatBackground(hex, 'custom');
}

async function loadChatBackground(): Promise<void> {
  const saved  = localStorage.getItem('bridge_chat_bg');
  const preset = localStorage.getItem('bridge_chat_bg_preset') || 'custom';
  if (!saved) return;
  if (saved === '__idb__') {
    const val = await _loadBgFromIDB('custom_file');
    if (val) _applyBgCSS('url(' + val + ')', preset);
  } else {
    _applyBgCSS(saved, preset);
  }
}

export { setTheme, toggleTheme, loadTheme, setBrandColor, setChatBackground, loadChatBgFromFile, applyChatBgColor, loadChatBackground };
