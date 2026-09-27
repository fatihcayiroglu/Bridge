// client/tests/analytics-tab-deep-coverage.test.ts
//
// ════════════════════════════════════════════════════════════════════════════
// AnalyticsTab — SUNUCU BAĞLAMI, YARIŞ, SEYREK VERİ VE CSV DIŞA AKTARIM
// ════════════════════════════════════════════════════════════════════════════
//
// Ölçülmemiş dalların taşıdığı gerçek riskler:
//
//   · YANLIŞ SUNUCU — kullanıcı sekme açıkken sunucu değiştirebilir. Analitik
//     bir sunucunun üye/mesaj sayılarını AÇIĞA ÇIKARIR; eski bağlamın verisi
//     yeni sunucunun ekranında gösterilirse bu bir sızıntıdır.
//   · YARIŞ — dönem değiştirildiğinde eski istek geç dönebilir; eskiyen sonuç
//     yeni dönemin ekranını EZMEMELİDİR.
//   · SEYREK/BOZUK VERİ — sayaçlar `undefined`, negatif veya metin gelebilir;
//     ekranda "NaN"/"-3" değil, belgelenmiş 0 görünmelidir.
//   · GİZLİLİK — sunucu hata gövdesi kullanıcıya HAM gösterilmez.
//   · CSV — dışa aktarım yalnızca sahibe açıktır ve nesne URL'i her durumda
//     serbest bırakılır.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { t } from '../js/core/i18n/index.ts';

let apiMock: ReturnType<typeof vi.fn>;
let stillCurrent = true;

vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: (...args: unknown[]) => apiMock(...args) }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => 'https://bridge.test' }));
vi.mock('../js/core/server-settings/stores/serverSettingsStore.ts', () => ({
  getCurrentServerFromRegistry: () => ({ _id: 'srv-1' }),
  isStillCurrentServer: () => stillCurrent,
}));

import AnalyticsTab from '../js/core/server-settings/tabs/AnalyticsTab.svelte';

type StoreProp = { serverId: string };
const store = (serverId = 'srv-1'): StoreProp => ({ serverId });

const ok = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body, blob: async () => new Blob([String(body)]) }) as unknown as Response;
const fail = (status: number, body: unknown = {}): Response =>
  ({ ok: false, status, json: async () => body, blob: async () => new Blob() }) as unknown as Response;

const SUMMARY = {
  memberCount: 1234, channelCount: 9, totalMessages: 98765,
  activeUsers7d: 44, activeUsers30d: 210, isOwner: true,
  topUsers: [
    { userId: 'u1', displayName: 'Ada', msgCount: 500 },
    { userId: 'u2', displayName: 'Linus', msgCount: 250 },
  ],
  channelBreakdown: [
    { channelId: 'c1', channelName: 'genel', msgCount: 800 },
    { channelId: 'c2', channelName: 'random', msgCount: 200 },
  ],
};
const GROWTH = {
  days: 30,
  joinSeries: [{ day: '2026-09-01', newMembers: 3 }, { day: '2026-09-02', newMembers: 4 }],
  cumulativeSeries: [{ day: '2026-09-01', totalMembers: 100 }, { day: '2026-09-02', totalMembers: 104 }],
  messageSeries: [{ day: '2026-09-01', msgCount: 10 }],
};
const ACTIVITY = {
  hourlyDistribution: [{ hour: 0, label: '00', msgCount: 5 }, { hour: 13, label: '13', msgCount: 50 }],
  weeklyDistribution: [{ dow: 1, label: 'Pazartesi', msgCount: 30 }, { dow: 2, label: 'Salı', msgCount: 60 }],
  peakHour: { hour: 13, label: '13', msgCount: 50 },
  peakDay: { dow: 2, label: 'Salı', msgCount: 60 },
};
const RETENTION = { dau: 20, wau: 80, mau: 200, dauRate: 10, wauRate: 40, mauRate: 100, dauMauRatio: 10 };

