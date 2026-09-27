// client/tests/notification-prefs.test.ts
//
// FAZ K/5 — BILDIRIM TERCIHLERI.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERCEK BOSLUK
// ════════════════════════════════════════════════════════════════════════════
// Sunucu tarafi TAMDI: kanal/sunucu seviyesinde `all | mentions | mute`,
// `muteUntil` ile erteleme ve varsayilana donus.
//
// Istemcideki `NotificationPrefsPanel.svelte` ise 50 satirlik BOS bir kabuktu
// (hicbir API cagrisi, hicbir kontrol) ve uretim girisinden HIC import
// edilmiyordu. Kullanici bir kanali SUSTURAMIYORDU — ozellik "var" gorunup
// yoktu.
//
// En kritik davranis: KAYDEDILEMEYEN ayar GERI ALINIR. Iyimser guncellemeyi
// yerinde birakmak, kullaniciya kaydedilmemis bir ayari kaydedilmis gibi
// gosterirdi; bildirim ayarlarinda bu, beklenmedik bildirim ya da KACIRILAN
// mesaj olarak geri doner.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const registryMap: Record<string, unknown> = {};

vi.mock('../js/core/bridge-registry.js', () => ({
  BridgeRegistry: {
    register:   (k: string, fn: unknown) => { registryMap[k] = fn; },
    unregister: (k: string) => { delete registryMap[k]; },
    has:        (k: string) => k in registryMap,
    get:        (k: string) => registryMap[k],
    call:       (k: string, ...a: unknown[]) => {
      const v = registryMap[k];
      return typeof v === 'function' ? (v as (...x: unknown[]) => unknown)(...a) : v;
    },
  },
}));

