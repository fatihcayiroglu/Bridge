// client/tests/notification-prefs-rollback.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// NotificationPrefsPanel.svelte — İYİMSER YAZMANIN GERİ ALINMASI VE KİLİT
// ════════════════════════════════════════════════════════════════════════════
// Panel iyimser yazar: kullanıcı bir düzeye basar, arayüz HEMEN değişir, istek
// arkadan gider. Bu tasarımda tek kritik davranış, başarısız yazmanın GERİ
// ALINMASIDIR. Alınmazsa kullanıcı bir kanalı sustururken sustur*ama*mış olur
// ve bunu ancak mesajları kaçırdığında fark eder — ya da tam tersi.
//
// İkinci kritik davranış, TEK UÇUŞ kilididir (`busyKey`): iki eşzamanlı yazma
// birbirinin geri alma anlık görüntüsünü bozar ve sonuç, hangi isteğin önce
// döndüğüne bağlı olarak rastgele olurdu.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup, waitFor } from '@testing-library/svelte';

const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register: (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
    has: (k: string) => k in registryMap,
    get: (k: string) => registryMap[k],
    call: (k: string, ...a: unknown[]) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...a) : v;
    },
  },
}));
vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../js/core/a11y/focusTrap.ts', () => ({ focusTrap: () => ({ destroy() {} }) }));

import NotificationPrefsPanel from '../js/core/NotificationPrefsPanel.svelte';

const ok = (body: unknown = {}) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status = 500) => ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

const CHANNELS = [
  { _id: 'c1', name: 'genel', type: 'text' },
  { _id: 'c2', type: 'text' },            // adsız kanal
  { _id: 'v1', name: 'Sesli', type: 'voice' },
  { name: 'kimliksiz', type: 'text' },     // kimliksiz satır
];

async function openPanel(): Promise<HTMLElement> {
  render(NotificationPrefsPanel);
  (registryMap.showNotificationPrefsPanel as () => void)();
  await waitFor(() => expect(document.querySelector('.np-panel')).toBeTruthy());
  return document.querySelector<HTMLElement>('.np-panel')!;
}
const rows = () => [...document.querySelectorAll<HTMLElement>('.np-channel')];
const errorText = () => document.querySelector('.np-error')?.textContent?.trim()
  ?? document.querySelector('[role="alert"]')?.textContent?.trim() ?? '';

beforeEach(() => {
  for (const key of Object.keys(registryMap)) delete registryMap[key];
  document.body.innerHTML = '';
  vi.clearAllMocks();
});
afterEach(() => cleanup());

describe('panel prerequisites', () => {
  it('explains that a server must be selected instead of showing an empty panel', async () => {
    registryMap.apiFetch = vi.fn();
    registryMap.getCurrentServer = () => null;
    await openPanel();
    await waitFor(() => expect(document.body.textContent).toContain('önce bir sunucu seçin'));
    expect(registryMap.apiFetch).not.toHaveBeenCalled();
  });

  it('explains that settings cannot load when no API client is registered', async () => {
    registryMap.getCurrentServer = () => ({ _id: 's1', name: 'Takım' });
    registryMap.getCurrentServerChannels = () => CHANNELS;
    await openPanel();
    await waitFor(() => expect(document.body.textContent).toContain('şu anda yüklenemiyor'));
  });

  it('surfaces a load failure without leaving a half-rendered list', async () => {
    registryMap.apiFetch = vi.fn(async () => fail(503));
    registryMap.getCurrentServer = () => ({ _id: 's1', name: 'Takım' });
    registryMap.getCurrentServerChannels = () => CHANNELS;
    await openPanel();
    await waitFor(() => expect(document.body.textContent).toContain('yüklenemedi'));
  });

  it('says so plainly when the server exposes no configurable text channel', async () => {
    registryMap.apiFetch = vi.fn(async () => ok({ serverLevel: 'default', channels: [] }));
    registryMap.getCurrentServer = () => ({ _id: 's1', name: 'Takım' });
    registryMap.getCurrentServerChannels = () => [{ _id: 'v1', name: 'Sesli', type: 'voice' }];
    await openPanel();
    await waitFor(() => expect(document.body.textContent).toContain('ayarlanabilir metin kanalı yok'));
  });

  it('treats a channel row without an explicit type as a text channel and labels a nameless one', async () => {
    registryMap.apiFetch = vi.fn(async () => ok({ serverLevel: 'default', channels: [] }));
    registryMap.getCurrentServer = () => ({ _id: 's1', name: 'Takım' });
    registryMap.getCurrentServerChannels = () => [{ _id: 'c9' }, ...CHANNELS];
    await openPanel();
    await waitFor(() => expect(rows().length).toBe(3));
    const names = rows().map(row => row.querySelector('.np-channel-name')?.textContent);
    expect(names).toEqual(['#kanal', '#genel', '#kanal']);
  });

  it('falls back to an empty channel list when the registry provides none', async () => {
    registryMap.apiFetch = vi.fn(async () => ok({ serverLevel: 'default', channels: [] }));
    registryMap.getCurrentServer = () => ({ _id: 's1', name: 'Takım' });
    await openPanel();
    await waitFor(() => expect(document.body.textContent).toContain('ayarlanabilir metin kanalı yok'));
  });
});

