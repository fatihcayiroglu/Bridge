// client/js/mobile.ts
// Phase 9 — responsive shell controller. Presentation classes only; feature
// state remains with each canonical Svelte owner.

import { BridgeRegistry } from './core/bridge-registry.ts';

const BREAKPOINT_NARROW = 600;
const BREAKPOINT_TABLET = 768;

type MobileTab = 'servers' | 'channels' | 'chat' | 'members' | 'profile';
type MemberToggle = () => void;

let memberOwner: MemberToggle | null = null;

function updateVisualViewport(): void {
  const viewport = window.visualViewport;
  const height = Math.round(viewport?.height ?? window.innerHeight);
  const pageHeight = Math.round(window.innerHeight);
  const keyboardInset = Math.max(0, pageHeight - height - Math.round(viewport?.offsetTop ?? 0));
  document.documentElement.style.setProperty('--bridge-visual-viewport-height', `${height}px`);
  document.documentElement.style.setProperty('--bridge-keyboard-inset', `${keyboardInset}px`);
  document.documentElement.classList.toggle('bridge-keyboard-open', isNarrow() && keyboardInset >= 120);
}

function isNarrow(): boolean { return window.innerWidth <= BREAKPOINT_NARROW; }
function isTablet(): boolean { return window.innerWidth <= BREAKPOINT_TABLET; }

function updateMobileNav(active: MobileTab | null): void {
  document.querySelectorAll<HTMLElement>('.mobile-nav-btn').forEach((button) => {
    const id = button.id.replace('mnav-', '');
    const selected = id === active;
    button.classList.toggle('active', selected);
    if (selected) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
}

function setBackdrop(active: boolean): void {
  const backdrop = document.getElementById('mobile-backdrop');
  backdrop?.classList.toggle('active', active);
  backdrop?.setAttribute('aria-hidden', active ? 'false' : 'true');
}

function closeMobilePanels(syncMemberOwner = true): void {
  document.querySelector('.server-list')?.classList.remove('open');
  document.querySelector('.channel-sidebar')?.classList.remove('open');

  const members = document.querySelector('.member-list');
  const memberWasOpen = members?.classList.contains('open') ?? false;
  members?.classList.remove('open');
  if (memberWasOpen && syncMemberOwner && members && !members.classList.contains('is-collapsed')) memberOwner?.();

  setBackdrop(false);
  updateMobileNav(isNarrow() ? 'chat' : null);
}

function openDrawer(panel: Element | null, tab: MobileTab): void {
  closeMobilePanels();
  if (!panel) return;
  panel.classList.add('open');
  setBackdrop(true);
  updateMobileNav(tab);
}

function toggleMemberPresentation(): void {
  const members = document.querySelector('.member-list');

  // Desktop visibility belongs entirely to MemberListPanel.
  if (!isTablet()) {
    memberOwner?.();
    return;
  }

  if (members?.classList.contains('open')) {
    closeMobilePanels();
    return;
  }

  closeMobilePanels();
  if (members?.classList.contains('is-collapsed')) memberOwner?.();
  members?.classList.add('open');
  setBackdrop(true);
  if (isNarrow()) updateMobileNav('members');
}

function normalizeTab(first?: unknown, second?: unknown): MobileTab | null {
  const value = typeof second === 'string' ? second : typeof first === 'string' ? first : '';
  return ['servers', 'channels', 'chat', 'members', 'profile'].includes(value)
    ? value as MobileTab
    : null;
}

function mobileNav(first?: unknown, second?: unknown): void {
  const tab = normalizeTab(first, second);
  if (!tab || !isNarrow()) return;

  if (tab === 'servers') {
    openDrawer(document.querySelector('.server-list'), tab);
  } else if (tab === 'channels') {
    openDrawer(document.querySelector('.channel-sidebar'), tab);
  } else if (tab === 'members') {
    toggleMemberPresentation();
  } else if (tab === 'profile') {
    closeMobilePanels();
    const me = BridgeRegistry.call<{ id?: string } | null>('getMe');
    if (me?.id && BridgeRegistry.has('openProfileModal')) BridgeRegistry.call('openProfileModal', me.id);
    else BridgeRegistry.call('openSettingsModal');
    updateMobileNav('profile');
  } else {
    closeMobilePanels();
    updateMobileNav('chat');
  }
}

BridgeRegistry.register('closeMobilePanels', () => closeMobilePanels());
BridgeRegistry.register('mobileNav', mobileNav);
BridgeRegistry.register('setMobileNavPip', (tab: unknown, on: unknown) => {
  const button = document.getElementById(`mnav-${String(tab)}`);
  button?.classList.toggle('has-pip', Boolean(on));
});

/**
 * MemberListPanel registers the real feature owner independently. Re-wrap it
 * after mount and after socket boot; this adapter only adds drawer classes.
 */
function installMemberToggleAdapter(): void {
  const current = BridgeRegistry.get<MemberToggle>('toggleMemberList');
  if (current === toggleMemberPresentation) return;
  if (typeof current === 'function') memberOwner = current;
  BridgeRegistry.register('toggleMemberList', toggleMemberPresentation);
}

installMemberToggleAdapter();
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    queueMicrotask(installMemberToggleAdapter);
    window.setTimeout(installMemberToggleAdapter, 50);
  }, { once: true });
} else {
  queueMicrotask(installMemberToggleAdapter);
}
document.addEventListener('bridge:socket-ready', () => queueMicrotask(installMemberToggleAdapter));
document.addEventListener('bridge:auth-success', () => window.setTimeout(installMemberToggleAdapter, 0));

