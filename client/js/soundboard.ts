import { BridgeRegistry } from './core/bridge-registry.ts';
// client/js/soundboard.ts Soundboard
// Bridge'de tamamen bedava

let _soundboardServerId = null;
let _soundboardSounds   = [];
let _soundboardAudio    = null; // current playing

// ── OPEN SOUNDBOARD PANEL ────────────────────────────────────
async function openSoundboard() {
  if (!currentServer) return toast('Önce bir sunucu seç', 'error');
  _soundboardServerId = currentServer._id;

  const existing = document.getElementById('soundboard-panel');
  if (existing) { existing.remove(); return; } // toggle

  const panel = document.createElement('div');
  panel.id = 'soundboard-panel';
  panel.className = 'soundboard-panel';
  panel.innerHTML = `
    <div class="soundboard-header">
      <span>ğŸµ Soundboard</span>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-secondary" style="font-size:12px;padding:4px 10px;" onclick="openSoundUpload()">+ Ses Ekle</button>
        <button class="icon-btn" onclick="document.getElementById('soundboard-panel').remove()" title="Kapat">✕</button>
      </div>
    </div>
    <div id="soundboard-grid" class="soundboard-grid">
      <div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;">Yükleniyor...</div>
    </div>`;
  document.querySelector('.chat-area') ?.appendChild(panel) || document.body.appendChild(panel);

  await refreshSoundboard();
}