function routed(over: Partial<Record<'stats' | 'growth' | 'activity' | 'retention' | 'export', Response>> = {}) {
  return vi.fn(async (url: string) => {
    if (url.includes('export.csv')) return over.export ?? ok('csv');
    if (url.includes('/stats/growth')) return over.growth ?? ok(GROWTH);
    if (url.includes('/stats/activity')) return over.activity ?? ok(ACTIVITY);
    if (url.includes('/stats/retention')) return over.retention ?? ok(RETENTION);
    return over.stats ?? ok(SUMMARY);
  });
}

async function flush(): Promise<void> {
  for (let i = 0; i < 12; i += 1) { await tick(); await Promise.resolve(); }
}

const text = (): string => document.body.textContent ?? '';
const errorBox = (): HTMLElement | null => document.querySelector('.analytics-error');
const inlineError = (): HTMLElement | null => document.querySelector('.inline-error');
const periodSelect = (): HTMLSelectElement => document.querySelector('select')!;
const buttons = (): HTMLButtonElement[] => [...document.querySelectorAll<HTMLButtonElement>('.analytics-actions .btn')];
const csvButton = (): HTMLButtonElement | undefined => buttons().find(b => /CSV|Haz/.test(b.textContent ?? ''));
const barWidths = (selector: string): string[] =>
  [...document.querySelectorAll<HTMLElement>(selector)].map(node => node.style.width);
const urls = (): string[] => apiMock.mock.calls.map(call => String(call[0]));

let createObjectURL: ReturnType<typeof vi.fn>;
let revokeObjectURL: ReturnType<typeof vi.fn>;
let anchorClick: ReturnType<typeof vi.fn>;

beforeEach(() => {
  stillCurrent = true;
  apiMock = routed();
  createObjectURL = vi.fn(() => 'blob:analytics');
  revokeObjectURL = vi.fn();
  anchorClick = vi.fn();
  vi.stubGlobal('URL', Object.assign(globalThis.URL, { createObjectURL, revokeObjectURL }));
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click(this: HTMLAnchorElement) {
    anchorClick(this.download, this.href, this.rel);
  });
  document.body.innerHTML = '';
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = '';
});

describe('AnalyticsTab rendering', () => {
  it('renders every panel from a complete payload and requests each scoped endpoint once', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    expect(urls()).toEqual([
      'https://bridge.test/api/servers/srv-1/stats',
      'https://bridge.test/api/servers/srv-1/stats/growth?days=30',
      'https://bridge.test/api/servers/srv-1/stats/activity',
      'https://bridge.test/api/servers/srv-1/stats/retention',
    ]);
    // Yonlendirme takip edilmez: analitik ucu baska bir kaynaga savrulamaz.
    for (const call of apiMock.mock.calls) expect(call[1]).toEqual({ redirect: 'error' });

    const nf = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });
    expect(text()).toContain(nf.format(1234));
    expect(text()).toContain(nf.format(98765));
    expect(text()).toContain('Ada');
    expect(text()).toContain('#genel');
    // Zirve gun/saat icgoruleri yalnizca veri varsa cizilir.
    expect(text()).toContain('Salı');
    expect(document.querySelectorAll('.trend-bar')).toHaveLength(2);
    expect(document.querySelectorAll('.hour-grid span')).toHaveLength(2);
    expect(text()).toContain(nf.format(7));
    expect(errorBox()).toBeNull();
  });

  it('the server id is url-encoded so a hostile id cannot escape the stats path', async () => {
    render(AnalyticsTab, { props: { store: store('srv/../admin?x=1') } });
    await flush();

    expect(urls()[0]).toBe('https://bridge.test/api/servers/srv%2F..%2Fadmin%3Fx%3D1/stats');
  });

  it('negative, non-numeric and missing counters degrade to zero instead of NaN', async () => {
    apiMock = routed({
      stats: ok({
        ...SUMMARY,
        memberCount: -5, totalMessages: 'lots', activeUsers7d: null, activeUsers30d: Number.NaN,
        topUsers: [{ userId: 'u1', displayName: 'Ada', msgCount: -10 }],
        channelBreakdown: [{ channelId: 'c1', channelName: 'genel', msgCount: undefined }],
      }),
      retention: ok({}),
      activity: ok({ hourlyDistribution: [], weeklyDistribution: [] }),
    });
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    expect(text()).not.toContain('NaN');
    expect(text()).not.toContain('-5');
    expect(text()).not.toContain('-10');
    // Bolen 0 oldugunda yuzde 0'dir; genislik hesabi patlamaz.
    expect(barWidths('.bar-row b')).toEqual(['0%', '0%']);
    // Zirve gun/saat yoksa o icgoruler hic cizilmez.
    expect(document.querySelectorAll('.hour-grid span')).toHaveLength(0);
    expect(text()).toContain('DAU/MAU');
  });

  it('empty channel and member breakdowns show explicit empty copy, not blank panels', async () => {
    apiMock = routed({ stats: ok({ ...SUMMARY, topUsers: [], channelBreakdown: [] }) });
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    expect(document.querySelectorAll('.empty')).toHaveLength(2);
    expect(document.querySelectorAll('.bar-list .bar-row')).toHaveLength(2); // yalnizca haftalik dagilim
  });

  it('bar widths are proportional to the largest row and clamp at 100%', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    // haftalik(30/60, 60/60) + kanal(800/800, 200/800) + uye(500/500, 250/500)
    expect(barWidths('.bar-row b')).toEqual(['50%', '100%', '100%', '25%', '100%', '50%']);
  });
});

