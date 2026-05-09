// core/utils.ts
// Genel yardımcı fonksiyonlar: güvenlik, DOM, bildirim

// ── HTML güvenliği ────────────────────────────────────────────────────────────
function escHtml(s: unknown): string {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssColor(value: unknown): string {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  return '#808080';
}

function safeFileUrl(url: unknown): string {
  if (typeof url !== 'string') return '';
  if (url.startsWith('/uploads/') || url.startsWith('data:image/')) return url;
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin === window.location.origin) return url;
  } catch { /* fall */ }
  return '';
}

// ── İsim yardımcıları ─────────────────────────────────────────────────────────
function initials(name: string): string {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── Toast bildirimi ───────────────────────────────────────────────────────────
// Fix #4 (v56): duration parametresi eklendi – uzun uyarılar için kullanılır
// type: 'success' | 'error' | 'info' | 'warning'
function toast(msg: string, type = '', duration = 3000): void {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c?.appendChild(el);
  const fadeAt = Math.max(duration - 500, duration * 0.8);
  setTimeout(() => el.classList.add('fade-out'), fadeAt);
  setTimeout(() => el.remove(), duration);
}

// ── Modal yardımcıları ────────────────────────────────────────────────────────
function closeModal(id: string): void {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function closeModalOutside(e: MouseEvent, id: string): void {
  if ((e.target as HTMLElement)?.id === id) closeModal(id);
}