vi.mock('../js/core/logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

vi.mock('../js/core/a11y/focusTrap.ts', () => ({ focusTrap: () => ({ destroy() {} }) }));

import {
  normalizePref, isMuteActive, describeMute, snoozeUntil,
  fetchPrefs, saveServerLevel, saveChannelLevel, resetChannel,
  SNOOZE_OPTIONS, LEVELS,
} from '../js/core/notifications/notification-prefs-client.ts';
import NotificationPrefsPanel from '../js/core/NotificationPrefsPanel.svelte';

// ── Yardimcilar ────────────────────────────────────────────────────────────

const okResponse = (body: unknown = {}) =>
  ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const failResponse = (status = 500) =>
  ({ ok: false, status, json: async () => ({}) }) as unknown as Response;

const CHANNELS = [
  { _id: 'c1', name: 'genel', type: 'text' },
  { _id: 'c2', name: 'duyuru', type: 'text' },
  { _id: 'v1', name: 'Sesli', type: 'voice' },
];

/** Varsayilan mutlu yol ortami. */
function setupRegistry(api: unknown) {
  registryMap.apiFetch = api;
  registryMap.getCurrentServer = () => ({ _id: 's1', name: 'Takım' });
  registryMap.getCurrentServerChannels = () => CHANNELS;
}

async function openPanel() {
  (registryMap.showNotificationPrefsPanel as () => void)();
  await waitFor(() => expect(document.querySelector('.np-panel')).toBeTruthy());
  return document.querySelector<HTMLElement>('.np-panel')!;
}

const channelRows = () => [...document.querySelectorAll<HTMLElement>('.np-channel')];

beforeEach(() => {
  for (const k of Object.keys(registryMap)) delete registryMap[k];
  document.body.innerHTML = '';
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ════════════════════════════════════════════════════════════════════════════
describe('normalizePref', () => {
  it('kanal satirini cozer', () => {
    expect(normalizePref({ channelId: 'c1', level: 'mentions', muteUntil: null }))
      .toEqual({ channelId: 'c1', level: 'mentions', muteUntil: null });
  });

  it('SUNUCU-SEVIYESI satiri kanal listesine karismaz', () => {
    // Sunucu bu tercihi `server:<id>` ad alaninda saklar; kanal olarak
    // gostermek olmayan bir kanal satiri uretirdi.
    expect(normalizePref({ channelId: 'server:s1', level: 'mute' })).toBeNull();
  });

  it('taninmayan seviye varsayilana duser', () => {
    expect(normalizePref({ channelId: 'c1', level: 'uydurma' })!.level).toBe('default');
  });

  it('gecersiz muteUntil null olur', () => {
    expect(normalizePref({ channelId: 'c1', level: 'mute', muteUntil: 'abc' })!.muteUntil).toBeNull();
    expect(normalizePref({ channelId: 'c1', level: 'mute', muteUntil: -5 })!.muteUntil).toBeNull();
  });

  it('bozuk girdi cokmeye yol acmaz', () => {
    for (const bad of [null, undefined, 42, 'x', []]) expect(normalizePref(bad)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('erteleme (snooze)', () => {
  const now = 1_000_000;

  it('suresiz sessize alma etkindir', () => {
    expect(isMuteActive({ channelId: 'c', level: 'mute', muteUntil: null }, now)).toBe(true);
  });

  it('SURESI DOLMUS erteleme ETKIN SAYILMAZ', () => {
    // Sunucu gecmis bir `muteUntil`i kendiliginden temizlemez. "Sessize
    // alındı" demek, kullanici aslinda bildirim aliyorken YANLIS olurdu.
    expect(isMuteActive({ channelId: 'c', level: 'mute', muteUntil: now - 1 }, now)).toBe(false);
  });

  it('gelecekteki erteleme etkindir', () => {
    expect(isMuteActive({ channelId: 'c', level: 'mute', muteUntil: now + 60_000 }, now)).toBe(true);
  });

  it('mute olmayan seviye icin etkin degildir', () => {
    expect(isMuteActive({ channelId: 'c', level: 'all', muteUntil: null }, now)).toBe(false);
  });

  it('kalan sure insan diliyle anlatilir', () => {
    expect(describeMute({ channelId: 'c', level: 'mute', muteUntil: null }, now)).toContain('Süresiz');
    expect(describeMute({ channelId: 'c', level: 'mute', muteUntil: now + 30 * 60_000 }, now)).toContain('dakika');
    expect(describeMute({ channelId: 'c', level: 'mute', muteUntil: now + 5 * 3_600_000 }, now)).toContain('saat');
    expect(describeMute({ channelId: 'c', level: 'mute', muteUntil: now + 48 * 3_600_000 }, now)).toContain('gün');
    expect(describeMute({ channelId: 'c', level: 'mute', muteUntil: now - 1 }, now)).toContain('doldu');
  });

  it('secim mutlak zaman damgasina cevrilir', () => {
    const option = SNOOZE_OPTIONS.find(o => o.id === '1h')!;
    expect(snoozeUntil(option, now)).toBe(now + 3_600_000);
    expect(snoozeUntil(SNOOZE_OPTIONS.find(o => o.id === 'until')!, now)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('HTTP katmani', () => {
  it('sunucu kapsamiyla okur', async () => {
    const api = vi.fn(async () => okResponse({ channels: [], serverLevel: 'mentions' }));
    const snapshot = await fetchPrefs(api, 's1');

    expect(String(api.mock.calls[0]![0])).toContain('serverId=s1');
    expect(snapshot.serverLevel).toBe('mentions');
  });

  it('HATA FIRLATIR — sessizce basarili gorunmez', async () => {
    const api = vi.fn(async () => failResponse(500));
    await expect(fetchPrefs(api, 's1')).rejects.toThrow('HTTP 500');
    await expect(saveServerLevel(api, 's1', 'mute')).rejects.toThrow();
    await expect(saveChannelLevel(api, 'c1', 'mute')).rejects.toThrow();
    await expect(resetChannel(api, 'c1')).rejects.toThrow();
  });

  it('muteUntil YALNIZCA mute seviyesinde gonderilir', async () => {
    const api = vi.fn(async () => okResponse());
    await saveChannelLevel(api, 'c1', 'all', 12345);

    expect(JSON.parse(String(api.mock.calls[0]![1]!.body))).toMatchObject({ level: 'all', muteUntil: null });
  });

  it('mute seviyesinde muteUntil korunur', async () => {
    const api = vi.fn(async () => okResponse());
    await saveChannelLevel(api, 'c1', 'mute', 12345);
    expect(JSON.parse(String(api.mock.calls[0]![1]!.body))).toMatchObject({ muteUntil: 12345 });
  });

  it('kanal kimligi URL icin kacilir', async () => {
    const api = vi.fn(async () => okResponse());
    await resetChannel(api, 'a/b?c');
    expect(String(api.mock.calls[0]![0])).toBe('/api/notification-prefs/a%2Fb%3Fc');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('panel', () => {
  it('sunucu ve kanal ayarlarini cizer', async () => {
    setupRegistry(vi.fn(async () => okResponse({
      channels: [{ channelId: 'c1', level: 'mute', muteUntil: null }], serverLevel: 'mentions',
    })));
    render(NotificationPrefsPanel);
    await openPanel();

    // SES kanali listelenmez: orada "mesaj bildirimi" kavrami yoktur.
    await waitFor(() => expect(channelRows()).toHaveLength(2));
    expect(document.body.textContent).toContain('#genel');
    expect(document.body.textContent).not.toContain('#Sesli');
  });

  it('sunucu seviyesi degistirilebilir', async () => {
    const api = vi.fn(async () => okResponse({ channels: [], serverLevel: 'all' }));
    setupRegistry(api);
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() => expect(document.querySelectorAll('[role="radio"]').length).toBeGreaterThan(0));
    const serverRadios = [...document.querySelectorAll<HTMLElement>('.np-levels:not(.np-levels-compact) [role="radio"]')];
    await fireEvent.click(serverRadios[1]!);

    await waitFor(() => {
      const put = api.mock.calls.find(c => String(c[0]).endsWith('/server'));
      expect(put).toBeTruthy();
      expect(JSON.parse(String(put![1]!.body))).toMatchObject({ serverId: 's1', level: 'mentions' });
    });
  });

  it('kanal seviyesi degistirilebilir', async () => {
    const api = vi.fn(async () => okResponse({ channels: [], serverLevel: 'all' }));
    setupRegistry(api);
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() => expect(channelRows()).toHaveLength(2));
    const compact = channelRows()[0]!.querySelectorAll<HTMLElement>('[role="radio"]');
    await fireEvent.click(compact[2]!);   // mute

    await waitFor(() => {
      const put = api.mock.calls.find(c => String(c[0]) === '/api/notification-prefs');
      expect(JSON.parse(String(put![1]!.body))).toMatchObject({ channelId: 'c1', level: 'mute' });
    });
  });

  it('KAYDEDILEMEYEN ayar GERI ALINIR ve hata gosterilir', async () => {
    // Iyimser guncellemeyi yerinde birakmak, kaydedilmemis bir ayari
    // kaydedilmis gibi gosterirdi.
    const api = vi.fn(async (url: string, init?: RequestInit) =>
      init?.method === 'PUT' ? failResponse(500) : okResponse({ channels: [], serverLevel: 'all' }));
    setupRegistry(api);
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() => expect(channelRows()).toHaveLength(2));
    const compact = channelRows()[0]!.querySelectorAll<HTMLElement>('[role="radio"]');
    await fireEvent.click(compact[2]!);

    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
    // Seviye geri alinmis olmali — hicbiri "mute" isaretli kalmamali.
    expect(channelRows()[0]!.querySelector('[role="radio"][aria-checked="true"]')).toBeNull();
  });

  it('mute secilince ERTELEME secenekleri gorunur', async () => {
    setupRegistry(vi.fn(async () => okResponse({
      channels: [{ channelId: 'c1', level: 'mute', muteUntil: null }], serverLevel: 'all',
    })));
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() => expect(document.querySelectorAll('.np-snooze-btn').length).toBe(SNOOZE_OPTIONS.length));
    expect(document.body.textContent).toContain('Süresiz sessize alındı');
  });

  it('erteleme secimi mutlak zaman gonderir', async () => {
    const api = vi.fn(async () => okResponse({
      channels: [{ channelId: 'c1', level: 'mute', muteUntil: null }], serverLevel: 'all',
    }));
    setupRegistry(api);
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() => expect(document.querySelector('.np-snooze-btn')).toBeTruthy());
    await fireEvent.click(document.querySelector('.np-snooze-btn')!);

    await waitFor(() => {
      const put = api.mock.calls.find(c => c[1] && (c[1] as RequestInit).method === 'PUT');
      const body = JSON.parse(String((put![1] as RequestInit).body));
      expect(body.level).toBe('mute');
      expect(typeof body.muteUntil).toBe('number');
      expect(body.muteUntil).toBeGreaterThan(Date.now());
    });
  });

  it('varsayilana donus DELETE gonderir', async () => {
    const api = vi.fn(async () => okResponse({
      channels: [{ channelId: 'c1', level: 'mentions', muteUntil: null }], serverLevel: 'all',
    }));
    setupRegistry(api);
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() => expect(document.querySelector('.np-reset')).toBeTruthy());
    await fireEvent.click(document.querySelector('.np-reset')!);

    await waitFor(() => {
      const del = api.mock.calls.find(c => (c[1] as RequestInit | undefined)?.method === 'DELETE');
      expect(String(del![0])).toContain('/api/notification-prefs/c1');
    });
  });

  it('sunucu secili degilse NEDENI soyler', async () => {
    registryMap.apiFetch = vi.fn(async () => okResponse());
    registryMap.getCurrentServer = () => null;
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')!.textContent).toContain('sunucu seçin'));
  });

  it('yukleme hatasi ACIKCA bildirilir', async () => {
    setupRegistry(vi.fn(async () => failResponse(500)));
    render(NotificationPrefsPanel);
    await openPanel();

    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
  });

  it('erisilebilirlik sozlesmesi', async () => {
    setupRegistry(vi.fn(async () => okResponse({ channels: [], serverLevel: 'all' })));
    render(NotificationPrefsPanel);
    const panel = await openPanel();

    expect(panel.getAttribute('role')).toBe('dialog');
    expect(panel.getAttribute('aria-modal')).toBe('true');
    await waitFor(() => expect(document.querySelectorAll('[role="radiogroup"]').length).toBeGreaterThan(0));
    // Seviye secimi RENKTEN baska isaret de tasir.
    for (const group of document.querySelectorAll('[role="radiogroup"]')) {
      expect(group.getAttribute('aria-label') || group.getAttribute('aria-labelledby')).toBeTruthy();
      expect(group.querySelectorAll('[aria-checked]').length).toBe(LEVELS.length);
    }
    expect(document.querySelector('[role="status"]')!.getAttribute('aria-live')).toBe('polite');
  });

  it('Escape kapatir', async () => {
    setupRegistry(vi.fn(async () => okResponse({ channels: [], serverLevel: 'all' })));
    render(NotificationPrefsPanel);
    const panel = await openPanel();

    await fireEvent.keyDown(panel, { key: 'Escape' });
    await waitFor(() => expect(document.querySelector('.np-panel')).toBeNull());
  });

  it('unmount kayitlari birakir', () => {
    const { unmount } = render(NotificationPrefsPanel);
    expect('showNotificationPrefsPanel' in registryMap).toBe(true);
    unmount();
    expect('showNotificationPrefsPanel' in registryMap).toBe(false);
  });
});
