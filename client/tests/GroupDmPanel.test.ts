// client/tests/GroupDmPanel.test.ts
// Sprint 113 — GroupDmPanel.svelte birim testleri
// ADR-0008 Faz 2 doğrulama

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import GroupDmPanel from '../js/core/GroupDmPanel.svelte';

// The panel owns the lazy-loader fallback. Keep the heavy RTC runtime outside
// this component suite so the fallback-to-window and not-ready states can be
// exercised deterministically; the runtime itself has a dedicated suite.
vi.mock('../js/core/group-dm-voice.js', () => ({}));

// ── Mock'lar ─────────────────────────────────────────────────────────────

const mockRegistry: Record<string, unknown> = {};
const toastMock = vi.hoisted(() => vi.fn());

const mockGroups = [
  { _id: 'g1', name: 'Test Grubu', icon: '👥', memberCount: 3, ownerId: 'me' },
  { _id: 'g2', name: 'Diğer Grup', icon: '🎮', memberCount: 2, ownerId: 'other' },
];

const mockMessages = [
  { _id: 'm1', userId: 'me', displayName: 'Ben', avatarColor: '#2d9cdb', content: 'Merhaba!', createdAt: Date.now() - 5000 },
  { _id: 'm2', userId: 'u2', displayName: 'Ali',  avatarColor: '#ed4245', content: 'Selam!',   createdAt: Date.now() - 2000 },
];

const mockMe = { id: 'me', displayName: 'Ben' };
let activeMe: { id?: string; _id?: string; displayName?: string } | null = mockMe;
let provideCssColor = true;
let provideInitials = true;

vi.mock('../js/core/globals.js', () => ({
  friendsCache: [
    { _id: 'u2', username: 'ali', displayName: 'Ali', avatarColor: '#ed4245' },
    { _id: 'u3', username: 'veli', displayName: 'Veli', avatarColor: '#43b581' },
    { id: 'u4', username: 'idonly', displayName: 'Legacy', avatarColor: '#abcdef' },
  ],
}));

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (key: string, fn: unknown) => { mockRegistry[key] = fn; },
    unregister: (key: string) => { delete mockRegistry[key]; },
    has: (key: string) => key in mockRegistry,
    call: (key: string, ...args: unknown[]) => {
      const owner = mockRegistry[key];
      return typeof owner === 'function' ? (owner as (...values: unknown[]) => unknown)(...args) : undefined;
    },
    get: (key: string) => {
      if (key === 'getMe') return () => activeMe;
      if (key === 'toast') return toastMock;
      if (key === 'cssColor') return provideCssColor ? (c: string) => c : undefined;
      if (key === 'initials') return provideInitials ? (n: string) => n.slice(0, 2).toUpperCase() : undefined;
      if (key === 'formatText') return (s: string) => s;
      return mockRegistry[key];
    },
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// Kanonik API istemcisi mock'u; global fetch ürün kodunda kullanılmamalı.
const mockFetch = vi.fn();
const rawFetch = vi.fn();
global.fetch = rawFetch;

function mockFetchGdmList(): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => mockGroups,
  });
}

function mockFetchMessages(): void {
  mockFetch.mockResolvedValueOnce({
    ok: true,
    json: async () => mockMessages,
  });
}

/**
 * FAZ C4.7 — PANEL ARTIK GİZLİ MOUNT EDİLİR.
 *
 * DmPanel ile aynı kabuk sözleşmesi: bileşen `#gdm-root`a gizli mount edilir
 * ve yalnız GERÇEK bir ürün eylemi onu açar (`showGroupDmPanel`).
 * Bu yüzden testler paneli KAYIT DEFTERİ ÜZERİNDEN, yani üretimdeki yoldan
 * açar. Bu, doğrudan `render()`dan daha güçlü bir kanıttır: açıcının
 * gerçekten kayıtlı olduğunu da doğrular. Hiçbir assertion gevşetilmedi.
 */
function renderOpen(props?: Record<string, unknown>): ReturnType<typeof render> {
  const r = props ? render(GroupDmPanel, props as never) : render(GroupDmPanel);
  const open = mockRegistry['showGroupDmPanel'] as (() => void) | undefined;
  if (!open) throw new Error('showGroupDmPanel kayıtlı değil — açıcı kopmuş');
  open();
  flushSync();          // görünürlük DOM'a yansısın (senkron testler için)
  return r;
}

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  for (const k of Object.keys(mockRegistry)) delete mockRegistry[k];
  mockRegistry['recordNavigationLocation'] = vi.fn();
  activeMe = mockMe;
  provideCssColor = true;
  provideInitials = true;
  mockRegistry['apiFetch'] = mockFetch;
  // Grup listesi KALICI varsayılan yanıttır: hem `onMount` hem de açıcı
  // (`showGroupDmPanel`) listeyi yükler — DmPanel ile aynı davranış. Sıra
  // bazlı `...Once` kuyruğu kullanılsaydı açıcının ikinci yüklemesi, teste
  // ait mesaj yanıtını tüketirdi.
  mockFetch.mockResolvedValue({ ok: true, json: async () => mockGroups });
  rawFetch.mockRejectedValue(new Error('Ham fetch kullanılmamalı'));
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// ── Testler ───────────────────────────────────────────────────────────────

describe('GroupDmPanel — render', () => {
  it('panel render edilir', async () => {
    const { container } = renderOpen();
    expect(container.querySelector('#gdm-panel')).toBeTruthy();
  });

  it('sidebar ve chat alanı mevcut', () => {
    const { container } = renderOpen();
    expect(container.querySelector('.gdm-sidebar')).toBeTruthy();
    expect(container.querySelector('.gdm-chat')).toBeTruthy();
  });

  it('başlangıçta placeholder gösterilir (grup seçilmemiş)', () => {
    const { container } = renderOpen();
    expect(container.querySelector('.gdm-placeholder')).toBeTruthy();
  });

  it('onMount grup listesi yükler', async () => {
    renderOpen();
    await new Promise(r => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/gdm'),
      undefined,   // düz GET: bileşen seçenek nesnesi geçmez
    );
  });
});

describe('GroupDmPanel — grup listesi', () => {
  it('yüklenen gruplar listede görünür', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 20));
    const items = container.querySelectorAll('.gdm-item');
    expect(items.length).toBe(2);
  });

  it('grup adları doğru render edilir', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toContain('Test Grubu');
    expect(container.innerHTML).toContain('Diğer Grup');
  });

  it('grup ikonları görünür', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toContain('👥');
    expect(container.innerHTML).toContain('🎮');
  });
});

describe('GroupDmPanel — grup açma', () => {
  it('gruba tıklayınca mesajlar yüklenir', async () => {
    const { container } = renderOpen();
    mockFetchMessages();
    await new Promise(r => setTimeout(r, 20));
    const item = container.querySelector('.gdm-item') as HTMLElement;
    await fireEvent.click(item);
    await new Promise(r => setTimeout(r, 20));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/gdm/g1/messages'),
      undefined,
    );
  });

  it('grup açılınca header görünür', async () => {
    const { container } = renderOpen();
    mockFetchMessages();
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector('#dm-chat-header')).toBeTruthy();
  });

  it('grup açılınca input alanı görünür', async () => {
    const { container } = renderOpen();
    mockFetchMessages();
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector('#dm-input')).toBeTruthy();
  });

  it('mesajlar render edilir', async () => {
    const { container } = renderOpen();
    mockFetchMessages();
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toContain('Merhaba!');
    expect(container.innerHTML).toContain('Selam!');
  });
});

