// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/SoundboardUiPanel.svelte
//              client/js/core/soundboard-ui-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/soundboard-ui.ts  (Sprint 91)
// Soundboard — Discord benzeri ses efekti paneli
// Sesli kanaldayken toolbar'dan açılır, özel ses yükleme, kategori sistemi,
// volume, cool-down, sunucu bazlı paylaşım.

import { apiFetch }                             from './api-fetch.js';
import { getAPI, getCurrentServer }             from './globals.js';
import { escHtml, toast }                       from './utils.js';
import { BridgeRegistry }                       from './bridge-registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Sound {
  _id:         string;
  name:        string;
  emoji?:      string;
  fileUrl:     string;
  volume:      number;   // 0-100
  durationMs?: number;
  category?:   string;
  serverId?:   string;   // null = built-in
  uploadedBy?: string;
  useCount?:   number;
  isBuiltin?:  boolean;
}

// ── Built-in sounds (no server required) ─────────────────────────────────────

const BUILTIN_SOUNDS: Omit<Sound, '_id' | 'fileUrl'>[] = [
  { name: 'Zil',         emoji: '🔔', volume: 80,  durationMs: 1200, category: 'Bildirim', isBuiltin: true },
  { name: 'Alkış',       emoji: '👏', volume: 80,  durationMs: 2000, category: 'Eğlence',  isBuiltin: true },
  { name: 'Islık',       emoji: '😮', volume: 70,  durationMs: 1500, category: 'Eğlence',  isBuiltin: true },
  { name: 'Bravo',       emoji: '🎉', volume: 75,  durationMs: 1800, category: 'Eğlence',  isBuiltin: true },
  { name: 'Boo',         emoji: '👻', volume: 65,  durationMs: 1000, category: 'Eğlence',  isBuiltin: true },
  { name: 'Haha',        emoji: '😂', volume: 80,  durationMs: 1600, category: 'Eğlence',  isBuiltin: true },
  { name: 'Ah ha!',      emoji: '💡', volume: 70,  durationMs: 900,  category: 'Tepki',    isBuiltin: true },
  { name: 'Doğru',       emoji: '✅', volume: 70,  durationMs: 1000, category: 'Tepki',    isBuiltin: true },
  { name: 'Yanlış',      emoji: '❌', volume: 70,  durationMs: 1000, category: 'Tepki',    isBuiltin: true },
  { name: 'Soru',        emoji: '❓', volume: 65,  durationMs: 800,  category: 'Tepki',    isBuiltin: true },
  { name: 'Giriş',       emoji: '🚀', volume: 75,  durationMs: 2500, category: 'Müzik',    isBuiltin: true },
  { name: 'Fon Müziği',  emoji: '🎵', volume: 50,  durationMs: 5000, category: 'Müzik',    isBuiltin: true },
];

// ── State ─────────────────────────────────────────────────────────────────────

let _serverSounds: Sound[]       = [];
let _playingId:    string | null = null;
let _cooldowns:    Map<string, number> = new Map();
let _globalVolume: number        = 100;
let _filterCat:    string        = '';
let _query:        string        = '';
const COOLDOWN_MS = 2000;

// ── Open soundboard panel ─────────────────────────────────────────────────────

