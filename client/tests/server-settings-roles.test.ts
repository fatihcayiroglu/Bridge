import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { t } from '../js/core/i18n/index.ts';
import { mount, unmount, flushSync } from 'svelte';
import RolesTab from '../js/core/server-settings/tabs/RolesTab.svelte';
import { BridgeRegistry } from '../js/core/bridge-registry.ts';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('../js/core/api-fetch.js', () => ({
  apiFetch: (...args: unknown[]) => fetchMock(...args),
}));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => 'http://test' }));

const SID = 'srv-roles';
const roles = [
  { _id: 'r-low',  name: 'Backend',   color: '#2d9cdb', position: 10, displayOnProfile: false },
  { _id: 'r-high', name: 'Developer', color: '#e05260', position: 20, displayOnProfile: true },
];

const response = (body: unknown, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => body,
}) as Response;

let host: HTMLDivElement;
let instance: ReturnType<typeof mount> | null;
let currentServer: { _id?: string; id?: string } | null;

function setCurrent(value: { _id?: string; id?: string } | null): void {
  currentServer = value;
  BridgeRegistry.register('getCurrentServer', () => currentServer);
}

async function mountTab(): Promise<void> {
  instance = mount(RolesTab, { target: host });
  flushSync();
  await vi.waitFor(() => {
    flushSync();
    expect(host.textContent).not.toMatch(/Roller yükleniyor/);
  });
}

beforeEach(() => {
  host = document.createElement('div');
  document.body.appendChild(host);
  instance = null;
  setCurrent({ _id: SID });
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      const body = JSON.parse(String(init.body));
      return response({ ...roles[0], displayOnProfile: body.displayOnProfile });
    }
    return response(roles);
  });
});