describe('GroupDmPanel — mesaj gönderme', () => {
  const mockSocket = { emit: vi.fn() };

  beforeEach(async () => {
    // FAZ C4.7 — socket artık KANONİK kayıt defterinden çözülür
    // (`BridgeRegistry.get('socket')`), `window.socket` legacy global'inden
    // DEĞİL. Bu, ikinci bir socket sahibi yaratmayı önleyen mimari
    // değişikliğin ta kendisidir; test de gerçek yolu kullanır.
    mockRegistry['socket'] = mockSocket;
    (window as Record<string, unknown>)['API'] = '';
    mockFetchMessages();
  });

  it('Enter ile mesaj gönderilir', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    const input = container.querySelector('#dm-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Test mesaj' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockSocket.emit).toHaveBeenCalledWith('gdm:send', expect.objectContaining({
      groupId: 'g1',
      content: 'Test mesaj',
      clientNonce: expect.any(String),
    }));
  });

  it('Gönder butonuyla da çalışır', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    const input = container.querySelector('#dm-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Buton test' } });
    await fireEvent.click(container.querySelector('.btn-primary') as HTMLElement);
    expect(mockSocket.emit).toHaveBeenCalledWith('gdm:send', expect.objectContaining({ content: 'Buton test' }));
  });

  it('boş mesaj gönderilmez', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.keyDown(container.querySelector('#dm-input') as HTMLElement, { key: 'Enter' });
    expect(mockSocket.emit).not.toHaveBeenCalledWith('gdm:send', expect.anything());
  });
});

describe('GroupDmPanel — Create modal', () => {
  it('+ butonuyla modal açılır', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 10));
    const plusBtn = container.querySelector('.gdm-sidebar-header .btn-sm') as HTMLElement;
    await fireEvent.click(plusBtn);
    expect(container.querySelector('#gdm-name-input')).toBeTruthy();
  });

  it('grup adı girişi çalışır', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 10));
    await fireEvent.click(container.querySelector('.gdm-sidebar-header .btn-sm') as HTMLElement);
    const nameInput = container.querySelector('#gdm-name-input') as HTMLInputElement;
    await fireEvent.input(nameInput, { target: { value: 'Yeni Grup' } });
    expect(nameInput.value).toBe('Yeni Grup');
  });

  it('İptal butonu modali kapatır', async () => {
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 10));
    await fireEvent.click(container.querySelector('.gdm-sidebar-header .btn-sm') as HTMLElement);
    const cancelBtn = Array.from(container.querySelectorAll('.modal-footer .btn'))
      .find(b => b.textContent?.includes('İptal')) as HTMLElement;
    await fireEvent.click(cancelBtn);
    expect(container.querySelector('#gdm-name-input')).toBeNull();
  });

  it('grup oluşturma API çağrısı yapılır', async () => {
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => ({ _id: 'g3', name: 'Yeni Grup', memberCount: 2 }) });
    mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] }); // reload

    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 10));
    await fireEvent.click(container.querySelector('.gdm-sidebar-header .btn-sm') as HTMLElement);
    await fireEvent.input(container.querySelector('#gdm-name-input') as HTMLElement, { target: { value: 'Yeni Grup' } });
    await fireEvent.input(container.querySelector('#gdm-members-input') as HTMLElement, { target: { value: 'ali' } });
    const createBtn = Array.from(container.querySelectorAll('.modal-footer .btn'))
      .find(b => b.textContent?.includes('Oluştur')) as HTMLElement;
    await fireEvent.click(createBtn);
    await new Promise(r => setTimeout(r, 20));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/gdm'),
      expect.objectContaining({ method: 'POST' }),
    );
  });
});

describe('GroupDmPanel — BridgeRegistry kayıtları', () => {
  it('openGroupDm kayıtlı', async () => {
    renderOpen();
    await new Promise(r => setTimeout(r, 10));
    expect(mockRegistry['groupDmPanel:openGroupDm']).toBeDefined();
  });

  it('loadList kayıtlı', async () => {
    renderOpen();
    await new Promise(r => setTimeout(r, 10));
    expect(mockRegistry['groupDmPanel:loadList']).toBeDefined();
  });

  it('getCurrentGroup kayıtlı', async () => {
    renderOpen();
    await new Promise(r => setTimeout(r, 10));
    const fn = mockRegistry['groupDmPanel:getCurrentGroup'] as Function;
    expect(fn()).toBeNull();
  });

  it('getGroups komut yüzeyine kanonik salt-okunur listeyi verir', async () => {
    renderOpen();
    await new Promise(r => setTimeout(r, 20));
    const fn = mockRegistry['groupDmPanel:getGroups'] as Function;
    expect(fn()).toHaveLength(mockGroups.length);
    expect(fn()).toEqual(expect.arrayContaining(mockGroups.map(group => expect.objectContaining(group))));
  });

  it('başarılı açılış history kimliğini kaydeder ve true döndürür', async () => {
    mockFetch.mockImplementation(async (url: string) => ({
      ok: true,
      json: async () => url.includes('/messages') ? mockMessages : mockGroups,
    }));
    renderOpen();
    await new Promise(r => setTimeout(r, 20));
    const open = mockRegistry['groupDmPanel:openGroupDm'] as (group: typeof mockGroups[number], messageId?: string) => Promise<boolean>;

    expect(await open(mockGroups[0], 'm2')).toBe(true);
    expect(mockRegistry['recordNavigationLocation']).toHaveBeenCalledWith({
      type: 'gdm', group: { _id: 'g1', name: 'Test Grubu' }, messageId: 'm2',
    });
  });

  it('revoked GDM history target returns false and clears the private chat shell', async () => {
    mockFetch.mockImplementation(async (url: string) => (
      url.includes('/messages')
        ? { ok: false, status: 403, json: async () => ({ error: 'Forbidden' }) }
        : { ok: true, json: async () => mockGroups }
    ));
    const { container } = renderOpen();
    await new Promise(r => setTimeout(r, 20));
    const open = mockRegistry['groupDmPanel:openGroupDm'] as (group: typeof mockGroups[number]) => Promise<boolean>;

    expect(await open(mockGroups[0])).toBe(false);
    expect(mockRegistry['recordNavigationLocation']).not.toHaveBeenCalled();
    expect(container.querySelector('#dm-chat-header')).toBeNull();
    expect(container.querySelector('.gdm-placeholder')).not.toBeNull();
  });
});

describe('GroupDmPanel — ADR-0008 sınır kontrolü', () => {
  it('vanilla socket doğrudan import edilmez', () => {
    // Faz 12 — SIRA BAĞIMLILIĞI KALDIRILDI.
    // Test `render()` çağırmadan `mockRegistry`de kayıt bekliyordu; yani
    // önceki bir testin bıraktığı sızan duruma güveniyordu. Tek başına
    // koşturulduğunda kayıt yoktu ve `undefined` alıyordu.
    // Bileşen kendisi mount edilerek sözleşme doğrudan doğrulanır.
    renderOpen();

    // Bileşen socket'e `window.socket` üzerinden erişir, doğrudan import etmez;
    // kanonik yüzeyini BridgeRegistry üzerinden yayımlar.
    expect(typeof mockRegistry['groupDmPanel:openGroupDm']).toBe('function');
    expect(typeof mockRegistry['groupDmPanel:loadList']).toBe('function');
  });

  it('kapatma düğmesi önce kanonik görünürlüğü kapatır, sonra onClose bildirir', async () => {
    const onClose = vi.fn();
    const { container } = renderOpen({ props: { onClose } });
    const closeBtn = Array.from(container.querySelectorAll<HTMLButtonElement>('.gdm-sidebar-header .btn-sm'))
      .find(button => button.getAttribute('aria-label')?.includes('kapat'));
    expect(closeBtn).toBeTruthy();

    await fireEvent.click(closeBtn!);

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(container.querySelector('#gdm-panel')).toBeNull();
  });
});