describe('optimistic writes roll back on failure', () => {
  async function panelWithPrefs(apiImpl: (url: string, init?: RequestInit) => Promise<Response>) {
    registryMap.apiFetch = vi.fn(apiImpl);
    registryMap.getCurrentServer = () => ({ _id: 's1', name: 'Takım' });
    registryMap.getCurrentServerChannels = () => CHANNELS;
    await openPanel();
    await waitFor(() => expect(rows().length).toBeGreaterThan(0));
  }

  it('restores the previous server level when the write fails', async () => {
    let saveFails = false;
    await panelWithPrefs(async (_url, init) => {
      if (!init) return ok({ serverLevel: 'mentions', channels: [] });
      return saveFails ? fail(500) : ok();
    });

    const serverLevels = [...document.querySelectorAll<HTMLButtonElement>('.np-section:first-of-type .np-level')];
    expect(serverLevels.length).toBeGreaterThan(0);
    saveFails = true;
    const before = serverLevels.findIndex(button => button.classList.contains('active'));
    serverLevels[serverLevels.length - 1]!.click();
    await waitFor(() => expect(errorText() || document.body.textContent).toContain('kaydedilemedi'));
    const after = [...document.querySelectorAll<HTMLButtonElement>('.np-section:first-of-type .np-level')]
      .findIndex(button => button.classList.contains('active'));
    expect(after).toBe(before);
  });

  it('restores a previously stored channel preference when the write fails', async () => {
    let saveFails = false;
    await panelWithPrefs(async (_url, init) => {
      if (!init) return ok({ serverLevel: 'default', channels: [{ channelId: 'c1', level: 'mentions', muteUntil: null }] });
      return saveFails ? fail(500) : ok();
    });
    const row = rows()[0]!;
    expect(row.querySelector('.np-tag')?.textContent).toBeTruthy();

    saveFails = true;
    const levels = [...row.querySelectorAll<HTMLButtonElement>('.np-level-compact')];
    levels[levels.length - 1]!.click();
    await waitFor(() => expect(document.body.textContent).toContain('kaydedilemedi'));
    const checked = [...rows()[0]!.querySelectorAll<HTMLButtonElement>('.np-level-compact')]
      .find(button => button.getAttribute('aria-checked') === 'true');
    expect(checked!.textContent).toBe(levels.find(l => l.getAttribute('aria-checked') === 'true')!.textContent);
  });

  it('removes an optimistic row entirely when the channel had no stored preference', async () => {
    let saveFails = false;
    await panelWithPrefs(async (_url, init) => {
      if (!init) return ok({ serverLevel: 'default', channels: [] });
      return saveFails ? fail(500) : ok();
    });
    saveFails = true;
    const row = rows()[0]!;
    [...row.querySelectorAll<HTMLButtonElement>('.np-level-compact')].at(-1)!.click();
    await waitFor(() => expect(document.body.textContent).toContain('kaydedilemedi'));
    // Geri alma, satırı kaydedilmemiş bir "override" olarak bırakmaz.
    expect(rows()[0]!.querySelector('.np-tag')).toBeNull();
  });

  it('restores the preference when a reset to default fails', async () => {
    let resetFails = false;
    await panelWithPrefs(async (_url, init) => {
      if (!init) return ok({ serverLevel: 'default', channels: [{ channelId: 'c1', level: 'mute', muteUntil: null }] });
      return resetFails ? fail(500) : ok();
    });
    resetFails = true;
    (rows()[0]!.querySelector('.np-reset') as HTMLButtonElement).click();
    await waitFor(() => expect(document.body.textContent).toContain('sıfırlanamadı'));
    expect(rows()[0]!.querySelector('.np-tag')).not.toBeNull();
  });

  it('shows an expired snooze honestly and lets the user re-arm it', async () => {
    const calls: RequestInit[] = [];
    await panelWithPrefs(async (_url, init) => {
      if (!init) return ok({ serverLevel: 'default', channels: [{ channelId: 'c1', level: 'mute', muteUntil: Date.now() - 1_000 }] });
      calls.push(init);
      return ok();
    });
    await waitFor(() => expect(document.body.textContent).toContain('Erteleme süresi doldu'));

    (document.querySelector('.np-snooze-btn') as HTMLButtonElement).click();
    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String(calls[0]!.body)).muteUntil).toEqual(expect.any(Number));
    await waitFor(() => expect(document.body.textContent).not.toContain('Erteleme süresi doldu'));
  });

  it('locks every control while a write is in flight so two writes cannot race', async () => {
    let releaseSave!: (value: Response) => void;
    await panelWithPrefs(async (_url, init) => {
      if (!init) return ok({ serverLevel: 'default', channels: [] });
      return new Promise<Response>(resolve => { releaseSave = resolve; });
    });
    const row = rows()[0]!;
    const levels = [...row.querySelectorAll<HTMLButtonElement>('.np-level-compact')];
    levels.at(-1)!.click();
    await waitFor(() => expect(rows()[0]!.classList.contains('busy')).toBe(true));

    for (const button of rows()[0]!.querySelectorAll<HTMLButtonElement>('button')) {
      expect(button.disabled).toBe(true);
    }
    releaseSave(ok());
    await waitFor(() => expect(rows()[0]!.classList.contains('busy')).toBe(false));
    expect((registryMap.apiFetch as ReturnType<typeof vi.fn>).mock.calls.filter(
      call => Boolean(call[1]),
    )).toHaveLength(1);
  });
});
