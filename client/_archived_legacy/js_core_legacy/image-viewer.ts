// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/ImageViewerPanel.svelte
//              client/js/core/image-viewer-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// core/image-viewer.ts
// Resim görüntüleyici + dosya arşivi

import { getCurrentChannel } from './globals.js';
import { escHtml } from './utils.js';

// ── Helpers ───────────────────────────────────────────────────────────────────

 as Record<string, string>)[c]!
  );
}

// ── Image viewer ──────────────────────────────────────────────────────────────

function _ensureImageViewerOverlay(): HTMLElement {
  let overlay = document.getElementById('img-viewer-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id        = 'img-viewer-overlay';
    overlay.className = 'img-viewer-overlay';
    overlay.innerHTML = `
      <div class="img-viewer-box">
        <button class="img-viewer-close" onclick="(window).closeImageViewer()">✕</button>
        <img id="img-viewer-img" alt="Görsel">
      </div>`;
    overlay.addEventListener('click', (e: MouseEvent) => {
      if (e.target === overlay) closeImageViewer();
    });
    document.body.appendChild(overlay);
  }
  return overlay;
}

export function openImageViewer(msgId: string): void {
  const msg = document.getElementById(`msg-${msgId}`);
  const img = msg?.querySelector<HTMLImageElement>('.msg-image');
  if (!img) return;
  const overlay = _ensureImageViewerOverlay();
  (document.getElementById('img-viewer-img') as HTMLImageElement).src = img.src;
  overlay.style.display = 'flex';
}

export function openImageFromArchive(url: string): void {
  const overlay = _ensureImageViewerOverlay();
  (document.getElementById('img-viewer-img') as HTMLImageElement).src = url;
  overlay.style.display = 'flex';
}

export function closeImageViewer(): void {
  const overlay = document.getElementById('img-viewer-overlay');
  if (overlay) overlay.style.display = 'none';
}

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') closeImageViewer();
});

// ── File archive ──────────────────────────────────────────────────────────────

interface ArchiveFile {
  _id: string;
  fileName: string;
  fileUrl: string;
  fileType?: string;
  displayName?: string;
  createdAt: number;
}

export function openFileArchive(): void {
  const modal = document.getElementById('file-archive-modal') as HTMLElement | null;
  if (!modal) return;
  modal.style.display = 'flex';

  const channel = getCurrentChannel() as { _id: string } | null;
  const nameEl  = document.getElementById('archive-channel-name');
  if (nameEl && channel) nameEl.textContent = `#${channel.name}`;
  loadFileArchive();
}

export async function loadFileArchive(): Promise<void> {
  const grid    = document.getElementById('file-archive-grid');
  const channel = getCurrentChannel() as { _id: string } | null;
  if (!grid || !channel) return;

  grid.innerHTML = '<div class="archive-loading">Yükleniyor...</div>';
  const API = getAPI();

  try {
    const r     = await apiFetch(`${API}/api/channels/${channel!._id}/files?limit=50`);
    const files: ArchiveFile[] = await r.json();

    if (!files.length) {
      grid.innerHTML = '<div class="archive-loading">Bu kanalda henüz dosya paylaşılmamış.</div>';
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
               onclick="(window).openImageFromArchive('${API}${f.fileUrl}')"
               alt="${escHtml(f.fileName)}"
               loading="lazy">
          <div class="archive-card-info">
            <span class="archive-card-name">${escHtml(f.fileName)}</span>
            <span class="archive-card-meta">${escHtml(f.displayName ?? '')} • ${d}</span>
          </div>`;
      } else {
        card.innerHTML = `
          <div class="archive-icon">${isVideo ? '🎬' : '📎'}</div>
          <div class="archive-card-info">
            <a href="${API}${f.fileUrl}"
               download="${escHtml(f.fileName)}"
               class="archive-card-name">${escHtml(f.fileName)}</a>
            <span class="archive-card-meta">${escHtml(f.displayName ?? '')} • ${d}</span>
          </div>`;
      }
      grid.appendChild(card);
    }
  } catch {
    grid.innerHTML = '<div class="archive-loading">Yükleme başarısız.</div>';
  }
}

// ── Scroll to message ─────────────────────────────────────────────────────────

export function scrollToMsg(msgId: string): void {
  const el = document.getElementById(`msg-${msgId}`);
  if (!el) return;
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-highlight');
  setTimeout(() => el.classList.remove('msg-highlight'), 1500);
}