// ── Production-deep lifecycle / CRUD coverage ─────────────────────────────

class GdmSocketBus {
  listeners = new Map<string, Set<(payload: unknown) => void>>();
  emitted: Array<{ event: string; payload: unknown }> = [];

  on(event: string, fn: (payload: unknown) => void): void {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
  }

  off(event: string, fn: (payload: unknown) => void): void {
    this.listeners.get(event)?.delete(fn);
  }

  emit(event: string, payload: unknown): void {
    this.emitted.push({ event, payload });
  }

  fire(event: string, payload: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(payload);
    flushSync();
  }

  count(event: string): number { return this.listeners.get(event)?.size ?? 0; }
}

const richOwnerGroup = {
  _id: 'g-owner',
  name: 'Owner Group',
  icon: '🛡️',
  ownerId: 'me',
  memberCount: 2,
  unreadCount: 120,
  lastMessage: { content: '<img src=x onerror=alert(1)> a very long preview that is clipped after forty characters' },
  members: [
    { _id: 'me', displayName: 'Ben', avatarColor: '#111111', username: 'ben' },
    { id: 'u2', displayName: 'Ali', avatarColor: '#222222', username: 'ali' },
  ],
};

const richMessages = [
  { _id: 'system-1', groupId: 'g-owner', displayName: 'System', avatarColor: '#000', content: 'Ali joined', createdAt: 1, type: 'system' },
  { _id: 'saved-1', groupId: 'g-owner', userId: 'u2', displayName: 'Ali', avatarColor: '#222', content: '<svg onload=alert(1)>', createdAt: 2 },
];

function okJson(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response;
}

function installRichApi(options: {
  groups?: unknown[];
  messages?: unknown[];
  extra?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined;
} = {}): void {
  mockFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    const extra = options.extra?.(url, init);
    if (extra) return extra;
    if (url.includes('/messages')) return okJson(options.messages ?? richMessages);
    if (url === '/api/gdm') return okJson(options.groups ?? [richOwnerGroup]);
    if (url === `/api/gdm/${richOwnerGroup._id}`) return okJson(richOwnerGroup);
    return okJson({});
  });
}

async function settle(): Promise<void> {
  await Promise.resolve();
  await new Promise(resolve => setTimeout(resolve, 0));
  flushSync();
}

async function chooseProductDialog(action: 'confirm' | 'cancel'): Promise<void> {
  await Promise.resolve();
  const button = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
  if (!button) throw new Error(`product dialog ${action} button not found`);
  await fireEvent.click(button);
  await settle();
}

async function openRichGroup(group = richOwnerGroup) {
  const rendered = renderOpen();
  await settle();
  const open = mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof group, messageId?: string) => Promise<boolean>;
  expect(await open(group)).toBe(true);
  await settle();
  return rendered;
}

describe('GroupDmPanel — deep socket lifecycle and live truth', () => {
  it('binds all canonical events, applies safe updates, rebinds by socket identity, and tears down exactly', async () => {
    installRichApi();
    const oldSocket = new GdmSocketBus();
    mockRegistry.socket = oldSocket;
    const rendered = await openRichGroup();

    expect(oldSocket.count('gdm:message')).toBe(1);
    expect(oldSocket.count('gdm:updated')).toBe(1);
    expect(oldSocket.count('gdm:deleted')).toBe(1);

    oldSocket.fire('gdm:updated', null);
    oldSocket.fire('gdm:updated', {});
    oldSocket.fire('gdm:updated', { ...richOwnerGroup, name: 'Server Renamed', icon: '✅' });
    expect(rendered.container.textContent).toContain('Server Renamed');
    expect(rendered.container.textContent).toContain('✅');

    oldSocket.fire('gdm:message', { groupId: 'other', _id: 'cross', content: 'CROSS GROUP', displayName: 'Mallory', avatarColor: '#000', createdAt: 3 });
    oldSocket.fire('gdm:message', null);
    oldSocket.fire('gdm:message', { groupId: 'g-owner', _id: 'live', content: '<img src=x onerror=alert(1)>', displayName: 'Mallory', avatarColor: '#000', createdAt: 3 });
    expect(rendered.container.textContent).not.toContain('CROSS GROUP');
    expect(rendered.container.textContent).toContain('<img src=x onerror=alert(1)>');
    expect(rendered.container.querySelector('.dm-msg-text img')).toBeNull();
    expect(oldSocket.emitted).toContainEqual({ event: 'gdm:read', payload: { groupId: 'g-owner' } });

    const replacement = new GdmSocketBus();
    mockRegistry.socket = replacement;
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    expect(oldSocket.count('gdm:message')).toBe(0);
    expect(oldSocket.count('gdm:updated')).toBe(0);
    expect(oldSocket.count('gdm:deleted')).toBe(0);
    expect(replacement.count('gdm:message')).toBe(1);
    expect(replacement.count('gdm:updated')).toBe(1);
    expect(replacement.count('gdm:deleted')).toBe(1);

    replacement.fire('gdm:deleted', null);
    replacement.fire('gdm:deleted', { groupId: 'other' });
    expect(rendered.container.querySelector('#dm-chat-header')).toBeTruthy();
    replacement.fire('gdm:deleted', { groupId: 'g-owner' });
    expect(rendered.container.querySelector('#dm-chat-header')).toBeNull();

    rendered.unmount();
    expect(replacement.count('gdm:message')).toBe(0);
    expect(replacement.count('gdm:updated')).toBe(0);
    expect(replacement.count('gdm:deleted')).toBe(0);
    for (const key of ['showGroupDmPanel', 'openGroupDmPanel', 'closeGroupDmPanel', 'groupDmPanel:openGroupDm', 'groupDmPanel:loadList', 'groupDmPanel:getGroups', 'groupDmPanel:getCurrentGroup']) {
      expect(mockRegistry[key]).toBeUndefined();
    }
  });

  it('keeps hidden Escape inert, then closes only the top layer before closing panel state', async () => {
    installRichApi();
    const rendered = render(GroupDmPanel);
    await settle();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(rendered.container.querySelector('#gdm-panel')).toBeNull();

    (mockRegistry.showGroupDmPanel as () => void)();
    flushSync();
    await fireEvent.click(rendered.container.querySelector('[title="Yeni Grup"]') as HTMLElement);
    expect(rendered.container.querySelector('#gdm-name-input')).toBeTruthy();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(rendered.container.querySelector('#gdm-panel')).toBeTruthy();
    expect(rendered.container.querySelector('#gdm-name-input')).toBeNull();
    await fireEvent.keyDown(window, { key: 'Escape' });
    expect(rendered.container.querySelector('#gdm-panel')).toBeNull();
    expect((mockRegistry['groupDmPanel:getCurrentGroup'] as () => unknown)()).toBeNull();
  });
});

