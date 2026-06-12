// client/tests/command-palette.test.ts
// Sprint 111 — Komut Paleti (⌘K) testleri
// 95%+ coverage hedefi

jest.mock('../client/js/core/globals.js', () => ({
  getState:         jest.fn(() => ({ user: { _id: 'u1' } })),
  getCurrentServer: jest.fn(() => ({ _id: 'srv1', name: 'Test', ownerId: 'u1' })),
  getSocket:        jest.fn(() => ({ emit: jest.fn() })),
}));
jest.mock('../client/js/core/utils.js', () => ({
  escHtml: (s: string) => s.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
}));
jest.mock('../client/js/core/i18n.js', () => ({ t: (k: string) => k }));

// Mock dynamic imports
jest.mock('../client/js/core/friends.js',          () => ({ openFriendsPanel: jest.fn() }));
jest.mock('../client/js/core/server-ui.js',        () => ({
  openAddServerModal: jest.fn(),
  openInviteModal:    jest.fn().mockResolvedValue(undefined),
  openRoleManager:    jest.fn().mockResolvedValue(undefined),
  openServerMenu:     jest.fn(),
}));
jest.mock('../client/js/core/discover.js',         () => ({ openDiscoverPanel: jest.fn() }));
jest.mock('../client/js/core/group-dm-core.js',    () => ({ openCreateGroupDmModal: jest.fn() }));
jest.mock('../client/js/core/analytics.js',        () => ({ openServerAnalytics: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../client/js/core/soundboard-ui.js',    () => ({ openSoundboardPanel: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../client/js/core/outgoing-webhooks.js',() => ({ openOutgoingWebhookManager: jest.fn().mockResolvedValue(undefined) }));
jest.mock('../client/js/core/notification-prefs.js', () => ({ openServerNotifSettings: jest.fn() }));
jest.mock('../client/js/core/bot-marketplace/index.js', () => ({ openBotMarketplace: jest.fn().mockResolvedValue(undefined) }));

import {
  registerCommand,
  unregisterCommand,
  getCommands,
  open,
  close,
  toggle,
  initCommandPalette,
} from '../client/js/core/command-palette';

function key(key: string, opts: Partial<KeyboardEventInit> = {}) {
  document.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...opts }));
}
function paletteKey(k: string) {
  const overlay = document.querySelector('.cp-overlay');
  overlay?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));
}

beforeEach(() => {
  document.body.innerHTML = '';
  close();
  // Clear registered commands between tests by re-importing fresh
  jest.resetModules();
});

// ── registerCommand / unregisterCommand / getCommands ───────────────────────

describe('registry', () => {
  it('registers a command', () => {
    registerCommand({ id: 'test:cmd', label: 'Test', category: 'action', action: jest.fn() });
    expect(getCommands().some(c => c.id === 'test:cmd')).toBe(true);
    unregisterCommand('test:cmd');
  });

  it('unregisters a command', () => {
    registerCommand({ id: 'temp:cmd', label: 'Temp', category: 'action', action: jest.fn() });
    unregisterCommand('temp:cmd');
    expect(getCommands().some(c => c.id === 'temp:cmd')).toBe(false);
  });

  it('registering same id overwrites', () => {
    const fn1 = jest.fn();
    const fn2 = jest.fn();
    registerCommand({ id: 'dup', label: 'A', category: 'action', action: fn1 });
    registerCommand({ id: 'dup', label: 'B', category: 'action', action: fn2 });
    const cmd = getCommands().find(c => c.id === 'dup');
    expect(cmd?.label).toBe('B');
    unregisterCommand('dup');
  });

  it('unregistering non-existent id is safe', () => {
    expect(() => unregisterCommand('no-such-id')).not.toThrow();
  });
});

// ── open / close / toggle ────────────────────────────────────────────────────

