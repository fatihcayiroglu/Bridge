// client/tests/members-tab.test.ts
import { t } from '../js/core/i18n/index.ts';
//
// FAZ 8/4 — ÜYE YÖNETİMİ SEKMESİ.
//
// ════════════════════════════════════════════════════════════════════════════
// KAPATILAN GERÇEK BOŞLUK
// ════════════════════════════════════════════════════════════════════════════
// Üye listeleme ve rol atama uçları hazırdı ve izin korumalıydı; ayarlar
// modalında bir "Üyeler" sekmesi YOKTU. Sunucu sahibi kimin üye olduğunu
// göremiyor, rol atayamıyordu.
//
// ── BU PAKETİN ASIL İŞİ ───────────────────────────────────────────────────
// Yönetim yüzeylerinde en kolay yapılan hata, istemci tarafı kontrolü YETKİ
// SINIRI sanmaktır. İki yön birden kilitlenir:
//   • yetkisi olmayana ölü kontrol GÖSTERİLMEZ (yanıltmama)
//   • sunucunun 403'ü İSTEMCİ TARAFINDAN EZİLMEZ (sınır arka uçtadır)

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, fireEvent, cleanup, waitFor } from '@testing-library/svelte';

const PERM_MANAGE_ROLES = 1 << 2;
const PERM_ADMIN        = 1 << 30;

let myPerms = 0;
let apiMock: ReturnType<typeof vi.fn>;
let currentServer: { _id?: string; id?: string } | null = { _id: 's1', name: 'Takım' } as never;
let stillCurrent = true;
let permissionFailure: unknown = null;

vi.mock('../js/core/permissions/myPermissions.js', () => ({
  fetchMyPermissions: async () => {
    if (permissionFailure !== null) throw permissionFailure;
    return myPerms;
  },
  hasPerm: (perms: number, flag: number) => (perms & (1 << 30)) !== 0 || (perms & flag) !== 0,
  PERM_MANAGE_ROLES: 1 << 2,
}));
vi.mock('../js/core/api-fetch.js', () => ({ apiFetch: (...a: unknown[]) => apiMock(...a) }));
vi.mock('../js/core/globals.js', () => ({ getAPI: () => '' }));
vi.mock('../js/core/server-settings/stores/serverSettingsStore', () => ({
  getCurrentServerFromRegistry: () => currentServer,
  isStillCurrentServer: () => stillCurrent,
}));

import MembersTab from '../js/core/server-settings/tabs/MembersTab.svelte';

// ── Yardımcılar ────────────────────────────────────────────────────────────

const MEMBERS = [
  { userId: 'u1', username: 'ayse', displayName: 'Ayşe', roles: ['r1'], joinedAt: 1 },
  { userId: 'u2', username: 'veli', displayName: 'Veli', roles: [], joinedAt: 2 },
];
const ROLES = [
  { _id: 'r1', name: 'Moderatör', color: '#ff0000' },
  { _id: 'r2', name: 'Yardımcı', color: '#00ff00' },
];

const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body }) as unknown as Response;
const fail = (status: number, body: unknown = {}) =>
  ({ ok: false, status, json: async () => body }) as unknown as Response;

function defaultApi(members = MEMBERS, roles = ROLES) {
  return vi.fn(async (url: string) => {
    if (String(url).endsWith('/roles')) return ok(roles);
    if (String(url).endsWith('/members')) return ok(members);
    return ok({});
  });
}

const rows = () => [...document.querySelectorAll('.mem-row')];
const roleButtons = () => [...document.querySelectorAll<HTMLButtonElement>('button.mem-role')];
const calls = (method: string) =>
  apiMock.mock.calls.filter(c => (c[1] as RequestInit | undefined)?.method === method);

beforeEach(() => {
  document.body.innerHTML = '';
  myPerms = 0;
  currentServer = { _id: 's1' };
  stillCurrent = true;
  permissionFailure = null;
  apiMock = defaultApi();
  vi.clearAllMocks();
});

