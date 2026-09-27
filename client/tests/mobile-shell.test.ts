import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { BridgeRegistry } from '../js/core/bridge-registry.js';

const memberToggle = vi.fn(() => {
  document.querySelector('.member-list')?.classList.toggle('is-collapsed');
});

const SHELL_MARKUP = `
  <div class="server-list"></div>
  <div class="channel-sidebar"></div>
  <div class="member-list is-collapsed"></div>
  <div id="mobile-backdrop" aria-hidden="true"></div>
  <nav>
    <button class="mobile-nav-btn" id="mnav-channels"></button>
    <button class="mobile-nav-btn" id="mnav-chat"></button>
    <button class="mobile-nav-btn" id="mnav-members"></button>
  </nav>
`;

beforeAll(async () => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
  document.body.innerHTML = SHELL_MARKUP;
  BridgeRegistry.register('toggleMemberList', memberToggle);
  await import('../js/mobile.js');
});

beforeEach(() => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
  document.body.innerHTML = SHELL_MARKUP;
  memberToggle.mockClear();
});

describe('Phase 9 narrow shell controller', () => {
  it('makes channels reachable in the former 481–600px dead zone', () => {
    BridgeRegistry.call('mobileNav', 'channels');

    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(true);
    expect(document.getElementById('mobile-backdrop')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('mobile-backdrop')?.getAttribute('aria-hidden')).toBe('false');
  });

  it('uses the canonical member owner and adds only drawer presentation', () => {
    BridgeRegistry.call('mobileNav', 'members');

    expect(memberToggle).toHaveBeenCalledOnce();
    expect(document.querySelector('.member-list')?.classList.contains('is-collapsed')).toBe(false);
    expect(document.querySelector('.member-list')?.classList.contains('open')).toBe(true);

    BridgeRegistry.call('closeMobilePanels');
    expect(memberToggle).toHaveBeenCalledTimes(2);
    expect(document.querySelector('.member-list')?.classList.contains('open')).toBe(false);
  });

  it('keeps the member drawer backdrop coherent through the 600px boundary', () => {
    BridgeRegistry.call('mobileNav', 'members');

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    window.dispatchEvent(new Event('resize'));

    expect(document.querySelector('.member-list')?.classList.contains('open')).toBe(true);
    expect(document.getElementById('mobile-backdrop')?.classList.contains('active')).toBe(true);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    window.dispatchEvent(new Event('resize'));

    expect(document.querySelector('.member-list')?.classList.contains('open')).toBe(false);
    expect(document.getElementById('mobile-backdrop')?.classList.contains('active')).toBe(false);
  });

  it('opens every narrow drawer and keeps nav aria state synchronized', () => {
    BridgeRegistry.call('mobileNav', 'servers');
    expect(document.querySelector('.server-list')?.classList.contains('open')).toBe(true);
    expect(document.getElementById('mobile-backdrop')?.classList.contains('active')).toBe(true);

    BridgeRegistry.call('mobileNav', 'channels');
    expect(document.querySelector('.server-list')?.classList.contains('open')).toBe(false);
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(true);
    expect(document.getElementById('mnav-channels')?.getAttribute('aria-current')).toBe('page');

    BridgeRegistry.call('mobileNav', 'chat');
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);
    expect(document.getElementById('mnav-chat')?.getAttribute('aria-current')).toBe('page');
    expect(document.getElementById('mobile-backdrop')?.getAttribute('aria-hidden')).toBe('true');
  });

  it('routes profile to the canonical profile owner or settings fallback', () => {
    const profile = vi.fn(); const settings = vi.fn();
    BridgeRegistry.register('getMe', (() => ({ id: 'me-1' })) as never);
    BridgeRegistry.register('openProfileModal', profile as never);
    BridgeRegistry.register('openSettingsModal', settings as never);
    BridgeRegistry.call('mobileNav', 'profile');
    expect(profile).toHaveBeenCalledWith('me-1');
    expect(settings).not.toHaveBeenCalled();

    BridgeRegistry.unregister('openProfileModal'); profile.mockClear(); settings.mockClear();
    BridgeRegistry.call('mobileNav', 'profile');
    expect(profile).not.toHaveBeenCalled();
    expect(settings).toHaveBeenCalledOnce();
  });

  it('ignores invalid/non-narrow navigation and delegates desktop member ownership unchanged', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    BridgeRegistry.call('mobileNav', 'channels');
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);
    BridgeRegistry.call('toggleMemberList');
    expect(memberToggle).toHaveBeenCalledOnce();
    BridgeRegistry.call('mobileNav', 'not-a-tab');
    expect(document.getElementById('mobile-backdrop')?.classList.contains('active')).toBe(false);
  });

  it('sets notification pips and clears the channel pip after channel selection', () => {
    const channels = document.getElementById('mnav-channels')!;
    BridgeRegistry.call('setMobileNavPip', 'channels', true);
    expect(channels.classList.contains('has-pip')).toBe(true);
    document.dispatchEvent(new CustomEvent('bridge:channel-selected'));
    expect(channels.classList.contains('has-pip')).toBe(false);
  });

  it('owns shell data-action clicks without running unrelated actions', () => {
    const btn = document.createElement('button');
    btn.dataset.bridgeAction = 'mobileNav'; btn.dataset.bridgeArg = 'channels';
    const child = document.createElement('span'); btn.appendChild(child); document.body.appendChild(btn);
    child.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(true);

    BridgeRegistry.call('closeMobilePanels');
    const unrelated = document.createElement('button'); unrelated.dataset.bridgeAction = 'deleteServer'; document.body.appendChild(unrelated);
    unrelated.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);
  });

  it('supports horizontal edge swipes but cancels vertical gestures', () => {
    const touch = (type: string, x: number, y: number) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: Array<{ clientX: number; clientY: number }> };
      Object.defineProperty(event, 'touches', { configurable: true, value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
      document.dispatchEvent(event);
    };
    touch('touchstart', 10, 20); touch('touchmove', 80, 22);
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(true);

    touch('touchstart', 200, 20); touch('touchmove', 100, 22);
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);

    touch('touchstart', 10, 20); touch('touchmove', 20, 100); touch('touchmove', 100, 105);
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);
  });

  it('ikinci registry argumanini tanir ve eksik panel/uye DOMunda cokmez', () => {
    document.querySelector('.server-list')?.remove();
    document.querySelector('.member-list')?.remove();
    document.getElementById('mobile-backdrop')?.remove();

    expect(() => BridgeRegistry.call('mobileNav', { type: 'click' }, 'servers')).not.toThrow();
    expect(() => BridgeRegistry.call('mobileNav', { type: 'click' }, null)).not.toThrow();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    expect(() => BridgeRegistry.call('closeMobilePanels')).not.toThrow();
  });

  it('acik uye cekmecesini ikinci toggle ile kapatir', () => {
    BridgeRegistry.call('mobileNav', 'members');
    expect(document.querySelector('.member-list')?.classList.contains('open')).toBe(true);

    BridgeRegistry.call('toggleMemberList');
    expect(document.querySelector('.member-list')?.classList.contains('open')).toBe(false);
    expect(memberToggle).toHaveBeenCalledTimes(2);
  });

  it('zaten genisletilmis uye listesini cekmece acarken sahibine dokunmaz', () => {
    document.querySelector('.member-list')?.classList.remove('is-collapsed');
    BridgeRegistry.call('mobileNav', 'members');

    expect(memberToggle).not.toHaveBeenCalled();
    expect(document.querySelector('.member-list')?.classList.contains('open')).toBe(true);
  });

  it('socket/auth bariyerlerinde adapteri yeniden sarar ve kayipsa yeniden kurar', async () => {
    const replacement = vi.fn();
    BridgeRegistry.register('toggleMemberList', replacement as never);
    document.dispatchEvent(new Event('bridge:socket-ready'));
    await Promise.resolve();

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1024 });
    BridgeRegistry.call('toggleMemberList');
    expect(replacement).toHaveBeenCalledOnce();

    BridgeRegistry.unregister('toggleMemberList');
    document.dispatchEvent(new Event('bridge:auth-success'));
    await new Promise(resolve => window.setTimeout(resolve, 0));
    expect(BridgeRegistry.has('toggleMemberList')).toBe(true);
  });

  it('click delegesi Element olmayan hedefi ve argumansiz ogeyi yok sayar; shell eylemini cagirir', () => {
    expect(() => document.dispatchEvent(new MouseEvent('click', { bubbles: true }))).not.toThrow();

    const plain = document.createElement('button');
    document.body.appendChild(plain);
    plain.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    document.querySelector('.channel-sidebar')?.classList.add('open');
    const close = document.createElement('button');
    close.dataset.bridgeAction = 'closeMobilePanels';
    document.body.appendChild(close);
    close.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);
  });

  it('dokunma dinleyicileri genis ekran, eksik dokunus, esik alti ve touchend yollarini guvenle isler', () => {
    const touch = (type: string, touches: Array<{ clientX: number; clientY: number }>) => {
      const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
        touches: Array<{ clientX: number; clientY: number }>;
      };
      Object.defineProperty(event, 'touches', { configurable: true, value: touches });
      document.dispatchEvent(event);
    };

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    touch('touchstart', [{ clientX: 5, clientY: 5 }]);

    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 });
    touch('touchstart', []);
    touch('touchmove', []);
    touch('touchend', []);
    touch('touchmove', [{ clientX: 100, clientY: 0 }]);

    touch('touchstart', [{ clientX: 100, clientY: 20 }]);
    touch('touchmove', [{ clientX: 120, clientY: 22 }]);
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);

    touch('touchstart', [{ clientX: 10, clientY: 10 }]);
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    touch('touchmove', [{ clientX: 100, clientY: 10 }]);
    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(false);
  });

  it('dar resize cekmece/backdrop/nav dallarini ve uye DOMu olmayan tablet yolunu senkronlar', () => {
    document.querySelector('.server-list')?.classList.add('open');
    window.dispatchEvent(new Event('resize'));
    expect(document.getElementById('mobile-backdrop')?.classList.contains('active')).toBe(true);
    expect(document.getElementById('mnav-chat')?.getAttribute('aria-current')).toBe('page');

    document.querySelector('.server-list')?.classList.remove('open');
    window.dispatchEvent(new Event('resize'));
    expect(document.getElementById('mobile-backdrop')?.classList.contains('active')).toBe(false);

    document.querySelector('.member-list')?.remove();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 700 });
    expect(() => window.dispatchEvent(new Event('resize'))).not.toThrow();
  });

  it('genis ekranda kanal secimi cekmeceyi kapatmaz ama pipi temizler', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 900 });
    document.querySelector('.channel-sidebar')?.classList.add('open');
    BridgeRegistry.call('setMobileNavPip', 'channels', true);

    document.dispatchEvent(new Event('bridge:channel-selected'));

    expect(document.querySelector('.channel-sidebar')?.classList.contains('open')).toBe(true);
    expect(document.getElementById('mnav-channels')?.classList.contains('has-pip')).toBe(false);
  });

});