export async function openSoundboardPanel(): Promise<void> {
  document.getElementById('soundboard-panel')?.remove();
  const server = getCurrentServer() as { _id?: string } | null;
  const API    = getAPI();

  // Load server sounds
  if (server?._id) {
    try {
      const r = await apiFetch(`${API}/api/servers/${server._id}/soundboard`);
      _serverSounds = r.ok ? await r.json() : [];
    } catch { _serverSounds = []; }
  } else {
    _serverSounds = [];
  }

  // Build all sounds list
  const allSounds: Sound[] = [
    ...BUILTIN_SOUNDS.map((s, i) => ({ ...s, _id: `builtin-${i}`, fileUrl: '' })),
    ..._serverSounds,
  ];

  const categories = ['Tümü', ...new Set(allSounds.map(s => s.category ?? 'Diğer'))];

  const panel = document.createElement('div');
  panel.id = 'soundboard-panel';
  panel.style.cssText = `
    position:fixed; bottom:80px; right:20px;
    width:min(380px,calc(100vw - 32px));
    max-height:520px;
    background:var(--bg-secondary);
    border:1px solid var(--border);
    border-radius:14px;
    box-shadow:0 8px 32px rgba(0,0,0,.4);
    z-index:800;
    display:flex;
    flex-direction:column;
    overflow:hidden;
  `;

  panel.innerHTML = `
    <!-- Header -->
    <div style="padding:14px 16px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px;flex-shrink:0;">
      <span style="font-size:20px;">🎵</span>
      <div style="flex:1;">
        <div style="font-weight:700;font-size:14px;">Soundboard</div>
        <div style="font-size:11px;color:var(--text-3);">${allSounds.length} ses efekti</div>
      </div>
      <div style="display:flex;align-items:center;gap:6px;">
        <button onclick="window._sbOpenUpload()" title="Ses yükle"
          style="background:none;border:none;cursor:pointer;color:var(--text-2);font-size:16px;padding:4px;" aria-label="Ses yükle">➕</button>
        <button onclick="document.getElementById('soundboard-panel').remove()"
          style="background:none;border:none;cursor:pointer;color:var(--text-3);font-size:16px;padding:4px;" aria-label="Kapat">✕</button>
      </div>
    </div>

    <!-- Search & volume -->
    <div style="padding:10px 14px;border-bottom:1px solid var(--border);flex-shrink:0;display:flex;gap:8px;align-items:center;">
      <div style="flex:1;position:relative;">
        <span style="position:absolute;left:8px;top:50%;transform:translateY(-50%);color:var(--text-3);font-size:12px;">🔍</span>
        <input type="text" placeholder="Ses ara..." id="sb-search"
          style="width:100%;padding:7px 8px 7px 26px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:12px;outline:none;box-sizing:border-box;"
          oninput="window._sbSearch(this.value)">
      </div>
      <div style="display:flex;align-items:center;gap:4px;flex-shrink:0;">
        <span style="font-size:12px;">🔊</span>
        <input type="range" id="sb-global-vol" min="0" max="100" value="${_globalVolume}" step="5"
          style="width:60px;accent-color:var(--accent);"
          oninput="window._sbSetGlobalVol(this.value)">
      </div>
    </div>

    <!-- Category tabs -->
    <div id="sb-cats" style="display:flex;gap:4px;padding:8px 14px;overflow-x:auto;flex-shrink:0;scrollbar-width:none;">
      ${categories.map(c => `
        <button onclick="window._sbSetCat('${escHtml(c)}')"
          style="padding:4px 10px;border-radius:14px;border:none;cursor:pointer;white-space:nowrap;font-size:11px;flex-shrink:0;${_filterCat===c||(_filterCat===''&&c==='Tümü')?'background:var(--accent);color:#fff;':'background:var(--bg-1);color:var(--text-2);'}">
          ${escHtml(c)}
        </button>`).join('')}
    </div>

    <!-- Sound grid -->
    <div id="sb-grid" style="flex:1;overflow-y:auto;padding:8px 14px 14px;display:grid;grid-template-columns:repeat(auto-fill,minmax(90px,1fr));gap:8px;">
      ${_renderSoundGrid(allSounds)}
    </div>
  `;

  document.body.appendChild(panel);

  // Close on outside click
  setTimeout(() => {
    document.addEventListener('click', function handler(e) {
      if (!panel.contains(e.target as Node)) { panel.remove(); document.removeEventListener('click', handler); }
    });
  }, 50);
}
BridgeRegistry.register('openSoundboardPanel', openSoundboardPanel);

// ── Render grid ───────────────────────────────────────────────────────────────

