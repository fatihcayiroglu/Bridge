// core/utils.js
// Genel yardımcı fonksiyonlar: güvenlik, DOM, bildirim

// ── HTML güvenliği ────────────────────────────────────────────
function escHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function cssColor(value) {
  if (typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value)) return value;
  return '#808080';
}

function safeFileUrl(url) {
  if (typeof url !== 'string') return '';
  if (url.startsWith('/uploads/') || url.startsWith('data:image/')) return url;
  try {
    const u = new URL(url, window.location.origin);
    if (u.origin === window.location.origin) return url;
  } catch { /* fall */ }
  return '';
}

// ── İsim yardımcıları ─────────────────────────────────────────
function initials(name) {
  if (!name) return '?';
  const parts = name.trim().split(' ');
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// ── Toast bildirimi ───────────────────────────────────────────
// Fix #4 (v56): duration parametresi eklendi — uzun uyarılar için kullanılır
// type: 'success' | 'error' | 'info' | 'warning'
function toast(msg, type = '', duration = 3000) {
  const c = document.getElementById('toast-container');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  c.appendChild(el);
  const fadeAt = Math.max(duration - 500, duration * 0.8);
  setTimeout(() => el.classList.add('fade-out'), fadeAt);
  setTimeout(() => el.remove(), duration);
}

// ── Modal yardımcıları ────────────────────────────────────────
function closeModal(id) {
  const el = document.getElementById(id);
  if (el) el.style.display = 'none';
}

function closeModalOutside(e, id) {
  if (e.target.id === id) closeModal(id);
}

export {
  escHtml,
  cssColor,
  safeFileUrl,
  initials,
  toast,
  closeModal,
  closeModalOutside,
};

// window üzerinden global erişim — geriye dönük uyumluluk
