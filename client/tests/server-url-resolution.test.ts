// client/tests/server-url-resolution.test.ts
//
// Final21 Faz 19 (19-28) — paketlenmiş mobil uygulama sunucuya ULAŞABİLMELİ.
// Paketlenmiş uygulamanın kökeni `https://localhost`tur (Capacitor); sunucu-göreli yollar
// (`/api/…`, `/uploads/…`) oraya çözülüyordu ve emülatörde uygulama her isteği KENDİ kökenine
// yapıp açılış ekranında kaldı. `BRIDGE_API` yalnızca o derlemede tanımlıdır; web'de yardımcılar
// dizgeyi DEĞİŞTİRMEZ (davranış aynı).

import { cleanup, render } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { toServerUrl, safeServerUrl, getAPI } from '../js/core/globals.ts';
import MessageRenderer, { type MessageData } from '../js/core/MessageRenderer.svelte';

type WithApi = typeof globalThis & { BRIDGE_API?: unknown };
const setApi = (value: string | undefined) => { (globalThis as WithApi).BRIDGE_API = value; };

afterEach(() => { setApi(undefined); cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('web (BRIDGE_API yok) — davranış DEĞİŞMEZ', () => {
  it('göreli yollar olduğu gibi kalır; mutlak http(s) korunur; tehlikeli şemalar reddedilir', () => {
    expect(getAPI()).toBe(location.origin);
    expect(toServerUrl('/api/servers')).toBe('/api/servers');
    expect(safeServerUrl('/uploads/avatars/a.png')).toBe('/uploads/avatars/a.png');
    expect(safeServerUrl('https://cdn.example/x.png')).toBe('https://cdn.example/x.png');
    for (const bad of ['javascript:alert(1)', 'data:text/html,<b>x</b>', 'vbscript:x', '', null, 42]) {
      expect({ bad, out: safeServerUrl(bad) }).toEqual({ bad, out: null });
    }
  });
});

describe('paketlenmiş uygulama (BRIDGE_API = harici kök)', () => {
  beforeEach(() => setApi('https://chat.example.com/'));

  it('sunucu-göreli istek ve medya API köküne bağlanır (sondaki / tekilleşir)', () => {
    expect(toServerUrl('/api/servers')).toBe('https://chat.example.com/api/servers');
    expect(safeServerUrl('/uploads/avatars/a.png')).toBe('https://chat.example.com/uploads/avatars/a.png');
    expect(safeServerUrl('/api/files/att?sig=a&exp=1')).toBe('https://chat.example.com/api/files/att?sig=a&exp=1');
  });

  it('mutlak ve protokol-göreli adreslere dokunulmaz; tehlikeli şema yine reddedilir', () => {
    expect(toServerUrl('https://other.example/api/x')).toBe('https://other.example/api/x');
    expect(toServerUrl('//evil.example/x')).toBe('//evil.example/x');
    expect(safeServerUrl('javascript:alert(1)')).toBeNull();
  });

  it('apiFetch göreli yolu API köküne gönderir (18 çağıran göreli yol kullanıyor)', async () => {
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('token', 'test-token');
    try {
      const { apiFetch } = await import('../js/core/api-fetch.ts');
      await apiFetch('/api/servers');
      expect(fetchMock.mock.calls[0]?.[0]).toBe('https://chat.example.com/api/servers');
    } finally {
      localStorage.removeItem('token');
    }
  });

  it('mesaj eki gerçekten API kökünden yüklenir (uygulamanın kendi kökeninden değil)', () => {
    const message: MessageData = {
      _id: 'm-1', userId: 'u', displayName: 'Ada', content: '', createdAt: 1_754_000_000_000,
      channelId: 'c', serverId: 's', fileUrl: '/uploads/photo.png', fileType: 'image/png',
    };
    const view = render(MessageRenderer, { props: { message } });
    const img = view.container.querySelector<HTMLImageElement>('.msg-image');
    expect(img?.getAttribute('src')).toBe('https://chat.example.com/uploads/photo.png');
  });
});

describe('web — mesaj eki sayfanın kökeninden (değişmedi)', () => {
  it('göreli ek adresi aynen kalır', () => {
    const message: MessageData = {
      _id: 'm-2', userId: 'u', displayName: 'Ada', content: '', createdAt: 1_754_000_000_000,
      channelId: 'c', serverId: 's', fileUrl: '/uploads/photo.png', fileType: 'image/png',
    };
    const view = render(MessageRenderer, { props: { message } });
    expect(view.container.querySelector<HTMLImageElement>('.msg-image')?.getAttribute('src')).toBe('/uploads/photo.png');
  });
});
