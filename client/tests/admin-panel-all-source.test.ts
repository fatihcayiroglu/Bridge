import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/svelte';
import { t } from '../js/core/i18n/index.ts';

const apiFetch = vi.fn();
const registry: Record<string, unknown> = {};
const toast = vi.fn();

vi.mock('../js/core/api-fetch.ts', () => ({ apiFetch: (...args: unknown[]) => apiFetch(...args) }));
vi.mock('../js/core/globals.ts', () => ({ getAPI: () => '' }));
vi.mock('../js/core/bridge-registry.ts', () => ({
  BridgeRegistry: {
    register(key: string, value: unknown) { registry[key] = value; },
    unregister(key: string) { delete registry[key]; },
    has(key: string) { return key in registry; },
    get(key: string) { return registry[key]; },
    call(key: string, ...args: unknown[]) {
      const value = registry[key];
      return typeof value === 'function' ? (value as (...a: unknown[]) => unknown)(...args) : value;
    },
  },
}));
vi.mock('../js/core/i18n/reactive.svelte.ts', async () => {
  // Delegate to the canonical catalog `t`. The previous hand-rolled stub
  // did `Object.entries(vars).reduce((out) => out.replace(...), fallback)`,
  // which threw TypeError for every real call shaped `t(key, undefined,
  // { vars })` — the panel then stayed stuck on its loading branch and all
  // 15 tests in this file measured nothing.
  const real = await vi.importActual<typeof import('../js/core/i18n/index.ts')>('../js/core/i18n/index.ts');
  return { t: real.t, $t: real.t, localeTag: () => 'tr', localeTick: () => 0 };
});

import AdminPanel from '../js/admin/AdminPanel.svelte';

const now = Date.now();
const stats = {
  totals: { totalUsers: 10, totalServers: 2, totalMessages: 30, totalDMs: 4, onlineUsers: 5, verifiedEmails: 6, twoFaEnabled: 7, newUsers7d: 8 },
  msgsByDay: [
    { day: Math.floor(now / 86_400_000), n: 3 },
    { day: Math.floor(now / 86_400_000) - 1, n: 1 },
    { day: Math.floor(now / 86_400_000) - 2, n: 2 },
  ],
  topServers: [{ name: 'Main', memberCount: 9 }],
  topUsers: [{ displayName: 'Alice', msgCount: 12 }],
};
const users = [
  { _id: 'u1', displayName: 'Alice', username: 'alice', email: 'a@example.test', emailVerified: true, isAdmin: false, twoFactorEnabled: false, createdAt: now },
  { _id: 'u2', displayName: 'Root', username: 'root', email: 'root@example.test', emailVerified: false, isAdmin: true, twoFactorEnabled: true, createdAt: 0 },
  { _id: 'u3', displayName: 'No Mail', username: 'nomail', emailVerified: false, isAdmin: false, twoFactorEnabled: false, createdAt: now },
];
const servers = [
  { _id: 's1', name: 'Server One', memberCount: 4, discoverable: true, createdAt: now },
  { _id: 's2', name: 'Private Server', memberCount: 0, discoverable: false, createdAt: 0 },
];
const bans = [
  { ip: '203.0.113.7', reason: 'spam', bannedAt: now, expiresAt: now + 60_000 },
  { ip: '2001:db8::1', bannedAt: 0, expiresAt: null },
  { ip: '198.51.100.8', reason: '', bannedAt: now, expiresAt: now - 1_000 },
];
const logs = [{ ts: now, level: 'warn', msg: 'warning', event: 'evt' }, { ts: 0, level: 'info', msg: 'hello' }];
const rules = [{ _id: 'rr1', serverId: 's1', channelId: 'c1', messageId: 'm1', emoji: '👍', roleId: 'r1' }];
const bots = [
  { _id: 'b1', name: 'Helper', description: 'desc', isFeatured: false, createdAt: now },
  { _id: 'b2', name: 'Featured', description: '', isFeatured: true, createdAt: 0 },
];

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body } as Response;
}

