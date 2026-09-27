import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

let current = { _id: 's1' } as { _id: string } | null;
let stillCurrent = true;
let apiMock = vi.fn();
const toastMock = vi.fn();

vi.mock('../js/core/server-settings/stores/serverSettingsStore', async () => {
  const actual = await vi.importActual<any>('../js/core/server-settings/stores/serverSettingsStore');
  return {
    ...actual,
    getCurrentServerFromRegistry: () => current,
    isStillCurrentServer: () => stillCurrent,
  };
});
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...args: unknown[]) => apiMock(...args) }));
vi.mock('../js/core/utils.js', () => ({ toast: (...args: unknown[]) => toastMock(...args) }));

import EmojiTab from '../js/core/server-settings/tabs/EmojiTab.svelte';
import MediaTab from '../js/core/server-settings/tabs/MediaTab.svelte';

const response = (ok: boolean, body: unknown = {}, status = ok ? 200 : 400) => ({ ok, status, json: async () => body }) as Response;
const file = (name: string, size: number, type = 'image/png') => new File([new Uint8Array(size)], name, { type });

beforeEach(() => {
  current = { _id: 's1' }; stillCurrent = true; toastMock.mockReset(); document.body.innerHTML = '';
  apiMock = vi.fn(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'POST') return response(true, { bannerUrl: '/b.png', iconUrl: '/i.png' });
    if (init?.method === 'DELETE') return response(true, {});
    return response(true, [{ _id: 'e1', name: 'wave', url: '/e.png' }]);
  });
});
afterEach(() => cleanup());