afterEach(() => {
  if (instance) unmount(instance);
  BridgeRegistry.unregister('getCurrentServer');
  host.remove();
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

describe('Profil rolleri yonetimi', () => {
  it('kanonik rolleri hiyerarsi sirasinda ve metinle gosterir', async () => {
    await mountTab();

    const names = [...host.querySelectorAll('.role-name')].map(el => el.textContent);
    expect(names).toEqual(['Developer', 'Backend']);
    expect(host.textContent).toContain('Profilde gösteriliyor');
    expect(host.textContent).toContain('Profilde gizli');
    expect(fetchMock).toHaveBeenCalledWith(`http://test/api/servers/${SID}/roles`);
  });

  it('toggle yalniz boolean sunum ayarini PATCH eder', async () => {
    await mountTab();
    const toggle = host.querySelector<HTMLInputElement>('input[aria-label^="Developer"]')!;

    toggle.click();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    const [, init] = fetchMock.mock.calls[1]!;
    expect((init as RequestInit).method).toBe('PATCH');
    expect(JSON.parse(String((init as RequestInit).body))).toEqual({ displayOnProfile: false });
  });

  it('sunucu degistiyse eski sunucuya yazmayi fail-closed engeller', async () => {
    await mountTab();
    setCurrent({ _id: 'srv-other' });

    host.querySelector<HTMLInputElement>('input[aria-label^="Developer"]')!.click();
    flushSync();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/Sunucu değişti/);
  });

  it('sunucunun 403 kararini durustce gosterir ve kontrol yayinlamaz', async () => {
    fetchMock.mockResolvedValue(response({ error: 'Missing permission: MANAGE_ROLES' }, 403));
    await mountTab();

    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t('ui_rolleri_yonetme_yetkiniz_yok'));
    expect(host.querySelector('input[type="checkbox"]')).toBeNull();
  });

  it('kimlik yoksa undefined adresine istek atmaz ve yeniden denemeye izin verir', async () => {
    setCurrent(null);
    await mountTab();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(t('ssm_no_server'));
    expect(host.querySelector<HTMLButtonElement>('.roles-retry')).not.toBeNull();
  });

  it('id alanini yedek kanonik kimlik olarak URL icin kullanir', async () => {
    setCurrent({ id: 'legacy/id' });
    fetchMock.mockResolvedValue(response([]));
    await mountTab();

    expect(fetchMock).toHaveBeenCalledWith('http://test/api/servers/legacy%2Fid/roles');
    expect(host.textContent).toContain('Bu sunucuda rol yok');
  });

  it('bozuk rol cevabini guvenli bos listeye indirger', async () => {
    fetchMock.mockResolvedValue(response({ roles: 'not-an-array' }));
    await mountTab();

    expect(host.textContent).toContain('Bu sunucuda rol yok');
  });

  it('genel yukleme hatasini ve retry ile iyilesmeyi gosterir', async () => {
    fetchMock
      .mockResolvedValueOnce(response({}, 502))
      .mockResolvedValueOnce(response(roles));
    await mountTab();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(t('error_server'));

    host.querySelector<HTMLButtonElement>('.roles-retry')!.click();
    await vi.waitFor(() => expect(host.querySelectorAll('.role-row')).toHaveLength(2));
  });

  it('gecersiz renk icin tema rengini ve eksik pozisyon icin sifiri kullanir', async () => {
    fetchMock.mockResolvedValue(response([
      { _id: 'bad', name: 'Bad', color: 'url(javascript:alert(1))' },
      { _id: 'short', name: 'Short', color: '#abc', position: 1 },
    ]));
    await mountTab();

    const dots = [...host.querySelectorAll<HTMLElement>('.role-dot')];
    expect(dots.some(dot => dot.getAttribute('style')?.includes('var(--text-muted)'))).toBe(true);
    expect(dots.some(dot => dot.style.backgroundColor === 'rgb(170, 187, 204)')).toBe(true);
  });

  it('PATCH hata metnini gosterir ve checkbox degerini geri alir', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? response({ error: 'Rol kilitli' }, 409)
        : response(roles));
    await mountTab();
    const toggle = host.querySelector<HTMLInputElement>('input[aria-label^="Developer"]')!;

    toggle.click();

    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain(t('error_conflict')));
    expect(toggle.checked).toBe(true);
  });

  it('PATCH hata govdesi okunamazsa durum kodlu yedek mesaji kullanir', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') {
        return { ok: false, status: 503, json: async () => { throw new Error('bad json'); } } as unknown as Response;
      }
      return response(roles);
    });
    await mountTab();

    host.querySelector<HTMLInputElement>('input[aria-label^="Developer"]')!.click();

    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain(t('error_server')));
  });

  it('basarili PATCH sunucunun dondugu gorunurlugu render eder', async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === 'PATCH'
        ? response({ ...roles[1], displayOnProfile: false })
        : response(roles));
    await mountTab();

    host.querySelector<HTMLInputElement>('input[aria-label^="Developer"]')!.click();

    await vi.waitFor(() => expect(host.textContent).toContain('Profilde gizli'));
    expect(host.querySelectorAll('.role-row')).toHaveLength(2);
  });

  it('Error olmayan yukleme ve PATCH reddini guvenli yedek mesajlara cevirir', async () => {
    fetchMock.mockRejectedValueOnce('offline');
    await mountTab();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Roller yüklenemedi');

    unmount(instance!);
    instance = null;
    host.innerHTML = '';
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return Promise.reject('offline');
      return response(roles);
    });
    await mountTab();
    host.querySelector<HTMLInputElement>('input[aria-label^="Developer"]')!.click();
    await vi.waitFor(() => expect(host.querySelector('[role="alert"]')?.textContent).toContain('Rol güncellenemedi'));
  });

  it('devam eden PATCH varken sentetik ikinci degisikligi cift gondermez', async () => {
    let release: (value: Response) => void = () => {};
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PATCH') return new Promise<Response>(resolve => { release = resolve; });
      return response(roles);
    });
    await mountTab();
    const toggle = host.querySelector<HTMLInputElement>('input[aria-label^="Developer"]')!;
    toggle.click();
    await vi.waitFor(() => expect(toggle.disabled).toBe(true));

    toggle.checked = false;
    toggle.dispatchEvent(new Event('change', { bubbles: true }));

    expect(fetchMock.mock.calls.filter(call => (call[1] as RequestInit | undefined)?.method === 'PATCH')).toHaveLength(1);
    expect(toggle.checked).toBe(true);
    release(response({ ...roles[1], displayOnProfile: false }));
  });

  it('birden cok eksik pozisyonu sifir kabul ederek kararli liste uretir', async () => {
    fetchMock.mockResolvedValue(response([
      { _id: 'a', name: 'A' },
      { _id: 'b', name: 'B' },
      { _id: 'c', name: 'C', position: 1 },
    ]));
    await mountTab();

    expect(host.querySelectorAll('.role-row')).toHaveLength(3);
    expect(host.querySelector('.role-name')?.textContent).toBe('C');
  });
});