function errorJson(body: unknown = {}, status = 400): Response {
  return { ok: false, status, json: async () => body } as Response;
}

function installApi(): void {
  apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === '/api/admin/stats') return okJson(stats);
    if (url.startsWith('/api/admin/users?')) return okJson({ users, total: 61, pages: 3 });
    if (url === '/api/admin/servers' && !init) return okJson(servers);
    if (url === '/api/admin/ip-bans' && !init) return okJson(bans);
    if (url.startsWith('/api/admin/logs')) return okJson(logs);
    if (url === '/api/admin/reaction-roles' && !init) return okJson(rules);
    if (url.startsWith('/api/admin/marketplace') && (!init || init.method === 'GET')) return okJson(bots);
    if (url === '/api/admin/ip-bans' && init?.method === 'POST') return okJson({ ban: bans[0] });
    return okJson({ displayName: 'ok' });
  });
}

async function tab(label: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.admin-nav-btn')]
    .find(node => node.textContent?.includes(label));
  if (!button) throw new Error(`tab ${label} missing`);
  await fireEvent.click(button);
}

// ── ONAY ARTIK BİR ÜRÜN DİYALOĞUDUR ───────────────────────────────────────
// Üretim yıkıcı eylemleri `window.confirm` ile SORMUYOR: `product-dialog.ts`
// gerçek bir overlay basar ve butonlarını `data-product-dialog-action` ile
// işaretler. Bu dosya hâlâ `globalThis.confirm` stub'ını kuruyordu, yani onay
// akışını hiç sürmüyordu — silme isteği hiç gönderilmiyor, testler de
// "silme çalışıyor" diye kırmızıya dönüyordu. Diyaloğu gerçekten sürmek aynı
// zamanda onay penceresinin VAR OLDUĞUNU da kanıtlar.
async function resolveProductDialog(accept: boolean): Promise<void> {
  const action = accept ? 'confirm' : 'cancel';
  const button = await waitFor(() => {
    const el = document.querySelector<HTMLButtonElement>(`[data-product-dialog-action="${action}"]`);
    if (!el) throw new Error(`ürün diyaloğu açılmadı (${action})`);
    return el;
  });
  await fireEvent.click(button);
  await waitFor(() => expect(document.querySelector('[data-product-dialog-action]')).toBeNull());
}

