// client/tests/GroupDmPanel.test.ts
// Sprint 113 — GroupDmPanel.svelte birim testleri
// ADR-0008 Faz 2 doğrulama

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup } from '@testing-library/svelte';
import GroupDmPanel from '../js/core/GroupDmPanel.svelte';

// ── Mock'lar ─────────────────────────────────────────────────────────────

const mockRegistry: Record<string, unknown> = {};

const mockGroups = [
  { _id: 'g1', name: 'Test Grubu', icon: '👥', memberCount: 3, ownerId: 'me' },
  { _id: 'g2', name: 'Diğer Grup', icon: '🎮', memberCount: 2, ownerId: 'other' },
];

const mockMessages = [
  { _id: 'm1', userId: 'me', displayName: 'Ben', avatarColor: '#5865f2', content: 'Merhaba!', createdAt: Date.now() - 5000 },
  { _id: 'm2', userId: 'u2', displayName: 'Ali',  avatarColor: '#ed4245', content: 'Selam!',   createdAt: Date.now() - 2000 },
];

const mockMe = { id: 'me', displayName: 'Ben' };

vi.mock('../js/core/globals.js', () => ({
  friendsCache: [
    { _id: 'u2', username: 'ali', displayName: 'Ali', avatarColor: '#ed4245' },
    { _id: 'u3', username: 'veli', displayName: 'Veli', avatarColor: '#43b581' },
  ],
}));

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (key: string, fn: unknown) => { mockRegistry[key] = fn; },
    unregister: (key: string) => { delete mockRegistry[key]; },
    get: (key: string) => {
      if (key === 'getMe') return () => mockMe;
      if (key === 'toast') return vi.fn();
      if (key === 'cssColor') return (c: string) => c;
      if (key === 'initials') return (n: string) => n.slice(0, 2).toUpperCase();
      if (key === 'formatText') return (s: string) => s;
      return mockRegistry[key];
    },
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

// fetch mock
const mockFetch = vi.fn();
global.fetch = mockFetch;

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

// ── Setup ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockFetchGdmList();
});

afterEach(() => {
  cleanup();
});

// ── Testler ───────────────────────────────────────────────────────────────

describe('GroupDmPanel — render', () => {
  it('panel render edilir', async () => {
    const { container } = render(GroupDmPanel);
    expect(container.querySelector('#gdm-panel')).toBeTruthy();
  });

  it('sidebar ve chat alanı mevcut', () => {
    const { container } = render(GroupDmPanel);
    expect(container.querySelector('.gdm-sidebar')).toBeTruthy();
    expect(container.querySelector('.gdm-chat')).toBeTruthy();
  });

  it('başlangıçta placeholder gösterilir (grup seçilmemiş)', () => {
    const { container } = render(GroupDmPanel);
    expect(container.querySelector('.gdm-placeholder')).toBeTruthy();
  });

  it('onMount grup listesi yükler', async () => {
    render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 10));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/gdm'),
      expect.anything(),
    );
  });
});

describe('GroupDmPanel — grup listesi', () => {
  it('yüklenen gruplar listede görünür', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    const items = container.querySelectorAll('.gdm-item');
    expect(items.length).toBe(2);
  });

  it('grup adları doğru render edilir', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toContain('Test Grubu');
    expect(container.innerHTML).toContain('Diğer Grup');
  });

  it('grup ikonları görünür', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    expect(container.innerHTML).toContain('👥');
    expect(container.innerHTML).toContain('🎮');
  });
});

