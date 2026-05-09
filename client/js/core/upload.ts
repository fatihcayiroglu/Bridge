// core/upload.js (split from app.js)

// Sunucuyla senkron â€” server/routes/upload.js ALLOWED_TYPES ile eÅŸleÅŸmeli
const _ALLOWED_MIME_TYPES = new Set([
  'image/jpeg','image/png','image/gif','image/webp','image/svg+xml','image/tiff','image/bmp',
  'application/pdf','text/plain','text/markdown','text/csv',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/zip','application/x-rar-compressed','application/x-7z-compressed',
  'application/x-tar','application/gzip',
  'application/json','text/xml','application/xml',
  'audio/mpeg','audio/ogg','audio/wav','audio/flac','audio/aac','audio/webm','audio/mp4',
  'video/mp4','video/webm','video/ogg','video/quicktime','video/x-msvideo',
  'text/html','text/css','text/javascript','application/javascript',
]);

async function openFilePicker() {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = [..._ALLOWED_MIME_TYPES].join(',');
  inp.onchange = async (e) => {
    const file = e.target.files[0];
    if (!file) return;

    // â”€â”€ Client-side MIME kontrolÃ¼ â€” sunucuya gÃ¶ndermeden Ã¶nce erken reddet â”€â”€
    if (file.type && !_ALLOWED_MIME_TYPES.has(file.type)) {
      return toast(`Bu dosya tÃ¼rÃ¼ desteklenmiyor: ${file.type}`, 'error');
    }

    // â”€â”€ Boyut kontrolÃ¼ â€” paste yoluyla gelen bÃ¼yÃ¼k dosyalar dahil â”€â”€
    const maxBytes = (clientConfig.maxFileSizeMB || 2048) * 1024 * 1024;
    if (file.size > maxBytes) return toast(`Dosya Ã§ok bÃ¼yÃ¼k (max ${clientConfig.maxFileSizeMB}MB)`, 'error');
    if (!currentChannel || currentChannel.type !== 'text') return;

    if (file.size <= 50 * 1024 * 1024) {
      await uploadSmall(file);
    } else {
      await uploadChunked(file);
    }
  };
  inp.click();
}

async function uploadSmall(file) {
  const formData = new FormData(); formData.append('file', file);
  const progressEl = showUploadProgress(file.name, 0);
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API}/api/upload`);
    xhr.setRequestHeader('Authorization', `Bearer ${token}`);

    // GerÃ§ek upload progress
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) updateUploadProgress(progressEl, Math.round((e.loaded / e.total) * 100));
    };

    xhr.onload = () => {
      hideUploadProgress(progressEl);
      try {
        const data = JSON.parse(xhr.responseText);
        if (xhr.status < 200 || xhr.status >= 300) { toast(data.error || 'Upload failed', 'error'); }
        else { socket.emit('file:send', { channelId: currentChannel._id, serverId: currentServer._id, fileName: data.fileName, fileUrl: data.url, fileType: data.fileType }); }
      } catch { toast('Upload failed', 'error'); }
      resolve();
    };
    xhr.onerror = () => { hideUploadProgress(progressEl); toast('Upload failed', 'error'); resolve(); };
    xhr.send(formData);
  });
}

async function uploadChunked(file) {
  const CHUNK_MB = clientConfig.chunkSizeMB || 5;
  const CHUNK_SIZE = CHUNK_MB * 1024 * 1024;
  const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
  const uploadId = crypto.randomUUID ? crypto.randomUUID() : `uid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const progressEl = showUploadProgress(file.name, 0);

  try {
    for (let i = 0; i < totalChunks; i++) {
      const chunk = file.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      const r = await fetch(`${API}/api/upload/chunk`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'x-upload-id': uploadId,
          'x-chunk-index': String(i),
          'x-total-chunks': String(totalChunks),
          'x-file-name': encodeURIComponent(file.name),
          'x-file-type': file.type || 'application/octet-stream',
        },
        body: chunk,
      });
      const data = await r.json();
      if (!r.ok) { hideUploadProgress(progressEl); return toast(data.error || 'Chunk upload failed', 'error'); }
      updateUploadProgress(progressEl, Math.round(((i + 1) / totalChunks) * 100));

      if (data.done) {
        hideUploadProgress(progressEl);
        socket.emit('file:send', { channelId: currentChannel._id, serverId: currentServer._id, fileName: data.fileName, fileUrl: data.url, fileType: data.fileType });
      }
    }
  } catch { hideUploadProgress(progressEl); toast('Chunked upload failed', 'error'); }
}

function showUploadProgress(fileName, pct) {
  const el = document.createElement('div'); el.className = 'upload-progress-bar';
  el.innerHTML = `<div class="upload-progress-info"><span class="upload-filename">ğŸ“¤ ${escHtml(fileName.slice(0,40))}</span><span class="upload-pct">${pct}%</span></div><div class="upload-progress-track"><div class="upload-progress-fill" style="width:${pct}%"></div></div>`;
  document.getElementById('msg-input-wrap')?.prepend(el);
  return el;
}

function updateUploadProgress(el, pct) { if (!el) return; el.querySelector('.upload-pct').textContent = `${pct}%`; el.querySelector('.upload-progress-fill').style.width = `${pct}%`; }
function hideUploadProgress(el) { el?.remove(); }

// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// MEMBERS
// â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
// loadMembers implementation is in core/members.js

// â”€â”€ PASTE dosya/gÃ¶rsel yÃ¼kleme â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Pano'dan yapÄ±ÅŸtÄ±rÄ±lan gÃ¶rsel veya dosyayÄ± yakala â€” metin deÄŸil.
async function handleMsgPaste(event) {
  const items = event.clipboardData?.items;
  if (!items) return;

  for (const item of items) {
    if (item.kind !== 'file') continue;
    const file = item.getAsFile();
    if (!file) continue;

    // MIME kontrolÃ¼
    if (file.type && !_ALLOWED_MIME_TYPES.has(file.type)) {
      toast(`Bu dosya tÃ¼rÃ¼ desteklenmiyor: ${file.type}`, 'error');
      event.preventDefault();
      return;
    }

    // Boyut kontrolÃ¼
    const maxBytes = (clientConfig.maxFileSizeMB || 2048) * 1024 * 1024;
    if (file.size > maxBytes) {
      toast(`YapÄ±ÅŸtÄ±rÄ±lan dosya Ã§ok bÃ¼yÃ¼k (max ${clientConfig.maxFileSizeMB}MB)`, 'error');
      event.preventDefault();
      return;
    }

    if (!currentChannel || currentChannel.type !== 'text') return;
    event.preventDefault(); // textarea'ya ham yapÄ±ÅŸtÄ±rmayÄ± engelle

    if (file.size <= 50 * 1024 * 1024) {
      await uploadSmall(file);
    } else {
      await uploadChunked(file);
    }
    return; // ilk dosyayÄ± iÅŸle, durakla
  }
}

