// client/js/mobile.js
// Mobile navigation, panel open/close, swipe gestures

(function () {
  const BREAKPOINT_PHONE  = 480;
  const BREAKPOINT_TABLET = 768;

  function isMobile()  { return window.innerWidth <= BREAKPOINT_PHONE; }
  function isTablet()  { return window.innerWidth <= BREAKPOINT_TABLET; }
  function isTouchDevice() { return window.matchMedia('(hover:none) and (pointer:coarse)').matches; }

  // ── PANEL MANAGEMENT ─────────────────────────────────────────
  window.closeMobilePanels = function () {
    document.querySelector('.server-list')?.classList.remove('open');
    document.querySelector('.channel-sidebar')?.classList.remove('open');
    document.querySelector('.member-list')?.classList.remove('open');
    document.getElementById('mobile-backdrop')?.classList.remove('active');
    updateMobileNav(null);
  };

  function openPanel(panelEl) {
    closeMobilePanels();
    panelEl?.classList.add('open');
    document.getElementById('mobile-backdrop')?.classList.add('active');
  }

  // ── BOTTOM NAV HANDLER ───────────────────────────────────────
  window.mobileNav = function (tab) {
    if (!isMobile() && !isTablet()) return;

    switch (tab) {
      case 'servers':
        openPanel(document.querySelector('.server-list'));
        updateMobileNav('servers');
        break;
      case 'channels':
        openPanel(document.querySelector('.channel-sidebar'));
        updateMobileNav('channels');
        break;
      case 'chat':
        closeMobilePanels();
        updateMobileNav('chat');
        break;
      case 'members':
        openPanel(document.querySelector('.member-list'));
        updateMobileNav('members');
        break;
      case 'profile':
        closeMobilePanels();
        if (window.me?.id && typeof openProfileModal === 'function') {
          openProfileModal(window.me.id);
        } else if (typeof openSettings === 'function') {
          openSettings();
        }
        updateMobileNav('profile');
        break;
    }
  };

  function updateMobileNav(active) {
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      const id = btn.id.replace('mnav-', '');
      btn.classList.toggle('active', id === active);
    });
  }

  // ── AUTO-CLOSE PANELS ON CHANNEL SELECT ──────────────────────
  // Patch selectChannel to close panels on mobile after selection
  const _origSelectChannel = window.selectChannel;
  if (typeof _origSelectChannel === 'function') {
    window.selectChannel = async function (channel) {
      await _origSelectChannel(channel);
      if (isMobile() || isTablet()) {
        // Small delay so user sees the selection
        setTimeout(closeMobilePanels, 120);
        updateMobileNav('chat');
      }
    };
  }

  // ── SWIPE TO OPEN SIDEBAR ────────────────────────────────────
  let touchStartX = 0;
  let touchStartY = 0;
  let swipeActive = false;

  document.addEventListener('touchstart', (e) => {
    touchStartX = e.touches[0].clientX;
    touchStartY = e.touches[0].clientY;
    swipeActive = true;
  }, { passive: true });

  document.addEventListener('touchmove', (e) => {
    if (!swipeActive || !isTablet()) return;
    const dx = e.touches[0].clientX - touchStartX;
    const dy = e.touches[0].clientY - touchStartY;
    if (Math.abs(dy) > Math.abs(dx)) { swipeActive = false; return; } // vertical scroll
    if (Math.abs(dx) < 10) return;

    // Swipe right from left edge → open channel sidebar
    if (touchStartX < 40 && dx > 60) {
      openPanel(document.querySelector('.channel-sidebar'));
      updateMobileNav('channels');
      swipeActive = false;
    }
    // Swipe left → close any open panel
    if (dx < -60) {
      closeMobilePanels();
      updateMobileNav('chat');
      swipeActive = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', () => { swipeActive = false; }, { passive: true });

  // ── VIEWPORT HEIGHT FIX (iOS keyboard) ───────────────────────
  // iOS shrinks viewport when keyboard opens; this compensates
  function setVh() {
    document.documentElement.style.setProperty('--real-vh', `${window.innerHeight * 0.01}px`);
  }
  setVh();
  window.addEventListener('resize', setVh, { passive: true });

  // ── TABLET: TOGGLE MEMBER LIST ───────────────────────────────
  // Override toggleMemberList for tablet to use overlay
  const _origToggleMemberList = window.toggleMemberList;
  window.toggleMemberList = function () {
    if (isTablet()) {
      const ml = document.querySelector('.member-list');
      if (ml?.classList.contains('open')) {
        closeMobilePanels();
      } else {
        openPanel(ml);
        updateMobileNav('members');
      }
    } else if (typeof _origToggleMemberList === 'function') {
      _origToggleMemberList();
    }
  };

  // ── SHOW/HIDE MOBILE NAV ─────────────────────────────────────
  function updateNavVisibility() {
    const nav = document.getElementById('mobile-nav');
    if (!nav) return;
    nav.style.display = isMobile() ? 'flex' : 'none';
  }
  updateNavVisibility();
  window.addEventListener('resize', updateNavVisibility, { passive: true });

  // ── APPLY TABLET CLASS ON RESIZE ─────────────────────────────
  function onResize() {
    if (!isTablet()) {
      // Desktop: reset any mobile state
      document.querySelector('.server-list')?.classList.remove('open');
      document.querySelector('.channel-sidebar')?.classList.remove('open');
      document.querySelector('.member-list')?.classList.remove('open');
      document.getElementById('mobile-backdrop')?.classList.remove('active');
    }
  }
  window.addEventListener('resize', onResize, { passive: true });

  // ── v72: Notification pip API ─────────────────────────────────
  // Usage: window.setMobileNavPip('channels', true)  → dot on
  //        window.setMobileNavPip('channels', false) → dot off
  window.setMobileNavPip = function (tab, on) {
    const btn = document.getElementById(`mnav-${tab}`);
    if (btn) btn.classList.toggle('has-pip', !!on);
  };

  // Sync active state on channel select (re-patch in case selectChannel
  // was defined after mobile.js loaded)
  document.addEventListener('bridge:channel-selected', () => {
    if (isMobile() || isTablet()) {
      updateMobileNav('chat');
      window.setMobileNavPip('channels', false);
    }
  });

})();

export const mobileReady = true;