async function refreshSoundboard() {
  const grid = document.getElementById('soundboard-grid');
  if (!grid || !_soundboardServerId) return;

  try {
    const r = await apiFetch(`${API}/api/servers/${_soundboardServerId}/soundboard`);
    _soundboardSounds = r.ok ? await r.json() : [];

    if (!_soundboardSounds.length) {
      grid.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;grid-column:1/-1;">
        Henüz ses yok.<br>Admin olarak ses ekleyebilirsin.</div>`;
      return;
    }

    grid.innerHTML = _soundboardSounds.map(s => `
      <button class="sound-btn" onclick="playSound('${s._id}')" title="${escHtml(s.name)}">
        <span class="sound-emoji">${escHtml(s.emoji || 'ğŸ”Š')}</span>
        <span class="sound-name">${escHtml(s.name)}</span>
      </button>`).join('');
  } catch(e) {
    grid.innerHTML = `<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:20px;grid-column:1/-1;">Yüklenemedi</div>`;
  }
}

function playSound(soundId) {
  const sound = _soundboardSounds.find(s => s._id === soundId);
  if (!sound) return;

  // Stop currently playing
  if (_soundboardAudio) {
    _soundboardAudio.pause();
    _soundboardAudio = null;
    document.querySelectorAll('.sound-btn.playing').forEach(b => b.classList.remove('playing'));
  }

  const btn = document.querySelector(`.sound-btn[onclick="playSound('${soundId}')"]`);

  _soundboardAudio = new Audio(API + sound.url);
  _soundboardAudio.volume = 0.8;
  _soundboardAudio.play().then(() => {
    btn?.classList.add('playing');
    // Broadcast to voice channel peers
    if ((BridgeRegistry.get('rtc') as { isInVoice(): boolean } | null)?.isInVoice()) {
      socket.emit('soundboard:play', {
        channelId: rtc.currentChannelId,
        soundUrl:  API + sound.url,
        soundName: sound.name,
        emoji:     sound.emoji,
      });
    }
  }).catch(() => toast('Ses oynatılamadı', 'error'));

  _soundboardAudio.onended = () => {
    btn?.classList.remove('playing');
    _soundboardAudio = null;
  };
}

function stopSoundboard() {
  if (_soundboardAudio) {
    _soundboardAudio.pause();
    _soundboardAudio = null;
    document.querySelectorAll('.sound-btn.playing').forEach(b => b.classList.remove('playing'));
  }
}

// ── UPLOAD SOUND ─────────────────────────────────────────────
function openSoundUpload() {
  const existing = document.getElementById('sound-upload-modal');
  if (existing) existing.remove();

  const modal = document.createElement('div');
  modal.id = 'sound-upload-modal';
  modal.className = 'modal-overlay';
  modal.innerHTML = `
    <div class="modal-card" style="max-width:400px;width:95%;">
      <h2 style="margin-bottom:16px;">ğŸµ Ses Ekle</h2>

      <label class="settings-label">Ses Dosyası <span style="color:var(--text-muted);font-size:12px;">(MP3, OGG, WAV — max 5MB)</span></label>
      <input type="file" id="sound-file-input" accept="audio/*" class="input"
             style="width:100%;margin-bottom:12px;padding:8px;" onchange="previewSoundFile(this)" />

      <label class="settings-label">İsim</label>
      <input id="sound-name-input" class="input" placeholder="Sesin adı" maxlength="32"
             style="width:100%;margin-bottom:12px;" />

      <label class="settings-label">Emoji</label>
      <input id="sound-emoji-input" class="input" placeholder="ğŸ”Š" maxlength="8"
             style="width:80px;margin-bottom:16px;font-size:20px;text-align:center;" value="ğŸ”Š" />

      <div id="sound-preview" style="display:none;margin-bottom:16px;">
        <audio id="sound-preview-player" controls style="width:100%;"></audio>
      </div>

      <div class="modal-footer">
        <button class="btn btn-secondary" onclick="document.getElementById('sound-upload-modal').remove()">İptal</button>
        <button class="btn" onclick="uploadSound()">ğŸµ Yükle</button>
      </div>
    </div>`;
  modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
  document.body.appendChild(modal);
}

function previewSoundFile(input) {
  const file = input.files[0];
  if (!file) return;
  // Auto-fill name from filename
  const nameInput = document.getElementById('sound-name-input');
  if (nameInput && !nameInput.value) {
    nameInput.value = file.name.replace(/\.[^/.]+$/, '').slice(0, 32);
  }
  const preview = document.getElementById('sound-preview');
  const player  = document.getElementById('sound-preview-player');
  if (preview && player) {
    player.src = URL.createObjectURL(file);
    preview.style.display = 'block';
  }
}

async function uploadSound() {
  const fileInput = document.getElementById('sound-file-input');
  const file = fileInput?.files[0];
  if (!file) return toast('Dosya seç', 'error');

  const name  = document.getElementById('sound-name-input')?.value.trim();
  const emoji = document.getElementById('sound-emoji-input')?.value.trim() || 'ğŸ”Š';

  if (!name) return toast('İsim gerekli', 'error');

  const formData = new FormData();
  formData.append('sound', file);
  formData.append('name',  name);
  formData.append('emoji', emoji);

  try {
    const r = await apiFetch(`${API}/api/servers/${_soundboardServerId}/soundboard`, {
      method: 'POST',
      body:   formData,
    });
    if (!r.ok) { const e = await r.json(); return toast(e.error || 'Yüklenemedi', 'error'); }
    document.getElementById('sound-upload-modal')?.remove();
    toast('Ses eklendi! ğŸµ', 'success');
    await refreshSoundboard();
  } catch(e) {
    toast('Yüklenemedi', 'error');
  }
}

// ── SOCKET: remote soundboard play ───────────────────────────
function initSoundboardSocket(socket) {
  socket.on('soundboard:play', ({ channelId, soundUrl, soundName, emoji }) => {
    // Only play if we're in the same voice channel
    if (!(BridgeRegistry.get('rtc') as { isInVoice(): boolean } | null)?.isInVoice() || rtc.currentChannelId !== channelId) return;
    toast(`${emoji || 'ğŸ”Š'} ${soundName}`, 'info');
    // Play via remote audio (low volume so it mixes)
    const audio = new Audio(soundUrl);
    audio.volume = 0.5;
    audio.play().catch(() => {});
  });
}