function _renderSoundGrid(sounds: Sound[]): string {
  let list = sounds;
  if (_filterCat && _filterCat !== 'Tümü') list = list.filter(s => (s.category ?? 'Diğer') === _filterCat);
  if (_query) list = list.filter(s => s.name.toLowerCase().includes(_query.toLowerCase()));

  if (!list.length) return `<div style="grid-column:1/-1;text-align:center;padding:20px;color:var(--text-3);font-size:13px;">Ses bulunamadı</div>`;

  return list.map(s => {
    const playing   = _playingId === s._id;
    const onCooldown= _cooldowns.has(s._id) && (_cooldowns.get(s._id)! + COOLDOWN_MS) > Date.now();
    const disabled  = onCooldown;

    return `
      <button id="sb-btn-${s._id}"
        onclick="window._sbPlay('${s._id}', '${escHtml(s.fileUrl)}')"
        ${disabled ? 'disabled' : ''}
        style="
          display:flex;flex-direction:column;align-items:center;justify-content:center;
          gap:4px;padding:10px 6px;
          background:${playing ? 'var(--accent)' : 'var(--bg-1)'};
          border:1.5px solid ${playing ? 'var(--accent)' : 'var(--bg-5)'};
          border-radius:10px;cursor:${disabled?'not-allowed':'pointer'};
          opacity:${disabled?'0.5':'1'};
          transition:all .15s;min-height:70px;
          color:${playing?'#fff':'var(--text-1)'};
        "
        onmouseenter="if(!this.disabled)this.style.background='${playing?'var(--accent)':'var(--bg-hover)'}'"
        onmouseleave="if(!this.disabled)this.style.background='${playing?'var(--accent)':'var(--bg-1)'}'">
        <span style="font-size:22px;">${s.emoji ?? '🔊'}</span>
        <span style="font-size:10px;font-weight:600;text-align:center;line-height:1.2;overflow:hidden;text-overflow:ellipsis;width:100%;max-width:80px;">${escHtml(s.name)}</span>
        ${s.isBuiltin ? '' : `<span style="font-size:9px;opacity:.6;">${s.useCount ?? 0}×</span>`}
      </button>`;
  }).join('');
}

// ── Play sound ────────────────────────────────────────────────────────────────

async function _sbPlay(soundId: string, fileUrl: string): Promise<void> {
  const onCooldown = _cooldowns.has(soundId) && (_cooldowns.get(soundId)! + COOLDOWN_MS) > Date.now();
  if (onCooldown) return;

  // Stop current if playing same
  if (_playingId === soundId) {
    _stopCurrent();
    return;
  }

  _stopCurrent();
  _playingId = soundId;
  _cooldowns.set(soundId, Date.now());

  // Visual feedback
  const btn = document.getElementById(`sb-btn-${soundId}`);
  if (btn) { btn.style.background = 'var(--accent)'; btn.style.color = '#fff'; }

  const API = getAPI();

  if (fileUrl) {
    // Emit to voice channel via WebRTC audio injection
    window.dispatchEvent(new CustomEvent('bridge:soundboard:play', {
      detail: { soundId, fileUrl: `${API}${fileUrl}`, volume: _globalVolume / 100 }
    }));

    // Socket: tell other members in channel to show "playing" indicator
    (window as Window & { socket?: { emit: (...a: unknown[]) => void } }).socket?.emit(
      'soundboard:playing', { soundId }
    );
  } else {
    // Built-in: play via AudioContext
    await _playBuiltin(soundId);
  }

  // Reset after cooldown
  setTimeout(() => {
    if (_playingId === soundId) _stopCurrent();
  }, 3000);
}
(window as Window & { _sbPlay?: typeof _sbPlay })._sbPlay = _sbPlay;

async function _playBuiltin(soundId: string): Promise<void> {
  // Generate a tone for built-in sounds (oscillator-based, no file needed)
  try {
    const ctx   = new AudioContext();
    const osc   = ctx.createOscillator();
    const gain  = ctx.createGain();
    const idx   = parseInt(soundId.split('-')[1] ?? '0');
    const freqs = [440, 523, 659, 784, 880, 1047, 294, 349, 392, 440, 262, 330];
    osc.frequency.value = freqs[idx % freqs.length] ?? 440;
    osc.type            = ['sine', 'square', 'triangle', 'sawtooth'][idx % 4] as OscillatorType;
    gain.gain.setValueAtTime(_globalVolume / 100 * 0.3, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.8);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.8);
    setTimeout(() => ctx.close(), 1000);
  } catch { /* AudioContext may not be available */ }
}

function _stopCurrent(): void {
  if (_playingId) {
    const btn = document.getElementById(`sb-btn-${_playingId}`);
    if (btn) { btn.style.background = 'var(--bg-1)'; btn.style.color = 'var(--text-1)'; btn.style.borderColor = 'var(--bg-5)'; }
    window.dispatchEvent(new CustomEvent('bridge:soundboard:stop'));
  }
  _playingId = null;
}

// ── Global volume ────────────────────────────────────────────────────────────

(window as Window & { _sbSetGlobalVol?: (v: string) => void })._sbSetGlobalVol = (v) => {
  _globalVolume = parseInt(v);
  window.dispatchEvent(new CustomEvent('bridge:soundboard:volume', { detail: { volume: _globalVolume / 100 } }));
};