describe('GroupDmPanel — deep rendering, navigation, and persistence', () => {
  it('renders unread/preview/system/member variants, opens by Space, and saves only addressable messages', async () => {
    installRichApi();
    const socket = new GdmSocketBus();
    const save = vi.fn();
    mockRegistry.socket = socket;
    mockRegistry.saveForLater = save;
    const { container } = renderOpen();
    await settle();

    expect(container.querySelector('.gdm-unread')?.textContent).toContain('99+');
    expect(container.querySelector('.gdm-item-preview')?.textContent).toContain('<img src=x');
    expect(container.querySelector('.gdm-item-preview img')).toBeNull();
    const item = container.querySelector('.gdm-item') as HTMLElement;
    const keyEvent = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    item.dispatchEvent(keyEvent);
    await settle();
    expect(keyEvent.defaultPrevented).toBe(true);
    expect(container.textContent).toContain('Ali joined');
    expect(container.textContent).toContain('<svg onload=alert(1)>');

    await fireEvent.click(container.querySelector('.dm-msg-save') as HTMLElement);
    expect(save).toHaveBeenCalledWith({
      destinationType: 'gdm', destinationId: 'g-owner', messageId: 'saved-1',
    });
    expect(container.querySelector('.gdm-system-msg .dm-msg-save')).toBeNull();
    expect(socket.emitted).toContainEqual({ event: 'gdm:join', payload: 'g-owner' });
  });

  it('guards stale history responses when the panel is closed mid-flight', async () => {
    let resolveMessages!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { resolveMessages = resolve; });
    installRichApi({ extra: url => url.includes('/messages') ? pending : undefined });
    const rendered = renderOpen();
    await settle();
    const opening = (mockRegistry['groupDmPanel:openGroupDm'] as (group: typeof richOwnerGroup) => Promise<boolean>)(richOwnerGroup);
    (mockRegistry.closeGroupDmPanel as () => void)();
    resolveMessages(okJson(richMessages));
    expect(await opening).toBe(false);
    await settle();
    expect(rendered.container.querySelector('#gdm-panel')).toBeNull();
    expect((mockRegistry['groupDmPanel:getCurrentGroup'] as () => unknown)()).toBeNull();
  });
});

describe('GroupDmPanel — deep create/member/settings/leave flows', () => {
  it('validates create inputs and preserves server errors before resetting on success', async () => {
    let createAttempts = 0;
    installRichApi({ extra: (url, init) => {
      if (url === '/api/gdm' && init?.method === 'POST') {
        createAttempts += 1;
        return createAttempts === 1
          ? okJson({ error: 'Server refused' }, false)
          : okJson({ ...richOwnerGroup, _id: 'g-created', name: 'New Group' });
      }
      if (url.includes('/g-created/messages')) return okJson([]);
      return undefined;
    } });
    const { container } = renderOpen();
    await settle();
    await fireEvent.click(container.querySelector('[title="Yeni Grup"]') as HTMLElement);
    const create = () => Array.from(container.querySelectorAll('.modal-footer .btn')).find(button => button.textContent?.includes('Oluştur')) as HTMLElement;

    await fireEvent.click(create());
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('Grup adı'), 'error');
    await fireEvent.input(container.querySelector('#gdm-name-input') as HTMLElement, { target: { value: 'New Group' } });
    await fireEvent.click(create());
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('En az'), 'error');
    await fireEvent.input(container.querySelector('#gdm-members-input') as HTMLElement, { target: { value: 'stranger' } });
    await fireEvent.click(create());
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('stranger'), 'warning');

    await fireEvent.input(container.querySelector('#gdm-members-input') as HTMLElement, { target: { value: ' ali, veli ' } });
    await fireEvent.click(create());
    await settle();
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('Oluşturulamadı'), 'error');
    expect(container.querySelector('#gdm-name-input')).toBeTruthy();

    await fireEvent.click(create());
    await settle();
    const post = mockFetch.mock.calls.filter(call => call[1]?.method === 'POST').at(-1)!;
    expect(JSON.parse(String(post[1]?.body))).toEqual({ name: 'New Group', icon: null, memberIds: ['u2', 'u3'] });
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('New Group'), 'success');
    expect(container.querySelector('#gdm-name-input')).toBeNull();
  });

  it('adds and removes members through owner-only controls with confirmation and fresh server truth', async () => {
    const updated = { ...richOwnerGroup, memberCount: 3, members: [...richOwnerGroup.members, { _id: 'u3', displayName: 'Veli', avatarColor: '#333', username: 'veli' }] };
    installRichApi({ extra: (url, init) => {
      if (url.endsWith('/members') && init?.method === 'POST') return okJson({});
      if (url.endsWith('/members/u2') && init?.method === 'DELETE') return okJson({});
      if (url === '/api/gdm/g-owner') return okJson(updated);
      return undefined;
    } });
    const { container } = await openRichGroup();
    await fireEvent.click(container.querySelector('[title="Grup Bilgisi"]') as HTMLElement);
    expect(container.textContent).toContain('Sen sahipsin');
    expect(container.querySelector('.gdm-owner-badge')).toBeTruthy();

    await fireEvent.input(container.querySelector('#gdm-add-member') as HTMLElement, { target: { value: 'stranger' } });
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement);
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('stranger'), 'error');
    await fireEvent.input(container.querySelector('#gdm-add-member') as HTMLElement, { target: { value: 'veli' } });
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement);
    await settle();
    expect(mockFetch).toHaveBeenCalledWith('/api/gdm/g-owner/members', expect.objectContaining({ method: 'POST' }));
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('veli'), 'success');

    // Reopen info after fresh owner truth, then exercise cancel and confirmed removal.
    await fireEvent.click(container.querySelector('[title="Grup Bilgisi"]') as HTMLElement);
    let remove = Array.from(container.querySelectorAll('.gdm-member-row .btn-danger')).find(button => button.textContent?.includes('Çıkar')) as HTMLElement;
    await fireEvent.click(remove);
    await chooseProductDialog('cancel');
    expect(mockFetch).not.toHaveBeenCalledWith(expect.stringContaining('/members/u2'), expect.anything());
    remove = Array.from(container.querySelectorAll('.gdm-member-row .btn-danger')).find(button => button.textContent?.includes('Çıkar')) as HTMLElement;
    await fireEvent.click(remove);
    expect(document.querySelector('.bridge-product-dialog')?.textContent).toContain('Ali');
    await chooseProductDialog('confirm');
    expect(mockFetch).toHaveBeenCalledWith('/api/gdm/g-owner/members/u2', { method: 'DELETE' });
  });

  it('validates and persists owner settings, then delegates voice/video calls to the canonical owner', async () => {
    let patchAttempts = 0;
    installRichApi({ extra: (url, init) => {
      if (url === '/api/gdm/g-owner' && init?.method === 'PATCH') {
        patchAttempts += 1;
        return patchAttempts === 1 ? okJson({ error: 'Rename refused' }, false) : okJson({});
      }
      return undefined;
    } });
    const startCall = vi.fn();
    mockRegistry.startGdmCall = startCall;
    const { container } = await openRichGroup();

    await fireEvent.click(container.querySelector('[title="Ayarlar"]') as HTMLElement);
    const name = container.querySelector('#gdm-settings-name') as HTMLInputElement;
    await fireEvent.input(name, { target: { value: '   ' } });
    await fireEvent.click(container.querySelector('#gdm-settings-name')?.closest('.modal-card')?.querySelector('.btn-primary') as HTMLElement);
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('boş'), 'error');
    await fireEvent.input(name, { target: { value: ' Renamed Group ' } });
    await fireEvent.input(container.querySelector('#gdm-settings-icon') as HTMLElement, { target: { value: '  ' } });
    const save = container.querySelector('#gdm-settings-name')?.closest('.modal-card')?.querySelector('.btn-primary') as HTMLElement;
    await fireEvent.click(save);
    await settle();
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('Güncellenemedi'), 'error');
    await fireEvent.click(save);
    await settle();
    expect(mockFetch).toHaveBeenCalledWith('/api/gdm/g-owner', expect.objectContaining({
      method: 'PATCH', body: JSON.stringify({ name: 'Renamed Group', icon: null }),
    }));
    expect(container.textContent).toContain('Renamed Group');

    await fireEvent.click(container.querySelector('[title="Sesli Arama"]') as HTMLElement);
    await fireEvent.click(container.querySelector('[title*="Arama"]:not([title="Sesli Arama"])') as HTMLElement);
    expect(startCall).toHaveBeenNthCalledWith(1, 'voice', 'g-owner');
    expect(startCall).toHaveBeenNthCalledWith(2, 'video', 'g-owner');
  });

  it('keeps a group on cancelled/failed leave, then clears owner and member state on success', async () => {
    let deleteAttempts = 0;
    installRichApi({ extra: (url, init) => {
      if (url === '/api/gdm/g-owner' && init?.method === 'DELETE') {
        deleteAttempts += 1;
        return deleteAttempts === 1 ? okJson({ error: 'Delete refused' }, false) : okJson({});
      }
      return undefined;
    } });
    const { container } = await openRichGroup();
    const leave = () => container.querySelector('.gdm-header-actions > .btn-danger') as HTMLElement;

    await fireEvent.click(leave());
    await chooseProductDialog('cancel');
    expect(mockFetch).not.toHaveBeenCalledWith('/api/gdm/g-owner', expect.objectContaining({ method: 'DELETE' }));
    await fireEvent.click(leave());
    expect(document.querySelector('.bridge-product-dialog')?.textContent).toContain('Tüm mesajlar');
    await chooseProductDialog('confirm');
    expect(toastMock).toHaveBeenLastCalledWith(expect.stringContaining('İşlem başarısız'), 'error');
    await fireEvent.click(leave());
    await chooseProductDialog('confirm');
    expect(container.querySelector('#dm-chat-header')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('dağıtıldı'), 'success');
  });
});