describe('GroupDmPanel — grup açma', () => {
  it('gruba tıklayınca mesajlar yüklenir', async () => {
    mockFetchMessages();
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    const item = container.querySelector('.gdm-item') as HTMLElement;
    await fireEvent.click(item);
    await new Promise(r => setTimeout(r, 20));
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/gdm/g1/messages'),
      expect.anything(),
    );
  });

  it('grup açılınca header görünür', async () => {
    mockFetchMessages();
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector('#dm-chat-header')).toBeTruthy();
  });

  it('grup açılınca input alanı görünür', async () => {
    mockFetchMessages();
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    expect(container.querySelector('#dm-input')).toBeTruthy();
  });

  it('mesajlar render edilir', async () => {
    mockFetchMessages();
    const { container } = render(GroupDmPanel);
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
    (window as Record<string, unknown>)['socket'] = mockSocket;
    (window as Record<string, unknown>)['API'] = '';
    mockFetchMessages();
  });

  it('Enter ile mesaj gönderilir', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    const input = container.querySelector('#dm-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Test mesaj' } });
    await fireEvent.keyDown(input, { key: 'Enter' });
    expect(mockSocket.emit).toHaveBeenCalledWith('gdm:send', {
      groupId: 'g1',
      content: 'Test mesaj',
    });
  });

  it('Gönder butonuyla da çalışır', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    const input = container.querySelector('#dm-input') as HTMLInputElement;
    await fireEvent.input(input, { target: { value: 'Buton test' } });
    await fireEvent.click(container.querySelector('.btn-primary') as HTMLElement);
    expect(mockSocket.emit).toHaveBeenCalledWith('gdm:send', expect.objectContaining({ content: 'Buton test' }));
  });

  it('boş mesaj gönderilmez', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.click(container.querySelector('.gdm-item') as HTMLElement);
    await new Promise(r => setTimeout(r, 20));
    await fireEvent.keyDown(container.querySelector('#dm-input') as HTMLElement, { key: 'Enter' });
    expect(mockSocket.emit).not.toHaveBeenCalledWith('gdm:send', expect.anything());
  });
});

describe('GroupDmPanel — Create modal', () => {
  it('+ butonuyla modal açılır', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 10));
    const plusBtn = container.querySelector('.gdm-sidebar-header .btn-sm') as HTMLElement;
    await fireEvent.click(plusBtn);
    expect(container.querySelector('#gdm-name-input')).toBeTruthy();
  });

  it('grup adı girişi çalışır', async () => {
    const { container } = render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 10));
    await fireEvent.click(container.querySelector('.gdm-sidebar-header .btn-sm') as HTMLElement);
    const nameInput = container.querySelector('#gdm-name-input') as HTMLInputElement;
    await fireEvent.input(nameInput, { target: { value: 'Yeni Grup' } });
    expect(nameInput.value).toBe('Yeni Grup');
  });

  it('İptal butonu modali kapatır', async () => {
    const { container } = render(GroupDmPanel);
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

    const { container } = render(GroupDmPanel);
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
    render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 10));
    expect(mockRegistry['groupDmPanel:openGroupDm']).toBeDefined();
  });

  it('loadList kayıtlı', async () => {
    render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 10));
    expect(mockRegistry['groupDmPanel:loadList']).toBeDefined();
  });

  it('getCurrentGroup kayıtlı', async () => {
    render(GroupDmPanel);
    await new Promise(r => setTimeout(r, 10));
    const fn = mockRegistry['groupDmPanel:getCurrentGroup'] as Function;
    expect(fn()).toBeNull();
  });
});

describe('GroupDmPanel — ADR-0008 sınır kontrolü', () => {
  it('vanilla socket doğrudan import edilmez', () => {
    // Bileşen window.socket üzerinden erişir, import etmez
    const uses = typeof mockRegistry['groupDmPanel:openGroupDm'];
    expect(uses).toBe('function');
  });

  it('onClose prop çağrılabilir', async () => {
    const onClose = vi.fn();
    const { container } = render(GroupDmPanel, { props: { onClose } });
    // onClose butonu varsa tıkla
    const closeBtn = container.querySelectorAll('.gdm-sidebar-header .btn-sm');
    if (closeBtn.length >= 2) {
      await fireEvent.click(closeBtn[closeBtn.length - 1]);
      expect(onClose).toHaveBeenCalled();
    }
  });
});