describe('EmojiTab behavior', () => {
  it('loads emoji inventory and renders server-scoped assets', async () => {
    render(EmojiTab);
    await waitFor(() => expect(document.body.textContent).toContain(':wave:'));
    expect(apiMock).toHaveBeenCalledWith('/api/servers/s1/emojis');
    expect(document.querySelector('img')?.getAttribute('src')).toContain('/e.png');
  });

  it('rejects oversized files and missing normalized names before upload', async () => {
    render(EmojiTab); await waitFor(() => expect(document.querySelector('input[type="file"]')).not.toBeNull());
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    await fireEvent.change(input, { target: { files: [file('huge.png', 256 * 1024 + 1)] } });
    expect(toastMock).toHaveBeenCalledWith('Max 256KB!', 'error');
    const postBefore = apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST').length;
    await fireEvent.change(input, { target: { files: [file('ok.png', 16)] } });
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Emoji adı/i), 'error');
    expect(apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(postBefore);
  });

  it('normalizes emoji name and uploads as multipart', async () => {
    render(EmojiTab); await waitFor(() => expect(document.querySelector('input.input-field')).not.toBeNull());
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: ' Merhaba Dünya! ' } });
    await fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file('ok.png', 16)] } });
    await waitFor(() => expect(apiMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toBe(true));
    const post = apiMock.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'POST')!;
    expect(String(post[0])).toBe('/api/servers/s1/emojis');
    const body = (post[1] as RequestInit).body as FormData;
    expect(body.get('name')).toBe('merhaba_d_nya_');
    expect(body.get('emoji')).toBeInstanceOf(File);
  });

  it('fails closed if the server changed before upload/delete', async () => {
    render(EmojiTab); await waitFor(() => expect(document.body.textContent).toContain(':wave:'));
    stillCurrent = false;
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.emoji-del-btn')!);
    expect(apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toHaveLength(0);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Sunucu değişti/i), 'error');
  });

  it('surfaces safe upload/delete errors without reflecting raw server text', async () => {
    apiMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response(false, { error: 'bad emoji' }, 400);
      if (init?.method === 'DELETE') return response(false, {}, 500);
      return response(true, [{ _id: 'e1', name: 'wave', url: '/e.png' }]);
    });
    render(EmojiTab); await waitFor(() => expect(document.body.textContent).toContain(':wave:'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'ok' } });
    await fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file('ok.png', 16)] } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('İstek geçersiz'), 'error'));
    expect(toastMock).not.toHaveBeenCalledWith('bad emoji', 'error');
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.emoji-del-btn')!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith('Silinemedi', 'error'));
  });

  it('settles into an empty state without a selected server', async () => {
    current = null;
    render(EmojiTab);

    await waitFor(() => expect(document.body.textContent).toMatch(/Henüz emoji yok|No emoji/i));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('handles rejected, failed and malformed inventory responses safely', async () => {
    apiMock.mockRejectedValueOnce(new Error('offline'));
    const first = render(EmojiTab);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/yüklenemedi|could not/i), 'error'));
    first.unmount();
    cleanup();

    toastMock.mockClear();
    apiMock = vi.fn(async () => response(false, {}, 503));
    const second = render(EmojiTab);
    await waitFor(() => expect(document.body.textContent).toMatch(/Henüz emoji yok|No emoji/i));
    expect(toastMock).not.toHaveBeenCalled();
    second.unmount();
    cleanup();

    apiMock = vi.fn(async () => response(true, { emojis: [] }));
    render(EmojiTab);
    await waitFor(() => expect(document.body.textContent).toMatch(/Henüz emoji yok|No emoji/i));
  });

  it('ignores a file input event without a file', async () => {
    render(EmojiTab);
    const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[type="file"]')!);
    const before = apiMock.mock.calls.length;

    await fireEvent.change(input, { target: { files: [] } });

    expect(apiMock).toHaveBeenCalledTimes(before);
  });

  it('fails closed when the server changes during upload', async () => {
    render(EmojiTab);
    await waitFor(() => expect(document.body.textContent).toContain(':wave:'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'safe' } });
    stillCurrent = false;

    await fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, {
      target: { files: [file('safe.png', 16)] },
    });

    expect(apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
    expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Sunucu değişti|server changed/i), 'error');
  });

  it('uses fallback upload errors and reloads after a successful delete', async () => {
    apiMock = vi.fn(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response(false, {}, 400);
      if (init?.method === 'DELETE') return response(true);
      return response(true, [{ _id: 'e/1', name: 'wave', url: '/e.png' }]);
    });
    render(EmojiTab);
    await waitFor(() => expect(document.body.textContent).toContain(':wave:'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input.input-field')!, { target: { value: 'ok' } });
    await fireEvent.change(document.querySelector<HTMLInputElement>('input[type="file"]')!, { target: { files: [file('ok.png', 16)] } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('İstek geçersiz'), 'error'));

    const readsBefore = apiMock.mock.calls.filter(c => !(c[1] as RequestInit | undefined)?.method).length;
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.emoji-del-btn')!);
    await waitFor(() => expect(apiMock.mock.calls.some(c => String(c[0]).endsWith('/emojis/e%2F1'))).toBe(true));
    await waitFor(() => expect(apiMock.mock.calls.filter(c => !(c[1] as RequestInit | undefined)?.method).length).toBeGreaterThan(readsBefore));
    expect(toastMock).toHaveBeenCalledWith('Emoji silindi', 'success');
  });

  it('encodes the selected server id in inventory URLs', async () => {
    current = { _id: 's/1' };
    render(EmojiTab);
    await waitFor(() => expect(apiMock).toHaveBeenCalledWith('/api/servers/s%2F1/emojis'));
  });
});