// ── Filter handlers ───────────────────────────────────────────────────────────

(window as Window & { _sbSetCat?: (c: string) => void })._sbSetCat = (c) => {
  _filterCat = c === 'Tümü' ? '' : c;
  const all = [...BUILTIN_SOUNDS.map((s, i) => ({ ...s, _id: `builtin-${i}`, fileUrl: '' })), ..._serverSounds];
  const grid = document.getElementById('sb-grid');
  if (grid) grid.innerHTML = _renderSoundGrid(all);
  // Update cat button styles
  document.querySelectorAll<HTMLButtonElement>('#sb-cats button').forEach(btn => {
    const cat = btn.textContent?.trim() ?? '';
    const active = (cat === 'Tümü' && _filterCat === '') || cat === _filterCat;
    btn.style.background = active ? 'var(--accent)' : 'var(--bg-1)';
    btn.style.color      = active ? '#fff' : 'var(--text-2)';
  });
};

(window as Window & { _sbSearch?: (q: string) => void })._sbSearch = (q) => {
  _query = q;
  const all = [...BUILTIN_SOUNDS.map((s, i) => ({ ...s, _id: `builtin-${i}`, fileUrl: '' })), ..._serverSounds];
  const grid = document.getElementById('sb-grid');
  if (grid) grid.innerHTML = _renderSoundGrid(all);
};

// ── Upload modal ──────────────────────────────────────────────────────────────

(window as Window & { _sbOpenUpload?: () => void })._sbOpenUpload = () => {
  document.getElementById('sb-upload-modal')?.remove();
  const modal = document.createElement('div');
  modal.id        = 'sb-upload-modal';
  modal.className = 'modal-overlay';
  modal.style.cssText = 'z-index:10000;';

  modal.innerHTML = `
    <div class="modal-card" style="max-width:400px;width:95%;">
      <h3 style="margin:0 0 16px;">🎵 Ses Efekti Yükle</h3>

      <div class="form-group" style="margin-bottom:12px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Ses Dosyası</label>
        <div id="sb-drop-zone" style="margin-top:6px;border:2px dashed var(--bg-5);border-radius:8px;padding:20px;text-align:center;cursor:pointer;transition:border-color .15s;"
          onclick="document.getElementById('sb-file-input').click()"
          ondragover="event.preventDefault();this.style.borderColor='var(--accent)'"
          ondragleave="this.style.borderColor='var(--bg-5)'"
          ondrop="event.preventDefault();this.style.borderColor='var(--bg-5)';window._sbHandleFile(event.dataTransfer.files[0])">
          <div style="font-size:24px;margin-bottom:6px;">🎵</div>
          <div style="font-size:13px;color:var(--text-2);">Tıkla veya sürükle</div>
          <div style="font-size:11px;color:var(--text-3);margin-top:3px;">MP3, OGG, WAV • Max 512 KB • Max 5s</div>
        </div>
        <input type="file" id="sb-file-input" accept="audio/mp3,audio/mpeg,audio/ogg,audio/wav" style="display:none"
          onchange="window._sbHandleFile(this.files[0])">
        <div id="sb-file-preview" style="display:none;margin-top:6px;padding:8px;background:var(--bg-1);border-radius:6px;font-size:12px;"></div>
      </div>

      <div class="form-group" style="margin-bottom:12px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Ses Adı</label>
        <input id="sb-sound-name" type="text" maxlength="32" placeholder="Ses efektinin adı"
          style="width:100%;margin-top:6px;padding:9px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;box-sizing:border-box;">
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:12px;">
        <div class="form-group">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Emoji</label>
          <input id="sb-sound-emoji" type="text" maxlength="2" placeholder="🔊"
            style="width:100%;margin-top:6px;padding:9px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:20px;outline:none;box-sizing:border-box;text-align:center;">
        </div>
        <div class="form-group">
          <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Ses (%)</label>
          <input id="sb-sound-volume" type="number" min="10" max="100" value="80"
            style="width:100%;margin-top:6px;padding:9px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;box-sizing:border-box;">
        </div>
      </div>

      <div class="form-group" style="margin-bottom:16px;">
        <label style="font-size:12px;font-weight:600;color:var(--text-2);text-transform:uppercase;">Kategori</label>
        <select id="sb-sound-category" style="width:100%;margin-top:6px;padding:9px;background:var(--bg-1);border:1.5px solid var(--bg-5);border-radius:8px;color:var(--text-1);font-size:13px;outline:none;">
          <option value="Eğlence">🎉 Eğlence</option>
          <option value="Tepki">💬 Tepki</option>
          <option value="Müzik">🎵 Müzik</option>
          <option value="Bildirim">🔔 Bildirim</option>
          <option value="Diğer">📦 Diğer</option>
        </select>
      </div>

      <div class="modal-footer" style="display:flex;gap:10px;justify-content:flex-end;">
        <button class="btn btn-secondary" onclick="document.getElementById('sb-upload-modal').remove()">İptal</button>
        <button class="btn btn-primary" id="sb-upload-btn" onclick="window._sbSaveSound()">⬆️ Yükle</button>
      </div>
    </div>`;

  document.body.appendChild(modal);
  modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
};