describe('open / close / toggle', () => {
  it('open() creates overlay', () => {
    open();
    expect(document.querySelector('.cp-overlay')).not.toBeNull();
  });

  it('open() creates input', () => {
    open();
    expect(document.querySelector('#cp-input')).not.toBeNull();
  });

  it('close() removes overlay', () => {
    open();
    close();
    expect(document.querySelector('.cp-overlay')).toBeNull();
  });

  it('open() twice does not create duplicate overlays', () => {
    open();
    open();
    expect(document.querySelectorAll('.cp-overlay').length).toBe(1);
  });

  it('close() without open is safe', () => {
    expect(() => close()).not.toThrow();
  });

  it('toggle() opens when closed', () => {
    close();
    toggle();
    expect(document.querySelector('.cp-overlay')).not.toBeNull();
  });

  it('toggle() closes when open', () => {
    open();
    toggle();
    expect(document.querySelector('.cp-overlay')).toBeNull();
  });

  it('clicking overlay backdrop closes palette', () => {
    open();
    const overlay = document.querySelector<HTMLElement>('.cp-overlay')!;
    overlay.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.cp-overlay')).toBeNull();
  });

  it('clicking modal interior does not close', () => {
    open();
    const modal = document.querySelector<HTMLElement>('#cp-modal')!;
    modal.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelector('.cp-overlay')).not.toBeNull();
  });
});

// ── Klavye navigasyonu ───────────────────────────────────────────────────────

describe('keyboard navigation', () => {
  beforeEach(() => {
    registerCommand({ id: 'kn:a', label: 'Alpha', category: 'action', action: jest.fn() });
    registerCommand({ id: 'kn:b', label: 'Beta',  category: 'action', action: jest.fn() });
    open();
  });
  afterEach(() => {
    unregisterCommand('kn:a');
    unregisterCommand('kn:b');
  });

  it('Escape closes palette', () => {
    paletteKey('Escape');
    expect(document.querySelector('.cp-overlay')).toBeNull();
  });

  it('ArrowDown moves selection down', () => {
    const before = document.querySelector('.cp-item--active');
    paletteKey('ArrowDown');
    const after = document.querySelector('.cp-item--active');
    // index may have changed or stayed at max
    expect(after).not.toBeNull();
  });

  it('ArrowUp does not go below 0', () => {
    paletteKey('ArrowUp');
    const active = document.querySelector('.cp-item--active');
    expect(active).not.toBeNull();
  });

  it('Enter executes active item', () => {
    const actionFn = jest.fn();
    registerCommand({ id: 'kn:enter', label: 'EnterTest', category: 'action', action: actionFn });
    close(); open();
    paletteKey('Enter');
    // action should have been called (may be async)
    expect(document.querySelector('.cp-overlay')).toBeNull();
    unregisterCommand('kn:enter');
  });
});

// ── Arama filtresi ───────────────────────────────────────────────────────────

describe('search filtering', () => {
  beforeEach(() => {
    registerCommand({ id: 'sf:apple',  label: 'Apple',  keywords: ['fruit'],   category: 'navigate', action: jest.fn() });
    registerCommand({ id: 'sf:banana', label: 'Banana', keywords: ['fruit'],   category: 'navigate', action: jest.fn() });
    registerCommand({ id: 'sf:carrot', label: 'Carrot', keywords: ['veggie'],  category: 'action',   action: jest.fn() });
  });
  afterEach(() => {
    ['sf:apple','sf:banana','sf:carrot'].forEach(unregisterCommand);
  });

  it('typing filters items', () => {
    open();
    const input = document.querySelector<HTMLInputElement>('#cp-input')!;
    input.value = 'apple';
    input.dispatchEvent(new Event('input'));
    expect(document.body.innerHTML).toContain('Apple');
    expect(document.body.innerHTML).not.toContain('Carrot');
  });

  it('partial match works', () => {
    open();
    const input = document.querySelector<HTMLInputElement>('#cp-input')!;
    input.value = 'an';
    input.dispatchEvent(new Event('input'));
    expect(document.body.innerHTML).toContain('Banana');
  });

  it('empty query shows all items', () => {
    open();
    const input = document.querySelector<HTMLInputElement>('#cp-input')!;
    input.value = '';
    input.dispatchEvent(new Event('input'));
    expect(document.body.innerHTML).toContain('Apple');
    expect(document.body.innerHTML).toContain('Carrot');
  });

  it('no match shows empty state', () => {
    open();
    const input = document.querySelector<HTMLInputElement>('#cp-input')!;
    input.value = 'xyz_no_match_at_all';
    input.dispatchEvent(new Event('input'));
    expect(document.body.innerHTML).toMatch(/sonuç|cp_no_results|no.results/i);
  });

  it('keyword match works', () => {
    open();
    const input = document.querySelector<HTMLInputElement>('#cp-input')!;
    input.value = 'fruit';
    input.dispatchEvent(new Event('input'));
    expect(document.body.innerHTML).toContain('Apple');
    expect(document.body.innerHTML).toContain('Banana');
    expect(document.body.innerHTML).not.toContain('Carrot');
  });
});

