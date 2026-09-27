import { afterEach, describe, expect, it, vi } from 'vitest';
import { tick } from 'svelte';
import { cleanup, render } from '@testing-library/svelte';
import SavedPanel from '../js/core/SavedPanel.svelte';
import { BridgeRegistry, type AnyFn } from '../js/core/bridge-registry.ts';
import { closeProductDialog } from '../js/core/product-dialog.ts';
import { localeTag, t } from '../js/core/i18n/index.ts';

const DAY = 86_400_000;

function response(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as Response;
}

function channelRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'saved-1',
    savedAt: Date.now() - 120_000,
    unavailable: false,
    preview: 'Release checklist',
    sender: { _id: 'sender-1', displayName: 'Ada' },
    destination: {
      type: 'channel',
      messageId: 'message-1',
      channelId: 'channel-1',
      serverId: 'server-1',
      channel: { _id: 'channel-1', name: 'private' },
      server: { _id: 'server-1', name: 'Team' },
    },
    ...overrides,
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 10; i += 1) { await tick(); await Promise.resolve(); }
}

const remindButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('.saved-remind')];
const clearButtons = (): HTMLButtonElement[] =>
  [...document.querySelectorAll<HTMLButtonElement>('.saved-remind-clear')];
const destinations = (): string[] =>
  [...document.querySelectorAll('.saved-destination')].map(node => node.textContent ?? '');

async function mount(rows: unknown[], api?: ReturnType<typeof vi.fn>): Promise<ReturnType<typeof vi.fn>> {
  const fetcher = api ?? vi.fn(async () => response({ items: rows }));
  BridgeRegistry.register('apiFetch', fetcher as AnyFn);
  render(SavedPanel);
  BridgeRegistry.call('showSaved');
  await flush();
  return fetcher;
}

/** Urun diyalogunu gercek DOM'u uzerinden surer; promptProductText mock'lanmaz. */
async function answerPrompt(value: string | null): Promise<void> {
  await flush();
  const input = document.querySelector<HTMLInputElement>('.bridge-product-dialog-input');
  expect(input).not.toBeNull();
  if (value === null) {
    document.querySelector<HTMLButtonElement>('[data-product-dialog-action="cancel"]')!.click();
  } else {
    input!.value = value;
    document.querySelector<HTMLButtonElement>('[data-product-dialog-action="confirm"]')!.click();
  }
  await flush();
}

