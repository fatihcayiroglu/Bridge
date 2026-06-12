// client/js/mobile.ts
// Mobile navigation, panel open/close, swipe gestures

(function () {
  const BREAKPOINT_PHONE  = 480;
  const BREAKPOINT_TABLET = 768;

  function isMobile()  { return window.innerWidth <= BREAKPOINT_PHONE; }
  function isTablet()  { return window.innerWidth <= BREAKPOINT_TABLET; }
  function isTouchDevice() { return window.matchMedia('(hover:none) and (pointer:coarse)').matches; }

  // ── PANEL MANAGEMENT ─────────────────────────────────────────
  BridgeRegistry.register('closeMobilePanels', function closeMobilePanels() {
    document.querySelector('.server-list')?.classList.remove('open');
    document.querySelector('.channel-sidebar')?.classList.remove('open');
    document.querySelector('.member-list')?.classList.remove('open');
    document.getElementById('mobile-backdrop')?.classList.remove('active');
    updateMobileNav(null);
  });

  function openPanel(panelEl) {
    closeMobilePanels();
    panelEl?.classList.add('open');
    document.getElementById('mobile-backdrop')?.classList.add('active');
  }

  // ── BOTTOM NAV HANDLER ───────────────────────────────────────
  BridgeRegistry.register('mobileNav', function mobileNav(tab: unknown) {
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
        // Sprint 33 FIX: openProfileModal import edilmeden kullanılıyordu.
        // BridgeRegistry üzerinden çağır; profile.ts kaydı yapıyor.
        const meObj = BridgeRegistry.call('getMe') as { id?: string } | null;
        if (meObj?.id) {
          if (BridgeRegistry.has('openProfileModal')) {
            BridgeRegistry.call('openProfileModal', meObj.id);
          } else if (typeof (window as unknown as { openProfileModal?: (id: string) => void }).openProfileModal === 'function') {
            // geçiş köprüsü — profile.ts BridgeRegistry'ye geçince silinir
            (window as unknown as { openProfileModal: (id: string) => void }).openProfileModal(meObj.id);
          }
        } else {
          // Sprint 57: window.openSettings kaldırıldı — BridgeRegistry üzerinden çağır
          BridgeRegistry.call('openSettingsModal');
        }
        updateMobileNav('profile');
        break;
    }
  });

  function updateMobileNav(active) {
    document.querySelectorAll('.mobile-nav-btn').forEach(btn => {
      const id = btn.id.replace('mnav-', '');
      btn.classList.toggle('active', id === active);
    });
  }

  // ── AUTO-CLOSE PANELS ON CHANNEL SELECT ──────────────────────
  // Patch selectChannel to close panels on mobile after selection
  const _origSelectChannel = BridgeRegistry.get<(ch: unknown) => Promise<void>>('selectChannel');
  if (typeof _origSelectChannel === 'function') {
    BridgeRegistry.register('selectChannel', async function selectChannel(channel: unknown) {
      await _origSelectChannel(channel);
      if (isMobile() || isTablet()) {
        // Small delay so user sees the selection
        setTimeout(closeMobilePanels, 120);
        updateMobileNav('chat');
      }
    });
  }

  // ── SWIPE TO OPEN SIDEBAR ────────────────────────────────────
  // Sprint 96: Capacitor ortamında mobile-ux.ts'deki gelişmiş swipe devreye girer;
  // bu blok yalnızca Capacitor olmayan web/tablet için çalışır.
  const _isCapacitor = typeof window !== 'undefined' && !!(
    (window as Record<string, unknown>).Capacitor &&
    ((window as Record<string, unknown>).Capacitor as { isNativePlatform?(): boolean }).isNativePlatform?.()
  );

  if (!_isCapacitor) {
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
  }

  // ── VIEWPORT HEIGHT FIX (iOS keyboard) ───────────────────────
  // iOS shrinks viewport when keyboard opens; this compensates
  function setVh() {
    document.documentElement.style.setProperty('--real-vh', `${window.innerHeight * 0.01}px`);
  }
  setVh();
  window.addEventListener('resize', setVh, { passive: true });

  // ── TABLET: TOGGLE MEMBER LIST ───────────────────────────────
  // Override toggleMemberList for tablet to use overlay
  const _origToggleMemberList = BridgeRegistry.get<() => void>('toggleMemberList');
  BridgeRegistry.register('toggleMemberList', function toggleMemberList() {
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
  });

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
  BridgeRegistry.register('setMobileNavPip', function setMobileNavPip(tab: unknown, on: unknown) {
    const btn = document.getElementById(`mnav-${tab}`);
    if (btn) btn.classList.toggle('has-pip', !!on);
  });

  // Sync active state on channel select (re-patch in case selectChannel
  // was defined after mobile.js loaded)
  document.addEventListener('bridge:channel-selected', () => {
    if (isMobile() || isTablet()) {
      updateMobileNav('chat');
      BridgeRegistry.call('setMobileNavPip', 'channels', false);
    }
  });

})();