afterEach(() => cleanup());

// ════════════════════════════════════════════════════════════════════════════
describe('listeleme', () => {
  it('üyeleri ve sayıyı gösterir', async () => {
    render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(document.body.textContent).toContain('Ayşe');
    expect(document.body.textContent).toContain('@veli');
  });

  it('boş sunucuda boş durum açıkça yazılır', async () => {
    apiMock = defaultApi([]);
    render(MembersTab);
    await waitFor(() => expect(document.body.textContent).toContain('henüz üye yok'));
  });

  it('arama listeyi daraltır', async () => {
    render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));

    await fireEvent.input(document.querySelector('.mem-search input')!, { target: { value: 'ayse' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
  });

  it('eşleşme yoksa NEDENİ söylenir', async () => {
    render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));
    await fireEvent.input(document.querySelector('.mem-search input')!, { target: { value: 'zzz' } });
    await waitFor(() => expect(document.body.textContent).toContain('eşleşen üye yok'));
  });

  it('403 açıkça bildirilir', async () => {
    apiMock = vi.fn(async () => fail(403));
    render(MembersTab);
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')!.textContent).toContain(t('ui_bu_sunucunun_uyelerini_gorme_yetkiniz_yok')));
  });

  it('sunucu kimligi yoksa undefined URL uretmeden hata gosterir', async () => {
    currentServer = null;
    render(MembersTab);

    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('ssm_no_server')));
    expect(apiMock).not.toHaveBeenCalled();
  });

  it('legacy id alanini URL icin kullanir ve kacirir', async () => {
    currentServer = { id: 'legacy/id' };
    render(MembersTab);

    await waitFor(() => expect(apiMock.mock.calls.some(c => String(c[0]).includes('/servers/legacy%2Fid/members'))).toBe(true));
  });

  it('genel yukleme hatasi, izin reddi ve bozuk listeyi kontrollu ele alir', async () => {
    apiMock = vi.fn(async () => fail(502));
    const first = render(MembersTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server')));
    first.unmount();
    cleanup();

    permissionFailure = 'permission backend unavailable';
    const second = render(MembersTab);
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Üyeler yüklenemedi'));
    second.unmount();
    cleanup();

    permissionFailure = null;
    apiMock = defaultApi({ members: [] } as never);
    render(MembersTab);
    await waitFor(() => expect(document.body.textContent).toContain('henüz üye yok'));
  });

  it('sunucu cevap beklerken degisirse bayat listeyi render etmez', async () => {
    stillCurrent = false;
    render(MembersTab);

    await waitFor(() => expect(document.body.textContent).toContain('henüz üye yok'));
    expect(rows()).toHaveLength(0);
  });

  it('ad, rol JSON, tarih ve renk yedeklerini guvenli render eder', async () => {
    myPerms = PERM_ADMIN;
    apiMock = defaultApi([
      { _id: 'u-nick', nickname: 'Takma', username: 'account', roles: '["r1"]', joinedAt: 0, avatarColor: 'javascript:red' },
      { _id: 'u-user', username: 'OnlyUser', roles: 'not-json', joinedAt: 'bad' },
      { _id: 'u-id', roles: '{"r1":true}' },
      { roles: [] },
    ] as never, [
      { _id: 'r1', name: 'Moderatör', color: 'not-a-color' },
    ]);
    render(MembersTab);

    await waitFor(() => expect(rows()).toHaveLength(4));
    expect(document.body.textContent).toContain('Takma');
    expect(document.body.textContent).toContain('OnlyUser');
    expect(document.body.textContent).toContain('u-id');
    expect(document.body.textContent).toContain('Üye');
    expect(document.body.innerHTML).not.toContain('javascript:red');
    expect(roleButtons().some(button => button.getAttribute('aria-pressed') === 'true')).toBe(true);

    await fireEvent.input(document.querySelector('.mem-search input')!, { target: { value: 'account' } });
    await waitFor(() => expect(rows()).toHaveLength(1));
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('görünürlük — yetki', () => {
  it('MANAGE_ROLES YOKSA rol düğmesi çizilmez', async () => {
    myPerms = 0;
    render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(roleButtons()).toHaveLength(0);
  });

  it('yetkisiz kullanıcıya NEDENİ söylenir', async () => {
    myPerms = 0;
    render(MembersTab);
    await waitFor(() => expect(document.body.textContent).toContain('MANAGE_ROLES'));
  });

  it('yetkisizken rol listesi bile İSTENMEZ', async () => {
    // Yetkisiz istek 403 gürültüsü üretir ve hız sınırını yer.
    myPerms = 0;
    render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(apiMock.mock.calls.filter(c => String(c[0]).endsWith('/roles'))).toHaveLength(0);
  });

  it('yetkisiz kullanıcı atanmış rolleri GÖRÜR ama değiştiremez', async () => {
    myPerms = 0;
    render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));
    // Rol listesi çekilmediği için etiketler de yok; ölü kontrol üretilmez.
    expect(document.querySelectorAll('button.mem-role')).toHaveLength(0);
  });

  it('MANAGE_ROLES varsa her üye için rol düğmeleri çizilir', async () => {
    myPerms = PERM_MANAGE_ROLES;
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBe(MEMBERS.length * ROLES.length));
  });

  it('ADMINISTRATOR tüm bitleri kapsar', async () => {
    myPerms = PERM_ADMIN;
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));
  });

  it('rol servisi basarisiz veya bozuksa mutasyon kontrolu yayinlamaz', async () => {
    myPerms = PERM_ADMIN;
    apiMock = vi.fn(async (url: string) => String(url).endsWith('/roles') ? fail(503) : ok(MEMBERS));
    const first = render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(roleButtons()).toHaveLength(0);
    first.unmount();
    cleanup();

    apiMock = defaultApi(MEMBERS, { roles: [] } as never);
    render(MembersTab);
    await waitFor(() => expect(rows()).toHaveLength(2));
    expect(roleButtons()).toHaveLength(0);
  });

  it('atanmış rol RENKTEN başka işaret de taşır', async () => {
    myPerms = PERM_ADMIN;
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));

    const assigned = roleButtons().filter(b => b.getAttribute('aria-pressed') === 'true');
    expect(assigned).toHaveLength(1);              // yalnız Ayşe'nin r1 rolü
    expect(assigned[0]!.textContent!.trim()).toBe('Moderatör');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('rol atama kanonik uçlara gider', () => {
  beforeEach(() => { myPerms = PERM_ADMIN; });

  it('rol VERME POST gönderir', async () => {
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));

    const give = roleButtons().find(b => b.getAttribute('aria-pressed') === 'false')!;
    await fireEvent.click(give);

    await waitFor(() => {
      const post = calls('POST')[0];
      expect(String(post![0])).toContain('/servers/s1/members/u1/roles');
      expect(JSON.parse(String((post![1] as RequestInit).body)).roleId).toBeTruthy();
    });
  });

  it('rol ALMA DELETE gönderir', async () => {
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));

    const remove = roleButtons().find(b => b.getAttribute('aria-pressed') === 'true')!;
    await fireEvent.click(remove);

    await waitFor(() =>
      expect(calls('DELETE').some(c => String(c[0]).includes('/members/u1/roles/r1'))).toBe(true));
  });

  it('kimlikler URL için kaçılır', async () => {
    apiMock = defaultApi([{ userId: 'a/b', displayName: 'Slash', roles: [] }], ROLES);
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));

    await fireEvent.click(roleButtons()[0]!);
    await waitFor(() => expect(String(calls('POST')[0]![0])).toContain('/members/a%2Fb/roles'));
  });

  it('başarılı değişiklikten sonra liste SUNUCUDAN yeniden okunur', async () => {
    // İyimser güncelleme YOK: rol değişimi izin hesabını etkiler ve yanlış
    // gösterilmesi tehlikelidir.
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));
    const before = apiMock.mock.calls.filter(c => String(c[0]).endsWith('/members')).length;

    await fireEvent.click(roleButtons()[0]!);
    await waitFor(() => {
      const after = apiMock.mock.calls.filter(c => String(c[0]).endsWith('/members')).length;
      expect(after).toBeGreaterThan(before);
    });
    expect(document.querySelector('[role="status"]')?.textContent).toMatch(/verildi|kaldırıldı/);
  });

  it('kimliksiz uye icin mutasyon istegi atmaz', async () => {
    apiMock = defaultApi([{ displayName: 'Kimliksiz', roles: [] }], ROLES);
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));

    await fireEvent.click(roleButtons()[0]!);

    expect(calls('POST')).toHaveLength(0);
    expect(calls('DELETE')).toHaveLength(0);
  });

  it('sunucu degistiyse yakalanmis kimlikle rol mutasyonu yapmaz', async () => {
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));
    stillCurrent = false;

    await fireEvent.click(roleButtons()[0]!);

    expect(calls('POST')).toHaveLength(0);
    expect(calls('DELETE')).toHaveLength(0);
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('Sunucu değişti');
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('sunucu SON SÖZÜ söyler', () => {
  beforeEach(() => { myPerms = PERM_ADMIN; });

  async function clickFirstRole() {
    render(MembersTab);
    await waitFor(() => expect(roleButtons().length).toBeGreaterThan(0));
    await fireEvent.click(roleButtons()[0]!);
  }

  it('403 EZİLMEZ', async () => {
    // İstemci bitleri bayat olabilir; sınır arka uçtadır.
    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return fail(403);
      return String(url).endsWith('/roles') ? ok(ROLES) : ok(MEMBERS);
    });
    await clickFirstRole();
    // Bu MUTASYON yolunun 403'udur (liste yükleme değil): kanonik yetki metni.
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')!.textContent).toContain(t('ui_bu_islem_icin_yetkiniz_yok')));
  });

  it('sunucunun hata METNİ gösterilir', async () => {
    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return fail(400, { error: 'Rol hiyerarşisi ihlali' });
      return String(url).endsWith('/roles') ? ok(ROLES) : ok(MEMBERS);
    });
    await clickFirstRole();
    await waitFor(() =>
      expect(document.querySelector('[role="alert"]')!.textContent).toContain(t('error_bad_request')));
  });

  it('429 ve okunamayan hata govdesi ayri yedek mesajlar kullanir', async () => {
    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return fail(429);
      return String(url).endsWith('/roles') ? ok(ROLES) : ok(MEMBERS);
    });
    await clickFirstRole();
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain('Çok hızlı'));
    cleanup();

    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) {
        return { ok: false, status: 500, json: async () => { throw new Error('bad json'); } } as unknown as Response;
      }
      return String(url).endsWith('/roles') ? ok(ROLES) : ok(MEMBERS);
    });
    await clickFirstRole();
    await waitFor(() => expect(document.querySelector('[role="alert"]')?.textContent).toContain(t('error_server')));
  });

  it('ağ hatası çökertmez', async () => {
    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) throw new Error('offline');
      return String(url).endsWith('/roles') ? ok(ROLES) : ok(MEMBERS);
    });
    await clickFirstRole();
    await waitFor(() => expect(document.querySelector('[role="alert"]')).toBeTruthy());
  });

  it('işlem sırasında kontroller kilitlenir', async () => {
    let release: (v: Response) => void = () => {};
    apiMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method) return new Promise<Response>(r => { release = r; });
      return String(url).endsWith('/roles') ? ok(ROLES) : ok(MEMBERS);
    });
    await clickFirstRole();
    await waitFor(() => expect(roleButtons()[0]!.disabled).toBe(true));
    roleButtons()[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(calls('POST').length + calls('DELETE').length).toBe(1);
    release(ok({}));
  });
});