describe('AnalyticsTab server context', () => {
  it('a server change before loading blocks every request and explains why', async () => {
    stillCurrent = false;
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    expect(apiMock).not.toHaveBeenCalled();
    expect(errorBox()?.textContent).toContain(t('srv_changed', 'Sunucu değişti — ayarlar yeniden yüklenmeli.'));
    expect(text()).not.toContain('Ada');
  });

  it('an empty server id is treated as no context at all', async () => {
    render(AnalyticsTab, { props: { store: store('') } });
    await flush();

    expect(apiMock).not.toHaveBeenCalled();
    expect(errorBox()).not.toBeNull();
  });

  it('a server change while the request is in flight discards the stale payload', async () => {
    apiMock = vi.fn(async (url: string) => {
      stillCurrent = false; // yanit donerken kullanici sunucu degistirdi
      if (url.includes('/stats/growth')) return ok(GROWTH);
      if (url.includes('/stats/activity')) return ok(ACTIVITY);
      if (url.includes('/stats/retention')) return ok(RETENTION);
      return ok(SUMMARY);
    });
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    expect(apiMock).toHaveBeenCalledTimes(4);
    // Eski sunucunun uye/mesaj sayilari EKRANA yazilmaz.
    expect(text()).not.toContain('Ada');
    expect(text()).not.toContain('#genel');
  });
});

describe('AnalyticsTab period switching and races', () => {
  it('changing the period refetches growth for the new window', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    periodSelect().value = '7';
    periodSelect().dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    expect(urls().filter(url => url.includes('/stats/growth'))).toEqual([
      'https://bridge.test/api/servers/srv-1/stats/growth?days=30',
      'https://bridge.test/api/servers/srv-1/stats/growth?days=7',
    ]);
    expect(periodSelect().value).toBe('7');
  });

  it('a superseded slow response cannot overwrite the newer one', async () => {
    const gates: Array<() => void> = [];
    apiMock = vi.fn((url: string) => new Promise<Response>((resolve) => {
      const body = url.includes('/stats/growth') ? GROWTH
        : url.includes('/stats/activity') ? ACTIVITY
        : url.includes('/stats/retention') ? RETENTION
        : SUMMARY;
      gates.push(() => resolve(ok(body)));
    }));
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    // Ikinci yukleme baslatilir; ILK yukleme hala askidadir.
    buttons()[0]!.click();
    await flush();
    // Once YENI tur cozulur, sonra ESKI tur.
    for (const gate of gates.slice(4)) gate();
    await flush();
    for (const gate of gates.slice(0, 4)) gate();
    await flush();

    expect(document.querySelector('.analytics-state')).toBeNull();
    expect(text()).toContain('Ada');
  });

  it('a refresh over existing data keeps the table and shows a refreshing state, not a full loader', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    let release!: () => void;
    apiMock.mockImplementation(() => new Promise<Response>((resolve) => { release = () => resolve(ok(SUMMARY)); }));
    buttons()[0]!.click();
    await tick();

    expect(document.querySelector('.analytics-state')).toBeNull();
    expect(text()).toContain('Ada');
    expect(buttons()[0]!.disabled).toBe(true);
    expect(periodSelect().disabled).toBe(true);
    release();
    await flush();
  });
});