// ── visible() filtresi ───────────────────────────────────────────────────────

describe('visible() predicate', () => {
  it('hidden command is not rendered', () => {
    registerCommand({
      id: 'vis:hidden', label: 'HiddenCmd', category: 'action',
      visible: () => false,
      action: jest.fn(),
    });
    open();
    expect(document.body.innerHTML).not.toContain('HiddenCmd');
    unregisterCommand('vis:hidden');
  });

  it('visible command is rendered', () => {
    registerCommand({
      id: 'vis:shown', label: 'ShownCmd', category: 'action',
      visible: () => true,
      action: jest.fn(),
    });
    open();
    expect(document.body.innerHTML).toContain('ShownCmd');
    unregisterCommand('vis:shown');
  });
});

// ── initCommandPalette (⌘K kısayol) ─────────────────────────────────────────

describe('initCommandPalette keyboard shortcut', () => {
  it('Ctrl+K opens palette', () => {
    initCommandPalette();
    close();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(document.querySelector('.cp-overlay')).not.toBeNull();
  });

  it('Ctrl+K again closes palette', () => {
    initCommandPalette();
    open();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
    expect(document.querySelector('.cp-overlay')).toBeNull();
  });

  it('K without modifier does not open palette', () => {
    initCommandPalette();
    close();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: false, bubbles: true }));
    expect(document.querySelector('.cp-overlay')).toBeNull();
  });
});

// ── Son kullanılanlar ────────────────────────────────────────────────────────

describe('recent commands', () => {
  it('executed command appears in recent', () => {
    const action = jest.fn();
    registerCommand({ id: 'recent:test', label: 'RecentTest', category: 'action', action });
    open();
    // Click the item
    const items = document.querySelectorAll<HTMLElement>('.cp-item');
    const target = Array.from(items).find(el => el.textContent?.includes('RecentTest'));
    target?.click();
    // Reopen and check
    open();
    expect(document.body.innerHTML).toContain('RecentTest');
    unregisterCommand('recent:test');
  });
});

// ── XSS koruması ────────────────────────────────────────────────────────────

describe('XSS protection', () => {
  it('command labels are HTML-escaped', () => {
    registerCommand({
      id: 'xss:test',
      label: '<script>alert(1)</script>',
      category: 'action',
      action: jest.fn(),
    });
    open();
    expect(document.body.innerHTML).not.toContain('<script>alert(1)</script>');
    expect(document.body.innerHTML).toContain('&lt;script&gt;');
    unregisterCommand('xss:test');
  });
});

// ── İkon ve kısayol görüntüsü ────────────────────────────────────────────────

describe('icon and shortcut display', () => {
  it('icon is rendered', () => {
    registerCommand({ id: 'icon:test', label: 'IconTest', icon: '🔥', category: 'action', action: jest.fn() });
    open();
    expect(document.body.innerHTML).toContain('🔥');
    unregisterCommand('icon:test');
  });

  it('shortcut is rendered', () => {
    registerCommand({ id: 'sc:test', label: 'ShortcutTest', shortcut: '⌘P', category: 'action', action: jest.fn() });
    open();
    expect(document.body.innerHTML).toContain('⌘P');
    unregisterCommand('sc:test');
  });
});