describe('GroupDmPanel — hostile payload normalization and ordering', () => {
  it('normalizes, bounds, and deduplicates list/member payloads without keyed-render failures', async () => {
    activeMe = { _id: 'me', displayName: 'Me by _id' };
    const hostile = {
      _id: ' g-safe ', name: 42, icon: '123456789-too-long', ownerId: 'me',
      memberCount: -9, unreadCount: Number.MAX_SAFE_INTEGER + 1,
      lastMessage: { content: 7 },
      members: [
        null, {},
        { _id: ' member ', displayName: 5, username: ' ada ', avatarColor: 'red;position:fixed' },
        { id: 'member', displayName: 'duplicate', avatarColor: '#fff' },
      ],
    };
    mockFetch.mockResolvedValue(okJson([null, [], {}, hostile, { ...hostile, name: 'duplicate' }]));
    const { container } = renderOpen();
    await settle();

    expect(container.querySelectorAll('.gdm-item')).toHaveLength(1);
    expect(container.textContent).toContain('Group DM');
    expect(container.textContent).toContain('0 üye');
    expect(container.querySelector('.gdm-unread')).toBeNull();
    const groups = (mockRegistry['groupDmPanel:getGroups'] as () => Array<Record<string, unknown>>)();
    expect(groups[0]).toMatchObject({ _id: 'g-safe', name: 'Group DM', icon: '12345678', memberCount: 0, unreadCount: 0 });
    expect((groups[0]?.members as unknown[])).toHaveLength(1);
  });

  it('accepts only the newest overlapping list request', async () => {
    let resolveFirst!: (value: Response) => void;
    let resolveSecond!: (value: Response) => void;
    const first = new Promise<Response>(resolve => { resolveFirst = resolve; });
    const second = new Promise<Response>(resolve => { resolveSecond = resolve; });
    let calls = 0;
    mockFetch.mockImplementation(() => { calls += 1; return calls === 1 ? first : second; });
    render(GroupDmPanel);
    await Promise.resolve();
    (mockRegistry.showGroupDmPanel as () => void)();
    expect(calls).toBe(2);

    resolveSecond(okJson([{ _id: 'new', name: 'New truth' }]));
    await settle();
    resolveFirst(okJson([{ _id: 'old', name: 'Stale truth' }]));
    await settle();
    const groups = (mockRegistry['groupDmPanel:getGroups'] as () => Array<{ _id: string }>)();
    expect(groups.map(group => group._id)).toEqual(['new']);
  });

  it('contains list transport/HTTP/JSON failures and recovers through the registered loader', async () => {
    mockFetch.mockRejectedValue(new Error('offline'));
    const { container } = renderOpen();
    await settle();
    expect(container.querySelector('[role="alert"]')).toHaveTextContent(/yüklenemedi/i);

    mockFetch.mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) });
    await (mockRegistry['groupDmPanel:loadList'] as () => Promise<void>)();
    expect(container.querySelector('[role="alert"]')).toHaveTextContent(/yüklenemedi/i);

    mockFetch.mockResolvedValueOnce({ ok: true, status: 200, json: async () => { throw new Error('bad json'); } });
    await (mockRegistry['groupDmPanel:loadList'] as () => Promise<void>)();
    expect(container.querySelector('[role="alert"]')).toHaveTextContent(/yüklenemedi/i);

    mockFetch.mockResolvedValueOnce(okJson([{ _id: 'recovered', name: 'Recovered' }]));
    await (mockRegistry['groupDmPanel:loadList'] as () => Promise<void>)();
    flushSync();
    expect(container.textContent).toContain('Recovered');
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it('filters malformed and duplicate history/live messages and applies safe fallbacks', async () => {
    activeMe = { _id: 'me' };
    const messages = [
      null, {}, { _id: 'no-content', content: 7 },
      { _id: 'm1', groupId: 'g-owner', userId: 'me', content: 'hello', displayName: 9, avatarColor: 'red;position:fixed', createdAt: {} },
      { _id: 'm1', groupId: 'g-owner', content: 'duplicate', displayName: 'Duplicate', avatarColor: '#fff', createdAt: 2 },
      { groupId: 'g-owner', content: 'idless one', displayName: 'Anon', avatarColor: '#abc', createdAt: 3 },
      { groupId: 'g-owner', content: 'idless two', displayName: 'Anon', avatarColor: '#abcd', createdAt: 3 },
    ];
    installRichApi({ messages });
    const socket = new GdmSocketBus();
    mockRegistry.socket = socket;
    const { container } = await openRichGroup();
    expect(container.querySelectorAll('.dm-msg')).toHaveLength(3);
    expect(container.textContent).toContain('Bridge user');
    expect((container.querySelector('.dm-msg-avatar') as HTMLElement).style.background).not.toContain('position');

    socket.fire('gdm:message', { _id: 'm1', groupId: 'g-owner', content: 'duplicate live', displayName: 'X', avatarColor: '#fff', createdAt: 4 });
    socket.fire('gdm:message', { _id: 'live', groupId: 'g-owner', content: 7, displayName: 'X', avatarColor: '#fff', createdAt: 4 });
    expect(container.textContent).not.toContain('duplicate live');
    expect(container.querySelectorAll('.dm-msg')).toHaveLength(3);
  });

  it('rejects malformed direct-open targets without exposing a private chat shell', async () => {
    installRichApi();
    const { container } = renderOpen();
    const open = mockRegistry['groupDmPanel:openGroupDm'] as (value: unknown) => Promise<boolean>;
    expect(await open({ name: 'missing id' })).toBe(false);
    expect(container.querySelector('#dm-chat-header')).toBeNull();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('kullanılamıyor'), 'warning');
  });

  it('renders legacy-id members, low unread counts, missing optional fields, and non-owner fallbacks', async () => {
    activeMe = null;
    const group = {
      _id: 'fallbacks', name: '   ', ownerId: 'someone-else', unreadCount: 2,
      members: [{ id: 'legacy-member', username: 'legacy', displayName: 'Legacy Member', avatarColor: '#123' }],
    };
    installRichApi({ groups: [group], messages: [{
      groupId: 'fallbacks', content: 'fallback message', displayName: '   ', avatarColor: '#123', createdAt: 'bad-date',
    }] });
    const { container } = renderOpen();
    await settle();
    expect(container.querySelector('.gdm-unread')).toHaveTextContent('2');
    expect(container.querySelector('.gdm-item-count')).toHaveTextContent('0 üye');
    expect(container.querySelector('.gdm-item-icon')).toHaveTextContent('👥');
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await settle();
    expect(container.textContent).toContain('Bridge user');
    expect(container.querySelector('.dm-msg-avatar')).toHaveTextContent('BR');
    await fireEvent.click(container.querySelector('[title="Grup Bilgisi"]') as HTMLElement);
    expect(container.textContent).toContain('Üyesin');
    expect(container.querySelector('.gdm-member-row')).toHaveTextContent('Legacy Member');
    expect(container.querySelector('.gdm-member-row .gdm-owner-badge')).toBeNull();
    expect(container.querySelector('.gdm-member-row .btn-danger')).toBeNull();
  });

  it('treats non-array list/history bodies as empty and supports both empty-state create entry points', async () => {
    mockFetch.mockResolvedValue(okJson({ rows: [] }));
    const { container } = renderOpen();
    await settle();
    expect((mockRegistry['groupDmPanel:getGroups'] as () => unknown[])()).toEqual([]);
    await fireEvent.click(container.querySelector('.gdm-empty .btn-link') as HTMLElement);
    expect(container.querySelector('#gdm-name-input')).not.toBeNull();
    await fireEvent.click(container.querySelector('.modal-footer .btn:not(.btn-primary)') as HTMLElement);
    await fireEvent.click(container.querySelector('.gdm-placeholder .btn-link') as HTMLElement);
    expect(container.querySelector('#gdm-name-input')).not.toBeNull();

    // Backdrop closes only when it is the actual event target.
    const overlay = container.querySelector('.modal-overlay') as HTMLElement;
    await fireEvent.click(overlay.querySelector('.modal-card') as HTMLElement);
    expect(container.querySelector('#gdm-name-input')).not.toBeNull();
    await fireEvent.click(overlay);
    expect(container.querySelector('#gdm-name-input')).toBeNull();

    mockFetch.mockResolvedValueOnce(okJson({ messages: [] }));
    expect(await (mockRegistry['groupDmPanel:openGroupDm'] as (value: unknown) => Promise<boolean>)({ _id: 'empty-history', name: 'Empty History' })).toBe(true);
    await settle();
    expect(container.querySelectorAll('.dm-msg')).toHaveLength(0);
  });

  it('fails closed when the canonical API owner is missing', async () => {
    delete mockRegistry.apiFetch;
    const { container } = renderOpen();
    await settle();
    expect(container.querySelector('[role="alert"]')).toHaveTextContent(/yüklenemedi/i);
  });
});

