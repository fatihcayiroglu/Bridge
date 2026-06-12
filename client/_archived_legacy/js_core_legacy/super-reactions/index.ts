// ⚠️  LEGACY — Sprint 116'da arşivlendi
// Bu dosya artık aktif kullanımdan kaldırıldı.
//
// Yerine geçen: client/js/core/IndexPanel.svelte
//              client/js/core/index-svelte.ts (mount shim)
//
// BridgeRegistry kayıtları shim dosyasında korunuyor.
// Silinme planı: Sprint 118
//
// client/js/core/super-reactions/index.ts
// Sprint 82: Super Reactions — Discord'un "burst reaction" muadili
// Emoji'ye uzun basınca veya özel butonla tetiklenir; parçacık animasyonu gösterir.

import { getSocket } from '../globals.js';
import { BridgeRegistry } from '../bridge-registry.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SuperReaction {
  messageId:  string;
  channelId:  string;
  emoji:      string;
  userId:     string;
  count:      number;
  burstColor: string;
}

// ── Burst color presets (Discord'a benzer) ────────────────────────────────────

const BURST_COLORS: Record<string, string[]> = {
  '❤️':  ['#FF0000', '#FF6B6B', '#FF1493'],
  '🔥':  ['#FF4500', '#FF8C00', '#FFD700'],
  '⭐':  ['#FFD700', '#FFA500', '#FFEC8B'],
  '💯':  ['#00C851', '#00FF7F', '#ADFF2F'],
  '🎉':  ['#9B59B6', '#3498DB', '#E74C3C'],
  '👍':  ['#3498DB', '#1ABC9C', '#2ECC71'],
  '😂':  ['#FFD700', '#FFA500', '#FF6347'],
  '😍':  ['#FF69B4', '#FF1493', '#C71585'],
  '🚀':  ['#4169E1', '#6A5ACD', '#9400D3'],
  '💎':  ['#00CED1', '#1E90FF', '#7B68EE'],
};

const DEFAULT_BURST_COLORS = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7'];

function getBurstColors(emoji: string): string[] {
  return BURST_COLORS[emoji] ?? DEFAULT_BURST_COLORS;
}

// ── Particle Animation ────────────────────────────────────────────────────────

interface Particle {
  x: number; y: number;
  vx: number; vy: number;
  alpha: number;
  color: string;
  size: number;
  emoji: string;
}

function _animateBurst(originEl: Element, emoji: string): void {
  const rect = originEl.getBoundingClientRect();
  const originX = rect.left + rect.width / 2;
  const originY = rect.top + rect.height / 2;

  const canvas = document.createElement('canvas');
  canvas.style.cssText = `
    position: fixed;
    top: 0; left: 0;
    width: 100vw; height: 100vh;
    pointer-events: none;
    z-index: 99999;
  `;
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
  document.body.appendChild(canvas);

  const ctx = canvas.getContext('2d');
  if (!ctx) { canvas.remove(); return; }

  const colors = getBurstColors(emoji);
  const PARTICLE_COUNT = 24;

  const particles: Particle[] = Array.from({ length: PARTICLE_COUNT }, () => {
    const angle  = Math.random() * Math.PI * 2;
    const speed  = 3 + Math.random() * 6;
    return {
      x:     originX,
      y:     originY,
      vx:    Math.cos(angle) * speed,
      vy:    Math.sin(angle) * speed - 2,   // biraz yukarı eğim
      alpha: 1,
      color: colors[Math.floor(Math.random() * colors.length)]!,
      size:  6 + Math.random() * 8,
      emoji,
    };
  });

  let animId: number;

  function draw() {
    ctx!.clearRect(0, 0, canvas.width, canvas.height);

    let alive = false;
    for (const p of particles) {
      if (p.alpha <= 0) continue;
      alive = true;

      p.x  += p.vx;
      p.y  += p.vy;
      p.vy += 0.18; // yerçekimi
      p.vx *= 0.98; // hava direnci
      p.alpha -= 0.025;

      ctx!.save();
      ctx!.globalAlpha = Math.max(0, p.alpha);

      // Renkli daire
      ctx!.fillStyle = p.color;
      ctx!.beginPath();
      ctx!.arc(p.x, p.y, p.size / 2, 0, Math.PI * 2);
      ctx!.fill();

      // Üstüne emoji
      ctx!.font = `${p.size}px serif`;
      ctx!.textAlign = 'center';
      ctx!.textBaseline = 'middle';
      ctx!.fillText(p.emoji, p.x, p.y);

      ctx!.restore();
    }

    if (alive) {
      animId = requestAnimationFrame(draw);
    } else {
      canvas.remove();
    }
  }

  animId = requestAnimationFrame(draw);

  // Güvenlik: 3 saniye sonra her durumda temizle
  setTimeout(() => {
    cancelAnimationFrame(animId);
    canvas.remove();
  }, 3000);
}

// ── Super Reaction Gönderme ───────────────────────────────────────────────────