describe('MediaTab behavior', () => {
  function store(overrides: Record<string, unknown> = {}) {
    return {
      server: { _id: 's1', name: 'Bridge' }, bannerUrl: null, iconUrl: null,
      setError: vi.fn(), setBannerUrl: vi.fn(), setIconUrl: vi.fn(), ...overrides,
    } as any;
  }

  it('renders fallback icon and refuses mutation after server switch', async () => {
    const s = store(); render(MediaTab, { props: { store: s } });
    expect(document.body.textContent).toContain('B');
    stillCurrent = false;
    const input = document.querySelector<HTMLInputElement>('#server-banner-upload')!;
    await fireEvent.change(input, { target: { files: [file('banner.png', 32)] } });
    expect(s.setError).toHaveBeenCalledWith(expect.stringMatching(/Sunucu değişti/i));
    expect(apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === 'POST')).toHaveLength(0);
  });

  it('fails closed on hostile persisted media URLs', () => {
    const s = store({
      bannerUrl: 'https://attacker.example/banner.png',
      iconUrl: '//attacker.example/icon.png',
    });
    render(MediaTab, { props: { store: s } });
    const banner = document.querySelector<HTMLElement>('.media-banner-preview')!;
    expect(banner.style.background).toContain('linear-gradient');
    expect(banner.style.backgroundImage).not.toContain('javascript:');
    expect(document.querySelector('.media-icon-preview--letter')?.textContent).toContain('B');
    expect(document.body.innerHTML).not.toContain('attacker.example');
  });

  it('enforces 8MB limit before banner/icon network calls', async () => {
    const s = store(); render(MediaTab, { props: { store: s } });
    const huge = file('huge.png', 8 * 1024 * 1024 + 1);
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-banner-upload')!, { target: { files: [huge] } });
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-icon-upload')!, { target: { files: [huge] } });
    expect(toastMock).toHaveBeenCalledWith('Max 8MB!', 'error');
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('persists successful banner and icon uploads through canonical endpoints', async () => {
    const s = store(); render(MediaTab, { props: { store: s } });
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-banner-upload')!, { target: { files: [file('banner.png', 32)] } });
    await waitFor(() => expect(s.setBannerUrl).toHaveBeenCalledWith('/b.png'));
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-icon-upload')!, { target: { files: [file('icon.png', 32)] } });
    await waitFor(() => expect(s.setIconUrl).toHaveBeenCalledWith('/i.png'));
    expect(apiMock.mock.calls.some(c => String(c[0]).endsWith('/servers/s1/banner') && (c[1] as RequestInit).method === 'POST')).toBe(true);
    expect(apiMock.mock.calls.some(c => String(c[0]).endsWith('/servers/s1/icon-image') && (c[1] as RequestInit).method === 'POST')).toBe(true);
  });

  it('does not update local media state when upload API rejects', async () => {
    apiMock = vi.fn(async () => response(false, { error: 'forbidden' }, 403));
    const s = store(); render(MediaTab, { props: { store: s } });
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-banner-upload')!, { target: { files: [file('banner.png', 32)] } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('yetkin yok'), 'error'));
    expect(toastMock).not.toHaveBeenCalledWith('forbidden', 'error');
    expect(s.setBannerUrl).not.toHaveBeenCalled();
  });

  it('removes an existing banner only after successful DELETE', async () => {
    const s = store({ bannerUrl: '/old.png' }); render(MediaTab, { props: { store: s } });
    const remove = [...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Kaldır'))!;
    await fireEvent.click(remove);
    // Kanonik bos banner degeri '' (store'un baslangic degeri de budur);
    // `null` gecmek `bannerUrl: string` sozlesmesini sessizce bozuyordu.
    await waitFor(() => expect(s.setBannerUrl).toHaveBeenCalledWith(''));
    expect(apiMock.mock.calls.some(c => (c[1] as RequestInit | undefined)?.method === 'DELETE')).toBe(true);
  });

  it('renders local banner and icon assets and the question-mark name fallback', () => {
    const s = store({
      server: { _id: 's1' },
      bannerUrl: '/uploads/banner.png',
      iconUrl: '/uploads/icon.png',
    });
    render(MediaTab, { props: { store: s } });

    expect(document.querySelector<HTMLElement>('.media-banner-preview')!.style.backgroundImage).toContain('/uploads/banner.png');
    expect(document.querySelector<HTMLElement>('.media-icon-preview')!.style.backgroundImage).toContain('/uploads/icon.png');
    expect(document.querySelector('.media-icon-preview--letter')).toBeNull();
  });

  it('ignores empty file selections and rejects an icon after a server switch', async () => {
    const s = store();
    render(MediaTab, { props: { store: s } });
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-banner-upload')!, { target: { files: [] } });
    expect(apiMock).not.toHaveBeenCalled();

    stillCurrent = false;
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-icon-upload')!, {
      target: { files: [file('icon.png', 32)] },
    });
    expect(s.setError).toHaveBeenCalledWith(expect.stringMatching(/Sunucu değişti|server changed/i));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('shows bounded network errors for banner and icon uploads', async () => {
    apiMock = vi.fn(async () => { throw new Error('secret upstream detail'); });
    const s = store();
    render(MediaTab, { props: { store: s } });

    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-banner-upload')!, {
      target: { files: [file('banner.png', 32)] },
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Banner.*yüklenemedi|Banner.*failed/i), 'error'));
    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-icon-upload')!, {
      target: { files: [file('icon.png', 32)] },
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/ikonu.*yüklenemedi|icon.*failed/i), 'error'));
    expect(s.setBannerUrl).not.toHaveBeenCalled();
    expect(s.setIconUrl).not.toHaveBeenCalled();
  });

  it('surfaces failed and rejected banner deletion without clearing local state', async () => {
    apiMock = vi.fn(async () => response(false, { error: 'Banner kilitli' }, 409));
    const s = store({ bannerUrl: '/old.png' });
    const first = render(MediaTab, { props: { store: s } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Kaldır'))!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/başka bir yerde değişmiş/i), 'error'));
    expect(toastMock).not.toHaveBeenCalledWith('Banner kilitli', 'error');
    expect(s.setBannerUrl).not.toHaveBeenCalled();
    first.unmount();
    cleanup();

    toastMock.mockClear();
    apiMock = vi.fn(async () => { throw new Error('offline'); });
    const secondStore = store({ bannerUrl: '/old.png' });
    render(MediaTab, { props: { store: secondStore } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Kaldır'))!);
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/kaldırılamadı|remove failed/i), 'error'));
    expect(secondStore.setBannerUrl).not.toHaveBeenCalled();
  });

  it('uses a safe fallback when the server name is absent', () => {
    const s = store({ server: { _id: 's1' } });
    render(MediaTab, { props: { store: s } });
    expect(document.querySelector('.media-icon-preview--letter')?.textContent?.trim()).toBe('?');
  });

  it('refuses banner removal when the captured store has no server id', async () => {
    const s = store({ server: null, bannerUrl: '/old.png' });
    render(MediaTab, { props: { store: s } });

    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Kaldır'))!);

    expect(apiMock).not.toHaveBeenCalled();
    expect(s.setError).toHaveBeenCalledWith(expect.stringMatching(/Sunucu değişti|server changed/i));
  });

  it('uses fallback API errors for both upload kinds and ignores an empty icon selection', async () => {
    apiMock = vi.fn(async () => response(false, {}, 400));
    const s = store();
    render(MediaTab, { props: { store: s } });
    const icon = document.querySelector<HTMLInputElement>('#server-icon-upload')!;
    await fireEvent.change(icon, { target: { files: [] } });
    expect(apiMock).not.toHaveBeenCalled();

    await fireEvent.change(document.querySelector<HTMLInputElement>('#server-banner-upload')!, {
      target: { files: [file('banner.png', 32)] },
    });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('İstek geçersiz'), 'error'));
    toastMock.mockClear();

    await fireEvent.change(icon, { target: { files: [file('icon.png', 32)] } });
    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringContaining('İstek geçersiz'), 'error'));
  });

  it('uses the bounded delete fallback when an error response is not JSON', async () => {
    apiMock = vi.fn(async () => ({
      ok: false,
      status: 502,
      json: async () => { throw new Error('bad json'); },
    } as unknown as Response));
    const s = store({ bannerUrl: '/old.png' });
    render(MediaTab, { props: { store: s } });

    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes('Kaldır'))!);

    await waitFor(() => expect(toastMock).toHaveBeenCalledWith(expect.stringMatching(/Sunucu hatası|Server error/i), 'error'));
  });
});
