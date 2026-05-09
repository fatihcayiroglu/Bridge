// client/js/core/v42/mobile.js
// Modül: Mobil swipe iyileştirme + bottom nav düzeltmeleri + v42 CSS
'use strict';

(function mobileV42() {
  const PHONE = 480;
  const isMobile = () => window.innerWidth <= PHONE;

  function haptic(ms = 10) {
    try { window.navigator?.vibrate?.(ms); } catch {}
  }

  let _swTouchX = 0, _swTouchY = 0, _swipeDir = null;
  let _swipeOverlay = null;

  function _getSwipeOverlay() {
    if (!_swipeOverlay) {
      _swipeOverlay = document.createElement('div');
      _swipeOverlay.style.cssText = `
        position:fixed;inset:0;z-index:399;pointer-events:none;
        background:rgba(0,0,0,0);transition:background .2s;`;
      document.body.appendChild(_swipeOverlay);
    }
    return _swipeOverlay;
  }

  document.addEventListener('touchstart', e => {
    _swTouchX = e.touches[0].clientX;
    _swTouchY = e.touches[0].clientY;
    _swipeDir = null;
  }, { passive: true });

  document.addEventListener('touchmove', e => {
    if (!isMobile()) return;
    const dx = e.touches[0].clientX - _swTouchX;
    const dy = e.touches[0].clientY - _swTouchY;

    if (!_swipeDir) {
      if (Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
      _swipeDir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
    }
    if (_swipeDir !== 'h') return;

    const overlay = _getSwipeOverlay();

    if (_swTouchX < 20 && dx > 40) {
      const sl = document.querySelector('.server-list');
      if (sl && !sl.classList.contains('open')) {
        sl.classList.add('open');
        overlay.style.pointerEvents = 'auto';
        overlay.style.background = 'rgba(0,0,0,.4)';
        overlay.onclick = () => {
          sl.classList.remove('open');
          overlay.style.pointerEvents = 'none';
          overlay.style.background = 'rgba(0,0,0,0)';
          overlay.onclick = null;
        };
        haptic();
      }
    }

    if (_swTouchX >= 20 && _swTouchX < 60 && dx > 50) {
      const ch = document.querySelector('.channel-sidebar');
      if (ch && !ch.classList.contains('open')) {
        ch.classList.add('open');
        overlay.style.pointerEvents = 'auto';
        overlay.style.background = 'rgba(0,0,0,.4)';
        overlay.onclick = () => {
          ch.classList.remove('open');
          overlay.style.pointerEvents = 'none';
          overlay.style.background = 'rgba(0,0,0,0)';
          overlay.onclick = null;
        };
        haptic();
      }
    }

    if (dx < -50) {
      document.querySelector('.server-list')?.classList.remove('open');
      document.querySelector('.channel-sidebar')?.classList.remove('open');
      document.querySelector('.member-list')?.classList.remove('open');
      overlay.style.pointerEvents = 'none';
      overlay.style.background = 'rgba(0,0,0,0)';
      overlay.onclick = null;
      haptic(5);
    }
  }, { passive: true });

  function updateNavBadge(count) {
    const chatBtn = document.getElementById('mnav-chat');
    if (!chatBtn) return;
    let badge = chatBtn.querySelector('.nav-badge');
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'nav-badge';
      badge.style.cssText = `
        position:absolute;top:4px;right:12px;background:#ed4245;color:#fff;
        font-size:9px;font-weight:700;border-radius:99px;padding:1px 5px;
        min-width:16px;text-align:center;line-height:14px;`;
      chatBtn.style.position = 'relative';
      chatBtn.appendChild(badge);
    }
    badge.textContent = count > 99 ? '99+' : count;
    badge.style.display = count > 0 ? 'block' : 'none';
  }

  const _navUnreadObserver = new MutationObserver(() => {
    const unreadEls = document.querySelectorAll('.ch-unread:not([style*="display: none"])');
    updateNavBadge(unreadEls.length);
  });
  document.addEventListener('DOMContentLoaded', () => {
    const sidebar = document.querySelector('.channel-sidebar');
    if (sidebar) _navUnreadObserver.observe(sidebar, { subtree: true, attributes: true, attributeFilter: ['style'] });
  });

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      btn.addEventListener('touchend', e => { e.preventDefault(); btn.click(); }, { passive: false });
    });
  });

  const msgInput = document.getElementById('msg-input');
  if (msgInput) {
    msgInput.addEventListener('focus', () => {
      if (isMobile()) {
        setTimeout(() => msgInput.scrollIntoView({ behavior: 'smooth', block: 'end' }), 300);
      }
    });
  }
})();

// ── v42 CSS ──────────────────────────────────────────────────────────────────
(function injectV42CSS() {
  const style = document.createElement('style');
  style.textContent = `
    .forum-sort-btn {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 6px;
      padding: 5px 10px;
      font-size: 12px;
      cursor: pointer;
      transition: .15s;
    }
    .forum-sort-btn:hover, .forum-sort-btn.active {
      background: var(--brand);
      color: #fff;
      border-color: var(--brand);
    }
    .forum-tag-btn {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 12px;
      padding: 4px 10px;
      font-size: 11px;
      cursor: pointer;
      transition: .15s;
    }
    .forum-tag-btn:hover, .forum-tag-btn.active {
      background: var(--brand);
      color: #fff;
      border-color: transparent;
    }
    .forum-tag-chip {
      background: var(--bg-secondary);
      border: 1px solid var(--border);
      color: var(--text-muted);
      border-radius: 10px;
      padding: 2px 8px;
      font-size: 11px;
      cursor: pointer;
      transition: .12s;
    }
    .forum-tag-chip:hover { background: var(--brand); color: #fff; }
    .forum-card-pinned { border-left: 3px solid var(--brand) !important; }
    .forum-card-locked { opacity: .75; }
    .forum-mod-actions {
      display: flex;
      gap: 4px;
      opacity: 0;
      transition: opacity .15s;
    }
    .forum-card:hover .forum-mod-actions { opacity: 1; }
    .forum-mod-btn {
      background: none;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 4px 6px;
      font-size: 14px;
      cursor: pointer;
      transition: .12s;
    }
    .forum-mod-btn:hover { background: var(--bg-secondary); }

    #stage-hand-panel { animation: fadeInUp2 .2s ease; }
    @keyframes fadeInUp2 {
      from { opacity: 0; transform: translateY(12px); }
      to   { opacity: 1; transform: translateY(0); }
    }

    .cal-grid-header, .cal-grid {
      display: grid;
      grid-template-columns: repeat(7, 1fr);
      gap: 2px;
      text-align: center;
    }
    .cal-grid-header > div {
      font-size: 10px;
      font-weight: 700;
      color: var(--text-muted);
      padding: 4px 0;
    }
    .cal-day {
      padding: 7px 0;
      border-radius: 6px;
      font-size: 13px;
      transition: .1s;
    }
    .cal-day:not(.cal-past):hover { background: var(--bg-secondary); }
    .cal-sel { background: var(--brand) !important; color: #fff !important; }
    .cal-today { font-weight: 700; color: var(--brand); }
    .cal-nav-btn {
      background: var(--bg-primary);
      border: 1px solid var(--border);
      border-radius: 6px;
      width: 32px; height: 32px;
      cursor: pointer;
      font-size: 18px;
      line-height: 1;
      transition: .1s;
    }
    .cal-nav-btn:hover { background: var(--bg-secondary); }

    .nav-badge { pointer-events: none; }
    #automod-log-list { font-family: inherit; }
  `;
  document.head.appendChild(style);
})();
