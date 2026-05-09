// client/js/core/music-player.js
// Kanal mÃ¼zik oynatÄ±cÄ±sÄ±
// misc.js'den ayrÄ±ÅŸtÄ±rÄ±ldÄ±

let musicAudio = null;

function initMusicPlayer() {
  if (!window.socket) return;

  socket.on('music:play', ({ channelId, track }) => {
    if (!window.currentChannel || currentChannel._id !== channelId) return;
    showMusicPlayer(track, channelId);
  });

  socket.on('music:stop', ({ channelId }) => {
    if (!window.currentChannel || currentChannel._id !== channelId) return;
    hideMusicPlayer();
  });
}

function showMusicPlayer(track, channelId) {
  let bar = document.getElementById('music-bar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id        = 'music-bar';
    bar.className = 'music-bar';
    document.getElementById('text-view')?.prepend(bar);
  }

  // Ã–nceki ses durdur
  if (musicAudio) {
    musicAudio.pause();
    musicAudio = null;
  }

  musicAudio = new Audio(track.streamUrl);
  musicAudio.crossOrigin = 'anonymous';
  musicAudio.volume      = 0.5;

  musicAudio.play().catch(err => {
    console.warn('[music] autoplay engellendi:', err.message);
    if (typeof toast === 'function') {
      toast('ğŸµ MÃ¼ziÄŸi baÅŸlatmak iÃ§in play\'e tÄ±klayÄ±n (tarayÄ±cÄ± engelledi)', 'info');
    }
  });

  musicAudio.addEventListener('ended', () => {
    socket.emit('music:ended', { channelId });
  });

  const thumb = track.thumbnail
    ? `<img class="music-thumb" src="${escHtml(track.thumbnail)}" onerror="this.style.display='none'" alt="">`
    : 'ğŸµ';

  bar.innerHTML = `
    <div class="music-info">
      ${thumb}
      <div>
        <div class="music-title">${escHtml(track.title)}</div>
        <div class="music-sub">Ä°steyen: ${escHtml(track.requestedBy || '')}</div>
      </div>
    </div>
    <div class="music-controls">
      <button class="music-btn" id="music-playpause" title="Oynat/Duraklat">â¸ï¸</button>
      <input type="range" id="music-vol" min="0" max="1" step="0.05" value="0.5"
             title="Ses seviyesi" aria-label="Ses seviyesi">
      <button class="music-btn" id="music-skip-btn" title="Sonraki">â­ï¸</button>
      <button class="music-btn" id="music-stop-btn" title="Durdur">â¹ï¸</button>
    </div>`;

  document.getElementById('music-vol')?.addEventListener('input', (e) => {
    setMusicVolume(e.target.value);
  });
  document.getElementById('music-playpause')?.addEventListener('click', toggleMusicPause);
  document.getElementById('music-skip-btn')?.addEventListener('click', () => {
    socket.emit('music:ended', { channelId });
  });
  document.getElementById('music-stop-btn')?.addEventListener('click', () => {
    socket.emit('message:send', {
      channelId,
      content:  '!stop',
      serverId: window.currentServer?._id,
    });
  });
}

function hideMusicPlayer() {
  if (musicAudio) {
    musicAudio.pause();
    musicAudio = null;
  }
  document.getElementById('music-bar')?.remove();
}

function toggleMusicPause() {
  if (!musicAudio) return;
  const btn = document.getElementById('music-playpause');
  if (musicAudio.paused) {
    musicAudio.play();
    if (btn) btn.textContent = 'â¸ï¸';
  } else {
    musicAudio.pause();
    if (btn) btn.textContent = 'â–¶ï¸';
  }
}

function setMusicVolume(v) {
  if (musicAudio) musicAudio.volume = parseFloat(v);
}