// The document's compatibility dispatcher cannot see ESM bindings. Keep this
// delegate intentionally limited to shell actions so no second feature router
// is created and markup never depends on window globals.
const SHELL_ACTIONS = new Set(['mobileNav', 'closeMobilePanels', 'toggleMemberList']);
document.addEventListener('click', (event) => {
  const target = event.target instanceof Element
    ? event.target.closest<HTMLElement>('[data-bridge-action]')
    : null;
  const action = target?.dataset.bridgeAction ?? '';
  if (!target || !SHELL_ACTIONS.has(action)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  if (action === 'mobileNav') mobileNav(target, target.dataset.bridgeArg);
  else BridgeRegistry.call(action);
}, true);

// Web/tablet swipe: right from the left edge opens channels, left closes.
const capacitor = (window as unknown as {
  Capacitor?: { isNativePlatform?(): boolean };
}).Capacitor;
if (!capacitor?.isNativePlatform?.()) {
  let touchStartX = 0;
  let touchStartY = 0;
  let swipeActive = false;

  document.addEventListener('touchstart', (event) => {
    if (!isNarrow()) return;
    touchStartX = event.touches[0]?.clientX ?? 0;
    touchStartY = event.touches[0]?.clientY ?? 0;
    swipeActive = true;
  }, { passive: true });

  document.addEventListener('touchmove', (event) => {
    if (!swipeActive || !isNarrow()) return;
    const touch = event.touches[0];
    if (!touch) return;
    const dx = touch.clientX - touchStartX;
    const dy = touch.clientY - touchStartY;
    if (Math.abs(dy) > Math.abs(dx)) { swipeActive = false; return; }
    if (touchStartX < 36 && dx > 56) {
      openDrawer(document.querySelector('.channel-sidebar'), 'channels');
      swipeActive = false;
    } else if (dx < -56) {
      closeMobilePanels();
      swipeActive = false;
    }
  }, { passive: true });

  document.addEventListener('touchend', () => { swipeActive = false; }, { passive: true });
}

function onResize(): void {
  const members = document.querySelector('.member-list');

  if (!isNarrow()) {
    document.querySelector('.server-list')?.classList.remove('open');
    document.querySelector('.channel-sidebar')?.classList.remove('open');
  }
  if (!isTablet()) members?.classList.remove('open');

  // A member drawer remains valid from phone through tablet widths. Keep its
  // modal backdrop in sync when the viewport crosses the 600px navigation
  // breakpoint; desktop member state itself still belongs to MemberListPanel.
  const drawerOpen = isTablet() && (members?.classList.contains('open') ?? false);
  const narrowDrawerOpen = isNarrow() && Boolean(
    document.querySelector('.server-list.open, .channel-sidebar.open'),
  );
  setBackdrop(drawerOpen || narrowDrawerOpen);
  updateMobileNav(isNarrow() ? 'chat' : null);
}

window.addEventListener('resize', () => { onResize(); updateVisualViewport(); }, { passive: true });
window.visualViewport?.addEventListener('resize', updateVisualViewport, { passive: true });
window.visualViewport?.addEventListener('scroll', updateVisualViewport, { passive: true });
updateVisualViewport();
document.addEventListener('bridge:channel-selected', () => {
  if (isNarrow()) closeMobilePanels();
  BridgeRegistry.call('setMobileNavPip', 'channels', false);
});