describe('GroupDmPanel — private lifecycle and reconnect convergence', () => {
  it('clears all private state on logout and invalidates an in-flight history response', async () => {
    let resolveHistory!: (value: Response) => void;
    const pending = new Promise<Response>(resolve => { resolveHistory = resolve; });
    installRichApi({ extra: url => url.includes('/messages') ? pending : undefined });
    const rendered = renderOpen();
    await settle();
    const opening = (mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof richOwnerGroup) => Promise<boolean>)(richOwnerGroup);
    document.dispatchEvent(new CustomEvent('bridge:auth-logout'));
    flushSync();
    resolveHistory(okJson(richMessages));
    expect(await opening).toBe(false);
    await settle();
    expect(rendered.container.querySelector('#gdm-panel')).toBeNull();
    expect((mockRegistry['groupDmPanel:getGroups'] as () => unknown[])()).toEqual([]);
    expect((mockRegistry['groupDmPanel:getCurrentGroup'] as () => unknown)()).toBeNull();
  });

  it('does not refetch while hidden, then refreshes both list and open history on reconnect', async () => {
    installRichApi();
    const socket = new GdmSocketBus();
    mockRegistry.socket = socket;
    render(GroupDmPanel);
    await settle();
    const initial = mockFetch.mock.calls.length;
    document.dispatchEvent(new CustomEvent('bridge:socket-ready'));
    await settle();
    expect(mockFetch.mock.calls.length).toBe(initial);

    (mockRegistry.showGroupDmPanel as () => void)();
    await settle();
    const visibleWithoutSelection = mockFetch.mock.calls.length;
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await settle();
    const noSelectionCalls = mockFetch.mock.calls.slice(visibleWithoutSelection).map(call => String(call[0]));
    expect(noSelectionCalls).toContain('/api/gdm');
    expect(noSelectionCalls.some(url => url.includes('/messages'))).toBe(false);

    await (mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof richOwnerGroup) => Promise<boolean>)(richOwnerGroup);
    await settle();
    const beforeReconnect = mockFetch.mock.calls.length;
    document.dispatchEvent(new CustomEvent('bridge:socket-reconnected'));
    await settle();
    const reconnectCalls = mockFetch.mock.calls.slice(beforeReconnect).map(call => String(call[0]));
    expect(reconnectCalls.some(url => url === '/api/gdm')).toBe(true);
    expect(reconnectCalls.some(url => url.includes('/g-owner/messages'))).toBe(true);
  });

  it('scrolls a saved target with reduced motion and reports a target outside the page', async () => {
    installRichApi();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    vi.stubGlobal('matchMedia', vi.fn(() => ({ matches: true })));
    const { container } = renderOpen();
    await settle();
    const open = mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof richOwnerGroup, id?: string) => Promise<boolean>;
    expect(await open(richOwnerGroup, 'saved-1')).toBe(true);
    await settle();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'center' });
    expect(container.querySelector('[data-id="saved-1"]')).toHaveClass('dm-msg-highlight');

    expect(await open(richOwnerGroup, 'not-on-page')).toBe(true);
    await settle();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('son geçmiş sayfasında değil'), 'warning');
  });

  it('bounds outgoing content and exercises lazy voice fallback/not-ready states', async () => {
    installRichApi();
    const winStart = vi.fn();
    (window as Record<string, unknown>).startGdmCall = winStart;
    const { container } = await openRichGroup();
    const input = container.querySelector('#dm-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'x'.repeat(2_001) } });
    await fireEvent.click(container.querySelector('.gdm-input-area .btn-primary') as HTMLElement);
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('uzun'), 'error');

    await fireEvent.click(container.querySelector('[title="Sesli Arama"]') as HTMLElement);
    await new Promise(resolve => setTimeout(resolve, 70));
    expect(winStart).toHaveBeenCalledWith('voice');
    await fireEvent.click(container.querySelector('[title*="Arama"]:not([title="Sesli Arama"])') as HTMLElement);
    expect(winStart).toHaveBeenCalledWith('video');
    delete (window as Record<string, unknown>).startGdmCall;
    await fireEvent.click(container.querySelector('[title="Sesli Arama"]') as HTMLElement);
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('hazır değil'), 'error');
  });

  it('deduplicates id-less live messages, ignores unrelated updates, and tolerates a removed scroll area', async () => {
    installRichApi();
    const socket = new GdmSocketBus();
    mockRegistry.socket = socket;
    const { container } = await openRichGroup();
    socket.fire('gdm:updated', { ...richOwnerGroup, _id: 'other-valid', name: 'Other valid' });
    expect(container.textContent).not.toContain('Other valid');

    socket.fire('gdm:message', { groupId: 'g-owner', content: 'idless live', displayName: 'Live', avatarColor: '#abcdef', createdAt: 8 });
    expect(container.textContent).toContain('idless live');
    (mockRegistry.closeGroupDmPanel as () => void)();
    await settle();
    expect(container.querySelector('#gdm-messages')).toBeNull();
  });

  it('scrolls live messages while attached and preserves the group when a legacy-id member refresh is malformed', async () => {
    let addBody: { userId?: string } | null = null;
    installRichApi({ extra: (url, init) => {
      if (url.endsWith('/members') && init?.method === 'POST') {
        addBody = JSON.parse(String(init.body)) as { userId?: string };
        return okJson({});
      }
      if (url === '/api/gdm/g-owner' && !init?.method) return okJson({ invalid: true });
      return undefined;
    } });
    const socket = new GdmSocketBus();
    mockRegistry.socket = socket;
    const { container } = await openRichGroup();

    socket.fire('gdm:message', { _id: 'live-scroll', groupId: 'g-owner', content: 'scroll me', displayName: 'Live', avatarColor: '#abc', createdAt: 9 });
    await settle();
    expect(container.textContent).toContain('scroll me');

    await fireEvent.click(container.querySelector('[title="Grup Bilgisi"]') as HTMLElement);
    await fireEvent.input(container.querySelector('#gdm-add-member') as HTMLElement, { target: { value: 'idonly' } });
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement);
    await settle();
    expect(addBody).toEqual({ userId: 'u4' });
    expect((mockRegistry['groupDmPanel:getCurrentGroup'] as () => { _id: string })()._id).toBe('g-owner');
  });

  it('opens through the alias and uses smooth scrolling when reduced motion is unavailable', async () => {
    installRichApi();
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });
    vi.stubGlobal('matchMedia', undefined);
    render(GroupDmPanel);
    (mockRegistry.openGroupDmPanel as () => void)();
    await settle();
    const open = mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof richOwnerGroup, id?: string) => Promise<boolean>;
    expect(await open(richOwnerGroup, 'saved-1')).toBe(true);
    await settle();
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'center' });
  });

  it('keeps detached action callbacks fail-closed after access is revoked', async () => {
    installRichApi();
    const socket = new GdmSocketBus();
    mockRegistry.socket = socket;
    const { container } = await openRichGroup();
    const sendButton = container.querySelector('.gdm-input-area .btn-primary') as HTMLElement;
    const saveButton = container.querySelector('.dm-msg-save') as HTMLElement;
    const infoButton = container.querySelector('[title="Grup Bilgisi"]') as HTMLElement;
    const settingsButton = container.querySelector('[title="Ayarlar"]') as HTMLElement;
    const leaveButton = container.querySelector('.gdm-header-actions > .btn-danger') as HTMLElement;
    const voiceButton = container.querySelector('[title="Sesli Arama"]') as HTMLElement;

    await fireEvent.click(infoButton);
    const addButton = container.querySelector('.modal-card .btn-primary') as HTMLElement;
    const kickButton = container.querySelector('.gdm-member-row .btn-danger') as HTMLElement;
    await fireEvent.click(container.querySelector('.modal-footer .btn') as HTMLElement);
    await fireEvent.click(settingsButton);
    const settingsSave = container.querySelector('.modal-card .btn-primary') as HTMLElement;
    await fireEvent.click(container.querySelector('.modal-footer .btn:not(.btn-primary)') as HTMLElement);

    const controls = [sendButton, saveButton, addButton, kickButton, settingsButton, settingsSave, leaveButton, voiceButton];
    const detachedHandlers = controls.map(control => {
      const eventsKey = Reflect.ownKeys(control).find(key => typeof key === 'symbol' && key.description === 'events');
      const events = eventsKey ? (control as unknown as Record<PropertyKey, { click?: (event: MouseEvent) => unknown }>)[eventsKey] : null;
      const handler = events?.click;
      expect(handler).toBeTypeOf('function');
      return handler!;
    });

    socket.fire('gdm:deleted', { groupId: 'g-owner' });
    socket.fire('gdm:message', { groupId: 'g-owner', content: 'after revoke' });
    const callsBefore = mockFetch.mock.calls.length;
    for (let index = 0; index < controls.length; index += 1) {
      detachedHandlers[index]!.call(controls[index], new MouseEvent('click'));
    }
    await settle();
    expect(mockFetch.mock.calls).toHaveLength(callsBefore);
    expect(container.querySelector('#dm-chat-header')).toBeNull();
    expect(container.textContent).not.toContain('after revoke');
  });

  it('uses built-in color/initial fallbacks and renders missing group/member metadata safely', async () => {
    provideCssColor = false;
    provideInitials = false;
    activeMe = { id: 7 as unknown as string, displayName: 8 as unknown as string };
    const bare = { _id: 'bare', name: 'Bare', ownerId: 'other' };
    installRichApi({ groups: [bare], messages: [{
      groupId: 'bare', content: 'bare message', displayName: 'Alpha', avatarColor: '#abcdef', createdAt: 1,
    }] });
    const { container } = renderOpen();
    await settle();
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await settle();
    expect(container.querySelector('.gdm-header-count')).toHaveTextContent('0 üye');
    expect(container.querySelector('.dm-msg-avatar')).toHaveTextContent('AL');
    expect((container.querySelector('.dm-msg-avatar') as HTMLElement).style.background).not.toBe('');

    await fireEvent.click(container.querySelector('[title="Grup Bilgisi"]') as HTMLElement);
    expect(container.querySelectorAll('.gdm-member-row')).toHaveLength(0);
    const infoOverlay = container.querySelector('.modal-overlay') as HTMLElement;
    await fireEvent.click(infoOverlay.querySelector('.modal-card') as HTMLElement);
    expect(container.querySelector('.modal-overlay')).not.toBeNull();
    await fireEvent.click(infoOverlay);
    expect(container.querySelector('.modal-overlay')).toBeNull();
  });
});