export async function sendSuperReaction(
  messageId: string,
  channelId:  string,
  emoji:      string,
  originEl?:  Element,
): Promise<void> {
  const socket = getSocket();
  if (!socket) throw new Error('Socket bağlı değil');

  socket.emit('super_reaction:add', { messageId, channelId, emoji });

  // Animasyonu hemen başlat (optimistic)
  if (originEl) {
    _animateBurst(originEl, emoji);
  }
}

// ── Uzun Basma Dinleyicisi ────────────────────────────────────────────────────

const LONG_PRESS_MS = 600;

export function attachLongPressToReaction(
  reactionEl: Element,
  messageId:  string,
  channelId:  string,
  emoji:      string,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let fired = false;

  function onDown(e: Event) {
    fired = false;
    timer = setTimeout(() => {
      fired = true;
      sendSuperReaction(messageId, channelId, emoji, reactionEl);
      _showSuperReactionTooltip(reactionEl);
    }, LONG_PRESS_MS);
  }

  function onUp() {
    if (timer) { clearTimeout(timer); timer = null; }
  }

  reactionEl.addEventListener('mousedown', onDown);
  reactionEl.addEventListener('touchstart', onDown, { passive: true });
  reactionEl.addEventListener('mouseup', onUp);
  reactionEl.addEventListener('mouseleave', onUp);
  reactionEl.addEventListener('touchend', onUp);

  // Cleanup fonksiyonu döndür
  return () => {
    reactionEl.removeEventListener('mousedown', onDown);
    reactionEl.removeEventListener('touchstart', onDown);
    reactionEl.removeEventListener('mouseup', onUp);
    reactionEl.removeEventListener('mouseleave', onUp);
    reactionEl.removeEventListener('touchend', onUp);
    if (timer) clearTimeout(timer);
  };
}

function _showSuperReactionTooltip(el: Element): void {
  const existing = document.getElementById('super-react-tooltip');
  if (existing) return;

  const tip = document.createElement('div');
  tip.id = 'super-react-tooltip';
  tip.textContent = '✨ Süper Reaksiyon!';
  tip.style.cssText = `
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    background: var(--brand, #2d9cdb);
    color: #fff;
    padding: 8px 16px;
    border-radius: 20px;
    font-size: 14px;
    font-weight: 600;
    pointer-events: none;
    z-index: 99998;
    animation: superReactPop 0.3s ease;
  `;
  document.body.appendChild(tip);
  setTimeout(() => tip.remove(), 1200);
}

// ── Socket Event Dinleyicileri ────────────────────────────────────────────────

export function bindSuperReactionEvents(): void {
  const socket = getSocket();
  if (!socket) return;

  socket.on('super_reaction:received', (data: SuperReaction) => {
    // İlgili mesajın reaksiyon butonunu bul ve animasyon tetikle
    const msgEl = document.querySelector(`[data-message-id="${data.messageId}"]`);
    if (!msgEl) return;

    const reactionEl = msgEl.querySelector(`[data-emoji="${data.emoji}"]`);
    if (reactionEl) {
      _animateBurst(reactionEl, data.emoji);
    } else {
      // Mesajın ortasından tetikle
      _animateBurst(msgEl, data.emoji);
    }

    // Sayacı güncelle
    _updateSuperReactionBadge(msgEl, data.emoji, data.count);
  });
}

function _updateSuperReactionBadge(msgEl: Element, emoji: string, count: number): void {
  const badge = msgEl.querySelector<HTMLElement>(`.super-reaction-badge[data-emoji="${emoji}"]`);
  if (badge) {
    badge.textContent = `${emoji} ✨ ${count}`;
  } else {
    const newBadge = document.createElement('span');
    newBadge.className = 'super-reaction-badge';
    newBadge.dataset['emoji'] = emoji;
    newBadge.textContent = `${emoji} ✨ ${count}`;
    newBadge.style.cssText = `
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 2px 8px;
      border-radius: 12px;
      background: var(--brand-alpha, rgba(45,156,219,0.15));
      border: 1px solid var(--brand, #2d9cdb);
      font-size: 12px;
      margin-left: 4px;
    `;
    msgEl.querySelector('.reactions') ?.appendChild(newBadge);
  }
}

// ── CSS Injection ─────────────────────────────────────────────────────────────

export function injectSuperReactionStyles(): void {
  if (document.getElementById('super-reaction-styles')) return;
  const style = document.createElement('style');
  style.id = 'super-reaction-styles';
  style.textContent = `
    @keyframes superReactPop {
      0%   { transform: translate(-50%, -50%) scale(0.5); opacity: 0; }
      60%  { transform: translate(-50%, -50%) scale(1.15); opacity: 1; }
      100% { transform: translate(-50%, -50%) scale(1); opacity: 1; }
    }
    .reaction-btn { user-select: none; }
    .reaction-btn:active { transform: scale(0.9); }
    .super-reaction-badge {
      animation: superReactPop 0.3s ease;
    }
  `;
  document.head.appendChild(style);
}

// ── Init ──────────────────────────────────────────────────────────────────────

export function initSuperReactions(): void {
  injectSuperReactionStyles();
  bindSuperReactionEvents();

  BridgeRegistry.register('sendSuperReaction', sendSuperReaction);
  BridgeRegistry.register('attachLongPressToReaction', attachLongPressToReaction);
}