// â”€â”€ MÃ¼zik KuyruÄŸu Modal â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
async function openMusicQueue() {
  if (!currentServer || !currentChannel) return toast('Ã–nce bir kanala gir', 'error');

  let modal = document.getElementById('music-queue-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'music-queue-modal';
    modal.className = 'modal-overlay';
    modal.onclick = e => { if (e.target === modal) modal.style.display = 'none'; };
    modal.innerHTML = `
      <div class="modal-card" style="max-width:480px;width:95%;">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:16px;">
          <h2 style="margin:0;font-size:17px;">ğŸµ MÃ¼zik KuyruÄŸu</h2>
          <button class="btn" onclick="document.getElementById('music-queue-modal').style.display='none'" style="padding:4px 10px;">âœ•</button>
        </div>
        <div style="display:flex;gap:8px;margin-bottom:16px;">
          <input type="url" id="music-url-input" class="input-field" placeholder="YouTube URL yapÄ±ÅŸtÄ±r..." style="flex:1;">
          <button class="btn btn-primary" onclick="musicAddToQueue()">â–¶ Ekle</button>
        </div>
        <div id="music-queue-list" style="max-height:300px;overflow-y:auto;"></div>
        <div style="margin-top:12px;display:flex;gap:8px;">
          <button class="btn" style="flex:1;" onclick="musicSkip()">â­ Sonraki</button>
          <button class="btn btn-danger" style="flex:1;" onclick="musicStop()">â¹ Durdur</button>
        </div>
        <p style="font-size:11px;color:var(--text-muted);margin-top:8px;">
          ğŸ’¡ Slash komutlarÄ±: <code>/play [url]</code>  <code>/skip</code>  <code>/stop</code>
        </p>
      </div>`;
    document.body.appendChild(modal);
  }
  modal.style.display = 'flex';
  await _refreshMusicQueue();
}

async function _refreshMusicQueue() {
  if (!currentServer || !currentChannel) return;
  const list = document.getElementById('music-queue-list');
  if (!list) return;
  try {
    const r = await apiFetch(`${API}/api/music/queue/${currentServer._id}/${currentChannel._id}`);
    const data = await r.json();
    if (!data.current && !data.queue?.length) {
      list.innerHTML = '<div style="text-align:center;color:var(--text-muted);padding:20px;">ğŸµ Kuyruk boÅŸ</div>';
      return;
    }
    let html = '';
    if (data.current) {
      html += `<div style="background:var(--brand);border-radius:8px;padding:10px;margin-bottom:8px;display:flex;gap:10px;align-items:center;">
        <span style="font-size:20px;">â–¶ï¸</span>
        <div style="flex:1;overflow:hidden;">
          <div style="font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escHtml(data.current.title)}</div>
          <div style="font-size:11px;opacity:0.8;">Åu an Ã§alÄ±yor</div>
        </div>
      </div>`;
    }
    (data.queue || []).forEach((t, i) => {
      html += `<div style="background:var(--bg-3);border-radius:6px;padding:8px 10px;margin-bottom:6px;display:flex;gap:8px;align-items:center;">
        <span style="color:var(--text-muted);font-size:13px;width:20px;text-align:center;">${i+1}</span>
        <div style="flex:1;overflow:hidden;">
          <div style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;">${escHtml(t.title)}</div>
          <div style="font-size:11px;color:var(--text-muted);">Ä°steyen: ${escHtml(t.requestedBy||'')}</div>
        </div>
      </div>`;
    });
    list.innerHTML = html;
  } catch {
    list.innerHTML = '<div style="color:var(--text-muted);padding:12px;">Kuyruk alÄ±namadÄ±</div>';
  }
}

async function musicAddToQueue() {
  const input = document.getElementById('music-url-input');
  const url = input?.value.trim();
  if (!url) return toast('URL gir', 'error');
  if (!currentServer || !currentChannel) return;
  input.value = '';
  socket.emit('message:send', { channelId: currentChannel._id, content: `!play ${url}`, serverId: currentServer._id });
  setTimeout(_refreshMusicQueue, 1500);
}

function musicSkip() {
  if (!currentServer || !currentChannel) return;
  socket.emit('music:ended', { channelId: currentChannel._id });
  setTimeout(_refreshMusicQueue, 500);
}

function musicStop() {
  if (!currentServer || !currentChannel) return;
  socket.emit('message:send', { channelId: currentChannel._id, content: '!stop', serverId: currentServer._id });
  setTimeout(_refreshMusicQueue, 500);
}