describe('GroupDmPanel — contained mutation failures', () => {
  it('contains create/member/settings/leave transport failures without losing the open group', async () => {
    installRichApi({ extra: (url, init) => {
      if (init?.method && init.method !== 'GET') throw new Error(`offline ${init.method}`);
      return undefined;
    } });
    const { container } = renderOpen();
    await settle();
    await fireEvent.click(container.querySelector('[title="Yeni Grup"]') as HTMLElement);
    await fireEvent.input(container.querySelector('#gdm-name-input') as HTMLElement, { target: { value: 'Network Group' } });
    await fireEvent.input(container.querySelector('#gdm-members-input') as HTMLElement, { target: { value: 'ali' } });
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement);
    await settle();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Bağlantı'), 'error');

    // Re-open canonical server truth after the failed creation.
    await (mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof richOwnerGroup) => Promise<boolean>)(richOwnerGroup);
    await settle();
    await fireEvent.click(container.querySelector('[title="Grup Bilgisi"]') as HTMLElement);
    await fireEvent.input(container.querySelector('#gdm-add-member') as HTMLElement, { target: { value: 'ali' } });
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement);
    await settle();
    expect(container.querySelector('#dm-chat-header')).not.toBeNull();

    // Close info, exercise settings and leave transport containment.
    await fireEvent.click(Array.from(container.querySelectorAll('.modal-footer .btn')).find(button => button.textContent?.includes('Kapat')) as HTMLElement);
    await fireEvent.click(container.querySelector('[title="Ayarlar"]') as HTMLElement);
    await fireEvent.click(container.querySelector('#gdm-settings-name')?.closest('.modal-card')?.querySelector('.btn-primary') as HTMLElement);
    await settle();
    expect(container.querySelector('#dm-chat-header')).not.toBeNull();
    await fireEvent.click(Array.from(container.querySelectorAll('.modal-footer .btn')).find(button => button.textContent?.includes('İptal')) as HTMLElement);
    await fireEvent.click(container.querySelector('.gdm-header-actions > .btn-danger') as HTMLElement);
    await chooseProductDialog('confirm');
    expect(container.querySelector('#dm-chat-header')).not.toBeNull();
  });

  it('uses generic HTTP fallbacks and legacy friend IDs, and completes a non-owner leave', async () => {
    let mode: 'create' | 'add' | 'kick' | 'settings' | 'owner-leave' | 'member-leave' = 'create';
    installRichApi({ extra: (url, init) => {
      if (mode === 'create' && url === '/api/gdm' && init?.method === 'POST') return okJson({}, false);
      if (mode === 'add' && url.endsWith('/members') && init?.method === 'POST') return okJson({}, false);
      if (mode === 'kick' && url.includes('/members/') && init?.method === 'DELETE') return okJson({}, false);
      if (mode === 'settings' && init?.method === 'PATCH') return okJson({}, false);
      if (mode === 'owner-leave' && url === '/api/gdm/g-owner' && init?.method === 'DELETE') return okJson({}, false);
      if (mode === 'member-leave' && url.endsWith('/members/me') && init?.method === 'DELETE') return okJson({});
      return undefined;
    } });
    const { container } = renderOpen();
    await settle();

    await fireEvent.click(container.querySelector('[title="Yeni Grup"]') as HTMLElement);
    await fireEvent.input(container.querySelector('#gdm-name-input') as HTMLElement, { target: { value: 'Legacy IDs' } });
    await fireEvent.input(container.querySelector('#gdm-members-input') as HTMLElement, { target: { value: 'idonly' } });
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement);
    await settle();
    const createBody = JSON.parse(String(mockFetch.mock.calls.find(call => call[1]?.method === 'POST')?.[1]?.body));
    expect(createBody.memberIds).toEqual(['u4']);
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Oluşturulamadı'), 'error');

    await (mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof richOwnerGroup) => Promise<boolean>)(richOwnerGroup);
    await settle();
    await fireEvent.click(container.querySelector('[title="Grup Bilgisi"]') as HTMLElement);
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement); // empty username
    mode = 'add';
    await fireEvent.input(container.querySelector('#gdm-add-member') as HTMLElement, { target: { value: 'ali' } });
    await fireEvent.click(container.querySelector('.modal-card .btn-primary') as HTMLElement);
    await settle();
    expect(toastMock).toHaveBeenCalledWith('Eklenemedi', 'error');

    mode = 'kick';
    await fireEvent.click(container.querySelector('.gdm-member-row .btn-danger') as HTMLElement);
    await chooseProductDialog('confirm');
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Çıkarılamadı'), 'error');
    await fireEvent.click(container.querySelector('.modal-footer .btn') as HTMLElement);

    mode = 'settings';
    await fireEvent.click(container.querySelector('[title="Ayarlar"]') as HTMLElement);
    await fireEvent.click(container.querySelector('#gdm-settings-name')?.closest('.modal-card')?.querySelector('.btn-primary') as HTMLElement);
    await settle();
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('Güncellenemedi'), 'error');
    await fireEvent.click(container.querySelector('.modal-footer .btn:not(.btn-primary)') as HTMLElement);

    mode = 'owner-leave';
    await fireEvent.click(container.querySelector('.gdm-header-actions > .btn-danger') as HTMLElement);
    await chooseProductDialog('confirm');
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('İşlem başarısız'), 'error');

    const memberGroup = { ...richOwnerGroup, _id: 'member-group', ownerId: 'other', name: 'Member Group' };
    mode = 'member-leave';
    await (mockRegistry['groupDmPanel:openGroupDm'] as (value: typeof memberGroup) => Promise<boolean>)(memberGroup);
    await settle();
    await fireEvent.click(container.querySelector('.gdm-header-actions > .btn-danger') as HTMLElement);
    expect(document.querySelector('.bridge-product-dialog')?.textContent).toContain('ayrılmak');
    await chooseProductDialog('confirm');
    expect(mockFetch).toHaveBeenCalledWith('/api/gdm/member-group/members/me', { method: 'DELETE' });
    expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('ayrıldınız'), 'success');
  });
});

describe('GroupDmPanel — geçmiş zaman damgaları (Final21 Faz 19, 19-27)', () => {
  it('PostgreSQL BIGINT gibi METİN gelen createdAt geçerli bir saat olarak gösterilir', async () => {
    const ts = 1_790_328_773_133;
    installRichApi({ messages: [
      { _id: 'pg-1', groupId: 'g-owner', userId: 'u2', displayName: 'Ali', avatarColor: '#222', content: 'metin zaman', createdAt: String(ts) },
      { _id: 'pg-2', groupId: 'g-owner', userId: 'u2', displayName: 'Ali', avatarColor: '#222', content: 'sayı zaman', createdAt: ts + 60_000 },
    ] });
    mockRegistry.socket = new GdmSocketBus();
    const rendered = await openRichGroup();
    const times = [...rendered.container.querySelectorAll('.dm-msg-time')].map((el) => el.textContent?.trim() ?? '');
    expect(times).toHaveLength(2);
    expect(times.some((text) => /invalid/i.test(text))).toBe(false);
    expect(times[0]).toBe(new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }));
  });
});