beforeEach(() => {
  apiFetch.mockReset(); toast.mockReset(); installApi();
  for (const key of Object.keys(registry)) delete registry[key];
  registry.toast = toast;
  registry.closeAdminDashboard = vi.fn();
  (globalThis as any).confirm = vi.fn(() => true);

  const ctx = {
    scale: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })), fillRect: vi.fn(), fillText: vi.fn(),
    strokeStyle: '', lineWidth: 0, fillStyle: '', font: '', textAlign: '',
  };
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(ctx as any);
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe('AdminPanel all-source behavior', () => {
  it('loads stats, formats values, draws chart, and delegates close to the lifecycle owner', async () => {
    render(AdminPanel);
    await waitFor(() => expect(document.body.textContent).toContain('Genel İstatistikler'));
    expect(document.body.textContent).toContain('Main');
    expect(document.body.textContent).toContain('Alice');
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled();
    await fireEvent.click(document.querySelector('.admin-close-btn')!);
    expect(registry.closeAdminDashboard).toHaveBeenCalled();
  });

  it('draws safely with fallback DPR and width while the canvas is temporarily detached', async () => {
    const context = {
      scale: vi.fn(), beginPath: vi.fn(), moveTo: vi.fn(), lineTo: vi.fn(), stroke: vi.fn(),
      createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })), fillRect: vi.fn(), fillText: vi.fn(),
      strokeStyle: '', lineWidth: 0, fillStyle: '', font: '', textAlign: '',
    };
    vi.spyOn(window, 'devicePixelRatio', 'get').mockReturnValue(0);
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      Object.defineProperty(this, 'parentElement', { configurable: true, get: () => null });
      return context as unknown as CanvasRenderingContext2D;
    });

    render(AdminPanel);
    await waitFor(() => expect(context.fillRect).toHaveBeenCalled());
    const canvas = document.querySelector<HTMLCanvasElement>('canvas')!;
    expect(context.scale).toHaveBeenCalledWith(1, 1);
    expect(canvas.width).toBe(360);
    expect(canvas.style.width).toBe('360px');
  });

  it('shows fetch failure instead of an empty dashboard', async () => {
    apiFetch.mockReset();
    apiFetch.mockResolvedValueOnce({ ok: false, status: 403, json: async () => ({}) });
    render(AdminPanel);
    // Yukleyiciler artik durumu TASIYAN `ApiResponseError` firlatir; kanonik
    // eslesme 403 -> 'error_forbidden'. Eskiden duz bir Error firlatiliyordu ve
    // `safeApiErrorMessage` onu durum 0 olarak siniflandirip cagiranin jenerik
    // fallback'ini donduruyordu: 403/404/429 ayrimi ADMINE HIC ULASMIYORDU.
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent)
      .toContain('Bu işlem için yetkin yok.'));
  });

  it('users: renders real 2FA markup, searches, paginates, toggles admin and deletes with confirmation', async () => {
    render(AdminPanel); await waitFor(() => expect(apiFetch).toHaveBeenCalledWith('/api/admin/stats'));
    await tab('Kullanıcılar');
    await waitFor(() => expect(document.body.textContent).toContain('@alice'));
    expect(document.body.textContent).not.toContain('<span class="muted">');
    expect(document.body.textContent).toContain('🔐');

    const search = document.querySelector<HTMLInputElement>('input[aria-label="Kullanıcı ara"]')!;
    await fireEvent.input(search, { target: { value: 'ali' } });
    await fireEvent.input(search, { target: { value: 'ali ce' } });
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u).includes('q=ali+ce') && String(u).includes('page=1'))).toBe(true), { timeout: 800 });

    const next = [...document.querySelectorAll<HTMLButtonElement>('.btn-page')].find(b => b.textContent?.includes('Sonraki'))!;
    await fireEvent.click(next);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u).includes('page=2'))).toBe(true));
    const pageOneCalls = apiFetch.mock.calls.filter(([u]) => String(u).includes('/api/admin/users?') && String(u).includes('page=1')).length;
    const previous = [...document.querySelectorAll<HTMLButtonElement>('.btn-page')].find(b => b.textContent?.includes('Önceki'))!;
    await fireEvent.click(previous);
    await waitFor(() => expect(apiFetch.mock.calls.filter(([u]) => String(u).includes('/api/admin/users?') && String(u).includes('page=1')).length).toBeGreaterThan(pageOneCalls));

    const makeAdmin = [...document.querySelectorAll<HTMLButtonElement>('.btn-action')].find(b => b.textContent?.includes('Admin Yap'))!;
    await fireEvent.click(makeAdmin);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => String(u) === '/api/admin/users/u1' && (i as RequestInit)?.method === 'PATCH')).toBe(true));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Admin'), 'success');

    const deleteAlice = [...document.querySelectorAll<HTMLButtonElement>('[aria-label="Kullanıcıyı sil"]')][0]!;
    const before = apiFetch.mock.calls.length;
    await fireEvent.click(deleteAlice);
    await resolveProductDialog(false);
    expect(apiFetch).toHaveBeenCalledTimes(before);
    await fireEvent.click(deleteAlice);
    await resolveProductDialog(true);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => String(u) === '/api/admin/users/u1' && (i as RequestInit)?.method === 'DELETE')).toBe(true));
  });

  it('servers: renders inventory and confirmation-protected delete refreshes the list', async () => {
    render(AdminPanel); await tab('Sunucular');
    await waitFor(() => expect(document.body.textContent).toContain('Server One'));
    const remove = [...document.querySelectorAll<HTMLButtonElement>('.btn-icon-danger')].find(b => b.textContent?.includes('Sil'))!;
    await fireEvent.click(remove);
    await resolveProductDialog(true);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => String(u) === '/api/admin/servers/s1' && (i as RequestInit)?.method === 'DELETE')).toBe(true));
    expect(toast).toHaveBeenCalledWith(expect.stringContaining('Server One'), 'success');
  });

  it('IP bans: validates required IP, emits canonical numeric duration and removes encoded addresses', async () => {
    render(AdminPanel); await tab('IP Yasakları');
    await waitFor(() => expect(document.body.textContent).toContain('203.0.113.7'));
    const add = [...document.querySelectorAll<HTMLButtonElement>('.btn-primary')].find(b => b.textContent?.includes('Yasak Ekle'))!;
    await fireEvent.click(add);
    expect(toast).toHaveBeenCalledWith('IP adresi zorunlu', 'error');

    const ip = document.querySelector<HTMLInputElement>('input[placeholder^="192.168"]')!;
    const reason = document.querySelector<HTMLInputElement>('input[placeholder^="Spam"]')!;
    const duration = document.querySelector<HTMLSelectElement>('select.field-input')!;
    await fireEvent.input(ip, { target: { value: '198.51.100.9' } });
    await fireEvent.input(reason, { target: { value: ' abuse ' } });
    await fireEvent.change(duration, { target: { value: '3600000' } });
    await fireEvent.click(add);
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([u, i]) => u === '/api/admin/ip-bans' && (i as RequestInit)?.method === 'POST');
      expect(call).toBeTruthy();
      expect(JSON.parse((call![1] as RequestInit).body as string)).toEqual({ ip: '198.51.100.9', reason: 'abuse', durationMs: 3_600_000 });
    });

    const unban = document.querySelector<HTMLButtonElement>('.btn-success')!;
    await fireEvent.click(unban);
    await resolveProductDialog(true);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => String(u) === '/api/admin/ip-bans/203.0.113.7' && (i as RequestInit)?.method === 'DELETE')).toBe(true));
    // ISTEGIN GONDERILMESI, ISLEMIN BITMESI DEGILDIR. Bu test eskiden burada
    // duruyordu; basari toast'i test bittikten SONRA calisiyor ve bir SONRAKI
    // testin `toast` mock'una dusuyordu (olculdu: "broadcast" testi kendi
    // dogrulama toast'i yerine "203.0.113.7 yasagi kaldirildi" cagrisini
    // goruyordu). Islemi sonuna kadar beklemek hem sizintiyi kapatir hem de
    // basari bildirimini gercekten dogrular.
    await waitFor(() => expect(toast).toHaveBeenCalledWith(
      expect.stringContaining('203.0.113.7'), 'success'));
  });

  it('logs supports level refresh and renders missing event/time fallbacks', async () => {
    render(AdminPanel); await tab('Loglar');
    await waitFor(() => expect(document.body.textContent).toContain('warning'));
    expect(document.body.textContent).toContain('evt');
    const select = document.querySelector<HTMLSelectElement>('select.field-input')!;
    await fireEvent.change(select, { target: { value: 'warn' } });
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u) === '/api/admin/logs?level=warn')).toBe(true));
  });

  it('broadcast rejects blank text, sends trimmed content and clears successful input', async () => {
    render(AdminPanel); await tab('Duyuru');
    const textarea = document.querySelector<HTMLTextAreaElement>('.broadcast-textarea')!;
    const send = document.querySelector<HTMLButtonElement>('.btn-primary')!;
    await fireEvent.click(send);
    expect(toast).toHaveBeenCalledWith('Mesaj boş olamaz', 'error');
    await fireEvent.input(textarea, { target: { value: '  hello all  ' } });
    await fireEvent.click(send);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/admin/broadcast' && JSON.parse((i as RequestInit).body as string).message === 'hello all')).toBe(true));
    await waitFor(() => expect(textarea.value).toBe(''));
  });

  it('reaction roles validates all fields, adds and confirmation-deletes rules', async () => {
    render(AdminPanel); await tab('Reaction Rol');
    await waitFor(() => expect(document.body.textContent).toContain('Reaction Roller'));
    const add = [...document.querySelectorAll<HTMLButtonElement>('.btn-primary')].find(b => b.textContent?.includes('Kural Ekle'))!;
    await fireEvent.click(add);
    expect(toast).toHaveBeenCalledWith('Tüm alanlar zorunlu', 'error');
    const fields = [...document.querySelectorAll<HTMLInputElement>('input.field-input')];
    expect(fields).toHaveLength(5);
    for (const [field, value] of fields.map((field, index) => [field, ['s2', 'c2', 'm2', '🔥', 'r2'][index]] as const)) {
      await fireEvent.input(field, { target: { value } });
    }
    await fireEvent.click(add);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/admin/reaction-roles' && (i as RequestInit)?.method === 'POST')).toBe(true));
    const del = document.querySelector<HTMLButtonElement>('[aria-label="Kuralı sil"]')!;
    await fireEvent.click(del);
    await resolveProductDialog(true);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/admin/reaction-roles/rr1' && (i as RequestInit)?.method === 'DELETE')).toBe(true));
  });

  it('marketplace searches, validates add, adds bot, toggles featured, deletes and refreshes', async () => {
    render(AdminPanel); await tab('Marketplace');
    await waitFor(() => expect(document.body.textContent).toContain('Helper'));
    const search = document.querySelector<HTMLInputElement>('input[aria-label="Bot ara"]')!;
    await fireEvent.input(search, { target: { value: 'help' } });
    await fireEvent.input(search, { target: { value: 'help me' } });
    await waitFor(() => expect(apiFetch.mock.calls.some(([u]) => String(u) === '/api/admin/marketplace?q=help%20me')).toBe(true), { timeout: 800 });

    const add = [...document.querySelectorAll<HTMLButtonElement>('.btn-primary')].find(b => b.textContent?.includes('Bot Ekle'))!;
    await fireEvent.click(add);
    expect(toast).toHaveBeenCalledWith('Bot adı zorunlu', 'error');
    await fireEvent.input(document.querySelector<HTMLInputElement>('input[placeholder="BotAdı"]')!, { target: { value: ' Helper2 ' } });
    await fireEvent.input(document.querySelector<HTMLInputElement>('input[placeholder="Açıklama…"]')!, { target: { value: ' desc2 ' } });
    await fireEvent.input(document.querySelector<HTMLInputElement>('input[placeholder="bot-token"]')!, { target: { value: ' tok ' } });
    await fireEvent.click(add);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/admin/marketplace' && (i as RequestInit)?.method === 'POST')).toBe(true));

    const feature = [...document.querySelectorAll<HTMLButtonElement>('.btn-action')].find(b => b.textContent?.includes('Öne Çıkar'))!;
    await fireEvent.click(feature);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/admin/marketplace/b1' && (i as RequestInit)?.method === 'PATCH')).toBe(true));

    await fireEvent.click(document.querySelector<HTMLButtonElement>('[aria-label="Botu sil"]')!);
    await resolveProductDialog(true);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/admin/marketplace/b1' && (i as RequestInit)?.method === 'DELETE')).toBe(true));

    const refresh = [...document.querySelectorAll<HTMLButtonElement>('.btn-page')].find(b => b.textContent?.includes('Yenile'))!;
    await fireEvent.click(refresh);
    await waitFor(() => expect(apiFetch.mock.calls.some(([u, i]) => u === '/api/admin/marketplace/refresh' && (i as RequestInit)?.method === 'POST')).toBe(true));
  });

  it('renders bounded empty states and defensive API fallbacks for every inventory', async () => {
    const emptyStats = {
      ...stats,
      totals: { ...stats.totals, totalDMs: null },
      msgsByDay: [],
      topServers: [],
      topUsers: [],
    };
    apiFetch.mockImplementation(async (url: string) => {
      if (url === '/api/admin/stats') return okJson(emptyStats);
      if (url.startsWith('/api/admin/users?')) return okJson({ users: [], total: 0, pages: 0 });
      return okJson([]);
    });

    render(AdminPanel);
    await waitFor(() => expect(document.body.textContent).toContain('Sunucu yok'));
    expect(document.body.textContent).toContain('Veri yok');
    expect(document.querySelector('.stat-grid')?.textContent).toContain('—');
    expect(HTMLCanvasElement.prototype.getContext).toHaveBeenCalled();

    await tab('Kullanıcılar');
    await waitFor(() => expect(document.body.textContent).toContain('Kullanıcı bulunamadı'));
    expect(document.querySelector('.pagination')?.textContent).toContain('1 / 1');
    await tab('Sunucular');
    await waitFor(() => expect(document.body.textContent).toContain('Sunucu yok'));
    await tab('IP Yasakları');
    await waitFor(() => expect(document.body.textContent).toContain('Aktif IP yasağı yok'));
    await tab('Loglar');
    await waitFor(() => expect(document.body.textContent).toContain('Log bulunamadı'));
    await tab('Reaction Rol');
    await waitFor(() => expect(document.body.textContent).toContain('Reaction rol kuralı yok'));
    await tab('Marketplace');
    await waitFor(() => expect(document.body.textContent).toContain('Bot bulunamadı'));
  });

  it('surfaces each tab loader failure instead of preserving stale inventory', async () => {
    const base = apiFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    let failPrefix = '';
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (failPrefix && url.startsWith(failPrefix)) {
        failPrefix = '';
        return errorJson({}, 503);
      }
      return base(url, init);
    });
    render(AdminPanel);
    await waitFor(() => expect(document.body.textContent).toContain('Genel İstatistikler'));

    for (const [label, path] of [
      ['Kullanıcılar', '/api/admin/users?'],
      ['Sunucular', '/api/admin/servers'],
      ['IP Yasakları', '/api/admin/ip-bans'],
      ['Loglar', '/api/admin/logs'],
      ['Reaction Rol', '/api/admin/reaction-roles'],
      ['Marketplace', '/api/admin/marketplace'],
    ] as const) {
      failPrefix = path;
      const callsBefore = apiFetch.mock.calls.length;
      await tab(label);
      await waitFor(() => {
        expect(apiFetch.mock.calls.length).toBeGreaterThan(callsBefore);
        expect(failPrefix).toBe('');
        // Enjekte edilen durum 503'tur. Panel eskiden her yukleyici hatasi
        // icin SABIT "Erisim reddedildi" (bir 403 metni) basiyordu; uretim
        // artik durum kodunu kanonik anahtara esler. 503 icin dogru metin
        // `error_server`dir.
        expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server'));
      });
    }
  });

  it('covers alternate successful admin, permanent-ban and featured-bot transitions', async () => {
    render(AdminPanel);
    await tab('Kullanıcılar');
    await waitFor(() => expect(document.body.textContent).toContain('@root'));
    const revoke = [...document.querySelectorAll<HTMLButtonElement>('.btn-action')]
      .find(button => button.textContent?.includes('Yetkiyi Al'))!;
    await fireEvent.click(revoke);
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([url, init]) => url === '/api/admin/users/u2' && (init as RequestInit)?.method === 'PATCH');
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ isAdmin: false });
      expect(toast).toHaveBeenCalledWith('Admin yetkisi alındı', 'success');
    });

    await tab('IP Yasakları');
    await waitFor(() => expect(document.body.textContent).toContain('203.0.113.7'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input[placeholder^="192.168"]')!, { target: { value: ' 198.51.100.10 ' } });
    const addBan = [...document.querySelectorAll<HTMLButtonElement>('.btn-primary')].find(button => button.textContent?.includes('Yasak Ekle'))!;
    await fireEvent.click(addBan);
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([url, init]) => url === '/api/admin/ip-bans' && (init as RequestInit)?.method === 'POST');
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({
        ip: '198.51.100.10', reason: 'Admin ban', durationMs: null,
      });
    });

    await tab('Marketplace');
    await waitFor(() => expect(document.body.textContent).toContain('Featured'));
    const unfeature = [...document.querySelectorAll<HTMLButtonElement>('.btn-action')]
      .find(button => button.textContent?.includes('Geri Al'))!;
    await fireEvent.click(unfeature);
    await waitFor(() => {
      const call = apiFetch.mock.calls.find(([url, init]) => url === '/api/admin/marketplace/b2' && (init as RequestInit)?.method === 'PATCH');
      expect(JSON.parse((call?.[1] as RequestInit).body as string)).toEqual({ isFeatured: false });
      expect(toast).toHaveBeenCalledWith('Öne çıkarma kaldırıldı', 'success');
    });
  });

  it('rejects tampered ban durations and reports specific and fallback API errors', async () => {
    render(AdminPanel);
    await tab('IP Yasakları');
    await waitFor(() => expect(document.body.textContent).toContain('203.0.113.7'));
    const ip = document.querySelector<HTMLInputElement>('input[placeholder^="192.168"]')!;
    const duration = document.querySelector<HTMLSelectElement>('select.field-input')!;
    const add = [...document.querySelectorAll<HTMLButtonElement>('.btn-primary')].find(button => button.textContent?.includes('Yasak Ekle'))!;
    await fireEvent.input(ip, { target: { value: '198.51.100.11' } });
    const invalid = document.createElement('option');
    invalid.value = '-1'; invalid.textContent = 'invalid'; duration.append(invalid);
    await fireEvent.change(duration, { target: { value: '-1' } });
    const postsBefore = apiFetch.mock.calls.filter(([url, init]) => url === '/api/admin/ip-bans' && (init as RequestInit)?.method === 'POST').length;
    await fireEvent.click(add);
    // `adm_invalid_ban_duration` artik tr sozlugunde TANIMLI; uretim
    // Ingilizce fallback'i degil cevirisini gosterir.
    expect(toast).toHaveBeenCalledWith(t('adm_invalid_ban_duration'), 'error');
    expect(apiFetch.mock.calls.filter(([url, init]) => url === '/api/admin/ip-bans' && (init as RequestInit)?.method === 'POST')).toHaveLength(postsBefore);

    await fireEvent.change(duration, { target: { value: '' } });
    const base = apiFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    // 1. vaka: sunucu 400 dondurur ve govdesinde bir aciklama tasir. Bu test
    //    eskiden O GOVDENIN kullaniciya gosterilmesini bekliyordu; api-error.ts
    //    guvenlik sozlesmesi bunu yasaklar ("Sunucu govdesi ... ASLA bildirime
    //    konmaz"). Dogru sozlesme: kanonik 400 metni + govde SIZMAZ.
    // 2. vaka: Response OLMAYAN bir red (string throw). `apiFetch` ag hatasinda
    //    REDDEDER; panel bunu artik `handled()` ile yakalar ve kullaniciya
    //    kanonik "islem basarisiz" metnini gosterir. Onceden bu red hicbir
    //    yerde yakalanmiyordu: istek gitmiyor, bildirim de cikmiyordu.
    const failures: Array<Response | 'throw'> = [errorJson({ error: 'network policy denied' }, 400), 'throw'];
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/admin/ip-bans' && init?.method === 'POST') {
        const next = failures.shift()!;
        if (next === 'throw') throw 'ip-ban-transport-collapsed';
        return next;
      }
      return base(url, init);
    });
    await fireEvent.click(add);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(t('error_bad_request'), 'error'));
    expect(toast).not.toHaveBeenCalledWith('network policy denied', 'error');
    await fireEvent.click(add);
    await waitFor(() => expect(toast).toHaveBeenCalledWith(t('adm_op_failed'), 'error'));
  });

  it('reports failed user, server, unban and broadcast mutations without false success', async () => {
    const base = apiFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => init?.method ? errorJson() : base(url, init));
    render(AdminPanel);

    await tab('Kullanıcılar');
    await waitFor(() => expect(document.body.textContent).toContain('@alice'));
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('.btn-action')].find(button => button.textContent?.includes('Admin Yap'))!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('İşlem başarısız', 'error'));
    await fireEvent.click(document.querySelector<HTMLButtonElement>('[aria-label="Kullanıcıyı sil"]')!);
    await resolveProductDialog(true);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Silinemedi', 'error'));

    await tab('Sunucular');
    await waitFor(() => expect(document.body.textContent).toContain('Server One'));
    const deleteServerButton = [...document.querySelectorAll<HTMLButtonElement>('.btn-icon-danger')].find(button => button.textContent?.includes('Sil'))!;
    const callsBeforeCancel = apiFetch.mock.calls.length;
    await fireEvent.click(deleteServerButton);
    await resolveProductDialog(false);
    expect(apiFetch).toHaveBeenCalledTimes(callsBeforeCancel);
    await fireEvent.click(deleteServerButton);
    await resolveProductDialog(true);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Silinemedi', 'error'));

    await tab('IP Yasakları');
    await waitFor(() => expect(document.body.textContent).toContain('203.0.113.7'));
    const unban = document.querySelector<HTMLButtonElement>('.btn-success')!;
    await fireEvent.click(unban);
    await resolveProductDialog(false);
    await fireEvent.click(unban);
    await resolveProductDialog(true);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Kaldırılamadı', 'error'));

    await tab('Duyuru');
    await waitFor(() => expect(document.querySelector('.broadcast-textarea')).toBeTruthy());
    await fireEvent.input(document.querySelector<HTMLTextAreaElement>('.broadcast-textarea')!, { target: { value: 'maintenance' } });
    await fireEvent.click(document.querySelector<HTMLButtonElement>('.btn-primary')!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Gönderilemedi', 'error'));
  });

  it('reports failed reaction-role and marketplace mutations and honors delete cancellation', async () => {
    const base = apiFetch.getMockImplementation() as (url: string, init?: RequestInit) => Promise<Response>;
    apiFetch.mockImplementation(async (url: string, init?: RequestInit) => init?.method ? errorJson() : base(url, init));
    render(AdminPanel);

    await tab('Reaction Rol');
    await waitFor(() => expect(document.body.textContent).toContain('Reaction Roller'));
    const fields = [...document.querySelectorAll<HTMLInputElement>('input.field-input')];
    for (const [field, value] of fields.map((field, index) => [field, ['s2', 'c2', 'm2', '🔥', 'r2'][index]] as const)) {
      await fireEvent.input(field, { target: { value } });
    }
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('.btn-primary')].find(button => button.textContent?.includes('Kural Ekle'))!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Eklenemedi', 'error'));
    const deleteRule = document.querySelector<HTMLButtonElement>('[aria-label="Kuralı sil"]')!;
    await fireEvent.click(deleteRule);
    await resolveProductDialog(false);
    await fireEvent.click(deleteRule);
    await resolveProductDialog(true);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Silinemedi', 'error'));

    await tab('Marketplace');
    await waitFor(() => expect(document.body.textContent).toContain('Helper'));
    await fireEvent.input(document.querySelector<HTMLInputElement>('input[placeholder="BotAdı"]')!, { target: { value: 'Broken Bot' } });
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('.btn-primary')].find(button => button.textContent?.includes('Bot Ekle'))!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Bot eklenemedi', 'error'));
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('.btn-action')].find(button => button.textContent?.includes('Öne Çıkar'))!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Güncellenemedi', 'error'));
    const deleteBotButton = document.querySelector<HTMLButtonElement>('[aria-label="Botu sil"]')!;
    await fireEvent.click(deleteBotButton);
    await resolveProductDialog(false);
    await fireEvent.click(deleteBotButton);
    await resolveProductDialog(true);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Silinemedi', 'error'));
    await fireEvent.click([...document.querySelectorAll<HTMLButtonElement>('.btn-page')].find(button => button.textContent?.includes('Yenile'))!);
    await waitFor(() => expect(toast).toHaveBeenCalledWith('Yenilenemedi', 'error'));
  });
});