function localParts(at: number): string {
  const d = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function reminderCall(api: ReturnType<typeof vi.fn>): { url: string; body: Record<string, unknown> } {
  const call = api.mock.calls.find(entry => String(entry[0]).includes('/reminder'));
  if (!call) throw new Error('hatirlatici istegi yapilmadi');
  return { url: String(call[0]), body: JSON.parse(String((call[1] as RequestInit).body)) };
}

function reset(): void {
  closeProductDialog();
  cleanup();
  BridgeRegistry.unregister('toast');
  document.body.innerHTML = '';
}

afterEach(() => {
  closeProductDialog();
  cleanup();
  for (const key of ['apiFetch', 'showSaved', 'openSaved', 'saveForLater', 'toast', 'navigateToChannel']) {
    BridgeRegistry.unregister(key);
  }
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('SavedPanel reminder normalisation and labels', () => {
  it('non-safe-integer/negative remindAt and remindedAt values do not count as reminders', async () => {
    const scheduledAt = Date.now() + 3 * DAY;
    const remindedAt = Date.now() - 60_000;
    await mount([
      channelRow({ id: 'unsafe', preview: 'unsafe', remindAt: Number.MAX_SAFE_INTEGER + 2 }),
      channelRow({ id: 'negative', preview: 'negative', remindAt: -5 }),
      channelRow({ id: 'string', preview: 'string', remindAt: '2h' }),
      channelRow({ id: 'fractional', preview: 'fractional', remindAt: scheduledAt + 0.5 }),
      channelRow({ id: 'scheduled', preview: 'scheduled', remindAt: scheduledAt, remindedAt: 0 }),
      channelRow({ id: 'fired', preview: 'fired', remindAt: scheduledAt - 4 * DAY, remindedAt }),
      channelRow({ id: 'fired-unsafe', preview: 'fired-unsafe', remindAt: scheduledAt, remindedAt: Number.NaN }),
    ]);

    const labels = remindButtons().map(button => button.textContent ?? '');
    const fallback = t('ui_hatirlat', 'Hatirlat');
    // Reddedilen dort deger de "hatirlatici yok" durumuna duser: temizle dugmesi de cikmaz.
    expect(labels.slice(0, 4)).toEqual([fallback, fallback, fallback, fallback]);
    expect(labels[4]).toBe(`⏰ ${new Date(scheduledAt).toLocaleString()}`);
    expect(labels[5]).toBe(t('saved_reminded_at', 'Hatirlatildi · {date}', {
      date: new Date(remindedAt).toLocaleString(localeTag()),
    }));
    // remindedAt reddedilince satir "hatirlatildi" degil, hala "planlandi" gorunur.
    expect(labels[6]).toBe(`⏰ ${new Date(scheduledAt).toLocaleString()}`);
    expect(clearButtons()).toHaveLength(3);
    // Etiket erisilebilirlik icin title olarak da yansitilir.
    expect(remindButtons()[4]!.title).toBe(labels[4]);
  });

  it('destination label falls back safely for missing server/channel/user fields', async () => {
    await mount([
      channelRow({
        id: 'no-server-name',
        destination: {
          type: 'channel', messageId: 'm-1', channelId: 'c-1',
          channel: { _id: 'c-1', name: 'ops' }, server: { _id: 's-1' },
        },
      }),
      channelRow({
        id: 'no-channel-object',
        destination: { type: 'channel', messageId: 'm-2', channelId: 'c-2' },
      }),
      channelRow({
        id: 'dm-username-only',
        destination: { type: 'dm', messageId: 'm-3', user: { _id: 'u-1', username: 'ada' } },
      }),
      channelRow({
        id: 'dm-id-only',
        destination: { type: 'dm', messageId: 'm-4', user: { _id: 'u-2' } },
      }),
      channelRow({
        id: 'gdm-no-name',
        destination: { type: 'gdm', messageId: 'm-5', group: { _id: 'g-1' } },
      }),
    ]);

    expect(destinations()).toEqual([
      'Bridge · #ops',
      `Bridge · #${t('ui_channel_fallback', 'kanal')}`,
      'ada',
      'Bridge user',
      'Grup DM',
    ]);
  });
});

describe('SavedPanel setting a reminder', () => {
  it('relative inputs resolve as minutes/hours/days and land in the PUT body', async () => {
    for (const [input, ms] of [['30m', 1_800_000], ['2H', 7_200_000], [' 3d ', 3 * DAY]] as const) {
      const api = vi.fn(async (url: string) => (url.includes('/reminder')
        ? response({ ok: true })
        : response({ items: [channelRow()] })));
      await mount([], api);
      const before = Date.now();

      remindButtons()[0]!.click();
      await answerPrompt(input);

      const { url, body } = reminderCall(api);
      expect(url).toContain('/api/saved/saved-1/reminder');
      expect(typeof body.remindAt).toBe('number');
      expect(body.remindAt as number).toBeGreaterThanOrEqual(before + ms);
      expect(body.remindAt as number).toBeLessThan(before + ms + 10_000);
      reset();
    }
  });

  it('absolute "YYYY-MM-DD HH:MM" input is accepted as local time', async () => {
    const target = new Date(Date.now() + 2 * DAY);
    target.setSeconds(0, 0);
    const api = vi.fn(async (url: string) => (url.includes('/reminder')
      ? response({ ok: true })
      : response({ items: [channelRow()] })));
    await mount([], api);

    remindButtons()[0]!.click();
    await answerPrompt(localParts(target.getTime()));

    expect(reminderCall(api).body.remindAt).toBe(target.getTime());
  });

  it('out-of-range, past and meaningless inputs never reach the network boundary', async () => {
    const tooFar = new Date(Date.now() + 40 * DAY);
    for (const value of ['0m', '4s', '31d', '45d', 'yarin', '', '2020-01-01 10:00', localParts(tooFar.getTime())]) {
      const toast = vi.fn();
      BridgeRegistry.register('toast', toast);
      const api = vi.fn(async () => response({ items: [channelRow()] }));
      await mount([], api);

      remindButtons()[0]!.click();
      await answerPrompt(value);

      expect(api.mock.calls.some(entry => String(entry[0]).includes('/reminder'))).toBe(false);
      expect(toast).toHaveBeenCalledWith(
        t('ui_gecerli_ve_gelecekte_bir_zaman_girin_en_fazla_30_gun', 'Gecerli ve gelecekte bir zaman girin (en fazla 30 gun).'),
        'error',
      );
      expect(remindButtons()[0]!.textContent).toBe(t('ui_hatirlat', 'Hatirlat'));
      reset();
    }
  });

  it('cancelling the dialog issues no request and leaves the row untouched', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    const api = vi.fn(async () => response({ items: [channelRow()] }));
    await mount([], api);

    remindButtons()[0]!.click();
    await answerPrompt(null);

    expect(api.mock.calls.some(entry => String(entry[0]).includes('/reminder'))).toBe(false);
    expect(toast).not.toHaveBeenCalled();
    expect(clearButtons()).toHaveLength(0);
  });

  it('an unavailable message cannot get a reminder even if disabled is stripped from the DOM', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    const api = vi.fn(async () => response({ items: [channelRow({ unavailable: true })] }));
    await mount([], api);

    const button = remindButtons()[0]!;
    expect(button.disabled).toBe(true);
    // Savunma derinligi: disabled ozniteligi DOM tarafinda dusurulse de guard tutar.
    button.disabled = false;
    button.click();
    await flush();

    expect(document.querySelector('.bridge-product-dialog-input')).toBeNull();
    expect(api.mock.calls.some(entry => String(entry[0]).includes('/reminder'))).toBe(false);
    expect(toast).toHaveBeenCalledWith(
      t('ui_artik_erisilemeyen_bir_mesaj_icin_yeni_hatirlatici_k', 'Artik erisilemeyen bir mesaj icin yeni hatirlatici kurulamaz.'),
      'warning',
    );
  });

  it('a successful set patches the row optimistically and clears a previous "reminded" state', async () => {
    const toast = vi.fn();
    BridgeRegistry.register('toast', toast);
    const api = vi.fn(async (url: string) => (url.includes('/reminder')
      ? response({ ok: true })
      : response({ items: [channelRow({ remindAt: Date.now() - DAY, remindedAt: Date.now() - 3_600_000 })] })));
    await mount([], api);
    expect(remindButtons()[0]!.textContent).toContain(t('saved_reminded_at', 'Hatirlatildi · {date}', { date: '' }).split('·')[0]!.trim());

    remindButtons()[0]!.click();
    await answerPrompt('2h');

    const { body } = reminderCall(api);
    expect(remindButtons()[0]!.textContent).toBe(`⏰ ${new Date(body.remindAt as number).toLocaleString()}`);
    expect(clearButtons()).toHaveLength(1);
    expect(toast).toHaveBeenCalledWith(t('ui_hatirlatici_kuruldu', 'Hatirlatici kuruldu.'), 'success');
  });

  it('non-2xx responses and network failures raise distinct warnings without changing the row', async () => {
    for (const [mode, expected] of [
      ['status', t('ui_hatirlatici_kurulamadi', 'Hatirlatici kurulamadi.')],
      ['throw', t('ui_hatirlatici_kurulamadi_baglantini_kontrol_et', 'Hatirlatici kurulamadi. Baglantini kontrol et.')],
    ] as const) {
      const toast = vi.fn();
      BridgeRegistry.register('toast', toast);
      const api = vi.fn(async (url: string) => {
        if (!url.includes('/reminder')) return response({ items: [channelRow()] });
        if (mode === 'throw') throw new Error('offline');
        return response({ error: 'saved reminder store detail' }, 503);
      });
      await mount([], api);

      remindButtons()[0]!.click();
      await answerPrompt('2h');

      expect(toast).toHaveBeenCalledWith(expected, 'error');
      for (const call of toast.mock.calls) expect(String(call[0])).not.toContain('store detail');
      expect(remindButtons()[0]!.textContent).toBe(t('ui_hatirlat', 'Hatirlat'));
      expect(clearButtons()).toHaveLength(0);
      reset();
    }
  });
});

describe('SavedPanel clearing a reminder', () => {
  it('the clear request sends remindAt: null and returns the row to the fallback label', async () => {
    const api = vi.fn(async (url: string) => (url.includes('/reminder')
      ? response({ ok: true })
      : response({ items: [channelRow({ remindAt: Date.now() + DAY })] })));
    await mount([], api);
    expect(clearButtons()).toHaveLength(1);

    clearButtons()[0]!.click();
    await flush();

    const { url, body } = reminderCall(api);
    expect(url).toContain('/api/saved/saved-1/reminder');
    expect(body).toEqual({ remindAt: null });
    expect(remindButtons()[0]!.textContent).toBe(t('ui_hatirlat', 'Hatirlat'));
    expect(clearButtons()).toHaveLength(0);
  });

  it('a failed clear keeps the reminder on screen and emits a single generic warning', async () => {
    for (const mode of ['status', 'throw'] as const) {
      const toast = vi.fn();
      BridgeRegistry.register('toast', toast);
      const remindAt = Date.now() + DAY;
      const api = vi.fn(async (url: string) => {
        if (!url.includes('/reminder')) return response({ items: [channelRow({ remindAt })] });
        if (mode === 'throw') throw new Error('offline');
        return response({ error: 'reminder row locked' }, 500);
      });
      await mount([], api);

      clearButtons()[0]!.click();
      await flush();

      expect(toast).toHaveBeenCalledWith(t('ui_hatirlatici_kaldirilamadi', 'Hatirlatici kaldirilamadi.'), 'error');
      expect(toast).toHaveBeenCalledTimes(1);
      expect(remindButtons()[0]!.textContent).toBe(`⏰ ${new Date(remindAt).toLocaleString()}`);
      expect(clearButtons()).toHaveLength(1);
      reset();
    }
  });
});