let _pendingSoundFile: File | null = null;

(window as Window & { _sbHandleFile?: (f: File) => void })._sbHandleFile = (file) => {
  if (!file) return;
  if (file.size > 512 * 1024) { toast('Max 512 KB olabilir', 'error'); return; }
  _pendingSoundFile = file;
  // Auto-fill name
  const nameInput = document.getElementById('sb-sound-name') as HTMLInputElement | null;
  if (nameInput && !nameInput.value) nameInput.value = file.name.replace(/\.[^.]+$/, '').slice(0, 32);
  const preview = document.getElementById('sb-file-preview');
  if (preview) {
    preview.style.display = 'block';
    preview.innerHTML = `✅ <strong>${escHtml(file.name)}</strong> — ${(file.size/1024).toFixed(1)} KB`;
  }
};

(window as Window & { _sbSaveSound?: () => Promise<void> })._sbSaveSound = async () => {
  const server = getCurrentServer() as { _id?: string } | null;
  if (!server?._id) { toast('Sunucu seçilmedi', 'error'); return; }
  if (!_pendingSoundFile) { toast('Ses dosyası seçilmedi', 'error'); return; }
  const name = (document.getElementById('sb-sound-name') as HTMLInputElement)?.value?.trim();
  if (!name) { toast('Ses adı gerekli', 'error'); return; }
  const emoji    = (document.getElementById('sb-sound-emoji')    as HTMLInputElement)?.value?.trim() || '🔊';
  const volume   = parseInt((document.getElementById('sb-sound-volume') as HTMLInputElement)?.value ?? '80');
  const category = (document.getElementById('sb-sound-category') as HTMLSelectElement)?.value ?? 'Diğer';
  const API = getAPI();
  const btn = document.getElementById('sb-upload-btn') as HTMLButtonElement | null;
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Yükleniyor...'; }
  try {
    const fd = new FormData();
    fd.append('file', _pendingSoundFile);
    fd.append('name', name);
    fd.append('emoji', emoji);
    fd.append('volume', String(volume));
    fd.append('category', category);
    const r = await apiFetch(`${API}/api/servers/${server._id}/soundboard`, { method: 'POST', body: fd });
    if (!r.ok) { const d = await r.json(); toast(d.error ?? 'Yüklenemedi', 'error'); return; }
    const saved: Sound = await r.json();
    _serverSounds.push(saved);
    toast('🎵 Ses efekti yüklendi!', 'success');
    document.getElementById('sb-upload-modal')?.remove();
    _pendingSoundFile = null;
    // Re-open panel to show new sound
    openSoundboardPanel();
  } catch { toast('Bağlantı hatası', 'error'); }
  finally { if (btn) { btn.disabled = false; btn.textContent = '⬆️ Yükle'; } }
};

// ── Toolbar button injector ───────────────────────────────────────────────────

export function injectSoundboardToolbarBtn(): void {
  if (document.getElementById('sb-toolbar-btn')) return;

  const toolbar = document.querySelector<HTMLElement>('#voice-toolbar, .voice-controls, #vc-controls');
  if (!toolbar) return;

  const btn = document.createElement('button');
  btn.id            = 'sb-toolbar-btn';
  btn.className     = 'icon-btn';
  btn.title         = 'Soundboard';
  btn.setAttribute('aria-label', 'Soundboard aç');
  btn.textContent   = '🎵';
  btn.style.cssText = 'font-size:18px;padding:6px 8px;';
  btn.addEventListener('click', openSoundboardPanel);
  toolbar.appendChild(btn);
}
BridgeRegistry.register('injectSoundboardToolbarBtn', injectSoundboardToolbarBtn);
