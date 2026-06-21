import { render, screen, fireEvent, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const bridgeRegistryMock = vi.hoisted(() => ({
  register: vi.fn(),
  unregister: vi.fn(),
}));

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: bridgeRegistryMock,
}));

import EmptyServerStart from '../js/core/EmptyServerStart.svelte';

function response(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
  } as Response;
}

describe('EmptyServerStart', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
    window.localStorage.clear();
    window.localStorage.setItem('token', 'test-jwt');

    bridgeRegistryMock.register.mockReset();
    bridgeRegistryMock.unregister.mockReset();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test('sunucusu olmayan kullanıcıya oluştur/katıl/QR seçeneklerini gösterir', async () => {
    const fetchMock = vi.fn().mockResolvedValue(response([]));
    vi.stubGlobal('fetch', fetchMock);

    render(EmptyServerStart);

    await waitFor(() => {
      expect(
        screen.getByRole('heading', { name: 'Henüz bir sunucun yok' })
      ).toBeInTheDocument();
    });

    expect(screen.getByRole('button', { name: /Sunucu Oluştur/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Davet Koduyla Katıl/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /QR Kod Tara/i })).toBeInTheDocument();

    const request = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(fetchMock.mock.calls[0]?.[0]).toBe('/api/servers');
    expect(new Headers(request.headers).get('Authorization')).toBe('Bearer test-jwt');
  });

  test('en az bir sunucusu olan kullanıcıya başlangıç ekranını göstermez', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      response([{ _id: 'server-1', name: 'Oyun Ekibi' }])
    );
    vi.stubGlobal('fetch', fetchMock);

    render(EmptyServerStart);

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/servers',
        expect.objectContaining({ credentials: 'include' })
      );
    });

    expect(
      screen.queryByRole('heading', { name: 'Henüz bir sunucun yok' })
    ).not.toBeInTheDocument();
  });
  test('sunucu oluştururken CSRF token ile POST isteği gönderir', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/servers' && init?.method !== 'POST') {
        return Promise.resolve(response([]));
      }
      if (url === '/api/auth/csrf-token') {
        return Promise.resolve(response({ token: 'csrf-create-token' }));
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(EmptyServerStart);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Sunucu Oluştur/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Sunucu Oluştur/i }));

    const nameInput = await screen.findByPlaceholderText('Örn. Oyun Ekibi');
    fireEvent.input(nameInput, { target: { value: 'Bridge Türkiye' } });
    fireEvent.keyDown(nameInput, { key: 'Enter' });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) => url === '/api/servers' && (init as RequestInit)?.method === 'POST'
        )
      ).toBe(true);
    });

    const post = fetchMock.mock.calls.find(
      ([url, init]) => url === '/api/servers' && (init as RequestInit)?.method === 'POST'
    );
    const postInit = post?.[1] as RequestInit;

    expect(JSON.parse(String(postInit.body))).toEqual({
      name: 'Bridge Türkiye',
      icon: '🌐',
    });
    expect(new Headers(postInit.headers).get('Authorization')).toBe('Bearer test-jwt');
    expect(new Headers(postInit.headers).get('X-CSRF-Token')).toBe('csrf-create-token');
  });

  test('davet bağlantısından çıkarılan kodla katılma isteği gönderir', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url === '/api/servers' && init?.method !== 'POST') {
        return Promise.resolve(response([]));
      }
      if (url === '/api/auth/csrf-token') {
        return Promise.resolve(response({ token: 'csrf-join-token' }));
      }
      return new Promise<Response>(() => {});
    });
    vi.stubGlobal('fetch', fetchMock);

    render(EmptyServerStart);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Davet Koduyla Katıl/i })).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /Davet Koduyla Katıl/i }));

    const inviteInput = await screen.findByPlaceholderText(
      'örn. a1b2c3d4 veya https://…/invite/a1b2c3d4'
    );
    fireEvent.input(inviteInput, {
      target: { value: 'https://bridge.example/invite/a1B2_c-9' },
    });
    fireEvent.keyDown(inviteInput, { key: 'Enter' });

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            url === '/api/servers/invites/a1B2_c-9/use' &&
            (init as RequestInit)?.method === 'POST'
        )
      ).toBe(true);
    });

    const post = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === '/api/servers/invites/a1B2_c-9/use' &&
        (init as RequestInit)?.method === 'POST'
    );
    const postInit = post?.[1] as RequestInit;

    expect(postInit.body).toBe('{}');
    expect(new Headers(postInit.headers).get('Authorization')).toBe('Bearer test-jwt');
    expect(new Headers(postInit.headers).get('X-CSRF-Token')).toBe('csrf-join-token');
  });

});