describe('AnalyticsTab failure handling', () => {
  it('a failed first load shows a retry affordance and never echoes the server body', async () => {
    apiMock = routed({ stats: fail(500, { error: 'pg: relation server_stats does not exist' }) });
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    const box = errorBox();
    expect(box).not.toBeNull();
    expect(box!.textContent).not.toContain('relation server_stats');
    expect(box!.textContent).not.toContain('pg:');
    expect(box!.textContent!.trim().length).toBeGreaterThan(0);

    apiMock.mockImplementation(routed());
    box!.querySelector('button')!.click();
    await flush();

    expect(errorBox()).toBeNull();
    expect(text()).toContain('Ada');
  });

  it('a failed refresh keeps the previous data and reports the failure inline', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();
    expect(text()).toContain('Ada');

    apiMock.mockImplementation(async () => fail(403, { error: 'tenant-b audit trail' }));
    buttons()[0]!.click();
    await flush();

    expect(inlineError()).not.toBeNull();
    expect(inlineError()!.textContent).not.toContain('tenant-b');
    // Eski veri silinmez: kullanici bos ekranla kalmaz.
    expect(text()).toContain('Ada');
    expect(errorBox()).toBeNull();
  });

  it('a network rejection is reported without leaking the thrown detail', async () => {
    apiMock = vi.fn(async () => { throw new Error('ECONNREFUSED 10.0.0.5:5432'); });
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    expect(errorBox()).not.toBeNull();
    expect(errorBox()!.textContent).not.toContain('10.0.0.5');
  });
});

describe('AnalyticsTab CSV export', () => {
  it('the export control exists only for the owner', async () => {
    apiMock = routed({ stats: ok({ ...SUMMARY, isOwner: false }) });
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    expect(csvButton()).toBeUndefined();
    expect(buttons()).toHaveLength(1);
  });

  it('exporting downloads a server-scoped file and always releases the object URL', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    csvButton()!.click();
    await flush();

    expect(urls().at(-1)).toBe('https://bridge.test/api/servers/srv-1/stats/export.csv?days=30');
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledWith('bridge-analytics-srv-1.csv', expect.stringContaining('blob:analytics'), 'noopener');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:analytics');
  });

  it('the export follows the currently selected period', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();
    periodSelect().value = '90';
    periodSelect().dispatchEvent(new Event('change', { bubbles: true }));
    await flush();

    csvButton()!.click();
    await flush();

    expect(urls().at(-1)).toContain('export.csv?days=90');
  });

  it('a failed export reports inline and still revokes the URL it never created', async () => {
    apiMock = routed({ export: fail(402, { error: 'billing account 771 suspended' }) });
    render(AnalyticsTab, { props: { store: store() } });
    await flush();

    csvButton()!.click();
    await flush();

    expect(inlineError()).not.toBeNull();
    expect(inlineError()!.textContent).not.toContain('771');
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(revokeObjectURL).not.toHaveBeenCalled();
    // Kilit acilir: kullanici tekrar deneyebilir.
    expect(csvButton()!.disabled).toBe(false);
  });

  it('a server change after loading blocks the export before it reaches the network', async () => {
    render(AnalyticsTab, { props: { store: store() } });
    await flush();
    const before = apiMock.mock.calls.length;

    stillCurrent = false;
    csvButton()!.click();
    await flush();

    expect(apiMock.mock.calls).toHaveLength(before);
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
