export {};
// client/js/core/image-viewer.js
// Resim gÃ¶rÃ¼ntÃ¼leyici + dosya arÅŸivi
// misc.js'den ayrÄ±ÅŸtÄ±rÄ±ldÄ±

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// IMAGE VIEWER
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function _ensureImageViewerOverlay() {
  let overlay = document.getElementById('img-viewer-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id        = 'img-viewer-overlay';
    overlay.className = 'img-viewer-overlay';
    overlay.innerHTML = `
      <div class="img-viewer-box">
        <button class="img-viewer-close" onclick="closeImageViewer()">âœ•</button>
        <img id="img-viewer-img" alt="GÃ¶rsel">
      </div>`;
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeImageViewer();
    });
    document.body.appendChild(overlay);
  }
  return overlay;
}

function openImageViewer(msgId) {
  const msg = document.getElementById(`msg-${msgId}`);
  const img = msg?.querySelector('.msg-image');
  if (!img) return;
  const overlay = _ensureImageViewerOverlay();
  document.getElementById('img-viewer-img').src = img.src;
  overlay.style.display = 'flex';
}

function openImageFromArchive(url) {
  const overlay = _ensureImageViewerOverlay();
  document.getElementById('img-viewer-img').src = url;
  overlay.style.display = 'flex';
}

function closeImageViewer() {
  const overlay = document.getElementById('img-viewer-overlay');
  if (overlay) overlay.style.display = 'none';
}

// Klavye ile kapat
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeImageViewer();
});

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// DOSYA ARÅÄ°VÄ°
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function openFileArchive() {
  const modal = document.getElementById('file-archive-modal');
  if (!modal) return;
  modal.style.display = 'flex';
  const nameEl = document.getElementById('archive-channel-name');
  if (nameEl && window.currentChannel) {
    nameEl.textContent = `#${currentChannel.name}`;
  }
  loadFileArchive();
}

async function loadFileArchive() {
  const grid = document.getElementById('file-archive-grid');
  if (!grid || !window.currentChannel) return;

  grid.innerHTML = '<div class="archive-loading">YÃ¼kleniyor...</div>';

  try {
    const r     = await apiFetch(`${API}/api/channels/${currentChannel._id}/files?limit=50`);
    const files = await r.json();

    if (!files.length) {
      grid.innerHTML = '<div class="archive-loading">Bu kanalda henÃ¼z dosya paylaÅŸÄ±lmamÄ±ÅŸ.</div>';
      return;
    }

    grid.innerHTML = '';

    for (const f of files) {
      const isImage = f.fileType?.startsWith('image/');
      const isVideo = f.fileType?.startsWith('video/');
      const d       = new Date(f.createdAt).toLocaleDateString('tr-TR');
      const card    = document.createElement('div');
      card.className = 'archive-card';

      if (isImage) {
        card.innerHTML = `
          <img src="${API}${f.fileUrl}"
               class="archive-thumb"
               onclick="openImageFromArchive('${API}${f.fileUrl}')"
               alt="${escHtml(f.fileName)}"
               loading="lazy">
          <div class="archive-card-info">
            <span class="archive-card-name">${escHtml(f.fileName)}</span>
            <span class="archive-card-meta">${escHtml(f.displayName)} â€¢ ${d}</span>
          </div>`;
      } else {
        card.innerHTML = `
          <div class="archive-icon">${isVideo ? 'ğŸ¬' : 'ğŸ“'}</div>
          <div class="archive-card-info">
            <a href="${API}${f.fileUrl}"
               download="${escHtml(f.fileName)}"
               class="archive-card-name">${escHtml(f.fileName)}</a>
            <span class="archive-card-meta">${escHtml(f.displayName)} â€¢ ${d}</span>
          </div>`;
      }
      grid.appendChild(card);
    }
  } catch {
    grid.innerHTML = '<div class="archive-loading">YÃ¼kleme baÅŸarÄ±sÄ±z.</div>';
  }
}

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MESAJA KAYDIR
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•

function scrollToMsg(msgId) {
  const el = document.getElementById(`msg-${msgId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1500);
}

